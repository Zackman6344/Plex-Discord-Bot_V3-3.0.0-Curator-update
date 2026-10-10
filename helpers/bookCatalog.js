// helpers/bookCatalog.js
//
// Turns a Plex music library listing into the long-form catalog: which tracks are parts of an
// audiobook or podcast, which work each belongs to, and in what order they play.
//
// Plex albums are not books on a hand-ripped library. Several books can share one album title, one
// album can hold the second half of one book and the whole of another, a single book can be spread
// over several albums under several artist spellings, and numbered volumes can be poured into one
// flat folder. What does line up is the folder on disk, so works are built from folders first and
// Plex albums second. Membership is never decided by track length: books with short chapter files
// would leak into music, and long music mixes would be taken for books.
//
// Pure (no fs, no Plex, no discord.js), so a rule change is tested against fixtures in
// milliseconds. Detection rules and constants are unchanged from the prototype that was checked
// by hand against a real library; RULES_VERSION goes up whenever a change here would build a
// different catalog from the same listing, so a stored catalog built under older rules is rebuilt.

const RULES_VERSION = 1;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const DETECT = Object.freeze({
	minTotalMs: 2 * HOUR,
	medianLongMs: 15 * MIN,
	signalTotalMs: 3 * HOUR,
	monoMinTracks: 20,
	podcastMedianMs: 20 * MIN,
});

const PUBLISHER_RE = /^(graphic\s*audio|grahpic\s*audio)(,?\s*llc)?$/i;
const NAME_SIGNAL_RE = /graphic\s*audio|grahpic\s*audio|unabridged|audio\s*book|\babook\b|narrat|\bread by\b|STORMLIGHT\d{4}/i;
const CHAPTER_TITLE_RE = /\b(chapter|chatper|chap\.?|prologue|epilogue|interlude|prelude)\b/i;
const EPISODE_RE = /\b(?:ep|episode)\.?\s*(\d+)/i;
const SAMPLE_RE = /^sample$/i;
const SPOKEN_GENRE_RE = /spoken|abook|audiobook/i;
const SAMPLE_MAX_MS = 5 * MIN;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const natural = (a, b) => collator.compare(String(a), String(b));

function norm(text) {
	return String(text || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function slug(text) {
	return norm(text).replace(/ /g, '-') || 'untitled';
}

function basename(file) {
	const segs = String(file || '').split(/[\\/]+/).filter(Boolean);
	return segs.length ? segs[segs.length - 1] : '';
}

function partIdOf(partKey) {
	const m = String(partKey || '').match(/^\/library\/parts\/(\d+)\//);
	return m ? m[1] : null;
}

function own(map, k) {
	return map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
}

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v) {
	return typeof v === 'string' && v.trim() !== '';
}

function partOf(t) {
	const m = t && t.Media && t.Media[0];
	return (m && m.Part && m.Part[0]) || {};
}

function containerOf(t) {
	const m = t && t.Media && t.Media[0];
	return String((m && m.container) || '').toLowerCase();
}

function segmentsOf(t) {
	return String(partOf(t).file || '').split(/[\\/]+/).filter(Boolean);
}

function median(nums) {
	const s = [...nums].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// mp3 ID3 CHAP frames come back from Plex too, but the ones seen were 5-minute "Marker N" points,
// so only mp4 containers and very long files are worth a probe.
function wantsChapters(t) {
	return /mp4|m4a|m4b/.test(containerOf(t)) || (t && t.duration || 0) > 2 * HOUR;
}

/**
 * A Plex `Chapter` array (or an already normalised list) reduced to the chapters worth seeking to.
 * @returns {Array<{title: string|null, startMs: number, endMs: number}> | 'markers' | 'none'}
 */
function normalizeChapters(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return 'none';
	const entries = raw.filter(isObject).map((x) => ({
		title: typeof x.title === 'string' ? x.title : (typeof x.tag === 'string' ? x.tag : null),
		startMs: Number(x.startMs !== undefined ? x.startMs : x.startTimeOffset),
		endMs: Number(x.endMs !== undefined ? x.endMs : x.endTimeOffset),
	}));
	const real = entries.filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs);
	if (real.length >= 2) return real.sort((a, b) => a.startMs - b.startMs);
	if (entries.length && entries.every((c) => c.startMs === c.endMs)) return 'markers';
	return 'none';
}

// "[01]", "(1 of 6)", "part 2", "Disc 3", "The Final Empire 2" all name one piece of a larger whole.
function stripPartMarker(name) {
	let s = String(name || '').trim();
	if (/^(part|disc|disk|cd|vol(ume)?)\s*\d+$/i.test(s)) return '';
	s = s.replace(/\s*\(\s*\d+\s*of\s*\d+\s*\)\s*$/i, '');
	s = s.replace(/\s*\[\s*\d+\s*\]\s*$/, '');
	s = s.replace(/\s*[-,]?\s*(part|disc|disk|cd)\s*\d+\s*$/i, '');
	s = s.replace(/\s+\d{1,2}\s*$/, '');
	return s.trim();
}

/** The artist field, split into the person who wrote it and the house that produced it. */
function splitArtist(artist) {
	const raw = String(artist || '').trim();
	const m = raw.match(/^(.*?)\s*\[(.+)\]\s*$/);
	const base = m ? m[1] : raw;
	const bracket = m ? m[2] : null;
	if (PUBLISHER_RE.test(base)) return { author: bracket, publisher: 'GraphicAudio' };
	return { author: base || bracket, publisher: null };
}

/** The folder directly under the library's "Music" root, taken to be the author or artist. */
function rootChild(t) {
	const segs = segmentsOf(t);
	const i = segs.findIndex((s) => /^music$/i.test(s));
	return i >= 0 && i + 2 < segs.length ? segs[i + 1] : null;
}

/** A folder key that is the same for every piece of one book. */
function folderKey(t) {
	const segs = segmentsOf(t);
	const dirs = segs.slice(0, -1);
	if (dirs.length === 0) return `album:${t.parentRatingKey}`;
	const leaf = dirs[dirs.length - 1];
	const parent = dirs[dirs.length - 2] || '';
	const stripped = stripPartMarker(leaf);
	if (!stripped || (parent && norm(parent).includes(norm(stripped)))) return dirs.slice(0, -1).join('/');
	if (stripped !== leaf) return dirs.slice(0, -1).concat(stripped).join('/');
	return dirs.join('/');
}

// Overrides name folders the way the rejected list prints them, but people type slashes and case
// however they like.
function matchKey(key) {
	return String(key || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function groupTracks(tracks) {
	const groups = new Map();
	for (const t of tracks) {
		const k = folderKey(t);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(t);
	}

	// One Plex album spread over sibling folders that nothing else uses is one work (a box set
	// ripped per book). Albums that share a folder with another album are left split, because
	// there the album tag is the thing that is wrong.
	const keysByAlbum = new Map();
	for (const [k, ts] of groups) {
		for (const t of ts) {
			const a = String(t.parentRatingKey);
			if (!keysByAlbum.has(a)) keysByAlbum.set(a, new Set());
			keysByAlbum.get(a).add(k);
		}
	}
	for (const [album, keys] of keysByAlbum) {
		if (keys.size < 2) continue;
		const exclusive = [...keys].every((k) => groups.has(k) && groups.get(k).every((t) => String(t.parentRatingKey) === album));
		if (!exclusive) continue;
		const parents = new Set([...keys].map((k) => k.split('/').slice(0, -1).join('/')));
		if (parents.size !== 1) continue;
		const merged = [...parents][0];
		const all = [];
		for (const k of keys) { all.push(...groups.get(k)); groups.delete(k); }
		groups.set(merged, (groups.get(merged) || []).concat(all));
	}
	return groups;
}

function groupStats(key, ts, albumsByKey) {
	const durations = ts.map((t) => t.duration || 0);
	const totalMs = durations.reduce((s, d) => s + d, 0);
	const media = ts.map((t) => (t.Media && t.Media[0]) || {});
	const mono = media.filter((m) => m.audioChannels === 1).length / ts.length;
	const bitrate = median(media.map((m) => m.bitrate || 0));
	const albums = [...new Set(ts.map((t) => String(t.parentRatingKey)))].map((k) => albumsByKey.get(k)).filter(Boolean);
	const genres = albums.flatMap((a) => (a.Genre || []).map((g) => g.tag));
	const names = [key, ...albums.map((a) => `${a.parentTitle} ${a.title}`), ...ts.map((t) => t.grandparentTitle)].join(' | ');
	const chapterShare = ts.filter((t) => CHAPTER_TITLE_RE.test(t.title) || CHAPTER_TITLE_RE.test(segmentsOf(t).pop())).length / ts.length;
	const episodeShare = ts.filter((t) => EPISODE_RE.test(t.title) || EPISODE_RE.test(segmentsOf(t).pop())).length / ts.length;
	return {
		n: ts.length, totalMs, medianMs: median(durations), maxMs: durations.reduce((m, d) => Math.max(m, d), 0),
		mono, bitrate, genres,
		nameSignal: NAME_SIGNAL_RE.test(names) || genres.some((g) => SPOKEN_GENRE_RE.test(g)) || chapterShare >= 0.3,
		chapterShare, episodeShare,
	};
}

function classify(s) {
	if (s.totalMs < DETECT.minTotalMs) return null;
	if (s.episodeShare >= 0.5 && s.medianMs >= DETECT.podcastMedianMs) return { kind: 'podcast', rule: 'episodes' };
	if (s.medianMs >= DETECT.medianLongMs) return { kind: 'book', rule: 'median' };
	if (s.nameSignal && s.totalMs >= DETECT.signalTotalMs) return { kind: 'book', rule: 'name-signal' };
	if (s.mono >= 0.8 && s.bitrate && s.bitrate <= 96 && s.n >= DETECT.monoMinTracks && s.totalMs >= DETECT.signalTotalMs) return { kind: 'book', rule: 'mono-low-bitrate' };
	return null;
}

function relPath(t, key) {
	const file = segmentsOf(t).join('/');
	return file.startsWith(key + '/') ? file.slice(key.length + 1) : file;
}

function leadingNumber(name) {
	const m = String(name).match(/^\s*(\d+)/);
	return m ? +m[1] : null;
}

// Several files in one folder sharing a leading track number means more than one numbered
// sequence was poured into the same folder.
function hasInterleavedNumbers(ts) {
	const byDir = new Map();
	for (const t of ts) {
		const segs = segmentsOf(t);
		const dir = segs.slice(0, -1).join('/');
		// "1-01", "2-01" are disc-track numbers, not a repeated "1".
		const m = String(segs[segs.length - 1]).match(/^\s*(\d+(?:[-.]\d+)*)/);
		if (!m) continue;
		const key = `${dir}#${m[1]}`;
		byDir.set(key, (byDir.get(key) || 0) + 1);
	}
	return [...byDir.values()].some((c) => c > 1);
}

/**
 * The play order of several numbered volumes dumped in one folder. Each volume restarts its
 * numbering at 01, so chapter numbers decide which volume a file belongs to; files without one
 * (intro, prelude, interlude, outro) go to the volume with a gap at their number. GraphicAudio's
 * own codes (STORMLIGHT0103P04 = book 01, volume 03, part 04) carry the volume outright. Best
 * effort: the work is marked low confidence and a partOrder override is the fix.
 */
function orderInterleaved(ts) {
	const info = ts.map((t) => {
		const file = segmentsOf(t).pop() || '';
		const stem = file.replace(/\.[^.]+$/, '');
		const code = stem.match(/STORMLIGHT(\d{2})(\d{2})P(\d{2})/i) || String(t.title).match(/STORMLIGHT(\d{2})(\d{2})P(\d{2})/i);
		const chap = (t.title + ' ' + stem).match(/\b(?:chapter|chatper)\s*(\d+)/i);
		const num = leadingNumber(stem);
		const cluster = stem.replace(/^\s*\d+\s*/, '').replace(/\s+-\s+.*$/, '').trim().toLowerCase();
		return { t, stem, num, cluster, code: code ? { vol: +code[2], part: +code[3] } : null, chapter: chap ? +chap[1] : null };
	});

	const coded = info.filter((i) => i.code);
	const rest = info.filter((i) => !i.code);
	const clusters = new Map();
	for (const i of rest) {
		if (!clusters.has(i.cluster)) clusters.set(i.cluster, []);
		clusters.get(i.cluster).push(i);
	}

	const volumes = [];
	for (const items of clusters.values()) {
		const chapters = items.filter((i) => i.chapter !== null && i.num !== null).sort((a, b) => a.chapter - b.chapter);
		const vols = [];
		let cur = null;
		for (const c of chapters) {
			if (!cur || c.num <= cur.lastNum) { cur = { items: [], slots: new Map(), lastNum: -1 }; vols.push(cur); }
			cur.items.push(c); cur.slots.set(c.num, c); cur.lastNum = c.num;
		}
		if (vols.length === 0) vols.push({ items: [], slots: new Map(), lastNum: -1 });
		const others = items.filter((i) => !(i.chapter !== null && i.num !== null)).sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
		for (const o of others) {
			const isOutro = /outro/i.test(o.stem);
			const n = o.num ?? 999;
			const candidates = vols.filter((v) => !v.slots.has(n) && !(isOutro && v.items.some((i) => /outro/i.test(i.stem))));
			const score = (v) => {
				const prev = v.slots.get(n - 1), next = v.slots.get(n + 1);
				return (prev && prev.chapter !== null ? 4 : prev ? 2 : 0) + (next && next.chapter !== null ? 3 : next ? 1 : 0);
			};
			const pick = candidates.sort((a, b) => score(b) - score(a))[0] || vols[0];
			pick.items.push(o); pick.slots.set(n, o);
		}
		for (const v of vols) {
			v.items.sort((a, b) => (a.num ?? 999) - (b.num ?? 999) || natural(a.stem, b.stem));
			v.minChapter = Math.min(...v.items.filter((i) => i.chapter !== null).map((i) => i.chapter), Infinity);
			volumes.push(v);
		}
	}
	volumes.sort((a, b) => a.minChapter - b.minChapter);

	const codedVols = new Map();
	for (const c of coded) {
		if (!codedVols.has(c.code.vol)) codedVols.set(c.code.vol, []);
		codedVols.get(c.code.vol).push(c);
	}
	for (const [vol, items] of [...codedVols].sort((a, b) => a[0] - b[0])) {
		items.sort((a, b) => a.code.part - b.code.part);
		volumes.splice(Math.min(vol - 1, volumes.length), 0, { items, coded: vol });
	}
	return volumes.flatMap((v) => v.items.map((i) => i.t));
}

function isSample(t) {
	return SAMPLE_RE.test(String(t.title).trim()) && (t.duration || 0) < SAMPLE_MAX_MS;
}

/**
 * Album play order for a podcast whose episode numbers restart in another album (a new season
 * or campaign in the same folder), or null when none repeat, so a podcast with one album per
 * episode keeps its episode order. Albums go by earliest air date when every album has one,
 * else by when Plex added them, then by rating key, which Plex hands out in the order it adds.
 */
function albumRanks(ts, ep, date) {
	const albumsOfEp = new Map();
	for (const t of ts) {
		const n = ep(t);
		if (!Number.isFinite(n)) continue;
		if (!albumsOfEp.has(n)) albumsOfEp.set(n, new Set());
		albumsOfEp.get(n).add(String(t.parentRatingKey));
	}
	if (![...albumsOfEp.values()].some((s) => s.size > 1)) return null;
	const albums = new Map();
	for (const t of ts) {
		const k = String(t.parentRatingKey);
		const a = albums.get(k) || { key: k, date: '', addedAt: Infinity };
		const d = date(t);
		if (d && (!a.date || d < a.date)) a.date = d;
		if (Number.isFinite(t.addedAt)) a.addedAt = Math.min(a.addedAt, t.addedAt);
		albums.set(k, a);
	}
	const list = [...albums.values()];
	const dated = list.every((a) => a.date);
	list.sort((a, b) => (dated ? natural(a.date, b.date) : 0) || a.addedAt - b.addedAt || natural(a.key, b.key));
	return new Map(list.map((a, i) => [a.key, i]));
}

function orderParts(kind, key, ts) {
	const kept = ts.filter((t) => !isSample(t));
	if (kind === 'podcast') {
		const ep = (t) => { const m = (t.title + ' ' + (segmentsOf(t).pop() || '')).match(EPISODE_RE); return m ? +m[1] : Infinity; };
		const date = (t) => t.originallyAvailableAt || '';
		const byEpisode = (a, b) => ep(a) - ep(b) || natural(date(a), date(b)) || (a.addedAt || 0) - (b.addedAt || 0);
		const rank = albumRanks(kept, ep, date);
		const byAlbum = rank ? (a, b) => rank.get(String(a.parentRatingKey)) - rank.get(String(b.parentRatingKey)) : () => 0;
		return { parts: [...kept].sort((a, b) => byAlbum(a, b) || byEpisode(a, b)), method: 'episode-number' };
	}
	if (hasInterleavedNumbers(kept)) return { parts: orderInterleaved(kept), method: 'interleaved-volumes' };
	return { parts: [...kept].sort((a, b) => natural(relPath(a, key), relPath(b, key))), method: 'path-natural' };
}

function cleanTitle(raw) {
	let s = String(raw || '');
	s = s.replace(/^\s*\d{4}\s*-\s*/, '');                 // "1990 - Title"
	s = s.replace(/\s+\d+\s*mb\s*$/i, '');                  // "... 541mb"
	s = s.replace(/^\s*\d+(\.\d+)?\s*[.\-_]\s*/, '');       // "1.Title", "05 - "
	s = s.replace(/\s*\([^)]*\)\s*$/, '');                  // "(Narrator)": kept as the edition instead
	s = stripPartMarker(s);
	return s.replace(/\s+/g, ' ').trim();
}

function parenOf(raw) {
	const m = String(raw || '').match(/\(([^)]+)\)/);
	if (!m) return null;
	const inner = m[1].replace(/\.{2,}|,\s*$/g, '').replace(/,\s*$/, '').trim();
	return /^\d+\s*of\s*\d+$/i.test(inner) ? null : inner || null;
}

function describe(key, ts, albumsByKey, titleCounts) {
	const albumKeys = [...new Set(ts.map((t) => String(t.parentRatingKey)))];
	const albums = albumKeys.map((k) => albumsByKey.get(k)).filter(Boolean);
	// A group carved out by an album include override has no folder of its own to be named after.
	const leaf = key.startsWith('album:') && albums[0] ? albums[0].title : key.split('/').pop();

	const artists = ts.map((t) => splitArtist(t.grandparentTitle));
	const authorVotes = {};
	for (const a of artists) if (a.author) authorVotes[a.author] = (authorVotes[a.author] || 0) + 1;
	let author = Object.entries(authorVotes).sort((a, b) => b[1] - a[1])[0];
	author = author ? author[0] : rootChild(ts[0]);
	const publisher = artists.some((a) => a.publisher) || /graphic\s*audio|grahpic/i.test(key + ts.map((t) => segmentsOf(t).pop()).join(' ')) ? 'GraphicAudio' : null;

	// The folder is the author folder (a flat dump): the album title is the only name there is.
	const folderIsAuthor = norm(leaf) === norm(rootChild(ts[0])) || norm(leaf) === norm(author);
	const singleAlbum = albums.length === 1 ? albums[0] : null;
	const albumTitleUsable = singleAlbum && (titleCounts.get(norm(singleAlbum.title)) || 0) === 1;

	let rawTitle = folderIsAuthor && singleAlbum ? singleAlbum.title : (albumTitleUsable ? singleAlbum.title : leaf);
	let series = null, sequence = null;

	const stormlight = (rawTitle + ' ' + key).match(/stormlight archive\s*(?:\[(\d+(?:\.\d+)?)\]|(\d+))?/i);
	const code = ts.map((t) => (t.title || '').match(/STORMLIGHT(\d{2})\d{2}P\d{2}/i)).find(Boolean);
	if (stormlight || code) {
		series = 'The Stormlight Archive';
		const fromKey = key.match(/stormlight archive\s*\[(\d+(?:\.\d+)?)\]/i);
		sequence = fromKey ? +fromKey[1] : stormlight && stormlight[2] ? +stormlight[2] : code ? +code[1] : null;
		rawTitle = rawTitle.replace(/^.*stormlight archive\s*(\[\d+(?:\.\d+)?\]|\d+)?\s*[:\-]?\s*/i, '');
	}

	const leadNum = String(leaf).match(/^\s*(\d+)\s*\./);
	if (!series && leadNum && albums.length) {
		// "1.Title" under an album named after the series: the album is the series.
		series = cleanTitle(albums[0].title.replace(/\(.*\)/, '')) || null;
		sequence = +leadNum[1];
	}

	const title = cleanTitle(rawTitle) || cleanTitle(leaf);
	const edition = parenOf(leaf) || albums.map((a) => parenOf(a.title)).find(Boolean) || publisher || null;
	return { title, author, series, sequence, edition, publisher, albums };
}

/** The four override lists and maps, with anything malformed read as absent. */
function cleanOverrides(raw) {
	const o = isObject(raw) ? raw : {};
	const map = (v) => (isObject(v) ? v : {});
	const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
	return {
		authors: map(o.authors),
		works: map(o.works),
		include: list(o.include),
		exclude: list(o.exclude),
		podcastArtists: list(o.podcastArtists),
	};
}

function toList(works) {
	if (Array.isArray(works)) return works.filter(isObject);
	return isObject(works) ? Object.values(works).filter(isObject) : [];
}

function sortKey(w) {
	return `${w.author || ''} ${w.series || ''} ${String(w.sequence ?? 999).padStart(5, '0')} ${w.title || ''}`;
}

function toObject(list) {
	const out = {};
	for (const w of [...list].sort((a, b) => natural(sortKey(a), sortKey(b)) || natural(a.id, b.id))) out[w.id] = w;
	return out;
}

function reorderParts(w, partOrder) {
	const byName = new Map();
	for (const p of w.parts) {
		const k = String(p.file || '').toLowerCase();
		if (!byName.has(k)) byName.set(k, []);
		byName.get(k).push(p);
	}
	const used = new Set();
	const ordered = [];
	const missing = [];
	for (const name of partOrder) {
		const k = basename(name).toLowerCase();
		const pick = (byName.get(k) || []).find((p) => !used.has(p));
		if (!pick) { missing.push(String(name)); continue; }
		used.add(pick);
		ordered.push(pick);
	}
	const rest = w.parts.filter((p) => !used.has(p));
	w.parts = [...ordered, ...rest].map((p, i) => ({ ...p, ordinal: i + 1 }));
	w.orderMethod = 'override';
	if (missing.length) w.notes.push(`partOrder names ${missing.length} file(s) not in this work: ${missing.slice(0, 3).join(', ')}`);
	if (rest.length) w.notes.push(`partOrder leaves ${rest.length} part(s) unlisted; they play after the listed ones`);
	if (!missing.length && !rest.length) w.confidence = 'high';
}

/**
 * Work-level overrides: author series and order, and per-work title, series, sequence, narrator,
 * edition, partOrder, exclude and pinId. Entries are keyed by the id detection gave the work, so
 * a title or pinId override cannot stop its own entry from matching on the next build.
 * @returns {Object<string, object>} new works keyed by (possibly pinned) id, sorted
 */
function applyOverrides(works, overrides) {
	const ov = cleanOverrides(overrides);
	const list = toList(works).map((w) => ({
		...w,
		aliases: Array.isArray(w.aliases) ? [...w.aliases] : [],
		notes: Array.isArray(w.notes) ? [...w.notes] : [],
		parts: Array.isArray(w.parts) ? w.parts : [],
	}));
	const taken = new Set(list.map((w) => w.id));
	const out = [];
	for (const w of list) {
		const a = own(ov.authors, slug(w.author));
		if (isObject(a)) {
			if (isObject(a.order)) {
				const hit = Object.keys(a.order).find((k) => slug(k) === slug(w.title));
				if (hit !== undefined && Number.isFinite(Number(a.order[hit]))) {
					if (nonEmpty(a.series)) w.series = a.series.trim();
					w.sequence = Number(a.order[hit]);
				}
			} else if (nonEmpty(a.series) && !w.series) {
				w.series = a.series.trim();
			}
		}

		const o = own(ov.works, w.id);
		if (!isObject(o)) { out.push(w); continue; }
		if (o.exclude === true) continue;
		for (const field of ['title', 'series', 'narrator', 'edition']) {
			if (nonEmpty(o[field])) w[field] = o[field].trim();
			else if (o[field] === null && field !== 'title') w[field] = null;
		}
		if (o.sequence === null) w.sequence = null;
		else if (o.sequence !== undefined && o.sequence !== '' && Number.isFinite(Number(o.sequence))) w.sequence = Number(o.sequence);
		if (Array.isArray(o.partOrder) && o.partOrder.length) {
			reorderParts(w, o.partOrder);
			w.totalMs = w.parts.reduce((s, p) => s + (p.durationMs || 0), 0);
		}
		if (nonEmpty(o.pinId) && o.pinId.trim() !== w.id) {
			const pin = o.pinId.trim();
			if (taken.has(pin)) {
				w.notes.push(`pinId ${pin} ignored: another work already has that id`);
			} else {
				taken.delete(w.id);
				taken.add(pin);
				if (!w.aliases.includes(w.id)) w.aliases.push(w.id);
				w.id = pin;
			}
		}
		out.push(w);
	}
	for (const w of out) w.aliases = w.aliases.filter((x) => x !== w.id);
	return toObject(out);
}

function shareOf(parts, keyOf, keys) {
	if (!parts.length) return 0;
	return parts.filter((p) => { const k = keyOf(p); return k !== null && keys.has(k); }).length / parts.length;
}

/**
 * Carries ids forward across a rebuild. A work whose id changed (a renamed folder, a corrected
 * title) is found again by its tracks, and its old id becomes an alias, so bookmarks saved under
 * it still resolve. Matching tries track ratingKeys, then basename plus size, then basename alone;
 * at least half the old parts must match, and a tie between candidates matches nothing (two
 * narrations of one book share every basename).
 * @returns {{ works: Object<string, object>, moved: Object<string, string> }} new works with
 *   aliases filled, and old id to new id for every work that moved
 */
function matchAliases(oldWorks, newWorks) {
	const olds = toList(oldWorks);
	const news = toList(newWorks).map((w) => ({ ...w, aliases: Array.isArray(w.aliases) ? [...w.aliases] : [] }));
	const newById = new Map(news.map((w) => [w.id, w]));
	const oldIds = new Set(olds.map((w) => w.id));
	const moved = {};

	for (const o of olds) {
		const same = newById.get(o.id);
		if (same) {
			for (const a of o.aliases || []) if (!same.aliases.includes(a)) same.aliases.push(a);
		}
	}

	const keyed = news.map((w) => {
		const parts = Array.isArray(w.parts) ? w.parts : [];
		return {
			w,
			isNew: !oldIds.has(w.id),
			rks: new Set(parts.map((p) => String(p.trackRatingKey))),
			sized: new Set(parts.map((p) => `${String(p.file || '').toLowerCase()}#${p.sizeBytes}`)),
			names: new Set(parts.map((p) => String(p.file || '').toLowerCase())),
		};
	});
	const aliased = new Set(news.flatMap((w) => w.aliases));

	for (const o of olds) {
		if (newById.has(o.id) || aliased.has(o.id)) continue;
		const parts = Array.isArray(o.parts) ? o.parts : [];
		if (!parts.length) continue;
		const tiers = [
			(c) => shareOf(parts, (p) => String(p.trackRatingKey), c.rks),
			(c) => shareOf(parts, (p) => (p.sizeBytes ? `${String(p.file || '').toLowerCase()}#${p.sizeBytes}` : null), c.sized),
			(c) => shareOf(parts, (p) => (p.file ? String(p.file).toLowerCase() : null), c.names),
		];
		let target = null;
		for (const score of tiers) {
			const ranked = keyed
				.map((c) => ({ c, s: score(c) }))
				.filter((x) => x.s >= 0.5)
				.sort((a, b) => b.s - a.s || Number(b.c.isNew) - Number(a.c.isNew));
			if (!ranked.length) continue;
			const [best, second] = ranked;
			if (second && second.s === best.s && second.c.isNew === best.c.isNew) break;
			target = best.c.w;
			break;
		}
		if (!target) continue;
		for (const a of [o.id, ...(o.aliases || [])]) {
			if (a !== target.id && !newById.has(a) && !target.aliases.includes(a)) target.aliases.push(a);
		}
		moved[o.id] = target.id;
	}

	const out = {};
	for (const w of news) {
		w.aliases = w.aliases.filter((a) => a !== w.id && !newById.has(a));
		out[w.id] = w;
	}
	return { works: out, moved };
}

/**
 * The membership lists music pickers filter by. albumKeys holds only albums whose every track is
 * catalogued; artistKeys holds artists whose every album is, the artists of detected podcasts
 * (so a new episode album stays out of music before any rebuild sees it) and podcastArtists.
 * @param {Object|Array} works
 * @param {{ albums?: object[], tracks?: object[] }} library the Plex listing the works came from
 * @param {object} [overrides]
 */
function buildIndex(works, { albums = [], tracks = [] } = {}, overrides = {}) {
	const ov = cleanOverrides(overrides);
	const list = toList(works);
	const trackKeys = new Set();
	const partIds = new Set();
	const add = (p) => {
		if (p.trackRatingKey !== undefined && p.trackRatingKey !== null) trackKeys.add(String(p.trackRatingKey));
		const id = partIdOf(p.partKey);
		if (id) partIds.add(id);
	};
	for (const w of list) {
		for (const p of w.parts || []) add(p);
		for (const p of w.dropped || []) add(p);
	}

	const tracksByKey = new Map();
	const albumTracks = new Map();
	const artistAlbums = new Map();
	const link = (artist, album) => {
		if (artist === undefined || artist === null) return;
		const k = String(artist);
		if (!artistAlbums.has(k)) artistAlbums.set(k, new Set());
		artistAlbums.get(k).add(String(album));
	};
	for (const t of tracks) {
		tracksByKey.set(String(t.ratingKey), t);
		const a = String(t.parentRatingKey);
		if (!albumTracks.has(a)) albumTracks.set(a, new Set());
		albumTracks.get(a).add(String(t.ratingKey));
		link(t.grandparentRatingKey, a);
	}
	for (const a of albums) link(a.parentRatingKey, a.ratingKey);

	const albumKeys = new Set();
	for (const [a, ts] of albumTracks) {
		if (ts.size && [...ts].every((k) => trackKeys.has(k))) albumKeys.add(a);
	}
	const artistKeys = new Set();
	for (const [artist, as] of artistAlbums) {
		if (as.size && [...as].every((a) => albumKeys.has(a))) artistKeys.add(artist);
	}
	for (const w of list) {
		if (w.kind !== 'podcast') continue;
		for (const p of w.parts || []) {
			const t = tracksByKey.get(String(p.trackRatingKey));
			if (t && t.grandparentRatingKey !== undefined && t.grandparentRatingKey !== null) artistKeys.add(String(t.grandparentRatingKey));
		}
	}
	for (const a of ov.podcastArtists) artistKeys.add(a);

	const sorted = (set) => [...set].sort(natural);
	return { trackKeys: sorted(trackKeys), albumKeys: sorted(albumKeys), artistKeys: sorted(artistKeys), partIds: sorted(partIds) };
}

function partFrom(t, ordinal, chapters) {
	const p = partOf(t);
	const out = {
		ordinal,
		albumRatingKey: String(t.parentRatingKey),
		trackRatingKey: String(t.ratingKey),
		title: t.title,
		durationMs: t.duration || 0,
		partKey: p.key || null,
		file: segmentsOf(t).pop() || null,
		sizeBytes: p.size || null,
		container: containerOf(t),
	};
	const ch = own(chapters, String(t.ratingKey));
	const list = Array.isArray(ch) ? normalizeChapters(ch) : ch;
	if (Array.isArray(list)) out.chapters = list.map((c) => ({ title: c.title, startMs: c.startMs, endMs: c.endMs }));
	return { part: out, markers: list === 'markers' };
}

/**
 * @param {object} input
 * @param {object[]} input.albums   Plex type=9 listing
 * @param {object[]} input.tracks   Plex type=10 listing, with Media and Part
 * @param {Object<string, Array|'markers'|'none'>} [input.chapters] by track ratingKey: a Plex
 *   `Chapter` array or a normalizeChapters() result
 * @param {object} [input.overrides] the hand-edited overrides file
 * @returns {{ works: Object<string, object>, rejected: object[], index: object, notes: string[] }}
 */
function buildCatalog({ albums = [], tracks = [], chapters = {}, overrides = {} } = {}) {
	const ov = cleanOverrides(overrides);
	const albumsByKey = new Map(albums.map((a) => [String(a.ratingKey), a]));
	const include = new Set(ov.include.map(matchKey));
	const exclude = new Set(ov.exclude.map(matchKey));
	const notes = [];

	// Album-level includes are carved out before grouping: such an album usually sits in a bucket
	// folder with unrelated music, and including the whole folder would drag that in too.
	const forced = new Map();
	const loose = [];
	for (const t of tracks) {
		const album = String(t.parentRatingKey);
		if (exclude.has(album)) continue;
		if (include.has(album)) {
			const k = `album:${album}`;
			if (!forced.has(k)) forced.set(k, []);
			forced.get(k).push(t);
		} else {
			loose.push(t);
		}
	}
	const groups = groupTracks(loose);
	for (const [k, ts] of forced) groups.set(k, ts);

	const candidates = [];
	const rejected = [];
	const reject = (key, stats, reason) => rejected.push({
		folderKey: key, tracks: stats.n, hours: +(stats.totalMs / HOUR).toFixed(2),
		medianMin: +(stats.medianMs / MIN).toFixed(1), maxMin: +(stats.maxMs / MIN).toFixed(1), reason,
	});
	for (const [key, ts] of groups) {
		const stats = groupStats(key, ts, albumsByKey);
		if (exclude.has(matchKey(key))) { reject(key, stats, 'excluded by override'); continue; }
		const wanted = forced.has(key) || include.has(matchKey(key)) || ts.some((t) => include.has(matchKey(folderKey(t))));
		const cls = classify(stats) || (wanted ? { kind: 'book', rule: 'override' } : null);
		if (cls) candidates.push({ key, ts, stats, cls });
		else if (stats.maxMs >= 15 * MIN || stats.totalMs >= 3 * HOUR) reject(key, stats, stats.totalMs < DETECT.minTotalMs ? 'under 2 h' : 'no long-form signal');
	}

	const titleCounts = new Map();
	for (const c of candidates) {
		for (const k of new Set(c.ts.map((t) => String(t.parentRatingKey)))) {
			const a = albumsByKey.get(k);
			if (a) titleCounts.set(norm(a.title), (titleCounts.get(norm(a.title)) || 0) + 1);
		}
	}

	const tracksByAlbum = new Map();
	for (const t of tracks) {
		const a = String(t.parentRatingKey);
		if (!tracksByAlbum.has(a)) tracksByAlbum.set(a, []);
		tracksByAlbum.get(a).push(t);
	}

	const works = candidates.map((c) => {
		const d = describe(c.key, c.ts, albumsByKey, titleCounts);
		const { parts, method } = orderParts(c.cls.kind, c.key, c.ts);
		const workNotes = [];
		const dupIdx = new Set();
		const seen = new Set();
		for (const t of c.ts) {
			if (t.index === undefined) continue;
			const k = `${t.parentRatingKey}:${t.parentIndex}:${t.index}`;
			if (seen.has(k)) dupIdx.add(k);
			seen.add(k);
		}
		if (dupIdx.size) workNotes.push(`${dupIdx.size} duplicated album/disc/index triples, so the Plex track index cannot order it`);
		if (c.ts.some((t) => t.index === undefined)) workNotes.push('some tracks have no index');
		if (d.albums.length > 1) workNotes.push(`spread over ${d.albums.length} Plex albums`);
		const mine = new Set(c.ts);
		const otherAlbumTracks = d.albums.some((a) => (tracksByAlbum.get(String(a.ratingKey)) || []).some((t) => !mine.has(t)));
		if (otherAlbumTracks) workNotes.push('shares a Plex album with another work');
		if (method === 'interleaved-volumes') workNotes.push('several numbered volumes share one folder; the order is rebuilt from chapter numbers and is worth one check, or a partOrder override');
		const kept = new Set(parts);
		const droppedTracks = c.ts.filter((t) => !kept.has(t));
		if (droppedTracks.length) workNotes.push(`${droppedTracks.length} sample clip(s) dropped`);

		let confidence = 'high';
		if (method === 'interleaved-volumes') confidence = 'low';
		else if (method === 'episode-number' || d.albums.length > 1 || dupIdx.size || otherAlbumTracks) confidence = 'medium';
		if (c.cls.rule !== 'median' && c.cls.rule !== 'episodes' && confidence === 'high') confidence = 'medium';

		let markers = false;
		const outParts = parts.map((t, i) => {
			const r = partFrom(t, i + 1, chapters);
			markers = markers || r.markers;
			return r.part;
		});
		if (markers) workNotes.push('some parts carry "Marker N" points rather than chapters; they are ignored');

		const series = c.cls.kind === 'podcast' && !d.series ? d.author : d.series;
		return {
			id: null,
			kind: c.cls.kind,
			title: d.title,
			author: d.author,
			narrator: d.edition && d.edition !== d.publisher ? d.edition : null,
			edition: d.edition,
			series: series || null,
			sequence: d.sequence ?? null,
			confidence,
			aliases: [],
			totalMs: outParts.reduce((s, p) => s + p.durationMs, 0),
			folderKey: c.key,
			detectedBy: c.cls.rule,
			orderMethod: method,
			notes: workNotes,
			parts: outParts,
			dropped: droppedTracks.map((t) => ({
				trackRatingKey: String(t.ratingKey), albumRatingKey: String(t.parentRatingKey), partKey: partOf(t).key || null,
			})),
		};
	});

	// Stable ids: author/title, with the edition appended only where two works would collide.
	const base = (w) => `${slug(w.kind === 'podcast' ? (w.series || w.author) : w.author)}/${slug(w.title)}`;
	const counts = {};
	for (const w of works) counts[base(w)] = (counts[base(w)] || 0) + 1;
	for (const w of works) w.id = counts[base(w)] > 1 ? `${base(w)}~${slug(w.edition || w.folderKey)}` : base(w);

	const detected = new Set(works.map((w) => w.id));
	for (const id of Object.keys(ov.works)) {
		if (!detected.has(id)) notes.push(`overrides name a work that was not detected: ${id}`);
	}

	const final = applyOverrides(works, ov);
	return { works: final, rejected, index: buildIndex(final, { albums, tracks }, ov), notes };
}

module.exports = {
	RULES_VERSION,
	DETECT,
	buildCatalog,
	applyOverrides,
	matchAliases,
	buildIndex,
	normalizeChapters,
	wantsChapters,
	cleanOverrides,
	folderKey,
	stripPartMarker,
	splitArtist,
	classify,
	orderInterleaved,
	cleanTitle,
	norm,
	slug,
	basename,
	partIdOf,
};
