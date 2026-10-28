// commands/book.js/calibre.js: `!book calibre`, the owner's list of audiobooks with no Calibre match.
//
// The bug: Calibre matched 4 of 73 audiobooks and nothing told the owner which ones were missing,
// which had several candidates, or whether Calibre had even answered, so curating the Calibre
// library meant guessing. A long list must also fit Discord's 2,000-character messages.
//
// Harness: the real command through book.command.process, the real catalog store on a pid-suffixed
// temp file seeded from the fixture catalog, and a fake Calibre index in place of
// calibreIndex.instance(). reportChunks is also driven directly with a large synthetic catalog.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-calibre-${process.pid}`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = `${BASE}-overrides.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const catalog = require('../helpers/bookCatalogStore.js');
const calibreIndex = require('../helpers/calibreIndex.js');
const book = require('../commands/book.js');
const calibre = require('../commands/book.js/calibre.js');
const fixture = require('./fixtures/books/catalog.json');

const G = '200000000000000001';
const OWNER = '100000000000000009';
const OTHER = '100000000000000001';
const NOW = Date.UTC(2026, 9, 27, 12);

const saved = { audiobooksEnabled: config.audiobooksEnabled, ownerId: config.ownerId, instance: calibreIndex.instance };

function fakeIndex({ enabled = true, configured = true, matches = {}, records = {}, status = {} } = {}) {
	const f = {
		refreshes: [],
		enabled: () => enabled,
		configured: () => configured,
		matchFor: (w) => matches[w.id] || null,
		recordOf: (id) => records[id] || null,
		status: () => ({ libraryId: 'Test_Library', fetchedAt: NOW - 60000, checkedAt: NOW - 60000, books: Object.keys(records).length, answered: true, lastError: null, lastAttemptAt: NOW - 60000, backoffUntil: null, running: false, ...status }),
		refresh(opts) { f.refreshes.push(opts); return Promise.resolve({ ok: true, books: 3 }); },
	};
	return f;
}

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	catalog.reset();
}

test.beforeEach(() => {
	cleanup();
	catalog.replace(JSON.parse(JSON.stringify(fixture)));
	config.audiobooksEnabled = true;
	config.ownerId = OWNER;
});
test.afterEach(() => {
	config.audiobooksEnabled = saved.audiobooksEnabled;
	config.ownerId = saved.ownerId;
	calibreIndex.instance = saved.instance;
	cleanup();
});
test.after(cleanup);

const BOT = { books: { session: () => null, position: () => 0 } };

async function run(query, who = OWNER) {
	const calls = [];
	const m = {
		author: { id: who, username: who },
		member: { id: who, user: { id: who }, voice: {} },
		guild: { id: G },
		content: `!book ${query}`,
		mentions: { users: { first: () => undefined } },
		channel: { id: '400000000000000001', async send(p) { calls.push(p); return {}; } },
		async reply(p) { calls.push(p); return {}; },
	};
	await book.command.process(BOT, null, m, query);
	return calls.map((p) => (typeof p === 'string' ? p : p.content));
}

test('the report is owner-only, and says how to turn the index on when it is off', async () => {
	calibreIndex.instance = () => fakeIndex();
	assert.match((await run('calibre', OTHER))[0], /Only the bot owner/);
	calibreIndex.instance = () => fakeIndex({ enabled: false });
	assert.match((await run('calibre'))[0], /audiobookCalibreSort/);
	calibreIndex.instance = () => fakeIndex({ enabled: false, configured: false });
	assert.match((await run('calibre'))[0], /Calibre is not set up\. Set `calibreUrl`/);
	assert.match((await run('calibre sideways'))[0], /takes missing \(the default\), all or refresh/);
});

test('it counts every audiobook, lists the ambiguous ones with candidate ids and the ones with no match', async () => {
	const idx = fakeIndex({
		matches: {
			'avery-quill/the-ember-throne': { id: 299, verdict: 'exact', method: 'series, number and author' },
			'avery-quill/the-salt-crown': { id: 12, verdict: 'exact', method: 'pin' },
			'avery-quill/the-glass-road': { id: null, verdict: 'ambiguous', method: 'title and author', candidates: [80, 81] },
			'corin-vale/the-long-tide': { id: 5, verdict: 'none', method: 'pin', problem: 'uuid-changed' },
			'ilse-moreau/the-glass-sea': { id: null, verdict: 'none', method: 'pin' },
			'r-j-ashdown/the-hollow-king': { id: 350, verdict: 'likely', method: 'title overlap 0.67 and author' },
		},
		records: { 80: { title: 'The Glass Road' }, 81: { title: 'The Glass Road' }, 299: { title: 'Ashfall' }, 12: { title: 'Saltborn' }, 350: { title: 'The Hollow King Omnibus' } }
	});
	calibreIndex.instance = () => idx;
	const out = (await run('calibre')).join('\n');
	assert.match(out, /15 audiobooks: 1 exact, 1 pinned, 1 likely, 1 ambiguous, 10 with no match, 1 set to none/);
	assert.match(out, /Calibre library "Test\\_Library": 5 books in the saved copy, read <t:\d+:R>\./);
	assert.match(out, /Calibre answered at the last check/);
	assert.match(out, /pinned to #5, but that id is another book now/);
	assert.match(out, /\*\*The Glass Road\*\* \(GraphicAudio\) · Avery Quill: #80 “The Glass Road”, #81 “The Glass Road”/);
	assert.match(out, /\*\*No Calibre match\*\* \(9\)/);
	assert.match(out, /The Far Shore\*\* \(Harlow\)[^\n]*\n• \*\*The Far Shore\*\* \(Penrose\)/, 'two narrations are told apart');
	assert.doesNotMatch(out, /Tin Valley/, 'podcasts are not audiobooks here');
	assert.doesNotMatch(out, /\*\*Matched\*\*/);
	assert.match(out, /a record with no file is fine/);
	const all = (await run('calibre all')).join('\n');
	assert.match(all, /\*\*Matched\*\* \(3\)/);
	assert.match(all, /\*\*The Ember Throne\*\*[^\n]* · Avery Quill: #299 “Ashfall” \(exact: series, number and author\)/);
	assert.match(all, /\*\*Set to none\*\* \(1\)/);
});

test('a Calibre that did not answer is reported with the saved copy\'s age and the next try', async () => {
	calibreIndex.instance = () => fakeIndex({ status: { answered: false, lastError: 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).', backoffUntil: NOW + 900000 } });
	const out = (await run('calibre')).join('\n');
	assert.match(out, /Calibre did not answer at the last check <t:\d+:R> \(Calibre at 127\.0\.0\.1:8080 is not answering \(ECONNREFUSED\)\.\)\. The saved copy is used\. The next automatic try is <t:\d+:R>\./);
});

test('refresh, or a library never read, starts a background read and answers at once', async () => {
	const idx = fakeIndex();
	calibreIndex.instance = () => idx;
	const out = await run('calibre refresh');
	assert.match(out[0], /Reading the Calibre library in the background/);
	assert.deepStrictEqual(idx.refreshes, [{ force: true }]);
	const fresh = fakeIndex({ status: { fetchedAt: null } });
	calibreIndex.instance = () => fresh;
	assert.match((await run('calibre'))[0], /has not been read yet/);
	assert.deepStrictEqual(fresh.refreshes, [{ force: true }]);
});

// The bug: until the first successful read, every `!book calibre` answered "Reading the Calibre
// library in the background", so a closed Calibre or a wrong password was never shown.
test('a library never read that did not answer last time says why, and tries again', async () => {
	const idx = fakeIndex({ status: { fetchedAt: null, answered: false, lastError: 'Calibre at host asked for a login.' } });
	calibreIndex.instance = () => idx;
	const out = (await run('calibre'))[0];
	assert.match(out, /^📚 The Calibre library has not been read yet\. Calibre did not answer the last time <t:\d+:R> \(Calibre at host asked for a login\.\)\. Trying again in the background\./);
	assert.doesNotMatch(out, /—/);
	assert.deepStrictEqual(idx.refreshes, [{ force: true }]);
});

test('a long report is cut into at most 5 messages of 1,900 characters', () => {
	const works = [];
	for (let i = 0; i < 400; i++) works.push({ id: `avery-quill/book-${i}`, kind: 'book', title: `A Rather Long Audiobook Title Number ${i} of the Collection`, author: 'Avery Quill' });
	const chunks = calibre.reportChunks(works, fakeIndex(), 'missing');
	assert.strictEqual(chunks.length, 5);
	for (const c of chunks) assert.ok(c.length <= 2000, `${c.length}`);
	assert.match(chunks[4], /…and more/);
	assert.match(chunks[0], /400 audiobooks: 0 exact, 0 pinned, 0 likely, 0 ambiguous, 400 with no match/);
});

test('the slash spec offers calibre with its choices, within Discord\'s limits', () => {
	const subs = book._internal.SUBCOMMANDS;
	assert.ok(subs.length <= 25);
	const sub = subs.find((s) => s.name === 'calibre');
	assert.deepStrictEqual(sub.options[0].choices.map((c) => c.value), ['missing', 'all', 'refresh']);
	const field = subs.find((s) => s.name === 'edit').options.find((o) => o.name === 'field');
	assert.ok(field.choices.length <= 25);
	assert.match(book._internal.helpEmbed({ config }).data.description, /book calibre \[all\|refresh\]/);
});
