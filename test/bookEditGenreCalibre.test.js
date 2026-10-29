// commands/book.js/edit.js: the genre, author-genre and calibre details of `!book edit`.
//
// The bug: a book's library section could only come from folders and tags, so a wrong or missing
// one had no fix, and a wrong Calibre match (or a right one the matcher could not find) could only
// be fixed in Calibre itself. A pin stored by Calibre id alone would attach another book after the
// library is rebuilt, and section or pin keys mistaken for display fields would show up as edits
// to a book's details.
//
// Harness: the real command through book.command.process on the prefix and slash paths, the real
// catalog and overrides stores on pid-suffixed temp files seeded from the fixture catalog, and a
// fake Calibre index put in place of calibreIndex.instance().

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-edit-genre-${process.pid}`);
const OVERRIDES = `${BASE}-overrides.json`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES;
process.env.PLEXBOT_BOOK_LOOKUP_FILE = `${BASE}-lookup.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-text-links.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-text-works.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const bookmarks = require('../helpers/bookmarks.js');
const catalog = require('../helpers/bookCatalogStore.js');
const bookLookup = require('../helpers/bookLookup.js');
const bookMetadata = require('../helpers/bookMetadata.js');
const calibreIndex = require('../helpers/calibreIndex.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const book = require('../commands/book.js');
const fixture = require('./fixtures/books/catalog.json');

const G = '200000000000000001';
const OWNER = '100000000000000009';
const HARLOW = 'ilse-moreau/the-far-shore~harlow';
const PENROSE = 'ilse-moreau/the-far-shore~penrose';

const saved = { audiobooksEnabled: config.audiobooksEnabled, ownerId: config.ownerId, instance: calibreIndex.instance, lookup: bookLookup.instance };

function fakeIndex({ enabled = true, configured = true, records = {} } = {}) {
	const f = {
		calls: { rematch: 0, refresh: [] },
		enabled: () => enabled,
		configured: () => configured,
		recordOf: (id) => records[id] || null,
		status: () => ({ libraryId: 'Test_Library', fetchedAt: 1, books: Object.keys(records).length }),
		rematch() { f.calls.rematch++; return true; },
		refresh(opts) { f.calls.refresh.push(opts); return Promise.resolve({ ok: true }); },
		matchFor: () => null,
		genreOf: () => null,
		metadataFor: () => undefined,
	};
	return f;
}

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
	catalog.reset();
}

let index = null;

test.beforeEach(() => {
	cleanup();
	catalog.replace(JSON.parse(JSON.stringify(fixture)));
	config.audiobooksEnabled = true;
	config.ownerId = OWNER;
	// Calibre keeps authors surname first; the pin reply shows "Ilse Moreau".
	index = fakeIndex({ records: { 42: { uuid: 'uuid-42', title: 'The Far Shore', authors: ['Moreau, Ilse'], formats: ['epub'], tags: [] } } });
	calibreIndex.instance = () => index;
	bookLookup.instance = () => ({ isRunning: () => false, get: () => null, refresh() { throw new Error('no lookup expected'); } });
});
test.afterEach(() => {
	config.audiobooksEnabled = saved.audiobooksEnabled;
	config.ownerId = saved.ownerId;
	calibreIndex.instance = saved.instance;
	bookLookup.instance = saved.lookup;
	cleanup();
});
test.after(cleanup);

const BOT = { books: { session: () => null, position: () => 0 } };

function text(p) {
	return typeof p === 'string' ? p : p.content;
}

async function runPrefix(query, who = OWNER) {
	const calls = [];
	const m = {
		author: { id: who, username: who },
		member: { id: who, user: { id: who }, voice: {} },
		guild: { id: G },
		content: `!book edit ${query}`,
		mentions: { users: { first: () => undefined } },
		channel: { id: '400000000000000001', async send(p) { calls.push(p); return { edit: async () => {} }; } },
		async reply(p) { calls.push(p); return { edit: async () => {} }; },
	};
	await book.command.process(BOT, null, m, `edit ${query}`);
	return calls.map(text);
}

async function runSlash(values) {
	const calls = [];
	const interaction = {
		commandName: 'book',
		user: { id: OWNER, username: OWNER },
		member: { id: OWNER, user: { id: OWNER }, voice: {} },
		guild: { id: G },
		guildId: G,
		client: {},
		deferred: true,
		channel: { id: '400000000000000001', async send(p) { calls.push(p); return {}; } },
		options: { data: [], getSubcommand: () => 'edit', get: (name) => (values[name] === undefined ? null : { name, value: values[name] }) },
		async editReply(p) { calls.push(p); return {}; },
		async followUp(p) { calls.push(p); return {}; },
	};
	const query = slashRegistry.buildQueryString(interaction, book.command.slash);
	await book.command.process(BOT, null, adaptInteraction(interaction, query), query);
	return calls.map(text);
}

function overridesFile() {
	return fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : null;
}

test('genre lists every recording of a title under one section, in the library\'s spelling', async () => {
	const out = await runPrefix('the far shore genre science fiction');
	assert.match(out[0], /listed under \*\*Science Fiction\*\*/);
	assert.match(out[0], /all 2 recordings/);
	const works = overridesFile().works;
	assert.strictEqual(works[HARLOW].genre, 'Science Fiction');
	assert.strictEqual(works[PENROSE].genre, 'Science Fiction');
	const show = await runPrefix(HARLOW);
	assert.match(show[0], /Section: Science Fiction · your edit/);
});

test('a section is not a display field: the book\'s details and their sources stay as they were', async () => {
	catalog.refreshMetadata();
	const before = JSON.parse(JSON.stringify(catalog.work(HARLOW)));
	await runPrefix(`${HARLOW} genre Fantasy`);
	const after = catalog.work(HARLOW);
	for (const f of bookMetadata.FIELDS) assert.strictEqual(after[f], before[f], f);
	assert.deepStrictEqual(after.sources, before.sources);
	assert.ok(!('genre' in (bookMetadata.overrideFor(after, overridesFile()) || {})));
});

test('genre none is refused, and clear genre goes back to what the book gets on its own', async () => {
	assert.match((await runPrefix('the far shore genre none'))[0], /needs a name/);
	await runPrefix('the far shore genre Fantasy');
	const out = await runPrefix('the far shore clear genre');
	assert.match(out[0], /section edit is cleared; it is listed under More books · no source/);
	assert.strictEqual((overridesFile() || {}).works, undefined);
});

test('author-genre sits beside an author-wide series, and clearing it keeps the series', async () => {
	await runPrefix('The Night Gate author-series Moreau Cycle 2');
	const out = await runPrefix('the far shore author-genre fantasy');
	assert.match(out[0], /Every Ilse Moreau book is listed under \*\*Fantasy\*\*/);
	assert.deepStrictEqual(overridesFile().authors['ilse-moreau'], { series: 'Moreau Cycle', order: { 'The Night Gate': 2 }, genre: 'Fantasy' });
	const show = await runPrefix(PENROSE);
	assert.match(show[0], /Section: Fantasy · your author-wide edit/);
	await runPrefix('the far shore clear author-genre');
	assert.deepStrictEqual(overridesFile().authors['ilse-moreau'], { series: 'Moreau Cycle', order: { 'The Night Gate': 2 } });
});

// The bug: a pin kept by id alone attached another book once the Calibre library was rebuilt.
test('calibre pins one recording with the record\'s uuid and library, and matches again at once', async () => {
	const refused = await runPrefix('the far shore calibre 42');
	assert.match(refused[0], /changes one recording/);
	const out = await runPrefix(`${HARLOW} calibre #42`);
	assert.match(out[0], /Calibre #42 “The Far Shore” by Ilse Moreau \(EPUB\) from now on/);
	assert.deepStrictEqual(overridesFile().works[HARLOW], { calibreId: 42, calibreUuid: 'uuid-42', calibreLibrary: 'Test_Library' });
	assert.strictEqual(overridesFile().works[PENROSE], undefined);
	assert.strictEqual(index.calls.rematch, 1);
	assert.deepStrictEqual(bookMetadata.extrasFor(catalog.work(HARLOW), overridesFile()).calibre, { id: 42, uuid: 'uuid-42', library: 'Test_Library' });
});

test('calibre none forbids a match, and clear calibre removes the pin and its uuid', async () => {
	await runPrefix(`${HARLOW} calibre 42`);
	const none = await runPrefix(`${HARLOW} calibre none`);
	assert.match(none[0], /no Calibre book from now on/);
	assert.deepStrictEqual(overridesFile().works[HARLOW], { calibreId: null });
	assert.deepStrictEqual(bookMetadata.extrasFor(catalog.work(HARLOW), overridesFile()).calibre, { id: null });
	await runPrefix(`${HARLOW} clear calibre`);
	assert.strictEqual((overridesFile() || {}).works, undefined);
});

test('a pin to an id the saved copy lacks is kept without a uuid, and Calibre is read again', async () => {
	const out = await runPrefix(`${HARLOW} calibre 77`);
	assert.match(out[0], /Calibre book #77 from now on/);
	assert.match(out[0], /has no book #77/);
	assert.deepStrictEqual(overridesFile().works[HARLOW], { calibreId: 77, calibreLibrary: 'Test_Library' });
	assert.deepStrictEqual(index.calls.refresh, [{ force: true }]);
});

test('with the index off the pin is saved and the reply says how to turn it on', async () => {
	index = fakeIndex({ enabled: false });
	const out = await runPrefix(`${HARLOW} calibre 42`);
	assert.match(out[0], /audiobookCalibreSort/);
	assert.strictEqual(overridesFile().works[HARLOW].calibreId, 42);
	assert.deepStrictEqual(index.calls.refresh, []);
});

test('calibre takes only an id or none, on the slash path as well', async () => {
	assert.match((await runPrefix(`${HARLOW} calibre forty-two`))[0], /takes a Calibre book id/);
	const out = await runSlash({ title: HARLOW, field: 'calibre', value: '42' });
	assert.match(out[0], /Calibre #42/);
	assert.strictEqual(overridesFile().works[HARLOW].calibreId, 42);
});

test('a section and a pin written under an old id are found through the alias', () => {
	const moved = { id: 'ilse-moreau/the-far-shore', aliases: ['ilse-moreau/the-far-shore-a-novel'] };
	const ov = { works: { 'ilse-moreau/the-far-shore-a-novel': { genre: 'Fantasy', calibreId: '12', calibreUuid: 'u' }, 'ilse-moreau/the-far-shore': { title: 'X' } } };
	assert.deepStrictEqual(bookMetadata.extrasFor(moved, ov), { genre: 'Fantasy', calibre: { id: 12, uuid: 'u', library: null } });
	assert.deepStrictEqual(bookMetadata.extrasFor(moved, { works: { [moved.id]: { calibreId: 'abc' } } }), { genre: null, calibre: undefined });
});
