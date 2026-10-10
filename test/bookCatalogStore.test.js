// helpers/bookCatalogStore.js: the in-memory catalog, its file, the overrides file, work lookup
// by id, alias and typed text, and part keys looked up by identity.
//
// The bug: a catalog read at require time hands every test that loads app/bot.js the real
// library; reading the real overrides file under the runner makes a test pass or fail by what is
// on this machine; a replace that mutates the live works list lets a reader see half of two
// catalogs; and a part key looked up by ordinal after a rebuild inserted a part plays the
// neighbouring file, so a listener resumes in the wrong chapter with no error anywhere.
//
// Harness: the store pattern of test/archipelagoHints.test.js (pid-suffixed env file set before
// the first require, afterEach unlink and reset), the directory-at-.tmp write breaker from
// test/writeFailures.test.js, and a child process for the unset-env-var case, because the store
// reads its env var once at require time. The catalog is the synthetic
// test/fixtures/books/catalog.json.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { spawnSync } = require('node:child_process');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-catalog-${process.pid}.json`);
const OVERRIDES_FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-overrides-${process.pid}.json`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;

// Counted from before the require, so a read at require time would show up.
const catalogReads = [];
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
	if (String(p) === FILE) catalogReads.push(new Error().stack);
	return realReadFileSync.call(this, p, ...rest);
};

fs.writeFileSync(FILE, JSON.stringify({ catalog: { meta: { builtAt: 5 }, works: { 'a/b': { id: 'a/b', title: 'B', parts: [] } } } }));
const logger = require('../helpers/logger.js');
const store = require('../helpers/bookCatalogStore.js');
const readsAtRequire = catalogReads.length;
fs.readFileSync = realReadFileSync;

const CATALOG = require('./fixtures/books/catalog.json');

function fixture() {
	return JSON.parse(JSON.stringify(CATALOG));
}

function asideFiles() {
	const dir = pathMod.dirname(FILE);
	const base = pathMod.basename(FILE);
	return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`)).map((f) => pathMod.join(dir, f));
}

test.afterEach(() => {
	for (const p of [FILE, OVERRIDES_FILE, ...asideFiles()]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;
	store.reset();
});

test('nothing is read from disk until the catalog is first asked for', () => {
	assert.strictEqual(readsAtRequire, 0);
	assert.strictEqual(store.work('a/b').title, 'B', 'the file written before the require is what the first read sees');
	assert.strictEqual(store.meta().builtAt, 5);
});

test('an empty store is empty but well formed', () => {
	assert.deepStrictEqual(store.works(), []);
	assert.deepStrictEqual(store.meta(), {});
	assert.strictEqual(store.work('a/b'), null);
	assert.strictEqual(store.index().trackKeys.size, 0);
	assert.deepStrictEqual(store.findWorks('anything'), []);
	assert.deepStrictEqual(store.load().rejected, []);
	assert.deepStrictEqual(store.load().chapterCache, {});
});

test('replace persists the catalog and a fresh read gets it back', () => {
	assert.strictEqual(store.replace(fixture()), true);
	const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	assert.deepStrictEqual(Object.keys(onDisk.catalog.works), Object.keys(CATALOG.works));
	assert.ok(!fs.readFileSync(FILE, 'utf8').includes('\n'), 'written compact');

	store.reset();
	assert.strictEqual(store.works().length, Object.keys(CATALOG.works).length);
	assert.strictEqual(store.meta().rulesVersion, CATALOG.meta.rulesVersion);
	assert.deepStrictEqual([...store.index().albumKeys], CATALOG.index.albumKeys);
});

test('replace leaves what a reader already holds untouched', () => {
	store.replace(fixture());
	const before = store.works();
	const indexBefore = store.index();
	const count = before.length;

	const next = fixture();
	delete next.works['avery-quill/the-glass-road'];
	next.index.trackKeys = ['1'];
	store.replace(next);

	assert.strictEqual(before.length, count, 'the list a reader took is not edited under it');
	assert.strictEqual(indexBefore.trackKeys.size, CATALOG.index.trackKeys.length);
	assert.strictEqual(store.works().length, count - 1);
	assert.strictEqual(store.work('avery-quill/the-glass-road'), null);
	assert.deepStrictEqual([...store.index().trackKeys], ['1']);
});

test('a write failure keeps the new catalog in memory and reports unhealthy', (t) => {
	t.mock.method(logger, 'error', () => {});
	store.load();
	fs.mkdirSync(`${FILE}.tmp`, { recursive: true });
	assert.strictEqual(store.replace(fixture()), false);
	assert.strictEqual(store.healthy(), false);
	assert.ok(store.work('avery-quill/the-glass-road'));
});

test('a damaged catalog file is moved aside under the Audiobook name and the store starts empty', (t) => {
	fs.writeFileSync(FILE, '{"catalog": {');
	const lines = [];
	t.mock.method(logger, 'error', (...args) => { lines.push(args.join(' ')); });
	assert.deepStrictEqual(store.works(), []);
	assert.strictEqual(lines.length, 1);
	assert.match(lines[0], /^Audiobook catalog file unusable \(/);
	assert.strictEqual(asideFiles().length, 1);
});

test('a catalog stored with its works as a list is read by id', () => {
	fs.writeFileSync(FILE, JSON.stringify({ catalog: { works: [{ id: 'x/y', title: 'Y', parts: [] }, 'junk'] } }));
	assert.strictEqual(store.work('x/y').title, 'Y');
	assert.strictEqual(store.works().length, 1);
});

test('the store is memory-only under the runner when its env var is unset', () => {
	const code = `
		const fs = require('fs');
		const touched = [];
		for (const m of ['readFileSync', 'writeFileSync', 'renameSync', 'openSync', 'mkdirSync']) {
			const real = fs[m];
			fs[m] = function (p, ...rest) {
				if (String(p).includes('book_catalog')) touched.push(m);
				return real.call(this, p, ...rest);
			};
		}
		const store = require(${JSON.stringify(pathMod.join(__dirname, '..', 'helpers', 'bookCatalogStore.js'))});
		const ok = store.replace({ works: { 'a/b': { id: 'a/b', title: 'B', parts: [] } } });
		store.reset();
		process.stdout.write(JSON.stringify({ touched, ok, file: store.file, after: store.works().length }));
	`;
	const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8', PLEXBOT_LOG_TO_FILE: '0' };
	delete env.PLEXBOT_BOOK_CATALOG_FILE;
	const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
	assert.strictEqual(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.deepStrictEqual(out.touched, []);
	assert.strictEqual(out.ok, true);
	assert.match(out.file.replace(/\\/g, '/'), /data\/book_catalog\.json$/);
	assert.strictEqual(out.after, 0, 'a reset forgets it, because nothing was ever written');
});

test('readOverrides under the runner without its env var never touches the disk', (t) => {
	const spy = t.mock.method(fs, 'readFileSync');
	const r = store.readOverrides();
	assert.deepStrictEqual(r, { overrides: {}, error: null });
	assert.strictEqual(spy.mock.calls.filter((c) => String(c.arguments[0]).includes('book_overrides')).length, 0);
});

test('readOverrides reads the file its env var names', () => {
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ include: ['1090'] }));
	assert.deepStrictEqual(store.readOverrides(), { overrides: { include: ['1090'] }, error: null });
});

test('a missing overrides file is no overrides and no error', () => {
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	assert.deepStrictEqual(store.readOverrides(), { overrides: {}, error: null });
});

test('a malformed overrides file is logged, reported and ignored', (t) => {
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	const warned = [];
	t.mock.method(logger, 'warn', (...args) => { warned.push(args.join(' ')); });

	fs.writeFileSync(OVERRIDES_FILE, '{"include": [');
	const bad = store.readOverrides();
	assert.deepStrictEqual(bad.overrides, {});
	assert.strictEqual(typeof bad.error, 'string');
	assert.ok(bad.error.length > 0);

	fs.writeFileSync(OVERRIDES_FILE, '[1, 2]');
	assert.deepStrictEqual(store.readOverrides(), { overrides: {}, error: 'the file must hold a JSON object' });

	assert.strictEqual(warned.length, 2);
	for (const line of warned) assert.match(line, /Audiobook overrides file/);
});

test('work resolves an alias, and a live id wins over an alias of the same name', () => {
	const c = fixture();
	c.works['avery-quill/the-salt-crown'].aliases = ['old/salt', 'avery-quill/the-last-lantern'];
	store.replace(c);
	assert.strictEqual(store.work('old/salt').id, 'avery-quill/the-salt-crown');
	assert.strictEqual(store.work('avery-quill/the-last-lantern').id, 'avery-quill/the-last-lantern');
	assert.strictEqual(store.work('nobody/nothing'), null);
	assert.strictEqual(store.work(undefined), null);
});

test('findWorks puts an id, then an exact title, then title words, then other fields first', () => {
	store.replace(fixture());
	const ids = (text) => store.findWorks(text).map((w) => w.id);

	assert.deepStrictEqual(ids('The Far Shore'), ['ilse-moreau/the-far-shore~harlow', 'ilse-moreau/the-far-shore~penrose']);
	assert.deepStrictEqual(ids('ilse-moreau/the-night-gate~penrose')[0], 'ilse-moreau/the-night-gate~penrose');
	assert.deepStrictEqual(ids('the glass'), ['avery-quill/the-glass-road', 'ilse-moreau/the-glass-sea']);
	assert.deepStrictEqual(ids('glass'), ['avery-quill/the-glass-road', 'avery-quill/shadows-of-glass', 'ilse-moreau/the-glass-sea']);
	assert.deepStrictEqual(ids('penrose'), ['ilse-moreau/the-far-shore~penrose', 'ilse-moreau/the-night-gate~penrose']);
	assert.deepStrictEqual(ids('ashfall 7'), ['avery-quill/ashfall-collected-tales'], 'a series number is searchable');
	assert.deepStrictEqual(ids('ashfall coll'), ['avery-quill/ashfall-collected-tales']);
	assert.deepStrictEqual(ids('zzz'), []);
	assert.strictEqual(ids('').length, Object.keys(CATALOG.works).length);
});

const SEA = 'ilse-moreau/the-glass-sea';

function identity(part) {
	return { trackRatingKey: part.trackRatingKey, file: part.file };
}

test('partKeyFor finds a part by identity after a rebuild inserted a part before it', () => {
	const c = fixture();
	const target = c.works[SEA].parts[2];
	const ident = identity(target);
	assert.strictEqual(store.replace(c), true);
	assert.strictEqual(store.partKeyFor(SEA, ident), target.partKey);

	const next = fixture();
	const sea = next.works[SEA];
	const inserted = { ...sea.parts[0], trackRatingKey: '777777', file: 'Glass Sea 00b.mp3', partKey: '/library/parts/999001/1800000000/Glass Sea 00b.mp3' };
	sea.parts = [sea.parts[0], inserted, ...sea.parts.slice(1)]
		.map((p, i) => ({ ...p, ordinal: i + 1, partKey: p === inserted ? p.partKey : p.partKey.replace('/1700000000/', '/1800000000/') }));
	store.replace(next);

	const key = store.partKeyFor(SEA, ident);
	assert.strictEqual(key, target.partKey.replace('/1700000000/', '/1800000000/'));
	assert.notStrictEqual(key, sea.parts[2].partKey, 'not the key of whatever now sits at the old ordinal');
});

test('partKeyFor gives undefined for a part that is gone, never a neighbour', () => {
	const c = fixture();
	const target = c.works[SEA].parts[2];
	const ident = identity(target);
	c.works[SEA].parts = c.works[SEA].parts.filter((p) => p !== target).map((p, i) => ({ ...p, ordinal: i + 1 }));
	store.replace(c);

	assert.strictEqual(store.partKeyFor(SEA, ident), undefined);
	assert.strictEqual(store.partKeyFor(SEA, { ...ident, file: 'Glass Sea 03.mp3' }), undefined, 'a ratingKey with another basename is another file');
	assert.strictEqual(store.partKeyFor(SEA, { trackRatingKey: '1', file: target.file }), undefined);
	assert.strictEqual(store.partKeyFor(SEA, { file: target.file }), undefined);
	assert.strictEqual(store.partKeyFor('nobody/nothing', ident), undefined);
});

test('partKeyFor matches the basename from a full path, and finds a part in a renamed work', () => {
	const c = fixture();
	const target = c.works[SEA].parts[1];
	store.replace(c);
	assert.strictEqual(store.partKeyFor(SEA, { trackRatingKey: target.trackRatingKey, file: `M:\\Music\\Ilse Moreau\\x\\${target.file}` }), target.partKey);

	const moved = fixture();
	moved.works['ilse-moreau/glass-sea-renamed'] = { ...moved.works[SEA], id: 'ilse-moreau/glass-sea-renamed' };
	delete moved.works[SEA];
	store.replace(moved);
	assert.strictEqual(store.partKeyFor(SEA, identity(target)), target.partKey);
});

test('setPartKey changes the key in memory only and adds its part id to the index', (t) => {
	const c = fixture();
	const target = c.works[SEA].parts[0];
	store.replace(c);
	const mtime = fs.statSync(FILE).mtimeMs;
	const renames = t.mock.method(fs, 'renameSync');

	assert.strictEqual(store.setPartKey(SEA, identity(target), '/library/parts/888888/1900000000/Glass Sea 00.mp3'), true);
	assert.strictEqual(store.partKeyFor(SEA, identity(target)), '/library/parts/888888/1900000000/Glass Sea 00.mp3');
	assert.ok(store.index().partIds.has('888888'));
	assert.strictEqual(renames.mock.callCount(), 0);
	assert.strictEqual(fs.statSync(FILE).mtimeMs, mtime);

	assert.strictEqual(store.setPartKey(SEA, { trackRatingKey: '1', file: 'nope.mp3' }, '/library/parts/1/1/x.mp3'), false);
	assert.strictEqual(store.setPartKey(SEA, identity(target), ''), false);

	store.replace(store.load());
	store.reset();
	assert.strictEqual(store.partKeyFor(SEA, identity(target)), '/library/parts/888888/1900000000/Glass Sea 00.mp3', 'the next replace writes it');
});
