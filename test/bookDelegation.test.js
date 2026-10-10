// Decision D2: !pause, !resume, !skip and !stop, and the old music card's buttons, act on a book
// playing in the guild (commands/pause.js, resume.js, skip.js, stop.js, helpers/playbackButtons.js).
//
// The bug: with a book playing, !pause answered "Nothing is playing" while the book kept going,
// !skip said "nothing to be skipped" instead of moving a chapter, and !stop left the book running.
// The old card's Pause/Resume toggle picked its command from bot.isPaused, which a book never
// sets, so a parked book could never be resumed from it. The other way round, the delegation must
// not change anything without a book: no director, or a director with no session in the guild,
// leaves every command exactly as it was. A caller the book does not let act is told so instead
// of getting a music answer about music that is not playing. !stop must not hand the voice to
// queued music (only /book stop does, D1).
//
// Harness: test/bookEngineVoice.test.js's, trimmed (a real AudioPlayer on silence frames, a
// FakeConn with VoiceConnection's subscription hand-over, an injected manual clock, the real
// bookmark store on a pid-suffixed temp file, joins held open by a deferred promise), with the
// real command modules run against a plain fake Bot that also serves as the director's bot.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-delegation-${process.pid}.json`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), `plexbot-test-book-delegation-log-${process.pid}`);

const voice = require('@discordjs/voice');
const bookmarks = require('../helpers/bookmarks.js');
const voiceClaims = require('../helpers/voiceClaims.js');
const { createBookDirector } = require('../helpers/bookEngine.js');
const playbackButtons = require('../helpers/playbackButtons.js');
const language = require('../lang/en.js');
const pause = require('../commands/pause.js');
const resume = require('../commands/resume.js');
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');

const COMMANDS = { pause, resume, skip, stop };
const PLEX_COMMANDS = { pause: pause.command, resume: resume.command, skip: skip.command, stop: stop.command };

const S = 1000;
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(FILE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
}
test.afterEach(cleanup);
test.after(() => {
	cleanup();
	try { fs.rmSync(process.env.PLEXBOT_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ---- harness ------------------------------------------------------------------------------

function part(work, i, durationMs) {
	return {
		ordinal: i + 1,
		albumRatingKey: `${work}0`,
		trackRatingKey: `${work}${i + 1}`,
		title: `Part ${i + 1}`,
		durationMs,
		partKey: `/library/parts/${work}${i + 1}/1700000000/part${i + 1}.mp3`,
		file: `part${i + 1}.mp3`,
		sizeBytes: 1000 + i,
		container: 'mp3'
	};
}

const LONG = {
	id: 'test-author/long-book',
	kind: 'book',
	title: 'Long Book',
	author: 'Test Author',
	narrator: null,
	edition: null,
	series: null,
	sequence: null,
	aliases: [],
	parts: [part(81, 0, 600 * S), part(81, 1, 600 * S)]
};

function manualClock(start = Date.now()) {
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
		now: () => t,
		advance(ms) {
			const end = t + ms;
			for (;;) {
				let next = null;
				for (const d of due.values()) {
					if (d.at <= end && (!next || d.at < next.at || (d.at === next.at && d.id < next.id))) next = d;
				}
				if (!next) break;
				due.delete(next.id);
				t = next.at;
				next.fn();
			}
			t = end;
		}
	};
}

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'ready' };
		this.destroyCount = 0;
	}
	get state() { return this._state; }
	set state(next) {
		const old = this._state;
		this._state = next;
		if (old.subscription && old.subscription !== next.subscription) old.subscription.unsubscribe();
		this.emit('stateChange', old, next);
	}
	subscribe(player) {
		if (this._state.status === 'destroyed') return undefined;
		const sub = player['subscribe'](this);
		this.state = { ...this._state, subscription: sub };
		return sub;
	}
	onSubscriptionRemoved(sub) {
		if (this._state.status !== 'destroyed' && this._state.subscription === sub) this._state = { ...this._state, subscription: undefined };
	}
	destroy() {
		if (this._state.status === 'destroyed') throw new Error('Cannot destroy VoiceConnection - it has already been destroyed');
		this.destroyCount++;
		this.state = { status: 'destroyed' };
	}
	setSpeaking() {}
	prepareAudioPacket() {}
	dispatchAudio() {}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, what, ms = 5000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

function makeGuild(id = 'g1') {
	return { id, voiceStates: { cache: new Map() }, voiceAdapterCreator: () => ({}) };
}

function makeMember(guild, id, name, channel) {
	if (channel) guild.voiceStates.cache.set(id, { channelId: channel.id });
	return {
		id,
		displayName: name,
		user: { id, username: name },
		guild,
		voice: {
			channel: channel || null,
			get channelId() { return this.channel ? this.channel.id : null; }
		}
	};
}

function makeTextChannel(id = 't1') {
	const ch = {
		id,
		sent: [],
		async send(payload) {
			const msg = { payload, edits: [], async edit(p) { msg.edits.push(p); return msg; } };
			ch.sent.push(msg);
			return msg;
		}
	};
	return ch;
}

/**
 * The music side as the four commands see it: queue, flags, a dispatcher and stop(). It is
 * also the director's bot (musicBusy, openConnection, playSong).
 */
function makeBot(opts = {}) {
	const conns = [];
	const bot = {
		language,
		songQueue: [],
		isPlaying: false,
		isPaused: false,
		dispatcher: null,
		books: null,
		stopCalls: 0,
		played: [],
		joins: [],
		conns,
		stop() { this.stopCalls++; },
		musicBusy() { return false; },
		openConnection(channel) {
			const d = deferred();
			bot.joins.push({ channel, ...d });
			if (!opts.manualJoins) {
				const c = new FakeConn();
				conns.push(c);
				d.resolve(c);
			}
			return d.promise;
		},
		playSong(message) { this.played.push(message); return Promise.resolve(); }
	};
	return bot;
}

/** A music player stub: pause() and unpause() take only from Playing and Paused, as the real one. */
function musicPlayer(status = voice.AudioPlayerStatus.Playing) {
	const calls = [];
	return {
		calls,
		state: { status },
		pause() {
			calls.push('pause');
			if (this.state.status !== voice.AudioPlayerStatus.Playing) return false;
			this.state = { status: voice.AudioPlayerStatus.Paused };
			return true;
		},
		unpause() {
			calls.push('unpause');
			if (this.state.status !== voice.AudioPlayerStatus.Paused) return false;
			this.state = { status: voice.AudioPlayerStatus.Playing };
			return true;
		},
		stop() { calls.push('stop'); }
	};
}

function director(bot, clock, extra = {}) {
	const partsByKey = new Map(LONG.parts.map(p => [p.partKey, p]));
	const builds = [];
	const deps = {
		timers: clock,
		config: {
			audiobooksEnabled: true,
			audiobookSaveSeconds: 15,
			audiobookIdleLeaveMinutes: 10,
			audiobookResumeRewindSeconds: 10,
			ownerId: 'owner'
		},
		bookmarks,
		catalog: {
			works: () => [LONG],
			work: id => (id === LONG.id ? LONG : null),
			findWorks: () => [LONG],
			partKeyFor: (workId, p) => p.partKey
		},
		library: { start: () => null, stop() {}, ensureFresh: async () => ({ action: 'fresh' }), status: () => 'ready', lastError: () => null },
		repairPartKey: async () => null,
		ensureFresh: async () => ({ action: 'fresh' }),
		proxy: { stop: async () => {} },
		probe: async () => ({ ok: true, status: 206 }),
		urlFor: key => `fake:${key}`,
		createPlayer: () => voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause, maxMissedFrames: 750 } }),
		createResource: ({ url, startMs, speed }) => {
			const p = partsByKey.get(url.slice('fake:'.length));
			const frames = Math.max(1, Math.round((p.durationMs - startMs) / speed / 20));
			let n = 0;
			const s = new Readable({ objectMode: true, read() { if (n++ < frames) this.push(SILENCE); else this.push(null); } });
			const resource = voice.createAudioResource(s, { inputType: voice.StreamType.Opus });
			const build = { part: p, startMs, speed, killed: 0 };
			const kill = () => { build.killed++; if (!s.destroyed) s.destroy(); };
			resource.playStream.once('close', kill);
			builds.push(build);
			return { resource, kill };
		},
		card: {
			buildCard: v => ({ kind: 'card', view: v }),
			endedCard: v => ({ kind: 'ended', view: v }),
			movedCard: () => ({ kind: 'moved' })
		},
		commandLog: { recordEvent() {} },
		getVoiceConnection: () => bot.conns[bot.conns.length - 1]
	};
	const client = new EventEmitter();
	client.user = { id: 'bot' };
	const d = createBookDirector({ client, bot, deps: Object.assign(deps, extra) });
	d.builds = builds;
	return d;
}

function harness(opts = {}) {
	// A previous test's director saves on shutdown, after afterEach has already run.
	cleanup();
	const clock = manualClock();
	const guild = makeGuild();
	const voiceChannel = { id: 'v1', name: 'Reading Room', guild };
	const textChannel = makeTextChannel();
	const listener = makeMember(guild, 'u1', 'Reader', voiceChannel);
	const bot = makeBot(opts);
	bot.books = director(bot, clock);
	return {
		clock, guild, voiceChannel, textChannel, listener, bot,
		play() { return bot.books.play({ guild, member: listener, textChannel, workId: LONG.id }); },
		session() { return bot.books.session(guild.id); },
		async done() {
			bot.books.shutdown();
			await tick();
		}
	};
}

async function playing(h) {
	const r = await h.play();
	assert.strictEqual(r.ok, true, `play failed: ${r.code} ${r.text}`);
	await until(() => h.session() && h.session().audible, 'audio');
	return h.session();
}

/** A prefix message: what it got back as replies and channel posts, in order. */
function message(guild, member) {
	const out = [];
	return {
		out,
		guild,
		member,
		author: member.user,
		channel: { id: 't1', send(p) { out.push({ send: p }); return Promise.resolve({}); } },
		reply(p) { out.push({ reply: p }); return Promise.resolve({}); }
	};
}

const replyText = m => m.out.map(o => (o.reply && o.reply.content) || o.reply || o.send);

function run(bot, name, member, guild, query = '') {
	const m = message(guild, member);
	COMMANDS[name].command.process(bot, {}, m, query);
	return m;
}

/** A button click on the old music card, through helpers/playbackButtons.js and the adapter. */
function click(h, action, member) {
	const out = [];
	const interaction = {
		customId: `playback:${action}`,
		guildId: h.guild.id,
		guild: h.guild,
		member,
		user: member.user,
		client: {},
		commandName: action,
		channel: { id: 't1', send(p) { out.push({ send: p }); return Promise.resolve({}); } },
		async deferReply() { out.push('defer'); },
		async editReply(p) { out.push({ edit: p }); return {}; },
		async followUp(p) { out.push({ followUp: p }); return {}; },
		async reply(p) { out.push({ reply: p }); return {}; }
	};
	return playbackButtons.handle(interaction, h.bot, {}, PLEX_COMMANDS).then(handled => ({ handled, out }));
}

// ---- no book: as before -------------------------------------------------------------------

/** What a command did to the music side: its messages, the flags, the queue and the player. */
function snapshot(bot, m) {
	return JSON.stringify({
		out: m.out,
		queue: bot.songQueue.map(t => t.title),
		isPlaying: bot.isPlaying,
		isPaused: bot.isPaused,
		stopCalls: bot.stopCalls,
		player: bot.dispatcher && { status: bot.dispatcher.state.status, calls: bot.dispatcher.calls }
	});
}

const SCENES = {
	idle: bot => {},
	playing: bot => {
		bot.isPlaying = true;
		bot.dispatcher = musicPlayer();
		bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' }, { title: 'Song B', artist: 'Engelwood' });
	},
	paused: bot => {
		bot.isPlaying = true;
		bot.isPaused = true;
		bot.dispatcher = musicPlayer(voice.AudioPlayerStatus.Paused);
		bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });
	},
	queuedOnly: bot => {
		bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });
	}
};

test('with no director, or a director with no book in the guild, every command does exactly what it did', async (t) => {
	const clock = manualClock();
	const guild = makeGuild();
	const member = makeMember(guild, 'u1', 'Reader', { id: 'v1', guild });
	const routed = [];
	for (const name of Object.keys(COMMANDS)) {
		for (const [scene, setUp] of Object.entries(SCENES)) {
			for (const query of name === 'skip' ? ['', '2', 'x'] : ['']) {
				const plain = makeBot();
				setUp(plain);
				const before = run(plain, name, member, guild, query);

				const withBooks = makeBot();
				withBooks.books = director(withBooks, clock);
				t.after(() => withBooks.books.shutdown());
				const real = withBooks.books.routeGeneric;
				withBooks.books.routeGeneric = (cmd, msg) => {
					const r = real(cmd, msg);
					routed.push({ cmd, r });
					return r;
				};
				setUp(withBooks);
				const after = run(withBooks, name, member, guild, query);

				assert.strictEqual(snapshot(withBooks, after), snapshot(plain, before), `${name} ${scene} '${query}'`);
			}
		}
	}
	assert.ok(routed.length >= 4 * Object.keys(SCENES).length, 'each command asked the director first');
	assert.ok(routed.every(x => x.r === false));
	await tick();
});

test('the old card toggle follows bot.isPaused when no book plays, with or without a director', async (t) => {
	const h = harness();
	t.after(() => h.done());
	for (const books of [null, h.bot.books]) {
		for (const isPaused of [false, true]) {
			const ran = [];
			const spy = name => ({ process() { ran.push(name); } });
			const bot = Object.assign(makeBot(), { books, isPaused });
			const interaction = {
				customId: 'playback:pausetoggle',
				guildId: h.guild.id,
				guild: h.guild,
				member: h.listener,
				user: h.listener.user,
				channel: { send: async () => ({}) },
				async deferReply() {},
				async editReply() { return {}; }
			};
			const handled = await playbackButtons.handle(interaction, bot, {}, { pause: spy('pause'), resume: spy('resume') });
			assert.strictEqual(handled, true);
			assert.deepStrictEqual(ran, [isPaused ? 'resume' : 'pause'], `books ${books ? 'on' : 'off'}, isPaused ${isPaused}`);
		}
	}
});

// ---- a book playing ------------------------------------------------------------------------

test('!pause parks the book and !resume picks it up, without touching the music flags', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);

	const p = run(h.bot, 'pause', h.listener, h.guild);
	assert.strictEqual(s.state, 'paused');
	assert.match(replyText(p)[0], /^⏸ Paused at /);
	assert.strictEqual(p.out.length, 1, 'one reply, no music "Update" post');
	assert.strictEqual(h.bot.isPaused, false, 'music\'s flag is not the book\'s');

	const builds = h.bot.books.builds.length;
	const r = run(h.bot, 'resume', h.listener, h.guild);
	assert.strictEqual(s.state, 'playing');
	assert.match(replyText(r)[0], /^▶ Resuming at /);
	assert.strictEqual(r.out.length, 1);
	await until(() => h.bot.books.builds.length > builds, 'the resumed stream');
});

test('!skip moves the book one chapter on and leaves the music queue alone', async (t) => {
	const h = harness();
	t.after(() => h.done());
	await playing(h);
	h.bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });

	const m = run(h.bot, 'skip', h.listener, h.guild, '3');
	assert.strictEqual(m.out.length, 1);
	assert.match(replyText(m)[0], /^⏭ Part 2 · /);
	await until(() => h.bot.books.builds.length === 2, 'the next chapter\'s stream');
	const b = h.bot.books.builds[1];
	assert.strictEqual(b.part, LONG.parts[1]);
	assert.strictEqual(b.startMs, 0);
	assert.deepStrictEqual(h.bot.songQueue.map(t => t.title), ['Song A']);
	assert.strictEqual(h.bot.stopCalls, 0);
});

test('!stop ends the book, clears the queue and does not start the queued music', async (t) => {
	const h = harness();
	t.after(() => h.done());
	await playing(h);
	h.bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });
	const requester = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);
	const gated = message(h.guild, requester);
	assert.strictEqual(h.bot.books.blocksMusic(gated), true);

	const m = run(h.bot, 'stop', h.listener, h.guild);
	assert.strictEqual(h.bot.books.holds(h.guild.id), false);
	assert.match(replyText(m)[0], /^⏹ Stopped\. Saved at /);
	assert.strictEqual(m.out.length, 1, 'no music "Update" post');
	assert.deepStrictEqual(h.bot.songQueue, []);
	assert.strictEqual(h.bot.stopCalls, 0, 'music had nothing to stop');
	h.clock.advance(60 * S);
	await tick();
	assert.deepStrictEqual(h.bot.played, [], 'a generic stop never hands voice to the queue (D1)');
	assert.ok(bookmarks.get('u1', LONG), 'the place is saved');
});

test('while the bot is still joining, !pause, !resume and !skip say so and !stop ends it', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const pending = h.play();
	assert.strictEqual(h.session().state, 'starting');

	for (const name of ['pause', 'resume', 'skip']) {
		const m = run(h.bot, name, h.listener, h.guild);
		assert.deepStrictEqual(replyText(m), ['Still joining the voice channel, one moment.'], name);
	}
	assert.strictEqual(h.session().state, 'starting');

	h.bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });
	const m = run(h.bot, 'stop', h.listener, h.guild);
	assert.strictEqual(m.out.length, 1);
	assert.strictEqual(h.bot.books.holds(h.guild.id), false);
	assert.strictEqual(voiceClaims.holder(h.guild.id), null, 'the claim is released');
	assert.deepStrictEqual(h.bot.songQueue, []);

	const late = new FakeConn();
	h.bot.conns.push(late);
	h.bot.joins[0].resolve(late);
	const r = await pending;
	assert.strictEqual(r.ok, false);
	assert.strictEqual(late.destroyCount, 1, 'the late connection is let go');
	assert.strictEqual(h.bot.books.builds.length, 0);
});

// The bug: a caller the book did not let act fell through to the music command, which answered
// "Nothing is playing" over an audible book, or announced the queued track behind the book as
// skipped (and still played it after /book stop).
test('a caller the book does not let act is told whose book it is, and the book plays on', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);
	h.bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });
	const bystander = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);
	const owner = makeMember(h.guild, 'owner', 'Owner', null);

	for (const [name, member] of [['pause', bystander], ['resume', bystander], ['skip', bystander], ['skip', owner]]) {
		const m = run(h.bot, name, member, h.guild);
		assert.strictEqual(m.out.length, 1, `${name}: one reply`);
		assert.match(replyText(m)[0], /^This is Reader's book: only they can control it/, name);
	}
	assert.deepStrictEqual(h.bot.songQueue.map(t => t.title), ['Song A'], 'nothing was skipped');
	assert.strictEqual(h.bot.stopCalls, 0);
	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(h.bot.books.builds.length, 1);

	const x = run(h.bot, 'stop', bystander, h.guild);
	assert.deepStrictEqual(replyText(x), ['Reader\'s book keeps playing: only they can stop it, or anyone in its voice channel once they\'ve left. The music queue is cleared.']);
	assert.deepStrictEqual(h.bot.songQueue, [], '!stop still clears the music queue');
	assert.strictEqual(h.bot.stopCalls, 0);
	const y = run(h.bot, 'stop', bystander, h.guild);
	assert.deepStrictEqual(replyText(y), ['Reader\'s book keeps playing: only they can stop it, or anyone in its voice channel once they\'ve left.']);
	assert.strictEqual(s.state, 'playing');

	const c = await click(h, 'skip', bystander);
	assert.match(c.out[1].edit.content, /^This is Reader's book/, 'the old card\'s buttons too');

	const o = run(h.bot, 'pause', owner, h.guild);
	assert.match(replyText(o)[0], /^⏸ Paused at /, 'the owner may pause');
	assert.strictEqual(s.state, 'paused');
});

// ---- the old music card --------------------------------------------------------------------

test('the old card toggle resumes a parked book and pauses a playing one', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);

	let c = await click(h, 'pausetoggle', h.listener);
	assert.strictEqual(c.handled, true);
	assert.strictEqual(s.state, 'paused');
	assert.match(c.out[1].edit.content, /^⏸ Paused at /, 'the reply closes the button\'s defer');

	c = await click(h, 'pausetoggle', h.listener);
	assert.strictEqual(s.state, 'playing', 'isPaused is still false, yet the parked book resumes');
	assert.match(c.out[1].edit.content, /^▶ Resuming at /);
	assert.strictEqual(h.bot.isPaused, false);
	await until(() => h.bot.books.builds.length === 2, 'the resumed stream');

	c = await click(h, 'pausetoggle', h.listener);
	assert.strictEqual(s.state, 'paused');
});

test('the old card\'s Skip and Stop act on the book', async (t) => {
	const h = harness();
	t.after(() => h.done());
	await playing(h);
	h.bot.songQueue.push({ title: 'Song A', artist: 'Engelwood' });

	let c = await click(h, 'skip', h.listener);
	assert.match(c.out[1].edit.content, /^⏭ Part 2 · /);
	await until(() => h.bot.books.builds.length === 2, 'the next chapter\'s stream');

	c = await click(h, 'stop', h.listener);
	assert.match(c.out[1].edit.content, /^⏹ Stopped\. /);
	assert.strictEqual(h.bot.books.holds(h.guild.id), false);
	assert.deepStrictEqual(h.bot.songQueue, []);
	assert.deepStrictEqual(h.bot.played, []);
});
