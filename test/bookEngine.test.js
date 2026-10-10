// helpers/bookEngine.js: playback inside one session. Resume position, part advance, the last
// part finishing, early ends and their retry, the Buffering watchdog, park and resume, jumps,
// speed, the sleep and chapter timers, and the identity guard on Idle.
//
// The bug: a book player that skips or replays chapters, starts audio nobody asked for after a
// pause or a stop (the retry timer), loops on a stalled Plex, saves "the next part plus the old
// offset" while a part change is loading, counts listening time at the wrong speed, or lets a
// sleep timer run while nothing is audible. Each of these is silent until someone resumes a
// 37-hour book in the wrong place.
//
// Harness: a real @discordjs/voice AudioPlayer, as in design/experience-first/proto5 (Opus
// silence frames give a real AudioResource whose playbackDuration advances 20 ms per frame), on
// a FakeConn modelled on test/voiceRecovery.test.js's connection stub, with the voice
// subscription hand-over of VoiceConnection. The engine's timers are injected (a manual clock),
// never t.mock.timers: the real player's 20 ms cycle runs on the global setTimeout. The bookmark
// store is the real one on a pid-suffixed temp file, as in test/bookmarks.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-engine-${process.pid}.json`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), `plexbot-test-book-engine-log-${process.pid}`);

const voice = require('@discordjs/voice');
const bookmarks = require('../helpers/bookmarks.js');
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

test('play resumes at the resolved bookmark, rewound after a day away', async (t) => {
	const h = harness({ start: Date.now() + 2 * 24 * 60 * MIN });
	t.after(() => h.done());
	bookmarks.record('u1', LONG, { absoluteMs: 700 * S, speed: 1.25, guildId: 'g1', addListenedMs: 5 * S });

	const r = await h.play({ workId: LONG.id });

	assert.strictEqual(r.ok, true);
	assert.match(r.text, /^▶ Resuming Long Book/);
	assert.match(r.text, /rewound 30 s/, 'a gap over 24 h rewinds three times the setting');
	await until(() => h.builds.length === 1, 'the first build');
	assert.strictEqual(h.builds[0].part.ordinal, 2, 'the bookmark is in part 2');
	assert.strictEqual(h.builds[0].startMs, 100 * S - 30 * S);
	assert.strictEqual(h.builds[0].speed, 1.25, 'the bookmark keeps its speed');
	assert.strictEqual(h.textChannel.sent.length, 1, 'the card is posted once');
	assert.strictEqual(h.textChannel.sent[0].payload.kind, 'card');
});

test('a finished book starts again from 0 without a rewind, and the first save clears finished', async (t) => {
	const h = harness({ start: Date.now() + 2 * 24 * 60 * MIN });
	t.after(() => h.done());
	bookmarks.markFinished('u1', LONG, { guildId: 'g1' });

	const r = await h.play({ workId: LONG.id });

	assert.match(r.text, /starting again/);
	await until(() => h.builds.length === 1, 'the first build');
	assert.strictEqual(h.builds[0].startMs, 0);
	const m = mark(LONG);
	assert.strictEqual(m.finished, false);
	assert.strictEqual(m.finishedCount, 1, 'the earlier finish still counts');
});

test('a finished work that gained a part starts at the new part, with no rewind into the old one', async (t) => {
	const h = harness({ start: Date.now() + 2 * 24 * 60 * MIN });
	t.after(() => h.done());
	// The podcast case: caught up on part 1, then a rebuild appended part 2.
	const before = Object.assign({}, LONG, { parts: LONG.parts.slice(0, 1) });
	bookmarks.record('u1', before, { absoluteMs: 590 * S, guildId: 'g1', addListenedMs: 5 * S });
	bookmarks.markFinished('u1', before, { guildId: 'g1' });

	const r = await h.play({ workId: LONG.id });

	assert.match(r.text, /1 new part since you caught up/);
	assert.strictEqual(r.info.rewindMs, 0);
	await until(() => h.builds.length === 1, 'the first build');
	assert.strictEqual(h.builds[0].part.ordinal, 2);
	assert.strictEqual(h.builds[0].startMs, 0);
});

test('a jump while playing swaps the resource, saves the target and advances nothing', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });

	const r = h.director.control('g1', h.listener, 'fwd', 30);

	assert.strictEqual(r.ok, true);
	const target = s.anchorAbsMs;
	assert.ok(target >= 30 * S && target < 32 * S, `anchor moved by 30 s (${target})`);
	assert.strictEqual(mark(LONG).absoluteMs, Math.round(target), 'the target is saved before the build');
	await until(() => h.builds.length === 2, 'the swap');
	await until(() => s.audible, 'audio after the swap');
	assert.strictEqual(h.builds[1].part.ordinal, 1);
	assert.strictEqual(h.builds[1].startMs, target);
	assert.strictEqual(h.bot.joins.length, 1);
	assert.strictEqual(h.players.length, 1, 'one player for the whole session');
});

test('a natural part end advances on the same player with no new voice join', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);
	const player = s.player;

	await until(() => h.builds.length === 2, 'the next part', 4000);

	assert.strictEqual(h.builds[1].part.ordinal, 2);
	assert.strictEqual(h.builds[1].startMs, 0);
	assert.strictEqual(s.player, player);
	assert.strictEqual(h.bot.joins.length, 1, 'no openConnection for a part change');
	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(s.partIndex, 1);
});

test('the last part ending naturally finishes the work and nothing smaller is saved after it', async (t) => {
	const h = harness();
	t.after(() => h.done());
	bookmarks.record('u1', SHORT, { absoluteMs: 2000, guildId: 'g1' });
	const s = await playing(h);

	await until(() => s.state === 'ended', 'the finish', 4000);

	assert.strictEqual(s.endReason, 'finished');
	const m = mark(SHORT);
	assert.strictEqual(m.finished, true);
	assert.strictEqual(m.finishedCount, 1);
	assert.strictEqual(m.absoluteMs, 3000, 'the place is the end of the work');
	assert.strictEqual(m.hint.ordinal, 3);
	assert.strictEqual(m.hint.partMs, 1000, 'the hint resumeStart reads as "finished"');
	assert.ok(m.listenedMs >= 800, `the last part's listening time is kept (${m.listenedMs})`);
	assert.strictEqual(h.director.holds('g1'), false);
	await s.cardChain;
	const last = h.textChannel.sent[0].edits.pop();
	assert.strictEqual(last.kind, 'ended');
	assert.strictEqual(last.view.endReason, 'finished');
});

test('an early end retries from where it stopped after the retry delay', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push('die');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());

	await until(() => s.timers.retry, 'the retry timer');
	assert.strictEqual(h.builds.length, 1);
	assert.strictEqual(s.failures.length, 1, 'the failure is kept on the session');
	h.clock.advance(1000);
	await until(() => h.builds.length === 2, 'the retry build');

	assert.strictEqual(h.builds[1].startMs, h.builds[0].startMs);
	assert.strictEqual(s.state, 'playing');
});

test('a pause during the retry gap builds nothing when the retry timer would have fired', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push('die');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => s.timers.retry, 'the retry timer');

	h.clock.advance(500);
	const r = h.director.control('g1', h.listener, 'pause');
	h.clock.advance(5000);
	await sleep(50);

	assert.strictEqual(r.ok, true);
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(h.builds.length, 1, 'no resource after the pause');
});

// The bug: during the 1 s retry gap position() still read the failed attempt's start, so a pause,
// a stop or a relative seek there went back by however long that attempt had played.
test('a pause in the retry gap keeps the place where the failed attempt stopped', async (t) => {
	const h = harness();
	t.after(() => h.done());
	bookmarks.record('u1', LONG, { absoluteMs: 300 * S, guildId: 'g1' });
	h.script.push({ frames: 25 });
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => s.timers.retry, 'the retry timer');
	const startAbs = h.builds[0].startMs;
	const heard = startAbs + h.builds[0].resource.playbackDuration;
	assert.ok(heard - startAbs >= 400, `the attempt played (${heard - startAbs} ms)`);

	h.director.control('g1', h.listener, 'pause');

	assert.strictEqual(s.parkedAbsMs, heard);
	assert.strictEqual(mark(LONG).absoluteMs, Math.round(heard));
	h.director.control('g1', h.listener, 'back', 10);
	assert.strictEqual(s.parkedAbsMs, heard - 10 * S, 'a relative jump counts from there too');
});

test('a stop during the retry gap builds nothing and writes no bookmark afterwards', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push('die');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => s.timers.retry, 'the retry timer');

	h.clock.advance(500);
	h.director.control('g1', h.listener, 'stop');
	const after = fs.readFileSync(FILE, 'utf8');
	h.clock.advance(60 * S);
	await sleep(50);

	assert.strictEqual(h.builds.length, 1);
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), after, 'nothing written after the stop');
	assert.strictEqual(s.state, 'ended');
});

test('a resource stuck in Buffering is killed by the 20 s watchdog and retried; three in two minutes park', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push('never', 'never', 'never');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => h.builds.length === 1, 'the first build');

	h.clock.advance(19999);
	assert.strictEqual(h.builds[0].killed, 0, 'not before 20 s');
	h.clock.advance(1);
	assert.ok(h.builds[0].killed >= 1, 'killed at 20 s');
	assert.strictEqual(s.res, null);
	h.clock.advance(1000);
	await until(() => h.builds.length === 2, 'the first retry');
	h.clock.advance(21000);
	await until(() => h.builds.length === 3, 'the second retry');
	h.clock.advance(20000);

	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.pauseReason, 'plex-failing');
	assert.match(s.pauseDetail, /3 times in 2 minutes/);
	h.clock.advance(5000);
	await sleep(30);
	assert.strictEqual(h.builds.length, 3, 'parked: nothing more is built');
});

function fakeVoiceHealth() {
	return {
		watched: [],
		events: [],
		watchPlayer(player, meta) { this.watched.push({ player, meta }); },
		event(type, detail) { this.events.push({ type, ...detail }); }
	};
}

test('the book player goes to the voice-health log, and a Buffering kill is one early-end event', async (t) => {
	const vh = fakeVoiceHealth();
	const h = harness({ deps: { voiceHealth: vh } });
	t.after(() => h.done());
	h.script.push('never');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => h.builds.length === 1, 'the first build');

	assert.strictEqual(vh.watched.length, 1);
	assert.strictEqual(vh.watched[0].player, s.player);
	assert.deepStrictEqual(vh.watched[0].meta, { kind: 'book' });
	h.clock.advance(20000);

	assert.deepStrictEqual(vh.events.map(e => [e.type, e.reason, e.part]), [['book-early-end', 'buffering-timeout', 1]]);
});

test('a part whose stream dies is recorded once as a stalled early end', async (t) => {
	const vh = fakeVoiceHealth();
	const h = harness({ deps: { voiceHealth: vh } });
	t.after(() => h.done());
	h.script.push('die');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());
	await until(() => s.timers.retry, 'the retry timer');

	assert.strictEqual(vh.events.length, 1);
	assert.strictEqual(vh.events[0].type, 'book-early-end');
	assert.strictEqual(vh.events[0].reason, 'stalled');
	assert.strictEqual(typeof vh.events[0].outputMs, 'number');
});

test('three early ends in two minutes park with the Plex warning', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push('die', 'die', 'die');
	const s = await h.play({ workId: LONG.id }).then(() => h.session());

	for (let i = 1; i <= 2; i++) {
		await until(() => s.timers.retry, `retry ${i}`);
		h.clock.advance(1000);
		await until(() => h.builds.length === i + 1, `build ${i + 1}`);
	}
	await until(() => s.state === 'paused', 'the park');

	assert.strictEqual(s.pauseReason, 'plex-failing');
	assert.strictEqual(s.timers.retry, null);
	assert.ok(s.timers.idleLeave, 'a parked session leaves voice later');
});

test('two short end-of-streams at the same spot mid-part park as "file ends early", never skip', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.script.push({ frames: 10 }, { frames: 10 });
	const s = await h.play({ workId: LONG.id }).then(() => h.session());

	await until(() => s.timers.retry, 'the first retry');
	h.clock.advance(1000);
	await until(() => s.state === 'paused', 'the park');

	assert.strictEqual(s.pauseReason, 'file-ends-early');
	assert.match(s.pauseDetail, /ends early/);
	assert.strictEqual(s.partIndex, 0, 'no skip to the next part');
	assert.strictEqual(h.builds.length, 2);
});

test('pause parks (ffmpeg killed, the Idle ignored) and resume after 5 min rebuilds with the rewind', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	h.director.control('g1', h.listener, 'goto', '0:20');
	await until(() => h.builds.length === 2 && s.audible, 'the goto');

	const r = h.director.control('g1', h.listener, 'toggle');

	assert.match(r.text, /Paused/);
	assert.strictEqual(s.state, 'paused');
	assert.ok(h.builds[1].killed >= 1, 'the parked resource is killed');
	assert.strictEqual(s.res, null);
	assert.strictEqual(h.players[0].state.status, 'idle');
	const parked = s.parkedAbsMs;
	assert.ok(parked >= 20 * S && parked < 21 * S);
	await sleep(30);
	assert.strictEqual(h.builds.length, 2, 'the Idle from the park started nothing');

	h.clock.advance(6 * MIN);
	const back = h.director.control('g1', h.listener, 'toggle');
	await until(() => h.builds.length === 3, 'the resume build');

	assert.match(back.text, /rewound 10 s/);
	assert.strictEqual(h.builds[2].startMs, parked - 10 * S);
	assert.strictEqual(s.state, 'playing');
	assert.strictEqual(s.timers.idleLeave, null);
});

test('a jump while parked moves the place and spawns nothing', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	h.director.control('g1', h.listener, 'pause');
	const parked = s.parkedAbsMs;

	h.director.control('g1', h.listener, 'fwd', 120);
	h.director.control('g1', h.listener, 'speed', 1.5);
	await sleep(50);

	assert.strictEqual(h.builds.length, 1);
	assert.strictEqual(s.parkedAbsMs, parked + 120 * S);
	assert.strictEqual(mark(LONG).absoluteMs, Math.round(parked + 120 * S));
	assert.strictEqual(mark(LONG).speed, 1.5);
});

test('rapid clicks leave exactly one live resource at the composed target', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	const start = s.anchorAbsMs + s.res.playbackDuration;

	for (let i = 0; i < 5; i++) h.director.control('g1', h.listener, 'fwd', 30);
	await until(() => s.audible && h.builds.length >= 2, 'the newest build');
	await sleep(30);

	assert.strictEqual(h.builds.length, 2, 'only the newest click built');
	assert.strictEqual(h.players[0].state.resource, h.builds[1].resource);
	assert.ok(Math.abs(s.anchorAbsMs - (start + 150 * S)) < 200, `5 x 30 s composed (${s.anchorAbsMs - start})`);
});

test('a save during the probe await writes the target across a part boundary', async (t) => {
	const h = harness();
	t.after(() => h.done());
	bookmarks.record('u1', LONG, { absoluteMs: 590 * S, guildId: 'g1' });
	const s = await playing(h, { workId: LONG.id });
	const gate = deferred();
	h.setProbe(() => gate.promise);

	h.director.control('g1', h.listener, 'fwd', 30);
	h.clock.advance(15 * S);

	const m = mark(LONG);
	assert.strictEqual(s.partIndex, 1);
	assert.ok(m.absoluteMs >= 620 * S && m.absoluteMs < 621 * S, `saved the target (${m.absoluteMs})`);
	assert.strictEqual(m.hint.ordinal, 2, 'the hint names the new part');
	assert.ok(m.hint.partMs >= 20 * S && m.hint.partMs < 21 * S);
	gate.resolve({ ok: true, status: 206 });
	await until(() => h.builds.length === 2, 'the build');
	assert.strictEqual(h.builds[1].part.ordinal, 2);
});

test('a speed change keeps the position and accounts the time before it at the old speed', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	// Audio progress, not wall time: a stalled event loop loses frames a fixed sleep counts on.
	await until(() => s.res && s.res.playbackDuration >= 400, '400 ms at 1x');

	h.director.control('g1', h.listener, 'speed', 2);
	const swapAt = s.anchorAbsMs;
	await until(() => h.builds.length === 2 && s.audible, 'the 2x build');
	await until(() => s.res && s.res.playbackDuration >= 400, '400 ms at 2x');
	h.director.control('g1', h.listener, 'stop');

	assert.strictEqual(h.builds[1].startMs, swapAt, 'the 2x resource starts where 1x left off');
	assert.strictEqual(h.builds[1].speed, 2);
	const m = mark(LONG);
	const at1x = swapAt;
	const at2x = m.listenedMs - at1x;
	assert.ok(at2x > 200, `time heard at 2x (${at2x})`);
	assert.ok(Math.abs(m.coveredMs - (at1x + 2 * at2x)) <= 2, `covered = 1x part + 2 x the 2x part (${m.coveredMs} vs ${at1x} + 2*${at2x})`);
	assert.ok(Math.abs(m.absoluteMs - Math.round(at1x + 2 * at2x)) <= 2, 'the place moved by book time');
	assert.strictEqual(m.speed, 2);
});

test('the sleep timer counts listening time only: not while parked or auto-paused', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	h.director.control('g1', h.listener, 'pause');

	h.director.control('g1', h.listener, 'sleep', 1);
	h.clock.advance(2 * MIN);
	assert.strictEqual(s.state, 'paused', 'a parked session does not count down');

	h.director.control('g1', h.listener, 'resume');
	await until(() => s.audible, 'audio after resume');
	h.clock.advance(50 * S);
	assert.strictEqual(s.state, 'playing');
	h.conns[0].setStatus('signalling');
	await until(() => h.players[0].state.status === 'autopaused', 'auto-pause');
	assert.strictEqual(s.audible, false);
	// Under the 30 s bound on a reconnect, and past the 10 s of sleep left.
	h.clock.advance(20 * S);
	assert.strictEqual(s.state, 'playing', 'auto-paused time does not count');
	h.conns[0].setStatus('ready');
	await until(() => s.audible, 'audio after the blip');
	h.clock.advance(9 * S);
	assert.strictEqual(s.state, 'playing');
	h.clock.advance(1 * S + 1);

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'sleep');
	assert.strictEqual(h.bot.played.length, 0, 'a sleep never starts queued music');
});

test('sleep at the end of the chapter stops at a part boundary instead of advancing', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);
	h.director.control('g1', h.listener, 'sleep', 'chapter');

	await until(() => s.state === 'ended', 'the stop', 4000);

	assert.strictEqual(s.endReason, 'sleep');
	assert.strictEqual(h.builds.length, 1, 'part 2 never starts');
	assert.strictEqual(mark(SHORT).absoluteMs, 1000, 'saved at the next part start');
});

test('sleep at the end of the chapter also stops on the last embedded chapter of a chaptered part', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: CHAPTERED.id });
	// A bookmark this close to a part end would resume in the next part, so this goes by goto.
	h.director.control('g1', h.listener, 'goto', { mode: 'absolute', ms: 700 });
	await until(() => h.builds.length === 2 && s.audible, 'the goto into the last chapter');
	h.director.control('g1', h.listener, 'sleep', 'chapter');
	assert.strictEqual(s.timers.chapter, null, 'the last chapter ends with the part, so Idle handles it');

	await until(() => s.state === 'ended', 'the stop', 4000);

	assert.strictEqual(s.endReason, 'sleep');
	assert.strictEqual(h.builds.length, 2, 'part 2 never starts');
	assert.strictEqual(mark(CHAPTERED).absoluteMs, 1400);
});

test('a chapter timer that fires before the audio got there re-arms instead of acting', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: CHAPTERED.id });
	h.director.control('g1', h.listener, 'sleep', 'chapter');
	assert.ok(s.timers.chapter, 'armed on Playing for the first embedded chapter');

	h.clock.advance(950);
	assert.strictEqual(s.state, 'playing', 'the audio is not at 600 ms yet');
	assert.ok(s.timers.chapter, 're-armed for the remainder');

	await until(() => h.director.position(s) >= 620, 'the audio passing the chapter end');
	h.clock.advance(2000);

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'sleep');
	assert.strictEqual(mark(CHAPTERED).absoluteMs, 600, 'saved at the chapter end');
});

test('an Idle from a resource that is no longer current is ignored', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h);
	const gate = deferred();
	h.setProbe(() => gate.promise);

	h.director.control('g1', h.listener, 'goto', { mode: 'absolute', ms: 500 });
	await until(() => h.players[0].state.status === 'idle', 'the old part ending during the probe', 4000);
	await sleep(30);

	assert.strictEqual(h.builds.length, 1, 'no advance from the stale Idle');
	assert.strictEqual(s.timers.retry, null, 'and no retry');
	assert.strictEqual(s.partIndex, 0);
	gate.resolve({ ok: true, status: 206 });
	await until(() => h.builds.length === 2, 'the goto build');
	assert.strictEqual(h.builds[1].startMs, 500);
});

test('a dead part key is repaired through repairPartKey and a missing file ends the session saved', async (t) => {
	const h = harness({ deps: { repairPartKey: async (work, p) => (p.ordinal === 1 ? p.partKey : null) } });
	t.after(() => h.done());
	h.setProbe(async () => ({ ok: false, status: 404 }));
	const s = await playing(h);
	assert.strictEqual(h.builds.length, 1, 'repaired and built');

	await until(() => s.state === 'ended', 'the second part failing', 4000);

	assert.strictEqual(s.endReason, 'failed-file');
	assert.match(s.endDetail, /can't find the file for Ch 2/);
	assert.strictEqual(mark(SHORT).absoluteMs, 1000);
});

test('shutdown saves synchronously, flushes and closes the proxy without awaiting it', async () => {
	let proxyStopped = 0;
	const h = harness({ deps: { proxy: { stop: () => { proxyStopped++; return new Promise(() => {}); } } } });
	const s = await playing(h, { workId: LONG.id });
	await until(() => s.res && s.res.playbackDuration >= 300, '300 ms of audio');
	const heard = h.director.position(s);

	h.director.shutdown();

	assert.strictEqual(s.state, 'ended');
	assert.strictEqual(s.endReason, 'shutdown');
	const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')).bookmarks[`u1::${LONG.id}`];
	assert.ok(heard >= 300 && onDisk.absoluteMs >= Math.floor(heard), `the place is on disk at once (${onDisk.absoluteMs}, heard ${heard})`);
	assert.strictEqual(proxyStopped, 1);
	assert.strictEqual(h.conns[0].state.status, 'destroyed');
	const again = await h.play({ workId: LONG.id });
	assert.strictEqual(again.code, 'closed');
});

// ---- read-along hooks (helpers/readAlong.js) -----------------------------------------------------
// The pager follows the narration from these notifications alone, so each kind of move must
// produce one: a missed one leaves the DM page on the wrong chapter until the next timed turn.

function watch(h) {
	const seen = [];
	h.director.onChange((s, kind) => seen.push(kind));
	return seen;
}

test('change listeners hear started, moved, audible, paused and ended', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const seen = watch(h);
	const s = await playing(h, { workId: LONG.id });
	assert.deepStrictEqual(seen, ['started', 'moved', 'audible'], 'the start, its first build and its first frame');

	seen.length = 0;
	h.director.control('g1', h.listener, 'fwd', 30);
	await until(() => s.audible, 'audio after the seek');
	h.director.control('g1', h.listener, 'speed', 1.5);
	await until(() => s.audible, 'audio after the speed change');
	assert.deepStrictEqual(seen, ['moved', 'audible', 'moved', 'audible'], 'a seek and a speed change');

	seen.length = 0;
	h.director.control('g1', h.listener, 'pause');
	h.director.control('g1', h.listener, 'back', 10);
	h.director.control('g1', h.listener, 'speed', 2);
	assert.deepStrictEqual(seen, ['paused', 'moved', 'moved'], 'a parked jump and a parked speed change are moves too');

	seen.length = 0;
	h.director.control('g1', h.listener, 'resume');
	await until(() => s.audible, 'audio after the resume');
	h.director.control('g1', h.listener, 'stop');
	assert.deepStrictEqual(seen, ['moved', 'audible', 'ended']);
});

test('a natural part advance and a chapter jump are moves', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const seen = watch(h);
	const s = await playing(h);
	seen.length = 0;
	await until(() => h.builds.length === 2 && s.audible, 'the next part', 4000);
	assert.deepStrictEqual(seen, ['moved', 'audible']);

	const h2 = harness();
	t.after(() => h2.done());
	const seen2 = watch(h2);
	const s2 = await playing(h2, { workId: CHAPTERED.id });
	seen2.length = 0;
	h2.director.control('g1', h2.listener, 'nextch');
	await until(() => s2.audible && h2.builds.length === 2, 'the chapter jump');
	assert.deepStrictEqual(seen2, ['moved', 'audible']);
});

test('a throwing change listener breaks nothing, and a later listener still hears every event', async (t) => {
	const h = harness();
	t.after(() => h.done());
	h.director.onChange(() => { throw new Error('listener bug'); });
	const seen = watch(h);
	const s = await playing(h, { workId: LONG.id });
	h.director.control('g1', h.listener, 'fwd', 30);
	await until(() => s.audible && h.builds.length === 2, 'the seek still plays');
	h.director.control('g1', h.listener, 'stop');
	assert.strictEqual(s.state, 'ended');
	assert.deepStrictEqual(seen, ['started', 'moved', 'audible', 'moved', 'audible', 'ended']);
});

test('onChange returns an unsubscribe', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const seen = [];
	const off = h.director.onChange((s, kind) => seen.push(kind));
	off();
	await playing(h, { workId: LONG.id });
	assert.deepStrictEqual(seen, []);
});

test('view().text comes from setTextInfo, is null without it, and a throwing one gives null', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	assert.strictEqual(h.director.view(s).text, null);
	h.director.setTextInfo(x => ({ button: x.id === s.id }));
	assert.deepStrictEqual(h.director.view(s).text, { button: true });
	h.director.setTextInfo(() => { throw new Error('renderer bug'); });
	assert.strictEqual(h.director.view(s).text, null);
	h.director.setTextInfo(null);
	assert.strictEqual(h.director.view(s).text, null);
});

test('refreshCard edits the live card (coalesced) and ignores a session that is gone', async (t) => {
	const h = harness();
	t.after(() => h.done());
	const s = await playing(h, { workId: LONG.id });
	await until(() => h.textChannel.sent.length === 1, 'the card');
	const card = h.textChannel.sent[0];
	h.clock.advance(2000);
	const before = card.edits.length;
	h.director.setTextInfo(() => ({ button: true }));
	h.director.refreshCard(s);
	await until(() => card.edits.length === before + 1, 'the refresh edit');
	assert.deepStrictEqual(card.edits[card.edits.length - 1].view.text, { button: true });
	h.director.control('g1', h.listener, 'stop');
	await tick();
	const after = card.edits.length;
	h.director.refreshCard(s);
	h.director.refreshCard(null);
	h.clock.advance(5000);
	await tick();
	assert.strictEqual(card.edits.length, after);
});
