// helpers/apMediaBooks.js: audiobooks the bot plays in voice turned into Plex Media credit events
// (spec 5.7).
//
// The span rules decide when a step in work time is listening: it has to fit the wall time that
// passed at the session's speed, and a pause, a stall or a jump starts the measure again, so a
// /book goto (or one made while paused and read after a long pause) never earns the checkpoints it
// jumped over. The engine's notifications are measured where they happen, so the seconds between
// the last poll and a pause or a stop, and between a resume or a jump and the next poll, are not
// lost. Finished bookmarks are reported on every poll at their finishedAt, and work ids go through
// the catalog because a rebuild can rename a work while a seed runs.
//
// Harness: a fake book engine (sessions, positions set by the test, onChange; like the real one, a
// test sets the state and the place before it notifies), fake bookmarks and catalog, a manual
// clock, and recording fake timers the test fires by hand. One test drives a real book director
// instead, on a cut-down copy of test/bookEngine.test.js's harness (a real AudioPlayer on Opus
// silence frames, so the place moves in real time), to hold the fakes to the engine's real order.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const voice = require('@discordjs/voice');
const { createBookDirector } = require('../helpers/bookEngine.js');
const books = require('../helpers/apMediaBooks.js');

const T0 = Date.UTC(2026, 10, 11, 20, 0, 0);
const MIN = 60000;

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function fakeTimers() {
	const handles = [];
	const make = (kind, fn, ms) => {
		const h = { kind, fn, ms, cleared: false, fired: false, unrefed: false, unref() { this.unrefed = true; return this; } };
		handles.push(h);
		return h;
	};
	return {
		handles,
		setInterval: (fn, ms) => make('interval', fn, ms),
		clearInterval: (h) => { if (h) h.cleared = true; },
		setTimeout: (fn, ms) => make('timeout', fn, ms),
		clearTimeout: (h) => { if (h) h.cleared = true; },
		live(kind, ms) {
			return handles.filter((h) => !h.cleared && !h.fired && h.kind === kind && (ms === undefined || h.ms === ms));
		},
		runTimeouts() {
			for (const h of this.live('timeout')) {
				h.fired = true;
				h.fn();
			}
		},
		fire(ms) {
			for (const h of this.live('interval', ms)) h.fn();
		}
	};
}

function fakeEngine() {
	const list = [];
	const pos = new Map();
	const listeners = new Set();
	return {
		list,
		pos,
		listeners,
		sessions: () => [...list],
		position: (s) => pos.get(s.id),
		onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		notify(s, kind) { for (const fn of listeners) fn(s, kind); }
	};
}

const CATALOG = {
	'w1': { id: 'w1', aliases: [] },
	'w4': { id: 'w4', aliases: ['old-w4'] },
	'old-w4': { id: 'w4', aliases: ['old-w4'] }
};

function setup({ engine = fakeEngine(), marks = {}, bound = ['u1'], onEvent, withOnChange = true } = {}) {
	const timers = fakeTimers();
	const clock = { t: T0 };
	const events = [];
	const warns = [];
	const userCalls = [];
	if (!withOnChange) delete engine.onChange;
	const detach = books.attach({
		books: engine,
		bookmarks: { forUser: (id) => (marks[id] || []).map((m) => ({ ...m })) },
		catalogStore: { work: (id) => (typeof id === 'string' && CATALOG[id]) || null },
		users: () => { userCalls.push(true); return bound; },
		onEvent: onEvent || ((e) => { events.push(e); }),
		now: () => clock.t,
		timers,
		logger: { warn: (...a) => warns.push(a.join(' ')), info() {}, error() {}, debug() {} }
	});
	const session = (extra = {}) => {
		const s = { id: 's1', guildId: 'g1', userId: 'u1', workId: 'w1', state: 'playing', speed: 1, ...extra };
		engine.list.push(s);
		return s;
	};
	/** Move the clock and the session, then run the 10 s poll. */
	const step = async (s, wallMs, toPos) => {
		clock.t += wallMs;
		if (toPos !== undefined) engine.pos.set(s.id, toPos);
		timers.fire(books.SPAN_MS);
		await flush();
	};
	return { engine, timers, clock, events, warns, userCalls, detach, session, step };
}

/** A playing session whose first poll has set its baseline at `pos`. */
async function started(ctx, pos = 10 * MIN, extra) {
	const s = ctx.session(extra);
	ctx.engine.pos.set(s.id, pos);
	ctx.engine.notify(s, 'started');
	ctx.timers.runTimeouts();
	await flush();
	return s;
}

const spans = (events) => events.filter((e) => e.type === 'span').map((e) => [e.fromMs, e.toMs]);

test('a playing session earns a span for each step that fits the wall time', async () => {
	const ctx = setup();
	const s = await started(ctx);
	assert.deepStrictEqual(ctx.events, [], 'the first poll only sets the baseline');

	await ctx.step(s, 10000, 10 * MIN + 10000);
	await ctx.step(s, 10000, 10 * MIN + 20000);

	assert.deepStrictEqual(ctx.events[0], {
		type: 'span',
		source: 'book',
		userIds: ['u1'],
		workId: 'w1',
		workIds: ['w1'],
		fromMs: 10 * MIN,
		toMs: 10 * MIN + 10000,
		at: T0 + 10000
	});
	assert.deepStrictEqual(spans(ctx.events), [[10 * MIN, 10 * MIN + 10000], [10 * MIN + 10000, 10 * MIN + 20000]]);
});

test('a step counts up to 1.5x the wall time at the session speed plus 5 s, and a jump past it counts from where it lands', async () => {
	const ctx = setup();
	const s = await started(ctx, 0);

	await ctx.step(s, 10000, 20000);
	assert.deepStrictEqual(spans(ctx.events), [[0, 20000]], '10 s x 1.5 + 5 s = 20 s fits exactly');

	await ctx.step(s, 10000, 40001);
	assert.strictEqual(ctx.events.length, 1, '20.001 s in 10 s is a jump');
	await ctx.step(s, 10000, 50001);
	assert.deepStrictEqual(spans(ctx.events)[1], [40001, 50001], 'measured again from where the jump landed');

	s.speed = 2;
	await ctx.step(s, 10000, 85001);
	assert.deepStrictEqual(spans(ctx.events)[2], [50001, 85001], 'at 2x, 35 s of book in 10 s is listening');
});

test('a jump made while paused never counts, however long the pause', async () => {
	const ctx = setup();
	const s = await started(ctx, 10 * MIN);

	s.state = 'paused';
	await ctx.step(s, 10000, 10 * MIN + 5000);
	// An hour later the listener resumes after a /book goto 30 minutes on; a bound stretched over the
	// hour would take that 30-minute step for listening.
	s.state = 'playing';
	await ctx.step(s, 60 * MIN, 40 * MIN);
	await ctx.step(s, 10000, 40 * MIN + 10000);

	assert.deepStrictEqual(spans(ctx.events), [[40 * MIN, 40 * MIN + 10000]]);
});

test('a stalled or rewound session starts its measure again', async () => {
	const ctx = setup();
	const s = await started(ctx, 10 * MIN);

	// Buffering for a minute: the position does not move, and the wall time it spent is not banked.
	await ctx.step(s, 60000, 10 * MIN);
	await ctx.step(s, 10000, 10 * MIN + 50000);
	assert.deepStrictEqual(ctx.events, [], '50 s in 10 s after a stall is a jump, not a minute of listening');

	await ctx.step(s, 10000, 9 * MIN);
	await ctx.step(s, 10000, 9 * MIN + 10000);
	assert.deepStrictEqual(spans(ctx.events), [[9 * MIN, 9 * MIN + 10000]], 'a rewind earns nothing, and the next step counts from it');
});

/** What the engine does on a pause: park the place, then notify. */
function pause(ctx, s, wallMs, at) {
	ctx.clock.t += wallMs;
	s.state = 'paused';
	ctx.engine.pos.set(s.id, at);
	ctx.engine.notify(s, 'paused');
}

/** What the engine does on a stop: park the place, drop the session, then notify. */
function stop(ctx, s, wallMs, at) {
	ctx.clock.t += wallMs;
	s.state = 'ended';
	ctx.engine.pos.set(s.id, at);
	const i = ctx.engine.list.indexOf(s);
	if (i >= 0) ctx.engine.list.splice(i, 1);
	ctx.engine.notify(s, 'ended');
}

test('a pause counts the seconds since the last poll, and a resume counts from where it starts again', async () => {
	const ctx = setup();
	const s = await started(ctx, 29 * MIN + 56000);

	// /book pause at 30:04, before the next poll comes round.
	pause(ctx, s, 8000, 30 * MIN + 4000);
	ctx.timers.runTimeouts();
	await flush();
	assert.deepStrictEqual(spans(ctx.events), [[29 * MIN + 56000, 30 * MIN + 4000]], 'the 30:00 checkpoint was passed while playing');
	assert.strictEqual(ctx.events[0].at, T0 + 8000);

	await ctx.step(s, 2000);
	// Resumed half a minute later where it parked: the engine restarts the part there.
	ctx.clock.t += 30000;
	s.state = 'playing';
	ctx.engine.notify(s, 'moved');
	ctx.clock.t += 1500;
	ctx.engine.pos.set(s.id, 30 * MIN + 4040);
	ctx.engine.notify(s, 'audible');
	await ctx.step(s, 6500, 30 * MIN + 12000);

	assert.deepStrictEqual(spans(ctx.events), [
		[29 * MIN + 56000, 30 * MIN + 4000],
		[30 * MIN + 4000, 30 * MIN + 12000]
	], 'the pause is sent once, the 8 s after the resume count, and the sound starting is no step of its own');
});

test('a stop counts the seconds since the last poll, and the last session ending stops the span poll', async () => {
	const ctx = setup();
	const s = await started(ctx, 10 * MIN);
	await ctx.step(s, 10000, 10 * MIN + 10000);

	stop(ctx, s, 6000, 10 * MIN + 16000);
	ctx.timers.runTimeouts();
	await flush();

	assert.deepStrictEqual(spans(ctx.events), [[10 * MIN, 10 * MIN + 10000], [10 * MIN + 10000, 10 * MIN + 16000]]);
	assert.strictEqual(ctx.events[1].at, T0 + 16000);
	assert.strictEqual(ctx.timers.live('interval', books.SPAN_MS).length, 0);
});

test('a stop that detach finds before its poll still goes out once, as at a !restart', async () => {
	const ctx = setup();
	const s = await started(ctx, 10 * MIN);
	await ctx.step(s, 10000, 10 * MIN + 10000);

	stop(ctx, s, 6000, 10 * MIN + 16000);
	ctx.detach();
	ctx.detach();
	await flush();

	assert.deepStrictEqual(spans(ctx.events), [[10 * MIN, 10 * MIN + 10000], [10 * MIN + 10000, 10 * MIN + 16000]]);
	assert.strictEqual(ctx.timers.live('timeout').length, 0);
	assert.strictEqual(ctx.timers.live('interval').length, 0);
});

test('a pause or a stop that parks far ahead of the sound, like /book finish, earns nothing for the jump', async () => {
	const ctx = setup();
	const a = await started(ctx, 10 * MIN);
	const b = ctx.session({ id: 's2', guildId: 'g2', userId: 'u2' });
	ctx.engine.pos.set(b.id, 20 * MIN);
	await ctx.step(a, 10000, 10 * MIN + 10000);

	stop(ctx, a, 6000, 300 * MIN);
	pause(ctx, b, 0, 21 * MIN);
	ctx.timers.runTimeouts();
	await flush();

	assert.deepStrictEqual(spans(ctx.events), [[10 * MIN, 10 * MIN + 10000]]);
});

test('a poll that comes round before a pause is sent sends it once', async () => {
	const ctx = setup();
	const s = await started(ctx, 29 * MIN + 56000);

	pause(ctx, s, 8000, 30 * MIN + 4000);
	await ctx.step(s, 2000);
	ctx.timers.runTimeouts();
	await flush();

	assert.deepStrictEqual(spans(ctx.events), [[29 * MIN + 56000, 30 * MIN + 4000]]);
});

test('a pause while a poll still delivers goes out after it, one event at a time', async () => {
	const order = [];
	let release = null;
	const ctx = setup({
		onEvent: (e) => {
			order.push([e.fromMs, e.toMs]);
			if (order.length === 1) return new Promise((r) => { release = r; });
			return undefined;
		}
	});
	const s = await started(ctx, 0);
	await ctx.step(s, 10000, 10000);

	pause(ctx, s, 4000, 14000);
	ctx.timers.runTimeouts();
	await flush();
	assert.deepStrictEqual(order, [[0, 10000]], 'held while the first one is delivered');

	release();
	await flush();
	await ctx.step(s, 6000);
	assert.deepStrictEqual(order, [[0, 10000], [10000, 14000]]);
});

test('a jump while playing never counts, and the measure starts again where it landed', async () => {
	const ctx = setup();
	const s = await started(ctx, 10 * MIN);
	await ctx.step(s, 10000, 10 * MIN + 10000);

	// /book goto 29:58, 3 s after that poll: the engine moves the place, then notifies.
	ctx.clock.t += 3000;
	ctx.engine.pos.set(s.id, 29 * MIN + 58000);
	ctx.engine.notify(s, 'moved');
	await ctx.step(s, 7000, 30 * MIN + 5000);

	assert.deepStrictEqual(spans(ctx.events), [
		[10 * MIN, 10 * MIN + 10000],
		[29 * MIN + 58000, 30 * MIN + 5000]
	], 'the 30:00 checkpoint just after the landing counts');
});

test('a speed change keeps the step played at the old speed', async () => {
	const ctx = setup();
	const s = await started(ctx, 0, { speed: 3 });

	// /book speed 1, 9 s in: the engine reads the place, sets the speed, then restarts there.
	ctx.clock.t += 9000;
	ctx.engine.pos.set(s.id, 27000);
	s.speed = 1;
	ctx.engine.notify(s, 'moved');
	await ctx.step(s, 1000, 28000);

	assert.deepStrictEqual(spans(ctx.events), [[0, 27000], [27000, 28000]]);
});

test('the 10 s poll runs only while a book session exists', async () => {
	const ctx = setup();
	ctx.timers.runTimeouts();
	await flush();
	assert.strictEqual(ctx.timers.live('interval', books.SPAN_MS).length, 0, 'no session, no span poll');
	assert.strictEqual(ctx.timers.live('interval', books.FINISH_MS).length, 1);

	const s = await started(ctx);
	assert.strictEqual(ctx.timers.live('interval', books.SPAN_MS).length, 1);
	ctx.engine.notify(s, 'moved');
	assert.strictEqual(ctx.timers.live('timeout').length, 0, 'an armed poll needs no kick');

	ctx.engine.list.length = 0;
	await ctx.step(s, 10000);
	assert.strictEqual(ctx.timers.live('interval', books.SPAN_MS).length, 0, 'the last session ended');
});

test('without onChange, the 60 s poll starts the span poll when it finds a session', async () => {
	const ctx = setup({ withOnChange: false, bound: [] });
	ctx.timers.runTimeouts();
	const s = ctx.session();
	ctx.engine.pos.set(s.id, 0);
	ctx.timers.fire(books.FINISH_MS);
	await flush();
	assert.strictEqual(ctx.timers.live('interval', books.SPAN_MS).length, 1);

	await ctx.step(s, 10000, 10000);
	assert.deepStrictEqual(spans(ctx.events), [[0, 10000]]);
});

test('sessions that are not playing, or have no position, earn nothing', async () => {
	const ctx = setup();
	const starting = await started(ctx, 0, { id: 's1', state: 'starting' });
	const lost = ctx.session({ id: 's2', guildId: 'g2', userId: 'u2' });
	ctx.engine.pos.set(lost.id, NaN);

	await ctx.step(starting, 10000, 10000);
	ctx.engine.pos.set(lost.id, 20000);
	await ctx.step(starting, 10000, 20000);

	assert.deepStrictEqual(ctx.events, []);
});

test('finished bookmarks of the bound users are reported at their finishedAt on every 60 s poll', async () => {
	const marks = {
		u1: [
			{ workId: 'w1', finished: true, finishedAt: T0 - 5 * MIN },
			{ workId: 'w2', finished: false, finishedAt: null },
			{ workId: 'w3', finished: true, finishedAt: null }
		],
		u2: [{ workId: 'old-w4', finished: true, finishedAt: T0 - MIN }],
		stranger: [{ workId: 'w1', finished: true, finishedAt: T0 }]
	};
	const ctx = setup({ marks, bound: ['u1', 'u2', 'u1'] });

	ctx.timers.fire(books.FINISH_MS);
	await flush();
	const first = ctx.events.slice();
	ctx.timers.fire(books.FINISH_MS);
	await flush();

	assert.deepStrictEqual(first, [
		{ type: 'complete', source: 'book', userIds: ['u1'], workId: 'w1', workIds: ['w1'], at: T0 - 5 * MIN },
		{ type: 'complete', source: 'book', userIds: ['u2'], workId: 'w4', workIds: ['w4', 'old-w4'], at: T0 - MIN }
	]);
	assert.deepStrictEqual(ctx.events.slice(2), first, 'repeated: the game dedupes, and a slot bound later still gets it');
});

test('work ids go through the catalog: a renamed work comes under its new id, with its old ones', async () => {
	const ctx = setup();
	const s = await started(ctx, 0, { workId: 'old-w4' });
	await ctx.step(s, 10000, 10000);
	const gone = ctx.session({ id: 's2', guildId: 'g2', workId: 'not-in-catalog' });
	ctx.engine.pos.set(gone.id, 0);
	await ctx.step(s, 10000, 20000);
	ctx.engine.pos.set(gone.id, 10000);
	await ctx.step(s, 10000, 30000);

	assert.deepStrictEqual(ctx.events.map((e) => [e.workId, e.workIds]), [
		['w4', ['w4', 'old-w4']],
		['w4', ['w4', 'old-w4']],
		['w4', ['w4', 'old-w4']],
		['not-in-catalog', ['not-in-catalog']]
	]);
});

test('events go out one at a time; a failure is logged and a poll waiting on delivery keeps its baseline', async () => {
	const order = [];
	let release = null;
	const ctx = setup({
		onEvent: (e) => {
			order.push(e.type === 'span' ? [e.fromMs, e.toMs] : e.workId);
			if (order.length === 1) return Promise.reject(new Error('store full'));
			if (order.length === 2) return new Promise((r) => { release = r; });
			return undefined;
		},
		marks: { u1: [{ workId: 'w1', finished: true, finishedAt: T0 }] }
	});
	const s = await started(ctx, 0);

	await ctx.step(s, 10000, 10000);
	assert.match(ctx.warns[0], /span credit for w1 failed: store full/);
	await ctx.step(s, 10000, 20000);
	assert.strictEqual(typeof release, 'function', 'the second span is still being delivered');
	await ctx.step(s, 10000, 30000);
	assert.strictEqual(order.length, 2, 'no poll while one still delivers');

	release();
	await flush();
	await ctx.step(s, 5000, 35000);
	ctx.timers.fire(books.FINISH_MS);
	await flush();
	assert.deepStrictEqual(order, [[0, 10000], [10000, 20000], [20000, 35000], 'w1'], 'the skipped poll left its step to the next one');
	assert.strictEqual(ctx.warns.length, 1);
});

test('the timers are unref()ed, and detach clears them and leaves the engine', async () => {
	const ctx = setup({ marks: { u1: [{ workId: 'w1', finished: true, finishedAt: T0 }] } });
	const s = await started(ctx, 0);
	assert.ok(ctx.timers.handles.length >= 3);
	assert.ok(ctx.timers.handles.every((h) => h.unrefed));

	ctx.detach();
	ctx.detach();
	assert.strictEqual(ctx.timers.live('interval').length, 0);
	assert.strictEqual(ctx.engine.listeners.size, 0);
	ctx.engine.notify(s, 'moved');
	assert.strictEqual(ctx.timers.live('timeout').length, 0);
	assert.deepStrictEqual(ctx.events, []);
});

test('attach refuses to run without what it reads', () => {
	const engine = fakeEngine();
	const ok = { books: engine, bookmarks: { forUser: () => [] }, users: () => [], onEvent() {}, timers: fakeTimers() };
	assert.throws(() => books.attach({ ...ok, books: {} }), /book engine/);
	assert.throws(() => books.attach({ ...ok, bookmarks: null }), /bookmarks/);
	assert.throws(() => books.attach({ ...ok, users: null }), /users/);
	assert.throws(() => books.attach({ ...ok, onEvent: null }), /onEvent/);
});

// ---- against a real book director ---------------------------------------------------------

const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, what, ms = 5000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'ready' };
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
	destroy() { this.state = { status: 'destroyed' }; }
	setSpeaking() {}
	prepareAudioPacket() {}
	dispatchAudio() {}
}

/** A director with a book of two 10-minute parts, its own timers on a clock that never moves. */
function realDirector(t) {
	const parts = [1, 2].map((n) => ({
		ordinal: n,
		albumRatingKey: '720',
		trackRatingKey: `72${n}`,
		title: `Part ${n}`,
		durationMs: 10 * MIN,
		partKey: `/library/parts/72${n}/1700000000/part${n}.mp3`,
		file: `part${n}.mp3`,
		sizeBytes: 1000 + n,
		container: 'mp3'
	}));
	const work = { id: 'test-author/long-book', kind: 'book', title: 'Long Book', author: 'Test Author', narrator: null, edition: null, series: null, sequence: null, aliases: [], parts };
	const guild = { id: 'g1', voiceStates: { cache: new Map([['u1', { channelId: 'v1' }]]) }, voiceAdapterCreator: () => ({}) };
	const channel = { id: 'v1', name: 'Reading Room', guild };
	const listener = { id: 'u1', displayName: 'Reader', user: { id: 'u1', username: 'Reader' }, guild, voice: { channel, channelId: 'v1' } };
	const textChannel = {
		id: 't1',
		async send() {
			const msg = { async edit() { return msg; } };
			return msg;
		}
	};
	const conns = [];
	const deps = {
		// Never advanced: the engine's own timers stay quiet, and a resume never rewinds.
		timers: { setTimeout: (fn, ms) => ({ fn, ms, unref() {} }), clearTimeout() {}, now: () => T0 },
		config: { audiobooksEnabled: true, audiobookSaveSeconds: 15, audiobookIdleLeaveMinutes: 10, audiobookResumeRewindSeconds: 10, ownerId: 'owner' },
		catalog: { works: () => [work], work: (id) => (id === work.id ? work : null), findWorks: () => [work], partKeyFor: (w, p) => p.partKey },
		library: { start: () => null, stop() {}, ensureFresh: async () => ({ action: 'fresh' }), status: () => 'ready', lastError: () => null },
		repairPartKey: async () => null,
		ensureFresh: async () => ({ action: 'fresh' }),
		proxy: { stop: async () => {} },
		probe: async () => ({ ok: true, status: 206 }),
		urlFor: (key) => `fake:${key}`,
		createPlayer: () => voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause, maxMissedFrames: 750 } }),
		createResource: ({ url, startMs, speed }) => {
			const p = parts.find((x) => `fake:${x.partKey}` === url);
			const frames = Math.max(1, Math.round((p.durationMs - startMs) / speed / 20));
			let n = 0;
			const stream = new Readable({ objectMode: true, read() { if (n++ < frames) this.push(SILENCE); else this.push(null); } });
			const resource = voice.createAudioResource(stream, { inputType: voice.StreamType.Opus });
			const kill = () => { if (!stream.destroyed) stream.destroy(); };
			resource.playStream.once('close', kill);
			return { resource, kill };
		},
		card: { buildCard: (v) => ({ view: v }), endedCard: (v) => ({ view: v }), movedCard: () => ({}) },
		commandLog: { recordEvent() {} },
		getVoiceConnection: () => conns[conns.length - 1]
	};
	const bot = {
		songQueue: [],
		musicBusy: () => false,
		openConnection() {
			const c = new FakeConn();
			conns.push(c);
			return Promise.resolve(c);
		},
		playSong: () => Promise.resolve()
	};
	const client = new EventEmitter();
	client.user = { id: 'bot' };
	const director = createBookDirector({ client, bot, deps });
	t.after(async () => {
		director.shutdown();
		await flush();
	});
	return {
		director,
		control: (action, arg) => director.control(guild.id, listener, action, arg),
		play: () => director.play({ guild, member: listener, textChannel, workId: work.id }),
		session: () => director.session(guild.id)
	};
}

test('against a real book director, a pause, a resume, a jump and a stop give the spans it played', async (t) => {
	const real = realDirector(t);
	const timers = fakeTimers();
	const events = [];
	const warns = [];
	t.after(books.attach({
		books: real.director,
		bookmarks: { forUser: () => [] },
		users: () => [],
		onEvent: (e) => { events.push(e); },
		timers,
		logger: { warn: (...a) => warns.push(a.join(' ')), info() {}, error() {}, debug() {} }
	}));
	const r = await real.play();
	assert.strictEqual(r.ok, true, r.text);
	const s = real.session();
	const movedOn = (from) => until(() => real.director.position(s) >= from + 100, 'the audio to move on');
	const poll = async () => {
		timers.fire(books.SPAN_MS);
		await flush();
	};
	/** The events an action gave, after the engine's own notifications and a turn. */
	const after = async (act) => {
		const n = events.length;
		act();
		timers.runTimeouts();
		await flush();
		return events.slice(n);
	};

	await until(() => s.audible, 'audio');
	timers.runTimeouts();
	await flush();
	await movedOn(real.director.position(s));
	await poll();
	const polled = events[events.length - 1].toMs;

	await movedOn(polled);
	const paused = await after(() => real.control('pause'));
	assert.deepStrictEqual(spans(paused), [[polled, s.parkedAbsMs]], 'the pause closes the step where it parked');

	const resumedAt = s.parkedAbsMs;
	assert.deepStrictEqual(await after(() => real.control('resume')), []);
	assert.strictEqual(s.anchorAbsMs, resumedAt);
	await until(() => s.audible, 'audio after the resume');
	await movedOn(resumedAt);
	let n = events.length;
	await poll();
	assert.strictEqual(events.length, n + 1);
	assert.strictEqual(events[n].fromMs, resumedAt, 'the next step starts where it resumed');

	const before = events[n].toMs;
	assert.deepStrictEqual(await after(() => real.control('fwd', 30)), [], 'the jump earns nothing');
	const landed = s.anchorAbsMs;
	assert.ok(landed >= before + 30000);
	await until(() => s.audible, 'audio after the jump');
	await movedOn(landed);
	n = events.length;
	await poll();
	assert.strictEqual(events.length, n + 1);
	assert.strictEqual(events[n].fromMs, landed, 'the step after it starts where it landed');

	const last = events[n].toMs;
	await movedOn(last);
	const stopped = await after(() => real.control('stop'));
	assert.deepStrictEqual(spans(stopped), [[last, s.parkedAbsMs]], 'the stop closes the step where it parked');

	assert.ok(events.every((e) => e.toMs - e.fromMs < 5000), 'no step reaches over the jump');
	assert.deepStrictEqual(warns, []);
});
