// helpers/bookButtons.js: the book:* buttons against a real BookDirector.
//
// The bug: a control click answered with deferReply plus a channel message (a new message per
// click, and the card itself never changes); a stranger driving someone else's book; an old card
// driving the live session; a click that is never acknowledged ("This interaction failed") or
// acknowledged twice (the second call throws); "Mark finished" usable by anyone, marking the
// clicker's own copy finished; the engine editing the card again right after the click's own
// update.
//
// Harness: a real createBookDirector with the deps seams bookEngine.test.js uses (injected manual
// clock, fake player and connection) and a probe that never answers, so a session plays nothing
// and spawns no ffmpeg. The catalog and bookmark stores are the real ones on pid-suffixed temp
// files, seeded from test/fixtures/books/catalog.json. Interactions are recording fakes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-buttons-${process.pid}`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const bookmarks = require('../helpers/bookmarks.js');
const catalog = require('../helpers/bookCatalogStore.js');
const { createBookDirector } = require('../helpers/bookEngine.js');
const bookButtons = require('../helpers/bookButtons.js');
const fixture = require('./fixtures/books/catalog.json');

const T0 = 1791500000000;
const G = '200000000000000001';
const VC = '300000000000000001';
const ANA = '100000000000000001';
const BEN = '100000000000000002';
const EMBER = 'avery-quill/the-ember-throne';
const EPHEMERAL = 64;
const ACKS = new Set(['update', 'reply', 'deferReply', 'deferUpdate']);

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
	catalog.reset();
}

let live = [];
test.beforeEach(() => {
	cleanup();
	catalog.replace(JSON.parse(JSON.stringify(fixture)));
});
test.afterEach(() => {
	for (const h of live) h.books.shutdown();
	live = [];
	cleanup();
});
test.after(cleanup);

function manualClock(start) {
	let t = start;
	let seq = 0;
	const due = new Map();
	return {
		setTimeout(fn, ms) {
			const h = { id: ++seq, at: t + Math.max(0, ms || 0), fn, unref() {} };
			due.set(h.id, h);
			return h;
		},
		clearTimeout(h) { if (h) due.delete(h.id); },
		now: () => t
	};
}

class FakePlayer extends EventEmitter {
	constructor() {
		super();
		this.state = { status: 'idle' };
	}
	play(resource) { this.state = { status: 'buffering', resource }; }
	stop() { this.state = { status: 'idle' }; return true; }
}

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this.state = { status: 'ready' };
	}
	subscribe(player) {
		this.state = Object.assign({}, this.state, { subscription: { player } });
		return this.state.subscription;
	}
	destroy() {
		this.state = { status: 'destroyed' };
		this.emit('stateChange', {}, this.state);
	}
}

function fakeMessage(payload) {
	return {
		payload,
		edits: [],
		flags: { has: () => false },
		embeds: payload.embeds || [],
		components: payload.components || [],
		async edit(p) { this.edits.push(p); return this; }
	};
}

function harness() {
	const sent = [];
	const textChannel = { id: '400000000000000001', name: 'books', async send(p) { const m = fakeMessage(p); sent.push(m); return m; } };
	const guild = { id: G, voiceStates: { cache: new Map() } };
	const bot = {
		songQueue: [],
		musicBusy: () => false,
		async openConnection() { return new FakeConn(); },
		async playSong() {}
	};
	const config = { audiobooksEnabled: true, audiobookSaveSeconds: 15, audiobookIdleLeaveMinutes: 10, audiobookResumeRewindSeconds: 10, ownerId: '' };
	const books = createBookDirector({
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
			timers: manualClock(T0),
			config
		}
	});
	bot.books = books;
	const h = { bot, books, sent, textChannel, guild };
	live.push(h);
	return h;
}

function member(h, id, name, channelId) {
	const voice = channelId
		? { channelId, channel: { id: channelId, name: 'Lounge', guild: h.guild } }
		: { channelId: null, channel: null };
	if (channelId) h.guild.voiceStates.cache.set(id, { channelId });
	else h.guild.voiceStates.cache.delete(id);
	return { id, displayName: name, user: { id, username: name }, voice };
}

async function start(h, listener, workId = EMBER) {
	const r = await h.books.play({ guild: h.guild, member: listener, textChannel: h.textChannel, workId });
	assert.strictEqual(r.code, 'playing', r.text);
	const s = h.books.session(G);
	await s.cardChain;
	return s;
}

function click(h, customId, who, { message = null } = {}) {
	const calls = [];
	return {
		customId,
		member: who,
		user: who.user,
		guildId: G,
		guild: h.guild,
		channel: h.textChannel,
		message: message || { flags: { has: () => false }, embeds: [], components: [] },
		replied: false,
		deferred: false,
		calls,
		async update(p) { calls.push(['update', p]); this.replied = true; },
		async reply(p) { calls.push(['reply', p]); this.replied = true; },
		async deferReply(p) { calls.push(['deferReply', p]); this.deferred = true; },
		async deferUpdate() { calls.push(['deferUpdate']); this.deferred = true; },
		async editReply(p) { calls.push(['editReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); }
	};
}

function acks(i) {
	return i.calls.filter(c => ACKS.has(c[0])).length;
}

function only(i, kind) {
	const hit = i.calls.filter(c => c[0] === kind);
	assert.strictEqual(hit.length, 1, `one ${kind}, got ${JSON.stringify(i.calls.map(c => c[0]))}`);
	return hit[0][1];
}

function buttonIds(payload) {
	return (payload.components || []).flatMap(r => r.components).map(b => b.custom_id);
}

test('ids outside the book namespace are left for the next handler', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	for (const id of ['playback:skip', 'tagprop:next:none:0', 'bookx:toggle:abc', 'books:shelf']) {
		const i = click(h, id, ana);
		assert.strictEqual(await bookButtons.handle(i, h.bot, null), false, id);
		assert.deepStrictEqual(i.calls, [], `${id} was touched`);
	}
	assert.strictEqual(await bookButtons.handle({ customId: undefined }, h.bot, null), false);
});

test('a listener control click updates the card in one call and posts nothing', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	assert.strictEqual(h.sent.length, 1, 'the engine posted the card once');
	const before = h.books.position(s);
	const i = click(h, `book:fwd:${s.id}`, ana, { message: h.sent[0] });
	const reported = [];
	assert.strictEqual(await bookButtons.handle(i, h.bot, null, { onInteractionResponse: p => reported.push(p) }), true);
	assert.strictEqual(acks(i), 1);
	const card = only(i, 'update');
	assert.strictEqual(h.books.position(s), before + 30000);
	assert.strictEqual(card.embeds.length, 1);
	assert.deepStrictEqual(buttonIds(card).slice(0, 5), ['prevch', 'back', 'toggle', 'fwd', 'nextch'].map(a => `book:${a}:${s.id}`));
	assert.strictEqual(reported.length, 1, 'the update is reported to the command log');
	await s.cardChain;
	assert.strictEqual(h.sent.length, 1, 'no new channel message');
	assert.strictEqual(h.sent[0].edits.length, 0, 'the engine does not edit the card the click just updated');
});

test('the toggle parks and resumes, and the card follows', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const pause = click(h, `book:toggle:${s.id}`, ana);
	await bookButtons.handle(pause, h.bot, null);
	assert.strictEqual(s.state, 'paused');
	const paused = only(pause, 'update');
	assert.ok(paused.components[0].components.some(b => b.label === 'Resume'));
	const resume = click(h, `book:toggle:${s.id}`, ana);
	await bookButtons.handle(resume, h.bot, null);
	assert.strictEqual(s.state, 'playing');
	assert.ok(only(resume, 'update').components[0].components.some(b => b.label === 'Pause'));
});

test('someone else gets a private refusal and the book is untouched', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const ben = member(h, BEN, 'Ben', VC);
	const pos = h.books.position(s);
	for (const action of ['fwd', 'toggle', 'stop', 'speed']) {
		const i = click(h, `book:${action}:${s.id}`, ben);
		await bookButtons.handle(i, h.bot, null);
		assert.strictEqual(acks(i), 1, action);
		const r = only(i, 'reply');
		assert.strictEqual(r.flags, EPHEMERAL, `${action} refusal is private`);
		assert.match(r.content, /Ana's book: only they can control it/);
	}
	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(h.books.position(s), pos);
	assert.strictEqual(s.speed, 1);
});

test('with the listener gone, someone in the channel may pause or stop but not seek', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	h.guild.voiceStates.cache.delete(ANA);
	const ben = member(h, BEN, 'Ben', VC);
	const seek = click(h, `book:fwd:${s.id}`, ben);
	await bookButtons.handle(seek, h.bot, null);
	assert.match(only(seek, 'reply').content, /only they can control it/);
	const pause = click(h, `book:toggle:${s.id}`, ben);
	await bookButtons.handle(pause, h.bot, null);
	assert.strictEqual(s.state, 'paused');
	only(pause, 'update');
});

test('an old card has its buttons stripped and the clicker is told why', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const oldId = s.id;
	h.books.control(G, ana, 'stop');
	const s2 = await start(h, ana);
	assert.notStrictEqual(s2.id, oldId);
	const i = click(h, `book:fwd:${oldId}`, ana);
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	assert.deepStrictEqual(only(i, 'update'), { components: [] });
	const note = only(i, 'followUp');
	assert.strictEqual(note.flags, EPHEMERAL);
	assert.match(note.content, /earlier session\. \/book now shows the current one/);
	assert.strictEqual(h.books.position(s2), s2.anchorAbsMs, 'the live session did not move');
});

test('stop from the card shows the ended card in the same update', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const i = click(h, `book:stop:${s.id}`, ana);
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	const card = only(i, 'update');
	assert.deepStrictEqual(buttonIds(card), [`book:resume:${EMBER}`, 'book:shelf'], 'far from the end: no Mark finished');
	assert.match(card.embeds[0].description, /⏹ Stopped/);
	assert.strictEqual(h.books.session(G), null);
	await s.cardChain;
	assert.strictEqual(h.sent.length, 1);
	assert.strictEqual(h.sent[0].edits.length, 0, 'the engine left the ended card to the click');
	assert.ok(bookmarks.get(ANA, EMBER), 'the place was saved');
});

test('speed and sleep buttons step through their cycles', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const speed = click(h, `book:speed:${s.id}`, ana);
	await bookButtons.handle(speed, h.bot, null);
	assert.strictEqual(s.speed, 1.1);
	assert.ok(buttonIds(only(speed, 'update')).includes(`book:speed:${s.id}`));
	const sleep = click(h, `book:sleep:${s.id}`, ana);
	await bookButtons.handle(sleep, h.bot, null);
	assert.deepStrictEqual([s.sleep.mode, s.sleep.minutes], ['timer', 15]);
	const label = only(sleep, 'update').components[1].components.find(b => b.custom_id === `book:sleep:${s.id}`).label;
	assert.strictEqual(label, 'Sleep: 15 min');
});

test('a no-op click still updates the card and says why privately', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	h.books.control(G, ana, 'chapter', 4);
	const i = click(h, `book:nextch:${s.id}`, ana);
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	only(i, 'update');
	const note = only(i, 'followUp');
	assert.strictEqual(note.flags, EPHEMERAL);
	assert.match(note.content, /last chapter/);
});

test('mark finished is the listener\'s alone and edits the ended card', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	const total = s.work.parts.reduce((n, p) => n + p.durationMs, 0);
	h.books.control(G, ana, 'goto', { mode: 'absolute', ms: total - 60000 });
	const stop = click(h, `book:stop:${s.id}`, ana);
	await bookButtons.handle(stop, h.bot, null);
	const ended = only(stop, 'update');
	const finishId = `book:finish:${EMBER}:${ANA}`;
	assert.ok(buttonIds(ended).includes(finishId), 'offered within 2 minutes of the end');
	const message = { flags: { has: () => false }, embeds: ended.embeds, components: ended.components };

	const ben = member(h, BEN, 'Ben', VC);
	const theirs = click(h, finishId, ben, { message });
	await bookButtons.handle(theirs, h.bot, null);
	assert.strictEqual(only(theirs, 'reply').flags, EPHEMERAL);
	assert.strictEqual(bookmarks.get(BEN, EMBER), null, 'the clicker got no bookmark');
	assert.notStrictEqual(bookmarks.get(ANA, EMBER).finished, true);

	const mine = click(h, finishId, ana, { message });
	await bookButtons.handle(mine, h.bot, null);
	assert.strictEqual(acks(mine), 1);
	const card = only(mine, 'update');
	assert.deepStrictEqual(buttonIds(card), [`book:resume:${EMBER}`, 'book:shelf']);
	assert.match(card.embeds[0].description, /Marked finished/);
	assert.strictEqual(bookmarks.get(ANA, EMBER).finished, true);
});

test('my shelf answers privately', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	h.books.control(G, ana, 'stop');
	await s.cardChain;
	const i = click(h, 'book:shelf', ana);
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	const r = only(i, 'reply');
	assert.strictEqual(r.flags, EPHEMERAL);
	assert.match(r.embeds[0].description, /The Ember Throne/);
	assert.deepStrictEqual(buttonIds(r), [`book:resume:${EMBER}`]);
});

test('resume from the public ended card answers privately and plays for the clicker', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const s = await start(h, ana);
	h.books.control(G, ana, 'stop');
	await s.cardChain;
	const i = click(h, `book:resume:${EMBER}`, ana, { message: h.sent[0] });
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	assert.deepStrictEqual(only(i, 'deferReply'), { flags: EPHEMERAL });
	assert.match(only(i, 'editReply').content, /▶ Resuming The Ember Throne/);
	const now = h.books.session(G);
	assert.ok(now && now.userId === ANA && now.workId === EMBER);
	assert.notStrictEqual(now.id, s.id);
});

test('a pick from the private "Which one?" list replaces the list with the answer', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const eph = { flags: { has: f => f === EPHEMERAL }, embeds: [], components: [] };
	const i = click(h, 'book:play:ilse-moreau/the-far-shore~penrose', ana, { message: eph });
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	only(i, 'deferUpdate');
	const answer = only(i, 'editReply');
	assert.match(answer.content, /Starting The Far Shore/);
	assert.deepStrictEqual(answer.components, [], 'the choice buttons go');
	assert.strictEqual(h.books.session(G).workId, 'ilse-moreau/the-far-shore~penrose');
});

test('the forget confirm forgets through the engine', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	await start(h, ana);
	const eph = { flags: { has: f => f === EPHEMERAL }, embeds: [], components: [] };
	const i = click(h, `book:forget:${EMBER}`, ana, { message: eph });
	await bookButtons.handle(i, h.bot, null);
	assert.strictEqual(acks(i), 1);
	only(i, 'deferUpdate');
	assert.match(only(i, 'editReply').content, /Forgotten/);
	assert.strictEqual(h.books.session(G), null, 'the live session ended first, so it cannot save the place back');
	h.books.shutdown();
	assert.strictEqual(bookmarks.get(ANA, EMBER), null);
});

test('a bot with no book player still answers the click', async () => {
	const h = harness();
	const ana = member(h, ANA, 'Ana', VC);
	const i = click(h, 'book:toggle:abcdef', ana);
	assert.strictEqual(await bookButtons.handle(i, { books: null }, null), true);
	assert.strictEqual(acks(i), 1);
	assert.strictEqual(only(i, 'reply').flags, EPHEMERAL);
});
