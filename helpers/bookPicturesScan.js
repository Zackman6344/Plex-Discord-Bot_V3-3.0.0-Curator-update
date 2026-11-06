// helpers/bookPicturesScan.js
//
// The PDF pass of the read-along pictures child (helpers/bookPicturesWorker.js): the scan's OCR
// text layer, the pictures on each page, two-page spreads and the JPGs. It only ever runs in that
// Below Normal child: parsing #384's word boxes alone takes 0.4 s, far past the 20 ms voice timer.
//
// Every page is decoded once. pdftoppm renders it 1200 px tall as PPM on stdout; a 110 px box
// average of that is scored for art, which is the size the design's scorer was tuned on; a
// picture is encoded from the full-size PPM by ffmpeg-static through stdin: cropped to its art on
// a text page, whole for a full page, and two facing full pages tiled into one for a spread.
//
// The scorer (ported from kim/design/algo artScore.js and spreads.js): pixels far from the paper
// colour that no OCR text line covers are ink, and a page carries a picture when its largest
// 8-connected patch of ink is at least 2.5% of the page. On #384's body pages that gave precision
// 0.983 and recall 0.991 against labels made by eye. A thin sliver at a side edge is not one.

const pathMod = require('path');
const { tokenKey, readingOrder, DEFAULTS } = require('./bookPicturesAlign.js');

const RENDER_HEIGHT = 1200;
const SCORE_HEIGHT = 110;
// Rendering measured 0.84 s a page on an idle PC and 1.38 s on a busy one: 1000 pages take about 14
// to 23 minutes, under the worker's total cap, which stretches to 55 minutes for 1000 pages (5
// minutes and 3 s a page). bookPictures' LIMITS.maxPages is the same.
const MAX_PAGES = 1000;
const MAX_PICTURES = 200;
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_BYTES = 32 * 1024 * 1024;
const MAX_JPEG_BYTES = 16 * 1024 * 1024;
// #384's 264 pages give 11.9 MB of word boxes; this is far past any book under MAX_PAGES.
const MAX_WORDS_BYTES = 256 * 1024 * 1024;
const TEXT_TIMEOUT_MS = 60000;
const RENDER_TIMEOUT_MS = 30000;
const ENCODE_TIMEOUT_MS = 15000;
// One page that times out is skipped; three in a row is a pdftoppm that hangs on this PDF.
const MAX_TIMEOUTS_IN_A_ROW = 3;
// A few pages that will not render and pictures ffmpeg will not encode are passed over. More
// than this many, or than this share of the pages, is a tool that broke partway: that partial
// read, installed as the book's finished analysis, would hide the loss until someone ran
// pictures:redo. 'crash' is a strike, so the parent tries again later.
const MAX_LOST = 3;
const MAX_LOST_SHARE = 0.02;
// The first try is the design's measured setting; a JPG over maxPictureBytes is encoded again
// at a lower quality, then at half the size.
const ENCODE_STEPS = [{ q: 3, half: false }, { q: 8, half: false }, { q: 12, half: true }];
const WORDS_FILE = 'words.html';
const NAME_RE = /^p\d{3,4}(-\d{3,4})?\.jpg$/;
// Calibre's poppler exits 1 for a PDF with a user password, as for a damaged one, and never 3.
// The /Encrypt entry tells them apart without stderr, which quotes the path: in the trailer at
// the end, or in a linearized file's first trailer near the start.
const ENCRYPT_PROBE_BYTES = 64 * 1024;
const ENCRYPT_RE = /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/;

const ART_BLOB = 0.025;
// At 0.5% of the page the boxes of #384's pages 61, 98 and 243 swallowed edge stains.
const CROP_MIN_BLOB = 0.015;
// One pixel of the 110 px render is about 1% of the page, and a faint edge of the art can fall
// under the ink threshold there; the margin keeps it in the crop of the full render.
const CROP_PAD = 0.02;
// Patches that together touch the left or right edge and are narrower than this share of the
// page are a scanner's shadow or the facing page's art bleeding over (#384's pages 220 and 27),
// not a picture, on a full page as on a text page. #384's narrowest real art at an edge is 26%
// of the page wide.
const EDGE_SLIVER_WIDTH = 0.2;
const EDGE_SLIVER_MARGIN = 0.01;
const INK_DIST = 45;
const MASK_PAD = 1;
const PAPER_MIN_PIXELS = 50;
const BRIGHT_LUM = 150;
const WHITE = [255, 255, 255];
const SPREAD_EDGE = 2;
const SPREAD_ROWS = 60;
const SPREAD_BOTH_INK = 0.5;
const SPREAD_MAX_DIST = 60;
// The bands readingOrder drops: where running heads and folios sit.
const HEAD_BAND = 0.075;
const FOOT_BAND = 0.94;
const FOLIO_MIN_VOTES = 3;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function failure(code) {
	const err = new Error(`book pictures scan failed: ${code}`);
	err.code = code;
	return err;
}

function decodeXml(s) {
	if (s.indexOf('&') < 0) return s;
	return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
		if (e[0] === '#') {
			const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
		}
		return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
	});
}

function attrsOf(text) {
	const out = {};
	const re = /([A-Za-z]+)\s*=\s*"([^"]*)"/g;
	let m;
	while ((m = re.exec(text))) out[m[1]] = m[2];
	return out;
}

function boxOf(a) {
	return { xMin: Number(a.xMin), yMin: Number(a.yMin), xMax: Number(a.xMax), yMax: Number(a.yMax) };
}

const finiteBox = (b) => [b.xMin, b.yMin, b.xMax, b.yMax].every(Number.isFinite);

/**
 * Pages of `pdftotext -bbox-layout` output, in document order and numbered from 1, each with
 * its lines of words. Units are PDF points, origin top-left. pdftotext ends lines with CRLF on a
 * pipe and escapes &, <, >, " and ' in word text. A word outside any line (plain -bbox) becomes
 * a line of its own.
 * @param {string|Buffer} xhtml
 * @returns {Array<{ n: number, width: number, height: number, lines: Array<{ xMin, yMin, xMax, yMax, words: Array<{ text: string, xMin, yMin, xMax, yMax }> }> }>}
 */
function parseBboxLayout(xhtml) {
	const src = Buffer.isBuffer(xhtml) ? xhtml.toString('utf8') : String(xhtml ?? '');
	const pages = [];
	let page = null;
	let line = null;
	const re = /<page\b([^>]*)>|(<\/page\s*>)|<line\b([^>]*)>|(<\/line\s*>)|<word\b([^>]*)>([^<]*)<\/word\s*>/g;
	let m;
	while ((m = re.exec(src))) {
		if (m[1] !== undefined) {
			const a = attrsOf(m[1]);
			page = { n: pages.length + 1, width: Number(a.width), height: Number(a.height), lines: [] };
			pages.push(page);
			line = null;
		} else if (m[2] !== undefined) {
			page = null;
			line = null;
		} else if (m[3] !== undefined) {
			if (!page) continue;
			line = { ...boxOf(attrsOf(m[3])), words: [] };
			page.lines.push(line);
		} else if (m[4] !== undefined) {
			line = null;
		} else if (page) {
			const word = { text: decodeXml(m[6]).trim(), ...boxOf(attrsOf(m[5])) };
			if (!word.text || !finiteBox(word)) continue;
			if (line) line.words.push(word);
			else page.lines.push({ xMin: word.xMin, yMin: word.yMin, xMax: word.xMax, yMax: word.yMax, words: [word] });
		}
	}
	for (const p of pages) {
		p.lines = p.lines.filter((l) => l.words.length);
		for (const l of p.lines) {
			if (finiteBox(l)) continue;
			l.xMin = Math.min(...l.words.map((w) => w.xMin));
			l.yMin = Math.min(...l.words.map((w) => w.yMin));
			l.xMax = Math.max(...l.words.map((w) => w.xMax));
			l.yMax = Math.max(...l.words.map((w) => w.yMax));
		}
	}
	return pages;
}

const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d;

/**
 * A binary PPM (P6, 8 bits a sample). `data` is a view into `buf`, RGB rows top to bottom.
 * Throws on anything else: another magic, a 16-bit maxval, a bad header or too few bytes.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Buffer }}
 */
function parsePpm(buf) {
	if (!Buffer.isBuffer(buf)) {
		if (!(buf instanceof Uint8Array)) throw Object.assign(new Error('not a PPM'), { code: 'bad-ppm' });
		buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	let pos = 0;
	const token = () => {
		for (;;) {
			while (pos < buf.length && isSpace(buf[pos])) pos++;
			if (buf[pos] !== 0x23) break;
			while (pos < buf.length && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos++;
		}
		const from = pos;
		while (pos < buf.length && pos - from < 16 && !isSpace(buf[pos]) && buf[pos] !== 0x23) pos++;
		return buf.toString('latin1', from, pos);
	};
	const bad = (why) => Object.assign(new Error(`not a binary PPM: ${why}`), { code: 'bad-ppm' });
	if (token() !== 'P6') throw bad('magic');
	const width = Number(token());
	const height = Number(token());
	const max = Number(token());
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw bad('size');
	if (max !== 255) throw bad('depth');
	if (pos >= buf.length || !isSpace(buf[pos])) throw bad('header');
	pos++;
	const bytes = width * height * 3;
	if (buf.length - pos < bytes) throw bad('short');
	return { width, height, data: buf.subarray(pos, pos + bytes) };
}

/**
 * A box-averaged copy `height` px tall, width in proportion.
 * @param {{ width: number, height: number, data: Uint8Array }} img
 * @param {number} height
 * @returns {{ width: number, height: number, data: Buffer }}
 */
function downscale(img, height) {
	const W = img.width;
	const H = img.height;
	const src = img.data;
	const h = Math.max(1, Math.round(height));
	const w = Math.max(1, Math.round(W * h / H));
	const out = Buffer.alloc(w * h * 3);
	for (let oy = 0; oy < h; oy++) {
		const y0 = Math.floor(oy * H / h);
		const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * H / h));
		for (let ox = 0; ox < w; ox++) {
			const x0 = Math.floor(ox * W / w);
			const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * W / w));
			let r = 0;
			let g = 0;
			let b = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0, p = (y * W + x0) * 3; x < x1; x++, p += 3) {
					r += src[p];
					g += src[p + 1];
					b += src[p + 2];
				}
			}
			const n = (y1 - y0) * (x1 - x0);
			const q = (oy * w + ox) * 3;
			out[q] = Math.round(r / n);
			out[q + 1] = Math.round(g / n);
			out[q + 2] = Math.round(b / n);
		}
	}
	return { width: w, height: h, data: out };
}

// Body text and running heads are 8-16 pt tall on #384; OCR junk read off a picture is a lone
// short fragment or a box of odd height, and masking it would hide part of the picture.
function isTextLine(line) {
	const h = line.yMax - line.yMin;
	if (!(h >= 5 && h <= 18)) return false;
	const words = (line.words || []).filter((w) => /\p{L}{2,}/u.test(w.text));
	return words.length >= 2 || (words.length === 1 && words[0].text.length >= 4);
}

function textMask(img, page, pad) {
	const { width: w, height: h } = img;
	const mask = new Uint8Array(w * h);
	const sx = w / Number(page && page.width);
	const sy = h / Number(page && page.height);
	if (!(sx > 0) || !(sy > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return mask;
	for (const l of page.lines || []) {
		if (!isTextLine(l)) continue;
		const x0 = Math.max(0, Math.floor(l.xMin * sx) - pad);
		const x1 = Math.min(w - 1, Math.ceil(l.xMax * sx) - 1 + pad);
		const y0 = Math.max(0, Math.floor(l.yMin * sy) - pad);
		const y1 = Math.min(h - 1, Math.ceil(l.yMax * sy) - 1 + pad);
		for (let y = y0; y <= y1; y++) mask.fill(1, y * w + x0, y * w + x1 + 1);
	}
	return mask;
}

const lumAt = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

function medianRgb(r, g, b) {
	const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
	return [med(r), med(g), med(b)];
}

// The paper between the glyphs of the page's text lines: the bright half of their pixels.
function paperSample(img, mask) {
	const r = [];
	const g = [];
	const b = [];
	const d = img.data;
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		const p = i * 3;
		if (lumAt(d, p) > BRIGHT_LUM) { r.push(d[p]); g.push(d[p + 1]); b.push(d[p + 2]); }
	}
	return r.length < PAPER_MIN_PIXELS ? null : medianRgb(r, g, b);
}

// Only for a page met before any page with text: its own bright pixels stand in for the paper,
// so a blank page is not taken for a picture.
function brightMedian(img) {
	const r = [];
	const g = [];
	const b = [];
	const d = img.data;
	for (let p = 0; p + 2 < d.length; p += 3) {
		if (lumAt(d, p) > BRIGHT_LUM) { r.push(d[p]); g.push(d[p + 1]); b.push(d[p + 2]); }
	}
	return r.length < PAPER_MIN_PIXELS ? null : medianRgb(r, g, b);
}

const validPaper = (p) => (Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v)) ? p : null);

function patchesOf(on, w, h) {
	const seen = new Uint8Array(on.length);
	const stack = new Int32Array(on.length);
	const out = [];
	for (let s = 0; s < on.length; s++) {
		if (!on[s] || seen[s]) continue;
		let top = 0;
		let size = 0;
		let x0 = w;
		let y0 = h;
		let x1 = -1;
		let y1 = -1;
		stack[top++] = s;
		seen[s] = 1;
		while (top) {
			const i = stack[--top];
			size++;
			const x = i % w;
			const y = (i - x) / w;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const j = ny * w + nx;
					if (on[j] && !seen[j]) {
						seen[j] = 1;
						stack[top++] = j;
					}
				}
			}
		}
		out.push({ size, x0, y0, x1, y1 });
	}
	return out;
}

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Whether a page carries a picture, from its 110 px render and its OCR lines.
 * @param {{ width: number, height: number, data: Uint8Array }} small
 * @param {{ width: number, height: number, lines: Array }} page parsed bbox-layout page
 * @param {{ paper?: number[], textWords?: number, inkDist?: number }} [opts] paper: the book's
 *   paper colour so far; textWords: the page's OCR token count (readingOrder's when omitted)
 * @returns {{ paper: number[]|null, largest: number, patches: Array<{ frac: number, box: number[] }>,
 *   art: boolean, full: boolean, crop: number[]|null }} paper is this page's own sample (null
 *   with no text lines) for the caller's running median; patches are those of at least 1.5% of
 *   the page, largest first; boxes and crop are [x0, y0, x1, y1] fractions of the page. A picture
 *   page with fewer than DEFAULTS.textPageTokens OCR tokens is a full page and has no crop. A page
 *   whose patches together are an edge sliver (EDGE_SLIVER_WIDTH) has no art, whatever their size.
 */
function scorePage(small, page, opts = {}) {
	const inkDist = Number.isFinite(opts.inkDist) ? opts.inkDist : INK_DIST;
	const { width: w, height: h, data } = small;
	const mask = textMask(small, page, MASK_PAD);
	const own = paperSample(small, mask);
	const paper = validPaper(opts.paper) || own || brightMedian(small) || WHITE;
	const n = w * h;
	const on = new Uint8Array(n);
	const limit = inkDist * inkDist;
	for (let i = 0, p = 0; i < n; i++, p += 3) {
		if (mask[i]) continue;
		const dr = data[p] - paper[0];
		const dg = data[p + 1] - paper[1];
		const db = data[p + 2] - paper[2];
		if (dr * dr + dg * dg + db * db > limit) on[i] = 1;
	}
	const comps = patchesOf(on, w, h);
	let most = 0;
	for (const c of comps) if (c.size > most) most = c.size;
	const largest = n ? most / n : 0;
	const patches = comps
		.filter((c) => c.size >= CROP_MIN_BLOB * n)
		.sort((a, b) => b.size - a.size)
		.map((c) => ({ frac: round4(c.size / n), box: [round4(c.x0 / w), round4(c.y0 / h), round4((c.x1 + 1) / w), round4((c.y1 + 1) / h)] }));
	const u = patches.length ? patches.reduce((a, p) => [Math.min(a[0], p.box[0]), Math.min(a[1], p.box[1]), Math.max(a[2], p.box[2]), Math.max(a[3], p.box[3])], [1, 1, 0, 0]) : null;
	const sliver = !!u && (u[0] <= EDGE_SLIVER_MARGIN || u[2] >= 1 - EDGE_SLIVER_MARGIN) && u[2] - u[0] < EDGE_SLIVER_WIDTH;
	const art = largest >= ART_BLOB && !sliver;
	const textWords = Number.isFinite(opts.textWords) ? opts.textWords : readingOrder(page).length;
	const full = art && textWords < DEFAULTS.textPageTokens;
	let crop = null;
	if (art && !full && u) {
		crop = [round4(Math.max(0, u[0] - CROP_PAD)), round4(Math.max(0, u[1] - CROP_PAD)), round4(Math.min(1, u[2] + CROP_PAD)), round4(Math.min(1, u[3] + CROP_PAD))];
	}
	return { paper: own, largest, patches, art, full, crop };
}

function edgeInk(img, paper, inkDist, x, y) {
	const p = (y * img.width + x) * 3;
	const d = img.data;
	const dr = d[p] - paper[0];
	const dg = d[p + 1] - paper[1];
	const db = d[p + 2] - paper[2];
	return dr * dr + dg * dg + db * db > inkDist * inkDist;
}

function edgeColour(img, y, side) {
	const out = [0, 0, 0];
	for (let k = 0; k < SPREAD_EDGE; k++) {
		const x = side === 'right' ? img.width - 1 - k : k;
		const p = (y * img.width + x) * 3;
		for (let c = 0; c < 3; c++) out[c] += img.data[p + c] / SPREAD_EDGE;
	}
	return out;
}

/**
 * Whether two facing full pages are one picture across the gutter: both edge columns at the
 * gutter carry ink in at least half of 60 sampled rows, and the median colour distance across
 * it is at most 60. Rows are compared at the same fraction of the page height, since the two
 * renders can differ by a pixel.
 * @param {{ width, height, data }} left the left page's 110 px render
 * @param {{ width, height, data }} right the right page's
 * @param {{ paper?: number[], inkDist?: number }} [opts]
 * @returns {boolean}
 */
function isSpread(left, right, opts = {}) {
	const inkDist = Number.isFinite(opts.inkDist) ? opts.inkDist : INK_DIST;
	const paper = validPaper(opts.paper) || brightMedian(left) || WHITE;
	if (left.width < SPREAD_EDGE || right.width < SPREAD_EDGE) return false;
	const allInk = (img, side, y) => {
		for (let k = 0; k < SPREAD_EDGE; k++) {
			if (!edgeInk(img, paper, inkDist, side === 'right' ? img.width - 1 - k : k, y)) return false;
		}
		return true;
	};
	let both = 0;
	const dist = [];
	for (let k = 0; k < SPREAD_ROWS; k++) {
		const ya = Math.min(left.height - 1, Math.floor((k + 0.5) * left.height / SPREAD_ROWS));
		const yb = Math.min(right.height - 1, Math.floor((k + 0.5) * right.height / SPREAD_ROWS));
		const ia = allInk(left, 'right', ya);
		const ib = allInk(right, 'left', yb);
		if (ia && ib) both++;
		if (ia || ib) {
			const a = edgeColour(left, ya, 'right');
			const b = edgeColour(right, yb, 'left');
			dist.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
		}
	}
	if (!dist.length || both / SPREAD_ROWS < SPREAD_BOTH_INK) return false;
	dist.sort((x, y) => x - y);
	return dist[dist.length >> 1] <= SPREAD_MAX_DIST;
}

/**
 * The scan page number minus the printed page number, the mode over every folio the OCR read
 * (a number alone on its line in the head or foot band); null with fewer than 3 agreeing or no
 * majority. Left pages are the even printed pages.
 * @param {Array<{ n: number, height: number, lines: Array }>} pages parsed bbox-layout pages
 * @returns {number|null}
 */
function folioOffset(pages) {
	const votes = new Map();
	let total = 0;
	for (const page of Array.isArray(pages) ? pages : []) {
		const H = Number(page && page.height);
		if (!(H > 0) || !Number.isInteger(page.n)) continue;
		for (const l of page.lines || []) {
			const c = (l.yMin + l.yMax) / 2 / H;
			if (!(c < HEAD_BAND || c > FOOT_BAND)) continue;
			// A number among other words is a chapter number or a year in a running head. Counted,
			// one on every page halves the folios' share and the offset is lost, and with it which
			// full pages may open a spread.
			const words = l.words || [];
			if (words.length !== 1 || !/^\d{1,4}$/.test(words[0].text)) continue;
			const d = page.n - Number(words[0].text);
			total++;
			votes.set(d, (votes.get(d) || 0) + 1);
		}
	}
	let best = null;
	let count = 0;
	for (const [d, c] of votes) {
		if (c > count) {
			best = d;
			count = c;
		}
	}
	return count >= FOLIO_MIN_VOTES && count * 2 > total ? best : null;
}

function isJpeg(b) {
	return Buffer.isBuffer(b) && b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

function jpegSize(b) {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const m = b[i + 1];
		if (m === 0xff) {
			i++;
			continue;
		}
		if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
			i += 2;
			continue;
		}
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
		i += 2 + b.readUInt16BE(i + 2);
	}
	return null;
}

function cropPixels(crop, W, H) {
	const x = Math.max(0, Math.floor(crop[0] * W));
	const y = Math.max(0, Math.floor(crop[1] * H));
	let w = Math.min(W, Math.ceil(crop[2] * W)) - x;
	let h = Math.min(H, Math.ceil(crop[3] * H)) - y;
	w -= w % 2;
	h -= h % 2;
	if (w < 2 || h < 2 || (x === 0 && y === 0 && w >= W - 1 && h >= H - 1)) return null;
	return { x, y, w, h };
}

function toolOf(t) {
	if (typeof t === 'string' && t) return { exe: t, args: [] };
	if (t && typeof t.exe === 'string' && t.exe) return { exe: t.exe, args: Array.isArray(t.args) ? t.args.map(String) : [] };
	return null;
}

function limitsOf(l) {
	const o = l && typeof l === 'object' ? l : {};
	const int = (v, d, min) => (Number.isInteger(v) && v >= min ? v : d);
	return {
		maxPages: int(o.maxPages, MAX_PAGES, 1),
		maxPictures: int(o.maxPictures, MAX_PICTURES, 0),
		maxPictureBytes: int(o.maxPictureBytes, MAX_PICTURE_BYTES, 1024),
		renderHeight: int(o.renderHeight, RENDER_HEIGHT, SCORE_HEIGHT)
	};
}

// The book's paper colour so far: the median of the text pages' own samples, as the design took
// the median over #384's pages with text so a page of art is never taken for paper. Only text
// pages count: #384's endpaper (7 OCR tokens) samples darker and made the blank page after it
// look like a picture.
function paperRunner() {
	const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
	let count = 0;
	return {
		add(rgb) {
			for (let c = 0; c < 3; c++) hist[c][Math.max(0, Math.min(255, Math.round(rgb[c])))]++;
			count++;
		},
		value() {
			if (!count) return null;
			return hist.map((h) => {
				let cum = 0;
				for (let v = 0; v < 256; v++) {
					cum += h[v];
					if (cum > count >> 1) return v;
				}
				return 255;
			});
		}
	};
}

// Whether the first or last ENCRYPT_PROBE_BYTES of the PDF carry an /Encrypt entry. A file that
// cannot be read is no proof of a password, so it stays damaged.
function hasEncrypt(fs, pdfPath) {
	let fd = null;
	try {
		fd = fs.openSync(pdfPath, 'r');
		const size = fs.fstatSync(fd).size;
		const read = (from, len) => {
			const buf = Buffer.alloc(len);
			return buf.toString('latin1', 0, fs.readSync(fd, buf, 0, len, from));
		};
		if (size <= 2 * ENCRYPT_PROBE_BYTES) return ENCRYPT_RE.test(read(0, size));
		return ENCRYPT_RE.test(read(0, ENCRYPT_PROBE_BYTES)) || ENCRYPT_RE.test(read(size - ENCRYPT_PROBE_BYTES, ENCRYPT_PROBE_BYTES));
	} catch (_) {
		return false;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch (_) { /* nothing left to release */ }
		}
	}
}

function textFailure(r, encrypted) {
	if (!r) return 'io-error';
	if (r.code === 'missing') return 'tools-missing';
	if (r.code === 'timeout') return 'timeout';
	if (r.code === 'too-big') return 'too-large';
	if (r.code !== 'exit') return 'io-error';
	// Poppler's exit codes: 1 the PDF would not open, 2 the output file, 3 permissions.
	if (r.exit === 3) return 'pdf-encrypted';
	if (r.exit === 2) return 'io-error';
	if (r.exit === 1 && encrypted()) return 'pdf-encrypted';
	return 'pdf-damaged';
}

const pad = (n) => String(n).padStart(3, '0');

// The PPM frame alone, as pdftoppm wrote it, without any byte after it.
const frameOf = (ppm, img) => ppm.subarray(0, img.data.byteOffset - ppm.byteOffset + img.data.length);

/**
 * Reads a PDF for pictures: its word boxes once, then each page rendered once, scored, and its
 * picture written into outDir as p022.jpg (or p062-063.jpg for a spread). Writes nothing else
 * into outDir; the word boxes go to `<tmpDir>/words.html` (tmpDir defaults to outDir's parent)
 * and are deleted once read. A page that fails to render is skipped, and a picture ffmpeg fails
 * to encode is dropped, up to MAX_LOST of them (or MAX_LOST_SHARE of the pages) together.
 * @param {{ pdfPath: string, outDir: string, tmpDir?: string,
 *   tools: { pdftotext: string, pdftoppm: string, ffmpeg: string|{ exe: string, args?: string[] } },
 *   limits?: { maxPages?: number, maxPictures?: number, maxPictureBytes?: number, renderHeight?: number } }} job
 * @param {{ runTool: Function, onProgress?: (p: { stage: 'text'|'render', done: number, total: number }) => void, fs?: object }} deps
 * @returns {Promise<{ pageCount: number, pages: Array<{ n, keys: Uint32Array, textWords, art, full, boxes }>,
 *   pictures: Array<{ id, file, pages, kind: 'part'|'full'|'spread', width, height, bytes }>,
 *   spreads: number, textPages: number, folioOffset: number|null, skipped: number, encodeFailed: number }>}
 *   folioOffset is the scan page minus the printed page; skipped counts the pages that would not
 *   render or score, encodeFailed the pictures dropped because ffmpeg failed (not for their size)
 * @throws {Error} with a code: pdf-damaged, pdf-encrypted, no-text-layer, too-large, timeout,
 *   tools-missing, io-error; crash when more were lost than that, or when pages scored as art
 *   and not one JPG was written
 */
async function scanPdf(job, deps = {}) {
	const { pdfPath, outDir } = job || {};
	const fs = deps.fs || require('fs');
	const runTool = deps.runTool;
	const tools = job && job.tools ? { pdftotext: toolOf(job.tools.pdftotext), pdftoppm: toolOf(job.tools.pdftoppm), ffmpeg: toolOf(job.tools.ffmpeg) } : {};
	if (typeof runTool !== 'function' || !tools.pdftotext || !tools.pdftoppm || !tools.ffmpeg) throw failure('tools-missing');
	if (typeof pdfPath !== 'string' || !pdfPath || typeof outDir !== 'string' || !outDir) throw failure('io-error');
	const lim = limitsOf(job.limits);
	const tmpDir = typeof job.tmpDir === 'string' && job.tmpDir ? job.tmpDir : pathMod.dirname(outDir);
	const progress = (stage, done, total) => {
		try {
			if (typeof deps.onProgress === 'function') deps.onProgress({ stage, done, total });
		} catch (_) { /* a progress listener never stops the scan */ }
	};
	const run = async (tool, args, opts) => {
		try {
			return await runTool(tool.exe, [...tool.args, ...args], { cwd: tmpDir, ...opts });
		} catch (_) {
			return null;
		}
	};

	try {
		fs.mkdirSync(outDir, { recursive: true });
		fs.mkdirSync(tmpDir, { recursive: true });
	} catch (_) {
		throw failure('io-error');
	}

	progress('text', 0, 1);
	const wordsPath = pathMod.join(tmpDir, WORDS_FILE);
	const text = await run(tools.pdftotext, ['-enc', 'UTF-8', '-bbox-layout', '-f', '1', '-l', String(lim.maxPages + 1), pdfPath, wordsPath], { timeoutMs: TEXT_TIMEOUT_MS });
	let xhtml;
	try {
		if (!text || !text.ok) throw failure(textFailure(text, () => hasEncrypt(fs, pdfPath)));
		let size;
		try {
			size = fs.statSync(wordsPath).size;
		} catch (_) {
			throw failure('pdf-damaged');
		}
		if (size > MAX_WORDS_BYTES) throw failure('too-large');
		try {
			xhtml = fs.readFileSync(wordsPath, 'utf8');
		} catch (_) {
			throw failure('io-error');
		}
	} finally {
		try {
			fs.unlinkSync(wordsPath);
		} catch (_) { /* never written, or already gone */ }
	}
	const layout = parseBboxLayout(xhtml);
	xhtml = null;
	if (!layout.length) throw failure('pdf-damaged');
	if (layout.length > lim.maxPages) throw failure('too-large');
	const pages = layout.map((p) => {
		const keys = Uint32Array.from(readingOrder(p), (t) => tokenKey(t));
		return { n: p.n, keys, textWords: keys.length, art: false, full: false, boxes: [] };
	});
	const textPages = pages.filter((p) => p.textWords >= DEFAULTS.textPageTokens).length;
	if (!textPages) throw failure('no-text-layer');
	progress('text', 1, 1);

	const offset = folioOffset(layout);
	const isLeft = (n) => offset === null || ((n - offset) % 2 + 2) % 2 === 0;
	const paper = paperRunner();
	const pictures = [];
	const room = () => pictures.length < lim.maxPictures;
	const maxLost = Math.max(MAX_LOST, Math.ceil(layout.length * MAX_LOST_SHARE));
	let pending = null;
	let skipped = 0;
	let encodeFailed = 0;
	let timeouts = 0;
	const lost = () => {
		if (skipped + encodeFailed > maxLost) throw failure('crash');
	};

	// The JPG; 'too-big' when even the last step is over maxPictureBytes; 'failed' when ffmpeg
	// gave no JPG at all.
	const encode = async (input, filters) => {
		for (const step of ENCODE_STEPS) {
			const vf = [...filters, ...(step.half ? ['scale=iw/2:-2'] : [])].join(',');
			const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'ppm_pipe', '-i', 'pipe:0'];
			if (vf) args.push('-vf', vf);
			args.push('-frames:v', '1', '-q:v', String(step.q), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1');
			const r = await run(tools.ffmpeg, args, { timeoutMs: ENCODE_TIMEOUT_MS, maxStdoutBytes: MAX_JPEG_BYTES, input });
			if (r && r.code === 'missing') throw failure('tools-missing');
			if (r && r.code === 'too-big') continue;
			if (!r || !r.ok || !isJpeg(r.stdout)) return 'failed';
			if (r.stdout.length <= lim.maxPictureBytes) return r.stdout;
		}
		return 'too-big';
	};
	const save = (id, list, kind, jpg, size) => {
		const file = `${id}.jpg`;
		if (!NAME_RE.test(file)) return;
		try {
			fs.writeFileSync(pathMod.join(outDir, file), jpg);
		} catch (_) {
			throw failure('io-error');
		}
		const got = jpegSize(jpg) || size;
		pictures.push({ id, file, pages: list, kind, width: got.width, height: got.height, bytes: jpg.length });
	};
	const one = async (n, shot, kind, crop) => {
		if (!room()) return;
		const c = kind === 'part' && crop ? cropPixels(crop, shot.img.width, shot.img.height) : null;
		const jpg = await encode(frameOf(shot.ppm, shot.img), c ? [`crop=${c.w}:${c.h}:${c.x}:${c.y}`] : []);
		if (Buffer.isBuffer(jpg)) {
			save(`p${pad(n)}`, [n], kind, jpg, c ? { width: c.w, height: c.h } : { width: shot.img.width, height: shot.img.height });
		} else if (jpg === 'failed') {
			encodeFailed++;
			lost();
		}
	};
	const flush = async () => {
		if (!pending) return;
		const left = pending;
		pending = null;
		await one(left.n, left, 'full', null);
	};
	const join = async (left, n, shot) => {
		if (!room()) return;
		const jpg = await encode([frameOf(left.ppm, left.img), frameOf(shot.ppm, shot.img)], ['tile=2x1']);
		if (Buffer.isBuffer(jpg)) {
			save(`p${pad(left.n)}-${pad(n)}`, [left.n, n], 'spread', jpg, { width: left.img.width * 2, height: left.img.height });
			return;
		}
		// A failed join loses no picture yet: each page is tried on its own, and those count.
		await one(left.n, left, 'full', null);
		await one(n, shot, 'full', null);
	};
	const render = async (n) => {
		const r = await run(tools.pdftoppm, ['-f', String(n), '-l', String(n), '-singlefile', '-scale-to-x', '-1', '-scale-to-y', String(lim.renderHeight), pdfPath], { timeoutMs: RENDER_TIMEOUT_MS, maxStdoutBytes: MAX_RENDER_BYTES });
		if (!r || !r.ok || !Buffer.isBuffer(r.stdout)) return { ok: false, code: r ? r.code : 'spawn' };
		try {
			return { ok: true, ppm: r.stdout, img: parsePpm(r.stdout) };
		} catch (_) {
			return { ok: false, code: 'bad-output' };
		}
	};

	for (let k = 0; k < layout.length && room(); k++) {
		const n = k + 1;
		const shot = await render(n);
		progress('render', n, layout.length);
		if (!shot.ok) {
			if (shot.code === 'missing') throw failure('tools-missing');
			timeouts = shot.code === 'timeout' ? timeouts + 1 : 0;
			if (timeouts >= MAX_TIMEOUTS_IN_A_ROW) throw failure('timeout');
			skipped++;
			lost();
			await flush();
			continue;
		}
		timeouts = 0;
		let small;
		let s;
		try {
			small = downscale(shot.img, SCORE_HEIGHT);
			s = scorePage(small, layout[k], { paper: paper.value(), textWords: pages[k].textWords });
		} catch (_) {
			skipped++;
			lost();
			await flush();
			continue;
		}
		if (s.paper && pages[k].textWords >= DEFAULTS.textPageTokens) paper.add(s.paper);
		pages[k].art = s.art;
		pages[k].full = s.full;
		pages[k].boxes = s.patches.map((p) => p.box);
		if (!s.art) {
			await flush();
		} else if (!s.full) {
			await flush();
			await one(n, shot, 'part', s.crop);
		} else if (pending && pending.n === n - 1 && pending.img.width === shot.img.width && pending.img.height === shot.img.height
			&& isSpread(pending.small, small, { paper: paper.value() })) {
			const left = pending;
			pending = null;
			await join(left, n, shot);
		} else {
			await flush();
			if (isLeft(n)) pending = { n, ppm: shot.ppm, img: shot.img, small };
			else await one(n, shot, 'full', null);
		}
	}
	await flush();
	// Every picture found was lost, though too few to pass maxLost: an ffmpeg that fails each
	// time, in a book with few pictures. With maxPictures 0 no page is scored at all.
	if (!pictures.length && pages.some((p) => p.art)) throw failure('crash');
	return {
		pageCount: layout.length,
		pages,
		pictures,
		spreads: pictures.filter((p) => p.kind === 'spread').length,
		textPages,
		folioOffset: offset,
		skipped,
		encodeFailed
	};
}

module.exports = {
	parseBboxLayout,
	parsePpm,
	downscale,
	scorePage,
	isSpread,
	folioOffset,
	scanPdf
};
