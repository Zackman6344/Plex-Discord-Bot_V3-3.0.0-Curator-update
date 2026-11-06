// test/helpers/fakePdfTools.js
//
// Stands in for Calibre's poppler tools and ffmpeg-static: `node fakePdfTools.js <tool> [args]`,
// <tool> one of pdftotext, pdftoppm, ffmpeg, or xpdf (Git for Windows' Xpdf 4.00 pdftotext, which
// answers -v without naming Poppler). A test runs it as the tool { exe: process.execPath,
// args: [FAKE, '<tool>'] }; fakeTools() builds all three.
//
// The "PDF" is a JSON file (writeFakePdf) that says what the book holds and how the tools behave:
//   { fake: 'plexbot-fake-pdf', mode, pages: [...], ... }
//   mode 'ok'         pdftotext writes the pages' words as poppler's -bbox-layout (or -bbox) XHTML;
//                     pdftoppm renders a page as a P6 PPM: paper, art rectangles, and every text
//                     line as thin dark stripes over paper
//   mode 'damaged'    both exit 1 with poppler's xref complaint and write nothing, as for a cut
//                     download
//   mode 'encrypted'  both exit 1 with "Incorrect password" and write nothing, as Calibre's
//                     poppler 25.11 does for a PDF with a user password (never 3, poppler's
//                     permissions code); writeFakePdf puts such a file's /Encrypt trailer entry
//                     in the spec, which is how the scan tells it from a damaged one
//   mode 'no-text'    pdftotext writes every page with no words (a scan without an OCR layer);
//                     pdftoppm still draws the lines
//   mode 'hang'       the tools named in `hang` (every tool when unset) never end
//   mode 'hang-tree'  the same, after starting a detached grandchild; both pids go to pidFile
// A page is { width, height } in points, paper [r, g, b], lines [{ box: [x0, y0, x1, y1] in
// points, words: [...], block? }] and art [{ box: [x0, y0, x1, y1] as page fractions, rgb }].
// Lines without a block each get their own flow, and are listed in the order given, as the real
// tool lists a two-column scan row by row (textPage() lays pages out that way). failPages exit 1
// and hangPages hang in pdftoppm only. Any spec may add delayMs, crlf (pdftotext writes CRLF, as
// its stdout on Windows has), and argvFile (one JSON line per call: tool, argv, cwd).
//
// ffmpeg reads P6 frames from stdin (-f ppm_pipe -i pipe:0) and answers on stdout with a
// JPEG-shaped file (SOI, JFIF, SOF0 carrying the output size, padding, EOI) after -vf crop=w:h:x:y,
// tile=2x1 or scale=w:h (each side a number, iw or ih over or times a number, or -1 / -2), joined
// with commas; frames of two sizes under tile fail with exit 1, as the real filter does.
// Its size is about what ffmpeg's mjpeg makes at that -q:v, times the spec's jpegScale. Its spec,
// when a test needs one, comes from --fake-spec <file> right after the tool name.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const fs = require('node:fs');
const cp = require('node:child_process');

const FAKE = __filename;
const MARK = 'plexbot-fake-pdf';
const POPPLER_VERSION = '25.11.0';
const PAPER = [191, 195, 196];
const ART = [40, 90, 160];
const INK = [70, 70, 70];
const XPDF_BANNER = 'pdftotext version 4.00\r\nCopyright 1996-2017 Glyph & Cog, LLC\r\n';
const VALUE_FLAGS = new Set([
	'-f', '-l', '-r', '-rx', '-ry', '-x', '-y', '-W', '-H', '-enc', '-eol', '-opw', '-upw',
	'-scale-to', '-scale-to-x', '-scale-to-y', '-jpegopt', '-sep',
	'-loglevel', '-i', '-vf', '-filter_complex', '-frames:v', '-q:v', '-c:v', '-pix_fmt'
]);

function popplerBanner(tool) {
	return `${tool} version ${POPPLER_VERSION}\r\nCopyright 2005-2025 The Poppler Developers - http://poppler.freedesktop.org\r\nCopyright 1996-2011, 2022 Glyph & Cog, LLC\r\n`;
}

function parseArgs(argv) {
	const opts = new Map();
	const pos = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) {
			const v = VALUE_FLAGS.has(a) ? argv[++i] : true;
			if (!opts.has(a)) opts.set(a, []);
			opts.get(a).push(v);
		} else {
			pos.push(a);
		}
	}
	return {
		pos,
		has: (k) => opts.has(k),
		last: (k) => (opts.has(k) ? opts.get(k)[opts.get(k).length - 1] : undefined),
		all: (k) => opts.get(k) || []
	};
}

function readSpec(file) {
	try {
		const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
		return spec && spec.fake === MARK ? spec : null;
	} catch (_) {
		return null;
	}
}

function record(spec, tool, argv) {
	if (spec && spec.argvFile) fs.appendFileSync(spec.argvFile, `${JSON.stringify({ tool, argv, cwd: process.cwd() })}\n`);
}

function hangsFor(spec, tool) {
	if (!spec || (spec.mode !== 'hang' && spec.mode !== 'hang-tree')) return false;
	return spec.hang == null || [].concat(spec.hang).includes(tool);
}

function hang(spec) {
	if (spec && spec.mode === 'hang-tree' && spec.pidFile) {
		// Detached, as a real tool's helper would be: Node otherwise ends a child with its parent
		// through its job object, and a test would pass without any tree kill.
		const kid = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
		kid.unref();
		fs.writeFileSync(spec.pidFile, JSON.stringify({ self: process.pid, kid: kid.pid }));
	}
	setInterval(() => {}, 1000);
}

function damaged() {
	process.stderr.write('Syntax Error: Couldn\'t find trailer dictionary\r\nSyntax Error: Couldn\'t find trailer dictionary\r\nSyntax Error: Couldn\'t read xref table\r\n');
	process.exitCode = 1;
}

function encrypted() {
	process.stderr.write('Command Line Error: Incorrect password\r\n');
	process.exitCode = 1;
}

// Poppler's own rules: 0 or nothing means the whole book, a last page past the end is clamped, and a
// first page after the last exits 99.
function pageRange(count, args, single) {
	let first = parseInt(args.last('-f'), 10);
	let last = parseInt(args.last('-l'), 10);
	if (!(first >= 1)) first = 1;
	if (!(last >= 1) || last > count) last = count;
	if (first > last) return { error: `Wrong page range given: the first page (${first}) can not be after the last page (${last}).` };
	return { first, last: single ? first : last };
}

// --- pdftotext -----------------------------------------------------------------------------------

const f6 = (n) => Number(n).toFixed(6);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const boxAttrs = (b) => `xMin="${f6(b.xMin)}" yMin="${f6(b.yMin)}" xMax="${f6(b.xMax)}" yMax="${f6(b.yMax)}"`;

function usableLines(page) {
	return (Array.isArray(page && page.lines) ? page.lines : []).filter((l) => l && Array.isArray(l.box) && l.box.length === 4 && Array.isArray(l.words) && l.words.length);
}

function wordsOfLine(line) {
	const [x0, y0, x1, y1] = line.box.map(Number);
	const words = line.words.map(String);
	const chars = words.reduce((n, w) => n + w.length, 0) + words.length - 1;
	const cw = (x1 - x0) / Math.max(1, chars);
	let x = x0;
	return words.map((text) => {
		const w = { text, xMin: x, yMin: y0, xMax: x + text.length * cw, yMax: y1 };
		x += (text.length + 1) * cw;
		return w;
	});
}

function blocksOf(lines) {
	const blocks = [];
	const byKey = new Map();
	for (const line of lines) {
		if (line.block == null) {
			blocks.push([line]);
			continue;
		}
		if (!byKey.has(line.block)) {
			byKey.set(line.block, []);
			blocks.push(byKey.get(line.block));
		}
		byKey.get(line.block).push(line);
	}
	return blocks;
}

function unionOf(lines) {
	const boxes = lines.map((l) => l.box.map(Number));
	return {
		xMin: Math.min(...boxes.map((b) => b[0])),
		yMin: Math.min(...boxes.map((b) => b[1])),
		xMax: Math.max(...boxes.map((b) => b[2])),
		yMax: Math.max(...boxes.map((b) => b[3]))
	};
}

function bboxDocument(pages, { layout, noText, title }) {
	const out = [
		'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">',
		'<head>',
		`<title>${esc(title || 'Fake book')}</title>`,
		'<meta name="Producer" content="plexbot fakePdfTools"/>',
		'</head>',
		'<body>',
		'<doc>'
	];
	for (const page of pages) {
		out.push(`  <page width="${f6(page.width)}" height="${f6(page.height)}">`);
		const lines = noText ? [] : usableLines(page);
		if (layout) {
			for (const block of blocksOf(lines)) {
				out.push('    <flow>', `      <block ${boxAttrs(unionOf(block))}>`);
				for (const line of block) {
					out.push(`        <line ${boxAttrs(unionOf([line]))}>`);
					for (const w of wordsOfLine(line)) out.push(`          <word ${boxAttrs(w)}>${esc(w.text)}</word>`);
					out.push('        </line>');
				}
				out.push('      </block>', '    </flow>');
			}
		} else {
			for (const line of lines) {
				for (const w of wordsOfLine(line)) out.push(`    <word ${boxAttrs(w)}>${esc(w.text)}</word>`);
			}
		}
		out.push('  </page>');
	}
	out.push('</doc>', '</body>', '</html>');
	return out;
}

function pdftotext(spec, args) {
	const out = args.pos[1];
	if (!spec || spec.mode === 'damaged') return damaged();
	if (spec.mode === 'encrypted') return encrypted();
	if (hangsFor(spec, 'pdftotext')) return hang(spec);
	const pages = Array.isArray(spec.pages) ? spec.pages : [];
	const range = pageRange(pages.length, args, false);
	if (range.error) {
		process.stderr.write(`Command Line Error: ${range.error}\r\n`);
		process.exitCode = 99;
		return;
	}
	const nl = spec.crlf ? '\r\n' : '\n';
	const chosen = pages.slice(range.first - 1, range.last);
	const text = args.has('-bbox') || args.has('-bbox-layout')
		? bboxDocument(chosen, { layout: args.has('-bbox-layout'), noText: spec.mode === 'no-text', title: spec.title }).join(nl) + nl
		: chosen.map((p) => (spec.mode === 'no-text' ? [] : usableLines(p)).map((l) => l.words.join(' ')).join(nl)).join(`${nl}\f`) + nl;
	if (!out || out === '-') {
		process.stdout.write(text);
		return;
	}
	try {
		fs.writeFileSync(out, text);
	} catch (_) {
		process.stderr.write(`I/O Error: Couldn't open text file '${out}'\r\n`);
		process.exitCode = 2;
	}
}

// --- pdftoppm ------------------------------------------------------------------------------------

function rgbOf(v, fallback) {
	return Array.isArray(v) && v.length === 3 && v.every((c) => Number.isInteger(c) && c >= 0 && c <= 255) ? v : fallback;
}

// Output pixels are ceil(points * dpi / 72), and -scale-to-x alone leaves the height at 150 dpi:
// poppler 25.11's own quirks, measured in design/tools.
function sizeOf(page, args) {
	const W = Number(page.width) || 562.2;
	const H = Number(page.height) || 690.2;
	const sx = parseInt(args.last('-scale-to-x'), 10);
	const sy = parseInt(args.last('-scale-to-y'), 10);
	const st = parseInt(args.last('-scale-to'), 10);
	const dpi = Number(args.last('-r')) || 150;
	let w = Math.ceil((W * dpi) / 72);
	let h = Math.ceil((H * dpi) / 72);
	if (st > 0) {
		if (W >= H) {
			w = st;
			h = Math.ceil((H * st) / W);
		} else {
			h = st;
			w = Math.ceil((W * st) / H);
		}
	}
	if (sx > 0 && sy > 0) {
		w = sx;
		h = sy;
	} else if (sx > 0) {
		w = sx;
		if (sy === -1) h = Math.ceil((H * sx) / W);
	} else if (sy > 0) {
		h = sy;
		if (sx === -1) w = Math.ceil((W * sy) / H);
	}
	return { w: Math.max(1, w), h: Math.max(1, h) };
}

function fillRect(px, w, h, x0, y0, x1, y1, color) {
	const pattern = Buffer.from(color);
	const a = Math.max(0, x0);
	const b = Math.min(w, x1);
	if (b <= a) return;
	for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) px.fill(pattern, (y * w + a) * 3, (y * w + b) * 3);
}

function renderPpm(page, w, h) {
	const px = Buffer.alloc(w * h * 3);
	px.fill(Buffer.from(rgbOf(page.paper, PAPER)));
	const W = Number(page.width) || 562.2;
	const H = Number(page.height) || 690.2;
	for (const a of Array.isArray(page.art) ? page.art : []) {
		const [fx0, fy0, fx1, fy1] = Array.isArray(a && a.box) ? a.box.map(Number) : [0, 0, 1, 1];
		fillRect(px, w, h, Math.floor(fx0 * w), Math.floor(fy0 * h), Math.ceil(fx1 * w), Math.ceil(fy1 * h), rgbOf(a && a.rgb, ART));
	}
	// Glyphs as every fourth column of the line's middle half: dark enough to be text, sparse
	// enough that a line box's average stays close to the paper it is printed on.
	for (const line of Array.isArray(page.lines) ? page.lines : []) {
		if (!line || !Array.isArray(line.box)) continue;
		const [x0, y0, x1, y1] = line.box.map(Number);
		const px0 = Math.max(0, Math.floor((x0 * w) / W));
		const px1 = Math.min(w, Math.ceil((x1 * w) / W));
		const py0 = Math.floor((y0 * h) / H);
		const py1 = Math.ceil((y1 * h) / H);
		const quarter = Math.floor((py1 - py0) / 4);
		for (let y = Math.max(0, py0 + quarter); y < Math.min(h, py1 - quarter); y++) {
			for (let x = px0; x < px1; x += 4) {
				const o = (y * w + x) * 3;
				px[o] = INK[0];
				px[o + 1] = INK[1];
				px[o + 2] = INK[2];
			}
		}
	}
	return Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`, 'latin1'), px]);
}

function pdftoppm(spec, args) {
	const root = args.pos[1];
	if (!spec || spec.mode === 'damaged') return damaged();
	if (spec.mode === 'encrypted') return encrypted();
	if (hangsFor(spec, 'pdftoppm')) return hang(spec);
	const pages = Array.isArray(spec.pages) ? spec.pages : [];
	const single = args.has('-singlefile');
	const range = pageRange(pages.length, args, single);
	if (range.error) {
		process.stderr.write(`${range.error}\r\n`);
		process.exitCode = 99;
		return;
	}
	const frames = [];
	for (let n = range.first; n <= range.last; n++) {
		if ([].concat(spec.hangPages || []).includes(n)) return hang(null);
		if ([].concat(spec.failPages || []).includes(n)) {
			process.stderr.write(`Syntax Error (${n}): Illegal character in content stream\r\n`);
			process.exitCode = 1;
			return;
		}
		const page = pages[n - 1] || {};
		const { w, h } = sizeOf(page, args);
		frames.push({ n, ppm: renderPpm(page, w, h) });
	}
	if (!root) {
		process.stdout.write(Buffer.concat(frames.map((f) => f.ppm)));
		return;
	}
	const digits = String(pages.length).length;
	for (const f of frames) fs.writeFileSync(single ? `${root}.ppm` : `${root}-${String(f.n).padStart(digits, '0')}.ppm`, f.ppm);
}

// --- ffmpeg --------------------------------------------------------------------------------------

function parsePpms(buf) {
	const frames = [];
	let at = 0;
	while (at < buf.length) {
		const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(at, at + 64).toString('latin1'));
		if (!m) break;
		const w = Number(m[1]);
		const h = Number(m[2]);
		const start = at + m[0].length;
		const end = start + w * h * 3;
		if (!w || !h || end > buf.length) break;
		frames.push({ width: w, height: h, data: buf.subarray(start, end) });
		at = end;
	}
	return frames;
}

function fakeJpeg(w, h, q, scale) {
	const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
	const parts = [head, sof];
	let pad = Math.round(((w * h * 3) / (8 * Math.max(1, q))) * scale) - head.length - sof.length - 2;
	while (pad > 4) {
		const n = Math.min(pad - 4, 65533);
		const seg = Buffer.alloc(n + 4, 0x20);
		seg[0] = 0xff;
		seg[1] = 0xfe;
		seg.writeUInt16BE(n + 2, 2);
		parts.push(seg);
		pad -= n + 4;
	}
	parts.push(Buffer.from([0xff, 0xd9]));
	return Buffer.concat(parts);
}

function refuse(message) {
	process.stderr.write(`${message}\r\n`);
	process.exitCode = 1;
}

// One side of scale=: a number, iw or ih (times or over a number), or -1 / -2 for "keep the aspect"
// (-2 also rounds to an even number). null for keep-aspect, NaN for anything else.
function scaleSide(expr, size) {
	if (expr === '-1' || expr === '-2') return null;
	const m = /^(iw|ih|\d+(?:\.\d+)?)(?:([*/])(\d+(?:\.\d+)?))?$/.exec(expr);
	if (!m) return NaN;
	const base = m[1] === 'iw' ? size.w : m[1] === 'ih' ? size.h : Number(m[1]);
	const v = !m[2] ? base : m[2] === '*' ? base * Number(m[3]) : base / Number(m[3]);
	return Math.round(v);
}

function sizeAfter(filters, frames) {
	let size = { w: frames[0].width, h: frames[0].height };
	for (const f of filters) {
		let m;
		if ((m = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(f))) {
			const [cw, ch, cx, cy] = m.slice(1).map(Number);
			if (!cw || !ch || cx + cw > size.w || cy + ch > size.h) return { error: 'Invalid too big or non positive size for width \'w\' or height \'h\'' };
			size = { w: cw, h: ch };
		} else if (f === 'tile=2x1') {
			if (frames.length > 1 && (frames[1].width !== frames[0].width || frames[1].height !== frames[0].height)) return { error: 'Failed to configure output pad on Parsed_tile_0' };
			size = { w: size.w * 2, h: size.h };
		} else if ((m = /^scale=([^:]+):([^:]+)$/.exec(f))) {
			let sw = scaleSide(m[1], size);
			let sh = scaleSide(m[2], size);
			if (Number.isNaN(sw) || Number.isNaN(sh) || (sw === null && sh === null) || sw === 0 || sh === 0) return { error: 'Invalid scale size' };
			const even = (v, side) => (side === '-2' ? Math.max(2, Math.round(v / 2) * 2) : Math.max(1, Math.round(v)));
			if (sw === null) sw = even((size.w * sh) / size.h, m[1]);
			if (sh === null) sh = even((size.h * sw) / size.w, m[2]);
			size = { w: sw, h: sh };
		} else {
			return { error: `No such filter: '${f}'` };
		}
	}
	return size;
}

function ffmpeg(spec, args) {
	if (args.has('-version')) {
		process.stdout.write('ffmpeg version 4.4.1-fake Copyright (c) 2000-2021 the FFmpeg developers\r\n');
		return;
	}
	const s = spec || { mode: 'ok' };
	// Exits without reading stdin, so a caller's write meets a closed pipe, as with a real refusal.
	if (s.mode === 'damaged') return refuse('pipe:0: Invalid data found when processing input');
	if (hangsFor(s, 'ffmpeg')) return hang(s);
	if (args.last('-i') !== 'pipe:0' || args.pos[args.pos.length - 1] !== 'pipe:1' || !args.all('-f').includes('ppm_pipe')) {
		return refuse('fakePdfTools: ffmpeg is only faked for ppm_pipe on pipe:0 to pipe:1');
	}
	const chunks = [];
	process.stdin.on('data', (c) => chunks.push(c));
	process.stdin.on('end', () => {
		const frames = parsePpms(Buffer.concat(chunks));
		if (!frames.length) return refuse('pipe:0: Invalid data found when processing input');
		const vf = args.last('-vf');
		const size = sizeAfter(vf ? String(vf).split(',') : [], frames);
		if (size.error) return refuse(size.error);
		process.stdout.write(fakeJpeg(size.w, size.h, Number(args.last('-q:v')) || 3, Number(s.jpegScale) || 1));
	});
}

// --- entry ---------------------------------------------------------------------------------------

function main(argv) {
	const [tool, ...given] = argv;
	let rest = given;
	let specFile = null;
	if (rest[0] === '--fake-spec') {
		specFile = rest[1];
		rest = rest.slice(2);
	}
	const args = parseArgs(rest);
	if (tool === 'xpdf') {
		process.stderr.write(XPDF_BANNER);
		process.exitCode = 99;
		return;
	}
	if ((tool === 'pdftotext' || tool === 'pdftoppm') && args.has('-v')) {
		process.stderr.write(popplerBanner(tool));
		return;
	}
	const spec = specFile ? readSpec(specFile) : tool === 'ffmpeg' ? null : readSpec(args.pos[0]);
	record(spec, tool, rest);
	const go = () => {
		if (tool === 'pdftotext') return pdftotext(spec, args);
		if (tool === 'pdftoppm') return pdftoppm(spec, args);
		if (tool === 'ffmpeg') return ffmpeg(spec, args);
		return refuse(`fakePdfTools: unknown tool ${tool}`);
	};
	const delay = Number(spec && spec.delayMs) || 0;
	if (delay > 0) setTimeout(go, delay);
	else go();
}

// --- for tests -----------------------------------------------------------------------------------

/** Writes a fake PDF (the JSON the fake tools read) and returns its path. */
function writeFakePdf(file, spec = {}) {
	const encrypt = spec && spec.mode === 'encrypted' ? { trailer: '<< /Size 12 /Root 1 0 R /Encrypt 11 0 R >>' } : {};
	fs.writeFileSync(file, JSON.stringify({ fake: MARK, mode: 'ok', pages: [], ...encrypt, ...spec }));
	return file;
}

/** The three tools as { exe, args } that pdfTools.runTool and a job's `tools` take. */
function fakeTools({ ffmpegSpec = null } = {}) {
	const tool = (name) => ({ exe: process.execPath, args: name === 'ffmpeg' && ffmpegSpec ? [FAKE, name, '--fake-spec', ffmpegSpec] : [FAKE, name] });
	return { pdftotext: tool('pdftotext'), pdftoppm: tool('pdftoppm'), ffmpeg: tool('ffmpeg'), poppler: POPPLER_VERSION };
}

/**
 * A printed text page: the words in lines of `perLine`, filling `columns` columns top to bottom,
 * listed row by row across the columns as pdftotext lists a two-column scan. Words past what the
 * page holds are left off; `art` and `paper` pass through.
 */
function textPage(words, { width = 562.2, height = 690.2, columns = 1, perLine = 9, art = [], paper, top = 0.1 } = {}) {
	const lineH = 11;
	const gap = 2;
	const margin = 66;
	const colGap = 20;
	const colW = (width - 2 * margin - (columns - 1) * colGap) / columns;
	const rows = Math.floor((height * 0.9 - height * top) / (lineH + gap));
	const lines = [];
	let i = 0;
	for (let c = 0; c < columns && i < words.length; c++) {
		for (let r = 0; r < rows && i < words.length; r++) {
			const ws = words.slice(i, i + perLine);
			i += ws.length;
			const x0 = margin + c * (colW + colGap);
			const y0 = height * top + r * (lineH + gap);
			lines.push({ box: [x0, y0, x0 + colW, y0 + lineH], words: ws });
		}
	}
	lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
	return { width, height, paper, lines, art };
}

/** A page of art and no text: the whole page unless `box` (page fractions) says otherwise. */
function artPage({ width = 562.2, height = 690.2, rgb = ART, box = [0, 0, 1, 1], paper } = {}) {
	return { width, height, paper, lines: [], art: [{ box, rgb }] };
}

module.exports = { FAKE, MARK, POPPLER_VERSION, writeFakePdf, fakeTools, textPage, artPage, parsePpms };

if (require.main === module) main(process.argv.slice(2));
