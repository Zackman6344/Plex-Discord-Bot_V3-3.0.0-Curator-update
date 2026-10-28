// helpers/calibreMatch.js
//
// Which Calibre record, if any, holds each audiobook work's book. Pure: the records come from the
// cached copy of the library helpers/calibreIndex.js keeps, so a whole catalog is matched in
// milliseconds with Calibre closed.
//
// The first rule that gives an answer wins:
//   1. the owner's pin (book_overrides.json works[id].calibreId, with the record's uuid and
//      library), or a pin to none (calibreId null), which forbids any match;
//   2. a `!book link` to a Calibre id, then the Calibre book the read-along already uses;
//   3. an ISBN the work carries;
//   4. the cleaned title and an author surname: 'exact';
//   5. the series, its number and an author surname: 'exact'. A record titled after the series
//      counts only when the number agrees;
//   6. one volume against the whole set, or title words overlapping by 0.6 or more, and an
//      author surname: 'likely'.
// Equal best answers are 'ambiguous' and never picked. Only 'exact' (pins and links included)
// may fill a blank catalog field; 'likely' only sorts a book into a section.
//
// The traps, each met in the owner's library:
//   - A record titled after its series ("Mistborn", which holds book one) against a work whose
//     title starts with the series name ("Mistborn - Collected Tales", #7). Cut down to the part
//     before " - ", the work's title is the series name, so a cut title that names a series is
//     never compared on its own.
//   - Two subtitles under one main title ("Heroes: X" and "Heroes: Y") are two books, so a main
//     title alone counts only when one side has no subtitle.
//   - Author strings with roles, houses and narrators in them ("Homer, Richmond Lattimore -
//     translator"). A surname must be the LAST word of one of the record's authors: Calibre's
//     search for "Jordan" also finds a Jordan Weisman.
//   - Two translations of one text (the Fitzgerald and Lattimore Iliads). A record naming the
//     work's translator ranks first; a record claimed by works with different translators stays
//     with the one whose translator it names, and is ambiguous for all of them when it names
//     none. Several narrations of one translation may share a record.

const bookCatalog = require('./bookCatalog.js');

const STOP = new Set(['the', 'a', 'an', 'of', 'and']);
const SERIES_FILLER = /\b(?:saga|series|cycle|archive|sequence)\b/gi;
const NUMBER_WORDS = Object.freeze({
	one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
	eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
	eighteen: '18', nineteen: '19', twenty: '20'
});
const NUMBER_RE = `(?:\\d+|${Object.keys(NUMBER_WORDS).join('|')})`;
const NOISE = [
	/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g,
	/\bpart\s+\d+\s+of\s+\d+\b/gi,
	/\b(?:read|narrated)\s+by\b.*$/i,
	/[,:;-]\s*a\s+novel\s*$/i,
	/\b(?:a\s+)?full[- ]cast\b.*$/i,
	/\bbbc\b/gi,
	new RegExp(`\\b(?:book|volume|vol)\\.?\\s+${NUMBER_RE}\\s+(?:of|in)\\s+(?:the\\s+)?.*$`, 'i'),
	/[,:-]\s*(?:[\w\s’']+?\s+series)?,?\s*book\s*\d*\s*$/i
];
const VOLUME_RE = new RegExp(`[,:-]?\\s*\\b(?:vol(?:ume)?|part|book)\\.?\\s*${NUMBER_RE}\\s*$`, 'i');
const MAIN_SPLIT = /\s*[:;]\s*|\s+-\s+|\s+by\s+/i;
const ROLE_RE = /\b(?:translator|translated|transl|illustrator|illustrated|editor|edited|narrator|narrated|foreword|introduction)\b\.?/gi;
const NOT_A_PERSON = /^(?:bbc\b.*|unknown|various|various authors|anonymous|mythology|full cast)$/i;
const TRANSLATOR_RES = [
	/([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3})\s*,?\s*(?:transl\b\.?|translator\b|trans\.)/,
	/\b(?:translated|transl\.?|translation)\s+by\s+([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3})/i
];
const OVERLAP = 0.6;
const RANK = { exact: 2, likely: 1 };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function deaccent(text) {
	return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function words(text) {
	return bookCatalog.norm(deaccent(text)).split(' ').filter(Boolean).map((w) => NUMBER_WORDS[w] || w);
}

function key(text) {
	return words(text).filter((w) => !STOP.has(w)).join(' ');
}

function cleanTitle(title) {
	let s = deaccent(title);
	for (const re of NOISE) s = s.replace(re, ' ');
	return s.replace(/\s+/g, ' ').trim();
}

/**
 * A title as keys: as given, with the noise taken out, the main title before a subtitle and what
 * follows it, and the cleaned title without a volume number. `cut` says the main title dropped
 * something.
 * @returns {{ full: string, clean: string, main: string, rest: string, loose: string, cut: boolean }}
 */
function titleVariants(title) {
	const cleaned = cleanTitle(title);
	const clean = key(cleaned);
	const pieces = cleaned.split(MAIN_SPLIT);
	const main = key(pieces[0]) || clean;
	return {
		full: key(title),
		clean,
		main,
		rest: pieces.length > 1 ? key(pieces.slice(1).join(' ')) : '',
		loose: key(cleaned.replace(VOLUME_RE, ' ')),
		cut: main !== clean
	};
}

function seriesKey(series) {
	return nonEmpty(series) ? key(String(series).replace(SERIES_FILLER, ' ')) : '';
}

function lastWord(name) {
	const ws = bookCatalog.norm(deaccent(String(name || '').replace(/\./g, '. '))).split(' ').filter(Boolean);
	return ws.length ? ws[ws.length - 1] : '';
}

/** The people in a catalog author string, with roles, houses, copyright notes and placeholders dropped. */
function authorNames(raw) {
	if (!nonEmpty(raw)) return [];
	const out = [];
	for (const part of deaccent(raw).replace(/&#\d+;.*$|©.*$/g, '').split(/\s*(?:&|,|\/|;|\band\b)\s*/i)) {
		const name = part.replace(ROLE_RE, ' ').replace(/[-–\s]+$/g, '').replace(/^[-–\s]+/g, '').trim();
		if (name && !NOT_A_PERSON.test(name)) out.push(name);
	}
	return out;
}

/** Surnames from a catalog author string. */
function authorSurnames(raw) {
	const out = [];
	for (const name of authorNames(raw)) {
		const s = lastWord(name);
		if (s.length > 1 && !/^\d+$/.test(s) && !out.includes(s)) out.push(s);
	}
	return out;
}

function recordSurnames(authors) {
	const out = [];
	for (const a of Array.isArray(authors) ? authors : []) {
		if (!nonEmpty(a) || NOT_A_PERSON.test(a.trim())) continue;
		const s = lastWord(a);
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

/** The surname of a translator named in the work's edition or titles, or null. */
function translatorOf(work) {
	const d = isObject(work.detected) ? work.detected : {};
	for (const text of [work.edition, d.edition, work.title, d.title]) {
		if (!nonEmpty(text)) continue;
		for (const re of TRANSLATOR_RES) {
			const m = re.exec(text);
			if (m) {
				const s = lastWord(m[1].replace(ROLE_RE, ' '));
				if (s.length > 1) return s;
			}
		}
	}
	return null;
}

function isbn13(raw) {
	const s = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
	if (/^97[89]\d{10}$/.test(s)) return s;
	if (!/^\d{9}[\dX]$/.test(s)) return null;
	const core = `978${s.slice(0, 9)}`;
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
	return `${core}${(10 - (sum % 10)) % 10}`;
}

function jaccard(a, b) {
	const x = new Set(String(a).split(' ').filter(Boolean));
	const y = new Set(String(b).split(' ').filter(Boolean));
	if (!x.size || !y.size) return 0;
	let both = 0;
	for (const w of x) if (y.has(w)) both++;
	return both / (x.size + y.size - both);
}

// A main title is the whole identity of a book only when one side has no subtitle, and never
// when it is just a series name.
function mainComparable(w, b, seriesNames) {
	if (!w.main || !b.main) return false;
	if (w.cut && b.cut) return false;
	if (w.cut && seriesNames.has(w.main)) return false;
	if (b.cut && seriesNames.has(b.main)) return false;
	return true;
}

/**
 * Title similarity of a work and a record, 0..1: the best of the titles as given, cleaned, and
 * (where comparable) their main titles. The read-along's own matcher uses it too.
 */
function titleScore(workTitle, workSeries, bookTitle, bookSeries) {
	const w = titleVariants(workTitle);
	const b = titleVariants(bookTitle);
	const names = new Set([seriesKey(workSeries), seriesKey(bookSeries)].filter(Boolean));
	let best = Math.max(jaccard(w.full, b.full), jaccard(w.clean, b.clean));
	if (mainComparable(w, b, names)) best = Math.max(best, jaccard(w.main, b.main));
	return best;
}

function numberOf(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function prepWork(work) {
	const d = isObject(work.detected) ? work.detected : {};
	return {
		titles: [...new Set([work.title, d.title].filter(nonEmpty))].map(titleVariants),
		series: seriesKey(work.series),
		sequence: numberOf(work.sequence),
		surnames: [...new Set([...authorSurnames(work.author), ...authorSurnames(d.author)])],
		authorWords: [...new Set([...authorNames(work.author), ...authorNames(d.author)].flatMap(words))],
		translator: translatorOf(work),
		isbn: isbn13(work.isbn)
	};
}

function prepBook(book) {
	return {
		title: titleVariants(book.title),
		series: seriesKey(book.series),
		titleAsSeries: seriesKey(cleanTitle(book.title)),
		index: numberOf(book.index),
		surnames: recordSurnames(book.authors),
		named: new Set([...recordSurnames(book.authors), ...words(book.title)]),
		isbn: isbn13(book.isbn)
	};
}

function without(text, drop) {
	return String(text).split(' ').filter((x) => x && !drop.includes(x)).join(' ');
}

// "Series: Title" on one side and "Title" on the other: the part after a series name is the title.
function afterSeries(t, other, names) {
	return t.cut && names.has(t.main) && !!t.rest && (t.rest === other.clean || t.rest === other.rest);
}

/** One work against one record: { verdict: 'exact'|'likely', method, score } or null. */
function score(w, b) {
	if (!w.surnames.some((s) => b.surnames.includes(s))) return null;
	const names = new Set([w.series, b.series].filter(Boolean));
	// A record naming the work's translator outranks any title tier of one that does not, so two
	// translations with a record each both find their own.
	const bonus = w.translator && b.named.has(w.translator) ? 0.5 : 0;
	let best = 0;
	let overlap = 0;
	let loose = false;
	for (const t of w.titles) {
		const main = mainComparable(t, b.title, names);
		if ((t.clean && t.clean === b.title.clean) || (t.full && t.full === b.title.full)) best = Math.max(best, 3);
		else if (afterSeries(t, b.title, names) || afterSeries(b.title, t, names)) best = Math.max(best, 2.9);
		else if (main && t.main === b.title.main) best = Math.max(best, 2.8);
		else {
			// "The Iliad of Homer" against "The Iliad": the author's name in a title is not the title.
			const plain = without(t.clean, w.authorWords);
			if (plain && plain === without(b.title.clean, w.authorWords)) best = Math.max(best, 2.7);
		}
		if (t.loose && t.loose === b.title.loose) loose = true;
		overlap = Math.max(overlap, jaccard(t.clean, b.title.clean), main ? jaccard(t.main, b.title.main) : 0);
	}
	if (best) return { verdict: 'exact', method: 'title and author', score: best + bonus };
	const numbered = w.sequence !== null && b.index !== null && b.index === w.sequence;
	if (w.series && numbered) {
		if (b.series && b.series === w.series) return { verdict: 'exact', method: 'series, number and author', score: 2.5 + bonus };
		if (!b.series && b.titleAsSeries === w.series) return { verdict: 'exact', method: 'record named after the series, number and author', score: 2.4 + bonus };
	}
	// One volume against the whole set ("The Age of Fable Vol 1" and "The Age of Fable"): the same
	// text, but never the same record's metadata.
	if (loose) return { verdict: 'likely', method: 'title without its volume number, and author', score: 1.9 + bonus };
	if (overlap >= OVERLAP) return { verdict: 'likely', method: `title overlap ${overlap.toFixed(2)} and author`, score: 1 + overlap + bonus };
	return null;
}

/**
 * @param {object} work a catalog work
 * @param {Object<string, object>} books the index's records by Calibre id (see calibreIndex)
 * @param {object} [opts]
 * @param {{ id: number|null, uuid?: string|null, library?: string|null }|null} [opts.pin]
 * @param {number|null} [opts.linkId] a `!book link` Calibre id
 * @param {number|null} [opts.pointerId] the read-along's own Calibre id for the work
 * @param {string|null} [opts.libraryId] the library the records come from
 * @param {Map} [opts.prepared] prepBook results by id, so a catalog prepares each record once
 * @returns {{ id: number|null, uuid: string|null, libraryId: string|null, verdict: string, method: string, candidates?: number[], problem?: string }}
 */
function matchWork(work, books, opts = {}) {
	const libraryId = opts.libraryId || null;
	const all = isObject(books) ? books : {};
	const recordOf = (id) => (Object.prototype.hasOwnProperty.call(all, String(id)) && isObject(all[String(id)]) ? all[String(id)] : null);
	const out = (id, verdict, method, extra = {}) => {
		const rec = id === null ? null : recordOf(id);
		return { id, uuid: rec && nonEmpty(rec.uuid) ? rec.uuid : null, libraryId, verdict, method, ...extra };
	};

	const pin = opts.pin;
	if (pin) {
		if (pin.id === null) return out(null, 'none', 'pin');
		const id = Number(pin.id);
		const rec = recordOf(id);
		if (nonEmpty(pin.library) && libraryId && pin.library !== libraryId) return out(id, 'none', 'pin', { problem: 'other-library' });
		if (!rec) return out(id, 'none', 'pin', { problem: 'missing' });
		if (nonEmpty(pin.uuid) && nonEmpty(rec.uuid) && pin.uuid !== rec.uuid) return out(id, 'none', 'pin', { problem: 'uuid-changed' });
		return out(id, 'exact', 'pin');
	}
	if (opts.linkId && recordOf(opts.linkId)) return out(Number(opts.linkId), 'exact', 'link');
	if (opts.pointerId && recordOf(opts.pointerId)) return out(Number(opts.pointerId), 'exact', 'read-along');

	const prepared = opts.prepared || new Map();
	const prep = (id) => {
		if (!prepared.has(id)) prepared.set(id, prepBook(recordOf(id)));
		return prepared.get(id);
	};
	const w = prepWork(work);
	const ids = Object.keys(all).filter((id) => isObject(all[id]));
	if (w.isbn) {
		const hits = ids.filter((id) => prep(id).isbn === w.isbn);
		if (hits.length === 1) return out(Number(hits[0]), 'exact', 'isbn');
		if (hits.length > 1) return out(null, 'ambiguous', 'isbn', { candidates: hits.map(Number) });
	}
	const found = [];
	for (const id of ids) {
		const s = score(w, prep(id));
		if (s) found.push({ id: Number(id), ...s });
	}
	if (!found.length) return out(null, 'none', 'no match');
	found.sort((a, b) => RANK[b.verdict] - RANK[a.verdict] || b.score - a.score || a.id - b.id);
	const top = found[0];
	const tied = found.filter((f) => f.verdict === top.verdict && f.score === top.score);
	if (tied.length > 1) return out(null, 'ambiguous', top.method, { candidates: tied.slice(0, 5).map((f) => f.id) });
	return out(top.id, top.verdict, top.method);
}

/**
 * Every work of a catalog, podcasts left out, with the translation guard applied across works.
 * @param {object[]} works
 * @param {Object<string, object>} books
 * @param {object} [opts]
 * @param {(work: object) => object|null} [opts.pinOf]
 * @param {(work: object) => number|null} [opts.linkOf]
 * @param {(work: object) => number|null} [opts.pointerOf]
 * @param {string|null} [opts.libraryId]
 * @returns {Object<string, object>} matchWork results by work id
 */
function matchAll(works, books, { pinOf = () => null, linkOf = () => null, pointerOf = () => null, libraryId = null } = {}) {
	const prepared = new Map();
	const out = {};
	const safe = (fn, w) => { try { return fn(w) || null; } catch (_) { return null; } };
	const list = (Array.isArray(works) ? works : []).filter((w) => isObject(w) && typeof w.id === 'string' && w.kind !== 'podcast');
	for (const w of list) {
		out[w.id] = matchWork(w, books, { pin: safe(pinOf, w), linkId: safe(linkOf, w), pointerId: safe(pointerOf, w), libraryId, prepared });
	}
	const auto = (m) => m.id !== null && (m.verdict === 'exact' || m.verdict === 'likely') && !['pin', 'link', 'read-along'].includes(m.method);
	const claims = new Map();
	for (const w of list) {
		const m = out[w.id];
		const t = translatorOf(w);
		if (!auto(m) || !t) continue;
		if (!claims.has(m.id)) claims.set(m.id, []);
		claims.get(m.id).push({ w, t });
	}
	for (const [id, cl] of claims) {
		if (new Set(cl.map((c) => c.t)).size < 2) continue;
		const named = prepared.has(String(id)) ? prepared.get(String(id)).named : new Set();
		const owners = cl.filter((c) => named.has(c.t));
		for (const c of cl) {
			if (owners.includes(c)) continue;
			out[c.w.id] = owners.length
				? { ...out[c.w.id], id: null, uuid: null, verdict: 'none', method: 'another translation' }
				: { ...out[c.w.id], id: null, uuid: null, verdict: 'ambiguous', method: 'translation not named', candidates: [id] };
		}
	}
	return out;
}

module.exports = {
	matchWork,
	matchAll,
	titleVariants,
	titleScore,
	cleanTitle,
	seriesKey,
	authorSurnames,
	recordSurnames,
	translatorOf,
	isbn13,
	key,
	words,
	OVERLAP,
};
