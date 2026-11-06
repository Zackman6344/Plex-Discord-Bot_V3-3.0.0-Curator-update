// test/fixtures/bookPictures/synth.js
//
// Synthetic books for the read-along pictures tests. Every word is made up from syllables by a
// seeded generator, so no real book text is used and every run is the same.
//
//   makeEbook(opts)        an ebook cached by the read-along's own builder (epubText.buildCache):
//                          { index, text, words: [{ raw, global, section }], sectionWords(label) }
//   typeset(words, opts)   the words set into two-column printed pages
//   ocrPage(page, opts)    one printed page as pdftotext -bbox-layout sees it: a running head and
//                          a folio in their bands, a full-width chapter title on an opener, the
//                          opener's first words hidden by its drop cap, line-end hyphens, junk
//                          tokens and merged words
//   printBook(ebook, opts) a whole printed edition with front matter, pictures, a spread and
//                          back matter, each page's OCR and the word it truly starts on
//   lineOf(items, x, y, h) one OCR line of words set left to right
//   xhtmlOf(pages, opts)   pages of lines as pdftotext -bbox-layout XHTML, lines listed row by
//                          row across both columns as pdftotext lists a two-column scan
//   ppmOf(w, h, paint)     a binary PPM; paint(x, y) gives [r, g, b]
//   jpegOf(w, h, bytes)    the smallest JPEG-shaped buffer with that size in its SOF0
//
// Not named *.test.js, so `node --test test/*.test.js` does not run it.

const epubText = require('../../../helpers/epubText.js');
const { WORD_RE } = require('../../../helpers/readAlongModel.js');

const PAGE_W = 562.2;
const PAGE_H = 690.2;
const COL_X = [56, 296];
const COL_W = 210;
const CHAR_W = 3.6;
const SPACE_W = 3.2;
const LINE_H = 10.9;
const LINE_STEP = 13.2;
const BODY_TOP = 66.9;
const OPENER_TOP = 170;

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'so', 'ta', 'vi', 'zu', 'pe', 'qua', 'dri', 'fen', 'gol',
	'hap', 'jin', 'ber', 'cot', 'dun', 'elm', 'or', 'ash', 'iv', 'um'];

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function vocabulary(rand, size) {
	const set = new Set();
	while (set.size < size) {
		const n = 1 + Math.floor(rand() * 3);
		let w = '';
		for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
		set.add(w);
	}
	return [...set];
}

/**
 * @param {{ seed?: number, chapters?: number, chapterWords?: number, vocab?: number }} [opts]
 */
function makeEbook({ seed = 1, chapters = 5, chapterWords = 1400, vocab: vocabSize = 700 } = {}) {
	const rand = rng(seed);
	const vocab = vocabulary(rand, vocabSize);
	const pick = () => vocab[Math.floor(rand() * vocab.length)];
	const sentence = (len) => {
		const ws = [];
		for (let i = 0; i < len; i++) {
			let w = pick();
			const r = rand();
			// Ebook spellings the OCR prints differently: an accent, a curly possessive, a compound.
			if (r < 0.03 && w.includes('e')) w = w.replace('e', '\u00e9');
			else if (r < 0.07) w += '\u2019s';
			else if (r < 0.1) w = `${w}-${pick()}`;
			if (i === 0) w = w[0].toUpperCase() + w.slice(1);
			ws.push(i === len - 1 ? w : rand() < 0.08 ? `${w},` : w);
		}
		return `${ws.join(' ')}.`;
	};
	const paragraph = (n) => {
		const out = [];
		for (let left = n; left > 0;) {
			const len = Math.min(left, 6 + Math.floor(rand() * 9));
			out.push(sentence(len));
			left -= len;
		}
		return out.join(' ');
	};
	const section = (label, n) => {
		const paragraphs = [];
		for (let left = n; left > 0;) {
			const k = Math.min(left, 40 + Math.floor(rand() * 50));
			paragraphs.push(paragraph(k));
			left -= k;
		}
		return { label, href: `text/${label.replace(/\W+/g, '-')}.xhtml`, depth: 1, paragraphs, words: epubText.countWords(paragraphs.join('\n')) };
	};
	const sections = [section('Title Page', 6), section('Dedication', 36)];
	for (let c = 1; c <= chapters; c++) sections.push(section(`Chapter ${c}`, chapterWords + Math.floor(rand() * 300)));
	sections.push(section('About the Author', 64));
	const info = { meta: { title: 'Synthetic', creator: 'Nobody', identifier: 'synth', language: 'en' }, tocSource: 'ncx', drm: { fontObfuscationOnly: false } };
	const { index, text } = epubText.buildCache(sections, info, { now: 0 });
	const buf = Buffer.from(text, 'utf8');
	const words = [];
	index.sections.forEach((s, k) => {
		const body = buf.toString('utf8', s.byteStart, s.byteStart + s.byteLen);
		let i = 0;
		for (const m of body.matchAll(WORD_RE)) words.push({ raw: m[0], global: s.wordStart + i++, section: k });
	});
	const sectionWords = (label) => {
		const k = index.sections.findIndex((s) => s.label === label);
		return words.filter((w) => w.section === k);
	};
	return { index, text, words, sectionWords };
}

const widthOf = (raw) => raw.length * CHAR_W;

/**
 * Sets words into two-column pages: the left column fills before the right one.
 * @returns {Array<{ cols: Array<Array<Array<{ raw, global }>>>, opener: boolean, first: number }>}
 */
function typeset(words, { opener = false, lines = 24, openerLines = 16 } = {}) {
	const pages = [];
	let i = 0;
	let first = true;
	while (i < words.length) {
		const nLines = first && opener ? openerLines : lines;
		const cols = [[], []];
		const start = words[i].global;
		for (let c = 0; c < 2 && i < words.length; c++) {
			for (let l = 0; l < nLines && i < words.length; l++) {
				const line = [];
				let w = 0;
				while (i < words.length) {
					const add = widthOf(words[i].raw) + (line.length ? SPACE_W : 0);
					if (line.length && w + add > COL_W) break;
					line.push(words[i++]);
					w += add;
				}
				cols[c].push(line);
			}
		}
		pages.push({ cols, opener: first && opener, first: start });
		first = false;
	}
	return pages;
}

// items: strings, or { text, width } where the OCR read something other than what is printed in
// that box (a box keeps the printed word's width whatever the OCR made of it).
function lineOf(items, x, y, h = LINE_H) {
	const words = [];
	let at = x;
	for (const item of items) {
		const text = typeof item === 'string' ? item : item.text;
		const w = Math.max(2, typeof item === 'string' ? widthOf(text) : item.width);
		words.push({ text, xMin: at, yMin: y, xMax: at + w, yMax: y + h });
		at += w + SPACE_W;
	}
	return { xMin: x, yMin: y, xMax: words.length ? words[words.length - 1].xMax : x, yMax: y + h, words };
}

/**
 * One printed page as OCR lines (the parsed bbox-layout shape).
 * @param {{ cols, opener }} page from typeset
 * @param {{ rand?: Function, folio?: number|null, title?: string, hide?: number, junk?: number,
 *   merge?: number, hyphen?: number, head?: string }} [opts]
 */
function ocrPage(page, { rand = rng(7), folio = null, title = 'Chapter Heading', hide = 2, junk = 0, merge = 0, hyphen = 0, head = 'THE SYNTH BOOK' } = {}) {
	const lines = [];
	const ocr = (raw) => raw.replace(/\u2019/g, '\'').replace(/\u00e9/g, 'e');
	const junkWord = () => `zq${Math.floor(rand() * 1e6)}x`;
	lines.push(lineOf(head.split(' '), 226.2, 24.3, 9.5));
	if (folio !== null) lines.push(lineOf([String(folio)], 275.4, 655.8, 12.4));
	let top = BODY_TOP;
	if (page.opener) {
		// Set in large capitals across both columns.
		lines.push({ ...lineOf(title.toUpperCase().split(' '), 150, 112, 16), xMax: 412 });
		top = OPENER_TOP;
	}
	// Reading order of the printed lines: left column, then right.
	const item = (text) => ({ text, width: widthOf(text) });
	const rows = [];
	for (let c = 0; c < 2; c++) {
		page.cols[c].forEach((line, l) => rows.push({ c, l, items: line.map((w) => item(ocr(w.raw))) }));
	}
	if (page.opener && rows.length) {
		// The drop cap and heading art hide the chapter's first words; the next one loses its
		// first letter to the drop cap and is read as a box of its own on the first row.
		const r0 = rows[0];
		const hidden = r0.items.splice(0, Math.min(hide, r0.items.length));
		if (hidden.length === hide && r0.items.length && r0.items[0].text.length > 3) r0.capRest = r0.items.shift().text.slice(1);
	}
	for (let k = 0; k + 1 < rows.length; k++) {
		const items = rows[k].items;
		const last = items.length ? items[items.length - 1].text : '';
		if (last.length >= 7 && /^\p{Ll}+$/u.test(last) && rand() < hyphen) {
			const cut = 3 + Math.floor(rand() * (last.length - 5));
			items[items.length - 1] = item(`${last.slice(0, cut)}-`);
			rows[k + 1].items.unshift(item(last.slice(cut)));
			rows[k + 1].tail = true;
		}
	}
	for (const row of rows) {
		const items = [];
		for (let i = 0; i < row.items.length; i++) {
			const it = row.items[i];
			if (/-$/.test(it.text) || (i === 0 && row.tail)) {
				items.push(it);
				continue;
			}
			const next = row.items[i + 1];
			if (rand() < junk) items.push({ text: junkWord(), width: it.width });
			else if (next && !/-$/.test(next.text) && rand() < merge) {
				items.push({ text: it.text + next.text, width: it.width + SPACE_W + next.width });
				i++;
			} else items.push(it);
		}
		const y = top + row.l * LINE_STEP;
		const x = COL_X[row.c];
		if (row.capRest) {
			const rest = lineOf([row.capRest], x + 22, y + 0.6);
			lines.push(rest);
			lines.push(lineOf(items, rest.xMax + SPACE_W, y));
		} else {
			lines.push(lineOf(items, x, y));
		}
	}
	return { width: PAGE_W, height: PAGE_H, lines };
}

/**
 * The printed edition of a makeEbook book, page by page: a cover, the title page, a copyright
 * page that prints the ebook's back matter (as #384's copyright page matched the ebook's), the
 * dedication, a frontispiece, the chapters (each opening a page, a full-page picture after the
 * second page of chapter 1, a two-page spread before chapter 3), the back matter and an endpaper.
 * `lines` sets the lines in a column, so the words on a page; `plateEvery` adds a full-page plate
 * after every that many pages inside a chapter, as in a heavily illustrated edition.
 * `truth` is the global word a text page starts on; null where nothing should align.
 * @returns {Array<{ n: number, kind: 'art'|'text', truth: number|null, opener: boolean, label: string|null, ocr: object }>}
 */
function printBook(ebook, { seed = 11, junk = 0, merge = 0, hyphen = 0, offset = 4, lines = 24, plateEvery = 0 } = {}) {
	const rand = rng(seed);
	const out = [];
	const art = (label = null) => out.push({ kind: 'art', truth: null, opener: false, label, page: null });
	const text = (words, { opener = false, label = null, truth = true } = {}) => {
		for (const page of typeset(words, { opener, lines })) {
			out.push({ kind: 'text', truth: truth ? page.first : null, opener: page.opener, label, page });
		}
	};
	art('cover');
	text(ebook.sectionWords('Title Page'), { label: 'Title Page' });
	text(ebook.sectionWords('About the Author'), { label: 'copyright', truth: false });
	text(ebook.sectionWords('Dedication'), { label: 'Dedication' });
	art('frontispiece');
	const chapters = ebook.index.sections.filter((s) => /^Chapter \d+$/.test(s.label));
	chapters.forEach((s, c) => {
		if (c === 2) {
			art('spread-left');
			art('spread-right');
		}
		const pages = typeset(ebook.sectionWords(s.label), { opener: true, lines });
		pages.forEach((page, i) => {
			out.push({ kind: 'text', truth: page.first, opener: page.opener, label: s.label, page });
			if (c === 0 && i === 1) art('mid-chapter');
			else if (plateEvery > 0 && (i + 1) % plateEvery === 0 && i + 1 < pages.length) art('plate');
		});
	});
	text(ebook.sectionWords('About the Author'), { label: 'About the Author' });
	art('endpaper');
	return out.map((p, k) => {
		const n = k + 1;
		let ocr;
		if (p.kind === 'art') {
			// A painting's OCR: a few fragments in boxes far taller than any text line.
			ocr = { width: PAGE_W, height: PAGE_H, lines: p.label === 'mid-chapter' ? [lineOf(['/', 'ALBUS', '\u2122'], 100, 8.3, 42.6)] : [] };
		} else {
			ocr = ocrPage(p.page, { rand, folio: n - offset > 0 ? n - offset : null, title: p.label || 'Heading', junk, merge, hyphen });
		}
		return { n, kind: p.kind, truth: p.truth, opener: p.opener, label: p.label, ocr };
	});
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const num = (v) => v.toFixed(6);
const boxAttrs = (b) => `xMin="${num(b.xMin)}" yMin="${num(b.yMin)}" xMax="${num(b.xMax)}" yMax="${num(b.yMax)}"`;

/**
 * pdftotext -bbox-layout XHTML for pages of lines, each line in its own flow and block.
 * @param {Array<{ width, height, lines }>} pages
 * @param {{ crlf?: boolean, rowOrder?: boolean }} [opts]
 */
function xhtmlOf(pages, { crlf = false, rowOrder = true } = {}) {
	const out = ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">',
		'<head>', '<title>Synthetic &amp; made up</title>', '<meta name="Producer" content="synth"/>', '</head>', '<body>', '<doc>'];
	for (const p of pages) {
		out.push(`  <page width="${num(p.width)}" height="${num(p.height)}">`);
		const lines = rowOrder ? p.lines.slice().sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin) : p.lines;
		for (const l of lines) {
			out.push('    <flow>', `      <block ${boxAttrs(l)}>`, `        <line ${boxAttrs(l)}>`);
			for (const w of l.words) out.push(`          <word ${boxAttrs(w)}>${esc(w.text)}</word>`);
			out.push('        </line>', '      </block>', '    </flow>');
		}
		out.push('  </page>');
	}
	out.push('</doc>', '</body>', '</html>', '');
	return out.join(crlf ? '\r\n' : '\n');
}

function ppmOf(width, height, paint) {
	const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'latin1');
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const c = paint(x, y);
			const p = (y * width + x) * 3;
			data[p] = c[0];
			data[p + 1] = c[1];
			data[p + 2] = c[2];
		}
	}
	return Buffer.concat([header, data]);
}

function jpegOf(width, height, bytes = 0) {
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
		0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
	const parts = [Buffer.from([0xff, 0xd8])];
	let left = bytes - 2 - sof.length - 2;
	while (left > 4) {
		const len = Math.min(left - 2, 65535);
		const com = Buffer.alloc(2 + len, 0x61);
		com[0] = 0xff;
		com[1] = 0xfe;
		com.writeUInt16BE(len, 2);
		parts.push(com);
		left -= 2 + len;
	}
	parts.push(sof, Buffer.from([0xff, 0xd9]));
	return Buffer.concat(parts);
}

module.exports = {
	PAGE_W,
	PAGE_H,
	COL_X,
	rng,
	vocabulary,
	makeEbook,
	typeset,
	ocrPage,
	printBook,
	lineOf,
	xhtmlOf,
	ppmOf,
	jpegOf
};
