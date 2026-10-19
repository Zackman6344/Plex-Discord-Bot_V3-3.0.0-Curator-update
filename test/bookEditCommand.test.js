// commands/book.js/edit.js: `!book edit` and `/book edit`, the owner's fixes to what a book shows.
//
// The bug: a wrong title, author, narrator or series could only be fixed by hand-editing
// book_overrides.json and rescanning; a series name typed on one narration of a title left the
// other narration behind; "Area 51" read as series "Area" number 51; a reply that could carry the
// overrides file's path into an open channel; anyone (or nobody, with no ownerId set) able to
// change the catalog; an edit to one field wiping the owner's exclude, part order or pinned id.
//
// Harness: the real command module through book.command.process, on the prefix path and through
// slashRegistry.buildQueryString plus interactionAdapter.adaptInteraction (as app/music.js does).
// The catalog, overrides and bookmark stores are real, on pid-suffixed temp files seeded from
// test/fixtures/books/catalog.json; bookLibrary.rebuild and bookLookup.instance are replaced by
// recording fakes, so neither Plex nor the network is reached.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-edit-${process.pid}`);
const OVERRIDES = `${BASE}-overrides.json`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES;
process.env.PLEXBOT_BOOK_LOOKUP_FILE = `${BASE}-lookup.json`;
process.env.PLEXBOT_BOOK_TAGS_FILE = `${BASE}-tags.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-text-links.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-text-works.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-text-readers.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const bookmarks = require('../helpers/bookmarks.js');
const catalog = require('../helpers/bookCatalogStore.js');
const bookModel = require('../helpers/bookModel.js');
const bookLibrary = require('../helpers/bookLibrary.js');
const bookLookup = require('../helpers/bookLookup.js');
const { chapterLabel } = require('../helpers/bookChapterLabel.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const book = require('../commands/book.js');
const edit = require('../commands/book.js/edit.js');
const fixture = require('./fixtures/books/catalog.json');

const G = '200000000000000001';
const ANA = '100000000000000001';
const OWNER = '100000000000000009';
const SALT = 'avery-quill/the-salt-crown';
const HARLOW = 'ilse-moreau/the-far-shore~harlow';
const PENROSE = 'ilse-moreau/the-far-shore~penrose';

const saved = {
	audiobooksEnabled: config.audiobooksEnabled,
	ownerId: config.ownerId,
	audiobookOnlineLookup: config.audiobookOnlineLookup,
	rebuild: bookLibrary.rebuild,
	status: bookLibrary.status,
	instance: bookLookup.instance,
};

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
	catalog.reset();
}

function seed(mutate = (c) => c) {
	catalog.replace(mutate(JSON.parse(JSON.stringify(fixture))));
}

test.beforeEach(() => {
	cleanup();
	seed();
	config.audiobooksEnabled = true;
	config.ownerId = OWNER;
	config.audiobookOnlineLookup = false;
	bookLibrary.rebuild = async () => { throw new Error('no rebuild expected'); };
	bookLibrary.status = () => 'ready';
	bookLookup.instance = () => ({ isRunning: () => false, get: () => null, refresh() { throw new Error('no lookup expected'); } });
});
test.afterEach(() => {
	config.audiobooksEnabled = saved.audiobooksEnabled;
	config.ownerId = saved.ownerId;
	config.audiobookOnlineLookup = saved.audiobookOnlineLookup;
	bookLibrary.rebuild = saved.rebuild;
	bookLibrary.status = saved.status;
	bookLookup.instance = saved.instance;
	cleanup();
});
test.after(cleanup);

// ---- fakes ----------------------------------------------------------------------------------

const BOT = { books: { session: () => null, position: () => 0 } };

function user(id) {
	return { id, displayName: id, user: { id, username: id }, voice: { channelId: null, channel: null } };
}

function fakeMessage(payload) {
	return { payload, async edit() { return this; } };
}

async function runPrefix(query, who = OWNER) {
	const calls = [];
	const m = {
		author: { id: who, username: who },
		member: user(who),
		guild: { id: G },
		content: `!book edit ${query}`,
		mentions: { users: { first: () => undefined } },
		channel: { id: '400000000000000001', async send(p) { calls.push(p); return fakeMessage(p); } },
		async reply(p) { calls.push(p); return fakeMessage(p); },
	};
	await book.command.process(BOT, null, m, `edit ${query}`);
	return calls.map(text);
}

function slash(values, who = OWNER) {
	const calls = [];
	const interaction = {
		commandName: 'book',
		user: { id: who, username: who },
		member: user(who),
		guild: { id: G },
		guildId: G,
		client: {},
		deferred: true,
		channel: { id: '400000000000000001', async send(p) { calls.push(p); return fakeMessage(p); } },
		options: {
			data: [],
			getSubcommand: () => 'edit',
			get: (name) => (values[name] === undefined ? null : { name, value: values[name] }),
		},
		async editReply(p) { calls.push(p); return fakeMessage(p); },
		async followUp(p) { calls.push(p); return fakeMessage(p); },
	};
	const query = slashRegistry.buildQueryString(interaction, book.command.slash);
	return { calls, query, message: adaptInteraction(interaction, query) };
}

async function runSlash(values, who = OWNER) {
	const s = slash(values, who);
	await book.command.process(BOT, null, s.message, s.query);
	return s.calls.map(text);
}

function text(p) {
	return typeof p === 'string' ? p : p.content;
}

function overridesFile() {
	return fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')) : null;
}

function ids() {
	return catalog.works().map((w) => w.id).sort();
}

function assertPathFree(replies) {
	const all = replies.join('\n');
	assert.doesNotMatch(all, /[A-Za-z]:[\\/]/, 'no drive letter');
	assert.ok(!all.includes(os.tmpdir()) && !all.includes('plexbot-test'), 'no file path');
	assert.doesNotMatch(all, /book_overrides\.json[\\/]|data[\\/]/, 'no data folder');
}

// ---- grammar --------------------------------------------------------------------------------

test('the prefix grammar splits the book from the detail and its value', () => {
	const titles = ['the salt crown', 'the narrator wars', 'the far shore'];
	const names = (t, field, strong) => {
		const n = String(t).toLowerCase();
		return strong ? titles.includes(n) : titles.some((x) => x.startsWith(n) || x.split(' ').includes(n));
	};
	const parse = (q) => edit.parsePrefix(q, names);
	const req = (q) => { const r = parse(q); assert.ok(!r.error, `${q}: ${r.error}`); return [r.workText, r.req]; };

	assert.deepStrictEqual(parse(''), { help: true });
	assert.deepStrictEqual(parse('?'), { help: true });
	assert.deepStrictEqual(req('The Salt Crown'), ['The Salt Crown', { action: 'show' }]);
	assert.deepStrictEqual(req('The Salt Crown title The Salt Crown: Revised'), ['The Salt Crown', { action: 'set', field: 'title', value: 'The Salt Crown: Revised' }]);
	assert.deepStrictEqual(req('the salt crown author Avery  Quill'), ['the salt crown', { action: 'set', field: 'author', value: 'Avery Quill' }]);
	assert.deepStrictEqual(req('the salt crown narrator none'), ['the salt crown', { action: 'set', field: 'narrator', value: null }]);
	assert.deepStrictEqual(req('the salt crown publisher Tin Roof Audio'), ['the salt crown', { action: 'set', field: 'publisher', value: 'Tin Roof Audio' }]);
	assert.deepStrictEqual(req('the salt crown series Ashfall 2'), ['the salt crown', { action: 'series', name: 'Ashfall', position: { text: '2', sequence: 2 } }]);
	assert.deepStrictEqual(req('the salt crown series Ashfall #0.5')[1].position, { text: '0.5', sequence: 0.5 });
	assert.deepStrictEqual(req('the salt crown series Ashfall 1-5')[1].position, { text: '1-5', sequence: null });
	assert.deepStrictEqual(req('the salt crown series Ashfall Cycle')[1], { action: 'series', name: 'Ashfall Cycle', position: null });
	assert.deepStrictEqual(req('"The Salt Crown" series "Area 51"'), ['The Salt Crown', { action: 'series', name: 'Area 51', position: null }]);
	assert.deepStrictEqual(req('"The Salt Crown" series "Area 51" 3')[1].position, { text: '3', sequence: 3 });
	assert.deepStrictEqual(req('the salt crown series none')[1], { action: 'series', none: true });
	assert.deepStrictEqual(req('the salt crown author-series Ashfall Saga 4')[1], { action: 'author-series', name: 'Ashfall Saga', position: { text: '4', sequence: 4 } });
	assert.deepStrictEqual(req('the salt crown clear series')[1], { action: 'clear', field: 'series' });
	assert.deepStrictEqual(req('the salt crown clear all')[1], { action: 'clear', field: 'all' });
	assert.deepStrictEqual(req('the salt crown exclude')[1], { action: 'exclude' });
	assert.deepStrictEqual(req('the salt crown include')[1], { action: 'include' });
	assert.deepStrictEqual(req('the salt crown lookup')[1], { action: 'lookup' });
	// A title holding a field word: the exact title wins over "The" matching anything.
	assert.deepStrictEqual(req('The Narrator Wars narrator Bo Lind'), ['The Narrator Wars', { action: 'set', field: 'narrator', value: 'Bo Lind' }]);
	assert.deepStrictEqual(req('The Narrator Wars'), ['The Narrator Wars', { action: 'show' }]);

	assert.match(parse('the salt crown clear edition').error, /`clear` takes one of/);
	assert.match(parse('the salt crown lookup now').error, /takes no value/);
	assert.match(parse('the salt crown title').error, /`title` needs a value/);
	assert.match(parse('the salt crown series').error, /`series` needs a name/);
	assert.match(parse('the salt crown author-series Saga 1-4').error, /single number/);
	assert.match(parse(`the salt crown title ${'x'.repeat(301)}`).error, /longer than 300/);
	assert.match(parse('"The Salt Crown" colour blue').error, /Unknown detail "colour"/);
});

test('the slash options take a value whole, so a name ending in a number stays a name', () => {
	const opts = (values) => ({ options: { get: (n) => (values[n] === undefined ? null : { value: values[n] }) } });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT, field: 'series', value: 'Area 51' })), { workText: SALT, req: { action: 'series', name: 'Area 51', position: null } });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT, field: 'series', value: 'Area 51', position: '2' })).req.position, { text: '2', sequence: 2 });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT, field: 'series', value: 'none' })).req, { action: 'series', none: true });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT, field: 'clear', value: 'Narrator' })).req, { action: 'clear', field: 'narrator' });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT, field: 'title', value: 'New', position: '3' })).req, { action: 'set', field: 'title', value: 'New' });
	assert.deepStrictEqual(edit.parseSlash(opts({ title: SALT })), { workText: SALT, req: { action: 'show' } });
	assert.match(edit.parseSlash(opts({ title: SALT, field: 'series', position: '2' })).error, /needs a name/);
});

// ---- owner gate -----------------------------------------------------------------------------

test('only the configured owner may edit, and there is no bootstrap while ownerId is blank', async () => {
	config.ownerId = '';
	const blank = await runPrefix('the salt crown title Mine Now', ANA);
	assert.match(blank[0], /Set ownerId first/);
	config.ownerId = OWNER;
	const other = await runPrefix('the salt crown title Mine Now', ANA);
	assert.match(other[0], /Only the bot owner/);
	const viaSlash = await runSlash({ title: SALT, field: 'title', value: 'Mine Now' }, ANA);
	assert.match(viaSlash[0], /Only the bot owner/);
	assert.strictEqual(overridesFile(), null, 'nothing written');
	assert.strictEqual(catalog.work(SALT).title, 'The Salt Crown');
});

// ---- edits ----------------------------------------------------------------------------------

test('a title edit reaches every recording of the title and never changes an id', async () => {
	const before = ids();
	const replies = await runPrefix('The Far Shore title The Distant Shore');
	assert.match(replies[0], /The Distant Shore/);
	assert.ok(replies[0].includes(HARLOW) && replies[0].includes(PENROSE), replies[0]);
	assert.match(replies[0], /your edit wins over every other source/);
	assert.deepStrictEqual(overridesFile().works, { [HARLOW]: { title: 'The Distant Shore' }, [PENROSE]: { title: 'The Distant Shore' } });
	for (const id of [HARLOW, PENROSE]) {
		assert.strictEqual(catalog.work(id).title, 'The Distant Shore');
		assert.strictEqual(catalog.work(id).sources.title, 'override');
	}
	assert.deepStrictEqual(ids(), before);
	assert.strictEqual(catalog.findWorks('the distant shore').length, 2, 'found by its new title at once');
	assertPathFree(replies);
});

test('a series edit with a number reaches both narrations; without one the detected number stays', async () => {
	const replies = await runPrefix('the far shore series Tide Books 2');
	assert.match(replies[0], /series set to Tide Books #2/);
	for (const id of [HARLOW, PENROSE]) {
		const w = catalog.work(id);
		assert.deepStrictEqual([w.series, w.sequence, w.sources.series, w.sources.sequence], ['Tide Books', 2, 'override', 'override']);
	}
	await runPrefix(`${SALT} series Ashfall Chronicles`);
	const salt = catalog.work(SALT);
	assert.deepStrictEqual([salt.series, salt.sequence], ['Ashfall Chronicles', 2], 'the folder\'s number is kept');
	assert.deepStrictEqual(overridesFile().works[SALT], { series: 'Ashfall Chronicles' });
	const none = await runPrefix(`${SALT} series none`);
	assert.match(none[0], /no series from now on/);
	assert.deepStrictEqual([catalog.work(SALT).series, catalog.work(SALT).sequence], [null, null]);
	const range = await runPrefix(`${SALT} series Ashfall Omnibus 1-3`);
	assert.match(range[0], /range 1-3 is kept as no number/);
	assert.deepStrictEqual(overridesFile().works[SALT], { series: 'Ashfall Omnibus', sequence: null });
});

test('narrator, author and publisher change one recording, so two narrations need the id', async () => {
	const amb = await runPrefix('the far shore narrator Bo Lind');
	assert.match(amb[0], /changes one recording/);
	assert.ok(amb[0].includes(HARLOW) && amb[0].includes(PENROSE));
	assert.strictEqual(overridesFile(), null);
	const one = await runPrefix(`${HARLOW} narrator Bo Lind`);
	assert.match(one[0], /narrator set to Bo Lind/);
	assert.strictEqual(catalog.work(HARLOW).narrator, 'Bo Lind');
	assert.strictEqual(catalog.work(PENROSE).narrator, 'Penrose');
	await runPrefix(`${HARLOW} author Ilse M. Moreau`);
	assert.strictEqual(catalog.work(HARLOW).author, 'Ilse M. Moreau');
	assert.strictEqual(catalog.work(HARLOW).id, HARLOW, 'an author edit never renames');
	const none = await runPrefix(`${HARLOW} publisher none`);
	assert.match(none[0], /no publisher from now on/);
	assert.deepStrictEqual(overridesFile().works[HARLOW], { narrator: 'Bo Lind', author: 'Ilse M. Moreau', publisher: null });
});

test('clear falls back one layer, and clear all keeps exclude, part order and the pinned id', async () => {
	fs.writeFileSync(OVERRIDES, JSON.stringify({ include: ['Some/Folder'], works: { [HARLOW]: { narrator: 'Bo Lind', title: 'Shore', partOrder: ['Far Shore 02.mp3'], pinId: HARLOW, exclude: false } } }));
	catalog.refreshMetadata();
	assert.strictEqual(catalog.work(HARLOW).narrator, 'Bo Lind');
	const cleared = await runPrefix(`${HARLOW} clear narrator`);
	assert.match(cleared[0], /your narrator edit is cleared; it shows Harlow \(folder name\)/);
	assert.strictEqual(catalog.work(HARLOW).narrator, 'Harlow');
	const all = await runPrefix(`${HARLOW} clear all`);
	assert.match(all[0], /edits to its details are cleared/);
	const file = overridesFile();
	assert.deepStrictEqual(file.works[HARLOW], { partOrder: ['Far Shore 02.mp3'], pinId: HARLOW, exclude: false });
	assert.deepStrictEqual(file.include, ['Some/Folder'], 'an unwidened include key is written back as it was');
	assert.strictEqual(catalog.work(HARLOW).title, 'The Far Shore');
	const again = await runPrefix(`${HARLOW} clear narrator`);
	assert.match(again[0], /no narrator edit/);
	assert.ok(fs.existsSync(`${OVERRIDES}.bak`), 'the previous text is kept beside the file');
});

test('a clear with nothing to clear creates no overrides file', async () => {
	const r = await runPrefix(`${SALT} clear title`);
	assert.match(r[0], /no title edit/);
	assert.strictEqual(overridesFile(), null);
});

test('an edit made under an old id is cleared too, so it cannot show through', async () => {
	seed((c) => { c.works[SALT].aliases = ['avery-quill/salt-crown']; return c; });
	fs.writeFileSync(OVERRIDES, JSON.stringify({ works: { 'avery-quill/salt-crown': { title: 'Old Salt', narrator: 'Kept Reader' } } }));
	catalog.refreshMetadata();
	assert.strictEqual(catalog.work(SALT).title, 'Old Salt');
	await runPrefix(`${SALT} clear title`);
	assert.strictEqual(catalog.work(SALT).title, 'The Salt Crown');
	assert.deepStrictEqual(overridesFile().works, { 'avery-quill/salt-crown': { narrator: 'Kept Reader' } });
});

test('a pinned work\'s edits go under the id its pinId sits on, the one the build reads', async () => {
	seed((c) => {
		const w = c.works[SALT];
		delete c.works[SALT];
		c.works['pinned/salt'] = Object.assign(w, { id: 'pinned/salt', aliases: [SALT] });
		return c;
	});
	fs.writeFileSync(OVERRIDES, JSON.stringify({ works: { [SALT]: { pinId: 'pinned/salt' } } }));
	await runPrefix('pinned/salt narrator Bo Lind');
	assert.deepStrictEqual(overridesFile().works, { [SALT]: { pinId: 'pinned/salt', narrator: 'Bo Lind' } });
	assert.strictEqual(catalog.work('pinned/salt').narrator, 'Bo Lind');
});

test('author-series numbers a whole series through one author-level entry', async () => {
	const before = ids();
	fs.writeFileSync(OVERRIDES, JSON.stringify({ authors: { 'Ilse Moreau': { series: 'Moreau Books' } } }));
	await runPrefix('The Night Gate author-series Moreau Cycle 2');
	const replies = await runPrefix('The Far Shore author-series Moreau Cycle 1');
	assert.deepStrictEqual(overridesFile().authors, { 'ilse-moreau': { series: 'Moreau Cycle', order: { 'The Night Gate': 2, 'The Far Shore': 1 } } }, 'a hand-written key is folded into the slug key the build reads');
	assert.match(replies[0], /Moreau Cycle, for every Ilse Moreau book: The Far Shore #1 \(2 recordings\), The Night Gate #2 \(2 recordings\)/);
	for (const [id, n] of [[HARLOW, 1], [PENROSE, 1], ['ilse-moreau/the-night-gate~harlow', 2], ['ilse-moreau/the-night-gate~penrose', 2]]) {
		const w = catalog.work(id);
		assert.deepStrictEqual([w.series, w.sequence, w.sources.sequence], ['Moreau Cycle', n, 'override'], id);
	}
	assert.deepStrictEqual(ids(), before);
	const show = await runPrefix(HARLOW);
	assert.match(show[0], /\nSeries: Moreau Cycle #1 · your author-wide edit\n/, 'the number comes from the same author-wide edit');
	const gone = await runPrefix(`${HARLOW} clear author-series`);
	assert.match(gone[0], /author-wide series is cleared/);
	assert.strictEqual(overridesFile().authors, undefined);
	assert.strictEqual(catalog.work(HARLOW).series, null);
});

// ---- exclude and include --------------------------------------------------------------------

// The bug (review): the exclude was keyed by the work's id alone, which a rule change or a late tag
// can move, and a build already running was waited out by hand instead of through the queued
// rebuild bookLibrary offers.
test('exclude and include write the flag and the folder, and queue one rebuild behind any running one', async () => {
	const rebuilds = [];
	bookLibrary.rebuild = async (opts) => {
		rebuilds.push(opts || null);
		const excluded = new Set(Object.entries((overridesFile() || {}).works || {}).filter(([, e]) => e.exclude === true).map(([k]) => k));
		seed((c) => { for (const k of excluded) delete c.works[k]; return c; });
		return { ok: true };
	};
	bookmarks.record(ANA, catalog.work(SALT), { absoluteMs: 600000, guildId: G, addListenedMs: 60000 }, { force: true });

	const out = await runPrefix(`${SALT} exclude`);
	assert.deepStrictEqual(rebuilds, [{ force: true, after: 'current' }], 'one more build follows any build already running');
	assert.match(out[0], /Taking \*\*The Salt Crown\*\* out of the catalog.*about 20 s/);
	assert.match(out[0], /1 listener here has a place saved in it; it is kept and comes back with `!book edit avery-quill\/the-salt-crown include`/);
	assert.match(out[1], /is out of the catalog/);
	assert.deepStrictEqual(overridesFile().works[SALT], { exclude: true, folderKey: 'M:/Music/Avery Quill/2.The Salt Crown' });
	assert.strictEqual(catalog.work(SALT), null);
	assert.ok(bookmarks.get(ANA, SALT), 'the place is kept');

	const already = await runPrefix(`${SALT} exclude`);
	assert.match(already[0], /already out of the catalog/);
	rebuilds.length = 0;
	const back = await runPrefix('the salt crown include');
	assert.deepStrictEqual(rebuilds, [{ force: true, after: 'current' }]);
	assert.match(back[0], /Bringing `avery-quill\/the-salt-crown` back/);
	assert.match(back[1], /The Salt Crown\*\* is back in the catalog/);
	assert.strictEqual(overridesFile().works, undefined, 'an entry left empty is dropped');
	const twice = await runPrefix(`${SALT} include`);
	assert.match(twice[0], /already in the catalog/);
	assertPathFree([...out, ...back]);
});

test('a rebuild that does not finish says the change applies at the next rescan', async () => {
	bookLibrary.rebuild = async () => ({ ok: false, skipped: 'refreshing' });
	const out = await runPrefix(`${HARLOW} exclude`);
	assert.match(out[1], /did not finish \(Plex is scanning the library\)/);
	assert.strictEqual(overridesFile().works[HARLOW].exclude, true);
});

test('exclude names one recording', async () => {
	const out = await runPrefix('the far shore exclude');
	assert.match(out[0], /changes one recording/);
	assert.strictEqual(overridesFile(), null);
});

// ---- refusals -------------------------------------------------------------------------------

test('a broken overrides file is refused without its path, and left exactly as it was', async () => {
	const broken = '{ "works": { "a/b": { "title": "x", } } }';
	fs.writeFileSync(OVERRIDES, broken);
	const viaPrefix = await runPrefix(`${SALT} title Something Else`);
	assert.match(viaPrefix[0], /book_overrides\.json: the file is not valid JSON( \(line \d+ column \d+\))?, so nothing was changed/);
	const viaSlash = await runSlash({ title: SALT, field: 'series', value: 'Tide', position: '1' });
	assert.match(viaSlash[0], /not valid JSON/);
	assert.strictEqual(fs.readFileSync(OVERRIDES, 'utf8'), broken);
	assert.ok(!fs.existsSync(`${OVERRIDES}.bak`));
	assert.strictEqual(catalog.work(SALT).title, 'The Salt Crown');
	assertPathFree([...viaPrefix, ...viaSlash]);
});

test('an unknown book says so', async () => {
	const out = await runPrefix('Nothing Like This title X');
	assert.match(out[0], /Nothing in the audiobook library matches/);
	assert.strictEqual(overridesFile(), null);
});

// ---- prefix and slash -----------------------------------------------------------------------

test('prefix and slash reach the same handler and write the same file', async () => {
	await runPrefix('"The Salt Crown" series "Tide Books" 2');
	const fromPrefix = fs.readFileSync(OVERRIDES, 'utf8');
	fs.rmSync(OVERRIDES);
	seed();
	const s = slash({ title: SALT, field: 'series', value: 'Tide Books', position: '2' });
	assert.strictEqual(s.query, `edit ${SALT} series Tide Books 2`);
	await book.command.process(BOT, null, s.message, s.query);
	assert.strictEqual(fs.readFileSync(OVERRIDES, 'utf8'), fromPrefix);
	assert.match(text(s.calls[0]), /series set to Tide Books #2/);
	await runSlash({ title: SALT, field: 'series', value: 'Area 51' });
	assert.deepStrictEqual([catalog.work(SALT).series, catalog.work(SALT).sequence], ['Area 51', 2]);
});

test('the slash spec offers edit with its field choices, under the budget the validator checks', () => {
	const sub = book._internal.SUBCOMMANDS.find((s) => s.name === 'edit');
	assert.ok(sub);
	assert.deepStrictEqual(sub.options.map((o) => o.name), ['title', 'field', 'value', 'position']);
	const field = sub.options.find((o) => o.name === 'field');
	assert.deepStrictEqual(field.choices.map((c) => c.value), ['title', 'author', 'narrator', 'publisher', 'series', 'author-series', 'clear', 'exclude', 'include', 'lookup']);
	assert.match(book.command.usage, /\|edit>/);
	assert.match(book._internal.helpEmbed({ config }).data.description, /book edit <title>/);
});

// ---- show -----------------------------------------------------------------------------------

test('showing a book lists each detail with its source and its doubts, path-free', async () => {
	seed((c) => {
		c.works[HARLOW].doubts = [{ code: 'generic-folder', folder: 'Audio', albums: 2 }, { code: 'no-author' }];
		return c;
	});
	catalog.refreshMetadata();
	const out = await runPrefix('the far shore');
	const shown = out[0];
	assert.match(shown, new RegExp(`The Far Shore\\*\\* \\(\`${HARLOW.replace(/[~/]/g, '\\$&')}\`\\)`));
	assert.match(shown, /Title: The Far Shore · folder name/);
	assert.match(shown, /Author: Ilse Moreau · Plex/);
	assert.match(shown, /Narrator: Harlow · folder name/);
	assert.match(shown, /Series: -/);
	assert.match(shown, /Doubts: .*(generic|Audio).*;.*no author/);
	assert.ok(shown.includes(PENROSE), 'the other recording is named');
	assertPathFree(out);
	const help = await runPrefix('');
	assert.match(help[0], /author-series <name> \[number\]/);
	assert.match(help[0], /Title and series edits apply to every recording/);
});

// ---- lookup ---------------------------------------------------------------------------------

test('lookup says how to turn the setting on when it is off, and asks nothing', async () => {
	const out = await runPrefix(`${SALT} lookup`);
	assert.match(out[0], /online lookup is off.*audiobookOnlineLookup/);
});

test('lookup forces a fresh lookup of that book and reports what it filled', async () => {
	config.audiobookOnlineLookup = true;
	const calls = [];
	let cached = null;
	bookLookup.instance = () => ({
		isRunning: () => false,
		get: (w) => (cached && w.id === SALT ? cached : null),
		async refresh(works, opts) {
			calls.push([works.map((w) => w.id), opts]);
			cached = { outcome: 'book', fields: { publisher: 'Tin Roof Audio', series: 'Something Else', sequence: 9 } };
			return { enabled: true, counts: { book: 1 }, changed: [SALT], results: { [SALT]: { outcome: 'book', reason: null } } };
		},
	});
	const out = await runPrefix(`${SALT} lookup`);
	assert.deepStrictEqual(calls.map(([w, o]) => [w, o.force]), [[[SALT], true]]);
	assert.strictEqual(typeof calls[0][1].overrideOf, 'function', 'a locked or excluded book is still told apart');
	assert.match(out[0], /Looking up \*\*The Salt Crown\*\* online/);
	assert.match(out[1], /found the book; filled in publisher Tin Roof Audio/);
	const w = catalog.work(SALT);
	assert.deepStrictEqual([w.publisher, w.series, w.sequence], ['Tin Roof Audio', 'Ashfall', 2], 'online only fills blanks');

});

// The bug (review): a lookup asked for while a batch ran was refused, and every build starts one.
test('lookup waits for a running batch, then looks the book up', async () => {
	config.audiobookOnlineLookup = true;
	const calls = [];
	let running = true;
	bookLookup.instance = () => ({
		isRunning: () => running,
		get: () => null,
		async refresh(works) {
			calls.push(works.map((w) => w.id));
			if (running) { await new Promise((r) => setImmediate(r)); running = false; return { results: {} }; }
			return { results: { [SALT]: { outcome: 'none', reason: 'no-results' } } };
		},
	});
	const out = await runPrefix(`${SALT} lookup`);
	assert.deepStrictEqual(calls, [[], [SALT]], 'the running batch is waited on, then this book asked');
	assert.match(out.join('\n'), /not found online/);
});

test('waitForBatch gives up after its limit while a batch keeps running', async () => {
	const never = { isRunning: () => true, refresh: () => new Promise(() => {}) };
	assert.strictEqual(await edit.waitForBatch(never, 20), false);
	assert.strictEqual(await edit.waitForBatch({ isRunning: () => false }, 20), true);
});

test('lookup reports a skipped book with the reason in words', async () => {
	config.audiobookOnlineLookup = true;
	bookLookup.instance = () => ({
		isRunning: () => false,
		get: () => null,
		async refresh(works) { return { results: Object.fromEntries(works.map((w) => [w.id, { outcome: 'skipped', reason: 'doubtful' }])) }; },
	});
	const out = await runPrefix('the far shore lookup');
	assert.match(out[0], /\(2 recordings\)/);
	assert.match(out[1], /skipped, its grouping has doubts/);
});

// ---- chapter autocomplete -------------------------------------------------------------------

test('chapter autocomplete names what the track says and keeps the number to type', async () => {
	const work = catalog.work('r-j-ashdown/the-hollow-king');
	const chs = bookModel.chapters(work);
	const bot = { books: { session: () => ({ work }), position: () => chs[19].startMs + 1000 } };
	let answer = null;
	await book.command.slash.autocomplete({
		user: { id: ANA },
		guildId: G,
		options: { getFocused: () => ({ name: 'number', value: '' }), getSubcommand: () => 'chapter' },
		async respond(c) { answer = c; },
	}, bot);
	assert.strictEqual(answer.length, 25);
	for (const c of answer) {
		const ch = chs[c.value - 1];
		const label = chapterLabel(work, ch, chs).label;
		const name = `${c.value} · ${label} (${bookModel.formatSpan(ch.endMs - ch.startMs)})`;
		assert.ok(c.name === name || c.name === `▶ ${name}` || c.name.endsWith('…'), c.name);
	}
	assert.ok(answer.some((c) => /^(▶ )?\d+ · Book \d/.test(c.name)), answer.map((c) => c.name).join('\n'));
});
