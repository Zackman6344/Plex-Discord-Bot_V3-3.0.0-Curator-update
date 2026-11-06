// helpers/bookPicturesAlign.js
//
// Lines up the printed pages of a scanned PDF with the read-along's own word numbering, so a
// picture can be shown when the narration reaches the start of the printed page it is on. Pure:
// no fs, no child processes. It runs in the pictures child (helpers/bookPicturesWorker.js), never
// on the bot's thread: indexing and aligning a 264-page book takes a few hundred ms.
//
// Ported from the design spike (kim/design/algo), which placed all 17 chapter openers of Calibre
// #384 on their chapter's first word against both the UK and the US text. Every OCR n-gram that
// is rare in the ebook votes for its page's offset; the votes form a few candidate places per
// page; a DP picks one place per page in reading order, and a page it left out between two placed
// ones takes its own best place when that keeps the order; the chosen place's matched words,
// widened one exact token at a time, are the page's first and last seen words; a start rule turns
// those into the page's first word.

const { WORD_RE } = require('./readAlongModel.js');

const DEFAULTS = Object.freeze({
	n: 3,
	k: 1,
	radius: 25,
	maxCandidates: 5,
	minVotes: 3,
	step: 650,
	slack: 200,
	back: 20,
	snap: 40,
	minShare: 0.6,
	// The votes a page the DP left out needs on its best place before fillGaps puts it back. Every
	// page that aligned on #384 had 24 or more.
	fillMinVotes: 20,
	// The split start rule never moves a page's start back by more OCR tokens than this.
	maxBack: 60,
	// A page with fewer OCR tokens is not counted as a text page in the alignment's quality, and
	// a picture page below it is a full page (helpers/bookPicturesScan.js). Every page of #384
	// that aligned had 36 or more.
	textPageTokens: 30
});

// Running heads and folios sit outside these bands of the page height.
const HEAD_BAND = 0.075;
const FOOT_BAND = 0.94;
// A line reaching both sides of the page's middle is full width (a chapter title, a caption
// under a wide picture) and cuts the page into bands that are read one after another.
const SPAN_LEFT = 0.45;
const SPAN_RIGHT = 0.55;
// Two line boxes whose centres are this close (points) are one row: a drop cap's remainder
// ("arry woke") and the rest of its line come out as two lines at the same height.
const ROW_TOLERANCE = 4;
const LINE_END_HYPHEN = /\p{L}[-\u00ad\u2010\u2011]$/u;

/**
 * The matching form of a word: NFKD, diacritics dropped, lowercase, everything but letters and
 * digits dropped, so "Didn't", "didn’t" and "didnt" are one key, and so are "longest-ever" and the
 * line-broken "longest-" + "ever".
 * @param {string} word
 * @returns {string}
 */
function normalise(word) {
	return String(word ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The uint32 FNV-1a (over UTF-16LE) of normalise(word); null when that is empty. 0 is never
 * returned: it marks an ebook word with no key, which must never match an OCR token.
 * @param {string} word
 * @returns {number|null}
 */
function tokenKey(word) {
	const s = normalise(word);
	if (!s) return null;
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h = Math.imul(h ^ (c & 0xff), 0x01000193);
		h = Math.imul(h ^ (c >>> 8), 0x01000193);
	}
	return (h >>> 0) || 1;
}

/**
 * The ebook's words as keys, numbered exactly as the read-along numbers them: word i of section
 * k (a WORD_RE match in bytes [byteStart, byteStart + byteLen) of `<base>.txt`) is
 * sections[k].wordStart + i.
 * @param {Buffer|string} text the whole `<base>.txt`; a Buffer is used as it is
 * @param {Array<{ wordStart?: number, words: number, byteStart: number, byteLen: number }>} sections index.sections
 * @returns {{ keys: Uint32Array, totalWords: number, sectionStarts: number[] }}
 */
function ebookKeys(text, sections) {
	const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
	const list = Array.isArray(sections) ? sections : [];
	// readAlongModel.withWordStarts: an index without wordStart everywhere is numbered by running
	// totals of `words`.
	const given = list.every((s) => s && Number.isFinite(s.wordStart));
	const starts = [];
	let run = 0;
	let totalWords = 0;
	for (const s of list) {
		const words = s && Number.isFinite(s.words) ? Math.max(0, s.words) : 0;
		const start = given ? s.wordStart : run;
		starts.push(start);
		run += words;
		totalWords = Math.max(totalWords, start + words);
	}
	const keys = new Uint32Array(totalWords);
	list.forEach((s, k) => {
		const words = s && Number.isFinite(s.words) ? s.words : 0;
		const from = s && Number.isInteger(s.byteStart) ? s.byteStart : -1;
		const len = s && Number.isInteger(s.byteLen) ? s.byteLen : 0;
		if (!(words > 0) || from < 0 || !(len > 0) || from + len > buf.length) return;
		const body = buf.toString('utf8', from, from + len);
		let i = 0;
		for (const m of body.matchAll(WORD_RE)) {
			if (i >= words) break;
			keys[starts[k] + i] = tokenKey(m[0]) || 0;
			i++;
		}
	});
	const sectionStarts = [...new Set(list.map((s, k) => (s && s.words > 0 ? starts[k] : null)).filter((w) => w !== null))].sort((a, b) => a - b);
	return { keys, totalWords, sectionStarts };
}

/**
 * A scanned page's OCR words in reading order, as WORD_RE tokens that have a key.
 *
 * pdftotext lists a two-column scan row by row across both columns, and fed that order the
 * alignment got 8 of 17 openers on #384 instead of 17. So the lines are re-read: running heads
 * and folios are dropped by position, a full-width line cuts the page into bands, and inside a
 * band the left column is read before the right one. A word broken by a line-end hyphen is
 * joined with the next line's first word when that starts lowercase.
 * @param {{ width: number, height: number, lines: Array<{ xMin, yMin, xMax, yMax, words: Array<{ text: string }> }> }} page
 * @returns {string[]}
 */
function readingOrder(page) {
	const lines = page && Array.isArray(page.lines) ? page.lines : [];
	const W = Number(page && page.width);
	const H = Number(page && page.height);
	if (!lines.length || !(W > 0) || !(H > 0)) return [];
	const cy = (l) => (l.yMin + l.yMax) / 2;
	const kept = lines.filter((l) => cy(l) / H >= HEAD_BAND && cy(l) / H <= FOOT_BAND);
	const spanning = (l) => l.xMin < SPAN_LEFT * W && l.xMax > SPAN_RIGHT * W;
	const byRow = (a, b) => (Math.abs(cy(a) - cy(b)) <= ROW_TOLERANCE ? a.xMin - b.xMin : cy(a) - cy(b));
	const cuts = kept.filter(spanning).sort(byRow);
	const ordered = [];
	let top = -Infinity;
	for (const cut of [...cuts, null]) {
		const bottom = cut ? cy(cut) : Infinity;
		const band = kept.filter((l) => !spanning(l) && cy(l) > top && cy(l) <= bottom);
		const mid = W / 2;
		ordered.push(...band.filter((l) => (l.xMin + l.xMax) / 2 < mid).sort(byRow));
		ordered.push(...band.filter((l) => (l.xMin + l.xMax) / 2 >= mid).sort(byRow));
		if (cut) ordered.push(cut);
		top = bottom;
	}
	const words = [];
	for (const l of ordered) {
		for (const w of l.words || []) words.push({ text: String(w.text ?? ''), line: l });
	}
	const out = [];
	for (let k = 0; k < words.length; k++) {
		let raw = words[k].text;
		const next = words[k + 1];
		if (next && next.line !== words[k].line && LINE_END_HYPHEN.test(raw) && /^\p{Ll}/u.test(next.text)) {
			raw = raw.slice(0, -1) + next.text;
			k++;
		}
		for (const m of raw.matchAll(WORD_RE)) {
			if (normalise(m[0])) out.push(m[0]);
		}
	}
	return out;
}

// The key of the n words at keys[at]: two 32-bit mixes packed into one exact 52-bit number, so
// the index holds numbers rather than strings and an omnibus's index stays small.
function gramOf(keys, at, n) {
	let h = 0x811c9dc5;
	let g = 0x9e3779b9;
	for (let j = at; j < at + n; j++) {
		const x = keys[j];
		h = Math.imul(h ^ x, 0x01000193);
		g = Math.imul(g ^ x, 0x85ebca6b);
		g ^= g >>> 13;
	}
	return (h >>> 0) * 0x100000 + (g >>> 12);
}

function gramIndex(keys, n) {
	const index = new Map();
	for (let e = 0; e + n <= keys.length; e++) {
		let gap = false;
		for (let j = e; j < e + n && !gap; j++) gap = !keys[j];
		if (gap) continue;
		const g = gramOf(keys, e, n);
		const at = index.get(g);
		if (at === undefined) index.set(g, e);
		else if (typeof at === 'number') index.set(g, [at, e]);
		else at.push(e);
	}
	return index;
}

// Each OCR n-gram found at most k times in the ebook votes for the page's offset, the ebook word
// minus the page token index, weighted 1/occurrences.
function pageAnchors(keys, index, n, k) {
	const out = [];
	for (let i = 0; i + n <= keys.length; i++) {
		const at = index.get(gramOf(keys, i, n));
		if (at === undefined) continue;
		if (typeof at === 'number') {
			out.push({ i, e: at, d: at - i, w: 1 });
			continue;
		}
		if (at.length > k) continue;
		const w = 1 / at.length;
		for (const e of at) out.push({ i, e, d: e - i, w });
	}
	return out;
}

// Windows of width 2r+1 over the offsets, best first, each anchor in at most one window.
function candidates(anchors, r, max) {
	let left = anchors.slice().sort((a, b) => a.d - b.d);
	const out = [];
	while (left.length && out.length < max) {
		let best = -1;
		let bestSum = 0;
		let sum = 0;
		let j = 0;
		for (let i = 0; i < left.length; i++) {
			sum += left[i].w;
			while (left[i].d - left[j].d > 2 * r) sum -= left[j++].w;
			if (sum > bestSum + 1e-9) {
				bestSum = sum;
				best = j;
			}
		}
		const lo = left[best].d;
		const inside = left.filter((a) => a.d >= lo && a.d <= lo + 2 * r);
		const ds = inside.map((a) => a.d).sort((a, b) => a - b);
		out.push({ d: ds[ds.length >> 1], votes: bestSum, anchors: inside });
		left = left.filter((a) => a.d < lo - 2 * r || a.d > lo + 4 * r);
	}
	return out;
}

// The heaviest chain of (page, place) choices that never moves back more than `back` words and
// never moves further than the pages between could hold. A greedy pick was stranded at the end
// of the book by #384's copyright page, which matches the ebook's back matter; the DP cannot be.
function pickDp(perPage, { minVotes, step, slack, back }) {
	const nodes = [];
	perPage.forEach((cands, p) => cands.forEach((c) => { if (c.votes >= minVotes) nodes.push({ p, c }); }));
	const best = new Float64Array(nodes.length);
	const from = new Int32Array(nodes.length).fill(-1);
	let top = -1;
	for (let a = 0; a < nodes.length; a++) {
		const x = nodes[a];
		best[a] = x.c.votes;
		for (let b = 0; b < a; b++) {
			const y = nodes[b];
			if (y.p >= x.p) continue;
			if (x.c.d < y.c.d - back || x.c.d > y.c.d + (x.p - y.p) * step + slack) continue;
			if (best[b] + x.c.votes > best[a]) {
				best[a] = best[b] + x.c.votes;
				from[a] = b;
			}
		}
		if (top < 0 || best[a] > best[top]) top = a;
	}
	const out = perPage.map(() => null);
	for (let a = top; a >= 0; a = from[a]) out[nodes[a].p] = nodes[a].c;
	return out;
}

// pickDp's step limit cannot bridge a jump in the offset: a scan missing a few printed pages, an
// ebook passage the print lacks, or pages of more than about 850 words (dense or 2-up scans). It
// leaves out strong pages beside the jump instead, and their pictures move to the far side of it:
// with #384's scan pages 180-185 gone, page 178's picture came 4,251 words late. A page left out
// between two placed pages takes its own best place when that has fillMinVotes and lies between
// the place before it and the next placed page, within `back`, so reading order still holds.
// #384's front-matter pages that match the back matter stay out: their best place lies past the
// next placed page.
function fillGaps(picks, perPage, { fillMinVotes, back }) {
	const next = picks.map(() => null);
	for (let p = picks.length - 2; p >= 0; p--) next[p] = picks[p + 1] || next[p + 1];
	const out = picks.slice();
	let last = null;
	for (let p = 0; p < out.length; p++) {
		if (out[p]) {
			last = out[p];
			continue;
		}
		const best = perPage[p][0];
		if (!last || !next[p] || !best || best.votes < fillMinVotes) continue;
		if (best.d < last.d - back || best.d > next[p].d + back) continue;
		out[p] = best;
		last = best;
	}
	return out;
}

// The anchors of a place that run forward in both page and ebook order.
function chain(anchors) {
	const s = anchors.slice().sort((a, b) => a.i - b.i || a.e - b.e);
	const len = new Int32Array(s.length);
	const prev = new Int32Array(s.length).fill(-1);
	let top = -1;
	for (let x = 0; x < s.length; x++) {
		len[x] = 1;
		for (let y = 0; y < x; y++) {
			if (s[y].i < s[x].i && s[y].e < s[x].e && len[y] + 1 > len[x]) {
				len[x] = len[y] + 1;
				prev[x] = y;
			}
		}
		if (top < 0 || len[x] > len[top]) top = x;
	}
	const out = [];
	for (let x = top; x >= 0; x = prev[x]) out.push(s[x]);
	return out.reverse();
}

function span(page, keys, place, n) {
	const c = chain(place.anchors);
	if (!c.length) return null;
	let i0 = c[0].i;
	let e0 = c[0].e;
	while (i0 > 0 && e0 > 0 && page[i0 - 1] === keys[e0 - 1]) { i0--; e0--; }
	let i1 = c[c.length - 1].i + n - 1;
	let e1 = c[c.length - 1].e + n - 1;
	while (i1 + 1 < page.length && e1 + 1 < keys.length && page[i1 + 1] === keys[e1 + 1]) { i1++; e1++; }
	return { first: e0, last: e1, firstToken: i0, lastToken: i1, tokenCount: page.length };
}

// A page's first word. Snap: a section that begins after the last word seen on the page before,
// and at most `snap` words before this page's first seen word, starts this page, since print opens
// a chapter on a new page and its drop cap and heading art hide the first 0-5 words from the OCR.
// Otherwise the unseen words are split: this page's top was read cleanly (no token before its
// first seen word), so they ended the page before; or the page before was read to its last token,
// so they open this page, and each unread token may hide a second word the OCR merged into it
// ("Ortwice"), up to 2 such words; or neither, and the start goes back by the unread tokens, at
// most maxBack. Never before the word after the previous page's last seen word.
function pageStarts(spans, sectionStarts, { snap, maxBack }) {
	let prevLast = -1;
	let prev = null;
	return spans.map((s) => {
		if (!s) return null;
		const floor = prevLast < s.first ? prevLast : -1;
		let snapped = null;
		for (const w of sectionStarts) {
			if (w > floor && w <= s.first && s.first - w <= snap) snapped = w;
		}
		let start;
		if (snapped !== null) start = snapped;
		else if (s.firstToken === 0) start = s.first;
		else if (prev && floor >= 0 && prev.lastToken === prev.tokenCount - 1) {
			start = Math.max(floor + 1, s.first - Math.min(2 * s.firstToken, s.firstToken + 2, maxBack));
		} else {
			start = Math.max(floor + 1, s.first - Math.min(s.firstToken, maxBack), 0);
		}
		prevLast = s.last;
		prev = s;
		return start;
	});
}

const asKeys = (k) => (k instanceof Uint32Array ? k : Uint32Array.from(Array.isArray(k) ? k : []));

/**
 * Each printed page's first and last ebook word. Index p of every array is page p + 1.
 * The alignment failed for this text when quality.share is under DEFAULTS.minShare.
 * @param {Array<Uint32Array|number[]>} pageKeys each page's OCR token keys in reading order
 * @param {{ keys: Uint32Array, sectionStarts: number[] }} ebook from ebookKeys
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {{ starts: Array<number|null>, ends: Array<number|null>, quality: { textPages: number, aligned: number, share: number } }}
 */
function alignPages(pageKeys, ebook, opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const pages = (Array.isArray(pageKeys) ? pageKeys : []).map(asKeys);
	const keys = asKeys(ebook && ebook.keys);
	const sectionStarts = ebook && Array.isArray(ebook.sectionStarts) ? ebook.sectionStarts : [];
	const index = gramIndex(keys, o.n);
	const perPage = pages.map((page) => candidates(pageAnchors(page, index, o.n, o.k), o.radius, o.maxCandidates));
	const picks = fillGaps(pickDp(perPage, o), perPage, o);
	const spans = picks.map((c, p) => (c ? span(pages[p], keys, c, o.n) : null));
	const starts = pageStarts(spans, sectionStarts, o);
	const ends = spans.map((s, p) => (starts[p] === null ? null : s.last));
	let textPages = 0;
	let aligned = 0;
	pages.forEach((page, p) => {
		if (page.length < o.textPageTokens) return;
		textPages++;
		if (starts[p] !== null) aligned++;
	});
	return { starts, ends, quality: { textPages, aligned, share: textPages ? aligned / textPages : 0 } };
}

/**
 * Each picture's word: the start of its own page when that page aligned, else the start of the
 * next aligned text page (a full page or a joined spread shows with the text that follows it,
 * as a print reader sees it on turning the page), else the word after the previous aligned text
 * page's end. Pictures before the first aligned text page are front matter and dropped; nothing
 * else is filtered here.
 *
 * A picture placed off its own page also gets `fallback`, the last word of the nearest aligned
 * page before it. The next text page can be back matter the narration never reaches (#384's last
 * story picture, p259, takes the first back-matter page's start), so the read-along shows the
 * picture at its fallback when its word is not narrated. The inclusive last word, not the one
 * after it: past a book's last chapter, the word after is exactly the first one not narrated.
 * @param {Array<{ id: string, pages: number[], kind?: string }>} pictures
 * @param {{ starts: Array<number|null>, ends: Array<number|null> }} aligned from alignPages
 * @param {{ totalWords?: number }} [opts]
 * @returns {Array<{ id: string, word: number, how: 'page-start'|'next-text'|'prev-end', fallback?: number }>}
 *   word and fallback are at most totalWords - 1; fallback only on 'next-text' and 'prev-end',
 *   and only when an aligned page comes before the picture
 */
function pictureWords(pictures, aligned, { totalWords } = {}) {
	const starts = aligned && Array.isArray(aligned.starts) ? aligned.starts : [];
	const ends = aligned && Array.isArray(aligned.ends) ? aligned.ends : [];
	const has = (a, p) => Number.isInteger(a[p - 1]);
	const clamp = (w) => (Number.isFinite(totalWords) && totalWords > 0 ? Math.min(w, totalWords - 1) : w);
	let firstText = 0;
	while (firstText < starts.length && !has(starts, firstText + 1)) firstText++;
	if (firstText >= starts.length) return [];
	firstText++;
	const out = [];
	for (const pic of Array.isArray(pictures) ? pictures : []) {
		const pages = (pic && Array.isArray(pic.pages) ? pic.pages : []).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
		if (!pages.length || pages[0] < firstText) continue;
		let word = null;
		let how = null;
		let before = null;
		const own = pages.find((n) => has(starts, n));
		if (own !== undefined) {
			word = starts[own - 1];
			how = 'page-start';
		} else {
			for (let q = pages[0] - 1; before === null && q >= 1; q--) {
				if (has(ends, q)) before = ends[q - 1];
			}
			for (let q = pages[pages.length - 1] + 1; q <= starts.length; q++) {
				if (has(starts, q)) {
					word = starts[q - 1];
					how = 'next-text';
					break;
				}
			}
			if (word === null && before !== null) {
				word = before + 1;
				how = 'prev-end';
			}
		}
		if (word === null) continue;
		const placed = { id: pic.id, word: clamp(word), how };
		if (how !== 'page-start' && before !== null) placed.fallback = clamp(before);
		out.push(placed);
	}
	return out;
}

module.exports = {
	normalise,
	tokenKey,
	ebookKeys,
	readingOrder,
	alignPages,
	pictureWords,
	DEFAULTS
};
