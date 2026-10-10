// helpers/voiceHealth.js: the opt-in voice-health sampler.
//
// The bug: a listener reports a stutter and nothing in the bot recorded what happened during the
// track, so there was no way to tell the bot's own late send timer from a starved source, a voice
// reconnect or a busy machine. The sampler has to see each of those, roll them into one line per
// minute, keep a flood of events from filling the disk, and cost nothing while it is switched off.
//
// Harness: the sampler's clock, interval timer, probes and writer are injected (a manual clock and
// fake event-loop and CPU readings), on a FakeConn modelled on test/bookEngine.test.js's, whose
// dispatchAudio lives on the prototype as VoiceConnection's does. The player is an EventEmitter
// whose state carries the playbackDuration counters the real AudioPlayer and AudioResource keep.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-voicehealth-' + process.pid);

const voiceHealth = require('../helpers/voiceHealth.js');
const { createVoiceHealth } = voiceHealth;

const MB = 1024 * 1024;

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'ready' };
		this.ping = { ws: 42, udp: undefined };
		this.dispatched = 0;
	}
	get state() { return this._state; }
	set state(next) {
		const old = this._state;
		this._state = next;
		this.emit('stateChange', old, next);
	}
	dispatchAudio() {
		this.dispatched++;
		return true;
	}
}

class FakePlayer extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'idle' };
	}
	get state() { return this._state; }
	set state(next) {
		const old = this._state;
		this._state = next;
		this.emit('stateChange', old, next);
	}
}

function rig(opts = {}) {
	let perfNow = 1000;
	let wall = Date.parse('2026-10-09T12:00:00.000Z');
	let tickFn = null;
	let intervals = 0;
	const lines = [];
	const probes = {
		loopDelay: () => ({ percentile: (p) => (p === 50 ? 16e6 : 31e6), max: 47e6, reset() {}, disable() {} }),
		elu: () => ({ utilization: 0.04 }),
		cpuUsage: () => ({ user: 0, system: 0 }),
		memoryUsage: () => ({ rss: 210 * MB, heapUsed: 80 * MB, external: 3 * MB, arrayBuffers: 1 * MB }),
		cpus: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }],
		observeGc: () => () => {}
	};
	const vh = createVoiceHealth(Object.assign({
		now: () => perfNow,
		wallNow: () => wall,
		setInterval: (fn) => { intervals++; tickFn = fn; return { unref() {} }; },
		clearInterval: () => { tickFn = null; },
		write: (text) => { for (const l of text.trim().split('\n')) lines.push(JSON.parse(l)); },
		listConnections: () => [],
		probes
	}, opts));
	return {
		vh,
		lines,
		intervals: () => intervals,
		advance(ms) { perfNow += ms; wall += ms; },
		tick() { if (tickFn) tickFn(); },
		// One tick a second, as the real interval would, for `seconds` seconds.
		run(seconds) { for (let i = 0; i < seconds; i++) { perfNow += 1000; wall += 1000; if (tickFn) tickFn(); } },
		of: (type) => lines.filter((l) => l.type === type)
	};
}

function playing(player, res, pd) {
	player._state = { status: 'playing', resource: res, playbackDuration: pd };
}

test('while off nothing is wrapped, listened to, timed or written', () => {
	const r = rig();
	const conn = new FakeConn();
	const player = new FakePlayer();

	r.vh.watchConnection(conn);
	r.vh.watchPlayer(player, { kind: 'music' });
	r.vh.event('book-early-end', { reason: 'x' });
	assert.strictEqual(r.vh.mark('stutter'), false);
	r.vh.flush();

	assert.strictEqual(Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio'), false);
	assert.strictEqual(conn.listenerCount('stateChange'), 0);
	assert.strictEqual(player.listenerCount('stateChange'), 0);
	assert.strictEqual(r.intervals(), 0);
	assert.deepStrictEqual(r.lines, []);
	assert.strictEqual(r.vh.snapshot().current, null);
});

test('the shared instance is off until something enables it', () => {
	const conn = new FakeConn();
	voiceHealth.watchConnection(conn);
	assert.strictEqual(voiceHealth.isEnabled(), false);
	assert.strictEqual(Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio'), false);
	assert.strictEqual(conn.listenerCount('stateChange'), 0);
});

test('a late packet is recorded as a gap, and a catch-up burst is counted', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);
	r.vh.watchConnection(conn);

	conn.dispatchAudio();
	r.advance(20);
	conn.dispatchAudio();
	r.advance(120);
	conn.dispatchAudio();
	r.advance(1);
	conn.dispatchAudio();

	assert.strictEqual(conn.dispatched, 4, 'the original still sends every packet');
	const gaps = r.vh.snapshot().events.filter((e) => e.type === 'gap');
	assert.deepStrictEqual(gaps.map((g) => g.ms), [120]);
	const cur = r.vh.snapshot().current;
	assert.strictEqual(cur.pkts, 4);
	assert.strictEqual(cur.gaps[40], 1);
	assert.strictEqual(cur.gaps[100], 1);
	assert.strictEqual(cur.maxGap, 120);
	assert.strictEqual(cur.burst, 1);
});

test('a source that starves while Playing is an underrun; end-of-track padding is not', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const player = new FakePlayer();
	r.vh.watchPlayer(player, { kind: 'music' });
	const res = { playbackDuration: 0, silenceRemaining: -1 };
	playing(player, res, 0);

	r.run(1);
	playing(player, res, 1000);
	res.playbackDuration = 600;
	r.run(1);
	playing(player, res, 2000);
	res.playbackDuration = 1600;
	r.run(1);
	res.silenceRemaining = 3;
	playing(player, res, 3000);
	res.playbackDuration = 1700;
	r.run(1);

	const underruns = r.vh.snapshot().events.filter((e) => e.type === 'underrun');
	assert.deepStrictEqual(underruns.map((u) => [u.ms, u.kind]), [[400, 'music']]);
	assert.strictEqual(r.vh.snapshot().current.underMs, 400);
});

test('a minute rolls up into one line with gaps, ping, loop delay, CPU and memory', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);
	conn.dispatchAudio();
	r.advance(250);
	conn.dispatchAudio();

	r.run(60);

	const [min] = r.of('min');
	assert.ok(min, 'a minute line was written');
	assert.strictEqual(min.pkts, 2);
	assert.strictEqual(min.gaps[100], 1);
	assert.strictEqual(min.maxGap, 250);
	assert.deepStrictEqual(min.ping, { n: 1, min: 42, max: 42, last: 42 });
	assert.deepStrictEqual(min.el, { p50: 16, p99: 31, max: 47 });
	assert.strictEqual(min.heapMB, 80);
	assert.strictEqual(min.rssMB, 210);
	assert.strictEqual(r.of('gap').length, 1, 'the event line went out with the minute');

	const before = r.lines.length;
	r.run(60);
	assert.strictEqual(r.lines.length, before, 'an idle minute is kept in memory, not written');
	assert.strictEqual(r.vh.snapshot(5).minutes.length, 2);
});

test('events past the per-minute cap are counted, not written, and marks always get through', () => {
	const r = rig({ maxEventsPerMinute: 3 });
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);
	conn.dispatchAudio();
	for (let i = 0; i < 6; i++) {
		r.advance(150);
		conn.dispatchAudio();
	}
	assert.strictEqual(r.vh.mark('choppy', 'Listener'), true);

	r.run(60);

	assert.strictEqual(r.of('gap').length, 3);
	assert.deepStrictEqual(r.of('mark').map((m) => [m.note, m.user]), [['choppy', 'Listener']]);
	// The 900 ms of packets with no tick also reads as a stall, the fourth event refused.
	assert.strictEqual(r.of('stall').length, 0);
	assert.strictEqual(r.of('min')[0].dropped, 4);
});

test('a reconnect is recorded and flagged; a destroy unwraps the connection', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);

	conn.state = { status: 'connecting' };
	conn.state = { status: 'ready' };
	conn.state = { status: 'destroyed' };

	const conns = r.vh.snapshot().events.filter((e) => e.type === 'conn').map((e) => `${e.from}>${e.to}`);
	assert.deepStrictEqual(conns, ['ready>connecting', 'connecting>ready', 'ready>destroyed']);
	assert.strictEqual(r.vh.snapshot().current.drops, 1, 'leaving the channel is not a drop');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio'), false);
	assert.strictEqual(conn.listenerCount('stateChange'), 0);
});

test('a player stripped of its listeners by the next track is summarised and let go', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const player = new FakePlayer();
	r.vh.watchPlayer(player, { kind: 'music' });
	const res = { playbackDuration: 0, silenceRemaining: -1 };
	playing(player, res, 0);
	r.run(1);
	res.playbackDuration = 5000;
	playing(player, res, 5000);
	r.run(1);

	player.removeAllListeners();
	r.run(1);

	const tracks = r.vh.snapshot().events.filter((e) => e.type === 'track');
	assert.deepStrictEqual(tracks.map((t) => [t.kind, t.playedMs]), [['music', 5000]]);
	assert.strictEqual(r.vh._watched().players, 0);
});

test('turning it on mid-track adopts the live connection and its player; off restores both', () => {
	const conn = new FakeConn();
	const player = new FakePlayer();
	conn._state = { status: 'ready', subscription: { player } };
	const r = rig({ listConnections: () => [conn] });

	r.vh.setEnabled(true);
	assert.deepStrictEqual(r.vh._watched(), { conns: 1, players: 1 });
	assert.strictEqual(Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio'), true);

	r.vh.setEnabled(false);
	assert.deepStrictEqual(r.vh._watched(), { conns: 0, players: 0 });
	assert.strictEqual(Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio'), false);
	assert.strictEqual(player.listenerCount('stateChange'), 0);
	r.tick();
	assert.strictEqual(r.intervals(), 1);
});

test('bindToConfig follows the setting at boot and on a /config change, subscribing once', (t) => {
	const listeners = [];
	const store = { onChange(fn) { listeners.push(fn); } };
	const logged = [];
	const logger = { info: (m) => logged.push(m) };
	t.after(() => voiceHealth.setEnabled(false));

	voiceHealth.bindToConfig({ voiceHealthEnabled: false }, { store, logger });
	voiceHealth.bindToConfig({ voiceHealthEnabled: false }, { store, logger });
	assert.strictEqual(listeners.length, 1);
	assert.strictEqual(voiceHealth.isEnabled(), false);

	listeners[0]('voiceHealthEnabled', true);
	assert.strictEqual(voiceHealth.isEnabled(), true);
	listeners[0]('processPriority', 'normal');
	assert.strictEqual(voiceHealth.isEnabled(), true);
	listeners[0]('voiceHealthEnabled', false);
	assert.strictEqual(voiceHealth.isEnabled(), false);
	assert.deepStrictEqual(logged, ['Voice health log on', 'Voice health log off']);
});

test('the packet wrapper costs microseconds per packet', () => {
	const vh = createVoiceHealth({
		setInterval: () => ({ unref() {} }),
		clearInterval: () => {},
		write: () => {},
		listConnections: () => [],
		probes: {
			loopDelay: () => ({ percentile: () => 0, max: 0, reset() {}, disable() {} }),
			observeGc: () => () => {}
		}
	});
	vh.setEnabled(true);
	const conn = new FakeConn();
	vh.watchConnection(conn);
	const N = 50000;
	for (let i = 0; i < N; i++) conn.dispatchAudio();
	vh.setEnabled(false);

	const perPacketUs = (vh._selfTime.sendMs * 1000) / vh._selfTime.sends;
	assert.strictEqual(vh._selfTime.sends, N);
	// 50 packets a second: even 20 us each would be 0.1% of one core.
	assert.ok(perPacketUs < 20, `${perPacketUs.toFixed(2)} us per packet`);
});
