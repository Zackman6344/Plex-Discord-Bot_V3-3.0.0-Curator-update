// helpers/bookCatalogStore.js
//
// The current long-form catalog, in memory and in data/book_catalog.json. No Plex here: the
// library module builds a catalog and hands it to replace(); refreshMetadata() lays the display
// fields over the stored works again (helpers/bookMetadata.js) after an edit, without a rebuild;
// everything else only reads. editOverrides() is the one writer of the hand-edited overrides file.
//
// Nothing is read at require time. Music pickers ask this store whether a track is a book, and
// app/bot.js is required by tests that must never see the real catalog; jsonStore keeps the
// store memory-only under the test runner unless PLEXBOT_BOOK_CATALOG_FILE is set, and the
// overrides file follows the same rule.
//
// Part keys go stale whenever Plex re-scans, so they are looked up by identity (track ratingKey
// plus file basename), never by ordinal: a rebuild that inserts a part shifts every ordinal
// after it, and a key found by ordinal would play the wrong file.

const fs = require('fs');
const path = require('path');
const { createStore } = require('./jsonStore.js');
const logger = require('./logger.js');
const bookCatalog = require('./bookCatalog.js');
const bookMetadata = require('./bookMetadata.js');
const bookSearch = require('./bookSearch.js');

const OVERRIDES_ENV = 'PLEXBOT_BOOK_OVERRIDES_FILE';
const OVERRIDES_DEFAULT = path.join(__dirname, '..', 'data', 'book_overrides.json');

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function shape(raw) {
	const c = isObject(raw) ? raw : {};
	const index = isObject(c.index) ? c.index : {};
	const list = (v) => (Array.isArray(v) ? v.map(String) : []);
	let works = {};
	if (Array.isArray(c.works)) {
		for (const w of c.works) if (isObject(w) && typeof w.id === 'string') works[w.id] = w;
	} else if (isObject(c.works)) {
		works = c.works;
	}
	return {
		meta: isObject(c.meta) ? c.meta : {},
		works,
		rejected: Array.isArray(c.rejected) ? c.rejected : [],
		splits: Array.isArray(c.splits) ? c.splits : [],
		chapterCache: isObject(c.chapterCache) ? c.chapterCache : {},
		index: {
			trackKeys: list(index.trackKeys),
			albumKeys: list(index.albumKeys),
			artistKeys: list(index.artistKeys),
			partIds: list(index.partIds),
		},
	};
}

const store = createStore({
	envVar: 'PLEXBOT_BOOK_CATALOG_FILE',
	defaultPath: path.join(__dirname, '..', 'data', 'book_catalog.json'),
	key: 'catalog',
	shape: 'object',
	label: 'catalog',
	feature: 'Audiobook',
	pretty: false,
	migrate: shape,
});

// Lookups derived from the catalog, rebuilt on the first read after a replace() or reset().
let derived = null;
const shaped = new WeakSet();

/** @returns {object} the whole catalog: meta, works, rejected, splits, chapterCache, index */
function load() {
	const c = store.load();
	// jsonStore hands back a bare {} without calling migrate when the file is missing, has no
	// "catalog" key, or the store is memory-only, so the shape is filled in here as well.
	if (!shaped.has(c)) {
		Object.assign(c, shape(c));
		shaped.add(c);
	}
	return c;
}

function lookups() {
	if (derived) return derived;
	const c = load();
	const list = Object.values(c.works).filter(isObject);
	const byId = new Map(list.map((w) => [w.id, w]));
	const byAlias = new Map();
	for (const w of list) {
		for (const a of Array.isArray(w.aliases) ? w.aliases : []) {
			if (typeof a === 'string' && !byId.has(a) && !byAlias.has(a)) byAlias.set(a, w);
		}
	}
	const byTrack = new Map();
	for (const w of list) {
		for (const p of Array.isArray(w.parts) ? w.parts : []) {
			const k = String(p.trackRatingKey);
			if (!byTrack.has(k)) byTrack.set(k, []);
			byTrack.get(k).push({ work: w, part: p });
		}
	}
	derived = {
		list,
		byId,
		byAlias,
		byTrack,
		index: Object.freeze({
			trackKeys: new Set(c.index.trackKeys),
			albumKeys: new Set(c.index.albumKeys),
			artistKeys: new Set(c.index.artistKeys),
			partIds: new Set(c.index.partIds),
		}),
	};
	return derived;
}

/** @returns {object[]} every work, in catalog order */
function works() {
	return lookups().list;
}

/** @returns {object|null} the work with this id, or the one that now carries it as an alias */
function work(id) {
	if (typeof id !== 'string') return null;
	const l = lookups();
	return l.byId.get(id) || l.byAlias.get(id) || null;
}

function words(text) {
	return bookSearch.key(text).split(' ').filter(Boolean);
}

/**
 * Works matching what someone typed, best first: an id or alias, then an exact title, then a
 * title prefix, then every word starting a title word, then every word starting a word of the
 * title, author, series, series number, narrator or edition. When that finds nothing, a leading
 * the/a/an is dropped and the search runs again ("the mythos" for Mythos); while it finds
 * something the article still narrows ("the glass" is not Shadows of Glass). Empty text gives
 * every work. Typos find nothing here; bookSearch.suggest is the fallback for those.
 */
function findWorks(text) {
	const list = works();
	const q = bookSearch.key(text);
	if (!q) return [...list];
	const found = rank(list, q, String(text).trim());
	const loose = bookSearch.bare(q);
	return found.length || loose === q ? found : rank(list, loose, null);
}

function rank(list, q, raw) {
	const tokens = q.split(' ');
	const scored = [];
	list.forEach((w, i) => {
		const title = bookSearch.key(w.title);
		const titleWords = title.split(' ');
		const all = words([w.title, w.author, w.series, w.sequence, w.narrator, w.edition].filter((x) => x !== null && x !== undefined).join(' '));
		let score = 0;
		if (raw && (raw === w.id || (Array.isArray(w.aliases) && w.aliases.includes(raw)))) score = 100;
		else if (title === q) score = 90;
		else if (title.startsWith(q)) score = 80;
		else if (tokens.every((t) => titleWords.some((x) => x.startsWith(t)))) score = 70;
		else if (tokens.every((t) => all.some((x) => x.startsWith(t)))) score = 50;
		if (score) scored.push({ w, score, i });
	});
	return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.w);
}

function findPart(workId, ident) {
	if (!ident || ident.trackRatingKey === undefined || ident.trackRatingKey === null) return null;
	const trk = String(ident.trackRatingKey);
	const name = bookCatalog.basename(ident.file).toLowerCase();
	if (!name) return null;
	const same = (p) => String(p.trackRatingKey) === trk && bookCatalog.basename(p.file).toLowerCase() === name;
	const w = work(workId);
	const inWork = w && Array.isArray(w.parts) ? w.parts.find(same) : null;
	if (inWork) return inWork;
	// The work may have been renamed without an alias match; the identity is still unique.
	const hit = (lookups().byTrack.get(trk) || []).find((x) => same(x.part));
	return hit ? hit.part : null;
}

/** @returns {string|undefined} the part's current key, or undefined when the part is gone */
function partKeyFor(workId, ident) {
	const p = findPart(workId, ident);
	return p && p.partKey ? p.partKey : undefined;
}

/**
 * Records a repaired key in memory only; it reaches disk with the next replace(). Losing it on a
 * restart costs one more repair lookup, while persisting 340 KB per repair would cost every time.
 * @returns {boolean} whether the part was found
 */
function setPartKey(workId, ident, key) {
	const p = findPart(workId, ident);
	if (!p || typeof key !== 'string' || !key) return false;
	p.partKey = key;
	const id = bookCatalog.partIdOf(key);
	if (id) {
		const c = load();
		if (!c.index.partIds.includes(id)) c.index.partIds.push(id);
		if (derived) derived.index.partIds.add(id);
	}
	return true;
}

/**
 * Swaps the whole catalog at once, so a reader never sees half of an old one and half of a new
 * one, then writes it.
 * @returns {boolean} whether it reached disk (always true when the store is memory-only)
 */
function replace(catalog) {
	const next = shape(catalog);
	const c = load();
	for (const k of Object.keys(c)) delete c[k];
	Object.assign(c, next);
	shaped.add(c);
	derived = null;
	return store.persist();
}

/** @returns {{ trackKeys: Set<string>, albumKeys: Set<string>, artistKeys: Set<string>, partIds: Set<string> }} */
function index() {
	return lookups().index;
}

function meta() {
	return load().meta;
}

function keyOf(key) {
	return String(key || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

// `/book rescan` prints folder keys relative to the music root, so the host's drive layout stays
// out of the channel. An include or exclude copied from that reply is widened here to the one
// full key it ends, taken from the folders the last build saw (its works and rejected groups),
// because the catalog builder matches whole keys only.
function widen(entries, known) {
	if (!Array.isArray(entries)) return entries;
	const out = [...entries];
	for (const entry of entries) {
		const k = keyOf(entry);
		if (!k || known.has(k)) continue;
		const hits = [...known.values()].filter((full) => keyOf(full).endsWith(`/${k}`));
		if (hits.length === 1) out.push(hits[0]);
		else if (hits.length > 1) logger.warn(`Audiobook override "${entry}" fits more than one folder; give its full path.`);
	}
	return out;
}

function widenOverrides(parsed) {
	if (!Array.isArray(parsed.include) && !Array.isArray(parsed.exclude)) return parsed;
	const c = load();
	const known = new Map();
	const add = (full) => { if (typeof full === 'string' && full) known.set(keyOf(full), full); };
	for (const w of Object.values(c.works)) if (isObject(w)) add(w.folderKey);
	for (const r of c.rejected) if (isObject(r)) add(r.folderKey);
	const out = Object.assign({}, parsed);
	for (const field of ['include', 'exclude']) if (Array.isArray(parsed[field])) out[field] = widen(parsed[field], known);
	return out;
}

/**
 * The hand-edited overrides file. A parse error is logged and reported, never thrown, and the
 * build carries on without overrides rather than refusing to run. The reported error ends up in
 * a rescan reply, which can be public, so it never carries the file's path or text; the log does.
 * @returns {{ overrides: object, error: string|null }}
 */
function readOverrides() {
	const file = overridesFile();
	if (overridesOffLimits()) return { overrides: {}, error: null };
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return { overrides: {}, error: null };
		logger.warn(`Could not read the Audiobook overrides file ${file}:`, err.message);
		return { overrides: {}, error: err.code || 'unreadable' };
	}
	const r = parseOverrides(text, file, 'Ignoring');
	if (r.error) return { overrides: {}, error: r.error };
	return { overrides: widenOverrides(r.parsed), error: null };
}

function overridesFile() {
	return process.env[OVERRIDES_ENV] || OVERRIDES_DEFAULT;
}

// The real file says which folders are books; a test reading it would pass or fail by what is on
// this machine's disk, and a test writing it would change the owner's edits, so under the runner
// the env var is required, as in jsonStore.
function overridesOffLimits() {
	return !!process.env.NODE_TEST_CONTEXT && !process.env[OVERRIDES_ENV];
}

// Notepad saves UTF-8 with a byte order mark, which JSON.parse refuses.
function stripBom(text) {
	return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function parseOverrides(text, file, verb) {
	let parsed;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch (err) {
		logger.warn(`${verb} the Audiobook overrides file ${file}: ${err.message}`);
		const at = /\(line \d+ column \d+\)/.exec(err.message);
		return { error: `the file is not valid JSON${at ? ` ${at[0]}` : ''}` };
	}
	if (!isObject(parsed)) {
		const error = 'the file must hold a JSON object';
		logger.warn(`${verb} the Audiobook overrides file ${file}: ${error}`);
		return { error };
	}
	return { parsed, error: null };
}

function writeSynced(target, text) {
	const fd = fs.openSync(target, 'w');
	try {
		fs.writeFileSync(fd, text);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Changes the overrides file, for `!book edit`. The file is read raw (never through
 * readOverrides, whose widened include and exclude keys must not be written back) and handed to
 * `mutator`, which changes it in place or returns a replacement object, or returns false to write
 * nothing. A file that is not valid JSON is refused rather than replaced, so a hand edit with a
 * typo is never lost. The previous text goes to `<file>.bak`, the new text to `<file>.tmp`, which
 * is then renamed over the file, so a crash mid-write leaves the old file whole. The reported
 * error can reach a public reply, so it never carries the file's path or text; the log does.
 * @param {(overrides: object) => (object|false|void)} mutator
 * @returns {{ ok: boolean, changed: boolean, overrides?: object, error: string|null }}
 */
function editOverrides(mutator) {
	if (overridesOffLimits()) return { ok: false, changed: false, error: 'the overrides file is off limits under the test runner' };
	const file = overridesFile();
	let before = null;
	try {
		before = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err.code !== 'ENOENT') {
			logger.warn(`Could not read the Audiobook overrides file ${file}:`, err.message);
			return { ok: false, changed: false, error: err.code || 'unreadable' };
		}
	}
	let obj = {};
	if (before !== null && stripBom(before).trim() !== '') {
		const r = parseOverrides(before, file, 'Not changing');
		if (r.error) return { ok: false, changed: false, error: r.error };
		obj = r.parsed;
	}
	const snapshot = JSON.stringify(obj);
	let next;
	try {
		const result = mutator(obj);
		if (result === false) return { ok: true, changed: false, overrides: obj, error: null };
		next = result === undefined ? obj : result;
	} catch (err) {
		logger.warn(`Not changing the Audiobook overrides file ${file}: the edit failed: ${err && err.message}`);
		return { ok: false, changed: false, error: 'the edit could not be applied' };
	}
	if (!isObject(next)) return { ok: false, changed: false, error: 'the edit must leave a JSON object' };
	// An edit that changes nothing leaves the owner's own formatting alone.
	if (before !== null && JSON.stringify(next) === snapshot) return { ok: true, changed: false, overrides: next, error: null };
	const tmp = `${file}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (before !== null) writeSynced(`${file}.bak`, before);
		writeSynced(tmp, `${JSON.stringify(next, null, 2)}\n`);
		fs.renameSync(tmp, file);
	} catch (err) {
		logger.error(`Could not write the Audiobook overrides file ${file}:`, err.message);
		try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nothing to clean up */ }
		return { ok: false, changed: false, error: 'the file could not be written' };
	}
	return { ok: true, changed: true, overrides: next, error: null };
}

function optional(load) {
	try {
		return load();
	} catch (err) {
		logger.warn('Audiobook metadata: a source is unavailable:', err && err.message);
		return null;
	}
}

/**
 * What the metadata layer reads beside the catalog: the overrides file, the online lookup's cache
 * (empty while the setting is off) and Calibre. Exported so a fresh build can be resolved with the
 * same layers before replace().
 *
 * Calibre, while the Calibre index is on (helpers/calibreIndex.js): the owner's pin, then the
 * index's current record for the read-along pointer's Calibre id (the pointer's own copy is only
 * refreshed when the read-along checks the ebook again), then an exact index match. With the index
 * off, or silent about a work, the pointer's copy stands, as before the index existed.
 * @param {object} [deps] test seams; each omitted one is the real module
 * @param {object} [deps.overrides] the parsed overrides, instead of reading the file
 * @param {{ get: (work: object) => object|null }|null} [deps.lookup]
 * @param {object|null} [deps.textStore] bookTextStore's shape: works.peek, links.get
 * @param {(pointer: object|null, link: object|null) => object|null} [deps.calibreMeta]
 * @param {{ metadataFor: (work: object, pointerId: number|null) => object|null|undefined }|null} [deps.calibreIndex]
 */
function metadataContext(deps = {}) {
	const read = Object.prototype.hasOwnProperty.call(deps, 'overrides') ? { overrides: deps.overrides || {}, error: null } : readOverrides();
	const lookup = deps.lookup !== undefined ? deps.lookup : optional(() => require('./bookLookup.js').instance());
	const textStore = deps.textStore !== undefined ? deps.textStore : optional(() => require('./bookTextStore.js'));
	const calibreMeta = deps.calibreMeta || optional(() => require('./bookTextSource.js').calibreMetaOf);
	const index = deps.calibreIndex !== undefined ? deps.calibreIndex : optional(() => require('./calibreIndex.js').instance());
	function calibreOf(w) {
		const ptr = textStore ? textStore.works.peek(w) : null;
		const meta = textStore && calibreMeta ? calibreMeta(ptr, textStore.links.get(w)) : null;
		if (index && typeof index.metadataFor === 'function') {
			const pointerId = meta && ptr && ptr.source ? Number(ptr.source.id) || null : null;
			const pointer = pointerId ? { libraryId: ptr.source.libraryId || null, uuid: ptr.source.uuid || null } : {};
			const fromIndex = index.metadataFor(w, pointerId, pointer);
			if (fromIndex !== undefined) return fromIndex;
		}
		return meta;
	}
	return {
		error: read.error,
		overrides: read.overrides,
		calibreOf,
		onlineOf: (w) => (lookup && typeof lookup.get === 'function' ? lookup.get(w) : null),
	};
}

/**
 * Lays the metadata sources over every stored work again and saves the catalog when anything a
 * reader sees changed. No Plex: it runs after an edit, a finished lookup batch or a new Calibre
 * link, and takes milliseconds.
 * @param {object} [deps] as metadataContext
 * @returns {{ ok: boolean, changed: string[], error: string|null }}
 */
function refreshMetadata(deps = {}) {
	const ctx = metadataContext(deps);
	// Without the owner's edits every edited field would fall back to detection until the file is
	// fixed, so a broken file changes nothing.
	if (ctx.error) return { ok: false, changed: [], error: ctx.error };
	const c = load();
	const changed = [];
	for (const key of Object.keys(c.works)) {
		const w = c.works[key];
		if (!isObject(w)) continue;
		const next = bookMetadata.resolveWith(w, ctx);
		if (!bookMetadata.differs(w, next)) continue;
		c.works[key] = next;
		changed.push(w.id);
	}
	if (!changed.length) return { ok: true, changed, error: null };
	derived = null;
	const ok = store.persist();
	return { ok, changed, error: ok ? null : 'the catalog could not be saved' };
}

/** Test seam: forget the in-memory catalog so the next read comes off disk. */
function reset() {
	store.reset();
	derived = null;
}

module.exports = {
	file: store.file,
	load,
	works,
	work,
	findWorks,
	partKeyFor,
	setPartKey,
	replace,
	index,
	meta,
	readOverrides,
	editOverrides,
	metadataContext,
	refreshMetadata,
	reset,
	healthy: () => store.healthy(),
};
