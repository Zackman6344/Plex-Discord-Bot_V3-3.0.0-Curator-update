// commands/book.js: /book and !book, from the query string to the engine call and the reply.
//
// The bug: a slash command's second reply posted publicly in the channel (the adapter's default);
// prefix and slash parsing the same request differently; a speed choice declared as a number on
// a STRING option (Discord rejects the whole registration and every /command vanishes); "play"
// with no title resuming someone else's book; an ambiguous title starting the wrong edition; an
// autocomplete that calls Plex on every keystroke or returns more than 25 choices; two gated
// /play requests in a row leaving the second "thinking…" open; a help embed pushed past
// Discord's 4096-character limit once both opt-in sections are on; /book answering nothing
// while audiobooks are switched off.
//
// Harness: the real command module driven through slashRegistry.buildQueryString and
// interactionAdapter.adaptInteraction (as app/music.js does), with recording fakes for the
// interaction and channel. Parsing tests use a recording fake director; the engine tests use a
// real createBookDirector with test/bookButtons.test.js's deps (fake player and connection, a
// probe that never answers). The catalog and bookmark stores are real, on pid-suffixed temp
// files seeded from test/fixtures/books/catalog.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-command-${process.pid}`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const bookmarks = require('../helpers/bookmarks.js');
const catalog = require('../helpers/bookCatalogStore.js');
const bookModel = require('../helpers/bookModel.js');
const bookLibrary = require('../helpers/bookLibrary.js');
const plexClient = require('../helpers/plexClient.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const { createBookDirector } = require('../helpers/bookEngine.js');
const book = require('../commands/book.js');
const help = require('../commands/help.js');
const fixture = require('./fixtures/books/catalog.json');

const T0 = 1791500000000;
const G = '200000000000000001';
const VC = '300000000000000001';
const ANA = '100000000000000001';
const BEN = '100000000000000002';
const OWNER = '100000000000000009';
const EPHEMERAL = 64;
const SALT = 'avery-quill/the-salt-crown';

const saved = {
	audiobooksEnabled: config.audiobooksEnabled,
	archipelagoEnabled: config.archipelagoEnabled,
	ownerId: config.ownerId,
	rebuild: bookLibrary.rebuild,
	getPlex: plexClient.getPlex
};

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
	catalog.reset();
}

let directors = [];
test.beforeEach(() => {
	cleanup();
	catalog.replace(JSON.parse(JSON.stringify(fixture)));
	config.audiobooksEnabled = true;
	config.ownerId = '';
});
test.afterEach(() => {
	for (const d of directors) d.shutdown();
	directors = [];
	config.audiobooksEnabled = saved.audiobooksEnabled;
	config.archipelagoEnabled = saved.archipelagoEnabled;
	config.ownerId = saved.ownerId;
	bookLibrary.rebuild = saved.rebuild;
	plexClient.getPlex = saved.getPlex;
	cleanup();
});
test.after(cleanup);

// ---- fakes ----------------------------------------------------------------------------------

function fakeMessage(payload) {
	return { payload, edits: [], async edit(p) { this.edits.push(p); return this; } };
}

function world() {
	const sent = [];
	const guild = { id: G, voiceStates: { cache: new Map() } };
	const channel = { id: '400000000000000001', name: 'books', async send(p) { sent.push(p); return fakeMessage(p); } };
	return { guild, channel, sent };
}

function member(w, id, name, inVoice = true) {
	if (inVoice) w.guild.voiceStates.cache.set(id, { channelId: VC });
	return {
		id,
		displayName: name,
		user: { id, username: name },
		voice: inVoice ? { channelId: VC, channel: { id: VC, name: 'Lounge', guild: w.guild } } : { channelId: null, channel: null }
	};
}

function prefix(w, who, query) {
	const calls = [];
	return {
		calls,
		author: who.user,
		member: who,
		guild: w.guild,
		content: `!book ${query}`,
		mentions: { users: { first: () => undefined } },
		channel: { id: w.channel.id, name: 'books', async send(p) { calls.push(['send', p]); return fakeMessage(p); } },
		async reply(p) { calls.push(['reply', p]); return fakeMessage(p); }
	};
}

function slash(w, who, sub, values = {}) {
	const calls = [];
	const interaction = {
		calls,
		commandName: 'book',
		user: who.user,
		member: who,
		guild: w.guild,
		guildId: G,
		client: {},
		deferred: true,
		channel: { id: w.channel.id, name: 'books', async send(p) { calls.push(['channel.send', p]); return fakeMessage(p); } },
		options: {
			data: [],
			getSubcommand: () => sub,
			get: name => (values[name] === undefined ? null : { name, value: values[name] }),
			getUser: name => (values[name] && values[name].id ? values[name] : null)
		},
		async editReply(p) { calls.push(['editReply', p]); return fakeMessage(p); },
		async followUp(p) { calls.push(['followUp', p]); return fakeMessage(p); }
	};
	const query = slashRegistry.buildQueryString(interaction, book.command.slash);
	return { interaction, query, message: adaptInteraction(interaction, query) };
}

async function runPrefix(bot, w, who, query) {
	const m = prefix(w, who, query);
	await book.command.process(bot, null, m, query);
	return m.calls;
}

async function runSlash(bot, w, who, sub, values) {
	const s = slash(w, who, sub, values);
	await book.command.process(bot, null, s.message, s.query);
	return s.interaction.calls;
}

function recordingBooks(over = {}) {
	const calls = [];
	const books = Object.assign({
		calls,
		start() { calls.push(['start']); return null; },
		async play(ctx) { calls.push(['play', ctx]); return { ok: true, code: 'playing', text: '▶ Starting', info: { stale: false } }; },
		control(guildId, m, action, arg) { calls.push(['control', action, arg]); return { ok: true, code: 'ok', text: `did ${action}` }; },
		repost(guildId, opts) { calls.push(['repost', opts]); return { ok: true, code: 'ok', text: 'Posted.' }; },
		finish(userId, work, opts) { calls.push(['finish', userId, work && work.id, opts]); return { ok: true, code: 'finished', text: '🎉 Marked finished.' }; },
		forget(userId, workId) { calls.push(['forget', userId, workId]); return { ok: true, code: 'forgotten', text: 'Forgotten.' }; },
		session: () => null,
		position: () => 0
	}, over);
	return { books, calls };
}

class FakePlayer extends EventEmitter {
	constructor() { super(); this.state = { status: 'idle' }; }
	play(resource) { this.state = { status: 'buffering', resource }; }
	stop() { this.state = { status: 'idle' }; return true; }
}

class FakeConn extends EventEmitter {
	constructor() { super(); this.state = { status: 'ready' }; }
	subscribe(player) { this.state = Object.assign({}, this.state, { subscription: { player } }); return this.state.subscription; }
	destroy() { this.state = { status: 'destroyed' }; this.emit('stateChange', {}, this.state); }
}

function realBot({ musicBusy = false } = {}) {
	const bot = { songQueue: [], musicBusy: () => musicBusy, async openConnection() { return new FakeConn(); }, async playSong() {} };
	bot.books = createBookDirector({
		bot,
		deps: {
			createPlayer: () => new FakePlayer(),
			probe: () => new Promise(() => {}),
			urlFor: () => 'http://127.0.0.1:1/unused',
			createResource: () => { throw new Error('nothing is played in this test'); },
			library: { start: () => null, stop() {}, lastError: () => null },
			ensureFresh: () => Promise.resolve({ action: 'fresh' }),
			commandLog: { recordEvent() {} },
			proxy: { stop: () => Promise.resolve() },
			getVoiceConnection: () => null,
			timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {}, now: () => T0 },
			config: () => config
		}
	});
	directors.push(bot.books);
	return bot;
}

function contentOf(call) {
	return typeof call[1] === 'string' ? call[1] : call[1].content;
}

// ---- parsing and replies --------------------------------------------------------------------

test('prefix and slash hand the engine the same play request', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const a = recordingBooks();
	await runPrefix({ books: a.books }, w, ana, 'play the salt crown --restart');
	const b = recordingBooks();
	const s = slash(w, ana, 'play', { title: 'the salt crown', 'from-start': true });
	assert.strictEqual(s.query, 'play the salt crown --restart');
	await book.command.process({ books: b.books }, null, s.message, s.query);
	const pa = a.calls.find(c => c[0] === 'play')[1];
	const pb = b.calls.find(c => c[0] === 'play')[1];
	assert.deepStrictEqual([pa.query, pa.fromStart], ['the salt crown', true]);
	assert.deepStrictEqual([pb.query, pb.fromStart], ['the salt crown', true]);
	assert.strictEqual(pa.textChannel.id, w.channel.id);
	// The adapter's channel would turn the engine's card into the ephemeral editReply.
	assert.strictEqual(pb.textChannel, s.interaction.channel, 'the slash card goes to the real channel');
	const c = recordingBooks();
	await runSlash({ books: c.books }, w, ana, 'play', { title: 'the salt crown', 'from-start': false });
	assert.strictEqual(c.calls.find(x => x[0] === 'play')[1].fromStart, false);
});

test('a slash command\'s second reply is a private follow-up, never a channel post', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const s = slash(w, ana, 'library', {});
	const say = book._internal.makeSay(s.message, { ephemeral: true });
	await say('one');
	await say({ content: 'two' });
	assert.deepStrictEqual(s.interaction.calls.map(c => c[0]), ['editReply', 'followUp']);
	assert.strictEqual(s.interaction.calls[1][1].flags, EPHEMERAL);
	assert.deepStrictEqual(s.interaction.calls[1][1].allowedMentions, { parse: [] });

	const board = slash(w, ana, 'leaderboard', {});
	const sayPublic = book._internal.makeSay(board.message, { ephemeral: false });
	await sayPublic('one');
	await sayPublic('two');
	assert.strictEqual(board.interaction.calls[1][0], 'followUp');
	assert.strictEqual(board.interaction.calls[1][1].flags, undefined, 'the leaderboard stays public');

	const m = prefix(w, ana, 'library');
	const sayPrefix = book._internal.makeSay(m);
	await sayPrefix('one');
	await sayPrefix('two');
	assert.deepStrictEqual(m.calls.map(c => c[0]), ['reply', 'send']);
});

test('say never rejects', async () => {
	const say = book._internal.makeSay({ async reply() { throw new Error('50035 Invalid Form Body'); } });
	assert.strictEqual(await say('x'), null);
});

// The bug: nothing capped a reply at Discord's 2,000 characters. A chapter list of long podcast
// episode titles (2,213 characters) was rejected, and on slash that rejected editReply was the
// only answer, so the reply stayed on "thinking…".
test('a reply never goes over 2,000 characters, and long chapter titles are clipped', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const s = slash(w, ana, 'library', {});
	await book._internal.makeSay(s.message)({ content: 'x'.repeat(2500) });
	assert.strictEqual(contentOf(s.interaction.calls[0]).length, 2000);

	// One word of its own per episode: words every title shares are dropped from the label.
	const topics = 'maps rivers tides storms lanterns bridges orchards ferries canals beacons quarries mills harbours meadows glaciers deserts islands forests valleys caves comets reefs dunes marshes cliffs moors fjords deltas lagoons prairies'.split(' ');
	const parts = Array.from({ length: 30 }, (_, i) => ({
		ordinal: i + 1,
		durationMs: 3600000,
		title: `Episode ${i + 1}: ${topics[i]} and ${'a long conversation about a book, recorded live at a festival, '.repeat(3)}`
	}));
	const work = { id: 'pod/show', title: 'The Show', kind: 'podcast', parts, totalMs: 30 * 3600000 };
	const r = recordingBooks({ session: () => ({ work }), position: () => 15 * 3600000 });
	const calls = await runSlash({ books: r.books }, w, ana, 'chapter', {});
	const text = contentOf(calls[0]);
	assert.ok(text.length <= 2000, `${text.length}`);
	const lines = text.split('\n').slice(1);
	assert.strictEqual(lines.length, 10, 'every one of the ten lines is still there');
	for (const line of lines) assert.ok(line.length < 120, line);
	assert.match(lines.find(l => l.startsWith('▶')), /^▶ 16 · Episode 16 of 30 · Episode 16: deserts and a long .*… \(1 h 00 m\)$/);
});

// The bug: the clip cut by UTF-16 units, so an emoji across the 2,000 boundary left half a
// surrogate pair, and a clip inside a code block left the fence open around the ellipsis.
test('the 2,000-character clip never splits an emoji and closes an open code block', async () => {
	const sent = async (content) => {
		let got = null;
		await book._internal.makeSay({ async reply(b) { got = b.content; return {}; } })(content);
		return got;
	};
	const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

	const emoji = await sent('x'.repeat(1998) + '📚'.repeat(10));
	assert.ok(emoji.length <= 2000, `${emoji.length}`);
	assert.doesNotMatch(emoji, loneSurrogate);
	assert.ok(emoji.endsWith('…'));

	const code = await sent('```\n' + 'y'.repeat(2500) + '\n```');
	assert.ok(code.length <= 2000, `${code.length}`);
	assert.strictEqual((code.match(/```/g) || []).length % 2, 0, 'the fence is closed');
	assert.ok(code.endsWith('```\n…'), JSON.stringify(code.slice(-12)));

	assert.strictEqual(await sent('short 📚'), 'short 📚', 'a reply under the limit is untouched');
});

// The bug: HANDLERS was a plain object, so `!book constructor` found Object and threw
// "handler.run is not a function" with no reply at all.
test('a subcommand named after an Object property is an unknown command', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	for (const sub of ['constructor', '__proto__']) {
		const calls = await runPrefix({ books: recordingBooks().books }, w, ana, sub);
		assert.strictEqual(calls.length, 1, sub);
		assert.match(contentOf(calls[0]), /Unknown book command/, sub);
	}
});

test('speed choices are strings, and the number reaches the engine', async () => {
	const spec = book.command.slash.subcommands.find(s => s.name === 'speed').options[0];
	assert.strictEqual(spec.type, 'STRING');
	for (const c of spec.choices) {
		assert.strictEqual(typeof c.value, 'string');
		assert.ok(bookModel.SPEEDS.includes(Number(c.value)), c.value);
	}
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const r = recordingBooks();
	await runSlash({ books: r.books }, w, ana, 'speed', { rate: '1.25' });
	assert.deepStrictEqual(r.calls.find(c => c[0] === 'control'), ['control', 'speed', 1.25]);
	const bad = recordingBooks();
	const calls = await runPrefix({ books: bad.books }, w, ana, 'speed 7');
	assert.ok(!bad.calls.some(c => c[0] === 'control'), 'refused before the engine');
	assert.match(contentOf(calls[0]), /Speed must be one of/);
	const x = recordingBooks();
	await runPrefix({ books: x.books }, w, ana, 'speed 1.5x');
	assert.deepStrictEqual(x.calls.find(c => c[0] === 'control'), ['control', 'speed', 1.5]);
});

test('the controls pass their arguments through', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const cases = [
		['back', 'back 90', ['control', 'back', '90']],
		['forward', 'forward 2m', ['control', 'fwd', '2m']],
		['forward', 'forward', ['control', 'fwd', undefined]],
		['goto', 'goto +5m', ['control', 'goto', '+5m']],
		['chapter', 'chapter 12', ['control', 'chapter', 12]],
		['sleep', 'sleep 30', ['control', 'sleep', 30]],
		['sleep', 'sleep chapter', ['control', 'sleep', 'chapter']],
		['next', 'next', ['control', 'nextch', undefined]],
		['stop', 'stop', ['control', 'stop', undefined]]
	];
	for (const [, query, expected] of cases) {
		const r = recordingBooks();
		await runPrefix({ books: r.books }, w, ana, query);
		assert.deepStrictEqual(r.calls.find(c => c[0] === 'control'), expected, query);
	}
	const s = recordingBooks();
	await runSlash({ books: s.books }, w, ana, 'back', { seconds: 60 });
	assert.deepStrictEqual(s.calls.find(c => c[0] === 'control'), ['control', 'back', '60']);
	const sl = recordingBooks();
	await runSlash({ books: sl.books }, w, ana, 'sleep', { after: 'off' });
	assert.deepStrictEqual(sl.calls.find(c => c[0] === 'control'), ['control', 'sleep', 'off']);
	const now = recordingBooks();
	const calls = await runSlash({ books: now.books }, w, ana, 'now', {});
	assert.strictEqual(now.calls[0][1].textChannel.id, w.channel.id);
	assert.strictEqual(contentOf(calls[0]), 'Posted.');
});

// The bug: it named `/config`, which an owner who only uses prefix commands cannot run.
test('with audiobooks off every subcommand says how to turn them on, with the prefix command', async () => {
	config.audiobooksEnabled = false;
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const how = `Audiobooks are turned off. The bot owner can turn them on with \`${config.commandPrefix}config\`, under Audiobooks`;
	for (const sub of ['play', 'shelf', 'leaderboard', 'rescan']) {
		const r = recordingBooks();
		const calls = await runSlash({ books: r.books }, w, ana, sub, {});
		assert.deepStrictEqual(r.calls, [], `${sub} reached the engine`);
		assert.strictEqual(calls.length, 1);
		assert.ok(contentOf(calls[0]).includes(how), contentOf(calls[0]));
		assert.ok(!contentOf(calls[0]).includes('/config'), sub);
	}
	assert.match(book._internal.offText('?'), /`\?config`/, 'a custom prefix');
});

// The bug: turning audiobooks off does not end a book that is playing, yet /book stop, pause and
// now all answered "turned off", so the listener lost the way to control or re-post it.
test('with audiobooks off a book still playing in the server can be controlled', async () => {
	config.audiobooksEnabled = false;
	const w = world();
	const ana = member(w, ANA, 'Ana');
	for (const sub of ['stop', 'pause', 'resume', 'now', 'sleep']) {
		const r = recordingBooks({ session: () => ({ work: catalog.work(SALT) }) });
		const calls = await runSlash({ books: r.books }, w, ana, sub, sub === 'sleep' ? { after: 'off' } : {});
		assert.ok(r.calls.some(c => c[0] === 'control' || c[0] === 'repost'), `${sub} reached the engine`);
		assert.doesNotMatch(contentOf(calls[0]), /turned off/, sub);
	}
	for (const sub of ['play', 'shelf', 'rescan']) {
		const r = recordingBooks({ session: () => ({ work: catalog.work(SALT) }) });
		const calls = await runSlash({ books: r.books }, w, ana, sub, {});
		assert.deepStrictEqual(r.calls, [], `${sub} reached the engine`);
		assert.match(contentOf(calls[0]), /turned off/, sub);
	}
	const idle = recordingBooks();
	const calls = await runSlash({ books: idle.books }, w, ana, 'stop', {});
	assert.deepStrictEqual(idle.calls, [], 'with no book playing, stop is refused as before');
	assert.match(contentOf(calls[0]), /turned off/);
});

test('!book ? and a bare !book show the sub-help, which fits an embed', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	for (const query of ['?', '']) {
		const calls = await runPrefix({ books: recordingBooks().books }, w, ana, query);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0][0], 'send');
		const e = calls[0][1].embeds[0].data;
		assert.ok(e.description.length <= 4096);
		assert.match(e.description, /book play \[title\]/);
	}
	const unknown = await runPrefix({ books: recordingBooks().books }, w, ana, 'frobnicate');
	assert.match(contentOf(unknown[0]), /Unknown book command "frobnicate"/);
});

// ---- play through the real engine -----------------------------------------------------------

test('play with no title resumes your own latest book, never someone else\'s', async () => {
	const w = world();
	const bot = realBot();
	const salt = catalog.work(SALT);
	bookmarks.record(ANA, salt, { absoluteMs: 6000000, guildId: G }, { force: true });
	const ben = member(w, BEN, 'Ben');
	const theirs = await runPrefix(bot, w, ben, 'play');
	assert.match(contentOf(theirs[0]), /Which book\?/);
	assert.strictEqual(bot.books.session(G), null);
	const ana = member(w, ANA, 'Ana');
	const mine = await runSlash(bot, w, ana, 'play', {});
	const s = bot.books.session(G);
	assert.deepStrictEqual([s.userId, s.workId], [ANA, SALT]);
	await s.cardChain;
	assert.deepStrictEqual(mine.map(c => c[0]).filter(k => k !== 'channel.send'), ['editReply'], 'one private reply');
	assert.match(mine.find(c => c[0] === 'editReply')[1].content, /▶ Resuming The Salt Crown/);
	const card = mine.filter(c => c[0] === 'channel.send');
	assert.strictEqual(card.length, 1, 'the card is a public channel message');
	assert.match(card[0][1].embeds[0].title, /The Salt Crown/);
});

test('refusals come back as one reply each', async () => {
	const w = world();
	const bot = realBot();
	const away = member(w, ANA, 'Ana', false);
	assert.match(contentOf((await runPrefix(bot, w, away, 'play the salt crown'))[0]), /Join a voice channel first/);
	const ana = member(w, ANA, 'Ana');
	await runPrefix(bot, w, ana, 'play the salt crown');
	const ben = member(w, BEN, 'Ben');
	const busy = await runPrefix(bot, w, ben, 'play the ember throne');
	assert.strictEqual(busy.length, 1);
	assert.match(contentOf(busy[0]), /Ana is listening to The Salt Crown here/);
	const music = realBot({ musicBusy: true });
	const w2 = world();
	const cal = member(w2, BEN, 'Ben');
	assert.match(contentOf((await runPrefix(music, w2, cal, 'play the salt crown'))[0]), /Music is playing here/);
	const missing = await runPrefix(realBot(), world(), member(world(), BEN, 'Ben'), 'play zzzz nothing');
	assert.match(contentOf(missing[0]), /Nothing in the audiobook library matches/);
});

test('an ambiguous title lists the editions as buttons', async () => {
	const w = world();
	const bot = realBot();
	const ana = member(w, ANA, 'Ana');
	const calls = await runSlash(bot, w, ana, 'play', { title: 'the far shore' });
	assert.strictEqual(calls.length, 1);
	const reply = calls[0][1];
	assert.match(reply.content, /Which one\?/);
	const ids = reply.components[0].components.map(b => b.custom_id).sort();
	assert.deepStrictEqual(ids, ['book:play:ilse-moreau/the-far-shore~harlow', 'book:play:ilse-moreau/the-far-shore~penrose']);
	assert.strictEqual(bot.books.session(G), null, 'nothing started');
});

test('the lowercased title from a music search redirect plays', async () => {
	// helpers/longForm.js prints `/book play <title in lowercase>` under search results.
	const w = world();
	const bot = realBot();
	const ana = member(w, ANA, 'Ana');
	const calls = await runPrefix(bot, w, ana, 'play the glass road');
	assert.match(contentOf(calls.find(c => c[0] === 'reply')), /Starting The Glass Road/);
	assert.strictEqual(bot.books.session(G).workId, 'avery-quill/the-glass-road');
});

test('a stale library adds a line to the play reply', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const r = recordingBooks({ async play() { return { ok: true, code: 'playing', text: '▶ Starting X', info: { stale: true } }; } });
	const calls = await runPrefix({ books: r.books }, w, ana, 'play x');
	assert.match(contentOf(calls[0]), /▶ Starting X\n\(The library list may be stale/);
});

test('two gated /play requests each get exactly one answer, the second without the long explanation', async () => {
	const w = world();
	const bot = realBot();
	const ana = member(w, ANA, 'Ana');
	await runPrefix(bot, w, ana, 'play the salt crown');
	const ben = member(w, BEN, 'Ben');
	const answers = [];
	for (let i = 0; i < 2; i++) {
		const calls = [];
		const interaction = {
			commandName: 'play', user: ben.user, member: ben, guild: w.guild, client: {},
			channel: { id: w.channel.id, async send(p) { calls.push(['channel.send', p]); } },
			async editReply(p) { calls.push(['editReply', p]); }
		};
		const adapter = adaptInteraction(interaction, 'some song');
		assert.strictEqual(bot.books.blocksMusic(adapter), true);
		await new Promise(setImmediate);
		answers.push(calls);
	}
	for (const calls of answers) assert.deepStrictEqual(calls.map(c => c[0]), ['editReply']);
	assert.match(answers[0][0][1].content, /Queued behind Ana's book[\s\S]*is listening to The Salt Crown/);
	assert.doesNotMatch(answers[1][0][1].content, /is listening to/);
	assert.match(answers[1][0][1].content, /Queued behind Ana's book/);
});

// ---- autocomplete -----------------------------------------------------------------------------

function trapPlex() {
	const hits = [];
	plexClient.getPlex = () => { hits.push('getPlex'); throw new Error('autocomplete must not reach Plex'); };
	bookLibrary.rebuild = async () => { hits.push('rebuild'); return { ok: false }; };
	return hits;
}

async function complete(bot, who, sub, name, value) {
	let answer = null;
	const interaction = {
		user: who.user,
		guildId: G,
		options: { getFocused: () => ({ name, value }), getSubcommand: () => sub },
		async respond(c) { answer = c; }
	};
	await book.command.slash.autocomplete(interaction, bot);
	return answer;
}

test('title autocomplete puts your books in progress first and never calls Plex', async () => {
	const hits = trapPlex();
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const salt = catalog.work(SALT);
	bookmarks.record(ANA, salt, { absoluteMs: Math.floor(bookModel.totalMs(salt) * 0.41) + 1000 }, { force: true });
	const all = await complete({ books: null }, ana, 'play', 'title', '');
	assert.strictEqual(all[0].value, SALT);
	assert.match(all[0].name, /^▶ 41% · The Salt Crown/);
	assert.strictEqual(all.filter(c => c.value === SALT).length, 1, 'listed once');
	assert.ok(all.length <= 25);
	for (const c of all) {
		assert.ok(c.name.length >= 1 && c.name.length <= 100, c.name);
		assert.ok(catalog.work(c.value), `${c.value} is a work id`);
	}
	const typed = await complete({ books: null }, ana, 'play', 'title', 'glass');
	assert.deepStrictEqual(typed.map(c => c.value).sort(), ['avery-quill/shadows-of-glass', 'avery-quill/the-glass-road', 'ilse-moreau/the-glass-sea'],'only matches; the book in progress does not match');
	const ben = member(w, BEN, 'Ben');
	const theirs = await complete({ books: null }, ben, 'play', 'title', '');
	assert.ok(!theirs[0].name.startsWith('▶'), 'someone else\'s progress is not yours');
	assert.deepStrictEqual(hits, []);
});

test('title autocomplete stops at 25', async () => {
	const big = JSON.parse(JSON.stringify(fixture));
	const base = big.works[SALT];
	for (let i = 0; i < 20; i++) {
		const id = `test-author/extra-book-${i}`;
		big.works[id] = Object.assign(JSON.parse(JSON.stringify(base)), { id, title: `Extra Book ${i}` });
	}
	catalog.replace(big);
	const w = world();
	const out = await complete({ books: null }, member(w, ANA, 'Ana'), 'play', 'title', '');
	assert.strictEqual(catalog.works().length, 36);
	assert.strictEqual(out.length, 25);
});

test('autocomplete before the catalog exists says the library is being read', async () => {
	const hits = trapPlex();
	catalog.replace({ meta: {}, works: {}, rejected: [], chapterCache: {}, index: { trackKeys: [], albumKeys: [], artistKeys: [], partIds: [] } });
	const w = world();
	const out = await complete({ books: null }, member(w, ANA, 'Ana'), 'play', 'title', 'sal');
	assert.strictEqual(out.length, 1);
	assert.match(out[0].name, /still being read/);
	assert.deepStrictEqual(hits, []);
});

test('chapter autocomplete is centred on the current chapter', async () => {
	const work = catalog.work('r-j-ashdown/the-hollow-king');
	const chs = bookModel.chapters(work);
	assert.strictEqual(chs.length, 35);
	const at = chs[19].startMs + 1000;
	const bot = { books: { session: () => ({ work }), position: () => at } };
	const w = world();
	const out = await complete(bot, member(w, ANA, 'Ana'), 'chapter', 'number', '');
	assert.strictEqual(out.length, 25);
	assert.ok(out.some(c => c.value === 20 && c.name.startsWith('▶ 20 · ')));
	const numbers = out.map(c => c.value);
	assert.ok(numbers.includes(8) && numbers.includes(32), `around 20: ${numbers.join(',')}`);
	for (const c of out) assert.ok(Number.isInteger(c.value) && c.name.length <= 100);
	const none = await complete({ books: { session: () => null } }, member(w, ANA, 'Ana'), 'chapter', 'number', '');
	assert.deepStrictEqual(none, []);
});

// ---- shelf, library, stats, leaderboard -------------------------------------------------------

test('the shelf lists books in progress with Resume buttons and collapses finished ones', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const salt = catalog.work(SALT);
	const ember = catalog.work('avery-quill/the-ember-throne');
	bookmarks.record(ANA, salt, { absoluteMs: 6000000, speed: 1.25, addListenedMs: 60000 }, { force: true });
	bookmarks.markFinished(ANA, ember);
	bookmarks.record(ANA, { id: 'gone-author/lost-book', title: 'Lost Book', kind: 'book', parts: [{ durationMs: 600000 }] }, { absoluteMs: 120000 }, { force: true });
	const calls = await runSlash({ books: recordingBooks().books }, w, ana, 'shelf', {});
	const reply = calls[0][1];
	const d = reply.embeds[0].description;
	assert.match(d, /▶ \*\*The Salt Crown\*\*.* · 40% · Part 2 of 4 · 1 h 58 m left at 1\.25x/);
	assert.match(d, /⚠️ \*\*Lost Book\*\* · not in the library any more/);
	assert.match(d, /\*\*Finished\*\*\n✅ The Ember Throne.* · finished <t:\d+:d>/);
	const ids = reply.components[0].components.map(b => b.custom_id);
	assert.deepStrictEqual(ids, [`book:resume:${SALT}`], 'no Resume for a book missing from the library');
	const empty = await runSlash({ books: recordingBooks().books }, w, member(w, BEN, 'Ben'), 'shelf', {});
	assert.match(contentOf(empty[0]), /Your shelf is empty/);
});

test('the library opens on its sections and lists a series under its own heading', async () => {
	const w = world();
	const calls = await runPrefix({ books: recordingBooks().books }, w, member(w, ANA, 'Ana'), 'library');
	assert.strictEqual(calls.length, 1, 'one message');
	assert.ok(contentOf(calls[0]).length <= 1900);
	assert.match(contentOf(calls[0]), /\*\*More books\*\* · 15 works, .*\n\*\*Podcasts\*\* · 1 work/);
	assert.match(calls[0][1].components[0].components[0].custom_id, /^book:lib:open:/, 'the prefix reply carries its menu');
	const series = await runPrefix({ books: recordingBooks().books }, w, member(w, ANA, 'Ana'), 'library ashfall');
	assert.match(contentOf(series[0]), /\*Ashfall\* · Avery Quill\n• #1 The Ember Throne · 4 h 08 m/);
	const pods = await runPrefix({ books: recordingBooks().books }, w, member(w, ANA, 'Ana'), 'library podcasts');
	assert.match(contentOf(pods[0]), /🎙 podcast/);
	const filtered = await runPrefix({ books: recordingBooks().books }, w, member(w, ANA, 'Ana'), 'library far shore');
	const f = filtered.map(contentOf).join('\n');
	assert.match(f, /2 works/);
	assert.match(f, /The Far Shore \(Harlow\)/);
	assert.match(f, /The Far Shore \(Penrose\)/);
});

test('stats and the public leaderboard read the bookmark store', async () => {
	const w = world();
	const salt = catalog.work(SALT);
	bookmarks.record(ANA, salt, { absoluteMs: 6000000, guildId: G, addListenedMs: 2 * 3600000, addCoveredMs: 2.5 * 3600000 }, { force: true });
	bookmarks.record(BEN, salt, { absoluteMs: 1000, guildId: G }, { force: true });
	const ana = member(w, ANA, 'Ana');
	const stats = await runSlash({ books: recordingBooks().books }, w, ana, 'stats', {});
	assert.match(stats[0][1].embeds[0].description, /\*\*2\.0 h\*\* listened · \*\*2\.5 h\*\* of book time covered/);
	const ben = member(w, BEN, 'Ben');
	const other = await runSlash({ books: recordingBooks().books }, w, ben, 'stats', { user: ana.user });
	assert.match(other[0][1].embeds[0].description, new RegExp(`<@${ANA}>`));
	const board = await runSlash({ books: recordingBooks().books }, w, ana, 'leaderboard', {});
	const lines = board[0][1].embeds[0].description.split('\n');
	assert.deepStrictEqual(lines, [`🥇 <@${ANA}> · 2.0 h listened · 0 finished`], 'Ben has 0 h and nothing finished, so is left off');
	assert.ok(book.command.slash.ephemeral({ options: { getSubcommand: () => 'leaderboard' } }) === false);
	assert.ok(book.command.slash.ephemeral({ options: { getSubcommand: () => 'stats' } }) === true);
});

// ---- finish, forget, rescan -------------------------------------------------------------------

test('finish and forget go through the engine', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const r = recordingBooks();
	await runPrefix({ books: r.books }, w, ana, 'finish the salt crown');
	assert.deepStrictEqual(r.calls.find(c => c[0] === 'finish'), ['finish', ANA, SALT, { guildId: G }]);

	bookmarks.record(ANA, catalog.work(SALT), { absoluteMs: 5000 }, { force: true });
	const f = recordingBooks();
	const ask = await runPrefix({ books: f.books }, w, ana, 'forget the salt crown');
	assert.match(contentOf(ask[0]), /forget avery-quill\/the-salt-crown confirm/);
	assert.ok(!f.calls.some(c => c[0] === 'forget'), 'prefix needs confirm');
	await runPrefix({ books: f.books }, w, ana, `forget ${SALT} confirm`);
	assert.deepStrictEqual(f.calls.find(c => c[0] === 'forget'), ['forget', ANA, SALT]);

	const s = recordingBooks();
	const confirm = await runSlash({ books: s.books }, w, ana, 'forget', { title: SALT });
	assert.strictEqual(confirm[0][1].components[0].components[0].custom_id, `book:forget:${SALT}`);
	assert.ok(!s.calls.some(c => c[0] === 'forget'), 'slash asks with a button first');

	const none = await runPrefix({ books: recordingBooks().books }, w, ana, 'forget the ember throne confirm');
	assert.match(contentOf(none[0]), /no place saved in The Ember Throne/);
	const amb = await runPrefix({ books: recordingBooks().books }, w, ana, 'finish the far shore');
	assert.match(contentOf(amb[0]), /Which one\? Use the id/);
});

test('rescan is the owner\'s and reports what changed', async () => {
	const w = world();
	config.ownerId = OWNER;
	let rebuilt = 0;
	bookLibrary.rebuild = async () => {
		rebuilt++;
		return { ok: true, works: 16, books: 15, podcasts: 1, parts: 120, totalMs: 300 * 3600000, added: [SALT], removed: ['gone/old'], moved: { 'old/id': 'new/id' }, rejected: 3, notes: ['override for x/y names no detected work'], overridesError: 'Unexpected token } in JSON', persisted: true };
	};
	const ana = member(w, ANA, 'Ana');
	const no = await runSlash({ books: recordingBooks().books }, w, ana, 'rescan', {});
	assert.match(contentOf(no[0]), /Only the bot owner/);
	assert.strictEqual(rebuilt, 0);
	const owner = member(w, OWNER, 'Owner');
	const calls = await runSlash({ books: recordingBooks().books }, w, owner, 'rescan', {});
	assert.strictEqual(rebuilt, 1);
	assert.deepStrictEqual(calls.map(c => c[0]), ['editReply', 'followUp']);
	const text = contentOf(calls[1]);
	assert.match(text, /Rescanned: 16 works \(15 books, 1 podcasts\), 120 parts, 300 h 00 m/);
	assert.match(text, /➕ Added \(1\): The Salt Crown/);
	assert.match(text, /➖ Removed \(1\): gone\/old/);
	assert.match(text, /↪ Renamed \(1\), bookmarks follow: old\/id → new\/id/);
	assert.match(text, /🔍 Check the part order of \(1\): The Glass Road/);
	assert.match(text, /book_overrides\.json could not be read/);
	assert.match(text, /Long groups not taken as books.*: Sam Drift\/\[Unknown Album\] \(2\.5 h\)/);
	assert.match(text, /📝 override for x\/y names no detected work/);

	// The bug: the rejected list printed the host's full folder paths, drive letter and all, and
	// `!book rescan` posts in the open channel.
	const prefixCalls = await runPrefix({ books: recordingBooks().books }, w, owner, 'rescan');
	const posted = prefixCalls.map(contentOf).join('\n');
	assert.match(posted, /Sam Drift\/\[Unknown Album\] \(2\.5 h\)/);
	assert.doesNotMatch(posted, /M:\/|Music\//);

	bookLibrary.rebuild = async () => ({ ok: false, skipped: 'refreshing' });
	const scanning = await runSlash({ books: recordingBooks().books }, w, owner, 'rescan', {});
	assert.match(contentOf(scanning[1]), /Plex is scanning the library right now/);
});

// The bug: a failed rescan printed the raw error, and a network error names the Plex host and
// port; `!book rescan` answers in the open channel.
test('a failed rescan shows the error code, never the Plex host', async () => {
	const w = world();
	config.ownerId = OWNER;
	const owner = member(w, OWNER, 'Owner');
	const cases = [
		['connect ECONNREFUSED 192.0.2.20:32400', /Rescan failed: ECONNREFUSED\b/],
		['getaddrinfo ENOTFOUND plex.example.internal', /Rescan failed: ENOTFOUND\b/],
		['connect ETIMEDOUT 198.51.100.5:32400', /Rescan failed: ETIMEDOUT\b/],
		['Plex Server didnt respond with a valid 2xx status code, response code: 401', /Rescan failed: HTTP 401\b/],
		['socket hang up at plex.example.internal', /Rescan failed: Plex did not answer\b/],
	];
	for (const [error, shown] of cases) {
		bookLibrary.rebuild = async () => ({ ok: false, error });
		const calls = await runPrefix({ books: recordingBooks().books }, w, owner, 'rescan');
		const posted = calls.map(contentOf).join('\n');
		assert.match(posted, shown);
		assert.doesNotMatch(posted, /192\.0\.2|198\.51\.100|plex\.example|32400/);
		assert.match(posted, /The last catalog is still in use/);
	}

	bookLibrary.rebuild = async () => { throw new Error('connect ECONNREFUSED 192.0.2.20:32400'); };
	const thrown = (await runPrefix({ books: recordingBooks().books }, w, owner, 'rescan')).map(contentOf).join('\n');
	assert.match(thrown, /Rescan failed: ECONNREFUSED\b/);
	assert.doesNotMatch(thrown, /192\.0\.2/);
});

// ---- help -------------------------------------------------------------------------------------

test('the help embed fits with Archipelago and audiobooks on or off', async () => {
	const lengths = {};
	for (const ap of [false, true]) {
		for (const books of [false, true]) {
			config.archipelagoEnabled = ap;
			config.audiobooksEnabled = books;
			let embed = null;
			await help.command.process(null, null, { channel: { async send(p) { embed = p.embeds[0].data; } }, author: {} });
			const total = embed.title.length + embed.description.length + embed.footer.text.length;
			assert.ok(embed.description.length <= 4096, `AP ${ap}, books ${books}: ${embed.description.length}`);
			assert.ok(total <= 6000);
			assert.strictEqual(/book play \[title\]/.test(embed.description), books, 'the line shows only while audiobooks are on');
			lengths[`${ap}/${books}`] = embed.description.length;
		}
	}
	assert.ok(lengths['true/true'] - lengths['true/false'] <= 160, 'one short line');
});

test('text and link are /book subcommands, in the usage line and the sub-help', () => {
	const names = book._internal.SUBCOMMANDS.map(s => s.name);
	assert.ok(names.includes('text') && names.includes('link'));
	assert.ok(names.length <= 25);
	assert.match(book.command.usage, /\|text\|link\|/);
	const help = book._internal.helpEmbed({ config: { commandPrefix: '!' } }).data.description;
	assert.match(help, /READ ALONG/);
	assert.ok(!/\/config/.test(help));
});

// The bug: Number(null) is 0, so a series with no number (a podcast, or a series the online
// lookup filled without one) was listed as "#null" and sorted ahead of book 1.
test('the library lists a series book with no number without "#null", after the numbered ones', () => {
	const works = [
		{ id: 'a/two', title: 'Two', author: 'A', series: 'S', sequence: 2, parts: [], totalMs: 0 },
		{ id: 'a/loose', title: 'Loose', author: 'A', series: 'S', sequence: null, parts: [], totalMs: 0 },
		{ id: 'a/one', title: 'One', author: 'A', series: 'S', sequence: 1, parts: [], totalMs: 0 }
	];
	const reply = require('../commands/book.js/library.js').libraryReply('u', '', {}, { bookmarks: { get: () => null }, catalog: { works: () => works, findWorks: () => works }, sections: () => new Map() });
	const lines = reply.content.split('\n').filter(l => l.startsWith('•'));
	assert.deepStrictEqual(lines.map(l => l.split(' · ')[0]), ['• #1 One', '• #2 Two', '• Loose']);
});

// ---- matching what was typed ------------------------------------------------------------------

const EMBER = 'avery-quill/the-ember-throne';
const LANTERN = 'avery-quill/the-last-lantern';
const IRON = 'avery-quill/the-iron-wake';
const GLASS = 'avery-quill/the-glass-road';

function buttonIds(call) {
	const rows = (call[1] && call[1].components) || [];
	return rows.flatMap(r => r.components.map(b => b.custom_id));
}

function withWorks(extra) {
	const c = JSON.parse(JSON.stringify(fixture));
	const base = c.works[SALT];
	for (const [id, fields] of Object.entries(extra)) {
		c.works[id] = Object.assign(JSON.parse(JSON.stringify(base)), { id, series: null, sequence: null, narrator: null, edition: null, aliases: [] }, fields);
	}
	catalog.replace(c);
}

async function playAs(who, query) {
	const w = world();
	const bot = realBot();
	const calls = await runPrefix(bot, w, member(w, who, 'Reader'), query);
	const s = bot.books.session(G);
	return { calls, reply: contentOf(calls.find(c => c[0] === 'reply')), workId: s ? s.workId : null, bot, w };
}

// The bug: "!book start artifical condition", "!book play Artifical Conditioon" and "!book play
// Rouge Protocol" each answered "Nothing in the audiobook library matches", and the owner gave up
// typing titles.
test('a typo is answered "Did you mean ...?" with a play button, and starts nothing', async () => {
	for (const query of ['play the slat crown', 'start Slat Crwon']) {
		const r = await playAs(ANA, query);
		assert.strictEqual(r.workId, null, query);
		assert.match(r.reply, /^Nothing in the audiobook library matches ".*"\. Did you mean \*\*The Salt Crown\*\*\?$/, query);
		assert.deepStrictEqual(buttonIds(r.calls.find(c => c[0] === 'reply')), [`book:play:${SALT}`], query);
	}
	const w = world();
	const bot = realBot();
	const slashed = await runSlash(bot, w, member(w, ANA, 'Ana'), 'play', { title: 'slat crwn' });
	assert.strictEqual(slashed.length, 1);
	assert.match(slashed[0][1].content, /Did you mean \*\*The Salt Crown\*\*\?/);
	assert.deepStrictEqual(buttonIds(slashed[0]), [`book:play:${SALT}`]);
	assert.strictEqual(bot.books.session(G), null);
	const none = await playAs(ANA, 'play zzkk qqxx');
	assert.match(none.reply, /Nothing in the audiobook library matches "zzkk qqxx"\. `\/book library` lists what is there\./);
	assert.strictEqual(buttonIds(none.calls[0]).length, 0);
});

// The bug: "mistborn" started Mistborn - Collected Tales (#7), the one title starting with the
// word, while the owner had The Final Empire in progress.
test('a series name resumes your book in progress there, else the lowest number you have not finished', async () => {
	assert.strictEqual((await playAs(ANA, 'play ashfall')).workId, EMBER, 'nothing started: #1');
	bookmarks.markFinished(BEN, catalog.work(EMBER));
	assert.strictEqual((await playAs(BEN, 'play ashfall')).workId, SALT, '#1 finished: #2');
	bookmarks.record(OWNER, catalog.work(IRON), { absoluteMs: 600000, guildId: G }, { force: true });
	bookmarks.record(OWNER, catalog.work(SALT), { absoluteMs: 600000, guildId: G }, { force: true });
	bookmarks.record(OWNER, catalog.work(IRON), { absoluteMs: 700000, guildId: G }, { force: true });
	assert.strictEqual((await playAs(OWNER, 'play the ashfall')).workId, IRON, 'the newest book in progress');
});

test('"<series> <n>" plays that number, and a number the series lacks lists the series', async () => {
	assert.strictEqual((await playAs(ANA, 'play ashfall 3')).workId, LANTERN);
	assert.strictEqual((await playAs(ANA, 'play ashfall #3')).workId, LANTERN);
	assert.strictEqual((await playAs(ANA, 'play ashfall book three')).workId, LANTERN);
	const missing = await playAs(ANA, 'play ashfall 9');
	assert.strictEqual(missing.workId, null);
	assert.match(missing.reply, /^Ashfall has no #9 in the library\. It has #1, #2, #3, #4, #5, #6, #7\. Pick one:/);
	assert.match(missing.reply, /…and 2 more; `\/book library Ashfall` lists them all\.$/);
	assert.strictEqual(buttonIds(missing.calls[0]).length, 5);
});

// The bug: "stephen fry" started the one of his four books whose title holds his name.
test('an author\'s name resumes their book you have in progress, else lists their books', async () => {
	const list = await playAs(ANA, 'play avery quill');
	assert.strictEqual(list.workId, null);
	assert.match(list.reply, /^Which one\?\n/);
	assert.match(list.reply, /…and 3 more; `\/book library Avery Quill` lists them all\.$/);
	assert.strictEqual(buttonIds(list.calls[0]).length, 5);
	bookmarks.record(BEN, catalog.work(GLASS), { absoluteMs: 600000, guildId: G }, { force: true });
	assert.strictEqual((await playAs(BEN, 'play quill')).workId, GLASS, 'the surname alone');
	assert.strictEqual((await playAs(BEN, 'play avery quill')).workId, GLASS);
});

test('of several editions with one title, the one you have in progress plays', async () => {
	bookmarks.record(BEN, catalog.work('ilse-moreau/the-far-shore~penrose'), { absoluteMs: 600000, guildId: G }, { force: true });
	assert.strictEqual((await playAs(BEN, 'play the far shore')).workId, 'ilse-moreau/the-far-shore~penrose');
	assert.strictEqual((await playAs(ANA, 'play the far shore')).workId, null, 'yours only');
});

// The bug: "odyssey" started Odyssey: Stephen Fry's Greek Myths without asking about The Odyssey,
// and "the mythos" started a book whose author field held both words over Mythos itself.
test('a leading article is ignored for the prefix tier, and names a title exactly when typed', async () => {
	withWorks({
		'ilka-varo/the-voyage': { title: 'The Voyage', author: 'Ilka Varo' },
		'perrin-hale/voyage-retold-tales': { title: 'Voyage: Retold Tales', author: 'Perrin Hale' },
		'noor-vasquez/lanterns': { title: 'Lanterns', author: 'Noor Vasquez' },
		'the-lanterns-collective/songs': { title: 'Songs', author: 'The Lanterns Collective' }
	});
	const asks = await playAs(ANA, 'play voyage');
	assert.strictEqual(asks.workId, null);
	assert.deepStrictEqual(buttonIds(asks.calls[0]).sort(), ['book:play:ilka-varo/the-voyage', 'book:play:perrin-hale/voyage-retold-tales']);
	assert.strictEqual((await playAs(ANA, 'play the voyage')).workId, 'ilka-varo/the-voyage');
	assert.strictEqual((await playAs(ANA, 'play the lanterns')).workId, 'noor-vasquez/lanterns');
	assert.strictEqual((await playAs(ANA, 'play final empire')).workId, null, 'nothing of that name in the fixture');
	assert.strictEqual((await playAs(ANA, 'play salt crown')).workId, SALT);
});

// The bug: a choice row dropped every work whose id made the button's custom_id longer than
// Discord's 100 characters, so a reply could list four books and offer three buttons.
test('a work with a long id gets a short button key that plays it', async () => {
	const longId = `some-author-with-a-long-name/${'the-orchard-of-glass-and-a-subtitle-'.repeat(2)}unabridged`;
	withWorks({ [longId]: { title: 'The Orchard of Glass', author: 'Some Author' } });
	const r = await playAs(ANA, 'play orchrd of glass');
	assert.strictEqual(r.workId, null);
	const [id] = buttonIds(r.calls[0]);
	assert.ok(id.length <= 100 && /^book:play:~[0-9a-f]{16}$/.test(id), id);
	const w = world();
	const bot = realBot();
	const res = await bot.books.play({ guild: w.guild, member: member(w, ANA, 'Ana'), userId: ANA, textChannel: w.channel, workId: id.slice('book:play:'.length) });
	assert.strictEqual(res.ok, true, res.text);
	assert.strictEqual(bot.books.session(G).workId, longId);
});

// The bug: "!book read Artifical Condition" answered only 'Unknown book command "read"'.
test('an unknown subcommand offers the rest of the line as a book to play, or the command it misspells', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const r = recordingBooks();
	const read = await runPrefix({ books: r.books }, w, ana, 'read the slat crown');
	assert.strictEqual(read.length, 1);
	assert.strictEqual(contentOf(read[0]), 'Unknown book command "read". Did you mean `!book play The Salt Crown`?');
	assert.deepStrictEqual(buttonIds(read[0]), [`book:play:${SALT}`]);
	const bare = await runPrefix({ books: r.books }, w, ana, 'ashfall');
	assert.match(contentOf(bare[0]), /^Unknown book command "ashfall"\. Did you mean `!book play The Ember Throne`\?$/, 'the series, from its lowest number');
	assert.match(contentOf((await runPrefix({ books: r.books }, w, ana, 'pasue'))[0]), /^Unknown book command "pasue"\. Did you mean `!book pause`\?$/);
	assert.match(contentOf((await runPrefix({ books: r.books }, w, ana, 'speeed 2'))[0]), /Did you mean `!book speed 2`\?$/);
	const plain = await runPrefix({ books: r.books }, w, ana, 'read zzkk');
	assert.strictEqual(contentOf(plain[0]), 'Unknown book command "read". `!book ?` lists them.');
	assert.ok(!r.calls.some(c => c[0] === 'play'), 'nothing was played');
	config.audiobooksEnabled = false;
	assert.strictEqual(contentOf((await runPrefix({ books: r.books }, w, ana, 'read the salt crown'))[0]), 'Unknown book command "read". `!book ?` lists them.');
});

// The bug: v5 shortened "Odyssey: Stephen Fry's Greek Myths" to "Odyssey", and the exact tier took
// the one title that matched letter for letter, so "odyssey" started it without asking about
// The Odyssey.
test('a bare title asks between itself and the same title with an article', async () => {
	withWorks({
		'perrin-hale/odyssey': { title: 'Odyssey', author: 'Perrin Hale' },
		'ilka-varo/the-odyssey': { title: 'The Odyssey', author: 'Ilka Varo' }
	});
	const asks = await playAs(ANA, 'play odyssey');
	assert.strictEqual(asks.workId, null);
	assert.deepStrictEqual(buttonIds(asks.calls[0]).sort(), ['book:play:ilka-varo/the-odyssey', 'book:play:perrin-hale/odyssey']);
	bookmarks.record(BEN, catalog.work('perrin-hale/odyssey'), { absoluteMs: 600000, guildId: G }, { force: true });
	assert.strictEqual((await playAs(BEN, 'play odyssey')).workId, 'perrin-hale/odyssey', 'the one you have in progress');
});

// The bug: a bare "!book <title>" tried the rest of the line after the first word before the
// whole line, so "!book whale fall" offered The Fall of Hyperion, "murderbot 2" a Vol 2 of
// something else and "oath bringer" nothing at all.
test('a bare title with no verb is tried whole first, offered with play buttons, and never started', async () => {
	withWorks({
		'ida-moss/whalefall': { title: 'Whalefall', author: 'Ida Moss' },
		'kel-ash/the-fall-of-kings': { title: 'The Fall of Kings', author: 'Kel Ash' },
		'kel-ash/saltbringer': { title: 'Saltbringer', author: 'Kel Ash' }
	});
	const w = world();
	const ana = member(w, ANA, 'Ana');
	const r = recordingBooks();
	const ask = async (q) => (await runPrefix({ books: r.books }, w, ana, q))[0];
	const whale = await ask('whale fall');
	assert.strictEqual(contentOf(whale), 'Unknown book command "whale". Did you mean `!book play Whalefall`?');
	assert.deepStrictEqual(buttonIds(whale), ['book:play:ida-moss/whalefall']);
	assert.strictEqual(contentOf(await ask('ashfall 2')), 'Unknown book command "ashfall". Did you mean `!book play The Salt Crown`?');
	assert.strictEqual(contentOf(await ask('salt bringer')), 'Unknown book command "salt". Did you mean `!book play Saltbringer`?');
	const author = await ask('avery quill');
	assert.strictEqual(buttonIds(author).length, 5);
	bookmarks.record(ANA, catalog.work(IRON), { absoluteMs: 600000, guildId: G }, { force: true });
	assert.strictEqual(contentOf(await ask('avery quill')), 'Unknown book command "avery". Did you mean `!book play The Iron Wake`?', 'your book in progress first');
	assert.strictEqual(contentOf(await ask('ashfall')), 'Unknown book command "ashfall". Did you mean `!book play The Iron Wake`?');
	assert.ok(!r.calls.some(c => c[0] === 'play'), 'nothing was played');
});

// The bug: a first word one edit from a subcommand was always offered as that subcommand, so
// "!book exit strategy" suggested the owner-only `!book edit strategy` and never the book.
test('a title whose first word looks like a subcommand is offered as the book too', async () => {
	withWorks({ 'kel-ash/exit-strategy': { title: 'Exit Strategy', author: 'Kel Ash' } });
	const w = world();
	const r = recordingBooks();
	const calls = await runPrefix({ books: r.books }, w, member(w, ANA, 'Ana'), 'exit strategy');
	assert.strictEqual(contentOf(calls[0]), 'Unknown book command "exit". Did you mean `!book play Exit Strategy` or `!book edit strategy`?');
	assert.deepStrictEqual(buttonIds(calls[0]), ['book:play:kel-ash/exit-strategy']);
	assert.strictEqual(contentOf((await runPrefix({ books: r.books }, w, member(w, ANA, 'Ana'), 'exit zzkk'))[0]), 'Unknown book command "exit". Did you mean `!book edit zzkk`?');
});

// The bug: "???" or "潘" normalises to nothing, findWorks of nothing is every work, and with one
// book open the prefix tier picked it: "!book play ???" resumed it and "!book finish ?" marked it
// finished, losing the listener's place.
test('a query of only punctuation matches nothing, and starts or finishes nothing', async () => {
	bookmarks.record(ANA, catalog.work(SALT), { absoluteMs: 600000, guildId: G }, { force: true });
	for (const q of ['???', '潘']) {
		const r = await playAs(ANA, `play ${q}`);
		assert.strictEqual(r.workId, null, q);
		assert.match(r.reply, /^Nothing in the audiobook library matches/, q);
	}
	const w = world();
	const books = recordingBooks();
	const calls = await runPrefix({ books: books.books }, w, member(w, ANA, 'Ana'), 'finish ?');
	assert.match(contentOf(calls[0]), /^Nothing in the audiobook library matches "\?"/);
	assert.ok(!books.calls.some(c => c[0] === 'finish'));
	const mark = bookmarks.get(ANA, catalog.work(SALT));
	assert.deepStrictEqual([mark.finished, mark.absoluteMs], [false, 600000]);
});

// The bug: each narration of a numbered book counted on its own, so after one edition of #2 was
// finished the other edition of #2 still counted as the lowest unfinished number, and a series
// query started it from the beginning ahead of #3.
test('a series number counts as read once any edition of it is', async () => {
	withWorks({
		'jo-quell/kettle-one': { title: 'Kettle One', author: 'Jo Quell', series: 'Kettle Tales', sequence: 1 },
		'jo-quell/kettle-two~ash': { title: 'Kettle Two', author: 'Jo Quell', series: 'Kettle Tales', sequence: 2, narrator: 'Ash' },
		'jo-quell/kettle-two~birch': { title: 'Kettle Two', author: 'Jo Quell', series: 'Kettle Tales', sequence: 2, narrator: 'Birch' },
		'jo-quell/kettle-three': { title: 'Kettle Three', author: 'Jo Quell', series: 'Kettle Tales', sequence: 3 }
	});
	bookmarks.markFinished(ANA, catalog.work('jo-quell/kettle-one'));
	bookmarks.markFinished(ANA, catalog.work('jo-quell/kettle-two~ash'));
	assert.strictEqual((await playAs(ANA, 'play kettle tales')).workId, 'jo-quell/kettle-three');
});

// The bug: a "Mark finished" or Resume button whose work id was too long carried a short key the
// engine's finish could not resolve.
test('the engine finishes a work named by its short key', async () => {
	const longId = `some-author-with-a-long-name/${'the-orchard-of-glass-and-a-subtitle-'.repeat(3)}unabridged`;
	withWorks({ [longId]: { title: 'The Orchard of Glass', author: 'Some Author' } });
	const bot = realBot();
	const r = bot.books.finish(ANA, require('../helpers/bookSearch.js').shortKey(longId), {});
	assert.strictEqual(r.ok, true, r.text);
	assert.strictEqual(bookmarks.get(ANA, catalog.work(longId)).finished, true);
});

test('finish and forget answer a typo with the ids it probably meant', async () => {
	const w = world();
	const r = recordingBooks();
	const calls = await runPrefix({ books: r.books }, w, member(w, ANA, 'Ana'), 'finish the slat crown');
	assert.strictEqual(contentOf(calls[0]), `Nothing in the audiobook library matches "the slat crown". Did you mean **The Salt Crown** (\`${SALT}\`)?`);
	assert.ok(!r.calls.some(c => c[0] === 'finish'));
});

test('title autocomplete forgives typos and reads "<series> <n>"', async () => {
	const w = world();
	const ana = member(w, ANA, 'Ana');
	assert.deepStrictEqual((await complete({ books: null }, ana, 'play', 'title', 'slat crwn')).map(c => c.value), [SALT]);
	assert.deepStrictEqual((await complete({ books: null }, ana, 'play', 'title', 'ashfall 3')).map(c => c.value), [LANTERN]);
	assert.strictEqual((await complete({ books: null }, ana, 'play', 'title', 'ashfall 9')).length, 7, 'the series, when it has no such number');
	assert.deepStrictEqual(await complete({ books: null }, ana, 'play', 'title', 'zzkk qqxx'), []);
});

// The bug: a /book play picked from autocomplete arrived as a bare id, so a wrong pick could not
// be told from a typo when reading the log afterwards.
test('the text typed into autocomplete is logged with the slash command that follows', async () => {
	const commandLog = require('../helpers/commandLog.js');
	const w = world();
	const ana = member(w, ANA, 'Ana');
	for (const typed of ['s', 'sl', 'slat cr']) await complete({ books: null }, ana, 'play', 'title', typed);
	commandLog.startInvocation({ path: 'slash', command: 'book', args: `play ${SALT}`, userId: ANA });
	commandLog.startInvocation({ path: 'slash', command: 'book', args: `play ${SALT}`, userId: ANA });
	await complete({ books: null }, ana, 'play', 'title', 'glass');
	commandLog.startInvocation({ path: 'slash', command: 'book', args: 'shelf', userId: ANA });
	const args = commandLog.readInvocations({ command: 'book' }).invocations.map(i => i.args);
	assert.deepStrictEqual(args.sort(), [`play ${SALT}`, `play ${SALT} [typed "slat cr"]`, 'shelf'].sort(), 'once, the last text, and only on the subcommand it was typed for');
});
