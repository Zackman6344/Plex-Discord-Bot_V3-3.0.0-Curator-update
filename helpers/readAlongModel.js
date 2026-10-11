// helpers/readAlongModel.js
//
// The arithmetic of the read-along: which ebook sections are the narrated body, which audio
// tracks are named after which chapters, the piecewise-linear map between a work's ms and the
// ebook's global word index, and the pages a section is shown in.
//
// Pure on purpose (no fs, no discord.js), so every sync decision is tested in milliseconds and
// runs on the bot's main thread in well under the voice timer's budget.
//
// The map is honest about what it knows: tracks named after a chapter pin that chapter
// ('chapter' level), hour splits between known points are interpolated by word count ('pace'),
// and intro/outro tracks carry no text ('none'). A later manual-marks feature only adds anchors
// (`extraAnchors`), nothing else changes.

// Shared with helpers/epubText.js countWords: the cache's word counts and this module's word
// offsets must agree exactly, or every page would drift from its index.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;

const BACK_KEYS = new Set(['ars-arcanum', 'endnote', 'postscript', 'afterword']);

const EXCERPT_LABELS = ['preview', 'excerpt', 'sneak\\s+peek', 'bonus\\s+chapter', 'read\\s+on\\b', 'teaser', 'coming\\s+soon'];
const AUX_LABELS = [
	'cover\\b', 'title\\b', 'half[- ]title', 'copyright', '(?:table of\\s+)?contents\\b', 'dedication', 'epigraph',
	'also\\s+by', '(?:other\\s+)?books\\s+by', 'praise\\b', 'maps?\\b', 'illustrations?\\b', 'acknowledg',
	'about\\s+the\\s+(?:author|publisher)', 'glossary', 'appendix', 'appendices', 'newsletter', 'index\\b',
	'frontispiece', 'author\'?s\\s+note', ...EXCERPT_LABELS,
];
const labelRe = (list) => new RegExp(`^(?:(?:a|an|the)\\s+)?(?:${list.join('|')})`, 'i');
const AUX_RE = labelRe(AUX_LABELS);
const EXCERPT_RE = labelRe(EXCERPT_LABELS);
const NO_TEXT_RE = /\b(?:intro|outro|credits|opening|closing|preview|trailer)\b/i;
const DRAMA_RE = /graphic\s*audio|grahpic|dramati[sz]ed|full[- ]cast/i;

const ONES = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
	eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
	eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ROMAN_RE = /^(?=[ivxlc])(c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100 };

const LEVEL_LABELS = { chapter: 'chapter-level', pace: 'estimated from pace', none: 'no text' };

// Kind priority for the longest-chain pick: a hand-set mark beats a track name, which beats the
// work's bare start and end.
const KIND_PRIORITY = { mark: 3, 'track-start': 2, 'track-end': 2, 'work-start': 1, 'work-end': 1, 'no-text': 0 };
// Sort rank at a shared ms: whatever ends there comes before a flat no-text stretch, which comes
// before whatever starts there, so segment levels pair a track's own start and end.
const KIND_RANK = { 'track-end': 0, 'work-end': 0, 'no-text': 1, mark: 1, 'track-start': 2, 'work-start': 2 };
const CHAIN_WEIGHT = 10000;

// An omnibus's first book often has no heading of its own: its title is the TOC label of a
// section that also holds chapter 1. A bare title page is far shorter than any chapter.
const HEADING_CHAPTER_MIN_WORDS = 200;
// Longer labels are an epigraph's or a passage's own text standing in for a missing TOC title.
const HEADING_MAX_LABEL_WORDS = 10;
const TITLE_STOP = new Set(['a', 'an', 'the', 'of', 'in', 'and', 'book']);
const TITLE_MATCH = 0.5;
const BOOK_SEP_RE = /\s+[-\u2013\u2014]+\s+|\s*[:,;]\s+/g;

function words(text) {
	const out = [];
	for (const m of String(text ?? '').matchAll(WORD_RE)) out.push({ start: m.index, end: m.index + m[0].length });
	return out;
}

function romanValue(s) {
	let total = 0;
	const t = s.toLowerCase();
	for (let i = 0; i < t.length; i++) {
		const v = ROMAN_VALUES[t[i]];
		const next = ROMAN_VALUES[t[i + 1]] || 0;
		total += v < next ? -v : v;
	}
	return total;
}

function wordsNumber(str, i) {
	const sep = /[\s-]*/y;
	const tok = /[a-z]+/iy;
	let pos = i;
	let value = 0;
	let end = -1;
	for (;;) {
		sep.lastIndex = pos;
		sep.exec(str);
		tok.lastIndex = sep.lastIndex;
		const m = tok.exec(str);
		if (!m) break;
		const w = m[0].toLowerCase();
		if (w === 'and' && value >= 100) { pos = tok.lastIndex; continue; }
		if (Object.prototype.hasOwnProperty.call(ONES, w)) value += ONES[w];
		else if (Object.prototype.hasOwnProperty.call(TENS, w)) value += TENS[w];
		else if (w === 'hundred' && value > 0 && value < 10) value *= 100;
		else break;
		end = tok.lastIndex;
		pos = end;
	}
	return end < 0 ? null : { value, end, roman: false };
}

// A number at str[i]: digits, a roman numeral, or English number words up to the hundreds.
function numberAt(str, i) {
	const rest = str.slice(i);
	let m = /^\d+/.exec(rest);
	if (m) return { value: Number(m[0]), end: i + m[0].length, roman: false };
	m = /^\p{L}+/u.exec(rest);
	if (!m) return null;
	if (ROMAN_RE.test(m[0])) return { value: romanValue(m[0]), end: i + m[0].length, roman: true, text: m[0] };
	return wordsNumber(str, i);
}

function numberAfter(str, i) {
	const skip = /^[\s#:.,\-\u2013\u2014]*/.exec(str.slice(i));
	return numberAt(str, i + skip[0].length);
}

function interludeKey(str, i) {
	const skip = /^[\s#:.,\-\u2013\u2014]*/.exec(str.slice(i));
	const a = numberAt(str, i + skip[0].length);
	if (!a || !(a.value > 0)) return 'i';
	const dash = /^\s*[-\u2013]\s*/.exec(str.slice(a.end));
	if (dash) {
		const b = numberAt(str, a.end + dash[0].length);
		if (b && b.value > 0) return `i${a.value}-${b.value}`;
	}
	return `i${a.value}`;
}

function labelKey(label) {
	const t = String(label ?? '').replace(/\s+/g, ' ').trim();
	if (!t) return null;
	let m = /^(\d+|[IVXL]+)-(\d+)(?![\p{L}\p{N}])/u.exec(t);
	if (m) {
		const a = /^\d+$/.test(m[1]) ? Number(m[1]) : (ROMAN_RE.test(m[1]) ? romanValue(m[1]) : 0);
		if (a > 0) return `i${a}-${Number(m[2])}`;
	}
	m = /^(chapter|chap|ch|interlude|prologue|prelude|epilogue|endnotes?|postscript|afterword|ars arcanum)(?!\p{L})\.?/iu.exec(t);
	if (m) {
		const w = m[1].toLowerCase();
		if (w.startsWith('ch')) {
			const n = numberAfter(t, m[0].length);
			return n && n.value > 0 ? `c${n.value}` : null;
		}
		if (w === 'interlude') return interludeKey(t, m[0].length);
		if (w === 'ars arcanum') return 'ars-arcanum';
		if (w.startsWith('endnote')) return 'endnote';
		return w;
	}
	m = /^(\d+)(?=$|[\s:.)\-\u2013\u2014])/.exec(t);
	if (m) return Number(m[1]) > 0 ? `c${Number(m[1])}` : null;
	// A bare roman or worded number counts only as the whole label or before ':' / '.', so
	// "One Last Thing" or "I Am Here" stay unkeyed.
	const n = numberAt(t, 0);
	if (n && n.value > 0 && (!n.roman || n.text === n.text.toUpperCase())) {
		if (/^(?:\s*$|\s*[:.]|\s+[-\u2013\u2014]\s)/.test(t.slice(n.end))) return `c${n.value}`;
	}
	return null;
}

function keyClass(key) {
	if (!key) return null;
	return BACK_KEYS.has(key) ? 'back' : 'chapter';
}

function keysMatch(a, b) {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a[0] !== 'i' || b[0] !== 'i') return false;
	const ia = /^i(\d+)(?:-(\d+))?$/.exec(a);
	const ib = /^i(\d+)(?:-(\d+))?$/.exec(b);
	if (!ia || !ib || (ia[2] && ib[2])) return false;
	return (ia[2] || ia[1]) === (ib[2] || ib[1]);
}

// Optimal-string-alignment distance: enough to forgive 'Chatper' and 'Prolouge'.
function editDistance(a, b) {
	const n = a.length;
	const m = b.length;
	const d = Array.from({ length: n + 1 }, (_, i) => {
		const row = new Array(m + 1).fill(0);
		row[0] = i;
		return row;
	});
	for (let j = 0; j <= m; j++) d[0][j] = j;
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[n][m];
}

const FUZZY_KEYWORDS = ['chapter', 'prologue', 'prelude', 'epilogue', 'interlude', 'endnote', 'postscript', 'afterword'];
// Track titles repeat the same few words hundreds of times per work; the fuzzy compare is the
// costly part of a map build, so each token is judged once.
const KEYWORD_CACHE = new Map();
const KEYWORD_CACHE_MAX = 2000;

function keywordOf(tok) {
	if (tok === 'ch' || tok === 'chap' || tok === 'chapt' || tok === 'chpt') return 'chapter';
	if (tok === 'ars') return 'ars';
	if (tok.length < 5) return null;
	if (KEYWORD_CACHE.has(tok)) return KEYWORD_CACHE.get(tok);
	let found = null;
	for (const kw of FUZZY_KEYWORDS) {
		const max = kw === 'chapter' && tok.length >= 6 ? 2 : 1;
		if (Math.abs(tok.length - kw.length) > max) continue;
		if (editDistance(tok, kw) <= max) { found = kw; break; }
	}
	if (KEYWORD_CACHE.size >= KEYWORD_CACHE_MAX) KEYWORD_CACHE.clear();
	KEYWORD_CACHE.set(tok, found);
	return found;
}

function stripWorkTitle(title, workTitle) {
	const wt = String(workTitle ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
	if (!wt || !wt.length) return title;
	const re = /[\p{L}\p{N}]+/gu;
	let k = 0;
	let end = 0;
	for (const m of title.matchAll(re)) {
		if (m[0].toLowerCase() !== wt[k]) return title;
		k++;
		end = m.index + m[0].length;
		if (k === wt.length) return title.slice(end);
	}
	return title;
}

function partKey(title, { workTitle = '' } = {}) {
	let t = stripWorkTitle(String(title ?? ''), workTitle);
	t = t.replace(/^\s*\d{1,4}(?:\s*[-.:_)]\s*|\s+)(?=\D)/, '');
	for (const m of t.matchAll(/\p{L}+/gu)) {
		const kw = keywordOf(m[0].toLowerCase());
		if (!kw) continue;
		const end = m.index + m[0].length;
		if (kw === 'ars') {
			const next = /^\s+(\p{L}+)/u.exec(t.slice(end));
			if (next && editDistance(next[1].toLowerCase(), 'arcanum') <= 1) return 'ars-arcanum';
			continue;
		}
		if (kw === 'chapter') {
			const n = numberAfter(t, end);
			if (n && n.value > 0) return `c${n.value}`;
			continue;
		}
		if (kw === 'interlude') return interludeKey(t, end);
		return kw;
	}
	return null;
}

function isNoTextPart(part, { workTitle = '' } = {}) {
	const title = String((part && part.title) ?? '');
	return NO_TEXT_RE.test(title) && !partKey(title, { workTitle });
}

// An omnibus track: "1-02 Book 1  The Sword of Testing - Chapter 01a" gives book 1, its title,
// and "Chapter 01a" as the rest, which carries the chapter key. The rest starts at the last
// separator that still leaves a chapter key (else a no-text word), so a book title may hold
// separators of its own and "Chapter 3: The Opening" stays one chapter. A book named after the
// chapter ("Chapter 3 - Book 2 of Ash") is part of that chapter's own title.
function bookOfPart(title, { workTitle = '' } = {}) {
	const t = stripWorkTitle(String(title ?? ''), workTitle);
	const m = /(?:^|[^\p{L}\p{N}])book\s+/iu.exec(t);
	if (!m || partKey(t.slice(0, m.index))) return null;
	const from = m.index + m[0].length;
	// A worded number stops at the separator, so "Book One - Two Swords" is book 1, not 3.
	const stop = new RegExp(BOOK_SEP_RE.source).exec(t.slice(from));
	const n = numberAt(stop ? t.slice(0, from + stop.index) : t, from);
	if (!n || !(n.value > 0) || (n.roman && n.text !== n.text.toUpperCase())) return null;
	if (/^[\p{L}\p{N}]/u.test(t.slice(n.end))) return null;
	const body = t.slice(n.end).replace(/^[\s:.,;\-\u2013\u2014]+/, '');
	const after = (s) => body.slice(s.index + s[0].length);
	const cuts = [...body.matchAll(BOOK_SEP_RE)].reverse();
	const split = (cut) => ({ number: n.value, title: body.slice(0, cut.index).trim(), rest: after(cut) });
	const keyed = cuts.find((s) => partKey(after(s)));
	if (keyed) return split(keyed);
	if (partKey(body)) return { number: n.value, title: '', rest: body };
	const quiet = cuts.find((s) => NO_TEXT_RE.test(after(s)));
	if (quiet) return split(quiet);
	return NO_TEXT_RE.test(body) ? { number: n.value, title: '', rest: body } : { number: n.value, title: body.trim(), rest: '' };
}

function withWordStarts(sections) {
	const list = Array.isArray(sections) ? sections : [];
	if (list.every((s) => Number.isFinite(s.wordStart))) return list;
	let w = 0;
	return list.map((s) => {
		const out = { ...s, wordStart: w };
		w += s.words || 0;
		return out;
	});
}

function classifySections(sections, { performedKeys = new Set(), keyOverrides = null } = {}) {
	const performed = [...performedKeys].filter(Boolean);
	const isPerformed = (key) => performed.some((k) => keysMatch(k, key));
	const list = withWordStarts(sections).map((s, i) => ({
		...s, key: keyOverrides && keyOverrides.has(i) ? keyOverrides.get(i) : labelKey(s.label),
	}));
	const info = list.map((s) => {
		const label = String(s.label ?? '').trim();
		const kc = keyClass(s.key);
		const chapter = kc === 'chapter' || (kc === 'back' && isPerformed(s.key));
		const backOut = kc === 'back' && !chapter;
		const aux = !s.key && AUX_RE.test(label);
		const excerpt = !s.key && EXCERPT_RE.test(label);
		const words = s.words || 0;
		return { chapter, backOut, excerpt, bodyish: words > 0 && (chapter || (!aux && !backOut && words >= 50)) };
	});
	let startIdx = list.findIndex((s, i) => info[i].chapter && s.words > 0);
	if (startIdx < 0) startIdx = list.findIndex((s, i) => info[i].bodyish);
	let endIdx = startIdx;
	if (startIdx >= 0) {
		const last = list[list.length - 1];
		const totalWords = last.wordStart + (last.words || 0);
		const mid = (list[startIdx].wordStart + totalWords) / 2;
		// A next-book preview often has its own "Chapter One"; cutting the body before the first
		// excerpt past the midpoint keeps it from stretching the pace map.
		let limit = list.findIndex((s, i) => i > startIdx && info[i].excerpt && s.wordStart >= mid);
		if (limit < 0) limit = list.length;
		for (let i = limit - 1; i >= startIdx; i--) {
			if (info[i].bodyish) { endIdx = i + 1; break; }
		}
	}
	const out = list.map((s, i) => {
		let matter;
		if (!(s.words > 0)) matter = 'empty';
		else if (startIdx < 0 || i < startIdx) matter = 'front';
		else if (i >= endIdx || info[i].backOut) matter = 'back';
		else matter = 'body';
		return { ...s, matter };
	});
	const hasBody = startIdx >= 0 && endIdx > startIdx;
	const bodyStartWord = hasBody ? out[startIdx].wordStart : 0;
	const bodyEndWord = hasBody ? out[endIdx - 1].wordStart + (out[endIdx - 1].words || 0) : 0;
	return {
		sections: out,
		bodyStartIndex: hasBody ? startIdx : 0,
		bodyEndIndex: hasBody ? endIdx : 0,
		bodyStartWord,
		bodyEndWord,
	};
}

function isBookHeading(s) {
	const label = String(s.label ?? '').trim();
	if (!label || s.key || AUX_RE.test(label)) return false;
	const n = (label.match(/[\p{L}\p{N}]+/gu) || []).length;
	return n > 0 && n <= HEADING_MAX_LABEL_WORDS;
}

// The books of an omnibus ebook: the chapter numbering restarts under a titled heading for each
// new book. A heading section that holds a chapter's worth of text right before chapter 2 is that
// book's chapter 1. Title pages and epigraphs between books stay outside every book's chapters.
function ebookBooks(list) {
	const chapters = [];
	list.forEach((s, i) => {
		const m = /^c(\d+)$/.exec(s.key || '');
		if (m) chapters.push({ index: i, n: Number(m[1]) });
	});
	const books = [];
	chapters.forEach((c, j) => {
		const prev = chapters[j - 1];
		if (prev && !(c.n <= 2 && c.n < prev.n)) return;
		const floor = prev ? prev.index : -1;
		let heading = -1;
		for (let i = c.index - 1; i > floor; i--) {
			// A later piece of a section the cache split is labelled like its first piece plus " (2)".
			if (list[i].part > 1) continue;
			if (isBookHeading(list[i])) { heading = i; break; }
		}
		if (prev && heading < 0) return;
		const between = list.slice(heading + 1, c.index);
		const chapterOne = heading >= 0 && c.n === 2 && list[heading].words >= HEADING_CHAPTER_MIN_WORDS
			&& between.every((s) => s.part > 1) ? heading : -1;
		// An empty heading right before a short-label page is the book's own; that page is an
		// epigraph or a subtitle, and its label must not pair the book by title.
		if (chapterOne < 0) {
			while (heading - 1 > floor && !(list[heading - 1].words > 0) && isBookHeading(list[heading - 1])) heading--;
		}
		const h = heading >= 0 ? list[heading] : null;
		books.push({ title: h ? String(h.label).trim() : '', from: heading >= 0 ? heading : c.index, chapterOne });
	});
	if (books.length < 2) return null;
	books.forEach((b, k) => {
		b.to = k + 1 < books.length ? books[k + 1].from : list.length;
		let last = -1;
		for (let i = b.from; i < b.to; i++) if (list[i].key || i === b.chapterOne) last = i;
		b.endWord = last >= 0 ? list[last].wordStart + (list[last].words || 0) : list[b.from].wordStart;
	});
	return books;
}

function titleWords(title) {
	return new Set((String(title ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !TITLE_STOP.has(w)));
}

function titleSimilarity(a, b) {
	const x = titleWords(a);
	const y = titleWords(b);
	if (!x.size || !y.size) return 0;
	let both = 0;
	for (const w of x) if (y.has(w)) both++;
	return both / (x.size + y.size - both);
}

// Audio book n reads ebook book n - 1 + shift, so a recording that starts at book 2 reads book 2.
// The shift is the one most title-matched books agree on (an ebook that lacks the first books),
// else 0, else the one that puts the lowest recorded number first when the numbers run past the
// ebook's books. A title match further on moves the pairing from there, and an unmatched book
// whose place the next book's title claims is one the ebook lacks. A book the two editions title
// differently keeps its numbered place.
function pairBooks(audio, ebook) {
	const matched = audio.map((a) => ebook.findIndex((b) => titleSimilarity(a.title, b.title) >= TITLE_MATCH));
	const votes = new Map();
	audio.forEach((a, k) => {
		if (matched[k] < 0) return;
		const s = matched[k] - (a.number - 1);
		votes.set(s, (votes.get(s) || 0) + 1);
	});
	const numbers = audio.map((a) => a.number);
	let shift = Math.max(...numbers) <= ebook.length ? 0 : 1 - Math.min(...numbers);
	let best = 0;
	for (const [s, n] of votes) {
		if (n > best || (n === best && Math.abs(s) < Math.abs(shift))) {
			shift = s;
			best = n;
		}
	}
	const pairs = new Map();
	let last = -1;
	audio.forEach((a, k) => {
		let e = a.number - 1 + shift;
		if (matched[k] > last && matched[k] !== e) {
			e = matched[k];
			shift = e - (a.number - 1);
		} else if (matched[k] < 0 && e >= 0 && matched[k + 1] === e) {
			shift--;
			return;
		}
		if (e > last && e < ebook.length) {
			pairs.set(a.number, e);
			last = e;
		}
	});
	return pairs;
}

// Chapter numbers restart in every book of an omnibus, so a chapter key means something only
// inside its book. Null unless both the tracks and the ebook name at least two books.
function bookPlan(parts, sections, workTitle) {
	const info = parts.map((p) => bookOfPart(p && p.title, { workTitle }));
	const audio = [];
	for (const b of info) {
		if (!b) continue;
		const seen = audio.find((a) => a.number === b.number);
		if (!seen) audio.push({ number: b.number, title: b.title });
		else if (!seen.title) seen.title = b.title;
	}
	if (audio.length < 2) return null;
	const ebook = ebookBooks(withWordStarts(sections).map((s) => ({ ...s, key: labelKey(s.label) })));
	if (!ebook) return null;
	const pairs = pairBooks(audio, ebook);
	const keys = parts.map((p, i) => (info[i] ? partKey(info[i].rest) : partKey(p && p.title, { workTitle })));
	// Hour splits that name books carry no chapter to place inside a book, so plain pace serves them.
	if (!keys.some(Boolean)) return null;
	const absent = info.map((b) => !!b && !pairs.has(b.number));
	const sectionBook = new Array(sections.length).fill(-1);
	ebook.forEach((b, k) => { for (let i = b.from; i < b.to; i++) sectionBook[i] = k; });
	return {
		audio: audio.map((a) => ({ ...a, ebook: pairs.has(a.number) ? pairs.get(a.number) : -1 })),
		ebook,
		keys,
		// An audio book the ebook lacks is cut out of the time axis like an intro, so it never
		// stretches the pace map past the last book that has text.
		noText: parts.map((p, i) => absent[i] || (info[i] ? NO_TEXT_RE.test(info[i].rest) && !keys[i] : isNoTextPart(p, { workTitle }))),
		partBook: info.map((b) => (b && pairs.has(b.number) ? pairs.get(b.number) : -1)),
		partAudioBook: info.map((b) => (b ? b.number : null)),
		sectionBook,
		keyOverrides: new Map(ebook.filter((b) => b.chapterOne >= 0).map((b) => [b.chapterOne, 'c1'])),
	};
}

function sortAnchors(list) {
	return list.sort((a, b) => (a.ms - b.ms) || (a.word - b.word) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]));
}

// The heaviest chain non-decreasing in word: most anchors first, then the most trusted kinds.
function longestChain(sorted) {
	const n = sorted.length;
	const best = new Array(n).fill(0);
	const prev = new Array(n).fill(-1);
	let top = -1;
	for (let i = 0; i < n; i++) {
		best[i] = CHAIN_WEIGHT + KIND_PRIORITY[sorted[i].kind];
		for (let j = 0; j < i; j++) {
			if (sorted[j].word <= sorted[i].word && best[j] + CHAIN_WEIGHT + KIND_PRIORITY[sorted[i].kind] > best[i]) {
				best[i] = best[j] + CHAIN_WEIGHT + KIND_PRIORITY[sorted[i].kind];
				prev[i] = j;
			}
		}
		if (top < 0 || best[i] > best[top]) top = i;
	}
	const keep = new Set();
	for (let i = top; i >= 0; i = prev[i]) keep.add(i);
	return keep;
}

// The word narration resumes at, at effective ms e: the highest word anchored exactly there,
// else the interpolation around it.
function rightWord(chain, e) {
	let at = -1;
	for (let i = 0; i < chain.length; i++) if (chain[i].ms <= e) at = i;
	if (at < 0) return chain[0].word;
	if (chain[at].ms === e || at === chain.length - 1) return chain[at].word;
	const a = chain[at];
	const b = chain[at + 1];
	return a.word + (e - a.ms) * (b.word - a.word) / (b.ms - a.ms);
}

function buildMap(work, index, { extraAnchors = [] } = {}) {
	const parts = Array.isArray(work && work.parts) ? work.parts : [];
	if (!parts.length || !index) return null;
	const workTitle = (work && work.title) || '';
	const bk = bookPlan(parts, Array.isArray(index.sections) ? index.sections : [], workTitle);
	const keys = bk ? bk.keys : parts.map((p) => partKey(p && p.title, { workTitle }));
	const noText = bk ? bk.noText : parts.map((p) => isNoTextPart(p, { workTitle }));
	const partBook = bk ? bk.partBook : parts.map(() => -1);
	const cls = classifySections(index.sections, { performedKeys: new Set(keys.filter(Boolean)), keyOverrides: bk && bk.keyOverrides });
	const { sections, bodyStartIndex, bodyEndIndex, bodyStartWord, bodyEndWord } = cls;
	if (!(bodyEndWord > bodyStartWord)) return null;
	const last = sections[sections.length - 1];
	const totalWords = Number.isFinite(index.totalWords) ? index.totalWords : last.wordStart + (last.words || 0);

	// Intro/outro tracks are cut out of the time axis, so pace never stretches across them.
	let real = 0;
	let eff = 0;
	const tl = parts.map((p, i) => {
		const dur = Math.max(0, Number(p && p.durationMs) || 0);
		const t = { realStart: real, realEnd: real + dur, effStart: eff, effEnd: eff + (noText[i] ? 0 : dur) };
		real = t.realEnd;
		eff = t.effEnd;
		return t;
	});
	const totalMs = real;
	const totalEff = eff;
	if (!(totalEff > 0)) return null;
	const textParts = parts.map((_, i) => i).filter((i) => !noText[i]);
	const firstText = textParts[0];
	const lastText = textParts[textParts.length - 1];

	const candidates = [];
	const candidatePos = new Map();
	const byKey = new Map();
	for (let i = bodyStartIndex; i < bodyEndIndex; i++) {
		const s = sections[i];
		if (!s.key || s.matter === 'back' || s.part > 1) continue;
		candidatePos.set(i, candidates.length);
		candidates.push(i);
		if (!byKey.has(s.key)) byKey.set(s.key, []);
		byKey.get(s.key).push(i);
	}
	const inBook = (c, b) => b < 0 || bk.sectionBook[c] === b;
	const optionsFor = (key, b) => {
		const list = key[0] === 'i' ? candidates.filter((c) => keysMatch(key, sections[c].key)) : byKey.get(key) || [];
		return b < 0 ? list : list.filter((c) => inBook(c, b));
	};

	// Consecutive tracks with one key are one chapter split across files.
	const runs = [];
	const runOfPart = new Array(parts.length).fill(-1);
	for (let i = 0; i < parts.length; i++) {
		if (!keys[i] || noText[i]) continue;
		const r = runs[runs.length - 1];
		if (r && r.last === i - 1 && r.key === keys[i] && r.book === partBook[i]) r.last = i;
		else runs.push({ key: keys[i], first: i, last: i, section: -1, book: partBook[i] });
		runOfPart[i] = runs.length - 1;
	}
	let lastWord = -1;
	for (const r of runs) {
		const options = optionsFor(r.key, r.book);
		if (!options.length) continue;
		const pick = options.find((c) => sections[c].wordStart > lastWord);
		r.section = pick === undefined ? options[0] : pick;
		lastWord = sections[r.section].wordStart;
	}
	// An omnibus TOC that skips a chapter number ('33' then '35') prints that chapter inside the
	// section before it, so its tracks extend that span instead of showing no text. Kept to
	// omnibuses so every other work's map stays as it was.
	if (bk) {
		const num = (key) => { const m = /^c(\d+)$/.exec(key || ''); return m ? Number(m[1]) : NaN; };
		let host = -1;
		runs.forEach((r, ri) => {
			if (r.section >= 0) { host = ri; return; }
			const h = runs[host];
			const next = runs.slice(ri + 1).find((x) => x.section >= 0);
			let j = h ? h.last + 1 : parts.length;
			while (j < parts.length && noText[j]) j++;
			if (!h || j !== r.first || r.book < 0 || h.book !== r.book || !next || next.book !== r.book
				|| !(num(h.key) < num(r.key) && num(r.key) < num(next.key))) {
				host = -1;
				return;
			}
			h.last = r.last;
			for (let i = r.first; i <= r.last; i++) runOfPart[i] = host;
		});
	}

	const effAnchors = [];
	runs.forEach((r, ri) => {
		if (r.section < 0) return;
		const start = sections[r.section].wordStart;
		let end = -1;
		let j = r.last + 1;
		while (j < parts.length && noText[j]) j++;
		const nr = j < parts.length ? runOfPart[j] : -1;
		if (nr >= 0 && runs[nr].first === j && runs[nr].book === r.book && runs[nr].section >= 0 && sections[runs[nr].section].wordStart > start) {
			end = sections[runs[nr].section].wordStart;
		} else {
			let p = candidatePos.get(r.section) + 1;
			while (p < candidates.length && !(sections[candidates[p]].wordStart > start)) p++;
			// A book's last chapter ends at its own last word, not at the next book's title pages.
			const limit = r.book >= 0 && r.book + 1 < bk.ebook.length ? bk.ebook[r.book].endWord : bodyEndWord;
			end = p < candidates.length && inBook(candidates[p], r.book) ? sections[candidates[p]].wordStart : limit;
		}
		end = Math.max(start, Math.min(end, bodyEndWord));
		const base = { span: ri, section: r.section };
		effAnchors.push({ ...base, kind: 'track-start', ms: tl[r.first].effStart, real: tl[r.first].realStart, word: start, partIndex: r.first });
		effAnchors.push({ ...base, kind: 'track-end', ms: tl[r.last].effEnd, real: tl[r.last].realEnd, word: end, partIndex: r.last });
	});
	const matched = (i) => runOfPart[i] >= 0 && runs[runOfPart[i]].section >= 0;
	const workStart = () => ({ kind: 'work-start', ms: 0, real: tl[firstText].realStart, word: bodyStartWord, partIndex: firstText });
	const workEnd = () => ({ kind: 'work-end', ms: totalEff, real: tl[lastText].realEnd, word: bodyEndWord, partIndex: lastText });
	if (!matched(firstText)) effAnchors.push(workStart());
	if (!matched(lastText)) effAnchors.push(workEnd());
	for (const a of Array.isArray(extraAnchors) ? extraAnchors : []) {
		const ms = Math.min(Math.max(0, Number(a.ms) || 0), totalMs);
		const word = Math.min(Math.max(0, Math.round(Number(a.word) || 0)), totalWords);
		let e = totalEff;
		for (let i = 0; i < parts.length; i++) {
			if (ms < tl[i].realEnd || i === parts.length - 1) {
				e = noText[i] ? tl[i].effStart : tl[i].effStart + Math.min(ms - tl[i].realStart, tl[i].effEnd - tl[i].effStart);
				break;
			}
		}
		effAnchors.push({ kind: 'mark', ms: Math.max(0, e), real: ms, word, partIndex: null });
	}

	const sorted = sortAnchors(effAnchors);
	const keep = longestChain(sorted);
	const chain = sorted.filter((_, i) => keep.has(i));
	const dropped = sorted.filter((_, i) => !keep.has(i)).map((a) => ({
		kind: a.kind, ms: a.real, word: a.word, partIndex: a.partIndex, section: a.section ?? null,
	}));
	// The map must cover the whole work even when the longest chain lost its first or last anchor.
	if (!chain.length || chain[0].ms > 0) chain.unshift({ ...workStart(), word: Math.min(bodyStartWord, chain.length ? chain[0].word : bodyStartWord) });
	if (chain[chain.length - 1].ms < totalEff) chain.push({ ...workEnd(), word: Math.max(bodyEndWord, chain[chain.length - 1].word) });

	const anchors = chain.map((a) => {
		const out = { ms: a.real, word: a.word, kind: a.kind, partIndex: a.partIndex };
		if (a.section !== undefined) out.section = a.section;
		if (a.span !== undefined) out.span = a.span;
		return out;
	});
	for (const i of parts.keys()) {
		if (!noText[i]) continue;
		const w = Math.round(rightWord(chain, tl[i].effStart));
		anchors.push({ ms: tl[i].realStart, word: w, kind: 'no-text', partIndex: i });
		anchors.push({ ms: tl[i].realEnd, word: w, kind: 'no-text', partIndex: i });
	}
	sortAnchors(anchors);
	for (let k = 1; k < anchors.length; k++) {
		if (anchors[k].word < anchors[k - 1].word) anchors[k].word = anchors[k - 1].word;
	}

	const segments = [];
	const jumps = [];
	for (let k = 0; k + 1 < anchors.length; k++) {
		const a = anchors[k];
		const b = anchors[k + 1];
		if (b.ms <= a.ms) {
			if (b.word > a.word) jumps.push({ ms: a.ms, fromWord: a.word, toWord: b.word });
			continue;
		}
		let level = 'pace';
		if (a.word === b.word) level = 'none';
		else if (a.kind === 'track-start' && b.kind === 'track-end' && a.span === b.span) level = 'chapter';
		segments.push({ fromMs: a.ms, toMs: b.ms, fromWord: a.word, toWord: b.word, level });
	}
	const chapterMs = segments.filter((s) => s.level === 'chapter').reduce((n, s) => n + (s.toMs - s.fromMs), 0);
	const keptStarts = new Set(chain.filter((a) => a.kind === 'track-start').map((a) => a.span));
	let matchedParts = 0;
	runs.forEach((r, ri) => { if (keptStarts.has(ri)) matchedParts += r.last - r.first + 1; });

	const map = {
		totalMs,
		totalWords,
		bodyStartWord,
		bodyEndWord,
		bodyStartIndex,
		bodyEndIndex,
		sections,
		anchors,
		segments,
		jumps,
		dropped,
		matchedParts,
		matchedMsShare: totalMs > 0 ? chapterMs / totalMs : 0,
		dramatized: isDramatized(work),
	};
	// Only an omnibus carries this, so every other work's map stays exactly what it was.
	if (bk) {
		map.books = bk.audio.map((a) => {
			const idx = parts.map((_, i) => i).filter((i) => bk.partAudioBook[i] === a.number);
			return {
				number: a.number,
				title: a.title,
				ebookTitle: a.ebook >= 0 ? bk.ebook[a.ebook].title : null,
				fromMs: tl[idx[0]].realStart,
				toMs: tl[idx[idx.length - 1]].realEnd,
			};
		});
	}
	return map;
}

// The audio book of an omnibus playing at ms, or null.
function bookAt(map, ms) {
	const list = (map && map.books) || [];
	return list.find((b) => ms >= b.fromMs && (ms < b.toMs || (ms === b.toMs && ms === map.totalMs))) || null;
}

function segmentAt(map, ms) {
	const segs = map.segments;
	let lo = 0;
	let hi = segs.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (segs[mid].fromMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return ans;
}

function msToWord(map, ms) {
	const segs = map && map.segments;
	if (!segs || !segs.length) return { word: 0, level: 'none', segmentIndex: -1 };
	const clamp = (w) => Math.max(0, Math.min(w, map.bodyEndWord - 1));
	const k = segmentAt(map, ms);
	if (k < 0) return { word: clamp(segs[0].fromWord), level: 'none', segmentIndex: -1 };
	const s = segs[k];
	if (ms >= s.toMs) return { word: clamp(s.toWord), level: ms === s.toMs ? s.level : 'none', segmentIndex: k };
	const exact = s.fromWord + (ms - s.fromMs) * (s.toWord - s.fromWord) / (s.toMs - s.fromMs);
	// The epsilon keeps a float a hair under an integer from landing one word short.
	return { word: clamp(Math.floor(exact + 1e-9)), level: s.level, segmentIndex: k };
}

function wordToMs(map, word) {
	const segs = (map && map.segments) || [];
	const k = segs.findIndex((s) => s.level !== 'none' && s.toWord > word);
	if (k < 0) {
		for (let i = segs.length - 1; i >= 0; i--) if (segs[i].level !== 'none') return segs[i].toMs;
		return 0;
	}
	const s = segs[k];
	// A word inside a jump (an unperformed stretch) maps to where narration resumes.
	const w = Math.max(word, s.fromWord);
	const exact = s.fromMs + (w - s.fromWord) * (s.toMs - s.fromMs) / (s.toWord - s.fromWord);
	let m = Math.max(s.fromMs, Math.ceil(exact) - 1);
	while (m < s.toMs - 1 && msToWord(map, m).word < w) m++;
	// One ms of margin, only while it keeps the same word, so an engine that rounds a seek down
	// still lands on the page asked for.
	if (m + 1 < s.toMs && msToWord(map, m + 1).word === msToWord(map, m).word) m++;
	return m;
}

function locate(map, word) {
	const secs = (map && map.sections) || [];
	let lo = 0;
	let hi = secs.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (secs[mid].wordStart <= word) { ans = mid; lo = mid + 1; } else hi = mid - 1;
	}
	while (ans >= 0 && !(secs[ans].words > 0)) ans--;
	if (ans < 0) {
		const first = secs.findIndex((s) => s.words > 0);
		return first < 0 ? null : { section: first, wordInSection: 0 };
	}
	const s = secs[ans];
	return { section: ans, wordInSection: Math.min(Math.max(0, word - s.wordStart), s.words - 1) };
}

function paginate(sectionText, { targetWords = 180, maxChars = 1400 } = {}) {
	const text = String(sectionText ?? '');
	const ws = words(text);
	const n = ws.length;
	if (!n) return [{ startChar: 0, endChar: text.length, startWord: 0, endWord: 0 }];
	// One pass over the gaps between words: where a page ending at word k would end, and whether
	// a paragraph or a sentence ends there. A page ends at the first space after its last word,
	// so closing punctuation stays with it and an opening quote goes with the next page.
	const cut = new Array(n);
	const para = new Uint8Array(n);
	const sent = new Uint8Array(n);
	for (let k = 0; k < n; k++) {
		const limit = k + 1 < n ? ws[k + 1].start : text.length;
		cut[k] = limit;
		if (k + 1 >= n) { para[k] = 1; sent[k] = 1; }
		for (let c = ws[k].end; c < limit; c++) {
			const ch = text[c];
			if (cut[k] === limit && /\s/.test(ch)) cut[k] = c;
			if (ch === '\n') para[k] = 1;
			else if (ch === '.' || ch === '!' || ch === '?' || ch === '\u2026') sent[k] = 1;
		}
	}
	const cutAfter = (k) => cut[k];
	const paraEnd = (k) => para[k] === 1;
	const sentenceEnd = (k) => sent[k] === 1;
	const pages = [];
	let s = 0;
	let startChar = 0;
	while (s < n) {
		const fits = (e) => cutAfter(e - 1) - startChar <= maxChars;
		const remaining = n - s;
		let e;
		if (remaining <= Math.ceil(targetWords * 1.25) && fits(n)) e = n;
		else {
			const target = remaining < 2 * targetWords ? Math.ceil(remaining / 2) : targetWords;
			let hi = s + 1;
			const cap = Math.min(n, s + Math.ceil(target * 1.25));
			while (hi < cap && fits(hi + 1)) hi++;
			const lo = Math.min(hi, s + Math.max(1, Math.floor(target * 0.6)));
			const want = Math.min(hi, s + target);
			const nearest = (ok) => {
				let pick = -1;
				for (let c = lo; c <= hi; c++) {
					if (ok(c - 1) && (pick < 0 || Math.abs(c - want) < Math.abs(pick - want))) pick = c;
				}
				return pick;
			};
			e = nearest(paraEnd);
			if (e < 0) e = nearest(sentenceEnd);
			if (e < 0) e = want;
		}
		const endChar = e >= n ? text.length : cutAfter(e - 1);
		pages.push({ startChar, endChar, startWord: s, endWord: e });
		startChar = endChar;
		s = e;
	}
	return pages;
}

function pageAt(pages, wordInSection) {
	if (!Array.isArray(pages) || !pages.length) return 0;
	let lo = 0;
	let hi = pages.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (pages[mid].startWord <= wordInSection) { ans = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return ans;
}

function qualityAt(map, ms) {
	const { level } = msToWord(map, ms);
	return { level, label: LEVEL_LABELS[level] };
}

function isDramatized(work) {
	if (!work) return false;
	return [work.publisher, work.edition, work.narrator].some((v) => DRAMA_RE.test(String(v ?? '')));
}

module.exports = {
	WORD_RE,
	words,
	labelKey,
	partKey,
	bookOfPart,
	bookAt,
	keyClass,
	keysMatch,
	isNoTextPart,
	classifySections,
	buildMap,
	msToWord,
	wordToMs,
	locate,
	paginate,
	pageAt,
	qualityAt,
	isDramatized,
};
