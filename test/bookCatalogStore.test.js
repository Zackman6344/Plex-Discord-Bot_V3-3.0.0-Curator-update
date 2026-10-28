// helpers/bookCatalogStore.js: the in-memory catalog, its file, the overrides file, work lookup
// by id, alias and typed text, and part keys looked up by identity.
//
// The bug: a catalog read at require time hands every test that loads app/bot.js the real
// library; reading the real overrides file under the runner makes a test pass or fail by what is
// on this machine; a replace that mutates the live works list lets a reader see half of two
// catalogs; and a part key looked up by ordinal after a rebuild inserted a part plays the
// neighbouring file, so a listener resumes in the wrong chapter with no error anywhere. An
// overrides writer that replaces a hand edit with a typo in it loses the owner's work; one that
// writes in place leaves half a file after a crash; one that writes back what readOverrides
// widened turns a short include key into a full path the owner never typed; and a metadata
// refresh that reads a broken overrides file as "no overrides" drops every edit from view. A
// Calibre record laid over the catalog must only fill blanks: one titled in lower case or after
// its series would otherwise replace a good title.
//
// Harness: the store pattern of test/archipelagoHints.test.js (pid-suffixed env file set before
// the first require, afterEach unlink and reset), the directory-at-.tmp write breaker from
// test/writeFailures.test.js, and a child process for the unset-env-var case, because the store
// reads its env var once at require time. The catalog is the synthetic
// test/fixtures/books/catalog.json. The lookup cache and the read-along stores, which the
// metadata refresh reads by default, point at pid-suffixed temp files before the first require.

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
const SIDE_STORES = { PLEXBOT_BOOK_LOOKUP_FILE: 'lookup', PLEXBOT_BOOK_TEXT_LINKS_FILE: 'text-links', PLEXBOT_BOOK_TEXT_WORKS_FILE: 'text-works' };
for (const [env, label] of Object.entries(SIDE_STORES)) process.env[env] = pathMod.join(os.tmpdir(), `plexbot-test-book-catalog-${label}-${process.pid}.json`);

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
	for (const p of [FILE, OVERRIDES_FILE, `${OVERRIDES_FILE}.bak`, ...Object.keys(SIDE_STORES).map((e) => process.env[e]), ...asideFiles()]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
	for (const p of [`${FILE}.tmp`, `${OVERRIDES_FILE}.tmp`]) {
		try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
	}
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

// The bug: "the mythos" found nothing for a work titled "Mythos", and "penelope" nothing for
// "Pénélope", whose accents norm() turned into word breaks.
test('findWorks drops a leading article only when the query finds nothing with it, and folds accents', () => {
	const c = fixture();
	const base = c.works['avery-quill/the-salt-crown'];
	c.works['noor-vasquez/lanterns'] = Object.assign(JSON.parse(JSON.stringify(base)), { id: 'noor-vasquez/lanterns', title: 'Lanterns', author: 'Noor Vasquez', series: null, sequence: null });
	c.works['noor-vasquez/penelope'] = Object.assign(JSON.parse(JSON.stringify(base)), { id: 'noor-vasquez/penelope', title: 'Pénélope', author: 'Noor Vásquez', series: null, sequence: null });
	store.replace(c);
	const ids = (text) => store.findWorks(text).map((w) => w.id);
	assert.deepStrictEqual(ids('the lanterns'), ['noor-vasquez/lanterns']);
	assert.deepStrictEqual(ids('the glass'), ['avery-quill/the-glass-road', 'ilse-moreau/the-glass-sea'], 'the article still narrows while it matches');
	assert.deepStrictEqual(ids('penelope'), ['noor-vasquez/penelope']);
	assert.deepStrictEqual(ids('vasquez pen'), ['noor-vasquez/penelope']);
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

test('replace keeps the music split off book folders, and meta as built', () => {
	const c = fixture();
	c.splits = [{ folderKey: 'M:/Library/Music/Avery Quill', album: '5001', albumTitle: 'Night Drive', tracks: 9, reason: 'music-genre' }];
	c.meta.roots = ['M:/Library/Music'];
	store.replace(c);
	store.reset();
	assert.deepStrictEqual(store.load().splits, c.splits);
	assert.deepStrictEqual(store.meta().roots, ['M:/Library/Music']);
	store.replace({ works: {} });
	assert.deepStrictEqual(store.load().splits, [], 'a catalog without splits has an empty list');
});

// --- the overrides writer ------------------------------------------------------------------------

function useOverrides(text) {
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	if (text !== undefined) fs.writeFileSync(OVERRIDES_FILE, text);
}

test('editOverrides writes a .bak of the old text, then a temp file renamed over the file', (t) => {
	const old = '{ "works": { "avery-quill/the-salt-crown": { "title": "Salt" } } }\r\n';
	useOverrides(old);
	const renames = t.mock.method(fs, 'renameSync');
	const r = store.editOverrides((o) => { o.works['avery-quill/the-salt-crown'].narrator = 'Rhea Stone'; });
	assert.deepStrictEqual([r.ok, r.changed, r.error], [true, true, null]);
	assert.strictEqual(fs.readFileSync(`${OVERRIDES_FILE}.bak`, 'utf8'), old, 'the previous text, byte for byte');
	const text = fs.readFileSync(OVERRIDES_FILE, 'utf8');
	assert.strictEqual(text, `${JSON.stringify({ works: { 'avery-quill/the-salt-crown': { title: 'Salt', narrator: 'Rhea Stone' } } }, null, 2)}\n`);
	assert.deepStrictEqual(renames.mock.calls.map((c) => c.arguments.map(String)), [[`${OVERRIDES_FILE}.tmp`, OVERRIDES_FILE]]);
	assert.ok(!fs.existsSync(`${OVERRIDES_FILE}.tmp`));
	assert.deepStrictEqual(store.readOverrides().overrides.works['avery-quill/the-salt-crown'], { title: 'Salt', narrator: 'Rhea Stone' });
});

test('editOverrides refuses a file that is not valid JSON and leaves it untouched', (t) => {
	const warned = [];
	t.mock.method(logger, 'warn', (...args) => { warned.push(args.join(' ')); });
	const broken = '{\n  "works": {\n    "a/b": { "title": "B", }\n  }\n}\n';
	useOverrides(broken);
	let called = false;
	const r = store.editOverrides(() => { called = true; });
	assert.deepStrictEqual([r.ok, r.changed], [false, false]);
	assert.match(r.error, /^the file is not valid JSON \(line 3 column \d+\)$/);
	assert.ok(!r.error.includes(pathMod.basename(OVERRIDES_FILE)), 'no path in what a reply may show');
	assert.strictEqual(called, false);
	assert.strictEqual(fs.readFileSync(OVERRIDES_FILE, 'utf8'), broken);
	assert.ok(!fs.existsSync(`${OVERRIDES_FILE}.bak`));
	assert.strictEqual(warned.length, 1);
	assert.ok(warned[0].includes(OVERRIDES_FILE), 'the log names the file');

	useOverrides('[1, 2]');
	assert.deepStrictEqual(store.editOverrides(() => {}), { ok: false, changed: false, error: 'the file must hold a JSON object' });
	assert.strictEqual(fs.readFileSync(OVERRIDES_FILE, 'utf8'), '[1, 2]');
});

test('editOverrides writes back the keys as typed, never the ones readOverrides widened', () => {
	store.replace(fixture());
	const full = CATALOG.works['avery-quill/the-glass-road'].folderKey;
	const short = full.split('/').slice(-2).join('/');
	useOverrides(JSON.stringify({ exclude: [short] }));
	assert.ok(store.readOverrides().overrides.exclude.includes(full), 'the reader widens the short key');
	const r = store.editOverrides((o) => { o.podcastArtists = ['Lantern Hollow']; });
	assert.strictEqual(r.ok, true);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { exclude: [short], podcastArtists: ['Lantern Hollow'] });
});

test('editOverrides creates a missing file, with no .bak', () => {
	useOverrides();
	const r = store.editOverrides((o) => { o.works = { 'a/b': { exclude: true } }; });
	assert.deepStrictEqual([r.ok, r.changed], [true, true]);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { works: { 'a/b': { exclude: true } } });
	assert.ok(!fs.existsSync(`${OVERRIDES_FILE}.bak`));
});

test('editOverrides accepts an empty file or one saved with a byte order mark', () => {
	useOverrides('  \n');
	assert.strictEqual(store.editOverrides((o) => { o.include = ['1']; }).ok, true);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { include: ['1'] });
	useOverrides(`${String.fromCharCode(0xFEFF)}{ "include": ["2"] }`);
	assert.deepStrictEqual(store.readOverrides(), { overrides: { include: ['2'] }, error: null }, 'the reader takes it too');
	assert.strictEqual(store.editOverrides((o) => { o.include.push('3'); }).ok, true);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { include: ['2', '3'] });
});

test('an edit that changes nothing, or a mutator that returns false, writes nothing', (t) => {
	const hand = '{"works":{"a/b":{"title":"B"}}}';
	useOverrides(hand);
	const renames = t.mock.method(fs, 'renameSync');
	assert.strictEqual(store.editOverrides((o) => { o.works['a/b'].title = 'B'; }).changed, false);
	assert.strictEqual(store.editOverrides((o) => { o.works['a/b'].title = 'C'; return false; }).changed, false);
	assert.strictEqual(renames.mock.callCount(), 0);
	assert.strictEqual(fs.readFileSync(OVERRIDES_FILE, 'utf8'), hand, 'the owner\'s own formatting stays');
});

test('a mutator may return a replacement object, and a throw or a non-object writes nothing', (t) => {
	t.mock.method(logger, 'warn', () => {});
	useOverrides('{"include":["1"]}');
	assert.strictEqual(store.editOverrides(() => ({ include: ['9'] })).ok, true);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { include: ['9'] });
	assert.deepStrictEqual(store.editOverrides(() => { throw new Error('boom'); }), { ok: false, changed: false, error: 'the edit could not be applied' });
	assert.deepStrictEqual(store.editOverrides(() => [1]), { ok: false, changed: false, error: 'the edit must leave a JSON object' });
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { include: ['9'] });
});

test('a failed write keeps the old file whole and reports no path', (t) => {
	t.mock.method(logger, 'error', () => {});
	useOverrides('{"include":["1"]}');
	fs.mkdirSync(`${OVERRIDES_FILE}.tmp`, { recursive: true });
	const r = store.editOverrides((o) => { o.include.push('2'); });
	assert.deepStrictEqual(r, { ok: false, changed: false, error: 'the file could not be written' });
	assert.strictEqual(fs.readFileSync(OVERRIDES_FILE, 'utf8'), '{"include":["1"]}');
});

test('editOverrides under the runner without its env var never touches the disk', (t) => {
	const spies = ['readFileSync', 'writeFileSync', 'openSync', 'renameSync', 'mkdirSync'].map((m) => t.mock.method(fs, m));
	const r = store.editOverrides((o) => { o.include = ['1']; });
	assert.strictEqual(r.ok, false);
	for (const spy of spies) assert.strictEqual(spy.mock.calls.filter((c) => String(c.arguments[0]).includes('book_overrides')).length, 0);
});

test('an author-level series and order written by editOverrides reaches both the build and the display', () => {
	useOverrides('{}');
	const order = { 'The Ember Throne': 1, 'The Salt Crown': 2 };
	assert.strictEqual(store.editOverrides((o) => { o.authors = { 'avery-quill': { series: 'Ashfall Cantos', order } }; }).ok, true);
	const { overrides } = store.readOverrides();
	assert.deepStrictEqual(overrides.authors['avery-quill'], { series: 'Ashfall Cantos', order });
	const built = require('../helpers/bookCatalog.js').applyOverrides(fixture().works, overrides);
	assert.deepStrictEqual([built['avery-quill/the-salt-crown'].series, built['avery-quill/the-salt-crown'].sequence], ['Ashfall Cantos', 2]);

	store.replace(fixture());
	const r = store.refreshMetadata({ lookup: null, textStore: null });
	assert.strictEqual(r.ok, true);
	const w = store.work('avery-quill/the-salt-crown');
	assert.deepStrictEqual([w.id, w.series, w.sequence, w.sources.series], ['avery-quill/the-salt-crown', 'Ashfall Cantos', 2, 'override']);
	assert.deepStrictEqual(w.parts, CATALOG.works['avery-quill/the-salt-crown'].parts);
	const other = store.work('avery-quill/the-last-lantern');
	assert.deepStrictEqual([other.series, other.sequence], ['Ashfall', 3], 'a title the order does not list keeps its own series');
});

// --- refreshMetadata ------------------------------------------------------------------------------

test('refreshMetadata applies an edit found through an alias, persists it and needs no Plex', (t) => {
	const c = fixture();
	c.works['avery-quill/the-salt-crown'].aliases = ['old/salt'];
	store.replace(c);
	useOverrides(JSON.stringify({ works: { 'old/salt': { title: 'The Salt Crown, Revised', narrator: null } } }));
	const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in this test'); });
	const first = store.refreshMetadata({ lookup: null, textStore: null });
	assert.strictEqual(first.ok, true);
	assert.ok(first.changed.includes('avery-quill/the-salt-crown'));
	assert.strictEqual(fetches.mock.callCount(), 0);
	assert.strictEqual(store.work('old/salt').title, 'The Salt Crown, Revised');
	assert.strictEqual(store.findWorks('revised')[0].id, 'avery-quill/the-salt-crown', 'the lookups are rebuilt');

	store.reset();
	const w = store.work('avery-quill/the-salt-crown');
	assert.deepStrictEqual([w.title, w.narrator, w.sources.title, w.sources.narrator], ['The Salt Crown, Revised', null, 'override', 'override'], 'it reached disk');
	assert.strictEqual(w.detected.title, 'The Salt Crown');
	assert.deepStrictEqual(store.refreshMetadata({ lookup: null, textStore: null }), { ok: true, changed: [], error: null }, 'a second run changes nothing');
});

test('refreshMetadata changes nothing while the overrides file is broken', (t) => {
	t.mock.method(logger, 'warn', () => {});
	store.replace(fixture());
	useOverrides(JSON.stringify({ works: { 'avery-quill/the-salt-crown': { title: 'Edited' } } }));
	store.refreshMetadata({ lookup: null, textStore: null });
	const before = fs.readFileSync(FILE, 'utf8');
	fs.writeFileSync(OVERRIDES_FILE, '{"works": ');
	const r = store.refreshMetadata({ lookup: null, textStore: null });
	assert.deepStrictEqual([r.ok, r.changed], [false, []]);
	assert.match(r.error, /^the file is not valid JSON/);
	assert.strictEqual(store.work('avery-quill/the-salt-crown').title, 'Edited', 'the edit stays on show');
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), before);
});

test('refreshMetadata lays Calibre and the online lookup under the overrides', () => {
	store.replace(fixture());
	const id = 'avery-quill/the-glass-road';
	const textStore = {
		works: { peek: (w) => (w.id === id ? { base: 'abcd', via: 'auto', source: { type: 'calibre', id: 11 }, meta: { title: 'The Glass Road: A Novel', authors: ['A. Quill'], series: 'Glass', seriesIndex: 1 } } : null) },
		links: { get: () => null },
	};
	const asked = [];
	const lookup = { get: (w) => { asked.push([w.id, w.title, w.series]); return w.id === id ? { outcome: 'edition', fields: { title: 'The Glass Road: A Novel', narrator: 'Kit Moss', narrators: ['Kit Moss'], publisher: 'GraphicAudio' } } : null; } };
	const r = store.refreshMetadata({ overrides: {}, lookup, textStore });
	assert.ok(r.changed.includes(id));
	const w = store.work(id);
	assert.deepStrictEqual([w.title, w.author, w.series, w.sequence, w.narrator], ['The Glass Road', 'Avery Quill', 'Glass', 1, 'Kit Moss'], 'Calibre fills the blank series and never replaces the title or author');
	assert.deepStrictEqual([w.sources.series, w.sources.sequence, w.sources.narrator, w.sources.publisher], ['calibre', 'calibre', 'online', 'plex']);
	assert.notStrictEqual(w.sources.title, 'calibre');
	assert.ok(asked.some(([x, title, series]) => x === id && title === 'The Glass Road' && series === 'Glass'), 'the lookup is asked with the work as Calibre left it');
	assert.strictEqual(w.id, id);

	const linkedElsewhere = { works: textStore.works, links: { get: () => ({ type: 'calibre', id: 12 }) } };
	store.refreshMetadata({ overrides: {}, lookup: null, textStore: linkedElsewhere });
	assert.strictEqual(store.work(id).series, null, 'a pointer made under another link is not this book\'s');
});

// The bug: the read-along pointer's copy of Calibre's metadata was refreshed only when someone
// opened the read-along, so a series fixed in Calibre stayed wrong in the catalog.
test('with the Calibre index on, its current record for the pointer\'s id wins over the pointer\'s copy', () => {
	store.replace(fixture());
	const id = 'avery-quill/the-glass-road';
	const pointer = { base: 'abcd', via: 'auto', source: { type: 'calibre', id: 11 }, meta: { title: 'The Glass Road', authors: ['Avery Quill'], series: 'Old Name', seriesIndex: 1 } };
	const textStore = { works: { peek: (w) => (w.id === id ? pointer : null) }, links: { get: () => null } };
	const asked = [];
	const answers = { [id]: { title: 'The Glass Road', authors: ['Avery Quill'], series: 'New Name', seriesIndex: 1 } };
	const calibreIndex = { metadataFor: (w, pointerId) => { asked.push([w.id, pointerId]); return answers[w.id]; } };
	store.refreshMetadata({ overrides: {}, lookup: null, textStore, calibreIndex });
	assert.strictEqual(store.work(id).series, 'New Name');
	assert.ok(asked.some(([w, p]) => w === id && p === 11), 'the pointer\'s Calibre id is handed to the index');
	assert.ok(asked.some(([w, p]) => w !== id && p === null));

	answers[id] = undefined;
	store.refreshMetadata({ overrides: {}, lookup: null, textStore, calibreIndex });
	assert.strictEqual(store.work(id).series, 'Old Name', 'an index with no say leaves the pointer\'s copy');
	answers[id] = null;
	store.refreshMetadata({ overrides: {}, lookup: null, textStore, calibreIndex });
	assert.strictEqual(store.work(id).series, null, 'a pin to none takes Calibre away');
});

test('refreshMetadata with its real sources reads nothing online while the setting is off', () => {
	store.replace(fixture());
	useOverrides(JSON.stringify({ works: { 'avery-quill/the-salt-crown': { series: 'Salt Saga' } } }));
	const r = store.refreshMetadata();
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.changed.length, Object.keys(CATALOG.works).length, 'every work gains its sources');
	const w = store.work('avery-quill/the-salt-crown');
	assert.deepStrictEqual([w.series, w.sources.series], ['Salt Saga', 'override']);
	assert.ok(!Object.values(store.load().works).some((x) => Object.values(x.sources).includes('online') || Object.values(x.sources).includes('calibre')));
});
