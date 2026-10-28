// helpers/bookSearch.js
//
// Typed text against the catalog's works, past what bookCatalogStore.findWorks ranks: a query
// that names a whole series or author (optionally with a number, "mistborn 3"), and the typo
// fallback behind "Did you mean ...?". Pure functions over a works list the caller passes, so the
// engine's stub catalogs in tests need nothing new.
//
// The typo fallback only ever suggests. It runs after the normal search found nothing, and a
// loose match can land on the wrong book ("auto" is one edit from the start of "Autumn").

const crypto = require('crypto');
const bookCatalog = require('./bookCatalog.js');

const ARTICLES = new Set(['the', 'a', 'an']);
// Words that tell no title apart; a typo of "of" must not decide a match.
const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'book', 'vol', 'volume']);
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, first: 1, second: 2, third: 3 };
const NUMBER_LEAD = new Set(['book', 'vol', 'volume', 'part', 'no', 'number']);
const ROLE = / (illustrator|translator|transl|editor|narrator|foreword)$/;
// "Ed" or "An" would name half the library's authors by a surname ending.
const MIN_NAME = 3;
const SUGGEST_MAX = 5;
// The longest real title is about 106 characters; a longer query only costs time.
const QUERY_MAX = 120;

/** norm() after folding accents, which norm() alone turns into word breaks ("Penélope"). */
function key(text) {
	const s = text === null || text === undefined ? '' : String(text);
	return bookCatalog.norm(s.normalize('NFKD').replace(/[̀-ͯ]/g, ''));
}

/** A normalised text without one leading the/a/an, unless that is all there is. */
function bare(k) {
	const i = k.indexOf(' ');
	return i > 0 && ARTICLES.has(k.slice(0, i)) ? k.slice(i + 1) : k;
}

/** The series as it is compared: no article, and no "<author> - " in front of it. */
function seriesName(w) {
	if (!w || !w.series) return '';
	let s = key(w.series);
	const a = key(w.author);
	if (a && s.startsWith(`${a} `)) s = s.slice(a.length + 1);
	return bare(s);
}

/** Each person in an author field ("A, B - illustrator" or "A/B"), normalised, roles dropped. */
function authorNames(author) {
	return String(author || '').split(/\s*(?:[,;&/]|\band\b)\s*/i).map((n) => key(n).replace(ROLE, '')).filter(Boolean);
}

function seqOf(w) {
	if (!w || w.sequence === null || w.sequence === undefined || w.sequence === '') return NaN;
	return Number(w.sequence);
}

function inSeriesOrder(works, list) {
	const at = new Map(list.map((w, i) => [w, i]));
	const seq = (w) => (Number.isFinite(seqOf(w)) ? seqOf(w) : Infinity);
	return [...works].sort((a, b) => seriesName(a).localeCompare(seriesName(b)) || seq(a) - seq(b) || at.get(a) - at.get(b));
}

function shortest(values) {
	return values.filter(Boolean).sort((a, b) => a.length - b.length)[0] || '';
}

/** "mistborn 3", "murderbot #2" (norm drops the #), "wheel of time book one". */
function splitNumber(k) {
	const words = k.split(' ');
	if (words.length < 2) return null;
	const last = words[words.length - 1];
	const n = /^\d+$/.test(last) ? Number(last) : NUMBER_WORDS[last];
	if (n === undefined) return null;
	let base = words.slice(0, -1);
	if (base.length > 1 && NUMBER_LEAD.has(base[base.length - 1])) base = base.slice(0, -1);
	return { base: base.join(' '), number: n };
}

function seriesGroup(q, list) {
	if (q.length < MIN_NAME) return null;
	const works = list.filter((w) => {
		const s = seriesName(w);
		return s && (s === q || s.startsWith(`${q} `));
	});
	if (!works.length) return null;
	return {
		kind: 'series',
		name: shortest(works.map((w) => String(w.series).trim())),
		works: inSeriesOrder(works, list),
		oneSeries: new Set(works.map(seriesName)).size === 1,
	};
}

function authorGroup(q, list) {
	if (q.length < MIN_NAME) return null;
	const works = list.filter((w) => authorNames(w.author).some((n) => n === q || n.endsWith(` ${q}`)));
	if (!works.length) return null;
	const series = new Set(works.map(seriesName));
	return {
		kind: 'author',
		name: shortest(works.map((w) => String(w.author || '').trim())),
		works: inSeriesOrder(works, list),
		oneSeries: series.size === 1 && !series.has(''),
	};
}

/**
 * The series or author a query names, if any: the whole series name or its first words without
 * a leading article ("murderbot" for "The Murderbot Diaries"), or a whole author name or its
 * surname. A trailing number only ever goes with a series.
 * @returns {{ kind: 'series'|'author', name: string, works: object[], oneSeries: boolean, number: number|null }|null}
 */
function namedGroup(text, list) {
	const q = bare(key(text)).slice(0, QUERY_MAX);
	const split = splitNumber(q);
	if (split) {
		const g = seriesGroup(bare(split.base), list);
		if (g) return Object.assign(g, { number: split.number });
	}
	const g = seriesGroup(q, list) || authorGroup(q, list);
	return g ? Object.assign(g, { number: null }) : null;
}

// ---- the typo fallback ------------------------------------------------------------------------

/** Damerau-Levenshtein (optimal string alignment): a swapped pair of letters is one edit. */
function damerau(a, b) {
	const m = a.length;
	const n = b.length;
	if (!m) return n;
	if (!n) return m;
	let prev2 = null;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
			cur.push(d);
		}
		prev2 = prev;
		prev = cur;
	}
	return prev[n];
}

// A doubled or undoubled letter ("oddysey", "Conditioon") is the commonest typo after a swap.
function squeeze(s) {
	return s.replace(/(.)\1+/g, '$1');
}

// Squeezed, "zzzz" would be one edit from any one-letter word.
function distance(a, b) {
	const d = damerau(a, b);
	const sa = squeeze(a);
	const sb = squeeze(b);
	return sa.length >= 4 && sb.length >= 4 ? Math.min(d, damerau(sa, sb)) : d;
}

function budget(length) {
	return length >= 8 ? 2 : length >= 4 ? 1 : 0;
}

/**
 * Edits from a typed word to a word of the work, or -1. A word of 3 letters or fewer must be
 * exact or the start of the word. `partial` allows a typo in the start of a longer word, for the
 * last word typed (autocomplete sends half-typed text).
 */
function near(t, w, partial) {
	if (w.startsWith(t)) return 0;
	const b = budget(t.length);
	if (!b) return -1;
	const d = distance(t, w);
	if (d <= b) return d;
	if (partial && t.length >= 5 && w.length > t.length) {
		const p = distance(t, w.slice(0, t.length));
		if (p <= b) return p;
	}
	return -1;
}

/** Sum of the best edits for every token, or -1 when one token matches nothing. */
function cover(tokens, words, { partialLast = true } = {}) {
	let total = 0;
	for (let i = 0; i < tokens.length; i++) {
		const partial = partialLast && i === tokens.length - 1;
		let best = -1;
		for (const w of words) {
			const d = near(tokens[i], w, partial);
			if (d >= 0 && (best < 0 || d < best)) best = d;
			if (best === 0) break;
		}
		if (best < 0) return -1;
		total += best;
	}
	return total;
}

function contentWords(k) {
	return k.split(' ').filter((t) => t && !FILLER.has(t)).map((t) => (NUMBER_WORDS[t] !== undefined ? String(NUMBER_WORDS[t]) : t));
}

// Spacing typos: "oath bringer" is Oathbringer, "murder bot" the Murderbot Diaries.
function compactDistance(cq, cf) {
	if (!cf || cq.length < 4) return -1;
	if (cf.startsWith(cq)) return 0;
	const b = budget(cq.length);
	// Longer than the title by more than the budget can never match, and a pasted wall of text
	// would otherwise cost a full table against every title on the event loop.
	if (cq.length - cf.length > b) return -1;
	const d = distance(cq, cf);
	if (d <= b) return d;
	if (cq.length >= 5 && cf.length > cq.length) {
		const p = distance(cq, cf.slice(0, cq.length));
		if (p <= b) return p;
	}
	return -1;
}

function scoreWork(w, q) {
	const titleKey = bare(key(w.title));
	const series = seriesName(w);
	let best = null;
	const take = (score, dist) => {
		if (dist >= 0 && (!best || score > best.score || (score === best.score && dist < best.dist))) best = { score, dist };
	};
	// A number is matched as a word only: "mistbron3" is two edits from "mistborn", any book of it.
	if (!/\d/.test(q.compact)) {
		take(3, compactDistance(q.compact, titleKey.replace(/ /g, '')));
		take(3, compactDistance(q.compact, series.replace(/ /g, '')));
	}
	const titleWords = contentWords(titleKey);
	take(2, cover(q.tokens, titleWords));
	const seq = seqOf(w);
	const pool = titleWords.concat(contentWords(series), Number.isFinite(seq) ? [String(seq)] : []);
	take(2, cover(q.tokens, pool));
	const names = authorNames(w.author);
	// One word only ever matches a surname, whole: "auto" must not find Autumn Bardot.
	if (q.tokens.length === 1) {
		take(1, cover(q.tokens, names.map((n) => n.split(' ').pop()), { partialLast: false }));
	} else {
		const authorWords = names.flatMap((n) => contentWords(n));
		take(1, cover(q.tokens, pool.concat(authorWords), { partialLast: false }));
	}
	return best;
}

/**
 * Works a mistyped query probably meant, best first: the query with its spaces removed against a
 * title or series, then every word within a typo or two of a title or series word, then an
 * author. 1 edit is allowed for words of 4-7 letters and 2 for longer ones; shorter words must
 * match exactly. `rank(work)` breaks ties (lower first), so the caller can put the asker's own
 * books in progress first.
 * @param {string} text
 * @param {object[]} list every work
 * @param {{ limit?: number, rank?: (work: object) => number }} [opts]
 * @returns {object[]}
 */
function suggest(text, list, { limit = SUGGEST_MAX, rank = null } = {}) {
	const k = bare(key(text)).slice(0, QUERY_MAX);
	const tokens = contentWords(k);
	if (!tokens.length || !Array.isArray(list)) return [];
	const q = { tokens, compact: k.replace(/ /g, '') };
	const order = new Map(inSeriesOrder(list, list).map((w, i) => [w, i]));
	const scored = [];
	for (const w of list) {
		const s = scoreWork(w, q);
		if (s) scored.push(Object.assign(s, { w, r: rank ? rank(w) : 0 }));
	}
	scored.sort((a, b) => b.score - a.score || a.dist - b.dist || a.r - b.r || order.get(a.w) - order.get(b.w));
	return scored.slice(0, limit).map((x) => x.w);
}

/**
 * A stand-in for a work id too long for a button (Discord caps a custom_id at 100 characters, and
 * some ids built from long folder names are longer). It is found again by hashing every id, so
 * it survives a restart, and follows the work through its aliases when a rebuild moves its id.
 */
function shortKey(id) {
	return `~${crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16)}`;
}

/** @returns {object|null} the work whose shortKey this is, current ids before aliases */
function byShortKey(key, list) {
	if (typeof key !== 'string' || !key.startsWith('~') || !Array.isArray(list)) return null;
	return list.find((w) => w && shortKey(w.id) === key)
		|| list.find((w) => w && Array.isArray(w.aliases) && w.aliases.some((a) => shortKey(a) === key))
		|| null;
}

module.exports = { key, bare, seriesName, authorNames, seqOf, namedGroup, suggest, damerau, shortKey, byShortKey, SUGGEST_MAX };
