// helpers/apMediaWatch.js
// Turns Plex history and live sessions of the linked Plex accounts into Plex Media credit events.
//
// History is read again over a 7-day window every poll, oldest first, and a row counts once by its
// historyKey. A high-water mark on viewedAt alone loses rows: Plexamp inserts offline plays up to
// 54 h late with their original viewedAt (measured on this server, most recently 2026-10-30). Rows
// without a ratingKey (deleted items) and rows dated before 2000 (seven bogus 1971-1984 rows exist)
// are marked seen without crediting anything.
//
// A poll's mark is written only after every event of that poll has resolved, so a crash between a
// credit and its mark repeats the credit (which the game dedupes) instead of losing it. An event
// whose handler fails is left unseen and comes back on the next poll, but only for MAX_ROW_TRIES
// polls in a row: a row that fails every time (one item Plex answers 500 for) would otherwise hold
// the read window back for good, so the window and the seen-set would grow without end.
//
// Sessions give the timesanity spans of a title someone is watching. Plex reports viewOffset only
// every so often, so a playing poll whose offset has not moved keeps the earlier wall time, and a
// forward step counts only while it fits the wall time that passed (2.5x plus 20 s), which a seek
// does not. A pause or a stall reports where playback stopped, so the step that ends on it counts
// when the poll before it was playing; between two polls that are not playing, a move is a scrub.
// The owner's session User.id may be their plex.tv id rather than local account 1, so an unknown id
// is matched by User.title against the /accounts names.

const contracts = require('./apMediaContracts.js');
const defaultLogger = require('./logger.js');

const WINDOW_S = 7 * 86400;
// 2000-01-01: anything older is a device with a broken clock, not a watch.
const MIN_VALID_S = 946684800;
const HISTORY_PAGE = 300;
const MAX_HISTORY_PAGES = 200;
// About 20 minutes at the default 2-minute poll: long enough to ride out Plex or the PC being busy.
const MAX_ROW_TRIES = 10;
const SPAN_FACTOR = 2.5;
const SPAN_SLACK_MS = 20000;
// A session step's padMs, for timesanity_strict: a session is seen only once a poll, so the first and
// last poll of play are never seen, at the step's own rate, and a client reports its offset late.
const PAD_LAG_MS = 10000;
const PAD_MAX_MS = 90000;
const ACCOUNTS_TTL_MS = 10 * 60 * 1000;
// An unknown session user forces a fresh /accounts read at most this often.
const ACCOUNTS_RETRY_MS = 60 * 1000;
const REACH_MAX = 5000;
// Node runs a timer set past 2^31 - 1 ms (about 24.8 days) after 1 ms instead, so a huge setting
// would poll Plex back to back.
const MAX_POLL_S = 86400;

const DEFAULT_TIMERS = {
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (h) => clearInterval(h),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h),
};

function unref(handle) {
	if (handle && typeof handle.unref === 'function') handle.unref();
	return handle;
}

function seconds(raw, spec) {
	const n = Math.floor(Number(raw));
	return Math.min(MAX_POLL_S, Math.max(spec.min, Number.isFinite(n) && n > 0 ? n : spec.default));
}

function historyKeyOf(row) {
	if (row.historyKey !== undefined && row.historyKey !== null && row.historyKey !== '') return String(row.historyKey);
	return `${row.accountID}|${row.ratingKey}|${row.viewedAt}`;
}

function ratingKeyOf(value) {
	if (value === undefined || value === null || value === '') return null;
	const rk = Number(value);
	return Number.isInteger(rk) && rk > 0 ? rk : null;
}

function readMark(raw) {
	const newest = Number(raw && raw.newestViewedAt);
	const seen = Array.isArray(raw && raw.seen) ? raw.seen.map(String) : [];
	return { newestViewedAt: Number.isFinite(newest) && newest > 0 ? newest : 0, seen: new Set(seen) };
}

function targetList(raw) {
	const byAccount = new Map();
	for (const t of Array.isArray(raw) ? raw : []) {
		const accountId = Number(t && t.accountId);
		const floorS = Number(t && t.floorS);
		if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isFinite(floorS) || floorS <= 0) continue;
		const was = byAccount.get(accountId);
		byAccount.set(accountId, { accountId, floorS: was ? Math.min(was.floorS, floorS) : floorS });
	}
	return [...byAccount.values()];
}

/**
 * @param {object} deps
 * @param {object} deps.pms helpers/apMediaPlex.js createPms() (history, sessions, accounts)
 * @param {() => Array<{accountId: number, floorS: number}>|Promise<...>} deps.targets the consented
 *   linked accounts with active bindings; floorS = the earliest generated_at among them
 * @param {(event: object) => any} deps.onEvent a CreditEvent; a returned promise is awaited
 * @param {{get: (accountId: number) => any, set: (accountId: number, mark: object) => any}} deps.marks
 *   {newestViewedAt, seen: [historyKey]} per account
 * @param {() => number} [deps.now] ms
 * @param {object} [deps.timers] setInterval/clearInterval/setTimeout/clearTimeout
 * @param {object|(() => object)} [deps.config] carries apMediaHistorySeconds and apMediaSessionSeconds,
 *   each held between its contracts.SETTINGS minimum and MAX_POLL_S (a day)
 * @param {object} [deps.logger]
 */
function createWatcher({ pms, targets, onEvent, marks, now = Date.now, timers = DEFAULT_TIMERS, config, logger = defaultLogger } = {}) {
	if (!pms || typeof pms.history !== 'function') throw new TypeError('createWatcher needs pms.');
	if (typeof targets !== 'function') throw new TypeError('createWatcher needs targets().');
	if (typeof onEvent !== 'function') throw new TypeError('createWatcher needs onEvent().');
	if (!marks || typeof marks.get !== 'function' || typeof marks.set !== 'function') throw new TypeError('createWatcher needs marks {get, set}.');

	let running = false;
	// Bumped by stop() so a poll still in flight delivers nothing more and writes no mark.
	let generation = 0;
	let historyTimer = null;
	let sessionTimer = null;
	let kickTimer = null;
	let historyMs = 0;
	let sessionMs = 0;
	let historyBusy = null;
	let historyBusyGen = -1;
	let sessionBusy = null;
	let sessionBusyGen = -1;
	// accountId -> Map(historyKey -> failed polls in a row). Kept in memory: a restart only buys a
	// failing row a few more tries, and once given up it is in the persisted seen-set.
	const rowFailures = new Map();
	const baselines = new Map();
	const reach = new Map();
	const latest = new Map();
	// accountId -> times forget() ran, so a pass that was reading the account when its last link went
	// writes back neither its mark nor its session sample.
	const forgotten = new Map();
	const epochOf = (accountId) => forgotten.get(accountId) || 0;
	const loggedPaths = new Set();
	let accountCache = { list: null, at: -Infinity };
	const health = {
		accounts: null,
		historyFailures: 0,
		lastHistoryAt: null,
		lastHistoryOkAt: null,
		lastHistoryError: null,
		sessionFailures: 0,
		lastSessionOkAt: null,
		lastSessionError: null,
	};

	function settings() {
		let c = config;
		if (typeof c === 'function') c = c();
		if (!c) c = require('../config/config.js');
		return {
			historyMs: seconds(c.apMediaHistorySeconds, contracts.SETTINGS.apMediaHistorySeconds) * 1000,
			sessionMs: seconds(c.apMediaSessionSeconds, contracts.SETTINGS.apMediaSessionSeconds) * 1000,
		};
	}

	async function readTargets() {
		try {
			return targetList(await targets());
		} catch (err) {
			logger.warn('Plex Media: could not list the linked Plex accounts:', (err && err.message) || err);
			return null;
		}
	}

	async function readHistory(accountId, since) {
		const rows = [];
		let start = 0;
		for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
			const { rows: got, total } = await pms.history({ accountId, since, start, size: HISTORY_PAGE });
			rows.push(...got);
			start += got.length;
			if (!got.length || start >= total) break;
		}
		return rows;
	}

	function eventOf(row, accountId, floorS) {
		const ratingKey = ratingKeyOf(row.ratingKey);
		if (ratingKey === null) return null;
		const viewedAt = Number(row.viewedAt);
		if (!Number.isFinite(viewedAt) || viewedAt < MIN_VALID_S || viewedAt < floorS) return null;
		// The accountID filter runs on the server; a row for anyone else is never credited here.
		if (row.accountID !== undefined && row.accountID !== null && Number(row.accountID) !== accountId) return null;
		const event = { type: 'complete', source: 'history', accountId, ratingKey, at: viewedAt * 1000 };
		if (row.librarySectionID !== undefined && row.librarySectionID !== null) event.librarySectionID = String(row.librarySectionID);
		return event;
	}

	async function pollAccount({ accountId, floorS }, gen) {
		const epoch = epochOf(accountId);
		const mark = readMark(await marks.get(accountId));
		const since = Math.max(floorS, mark.newestViewedAt - WINDOW_S);
		const rows = await readHistory(accountId, since);
		const nowS = Math.floor(now() / 1000);
		let newest = mark.newestViewedAt;
		let oldestFailed = Infinity;
		const kept = [];
		const failedBefore = rowFailures.get(accountId) || new Map();
		const failing = new Map();
		let credited = 0;
		for (const row of rows) {
			if (gen !== generation) return { credited, abandoned: true };
			const key = historyKeyOf(row);
			const viewedAt = Number(row.viewedAt);
			if (!mark.seen.has(key)) {
				const event = eventOf(row, accountId, floorS);
				if (event) {
					try {
						await onEvent(event);
						credited += 1;
					} catch (err) {
						const tries = (failedBefore.get(key) || 0) + 1;
						const why = (err && err.message) || err;
						if (tries < MAX_ROW_TRIES) {
							if (tries === 1) logger.warn(`Plex Media: the history credit of ratingKey ${event.ratingKey} for account ${accountId} failed; it is tried again on the next ${MAX_ROW_TRIES - 1} polls:`, why);
							failing.set(key, tries);
							oldestFailed = Math.min(oldestFailed, viewedAt);
							continue;
						}
						logger.warn(`Plex Media: gave up on the history credit of ratingKey ${event.ratingKey} for account ${accountId} after ${tries} failed polls (/apmedia check can credit it by hand):`, why);
					}
				}
			}
			kept.push([key, viewedAt]);
			// A device clock set in the future must not move the window past real rows.
			if (Number.isFinite(viewedAt) && viewedAt >= MIN_VALID_S) newest = Math.max(newest, Math.min(viewedAt, nowS));
		}
		if (gen !== generation || epochOf(accountId) !== epoch) return { credited, abandoned: true };
		if (failing.size) rowFailures.set(accountId, failing);
		else rowFailures.delete(accountId);
		// The window stays wide enough to read every failed row again next poll.
		newest = Math.min(newest, oldestFailed + WINDOW_S);
		const nextSince = Math.max(floorS, newest - WINDOW_S);
		const seen = kept.filter(([, viewedAt]) => !(viewedAt < nextSince)).map(([key]) => key);
		await marks.set(accountId, { newestViewedAt: newest, seen });
		return { credited, abandoned: false };
	}

	async function runHistory() {
		const gen = generation;
		const list = await readTargets();
		if (!list || gen !== generation) return;
		// With no account to read, the pass never asks Plex, so it is no read: it must neither report
		// "Plex history read 0m ago" nor clear the failures of the passes that did ask.
		if (!list.length) {
			health.accounts = 0;
			return;
		}
		let failed = null;
		for (const t of list) {
			if (gen !== generation) return;
			try {
				await pollAccount(t, gen);
			} catch (err) {
				failed = (err && err.message) || String(err);
				logger.warn(`Plex Media: could not read Plex history for account ${t.accountId}:`, failed);
			}
		}
		if (gen !== generation) return;
		health.accounts = list.length;
		health.lastHistoryAt = now();
		if (failed) {
			health.historyFailures += 1;
			health.lastHistoryError = failed;
		} else {
			health.historyFailures = 0;
			health.lastHistoryOkAt = health.lastHistoryAt;
			health.lastHistoryError = null;
		}
	}

	/** One history pass over every target account; never rejects, and a call while this run's pass is going returns that pass. */
	function pollHistory() {
		// A pass from before stop() gives up at its next step; waiting on it would leave a restarted
		// watcher reading nothing until its first interval.
		if (!historyBusy || historyBusyGen !== generation) {
			const pass = runHistory()
				.catch((err) => logger.warn('Plex Media: history poll failed:', (err && err.message) || err))
				.finally(() => { if (historyBusy === pass) historyBusy = null; });
			historyBusy = pass;
			historyBusyGen = generation;
		}
		return historyBusy;
	}

	/**
	 * A one-off history read from floorS for an account the poll already follows, for a binding that
	 * joins late. It ignores the seen-set, writes no mark, and hands events to `deliver` only.
	 * @returns {Promise<{rows: number, delivered: number}>}
	 */
	async function backfill({ accountId, floorS, deliver } = {}) {
		const account = Number(accountId);
		const floor = Number(floorS);
		if (!Number.isInteger(account) || account <= 0) throw new TypeError('backfill needs an accountId.');
		if (!Number.isFinite(floor) || floor <= 0) throw new TypeError('backfill needs floorS.');
		if (typeof deliver !== 'function') throw new TypeError('backfill needs deliver().');
		const rows = await readHistory(account, Math.max(floor, MIN_VALID_S));
		let delivered = 0;
		for (const row of rows) {
			const event = eventOf(row, account, floor);
			if (!event) continue;
			await deliver(event);
			delivered += 1;
		}
		return { rows: rows.length, delivered };
	}

	async function accountList(force) {
		const age = now() - accountCache.at;
		if (accountCache.list && (force ? age < ACCOUNTS_RETRY_MS : age < ACCOUNTS_TTL_MS)) return accountCache.list;
		try {
			const list = await pms.accounts();
			accountCache = { list: Array.isArray(list) ? list : [], at: now() };
		} catch (err) {
			if (!accountCache.list) throw err;
		}
		return accountCache.list;
	}

	function matchUser(list, user) {
		const id = Number(user && user.id);
		if (Number.isInteger(id) && list.some((a) => Number(a.id) === id)) return { accountId: id, path: 'User.id' };
		const title = String((user && user.title) || '').trim().toLowerCase();
		if (title) {
			const hit = list.find((a) => String(a.name || '').trim().toLowerCase() === title);
			if (hit) return { accountId: Number(hit.id), path: 'User.title' };
		}
		return null;
	}

	async function resolveAccount(user) {
		if (!user) return null;
		return matchUser(await accountList(false), user) || matchUser(await accountList(true), user);
	}

	function notePath(hit) {
		const tag = `${hit.accountId}|${hit.path}`;
		if (loggedPaths.has(tag)) return;
		loggedPaths.add(tag);
		logger.info(`Plex Media: Plex sessions of account ${hit.accountId} are matched by ${hit.path}.`);
	}

	function noteReach(accountId, ratingKey, offset, duration, at) {
		if (!(duration > 0)) return;
		const fraction = Math.min(1, Math.max(0, offset / duration));
		const key = `${accountId}|${ratingKey}`;
		const was = reach.get(key);
		reach.delete(key);
		reach.set(key, { fraction: was ? Math.max(was.fraction, fraction) : fraction, at });
		while (reach.size > REACH_MAX) reach.delete(reach.keys().next().value);
		latest.set(accountId, { ratingKey, fraction, at });
	}

	async function runSessions() {
		const gen = generation;
		const list = await readTargets();
		if (!list) return;
		const wanted = new Set(list.map((t) => t.accountId));
		if (!wanted.size) {
			baselines.clear();
			return;
		}
		const epochs = new Map(list.map((t) => [t.accountId, epochOf(t.accountId)]));
		// Everything that can fail runs before any baseline moves, so a failed poll keeps the state.
		const mine = [];
		try {
			const rows = await pms.sessions();
			for (const row of Array.isArray(rows) ? rows : []) {
				const ratingKey = ratingKeyOf(row && row.ratingKey);
				if (ratingKey === null) continue;
				const hit = await resolveAccount(row.User);
				if (!hit || !wanted.has(hit.accountId)) continue;
				notePath(hit);
				mine.push({ row, ratingKey, accountId: hit.accountId });
			}
		} catch (err) {
			health.sessionFailures += 1;
			health.lastSessionError = (err && err.message) || String(err);
			return;
		}
		if (gen !== generation) return;
		const at = now();
		const live = new Set();
		const spans = [];
		for (const { row, ratingKey, accountId } of mine) {
			if (epochOf(accountId) !== epochs.get(accountId)) continue;
			const session = (row.Session && row.Session.id) || row.sessionKey;
			const key = `${session}|${ratingKey}`;
			live.add(key);
			const offset = Number(row.viewOffset);
			if (!Number.isFinite(offset) || offset < 0) continue;
			noteReach(accountId, ratingKey, offset, Number(row.duration), at);
			const playing = !!(row.Player && row.Player.state === 'playing');
			const prev = baselines.get(key);
			if (!prev) {
				baselines.set(key, { offset, wall: at, playing });
				continue;
			}
			const dOffset = offset - prev.offset;
			if (playing && dOffset === 0) {
				prev.playing = true;
				continue;
			}
			// The baseline still resets at a poll that is not playing, so a pause's wall time never
			// widens the bound of the step after it.
			if ((playing || prev.playing) && dOffset > 0 && dOffset <= (at - prev.wall) * SPAN_FACTOR + SPAN_SLACK_MS) {
				const wall = at - prev.wall;
				const rate = wall > 0 ? dOffset / wall : 1;
				const padMs = Math.min(PAD_MAX_MS, Math.round((sessionMs || settings().sessionMs) * Math.max(1, rate) + PAD_LAG_MS));
				spans.push({ type: 'span', source: 'session', accountId, ratingKey, fromMs: prev.offset, toMs: offset, padMs, at });
			}
			baselines.set(key, { offset, wall: at, playing });
		}
		for (const key of [...baselines.keys()]) if (!live.has(key)) baselines.delete(key);
		health.sessionFailures = 0;
		health.lastSessionOkAt = at;
		health.lastSessionError = null;
		for (const event of spans) {
			if (gen !== generation) return;
			try {
				await onEvent(event);
			} catch (err) {
				logger.warn(`Plex Media: a session credit for account ${event.accountId} failed:`, (err && err.message) || err);
			}
		}
	}

	/** One sessions pass; never rejects, and a call while this run's pass is going returns that pass. */
	function pollSessions() {
		if (!sessionBusy || sessionBusyGen !== generation) {
			const pass = runSessions()
				.catch((err) => logger.warn('Plex Media: session poll failed:', (err && err.message) || err))
				.finally(() => { if (sessionBusy === pass) sessionBusy = null; });
			sessionBusy = pass;
			sessionBusyGen = generation;
		}
		return sessionBusy;
	}

	function arm() {
		const s = settings();
		historyMs = s.historyMs;
		sessionMs = s.sessionMs;
		historyTimer = unref(timers.setInterval(() => { pollHistory(); }, historyMs));
		sessionTimer = unref(timers.setInterval(() => { pollSessions(); }, sessionMs));
	}

	function disarm() {
		if (historyTimer) timers.clearInterval(historyTimer);
		if (sessionTimer) timers.clearInterval(sessionTimer);
		if (kickTimer) timers.clearTimeout(kickTimer);
		historyTimer = null;
		sessionTimer = null;
		kickTimer = null;
	}

	/** Starts both polls, plus one pass of each right away rather than a full interval later. */
	function start() {
		if (running) return;
		running = true;
		arm();
		kickTimer = unref(timers.setTimeout(() => {
			kickTimer = null;
			pollHistory();
			pollSessions();
		}, 0));
	}

	function stop() {
		if (!running) return;
		running = false;
		generation += 1;
		disarm();
		baselines.clear();
	}

	/** Picks up changed poll intervals; does nothing when stopped or when they are unchanged. */
	function rearm() {
		if (!running) return;
		const s = settings();
		if (s.historyMs === historyMs && s.sessionMs === sessionMs) return;
		if (historyTimer) timers.clearInterval(historyTimer);
		if (sessionTimer) timers.clearInterval(sessionTimer);
		arm();
	}

	/** The furthest fraction (0..1) of this title any session of the account has reached, or null. */
	function lastSeen(accountId, ratingKey) {
		const hit = reach.get(`${Number(accountId)}|${Number(ratingKey)}`);
		return hit ? hit.fraction : null;
	}

	/** The account's most recent session sample: {ratingKey, fraction, at}, or null. */
	function lastSession(accountId) {
		const hit = latest.get(Number(accountId));
		return hit ? { ...hit } : null;
	}

	/** Drops what is kept in memory for an account nobody links any more; a pass reading it now writes nothing back. */
	function forget(accountId) {
		const id = Number(accountId);
		if (!Number.isInteger(id) || id <= 0) return;
		forgotten.set(id, epochOf(id) + 1);
		latest.delete(id);
		rowFailures.delete(id);
		const prefix = `${id}|`;
		for (const key of [...reach.keys()]) if (key.startsWith(prefix)) reach.delete(key);
	}

	return {
		start,
		stop,
		rearm,
		pollHistory,
		pollSessions,
		backfill,
		lastSeen,
		lastSession,
		forget,
		/**
		 * `accounts` is how many linked accounts the last history pass read: 0 when none are linked,
		 * null before the first pass. The lastHistory* fields and historyFailures describe the last
		 * pass that had an account to read.
		 */
		health: () => ({ running, historySeconds: historyMs / 1000, sessionSeconds: sessionMs / 1000, ...health }),
		get running() { return running; },
	};
}

module.exports = {
	createWatcher,
	WINDOW_S,
	MIN_VALID_S,
	MAX_ROW_TRIES,
	MAX_POLL_S,
};
