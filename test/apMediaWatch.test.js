// helpers/apMediaWatch.js: Plex history and live sessions of the linked accounts turned into Plex
// Media credit events (spec 5.5).
//
// The history rules exist because of what this server does: Plexamp inserts offline plays up to
// 54 h late with their original viewedAt, 179 rows have no ratingKey, seven rows are dated
// 1971-1984, and ratingKey arrives as a string. A watermark on viewedAt alone loses the late rows
// for good, and a mark written before its credits are safe loses credits on a crash. The session
// rules decide when a viewOffset step is real playing time (a timesanity span) and when it is a
// seek, and which account a session belongs to when the owner shows up under their plex.tv id.
//
// Harness: a fake pms (history with server-side filters and paging, sessions, accounts), an
// in-memory marks store, a manual clock and recording fake timers. No network, no real timers.

const test = require('node:test');
const assert = require('node:assert');
const { createWatcher, WINDOW_S, MAX_ROW_TRIES, MAX_POLL_S } = require('../helpers/apMediaWatch.js');

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const DAY = 86400;
const FLOOR = NOW_S - 30 * DAY;

function row(id, ratingKey, viewedAt, accountID = 5, extra = {}) {
	const r = { historyKey: `/status/sessions/history/${id}`, viewedAt, accountID, librarySectionID: '3', type: 'movie', ...extra };
	if (ratingKey !== null) r.ratingKey = String(ratingKey);
	return r;
}

function fakePms() {
	const state = {
		rows: [],
		sessions: [],
		accounts: [{ id: 1, name: 'OwnerName' }, { id: 5, name: 'friend' }, { id: 7, name: 'stranger' }],
		historyCalls: [],
		accountsCalls: 0,
		fail: null,
		sessionsFail: null,
		ignoreSince: false,
		ignoreAccount: false,
		hold: null,
	};
	return {
		state,
		async history({ accountId, since, start = 0, size = 300 }) {
			state.historyCalls.push({ accountId, since, start, size });
			if (state.hold) await state.hold;
			if (state.fail) throw state.fail;
			const rows = state.rows
				.filter((r) => (state.ignoreAccount || accountId === undefined || Number(r.accountID) === accountId)
					&& (state.ignoreSince || since === undefined || r.viewedAt >= since))
				.sort((a, b) => a.viewedAt - b.viewedAt);
			return { rows: rows.slice(start, start + size), total: rows.length };
		},
		async sessions() {
			if (state.sessionsFail) throw state.sessionsFail;
			return state.sessions;
		},
		async accounts() {
			state.accountsCalls += 1;
			return state.accounts;
		},
	};
}

function memoryMarks(initial = {}) {
	const map = new Map(Object.entries(initial).map(([k, v]) => [Number(k), v]));
	const writes = [];
	return {
		map,
		writes,
		get: (id) => map.get(id),
		set: (id, mark) => {
			writes.push({ id, mark: JSON.parse(JSON.stringify(mark)) });
			map.set(id, mark);
		},
	};
}

function fakeTimers() {
	const t = { intervals: [], timeouts: [], cleared: [] };
	const handle = (kind, fn, ms) => {
		const h = { kind, fn, ms, unrefed: false, unref() { this.unrefed = true; } };
		t[kind === 'interval' ? 'intervals' : 'timeouts'].push(h);
		return h;
	};
	t.setInterval = (fn, ms) => handle('interval', fn, ms);
	t.setTimeout = (fn, ms) => handle('timeout', fn, ms);
	t.clearInterval = (h) => t.cleared.push(h);
	t.clearTimeout = (h) => t.cleared.push(h);
	return t;
}

function quietLogger() {
	const lines = [];
	const log = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
	return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

function setup(over = {}) {
	const pms = over.pms || fakePms();
	const marks = over.marks || memoryMarks();
	const events = [];
	const clock = { ms: NOW_MS };
	const logger = quietLogger();
	const timers = fakeTimers();
	const w = createWatcher({
		pms,
		targets: over.targets || (() => [{ accountId: 5, floorS: FLOOR }]),
		onEvent: over.onEvent || ((e) => { events.push(e); }),
		marks,
		now: () => clock.ms,
		timers,
		config: over.config || { apMediaHistorySeconds: 120, apMediaSessionSeconds: 15 },
		logger,
	});
	return { w, pms, marks, events, clock, logger, timers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a history poll credits each row once, oldest first, with numeric ids and ms times', async () => {
	const { w, pms, marks, events } = setup();
	pms.state.rows.push(row(11, 101, NOW_S - 3600), row(10, 102, NOW_S - 7200, 5, { librarySectionID: '4', type: 'episode' }));
	await w.pollHistory();
	assert.deepStrictEqual(events, [
		{ type: 'complete', source: 'history', accountId: 5, ratingKey: 102, librarySectionID: '4', at: (NOW_S - 7200) * 1000 },
		{ type: 'complete', source: 'history', accountId: 5, ratingKey: 101, librarySectionID: '3', at: (NOW_S - 3600) * 1000 },
	]);
	assert.deepStrictEqual(pms.state.historyCalls, [{ accountId: 5, since: FLOOR, start: 0, size: 300 }], 'a fresh account reads from its floor');
	assert.deepStrictEqual(marks.map.get(5), { newestViewedAt: NOW_S - 3600, seen: ['/status/sessions/history/10', '/status/sessions/history/11'] });

	await w.pollHistory();
	assert.strictEqual(events.length, 2, 'seen rows are not credited again');
	assert.strictEqual(pms.state.historyCalls[1].since, NOW_S - 3600 - WINDOW_S, 'later polls read a 7-day window back from the newest row');
});

test('a row Plex inserts late with an older viewedAt is still credited (Plexamp offline plays)', async () => {
	const { w, pms, events } = setup();
	pms.state.rows.push(row(20, 201, NOW_S - 100));
	await w.pollHistory();
	pms.state.rows.push(row(21, 202, NOW_S - 2 * DAY));
	await w.pollHistory();
	await w.pollHistory();
	assert.deepStrictEqual(events.map((e) => e.ratingKey), [201, 202]);
});

test('the seen-set is pruned to the next window', async () => {
	const { w, pms, marks, events } = setup();
	pms.state.rows.push(row(30, 301, NOW_S - 10 * DAY), row(31, 302, NOW_S - 3600));
	await w.pollHistory();
	assert.deepStrictEqual(marks.map.get(5).seen, ['/status/sessions/history/31']);
	await w.pollHistory();
	assert.deepStrictEqual(events.map((e) => e.ratingKey), [301, 302]);
});

test('rows without a ratingKey, before the floor or before 2000 are marked seen and credit nothing', async () => {
	const { w, pms, marks, events } = setup();
	pms.state.ignoreSince = true;
	pms.state.rows.push(
		row(40, null, NOW_S - 50),
		row(41, 401, 400000000),
		row(42, 402, FLOOR - 10),
		row(43, '', NOW_S - 40),
		row(44, 404, NOW_S - 30),
	);
	await w.pollHistory();
	assert.deepStrictEqual(events.map((e) => e.ratingKey), [404]);
	const seen = marks.map.get(5).seen;
	assert.ok(seen.includes('/status/sessions/history/40'));
	assert.ok(seen.includes('/status/sessions/history/43'));
	assert.strictEqual(marks.map.get(5).newestViewedAt, NOW_S - 30, 'a 1982 row never moves the window');
	await w.pollHistory();
	assert.strictEqual(events.length, 1);
});

test('a row for another account is never credited, even if the server ignored the filter', async () => {
	const { w, pms, events } = setup();
	pms.state.ignoreAccount = true;
	pms.state.rows.push(row(50, 501, NOW_S - 60, 7), row(51, 502, NOW_S - 50, 5));
	await w.pollHistory();
	assert.deepStrictEqual(events.map((e) => [e.accountId, e.ratingKey]), [[5, 502]]);
});

test('a future-dated row does not push the window past real rows', async () => {
	const { w, pms, marks, events } = setup();
	pms.state.rows.push(row(55, 551, NOW_S + 365 * DAY));
	await w.pollHistory();
	assert.strictEqual(marks.map.get(5).newestViewedAt, NOW_S);
	pms.state.rows.push(row(56, 552, NOW_S - 3 * DAY));
	await w.pollHistory();
	assert.deepStrictEqual(events.map((e) => e.ratingKey), [551, 552]);
});

test('history is read in pages of 300', async () => {
	const { w, pms, events } = setup();
	for (let i = 0; i < 650; i++) pms.state.rows.push(row(1000 + i, 5000 + i, NOW_S - 650 + i));
	await w.pollHistory();
	assert.deepStrictEqual(pms.state.historyCalls.map((c) => c.start), [0, 300, 600]);
	assert.strictEqual(events.length, 650);
	assert.strictEqual(new Set(events.map((e) => e.ratingKey)).size, 650);
});

test('the mark is written only after every event of the poll has resolved', async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const delivered = [];
	const { w, pms, marks } = setup({ onEvent: async (e) => { delivered.push(e.ratingKey); await gate; } });
	pms.state.rows.push(row(60, 601, NOW_S - 20), row(61, 602, NOW_S - 10));
	const poll = w.pollHistory();
	for (let i = 0; i < 5; i++) await tick();
	assert.deepStrictEqual(delivered, [601]);
	assert.strictEqual(marks.writes.length, 0);
	release();
	await poll;
	assert.deepStrictEqual(delivered, [601, 602]);
	assert.strictEqual(marks.writes.length, 1);
});

test('an event whose handler fails stays unseen and comes back on the next poll', async () => {
	const tries = new Map();
	const credited = [];
	const { w, pms, marks } = setup({
		onEvent: (e) => {
			const n = (tries.get(e.ratingKey) || 0) + 1;
			tries.set(e.ratingKey, n);
			if (e.ratingKey === 702 && n === 1) throw new Error('store write failed');
			credited.push(e.ratingKey);
		},
	});
	pms.state.rows.push(row(70, 701, NOW_S - 30), row(71, 702, NOW_S - 20), row(72, 703, NOW_S - 10));
	await w.pollHistory();
	assert.deepStrictEqual(credited, [701, 703]);
	assert.ok(!marks.map.get(5).seen.includes('/status/sessions/history/71'));
	await w.pollHistory();
	await w.pollHistory();
	assert.deepStrictEqual(credited, [701, 703, 702]);
});

test('a failed credit more than 7 days older than the newest row is still read again', async () => {
	let failOnce = true;
	const credited = [];
	const { w, pms, marks } = setup({
		onEvent: (e) => {
			if (e.ratingKey === 751 && failOnce) {
				failOnce = false;
				throw new Error('store write failed');
			}
			credited.push(e.ratingKey);
		},
	});
	pms.state.rows.push(row(75, 751, NOW_S - 10 * DAY), row(76, 752, NOW_S - 3600));
	await w.pollHistory();
	assert.deepStrictEqual(credited, [752]);
	assert.strictEqual(marks.map.get(5).newestViewedAt, NOW_S - 3 * DAY, 'held back so the failed row stays in the window');
	await w.pollHistory();
	assert.deepStrictEqual(credited, [752, 751]);
	assert.strictEqual(marks.map.get(5).newestViewedAt, NOW_S - 3600);
	await w.pollHistory();
	assert.strictEqual(credited.length, 2);
});

test('a row whose credit fails on every poll is given up after MAX_ROW_TRIES polls, with one warning before and one after', async () => {
	const tries = new Map();
	const credited = [];
	const { w, pms, marks, logger } = setup({
		onEvent: (e) => {
			if (e.ratingKey === 666 || e.ratingKey === 667) {
				tries.set(e.ratingKey, (tries.get(e.ratingKey) || 0) + 1);
				throw new Error('handler bug for this row');
			}
			credited.push(e.ratingKey);
		},
	});
	pms.state.rows.push(row(97, 666, NOW_S - 10 * DAY), row(98, 667, NOW_S - 600), row(99, 981, NOW_S - 3600));
	for (let i = 1; i < MAX_ROW_TRIES; i++) await w.pollHistory();
	assert.deepStrictEqual([...tries.values()], [MAX_ROW_TRIES - 1, MAX_ROW_TRIES - 1]);
	assert.strictEqual(marks.map.get(5).newestViewedAt, NOW_S - 3 * DAY, 'held back while the old row is retried');
	assert.ok(!marks.map.get(5).seen.includes('/status/sessions/history/98'));

	await w.pollHistory();
	const mark = marks.map.get(5);
	assert.strictEqual(mark.newestViewedAt, NOW_S - 600, 'the window moves on');
	assert.ok(mark.seen.includes('/status/sessions/history/98'), 'a given-up row inside the window is seen');
	await w.pollHistory();
	await w.pollHistory();
	assert.deepStrictEqual([...tries.values()], [MAX_ROW_TRIES, MAX_ROW_TRIES], 'neither is tried again');
	assert.deepStrictEqual(credited, [981]);
	assert.strictEqual(w.health().historyFailures, 0, 'a failing credit is not a failing Plex read');

	const warnings = logger.lines.filter((l) => l.startsWith('warn '));
	assert.strictEqual(warnings.length, 4);
	assert.match(warnings[0], /ratingKey 666 for account 5 failed; it is tried again/);
	assert.match(warnings[1], /ratingKey 667 for account 5 failed; it is tried again/);
	assert.match(warnings[2], new RegExp(`gave up on the history credit of ratingKey 666 for account 5 after ${MAX_ROW_TRIES} failed polls.*handler bug`));
	assert.match(warnings[3], /gave up on the history credit of ratingKey 667/);
});

test('a failed history read writes no mark and counts toward health until a poll succeeds', async () => {
	const { w, pms, marks } = setup();
	pms.state.rows.push(row(80, 801, NOW_S - 10));
	pms.state.fail = new Error('Plex at localhost:32400 could not be reached for /status/sessions/history/all: ECONNREFUSED.');
	await w.pollHistory();
	await w.pollHistory();
	assert.strictEqual(marks.writes.length, 0);
	assert.strictEqual(w.health().historyFailures, 2);
	assert.match(w.health().lastHistoryError, /ECONNREFUSED/);
	assert.strictEqual(w.health().lastHistoryOkAt, null);
	pms.state.fail = null;
	await w.pollHistory();
	assert.strictEqual(w.health().historyFailures, 0);
	assert.strictEqual(w.health().lastHistoryOkAt, NOW_MS);
	assert.strictEqual(marks.writes.length, 1);
});

test('a history pass with no linked account is no read: health says how many accounts were read instead', async () => {
	let list = [];
	const { w, pms, clock } = setup({ targets: () => list });
	const history = () => {
		const h = w.health();
		return [h.accounts, h.historyFailures, h.lastHistoryAt, h.lastHistoryOkAt, h.lastHistoryError];
	};
	assert.deepStrictEqual(history(), [null, 0, null, null, null], 'no pass yet');
	await w.pollHistory();
	assert.strictEqual(pms.state.historyCalls.length, 0);
	assert.deepStrictEqual(history(), [0, 0, null, null, null], 'nothing was read, so nothing says Plex was');

	list = [{ accountId: 5, floorS: FLOOR }];
	pms.state.fail = new Error('Plex at localhost:32400 could not be reached for /status/sessions/history/all: ECONNREFUSED.');
	await w.pollHistory();
	const down = pms.state.fail.message;
	assert.deepStrictEqual(history(), [1, 1, NOW_MS, null, down]);

	list = [];
	clock.ms += 60000;
	await w.pollHistory();
	assert.deepStrictEqual(history(), [0, 1, NOW_MS, null, down], 'an empty pass neither clears the failure nor counts as a read');

	list = [{ accountId: 5, floorS: FLOOR }, { accountId: 7, floorS: FLOOR }];
	pms.state.fail = null;
	await w.pollHistory();
	assert.deepStrictEqual(history(), [2, 0, NOW_MS + 60000, NOW_MS + 60000, null]);
});

test('a poll interval set past a day is cut to a day: Node fires a timer set past 2^31 - 1 ms at once', () => {
	const { w, timers } = setup({ config: { apMediaHistorySeconds: 3000000, apMediaSessionSeconds: 1e12 } });
	w.start();
	assert.deepStrictEqual(timers.intervals.map((h) => h.ms), [86400000, 86400000]);
	assert.deepStrictEqual([w.health().historySeconds, w.health().sessionSeconds], [86400, 86400]);
	assert.strictEqual(MAX_POLL_S, 86400);
	w.stop();
});

test('targets: one read per account from its earliest floor; bad targets are skipped', async () => {
	const { w, pms } = setup({
		targets: async () => [
			{ accountId: 5, floorS: FLOOR },
			{ accountId: '5', floorS: FLOOR - 1000 },
			{ accountId: 0, floorS: FLOOR },
			{ accountId: 9, floorS: null },
		],
	});
	await w.pollHistory();
	assert.deepStrictEqual(pms.state.historyCalls.map((c) => [c.accountId, c.since]), [[5, FLOOR - 1000]]);
});

test('backfill reads from the floor, ignores the seen-set and marks, and feeds only deliver', async () => {
	const { w, pms, marks, events } = setup();
	pms.state.rows.push(row(90, 901, NOW_S - 5 * DAY), row(91, 902, NOW_S - 60));
	await w.pollHistory();
	const writes = marks.writes.length;
	pms.state.ignoreSince = true;
	pms.state.rows.push(row(92, 903, FLOOR - 100));
	const delivered = [];
	const out = await w.backfill({ accountId: 5, floorS: FLOOR, deliver: async (e) => { delivered.push(e); } });
	assert.deepStrictEqual(out, { rows: 3, delivered: 2 });
	assert.deepStrictEqual(delivered.map((e) => e.ratingKey), [901, 902]);
	assert.strictEqual(events.length, 2, 'onEvent saw only the regular poll');
	assert.strictEqual(marks.writes.length, writes);
	assert.strictEqual(pms.state.historyCalls[pms.state.historyCalls.length - 1].since, FLOOR);
	await assert.rejects(w.backfill({ accountId: 5, floorS: FLOOR }), /deliver/);
	await assert.rejects(w.backfill({ accountId: null, floorS: FLOOR, deliver() {} }), /accountId/);
});

test('stopping mid-poll delivers nothing more and writes no mark', async () => {
	let w;
	const delivered = [];
	const ctx = setup({ onEvent: (e) => { delivered.push(e.ratingKey); w.stop(); } });
	w = ctx.w;
	ctx.pms.state.rows.push(row(95, 951, NOW_S - 20), row(96, 952, NOW_S - 10));
	w.start();
	await w.pollHistory();
	assert.deepStrictEqual(delivered, [951]);
	assert.strictEqual(ctx.marks.writes.length, 0);
});

// id null leaves the Session object out, as a server that sends only sessionKey would.
function session({ user = { id: '5', title: 'friend' }, rk = '777', offset, duration = 6000000, state = 'playing', id = 'sess-1', key = '12' }) {
	const s = { ratingKey: rk, viewOffset: offset, duration, User: user, Player: { state }, sessionKey: key };
	if (id !== null) s.Session = { id };
	return s;
}

test('sessions: a forward step that fits the wall time is a span; a still offset keeps the old wall', async () => {
	const { w, pms, events, clock } = setup();
	const at = (s, offset, state = 'playing') => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, state })];
		return w.pollSessions();
	};
	await at(0, 60000);
	assert.deepStrictEqual(events, [], 'first sight only sets the baseline');
	await at(15, 75000);
	assert.deepStrictEqual(events, [{ type: 'span', source: 'session', accountId: 5, ratingKey: 777, fromMs: 60000, toMs: 75000, at: NOW_MS + 15000 }]);
	await at(30, 75000);
	assert.strictEqual(events.length, 1);
	await at(75, 225000);
	assert.deepStrictEqual(events.slice(1).map((e) => [e.fromMs, e.toMs]), [[75000, 225000]], 'fits 60 s of wall time (the kept one), not the 45 s since the still poll');
});

test('sessions: a step of exactly 2.5x the wall time plus 20 s is a span; 1 ms more is a seek', async () => {
	const { w, pms, events, clock } = setup();
	const poll = (s, a, b) => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ id: 'a', offset: a }), session({ id: 'b', offset: b })];
		return w.pollSessions();
	};
	await poll(0, 60000, 60000);
	await poll(15, 60000 + 57500, 60000 + 57501);
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[60000, 117500]]);
});

test('sessions: without a Session object, sessionKey keeps two devices on one title apart', async () => {
	const { w, pms, events, clock } = setup();
	const poll = (s, a, b) => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ id: null, key: '11', offset: a }), session({ id: null, key: '12', offset: b })];
		return w.pollSessions();
	};
	await poll(0, 60000, 1000000);
	await poll(15, 75000, 1015000);
	assert.deepStrictEqual(events.map((e) => [e.accountId, e.ratingKey, e.fromMs, e.toMs]), [[5, 777, 60000, 75000], [5, 777, 1000000, 1015000]]);
});

// The bug: a poll that found the title paused reset the baseline without the stretch played since
// the poll before, so a checkpoint passed in the last few seconds before a pause was never earned.
test('sessions: a pause counts the step it ends after a playing poll; a seek, a backward jump and a step between two stopped polls do not', async () => {
	const { w, pms, events, clock } = setup();
	const at = (s, offset, state = 'playing') => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, state })];
		return w.pollSessions();
	};
	await at(0, 60000);
	await at(15, 1000000);
	assert.deepStrictEqual(events, [], 'a seek');
	await at(30, 1010000, 'paused');
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[1000000, 1010000]], 'played until the pause');
	await at(45, 1012000, 'buffering');
	assert.strictEqual(events.length, 1, 'paused, then buffering further on: a scrub, not playing');
	await at(60, 1025000);
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[1000000, 1010000], [1012000, 1025000]]);
	await at(75, 900000);
	assert.strictEqual(events.length, 2, 'a backward jump is not a span');
});

test('sessions: a pause 12 s past a checkpoint still earns it', async () => {
	const { w, pms, events, clock } = setup();
	const at = (s, offset, state = 'playing') => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, state })];
		return w.pollSessions();
	};
	// 15:00 is 900000 ms.
	await at(0, 890000);
	await at(15, 902000, 'paused');
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[890000, 902000]]);
	await at(30, 902000, 'paused');
	await at(45, 917000);
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[890000, 902000], [902000, 917000]], 'and playing on goes on from where it paused');
});

test('sessions: a move between two polls that are not playing is a scrub', async () => {
	const { w, pms, events, clock } = setup();
	const at = (s, offset, state) => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, state })];
		return w.pollSessions();
	};
	await at(0, 880000, 'paused');
	await at(15, 920000, 'paused');
	await at(30, 925000, 'buffering');
	await at(45, 930000, 'paused');
	assert.deepStrictEqual(events, []);
});

test('sessions: a playing poll whose offset had not moved, then a pause, counts from the kept wall', async () => {
	const { w, pms, events, clock } = setup();
	const at = (s, offset, state = 'playing') => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, state })];
		return w.pollSessions();
	};
	await at(0, 880000);
	await at(15, 880000);
	await at(30, 905000, 'paused');
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[880000, 905000]], '25 s played in 30 s of wall time');

	const first = setup();
	const at2 = (s, offset, state = 'playing') => {
		first.clock.ms = NOW_MS + s * 1000;
		first.pms.state.sessions = [session({ offset, state })];
		return first.w.pollSessions();
	};
	await at2(0, 880000, 'paused');
	await at2(15, 880000);
	await at2(30, 905000, 'paused');
	assert.deepStrictEqual(first.events.map((e) => [e.fromMs, e.toMs]), [[880000, 905000]], 'a resume Plex had not reported yet, then a pause');
});

test('sessions: a vanished session is forgotten; a failed read keeps the state', async () => {
	const { w, pms, events, clock } = setup();
	clock.ms = NOW_MS;
	pms.state.sessions = [session({ offset: 60000 })];
	await w.pollSessions();
	clock.ms += 15000;
	pms.state.sessionsFail = new Error('Plex answered HTTP 500 for /status/sessions.');
	await w.pollSessions();
	assert.strictEqual(w.health().sessionFailures, 1);
	pms.state.sessionsFail = null;
	clock.ms += 15000;
	pms.state.sessions = [session({ offset: 90000 })];
	await w.pollSessions();
	assert.deepStrictEqual(events.map((e) => [e.fromMs, e.toMs]), [[60000, 90000]]);
	assert.strictEqual(w.health().sessionFailures, 0);

	clock.ms += 15000;
	pms.state.sessions = [];
	await w.pollSessions();
	clock.ms += 15000;
	pms.state.sessions = [session({ offset: 120000 })];
	await w.pollSessions();
	assert.strictEqual(events.length, 1, 'after vanishing, the next sight is a first sight');
});

test('sessions: accounts resolve by User.id, else by User.title; others are ignored; the path is logged once', async () => {
	const { w, pms, events, clock, logger } = setup({ targets: () => [{ accountId: 5, floorS: FLOOR }, { accountId: 1, floorS: FLOOR }] });
	const owner = { id: '12345678', title: 'ownername' };
	const stranger = { id: '7', title: 'stranger' };
	const poll = (s, offset) => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [
			session({ user: owner, rk: '10', offset, id: 'a' }),
			session({ user: { id: '5', title: 'friend' }, rk: '20', offset, id: 'b' }),
			session({ user: stranger, rk: '30', offset, id: 'c' }),
		];
		return w.pollSessions();
	};
	await poll(0, 1000);
	await poll(15, 11000);
	await poll(30, 21000);
	assert.deepStrictEqual(events.map((e) => [e.accountId, e.ratingKey]), [[1, 10], [5, 20], [1, 10], [5, 20]]);
	const pathLines = logger.lines.filter((l) => /matched by/.test(l));
	assert.deepStrictEqual(pathLines, [
		'info Plex Media: Plex sessions of account 1 are matched by User.title.',
		'info Plex Media: Plex sessions of account 5 are matched by User.id.',
	]);
	assert.strictEqual(w.lastSeen(7, 30), null, 'nothing is kept for an account nobody bound');
});

test('sessions: with no linked account Plex is not asked at all', async () => {
	let asked = 0;
	const pms = fakePms();
	pms.sessions = async () => { asked += 1; return []; };
	const { w } = setup({ pms, targets: () => [] });
	await w.pollSessions();
	assert.strictEqual(asked, 0);
});

test('lastSeen keeps the furthest fraction reached; lastSession the latest sample', async () => {
	const { w, pms, clock } = setup();
	const at = (s, offset) => {
		clock.ms = NOW_MS + s * 1000;
		pms.state.sessions = [session({ offset, duration: 1000000 })];
		return w.pollSessions();
	};
	await at(0, 100000);
	await at(15, 870000);
	await at(30, 300000);
	assert.strictEqual(w.lastSeen(5, 777), 0.87);
	assert.strictEqual(w.lastSeen('5', '777'), 0.87);
	assert.deepStrictEqual(w.lastSession(5), { ratingKey: 777, fraction: 0.3, at: NOW_MS + 30000 });
	assert.strictEqual(w.lastSeen(5, 1), null);
});

// The bug: an account's last session sample outlived its last link, and a history pass that was
// reading the account when the link went wrote its mark back after the game had dropped it.
test('forget drops an account\'s session samples, and a pass still reading it writes nothing back', async () => {
	const ctx = setup({ targets: () => [{ accountId: 5, floorS: FLOOR }, { accountId: 1, floorS: FLOOR }] });
	const { w, pms, clock, marks } = ctx;
	clock.ms = NOW_MS;
	pms.state.sessions = [session({ offset: 100000, duration: 1000000 }), session({ user: { id: '1', title: 'OwnerName' }, rk: '888', offset: 5000, id: 'o' })];
	await w.pollSessions();
	w.forget(5);
	assert.strictEqual(w.lastSession(5), null);
	assert.strictEqual(w.lastSeen(5, 777), null);
	assert.deepStrictEqual(w.lastSession(1), { ratingKey: 888, fraction: 5000 / 6000000, at: NOW_MS }, 'another account keeps its own');
	w.forget('nope');

	pms.state.rows.push(row(1, 101, NOW_S - 10), row(2, 102, NOW_S - 5, 1));
	let release;
	pms.state.hold = new Promise((resolve) => { release = resolve; });
	const pass = w.pollHistory();
	await tick();
	w.forget(5);
	release();
	pms.state.hold = null;
	await pass;
	assert.deepStrictEqual(marks.writes.map((m) => m.id), [1], 'only the account still linked gets its mark');
	await w.pollHistory();
	assert.deepStrictEqual(marks.writes.map((m) => m.id), [1, 5, 1], 'a later pass, once it is linked again, reads it afresh');
});

test('a sessions pass still reading Plex when forget runs writes back no sample and no span for that account', async () => {
	const ctx = setup({ targets: () => [{ accountId: 5, floorS: FLOOR }, { accountId: 1, floorS: FLOOR }] });
	const { w, pms, clock, events } = ctx;
	const owner = (offset) => session({ user: { id: '1', title: 'OwnerName' }, rk: '888', offset, id: 'o' });
	clock.ms = NOW_MS;
	pms.state.sessions = [session({ offset: 100000 }), owner(5000)];
	await w.pollSessions();

	const read = pms.sessions;
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	pms.sessions = async () => { await held; return read(); };
	clock.ms = NOW_MS + 15000;
	pms.state.sessions = [session({ offset: 115000 }), owner(20000)];
	const pass = w.pollSessions();
	await tick();
	w.forget(5);
	release();
	await pass;

	assert.strictEqual(w.lastSession(5), null, 'no sample written back');
	assert.strictEqual(w.lastSeen(5, 777), null);
	assert.deepStrictEqual(events.map((e) => [e.accountId, e.fromMs, e.toMs]), [[1, 5000, 20000]], 'only the account still linked is credited');
});

test('start arms both polls at the configured seconds (never under the minimums), unref-ed, plus one immediate pass', async () => {
	const { w, timers, pms } = setup({ config: { apMediaHistorySeconds: 10, apMediaSessionSeconds: 2 } });
	w.start();
	w.start();
	assert.deepStrictEqual(timers.intervals.map((h) => h.ms), [30000, 5000]);
	assert.ok(timers.intervals.every((h) => h.unrefed));
	assert.strictEqual(timers.timeouts.length, 1);
	assert.ok(timers.timeouts[0].unrefed);
	assert.strictEqual(w.running, true);
	assert.deepStrictEqual([w.health().historySeconds, w.health().sessionSeconds], [30, 5]);

	timers.timeouts[0].fn();
	for (let i = 0; i < 5; i++) await tick();
	assert.strictEqual(pms.state.historyCalls.length, 1);

	w.stop();
	w.stop();
	assert.deepStrictEqual(timers.cleared, timers.intervals, 'the fired one-off pass has nothing left to clear');
	assert.strictEqual(w.running, false);

	w.start();
	w.stop();
	assert.deepStrictEqual(timers.cleared.slice(2), [...timers.intervals.slice(2), timers.timeouts[1]], 'a pending first pass is cancelled too');
});

test('without the interval settings the polls run every 120 s and 15 s', () => {
	const { w, timers } = setup({ config: {} });
	w.start();
	assert.deepStrictEqual(timers.intervals.map((h) => h.ms), [120000, 15000]);
	assert.deepStrictEqual([w.health().historySeconds, w.health().sessionSeconds], [120, 15]);
	w.stop();
});

test('a stop and start while a pass is still reading Plex lets the restarted watcher read at once', async () => {
	let releaseHistory;
	let releaseSessions;
	const pms = fakePms();
	pms.state.hold = new Promise((resolve) => { releaseHistory = resolve; });
	const sessionsHeld = new Promise((resolve) => { releaseSessions = resolve; });
	let sessionReads = 0;
	pms.sessions = async () => {
		sessionReads += 1;
		await sessionsHeld;
		return [];
	};
	const { w, events, marks, timers } = setup({ pms });
	pms.state.rows.push(row(85, 851, NOW_S - 10));
	w.start();
	timers.timeouts[0].fn();
	for (let i = 0; i < 5; i++) await tick();
	w.stop();
	w.start();
	timers.timeouts[1].fn();
	for (let i = 0; i < 5; i++) await tick();
	assert.strictEqual(pms.state.historyCalls.length, 2, 'the new pass does not wait on the stopped one');
	assert.strictEqual(sessionReads, 2);

	releaseHistory();
	releaseSessions();
	for (let i = 0; i < 10; i++) await tick();
	assert.deepStrictEqual(events.map((e) => e.ratingKey), [851], 'only the new pass credits');
	assert.strictEqual(marks.writes.length, 1);
	assert.strictEqual(w.health().lastSessionOkAt, NOW_MS);
	assert.strictEqual(w.health().lastHistoryOkAt, NOW_MS);
	w.stop();
});

test('rearm picks up changed intervals only while running, and only when they changed', () => {
	const config = { apMediaHistorySeconds: 120, apMediaSessionSeconds: 15 };
	const { w, timers } = setup({ config: () => config });
	w.rearm();
	assert.strictEqual(timers.intervals.length, 0);
	w.start();
	w.rearm();
	assert.strictEqual(timers.intervals.length, 2);
	config.apMediaHistorySeconds = 300;
	w.rearm();
	assert.deepStrictEqual(timers.intervals.map((h) => h.ms), [120000, 15000, 300000, 15000]);
	assert.strictEqual(timers.cleared.length, 2);
	w.rearm();
	assert.strictEqual(timers.intervals.length, 4);
});

test('a poll still running is not started twice', async () => {
	let release;
	const pms = fakePms();
	pms.state.hold = new Promise((resolve) => { release = resolve; });
	const { w } = setup({ pms });
	const a = w.pollHistory();
	const b = w.pollHistory();
	assert.strictEqual(a, b);
	release();
	await a;
	assert.strictEqual(pms.state.historyCalls.length, 1);
});

test('createWatcher refuses missing dependencies', () => {
	assert.throws(() => createWatcher({}), /pms/);
	assert.throws(() => createWatcher({ pms: fakePms() }), /targets/);
	assert.throws(() => createWatcher({ pms: fakePms(), targets: () => [] }), /onEvent/);
	assert.throws(() => createWatcher({ pms: fakePms(), targets: () => [], onEvent() {} }), /marks/);
});
