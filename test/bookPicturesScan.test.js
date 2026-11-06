// helpers/bookPicturesScan.js: a scanned PDF's text layer, pictures, spreads and JPGs.
//
// The bugs it guards against: pdftotext's CRLF lines or escaped quotes breaking the word boxes;
// a PPM read past its own frame, or a 16-bit or grey one taken for RGB; text lines scored as a
// picture, a paint speck stretching a crop box, a scanner's shadow or the facing page's bleed at
// the edge taken for a picture, a page of art with a little text kept whole or a full painting
// cut down; a spread joined from two different pictures, from pages of two sizes or from a right
// page and the left page after it, or the folios lost to numbers in the running heads; a JPG over
// the size cap kept; the word boxes file or anything but the JPGs left in the output folder; one
// bad page failing the whole book; a hung pdftoppm walking all 264 pages one 30 s timeout at a
// time; a scan that lost most pages or every picture to a broken tool installed as finished; and
// a damaged, password-protected, image-only or oversized PDF reported as anything but its code.
//
// Harness: the tools are a fake runTool. Its pdftotext writes XHTML built by
// test/fixtures/bookPictures/synth.js to the path it is given, its pdftoppm answers with PPMs
// painted here (paper, text lines with glyph gaps, pictures, full-page paintings), and its ffmpeg
// reads the PPM frames it is fed and answers with a JPEG-shaped buffer whose SOF0 carries the
// size the crop, tile or scale filter would give. Output goes to a pid-suffixed temp dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const scan = require('../helpers/bookPicturesScan.js');
const { readingOrder, tokenKey, DEFAULTS } = require('../helpers/bookPicturesAlign.js');
const fx = require('./fixtures/bookPictures/synth.js');

const { parseBboxLayout, parsePpm, downscale, scorePage, isSpread, folioOffset, scanPdf } = scan;

const TMP = pathMod.join(os.tmpdir(), `plexbot-test-bookpicturesscan-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const W = 225;
const H = 276;
const PAPER = [200, 198, 190];
const GLYPH = [35, 32, 30];
const NAME_RE = /^p\d{3,4}(-\d{3,4})?\.jpg$/;
const TOOLS = { pdftotext: 'C:/fake/bin/pdftotext.exe', pdftoppm: 'C:/fake/bin/pdftoppm.exe', ffmpeg: 'C:/fake/ffmpeg.exe' };
const VOCAB = fx.vocabulary(fx.rng(42), 300);

let dirs = 0;
function freshDir() {
	const dir = pathMod.join(TMP, `case-${++dirs}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// Two columns of text near the top of the page, 6 words a line: 36 OCR tokens for 3 rows.
function textLines({ rows = 3, seed = 1 } = {}) {
	const rand = fx.rng(seed);
	const word = () => VOCAB[Math.floor(rand() * VOCAB.length)];
	const lines = [fx.lineOf(['THE', 'SYNTH', 'BOOK'], 226.2, 24.3, 9.5)];
	for (let c = 0; c < 2; c++) {
		for (let r = 0; r < rows; r++) lines.push(fx.lineOf(Array.from({ length: 6 }, word), fx.COL_X[c], 82.8 + r * 13.2));
	}
	return lines;
}

const folioLine = (folio) => fx.lineOf([String(folio)], 275.4, 655.8, 12.4);

// A page: its OCR (parsed bbox-layout shape) and a painter for its render at any size.
function page({ lines = [], folio = null, rects = [], fill = null, width = W, bg = PAPER } = {}) {
	const all = folio === null ? lines : [...lines, folioLine(folio)];
	const ocr = { width: fx.PAGE_W, height: fx.PAGE_H, lines: all };
	const paint = (x, y, w, h) => {
		const fxp = (x + 0.5) / w;
		const fyp = (y + 0.5) / h;
		if (fill) return fill(fxp, fyp);
		for (const r of rects) {
			if (fxp >= r.box[0] && fxp < r.box[2] && fyp >= r.box[1] && fyp < r.box[3]) return r.colour;
		}
		for (const l of all) {
			if (fxp * fx.PAGE_W >= l.xMin && fxp * fx.PAGE_W < l.xMax && fyp * fx.PAGE_H >= l.yMin && fyp * fx.PAGE_H < l.yMax) return x % 3 === 0 ? GLYPH : bg;
		}
		return bg;
	};
	return { ocr, paint, width };
}

const render = (p, height = H) => fx.ppmOf(p.width, height, (x, y) => p.paint(x, y, p.width, height));

const skyA = (fxp, fyp) => [50 + Math.round(30 * fyp), 90, 150];
const skyB = (fxp, fyp) => [205, 60 + Math.round(20 * fyp), 40];

function fakeTools({ xhtml, renders, jpegBytes = () => 600, text = null }) {
	const calls = [];
	const runTool = async (exe, args, opts = {}) => {
		calls.push({ exe, args: args.slice(), opts });
		if (exe === TOOLS.pdftotext) {
			if (text) return text;
			fs.writeFileSync(args[args.length - 1], xhtml);
			return { ok: true, code: 'ok', exit: 0, stdout: null };
		}
		if (exe === TOOLS.pdftoppm) {
			const r = renders(Number(args[args.indexOf('-f') + 1]));
			if (!r) return { ok: false, code: 'exit', exit: 1, stdout: null };
			if (!Buffer.isBuffer(r)) return { ok: false, code: r.code, exit: null, stdout: null };
			return { ok: true, code: 'ok', exit: 0, stdout: r };
		}
		if (exe === TOOLS.ffmpeg) {
			const frames = (Array.isArray(opts.input) ? opts.input : [opts.input]).map((b) => parsePpm(b));
			const vf = args.includes('-vf') ? args[args.indexOf('-vf') + 1] : '';
			let w = frames[0].width;
			let h = frames[0].height;
			for (const f of vf.split(',').filter(Boolean)) {
				const crop = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(f);
				if (crop) {
					w = Number(crop[1]);
					h = Number(crop[2]);
				} else if (f === 'tile=2x1') {
					if (frames.length !== 2 || frames[1].width !== w || frames[1].height !== h) return { ok: false, code: 'exit', exit: 1, stdout: null };
					w *= 2;
				} else if (f === 'scale=iw/2:-2') {
					w = Math.floor(w / 2);
					h = Math.floor(h / 4) * 2;
				} else {
					return { ok: false, code: 'exit', exit: 1, stdout: null };
				}
			}
			return { ok: true, code: 'ok', exit: 0, stdout: fx.jpegOf(w, h, jpegBytes(Number(args[args.indexOf('-q:v') + 1]), frames)) };
		}
		return { ok: false, code: 'missing', exit: null, stdout: null };
	};
	return { runTool, calls, of: (exe) => calls.filter((c) => c.exe === exe) };
}

// The book of the end-to-end case. Printed page = scan page - 2, so even scan pages are left:
// page 5 is a right page and must not join page 6, however alike they are at the edge.
function testBook() {
	const pages = [
		page(),
		page({ lines: textLines({ seed: 2 }) }),
		page({ lines: textLines({ seed: 3 }), folio: 1, rects: [{ box: [0.1, 0.6, 0.9, 0.9], colour: [60, 110, 70] }, { box: [0.05, 0.4, 0.15, 0.5], colour: [150, 40, 40] }] }),
		page({ lines: textLines({ seed: 4 }), folio: 2 }),
		page({ fill: skyA }),
		page({ fill: skyA }),
		page({ fill: skyA }),
		page({ fill: skyA }),
		page({ fill: skyB }),
		page({ lines: textLines({ seed: 10 }), folio: 8 }),
		page({ lines: textLines({ seed: 11 }), folio: 9 }),
		page({ fill: skyA, width: 231 }),
		page({ fill: skyA }),
		page({ lines: textLines({ seed: 14 }), folio: 12 })
	];
	return { pages, xhtml: fx.xhtmlOf(pages.map((p) => p.ocr), { crlf: true }) };
}

async function rejectsWith(promise, code) {
	await assert.rejects(promise, (err) => {
		assert.strictEqual(err.code, code);
		return true;
	});
}

// ---- parseBboxLayout ----------------------------------------------------------------------------

test('parseBboxLayout reads pages, lines and words, with CRLF or LF and every escape decoded', () => {
	const pages = [
		{ width: 562.2, height: 690.2, lines: [fx.lineOf(['won\'t', 'A&B', '<i>', '"q"'], 56, 80)] },
		{ width: 515.8, height: 678.4, lines: [] },
		{ width: 562.2, height: 690.2, lines: [fx.lineOf(['two', 'lines'], 56, 80), fx.lineOf(['here'], 296, 80)] }
	];
	const crlf = parseBboxLayout(fx.xhtmlOf(pages, { crlf: true }));
	const lf = parseBboxLayout(fx.xhtmlOf(pages));
	assert.deepStrictEqual(crlf, lf);
	assert.deepStrictEqual(parseBboxLayout(Buffer.from(fx.xhtmlOf(pages), 'utf8')), lf);
	assert.deepStrictEqual(crlf.map((p) => [p.n, p.width, p.height, p.lines.length]), [[1, 562.2, 690.2, 1], [2, 515.8, 678.4, 0], [3, 562.2, 690.2, 2]]);
	assert.deepStrictEqual(crlf[0].lines[0].words.map((w) => w.text), ['won\'t', 'A&B', '<i>', '"q"']);
	const w0 = crlf[0].lines[0].words[0];
	assert.deepStrictEqual([w0.xMin, w0.yMin, w0.yMax], [56, 80, 90.9]);
	const xhtml = [
		'<head><title>Fish &amp; Chips</title></head><doc>',
		'<page width="100" height="200">',
		'<word xMin="1" yMin="2" xMax="3" yMax="4">loose</word>',
		'<line xMin="5" yMin="6" xMax="7" yMax="8"></line>',
		'<line xMin="5" yMin="20" xMax="50" yMax="30"><word xMin="5" yMin="20" xMax="20" yMax="30">caf&#233;</word><word xMin="21" yMin="20" xMax="30" yMax="30">caf&#xE9;</word><word xMin="31" yMin="20" xMax="50" yMax="30">&nbsp;x</word><word xMin="1" yMin="2" xMax="bad" yMax="4">dropped</word></line>',
		'</page>',
		'</doc>'
	].join('\r\n');
	const [p] = parseBboxLayout(xhtml);
	assert.deepStrictEqual(p.lines.map((l) => l.words.map((w) => w.text)), [['loose'], ['caf\u00e9', 'caf\u00e9', '&nbsp;x']]);
	assert.deepStrictEqual([p.lines[0].xMin, p.lines[0].yMax], [1, 4]);
	assert.deepStrictEqual(parseBboxLayout(''), []);
});

// ---- parsePpm and downscale ---------------------------------------------------------------------

test('parsePpm reads a binary PPM as a view of its frame and refuses anything else', () => {
	const frame = Buffer.from([1, 2, 3, 4, 5, 6]);
	const buf = Buffer.concat([Buffer.from('P6\n# from pdftoppm\n2 1\n255\n', 'latin1'), frame, Buffer.from('trailing')]);
	const img = parsePpm(buf);
	assert.deepStrictEqual([img.width, img.height], [2, 1]);
	assert.deepStrictEqual([...img.data], [1, 2, 3, 4, 5, 6]);
	assert.strictEqual(img.data.buffer, buf.buffer);
	const bad = [
		Buffer.concat([Buffer.from('P5\n2 1\n255\n', 'latin1'), Buffer.alloc(2)]),
		Buffer.from('P3\n1 1\n255\n1 2 3\n', 'latin1'),
		Buffer.concat([Buffer.from('P6\n1 1\n65535\n', 'latin1'), Buffer.alloc(6)]),
		Buffer.concat([Buffer.from('P6\n2 2\n255\n', 'latin1'), Buffer.alloc(11)]),
		Buffer.from('P6\n0 1\n255\n', 'latin1'),
		Buffer.from('P6\n1 1\n255', 'latin1'),
		Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
		Buffer.alloc(0)
	];
	for (const b of bad) assert.throws(() => parsePpm(b), (err) => err.code === 'bad-ppm', JSON.stringify(b.toString('latin1').slice(0, 12)));
	assert.throws(() => parsePpm('P6 1 1 255 abc'), (err) => err.code === 'bad-ppm');
});

test('downscale box-averages to the height asked, width in proportion', () => {
	const img = parsePpm(fx.ppmOf(4, 4, (x, y) => (x < 2 ? (y < 2 ? [0, 0, 0] : [100, 100, 100]) : (y < 2 ? [200, 0, 0] : [10, 20, 30]))));
	const small = downscale(img, 2);
	assert.deepStrictEqual([small.width, small.height, [...small.data]], [2, 2, [0, 0, 0, 200, 0, 0, 100, 100, 100, 10, 20, 30]]);
	// 3 rows into 2: rows [0, 1) and [1, 3).
	const odd = downscale(parsePpm(fx.ppmOf(1, 3, (x, y) => [y * 30, 0, 0])), 2);
	assert.deepStrictEqual([...odd.data], [0, 0, 0, 45, 0, 0]);
	// #384's 562.2 x 690.2 pt pages render 978 x 1200 and score at 90 x 110, the thumbnails' size.
	const page = { width: 978, height: 1200, data: Buffer.alloc(978 * 1200 * 3, 128) };
	const scored = downscale(page, 110);
	assert.deepStrictEqual([scored.width, scored.height, scored.data[0], scored.data[scored.data.length - 1]], [90, 110, 128, 128]);
});

// ---- scorePage ----------------------------------------------------------------------------------

const smallOf = (p) => downscale(parsePpm(render(p)), 110);
const near = (a, b, tol = 0.025) => Math.abs(a - b) <= tol;

test('scorePage finds a picture on a text page and crops it to the patches of 1.5% or more, padded', () => {
	const p = page({ lines: textLines(), folio: 7, rects: [{ box: [0.1, 0.6, 0.9, 0.9], colour: [60, 110, 70] }, { box: [0.05, 0.4, 0.15, 0.5], colour: [150, 40, 40] }] });
	const s = scorePage(smallOf(p), p.ocr);
	assert.deepStrictEqual(s.paper, PAPER);
	assert.strictEqual(s.art, true);
	assert.strictEqual(s.full, false);
	assert.ok(near(s.largest, 0.24, 0.02), String(s.largest));
	// The 1% paint speck is no patch and does not stretch the crop.
	assert.strictEqual(s.patches.length, 1);
	assert.ok(near(s.patches[0].frac, 0.24, 0.02));
	const [x0, y0, x1, y1] = s.patches[0].box;
	assert.ok(near(x0, 0.1, 0.012) && near(y0, 0.6, 0.01) && near(x1, 0.9, 0.012) && near(y1, 0.9, 0.01), JSON.stringify(s.patches[0].box));
	assert.deepStrictEqual(s.crop.map((v) => Math.round(v * 1000) / 1000), [x0 - 0.02, y0 - 0.02, x1 + 0.02, y1 + 0.02].map((v) => Math.round(v * 1000) / 1000));
});

test('scorePage scores text, folios and blank pages as no picture', () => {
	const text = page({ lines: textLines({ rows: 12 }), folio: 112 });
	const s = scorePage(smallOf(text), text.ocr);
	assert.strictEqual(s.art, false);
	assert.strictEqual(s.crop, null);
	assert.deepStrictEqual(s.patches, []);
	assert.ok(s.largest < 0.005, String(s.largest));
	// Before any page with text there is no paper colour yet; a blank page is still paper.
	const blank = page();
	const b = scorePage(smallOf(blank), blank.ocr);
	assert.deepStrictEqual([b.paper, b.art, b.largest], [null, false, 0]);
});

test('scorePage calls a picture page full below 30 OCR tokens, a text page above it', () => {
	const painting = page({ fill: skyA });
	const full = scorePage(smallOf(painting), painting.ocr, { paper: PAPER });
	assert.deepStrictEqual([full.art, full.full, full.crop, full.paper], [true, true, null, null]);
	assert.ok(full.largest > 0.99);
	// A painting with a passage of text on it (#384's page 22) is a text page: cropped, not whole.
	const lines = textLines({ rows: 3 });
	const withText = page({ lines, rects: [{ box: [0, 0.25, 1, 1], colour: [60, 90, 150] }] });
	const t = scorePage(smallOf(withText), withText.ocr);
	assert.strictEqual(readingOrder(withText.ocr).length >= DEFAULTS.textPageTokens, true);
	assert.deepStrictEqual([t.art, t.full], [true, false]);
	assert.ok(near(t.crop[0], 0) && near(t.crop[1], 0.23) && near(t.crop[2], 1) && near(t.crop[3], 1), JSON.stringify(t.crop));
	assert.strictEqual(scorePage(smallOf(withText), withText.ocr, { textWords: DEFAULTS.textPageTokens - 1 }).full, true);
});

test('scorePage measures ink from the book\'s paper, so a painting paler than the paper is still one', () => {
	const pale = page({ fill: () => [240, 240, 255] });
	assert.strictEqual(scorePage(smallOf(pale), pale.ocr, { paper: PAPER }).art, true);
	// Its own brightest pixels are all it has without the book's paper: they are the painting.
	assert.strictEqual(scorePage(smallOf(pale), pale.ocr).art, false);
});

test('scorePage needs a patch of 2.5% of the page for a picture', () => {
	const lines = textLines();
	const at = (frac) => {
		const side = Math.sqrt(frac);
		const p = page({ lines, rects: [{ box: [0.3, 0.5, 0.3 + side, 0.5 + side], colour: [40, 60, 160] }] });
		return scorePage(smallOf(p), p.ocr);
	};
	assert.strictEqual(at(0.018).art, false);
	assert.strictEqual(at(0.034).art, true);
});

test('scorePage takes a thin sliver at a side edge for no picture, on a text page or a blank one', () => {
	// #384's page 220 is a scanner's shadow 17% wide at a text page's edge, and page 27 a strip of
	// the facing page's painting 12% wide: both far over 2.5%, both useless as pictures.
	const lines = textLines();
	const at = (box, blank = false) => {
		const p = page({ lines: blank ? [] : lines, rects: [{ box, colour: [90, 120, 80] }] });
		return scorePage(smallOf(p), p.ocr, blank ? { paper: PAPER } : {});
	};
	for (const [box, blank] of [[[0, 0, 0.15, 1]], [[0.85, 0, 1, 1]], [[0, 0, 0.12, 0.45]], [[0.85, 0, 1, 1], true]]) {
		const s = at(box, blank);
		assert.ok(s.largest >= 0.025, JSON.stringify(box));
		assert.deepStrictEqual([s.art, s.full, s.crop], [false, false, null], `${JSON.stringify(box)}${blank ? ' on a blank page' : ''}`);
	}
	// Wider at the edge, or as thin away from it, is a picture.
	const wide = at([0, 0.3, 0.25, 0.7]);
	assert.deepStrictEqual([wide.art, wide.full], [true, false]);
	assert.ok(wide.crop[0] === 0 && near(wide.crop[2], 0.27), JSON.stringify(wide.crop));
	const wideBlank = at([0.75, 0, 1, 1], true);
	assert.deepStrictEqual([wideBlank.art, wideBlank.full], [true, true]);
	assert.strictEqual(at([0.425, 0, 0.575, 1]).art, true);
	assert.strictEqual(at([0.425, 0, 0.575, 1], true).full, true);
});

// ---- isSpread and folioOffset -------------------------------------------------------------------

test('isSpread joins one painting across the gutter and nothing else', () => {
	const small = (fill, rects) => smallOf(page({ fill, rects }));
	const opts = { paper: PAPER };
	assert.strictEqual(isSpread(small(skyA), small(skyA), opts), true);
	assert.strictEqual(isSpread(small(skyA), small(skyB), opts), false);
	// Pictures that keep away from the gutter leave paper on both of its edges.
	const leftHalf = small(null, [{ box: [0, 0, 0.6, 1], colour: [60, 90, 150] }]);
	const rightHalf = small(null, [{ box: [0.4, 0, 1, 1], colour: [60, 90, 150] }]);
	assert.strictEqual(isSpread(leftHalf, rightHalf, opts), false);
	assert.strictEqual(isSpread(small(skyA), small(null, []), opts), false);
	// Ink at the gutter in under half the rows is no spread, however alike the colours.
	const lowA = small(null, [{ box: [0, 0.6, 1, 1], colour: [60, 90, 150] }]);
	assert.strictEqual(isSpread(lowA, lowA, opts), false);
	const highA = small(null, [{ box: [0, 0.4, 1, 1], colour: [60, 90, 150] }]);
	assert.strictEqual(isSpread(highA, highA, opts), true);
});

test('folioOffset takes the mode of the folios in the head and foot bands', () => {
	const body = (n, folio, y = 655.8) => ({ n, width: fx.PAGE_W, height: fx.PAGE_H, lines: [...textLines(), fx.lineOf([String(folio)], 275, y, 12.4)] });
	const pages = [];
	for (let n = 13; n <= 30; n++) pages.push(body(n, n - 12, n === 20 ? 30 : 655.8));
	pages.push(body(31, 7), body(32, 400));
	assert.strictEqual(folioOffset(pages), 12);
	// A number in the text band is not a folio.
	assert.strictEqual(folioOffset([body(5, 1, 300), body(6, 2, 300), body(7, 3, 300)]), null);
	assert.strictEqual(folioOffset([body(5, 1), body(6, 2)]), null);
	assert.strictEqual(folioOffset([body(5, 1), body(6, 2), body(7, 3), body(8, 1), body(9, 2), body(10, 3)]), null);
	assert.strictEqual(folioOffset([]), null);
	assert.strictEqual(folioOffset(null), null);
});

test('folioOffset counts only a number alone on its line, not one in a running head', () => {
	// "CHAPTER 7 FLIGHT" on every page: counted, the chapter numbers held half the band numbers
	// and the offset was lost, so any full page could open a spread.
	const headed = [];
	for (let n = 113; n <= 140; n++) {
		const head = fx.lineOf(['CHAPTER', String(7 + Math.floor((n - 113) / 9)), 'FLIGHT'], 200, 24.3, 9.5);
		headed.push({ n, width: fx.PAGE_W, height: fx.PAGE_H, lines: [head, ...textLines().slice(1), folioLine(n - 12)] });
	}
	assert.strictEqual(folioOffset(headed), 12);
});

// ---- scanPdf ------------------------------------------------------------------------------------

test('scanPdf reads a book into page keys, pictures, crops and spreads, and writes only the JPGs', async () => {
	const { pages, xhtml } = testBook();
	const dir = freshDir();
	const outDir = pathMod.join(dir, 'out');
	const renders = (n) => {
		if (n === 10) return null;
		const ppm = render(pages[n - 1]);
		// pdftoppm's stdout holds the frame alone, but the encoder must never be fed past it.
		return n === 7 ? Buffer.concat([ppm, Buffer.from('extra')]) : ppm;
	};
	const tools = fakeTools({ xhtml, renders });
	const progress = [];
	const pdfPath = pathMod.join(dir, 'book.pdf');
	const got = await scanPdf({ pdfPath, outDir, tools: TOOLS, limits: {} }, { runTool: tools.runTool, onProgress: (p) => progress.push(p) });

	assert.deepStrictEqual(got.pictures.map((p) => [p.id, p.kind, p.pages]), [
		['p003', 'part', [3]],
		['p005', 'full', [5]],
		['p006-007', 'spread', [6, 7]],
		['p008', 'full', [8]],
		['p009', 'full', [9]],
		['p012', 'full', [12]],
		['p013', 'full', [13]]
	]);
	assert.deepStrictEqual([got.pageCount, got.textPages, got.spreads, got.skipped, got.encodeFailed, got.folioOffset], [14, 6, 1, 1, 0, 2]);
	assert.deepStrictEqual(got.pages.map((p) => p.n), Array.from({ length: 14 }, (_, k) => k + 1));
	assert.deepStrictEqual(got.pages.filter((p) => p.art).map((p) => [p.n, p.full]), [[3, false], [5, true], [6, true], [7, true], [8, true], [9, true], [12, true], [13, true]]);
	const parsed = parseBboxLayout(xhtml);
	got.pages.forEach((p, k) => {
		assert.deepStrictEqual(p.keys, Uint32Array.from(readingOrder(parsed[k]), (t) => tokenKey(t)), `keys of page ${p.n}`);
		assert.strictEqual(p.textWords, p.keys.length);
	});
	assert.strictEqual(got.pages[2].boxes.length, 1);

	const files = fs.readdirSync(outDir).sort();
	assert.deepStrictEqual(files, got.pictures.map((p) => p.file).sort());
	for (const f of files) assert.match(f, NAME_RE);
	assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['out']);
	for (const p of got.pictures) assert.strictEqual(fs.statSync(pathMod.join(outDir, p.file)).size, p.bytes);
	const size = Object.fromEntries(got.pictures.map((p) => [p.id, [p.width, p.height]]));
	assert.deepStrictEqual([size.p005, size['p006-007'], size.p012, size.p013], [[W, H], [2 * W, H], [231, H], [W, H]]);

	const text = tools.of(TOOLS.pdftotext);
	assert.strictEqual(text.length, 1);
	// One past the 1000-page cap, so a longer PDF is seen to be too large.
	assert.deepStrictEqual(text[0].args, ['-enc', 'UTF-8', '-bbox-layout', '-f', '1', '-l', '1001', pdfPath, pathMod.join(dir, 'words.html')]);
	assert.deepStrictEqual([text[0].opts.cwd, text[0].opts.timeoutMs], [dir, 60000]);
	const ppm = tools.of(TOOLS.pdftoppm);
	assert.deepStrictEqual(ppm.map((c) => Number(c.args[1])), Array.from({ length: 14 }, (_, k) => k + 1));
	assert.deepStrictEqual(ppm[4].args, ['-f', '5', '-l', '5', '-singlefile', '-scale-to-x', '-1', '-scale-to-y', '1200', pdfPath]);
	assert.deepStrictEqual([ppm[4].opts.timeoutMs, ppm[4].opts.maxStdoutBytes], [30000, 32 * 1024 * 1024]);

	const enc = tools.of(TOOLS.ffmpeg);
	assert.strictEqual(enc.length, 7);
	for (const c of enc) {
		assert.deepStrictEqual(c.args.slice(0, 8), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'ppm_pipe', '-i', 'pipe:0']);
		assert.deepStrictEqual(c.args.slice(-9), ['-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
		assert.strictEqual(c.opts.timeoutMs, 15000);
	}
	// The text page's picture is cut out of the full render: the painted box plus the padding.
	const crop = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(enc[0].args[enc[0].args.indexOf('-vf') + 1]).slice(1).map(Number);
	const [cw, ch, cx, cy] = crop;
	assert.ok(cw % 2 === 0 && ch % 2 === 0);
	assert.ok(cx <= 0.1 * W && cx >= 0.06 * W && cy <= 0.6 * H && cy >= 0.56 * H, JSON.stringify(crop));
	assert.ok(cx + cw >= 0.9 * W - 1 && cx + cw <= 0.94 * W && cy + ch >= 0.9 * H - 1 && cy + ch <= 0.94 * H, JSON.stringify(crop));
	assert.strictEqual(enc[1].args.includes('-vf'), false);
	const spread = enc[2];
	assert.deepStrictEqual(spread.args.slice(8, 10), ['-vf', 'tile=2x1']);
	assert.strictEqual(spread.opts.input.length, 2);
	for (const frame of spread.opts.input) assert.strictEqual(frame.length, 15 + W * H * 3);

	assert.deepStrictEqual(progress.slice(0, 2), [{ stage: 'text', done: 0, total: 1 }, { stage: 'text', done: 1, total: 1 }]);
	assert.deepStrictEqual(progress.slice(2), Array.from({ length: 14 }, (_, k) => ({ stage: 'render', done: k + 1, total: 14 })));
});

test('scanPdf pairs facing full pages by their content alone when no folio was read', async () => {
	const lines = textLines({ seed: 21 });
	const pages = [page({ lines }), page({ fill: skyA }), page({ fill: skyA }), page({ fill: skyA }), page({ lines: textLines({ seed: 22 }) })];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const outDir = pathMod.join(freshDir(), 'out');
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir, tools: TOOLS }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures.map((p) => [p.id, p.kind]), [['p002-003', 'spread'], ['p004', 'full']]);
	assert.strictEqual(got.folioOffset, null);
});

test('scanPdf scores each page against the paper of the text pages before it', async () => {
	const pages = [page({ lines: textLines({ seed: 81 }) }), page({ fill: () => [240, 240, 255] }), page({ lines: textLines({ seed: 82 }) })];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures.map((p) => [p.id, p.kind]), [['p002', 'full']]);
});

test('scanPdf takes the book\'s paper from text pages only, not from a card with a few lines', async () => {
	// #384's endpaper carries 7 OCR tokens on a darker ground; taken for paper, it made the
	// blank page after it a picture.
	const card = page({ lines: textLines({ rows: 1, seed: 91 }), bg: [150, 155, 160] });
	assert.ok(readingOrder(card.ocr).length < DEFAULTS.textPageTokens);
	const pages = [card, page(), page({ lines: textLines({ seed: 92 }) })];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures, []);
	assert.deepStrictEqual(got.pages.map((p) => p.art), [false, false, false]);
});

test('scanPdf encodes a JPG over the size cap again, smaller, and drops one it cannot shrink', async () => {
	const pages = [page({ lines: textLines({ seed: 31 }) }), page({ fill: skyB }), page({ lines: textLines({ seed: 32 }) }), page({ fill: skyA }), page({ lines: textLines({ seed: 33 }) })];
	const xhtml = fx.xhtmlOf(pages.map((p) => p.ocr));
	const outDir = pathMod.join(freshDir(), 'out');
	// Page 2 (painted red at the top) shrinks under the cap at the second quality; page 4 never does.
	const sizes = (frames) => (frames[0].data[0] === 205 ? { 3: 5000, 8: 900 } : { 3: 5000, 8: 4000, 12: 3000 });
	const tools = fakeTools({ xhtml, renders: (n) => render(pages[n - 1]), jpegBytes: (q, frames) => sizes(frames)[q] });
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir, tools: TOOLS, limits: { maxPictureBytes: 1024 } }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures.map((p) => [p.id, p.bytes]), [['p002', 900]]);
	// Dropped for its size, which is no failure of ffmpeg's.
	assert.strictEqual(got.encodeFailed, 0);
	assert.deepStrictEqual(fs.readdirSync(outDir), ['p002.jpg']);
	const enc = tools.of(TOOLS.ffmpeg).map((c) => [c.args[c.args.indexOf('-q:v') + 1], c.args.includes('-vf') ? c.args[c.args.indexOf('-vf') + 1] : null]);
	assert.deepStrictEqual(enc, [['3', null], ['8', null], ['3', null], ['8', null], ['12', 'scale=iw/2:-2']]);
});

test('scanPdf stops at maxPictures and renders no page after it', async () => {
	const pages = [
		page({ lines: textLines({ seed: 41 }) }),
		page({ lines: textLines({ seed: 42 }), rects: [{ box: [0.1, 0.5, 0.9, 0.9], colour: [60, 110, 70] }] }),
		page({ fill: skyB }),
		page({ fill: skyA }),
		page({ fill: skyB }),
		page({ lines: textLines({ seed: 43 }) })
	];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const outDir = pathMod.join(freshDir(), 'out');
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir, tools: TOOLS, limits: { maxPictures: 1 } }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures.map((p) => p.id), ['p002']);
	assert.strictEqual(tools.of(TOOLS.pdftoppm).length, 2);
	assert.strictEqual(got.pages.length, 6);
	assert.ok(got.pages[5].keys.length >= DEFAULTS.textPageTokens);
});

test('scanPdf skips a page that will not render and gives up on three timeouts in a row', async () => {
	const pages = [page({ lines: textLines({ seed: 51 }) }), page({ fill: skyB }), page({ lines: textLines({ seed: 52 }) }), page({ fill: skyB }), page({ lines: textLines({ seed: 53 }) })];
	const xhtml = fx.xhtmlOf(pages.map((p) => p.ocr));
	const flaky = { 2: { code: 'timeout' }, 3: { code: 'timeout' }, 4: Buffer.from('P6\n9 9\n255\nshort', 'latin1') };
	const ok = fakeTools({ xhtml, renders: (n) => flaky[n] || render(pages[n - 1]) });
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: ok.runTool });
	assert.deepStrictEqual([got.pictures.length, got.skipped, got.pageCount], [0, 3, 5]);
	const hung = fakeTools({ xhtml, renders: (n) => (n === 1 ? render(pages[0]) : { code: 'timeout' }) });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: hung.runTool }), 'timeout');
	assert.strictEqual(hung.of(TOOLS.pdftoppm).length, 4);
	const gone = fakeTools({ xhtml, renders: () => ({ code: 'missing' }) });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: gone.runTool }), 'tools-missing');
});

// A scan that finished with most pages unread was installed as the book's finished analysis:
// "no pictures the bot could find", and nothing tried again until someone ran pictures:redo.
test('scanPdf fails as a crash once more pages will not render than it may pass over', async () => {
	const { pages, xhtml } = testBook();
	const scanWith = (renders) => {
		const tools = fakeTools({ xhtml, renders });
		return { tools, scan: scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: tools.runTool }) };
	};
	// A pdftoppm that cannot be started: the fourth page lost of 14 ends the scan there.
	const spawn = scanWith(() => ({ code: 'spawn' }));
	await rejectsWith(spawn.scan, 'crash');
	assert.strictEqual(spawn.tools.of(TOOLS.pdftoppm).length, 4);
	// Timeouts on every other page never make three in a row, but they add up.
	const alternate = scanWith((n) => (n % 2 ? { code: 'timeout' } : render(pages[n - 1])));
	await rejectsWith(alternate.scan, 'crash');
	assert.strictEqual(alternate.tools.of(TOOLS.pdftoppm).length, 7);
	// A long book may lose 2% of its pages: 4 of 200, not 5.
	const long = [page({ lines: textLines({ seed: 111 }) }), ...Array.from({ length: 199 }, () => page())];
	const longXhtml = fx.xhtmlOf(long.map((p) => p.ocr));
	const first = render(long[0]);
	const blank = render(long[1]);
	const losing = (count) => fakeTools({ xhtml: longXhtml, renders: (n) => (n === 1 ? first : n <= count + 1 ? { code: 'exit' } : blank) });
	const four = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: losing(4).runTool });
	assert.deepStrictEqual([four.pageCount, four.skipped, four.encodeFailed, four.pictures.length], [200, 4, 0, 0]);
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: losing(5).runTool }), 'crash');
});

test('scanPdf passes over a picture ffmpeg fails to encode, and fails as a crash when it fails more, or every time', async () => {
	const { pages, xhtml } = testBook();
	const scanWith = (fails) => {
		const tools = fakeTools({ xhtml, renders: (n) => render(pages[n - 1]) });
		const runTool = (exe, args, opts) => (exe === TOOLS.ffmpeg && fails(args) ? Promise.resolve({ ok: false, code: 'timeout', exit: null, stdout: null }) : tools.runTool(exe, args, opts));
		return { tools, scan: scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool }) };
	};
	const crop = await scanWith((args) => args.some((a) => a.startsWith('crop='))).scan;
	assert.deepStrictEqual(crop.pictures.map((p) => p.id), ['p005', 'p006-007', 'p008', 'p009', 'p012', 'p013']);
	assert.deepStrictEqual([crop.skipped, crop.encodeFailed], [0, 1]);
	// Every encode timing out: pages 3, 5 and 6 (after the spread's join), then 7 ends it.
	const all = scanWith(() => true);
	await rejectsWith(all.scan, 'crash');
	assert.strictEqual(all.tools.of(TOOLS.pdftoppm).length, 7);
	// A book with one picture, lost: under the count, but there is nothing to show.
	const few = [page({ lines: textLines({ seed: 101 }) }), page({ fill: skyB }), page({ lines: textLines({ seed: 102 }) })];
	const fewTools = fakeTools({ xhtml: fx.xhtmlOf(few.map((p) => p.ocr)), renders: (n) => render(few[n - 1]) });
	const failing = (exe, args, opts) => (exe === TOOLS.ffmpeg ? Promise.resolve({ ok: false, code: 'exit', exit: 1, stdout: null }) : fewTools.runTool(exe, args, opts));
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: failing }), 'crash');
	// No picture found is no failure.
	const plain = [page({ lines: textLines({ seed: 103 }) }), page({ lines: textLines({ seed: 104 }) })];
	const plainTools = fakeTools({ xhtml: fx.xhtmlOf(plain.map((p) => p.ocr)), renders: (n) => render(plain[n - 1]) });
	const none = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: plainTools.runTool });
	assert.deepStrictEqual([none.pictures, none.skipped, none.encodeFailed], [[], 0, 0]);
});

test('scanPdf keeps both pages of a spread whose join failed', async () => {
	const pages = [page({ lines: textLines({ seed: 61 }) }), page({ fill: skyA }), page({ fill: skyA }), page({ lines: textLines({ seed: 62 }) })];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const runTool = (exe, args, opts) => (args.includes('tile=2x1') ? Promise.resolve({ ok: false, code: 'exit', exit: 1, stdout: null }) : tools.runTool(exe, args, opts));
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool });
	assert.deepStrictEqual(got.pictures.map((p) => [p.id, p.kind]), [['p002', 'full'], ['p003', 'full']]);
});

test('scanPdf maps a failed text pass to its code and leaves no word boxes behind', async () => {
	const { xhtml } = testBook();
	const cases = [
		[{ ok: false, code: 'exit', exit: 1, stdout: null }, 'pdf-damaged'],
		[{ ok: false, code: 'exit', exit: 3, stdout: null }, 'pdf-encrypted'],
		[{ ok: false, code: 'exit', exit: 99, stdout: null }, 'pdf-damaged'],
		[{ ok: false, code: 'exit', exit: 2, stdout: null }, 'io-error'],
		[{ ok: false, code: 'timeout', exit: null, stdout: null }, 'timeout'],
		[{ ok: false, code: 'missing', exit: null, stdout: null }, 'tools-missing'],
		[{ ok: false, code: 'spawn', exit: null, stdout: null }, 'io-error']
	];
	for (const [text, code] of cases) {
		const dir = freshDir();
		fs.writeFileSync(pathMod.join(dir, 'words.html'), xhtml);
		const tools = fakeTools({ xhtml, text, renders: () => null });
		await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(dir, 'out'), tools: TOOLS }, { runTool: tools.runTool }), code);
		assert.deepStrictEqual(fs.readdirSync(dir), ['out'], code);
		assert.deepStrictEqual(fs.readdirSync(pathMod.join(dir, 'out')), [], code);
	}
	const thrower = async () => { throw new Error('spawn EPERM'); };
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: thrower }), 'io-error');
	// Calibre's poppler exits 1 for a PDF with a user password, as for a damaged one, and never 3:
	// the /Encrypt entry in the first or last 64 KB tells them apart.
	const filler = Buffer.alloc(200 * 1024, 0x20);
	const pdfs = [
		['trailer', Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from('trailer\r\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<00> <00>] >>\r\nstartxref\r\n410\r\n%%EOF\r\n')]), 'pdf-encrypted'],
		['linearized', Buffer.concat([Buffer.from('%PDF-1.5\n1 0 obj\n<< /Linearized 1 >>\nendobj\ntrailer\n<< /Size 9 /Encrypt << /Filter /Standard /V 2 >> >>\n'), filler, Buffer.from('%%EOF\n')]), 'pdf-encrypted'],
		['small', Buffer.from('%PDF-1.4\ntrailer\n<</Root 1 0 R/Encrypt 4 0 R>>\n%%EOF\n'), 'pdf-encrypted'],
		['plain', Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from('trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n')]), 'pdf-damaged'],
		['middle', Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from('/Encrypt 4 0 R'), filler, Buffer.from('%%EOF\n')]), 'pdf-damaged']
	];
	for (const [name, bytes, code] of pdfs) {
		const dir = freshDir();
		const pdfPath = pathMod.join(dir, `${name}.pdf`);
		fs.writeFileSync(pdfPath, bytes);
		const tools = fakeTools({ xhtml, text: { ok: false, code: 'exit', exit: 1, stdout: null }, renders: () => null });
		await rejectsWith(scanPdf({ pdfPath, outDir: pathMod.join(dir, 'out'), tools: TOOLS }, { runTool: tools.runTool }), code);
		assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${name}.pdf`, 'out'].sort(), name);
	}
});

test('scanPdf refuses a PDF with no text layer, no pages or too many pages, and bad tools', async () => {
	const imageOnly = [page({ lines: [fx.lineOf(['A', 'few', 'words'], 56, 80)] }), page({ fill: skyA })];
	const noText = fakeTools({ xhtml: fx.xhtmlOf(imageOnly.map((p) => p.ocr)), renders: () => null });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: noText.runTool }), 'no-text-layer');
	assert.strictEqual(noText.of(TOOLS.pdftoppm).length, 0);
	const empty = fakeTools({ xhtml: '<doc>\r\n</doc>\r\n', renders: () => null });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, { runTool: empty.runTool }), 'pdf-damaged');
	const { xhtml } = testBook();
	const big = fakeTools({ xhtml, renders: () => null });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS, limits: { maxPages: 13 } }, { runTool: big.runTool }), 'too-large');
	assert.strictEqual(big.of(TOOLS.pdftotext)[0].args[6], '14');
	const none = fakeTools({ xhtml, renders: () => null });
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: { ...TOOLS, pdftoppm: '' } }, { runTool: none.runTool }), 'tools-missing');
	await rejectsWith(scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(freshDir(), 'out'), tools: TOOLS }, {}), 'tools-missing');
	assert.strictEqual(none.calls.length, 0);
});

test('scanPdf puts the word boxes in tmpDir when given one and runs ffmpeg as { exe, args }', async () => {
	const pages = [page({ lines: textLines({ seed: 71 }) }), page({ fill: skyB }), page({ lines: textLines({ seed: 72 }) })];
	const tools = fakeTools({ xhtml: fx.xhtmlOf(pages.map((p) => p.ocr)), renders: (n) => render(pages[n - 1]) });
	const dir = freshDir();
	const tmpDir = pathMod.join(dir, 'tmp');
	const got = await scanPdf({ pdfPath: 'C:/work/book.pdf', outDir: pathMod.join(dir, 'out'), tmpDir, tools: { ...TOOLS, ffmpeg: { exe: TOOLS.ffmpeg, args: ['-threads', '1'] } } }, { runTool: tools.runTool });
	assert.deepStrictEqual(got.pictures.map((p) => p.id), ['p002']);
	assert.strictEqual(tools.of(TOOLS.pdftotext)[0].args[8], pathMod.join(tmpDir, 'words.html'));
	assert.deepStrictEqual(fs.readdirSync(tmpDir), []);
	assert.deepStrictEqual(tools.of(TOOLS.ffmpeg)[0].args.slice(0, 3), ['-threads', '1', '-hide_banner']);
	for (const c of tools.calls) assert.strictEqual(c.opts.cwd, tmpDir);
});
