// helpers/bookmarks.js
//
// Each listener's place in each audiobook or podcast, and the listening stats derived from it.
//
// One flat record per `<userId>::<workId>`. The position that matters is `absoluteMs`, ms from the
// start of the work; `hint` pins it to a file so a rebuild that re-keys, reorders or re-rips the
// parts still resumes in the right place (bookModel.resolveBookmark). Part keys are never stored:
// they change on every Plex rescan.
//
// The engine saves every few seconds while a book plays, so a write is skipped unless the place or
// the listening time moved by a second or more. Nothing is rolled back when a write fails: the
// newer place stays in memory, the next save retries, and healthy() goes false so the card can say
// so. Rolling back would replay the same minutes on the next resume for a disk fault.
//
// Stats (hours listened, works finished, the leaderboard) are read from these records rather than
// kept in a second file, so the two cannot disagree.

const path = require('path');
const { createStore } = require('./jsonStore.js');
const logger = require('./logger.js');
const commandLog = require('./commandLog.js');
const bookModel = require('./bookModel.js');

const store = createStore({
	envVar: 'PLEXBOT_BOOK_BOOKMARKS_FILE',
	defaultPath: path.join(__dirname, '..', 'data', 'book_bookmarks.json'),
	key: 'bookmarks',
	shape: 'object',
	label: 'bookmark',
	feature: 'Audiobook',
	// Keys start with a Discord id and end with a work id built from folder names.
	nullPrototype: true,
	// Rewritten every 15 s per listener; indentation would only cost time.
	pretty: false,
	// A torn write after a power cut would otherwise lose every listener's place at once.
	durable: true
});

const MIN_MOVE_MS = 1000;
const IN_PROGRESS_MS = 60 * 1000;
const PODCAST = 'podcast';

// Keys whose in-memory record differs from what was last written, and what each looked like then.
const dirtyKeys = new Set();
const written = new Map();
// So a disk that stays broken records one 'book-save-failed' event, not one every 15 s.
let failing = false;

function keyOf(userId, workId) {
	return `${userId}::${workId}`;
}

function idOf(work) {
	if (typeof work === 'string') return work;
	return work && typeof work.id === 'string' ? work.id : '';
}

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function copy(mark) {
	if (!mark) return null;
	return Object.assign({}, mark, { hint: mark.hint ? Object.assign({}, mark.hint) : null });
}

function snapshot(mark) {
	return {
		absoluteMs: mark.absoluteMs,
		listenedMs: mark.listenedMs,
		speed: mark.speed,
		finished: mark.finished,
		guildId: mark.guildId
	};
}

function write() {
	const ok = store.persist();
	if (ok) {
		const all = store.load();
		for (const k of dirtyKeys) {
			if (has(all, k)) written.set(k, snapshot(all[k]));
			else written.delete(k);
		}
		dirtyKeys.clear();
		if (failing) logger.info('Audiobook bookmarks are being saved again.');
		failing = false;
	} else if (!failing) {
		failing = true;
		commandLog.recordEvent('book-save-failed', { file: path.basename(store.file) });
	}
	return ok;
}

function result(persisted) {
	return { persisted, healthy: store.healthy() };
}

function movedEnough(k, mark) {
	const was = written.get(k);
	if (!was) return true;
	return Math.abs(num(mark.absoluteMs) - num(was.absoluteMs)) >= MIN_MOVE_MS
		|| Math.abs(num(mark.listenedMs) - num(was.listenedMs)) >= MIN_MOVE_MS
		|| mark.speed !== was.speed
		|| mark.finished !== was.finished
		|| mark.guildId !== was.guildId;
}

function blank(userId, work, now) {
	return {
		userId: String(userId),
		workId: work.id,
		title: work.title || work.id,
		kind: work.kind || 'book',
		guildId: null,
		absoluteMs: 0,
		hint: null,
		speed: 1,
		listenedMs: 0,
		coveredMs: 0,
		finished: false,
		finishedCount: 0,
		finishedAt: null,
		startedAt: now,
		updatedAt: now,
		lastListenedAt: null
	};
}

/**
 * The listener's bookmark for a work, or null. A work renamed by a rebuild lists its old ids in
 * `aliases`; a bookmark found under one is moved to the current id here, on first read, so the
 * place survives a folder rename.
 * @param {string} userId
 * @param {object|string} work a catalog work, or a bare work id (no alias lookup)
 * @returns {object|null} a copy; change it through record() or markFinished()
 */
function get(userId, work) {
	const id = idOf(work);
	if (!userId || !id) return null;
	const all = store.load();
	const k = keyOf(userId, id);
	if (has(all, k)) return copy(all[k]);
	const aliases = work && typeof work === 'object' && Array.isArray(work.aliases) ? work.aliases : [];
	for (const alias of aliases) {
		const old = keyOf(userId, alias);
		if (typeof alias !== 'string' || !has(all, old)) continue;
		const mark = Object.assign(all[old], { workId: id, title: work.title || all[old].title });
		all[k] = mark;
		delete all[old];
		dirtyKeys.add(k);
		dirtyKeys.add(old);
		write();
		return copy(mark);
	}
	return null;
}

/**
 * Save a listener's place.
 * @param {string} userId
 * @param {object} work the catalog work; its parts give the hint, its title and kind are copied
 * @param {object} fields
 * @param {number} fields.absoluteMs required; clamped to the work
 * @param {number} [fields.speed] kept only when it is one of bookModel.SPEEDS
 * @param {string} [fields.guildId] the guild of this save, for the leaderboard
 * @param {number} [fields.addListenedMs] real time heard since the last call; added, never set
 * @param {number} [fields.addCoveredMs] book time covered since the last call; added, never set
 * @param {false} [fields.finished] false clears a finished mark (resumeStart's clearFinished);
 *   finishing goes through markFinished()
 * @param {{force?: boolean}} [options] force writes even when nothing moved a second
 * @returns {{persisted: boolean, healthy: boolean}} persisted is false both for a skipped write
 *   and a failed one; healthy tells them apart
 */
function record(userId, work, fields, { force = false } = {}) {
	fields = fields || {};
	const id = idOf(work);
	const abs = fields.absoluteMs;
	// An undefined or NaN position written here would survive into every later resume, and
	// JSON.stringify turns NaN into null, which reads back as 0: the start of the book.
	if (typeof abs !== 'number' || !Number.isFinite(abs)) {
		logger.error(`Not saving an Audiobook bookmark for ${id || 'an unknown work'}: ` +
			`position ${String(abs)} is not a number of ms.`);
		return result(false);
	}
	if (!userId || !id || typeof work !== 'object') {
		logger.error('Not saving an Audiobook bookmark without a listener and a catalog work.');
		return result(false);
	}
	const all = store.load();
	const k = keyOf(userId, id);
	const now = Date.now();
	const isNew = !has(all, k);
	const mark = isNew ? blank(userId, work, now) : all[k];

	const total = bookModel.totalMs(work);
	const at = Math.max(0, total > 0 ? Math.min(abs, total) : abs);
	mark.absoluteMs = Math.round(at);
	mark.hint = bookModel.hintFor(work, at);
	mark.title = work.title || mark.title;
	mark.kind = work.kind || mark.kind;
	if (bookModel.SPEEDS.includes(Number(fields.speed))) mark.speed = Number(fields.speed);
	if (typeof fields.guildId === 'string' && fields.guildId) mark.guildId = fields.guildId;
	const heard = num(fields.addListenedMs);
	if (heard > 0) {
		mark.listenedMs = Math.round(num(mark.listenedMs) + heard);
		mark.lastListenedAt = now;
	}
	const covered = num(fields.addCoveredMs);
	if (covered > 0) mark.coveredMs = Math.round(num(mark.coveredMs) + covered);
	if (fields.finished === false) mark.finished = false;
	mark.updatedAt = now;
	if (isNew) all[k] = mark;
	dirtyKeys.add(k);

	// A failed write is retried on the very next save, not only once a second has moved.
	if (!force && store.healthy() && !movedEnough(k, mark)) return result(false);
	return result(write());
}

/** Write anything still unsaved; for shutdown. Synchronous. */
function flush() {
	if (dirtyKeys.size === 0 && store.healthy()) return result(false);
	return result(write());
}

/**
 * Mark a work finished and put the place at its end. Only a natural end of the last part,
 * /book finish and the ended card's button call this; no stop reason does.
 * The hint is the last part's end, which is what lets resumeStart tell a podcast that has since
 * gained episodes ('new-material') from one replayed after a goto back.
 */
function markFinished(userId, work, { guildId } = {}) {
	const id = idOf(work);
	if (!userId || !id || typeof work !== 'object') return result(false);
	const all = store.load();
	const k = keyOf(userId, id);
	const now = Date.now();
	if (!has(all, k)) all[k] = blank(userId, work, now);
	const mark = all[k];
	const total = bookModel.totalMs(work);
	// A double click on "Mark finished" is one finish, not two.
	if (!mark.finished) {
		mark.finishedCount = num(mark.finishedCount) + 1;
		mark.finishedAt = now;
	}
	mark.finished = true;
	mark.absoluteMs = total;
	mark.hint = bookModel.hintFor(work, total);
	mark.title = work.title || mark.title;
	mark.kind = work.kind || mark.kind;
	if (typeof guildId === 'string' && guildId) mark.guildId = guildId;
	mark.updatedAt = now;
	dirtyKeys.add(k);
	return result(write());
}

/** @returns {{removed: boolean, persisted: boolean, healthy: boolean}} */
function forget(userId, workId) {
	const id = idOf(workId);
	const all = store.load();
	const k = keyOf(userId, id);
	if (!userId || !id || !has(all, k)) return { removed: false, ...result(false) };
	delete all[k];
	dirtyKeys.add(k);
	return { removed: true, ...result(write()) };
}

function newestFirst(a, b) {
	return num(b.updatedAt) - num(a.updatedAt) || String(a.workId).localeCompare(String(b.workId));
}

function marksOf(userId) {
	const all = store.load();
	const out = [];
	if (!userId) return out;
	// Filtered on the stored userId, not a key prefix, so no id can match another user's keys.
	for (const k of Object.keys(all)) {
		const mark = all[k];
		if (mark && typeof mark === 'object' && mark.userId === String(userId)) out.push(mark);
	}
	return out.sort(newestFirst);
}

/** Every bookmark of one listener, most recently updated first. Copies. */
function forUser(userId) {
	return marksOf(userId).map(copy);
}

/** What /book play with no title resumes: the newest unfinished bookmark, or null. */
function lastInProgress(userId) {
	return copy(marksOf(userId).find(m => !m.finished) || null);
}

/** The speed of the listener's newest bookmark, else the configured default, else 1. */
function lastSpeed(userId) {
	for (const mark of marksOf(userId)) {
		if (bookModel.SPEEDS.includes(Number(mark.speed))) return Number(mark.speed);
	}
	let fallback = NaN;
	try {
		fallback = Number(require('../config/config.js').audiobookDefaultSpeed);
	} catch (_) {}
	return bookModel.SPEEDS.includes(fallback) ? fallback : 1;
}

/**
 * Where a bookmark stands against the work as it is now.
 * @param {object} mark
 * @param {object|null} work the current catalog work; falsy means it is gone from the library
 * @returns {'missing'|'new'|'in-progress'|'finished'|'caught-up'|'new-episodes'|null}
 */
function statusOf(mark, work) {
	if (!mark) return null;
	if (!work) return 'missing';
	const podcast = (work.kind || mark.kind) === PODCAST;
	if (mark.finished) {
		if (!podcast) return 'finished';
		// Same rule /book play uses, so the shelf never promises episodes the play would not find.
		return bookModel.resumeStart(work, mark).mode === 'new-material' ? 'new-episodes' : 'caught-up';
	}
	return progressOf(mark);
}

function progressOf(mark) {
	return num(mark.absoluteMs) >= IN_PROGRESS_MS ? 'in-progress' : 'new';
}

// Without the catalog nothing can say whether a podcast has grown since it was caught up.
function statusFromMark(mark) {
	if (!mark.finished) return progressOf(mark);
	return mark.kind === PODCAST ? 'caught-up' : 'finished';
}

function lookup(catalog, id) {
	if (!catalog) return undefined;
	if (typeof catalog.work === 'function') return catalog.work(id) || null;
	const map = catalog.works && typeof catalog.works === 'object' ? catalog.works : catalog;
	return has(map, id) ? map[id] : null;
}

function tally() {
	return { works: 0, listenedMs: 0, coveredMs: 0, worksFinished: 0, totalFinishes: 0, inProgress: 0 };
}

function add(t, mark) {
	t.works++;
	t.listenedMs += num(mark.listenedMs);
	t.coveredMs += num(mark.coveredMs);
	if (num(mark.finishedCount) > 0) t.worksFinished++;
	t.totalFinishes += num(mark.finishedCount);
	if (!mark.finished && num(mark.absoluteMs) >= IN_PROGRESS_MS) t.inProgress++;
}

/**
 * One listener's totals, split into books and podcasts, plus their three most-listened works.
 * @param {string} userId
 * @param {object} [catalog] bookCatalogStore (anything with work(id)), a { works } object or a
 *   plain id-to-work map; without one, no status can say 'missing' or 'new-episodes'
 */
function statsFor(userId, catalog) {
	const marks = marksOf(userId);
	const total = tally();
	const byKind = { book: tally(), podcast: tally() };
	let newEpisodes = 0;
	const rows = marks.map((mark) => {
		add(total, mark);
		add(mark.kind === PODCAST ? byKind.podcast : byKind.book, mark);
		const status = catalog ? statusOf(mark, lookup(catalog, mark.workId)) : statusFromMark(mark);
		if (status === 'new-episodes') newEpisodes++;
		return {
			workId: mark.workId, title: mark.title, kind: mark.kind,
			listenedMs: num(mark.listenedMs), coveredMs: num(mark.coveredMs),
			finishedCount: num(mark.finishedCount), status
		};
	});
	const top = rows.filter(r => r.listenedMs > 0)
		.sort((a, b) => b.listenedMs - a.listenedMs || String(a.workId).localeCompare(String(b.workId)))
		.slice(0, 3);
	return Object.assign(total, { byKind, newEpisodes, top });
}

/**
 * One row per listener with at least one bookmark saved in this guild, most hours first, then
 * most works finished. Totals cover all of that listener's bookmarks. The bot has no
 * GuildMembers intent, so membership comes from the bookmark's guildId, not the member cache.
 * @returns {Array<{userId, listenedMs, coveredMs, worksFinished, totalFinishes, works}>}
 */
function leaderboardRows(guildId) {
	if (!guildId) return [];
	const all = store.load();
	const users = new Map();
	const here = new Set();
	for (const k of Object.keys(all)) {
		const mark = all[k];
		if (!mark || typeof mark !== 'object' || typeof mark.userId !== 'string') continue;
		if (!users.has(mark.userId)) users.set(mark.userId, tally());
		add(users.get(mark.userId), mark);
		if (mark.guildId === String(guildId)) here.add(mark.userId);
	}
	const rows = [];
	for (const userId of here) {
		const t = users.get(userId);
		rows.push({
			userId, listenedMs: t.listenedMs, coveredMs: t.coveredMs,
			worksFinished: t.worksFinished, totalFinishes: t.totalFinishes, works: t.works
		});
	}
	return rows.sort((a, b) => b.listenedMs - a.listenedMs || b.worksFinished - a.worksFinished
		|| a.userId.localeCompare(b.userId));
}

function healthy() {
	return store.healthy();
}

/** Test seam: drop the in-memory copy so the next read comes off disk, as after a restart. */
function reset() {
	store.reset();
	dirtyKeys.clear();
	written.clear();
	failing = false;
}

module.exports = {
	get,
	record,
	flush,
	markFinished,
	forget,
	forUser,
	lastInProgress,
	lastSpeed,
	statusOf,
	statsFor,
	leaderboardRows,
	healthy,
	reset,
	FILE: store.file,
	BACKUP_FILE: store.backupFile
};
