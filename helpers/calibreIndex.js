// helpers/calibreIndex.js
//
// A cached copy of the Calibre library's metadata, and which record each audiobook work matches
// (helpers/calibreMatch.js), kept in data/book_calibre.json:
//
//   { libraryId, token, fetchedAt, checkedAt,
//     books: { <calibre id>: { uuid, title, authors, series, index, tags, isbn, formats, last_modified } },
//     matches: { <work id>: { id, uuid, libraryId, verdict, method, candidates?, problem? } } }
//
// GET only, through helpers/calibreClient.js. A full copy is one search for every id plus one
// details request per 100 books (5 requests for 335 books). Whether anything changed is a cheaper
// token: the book count, and the id and last_modified of the most recently changed book (2
// requests). An edit moves last_modified and a deletion moves the count, so a deleted record
// drops its match on the next check.
//
// When it runs: after every catalog rebuild, and on a token check at most every 15 minutes while
// the setting is on. The content server runs only while the Calibre app is open, so a failed check
// keeps the saved copy, and the next automatic try waits 15 minutes, then 30, 60 and at most 2
// hours; `!book calibre refresh` tries at once. Nothing here is awaited by a catalog build or a
// command reply: they read the saved copy.
//
// Matches follow the catalog: they are computed again from the saved copy whenever the catalog or
// a pin changes, and a work is found by its id and then each alias, the way links and overrides
// are. Every match and pin carries the library id and the record's uuid, because a rebuilt or
// switched library reuses ids and a stale copy would otherwise attach the wrong book.
//
// Under the test runner the default instance is off unless PLEXBOT_BOOK_CALIBRE_FILE is set, so no
// test reads the owner's copy or arms a timer by accident.

const path = require('path');
const { createStore } = require('./jsonStore.js');
const calibreMatch = require('./calibreMatch.js');

const STORE_ENV = 'PLEXBOT_BOOK_CALIBRE_FILE';
const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'book_calibre.json');
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;
const BACKOFF_SLACK_MS = 60 * 1000;
const SETTING_KEYS = ['audiobookCalibreSort', 'audiobooksEnabled', 'calibreUrl'];
const BATCH = 100;
const SEARCH_MAX = 5000;
const TEXT_MAX = 300;
const TAGS_MAX = 50;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);

function text(v) {
	return typeof v === 'string' && v.trim() && !/^unknown$/i.test(v.trim()) ? v.trim().slice(0, TEXT_MAX) : null;
}

/** The fields the index keeps of a Calibre /ajax/books record. */
function slim(book) {
	if (!isObject(book)) return null;
	const list = (v, max) => (Array.isArray(v) ? v.map(text).filter(Boolean).slice(0, max) : []);
	const series = text(book.series);
	const index = Number(book.series_index);
	const ids = isObject(book.identifiers) ? book.identifiers : {};
	return {
		uuid: text(book.uuid),
		title: text(book.title),
		authors: list(book.authors, 10),
		series,
		index: series && book.series_index !== null && book.series_index !== '' && Number.isFinite(index) ? index : null,
		tags: list(book.tags, TAGS_MAX),
		isbn: text(ids.isbn),
		formats: Array.isArray(book.formats) ? book.formats.map((f) => String(f).toLowerCase()).slice(0, 20) : [],
		last_modified: text(book.last_modified)
	};
}

function idsOf(work) {
	if (typeof work === 'string') return work ? [work] : [];
	if (!isObject(work) || typeof work.id !== 'string') return [];
	return [work.id, ...(Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [])];
}

function messageOf(err) {
	return (err && err.message) || String(err);
}

/**
 * @param {object} [deps] test seams; each omitted one is the production wiring
 * @param {() => object} [deps.getConfig]
 * @param {() => object|null} [deps.client] the Calibre client, or null when calibreUrl is blank
 * @param {() => object} [deps.catalog] bookCatalogStore's shape: works, readOverrides, refreshMetadata
 * @param {object|null} [deps.textStore] bookTextStore's shape: links.get, works.peek
 * @param {{ load: Function, persist: Function }} [deps.store] a jsonStore
 */
function createCalibreIndex(deps = {}) {
	const getConfig = deps.getConfig || (() => require('../config/config.js'));
	const clientOf = deps.client || (() => require('./bookTextSource.js').calibreFromConfig(getConfig()));
	const catalog = deps.catalog || (() => require('./bookCatalogStore.js'));
	const textStore = () => (deps.textStore !== undefined ? deps.textStore : require('./bookTextStore.js'));
	const metadata = () => require('./bookMetadata.js');
	const textSource = () => require('./bookTextSource.js');
	const now = deps.now || Date.now;
	const setTimer = deps.setInterval || setInterval;
	const clearTimer = deps.clearInterval || clearInterval;
	const logger = deps.logger || require('./logger.js');
	const offLimits = !deps.store && !!process.env.NODE_TEST_CONTEXT && !process.env[STORE_ENV];
	const store = deps.store || createStore({
		envVar: STORE_ENV,
		defaultPath: DEFAULT_PATH,
		key: 'calibre',
		shape: 'object',
		label: 'Calibre index',
		feature: 'Audiobook',
		pretty: false
	});

	let timer = null;
	let running = null;
	let failures = 0;
	let backoffUntil = 0;
	let lastError = null;
	let lastAttemptAt = null;
	let answered = null;
	let lastEnabled = null;
	let unsubscribe = null;

	function load() {
		const c = store.load();
		if (!isObject(c.books)) c.books = {};
		if (!isObject(c.matches)) c.matches = {};
		return c;
	}

	function configured() {
		try {
			const cfg = getConfig();
			return String((cfg && cfg.calibreUrl) || '').trim() !== '';
		} catch (_) {
			return false;
		}
	}

	/** On only with audiobooks, the setting and a Calibre address all on. */
	function enabled() {
		if (offLimits) return false;
		try {
			const cfg = getConfig();
			return cfg.audiobooksEnabled === true && cfg.audiobookCalibreSort === true && configured();
		} catch (_) {
			return false;
		}
	}

	function refreshCatalog() {
		try {
			const r = catalog().refreshMetadata();
			if (r && r.changed && r.changed.length) logger.info(`Audiobook Calibre index: details of ${r.changed.length} book${r.changed.length === 1 ? '' : 's'} changed.`);
		} catch (err) {
			logger.warn('Audiobook Calibre index: the catalog could not be refreshed:', messageOf(err));
		}
	}

	// A read-along pointer made in another library, or for a record whose id a rebuilt library
	// reused, names a different book in this copy.
	function pointerBelongs(source, cache) {
		if (!isObject(source)) return false;
		const lib = text(source.libraryId);
		if (lib && cache.libraryId && lib !== cache.libraryId) return false;
		const rec = cache.books[String(source.id)];
		const uuid = text(source.uuid);
		return !(uuid && isObject(rec) && rec.uuid && uuid !== rec.uuid);
	}

	// A match's record, unless the id now holds another book: rematch can keep old matches over a
	// fresh copy (a broken overrides file stops it), and Calibre reuses the newest id.
	function recordFor(m) {
		if (!m || m.id === null || m.id === undefined) return null;
		const r = recordOf(m.id);
		if (!r) return null;
		return m.uuid && r.uuid && m.uuid !== r.uuid ? null : r;
	}

	function metaFrom(r) {
		if (!r) return null;
		return textSource().calibreMetaFrom({ title: r.title, authors: r.authors, series: r.series, series_index: r.index });
	}

	function calibreIdOfLink(link) {
		return link && link.type === 'calibre' && Number.isInteger(Number(link.id)) ? Number(link.id) : null;
	}

	/**
	 * Matches every catalog work again from the saved copy. Cheap (about 50 ms for 80 works and
	 * 335 books), so it runs after every rebuild and pin, Calibre open or not.
	 * @returns {boolean} whether any match changed
	 */
	function rematch({ persist = true, refresh = true } = {}) {
		if (!enabled()) return false;
		const cache = load();
		if (!Object.keys(cache.books).length) return false;
		let works;
		let overrides;
		try {
			works = catalog().works() || [];
			const read = catalog().readOverrides();
			// A broken overrides file would read as no pins at all, and every pin would come undone.
			if (read.error) return false;
			overrides = read.overrides || {};
		} catch (err) {
			logger.warn('Audiobook Calibre index: the catalog could not be read:', messageOf(err));
			return false;
		}
		if (!works.length) return false;
		const ts = textStore();
		const meta = metadata();
		const src = textSource();
		const next = calibreMatch.matchAll(works, cache.books, {
			libraryId: cache.libraryId || null,
			pinOf: (w) => meta.extrasFor(w, overrides).calibre || null,
			linkOf: (w) => (ts ? calibreIdOfLink(ts.links.get(w)) : null),
			pointerOf: (w) => {
				if (!ts) return null;
				const ptr = ts.works.peek(w);
				if (!src.calibreMetaOf(ptr, ts.links.get(w))) return null;
				return pointerBelongs(ptr.source, cache) ? Number(ptr.source.id) : null;
			}
		});
		const changed = JSON.stringify(next) !== JSON.stringify(cache.matches);
		if (!changed) return false;
		cache.matches = next;
		if (persist) store.persist();
		if (refresh) refreshCatalog();
		return true;
	}

	async function tokenOf(client) {
		const page = await client.searchPage('', { num: 1, sort: 'last_modified', order: 'desc' });
		const top = page.ids[0] || 0;
		let modified = '';
		if (top) {
			const found = await client.books([top]);
			const b = found.get(top);
			modified = (b && b.last_modified) || '';
		}
		return `${page.total}:${top}:${modified}`;
	}

	async function fetchAll(client) {
		const page = await client.searchPage('', { num: SEARCH_MAX });
		if (page.total > page.ids.length) logger.warn(`Audiobook Calibre index: the library has ${page.total} books; only the first ${page.ids.length} are matched.`);
		const books = {};
		for (let i = 0; i < page.ids.length; i += BATCH) {
			const found = await client.books(page.ids.slice(i, i + BATCH));
			for (const [id, b] of found) {
				const s = slim(b);
				if (s) books[String(id)] = s;
			}
		}
		return books;
	}

	async function doRefresh(force) {
		lastAttemptAt = now();
		try {
			const client = clientOf();
			if (!client) return { ok: false, skipped: 'off' };
			const lib = await client.libraryId();
			const token = await tokenOf(client);
			const cache = load();
			let fetched = false;
			if (force || cache.libraryId !== lib || cache.token !== token || !Object.keys(cache.books).length) {
				const books = await fetchAll(client);
				if (cache.libraryId !== lib) cache.matches = {};
				cache.libraryId = lib;
				cache.token = token;
				cache.fetchedAt = now();
				cache.books = books;
				fetched = true;
			}
			cache.checkedAt = now();
			if (failures) logger.info('Audiobook Calibre index: Calibre answers again.');
			failures = 0;
			backoffUntil = 0;
			lastError = null;
			answered = true;
			const changed = rematch({ persist: false, refresh: false });
			store.persist();
			if (fetched || changed) refreshCatalog();
			return { ok: true, fetched, changed, books: Object.keys(cache.books).length };
		} catch (err) {
			failures++;
			answered = false;
			lastError = messageOf(err);
			backoffUntil = now() + Math.min(CHECK_INTERVAL_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
			// Once per outage: a Calibre app closed for the night would otherwise log every check.
			if (failures === 1) logger.warn(`Audiobook Calibre index: ${lastError} The saved copy stays in use.`);
			return { ok: false, error: lastError };
		}
	}

	/**
	 * Checks the token and copies the library again when it moved, then matches. One at a time; a
	 * call while one runs gets the same promise. Never throws.
	 * @param {{ force?: boolean }} [opts] force: copy the whole library, and ignore the back-off
	 * @returns {Promise<{ ok: boolean, fetched?: boolean, changed?: boolean, books?: number, skipped?: 'off'|'backoff', error?: string }>}
	 */
	function refresh({ force = false } = {}) {
		if (!syncEnabled()) return Promise.resolve({ ok: false, skipped: 'off' });
		if (running) return running;
		// A minute of slack: the back-off is timed from when the failed check ended, and the timer
		// fires on its own 15-minute grid a moment before that, which skipped a whole tick each time.
		if (!force && backoffUntil - now() > BACKOFF_SLACK_MS) return Promise.resolve({ ok: false, skipped: 'backoff' });
		running = doRefresh(force).finally(() => { running = null; });
		return running;
	}

	/** After a catalog rebuild: match the new works from the saved copy at once, then check Calibre. */
	function afterRebuild() {
		syncEnabled();
		try {
			rematch();
		} catch (err) {
			logger.warn('Audiobook Calibre index: matching failed:', messageOf(err));
		}
		return refresh().catch(() => null);
	}

	function tick() {
		if (!syncEnabled()) return null;
		return refresh().catch(() => null);
	}

	/**
	 * The stored catalog holds what Calibre filled in, so turning the setting off must take those
	 * fields away again, and turning it back on must put them back, without waiting for an
	 * unrelated rebuild or edit.
	 * @returns {boolean} enabled()
	 */
	function syncEnabled() {
		const on = enabled();
		if (lastEnabled === null || on === lastEnabled) {
			lastEnabled = on;
			return on;
		}
		lastEnabled = on;
		if (on) {
			try { rematch({ refresh: false }); } catch (_) {}
		}
		refreshCatalog();
		return on;
	}

	/** Arms the 15-minute check and runs one now. The check does nothing while the setting is off. */
	function start() {
		if (offLimits) return null;
		if (!timer) {
			timer = setTimer(tick, CHECK_INTERVAL_MS);
			if (timer && typeof timer.unref === 'function') timer.unref();
		}
		if (!unsubscribe && !deps.getConfig) {
			try {
				const off = require('./configStore.js').onChange((key) => {
					if (SETTING_KEYS.includes(key)) syncEnabled();
				});
				unsubscribe = typeof off === 'function' ? off : () => {};
			} catch (_) {}
		}
		return tick();
	}

	function stop() {
		if (timer) clearTimer(timer);
		timer = null;
		if (unsubscribe) { try { unsubscribe(); } catch (_) {} }
		unsubscribe = null;
	}

	/** The work's match, found by its id and then each alias; null while the index is off. */
	function matchFor(work) {
		if (!enabled()) return null;
		const matches = load().matches;
		for (const id of idsOf(work)) {
			if (has(matches, id) && isObject(matches[id])) return { ...matches[id] };
		}
		return null;
	}

	function recordOf(id) {
		const books = load().books;
		return id !== null && id !== undefined && has(books, String(id)) && isObject(books[String(id)]) ? { ...books[String(id)] } : null;
	}

	/** A record as the catalog's metadata layer reads Calibre (bookTextSource.calibreMetaFrom). */
	function metaOf(id) {
		return metaFrom(recordOf(id));
	}

	/**
	 * What the metadata layer shows from Calibre for a work, or undefined when the index has no say
	 * (it is off, or knows nothing of the work) and the read-along pointer's own copy stands. A pin
	 * comes first, and a pin to none or to a record that is gone gives null: no Calibre details. Then
	 * the current record behind the read-along's pointer, then an exact match. A likely match never
	 * fills a field.
	 * @param {object} work
	 * @param {number|null} [pointerId] the Calibre id of the work's usable read-along pointer
	 * @param {{ libraryId?: string|null, uuid?: string|null }} [pointer] that pointer's library and
	 *   record uuid; a pointer from another library, or to an id now holding another book, is skipped
	 */
	function metadataFor(work, pointerId = null, pointer = {}) {
		if (!enabled()) return undefined;
		const m = matchFor(work);
		if (m && m.method === 'pin') return m.verdict === 'exact' ? metaFrom(recordFor(m)) : null;
		if (pointerId && pointerBelongs({ ...(isObject(pointer) ? pointer : {}), id: pointerId }, load())) {
			const r = metaOf(pointerId);
			if (r) return r;
		}
		if (m && m.verdict === 'exact' && m.id !== null) return metaFrom(recordFor(m)) || undefined;
		return undefined;
	}

	/** The tags a section may come from: { verdict: 'exact'|'likely', tags } or null. */
	function genreOf(work) {
		const m = matchFor(work);
		if (!m || m.id === null || (m.verdict !== 'exact' && m.verdict !== 'likely')) return null;
		const r = recordFor(m);
		return r ? { verdict: m.verdict, tags: r.tags || [] } : null;
	}

	/**
	 * A record the read-along may open for a work that has no pointer yet: an exact match with an
	 * EPUB. Never a likely one.
	 * @returns {{ id: number }|null}
	 */
	function readAlongPick(work) {
		const m = matchFor(work);
		if (!m || m.verdict !== 'exact' || m.id === null) return null;
		const r = recordFor(m);
		return r && Array.isArray(r.formats) && r.formats.includes('epub') ? { id: m.id } : null;
	}

	function status() {
		const c = load();
		return {
			enabled: enabled(),
			configured: configured(),
			libraryId: c.libraryId || null,
			fetchedAt: Number.isFinite(c.fetchedAt) ? c.fetchedAt : null,
			checkedAt: Number.isFinite(c.checkedAt) ? c.checkedAt : null,
			books: Object.keys(c.books).length,
			answered,
			lastError,
			lastAttemptAt,
			backoffUntil: backoffUntil > now() ? backoffUntil : null,
			running: !!running,
			armed: !!timer
		};
	}

	/** Every match by work id, as saved. */
	function matches() {
		return { ...load().matches };
	}

	return { start, stop, refresh, afterRebuild, rematch, enabled, configured, matchFor, recordOf, metaOf, metadataFor, genreOf, readAlongPick, status, matches };
}

let shared = null;

/** The process-wide index the bot uses. */
function instance() {
	if (!shared) shared = createCalibreIndex();
	return shared;
}

module.exports = { createCalibreIndex, instance, slim, STORE_ENV, CHECK_INTERVAL_MS, BACKOFF_MAX_MS, BATCH };
