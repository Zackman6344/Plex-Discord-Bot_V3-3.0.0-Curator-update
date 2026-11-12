// helpers/apMediaBooks.js
// Turns audiobooks the bot plays in voice into Plex Media credit events.
//
// The bot's audiobook player never reaches Plex history either, so this reads the book engine and
// the bookmarks directly, and gives the engine nothing to call back into.
//
// Spans: every 10 s while any book session exists, how far each playing session moved in work
// time. A step counts only while it fits the wall time that passed at the session's speed (1.5x
// plus 5 s), which a seek or a /book goto does not; a speed change inside a step played part of it
// at each speed, so the faster one bounds it. Every poll that finds a session not playing drops its
// baseline: a jump made while paused, read after a long pause, would otherwise fit a bound
// stretched by all that wall time and count as listening. A playing poll that has not moved
// (buffering) restarts the baseline too, for the same reason.
//
// The engine's notifications are measured where they happen, because polls alone lose up to 10 s
// at each end of every stretch of listening: the seconds before a pause or a stop, and the seconds
// after a resume or a jump. A pause or a stop closes the step at the place it parked; a start or a
// move closes it at the new place and starts the next one there. The seconds before a jump stay
// lost: by the time the engine reports a move, the place it left is gone. The engine notifies from
// inside its own park, stop and startAt, so the handler only reads and records, and what it found
// goes out with a poll a turn later.
//
// Finishes: every 60 s, every finished bookmark of each person bound to a slot, dated by its
// finishedAt. They repeat on every poll on purpose: the game's dedupe makes a repeat free, its
// floor drops a finish from before the seed, and a slot bound after the finish still gets it.
//
// Work ids go through the catalog, which knows a renamed work by its old ids too: a catalog rebuild
// can rename a work while a seed runs, and slot_data keeps the id the list was built with. Every
// event carries the current id first, then the old ones (workIds).

const defaultLogger = require('./logger.js');

const SPAN_MS = 10000;
const FINISH_MS = 60000;
const SPAN_FACTOR = 1.5;
const SPAN_SLACK_MS = 5000;

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

function why(err) {
	return (err && err.message) || err;
}

/**
 * Listen to the book engine and the bookmarks for the people bound to Plex Media slots.
 * @param {object} opts
 * @param {object} opts.books helpers/bookEngine.js's director: sessions(), position(s),
 *   onChange(fn) whose fn(s, kind) calls are measured on the spot
 * @param {object} opts.bookmarks helpers/bookmarks.js: forUser(userId)
 * @param {object} opts.catalogStore helpers/bookCatalogStore.js: work(id), which accepts old ids
 * @param {() => (string[]|Promise<string[]>)} opts.users Discord ids with active bindings
 * @param {(event: object) => (void|Promise)} opts.onEvent receives a CreditEvent (apMediaContracts),
 *   plus workIds; awaited one event at a time per poll kind, so a span delivery and a finish
 *   delivery can overlap
 * @param {() => number} [opts.now] @param {object} [opts.timers] @param {object} [opts.logger]
 * @returns {() => void} detach
 */
function attach({ books, bookmarks, catalogStore, users, onEvent, now = Date.now, timers = DEFAULT_TIMERS, logger = defaultLogger } = {}) {
	if (!books || typeof books.sessions !== 'function' || typeof books.position !== 'function') {
		throw new TypeError('apMediaBooks.attach needs the book engine.');
	}
	if (!bookmarks || typeof bookmarks.forUser !== 'function') throw new TypeError('apMediaBooks.attach needs the bookmarks.');
	if (typeof users !== 'function') throw new TypeError('apMediaBooks.attach needs users().');
	if (typeof onEvent !== 'function') throw new TypeError('apMediaBooks.attach needs onEvent().');

	let attached = true;
	let spanTimer = null;
	let kickTimer = null;
	let spanBusy = false;
	let finishBusy = false;
	// Session id -> { pos, wall, speed }: where a playing session was in work time when last measured.
	const baselines = new Map();
	// Steps the engine's notifications closed, sent with the next poll.
	const pending = [];

	function workIds(id) {
		const raw = id === undefined || id === null ? '' : String(id);
		const ids = [];
		const add = (x) => { if (typeof x === 'string' && x && !ids.includes(x)) ids.push(x); };
		let work = null;
		try {
			work = raw && catalogStore && typeof catalogStore.work === 'function' ? catalogStore.work(raw) : null;
		} catch (err) {
			logger.warn(`Plex Media: could not look up book ${raw} in the catalog:`, why(err));
		}
		if (work) {
			add(work.id);
			for (const alias of Array.isArray(work.aliases) ? work.aliases : []) add(alias);
		}
		add(raw);
		return ids;
	}

	async function deliver(events) {
		for (const event of events) {
			if (!attached) return;
			try {
				await onEvent(event);
			} catch (err) {
				logger.warn(`Plex Media: the book ${event.type} credit for ${event.workId} failed:`, why(err));
			}
		}
	}

	function armSpans() {
		if (attached && !spanTimer) spanTimer = unref(timers.setInterval(() => { pollSpans(); }, SPAN_MS));
	}

	function disarmSpans() {
		if (spanTimer) {
			timers.clearInterval(spanTimer);
			spanTimer = null;
		}
		baselines.clear();
	}

	// The engine notifies from inside its own calls, so the poll it prompts waits a turn.
	function wake() {
		if (!attached || kickTimer || (spanTimer && !pending.length)) return;
		kickTimer = unref(timers.setTimeout(() => {
			kickTimer = null;
			pollSpans();
		}, 0));
	}

	function keyOf(s) {
		return s.id !== undefined && s.id !== null ? s.id : s.guildId;
	}

	function speedOf(s) {
		return Number(s.speed) > 0 ? Number(s.speed) : 1;
	}

	function positionOf(s) {
		try {
			return Number(books.position(s));
		} catch (_) {
			return NaN;
		}
	}

	function stepTo(s, prev, pos, t) {
		const moved = pos - prev.pos;
		if (!(moved > 0 && moved <= (t - prev.wall) * Math.max(prev.speed, speedOf(s)) * SPAN_FACTOR + SPAN_SLACK_MS)) return null;
		return { userId: String(s.userId), workId: s.workId, fromMs: prev.pos, toMs: pos, at: t };
	}

	// The next step starts here even when this one did not count: a jump counts from where it lands.
	function measure(s, key, t) {
		const pos = positionOf(s);
		if (!Number.isFinite(pos)) {
			baselines.delete(key);
			return null;
		}
		const prev = baselines.get(key);
		baselines.set(key, { pos, wall: t, speed: speedOf(s) });
		return prev ? stepTo(s, prev, pos, t) : null;
	}

	function close(s, key, t) {
		const prev = baselines.get(key);
		baselines.delete(key);
		if (!prev) return null;
		const pos = positionOf(s);
		return Number.isFinite(pos) ? stepTo(s, prev, pos, t) : null;
	}

	function spanEvent(step) {
		const ids = workIds(step.workId);
		return {
			type: 'span',
			source: 'book',
			userIds: [step.userId],
			workId: ids[0],
			workIds: ids,
			fromMs: step.fromMs,
			toMs: step.toMs,
			at: step.at,
		};
	}

	// 'audible' only says the sound began, a few frames in: a step there would be noise.
	function onEngine(s, kind) {
		if (!attached) return;
		if (s && s.userId && kind !== 'audible') {
			const key = keyOf(s);
			const t = now();
			let step = null;
			if (kind === 'paused' || kind === 'ended') step = close(s, key, t);
			else if (s.state === 'playing') step = measure(s, key, t);
			else baselines.delete(key);
			if (step) pending.push(step);
		}
		wake();
	}

	function pollSpans() {
		// A poll skipped while the last one still delivers keeps its baselines, so the next step
		// covers both intervals and its bound grows with them.
		if (!attached || spanBusy) return null;
		let list;
		try {
			list = books.sessions() || [];
		} catch (err) {
			logger.warn('Plex Media: could not read the audiobook sessions:', why(err));
			return null;
		}
		const t = now();
		const live = new Set();
		const steps = pending.splice(0);
		for (const s of list) {
			if (!s || !s.userId) continue;
			const key = keyOf(s);
			live.add(key);
			if (s.state !== 'playing') {
				baselines.delete(key);
				continue;
			}
			const step = measure(s, key, t);
			if (step) steps.push(step);
		}
		for (const key of [...baselines.keys()]) if (!live.has(key)) baselines.delete(key);
		if (live.size === 0) disarmSpans();
		else armSpans();
		if (!steps.length) return null;
		spanBusy = true;
		return deliver(steps.map(spanEvent)).finally(() => { spanBusy = false; });
	}

	async function pollFinished() {
		if (!attached || finishBusy) return;
		finishBusy = true;
		try {
			let bound = [];
			try {
				bound = (await users()) || [];
			} catch (err) {
				logger.warn('Plex Media: could not list the people bound to slots:', why(err));
				return;
			}
			const events = [];
			for (const userId of new Set([...bound].map(String))) {
				let marks = [];
				try {
					marks = bookmarks.forUser(userId) || [];
				} catch (err) {
					logger.warn('Plex Media: could not read audiobook bookmarks:', why(err));
					continue;
				}
				for (const mark of marks) {
					if (!mark || !mark.finished) continue;
					const at = Number(mark.finishedAt);
					if (!Number.isFinite(at) || at <= 0) continue;
					const ids = workIds(mark.workId);
					if (!ids.length) continue;
					events.push({ type: 'complete', source: 'book', userIds: [userId], workId: ids[0], workIds: ids, at });
				}
			}
			await deliver(events);
		} finally {
			finishBusy = false;
		}
	}

	const finishTimer = unref(timers.setInterval(() => {
		// Belt and braces for an engine without onChange: a session found here starts the span poll.
		if (!spanTimer) pollSpans();
		pollFinished().catch((err) => logger.warn('Plex Media: the audiobook finish poll failed:', why(err)));
	}, FINISH_MS));

	let unsubscribe = null;
	if (typeof books.onChange === 'function') {
		const off = books.onChange(onEngine);
		if (typeof off === 'function') unsubscribe = off;
	}
	wake();

	return function detach() {
		if (!attached) return;
		// app/utils.js stop() shuts the books down just before this, and the steps their sessions
		// closed would otherwise wait for a poll that never comes. A !restart keeps the process, so
		// the game still credits them.
		const last = pending.splice(0).map(spanEvent);
		attached = false;
		timers.clearInterval(finishTimer);
		if (kickTimer) {
			timers.clearTimeout(kickTimer);
			kickTimer = null;
		}
		disarmSpans();
		if (unsubscribe) {
			try { unsubscribe(); } catch (_) {}
			unsubscribe = null;
		}
		for (const event of last) {
			const failed = (err) => logger.warn(`Plex Media: the book ${event.type} credit for ${event.workId} failed:`, why(err));
			try {
				Promise.resolve(onEvent(event)).catch(failed);
			} catch (err) {
				failed(err);
			}
		}
	};
}

module.exports = { attach, SPAN_MS, FINISH_MS, SPAN_FACTOR, SPAN_SLACK_MS };
