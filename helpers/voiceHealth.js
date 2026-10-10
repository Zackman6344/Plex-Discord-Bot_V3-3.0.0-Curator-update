// helpers/voiceHealth.js
//
// Opt-in record of how voice audio actually went out, so a "it stuttered" from a listener can be
// matched to a cause: the bot's own send timer running late, the audio source starving, a voice
// reconnect, a blocked event loop, or the machine being busy. Nothing else in the bot logs what
// happens during a track.
//
// Off by default (config voiceHealthEnabled). While off, every hook returns on its first line:
// no listeners, no timers, no writes. While on, it costs about 0.06% of one core (measured with
// the real AudioPlayer at six times the normal minute-write rate).
//
// Writes data/logs/voice-YYYY-MM-DD.jsonl: one 'min' line per minute that had voice activity, and
// event lines (send gaps, stalls, underruns, reconnects, listener marks), all in one async append
// per minute.
//
// Two things it must never do:
// - enable the voice library's debug option, whose WebSocket debug lines carry the session token;
// - listen for 'error' on a VoiceConnection. With no listener, a voice error reaches the global
//   uncaughtException handler in app/utils.js; adding one would swallow it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const perf = require('perf_hooks');
const logPrune = require('./logPrune.js');

const GAP_THRESHOLDS = [40, 60, 100, 200, 500];
const NET_CODES = ['opening-ws', 'identifying', 'udp-handshaking', 'selecting-protocol', 'ready', 'resuming', 'closed'];
const VOICE_LOG = /^voice-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MB = 1024 * 1024;
// Rare, and the lines a complaint is read against, so the per-minute cap never drops them.
const UNCAPPED = new Set(['mark', 'conn', 'net', 'ws-close', 'book-early-end']);
const PENDING_LIMIT = 1000;
// Watched players are dropped once they lose our listener. A music player left Idle at the end
// of a queue keeps it until the next track, so this caps what a long idle run can hold.
const PLAYER_LIMIT = 16;

const round1 = (n) => Math.round(n * 10) / 10;

function defaultProbes() {
	return {
		loopDelay() {
			// 10 ms is the coarsest resolution that still sees a single missed 20 ms send.
			const h = perf.monitorEventLoopDelay({ resolution: 10 });
			h.enable();
			return h;
		},
		elu: (prev) => perf.performance.eventLoopUtilization(prev),
		cpuUsage: () => process.cpuUsage(),
		memoryUsage: () => process.memoryUsage(),
		cpus: () => os.cpus(),
		observeGc(fn) {
			const obs = new perf.PerformanceObserver((list) => {
				for (const e of list.getEntries()) fn(e.duration, e.detail && e.detail.kind);
			});
			obs.observe({ entryTypes: ['gc'] });
			return () => obs.disconnect();
		}
	};
}

function createVoiceHealth(options = {}) {
	const o = {
		dir: process.env.PLEXBOT_LOG_DIR || path.join(__dirname, '..', 'data', 'logs'),
		tickMs: 1000,
		minuteMs: 60000,
		gapEventMs: 40,
		stallEventMs: 100,
		gcEventMs: 50,
		underrunEventMs: 100,
		maxEventsPerMinute: 120,
		ringMinutes: 120,
		ringEvents: 500,
		now: () => perf.performance.now(),
		wallNow: Date.now,
		setInterval,
		clearInterval,
		// (text) => void. Replaces the file append; tests and harnesses capture lines with it.
		write: null,
		prune: null,
		listConnections: () => {
			const map = require('@discordjs/voice').getVoiceConnections();
			return map ? [...map.values()] : [];
		},
		probes: null,
		...options
	};
	const probes = { ...defaultProbes(), ...(o.probes || {}) };
	const prune = o.prune || (() => logPrune.pruneDayFiles(o.dir, VOICE_LOG, 'voice-log'));
	// The same rule as commandLog.js: under the test runner only a test's own log dir is written.
	const fileWrites = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_LOG_DIR;

	let on = false;
	const conns = new Map();
	const players = new Map();
	const minutes = [];
	const events = [];
	let pending = [];
	let acc = null;
	let loopDelay = null;
	let stopGc = null;
	let timer = null;
	let lastTick = 0;
	let minuteStart = 0;
	let minuteStartWall = 0;
	let lastCpu = null;
	let lastSys = null;
	let lastElu = null;
	let nextConnId = 1;
	let nextPlayerId = 1;
	const selfTime = { tickMs: 0, ticks: 0, sendMs: 0, sends: 0 };

	function freshAcc() {
		return {
			pkts: 0, gaps: Object.fromEntries(GAP_THRESHOLDS.map((g) => [g, 0])), maxGap: 0, burst: 0,
			playingS: 0, underMs: 0, pings: [], drops: 0, gcN: 0, gcMax: 0, gcTotal: 0, stallMax: 0,
			events: 0, dropped: 0
		};
	}

	const iso = () => new Date(o.wallNow()).toISOString();

	function emit(type, detail = {}) {
		if (!UNCAPPED.has(type)) {
			if (acc.events >= o.maxEventsPerMinute) {
				acc.dropped++;
				return;
			}
			acc.events++;
		}
		const line = { t: iso(), type, ...detail };
		events.push(line);
		if (events.length > o.ringEvents) events.shift();
		if (pending.length < PENDING_LIMIT) pending.push(line);
	}

	function flush() {
		if (pending.length === 0) return;
		const text = pending.map((l) => JSON.stringify(l)).join('\n') + '\n';
		pending = [];
		if (o.write) {
			try { o.write(text); } catch (_) {}
			return;
		}
		if (!fileWrites) return;
		const file = path.join(o.dir, `voice-${iso().slice(0, 10)}.jsonl`);
		fs.mkdir(o.dir, { recursive: true }, (err) => {
			if (err) return;
			fs.appendFile(file, text, () => {});
			try { prune(); } catch (_) {}
		});
	}

	// ---- packets ------------------------------------------------------------------------------

	function sent(cw) {
		const t0 = o.now();
		if (cw.last !== null) {
			const gap = t0 - cw.last;
			// The voice timer catches up on a late cycle by sending the missed packets back to back.
			if (gap < 5) acc.burst++;
			for (const g of GAP_THRESHOLDS) if (gap >= g) acc.gaps[g]++;
			if (gap > acc.maxGap) acc.maxGap = gap;
			const sub = cw.conn.state && cw.conn.state.subscription;
			const pw = sub ? players.get(sub.player) : undefined;
			if (pw) {
				if (gap >= 40) pw.gaps40++;
				if (gap > pw.maxGap) pw.maxGap = gap;
			}
			if (gap >= o.gapEventMs) emit('gap', { ms: Math.round(gap), conn: cw.id });
		}
		cw.last = t0;
		acc.pkts++;
		selfTime.sends++;
		selfTime.sendMs += o.now() - t0;
	}

	// Silence between tracks or during a pause is not a gap the timer caused.
	function resetSendClocks() {
		for (const cw of conns.values()) cw.last = null;
	}

	// ---- connections --------------------------------------------------------------------------

	function watchConnection(conn, meta = {}) {
		if (!on || !conn || conns.has(conn) || typeof conn.dispatchAudio !== 'function') return;
		const cw = {
			id: nextConnId++, conn, meta, last: null, net: null, onNet: null, ws: null, onWsClose: null, lastPing: null,
			original: conn.dispatchAudio,
			hadOwn: Object.prototype.hasOwnProperty.call(conn, 'dispatchAudio')
		};
		conns.set(conn, cw);
		const original = cw.original;
		// The player calls dispatchAudio through the instance, so an own property sees every packet
		// without touching the voice library's prototype or any other connection.
		cw.wrapper = function dispatchAudio(...args) {
			const r = original.apply(this, args);
			if (r) sent(cw);
			return r;
		};
		conn.dispatchAudio = cw.wrapper;
		cw.onState = (from, to) => {
			if (from.status !== to.status) {
				emit('conn', { conn: cw.id, from: from.status, to: to.status, closeCode: to.closeCode, reason: to.reason });
				if (from.status === 'ready' && to.status !== 'destroyed') acc.drops++;
				cw.last = null;
			}
			if (to.networking !== from.networking) attachNet(cw, to.networking);
			if (to.status === 'destroyed') unwatchConnection(conn);
		};
		conn.on('stateChange', cw.onState);
		attachNet(cw, conn.state && conn.state.networking);
	}

	function attachNet(cw, networking) {
		if (cw.net && cw.onNet) cw.net.off('stateChange', cw.onNet);
		cw.net = networking && typeof networking.on === 'function' ? networking : null;
		cw.onNet = null;
		if (!cw.net) return;
		cw.onNet = (from, to) => {
			if (from.code !== to.code) emit('net', { conn: cw.id, from: NET_CODES[from.code] || from.code, to: NET_CODES[to.code] || to.code });
			if (to.ws !== from.ws) attachWs(cw, to.ws);
		};
		cw.net.on('stateChange', cw.onNet);
		attachWs(cw, cw.net.state && cw.net.state.ws);
	}

	function attachWs(cw, ws) {
		if (ws === cw.ws) return;
		if (cw.ws && cw.onWsClose) cw.ws.off('close', cw.onWsClose);
		cw.ws = ws && typeof ws.on === 'function' ? ws : null;
		cw.onWsClose = null;
		if (!cw.ws) return;
		cw.onWsClose = (e) => emit('ws-close', { conn: cw.id, code: e && e.code });
		cw.ws.on('close', cw.onWsClose);
	}

	function unwatchConnection(conn) {
		const cw = conns.get(conn);
		if (!cw) return;
		conns.delete(conn);
		if (conn.dispatchAudio === cw.wrapper) {
			if (cw.hadOwn) conn.dispatchAudio = cw.original;
			else delete conn.dispatchAudio;
		}
		conn.off('stateChange', cw.onState);
		if (cw.net && cw.onNet) cw.net.off('stateChange', cw.onNet);
		if (cw.ws && cw.onWsClose) cw.ws.off('close', cw.onWsClose);
	}

	// ---- players ------------------------------------------------------------------------------

	function watchPlayer(player, meta = {}) {
		if (!on || !player || players.has(player) || typeof player.on !== 'function') return;
		if (players.size >= PLAYER_LIMIT) {
			for (const pw of players.values()) {
				if (players.size < PLAYER_LIMIT) break;
				if (!pw.player.state || pw.player.state.status === 'idle') dropPlayer(pw);
			}
		}
		const pw = {
			id: nextPlayerId++, player, kind: meta.kind || 'unknown',
			res: null, lastPd: 0, lastResPd: 0, under: 0, underRun: 0, gaps40: 0, maxGap: 0, lastPlayedMs: 0
		};
		players.set(player, pw);
		pw.onState = (from, to) => {
			resetSendClocks();
			pw.res = null;
			if (from.status !== to.status && (from.status === 'autopaused' || to.status === 'autopaused')) {
				emit('player', { player: pw.id, kind: pw.kind, from: from.status, to: to.status });
			}
			if (to.status === 'idle' && from.status !== 'idle') trackSummary(pw, from.resource ? from.resource.playbackDuration : pw.lastPlayedMs);
		};
		player.on('stateChange', pw.onState);
	}

	// One line per track (music) or per part (books, which keep one player for the whole session).
	function trackSummary(pw, playedMs) {
		endUnderrun(pw);
		if (playedMs > 0 || pw.gaps40 > 0 || pw.under > 0) {
			emit('track', { player: pw.id, kind: pw.kind, playedMs, underMs: pw.under, gaps40: pw.gaps40, maxGap: Math.round(pw.maxGap) });
		}
		pw.under = 0;
		pw.gaps40 = 0;
		pw.maxGap = 0;
		pw.lastPlayedMs = 0;
	}

	function dropPlayer(pw) {
		players.delete(pw.player);
		try { pw.player.off('stateChange', pw.onState); } catch (_) {}
	}

	function endUnderrun(pw) {
		if (pw.underRun >= o.underrunEventMs) emit('underrun', { player: pw.id, kind: pw.kind, ms: pw.underRun });
		pw.underRun = 0;
	}

	function samplePlayers() {
		for (const pw of [...players.values()]) {
			const player = pw.player;
			// runPlayback strips every listener from a player it replaces, ours included, so a
			// replaced track is only noticed here.
			if (typeof player.listeners === 'function' && !player.listeners('stateChange').includes(pw.onState)) {
				trackSummary(pw, pw.lastPlayedMs);
				dropPlayer(pw);
				continue;
			}
			const st = player.state;
			if (!st || st.status !== 'playing' || !st.resource) {
				pw.res = null;
				continue;
			}
			acc.playingS += o.tickMs / 1000;
			const res = st.resource;
			pw.lastPlayedMs = res.playbackDuration;
			if (pw.res !== res) {
				pw.res = res;
				pw.lastPd = st.playbackDuration;
				pw.lastResPd = res.playbackDuration;
				continue;
			}
			const dPlayer = st.playbackDuration - pw.lastPd;
			const dRes = res.playbackDuration - pw.lastResPd;
			pw.lastPd = st.playbackDuration;
			pw.lastResPd = res.playbackDuration;
			// The player counts every frame it sends, silence included; the resource counts only
			// real audio. silenceRemaining stays -1 until the stream ends, and the five padding
			// frames after that are not a starved source.
			const under = res.silenceRemaining === -1 ? Math.max(0, dPlayer - dRes) : 0;
			if (under > 0) {
				pw.under += under;
				pw.underRun += under;
				acc.underMs += under;
			} else if (pw.underRun > 0) {
				endUnderrun(pw);
			}
		}
	}

	function sampleConnections() {
		for (const cw of conns.values()) {
			// ping.udp is never assigned in @discordjs/voice 0.19; ws is one reading per heartbeat.
			const p = cw.conn.ping && cw.conn.ping.ws;
			if (typeof p === 'number' && p !== cw.lastPing) {
				acc.pings.push(p);
				cw.lastPing = p;
			}
		}
	}

	// ---- minutes ------------------------------------------------------------------------------

	function systemTimes() {
		let idle = 0;
		let total = 0;
		for (const c of probes.cpus()) {
			const t = c.times;
			idle += t.idle;
			total += t.user + t.nice + t.sys + t.idle + t.irq;
		}
		return { idle, total };
	}

	function buildRecord(now) {
		const span = Math.max(1, now - minuteStart);
		const cpu = probes.cpuUsage();
		const sys = systemTimes();
		const mem = probes.memoryUsage();
		const elu = probes.elu(lastElu);
		const ns = (v) => round1((Number.isFinite(v) ? v : 0) / 1e6);
		const pings = acc.pings;
		return {
			rec: {
				type: 'min',
				span: Math.round(span / 1000),
				pkts: acc.pkts,
				gaps: { ...acc.gaps },
				maxGap: Math.round(acc.maxGap),
				burst: acc.burst,
				playingS: Math.round(acc.playingS),
				underMs: acc.underMs,
				ping: pings.length ? { n: pings.length, min: Math.min(...pings), max: Math.max(...pings), last: pings[pings.length - 1] } : null,
				drops: acc.drops,
				el: { p50: ns(loopDelay.percentile(50)), p99: ns(loopDelay.percentile(99)), max: ns(loopDelay.max) },
				elu: Math.round(elu.utilization * 1000) / 1000,
				stallMax: Math.round(acc.stallMax),
				cpu: round1(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000 / span * 100),
				sys: sys.total > lastSys.total ? round1(100 * (1 - (sys.idle - lastSys.idle) / (sys.total - lastSys.total))) : null,
				rssMB: Math.round(mem.rss / MB),
				heapMB: Math.round(mem.heapUsed / MB),
				extMB: Math.round(mem.external / MB),
				abMB: Math.round((mem.arrayBuffers || 0) / MB),
				gc: { n: acc.gcN, maxMs: round1(acc.gcMax), totalMs: round1(acc.gcTotal) },
				events: acc.events,
				dropped: acc.dropped || undefined
			},
			cpu,
			sys
		};
	}

	function closeMinute(now) {
		const { rec, cpu, sys } = buildRecord(now);
		const active = rec.pkts > 0 || rec.events > 0 || rec.drops > 0 || rec.playingS > 0;
		loopDelay.reset();
		lastCpu = cpu;
		lastSys = sys;
		lastElu = probes.elu();
		minuteStart = now;
		acc = freshAcc();
		// Stamped with its start, so a mark at 12:00:40 reads against the 12:00 row.
		const at = minuteStartWall;
		minuteStartWall = o.wallNow();
		minutes.push({ t: new Date(at).toISOString(), at, active, ...rec });
		if (minutes.length > o.ringMinutes) minutes.shift();
		// An idle minute stays in memory for the command but costs no disk.
		if (active) pending.push({ t: new Date(at).toISOString(), ...rec });
		flush();
	}

	function tick() {
		const t0 = o.now();
		const drift = t0 - lastTick - o.tickMs;
		lastTick = t0;
		if (drift > acc.stallMax) acc.stallMax = drift;
		if (drift >= o.stallEventMs) emit('stall', { ms: Math.round(drift) });
		samplePlayers();
		sampleConnections();
		if (t0 - minuteStart >= o.minuteMs - o.tickMs / 2) closeMinute(t0);
		selfTime.ticks++;
		selfTime.tickMs += o.now() - t0;
	}

	// ---- switch -------------------------------------------------------------------------------

	function start() {
		acc = freshAcc();
		loopDelay = probes.loopDelay();
		stopGc = probes.observeGc((ms, kind) => {
			acc.gcN++;
			acc.gcTotal += ms;
			if (ms > acc.gcMax) acc.gcMax = ms;
			if (ms >= o.gcEventMs) emit('gc', { ms: Math.round(ms), kind });
		});
		lastTick = o.now();
		minuteStart = lastTick;
		minuteStartWall = o.wallNow();
		lastCpu = probes.cpuUsage();
		lastSys = systemTimes();
		lastElu = probes.elu();
		timer = o.setInterval(tick, o.tickMs);
		if (timer && typeof timer.unref === 'function') timer.unref();
		// Turned on mid-session: pick up the connection and player already playing, rather than
		// waiting for the next track to pass through the hooks.
		let existing = [];
		try { existing = o.listConnections() || []; } catch (_) {}
		for (const conn of existing) {
			watchConnection(conn, { adopted: true });
			const sub = conn.state && conn.state.subscription;
			if (sub && sub.player) watchPlayer(sub.player, { kind: 'adopted' });
		}
	}

	function stop() {
		if (timer) o.clearInterval(timer);
		timer = null;
		for (const conn of [...conns.keys()]) unwatchConnection(conn);
		for (const pw of [...players.values()]) dropPlayer(pw);
		try { if (loopDelay) loopDelay.disable(); } catch (_) {}
		try { if (stopGc) stopGc(); } catch (_) {}
		loopDelay = null;
		stopGc = null;
		flush();
	}

	function setEnabled(value) {
		const want = value === true;
		if (want === on) return on;
		on = want;
		if (on) start();
		else stop();
		return on;
	}

	// ---- for hooks and the command ------------------------------------------------------------

	function event(type, detail) {
		if (!on) return;
		emit(String(type), detail || {});
	}

	function mark(note, user) {
		if (!on) return false;
		emit('mark', { note: String(note || '').slice(0, 200), user: user || null });
		flush();
		return true;
	}

	function snapshot(lastMinutes = 15) {
		const since = o.wallNow() - lastMinutes * 60000;
		let current = null;
		if (on) {
			const { rec } = buildRecord(o.now());
			current = { t: new Date(minuteStartWall).toISOString(), at: minuteStartWall, partial: true, ...rec };
		}
		return {
			enabled: on,
			minutes: minutes.filter((m) => m.at >= since),
			current,
			events: events.filter((e) => Date.parse(e.t) >= since),
			live: { conns: conns.size, players: players.size }
		};
	}

	return {
		isEnabled: () => on,
		setEnabled,
		watchConnection,
		watchPlayer,
		event,
		mark,
		snapshot,
		flush,
		_tick: tick,
		_closeMinute: () => closeMinute(o.now()),
		_selfTime: selfTime,
		_watched: () => ({ conns: conns.size, players: players.size })
	};
}

const shared = createVoiceHealth();
let bound = false;

/** Follow config.voiceHealthEnabled now and whenever /config changes it. */
function bindToConfig(config, { store = require('./configStore.js'), logger = require('./logger.js') } = {}) {
	const apply = (value) => {
		const before = shared.isEnabled();
		const after = shared.setEnabled(value === true);
		if (before !== after) logger.info(`Voice health log ${after ? 'on' : 'off'}`);
	};
	apply(config.voiceHealthEnabled);
	if (!bound) {
		bound = true;
		store.onChange((key, value) => {
			if (key === 'voiceHealthEnabled') apply(value);
		});
	}
}

module.exports = {
	...shared,
	shared,
	bindToConfig,
	createVoiceHealth,
	GAP_THRESHOLDS,
	NET_CODES,
	VOICE_LOG
};
