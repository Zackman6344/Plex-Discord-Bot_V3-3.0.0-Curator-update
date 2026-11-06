// helpers/bookPictures.js: pictures for the read-along from a scanned PDF on the text's Calibre
// record. The record check, the hand-off to the worker, installing and serving the picture list,
// the owner's controls, failures and back-off, the sweep and the size cap.
//
// The bug: each of these shows a listener the wrong pictures or none, or costs the PC minutes of
// work again and again. A tag edit in Calibre (last_modified) reading the whole PDF again; the
// record's local path copied into a pointer or a log line; a record id reused for another book,
// or another library's record, showing the old book's pictures; two narrations of one book
// downloading and reading one PDF twice; a re-parsed EPUB downloading the PDF again when only a
// realignment is needed; an encrypted PDF retried, or a PDF that hangs the tools retried after
// every restart; the downloaded PDF or a .work folder left behind; a folder swept under a job
// that is still writing it; forText reading the disk on every page render; pictures:redo on a
// shared analysis dropped for good by a failure that passes or by a restart; a known failure
// replaced by "Calibre isn't answering".
//
// Harness: the real bookTextStore on pid-suffixed temp files (env set before the first require),
// a temp book_text dir per test, a fake Calibre client with the measured /ajax/book shape
// (formats, format_metadata with size, mtime and a local path), a fake worker that runs one job
// at a time like the real queue and writes what the child would (out/*.jpg, pages.json,
// align-<base>.json, index.json last), and a manual clock. No real PDF is read or rendered.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = pathMod.join(os.tmpdir(), `plexbot-test-book-pictures-${process.pid}`);
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${ROOT}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${ROOT}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${ROOT}-works.json`;
process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE = `${ROOT}-marks.json`;
process.env.PLEXBOT_BOOK_PICTURES_FILE = `${ROOT}-pictures.json`;
delete process.env.PLEXBOT_BOOK_TEXT_DIR;

const store = require('../helpers/bookTextStore.js');
const { CalibreError } = require('../helpers/calibreClient.js');
const {
	createBookPictures, between, pdfOf, picturesKey, statusLine,
	MAX_PICTURE_BYTES, REVALIDATE_MS, STRIKE_RETRY_MS, CALIBRE_RETRY_MS, TOOLS_RETRY_MS, FAIL_RECORD_MAX_AGE_MS
} = require('../helpers/bookPictures.js');

const STORE_FILES = ['LINKS', 'READERS', 'WORKS', 'MARKS'].map((k) => process.env[`PLEXBOT_BOOK_TEXT_${k}_FILE`]).concat(process.env.PLEXBOT_BOOK_PICTURES_FILE);
const LIB = 'Calibre_Library';
const UUID = '5de05941-a85d-48a6-9db4-2ca0fa172f62';
const UUID2 = '0b1c2d3e-0000-4000-8000-000000000385';
const T0 = Date.UTC(2026, 10, 5, 20, 0, 0);
const BASE_A = '157d62d84d19901d';
const BASE_B = '0123456789abcdef';
const PDF_SIZE = 29224426;
const PDF_MTIME = '2026-11-05T19:48:19.486724+00:00';
const FP = `calibre:${LIB}:384:pdf:${PDF_SIZE}:${PDF_MTIME}`;
const KEY = picturesKey(FP);
const LOCAL_DIR = 'X:\\Calibre Library\\Avery Quill\\The Lantern Road (384)';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TOOLS = Object.freeze({
	ok: true, dir: 'X:\\Calibre2\\app\\bin', pdftotext: 'X:\\Calibre2\\app\\bin\\pdftotext.exe',
	pdftoppm: 'X:\\Calibre2\\app\\bin\\pdftoppm.exe', ffmpeg: 'X:\\bot\\node_modules\\ffmpeg-static\\ffmpeg.exe'
});

// The printed pages that carry a picture, out of reading order on purpose, and the word each is
// placed on in text A. The fake child places them 5 words later in text B. Printed page 1 is the
// PDF's 13th page, as #384's is its 13th.
const SPEC = {
	pages: 40,
	folioOffset: 12,
	pictures: [
		{ id: 'p030-031', pages: [30, 31], kind: 'spread', word: 1500 },
		{ id: 'p013', pages: [13], kind: 'part', word: 70 },
		{ id: 'p022', pages: [22], kind: 'full', word: 900 }
	]
};

let dirCount = 0;
const made = [];
const open = [];

function tmpDir(label) {
	const dir = `${ROOT}-${label}-${++dirCount}`;
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	made.push(dir);
	return dir;
}

test.afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
	for (const f of STORE_FILES) fs.rmSync(f, { force: true });
	store.reset();
});

test.after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

async function until(cond, label, ms = 3000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 2));
	}
}

function work(over = {}) {
	return { id: 'avery-quill/the-lantern-road', kind: 'book', title: 'The Lantern Road', author: 'Avery Quill', aliases: [], ...over };
}

function record({ id = 384, uuid = UUID, formats = ['epub', 'pdf'], pdf = { size: PDF_SIZE, mtime: PDF_MTIME }, lastModified = '2026-11-05T20:01:55.023423+00:00', spec = SPEC } = {}) {
	const fm = { epub: { path: `${LOCAL_DIR}\\The Lantern Road - Avery Quill.epub`, size: 19668395, mtime: '2026-11-05T20:01:55.016774+00:00' } };
	if (formats.includes('pdf') && pdf) fm.pdf = { path: `${LOCAL_DIR}\\The Lantern Road - Avery Quill.pdf`, size: pdf.size, mtime: pdf.mtime };
	return { title: 'The Lantern Road', authors: ['Avery Quill'], uuid, formats, format_metadata: fm, last_modified: lastModified, application_id: id, spec };
}

/** The content server, GET only, as helpers/calibreClient.js answers. The PDF it serves is the spec. */
function fakeCalibre(records = { 384: record() }) {
	const c = {
		lib: LIB,
		data: records,
		reachable: true,
		fail: null,
		failDownload: null,
		downloadHold: null,
		calls: { lib: 0, book: [], download: [] },
		check() {
			if (c.fail) throw c.fail;
			if (!c.reachable) throw new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).', { cause: 'ECONNREFUSED' });
		},
		async libraryId() {
			c.calls.lib++;
			c.check();
			return c.lib;
		},
		async book(id) {
			c.check();
			c.calls.book.push(id);
			const b = c.data[id];
			if (!b) return null;
			const copy = JSON.parse(JSON.stringify(b));
			delete copy.spec;
			return copy;
		},
		async downloadFormat(id, format, dest) {
			c.check();
			c.calls.download.push({ id, format, dest });
			if (c.downloadHold) await c.downloadHold;
			if (c.failDownload) throw c.failDownload;
			const b = c.data[id];
			if (!b || !b.formats.includes(String(format).toLowerCase())) throw new CalibreError('no-format', `Calibre has no ${format} for book #${id}.`);
			const body = `%PDF-fake\n${JSON.stringify(b.spec)}`;
			fs.writeFileSync(dest, body);
			return { bytes: Buffer.byteLength(body) };
		}
	};
	return c;
}

function handle(dir, base = BASE_A, { workId = 'avery-quill/the-lantern-road', source = {} } = {}) {
	const src = source.type === 'file'
		? source
		: { type: 'calibre', libraryId: LIB, id: 384, uuid: UUID, epubSize: 19668395, epubMtime: '2026-11-05T20:01:55.016774+00:00', fingerprint: `calibre:${LIB}:384:19668395:2026-11-05T20:01:55.016774+00:00`, ...source };
	return {
		workId,
		base,
		tag: base.slice(0, 4),
		fingerprint: src.fingerprint,
		index: { version: 1, totalWords: 2000, sections: [] },
		source: src,
		via: 'auto',
		label: `Calibre #${src.id}`,
		textPath: pathMod.join(dir, 'cache', `${base}.txt`),
		indexPath: pathMod.join(dir, 'cache', `${base}.json`),
		async readSection() { return ''; }
	};
}

function writeAlign(dir, key, base, spec, w) {
	if (w.alignFails.has(base)) {
		fs.writeFileSync(pathMod.join(dir, `align-${base}.fail.json`), JSON.stringify({ version: 1, base, code: 'align-failed', share: 0.12, at: T0 }));
		return false;
	}
	const shift = w.shift[base] || 0;
	fs.writeFileSync(pathMod.join(dir, `align-${base}.json`), JSON.stringify({
		version: 1, key, base, builtAt: T0, textWords: 2000, quality: { textPages: 30, aligned: 29, share: 0.97 },
		pictures: spec.pictures.map((p) => ({ id: p.id, word: p.word + shift, how: 'page-start' }))
	}));
	return true;
}

// What the forked child writes for one job, from the spec the fake Calibre put in the "PDF".
function child(job, w) {
	if (job.kind === 'full') {
		const spec = JSON.parse(fs.readFileSync(job.pdfPath, 'utf8').split('\n').slice(1).join('\n'));
		if (spec.fail) return { ok: false, code: spec.fail, message: 'fake' };
		const out = pathMod.join(job.workDir, 'out');
		fs.mkdirSync(out, { recursive: true });
		const pictures = spec.pictures.map((p) => {
			const file = p.file || `${p.id}.jpg`;
			const bytes = p.bytes || 1000;
			fs.writeFileSync(pathMod.join(out, file), Buffer.alloc(bytes, 0xff));
			return { id: p.id, file, pages: p.pages, kind: p.kind, width: 1172, height: 1438, bytes };
		});
		fs.writeFileSync(pathMod.join(out, 'pages.json'), JSON.stringify({ version: 1, norm: 1, pdf: { fingerprint: job.fingerprint, pages: spec.pages }, spec }));
		if (job.text) writeAlign(out, job.key, job.text.base, spec, w);
		const spreads = pictures.filter((p) => p.kind === 'spread').length;
		fs.writeFileSync(pathMod.join(out, 'index.json'), JSON.stringify({
			version: 1, kind: 'plexbot-book-pictures', builtAt: T0, pdf: { fingerprint: job.fingerprint, pages: spec.pages }, pictures,
			folioOffset: spec.folioOffset === undefined ? null : spec.folioOffset,
			summary: { pages: spec.pages, pictures: pictures.length, spreads, textPages: 30, ms: 5, skipped: spec.skipped || 0, encodeFailed: spec.encodeFailed || 0 }
		}));
		return { ok: true, summary: { pages: spec.pages, pictures: pictures.length, spreads, ms: 5 } };
	}
	const pages = JSON.parse(fs.readFileSync(pathMod.join(job.keyDir, 'pages.json'), 'utf8'));
	return writeAlign(job.keyDir, job.key, job.text.base, pages.spec, w) ? { ok: true, summary: { ms: 2 } } : { ok: false, code: 'align-failed' };
}

/** bookPicturesWorker's shape: one job at a time, align jobs ahead of waiting full ones. */
function fakeWorker() {
	const w = {
		runs: [],
		cancels: [],
		shutdowns: 0,
		running: 0,
		maxRunning: 0,
		queue: [],
		current: null,
		hold: null,
		answer: null,
		alignFails: new Set(),
		shift: { [BASE_A]: 0, [BASE_B]: 5 },
		seenPdf: [],
		run(job, { onProgress } = {}) {
			w.runs.push(job);
			return new Promise((resolve) => {
				const entry = { job, onProgress, resolve, done: false };
				entry.gone = new Promise((r) => { entry.release = r; });
				const i = job.kind === 'align' ? w.queue.findIndex((x) => x.job.kind === 'full') : -1;
				if (i < 0) w.queue.push(entry);
				else w.queue.splice(i, 0, entry);
				w.pump();
			});
		},
		pump() {
			if (w.current || !w.queue.length) return;
			const entry = w.queue.shift();
			w.current = entry;
			w.exec(entry);
		},
		async exec(entry) {
			w.running++;
			w.maxRunning = Math.max(w.maxRunning, w.running);
			try {
				if (entry.job.kind === 'full') w.seenPdf.push(fs.existsSync(entry.job.pdfPath));
				if (entry.onProgress) entry.onProgress({ stage: entry.job.kind === 'align' ? 'align' : 'render', done: 3, total: 40 });
				if (w.hold) await Promise.race([w.hold, entry.gone]);
				if (entry.done) return;
				w.finish(entry, w.answer ? await w.answer(entry.job) : child(entry.job, w));
			} catch (err) {
				w.finish(entry, { ok: false, code: 'crash', message: String(err && err.message) });
			}
		},
		finish(entry, res) {
			if (entry.done) return;
			entry.done = true;
			if (w.current === entry) {
				w.running--;
				w.current = null;
				setImmediate(() => w.pump());
			}
			entry.release();
			entry.resolve(res);
		},
		cancel(key) {
			w.cancels.push(key);
			for (const entry of [...w.queue]) {
				if (entry.job.key !== key) continue;
				w.queue.splice(w.queue.indexOf(entry), 1);
				w.finish(entry, { ok: false, code: 'cancelled' });
			}
			if (w.current && w.current.job.key === key) w.finish(w.current, { ok: false, code: 'cancelled' });
		},
		shutdown() {
			w.shutdowns++;
			const all = w.queue.splice(0);
			for (const entry of all) w.finish(entry, { ok: false, code: 'shutdown' });
			if (w.current) w.finish(w.current, { ok: false, code: 'shutdown' });
		},
		busy() {
			return !!w.current || w.queue.length > 0;
		}
	};
	return w;
}

function harness(opts = {}) {
	const dir = opts.dir || tmpDir(opts.label || 'pics');
	const clock = opts.clock || { t: T0, now() { return clock.t; }, advance(ms) { clock.t += ms; } };
	const cfg = opts.cfg || { audiobookTextPictures: true, commandPrefix: '!' };
	const calibre = opts.calibre || fakeCalibre();
	const worker = opts.worker || fakeWorker();
	const logs = [];
	const line = (level) => (...args) => logs.push([level, args.map(String).join(' ')]);
	const catalogWorks = new Map();
	const h = {
		dir, picsDir: pathMod.join(dir, 'pictures'), clock, cfg, calibre, worker, logs, catalogWorks,
		tools: TOOLS, toolCalls: 0, opened: null, changes: [], calibreOff: false
	};
	const deps = {
		cfg,
		dir,
		store: opts.store || store,
		worker,
		// calibreFromConfig answers null when calibreUrl is blank.
		calibre: () => (h.calibreOff ? null : calibre),
		locateTools: () => {
			h.toolCalls++;
			return h.tools;
		},
		openText: async () => h.opened || { ok: false, code: 'no-ebook', text: 'I couldn\'t find an ebook for this book.' },
		catalog: () => ({ work: (id) => catalogWorks.get(id) || null }),
		fs: opts.fs || fs,
		now: () => clock.now(),
		logger: { info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug') }
	};
	if (opts.configStore !== undefined) deps.configStore = opts.configStore;
	if (opts.maxDirBytes !== undefined) deps.maxDirBytes = opts.maxDirBytes;
	h.pics = createBookPictures(deps);
	h.pics.onChange((id) => h.changes.push(id));
	h.idle = () => h.pics._idle();
	h.keyDir = (key = KEY) => pathMod.join(h.picsDir, key);
	h.failFile = (key = KEY) => pathMod.join(h.picsDir, `${key}.fail.json`);
	h.line = (w, hd) => statusLine(h.pics.status(w, hd), { prefix: '!' });
	h.close = async () => {
		h.pics.shutdown();
		await h.idle();
	};
	open.push(h);
	return h;
}

function files(dir) {
	const out = [];
	const walk = (d, rel) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(pathMod.join(d, e.name), r);
			else out.push(r);
		}
	};
	if (fs.existsSync(dir)) walk(dir, '');
	return out.sort();
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertCleanLogs(h) {
	for (const [, l] of h.logs) {
		assert.ok(!/Lantern|Avery|Calibre Library|[A-Za-z]:\\|\.pdf\b|\.jpg\b/.test(l) && !l.includes(h.dir), `a log line names a title or a path: ${l}`);
	}
}

/** A complete analysis on disk, as an earlier run left it. `index` adds top-level index.json fields. */
function writeKey(picsDir, key, { pictures = [{ id: 'p013', file: 'p013.jpg', pages: [13], kind: 'part', bytes: 1000 }], aligns = {}, version = 1, index = {} } = {}) {
	const dir = pathMod.join(picsDir, key);
	fs.mkdirSync(dir, { recursive: true });
	for (const p of pictures) if (p.bytes) fs.writeFileSync(pathMod.join(dir, p.file), Buffer.alloc(p.bytes, 0xff));
	fs.writeFileSync(pathMod.join(dir, 'pages.json'), JSON.stringify({ version: 1, norm: 1, pages: [] }));
	for (const [base, list] of Object.entries(aligns)) {
		fs.writeFileSync(pathMod.join(dir, `align-${base}.json`), JSON.stringify({ version: 1, key, base, builtAt: T0, textWords: 2000, quality: { textPages: 30, aligned: 29, share: 0.97 }, pictures: list }));
	}
	fs.writeFileSync(pathMod.join(dir, 'index.json'), JSON.stringify(Object.assign({
		version, kind: 'plexbot-book-pictures', builtAt: T0, pdf: { pages: 40 },
		pictures: pictures.map(({ id, file, pages, kind }) => ({ id, file, pages, kind, width: 900, height: 1200, bytes: 1000 }))
	}, index)));
	return dir;
}

/** fs with promises.rename failing EIO where `when(from, to)` says, as a full or locked disk would. */
function failingRename(when) {
	const promises = new Proxy(fs.promises, {
		get(t, k) {
			if (k !== 'rename') return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
			return async (from, to) => {
				if (when(String(from), String(to))) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO', syscall: 'rename' });
				return t.rename(from, to);
			};
		}
	});
	return new Proxy(fs, { get: (t, k) => (k === 'promises' ? promises : t[k]) });
}

function pointer(key, base, over = {}) {
	return {
		key, base, pdf: { libraryId: LIB, id: 384, uuid: UUID, size: PDF_SIZE, mtime: PDF_MTIME, fingerprint: FP },
		count: 1, at: T0, usedAt: T0, off: false, offBy: null, offAt: null, ...over
	};
}

// --- the pure parts --------------------------------------------------------------------------

test('the key comes from the PDF\'s own size and mtime: never its path, never last_modified while those are there', () => {
	const book = record();
	const pdf = pdfOf(JSON.parse(JSON.stringify(book)), LIB);
	assert.deepStrictEqual(pdf, { libraryId: LIB, id: 384, uuid: UUID, size: PDF_SIZE, mtime: PDF_MTIME, fingerprint: FP });
	assert.strictEqual(picturesKey(FP), '9aa360b44c75c103', 'the key the design computed for Calibre #384');
	assert.ok(!JSON.stringify(pdf).includes('Calibre Library'), 'the library\'s local path is never copied');
	const tagged = pdfOf(record({ lastModified: '2026-12-01T00:00:00+00:00' }), LIB);
	assert.strictEqual(picturesKey(tagged.fingerprint), KEY, 'a tag or cover edit keeps the analysis');
	assert.notStrictEqual(picturesKey(pdfOf(record({ pdf: { size: PDF_SIZE, mtime: '2026-12-01T10:00:00+00:00' } }), LIB).fingerprint), KEY);
	assert.notStrictEqual(picturesKey(pdfOf(record({ pdf: { size: PDF_SIZE + 1, mtime: PDF_MTIME } }), LIB).fingerprint), KEY);
	const bare = record();
	delete bare.format_metadata;
	assert.strictEqual(pdfOf(bare, LIB).fingerprint, `calibre:${LIB}:384:pdf:lm:${bare.last_modified}`, 'only a record without format_metadata falls back to last_modified');
	assert.strictEqual(pdfOf(bare, LIB).size, null);
	assert.strictEqual(pdfOf(record({ formats: ['epub'] }), LIB), null);
	assert.strictEqual(pdfOf(book, ''), null);
	assert.strictEqual(pdfOf(null, LIB), null);
	assert.strictEqual(pdfOf(book, LIB, 7).id, 7, 'the id the record was fetched by wins');
	assert.notStrictEqual(picturesKey(FP, 2), KEY, 'PICTURES_VERSION is part of the key');
});

test('between takes a page\'s pictures from its first word up to, not including, its end word, in order and capped', () => {
	const pics = [10, 20, 20, 35, 50].map((word, i) => ({ id: `p00${i}`, word, bytes: 1000 }));
	const ids = (r) => r.shown.map((p) => p.id);
	assert.deepStrictEqual(ids(between(pics, 20, 35)), ['p001', 'p002']);
	assert.strictEqual(between(pics, 20, 35).count, 2);
	assert.deepStrictEqual(ids(between(pics, 35, 50)), ['p003'], 'a word at a page\'s end word belongs to the next page');
	assert.deepStrictEqual(ids(between(pics, 50, 51)), ['p004']);
	assert.deepStrictEqual(between(pics, 0, 10), { shown: [], count: 0 });
	assert.deepStrictEqual(between(pics, 51, 900), { shown: [], count: 0 });
	const many = Array.from({ length: 12 }, (_, i) => ({ id: `p1${String(i).padStart(2, '0')}`, word: 100 + i, bytes: 1000 }));
	const capped = between(many, 100, 200);
	assert.deepStrictEqual(capped.shown.map((p) => p.word), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109], 'Discord\'s 10, in reading order');
	assert.strictEqual(capped.count, 12, 'the count still says how many the page holds');
	assert.strictEqual(between(many, 100, 200, 3).shown.length, 3);
	const big = Array.from({ length: 6 }, (_, i) => ({ id: `p20${i}`, word: i, bytes: MAX_PICTURE_BYTES }));
	assert.deepStrictEqual([between(big, 0, 10).shown.length, between(big, 0, 10).count], [4, 6], 'and 8 MB a message');
	assert.deepStrictEqual(between(null, 0, 10), { shown: [], count: 0 });
	assert.deepStrictEqual(between(pics, 30, 20), { shown: [], count: 0 });
	assert.deepStrictEqual(between(pics, NaN, 20), { shown: [], count: 0 });
});

test('statusLine says what each state means, and nothing for a file source, no PDF, a podcast or a first check', () => {
	const line = (st) => statusLine(st, { prefix: '!' });
	assert.strictEqual(line({ state: 'ready', pdfId: 384, count: 60 }), '🖼 60 pictures from Calibre #384\'s PDF show on your page as the narration reaches them.');
	assert.strictEqual(line({ state: 'ready', pdfId: 384, count: 1 }), '🖼 1 picture from Calibre #384\'s PDF shows on your page as the narration reaches it.');
	assert.strictEqual(line({ state: 'ready', pdfId: 384, count: 0 }), '🖼 Calibre #384\'s PDF has no pictures the bot could find.');
	assert.strictEqual(line({ state: 'queued', pdfId: 384 }), '🖼 Calibre #384 has a PDF; it is read for pictures after the book being read now.');
	assert.strictEqual(line({ state: 'running', pdfId: 384, progress: { stage: 'render', done: 120, total: 264 } }), '🖼 Reading Calibre #384\'s PDF for pictures: page 120 of 264 (a few minutes, once).');
	assert.strictEqual(line({ state: 'downloading', pdfId: 384, progress: null }), '🖼 Reading Calibre #384\'s PDF for pictures (a few minutes, once).');
	assert.strictEqual(line({ state: 'aligning', pdfId: 384 }), '🖼 Lining Calibre #384\'s pictures up with this text.');
	const failed = (code) => line({ state: 'failed', pdfId: 384, code });
	assert.strictEqual(failed('pdf-encrypted'), '🖼 Calibre #384\'s PDF gives no pictures: it is encrypted.');
	assert.strictEqual(failed('pdf-damaged'), '🖼 Calibre #384\'s PDF gives no pictures: it is damaged.');
	assert.strictEqual(failed('no-text-layer'), '🖼 Calibre #384\'s PDF gives no pictures: it has no text layer to place them by.');
	assert.strictEqual(failed('align-failed'), '🖼 Calibre #384\'s PDF gives no pictures: its pages don\'t match this ebook.');
	assert.strictEqual(failed('too-large'), '🖼 Calibre #384\'s PDF gives no pictures: it is too large.');
	assert.strictEqual(failed('gave-up'), '🖼 Calibre #384\'s PDF gives no pictures: reading it failed 3 times.');
	assert.strictEqual(line({ state: 'waiting', code: 'calibre-unreachable', retryIn: 2 * MINUTE }), '🖼 Reading the PDF for pictures failed (Calibre isn\'t answering); it tries again in 2 minutes.');
	assert.strictEqual(line({ state: 'waiting', code: 'timeout', retryIn: 29 * MINUTE + 1 }), '🖼 Reading the PDF for pictures failed (it took too long); it tries again in 30 minutes.');
	assert.strictEqual(line({ state: 'waiting', code: 'pdf-missing', retryIn: REVALIDATE_MS }), '🖼 Reading the PDF for pictures failed (Calibre lists a PDF but has no file for it); it tries again in 10 minutes.');
	assert.strictEqual(line({ state: 'waiting', code: 'disk-error', retryIn: STRIKE_RETRY_MS }), '🖼 Reading the PDF for pictures failed (the bot couldn\'t read or write its picture files); it tries again in 30 minutes.');
	for (const code of ['calibre-unreachable', 'calibre-off', 'calibre-auth']) assert.strictEqual(line({ state: 'unknown', pdfId: 384, code, retryIn: CALIBRE_RETRY_MS }), null, `unknown (${code}): no PDF known, so nothing failed`);
	assert.strictEqual(line({ state: 'tools-missing' }), '🖼 Calibre\'s PDF tools weren\'t found on this PC, so no pictures. Install Calibre here.');
	assert.strictEqual(line({ state: 'book-off', title: 'The Lantern Road' }), '🖼 Pictures are off for this book (`!book link "The Lantern Road" pictures:on`).');
	assert.strictEqual(statusLine({ state: 'book-off', title: null }, { prefix: '?' }), '🖼 Pictures are off for this book (`?book link <book> pictures:on`).');
	assert.strictEqual(line({ state: 'off', count: 3 }), '🖼 This book has pictures from a PDF; the owner can show them with audiobookTextPictures (`!config` → Audiobooks).');
	for (const st of [{ state: 'off', count: 0 }, { state: 'not-calibre' }, { state: 'no-pdf' }, { state: 'checking' }, null, {}]) assert.strictEqual(line(st), null, JSON.stringify(st));
});

test('the pictures store keeps pointers by work id and alias, and is inert under the test runner without its env var', () => {
	assert.strictEqual(store.files.pictures, process.env.PLEXBOT_BOOK_PICTURES_FILE);
	const ptr = pointer(KEY, BASE_A, { count: 3 });
	store.pictures.set('avery-quill/the-lantern-road-old', ptr);
	const renamed = { id: 'avery-quill/the-lantern-road', aliases: ['avery-quill/the-lantern-road-old'] };
	assert.deepStrictEqual(store.pictures.peek(renamed), ptr);
	assert.strictEqual(store.pictures.all()[renamed.id], undefined, 'peek does not write');
	assert.deepStrictEqual(store.pictures.get(renamed), ptr);
	store.reset();
	assert.deepStrictEqual(store.pictures.all()[renamed.id], ptr, 'get copied it to the current id, on disk');
	store.pictures.clear(renamed);
	assert.deepStrictEqual(store.pictures.all(), {}, 'clear removes it under every name');
	store.pictures.set('__proto__', ptr);
	assert.strictEqual(store.pictures.peek('__proto__').key, KEY);
	assert.strictEqual(store.healthy(), true);

	const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
	delete env.PLEXBOT_BOOK_PICTURES_FILE;
	const script = [
		'const fs = require("fs");',
		`const s = require(${JSON.stringify(require.resolve('../helpers/bookTextStore.js'))});`,
		'const read = () => (fs.existsSync(s.files.pictures) ? fs.readFileSync(s.files.pictures, "utf8") : null);',
		'const before = read();',
		'const wrote = s.pictures.set("w", { key: "x" });',
		'process.stdout.write(JSON.stringify({ file: s.files.pictures, wrote, same: before === read(), seen: s.pictures.peek("w") }));'
	].join('\n');
	const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
	assert.strictEqual(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.ok(out.file.endsWith(pathMod.join('data', 'book_text', 'pictures.json')), out.file);
	assert.deepStrictEqual([out.wrote, out.same, out.seen], [true, true, { key: 'x' }], 'kept in memory, never written to the real file');
});

// --- what is checked, and when ---------------------------------------------------------------

test('nothing is checked or queued for a file source, a handle without cache paths, a podcast, the setting off or a book switched off', async () => {
	const h = harness();
	const w = work();
	const file = handle(h.dir, BASE_A, { source: { type: 'file', path: 'D:\\Books\\The Lantern Road.epub', size: 1, mtimeMs: 1, fingerprint: 'file:x' } });
	h.pics.ensure(w, file);
	assert.strictEqual(h.pics.status(w, file).state, 'not-calibre');
	assert.strictEqual(h.line(w, file), null);
	const bare = handle(h.dir);
	delete bare.textPath;
	delete bare.indexPath;
	h.pics.ensure(w, bare);
	const pod = work({ id: 'some-show/episode-1', kind: 'podcast', title: 'Episode 1' });
	h.pics.ensure(pod, handle(h.dir, BASE_A, { workId: pod.id }));
	assert.strictEqual(h.pics.status(pod, handle(h.dir, BASE_A, { workId: pod.id })).state, 'not-calibre');
	h.cfg.audiobookTextPictures = false;
	h.pics.ensure(w, handle(h.dir));
	assert.strictEqual(h.pics.status(w, handle(h.dir)).state, 'off');
	assert.strictEqual(h.line(w, handle(h.dir)), null, 'the setting off and no pictures known: no line');
	await h.idle();
	h.cfg.audiobookTextPictures = true;
	store.pictures.set(w.id, { key: null, base: null, pdf: null, count: 0, at: T0, usedAt: null, off: true, offBy: '42', offAt: T0 });
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, hd), null);
	assert.strictEqual(h.pics.status(w, hd).state, 'book-off');
	assert.strictEqual(h.line(w, hd), '🖼 Pictures are off for this book (`!book link "The Lantern Road" pictures:on`).');
	assert.deepStrictEqual([h.calibre.calls.lib, h.calibre.calls.book.length, h.calibre.calls.download.length, h.worker.runs.length], [0, 0, 0, 0]);
});

test('a record without a PDF queues nothing, and a PDF added later is found on the first check after 10 minutes', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ formats: ['epub'] }) }) });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.calibre.calls.book.length, h.calibre.calls.download.length, h.worker.runs.length], [1, 0, 0]);
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.line(w, hd)], ['no-pdf', null]);
	h.calibre.data[384] = record();
	h.clock.advance(REVALIDATE_MS - 1000);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.book.length, 1, 'not asked again inside 10 minutes');
	h.clock.advance(1000);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.book.length, 2);
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full']);
	const set = h.pics.forText(w, hd);
	assert.strictEqual(set.key, KEY);
	assert.deepStrictEqual(set.pictures.map((p) => [p.id, p.word, p.kind, p.name]), [
		['p013', 70, 'part', 'p013.jpg'], ['p022', 900, 'full', 'p022.jpg'], ['p030-031', 1500, 'spread', 'p030-031.jpg']
	], 'sorted by word, each with its file name');
	assert.deepStrictEqual(set.pictures.map((p) => p.alt), [
		'Picture from the printed book, page 1', 'Picture from the printed book, page 10', 'Picture from the printed book, pages 18 and 19'
	], 'the numbers printed on the pages, not the PDF\'s');
	assert.strictEqual(set.pictures[0].path, pathMod.join(h.keyDir(), 'p013.jpg'));
	assert.ok(pathMod.isAbsolute(set.pictures[0].path));
	assert.deepStrictEqual([set.base, set.workId, set.pdfId, set.count, set.pictures[0].bytes], [BASE_A, w.id, 384, 3, 1000]);
	assert.deepStrictEqual(h.changes, [w.id]);
	assert.strictEqual(h.line(w, hd), '🖼 3 pictures from Calibre #384\'s PDF show on your page as the narration reaches them.');
	h.calibre.data[384] = record({ formats: ['epub'] });
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, hd), null, 'a PDF removed from the record takes its pictures with it');
	assert.deepStrictEqual([h.changes, store.pictures.peek(w), h.worker.runs.length], [[w.id, w.id], null, 1]);
});

test('a full analysis downloads the PDF into <key>.work, hands the worker paths only, and leaves just the key folder', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const job = h.worker.runs[0];
	assert.deepStrictEqual(Object.keys(job).sort(), ['fingerprint', 'key', 'keyDir', 'kind', 'limits', 'pdfPath', 'text', 'tools', 'versions', 'workDir']);
	assert.deepStrictEqual(job.versions, { pictures: 1, align: 1 }, 'the child stamps its files with the versions this module loads');
	assert.deepStrictEqual([job.kind, job.key, job.fingerprint], ['full', KEY, FP]);
	assert.strictEqual(job.workDir, pathMod.join(h.picsDir, `${KEY}.work`));
	assert.strictEqual(job.keyDir, h.keyDir());
	assert.strictEqual(job.pdfPath, pathMod.join(job.workDir, 'book.pdf'));
	assert.deepStrictEqual(job.text, { base: BASE_A, textPath: hd.textPath, indexPath: hd.indexPath });
	assert.deepStrictEqual(job.tools, { dir: TOOLS.dir, pdftotext: TOOLS.pdftotext, pdftoppm: TOOLS.pdftoppm, ffmpeg: TOOLS.ffmpeg });
	assert.deepStrictEqual(job.limits, { maxPages: 1000, maxPictures: 200, maxPictureBytes: MAX_PICTURE_BYTES, renderHeight: 1200 }, 'about 14 to 23 minutes at most, under the worker\'s cap for 1000 pages');
	assert.ok(!/Lantern|Avery|Calibre Library/.test(JSON.stringify(job)), 'no title and no Calibre path cross to the child');
	assert.deepStrictEqual(h.worker.seenPdf, [true], 'the PDF was on disk when the child started');
	assert.deepStrictEqual(h.calibre.calls.download.map((d) => [d.id, d.format, d.dest]), [[384, 'pdf', job.pdfPath]]);
	assert.ok(!fs.existsSync(job.workDir), '<key>.work is gone');
	assert.deepStrictEqual(files(h.dir).filter((f) => /\.pdf$/i.test(f)), [], 'no PDF is kept anywhere');
	assert.deepStrictEqual(fs.readdirSync(h.picsDir), [KEY]);
	assert.deepStrictEqual(files(h.keyDir()), [`align-${BASE_A}.json`, 'index.json', 'p013.jpg', 'p022.jpg', 'p030-031.jpg', 'pages.json']);
	assert.deepStrictEqual(store.pictures.peek(w), {
		key: KEY, base: BASE_A, pdf: { libraryId: LIB, id: 384, uuid: UUID, size: PDF_SIZE, mtime: PDF_MTIME, fingerprint: FP },
		count: 3, at: T0, usedAt: T0, off: false, offBy: null, offAt: null
	});
	assert.ok(!fs.readFileSync(store.files.pictures, 'utf8').includes('Calibre Library'), 'the pointer never holds the local path');
	assert.ok(h.logs.some(([level, l]) => level === 'info' && l === `Read-along pictures: read the PDF for pictures ${KEY}: 40 pages, 3 pictures (1 spreads) in 5 ms.`), JSON.stringify(h.logs));
	assertCleanLogs(h);
});

// A relative PLEXBOT_BOOK_TEXT_DIR gives relative folders: the worker refuses a relative path, and
// the page card attaches only absolute ones, so every picture would be dropped.
test('a relative book_text folder still hands the worker and the pages absolute paths', async () => {
	const abs = tmpDir('relative');
	const rel = pathMod.relative(process.cwd(), abs);
	assert.ok(!pathMod.isAbsolute(rel));
	const h = harness({ dir: rel });
	const w = work();
	const hd = handle(rel);
	h.pics.ensure(w, hd);
	await h.idle();
	const job = h.worker.runs[0];
	assert.ok([job.workDir, job.keyDir, job.pdfPath, job.text.textPath, job.text.indexPath].every((p) => pathMod.isAbsolute(p)), JSON.stringify(job));
	assert.strictEqual(job.text.textPath, pathMod.join(abs, 'cache', `${BASE_A}.txt`));
	const set = h.pics.forText(w, hd);
	assert.strictEqual(set.count, 3);
	assert.ok(set.pictures.every((p) => pathMod.isAbsolute(p.path) && p.path.startsWith(abs)), JSON.stringify(set.pictures.map((p) => p.path)));
});

// pdfTools.instance().warm answers with a promise, so its version probes stay off the bot's thread.
test('the tools are looked for only for a full analysis, and an answer that comes as a promise is waited for', async () => {
	const h = harness();
	h.tools = Promise.resolve(TOOLS);
	const w = work();
	h.pics.ensure(w, handle(h.dir));
	await h.idle();
	assert.strictEqual(h.pics.forText(w, handle(h.dir)).count, 3);
	assert.strictEqual(h.toolCalls, 1);
	h.pics.ensure(w, handle(h.dir, BASE_B));
	await h.idle();
	assert.strictEqual(h.pics.forText(w, handle(h.dir, BASE_B)).count, 3);
	assert.deepStrictEqual(h.worker.runs.map((j) => [j.kind, j.tools]), [
		['full', { dir: TOOLS.dir, pdftotext: TOOLS.pdftotext, pdftoppm: TOOLS.pdftoppm, ffmpeg: TOOLS.ffmpeg }],
		['align', null]
	]);
	assert.strictEqual(h.toolCalls, 1, 'lining up runs no tool, so none is looked for');
});

test('forText answers from memory: no disk, no store, no Calibre, and the same frozen set each time', async () => {
	let fsCalls = 0;
	const countFn = (t, k) => {
		const v = t[k];
		return typeof v === 'function' ? (...a) => { fsCalls++; return v.apply(t, a); } : v;
	};
	const promises = new Proxy(fs.promises, { get: countFn });
	const countingFs = new Proxy(fs, { get: (t, k) => (k === 'promises' ? promises : countFn(t, k)) });
	let storeCalls = 0;
	const wrap = (obj) => new Proxy(obj, { get: (t, k) => { const v = t[k]; return typeof v === 'function' ? (...a) => { storeCalls++; return v.apply(t, a); } : v; } });
	const h = harness({ fs: countingFs, store: { pictures: wrap(store.pictures), works: wrap(store.works) } });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const set = h.pics.forText(w, hd);
	assert.ok(set && set.count === 3);
	assert.ok(Object.isFrozen(set) && Object.isFrozen(set.pictures) && Object.isFrozen(set.pictures[0]) && Object.isFrozen(set.pictures[0].pages));
	fsCalls = 0;
	storeCalls = 0;
	const books = h.calibre.calls.lib;
	for (let i = 0; i < 200; i++) assert.strictEqual(h.pics.forText(w, hd), set);
	h.clock.advance(MINUTE);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([fsCalls, storeCalls, h.calibre.calls.lib - books], [0, 0, 0], 'a memo hit is a Map lookup');
	assert.strictEqual(h.pics.forText(w, handle(h.dir, BASE_B)), null, 'nothing for a text the pictures are not lined up with');
	assert.strictEqual(h.pics.forText(work({ id: 'someone/else' }), handle(h.dir, BASE_A, { workId: 'someone/else' })), null);
});

test('a tag edit keeps the analysis; a replaced PDF is read again while the old pictures keep showing', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const first = h.pics.forText(w, hd);
	h.calibre.data[384].last_modified = '2026-12-01T00:00:00+00:00';
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.book.length, 2);
	assert.strictEqual(h.worker.runs.length, 1, 'no second analysis for a tag edit');
	assert.strictEqual(h.pics.forText(w, hd), first);
	h.calibre.data[384].format_metadata.pdf.mtime = '2026-12-02T09:00:00.000000+00:00';
	h.calibre.data[384].spec = { ...SPEC, pictures: SPEC.pictures.slice(1) };
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await until(() => h.worker.runs.length === 2 && h.worker.current, 'the second analysis');
	assert.strictEqual(h.pics.forText(w, hd), first, 'the old set serves while the new one is read');
	assert.strictEqual(h.pics.status(w, hd).state, 'ready');
	h.worker.hold = null;
	gate.resolve();
	await h.idle();
	const second = h.pics.forText(w, hd);
	assert.notStrictEqual(second.key, first.key);
	assert.deepStrictEqual(second.pictures.map((p) => p.id), ['p013', 'p022']);
	assert.deepStrictEqual(h.changes, [w.id, w.id]);
	assert.strictEqual(store.pictures.peek(w).key, second.key);
	assert.ok(fs.existsSync(h.keyDir(first.key)), 'the old folder waits for the next start-up');
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.ok(!fs.existsSync(h.keyDir(first.key)), 'which sweeps it');
	assert.strictEqual(h2.pics.forText(w, hd).key, second.key);
	assert.strictEqual(h2.worker.runs.length, 0);
});

test('a record id reused for another book, or another library\'s record, shows nothing', async () => {
	const h = harness();
	const w = work();
	const reused = handle(h.dir, BASE_A, { source: { uuid: 'ffffffff-0000-4000-8000-000000000000' } });
	h.pics.ensure(w, reused);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, reused), null);
	assert.deepStrictEqual([h.pics.status(w, reused).state, h.pics.status(w, reused).code, h.line(w, reused)], ['no-pdf', 'record-changed', null]);
	const other = handle(h.dir, BASE_A, { source: { libraryId: 'Other_Library' } });
	h.pics.ensure(w, other);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, other), null);
	assert.strictEqual(h.calibre.calls.book.length, 1, 'another library is refused before its record is fetched');
	assert.deepStrictEqual([h.calibre.calls.download.length, h.worker.runs.length], [0, 0]);

	const right = handle(h.dir);
	h.pics.ensure(w, right);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, right).count, 3);
	await h.close();
	h.calibre.data[384].uuid = 'ffffffff-0000-4000-8000-000000000000';
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.pics.ensure(w, right);
	await h2.idle();
	assert.strictEqual(h2.pics.forText(w, right), null, 'a set from an earlier run goes once the record turns out to be another book');
	assert.deepStrictEqual(h2.changes, [w.id, w.id]);
	assert.strictEqual(store.pictures.peek(w), null);
});

test('two narrations of one book share one download and one analysis; another book waits its turn without downloading', async () => {
	const second = record({ id: 385, uuid: UUID2, pdf: { size: 1234, mtime: '2026-11-01T00:00:00+00:00' }, spec: { pages: 12, pictures: [{ id: 'p005', pages: [5], kind: 'full', word: 300 }] } });
	const h = harness({ calibre: fakeCalibre({ 384: record(), 385: second }) });
	const w1 = work();
	const w2 = work({ id: 'avery-quill/the-lantern-road-dramatized', title: 'The Lantern Road (Dramatized)' });
	const hd1 = handle(h.dir, BASE_A, { workId: w1.id });
	const hd2 = handle(h.dir, BASE_B, { workId: w2.id });
	const download = deferred();
	h.calibre.downloadHold = download.promise;
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w1, hd1);
	await until(() => h.pics.status(w1, hd1).state === 'downloading', 'the download');
	assert.strictEqual(h.line(w1, hd1), '🖼 Reading Calibre #384\'s PDF for pictures (a few minutes, once).');
	h.calibre.downloadHold = null;
	download.resolve();
	h.pics.ensure(w2, hd2);
	await until(() => h.worker.current, 'the analysis');
	await until(() => h.pics.status(w2, hd2).state === 'running', 'the second narration to join it');
	assert.deepStrictEqual([h.calibre.calls.download.length, h.worker.runs.length], [1, 1]);
	assert.strictEqual(h.line(w2, hd2), '🖼 Reading Calibre #384\'s PDF for pictures: page 3 of 40 (a few minutes, once).');
	const w3 = work({ id: 'someone/other-book', title: 'Other Book' });
	const hd3 = handle(h.dir, BASE_B, { workId: w3.id, source: { id: 385, uuid: UUID2 } });
	h.pics.ensure(w3, hd3);
	await until(() => h.pics.status(w3, hd3).state === 'queued', 'the other book to queue');
	assert.strictEqual(h.line(w3, hd3), '🖼 Calibre #385 has a PDF; it is read for pictures after the book being read now.');
	assert.strictEqual(h.calibre.calls.download.length, 1, 'its PDF stays in Calibre until its turn');
	h.worker.hold = null;
	gate.resolve();
	await h.idle();
	assert.strictEqual(h.worker.maxRunning, 1);
	const k385 = picturesKey(`calibre:${LIB}:385:pdf:1234:2026-11-01T00:00:00+00:00`);
	assert.deepStrictEqual(h.worker.runs[0].text.base, BASE_A);
	assert.deepStrictEqual(h.worker.runs.map((j) => `${j.kind}:${j.key}:${j.text.base}`).sort(), [`align:${KEY}:${BASE_B}`, `full:${KEY}:${BASE_A}`, `full:${k385}:${BASE_B}`].sort(), 'the narration that joined is lined up with its own text');
	assert.strictEqual(h.calibre.calls.download.length, 2);
	assert.strictEqual(h.pics.forText(w1, hd1).pictures[0].path, h.pics.forText(w2, hd2).pictures[0].path, 'both narrations show the one analysis');
	assert.deepStrictEqual(h.pics.forText(w2, hd2).pictures.map((p) => p.word), [75, 905, 1505]);
	assert.strictEqual(h.pics.forText(w3, hd3).key, k385);
	assert.deepStrictEqual(Object.keys(store.pictures.all()).sort(), [w1.id, w2.id, w3.id].sort());
});

test('a text that changes while its analysis runs is lined up as soon as the analysis ends', async () => {
	const h = harness();
	const w = work();
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w, handle(h.dir, BASE_A));
	await until(() => h.worker.current, 'the analysis');
	const hdB = handle(h.dir, BASE_B);
	h.pics.ensure(w, hdB);
	h.worker.hold = null;
	gate.resolve();
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => `${j.kind}:${j.text.base}`), [`full:${BASE_A}`, `align:${BASE_B}`]);
	assert.strictEqual(h.pics.forText(w, hdB).base, BASE_B);
	assert.strictEqual(h.pics.forText(w, handle(h.dir, BASE_A)), null);
	assert.deepStrictEqual([store.pictures.peek(w).base, h.calibre.calls.download.length], [BASE_B, 1]);
});

test('a new text for the same record is lined up from the kept analysis, with no download', async () => {
	const h = harness();
	const w = work();
	const hdA = handle(h.dir, BASE_A);
	h.pics.ensure(w, hdA);
	await h.idle();
	const hdB = handle(h.dir, BASE_B);
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w, hdB);
	assert.strictEqual(h.pics.forText(w, hdB), null, 'nothing is served for a text the pictures are not lined up with');
	await until(() => h.worker.current && h.worker.current.job.kind === 'align', 'the align job');
	assert.strictEqual(h.line(w, hdB), '🖼 Lining Calibre #384\'s pictures up with this text.');
	h.worker.hold = null;
	gate.resolve();
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'align']);
	const align = h.worker.runs[1];
	assert.deepStrictEqual([align.key, align.keyDir, align.pdfPath, align.versions], [KEY, h.keyDir(), undefined, { pictures: 1, align: 1 }]);
	assert.deepStrictEqual(align.text, { base: BASE_B, textPath: hdB.textPath, indexPath: hdB.indexPath });
	assert.strictEqual(h.calibre.calls.download.length, 1, 'no second download');
	const set = h.pics.forText(w, hdB);
	assert.deepStrictEqual([set.base, set.pictures.map((p) => p.word)], [BASE_B, [75, 905, 1505]]);
	assert.strictEqual(store.pictures.peek(w).base, BASE_B);
	assert.deepStrictEqual(h.changes, [w.id, w.id]);
});

test('a text that does not line up says why, and keeps the analysis for the next text', async () => {
	const h = harness();
	h.worker.alignFails.add(BASE_A);
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, hd), null);
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code], ['failed', 'align-failed']);
	assert.strictEqual(h.line(w, hd), '🖼 Calibre #384\'s PDF gives no pictures: its pages don\'t match this ebook.');
	assert.deepStrictEqual([store.pictures.peek(w).key, store.pictures.peek(w).count], [KEY, 0], 'the pointer keeps the analysis from the sweep');
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 1, 'not tried again for the same text');
	const hdB = handle(h.dir, BASE_B);
	h.pics.ensure(w, hdB);
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'align']);
	assert.strictEqual(h.pics.forText(w, hdB).count, 3);
	const d = await h.pics.describe(w);
	assert.deepStrictEqual([d.state, d.count, d.share], ['ready', 3, 0.97]);
});

test('after a restart the kept pictures show at once, from disk, even with Calibre closed', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const first = h.pics.forText(w, hd);
	await h.close();
	const calibre = fakeCalibre();
	calibre.reachable = false;
	const h2 = harness({ dir: h.dir, calibre, clock: h.clock });
	h2.pics.ensure(w, hd);
	assert.strictEqual(h2.pics.forText(w, hd), null, 'nothing until it is loaded');
	await h2.idle();
	assert.deepStrictEqual(h2.pics.forText(w, hd).pictures.map((p) => [p.id, p.word]), first.pictures.map((p) => [p.id, p.word]));
	assert.deepStrictEqual([h2.changes, h2.worker.runs.length, h2.pics.status(w, hd).state], [[w.id], 0, 'ready']);
	assert.strictEqual(calibre.calls.lib, 1);
	h2.clock.advance(CALIBRE_RETRY_MS - 1);
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.strictEqual(calibre.calls.lib, 1, 'Calibre is asked again after 2 minutes, not on every page');
	calibre.reachable = true;
	h2.clock.advance(1);
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.deepStrictEqual([calibre.calls.lib, calibre.calls.book.length, h2.worker.runs.length], [2, 1, 0]);
	assert.strictEqual(h2.pics.forText(w, hd).key, KEY);
});

// With Calibre closed (the common case: texts serve from cache), every book whose
// text came from Calibre said "Reading the PDF for pictures failed", most of them with no PDF at all.
test('with Calibre closed, off or refusing the login and no PDF known for the text, nothing is claimed to have failed', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ formats: ['epub'] }) }) });
	h.calibre.reachable = false;
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const st = h.pics.status(w, hd);
	assert.deepStrictEqual([st.state, st.code, st.retryAt], ['unknown', 'calibre-unreachable', T0 + CALIBRE_RETRY_MS]);
	assert.strictEqual(h.line(w, hd), null, '!book text says nothing');
	const d = await h.pics.describe(w);
	assert.deepStrictEqual([d.state, d.code, d.pdfId], ['unknown', 'calibre-unreachable', null], '!book link says it was not checked, and why');
	h.clock.advance(CALIBRE_RETRY_MS - 1);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.lib, 1, 'asked again after 2 minutes, not on every page');
	h.calibre.reachable = true;
	h.clock.advance(1);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.line(w, hd)], ['no-pdf', null]);

	h.calibre.fail = new CalibreError('auth', 'Calibre at 127.0.0.1:8080 refused the login.');
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code, h.line(w, hd)], ['unknown', 'calibre-auth', null]);
	h.calibre.fail = null;
	h.calibreOff = true;
	h.clock.advance(CALIBRE_RETRY_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code, h.line(w, hd)], ['unknown', 'calibre-off', null]);
	assert.deepStrictEqual([h.calibre.calls.download.length, h.worker.runs.length], [0, 0]);

	// A PDF this record is known to have, from an earlier run's pointer for another text: the wait is real.
	const k = harness({ calibre: fakeCalibre() });
	k.calibre.reachable = false;
	store.pictures.set(w.id, pointer(KEY, BASE_B));
	k.pics.ensure(w, handle(k.dir));
	await k.idle();
	assert.deepStrictEqual([k.pics.status(w, handle(k.dir)).state, k.pics.status(w, handle(k.dir)).code], ['waiting', 'calibre-unreachable']);
	assert.strictEqual(k.line(w, handle(k.dir)), '🖼 Reading the PDF for pictures failed (Calibre isn\'t answering); it tries again in 2 minutes.');
});

// A damaged PDF's 10-minute check with Calibre closed turned "it is damaged" into "Reading the PDF
// for pictures failed (Calibre isn't answering)" until Calibre answered again.
test('a known failure keeps its reason when a later check finds Calibre closed, and that check only moves the next one', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, fail: 'pdf-damaged' } }) }) });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code], ['failed', 'pdf-damaged']);
	h.calibre.reachable = false;
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	const asked = h.calibre.calls.lib;
	assert.strictEqual(asked, 2, 'the record was looked at again');
	const st = h.pics.status(w, hd);
	assert.deepStrictEqual([st.state, st.code, st.retryAt], ['failed', 'pdf-damaged', h.clock.now() + CALIBRE_RETRY_MS]);
	assert.strictEqual(h.line(w, hd), '🖼 Calibre #384\'s PDF gives no pictures: it is damaged.');
	const d = await h.pics.describe(w);
	assert.deepStrictEqual([d.state, d.code], ['failed', 'pdf-damaged'], '!book link says the same');
	h.clock.advance(CALIBRE_RETRY_MS - 1);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.lib, asked, 'not asked again on every page');
	h.calibre.reachable = true;
	h.clock.advance(1);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.lib, asked + 1);
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code, h.worker.runs.length], ['failed', 'pdf-damaged', 1]);

	// Whatever the code: a text that does not line up keeps saying so.
	const a = harness();
	a.worker.alignFails.add(BASE_A);
	const ha = handle(a.dir);
	a.pics.ensure(w, ha);
	await a.idle();
	a.calibre.fail = new CalibreError('auth', 'Calibre at 127.0.0.1:8080 refused the login.');
	a.clock.advance(REVALIDATE_MS);
	a.pics.ensure(w, ha);
	await a.idle();
	assert.deepStrictEqual([a.pics.status(w, ha).state, a.pics.status(w, ha).code], ['failed', 'align-failed']);
	assert.strictEqual(a.line(w, ha), '🖼 Calibre #384\'s PDF gives no pictures: its pages don\'t match this ebook.');
});

// --- failures --------------------------------------------------------------------------------

test('an encrypted PDF is recorded on disk and never read again, even after a restart', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, fail: 'pdf-encrypted' } }) }) });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code], ['failed', 'pdf-encrypted']);
	assert.strictEqual(h.line(w, hd), '🖼 Calibre #384\'s PDF gives no pictures: it is encrypted.');
	assert.deepStrictEqual(readJson(h.failFile()), { version: 1, fingerprint: FP, code: 'pdf-encrypted', stable: true, strikes: 1, retryAfter: null, at: T0 });
	assert.deepStrictEqual(files(h.dir), [`pictures/${KEY}.fail.json`], 'no PDF, no .work folder');
	assert.strictEqual(store.pictures.peek(w), null, 'a failed key gets no pointer');
	h.clock.advance(DAY);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 1);
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.length, h2.pics.status(w, hd).code], [0, 'pdf-encrypted']);
	assert.ok(fs.existsSync(h.failFile()), 'a fail record younger than 30 days stays without a pointer');
	assertCleanLogs(h);
});

test('a hung analysis is tried again after 30 minutes, and the third timeout gives up for good', async () => {
	const h = harness();
	h.worker.answer = () => ({ ok: false, code: 'timeout', message: 'no progress in 120000 ms' });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code, h.pics.status(w, hd).retryAt], ['waiting', 'timeout', T0 + STRIKE_RETRY_MS]);
	assert.strictEqual(h.line(w, hd), '🖼 Reading the PDF for pictures failed (it took too long); it tries again in 30 minutes.');
	assert.deepStrictEqual(readJson(h.failFile()), { version: 1, fingerprint: FP, code: 'timeout', stable: false, strikes: 1, retryAfter: T0 + STRIKE_RETRY_MS, at: T0 });
	assert.deepStrictEqual(files(h.dir), [`pictures/${KEY}.fail.json`], 'the PDF and .work are gone after a timeout');
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 1);
	h.clock.advance(STRIKE_RETRY_MS - REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, readJson(h.failFile()).strikes], [2, 2]);
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock, worker: h.worker });
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.strictEqual(h.worker.runs.length, 2, 'a restart does not wipe the strikes');
	h2.clock.advance(STRIKE_RETRY_MS);
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.strictEqual(h.worker.runs.length, 3);
	assert.deepStrictEqual(readJson(h.failFile()), { version: 1, fingerprint: FP, code: 'gave-up', stable: true, strikes: 3, retryAfter: null, at: h2.clock.now() });
	assert.strictEqual(statusLine(h2.pics.status(w, hd)), '🖼 Calibre #384\'s PDF gives no pictures: reading it failed 3 times.');
	h2.clock.advance(STRIKE_RETRY_MS * 4);
	h2.pics.ensure(w, hd);
	await h2.idle();
	assert.strictEqual(h.worker.runs.length, 3);
	assert.deepStrictEqual(files(h.dir), [`pictures/${KEY}.fail.json`]);
});

test('Calibre closed during the download waits 2 minutes in memory; missing tools wait a minute and download nothing', async () => {
	const h = harness();
	h.calibre.failDownload = new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).');
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code], ['waiting', 'calibre-unreachable']);
	assert.strictEqual(h.line(w, hd), '🖼 Reading the PDF for pictures failed (Calibre isn\'t answering); it tries again in 2 minutes.');
	assert.deepStrictEqual(files(h.dir), [], 'nothing on disk: no fail record, no .work');
	h.clock.advance(CALIBRE_RETRY_MS - 1000);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.download.length, 1);
	h.calibre.failDownload = null;
	h.clock.advance(1000);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.calibre.calls.download.length, h.worker.runs.length, h.pics.forText(w, hd).count], [2, 1, 3]);

	const t = harness();
	t.tools = { ok: false, code: 'tools-missing', reason: 'not-found' };
	t.pics.ensure(w, handle(t.dir));
	await t.idle();
	assert.strictEqual(t.pics.status(w, handle(t.dir)).state, 'tools-missing');
	assert.strictEqual(t.line(w, handle(t.dir)), '🖼 Calibre\'s PDF tools weren\'t found on this PC, so no pictures. Install Calibre here.');
	assert.deepStrictEqual([t.calibre.calls.download.length, t.toolCalls], [0, 1]);
	assert.ok(t.logs.some(([, l]) => l === 'Read-along pictures: Calibre\'s PDF tools were not found (not-found).'));
	t.clock.advance(TOOLS_RETRY_MS - 1000);
	t.pics.ensure(w, handle(t.dir));
	await t.idle();
	assert.strictEqual(t.toolCalls, 1);
	t.tools = TOOLS;
	t.clock.advance(1000);
	t.pics.ensure(w, handle(t.dir));
	await t.idle();
	assert.deepStrictEqual([t.toolCalls, t.worker.runs.length, t.pics.forText(w, handle(t.dir)).count], [2, 1, 3]);
});

// A 404 on the download was taken as "no PDF" and the record checked again at once,
// so a record whose PDF file is gone from the library was downloaded again on every page turn.
test('a record that lists a PDF whose file is gone waits 10 minutes between tries, and says so once in the log', async () => {
	const h = harness();
	h.calibre.failDownload = new CalibreError('no-format', 'Calibre at 127.0.0.1:8080 has no pdf for book #384.');
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const st = h.pics.status(w, hd);
	assert.deepStrictEqual([st.state, st.code, st.retryAt], ['waiting', 'pdf-missing', T0 + REVALIDATE_MS]);
	assert.strictEqual(h.line(w, hd), '🖼 Reading the PDF for pictures failed (Calibre lists a PDF but has no file for it); it tries again in 10 minutes.');
	const d = await h.pics.describe(w);
	assert.deepStrictEqual([d.state, d.code, d.pdfId], ['waiting', 'pdf-missing', 384]);
	for (let i = 0; i < 5; i++) {
		h.clock.advance(MINUTE);
		h.pics.ensure(w, hd);
		await h.idle();
	}
	assert.deepStrictEqual([h.calibre.calls.book.length, h.calibre.calls.download.length, h.toolCalls], [1, 1, 1], 'nothing asked on the page turns in between');
	h.calibre.failDownload = new CalibreError('not-found', 'Calibre at 127.0.0.1:8080 has no book #384.');
	h.clock.advance(REVALIDATE_MS - 5 * MINUTE);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.calibre.calls.book.length, h.calibre.calls.download.length], [2, 2], 'the record is read again, then the PDF');
	assert.strictEqual(h.pics.status(w, hd).code, 'pdf-missing');
	const warned = h.logs.filter(([, l]) => l.startsWith('Read-along pictures: could not download the PDF'));
	assert.deepStrictEqual(warned.map(([, l]) => l), [`Read-along pictures: could not download the PDF for ${KEY}: pdf-missing.`], 'one line per key, not one per try');
	assert.deepStrictEqual(files(h.dir), [], 'no fail record, no .work');
	h.calibre.failDownload = null;
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, hd).count, 3, 'the file put back is read');
	assertCleanLogs(h);
});

// An io-error after the child ran was a 2-minute memory wait, so a disk that
// kept failing downloaded the PDF and read every page again every few minutes, with no strike.
test('a disk error after the PDF was read is a strike, tried again in 30 minutes and given up on the third; one in the download waits 2 minutes', async () => {
	const h = harness();
	h.worker.answer = () => ({ ok: false, code: 'io-error', message: 'Error ENOSPC' });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code, h.pics.status(w, hd).retryAt], ['waiting', 'disk-error', T0 + STRIKE_RETRY_MS]);
	assert.strictEqual(h.line(w, hd), '🖼 Reading the PDF for pictures failed (the bot couldn\'t read or write its picture files); it tries again in 30 minutes.');
	assert.deepStrictEqual(readJson(h.failFile()), { version: 1, fingerprint: FP, code: 'disk-error', stable: false, strikes: 1, retryAfter: T0 + STRIKE_RETRY_MS, at: T0 });
	for (const step of [CALIBRE_RETRY_MS, REVALIDATE_MS]) {
		h.clock.advance(step);
		h.pics.ensure(w, hd);
		await h.idle();
	}
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length], [1, 1], 'not read again after 2 minutes');
	h.clock.advance(STRIKE_RETRY_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, readJson(h.failFile()).strikes], [2, 2]);
	h.clock.advance(STRIKE_RETRY_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, readJson(h.failFile()).code, readJson(h.failFile()).stable], [3, 'gave-up', true]);
	assert.ok(h.logs.some(([, l]) => l === `Read-along pictures: reading the PDF ${KEY} failed 3 times (disk-error); it is not tried again.`), JSON.stringify(h.logs));
	assert.deepStrictEqual(files(h.dir), [`pictures/${KEY}.fail.json`]);

	const d = harness();
	d.calibre.failDownload = new CalibreError('io', 'The pdf of book #384 could not be saved (ENOSPC).');
	d.pics.ensure(w, handle(d.dir));
	await d.idle();
	assert.deepStrictEqual([d.pics.status(w, handle(d.dir)).state, d.pics.status(w, handle(d.dir)).code, d.pics.status(w, handle(d.dir)).retryAt], ['waiting', 'io-error', T0 + CALIBRE_RETRY_MS]);
	assert.deepStrictEqual(files(d.dir), [], 'nothing was read yet: no strike');
	d.calibre.failDownload = null;
	d.clock.advance(CALIBRE_RETRY_MS);
	d.pics.ensure(w, handle(d.dir));
	await d.idle();
	assert.strictEqual(d.pics.forText(w, handle(d.dir)).count, 3);
});

test('a finished analysis that cannot be put in place is a disk-error strike, and a folder it was replacing comes back', async () => {
	let failing = true;
	const intoKey = (from, to) => failing && pathMod.basename(from) === 'out' && to === pathMod.join(h.picsDir, KEY);
	const h = harness({ fs: failingRename((from, to) => intoKey(from, to)) });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.pics.status(w, hd).state, h.pics.status(w, hd).code], ['waiting', 'disk-error']);
	assert.deepStrictEqual(readJson(h.failFile()), { version: 1, fingerprint: FP, code: 'disk-error', stable: false, strikes: 1, retryAfter: T0 + STRIKE_RETRY_MS, at: T0 });
	assert.deepStrictEqual(files(h.dir), [`pictures/${KEY}.fail.json`], 'no half-installed folder, no .work');
	assert.ok(h.logs.some(([level, l]) => level === 'warn' && l === `Read-along pictures: could not put the analysis ${KEY} in place: EIO`), JSON.stringify(h.logs));
	failing = false;
	h.clock.advance(STRIKE_RETRY_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.forText(w, hd).count, 3);
	assert.ok(!fs.existsSync(h.failFile()), 'the strike goes with the success');

	// pictures:redo on a key another narration shows: the new folder cannot go in, so the old one
	// is moved back and both books serve it on.
	const w2 = work({ id: 'avery-quill/the-lantern-road-dramatized', title: 'The Lantern Road (Dramatized)' });
	const hd2 = handle(h.dir, BASE_A, { workId: w2.id });
	h.pics.ensure(w2, hd2);
	await h.idle();
	const shown = h.pics.forText(w2, hd2);
	h.opened = { ok: true, handle: hd, stale: false };
	failing = true;
	assert.strictEqual((await h.pics.command(w, 'redo', { by: '42' })).code, 'redo');
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full', 'full']);
	assert.deepStrictEqual(fs.readdirSync(h.picsDir).sort(), [KEY, `${KEY}.fail.json`].sort(), 'the old folder is back, nothing left aside');
	assert.deepStrictEqual(files(h.keyDir()), [`align-${BASE_A}.json`, 'index.json', 'p013.jpg', 'p022.jpg', 'p030-031.jpg', 'pages.json']);
	assert.strictEqual(h.pics.forText(w2, hd2), shown);
	assert.strictEqual(h.pics.forText(w, hd).count, 3, 'the kept analysis serves on for the book redone');
	assert.strictEqual(readJson(h.failFile()).code, 'disk-error');
});

// A whole analysis can still have lost a few pages or pictures, which nothing showed.
test('the install line counts the pages the scan skipped and the pictures it could not encode, only when there are some', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, skipped: 2, encodeFailed: 1 } }) }) });
	const w = work();
	h.pics.ensure(w, handle(h.dir));
	await h.idle();
	assert.ok(h.logs.some(([level, l]) => level === 'info' && l === `Read-along pictures: read the PDF for pictures ${KEY}: 40 pages, 3 pictures (1 spreads) in 5 ms; pages skipped: 2, pictures not encoded: 1.`), JSON.stringify(h.logs));
	const g = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, encodeFailed: 4 } }) }) });
	g.pics.ensure(w, handle(g.dir));
	await g.idle();
	assert.ok(g.logs.some(([, l]) => l.endsWith('in 5 ms; pages skipped: 0, pictures not encoded: 4.')), JSON.stringify(g.logs));
	assertCleanLogs(h);
});

// Any align-<base>.fail.json blocked its text for good, whatever version wrote it,
// so bumping ALIGN_VERSION retried the texts that had worked and never the ones that had failed.
test('an alignment failure recorded by another version, or for another text, does not block lining this text up again', async () => {
	const h = harness();
	h.worker.alignFails.add(BASE_A);
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.status(w, hd).code, 'align-failed');
	await h.close();
	const failFile = pathMod.join(h.keyDir(), `align-${BASE_A}.fail.json`);
	const okFile = pathMod.join(h.keyDir(), `align-${BASE_A}.json`);
	const kept = readJson(failFile);
	for (const bad of [{ ...kept, version: 0 }, { ...kept, version: 2 }, { ...kept, base: BASE_B }, {}]) {
		fs.rmSync(okFile, { force: true });
		fs.writeFileSync(failFile, JSON.stringify(bad));
		const again = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
		again.pics.ensure(w, hd);
		await again.idle();
		assert.deepStrictEqual(again.worker.runs.map((j) => j.kind), ['align'], JSON.stringify(bad));
		assert.strictEqual(again.pics.forText(w, hd).count, 3);
		await again.close();
	}
	fs.rmSync(okFile, { force: true });
	fs.writeFileSync(failFile, JSON.stringify(kept));
	const same = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	same.pics.ensure(w, hd);
	await same.idle();
	assert.deepStrictEqual([same.worker.runs.length, same.pics.status(w, hd).code], [0, 'align-failed'], 'this version\'s own record for this text still holds');
});

// After a restart with Calibre closed, a known alignment failure was blamed on Calibre.
test('describe names a kept alignment failure, not a Calibre that is closed or off, for a book not opened since the restart', async () => {
	const h = harness();
	h.worker.alignFails.add(BASE_A);
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	await h.close();
	store.works.set(w.id, { base: BASE_A, fingerprint: hd.fingerprint, via: 'auto', source: hd.source, at: T0 });
	const calibre = fakeCalibre();
	calibre.reachable = false;
	const h2 = harness({ dir: h.dir, calibre, clock: h.clock });
	const d = await h2.pics.describe(w);
	assert.deepStrictEqual([d.state, d.code, d.share, d.key], ['failed', 'align-failed', 0.12, KEY]);
	h2.calibreOff = true;
	const off = await h2.pics.describe(w);
	assert.deepStrictEqual([off.state, off.code, off.share], ['failed', 'align-failed', 0.12]);
	assert.strictEqual(h2.worker.runs.length, 0);
});

test('a kept alignment failure keeps its reason when the book opens after a restart with Calibre closed', async () => {
	const h = harness();
	h.worker.alignFails.add(BASE_A);
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	await h.close();
	const calibre = fakeCalibre();
	calibre.reachable = false;
	const h2 = harness({ dir: h.dir, calibre, clock: h.clock });
	h2.pics.ensure(w, hd);
	await h2.idle();
	const st = h2.pics.status(w, hd);
	assert.deepStrictEqual([st.state, st.code], ['failed', 'align-failed']);
	assert.strictEqual(h2.line(w, hd), '🖼 Calibre #384\'s PDF gives no pictures: its pages don\'t match this ebook.');
	assert.strictEqual(h2.worker.runs.length, 0);
});

// A stable failure is not kept forever; the sweep's 30 days apply to it too.
test('a stable failure record expires after 30 days: the sweep removes it and the PDF is read again', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, fail: 'pdf-damaged' } }) }) });
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.status(w, hd).code, 'pdf-damaged');
	await h.close();
	h.calibre.data[384].spec = SPEC;
	h.clock.advance(FAIL_RECORD_MAX_AGE_MS - DAY);
	const young = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	young.pics.ensure(w, hd);
	await young.idle();
	assert.deepStrictEqual([young.worker.runs.length, young.pics.status(w, hd).code], [0, 'pdf-damaged']);
	await young.close();
	h.clock.advance(2 * DAY);
	const old = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	old.pics.ensure(w, hd);
	await old.idle();
	assert.deepStrictEqual([old.worker.runs.length, old.pics.forText(w, hd).count], [1, 3]);
	assert.ok(!fs.existsSync(h.failFile()));
});

test('shutdown mid-analysis kills the job and leaves no PDF, no .work folder and no fail record', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w, hd);
	await until(() => h.worker.current, 'the analysis');
	assert.ok(fs.existsSync(pathMod.join(h.picsDir, `${KEY}.work`, 'book.pdf')));
	h.pics.shutdown();
	assert.strictEqual(h.worker.shutdowns, 1);
	await h.idle();
	gate.resolve();
	assert.deepStrictEqual(files(h.dir), []);
	assert.strictEqual(store.pictures.peek(w), null);
	assert.strictEqual(h.pics.forText(w, hd), null);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 1, 'a closed instance starts nothing');
});

test('the load rules skip a malformed picture, never the whole set, and a version change means work again', async () => {
	const dir = tmpDir('rules');
	const picsDir = pathMod.join(dir, 'pictures');
	writeKey(picsDir, KEY, {
		pictures: [
			{ id: 'p013', file: 'p013.jpg', pages: [13], kind: 'part', bytes: 1000 },
			{ id: 'p014', file: '..\\p014.jpg', pages: [14], kind: 'part' },
			{ id: 'p015', file: 'p015.jpg', pages: [15], kind: 'part' },
			{ id: 'p016', file: 'p016.jpg', pages: [16], kind: 'part', bytes: MAX_PICTURE_BYTES + 1 },
			{ id: 'p017', file: 'p017.jpg', pages: [17], kind: 'part', bytes: 500 },
			{ id: 'p018', file: 'p018.jpg', pages: [18], kind: 'part', bytes: 500 },
			{ id: 'p019', file: 'p019.jpg', pages: [19], kind: 'mystery', bytes: 500 }
		],
		aligns: {
			[BASE_A]: [
				{ id: 'p013', word: 70 }, { id: 'p014', word: 80 }, { id: 'p015', word: 90 }, { id: 'p016', word: 100 },
				{ id: 'p017', word: 2000 }, { id: 'p018', word: 1.5 }, { id: 'p019', word: 1999 }, { id: 'p099', word: 5 }, { id: 'p013', word: 3 }
			]
		}
	});
	store.pictures.set('avery-quill/the-lantern-road', pointer(KEY, BASE_A));
	const h = harness({ dir });
	const w = work();
	const hd = handle(dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual(h.pics.forText(w, hd).pictures.map((p) => [p.id, p.word, p.kind]), [['p013', 70, 'part'], ['p019', 1999, 'part']]);
	assert.strictEqual(h.worker.runs.length, 0);

	const dir2 = tmpDir('rules-version');
	const pics2 = pathMod.join(dir2, 'pictures');
	writeKey(pics2, KEY, { aligns: { [BASE_A]: [{ id: 'p013', word: 70 }] }, version: 2 });
	store.pictures.set('avery-quill/the-lantern-road', pointer(KEY, BASE_A));
	const h2 = harness({ dir: dir2 });
	h2.pics.ensure(w, handle(dir2));
	await h2.idle();
	assert.deepStrictEqual(h2.worker.runs.map((j) => j.kind), ['full'], 'another PICTURES_VERSION is analysed again');

	const dir3 = tmpDir('rules-align');
	const pics3 = pathMod.join(dir3, 'pictures');
	writeKey(pics3, KEY, { aligns: { [BASE_A]: [{ id: 'p013', word: 70 }] } });
	const alignFile = pathMod.join(pics3, KEY, `align-${BASE_A}.json`);
	fs.writeFileSync(alignFile, JSON.stringify({ ...readJson(alignFile), version: 2 }));
	const h3 = harness({ dir: dir3 });
	h3.pics.ensure(w, handle(dir3));
	await h3.idle();
	assert.deepStrictEqual(h3.worker.runs.map((j) => j.kind), ['align'], 'another ALIGN_VERSION is lined up again');
});

// Once the back matter is no longer narrated, a picture placed at its first page (#384's last
// illustration) would never show; its fallback word is where the pager puts it instead.
test('a picture\'s fallback word is served when it is a word of the text, and a bad one is dropped, never the picture', async () => {
	const dir = tmpDir('fallback');
	const picsDir = pathMod.join(dir, 'pictures');
	const ids = ['p013', 'p014', 'p015', 'p016', 'p017', 'p018', 'p019'];
	writeKey(picsDir, KEY, {
		pictures: ids.map((id, i) => ({ id, file: `${id}.jpg`, pages: [13 + i], kind: 'full', bytes: 500 })),
		aligns: {
			[BASE_A]: [
				{ id: 'p013', word: 70, how: 'page-start' },
				{ id: 'p014', word: 1990, how: 'next-text', fallback: 1500 },
				{ id: 'p015', word: 1991, how: 'prev-end', fallback: 0 },
				{ id: 'p016', word: 1992, how: 'next-text', fallback: 2000 },
				{ id: 'p017', word: 1993, how: 'next-text', fallback: -1 },
				{ id: 'p018', word: 1994, how: 'next-text', fallback: 12.5 },
				{ id: 'p019', word: 1995, how: 'next-text', fallback: '1500' }
			]
		}
	});
	store.pictures.set('avery-quill/the-lantern-road', pointer(KEY, BASE_A));
	const h = harness({ dir });
	const w = work();
	const hd = handle(dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const set = h.pics.forText(w, hd);
	assert.deepStrictEqual(set.pictures.map((p) => [p.id, p.word, p.fallback]), [
		['p013', 70, undefined], ['p014', 1990, 1500], ['p015', 1991, 0], ['p016', 1992, undefined],
		['p017', 1993, undefined], ['p018', 1994, undefined], ['p019', 1995, undefined]
	], 'a fallback must be a word of the text, as the word itself must');
	assert.ok(!Object.prototype.hasOwnProperty.call(set.pictures[0], 'fallback'), 'no key at all without one');
	assert.deepStrictEqual(Object.keys(set.pictures[1]).sort(), ['alt', 'bytes', 'fallback', 'height', 'id', 'kind', 'name', 'pages', 'path', 'width', 'word']);
	assert.ok(Object.isFrozen(set.pictures[1]));
	assert.strictEqual(h.worker.runs.length, 0);
});

// The alt text said "page 22" for the PDF's 22nd page, which is printed page 10 of #384.
test('alt text gives the printed page number from the index\'s folio offset, and no number without one', async () => {
	const dir = tmpDir('folio');
	const picsDir = pathMod.join(dir, 'pictures');
	const pictures = [
		{ id: 'p005', file: 'p005.jpg', pages: [5], kind: 'full', bytes: 500 },
		{ id: 'p022', file: 'p022.jpg', pages: [22], kind: 'part', bytes: 500 },
		{ id: 'p062-063', file: 'p062-063.jpg', pages: [62, 63], kind: 'spread', bytes: 500 },
		{ id: 'p064-066', file: 'p064-066.jpg', pages: [64, 65, 66], kind: 'full', bytes: 500 }
	];
	const aligns = { [BASE_A]: pictures.map((p, i) => ({ id: p.id, word: 10 + i, how: 'page-start' })) };
	store.pictures.set('avery-quill/the-lantern-road', pointer(KEY, BASE_A));
	const w = work();
	const altsWith = async (index) => {
		fs.rmSync(picsDir, { recursive: true, force: true });
		writeKey(picsDir, KEY, { pictures, aligns, index });
		const h = harness({ dir });
		h.pics.ensure(w, handle(dir));
		await h.idle();
		const alts = h.pics.forText(w, handle(dir)).pictures.map((p) => [p.id, p.alt]);
		await h.close();
		return alts;
	};
	const plain = 'Picture from the printed book';
	assert.deepStrictEqual(await altsWith({ folioOffset: 12 }), [
		['p005', plain],
		['p022', `${plain}, page 10`],
		['p062-063', `${plain}, pages 50 and 51`],
		['p064-066', `${plain}, pages 52 to 54`]
	], 'a page before printed page 1 gets no number');
	assert.deepStrictEqual((await altsWith({ folioOffset: -2 }))[1], ['p022', `${plain}, page 24`]);
	for (const index of [{ folioOffset: null }, {}, { folioOffset: 1.5 }, { folioOffset: '12' }]) {
		assert.ok((await altsWith(index)).every(([, alt]) => alt === plain), JSON.stringify(index));
	}
});

// --- the sweep and the size cap --------------------------------------------------------------

test('the start-up sweep removes unreferenced analyses, leftovers, dead alignments and old fail records, and skips keys in flight', async () => {
	const dir = tmpDir('sweep');
	const picsDir = pathMod.join(dir, 'pictures');
	const busy = harness({ dir });
	const gate = deferred();
	busy.worker.hold = gate.promise;
	busy.pics.ensure(work(), handle(dir));
	await until(() => busy.worker.current, 'the analysis in flight');
	const live = 'aaaaaaaaaaaaaaa1';
	const orphan = 'aaaaaaaaaaaaaaa2';
	const leftover = 'aaaaaaaaaaaaaaa3';
	const oldFail = 'aaaaaaaaaaaaaaa4';
	const youngFail = 'aaaaaaaaaaaaaaa5';
	const textBase = 'cccccccccccccccc';
	const deadBase = 'dddddddddddddddd';
	writeKey(picsDir, live, { aligns: { [BASE_A]: [{ id: 'p013', word: 70 }], [textBase]: [], [deadBase]: [] } });
	fs.writeFileSync(pathMod.join(picsDir, live, `align-${'eeeeeeeeeeeeeeee'}.fail.json`), '{}');
	fs.writeFileSync(pathMod.join(picsDir, live, 'index.json.tmp'), '{');
	writeKey(picsDir, orphan);
	writeKey(picsDir, KEY);
	fs.mkdirSync(pathMod.join(picsDir, `${leftover}.work`, 'out'), { recursive: true });
	fs.writeFileSync(pathMod.join(picsDir, `${leftover}.work`, 'book.pdf'), '%PDF');
	fs.writeFileSync(pathMod.join(picsDir, `${oldFail}.fail.json`), JSON.stringify({ version: 1, code: 'pdf-damaged', stable: true, at: T0 - FAIL_RECORD_MAX_AGE_MS - DAY }));
	fs.writeFileSync(pathMod.join(picsDir, `${youngFail}.fail.json`), JSON.stringify({ version: 1, code: 'pdf-damaged', stable: true, at: T0 - FAIL_RECORD_MAX_AGE_MS + DAY }));
	fs.writeFileSync(pathMod.join(picsDir, `${youngFail}.fail.json.tmp`), '{');
	fs.writeFileSync(pathMod.join(picsDir, 'notes.txt'), 'the owner\'s own file');
	store.pictures.set('w/live', pointer(live, BASE_A));
	store.works.set('w/text', { base: textBase, fingerprint: 'f', via: 'auto', source: { type: 'calibre', id: 1 }, at: T0 });

	const h = harness({ dir, calibre: fakeCalibre({ 385: record({ id: 385, uuid: UUID2, formats: ['epub'] }) }) });
	const other = work({ id: 'someone/other-book' });
	h.pics.ensure(other, handle(dir, BASE_B, { workId: other.id, source: { id: 385, uuid: UUID2 } }));
	await h.idle();
	const left = files(picsDir).filter((f) => !f.startsWith(`${KEY}.work/`));
	assert.deepStrictEqual(left, [
		`${KEY}/index.json`, `${KEY}/p013.jpg`, `${KEY}/pages.json`,
		`${live}/align-${BASE_A}.json`, `${live}/align-${textBase}.json`, `${live}/index.json`, `${live}/p013.jpg`, `${live}/pages.json`,
		`${youngFail}.fail.json`,
		'notes.txt'
	].sort());
	assert.ok(fs.existsSync(pathMod.join(picsDir, `${KEY}.work`, 'book.pdf')), 'the folder of a job in flight is left alone');
	assert.ok(h.logs.some(([, l]) => /^Read-along pictures: removed 7 unused file\(s\) or folder\(s\)\.$/.test(l)), JSON.stringify(h.logs));
	busy.worker.hold = null;
	gate.resolve();
	await busy.idle();
	assertCleanLogs(h);
});

test('the sweep puts back an analysis a crash left aside in the middle of a swap, and removes one that was replaced', async () => {
	const dir = tmpDir('aside');
	const picsDir = pathMod.join(dir, 'pictures');
	const replaced = 'aaaaaaaaaaaaaaa6';
	const orphan = 'aaaaaaaaaaaaaaa7';
	const aligns = { [BASE_A]: [{ id: 'p013', word: 70 }] };
	const aside = (key) => fs.renameSync(writeKey(picsDir, key, { aligns }), pathMod.join(picsDir, `${key}.old`));
	aside(KEY);
	aside(replaced);
	writeKey(picsDir, replaced, { aligns });
	aside(orphan);
	store.pictures.set('avery-quill/the-lantern-road', pointer(KEY, BASE_A));
	store.pictures.set('w/replaced', pointer(replaced, BASE_A));
	const h = harness({ dir });
	const w = work();
	const hd = handle(dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual(fs.readdirSync(picsDir).sort(), [KEY, replaced].sort());
	assert.deepStrictEqual(h.pics.forText(w, hd).pictures.map((p) => p.id), ['p013'], 'served from the folder put back');
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length], [0, 0], 'nothing read again');
	assert.ok(h.logs.some(([, l]) => l === 'Read-along pictures: put back 1 analysis folder(s) a crash left aside.'), JSON.stringify(h.logs));
	assert.ok(h.logs.some(([, l]) => l === 'Read-along pictures: removed 2 unused file(s) or folder(s).'), JSON.stringify(h.logs));
	assertCleanLogs(h);
});

test('over the size cap, whole analyses go least recently used first, never one used in the last hour', async () => {
	const dir = tmpDir('cap');
	const picsDir = pathMod.join(dir, 'pictures');
	const keys = { oldest: 'bbbbbbbbbbbbbbb1', older: 'bbbbbbbbbbbbbbb2', mid: 'bbbbbbbbbbbbbbb3', recent: 'bbbbbbbbbbbbbbb4' };
	const size = {};
	for (const [name, key] of Object.entries(keys)) {
		const d = writeKey(picsDir, key, { pictures: [{ id: 'p013', file: 'p013.jpg', pages: [13], kind: 'part', bytes: 4000 }], aligns: { [BASE_A]: [{ id: 'p013', word: 70 }] } });
		size[name] = fs.readdirSync(d).reduce((n, f) => n + fs.statSync(pathMod.join(d, f)).size, 0);
	}
	store.pictures.set('w/oldest', pointer(keys.oldest, BASE_A, { usedAt: T0 - 5 * HOUR }));
	store.pictures.set('w/older', pointer(keys.older, BASE_A, { usedAt: T0 - 3 * HOUR }));
	store.pictures.set('w/older-off', pointer(keys.older, BASE_A, { usedAt: T0 - 4 * HOUR, off: true, offBy: '42', offAt: T0 - DAY }));
	store.pictures.set('w/mid', pointer(keys.mid, BASE_A, { usedAt: T0 - 2 * HOUR }));
	store.pictures.set('w/recent', pointer(keys.recent, BASE_A, { usedAt: T0 - 10 * MINUTE }));
	const cap = size.mid + size.recent + 10;
	const h = harness({ dir, maxDirBytes: cap, calibre: fakeCalibre({ 385: record({ id: 385, uuid: UUID2, formats: ['epub'] }) }) });
	const other = work({ id: 'someone/other-book' });
	h.pics.ensure(other, handle(dir, BASE_B, { workId: other.id, source: { id: 385, uuid: UUID2 } }));
	await h.idle();
	assert.deepStrictEqual(fs.readdirSync(picsDir).sort(), [keys.mid, keys.recent].sort());
	const all = store.pictures.all();
	assert.deepStrictEqual(Object.keys(all).sort(), ['w/mid', 'w/older-off', 'w/recent']);
	assert.deepStrictEqual([all['w/older-off'].key, all['w/older-off'].off, all['w/older-off'].offBy], [null, true, '42'], 'the owner\'s off switch outlives the analysis');
	assert.ok(h.logs.some(([, l]) => l.startsWith('Read-along pictures: the pictures folder was over 0 MB; removed the 2 least recently used analyses')), JSON.stringify(h.logs));

	const tiny = harness({ dir: tmpDir('cap-recent'), maxDirBytes: 1, calibre: fakeCalibre({ 385: record({ id: 385, uuid: UUID2, formats: ['epub'] }) }) });
	writeKey(tiny.picsDir, keys.recent, { aligns: { [BASE_A]: [{ id: 'p013', word: 70 }] } });
	store.pictures.set('w/recent', pointer(keys.recent, BASE_A, { usedAt: T0 - 59 * MINUTE }));
	tiny.pics.ensure(other, handle(tiny.dir, BASE_B, { workId: other.id, source: { id: 385, uuid: UUID2 } }));
	await tiny.idle();
	assert.ok(fs.existsSync(pathMod.join(tiny.picsDir, keys.recent)), 'used within the hour: kept, cap or not');
});

test('the cap is applied when an analysis ends, never to that analysis or one a page is showing', async () => {
	const dir = tmpDir('cap-job');
	const picsDir = pathMod.join(dir, 'pictures');
	const stale = 'bbbbbbbbbbbbbbb5';
	writeKey(picsDir, stale, { aligns: { [BASE_A]: [{ id: 'p013', word: 70 }] } });
	store.pictures.set('w/stale', pointer(stale, BASE_A, { usedAt: T0 + HOUR }));
	const second = record({ id: 385, uuid: UUID2, pdf: { size: 1234, mtime: '2026-11-01T00:00:00+00:00' } });
	const h = harness({ dir, maxDirBytes: 1, calibre: fakeCalibre({ 384: record(), 385: second }) });
	const w = work();
	const hd = handle(dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual(fs.readdirSync(picsDir).sort(), [KEY, stale].sort(), 'the stale one was used within the hour at the time');
	h.clock.advance(3 * HOUR);
	// Its listener turns a page: the set is in use.
	h.pics.ensure(w, hd);
	await h.idle();
	const w2 = work({ id: 'someone/other-book', title: 'Other Book' });
	const hd2 = handle(dir, BASE_B, { workId: w2.id, source: { id: 385, uuid: UUID2 } });
	h.pics.ensure(w2, hd2);
	await h.idle();
	const k385 = picturesKey(`calibre:${LIB}:385:pdf:1234:2026-11-01T00:00:00+00:00`);
	assert.deepStrictEqual(fs.readdirSync(picsDir).sort(), [KEY, k385].sort(), 'the least recently used went; the new one and the one on screen stayed');
	assert.strictEqual(store.pictures.peek('w/stale'), null);
	assert.strictEqual(h.pics.forText(w, hd).count, 3);
	assert.strictEqual(h.pics.forText(w2, hd2).count, 3);
});

test('a book read for hours keeps its analysis recent for the size cap', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(store.pictures.peek(w).usedAt, T0);
	for (let i = 0; i < 12; i++) {
		h.clock.advance(5 * MINUTE);
		h.pics.ensure(w, hd);
		await h.idle();
	}
	assert.ok(store.pictures.peek(w).usedAt >= T0 + 30 * MINUTE, `usedAt ${store.pictures.peek(w).usedAt - T0} ms after the start`);
	assert.strictEqual(h.worker.runs.length, 1);
});

// Every set in memory counted as on screen, and memory lasts the whole uptime, so
// the cap could only take what no book had opened since the bot started.
test('the size cap takes an analysis opened earlier in this run once no page has used it for an hour, and its pages stop serving it', async () => {
	const rec = (id, n) => record({ id, uuid: `0b1c2d3e-0000-4000-8000-000000000${id}`, pdf: { size: PDF_SIZE + n, mtime: PDF_MTIME } });
	const h = harness({ calibre: fakeCalibre({ 384: record(), 385: rec(385, 1), 386: rec(386, 2) }) });
	const books = [384, 385, 386].map((id) => {
		const w = work({ id: `someone/book-${id}`, title: `Book ${id}` });
		return { w, hd: handle(h.dir, BASE_A, { workId: w.id, source: { id, uuid: id === 384 ? UUID : `0b1c2d3e-0000-4000-8000-000000000${id}` } }) };
	});
	const keyOf = (id, n) => picturesKey(`calibre:${LIB}:${id}:pdf:${PDF_SIZE + n}:${PDF_MTIME}`);
	const [b1, b2, b3] = books;
	h.pics.ensure(b1.w, b1.hd);
	await h.idle();
	const one = files(h.keyDir()).reduce((n, f) => n + fs.statSync(pathMod.join(h.keyDir(), f)).size, 0);
	// The cap is crossed by a second analysis; the PC is out of space for book 1 two hours later.
	await h.close();
	const c = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock, maxDirBytes: one + 100 });
	c.pics.ensure(b1.w, b1.hd);
	await c.idle();
	assert.strictEqual(c.pics.forText(b1.w, b1.hd).count, 3);
	c.clock.advance(2 * HOUR);
	c.changes.length = 0;
	c.pics.ensure(b2.w, b2.hd);
	await c.idle();
	assert.deepStrictEqual(fs.readdirSync(c.picsDir), [keyOf(385, 1)], 'book 1, opened in this run but not for two hours, went');
	assert.strictEqual(c.pics.forText(b1.w, b1.hd), null, 'and its pages no longer serve files that are gone');
	assert.deepStrictEqual(c.changes, [b2.w.id], 'no news for book 1: an open page of it keeps what Discord holds until it is drawn again');
	assert.strictEqual(store.pictures.peek(b1.w), null);
	assert.ok(c.logs.some(([, l]) => l.startsWith('Read-along pictures: the pictures folder was over 0 MB; removed the 1 least recently used analyses')), JSON.stringify(c.logs));
	// Book 2 is read on; book 3's analysis comes 30 minutes later and cannot take it.
	c.clock.advance(30 * MINUTE);
	c.pics.ensure(b2.w, b2.hd);
	await c.idle();
	c.pics.ensure(b3.w, b3.hd);
	await c.idle();
	assert.deepStrictEqual(fs.readdirSync(c.picsDir).sort(), [keyOf(385, 1), keyOf(386, 2)].sort(), 'used within the hour: kept, cap or not');
	assert.strictEqual(c.pics.forText(b2.w, b2.hd).count, 3);
	// Book 1 opened again is checked and read again, not served from a folder that is gone.
	c.pics.ensure(b1.w, b1.hd);
	await c.idle();
	assert.strictEqual(c.pics.forText(b1.w, b1.hd).count, 3);
	assert.deepStrictEqual(c.worker.runs.map((j) => j.key), [keyOf(385, 1), keyOf(386, 2), KEY]);
});

// The cap emitted for the book it took, and the pager answers a
// change by opening the text. A paused book's DM page stays open for hours, so its PDF was
// downloaded and read straight back into the folder the cap had just emptied, for a page nobody
// was turning.
test('the size cap does not read back an analysis it took from a book whose page is left open; that page\'s next turn does', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record(), 385: record({ id: 385, uuid: UUID2, pdf: { size: PDF_SIZE + 1, mtime: PDF_MTIME } }) }) });
	const b1 = { w: work({ id: 'someone/book-384', title: 'Book 384' }) };
	b1.hd = handle(h.dir, BASE_A, { workId: b1.w.id });
	const b2 = { w: work({ id: 'someone/book-385', title: 'Book 385' }) };
	b2.hd = handle(h.dir, BASE_A, { workId: b2.w.id, source: { id: 385, uuid: UUID2 } });
	const k385 = picturesKey(`calibre:${LIB}:385:pdf:${PDF_SIZE + 1}:${PDF_MTIME}`);
	h.pics.ensure(b1.w, b1.hd);
	await h.idle();
	const one = files(h.keyDir()).reduce((n, f) => n + fs.statSync(pathMod.join(h.keyDir(), f)).size, 0);
	await h.close();
	const c = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock, maxDirBytes: one + 100 });
	c.pics.ensure(b1.w, b1.hd);
	await c.idle();
	assert.strictEqual(c.pics.forText(b1.w, b1.hd).count, 3);
	// Book 1's DM page, as helpers/readAlong.js's redrawPictures opens the text (textFor) on a change.
	let redraws = 0;
	c.pics.onChange((id) => {
		if (id !== b1.w.id && id !== '*') return;
		redraws++;
		c.pics.ensure(b1.w, b1.hd);
	});
	c.clock.advance(2 * HOUR);
	const downloads = c.calibre.calls.download.length;
	c.pics.ensure(b2.w, b2.hd);
	await c.idle();
	assert.deepStrictEqual(fs.readdirSync(c.picsDir), [k385], 'book 1, paused for two hours, made room for book 2');
	assert.deepStrictEqual(c.worker.runs.map((j) => j.key), [k385], 'and its PDF was not read again for a page nobody turns');
	assert.strictEqual(c.calibre.calls.download.length - downloads, 1);
	assert.strictEqual(redraws, 0);
	assert.strictEqual(c.pics.forText(b1.w, b1.hd), null, 'the next page drawn has none of the files that are gone');
	assert.strictEqual(c.line(b1.w, b1.hd), null);
	// The listener comes back: the first page turn opens the text, and that reads the PDF again.
	c.clock.advance(10 * MINUTE);
	c.pics.ensure(b1.w, b1.hd);
	await c.idle();
	assert.deepStrictEqual(c.worker.runs.map((j) => j.key), [k385, KEY]);
	assert.strictEqual(c.calibre.calls.download.length - downloads, 2);
	assert.strictEqual(c.pics.forText(b1.w, b1.hd).count, 3);
	assert.strictEqual(redraws, 1, 'the open page is drawn again with its pictures back');
	assert.deepStrictEqual(fs.readdirSync(c.picsDir).sort(), [k385, KEY].sort(), 'book 2, read ten minutes ago, stays');
	assertCleanLogs(c);
});

// --- the owner's controls and the setting -----------------------------------------------------

test('pictures:off hides a book\'s pictures at once and pictures:on brings the kept ones back with no new analysis', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const set = h.pics.forText(w, hd);
	h.changes.length = 0;
	h.clock.advance(MINUTE);
	assert.deepStrictEqual(await h.pics.command(w, 'off', { by: '42' }), { ok: true, code: 'off', text: '🖼 Pictures are now off for The Lantern Road.' });
	assert.strictEqual(h.pics.forText(w, hd), null);
	assert.deepStrictEqual(h.changes, [w.id]);
	const ptr = store.pictures.peek(w);
	assert.deepStrictEqual([ptr.key, ptr.off, ptr.offBy, ptr.offAt], [KEY, true, '42', T0 + MINUTE]);
	assert.strictEqual(h.line(w, hd), '🖼 Pictures are off for this book (`!book link "The Lantern Road" pictures:on`).');
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.calibre.calls.book.length, 1, 'nothing is checked while the book is off');
	assert.deepStrictEqual(await h.pics.command(w, 'on', { by: '42' }), { ok: true, code: 'on', text: '🖼 Pictures are on again for The Lantern Road.' });
	assert.strictEqual(h.pics.forText(w, hd), set, 'the kept set comes back at once');
	assert.deepStrictEqual(h.changes, [w.id, w.id]);
	assert.deepStrictEqual([store.pictures.peek(w).off, store.pictures.peek(w).offBy], [false, null]);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length], [1, 1]);
	const fresh = work({ id: 'someone/never-opened', title: 'Never Opened' });
	await h.pics.command(fresh, 'off', { by: '42' });
	assert.deepStrictEqual(store.pictures.peek(fresh), { key: null, base: null, pdf: null, count: 0, at: h.clock.now(), usedAt: null, off: true, offBy: '42', offAt: h.clock.now() });
	h.cfg.audiobookTextPictures = false;
	assert.strictEqual((await h.pics.command(fresh, 'on', { by: '42' })).text, '🖼 Pictures are on again for Never Opened. They show once audiobookTextPictures is on (`!config` → Audiobooks).');
	assert.strictEqual(store.pictures.peek(fresh), null, 'an on switch with no analysis leaves no pointer');
	assert.strictEqual((await h.pics.command(w, 'sideways')).code, 'bad-action');
});

test('pictures:redo clears the analysis and its failure record and reads the PDF again at once', async () => {
	const h = harness({ calibre: fakeCalibre({ 384: record({ spec: { ...SPEC, fail: 'pdf-damaged' } }) }) });
	const w = work();
	const hd = handle(h.dir);
	h.opened = { ok: true, handle: hd, stale: false };
	h.pics.ensure(w, hd);
	await h.idle();
	assert.strictEqual(h.pics.status(w, hd).code, 'pdf-damaged');
	h.calibre.data[384].spec = SPEC;
	const r = await h.pics.command(w, 'redo', { by: '42' });
	assert.deepStrictEqual(r, { ok: true, code: 'redo', text: '🖼 Reading Calibre #384\'s PDF for pictures again; it takes a few minutes. `!book link "The Lantern Road"` shows how far it is.' });
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length, h.pics.forText(w, hd).count], [2, 2, 3]);
	assert.ok(!fs.existsSync(h.failFile()));
	h.changes.length = 0;
	const again = await h.pics.command(w, 'redo', { by: '42' });
	assert.strictEqual(again.ok, true);
	assert.strictEqual(h.pics.forText(w, hd), null, 'the old pictures go at once');
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.pics.forText(w, hd).count], [3, 3]);
	assert.deepStrictEqual(h.changes, [w.id, w.id]);
	assertCleanLogs(h);
});

// On a key another book shares, redo only lined this text up again,
// yet said the PDF was being read again; a picture missing from the folder stayed missing.
test('pictures:redo during an analysis cancels it; on an analysis another book shows, it reads the PDF again without taking that book\'s folder away', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.opened = { ok: true, handle: hd, stale: false };
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w, hd);
	await until(() => h.worker.current, 'the analysis');
	const pending = h.pics.command(w, 'redo', { by: '42' });
	await until(() => h.worker.cancels.includes(KEY), 'the cancel');
	h.worker.hold = null;
	gate.resolve();
	assert.strictEqual((await pending).ok, true);
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full']);
	assert.strictEqual(h.pics.forText(w, hd).count, 3);
	assert.ok(!fs.existsSync(pathMod.join(h.picsDir, `${KEY}.work`)));

	const w2 = work({ id: 'avery-quill/the-lantern-road-dramatized', title: 'The Lantern Road (Dramatized)' });
	const hd2 = handle(h.dir, BASE_B, { workId: w2.id });
	h.pics.ensure(w2, hd2);
	await h.idle();
	const shown = h.pics.forText(w2, hd2);
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full', 'align']);
	const downloads = h.calibre.calls.download.length;
	const gate2 = deferred();
	h.worker.hold = gate2.promise;
	assert.deepStrictEqual(await h.pics.command(w, 'redo', { by: '42' }), {
		ok: true, code: 'redo', text: '🖼 Reading Calibre #384\'s PDF for pictures again; it takes a few minutes. `!book link "The Lantern Road"` shows how far it is.'
	});
	await until(() => h.worker.current && h.worker.current.job.kind === 'full', 'the PDF read again');
	assert.strictEqual(h.pics.forText(w2, hd2), shown, 'the other book shows its pictures while the PDF is read');
	assert.deepStrictEqual(files(h.keyDir()), [`align-${BASE_A}.json`, `align-${BASE_B}.json`, 'index.json', 'p013.jpg', 'p022.jpg', 'p030-031.jpg', 'pages.json'].sort(), 'its folder stays whole meanwhile');
	h.worker.hold = null;
	gate2.resolve();
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full', 'align', 'full'], 'the PDF is read again, not just lined up');
	assert.strictEqual(h.calibre.calls.download.length, downloads + 1);
	assert.strictEqual(h.pics.forText(w, hd).count, 3);
	assert.deepStrictEqual(fs.readdirSync(h.picsDir), [KEY], 'no folder left aside, no .work');
	assert.strictEqual(h.pics.forText(w2, hd2), shown, 'the other book keeps its pictures until its next look');
	h.pics.ensure(w2, hd2);
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full', 'align', 'full', 'align'], 'which lines its text up with the new folder');
	assert.notStrictEqual(h.pics.forText(w2, hd2), shown);
	assert.deepStrictEqual(h.pics.forText(w2, hd2).pictures.map((p) => p.word), [75, 905, 1505]);
	assert.ok(fs.existsSync(pathMod.join(h.keyDir(), `align-${BASE_B}.json`)));
	assertCleanLogs(h);
});

test('pictures:redo on a key two narrations share brings a deleted picture back for both', async () => {
	const h = harness();
	const w1 = work();
	const w2 = work({ id: 'avery-quill/the-lantern-road-dramatized', title: 'The Lantern Road (Dramatized)' });
	const hd1 = handle(h.dir, BASE_A, { workId: w1.id });
	const hd2 = handle(h.dir, BASE_A, { workId: w2.id });
	h.pics.ensure(w1, hd1);
	await h.idle();
	h.pics.ensure(w2, hd2);
	await h.idle();
	fs.rmSync(pathMod.join(h.keyDir(), 'p022.jpg'));
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.opened = { ok: true, handle: hd1, stale: false };
	h2.pics.ensure(w1, hd1);
	h2.pics.ensure(w2, hd2);
	await h2.idle();
	const ids = (set) => set.pictures.map((p) => p.id);
	assert.deepStrictEqual([ids(h2.pics.forText(w1, hd1)), ids(h2.pics.forText(w2, hd2))], [['p013', 'p030-031'], ['p013', 'p030-031']]);
	const shown = h2.pics.forText(w2, hd2);
	h2.changes.length = 0;
	const r = await h2.pics.command(w1, 'redo', { by: '42' });
	assert.strictEqual(r.text, '🖼 Reading Calibre #384\'s PDF for pictures again; it takes a few minutes. `!book link "The Lantern Road"` shows how far it is.');
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.map((j) => j.kind), h2.calibre.calls.download.length], [['full'], 2]);
	assert.deepStrictEqual(ids(h2.pics.forText(w1, hd1)), ['p013', 'p022', 'p030-031']);
	assert.strictEqual(h2.pics.forText(w2, hd2), shown);
	h2.pics.ensure(w2, hd2);
	await h2.idle();
	assert.deepStrictEqual(ids(h2.pics.forText(w2, hd2)), ['p013', 'p022', 'p030-031'], 'the other narration loads the new folder');
	assert.strictEqual(h2.worker.runs.length, 1, 'with no job of its own');
	assert.deepStrictEqual(h2.changes, [w1.id, w1.id, w2.id]);
	assert.deepStrictEqual([store.pictures.peek(w1).key, store.pictures.peek(w2).key], [KEY, KEY]);
	assertCleanLogs(h2);
});

test('pictures:redo says why it cannot: the setting off, a podcast, the book switched off, no text, a file source, no PDF, Calibre closed', async () => {
	const h = harness();
	const w = work();
	h.cfg.audiobookTextPictures = false;
	assert.strictEqual((await h.pics.command(w, 'redo', { by: '42' })).code, 'disabled');
	h.cfg.audiobookTextPictures = true;
	assert.deepStrictEqual(await h.pics.command(work({ id: 'some-show/episode-1', kind: 'podcast' }), 'redo'), { ok: false, code: 'podcast', text: '🖼 Podcasts have no pictures.' });
	await h.pics.command(w, 'off', { by: '42' });
	assert.strictEqual((await h.pics.command(w, 'redo')).code, 'book-off');
	await h.pics.command(w, 'on', { by: '42' });
	const noText = await h.pics.command(w, 'redo');
	assert.deepStrictEqual([noText.ok, noText.code, noText.text], [false, 'no-ebook', '🖼 This book has no text to line pictures up with. I couldn\'t find an ebook for this book.']);
	h.opened = { ok: true, handle: handle(h.dir, BASE_A, { source: { type: 'file', path: 'D:\\Books\\x.epub', fingerprint: 'file:x' } }) };
	assert.strictEqual((await h.pics.command(w, 'redo')).code, 'not-calibre');
	h.opened = { ok: true, handle: handle(h.dir) };
	h.calibre.data[384] = record({ formats: ['epub'] });
	assert.deepStrictEqual(await h.pics.command(w, 'redo'), { ok: false, code: 'no-pdf', text: '🖼 Calibre #384 has no PDF to read pictures from (or nothing else to line its pages up with).' });
	h.calibre.reachable = false;
	const closed = await h.pics.command(w, 'redo');
	assert.deepStrictEqual([closed.code, closed.text.startsWith('🖼 Calibre isn\'t answering')], ['calibre-unreachable', true]);
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length], [0, 0]);
});

// Redo checked the off switch only on entry, then wrote off: false over a
// pictures:off sent while it waited, and served the pictures again.
test('pictures:off sent while pictures:redo is under way is kept: the pictures stay off and no analysis starts', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.opened = { ok: true, handle: hd, stale: false };
	h.pics.ensure(w, hd);
	await h.idle();
	h.changes.length = 0;
	const redo = h.pics.command(w, 'redo', { by: '42' });
	const off = await h.pics.command(w, 'off', { by: '7' });
	assert.strictEqual(off.code, 'off');
	const r = await redo;
	assert.deepStrictEqual(r, {
		ok: false, code: 'book-off',
		text: '🖼 Cleared the pictures, but they were switched off for this book meanwhile; `!book link "The Lantern Road" pictures:on` reads Calibre #384\'s PDF again.'
	});
	await h.idle();
	const ptr = store.pictures.peek(w);
	assert.deepStrictEqual([ptr.key, ptr.off, ptr.offBy], [null, true, '7'], 'the switch outlives the cleared analysis');
	assert.deepStrictEqual([h.pics.forText(w, hd), h.pics.status(w, hd).state], [null, 'book-off']);
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length], [1, 1], 'no second analysis while it is off');
	assert.strictEqual((await h.pics.command(w, 'on', { by: '7' })).code, 'on');
	h.pics.ensure(w, hd);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.pics.forText(w, hd).count], [2, 3], 'on reads the PDF again, as the reply said');
});

/** Two narrations of Calibre #384 lined up with one text, sharing one analysis, after its first read. */
async function sharedPair() {
	const h = harness();
	const w1 = work();
	const w2 = work({ id: 'avery-quill/the-lantern-road-dramatized', title: 'The Lantern Road (Dramatized)' });
	const hd1 = handle(h.dir, BASE_A, { workId: w1.id });
	const hd2 = handle(h.dir, BASE_A, { workId: w2.id });
	h.pics.ensure(w1, hd1);
	await h.idle();
	h.pics.ensure(w2, hd2);
	await h.idle();
	h.opened = { ok: true, handle: hd1, stale: false };
	assert.deepStrictEqual([h.worker.runs.length, h.calibre.calls.download.length, store.pictures.peek(w2).key], [1, 1, KEY]);
	return { h, w1, w2, hd1, hd2 };
}

// pictures:redo on a key another narration shares: a re-read that failed for a reason that passes
// installed the kept folder as ready and was never tried again, though the reply said the PDF was
// being read again.
test('a forced re-read that fails for a passing reason is tried again after that wait, the kept pictures serving and the status saying so', async () => {
	const { h, w1, hd1 } = await sharedPair();
	const kept = h.pics.forText(w1, hd1).pictures.map((p) => p.path);
	h.calibre.failDownload = new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).');
	assert.strictEqual((await h.pics.command(w1, 'redo', { by: '42' })).code, 'redo');
	assert.strictEqual(store.pictures.peek(w1).redo, KEY, 'the pointer asks for the re-read until it is done');
	await h.idle();
	assert.strictEqual(h.calibre.calls.download.length, 2);
	assert.deepStrictEqual(h.pics.forText(w1, hd1).pictures.map((p) => p.path), kept, 'the kept pictures serve on');
	const st = h.pics.status(w1, hd1);
	assert.deepStrictEqual([st.state, st.code, st.retryAt], ['waiting', 'calibre-unreachable', h.clock.now() + CALIBRE_RETRY_MS], 'not ready: the re-read is still to come');
	assert.strictEqual(h.line(w1, hd1), '🖼 Reading the PDF for pictures failed (Calibre isn\'t answering); it tries again in 2 minutes.');
	const d = await h.pics.describe(w1);
	assert.deepStrictEqual([d.state, d.code, d.retryAt, d.count], ['waiting', 'calibre-unreachable', h.clock.now() + CALIBRE_RETRY_MS, 3]);
	assert.strictEqual(store.pictures.peek(w1).redo, KEY);
	h.clock.advance(CALIBRE_RETRY_MS - 1);
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.strictEqual(h.calibre.calls.download.length, 2, 'not before its wait');
	h.calibre.failDownload = null;
	h.clock.advance(1);
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.deepStrictEqual([h.calibre.calls.download.length, h.worker.runs.map((j) => j.kind)], [3, ['full', 'full']], 'the PDF is read again');
	assert.deepStrictEqual([h.pics.status(w1, hd1).state, h.pics.status(w1, hd1).count, h.line(w1, hd1)], ['ready', 3, '🖼 3 pictures from Calibre #384\'s PDF show on your page as the narration reaches them.']);
	assert.strictEqual(store.pictures.peek(w1).redo, undefined, 'and the pointer stops asking');
	assert.strictEqual(store.pictures.peek(w1).key, KEY);
	h.clock.advance(REVALIDATE_MS);
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 2, 'read again once');
	assertCleanLogs(h);
});

test('a forced re-read with Calibre\'s tools missing waits a minute, and its line does not say the book has no pictures', async () => {
	const { h, w1, hd1 } = await sharedPair();
	h.tools = { ok: false, code: 'tools-missing', reason: 'not-found' };
	await h.pics.command(w1, 'redo', { by: '42' });
	await h.idle();
	assert.strictEqual(h.pics.forText(w1, hd1).count, 3);
	assert.deepStrictEqual([h.pics.status(w1, hd1).state, h.pics.status(w1, hd1).code, h.pics.status(w1, hd1).retryAt], ['waiting', 'tools-missing', h.clock.now() + TOOLS_RETRY_MS]);
	assert.strictEqual(h.line(w1, hd1), '🖼 Reading the PDF for pictures failed (Calibre\'s PDF tools weren\'t found on this PC); it tries again in 1 minute.');
	h.tools = TOOLS;
	h.clock.advance(TOOLS_RETRY_MS);
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, h.pics.status(w1, hd1).state, store.pictures.peek(w1).redo], [2, 'ready', undefined]);
});

test('a forced re-read that times out is struck and tried again after 30 minutes, across a restart, until the third strike ends it', async () => {
	const { h, w1, hd1 } = await sharedPair();
	const timeout = () => ({ ok: false, code: 'timeout', message: 'no progress in 120000 ms' });
	h.worker.answer = timeout;
	await h.pics.command(w1, 'redo', { by: '42' });
	await h.idle();
	assert.deepStrictEqual([h.worker.runs.length, readJson(h.failFile()).strikes], [2, 1]);
	assert.strictEqual(h.pics.forText(w1, hd1).count, 3, 'the kept pictures serve');
	assert.deepStrictEqual([h.pics.status(w1, hd1).state, h.pics.status(w1, hd1).code, h.pics.status(w1, hd1).retryAt], ['waiting', 'timeout', T0 + STRIKE_RETRY_MS]);
	assert.deepStrictEqual([store.pictures.peek(w1).key, store.pictures.peek(w1).redo], [KEY, KEY]);
	await h.close();
	// A restart inside the strike's wait: the pictures show at once, and nothing is read before it ends.
	const worker = fakeWorker();
	worker.answer = timeout;
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock, worker });
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.strictEqual(h2.pics.forText(w1, hd1).count, 3);
	assert.deepStrictEqual([h2.pics.status(w1, hd1).state, h2.pics.status(w1, hd1).code, h2.pics.status(w1, hd1).retryAt, worker.runs.length], ['waiting', 'timeout', T0 + STRIKE_RETRY_MS, 0]);
	h2.clock.advance(STRIKE_RETRY_MS);
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual([worker.runs.length, readJson(h.failFile()).strikes], [1, 2]);
	h2.clock.advance(STRIKE_RETRY_MS);
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual([worker.runs.length, readJson(h.failFile()).code], [2, 'gave-up']);
	assert.deepStrictEqual([h2.pics.status(w1, hd1).state, h2.pics.status(w1, hd1).count, h2.pics.forText(w1, hd1).count], ['ready', 3, 3], 'given up: the kept analysis is what the book shows');
	assert.strictEqual(store.pictures.peek(w1).redo, undefined);
	h2.clock.advance(STRIKE_RETRY_MS * 4);
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.strictEqual(worker.runs.length, 2, 'never tried again after it gave up');
});

test('a forced re-read that was cancelled is tried on the next look; one that fails for good ends the redo and keeps the pictures', async () => {
	const { h, w1, hd1 } = await sharedPair();
	h.worker.answer = () => ({ ok: false, code: 'cancelled' });
	await h.pics.command(w1, 'redo', { by: '42' });
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 2);
	assert.strictEqual(h.pics.forText(w1, hd1).count, 3);
	assert.deepStrictEqual([h.pics.status(w1, hd1).state, h.line(w1, hd1), store.pictures.peek(w1).redo], ['checking', null, KEY], 'not called ready');
	h.worker.answer = null;
	h.calibre.data[384].spec = { ...SPEC, fail: 'pdf-damaged' };
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 3, 'read again on the next look');
	assert.strictEqual(readJson(h.failFile()).code, 'pdf-damaged');
	assert.deepStrictEqual([h.pics.status(w1, hd1).state, h.pics.forText(w1, hd1).count], ['ready', 3], 'the kept analysis serves on');
	assert.strictEqual(store.pictures.peek(w1).redo, undefined);
	h.clock.advance(DAY);
	h.pics.ensure(w1, hd1);
	await h.idle();
	assert.strictEqual(h.worker.runs.length, 3, 'a stable failure ends it');
});

// A !restart in the minutes a forced re-read takes dropped it: the next run served the kept folder
// as ready, and the owner had to ask again.
test('a forced re-read cut short by a restart is done by the next run, once', async () => {
	const { h, w1, w2, hd1, hd2 } = await sharedPair();
	const gate = deferred();
	h.worker.hold = gate.promise;
	await h.pics.command(w1, 'redo', { by: '42' });
	await until(() => h.worker.current && h.worker.runs.length === 2, 'the PDF read again');
	assert.deepStrictEqual(store.pictures.peek(w1), { key: null, base: null, pdf: null, count: 0, at: T0, usedAt: T0, off: false, offBy: null, offAt: null, redo: KEY });
	await h.close();
	assert.strictEqual(store.pictures.peek(w1).redo, KEY, 'a shutdown leaves it asked for');
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	store.works.set(w1.id, { base: BASE_A, fingerprint: hd1.fingerprint, via: 'auto', source: hd1.source, at: T0 });
	assert.strictEqual((await h2.pics.describe(w1)).state, 'available', '!book link before the text opens: the PDF is read on the next open, not ready');
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.map((j) => j.kind), h2.calibre.calls.download.length], [['full'], 3], 'the next run reads the PDF again');
	assert.deepStrictEqual([h2.pics.status(w1, hd1).state, h2.pics.forText(w1, hd1).count], ['ready', 3]);
	assert.deepStrictEqual([store.pictures.peek(w1).key, store.pictures.peek(w1).redo], [KEY, undefined]);
	h2.pics.ensure(w2, hd2);
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.length, h2.pics.forText(w2, hd2).count], [1, 3], 'the other narration shows the new folder');
	h2.clock.advance(REVALIDATE_MS);
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.strictEqual(h2.worker.runs.length, 1);
	await h2.close();
	const h3 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h3.pics.ensure(w1, hd1);
	await h3.idle();
	assert.deepStrictEqual([h3.worker.runs.length, h3.pics.forText(w1, hd1).count], [0, 3], 'once: the run after serves it');
	assertCleanLogs(h2);
});

test('a forced re-read that lands ends the redo even when lining this text up with it fails for now', async () => {
	const { h, w1, hd1 } = await sharedPair();
	h.worker.answer = (job) => {
		if (job.kind === 'align') return { ok: false, code: 'crash', message: 'fake' };
		const res = child(job, h.worker);
		fs.rmSync(pathMod.join(job.workDir, 'out', `align-${BASE_A}.json`));
		return res;
	};
	await h.pics.command(w1, 'redo', { by: '42' });
	await h.idle();
	assert.deepStrictEqual(h.worker.runs.map((j) => j.kind), ['full', 'full', 'align']);
	assert.deepStrictEqual([h.pics.forText(w1, hd1), h.pics.status(w1, hd1).state], [null, 'waiting']);
	assert.strictEqual(store.pictures.peek(w1), null, 'the PDF was read again: the pointer stops asking');
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual(h2.worker.runs.map((j) => j.kind), ['align'], 'the next run lines the text up, and does not read the PDF a third time');
	assert.strictEqual(h2.pics.forText(w1, hd1).count, 3);
});

test('a redo left on the pointer of a PDF that has since failed for good is not run again', async () => {
	const { h, w1, hd1 } = await sharedPair();
	await h.close();
	// As if the run whose re-read gave up could not save the pointer that ended the redo.
	store.pictures.set(w1.id, Object.assign(store.pictures.peek(w1), { redo: KEY }));
	fs.writeFileSync(h.failFile(), JSON.stringify({ version: 1, fingerprint: FP, code: 'gave-up', stable: true, strikes: 3, retryAfter: null, at: T0 }));
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.length, h2.calibre.calls.download.length], [0, 1]);
	assert.deepStrictEqual([h2.pics.status(w1, hd1).state, h2.pics.forText(w1, hd1).count, store.pictures.peek(w1).redo], ['ready', 3, undefined]);
});

// A pointer asking for a shared analysis's re-read that dropped the owner's pictures:off would show
// the pictures again after a restart; a pictures:on that dropped a pointer holding only that ask
// would lose the re-read the redo's reply promised.
test('pictures:off sent while a shared analysis\'s redo lets go outlives a restart, and pictures:on then reads the PDF again once', async () => {
	const { h, w1, hd1 } = await sharedPair();
	const redo = h.pics.command(w1, 'redo', { by: '42' });
	assert.strictEqual((await h.pics.command(w1, 'off', { by: '7' })).code, 'off');
	assert.strictEqual((await redo).code, 'book-off');
	await h.idle();
	assert.deepStrictEqual(store.pictures.peek(w1), { key: null, base: null, pdf: null, count: 0, at: T0, usedAt: T0, off: true, offBy: '7', offAt: T0, redo: KEY });
	assert.strictEqual(h.worker.runs.length, 1, 'nothing is read while it is off');
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	assert.deepStrictEqual([h2.pics.status(w1, hd1).state, (await h2.pics.describe(w1)).state], ['book-off', 'book-off'], 'the switch came through the restart');
	assert.strictEqual((await h2.pics.command(w1, 'on', { by: '7' })).code, 'on');
	assert.deepStrictEqual(store.pictures.peek(w1), { key: null, base: null, pdf: null, count: 0, at: T0, usedAt: T0, off: false, offBy: null, offAt: null, redo: KEY }, 'on keeps the re-read the pointer asks for');
	h2.pics.ensure(w1, hd1);
	await h2.idle();
	assert.deepStrictEqual([h2.worker.runs.map((j) => j.kind), h2.pics.status(w1, hd1).state, h2.pics.forText(w1, hd1).count], [['full'], 'ready', 3], 'the PDF is read again, as the reply said');
	assert.strictEqual(store.pictures.peek(w1).redo, undefined);
	assertCleanLogs(h2);
});

test('the setting is followed live only in production wiring: off cancels the job and clears every page, on brings kept sets back', async (t) => {
	const listeners = new Set();
	const configStore = { onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
	const h = harness({ configStore });
	const notify = (key) => { for (const fn of [...listeners]) fn(key, h.cfg[key]); };
	assert.strictEqual(listeners.size, 1);
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const set = h.pics.forText(w, hd);
	const hdB = handle(h.dir, BASE_B);
	const gate = deferred();
	h.worker.hold = gate.promise;
	h.pics.ensure(w, hdB);
	await until(() => h.worker.current, 'the align job');
	h.changes.length = 0;
	h.cfg.audiobookTextPictures = false;
	notify('audiobookTextPictures');
	assert.deepStrictEqual(h.changes, ['*'], 'every open page is told at once');
	assert.ok(h.worker.cancels.includes(KEY), 'the running job is cancelled');
	assert.strictEqual(h.pics.forText(w, hd), null);
	h.worker.hold = null;
	gate.resolve();
	await h.idle();
	assert.ok(!fs.existsSync(pathMod.join(h.keyDir(), `align-${BASE_B}.json`)));
	h.cfg.audiobookTextPictures = true;
	notify('audiobookTextPictures');
	assert.deepStrictEqual(h.changes, ['*', '*']);
	assert.strictEqual(h.pics.forText(w, hd), set, 'the kept set is back with no new analysis');
	notify('commandPrefix');
	assert.deepStrictEqual(h.changes, ['*', '*']);
	h.pics.shutdown();
	assert.strictEqual(listeners.size, 0, 'shutdown unsubscribes');

	const configStoreModule = require('../helpers/configStore.js');
	const spy = t.mock.method(configStoreModule, 'onChange', () => () => {});
	const dir = tmpDir('wiring');
	const own = createBookPictures({ dir, cfg: { audiobookTextPictures: true }, store, worker: fakeWorker(), logger: { info() {}, warn() {}, error() {} } });
	assert.strictEqual(spy.mock.callCount(), 0, 'a test\'s own config is not followed');
	const prod = createBookPictures({ dir, store, worker: fakeWorker(), logger: { info() {}, warn() {}, error() {} } });
	assert.strictEqual(spy.mock.callCount(), 1, 'production wiring follows /config');
	own.shutdown();
	prod.shutdown();
	const inert = createBookPictures({ worker: fakeWorker() });
	assert.strictEqual(spy.mock.callCount(), 1, 'an inert instance subscribes to nothing');
	inert.ensure(work(), handle(dir));
	assert.deepStrictEqual([inert.forText(work(), handle(dir)), inert.status(work(), handle(dir)).state, (await inert.command(work(), 'redo')).code], [null, 'off', 'unavailable']);
	inert.shutdown();
});

test('describe reports the PDF by id, size and date, never its path, for a book open now or not', async () => {
	const h = harness();
	const w = work();
	const hd = handle(h.dir);
	h.pics.ensure(w, hd);
	await h.idle();
	const d = await h.pics.describe(w);
	assert.deepStrictEqual(
		[d.enabled, d.state, d.pdfId, d.pdf, d.key, d.base, d.count, d.found, d.pages, d.share, d.off],
		[true, 'ready', 384, { id: 384, size: PDF_SIZE, mtime: PDF_MTIME }, KEY, BASE_A, 3, 3, 40, 0.97, false]
	);
	assert.ok(!/Calibre Library|book\.pdf|\.jpg/.test(JSON.stringify(d)));
	await h.close();
	const h2 = harness({ dir: h.dir, calibre: h.calibre, clock: h.clock });
	const never = await h2.pics.describe(work({ id: 'someone/never-opened', title: 'Never Opened' }));
	assert.deepStrictEqual([never.state, never.pdf, never.key], ['unknown', null, null], 'a book never opened: nothing known, nothing asked');
	assert.strictEqual(h.calibre.calls.lib, 1);
	store.works.set(w.id, { base: BASE_A, fingerprint: hd.fingerprint, via: 'auto', source: hd.source, at: T0 });
	const cold = await h2.pics.describe(w);
	assert.deepStrictEqual([cold.state, cold.count, cold.found, cold.pdf.size], ['ready', 3, 3, PDF_SIZE]);
	store.works.set(w.id, { base: BASE_B, fingerprint: 'x', via: 'auto', source: hd.source, at: T0 });
	assert.strictEqual((await h2.pics.describe(w)).state, 'available', 'a PDF the next open lines up');
	store.works.set(w.id, { base: BASE_A, fingerprint: 'file:x', via: 'sidecar', source: { type: 'file', path: 'D:\\Books\\x.epub' }, at: T0 });
	assert.strictEqual((await h2.pics.describe(w)).state, 'not-calibre');
	h2.cfg.audiobookTextPictures = false;
	assert.deepStrictEqual([(await h2.pics.describe(w)).state, (await h2.pics.describe(w)).count], ['off', 3]);
	assert.strictEqual(h2.worker.runs.length, 0, 'describing never starts a job');
});
