// helpers/bookTextSource.js with ebook conversion: a Calibre book that is only MOBI or AZW3.
//
// The bug: the owner added the ebooks of the two books they were listening to, as MOBI and AZW3.
// The Calibre index matched both exactly, and the card still never showed 📖, because the
// read-along took only EPUB records (status 'none'). Converting must then not cost the bot: no
// second conversion of an unchanged book after a restart, no two at once for one book, no
// conversion loop for a DRM-locked or damaged file, no 📖 that can only fail when the converter is
// missing or switched off, no temp files left, and no ebook-convert left running at shutdown.
//
// Harness: the real source on the real bookTextStore (pid-suffixed temp files, env set before the
// first require), a temp book_text dir per test, the REAL parse path (helpers/epubTextWorker.js,
// its forked child and epubText.js) on synthetic EPUBs from test/helpers/epubFixture.js, the real
// converter spawning test/helpers/fakeEbookConvert.js in place of ebook-convert, and a fake
// Calibre client whose "MOBI" is the fake converter's JSON instructions. Every word in the books
// comes from the NATO alphabet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const ROOT = pathMod.join(os.tmpdir(), `plexbot-test-book-text-convert-${process.pid}`);
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${ROOT}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${ROOT}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${ROOT}-works.json`;
delete process.env.PLEXBOT_BOOK_TEXT_DIR;

const store = require('../helpers/bookTextStore.js');
const worker = require('../helpers/epubTextWorker.js');
const { createBookTextSource } = require('../helpers/bookTextSource.js');
const { createConverter } = require('../helpers/ebookConvert.js');
const { writeEpub, chapterBook, words } = require('./helpers/epubFixture.js');

const FAKE = pathMod.join(__dirname, 'helpers', 'fakeEbookConvert.js');
const LIB = 'Test_Library';
const STORE_FILES = [process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE, process.env.PLEXBOT_BOOK_TEXT_READERS_FILE, process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE];

let count = 0;
function tmpDir(label) {
	const dir = pathMod.join(ROOT, `${label}-${++count}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.afterEach(() => {
	for (const f of STORE_FILES) fs.rmSync(f, { force: true });
	store.reset();
});

test.after(() => {
	worker.shutdown();
	fs.rmSync(ROOT, { recursive: true, force: true });
});

const EPUBS = pathMod.join(ROOT, 'epubs');
function epubFile(name, chapters) {
	fs.mkdirSync(EPUBS, { recursive: true });
	const file = pathMod.join(EPUBS, `${name}.epub`);
	if (!fs.existsSync(file)) writeEpub(file, chapterBook({ title: 'Synthetic', chapters }));
	return file;
}
const BOOK_A = () => epubFile('a', [{ label: 'Chapter 1', paragraphs: [words(40)] }, { label: 'Chapter 2', paragraphs: [words(40, 5)] }]);
const BOOK_B = () => epubFile('b', [{ label: 'Chapter 1', paragraphs: [words(30, 9)] }, { label: 'Chapter 2', paragraphs: [words(30, 11)] }, { label: 'Chapter 3', paragraphs: [words(30, 13)] }]);

function work(over = {}) {
	return { id: 'avery-quill/the-lantern-road', kind: 'book', title: 'The Lantern Road', author: 'Avery Quill', series: null, sequence: null, aliases: [], dirs: [], ...over };
}

// A Calibre record whose file of `format` is the fake converter's instructions.
function record(format, spec, over = {}) {
	const content = JSON.stringify(spec);
	return {
		title: 'The Lantern Road', authors: ['Avery Quill'], series: null, series_index: 1, identifiers: {},
		formats: [format.toUpperCase()], last_modified: '2026-10-30T05:35:29+00:00', uuid: 'uuid-11',
		format_metadata: { [format]: { size: Buffer.byteLength(content), mtime: '2026-10-30T05:35:29.738293+00:00', path: 'X:/Calibre Library/Avery Quill/x' } },
		files: { [format]: content },
		...over
	};
}

function fakeCalibre(books) {
	const c = {
		data: books,
		reachable: true,
		downloads: [],
		check() {
			if (!c.reachable) throw Object.assign(new Error('Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).'), { code: 'unreachable' });
		},
		meta(id) {
			const b = c.data[id];
			if (!b) return null;
			const copy = JSON.parse(JSON.stringify(b));
			delete copy.files;
			return copy;
		},
		async libraryId() { c.check(); return LIB; },
		async search(query) {
			c.check();
			const author = /^authors:"(.+)"$/.exec(query);
			return Object.keys(c.data).map(Number).filter((id) => !author || c.data[id].authors.some((a) => a.includes(author[1])));
		},
		async books(ids) { c.check(); return new Map(ids.map((id) => [id, c.meta(id)])); },
		async book(id) { c.check(); return c.meta(id); },
		async downloadEpub(id, dest) { return c.downloadFormat(id, 'epub', dest); },
		async downloadFormat(id, format, dest) {
			c.check();
			c.downloads.push({ id, format, dest });
			const body = c.data[id].files[format];
			if (body === undefined) throw Object.assign(new Error('no such format'), { code: 'no-format' });
			if (Buffer.isBuffer(body)) fs.writeFileSync(dest, body);
			else fs.writeFileSync(dest, body);
			return { bytes: fs.statSync(dest).size };
		}
	};
	return c;
}

function fakeCatalog(works) {
	const map = new Map(works.map((w) => [w.id, w]));
	return { builtAt: 1, work: (id) => map.get(id) || null, meta() { return { builtAt: this.builtAt }; } };
}

function make({ works = [work()], books = {}, cfg = {}, dir, client, converterFound = true, indexPick, convert } = {}) {
	const spawned = [];
	const spawnOpts = [];
	const lines = [];
	const logger = { info: (...a) => lines.push(`info ${a.join(' ')}`), warn: (...a) => lines.push(`warn ${a.join(' ')}`), error: (...a) => lines.push(`error ${a.join(' ')}`), debug() {} };
	const located = { ok: true, path: process.execPath, args: [FAKE] };
	const converter = convert || createConverter({
		logger,
		locate: () => (converterFound ? located : { ok: false, code: 'convert-missing', reason: 'not-found' }),
		spawn: (...args) => {
			const child = require('node:child_process').spawn(...args);
			spawned.push(child);
			spawnOpts.push(args[2]);
			return child;
		}
	});
	const c = client || fakeCalibre(books);
	const bookDir = dir || tmpDir('dir');
	// One live object, as the bot's config is: a test changes a setting by assigning to h.cfg.
	const config = { audiobookTextEnabled: true, audiobookTextSidecars: true, audiobookTextConvert: true, commandPrefix: '!', ...cfg };
	const source = createBookTextSource({
		dir: bookDir,
		store,
		parse: worker,
		calibre: () => c,
		catalog: () => fakeCatalog(works),
		cfg: config,
		logger,
		convert: converter,
		...(indexPick ? { indexPick } : {})
	});
	return { source, client: c, converter, spawned, spawnOpts, lines, cfg: config, dir: bookDir, cacheDir: pathMod.join(bookDir, 'cache') };
}

async function textOf(handle) {
	const out = [];
	for (let i = 0; i < handle.index.sections.length; i++) out.push((await handle.readSection(i)).trim());
	return out;
}

function cacheFiles(h) {
	return fs.existsSync(h.cacheDir) ? fs.readdirSync(h.cacheDir).sort() : [];
}

// --- reading a converted book ----------------------------------------------------------------------

test('an AZW3-only Calibre match shows as available, converts on first open, and its text is cached', async () => {
	const h = make({ books: { 11: record('azw3', { mode: 'ok', epub: BOOK_A() }) }, indexPick: () => ({ id: 11, format: 'azw3' }) });
	assert.strictEqual(await h.source.probe(work()), 'available');
	assert.strictEqual(h.source.status(work()), 'available', 'so the card shows 📖');
	assert.strictEqual(h.source.pendingConversion(work()), 'azw3');
	assert.strictEqual(h.spawned.length, 0, 'a probe converts nothing');

	const res = await h.source.open(work(), { explicit: true });
	assert.ok(res.ok, res.text);
	assert.strictEqual(res.handle.label, 'Calibre #11 (AZW3, converted to EPUB)');
	assert.match(res.handle.fingerprint, /^calibre:Test_Library:11:azw3:\d+:2026-10-30T05:35:29\.738293\+00:00:cv1$/);
	const text = await textOf(res.handle);
	assert.ok(text.some((t) => t.startsWith('Chapter 1')) && text.some((t) => t.includes(words(40, 5))), 'the converted EPUB was parsed by the real reader');
	assert.strictEqual(h.source.status(work()), 'ready');
	assert.strictEqual(h.source.pendingConversion(work()), null);
	assert.strictEqual(h.spawned.length, 1);
	assert.strictEqual(h.spawnOpts[0].env.CALIBRE_TEMP_DIR, pathMod.join(h.cacheDir, `${res.handle.base}.convert`, 'tmp'), 'Calibre\'s own temp files go with the work folder');
	assert.deepStrictEqual(h.client.downloads.map((d) => [d.id, d.format]), [[11, 'azw3']]);
	assert.deepStrictEqual(cacheFiles(h), [`${res.handle.base}.json`, `${res.handle.base}.txt`], 'the download, the EPUB and their folder are gone');
	assert.ok(h.lines.some((l) => /converted the AZW3 of Calibre #11 \(cache [0-9a-f]{16}\) to EPUB in \d+ ms/.test(l)), h.lines.join('\n'));
	for (const l of h.lines) assert.ok(!/alpha|bravo|charlie/.test(l), l);

	// A restart: a new source on the same cache serves the text without converting again, even
	// with Calibre closed.
	h.client.reachable = false;
	const again = make({ client: h.client, dir: h.dir, converterFound: false });
	const back = await again.source.open(work());
	assert.ok(back.ok, back.text);
	assert.strictEqual(back.handle.base, res.handle.base);
	assert.strictEqual(again.spawned.length, 0);
});

test('concurrent opens and probes of one book, and two editions of it, share one conversion', async () => {
	const narr = work({ id: 'avery-quill/the-lantern-road~harlow', title: 'The Lantern Road' });
	const h = make({ works: [work(), narr], books: { 11: record('mobi', { mode: 'ok', epub: BOOK_A(), delayMs: 300 }) } });
	const results = await Promise.all([
		h.source.open(work(), { explicit: true }),
		h.source.open(work(), { explicit: true }),
		h.source.probe(work()),
		h.source.open(narr, { explicit: true })
	]);
	assert.ok(results[0].ok && results[1].ok && results[3].ok);
	assert.strictEqual(results[0].handle.base, results[3].handle.base);
	assert.strictEqual(h.spawned.length, 1);
	assert.strictEqual(h.client.downloads.length, 1);
});

test('a replaced MOBI converts again, and a tag edit in Calibre does not', async () => {
	const h = make({ books: { 11: record('mobi', { mode: 'ok', epub: BOOK_A() }) } });
	const first = await h.source.open(work(), { explicit: true });
	assert.ok(first.ok, first.text);
	h.client.data[11].last_modified = '2026-10-31T09:00:00+00:00';
	h.client.data[11].tags = ['Science Fiction'];
	const tagged = make({ client: h.client, dir: h.dir });
	assert.strictEqual((await tagged.source.open(work(), { explicit: true, force: true })).handle.base, first.handle.base);
	assert.strictEqual(tagged.spawned.length, 0);

	const replaced = JSON.stringify({ mode: 'ok', epub: BOOK_B() });
	h.client.data[11].files.mobi = replaced;
	h.client.data[11].format_metadata.mobi = { size: Buffer.byteLength(replaced), mtime: '2026-10-31T09:00:00+00:00' };
	const later = make({ client: h.client, dir: h.dir });
	const second = await later.source.open(work(), { explicit: true, force: true });
	assert.ok(second.ok, second.text);
	assert.notStrictEqual(second.handle.base, first.handle.base);
	assert.strictEqual(second.handle.index.sections.filter((s) => /^Chapter/.test(s.label)).length, 3);
	assert.strictEqual(later.spawned.length, 1);
	assert.ok((await textOf(first.handle)).some((t) => t.includes(words(40, 5))), 'a handle opened before keeps its own text');
});

test('an EPUB in the same record wins and nothing is converted; its cache key is the one it always had', async () => {
	const epub = fs.readFileSync(BOOK_A());
	const book = record('mobi', { mode: 'ok', epub: BOOK_B() });
	book.formats = ['MOBI', 'EPUB'];
	book.files.epub = epub;
	book.format_metadata.epub = { size: epub.length, mtime: '2026-01-01T00:00:01+00:00' };
	const h = make({ books: { 11: book } });
	const res = await h.source.open(work(), { explicit: true });
	assert.ok(res.ok, res.text);
	assert.strictEqual(res.handle.fingerprint, `calibre:${LIB}:11:${epub.length}:2026-01-01T00:00:01+00:00`);
	assert.strictEqual(res.handle.label, 'Calibre #11');
	assert.strictEqual(h.spawned.length, 0);
});

// --- when it can't convert -------------------------------------------------------------------------

test('a DRM-locked book fails once with a clear reason and is never converted again', async () => {
	const h = make({ books: { 11: record('azw3', { mode: 'drm' }) } });
	const res = await h.source.open(work(), { explicit: true });
	assert.deepStrictEqual([res.ok, res.code], [false, 'drm']);
	assert.match(res.text, /DRM-protected/);
	assert.strictEqual(h.source.status(work()), 'none');
	assert.ok(cacheFiles(h).every((f) => f.endsWith('.fail.json')), cacheFiles(h).join(','));
	const later = make({ client: h.client, dir: h.dir });
	assert.strictEqual(await later.source.probe(work()), 'none');
	assert.strictEqual((await later.source.open(work(), { explicit: true })).code, 'drm');
	assert.strictEqual(later.spawned.length, 0);
});

test('a damaged file is a stable conversion error, and a timeout is retried later', async () => {
	const bad = make({ books: { 11: record('mobi', { mode: 'corrupt' }) } });
	const r = await bad.source.open(work(), { explicit: true });
	assert.deepStrictEqual([r.code, r.text], ['convert-error', 'Calibre couldn\'t convert this ebook to EPUB: the file looks damaged.']);
	assert.strictEqual((await bad.source.open(work(), { explicit: true })).code, 'convert-error');
	assert.strictEqual(bad.spawned.length, 1);

	const slowConv = createConverter({ timeoutMs: 400, locate: () => ({ ok: true, path: process.execPath, args: [FAKE] }), logger: { warn() {} } });
	const slow = make({ books: { 11: record('mobi', { mode: 'hang' }) }, convert: slowConv });
	const t = await slow.source.open(work(), { explicit: true });
	assert.deepStrictEqual([t.ok, t.code], [false, 'convert-timeout']);
	assert.match(t.text, /took too long/);
	assert.ok(!cacheFiles(slow).some((f) => f.endsWith('.fail.json')), 'no fail record: it may work next time');
	assert.ok(!cacheFiles(slow).some((f) => f.endsWith('.convert')), 'its temp folder is gone');
	assert.strictEqual((await slow.source.open(work())).code, 'convert-timeout', 'a background open waits');
	assert.deepStrictEqual(slow.source.lastFailure(work()), { code: 'convert-timeout', text: t.text }, 'so `!book text` can report it without converting again');
	slow.client.data[11].files.mobi = JSON.stringify({ mode: 'ok', epub: BOOK_A() });
	assert.ok((await slow.source.open(work(), { explicit: true })).ok, 'a person asking again tries again');
});

// The bug: a probe found the record to convert, the first open then failed, and `!book text`
// answered "this ebook is DRM-protected" with "it is converted to EPUB the first time its text
// opens" under it, because the probe's 'available' outlived the failure.
test('after a failed conversion the book is no longer announced as converting on first open', async () => {
	for (const mode of ['drm', 'corrupt']) {
		const h = make({ books: { 11: record('mobi', { mode }) } });
		assert.strictEqual(await h.source.probe(work()), 'available', mode);
		assert.strictEqual(h.source.pendingConversion(work()), 'mobi', mode);
		assert.strictEqual((await h.source.open(work(), { explicit: true })).ok, false, mode);
		assert.strictEqual(h.source.pendingConversion(work()), null, mode);
		assert.strictEqual(h.source.status(work()), 'none', mode);
	}
});

// The bug: with converting off (or ebook-convert missing), a series-matched MOBI record outranked
// a plain EPUB record of the same book, was then found unconvertible, and the search gave up on
// Calibre: no 📖, and "Calibre has this ebook only as MOBI" while an EPUB of it was right there.
// Before conversion existed that EPUB was read.
test('a record that can\'t be converted yet never hides an EPUB record of the same book', async () => {
	const w = work({ series: 'Lantern Cycle', sequence: 1 });
	const books = () => {
		const mobi = record('mobi', { mode: 'ok', epub: BOOK_A() }, { series: 'Lantern Cycle', series_index: 1 });
		const bytes = fs.readFileSync(BOOK_B());
		const epub = record('epub', {}, { uuid: 'uuid-12' });
		epub.files.epub = bytes;
		epub.format_metadata.epub = { size: bytes.length, mtime: '2026-01-01T00:00:01+00:00' };
		return { 11: mobi, 12: epub };
	};
	for (const opts of [{ cfg: { audiobookTextConvert: false } }, { converterFound: false }]) {
		const h = make({ works: [w], books: books(), ...opts });
		assert.strictEqual(await h.source.probe(w), 'available', JSON.stringify(opts));
		const r = await h.source.open(w, { explicit: true });
		assert.ok(r.ok, r.text);
		assert.strictEqual(r.handle.label, 'Calibre #12');
		assert.strictEqual(h.spawned.length, 0);
	}
	const viaIndex = make({ works: [w], books: books(), cfg: { audiobookTextConvert: false }, indexPick: () => ({ id: 11, format: 'mobi' }) });
	const r = await viaIndex.source.open(w, { explicit: true });
	assert.ok(r.ok, r.text);
	assert.strictEqual(r.handle.label, 'Calibre #12', 'a blocked index pick falls through to the EPUB too');
	const only = make({ works: [w], books: { 11: books()[11] }, cfg: { audiobookTextConvert: false } });
	assert.strictEqual((await only.source.open(w, { explicit: true })).code, 'convert-off', 'with no EPUB the answer still says why');
});

test('with ebook-convert missing the 📖 stays hidden and !book text says why; a sidecar EPUB still wins', async () => {
	const h = make({ books: { 11: record('azw3', { mode: 'ok', epub: BOOK_A() }) }, converterFound: false });
	assert.strictEqual(await h.source.probe(work()), 'none');
	assert.strictEqual(h.source.status(work()), 'none');
	const res = await h.source.open(work(), { explicit: true });
	assert.strictEqual(res.code, 'convert-missing');
	assert.match(res.text, /Calibre has this ebook only as AZW3, and Calibre's ebook-convert program, which turns it into EPUB, wasn't found on this PC/);
	assert.strictEqual(h.client.downloads.length, 0);

	const audio = tmpDir('audio');
	fs.copyFileSync(BOOK_B(), pathMod.join(audio, 'The Lantern Road.epub'));
	const w = work({ dirs: [audio] });
	const side = make({ works: [w], books: { 11: record('azw3', { mode: 'ok', epub: BOOK_A() }) }, converterFound: false });
	const got = await side.source.open(w, { explicit: true });
	assert.ok(got.ok, got.text);
	assert.strictEqual(got.handle.via, 'sidecar');
});

test('with converting switched off nothing new is converted, and a text converted earlier still opens', async () => {
	const books = { 11: record('mobi', { mode: 'ok', epub: BOOK_A() }) };
	const off = make({ books, cfg: { audiobookTextConvert: false } });
	assert.strictEqual(await off.source.probe(work()), 'none');
	const r = await off.source.open(work(), { explicit: true });
	assert.strictEqual(r.code, 'convert-off');
	assert.match(r.text, /converting it to EPUB is turned off \(audiobookTextConvert in `!config` → Audiobooks\)/);
	assert.strictEqual(off.spawned.length, 0);

	const on = make({ client: off.client, dir: off.dir });
	assert.ok((await on.source.open(work(), { explicit: true })).ok);
	const offAgain = make({ client: off.client, dir: off.dir, cfg: { audiobookTextConvert: false } });
	const cached = await offAgain.source.open(work(), { explicit: true, force: true });
	assert.ok(cached.ok, cached.text);
	assert.strictEqual(offAgain.spawned.length, 0);
});

test('a probe made while converting was on stops offering 📖 once it is switched off', async () => {
	const h = make({ books: { 11: record('mobi', { mode: 'ok', epub: BOOK_A() }) } });
	assert.strictEqual(await h.source.probe(work()), 'available');
	h.cfg.audiobookTextConvert = false;
	assert.strictEqual(h.source.status(work()), 'none');
	assert.strictEqual(await h.source.probe(work()), 'none');
	assert.strictEqual(h.source.pendingConversion(work()), null);
	h.cfg.audiobookTextConvert = true;
	assert.strictEqual(h.source.status(work()), 'available');
});

test('shutdown kills a running conversion and removes its temp folder', async () => {
	const h = make({ books: { 11: record('mobi', { mode: 'hang' }) } });
	const opening = h.source.open(work(), { explicit: true });
	const end = Date.now() + 8000;
	while (!(h.converter.busy() && h.converter.pid()) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
	const pid = h.converter.pid();
	assert.ok(pid);
	h.source.shutdown();
	const res = await opening;
	assert.strictEqual(res.ok, false);
	const gone = Date.now() + 8000;
	let alive = true;
	while (alive && Date.now() < gone) {
		try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch (_) { alive = false; }
	}
	assert.strictEqual(alive, false, 'ebook-convert is not left running');
	assert.ok(!cacheFiles(h).some((f) => f.endsWith('.convert')), cacheFiles(h).join(','));
});

test('the start-up sweep removes a conversion folder left by a killed bot', async () => {
	const dir = tmpDir('sweep');
	const left = pathMod.join(dir, 'cache', '0123456789abcdef.convert');
	fs.mkdirSync(left, { recursive: true });
	fs.writeFileSync(pathMod.join(left, 'book.mobi'), 'x');
	const h = make({ dir, books: {} });
	await h.source.probe(work());
	assert.ok(!fs.existsSync(left));
});

// --- linking and describing ------------------------------------------------------------------------

test('!book link to a MOBI-only record converts it and says so; one with only a PDF is refused', async () => {
	const h = make({ books: { 11: record('mobi', { mode: 'ok', epub: BOOK_A() }), 12: record('pdf', {}, { title: 'Scanned Copy' }) } });
	const linked = await h.source.link(work(), { type: 'calibre', id: 11 }, { by: '1' });
	assert.deepStrictEqual([linked.ok, linked.text], [true, 'Linked The Lantern Road to Calibre #11 “The Lantern Road” (MOBI, converted to EPUB).']);
	assert.strictEqual(h.source.status(work()), 'ready');
	const pdf = await h.source.link(work(), { type: 'calibre', id: 12 }, { by: '1' });
	assert.deepStrictEqual([pdf.ok, pdf.code, pdf.text], [false, 'no-epub', 'Calibre #12 “Scanned Copy” has no EPUB, and its PDF can\'t be turned into one.']);
});

test('describe names the format of each Calibre candidate and whether the converter is there', async () => {
	const h = make({ books: { 11: record('azw3', { mode: 'ok', epub: BOOK_A() }) }, converterFound: false });
	const d = await h.source.describe(work());
	assert.deepStrictEqual(d.candidates.calibre.map((c) => [c.id, c.format, c.epub, c.accepted]), [[11, 'azw3', false, true]]);
	assert.deepStrictEqual(d.converter, { ok: false, code: 'convert-missing', reason: 'not-found' });
});
