// helpers/longForm.js
//
// Keeps catalogued audiobooks and podcasts out of music: random picks, mood picks, search,
// playlists, browse, sampling and Hitster all ask here.
//
// Membership in the book catalog, never duration: a length rule drops hour-long music mixes and
// still misses books cut into 6-minute chapters.
//
// The gate is read on every call. The catalog is built only while audiobooksEnabled is on, so a
// default install sees no change; once one exists, turning the feature off does not let books
// back into music, and only audiobooksExcludeFromMusic=false does.
//
// Artist-level exclusion is deliberate and matches the Plex fragment: a podcast artist's new
// episode album stays out of music before any rebuild has seen it, so every track by that
// artist is treated as long-form, here and server-side alike.

const config = require('../config/config');
const logger = require('./logger.js');
const bookCatalogStore = require('./bookCatalogStore.js');
const { partIdOf, norm } = require('./bookCatalog.js');

const ALSO_PREFIX = '📚 Also in your books:';
const ONLY_PREFIX = 'Those are audiobook chapters, not songs. 📚';
const ONLY_FALLBACK = '📚 That is in your audiobooks, not your music. `/book library` lists them.';
const PODCAST_ARTIST_FALLBACK = '📚 That belongs to an artist whose podcast is in your audiobook catalog, so it is kept out of music. Turning `audiobooksExcludeFromMusic` off, or excluding the podcast in `book_overrides.json`, brings it back.';
const REDIRECT_LIMIT = 3;

let warned = false;

function storeIndex() {
	try {
		return bookCatalogStore.index();
	} catch (err) {
		// A broken catalog must never break music, so it reads as "no catalog".
		if (!warned) {
			warned = true;
			logger.warn('Audiobook catalog unreadable; books are not kept out of music:', (err && err.message) || err);
		}
		return null;
	}
}

function nonEmpty(ix) {
	return !!ix && (ix.trackKeys.size + ix.albumKeys.size + ix.artistKeys.size + ix.partIds.size) > 0;
}

function activeIndex() {
	if (config.audiobooksExcludeFromMusic === false) return null;
	const ix = storeIndex();
	return nonEmpty(ix) ? ix : null;
}

/** @returns {boolean} whether catalogued audio is being kept out of music right now */
function enabled() {
	return activeIndex() !== null;
}

function has(set, v) {
	return v !== undefined && v !== null && v !== '' && set.has(String(v));
}

function trackIn(ix, t) {
	if (!t || typeof t !== 'object') return false;
	if (has(ix.trackKeys, t.ratingKey) || has(ix.albumKeys, t.parentRatingKey) || has(ix.artistKeys, t.grandparentRatingKey)) return true;
	for (const m of Array.isArray(t.Media) ? t.Media : []) {
		for (const p of (m && Array.isArray(m.Part)) ? m.Part : []) {
			if (p && has(ix.partIds, partIdOf(p.key))) return true;
		}
	}
	return false;
}

function albumIn(ix, a) {
	return !!a && typeof a === 'object' && (has(ix.albumKeys, a.ratingKey) || has(ix.artistKeys, a.parentRatingKey));
}

function artistIn(ix, a) {
	return !!a && typeof a === 'object' && has(ix.artistKeys, a.ratingKey);
}

// Queue entries carry only the part key, so the part id is the one identity they have.
function entryIn(ix, e) {
	return !!e && typeof e === 'object' && has(ix.partIds, partIdOf(e.key));
}

/** A Plex track (section listing, search hit or playlist item). */
function isLongFormTrack(t) {
	const ix = activeIndex();
	return !!ix && trackIn(ix, t);
}

/** A Plex album (type 9). */
function isLongFormAlbum(a) {
	const ix = activeIndex();
	return !!ix && albumIn(ix, a);
}

/** A Plex artist (type 8). */
function isLongFormArtist(a) {
	const ix = activeIndex();
	return !!ix && artistIn(ix, a);
}

/** A bot queue entry ({ key: '/library/parts/<id>/...' }). */
function isLongFormEntry(e) {
	const ix = activeIndex();
	return !!ix && entryIn(ix, e);
}

function kindOf(item) {
	if (!item || typeof item !== 'object') return null;
	if (item.type === 'track' || item.type === 'album' || item.type === 'artist') return item.type;
	if (Array.isArray(item.Media)) return 'track';
	if (partIdOf(item.key)) return 'entry';
	return null;
}

/** Any of the above, told apart by Plex's `type` or by shape. */
function isLongForm(item) {
	const ix = activeIndex();
	if (!ix) return false;
	switch (kindOf(item)) {
		case 'track': return trackIn(ix, item);
		case 'album': return albumIn(ix, item);
		case 'artist': return artistIn(ix, item);
		case 'entry': return entryIn(ix, item);
		default: return false;
	}
}

/**
 * Pure builder for the Plex section-listing filter. Plex reads a comma list after `!=` as "none
 * of these", and applies it to totalSize and Container-Start windowing as well as to the rows.
 * Only numeric keys pass, because the artist list can come from a hand-edited overrides file and
 * lands in a URL.
 */
function exclusionFragment(ix) {
	if (!ix) return '';
	const ids = (set) => [...set].filter((k) => /^\d+$/.test(k));
	const parts = [];
	const albums = ids(ix.albumKeys);
	const artists = ids(ix.artistKeys);
	if (albums.length) parts.push('album.id!=' + albums.join(','));
	if (artists.length) parts.push('artist.id!=' + artists.join(','));
	return parts.join('&');
}

/**
 * `album.id!=...&artist.id!=...` for a section listing, or '' when the exclusion is off or there
 * is no catalog. `/search` ignores it, so search results are filtered client-side instead.
 * Tracks of a partly catalogued album are not covered; listings that queue music also filter
 * client-side.
 */
function plexExclusion() {
	return exclusionFragment(activeIndex());
}

/** Appends plexExclusion() to a section-listing URL; the URL is unchanged when there is none. */
function withExclusion(url) {
	const fragment = plexExclusion();
	if (!fragment) return url;
	return url + (String(url).includes('?') ? '&' : '?') + fragment;
}

/** @returns {{ music: object[], books: object[] }} the tracks split, in their original order */
function partition(tracks) {
	const list = Array.isArray(tracks) ? tracks : [];
	const ix = activeIndex();
	if (!ix) return { music: [...list], books: [] };
	const music = [];
	const books = [];
	for (const t of list) (trackIn(ix, t) ? books : music).push(t);
	return { music, books };
}

const lookupCache = new WeakMap();

// Keyed on the index object, which bookCatalogStore replaces on every rebuild.
function lookups(ix) {
	let l = lookupCache.get(ix);
	if (l) return l;
	const byTrack = new Map();
	const byPart = new Map();
	const byAlbum = new Map();
	const byAuthor = new Map();
	const add = (map, k, w) => {
		if (k === undefined || k === null || k === '') return;
		const key = String(k);
		if (!map.has(key)) map.set(key, []);
		if (!map.get(key).includes(w)) map.get(key).push(w);
	};
	let works = [];
	try { works = bookCatalogStore.works(); } catch (_) { works = []; }
	for (const w of works) {
		add(byAuthor, norm(w.author || ''), w);
		for (const p of [...(w.parts || []), ...(w.dropped || [])]) {
			add(byTrack, p.trackRatingKey, w);
			add(byPart, partIdOf(p.partKey), w);
			add(byAlbum, p.albumRatingKey, w);
		}
	}
	l = { byTrack, byPart, byAlbum, byAuthor };
	lookupCache.set(ix, l);
	return l;
}

function worksOf(l, item) {
	switch (kindOf(item)) {
		case 'track': {
			const direct = l.byTrack.get(String(item.ratingKey));
			if (direct) return direct;
			for (const m of item.Media || []) {
				for (const p of (m && m.Part) || []) {
					const hit = l.byPart.get(String(partIdOf(p && p.key)));
					if (hit) return hit;
				}
			}
			return l.byAlbum.get(String(item.parentRatingKey)) || [];
		}
		case 'album': return l.byAlbum.get(String(item.ratingKey)) || [];
		// Works keep the author's name but not the Plex artist key.
		case 'artist': return l.byAuthor.get(norm(item.title || '')) || [];
		case 'entry': return l.byPart.get(String(partIdOf(item.key))) || [];
		default: return [];
	}
}

/** @returns {object[]} the catalog works behind these Plex items, first seen first, no repeats */
function worksFor(items) {
	const ix = activeIndex();
	if (!ix || !Array.isArray(items)) return [];
	const l = lookups(ix);
	const out = [];
	for (const item of items) {
		for (const w of worksOf(l, item)) if (!out.includes(w)) out.push(w);
	}
	return out;
}

function md(text) {
	return String(text).replace(/([\\`*_~|>])/g, '\\$1');
}

function playCommand(w) {
	return '/book play ' + String(w.title || w.id).toLowerCase().replace(/`/g, '');
}

/**
 * One line pointing at /book, e.g. "📚 Also in your books: The Glass Road (Avery Quill),
 * `/book play the glass road`". Editions sharing a title give one entry; /book play asks which.
 * @returns {string} '' when there are no works
 */
function redirectLine(works, prefix = ALSO_PREFIX) {
	const list = Array.isArray(works) ? works.filter((w) => w && typeof w === 'object') : [];
	const seen = new Set();
	const items = [];
	for (const w of list) {
		const cmd = playCommand(w);
		if (seen.has(cmd)) continue;
		seen.add(cmd);
		items.push(`${md(w.title || w.id)}${w.author ? ` (${md(w.author)})` : ''}, \`${cmd}\``);
	}
	if (!items.length) return '';
	const shown = items.slice(0, REDIRECT_LIMIT);
	const more = items.length - shown.length;
	return `${prefix} ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

// A podcast artist's other albums (a soundtrack, say) are caught by the artist key alone and
// belong to no work, so /book library does not list them.
function artistOnly(ix, item) {
	switch (kindOf(item)) {
		case 'track': return has(ix.artistKeys, item.grandparentRatingKey)
			&& !trackIn({ trackKeys: ix.trackKeys, albumKeys: ix.albumKeys, artistKeys: new Set(), partIds: ix.partIds }, item);
		case 'album': return has(ix.artistKeys, item.parentRatingKey) && !has(ix.albumKeys, item.ratingKey);
		default: return false;
	}
}

/** The pointer for long-form items no known work holds. */
function fallbackLine(items) {
	const ix = activeIndex();
	const list = Array.isArray(items) ? items : [];
	return ix && list.length && list.every((i) => artistOnly(ix, i)) ? PODCAST_ARTIST_FALLBACK : ONLY_FALLBACK;
}

/** The reply for a search whose every hit is long-form: the works when known, else a pointer. */
function onlyBooksLine(items) {
	return redirectLine(worksFor(items), ONLY_PREFIX) || fallbackLine(items);
}

module.exports = {
	enabled,
	isLongFormTrack,
	isLongFormAlbum,
	isLongFormArtist,
	isLongFormEntry,
	isLongForm,
	exclusionFragment,
	plexExclusion,
	withExclusion,
	partition,
	worksFor,
	redirectLine,
	onlyBooksLine,
	fallbackLine,
	ALSO_PREFIX,
	ONLY_PREFIX,
	ONLY_FALLBACK,
	PODCAST_ARTIST_FALLBACK,
};
