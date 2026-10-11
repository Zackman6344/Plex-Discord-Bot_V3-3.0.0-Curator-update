// helpers/bookTextSource.js: which ebook a work reads from, the content-addressed text cache, and
// what is remembered between attempts.
//
// The bug: each of these leaves a listener with no text, the wrong text or a stalled bot. A
// sidecar chosen because its name merely contains the title (a "Pocket Companion" beside the
// real book). A Calibre metadata edit (a tag, a rating) re-downloading and re-parsing a 115 MB
// EPUB. A re-parse rewriting the files under a page that is open. Two narrator editions parsing
// one ebook twice. Calibre closed reported as "no ebook" and remembered, so opening Calibre does
// not help. A known-bad file re-read after every restart. A slow Calibre delaying every page.
// A `!book link` path like \\host\share\x.epub that makes Windows send the bot account's NTLM
// hash to that host before anything checks it.
//
// Harness: the real bookTextStore on pid-suffixed temp files (env set before the first require),
// a temp book_text dir per test, a fake catalog with a settable meta().builtAt, a fake Calibre
// client with the confirmed API shape (format_metadata.epub size and mtime), and a fake parse
// that writes cache files in the plan's section 3.1 format and counts its calls. "EPUB" files are
// JSON lists of synthetic sections ("alpha bravo ..."): the fake parse reads them; the real EPUB
// reader has its own tests (test/epubText.test.js). Clocks are manual.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const ROOT = pathMod.join(os.tmpdir(), `plexbot-test-book-text-source-${process.pid}`);
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${ROOT}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${ROOT}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${ROOT}-works.json`;
delete process.env.PLEXBOT_BOOK_TEXT_DIR;

const store = require('../helpers/bookTextStore.js');
const bookTextSource = require('../helpers/bookTextSource.js');
const { CalibreError } = require('../helpers/calibreClient.js');

const { createBookTextSource, cacheBase, REVALIDATE_MS, TRANSIENT_TTL_MS } = bookTextSource;

const LIB = 'Test_Library';
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const STORE_FILES = [process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE, process.env.PLEXBOT_BOOK_TEXT_READERS_FILE, process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE];

let tmpCount = 0;
const made = [];
function tmpDir(label) {
	const dir = `${ROOT}-${label}-${++tmpCount}`;
	fs.mkdirSync(dir, { recursive: true });
	made.push(dir);
	return dir;
}

test.afterEach(() => {
	for (const f of STORE_FILES) fs.rmSync(f, { force: true });
	store.reset();
});

test.after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const SECTIONS_A = [['Chapter 1', 'alpha bravo charlie delta'], ['Chapter 2', 'echo foxtrot golf hotel india']];
const SECTIONS_B = [['Chapter 1', 'juliet kilo lima mike'], ['Chapter 2', 'november oscar papa quebec']];

function epubContent(sections) {
	return JSON.stringify({ sections });
}

function work(over = {}) {
	return {
		id: 'avery-quill/the-lantern-road', kind: 'book', title: 'The Lantern Road', author: 'Avery Quill',
		series: 'Ashfall', sequence: 1, aliases: [], dirs: [], ...over
	};
}

function cbook(over = {}) {
	const sections = over.sections || SECTIONS_A;
	const content = over.drm ? JSON.stringify({ drm: true }) : epubContent(sections);
	const b = {
		title: 'The Lantern Road', authors: ['Avery Quill'], series: null, series_index: 1,
		identifiers: {}, formats: ['epub'], last_modified: '2026-01-01T00:00:00+00:00',
		format_metadata: { epub: { size: Buffer.byteLength(content), mtime: '2026-01-01T00:00:01.25+00:00', path: 'X:/Calibre Library/Avery Quill/The Lantern Road (11)/x.epub' } },
		...over
	};
	delete b.sections;
	delete b.drm;
	b.content = content;
	return b;
}

function fakeCalibre(books) {
	const c = {
		data: books,
		reachable: true,
		hold: null,
		calls: { search: [], books: 0, book: 0, download: [] },
		check() {
			if (!c.reachable) throw new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).', { cause: 'ECONNREFUSED' });
		},
		meta(id) {
			const b = c.data[id];
			if (!b) return null;
			const copy = JSON.parse(JSON.stringify(b));
			delete copy.content;
			return copy;
		},
		async libraryId() {
			c.check();
			return LIB;
		},
		async search(query) {
			c.check();
			c.calls.search.push(query);
			const ids = [];
			for (const [id, b] of Object.entries(c.data)) {
				const hit = query.split(' or ').some((q) => {
					const author = q.match(/^authors:"(.+)"$/);
					if (author) return b.authors.some((a) => a.toLowerCase().split(' ').includes(author[1].toLowerCase()));
					const title = q.match(/^title:"(.+)"$/);
					if (title) return b.title.toLowerCase().includes(title[1].toLowerCase());
					const isbn = q.match(/^identifiers:isbn:(.+)$/);
					if (isbn) return b.identifiers && b.identifiers.isbn === isbn[1];
					return false;
				});
				if (hit) ids.push(Number(id));
			}
			return ids;
		},
		async books(ids) {
			c.check();
			c.calls.books++;
			return new Map(ids.map((id) => [id, c.meta(id)]));
		},
		async book(id) {
			c.check();
			c.calls.book++;
			if (c.hold) await c.hold;
			c.check();
			return c.meta(id);
		},
		async downloadEpub(id, dest) {
			c.check();
			c.calls.download.push(dest);
			fs.writeFileSync(dest, c.data[id].content);
			return { bytes: Buffer.byteLength(c.data[id].content) };
		}
	};
	return c;
}

function countWords(text) {
	return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu) || []).length;
}

function fakeParse() {
	const p = {
		VERSION: 1,
		calls: [],
		gate: null,
		async parseEpub(job) {
			p.calls.push({ input: job.input.path, base: job.base, fingerprint: job.source.fingerprint, outDir: job.outDir });
			const raw = JSON.parse(fs.readFileSync(job.input.path, 'utf8'));
			if (p.gate) await p.gate;
			const out = (ext) => pathMod.join(job.outDir, `${job.base}.${ext}`);
			if (raw.drm) {
				fs.writeFileSync(out('fail.json'), JSON.stringify({ version: 1, fingerprint: job.source.fingerprint, code: 'drm', at: 0 }));
				return { ok: false, code: 'drm', message: 'drm' };
			}
			let text = '';
			let wordStart = 0;
			const sections = raw.sections.map(([label, body], i) => {
				const byteStart = Buffer.byteLength(text);
				const words = countWords(body);
				const s = { label, href: `s${i}.xhtml`, depth: 1, part: 0, words, wordStart, byteStart, byteLen: Buffer.byteLength(body), paragraphs: 1 };
				wordStart += words;
				text += `${body}\n`;
				return s;
			});
			fs.writeFileSync(out('txt'), text);
			const index = {
				version: 1, builtAt: 1, source: job.source, meta: { title: 'x' },
				textFile: `${job.base}.txt`, textBytes: Buffer.byteLength(text), totalWords: wordStart, sections
			};
			fs.writeFileSync(out('json'), JSON.stringify(index));
			return { ok: true, summary: { sections: sections.length, totalWords: wordStart, textBytes: index.textBytes, title: 'x', tocSource: 'nav', ms: 1, pid: process.pid + 1 } };
		}
	};
	return p;
}

function fakeCatalog(works, builtAt = 1) {
	const c = {
		builtAt,
		works: new Map(works.map((w) => [w.id, w])),
		work(id) {
			return c.works.get(id) || [...c.works.values()].find((w) => (w.aliases || []).includes(id)) || null;
		},
		meta() {
			return { builtAt: c.builtAt };
		}
	};
	return c;
}

function silentLogger() {
	const lines = [];
	const rec = (level) => (...args) => lines.push(`${level} ${args.map(String).join(' ')}`);
	return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
}

function make({ works = [work()], books = {}, calibre = true, cfg = {}, dir, parse, client, catalog, fs: fsDep } = {}) {
	const clock = { t: T0 };
	const c = client || (calibre ? fakeCalibre(books) : null);
	const cat = catalog || fakeCatalog(works);
	const p = parse || fakeParse();
	const logger = silentLogger();
	const bookDir = dir || tmpDir('dir');
	const source = createBookTextSource({
		dir: bookDir,
		store,
		parse: p,
		calibre: () => c,
		catalog: () => cat,
		cfg: { audiobookTextEnabled: true, audiobookTextSidecars: true, commandPrefix: '!', ...cfg },
		now: () => clock.t,
		logger,
		...(fsDep ? { fs: fsDep } : {})
	});
	return { source, client: c, catalog: cat, parse: p, clock, dir: bookDir, cacheDir: pathMod.join(bookDir, 'cache'), logger };
}

// Real time, not a count of ticks: the cache reads go through the libuv thread pool, which a
// parallel test run can keep busy for a while.
async function until(cond, what = 'condition', ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 2));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

function sidecar(dir, name, sections = SECTIONS_A) {
	const file = pathMod.join(dir, name);
	fs.writeFileSync(file, epubContent(sections));
	return file;
}

async function textOf(handle) {
	const out = [];
	for (let i = 0; i < handle.index.sections.length; i++) out.push(await handle.readSection(i));
	return out;
}

// --- basics ------------------------------------------------------------------------------------

test('cacheBase is 16 hex characters and changes with the fingerprint and the extractor version', () => {
	const a = cacheBase('file:D:/x.epub:10:20', 1);
	assert.match(a, /^[0-9a-f]{16}$/);
	assert.notStrictEqual(a, cacheBase('file:D:/x.epub:10:21', 1));
	assert.notStrictEqual(a, cacheBase('file:D:/x.epub:10:20', 2));
	assert.strictEqual(a, cacheBase('file:D:/x.epub:10:20', 1));
});

test('the production wiring parses in the epubTextWorker child, never inline', () => {
	const d = bookTextSource.defaults();
	assert.strictEqual(d.parse, require('../helpers/epubTextWorker.js'));
	assert.notStrictEqual(d.parse, require('../helpers/epubText.js'));
	assert.strictEqual(typeof d.parse.parseEpub, 'function');
	assert.strictEqual(typeof d.calibre, 'function');
	assert.strictEqual(typeof d.catalog().work, 'function');
});

test('under the test runner with no book_text dir the source refuses to read or write', async () => {
	assert.ok(process.env.NODE_TEST_CONTEXT);
	const parse = fakeParse();
	const source = createBookTextSource({
		store, parse, calibre: () => fakeCalibre({ 11: cbook() }), catalog: () => fakeCatalog([work()]),
		cfg: { audiobookTextEnabled: true, commandPrefix: '!' }, logger: silentLogger()
	});
	assert.deepStrictEqual(await source.open(work(), { explicit: true }), { ok: false, code: 'disabled', text: 'Read-along is turned off (`!config` → Audiobooks).' });
	assert.strictEqual(source.status(work()), 'off');
	assert.strictEqual(await source.probe(work()), 'off');
	assert.strictEqual((await source.link(work(), { type: 'calibre', id: 11 })).code, 'disabled');
	assert.strictEqual(parse.calls.length, 0);
	assert.deepStrictEqual(store.links.all(), {});
});

test('a podcast and a switched-off feature give their own reasons', async () => {
	const h = make({ books: { 11: cbook() } });
	assert.strictEqual((await h.source.open(work({ id: 'podcasts/the-quiet-hours', kind: 'podcast' }))).code, 'podcast');
	const off = make({ books: { 11: cbook() }, cfg: { audiobookTextEnabled: false } });
	assert.strictEqual((await off.source.open(work(), { explicit: true })).code, 'disabled');
	assert.strictEqual(off.source.status(work()), 'off');
	assert.strictEqual(h.parse.calls.length + off.parse.calls.length, 0);
});

// --- resolution order ----------------------------------------------------------------------------

test('a manual link wins over Calibre, and Calibre over a sidecar', async () => {
	const audio = tmpDir('audio');
	sidecar(audio, 'The Lantern Road.epub', SECTIONS_B);
	const linked = sidecar(tmpDir('linked'), 'Linked Copy.epub', [['One', 'zulu yankee xray']]);
	const w = work({ dirs: [audio] });
	const h = make({ works: [w], books: { 11: cbook() } });

	const auto = await h.source.open(w, { explicit: true });
	assert.ok(auto.ok);
	assert.strictEqual(auto.handle.label, 'Calibre #11');
	assert.strictEqual(auto.handle.via, 'auto');
	assert.deepStrictEqual(await textOf(auto.handle), ['alpha bravo charlie delta', 'echo foxtrot golf hotel india']);

	const res = await h.source.link(w, { type: 'file', path: linked }, { by: '1' });
	assert.ok(res.ok, res.text);
	assert.strictEqual(res.text, 'Linked The Lantern Road to the EPUB Linked Copy.epub.');
	const viaLink = await h.source.open(w);
	assert.strictEqual(viaLink.handle.label, 'linked EPUB');
	assert.deepStrictEqual(await textOf(viaLink.handle), ['zulu yankee xray']);

	const noCalibre = make({ works: [w], calibre: false });
	store.links.clear(w);
	store.works.clear(w);
	const side = await noCalibre.source.open(w, { explicit: true });
	assert.strictEqual(side.handle.label, 'EPUB next to the audio');
	assert.strictEqual(side.handle.via, 'sidecar');
	assert.deepStrictEqual(await textOf(side.handle), ['juliet kilo lima mike', 'november oscar papa quebec']);
});

test('a link set to off switches the work off everywhere', async () => {
	const h = make({ books: { 11: cbook() } });
	assert.ok((await h.source.open(work(), { explicit: true })).ok);
	const res = await h.source.link(work(), { type: 'off' }, { by: '1' });
	assert.deepStrictEqual(res, { ok: true, code: 'off', text: 'Read-along is now off for The Lantern Road.' });
	assert.strictEqual((await h.source.open(work(), { explicit: true })).code, 'off');
	assert.strictEqual(h.source.status(work()), 'off');
	assert.strictEqual(await h.source.probe(work()), 'off');
	const back = await h.source.link(work(), { type: 'auto' }, { by: '1' });
	assert.ok(back.ok);
	assert.strictEqual(back.text, 'Cleared the ebook link for The Lantern Road; it now uses Calibre #11.');
	assert.strictEqual(h.source.status(work()), 'ready');
	assert.strictEqual(h.parse.calls.length, 1, 'the files were kept, so nothing is parsed again');
});

// --- Calibre matching ------------------------------------------------------------------------------

test('an ISBN-10 finds a book stored under its ISBN-13, and the reverse', async () => {
	const h = make({ works: [work({ title: 'The Final Ember' })], books: { 299: cbook({ title: 'Ashfall', identifiers: { isbn: '9780765350381' } }) } });
	const w = work({ title: 'The Final Ember' });
	const res = await h.source.link(w, { type: 'isbn', isbn: '0-7653-5038-6' }, { by: '1' });
	assert.ok(res.ok, res.text);
	assert.strictEqual(res.text, 'Linked The Final Ember to Calibre #299 “Ashfall” (EPUB).');
	assert.deepStrictEqual(h.client.calls.search.pop(), 'identifiers:isbn:9780765350381 or identifiers:isbn:0765350386');
	const link = store.links.get(w);
	assert.deepStrictEqual([link.type, link.id, link.isbn, link.by], ['calibre', 299, '9780765350381', '1']);

	const r = make({ works: [w], books: { 300: cbook({ title: 'Ashfall', identifiers: { isbn: '0765350386' } }) } });
	const res2 = await r.source.link(w, { type: 'isbn', isbn: '978-0-7653-5038-1' }, { by: '1' });
	assert.ok(res2.ok, res2.text);
	assert.strictEqual(store.links.get(w).id, 300);
	assert.strictEqual(bookTextSource.isbnForms('080442957X')[0], '9780804429573');
	assert.deepStrictEqual(bookTextSource.isbnForms('12345'), []);
});

test('Calibre auto-matches by title, and by series number plus author when the title differs', async () => {
	const books = {
		11: cbook(),
		12: cbook({ title: 'Saltborn', series: 'The Ashfall Saga', series_index: 2 }),
		13: cbook({ title: 'Saltborn Companion', series: 'The Ashfall Saga', series_index: 2.5 })
	};
	const salt = work({ id: 'avery-quill/the-salt-crown', title: 'The Salt Crown', sequence: 2 });
	const h = make({ works: [work(), salt], books });
	assert.strictEqual((await h.source.open(work(), { explicit: true })).handle.source.id, 11);
	assert.strictEqual((await h.source.open(salt, { explicit: true })).handle.source.id, 12);
	assert.deepStrictEqual(h.client.calls.search, ['authors:"Quill"', 'authors:"Quill"']);
});

test('two Calibre books that fit equally well are ambiguous and nothing is linked', async () => {
	const h = make({ books: { 11: cbook(), 14: cbook() } });
	const res = await h.source.open(work(), { explicit: true });
	assert.strictEqual(res.code, 'ambiguous');
	assert.strictEqual(res.text, 'More than one ebook could be this book, so none was picked. The owner can choose one with `!book link`.');
	assert.deepStrictEqual(store.links.all(), {});
	assert.strictEqual(h.parse.calls.length, 0);
	const d = await h.source.describe(work());
	assert.deepStrictEqual(d.candidates.calibre.map((c) => [c.id, c.accepted]), [[11, true], [14, true]]);
});

test('a Calibre book without an EPUB is no match', async () => {
	const h = make({ books: { 11: cbook({ formats: ['pdf'] }) } });
	assert.strictEqual((await h.source.open(work(), { explicit: true })).code, 'no-ebook');
});

// --- sidecars --------------------------------------------------------------------------------------

test('a sidecar is chosen by its title words, not because its name contains the title', async () => {
	const one = tmpDir('part1');
	const two = tmpDir('part2');
	sidecar(one, 'The Ashfall Saga [02] The Salt Crown.epub', SECTIONS_B);
	sidecar(one, 'The Ashfall Saga [A Companion To The Lantern Road & The Salt Crown].epub', SECTIONS_A);
	sidecar(two, 'The Ashfall Saga [02] The Salt Crown.epub', SECTIONS_B);
	const salt = work({ id: 'avery-quill/the-salt-crown', title: 'The Salt Crown', series: 'The Ashfall Saga', sequence: 2, dirs: [one, two] });
	const h = make({ works: [salt], calibre: false });
	const res = await h.source.open(salt, { explicit: true });
	assert.ok(res.ok, res.text);
	assert.strictEqual(pathMod.basename(res.handle.source.path), 'The Ashfall Saga [02] The Salt Crown.epub');
	assert.strictEqual(pathMod.dirname(res.handle.source.path), one);
	const d = await h.source.describe(salt);
	assert.deepStrictEqual(d.candidates.sidecars.map((f) => [f.file, f.accepted]), [
		['The Ashfall Saga [02] The Salt Crown.epub', true],
		['The Ashfall Saga [A Companion To The Lantern Road & The Salt Crown].epub', false]
	], 'the identical copy in the second part folder is listed once');
	assert.ok(bookTextSource.sidecarScore('The Ashfall Saga [A Companion To The Lantern Road & The Salt Crown].epub', salt) < 0.6);
});

test('two different sidecars that fit equally well are ambiguous', async () => {
	const dir = tmpDir('twins');
	sidecar(dir, 'The Lantern Road.epub', SECTIONS_A);
	sidecar(dir, 'Lantern Road, The.epub', SECTIONS_B);
	const w = work({ dirs: [dir] });
	const h = make({ works: [w], calibre: false });
	assert.strictEqual((await h.source.open(w, { explicit: true })).code, 'ambiguous');
});

test('every entry point re-reads the work from the catalog, so a stale work object still finds the sidecar', async () => {
	const dir = tmpDir('fresh');
	sidecar(dir, 'The Lantern Road.epub');
	const stale = work();
	delete stale.dirs;
	const h = make({ works: [work({ dirs: [dir] })], calibre: false });
	assert.strictEqual(await h.source.probe(stale), 'available');
	const res = await h.source.open(stale, { explicit: true });
	assert.ok(res.ok, res.text);
	assert.strictEqual(res.handle.via, 'sidecar');
});

test('sidecars are not searched when the setting is off', async () => {
	const dir = tmpDir('off');
	sidecar(dir, 'The Lantern Road.epub');
	const w = work({ dirs: [dir] });
	const h = make({ works: [w], calibre: false, cfg: { audiobookTextSidecars: false } });
	assert.strictEqual((await h.source.open(w, { explicit: true })).code, 'no-ebook');
});

// --- the cache -------------------------------------------------------------------------------------

test('a Calibre download goes to a temp file in the cache, is parsed from there and removed', async () => {
	const h = make({ books: { 11: cbook() } });
	const res = await h.source.open(work(), { explicit: true });
	assert.ok(res.ok, res.text);
	assert.strictEqual(h.client.calls.download.length, 1);
	const dest = h.client.calls.download[0];
	assert.strictEqual(dest, pathMod.join(h.cacheDir, `${res.handle.base}.download.tmp`));
	assert.deepStrictEqual(h.parse.calls.map((c) => c.input), [dest]);
	assert.ok(!fs.existsSync(dest));
	assert.deepStrictEqual(fs.readdirSync(h.cacheDir).sort(), [`${res.handle.base}.json`, `${res.handle.base}.txt`]);
	assert.strictEqual(res.handle.fingerprint, `calibre:${LIB}:11:${h.client.data[11].format_metadata.epub.size}:2026-01-01T00:00:01.25+00:00`);
	assert.strictEqual(res.handle.base, cacheBase(res.handle.fingerprint, 1));
	assert.strictEqual(res.handle.tag, res.handle.base.slice(0, 4));
	const ptr = store.works.get(work());
	assert.deepStrictEqual([ptr.base, ptr.via, ptr.fingerprint], [res.handle.base, 'auto', res.handle.fingerprint]);
	for (const line of h.logger.lines) assert.ok(!/alpha|bravo|echo|foxtrot/.test(line), line);
});

test('a changed EPUB parses into new files while a handle opened before keeps reading its own text', async () => {
	const h = make({ books: { 11: cbook() } });
	const first = await h.source.open(work(), { explicit: true });
	assert.ok(first.ok);
	const changes = [];
	h.source.onChange((id) => changes.push(id));

	h.client.data[11] = cbook({ sections: SECTIONS_B, format_metadata: { epub: { size: 999, mtime: '2026-02-02T00:00:00+00:00' } } });
	let release;
	h.client.hold = new Promise((r) => { release = r; });
	h.clock.t += REVALIDATE_MS;

	const during = await h.source.open(work(), { explicit: true });
	assert.strictEqual(during.handle, first.handle, 'a cached handle comes back at once while Calibre is slow');
	assert.strictEqual(h.parse.calls.length, 1);
	release();
	h.client.hold = null;
	await until(() => changes.length > 0, 'the background swap');
	assert.deepStrictEqual(changes, ['avery-quill/the-lantern-road']);

	const second = await h.source.open(work());
	assert.notStrictEqual(second.handle.base, first.handle.base);
	assert.notStrictEqual(second.handle.tag, first.handle.tag);
	assert.strictEqual(h.parse.calls.length, 2);
	assert.deepStrictEqual(await textOf(first.handle), ['alpha bravo charlie delta', 'echo foxtrot golf hotel india']);
	assert.deepStrictEqual(await textOf(second.handle), ['juliet kilo lima mike', 'november oscar papa quebec']);
	assert.strictEqual(store.works.get(work()).base, second.handle.base);
});

test('a metadata-only Calibre edit does not download or parse again', async () => {
	const h = make({ books: { 11: cbook() } });
	const first = await h.source.open(work(), { explicit: true });
	const changes = [];
	h.source.onChange((id) => changes.push(id));
	h.client.data[11].last_modified = '2026-03-03T00:00:00+00:00';
	h.client.data[11].identifiers = { isbn: '9780000000002' };
	h.clock.t += REVALIDATE_MS;
	const calls = h.client.calls.book;
	assert.strictEqual((await h.source.open(work())).handle, first.handle);
	await until(() => h.client.calls.book > calls, 'the background check');
	await settle();
	assert.strictEqual(h.parse.calls.length, 1);
	assert.strictEqual(h.client.calls.download.length, 1);
	assert.deepStrictEqual(changes, []);
	assert.strictEqual((await h.source.open(work())).handle, first.handle);
});

test('two narrator editions linked to one Calibre book download and parse it once and share its files', async () => {
	const penrose = work({ id: 'avery-quill/the-lantern-road~penrose' });
	const harlow = work({ id: 'avery-quill/the-lantern-road~harlow' });
	const h = make({ works: [penrose, harlow], books: { 11: cbook() } });
	let release;
	h.parse.gate = new Promise((r) => { release = r; });
	const both = Promise.all([h.source.open(penrose, { explicit: true }), h.source.open(harlow, { explicit: true })]);
	await until(() => h.parse.calls.length === 1, 'the first parse');
	release();
	const [a, b] = await both;
	assert.ok(a.ok && b.ok);
	assert.strictEqual(a.handle.base, b.handle.base);
	assert.strictEqual(h.parse.calls.length, 1);
	assert.strictEqual(h.client.calls.download.length, 1);
	const third = make({ works: [penrose, harlow], client: h.client, dir: h.dir });
	assert.ok((await third.source.open(work({ id: 'avery-quill/the-lantern-road~harlow' }), { explicit: true })).ok);
	assert.strictEqual(third.parse.calls.length, 0);
});

test('concurrent opens and probes of one work share one attempt', async () => {
	const h = make({ books: { 11: cbook() } });
	let release;
	h.parse.gate = new Promise((r) => { release = r; });
	const opens = [h.source.open(work(), { explicit: true }), h.source.open(work()), h.source.open(work(), { explicit: true })];
	await until(() => h.parse.calls.length === 1, 'the parse');
	release();
	const results = await Promise.all(opens);
	assert.ok(results.every((r) => r.ok && r.handle === results[0].handle));
	assert.strictEqual(h.parse.calls.length, 1);

	const other = work({ id: 'avery-quill/the-lantern-road~harlow' });
	const p = make({ works: [other], books: { 11: cbook() } });
	const probes = await Promise.all([p.source.probe(other), p.source.probe(other), p.source.probe(other)]);
	assert.deepStrictEqual(probes, ['available', 'available', 'available']);
	assert.strictEqual(p.client.calls.search.length, 1);
});

test('with Calibre closed a text read earlier is served from the cache, marked stale', async () => {
	const h = make({ books: { 11: cbook() } });
	const first = await h.source.open(work(), { explicit: true });
	assert.ok(first.ok);

	const closed = make({ client: h.client, dir: h.dir });
	h.client.reachable = false;
	const res = await closed.source.open(work(), { explicit: true });
	assert.ok(res.ok, res.text);
	assert.deepStrictEqual(await textOf(res.handle), ['alpha bravo charlie delta', 'echo foxtrot golf hotel india']);
	assert.strictEqual(closed.parse.calls.length, 0);
	await until(async () => (await closed.source.open(work())).stale === true, 'the background check to find Calibre closed');

	const forced = make({ client: h.client, dir: h.dir });
	const viaResolve = await forced.source.open(work(), { force: true, explicit: true });
	assert.ok(viaResolve.ok);
	assert.strictEqual(viaResolve.stale, true);
	assert.strictEqual(await make({ client: h.client, dir: h.dir }).source.probe(work()), 'ready');
});

test('with Calibre closed and nothing cached the answer is "not answering", never "no ebook"', async () => {
	const h = make({ books: { 11: cbook() } });
	h.client.reachable = false;
	const res = await h.source.open(work(), { explicit: true });
	assert.strictEqual(res.code, 'calibre-unreachable');
	assert.strictEqual(res.text, 'Calibre isn\'t answering. Open the Calibre app once (its content server only runs while the app is open); after that the text is kept.');
	assert.strictEqual(h.source.status(work()), 'unknown');
	assert.strictEqual(await h.source.probe(work()), 'unknown');
});

test('a fail record stops a known-bad file being parsed again until the owner links it', async () => {
	const h = make({ books: { 11: cbook({ drm: true }) } });
	const res = await h.source.open(work(), { explicit: true });
	assert.deepStrictEqual([res.code, res.text], ['drm', 'This ebook is DRM-protected, so its text can\'t be read.']);
	assert.strictEqual(h.parse.calls.length, 1);

	const restarted = make({ client: h.client, dir: h.dir });
	assert.strictEqual((await restarted.source.open(work(), { explicit: true })).code, 'drm');
	assert.strictEqual(await restarted.source.probe(work()), 'none');
	assert.strictEqual(restarted.parse.calls.length, 0, 'the fail record answered');

	h.client.data[11] = cbook();
	h.client.data[11].format_metadata.epub = { ...h.client.data[11].format_metadata.epub, size: JSON.stringify({ drm: true }).length };
	const linked = await restarted.source.link(work(), { type: 'calibre', id: 11 }, { by: '1' });
	assert.ok(linked.ok, linked.text);
	assert.strictEqual(linked.text, 'Linked The Lantern Road to Calibre #11 “The Lantern Road” (EPUB).');
	assert.strictEqual(restarted.parse.calls.length, 1, 'link cleared the fail record and parsed again');
	assert.strictEqual(restarted.source.status(work()), 'ready');
});

// --- what is remembered ------------------------------------------------------------------------

test('a stable "no ebook" is remembered for background callers until the catalog is rebuilt', async () => {
	const h = make({ books: {} });
	assert.strictEqual((await h.source.open(work())).code, 'no-ebook');
	assert.strictEqual(h.source.status(work()), 'none');
	h.client.data[11] = cbook();
	const searches = h.client.calls.search.length;
	assert.strictEqual((await h.source.open(work())).code, 'no-ebook');
	assert.strictEqual(await h.source.probe(work()), 'none');
	assert.strictEqual(h.client.calls.search.length, searches, 'answered from memory');
	h.clock.t += 24 * 60 * 60 * 1000;
	assert.strictEqual((await h.source.open(work())).code, 'no-ebook', 'time alone does not expire it');
	h.catalog.builtAt = 2;
	assert.strictEqual(await h.source.probe(work()), 'available');
	assert.ok((await h.source.open(work())).ok);
});

test('a person asking again bypasses the memo at once', async () => {
	const h = make({ books: {} });
	assert.strictEqual((await h.source.open(work())).code, 'no-ebook');
	h.client.data[11] = cbook();
	assert.ok((await h.source.open(work(), { explicit: true })).ok);
});

test('a link drops the remembered answer', async () => {
	const h = make({ books: { 12: cbook({ title: 'Something Else Entirely' }) } });
	assert.strictEqual((await h.source.open(work())).code, 'no-ebook');
	const res = await h.source.link(work(), { type: 'calibre', id: 12 }, { by: '1' });
	assert.ok(res.ok, res.text);
	assert.strictEqual(h.source.status(work()), 'ready');
});

test('a transient failure is remembered for 30 seconds for background callers only', async () => {
	const h = make({ books: { 11: cbook() } });
	h.client.reachable = false;
	assert.strictEqual((await h.source.open(work())).code, 'calibre-unreachable');
	h.client.reachable = true;
	assert.strictEqual((await h.source.open(work())).code, 'calibre-unreachable');
	assert.strictEqual(await h.source.probe(work()), 'unknown');
	h.clock.t += TRANSIENT_TTL_MS;
	assert.strictEqual(await h.source.probe(work()), 'available');

	const e = make({ books: { 11: cbook() } });
	e.client.reachable = false;
	assert.strictEqual((await e.source.open(work())).code, 'calibre-unreachable');
	e.client.reachable = true;
	assert.ok((await e.source.open(work(), { explicit: true })).ok, 'opening Calibre and trying again works at once');
});

// The parse child answers 'io-error' for a file that was locked, missing or on a full disk at
// parse time, and writes no fail record because that can pass.
test('a file system error while parsing is retried after 30 seconds, not remembered as unreadable', async () => {
	const parse = fakeParse();
	const real = parse.parseEpub;
	let failNext = true;
	parse.parseEpub = async (job) => {
		if (!failNext) return real(job);
		failNext = false;
		parse.calls.push({ input: job.input.path, base: job.base });
		return { ok: false, code: 'io-error', message: 'Error EBUSY' };
	};
	const h = make({ books: { 11: cbook() }, parse });
	const first = await h.source.open(work());
	assert.strictEqual(first.code, 'crash');
	assert.strictEqual(first.text, 'Reading this ebook failed unexpectedly. Try again in a minute.');
	assert.strictEqual(fs.existsSync(h.cacheDir) && fs.readdirSync(h.cacheDir).some((f) => f.endsWith('.fail.json')), false);
	h.clock.t += TRANSIENT_TTL_MS;
	assert.ok((await h.source.open(work())).ok);
	assert.strictEqual(parse.calls.length, 2);
});

// --- probe -----------------------------------------------------------------------------------------

test('probe finds a source without downloading or parsing it', async () => {
	const dir = tmpDir('probe');
	sidecar(dir, 'The Salt Crown.epub');
	const salt = work({ id: 'avery-quill/the-salt-crown', title: 'The Salt Crown', dirs: [dir] });
	const h = make({ works: [work(), salt, work({ id: 'x/none', title: 'Nothing Here' })], books: { 11: cbook() } });
	const changes = [];
	h.source.onChange((id) => changes.push(id));
	assert.strictEqual(h.source.status(work()), 'unknown');
	assert.strictEqual(await h.source.probe(work()), 'available');
	assert.strictEqual(await h.source.probe(salt), 'available');
	assert.strictEqual(await h.source.probe(work({ id: 'x/none', title: 'Nothing Here' })), 'none');
	assert.strictEqual(h.parse.calls.length, 0);
	assert.strictEqual(h.client.calls.download.length, 0);
	assert.ok(!fs.existsSync(h.cacheDir) || fs.readdirSync(h.cacheDir).length === 0);
	assert.deepStrictEqual(changes, ['avery-quill/the-lantern-road', 'avery-quill/the-salt-crown', 'x/none']);
	assert.strictEqual(h.source.status(work()), 'available');
	await h.source.open(work(), { explicit: true });
	assert.strictEqual(await h.source.probe(work()), 'ready');
	assert.strictEqual(changes.length, 4, 'available -> ready is a change');
	const calls = h.client.calls.search.length;
	assert.strictEqual(await h.source.probe(salt), 'available');
	assert.strictEqual(h.client.calls.search.length, calls, 'once per catalog build');
});

// --- the sweep and aliases ---------------------------------------------------------------------

test('the start-up sweep removes unreferenced cache files and keeps referenced ones', async () => {
	const h = make({ books: { 11: cbook() } });
	const kept = await h.source.open(work(), { explicit: true });
	const cache = h.cacheDir;
	const old = 'aaaaaaaaaaaaaaaa';
	const recentFail = 'bbbbbbbbbbbbbbbb';
	const oldFail = 'cccccccccccccccc';
	for (const name of [`${old}.txt`, `${old}.json`, `${old}.download.tmp`, `${old}.json.tmp`, `${recentFail}.fail.json`, `${oldFail}.fail.json`, 'notes.txt']) {
		fs.writeFileSync(pathMod.join(cache, name), '{}');
	}
	const longAgo = new Date(T0 - 31 * 24 * 60 * 60 * 1000);
	fs.utimesSync(pathMod.join(cache, `${oldFail}.fail.json`), longAgo, longAgo);
	fs.utimesSync(pathMod.join(cache, `${recentFail}.fail.json`), new Date(T0), new Date(T0));

	const restarted = make({ client: h.client, dir: h.dir });
	assert.strictEqual(await restarted.source.probe(work()), 'ready');
	assert.deepStrictEqual(fs.readdirSync(cache).sort(), [
		`${kept.handle.base}.json`, `${kept.handle.base}.txt`, `${recentFail}.fail.json`, 'notes.txt'
	].sort());
});

// The bug: !restart builds a new source in the same process, and its first open swept away the
// download the old source was still writing, so that book's first read failed.
test('a source started again by !restart never sweeps a download the old one is still writing', async () => {
	const h = make({ books: { 11: cbook() } });
	let release;
	const gate = new Promise((r) => { release = r; });
	let begun;
	const downloading = new Promise((r) => { begun = r; });
	const download = h.client.downloadEpub;
	h.client.downloadEpub = async (id, dest) => {
		const res = await download(id, dest);
		begun(dest);
		await gate;
		return res;
	};
	const first = h.source.open(work(), { explicit: true });
	const dest = await downloading;
	h.source.shutdown();
	const restarted = make({ client: h.client, dir: h.dir });
	await restarted.source.probe(work({ id: 'warm/up' }));
	assert.ok(fs.existsSync(dest), 'the sweep left the download in flight alone');
	const second = restarted.source.open(work(), { explicit: true });
	release();
	const [, res] = await Promise.all([first, second]);
	assert.ok(res.ok, res.text);
	assert.strictEqual(h.client.calls.download.length, 1, 'the new source waited for the old one\'s download');
});

test('a Calibre that asks for Basic over plain http says why the login was not sent', async () => {
	const h = make({ books: { 11: cbook() } });
	h.client.search = async () => {
		throw new CalibreError('auth', 'Calibre at 127.0.0.1:8080 asked for a plain-text login over http, which is refused.', { reason: 'basic-over-http' });
	};
	const res = await h.source.open(work(), { explicit: true });
	assert.strictEqual(res.code, 'calibre-auth');
	assert.match(res.text, /plain-text \(Basic\) login over http, so the password was not sent/);
	assert.ok(!/set calibreUsername/.test(res.text));
});

test('a pointer saved under a renamed work\'s old id is found through its alias and copied', async () => {
	const h = make({ books: { 11: cbook() } });
	const first = await h.source.open(work(), { explicit: true });
	const renamed = work({ id: 'avery-quill/the-lantern-road-2', aliases: ['avery-quill/the-lantern-road'] });
	const after = make({ works: [renamed], client: h.client, dir: h.dir });
	const res = await after.source.open(renamed, { explicit: true });
	assert.ok(res.ok);
	assert.strictEqual(res.handle.base, first.handle.base);
	assert.strictEqual(after.parse.calls.length, 0);
	assert.strictEqual(store.works.all()['avery-quill/the-lantern-road-2'].base, first.handle.base);
});

// --- !book link ----------------------------------------------------------------------------------

function spyFs() {
	const real = require('node:fs');
	const calls = [];
	const promises = new Proxy(real.promises, {
		get(target, name) {
			const fn = target[name];
			if (typeof fn !== 'function') return fn;
			return (...args) => {
				calls.push({ name, arg: String(args[0]) });
				return fn.apply(target, args);
			};
		}
	});
	return { calls, fs: Object.assign({}, real, { promises }) };
}

test('a link to a UNC, device, // or relative path is refused before anything touches the file system', async () => {
	const spy = spyFs();
	const h = make({ books: {}, fs: spy.fs });
	const sweepDone = h.source.probe(work({ id: 'warm/up' }));
	await sweepDone;
	spy.calls.length = 0;
	for (const p of ['\\\\host\\share\\x.epub', '//host/share/x.epub', '\\\\?\\UNC\\host\\share\\x.epub', '\\\\?\\C:\\x.epub', '\\\\.\\C:\\x.epub', 'books\\x.epub']) {
		const res = await h.source.link(work(), { type: 'file', path: p }, { by: '1' });
		assert.strictEqual(res.ok, false, p);
		assert.strictEqual(res.code, 'bad-path', p);
	}
	assert.deepStrictEqual(spy.calls.filter((c) => c.name === 'stat' || c.name === 'readdir' || c.name === 'open' || c.name === 'readFile'), []);
	assert.deepStrictEqual(store.links.all(), {});
	assert.strictEqual(bookTextSource.localPathProblem('\\\\host\\share\\x.epub'), 'unc');
	assert.strictEqual(bookTextSource.localPathProblem('//host/share/x.epub', 'linux'), 'unc');
	assert.strictEqual(bookTextSource.localPathProblem('/home/me/x.epub', 'linux'), null);
	assert.strictEqual(bookTextSource.localPathProblem('C:/Books/x.epub', 'win32'), null);
});

test('a linked path must be an existing .epub file', async () => {
	const h = make({ books: {} });
	const dir = tmpDir('link');
	fs.writeFileSync(pathMod.join(dir, 'notes.txt'), 'x');
	const missing = await h.source.link(work(), { type: 'file', path: pathMod.join(dir, 'Gone.epub') }, { by: '1' });
	assert.deepStrictEqual([missing.code, missing.text], ['not-found', 'There is no file Gone.epub at that path.']);
	assert.strictEqual((await h.source.link(work(), { type: 'file', path: pathMod.join(dir, 'notes.txt') }, { by: '1' })).code, 'bad-path');
	assert.deepStrictEqual(store.links.all(), {});
});

test('linking a Calibre id checks the book first and echoes its title', async () => {
	const h = make({ books: { 11: cbook(), 2: cbook({ title: 'A Comic', formats: ['cbz'] }) } });
	assert.deepStrictEqual(await h.source.link(work(), { type: 'calibre', id: 404 }, { by: '1' }), { ok: false, code: 'not-found', text: 'Calibre has no book #404.' });
	assert.deepStrictEqual(await h.source.link(work(), { type: 'calibre', id: 2 }, { by: '1' }), { ok: false, code: 'no-epub', text: 'Calibre #2 “A Comic” has no EPUB.' });
	h.client.reachable = false;
	const closed = await h.source.link(work(), { type: 'calibre', id: 11 }, { by: '1' });
	assert.deepStrictEqual([closed.ok, closed.code], [false, 'calibre-unreachable']);
	assert.strictEqual(closed.text, 'Calibre isn\'t answering; open the Calibre app (its content server only runs while the app is open) and try again.');
	assert.deepStrictEqual(store.links.all(), {});
});

test('describe names files by basename unless paths are asked for, and never shows Calibre\'s own path', async () => {
	const dir = tmpDir('describe');
	const file = sidecar(dir, 'The Lantern Road.epub');
	const w = work({ dirs: [dir] });
	const h = make({ works: [w], books: { 11: cbook() } });
	await h.source.link(w, { type: 'file', path: file }, { by: '1' });
	const pub = await h.source.describe(w);
	const flat = JSON.stringify(pub);
	assert.ok(!flat.includes(dir.replace(/\\/g, '\\\\')) && !flat.includes(dir), flat);
	assert.ok(!flat.includes('Calibre Library'), flat);
	assert.strictEqual(pub.link.path, 'The Lantern Road.epub');
	assert.strictEqual(pub.cache.source.path, 'The Lantern Road.epub');
	assert.strictEqual(pub.cache.label, 'linked EPUB');
	assert.strictEqual(pub.cache.totalWords, 9);
	assert.deepStrictEqual(pub.candidates.calibre.map((c) => [c.id, c.title]), [[11, 'The Lantern Road']]);
	const full = await h.source.describe(w, { paths: true });
	assert.strictEqual(full.link.path, pathMod.normalize(file));
	assert.strictEqual(full.candidates.sidecars[0].file, file);
});

test('a calibreUrl with a login in it is refused without a request and without echoing it', async () => {
	const h = make({ books: {} });
	const source = createBookTextSource({
		dir: h.dir, store, parse: h.parse, catalog: () => h.catalog, logger: h.logger,
		cfg: { audiobookTextEnabled: true, audiobookTextSidecars: true, commandPrefix: '?', calibreUrl: 'http://reader:pw-in-url-123@127.0.0.1:1' }
	});
	const res = await source.open(work(), { explicit: true });
	assert.strictEqual(res.code, 'bad-url');
	assert.strictEqual(res.text, 'The Calibre URL must not contain a login; put it in calibreUsername and calibrePassword (`?config` → Integrations).');
	assert.ok(!JSON.stringify(res).includes('pw-in-url-123'));
	for (const line of h.logger.lines) assert.ok(!line.includes('pw-in-url-123'), line);
});

test('nothing is written outside the book_text dir, and nothing near Calibre\'s library', async () => {
	const spy = spyFs();
	const h = make({ books: { 11: cbook() }, fs: spy.fs });
	assert.ok((await h.source.open(work(), { explicit: true })).ok);
	const writes = spy.calls.filter((c) => /write|rename|rm|unlink|mkdir|copy|appendFile/i.test(c.name));
	assert.ok(writes.length > 0, 'the spy saw the cache writes (positive control)');
	for (const c of writes) assert.ok(c.arg.startsWith(h.dir), `${c.name} ${c.arg}`);
	assert.ok(!spy.calls.some((c) => c.arg.includes('Calibre Library')));
});
