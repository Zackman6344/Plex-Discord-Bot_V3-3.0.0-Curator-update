// helpers/bookEngine.js: a session's edges. Voice loss and recovery, a second subscriber, the
// listener leaving, the 'starting' window while the bot joins voice, switching books, the
// refusals of /book play, the music gate and its D1 replay, generic commands and permissions.
//
// The bug: a book that hangs forever on a destroyed connection, keeps the guild's voice after
// a stop during the join (so music is refused until a restart), writes a bookmark nobody heard,
// lets a late join failure end a newer session, reuses a destroyed connection on a switch,
// leaves a /play "thinking…" open, or starts queued music after a sleep timer.
//
// Harness: the same as test/bookEngine.test.js (a real AudioPlayer on silence frames, a FakeConn
// with VoiceConnection's subscription hand-over, an injected manual clock, the real bookmark
// store on a pid-suffixed temp file), with joins held open by test/voiceJoinRace.test.js's
// deferred-promise pattern.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-engine-voice-${process.pid}.json`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), `plexbot-test-book-engine-voice-log-${process.pid}`);

const voice = require('@discordjs/voice');
const bookmarks = require('../helpers/bookmarks.js');
const voiceClaims = require('../helpers/voiceClaims.js');
const { createBookDirector } = require('../helpers/bookEngine.js');

const S = 1000;
const MIN = 60 * S;
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

function part(work, i, durationMs, extra = {}) {
	return Object.assign({
		ordinal: i + 1,
		albumRatingKey: `${work}0`,
		trackRatingKey: `${work}${i + 1}`,
		title: `Part ${i + 1}`,
		durationMs,
		partKey: `/library/parts/${work}${i + 1}/1700000000/part${i + 1}.mp3`,
		file: `part${i + 1}.mp3`,
		sizeBytes: 1000 + i,
		container: 'mp3'
	}, extra);
}

function makeWork(n, id, title, durations, extra = {}) {
	const parts = durations.map((d, i) => part(n, i, d, (extra.parts && extra.parts[i]) || {}));
	return { id, kind: extra.kind || 'book', title, author: 'Test Author', narrator: null, edition: null, series: null, sequence: null, aliases: [], parts };
}

const SHORT = makeWork(71, 'test-author/short-book', 'Short Book', [1000, 1000, 1000]);
const LONG = makeWork(72, 'test-author/long-book', 'Long Book', [600 * S, 600 * S]);
const CHAPTERED = makeWork(73, 'test-author/chaptered-book', 'Chaptered Book', [1400, 1000], {
	parts: [{ chapters: [{ title: 'One', startMs: 0, endMs: 600 }, { title: 'Two', startMs: 600, endMs: 1400 }] }]
});
const WORKS = [SHORT, LONG, CHAPTERED];

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
	// VoiceConnection's order: new state in place, old subscription dropped, then stateChange.
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
	setStatus(status) { this.state = { ...this._state, status }; }
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
 * A director on a real AudioPlayer. Each resource is the part's remaining length in silence
 * frames (at the session speed, as atempo would), so a part ends naturally in real time.
 * `script` takes per-build overrides: 'never' (never readable), 'die' (destroyed early, no EOS),
 * or { frames } (ends with EOS after that many frames).
 */
function harness(opts = {}) {
	// The previous test's director saves on shutdown, after afterEach has already run.
	cleanup();
	const clock = manualClock(opts.start);
	const guild = makeGuild(opts.guildId);
	const voiceChannel = { id: 'v1', name: 'Reading Room', guild };
	const textChannel = makeTextChannel();
	const listener = makeMember(guild, 'u1', 'Reader', voiceChannel);
	const builds = [];
	const script = [];
	const events = [];
	const conns = [];
	const players = [];
	let probeImpl = async () => ({ ok: true, status: 206 });
	const partsByKey = new Map();
	for (const w of WORKS) for (const p of w.parts) partsByKey.set(p.partKey, p);

	function stream(kind, frames) {
		let n = 0;
		if (kind === 'never') return new Readable({ objectMode: true, read() {} });
		if (kind === 'die') return new Readable({ objectMode: true, read() { if (n++ < 3) this.push(SILENCE); else this.destroy(); } });
		return new Readable({ objectMode: true, read() { if (n++ < frames) this.push(SILENCE); else this.push(null); } });
	}

	const deps = Object.assign({
		timers: clock,
		config: Object.assign({
			audiobooksEnabled: true,
			audiobookSaveSeconds: 15,
			audiobookIdleLeaveMinutes: 10,
			audiobookResumeRewindSeconds: 10,
			ownerId: 'owner'
		}, opts.config || {}),
		bookmarks,
		catalog: {
			works: () => WORKS,
			work: id => WORKS.find(w => w.id === id) || null,
			findWorks: q => WORKS.filter(w => w.title.toLowerCase().includes(String(q).toLowerCase())),
			partKeyFor: (workId, p) => p.partKey
		},
		library: { start: () => null, stop() {}, ensureFresh: async () => ({ action: 'fresh' }), status: () => 'ready', lastError: () => null },
		repairPartKey: async () => null,
		ensureFresh: async () => ({ action: 'fresh' }),
		proxy: { stop: async () => {} },
		probe: key => probeImpl(key),
		urlFor: key => `fake:${key}`,
		createPlayer: () => {
			const p = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause, maxMissedFrames: 750 } });
			players.push(p);
			return p;
		},
		createResource: ({ url, startMs, speed }) => {
			const p = partsByKey.get(url.slice('fake:'.length));
			const plan = script.length ? script.shift() : null;
			const frames = Math.max(1, Math.round((p.durationMs - startMs) / speed / 20));
			const s = plan === 'never' || plan === 'die' ? stream(plan) : stream('frames', plan && plan.frames ? plan.frames : frames);
			const resource = voice.createAudioResource(s, { inputType: voice.StreamType.Opus });
			const build = { url, part: p, startMs, speed, resource, killed: 0 };
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
		commandLog: { recordEvent: (kind, detail) => events.push({ kind, detail }) },
		getVoiceConnection: () => conns[conns.length - 1]
	}, opts.deps || {});

	const bot = {
		songQueue: [],
		busy: false,
		played: [],
		joins: [],
		musicBusy() { return this.busy; },
		openConnection(channel) {
			const d = deferred();
			const join = { channel, ...d };
			bot.joins.push(join);
			if (!opts.manualJoins) {
				const c = new FakeConn();
				conns.push(c);
				d.resolve(c);
			}
			return d.promise;
		},
		playSong(message) { this.played.push(message); return Promise.resolve(); }
	};
	const client = new EventEmitter();
	client.user = { id: 'bot' };
	const director = createBookDirector({ client, bot, deps });

	return {
		clock, guild, voiceChannel, textChannel, listener, builds, script, events, conns, players, bot, client, director, deps,
		setProbe(fn) { probeImpl = fn; },
		play(extra = {}) {
			return director.play(Object.assign({ guild, member: listener, textChannel, workId: SHORT.id }, extra));
		},
		session() { return director.session(guild.id); },
		newConn() { const c = new FakeConn(); conns.push(c); return c; },
		async done() {
			director.shutdown();
			await tick();
		}
	};
}

async function playing(h, extra) {
	const r = await h.play(extra);
	assert.strictEqual(r.ok, true, `play failed: ${r.code} ${r.text}`);
	await until(() => h.session() && h.session().audible, 'audio');
	return h.session();
}

function mark(work, userId = 'u1') {
	return bookmarks.get(userId, work);
}

// ---- tests --------------------------------------------------------------------------------

function gatedMessage(h, member, { slash = false } = {}) {
	const replies = [];
	const channel = makeTextChannel(slash ? 't-slash' : 't1');
	const message = {
		guild: h.guild,
		member,
		author: member.user,
		channel,
		reply(p) { replies.push(p); return Promise.resolve({}); }
	};
	if (slash) {
		// The adapter's own channel proxy would route a send to editReply; D1 must not use it.
		message.channel = { id: 't-slash', proxy: true, send() { throw new Error('adapter channel used'); } };
		message.interaction = { channel };
	}
	return { message, replies, channel };
}

test('a disconnect waits 5 s for the connection to recover before ending as voice-lost', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const conn = h.conns[0];

	conn.setStatus('disconnected');
	h.clock.advance(4999);
	assert.strictEqual(s.state, 'playing', 'still within the grace');
	conn.setStatus('connecting');
	h.clock.advance(10 * S);
	assert.strictEqual(s.state, 'playing', 'reconnecting cancels the grace');
	conn.setStatus('ready');

	conn.setStatus('disconnected');
	h.clock.advance(5000);

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'voice-lost');
	assert.strictEqual(conn.state.status, 'destroyed');
	assert.strictEqual(h.director.holds('g1'), false);
	assert.ok(mark(LONG), 'the place is saved');
});

// The bug: only Disconnected had a bound. A connection that went Ready -> Signalling and never
// heard back from the gateway left the book AutoPaused in 'playing' forever, refusing music.
test('a connection stuck in Signalling or Connecting ends the session as voice-lost after 30 s', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const conn = h.conns[0];

	conn.setStatus('signalling');
	h.clock.advance(29999);
	assert.strictEqual(s.state, 'playing', 'still within the bound');
	conn.setStatus('connecting');
	h.clock.advance(1);

	assert.strictEqual(s.state, 'ended', 'Connecting does not restart the bound');
	assert.strictEqual(s.endReason, 'voice-lost');
	assert.strictEqual(h.director.holds('g1'), false);
	assert.strictEqual(voiceClaims.holder('g1'), null, 'music may have the voice again');
});

test('a disconnect that turns into a reconnect that never finishes is still bounded', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const conn = h.conns[0];

	conn.setStatus('disconnected');
	h.clock.advance(1000);
	conn.setStatus('signalling');
	h.clock.advance(28999);
	assert.strictEqual(s.state, 'playing');
	h.clock.advance(1);

	assert.strictEqual(s.state, 'ended', '30 s since the connection left Ready');
	assert.strictEqual(s.endReason, 'voice-lost');
});

// The bug: the bound was re-armed on every change of status kind, so a connection flapping
// Disconnected -> Signalling -> Disconnected inside 5 s never ended the session.
test('a connection flapping between Disconnected and Signalling is bounded at 30 s overall', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const conn = h.conns[0];
	let endedAt = null;

	for (let ms = 0; ms < 40 * S; ms += 3 * S) {
		if (s.state === 'ended') break;
		conn.setStatus(conn.state.status === 'disconnected' ? 'signalling' : 'disconnected');
		h.clock.advance(3 * S);
		if (s.state === 'ended' && endedAt === null) endedAt = ms + 3 * S;
	}

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'voice-lost');
	assert.ok(endedAt !== null && endedAt <= 30 * S, `ended by 30 s (${endedAt})`);
	assert.strictEqual(h.director.holds('g1'), false);
	assert.strictEqual(voiceClaims.holder('g1'), null, 'the claim is released');
});

test('a connection destroyed elsewhere ends the session as voice-lost at once', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	h.conns[0].destroy();

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'voice-lost');
	assert.strictEqual(h.players[0].state.status, 'idle');
	await s.cardChain;
	assert.strictEqual(h.textChannel.sent[0].edits.pop().view.endReason, 'voice-lost');
});

test('another player subscribing to the connection parks the book through unsubscribe', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	// Audio progress, not wall time: a stalled event loop loses frames a fixed sleep counts on.
	await until(() => s.res && s.res.playbackDuration >= 200, '200 ms of audio');
	const other = voice.createAudioPlayer();
	const heard = h.director.position(s);

	h.conns[0].subscribe(other);

	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.pauseReason, 'unsubscribed');
	assert.ok(heard >= 200 && s.parkedAbsMs >= heard, `the place is kept (${s.parkedAbsMs}, heard ${heard})`);
	assert.strictEqual(mark(LONG).absoluteMs, Math.round(s.parkedAbsMs));

	h.director.control('g1', h.listener, 'resume');
	assert.strictEqual(h.conns[0].state.subscription.player, h.players[0], 'resume takes the connection back');
	await until(() => s.audible, 'audio after resume');
	other.stop(true);
});

test('the listener leaving the channel parks, rejoining does not resume, and idle-leave ends it', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	h.client.emit('voiceStateUpdate', { id: 'u1', guild: h.guild, channelId: 'v1' }, { id: 'u1', guild: h.guild, channelId: null });
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.pauseReason, 'listener-left');
	h.client.emit('voiceStateUpdate', { id: 'u1', guild: h.guild, channelId: null }, { id: 'u1', guild: h.guild, channelId: 'v1' });
	assert.strictEqual(s.state, 'paused', 'no auto-resume on rejoin');

	h.clock.advance(10 * MIN - 1);
	assert.strictEqual(s.state, 'paused');
	h.clock.advance(1);

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'idle');
	assert.strictEqual(h.conns[0].state.status, 'destroyed');
});

// The bug: voice state changes are ignored while 'starting', and attach() never looked again, so
// a listener who left during the join got the book played to an empty channel until it finished.
test('the listener leaving while the bot is still joining parks the book once it starts', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const pending = h.play({ workId: LONG.id });
	h.guild.voiceStates.cache.delete('u1');
	h.client.emit('voiceStateUpdate', { id: 'u1', guild: h.guild, channelId: 'v1' }, { id: 'u1', guild: h.guild, channelId: null });
	h.bot.joins[0].resolve(h.newConn());
	const r = await pending;
	assert.strictEqual(r.ok, true);
	const s = h.session();

	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.pauseReason, 'listener-left');
	assert.match(r.text, /Paused: you left the voice channel/, 'the reply agrees with the paused card');
	await sleep(50);
	assert.strictEqual(h.builds.length, 0, 'nothing is played to the empty channel');
	h.clock.advance(10 * MIN);
	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'idle');
});

function moveBot(h, to = 'v2') {
	h.client.emit('voiceStateUpdate',
		{ id: 'bot', guild: h.guild, channelId: 'v1' },
		{ id: 'bot', guild: h.guild, channelId: to, channel: { name: 'Elsewhere' } });
}

// The bug: the bot's own move only updated voiceChannelId, so a book moved away from its listener
// played on to nobody, and the listener's later leave from their channel was never matched.
test('the bot moved to a channel the listener does not follow parks the book after a grace', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	moveBot(h);

	assert.strictEqual(s.voiceChannelId, 'v2');
	assert.strictEqual(s.voiceChannelName, 'Elsewhere');
	assert.strictEqual(s.state, 'playing', 'the listener gets a moment to follow');
	h.clock.advance(4999);
	assert.strictEqual(s.state, 'playing');
	h.clock.advance(1);
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.pauseReason, 'listener-left');
	assert.ok(s.timers.idleLeave, 'and it leaves voice later');
});

// The bug: the bot-moved park was immediate, so an admin moving the bot with the listener a
// second behind left the book paused, and rejoining never resumes.
test('the listener following the moved bot within the grace keeps the book playing', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	moveBot(h);
	h.clock.advance(1000);
	h.guild.voiceStates.cache.set('u1', { channelId: 'v2' });
	h.client.emit('voiceStateUpdate', { id: 'u1', guild: h.guild, channelId: 'v1' }, { id: 'u1', guild: h.guild, channelId: 'v2' });
	h.clock.advance(10 * S);

	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(s.pauseReason, null);
	assert.strictEqual(s.timers.botMoved, null, 'the grace is cleared by the arrival');
});

test('a stop during the bot-moved grace leaves no park behind', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	moveBot(h);
	assert.strictEqual(s.state, 'playing');
	h.director.control('g1', h.listener, 'stop');
	assert.strictEqual(s.state, 'ended');
	h.clock.advance(10 * S);

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'explicit');
	assert.strictEqual(s.pauseReason, null);
	assert.ok(!s.timers.botMoved);
});

/** LONG renamed by a rebuild: a second edition took the plain id's place, this one carries it as an alias. */
function renamingCatalog() {
	const renamed = Object.assign({}, LONG, { id: `${LONG.id}~edition`, aliases: [LONG.id] });
	const state = { renamed: false };
	const works = () => (state.renamed ? [SHORT, renamed, CHAPTERED] : WORKS);
	const catalog = {
		works,
		work: id => works().find(w => w.id === id) || works().find(w => w.aliases.includes(id)) || null,
		findWorks: () => [],
		partKeyFor: (workId, p) => p.partKey
	};
	return { catalog, renamed, rename() { state.renamed = true; } };
}

// The bug: a live session kept saving under the id it started with. Once /book library read the
// new id (moving the bookmark there), the next periodic save wrote a fresh record under the old
// id, and resume read the stale new-id record.
test('a rebuild that renames the playing work moves its later saves to the new id', async (t) => {
	const r = renamingCatalog();
	const h = harness({ deps: { catalog: r.catalog } });
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	await until(() => s.res && s.res.playbackDuration >= 100, '100 ms of audio');
	h.clock.advance(15 * S);

	r.rename();
	assert.ok(bookmarks.get('u1', r.renamed), '/book library moves the place to the new id');
	await until(() => s.res && s.res.playbackDuration >= 1200, '1.2 s of audio');
	h.clock.advance(15 * S);

	assert.strictEqual(bookmarks.get('u1', LONG.id), null, 'nothing is written back under the old id');
	const m = bookmarks.get('u1', r.renamed);
	assert.ok(m.absoluteMs >= 1100, `the newest place is under the new id (${m.absoluteMs})`);
	assert.strictEqual(bookmarks.lastInProgress('u1').workId, r.renamed.id);
	assert.strictEqual(s.workId, r.renamed.id);
	assert.strictEqual(h.director.view(s).title, LONG.title);
});

// The bug: forget compared the session's start id to the new one, missed the live session, and
// the session's next periodic save wrote the forgotten place back.
test('/book forget by the new id of a renamed work ends its live session', async (t) => {
	const r = renamingCatalog();
	const h = harness({ deps: { catalog: r.catalog } });
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	r.rename();
	assert.ok(bookmarks.get('u1', r.renamed), 'the command reads the place first');
	const out = h.director.forget('u1', r.renamed.id);
	h.clock.advance(60 * S);

	assert.strictEqual(out.code, 'forgotten');
	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'forgotten');
	assert.strictEqual(bookmarks.get('u1', LONG.id), null);
	assert.strictEqual(bookmarks.get('u1', r.renamed), null);
});

test('the claim and the gate exist synchronously, before the voice join resolves', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());

	const pending = h.play();

	assert.deepStrictEqual(voiceClaims.holder('g1'), { owner: 'audiobook', label: 'Reader' });
	assert.strictEqual(voiceClaims.holder('g1', { ignore: ['audiobook'] }), null);
	assert.strictEqual(h.session().state, 'starting');
	const { message, replies } = gatedMessage(h, makeMember(h.guild, 'u2', 'Other'));
	assert.strictEqual(h.director.blocksMusic(message), true);
	assert.strictEqual(replies.length, 1);
	h.bot.joins[0].resolve(h.newConn());
	assert.strictEqual((await pending).ok, true);
});

test('a stop during the join saves nothing, opens the gate and destroys the late connection', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	bookmarks.record('u1', LONG, { absoluteMs: 300 * S, guildId: 'g1', addListenedMs: 5 * S });
	const before = fs.readFileSync(FILE, 'utf8');

	const pending = h.play({ workId: LONG.id });
	const r = h.director.control('g1', h.listener, 'stop');
	assert.strictEqual(r.ok, true);
	assert.strictEqual(h.director.holds('g1'), false);
	assert.strictEqual(h.director.blocksMusic(gatedMessage(h, h.listener).message), false, 'music is free again');
	assert.strictEqual(voiceClaims.holder('g1'), null);
	const late = h.newConn();
	h.bot.joins[0].resolve(late);
	const out = await pending;

	assert.strictEqual(out.code, 'cancelled');
	assert.strictEqual(late.state.status, 'destroyed', 'the join that landed after the stop is left');
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), before, 'the bookmark is byte-identical');
	assert.strictEqual(h.players.length, 0, 'no player was ever made');
});

test('a late connection is kept when something newer owns it', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const pending = h.play({ workId: LONG.id });
	h.director.control('g1', h.listener, 'stop');
	h.bot.busy = true;

	const late = h.newConn();
	h.bot.joins[0].resolve(late);
	await pending;

	assert.strictEqual(late.state.status, 'ready', 'music now uses the connection joinVoiceChannel handed back');
});

test('a second play from the same listener during the join is refused', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const pending = h.play();

	const second = await h.play();

	assert.strictEqual(second.code, 'starting');
	assert.strictEqual(h.bot.joins.length, 1);
	h.bot.joins[0].resolve(h.newConn());
	await pending;
});

test('controls during the join are refused without touching the player or the connection', async (t) => {
	let made = 0;
	const h = harness({ manualJoins: true, deps: { createPlayer: () => { made++; return voice.createAudioPlayer(); } } });
	t.after(() => h.done());
	const pending = h.play();

	for (const [action, arg] of [['fwd', 30], ['speed', 1.5], ['pause'], ['toggle'], ['sleep', 15], ['goto', '1:00']]) {
		const r = h.director.control('g1', h.listener, action, arg);
		assert.strictEqual(r.code, 'starting', action);
		assert.match(r.text, /Still joining/);
	}
	assert.strictEqual(made, 0);
	assert.strictEqual(h.session().speed, 1);
	h.bot.joins[0].resolve(h.newConn());
	await pending;
});

test('the first join failing after a stop and a second play does not end the second session', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const first = h.play();
	h.director.control('g1', h.listener, 'stop');
	const second = h.play();
	const s2 = h.session();
	h.bot.joins[1].resolve(h.newConn());
	assert.strictEqual((await second).ok, true);

	h.bot.joins[0].reject(new Error('The operation was aborted'));
	const out = await first;

	assert.strictEqual(out.code, 'cancelled');
	assert.strictEqual(h.session(), s2);
	assert.strictEqual(s2.state, 'playing');
	assert.strictEqual(h.conns[h.conns.length - 1].state.status, 'ready');
});

test('a join that fails for its own session ends it and says so', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const pending = h.play();
	h.bot.joins[0].reject(new Error('timeout'));

	const out = await pending;

	assert.strictEqual(out.code, 'join-failed');
	assert.strictEqual(h.director.holds('g1'), false);
	assert.strictEqual(h.textChannel.sent.length, 0, 'no card for a session that never joined');
});

test('a save that throws inside stop still releases the claim and the gate', async (t) => {
	let boom = false;
	const shaky = Object.assign({}, bookmarks, {
		record(...args) {
			if (boom) throw new Error('disk on fire');
			return bookmarks.record(...args);
		}
	});
	const h = harness({ deps: { bookmarks: shaky } });
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	boom = true;
	h.director.control('g1', h.listener, 'stop');

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(h.director.holds('g1'), false);
	assert.strictEqual(voiceClaims.holder('g1'), null);
	assert.strictEqual(h.conns[0].state.status, 'destroyed');
	assert.strictEqual(h.players[0].state.status, 'idle');
});

test('switching to another book stops the old one and joins afresh', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const old = await playing(h, { workId: LONG.id });
	await until(() => old.res && old.res.playbackDuration >= 100, '100 ms of audio');

	const r = await h.play({ workId: SHORT.id });

	assert.strictEqual(r.ok, true);
	assert.strictEqual(old.state, 'ended');
	assert.strictEqual(old.endReason, 'switched');
	assert.strictEqual(h.conns[0].state.status, 'destroyed', 'the old connection is never reused');
	assert.strictEqual(h.bot.joins.length, 2, 'a fresh openConnection');
	const s = h.session();
	assert.notStrictEqual(s, old);
	assert.strictEqual(s.conn, h.conns[1]);
	assert.strictEqual(s.conn.state.status, 'ready');
	await until(() => s.audible, 'the new book playing');
	assert.ok(mark(LONG).absoluteMs > 0, 'the old book was saved');
	assert.strictEqual(h.bot.played.length, 0);
});

test('play is refused while music is busy, a Hitster game holds voice, or someone else is listening', async (t) => {
	const h = harness();
	t.after(() => {
		voiceClaims.register('hitster', () => null);
		return h.done();
	});

	h.bot.busy = true;
	assert.strictEqual((await h.play()).code, 'music-busy');
	h.bot.busy = false;

	voiceClaims.register('hitster', guildId => (guildId === 'g1' ? 'a Hitster game' : null));
	const claimed = await h.play();
	assert.strictEqual(claimed.code, 'claimed');
	assert.match(claimed.text, /a Hitster game/);
	voiceClaims.register('hitster', () => null);

	await playing(h);
	const other = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);
	const r = await h.play({ member: other });
	assert.strictEqual(r.code, 'other-listener');
	assert.match(r.text, /Reader is listening to Short Book/);
	assert.strictEqual(h.bot.joins.length, 1);

	const away = await h.play({ member: makeMember(h.guild, 'u3', 'Away', null) });
	assert.strictEqual(away.code, 'no-voice');
	h.deps.config.audiobooksEnabled = false;
	assert.strictEqual((await h.play()).code, 'disabled');
});

test('an ambiguous title lists the choices and joins nothing', async (t) => {
	const h = harness();
	t.after(() => h.done());

	const r = await h.play({ workId: undefined, query: 'book' });

	assert.strictEqual(r.code, 'ambiguous');
	assert.deepStrictEqual(r.choices.map(c => c.id).sort(), WORKS.map(w => w.id).sort());
	assert.strictEqual(h.bot.joins.length, 0);
	assert.strictEqual(h.director.holds('g1'), false);
	const exact = await h.play({ workId: undefined, query: 'long book' });
	assert.strictEqual(exact.ok, true, 'one exact title is picked');
	assert.strictEqual(h.session().workId, LONG.id);
});

test('the gate answers each gated request exactly once, explaining at most every 30 s per channel', async (t) => {
	const h = harness();
	t.after(() => h.done());
	await playing(h);
	h.bot.songQueue.push({ title: 'a' }, { title: 'b' });
	const requester = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);

	const first = gatedMessage(h, requester, { slash: true });
	const second = gatedMessage(h, requester, { slash: true });
	assert.strictEqual(h.director.blocksMusic(first.message), true);
	assert.strictEqual(h.director.blocksMusic(second.message), true);
	h.clock.advance(30 * S);
	const third = gatedMessage(h, requester, { slash: true });
	h.director.blocksMusic(third.message);

	assert.strictEqual(first.replies.length, 1);
	assert.strictEqual(second.replies.length, 1);
	assert.match(first.replies[0].content, /Queued behind Reader's book \(2 waiting\)\.\nReader is listening to Short Book in 🔊 Reading Room/);
	assert.strictEqual(second.replies[0].content, '📚 Queued behind Reader\'s book (2 waiting).');
	assert.match(third.replies[0].content, /is listening to/);
	assert.deepStrictEqual(first.replies[0].allowedMentions, { parse: [] });
	assert.strictEqual(h.events.filter(e => e.kind === 'music-gated-by-book').length, 3);
});

test('an explicit stop starts the queued music with a channel-shaped message, never the adapter', async (t) => {
	const h = harness();
	t.after(() => h.done());
	await playing(h);
	h.bot.songQueue.push({ title: 'queued' });
	const requester = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);
	const { message, channel } = gatedMessage(h, requester, { slash: true });
	h.director.blocksMusic(message);

	h.director.control('g1', h.listener, 'stop');

	assert.strictEqual(h.bot.played.length, 1);
	const replay = h.bot.played[0];
	assert.strictEqual(replay.channel, channel, 'the interaction\'s real text channel');
	assert.strictEqual(replay.member, requester, 'the gated requester, still in voice');
	assert.strictEqual(replay.guild, h.guild);
	assert.strictEqual(replay.content, '');
	assert.strictEqual(replay.interaction, undefined);
	await replay.reply('Now playing');
	assert.strictEqual(channel.sent[0].payload, 'Now playing');
});

test('only an explicit stop starts queued music: not a generic !stop, a sleep or an idle leave', async () => {
	for (const how of ['generic', 'sleep', 'idle']) {
		const h = harness();
		await playing(h, { workId: LONG.id });
		h.bot.songQueue.push({ title: 'queued' });
		h.director.blocksMusic(gatedMessage(h, makeMember(h.guild, 'u2', 'Other', h.voiceChannel)).message);
		if (how === 'generic') {
			const msg = { guild: h.guild, member: h.listener, reply: () => Promise.resolve() };
			assert.strictEqual(h.director.routeGeneric('stop', msg), true);
		} else if (how === 'sleep') {
			h.director.control('g1', h.listener, 'sleep', 1);
			h.clock.advance(MIN);
		} else {
			h.director.control('g1', h.listener, 'pause');
			h.clock.advance(10 * MIN);
		}
		assert.strictEqual(h.director.holds('g1'), false, how);
		assert.strictEqual(h.bot.played.length, 0, how);
		await h.done();
	}
});

test('generic commands act on the book for those allowed, refuse the rest, and fall through with no book', async (t) => {
	const h = harness({ manualJoins: true });
	t.after(() => h.done());
	const replies = [];
	const msg = (member) => ({ guild: h.guild, member, reply(p) { replies.push(p.content); return Promise.resolve(); } });

	assert.strictEqual(h.director.routeGeneric('pause', msg(h.listener)), false, 'no book: music as usual');
	const pending = h.play({ workId: CHAPTERED.id });
	assert.strictEqual(h.director.routeGeneric('skip', msg(h.listener)), true);
	assert.match(replies.pop(), /Still joining/);
	h.bot.joins[0].resolve(h.newConn());
	await pending;
	const s = h.session();
	await until(() => s.audible, 'audio');

	assert.strictEqual(h.director.routeGeneric('skip', msg(h.listener)), true);
	assert.match(replies.pop(), /Two/, 'skip is the next chapter');
	const stranger = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);
	assert.strictEqual(h.director.routeGeneric('pause', msg(stranger)), true, 'not theirs while the listener is here');
	assert.match(replies.pop(), /^This is Reader's book/);
	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(h.director.routeGeneric('pause', msg(h.listener)), true);
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(h.director.routeGeneric('pause', msg(h.listener)), true);
	assert.strictEqual(replies.pop(), 'Already paused.');
	assert.strictEqual(h.director.routeGeneric('resume', msg(h.listener)), true);
	assert.strictEqual(s.state, 'playing');
});

test('permissions: the listener does everything, the owner and a bystander left alone may pause and stop', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const owner = makeMember(h.guild, 'owner', 'Owner', null);
	const bystander = makeMember(h.guild, 'u2', 'Other', h.voiceChannel);

	assert.strictEqual(h.director.canControl(s, h.listener, 'fwd'), true);
	assert.strictEqual(h.director.canControl(s, owner, 'pause'), true);
	assert.strictEqual(h.director.canControl(s, owner, 'fwd'), false);
	assert.strictEqual(h.director.canControl(s, bystander, 'pause'), false, 'the listener is still in the channel');
	const refused = h.director.control('g1', bystander, 'fwd', 30);
	assert.strictEqual(refused.code, 'forbidden');
	assert.match(refused.text, /Reader's book/);

	h.guild.voiceStates.cache.delete('u1');
	assert.strictEqual(h.director.canControl(s, bystander, 'stop'), true);
	assert.strictEqual(h.director.canControl(s, bystander, 'toggle'), true, 'toggle while playing is a pause');
	assert.strictEqual(h.director.canControl(s, bystander, 'speed'), false);
	h.director.control('g1', bystander, 'pause');
	assert.strictEqual(h.director.canControl(s, bystander, 'toggle'), false, 'toggle while parked is a resume');
	h.director.control('g1', bystander, 'stop');
	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(mark(LONG).userId, 'u1', 'the bookmark follows the listener, never the clicker');
});

test('a card button resolves its session id, and a stale id is told apart', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	await s.cardChain;

	const live = h.director.sessionById(s.id);
	const r = h.director.controlSession(live, h.listener, 'toggle', undefined, { cardUpdated: true });
	await s.cardChain;

	assert.strictEqual(r.view.state, 'paused');
	assert.strictEqual(r.sessionId, s.id);
	assert.strictEqual(h.textChannel.sent[0].edits.length, 0, 'the button edits the card itself');
	assert.strictEqual(h.director.sessionById('nope00'), null);
	h.director.control('g1', h.listener, 'stop');
	assert.strictEqual(h.director.controlSession(s, h.listener, 'resume').code, 'no-session');
});
