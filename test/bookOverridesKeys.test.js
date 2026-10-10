// helpers/bookCatalogStore.js readOverrides: what reaches a public rescan reply, and the short
// folder keys that reply now prints.
//
// The bug: an unreadable book_overrides.json reported the raw fs message, which carries the
// absolute path (user profile included), and a JSON error can quote the file's text; `!book
// rescan` posts both in the open channel. The rescan reply now prints folder keys relative to the
// music root, and an include or exclude copied from it has to keep matching the full key.
//
// Harness: pid-suffixed catalog and overrides files set before the first require, the synthetic
// test/fixtures/books/catalog.json as the stored catalog, and fs.readFileSync mocked for the
// permission error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-overrides-keys-${process.pid}`);
const OVERRIDES_FILE = `${BASE}-overrides.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const logger = require('../helpers/logger.js');
const store = require('../helpers/bookCatalogStore.js');
const fixture = require('./fixtures/books/catalog.json');

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	store.reset();
}

test.beforeEach(() => {
	cleanup();
	store.replace(JSON.parse(JSON.stringify(fixture)));
});
test.after(cleanup);

test('an unreadable overrides file reports its error code, and the log keeps the path', (t) => {
	const warned = [];
	t.mock.method(logger, 'warn', (...args) => { warned.push(args.join(' ')); });
	const real = fs.readFileSync;
	t.mock.method(fs, 'readFileSync', function (p, ...rest) {
		if (String(p) === OVERRIDES_FILE) {
			const err = new Error(`EACCES: permission denied, open '${OVERRIDES_FILE}'`);
			err.code = 'EACCES';
			throw err;
		}
		return real.call(this, p, ...rest);
	});
	const r = store.readOverrides();
	assert.deepStrictEqual(r, { overrides: {}, error: 'EACCES' });
	assert.ok(warned.some(line => line.includes(OVERRIDES_FILE)), 'the full message is still logged');
});

test('a JSON error never quotes the file', (t) => {
	t.mock.method(logger, 'warn', () => {});
	fs.writeFileSync(OVERRIDES_FILE, '{"include": ["D:/Media/Music/Private Folder/Book",]}');
	const r = store.readOverrides();
	assert.deepStrictEqual(r.overrides, {});
	assert.match(r.error, /not valid JSON/);
	assert.doesNotMatch(r.error, /Book|Private|Media/);
});

test('an include or exclude copied from the rescan reply matches the full folder key', (t) => {
	t.mock.method(logger, 'warn', () => {});
	fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({
		include: ['Sam Drift/[Unknown Album]', 'm:\\music\\theo bramble\\well', '1090'],
		exclude: ['Corin Vale/The Long Tide/']
	}));
	const { overrides, error } = store.readOverrides();
	assert.strictEqual(error, null);
	assert.deepStrictEqual(overrides.include, [
		'Sam Drift/[Unknown Album]', 'm:\\music\\theo bramble\\well', '1090',
		'M:/Music/Sam Drift/[Unknown Album]'
	], 'a rejected group, widened; a full key and an album key left alone');
	assert.deepStrictEqual(overrides.exclude, ['Corin Vale/The Long Tide/', 'M:/Music/Corin Vale/The Long Tide'], 'a work, widened');
});

test('a short key that fits two folders is left as typed', (t) => {
	const warned = [];
	t.mock.method(logger, 'warn', (...args) => { warned.push(args.join(' ')); });
	const c = JSON.parse(JSON.stringify(fixture));
	c.rejected.push(Object.assign({}, c.rejected[0], { folderKey: 'N:/Music/Sam Drift/[Unknown Album]' }));
	store.replace(c);
	fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ include: ['Sam Drift/[Unknown Album]'] }));
	assert.deepStrictEqual(store.readOverrides().overrides.include, ['Sam Drift/[Unknown Album]']);
	assert.ok(warned.some(line => /fits more than one folder/.test(line)));
});
