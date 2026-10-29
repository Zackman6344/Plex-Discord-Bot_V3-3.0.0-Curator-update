// helpers/bookMetadata.js
//
// Which value each displayed field of a work shows, and where it came from. Detection
// (helpers/bookCatalog.js) records what the folders, Plex and the embedded tags gave in
// `work.detected`; this module lays the other sources over it, highest first:
//
//   1. book_overrides.json: the owner's `!book edit` values and hand edits, per work (found by id,
//      then by each alias, so an edit survives a rename) and per author (`authors[slug]` with a
//      series and an order, which names a whole series at once);
//   2. embedded tags, then Plex, then the folder, already decided by detection;
//   3. Calibre (title, authors, series and number): while audiobookCalibreSort is on, the owner's
//      Calibre pin (a pin to none gives nothing), else the index's current copy of the book the
//      read-along uses, else an exact index match (helpers/calibreIndex.js); with it off, the
//      read-along pointer's own copy;
//   4. the online lookup.
// Calibre and online only FILL what every source above left blank. A Calibre record can be titled
// in lower case or after its series (a record "Ashfall" holding book one), and an online answer can
// be cased worse than the folder, so neither replaces a value that exists. The one change either
// may make is a case fix of a tag, Plex or folder title, and only to a candidate that is the same
// title once case and punctuation are ignored AND is itself properly cased (smartTitle leaves it
// as it is): "Words Of The Tide" becomes "Words of the Tide", never the other way round. A series
// number online disagrees with stays (0.5 against 2.5), and so does a series spelled differently.
//
// The section a book is listed under (its genre) has its own order in helpers/bookSections.js:
// the owner's edits, then the owner's folders, then Calibre tags of an exact match, then embedded
// genres, then Calibre tags of a likely match. That is the one place Calibre outranks a local
// source: the owner curates Calibre, while an embedded genre is whatever the uploader wrote.
// Those keys (works[id].genre, authors[slug].genre, works[id].calibreId) are not display fields
// and stay out of FIELDS; extrasFor() reads them by id and every alias.
//
// Only the display fields change. Ids, aliases, folder keys, parts, kind and confidence are never
// touched: a work's id is built from detection alone, so bookmarks, read-along links and sync
// marks cannot move because a source spelled something differently.
//
// Pure apart from the two lookups layersFor() is handed, so every rule is tested on plain objects.

const bookCatalog = require('./bookCatalog.js');
const bookLookup = require('./bookLookup.js');
const calibreMatch = require('./calibreMatch.js');

// The display fields, which are also the metadata keys a per-work override may carry. partOrder,
// pinId and exclude are structural and stay with bookCatalog.applyOverrides, inside the build.
const FIELDS = Object.freeze(['title', 'author', 'narrator', 'edition', 'publisher', 'series', 'sequence']);
// Detection's source names, folded into the four the owner sees.
const DETECTED_SOURCE = Object.freeze({ folder: 'folder', album: 'plex', 'plex-artist': 'plex', tag: 'tag' });
const LOWER_SOURCES = new Set(['tag', 'plex', 'folder', null]);
const MAX_TEXT = 300;

const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function text(v) {
	return nonEmpty(v) ? v.trim().slice(0, MAX_TEXT) : null;
}

function numberOf(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
	if (nonEmpty(v) && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function idsOf(work) {
	if (!work || typeof work.id !== 'string' || !work.id) return [];
	const aliases = Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [];
	return [work.id, ...aliases];
}

/**
 * The work's book_overrides.json entry, looked up by its id and then each alias. Several entries
 * (an edit made before a rename and one after) are merged field by field, the current id first,
 * so neither is lost.
 * @returns {object|null} only the metadata keys and `exclude`
 */
function overrideFor(work, overrides) {
	const works = isObject(overrides) && isObject(overrides.works) ? overrides.works : null;
	if (!works) return null;
	let out = null;
	for (const id of idsOf(work)) {
		const e = has(works, id) ? works[id] : undefined;
		if (!isObject(e)) continue;
		out = out || {};
		for (const k of [...FIELDS, 'exclude']) if (has(e, k) && !has(out, k)) out[k] = e[k];
	}
	return out;
}

/**
 * The owner's section and Calibre pin for a work, found like overrideFor (id first, then each
 * alias), so both survive an id move. `calibre` is undefined with no pin, { id: null } for a pin
 * to none, else { id, uuid, library }.
 * @returns {{ genre: string|null, calibre: { id: number|null, uuid?: string|null, library?: string|null }|undefined }}
 */
function extrasFor(work, overrides) {
	const works = isObject(overrides) && isObject(overrides.works) ? overrides.works : null;
	const out = { genre: null, calibre: undefined };
	if (!works) return out;
	for (const id of idsOf(work)) {
		const e = has(works, id) ? works[id] : undefined;
		if (!isObject(e)) continue;
		if (out.genre === null && nonEmpty(e.genre)) out.genre = text(e.genre);
		if (out.calibre === undefined && has(e, 'calibreId')) {
			const n = numberOf(e.calibreId);
			if (e.calibreId === null) out.calibre = { id: null };
			else if (n !== undefined && Number.isInteger(n) && n > 0) out.calibre = { id: n, uuid: text(e.calibreUuid), library: text(e.calibreLibrary) };
		}
	}
	return out;
}

/**
 * The author-level entry, `authors[slug(author)]` = { series, order: { title: n } }, as
 * applyOverrides reads it. Keyed by the detected author, so a displayed author changed by an edit
 * or by Calibre keeps the entry; a hand-written key that is not a slug still counts. An entry
 * written before a rule change cleaned the detected author is keyed by the old one, which is the
 * first half of each alias, so it is found through those, after the current author.
 */
function authorOverrideFor(work, overrides) {
	const authors = isObject(overrides) && isObject(overrides.authors) ? overrides.authors : null;
	if (!authors || !work) return null;
	const d = isObject(work.detected) ? work.detected : {};
	const slugs = [d.author, work.author].filter((name) => !blank(name)).map((name) => bookCatalog.slug(name));
	for (const id of idsOf(work).slice(1)) {
		const i = id.indexOf('/');
		if (i > 0) slugs.push(id.slice(0, i));
	}
	for (const s of slugs) {
		if (has(authors, s) && isObject(authors[s])) return authors[s];
		const key = Object.keys(authors).find((k) => bookCatalog.slug(k) === s && isObject(authors[k]));
		if (key !== undefined) return authors[key];
	}
	return null;
}

// The titles an alias carries ("author/title~edition"), for an author order keyed by a title
// detection gave before a rule change.
function aliasTitles(work) {
	return idsOf(work).slice(1).map((id) => id.slice(id.indexOf('/') + 1).replace(/~.*$/, '')).filter(Boolean);
}

/** Calibre's metadata as the read-along pointer stores it, as catalog fields. */
function calibreFields(meta) {
	if (!isObject(meta)) return {};
	const out = {};
	const title = text(meta.title);
	if (title) out.title = title;
	const author = calibreMatch.displayAuthors(Array.isArray(meta.authors) ? meta.authors.map(text).filter(Boolean) : []);
	if (author) out.author = author;
	const series = text(meta.series);
	// Calibre gives every book a series index (1 by default), so the number counts only beside a
	// series name.
	if (series) {
		out.series = series;
		const n = numberOf(meta.seriesIndex);
		out.sequence = n === undefined ? null : n;
	}
	return out;
}

function detectedOf(work) {
	const d = isObject(work.detected) ? work.detected : null;
	const values = {};
	const sources = {};
	for (const f of FIELDS) {
		const v = d ? d[f] : work[f];
		values[f] = v === undefined ? null : v;
		const src = d && isObject(d.sources) ? d.sources[f] : null;
		sources[f] = values[f] === null ? null : (has(DETECTED_SOURCE, src) ? DETECTED_SOURCE[src] : null);
	}
	return { values, sources };
}

// smartTitle leaves a title with no lower-case letter as it is, so an all-capitals candidate would
// pass its test without being cased at all.
function caseFix(local, candidate) {
	if (!nonEmpty(local) || !nonEmpty(candidate) || local === candidate) return false;
	if (bookLookup.caseKey(local) !== bookLookup.caseKey(candidate)) return false;
	return /\p{Ll}/u.test(candidate) && bookCatalog.smartTitle(candidate) === candidate;
}

function sameSeries(a, b) {
	return nonEmpty(a) && nonEmpty(b) && bookLookup.normTitle(a) === bookLookup.normTitle(b);
}

function orderHit(order, titles) {
	if (!isObject(order)) return undefined;
	for (const t of titles) {
		if (blank(t)) continue;
		const key = Object.keys(order).find((k) => bookCatalog.slug(k) === bookCatalog.slug(t));
		if (key !== undefined && numberOf(order[key]) !== undefined) return numberOf(order[key]);
	}
	return undefined;
}

/**
 * The work with its display fields chosen by precedence and `sources` saying where each came from:
 * 'override', 'calibre', 'tag', 'plex', 'folder', 'online', or null for a field nothing gave.
 * @param {object} work a catalog work, ideally with `detected`
 * @param {object} [layers]
 * @param {object|null} [layers.override] from overrideFor()
 * @param {object|null} [layers.authorOverride] from authorOverrideFor()
 * @param {object|null} [layers.calibre] the read-along pointer's `meta`
 * @param {object|null} [layers.online] a bookLookup cache entry, already checked against the work
 * @returns {object} a new work object; the input is not changed
 */
function resolve(work, layers = {}) {
	if (!isObject(work)) return work;
	const { values: v, sources: src } = detectedOf(work);
	// A field the owner set, even to "none", is never filled from below.
	const locked = new Set();
	const set = (f, value, source) => { v[f] = value; src[f] = value === null && source !== 'override' ? null : source; };
	const open = (f) => !locked.has(f) && blank(v[f]);
	const titleFix = (candidate) => LOWER_SOURCES.has(src.title) && !locked.has('title') && caseFix(v.title, candidate);

	const o = isObject(layers.override) ? layers.override : {};
	const a = isObject(layers.authorOverride) ? layers.authorOverride : null;
	if (a && isObject(a.order)) {
		const n = orderHit(a.order, [work.detected && work.detected.title, v.title, o.title, ...aliasTitles(work)]);
		if (n !== undefined) {
			if (nonEmpty(a.series)) { set('series', text(a.series), 'override'); locked.add('series'); }
			set('sequence', n, 'override');
			locked.add('sequence');
		}
	}

	for (const f of ['title', 'author', 'narrator', 'edition', 'publisher', 'series']) {
		if (nonEmpty(o[f])) { set(f, text(o[f]), 'override'); locked.add(f); }
		// A book always has a title and an author; "none" is for the optional fields.
		else if (o[f] === null && f !== 'title' && f !== 'author') { set(f, null, 'override'); locked.add(f); }
	}
	if (o.sequence === null) { set('sequence', null, 'override'); locked.add('sequence'); }
	else if (numberOf(o.sequence) !== undefined) { set('sequence', numberOf(o.sequence), 'override'); locked.add('sequence'); }

	// An author-wide series with no order is a default for the author's books that have none.
	if (a && !isObject(a.order) && nonEmpty(a.series) && blank(v.series) && !locked.has('series')) set('series', text(a.series), 'override');

	const cal = calibreFields(layers.calibre);
	if (has(cal, 'title') && (open('title') || titleFix(cal.title))) set('title', cal.title, 'calibre');
	if (has(cal, 'author') && open('author')) set('author', cal.author, 'calibre');
	if (has(cal, 'series')) {
		// Calibre's number belongs to Calibre's series, so it fills only beside that series.
		const filledSeries = open('series');
		if (filledSeries) set('series', cal.series, 'calibre');
		if (cal.sequence !== null && open('sequence') && (filledSeries || sameSeries(v.series, cal.series))) set('sequence', cal.sequence, 'calibre');
	}

	if (isObject(layers.online)) {
		const c = bookLookup.compare(layers.online, { title: v.title, series: v.series, sequence: v.sequence, narrator: v.narrator, publisher: v.publisher });
		const fill = (f, kind) => kind === 'fill' && open(f);
		if ((fill('title', c.title.kind) || (c.title.kind === 'case-fix' && titleFix(text(c.title.value)))) && nonEmpty(c.title.value)) set('title', text(c.title.value), 'online');
		if (fill('series', c.series.kind) && nonEmpty(c.series.value)) set('series', text(c.series.value), 'online');
		if (fill('sequence', c.sequence.kind) && !blank(v.series) && numberOf(c.sequence.value) !== undefined) set('sequence', numberOf(c.sequence.value), 'online');
		// A cast has no single narrator to show, whether Audible says "full cast" or the local
		// edition is a cut-short cast list that detection declined to read as a narrator.
		const castEdition = !blank(v.edition) && blank(v.narrator) && v.edition !== v.publisher && !bookCatalog.publisherOf(v.edition);
		if (fill('narrator', c.narrator.kind) && !c.narrator.fullCast && !castEdition && nonEmpty(c.narrator.value)) set('narrator', text(c.narrator.value), 'online');
		if (fill('publisher', c.publisher.kind) && nonEmpty(c.publisher.value)) set('publisher', text(c.publisher.value), 'online');
	}

	const out = { ...work };
	for (const f of FIELDS) out[f] = v[f];
	out.sources = { ...src };
	return out;
}

/**
 * Every layer for one work. `onlineOf` is asked with the work as it stands without the online
 * layer, because the lookup's cache entry is keyed by that title and author.
 * @param {object} work
 * @param {object} ctx
 * @param {object} [ctx.overrides] the parsed book_overrides.json
 * @param {(work: object) => object|null} [ctx.calibreOf] the Calibre meta for a work, or null
 * @param {(work: object) => object|null} [ctx.onlineOf] the lookup's entry for a work, or null
 */
function layersFor(work, { overrides = {}, calibreOf = () => null, onlineOf = () => null } = {}) {
	const safe = (fn, w) => { try { return fn(w) || null; } catch (_) { return null; } };
	const override = overrideFor(work, overrides);
	const authorOverride = authorOverrideFor(work, overrides);
	const calibre = safe(calibreOf, work);
	const online = safe(onlineOf, resolve(work, { override, authorOverride, calibre }));
	return { override, authorOverride, calibre, online };
}

/** resolve(work, layersFor(work, ctx)). */
function resolveWith(work, ctx = {}) {
	return resolve(work, layersFor(work, ctx));
}

/** Whether resolving changed anything a reader would see. */
function differs(a, b) {
	if (!isObject(a) || !isObject(b)) return a !== b;
	return FIELDS.some((f) => (a[f] ?? null) !== (b[f] ?? null)) || JSON.stringify(a.sources || null) !== JSON.stringify(b.sources || null);
}

module.exports = {
	FIELDS,
	resolve,
	resolveWith,
	layersFor,
	overrideFor,
	extrasFor,
	authorOverrideFor,
	calibreFields,
	differs,
};
