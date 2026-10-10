// commands/voicehealth.js and helpers/voiceHealthFormat.js: what !voicehealth and /voicehealth post.
//
// The bug: a stats table over Discord's 2000 characters is refused outright, so the command would
// answer nothing exactly when there is most to show (two hours of minutes, a flood of gap events).
// A listener's mark has to land in the timeline and come back with the minutes around it, a
// backtick in the note must not break the code block, and with the feature off the command has
// to say how to turn it on instead of showing an empty table.
//
// The sampler is the real one from helpers/voiceHealth.js on the injected clock and probes of
// test/voiceHealth.test.js; render() is also fed hand-built snapshots at the size limits.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-voicehealth-cmd-' + process.pid);

const { createVoiceHealth } = require('../helpers/voiceHealth.js');
const format = require('../helpers/voiceHealthFormat.js');
const voicehealth = require('../commands/voicehealth.js');
const { parse, respond } = voicehealth._test;

const timeOf = (iso) => iso.slice(11, 16);

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'ready' };
		this.ping = { ws: 40 };
	}
	get state() { return this._state; }
	dispatchAudio() { return true; }
}

function rig() {
	let perfNow = 1000;
	let wall = Date.parse('2026-10-09T12:00:00.000Z');
	let tickFn = null;
	const lines = [];
	const vh = createVoiceHealth({
		now: () => perfNow,
		wallNow: () => wall,
		setInterval: (fn) => { tickFn = fn; return { unref() {} }; },
		clearInterval: () => { tickFn = null; },
		write: (text) => { for (const l of text.trim().split('\n')) lines.push(JSON.parse(l)); },
		listConnections: () => [],
		probes: {
			loopDelay: () => ({ percentile: () => 16e6, max: 30e6, reset() {}, disable() {} }),
			elu: () => ({ utilization: 0.03 }),
			cpuUsage: () => ({ user: 0, system: 0 }),
			memoryUsage: () => ({ rss: 300 * 1024 * 1024, heapUsed: 90 * 1024 * 1024, external: 0, arrayBuffers: 0 }),
			cpus: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }],
			observeGc: () => () => {}
		}
	});
	return {
		vh,
		lines,
		advance(ms) { perfNow += ms; wall += ms; },
		run(seconds) { for (let i = 0; i < seconds; i++) { perfNow += 1000; wall += 1000; if (tickFn) tickFn(); } }
	};
}

function minute(i, extra = {}) {
	const at = Date.parse('2026-10-09T10:00:00.000Z') + i * 60000;
	return Object.assign({
		t: new Date(at).toISOString(), at, active: true, pkts: 2999, gaps: { 40: 123, 60: 50, 100: 12, 200: 3, 500: 1 },
		maxGap: 1830, burst: 40, playingS: 60, underMs: 12345, ping: { n: 4, min: 38, max: 211, last: 40 }, drops: 1,
		el: { p50: 15.6, p99: 812.3, max: 8800 }, elu: 0.4, cpu: 12.3, sys: 97.1, rssMB: 1885, heapMB: 1210,
		gc: { n: 30, maxMs: 120, totalMs: 400 }, events: 120
	}, extra);
}

function event(i) {
	return { t: new Date(Date.parse('2026-10-09T11:00:00.000Z') + i * 1000).toISOString(), type: 'gap', ms: 1830 + i, conn: 1, note: 'x'.repeat(200) };
}

test('parse reads minutes, mark and the slash subcommand forms', () => {
	assert.deepStrictEqual(parse(''), { action: 'show', minutes: 15 });
	assert.deepStrictEqual(parse('30'), { action: 'show', minutes: 30 });
	assert.deepStrictEqual(parse('show 30'), { action: 'show', minutes: 30 });
	assert.deepStrictEqual(parse('show'), { action: 'show', minutes: 15 });
	assert.deepStrictEqual(parse('mark choppy for 2 s'), { action: 'mark', note: 'choppy for 2 s' });
	assert.deepStrictEqual(parse('MARK'), { action: 'mark', note: '' });
	for (const bad of ['0', '121', '-5', 'banana', '15 30']) assert.deepStrictEqual(parse(bad), { action: 'usage' }, bad);
});

test('with the feature off the command says how to turn it on', async () => {
	const off = rig();
	assert.match(respond('', { health: off.vh }), /off.*\/config.*Voice/s);
	assert.match(respond('mark stutter', { health: off.vh }), /off/);
	assert.deepStrictEqual(off.lines, [], 'a mark while off records nothing');

	let sent = null;
	await voicehealth.command.process(null, null, { author: { username: 'Listener' }, reply: async (p) => { sent = p; } }, '');
	assert.match(sent.content, /Voice health logging is off/);
	assert.deepStrictEqual(sent.allowedMentions, { parse: [] });
});

test('a full two hours of busy minutes and long events still fits one message, newest kept', () => {
	const snap = {
		enabled: true,
		minutes: Array.from({ length: 120 }, (_, i) => minute(i)),
		current: null,
		events: Array.from({ length: 40 }, (_, i) => event(i)),
		live: { conns: 1, players: 1 }
	};
	const text = format.render(snap, { minutes: 120, timeOf });

	assert.ok(text.length <= 2000, `${text.length} chars`);
	assert.ok(text.includes(format.HEADER));
	assert.ok(text.includes(format.LEGEND));
	assert.ok(text.includes('11:59 '), 'the newest minute survives the trim');
	assert.ok(!text.includes('10:00 '), 'the oldest minute is what goes');
	assert.ok(text.trimEnd().endsWith('```'), 'the code block is closed');
	assert.match(text, /GUNLC/);
});

test('fifteen minutes of ordinary rows show every row and the last ten events', () => {
	const snap = {
		enabled: true,
		minutes: Array.from({ length: 15 }, (_, i) => minute(i, { gaps: { 40: 0, 60: 0, 100: 0, 200: 0, 500: 0 }, underMs: 0, drops: 0, el: { p50: 15.6, p99: 31, max: 47 }, sys: 40 })),
		current: null,
		events: Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse('2026-10-09T10:05:00Z') + i * 1000).toISOString(), type: 'gap', ms: 41 + i, conn: 1 })),
		live: { conns: 1, players: 1 }
	};
	const text = format.render(snap, { minutes: 15, timeOf });
	const rows = text.split('\n').filter((l) => /^\d\d:\d\d /.test(l) && /\s\.$/.test(l));

	assert.strictEqual(rows.length, 15);
	assert.strictEqual((text.match(/ gap ms=/g) || []).length, 10);
	assert.ok(text.includes('gap ms=52'), 'the newest event is listed');
	assert.ok(!text.includes('gap ms=41 '), 'the oldest two are not');
});

test('idle minutes are hidden and counted', () => {
	const snap = {
		enabled: true,
		minutes: [minute(0, { active: false, pkts: 0 }), minute(1, { active: false, pkts: 0 })],
		current: null,
		events: [],
		live: { conns: 0, players: 0 }
	};
	const text = format.render(snap, { minutes: 15, timeOf });
	assert.match(text, /2 idle min hidden/);
	assert.match(text, /No voice activity in this window/);
	assert.match(text, /events: none/);
});

test('mark records the note in the timeline and replies with the last two minutes', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);
	conn.dispatchAudio();
	r.advance(300);
	conn.dispatchAudio();
	r.run(60);
	conn.dispatchAudio();

	const text = respond('mark choppy `again`', { health: r.vh, user: 'Listener', timeOf });

	const marks = r.lines.filter((l) => l.type === 'mark');
	assert.deepStrictEqual(marks.map((m) => [m.note, m.user]), [["choppy 'again'", 'Listener']]);
	assert.match(text, /^\*\*Marked\.\*\* The last 2 min/);
	assert.ok(text.includes('mark note=choppy \'again\' user=Listener'));
	assert.strictEqual((text.match(/```/g) || []).length, 2, 'the note cannot open another code block');
	assert.match(text, /\n12:01\*/, 'the minute in progress is shown, starred');
	assert.match(text, /\n12:00 /, 'the closed minute before it is shown');
	assert.ok(text.length <= 2000);
});

test('show renders the sampler\'s own minutes', () => {
	const r = rig();
	r.vh.setEnabled(true);
	const conn = new FakeConn();
	r.vh.watchConnection(conn);
	conn.dispatchAudio();
	r.advance(150);
	conn.dispatchAudio();
	r.run(60);

	const text = respond('show 5', { health: r.vh, timeOf });
	const row = text.split('\n').find((l) => l.startsWith('12:00 '));
	assert.ok(row, text);
	assert.deepStrictEqual(row.trim().split(/\s+/), ['12:00', '2', '1', '1', '150', '0', '40', '16/30', '0', '-', '90/300', 'G']);
});
