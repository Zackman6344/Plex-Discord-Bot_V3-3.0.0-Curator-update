// helpers/bookTextStore.js: the read-along's ebook links, reader preferences, cache pointers and
// sync marks.
//
// The bug: a link or a cache pointer saved under a work's old id is lost when a catalog rebuild
// renames the work, so the owner's `!book link` silently stops applying and a parsed book is
// parsed again; clearing a link leaves its alias copy behind, which then comes back; a Discord id
// or a folder-built work id like "__proto__" reaches the prototype chain. A second sync mark at the
// same spot kept beside the first, a mark saved without the text version it belongs to, or marks under
// a renamed work's old id left to drift from the new list.
//
// Harness: the jsonStore pattern of test/bookmarks.test.js: pid-suffixed env files set before the
// first require, and reset() between tests so each read comes off disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-text-store-${process.pid}`);
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-works.json`;
process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE = `${BASE}-marks.json`;

const store = require('../helpers/bookTextStore.js');

const FILES = [process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE, process.env.PLEXBOT_BOOK_TEXT_READERS_FILE, process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE, process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE];

test.afterEach(() => {
	for (const f of FILES) fs.rmSync(f, { force: true });
	store.reset();
});

const RENAMED = { id: 'avery-quill/the-ember-throne-new', aliases: ['avery-quill/the-ember-throne'] };

test('the four files live where the env vars point', () => {
	assert.deepStrictEqual([store.files.links, store.files.readers, store.files.works, store.files.marks], FILES);
});

test('a link is found by the work id and survives a reload from disk', () => {
	store.links.set('avery-quill/the-ember-throne', { type: 'calibre', id: 299, by: '1', at: 5 });
	store.reset();
	assert.deepStrictEqual(store.links.get({ id: 'avery-quill/the-ember-throne', aliases: [] }), { type: 'calibre', id: 299, by: '1', at: 5 });
	assert.deepStrictEqual(store.links.get('avery-quill/the-ember-throne'), { type: 'calibre', id: 299, by: '1', at: 5 });
	assert.strictEqual(JSON.parse(fs.readFileSync(FILES[0], 'utf8')).links['avery-quill/the-ember-throne'].id, 299);
});

test('a link saved under an old id is found through the alias', () => {
	store.links.set('avery-quill/the-ember-throne', { type: 'file', path: 'D:/x.epub', by: '1', at: 5 });
	assert.strictEqual(store.links.get(RENAMED).path, 'D:/x.epub');
});

test('the current id wins over an alias', () => {
	store.links.set('avery-quill/the-ember-throne', { type: 'calibre', id: 1, by: '1', at: 5 });
	store.links.set(RENAMED.id, { type: 'off', by: '1', at: 6 });
	assert.strictEqual(store.links.get(RENAMED).type, 'off');
});

test('clearing a link removes it under every name, so an alias copy cannot come back', () => {
	store.links.set('avery-quill/the-ember-throne', { type: 'calibre', id: 1, by: '1', at: 5 });
	store.links.set(RENAMED.id, { type: 'calibre', id: 2, by: '1', at: 6 });
	store.links.clear(RENAMED);
	assert.strictEqual(store.links.get(RENAMED), null);
	store.reset();
	assert.deepStrictEqual(store.links.all(), {});
});

test('a returned link is a copy', () => {
	store.links.set('w', { type: 'calibre', id: 1, by: '1', at: 5 });
	store.links.get('w').id = 99;
	assert.strictEqual(store.links.get('w').id, 1);
});

test('a pointer found through an alias is copied to the current id', () => {
	const ptr = { base: '0123456789abcdef', fingerprint: 'file:D:/x.epub:10:20', via: 'sidecar', source: { type: 'file', path: 'D:/x.epub' }, at: 1 };
	store.works.set('avery-quill/the-ember-throne', ptr);
	assert.deepStrictEqual(store.works.peek(RENAMED), ptr);
	assert.strictEqual(store.works.all()[RENAMED.id], undefined, 'peek does not write');
	assert.deepStrictEqual(store.works.get(RENAMED), ptr);
	store.reset();
	assert.deepStrictEqual(store.works.all()[RENAMED.id], ptr);
});

test('reader preferences turn on and off and record when', () => {
	assert.strictEqual(store.readers.isOn('100000000000000001'), false);
	store.readers.set('100000000000000001', true, 1234);
	store.reset();
	assert.strictEqual(store.readers.isOn('100000000000000001'), true);
	assert.deepStrictEqual(store.readers.all(), { '100000000000000001': { on: true, since: 1234 } });
	store.readers.set('100000000000000001', true, 9999);
	assert.strictEqual(store.readers.all()['100000000000000001'].since, 1234, 'turning it on again keeps the first time');
	store.readers.set('100000000000000001', false);
	assert.strictEqual(store.readers.isOn('100000000000000001'), false);
	assert.deepStrictEqual(store.readers.all(), {});
});

test('a key like __proto__ is an ordinary entry', () => {
	store.links.set('__proto__', { type: 'off', by: '1', at: 1 });
	store.readers.set('__proto__', true, 1);
	assert.strictEqual(store.links.get('__proto__').type, 'off');
	assert.strictEqual(store.readers.isOn('__proto__'), true);
	assert.strictEqual(({}).type, undefined);
	assert.strictEqual(store.links.get('constructor'), null);
});

test('bad input is refused without writing', () => {
	assert.strictEqual(store.links.set('', { type: 'off' }), false);
	assert.strictEqual(store.links.set('w', null), false);
	assert.strictEqual(store.links.get(null), null);
	assert.strictEqual(store.readers.set('', true), false);
	assert.strictEqual(fs.existsSync(FILES[0]), false);
});

test('a mark is replaced by one within 20 s or on the same word of the same text, and kept per text', () => {
	const T1 = '0123456789abcdef';
	const first = store.marks.add(RENAMED, { ms: 60000, word: 100, text: T1, tag: '0123', by: '1', at: 1 });
	assert.strictEqual(first.ok, true);
	assert.match(first.mark.id, /^[0-9a-f]{8}$/);
	assert.deepStrictEqual(Object.keys(first.mark).sort(), ['at', 'by', 'id', 'ms', 'rec', 'tag', 'text', 'word'], 'no book text, ever');
	assert.strictEqual(first.mark.rec, null, 'a mark with no recording fingerprint keeps null');
	const near = store.marks.add(RENAMED, { ms: 75000, word: 140, text: T1, by: '2', at: 2 });
	assert.deepStrictEqual(near.replaced.map((m) => m.id), [first.mark.id]);
	const sameWord = store.marks.add(RENAMED, { ms: 300000, word: 140, text: T1, by: '2', at: 3 });
	assert.deepStrictEqual(sameWord.replaced.map((m) => m.id), [near.mark.id]);
	store.marks.add(RENAMED, { ms: 300000, word: 140, text: 'fedcba9876543210', by: '2', at: 4 });
	store.marks.add(RENAMED, { ms: 900000, word: 700, text: T1, by: '1', at: 5 });
	store.reset();
	assert.deepStrictEqual(store.marks.list(RENAMED).map((m) => [m.ms, m.word, m.text.slice(0, 4)]), [[300000, 140, '0123'], [300000, 140, 'fedc'], [900000, 700, '0123']]);
	assert.strictEqual(store.marks.add(RENAMED, { ms: -1, word: 1, text: T1 }).ok, false);
	assert.strictEqual(store.marks.add(RENAMED, { ms: 1, word: 1 }).ok, false, 'a mark needs its text version');
});

test('a mark of another recording under the same id is never replaced by a new one', () => {
	const T1 = '0123456789abcdef';
	const old = store.marks.add(RENAMED, { ms: 60000, word: 100, text: T1, rec: '6-aaaaaaaa', by: '1', at: 1 });
	const fresh = store.marks.add(RENAMED, { ms: 61000, word: 100, text: T1, rec: '6-bbbbbbbb', by: '1', at: 2 });
	assert.deepStrictEqual(fresh.replaced, []);
	const again = store.marks.add(RENAMED, { ms: 62000, word: 101, text: T1, rec: '6-bbbbbbbb', by: '1', at: 3 });
	assert.deepStrictEqual(again.replaced.map((m) => m.id), [fresh.mark.id]);
	assert.deepStrictEqual(store.marks.list(RENAMED).map((m) => [m.id === old.mark.id, m.rec]), [[true, '6-aaaaaaaa'], [false, '6-bbbbbbbb']]);
});

test('marks under an old id move to the new one on the next write, and clear removes every name', () => {
	const all = () => JSON.parse(fs.readFileSync(FILES[3], 'utf8')).marks;
	store.marks.add('avery-quill/the-ember-throne', { ms: 1000, word: 5, text: 'abc', by: '1', at: 1 });
	assert.strictEqual(store.marks.list(RENAMED).length, 1, 'found through the alias');
	const added = store.marks.add(RENAMED, { ms: 90000, word: 400, text: 'abc', by: '1', at: 2 });
	assert.deepStrictEqual(Object.keys(all()), [RENAMED.id]);
	assert.strictEqual(store.marks.remove(RENAMED, [added.mark.id]).removed.length, 1);
	assert.strictEqual(store.marks.clear(RENAMED).removed.length, 1);
	assert.deepStrictEqual(all(), {});
	assert.deepStrictEqual(store.marks.clear(RENAMED), { ok: true, removed: [] });
});

// The marks file logged as 'Audiobook' while its three siblings log as 'Read-along', so a search of
// the log for the read-along's files missed it.
test('a damaged marks file is logged under Read-along, like its sibling files', (t) => {
	const logger = require('../helpers/logger.js');
	const lines = [];
	t.mock.method(logger, 'error', (...args) => { lines.push(args.join(' ')); });
	fs.writeFileSync(FILES[3], '{"marks": [');
	try {
		assert.deepStrictEqual(store.marks.list('w'), []);
		assert.strictEqual(lines.length, 1);
		assert.match(lines[0], /^Read-along mark file unusable /);
	} finally {
		const dir = pathMod.dirname(FILES[3]);
		const base = pathMod.basename(FILES[3]);
		for (const f of fs.readdirSync(dir)) if (f.startsWith(`${base}.corrupt-`)) fs.rmSync(pathMod.join(dir, f), { force: true });
	}
});
