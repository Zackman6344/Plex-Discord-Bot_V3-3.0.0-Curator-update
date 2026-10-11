// commands/book.js/text.js: `!book text` and `!book link`, through the real /book dispatcher.
//
// The bug: a reply that carries a line of the book, or tells the user to use `/config` (slash
// commands are not reachable for them); `!book link Fahrenheit 451` linking "Fahrenheit" to
// Calibre #451 instead of showing "Fahrenheit 451"; an ISBN-10 that never matches the ISBN-13
// Calibre stores; `!book link` usable by anyone while ownerId is blank (it reads files on this
// PC); a guild-channel `!book link <book>` that prints local paths for the whole channel.
//
// Harness: the real command module with recording prefix messages and slash interactions (as in
// test/bookCommand.test.js), and the real pager (helpers/readAlong.js) on
// test/helpers/readAlongFakes.js: a fake director, a fake source serving a synthetic ebook and
// answering link/describe, a fake Discord client. The catalog store is the real one on a
// pid-suffixed temp file, seeded with made-up works.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-text-command-${process.pid}`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-works.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const catalog = require('../helpers/bookCatalogStore.js');
const bookmarks = require('../helpers/bookmarks.js');
const textStore = require('../helpers/bookTextStore.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const { createReadAlong } = require('../helpers/readAlong.js');
const book = require('../commands/book.js');
const text = require('../commands/book.js/text.js');
const T = require('./helpers/readAlongFakes.js');

const OWNER = '100000000000000009';
const ANA = '100000000000000001';
const SECTIONS = [{ label: 'Chapter 1', words: 900 }, { label: 'Chapter 2', words: 900 }];

function work(id, title, author = 'Test Author') {
	return { id, kind: 'book', title, author, narrator: null, edition: null, publisher: null, series: null, sequence: null, aliases: [], parts: [{ ordinal: 1, title: 'Chapter 1', durationMs: 300000, trackRatingKey: `${id}-1`, file: 'a.mp3' }] };
}

const WORKS = [
	work('test-author/fahrenheit-451', 'Fahrenheit 451'),
	work('test-author/fahrenheit', 'Fahrenheit'),
	work('test-author/the-final-empire', 'The Final Empire')
];

const saved = { ownerId: config.ownerId, audiobooksEnabled: config.audiobooksEnabled, audiobookTextEnabled: config.audiobookTextEnabled };

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	bookmarks.reset();
	catalog.reset();
	textStore.reset();
}

let live = [];
test.beforeEach(() => {
	cleanup();
	catalog.replace({ meta: { builtAt: 1 }, works: JSON.parse(JSON.stringify(WORKS)) });
	config.ownerId = OWNER;
	config.audiobooksEnabled = true;
	config.audiobookTextEnabled = true;
});
test.afterEach(() => {
	for (const ra of live) ra.shutdown();
	live = [];
	Object.assign(config, saved);
	cleanup();
});
test.after(cleanup);

function harness({ playing = true } = {}) {
	const clock = T.manualClock();
	const sample = T.makeText(SECTIONS);
	const w = T.makeWork(SECTIONS);
	const books = T.fakeBooks(clock);
	const source = T.fakeSource(sample);
	const client = T.fakeClient();
	const ra = createReadAlong({ client, books, source, timers: clock, logger: { info() {}, warn() {}, error() {} }, catalog: { work: () => null } });
	live.push(ra);
	if (playing) books.add({ work: w, userId: ANA, audible: false });
	return { clock, books, source, client, ra, bot: { books, readAlong: ra } };
}

function prefixMessage(userId, query, { inGuild = true } = {}) {
	const calls = [];
	const user = { id: userId, username: 'Ana' };
	return {
		calls,
		author: user,
		member: inGuild ? { id: userId, user } : null,
		guild: inGuild ? { id: '200000000000000001' } : null,
		content: `!book ${query}`,
		channel: { id: '400000000000000001', name: inGuild ? 'books' : undefined, async send(p) { calls.push(['send', p]); return {}; } },
		async reply(p) { calls.push(['reply', p]); return {}; }
	};
}

async function run(h, userId, query, opts) {
	const m = prefixMessage(userId, query, opts);
	await book.command.process(h.bot, null, m, query);
	return m.calls.map(c => c[1].content).join('\n');
}

// ---- !book text -------------------------------------------------------------------------------

test('text on, now, status and off answer without any book text and point at !config, never /config', async () => {
	const h = harness();
	const replies = [];
	replies.push(await run(h, ANA, 'text'));
	replies.push(await run(h, ANA, 'text on'));
	replies.push(await run(h, ANA, 'text now'));
	replies.push(await run(h, ANA, 'text'));
	replies.push(await run(h, ANA, 'text off'));
	assert.match(replies[0], /off\*\* for you/);
	assert.match(replies[1], /Sent to your DMs/);
	assert.match(replies[2], /fresh page/);
	assert.match(replies[3], /text from Calibre #1, 1,800 words/);
	assert.match(replies[3], /chapter-level for 100% of the audio/);
	assert.match(replies[4], /Read-along is off/);
	config.audiobookTextEnabled = false;
	replies.push(await run(h, ANA, 'text on'));
	assert.match(replies[5], /`!config` → Audiobooks/);
	const all = replies.join('\n');
	assert.ok(!/alpha|bravo|charlie/.test(all), 'no book text in any reply');
	assert.ok(!/\/config/.test(all));
	assert.strictEqual(h.client.sent.length, 2, 'on and now each sent a DM page');
});

test('the preference is kept per user in the readers store, across books, until text off', async () => {
	const h = harness({ playing: false });
	await run(h, ANA, 'text on');
	assert.strictEqual(textStore.readers.isOn(ANA), true);
	textStore.reset();
	assert.strictEqual(textStore.readers.isOn(ANA), true, 'read back from disk');
	await run(h, ANA, 'text off');
	assert.strictEqual(textStore.readers.isOn(ANA), false);
});

test('text now with nothing playing says so', async () => {
	const h = harness({ playing: false });
	await run(h, ANA, 'text on');
	assert.match(await run(h, ANA, 'text now'), /not listening to a book/);
});

test('the slash form reaches the same handler: /book text mode:on', async () => {
	const h = harness();
	const calls = [];
	const interaction = {
		commandName: 'book', user: { id: ANA, username: 'Ana' }, member: { id: ANA }, guild: { id: 'g1' }, guildId: 'g1', client: {}, deferred: true,
		channel: { id: 'c1', async send(p) { calls.push(['send', p]); } },
		options: { data: [], getSubcommand: () => 'text', get: n => (n === 'mode' ? { name: 'mode', value: 'on' } : null), getUser: () => null },
		async editReply(p) { calls.push(['editReply', p]); return {}; },
		async followUp(p) { calls.push(['followUp', p]); return {}; }
	};
	const query = slashRegistry.buildQueryString(interaction, book.command.slash);
	assert.strictEqual(query, 'text on');
	await book.command.process(h.bot, null, adaptInteraction(interaction, query), query);
	assert.match(calls[0][1].content, /Sent to your DMs/);
});

// ---- !book link: parsing ----------------------------------------------------------------------

test('parseLinkArgs returns readings: quoted, explicit splits, candidate splits', () => {
	const cases = [
		['"The Final Empire" 299', { quoted: { workText: 'The Final Empire', target: { type: 'calibre', id: 299 } } }],
		['Final Empire id:299', { split: { workText: 'Final Empire', target: { type: 'calibre', id: 299 }, explicit: true } }],
		['Final Empire 299', { split: { workText: 'Final Empire', target: { type: 'calibre', id: 299 }, explicit: false } }],
		['Final Empire 076535038X', { split: { workText: 'Final Empire', target: { type: 'isbn', isbn: '076535038X' }, explicit: false } }],
		['Final Empire 978-0-7653-5038-1', { split: { workText: 'Final Empire', target: { type: 'isbn', isbn: '978-0-7653-5038-1' }, explicit: false } }],
		['Final Empire isbn:0765350386', { split: { workText: 'Final Empire', target: { type: 'isbn', isbn: '0765350386' }, explicit: true } }],
		['Final Empire D:\\My Books\\The Final Empire.epub', { split: { workText: 'Final Empire', target: { type: 'file', path: 'D:\\My Books\\The Final Empire.epub' }, explicit: true } }],
		['Final Empire "D:/My Books/x y.epub"', { split: { workText: 'Final Empire', target: { type: 'file', path: 'D:/My Books/x y.epub' }, explicit: true } }],
		['Final Empire /home/me/My Books/x.epub', { split: { workText: 'Final Empire', target: { type: 'file', path: '/home/me/My Books/x.epub' }, explicit: true } }],
		['Final Empire \\\\host\\share\\x.epub', { split: { workText: 'Final Empire', target: { type: 'file', path: '\\\\host\\share\\x.epub' }, explicit: true } }],
		['Final Empire //host/share/x.epub', { split: { workText: 'Final Empire', target: { type: 'file', path: '//host/share/x.epub' }, explicit: true } }],
		['Final Empire off', { split: { workText: 'Final Empire', target: { type: 'off' }, explicit: true } }],
		['Final Empire AUTO', { split: { workText: 'Final Empire', target: { type: 'auto' }, explicit: true } }],
		['Final Empire', {}],
		['Fahrenheit 451', { split: { workText: 'Fahrenheit', target: { type: 'calibre', id: 451 }, explicit: false } }]
	];
	for (const [input, want] of cases) assert.deepStrictEqual(text.parseLinkArgs(input), Object.assign({ whole: input }, want), input);
});

test('isbn13 turns an ISBN-10 into the ISBN-13 Calibre stores', () => {
	assert.strictEqual(text.isbn13('0765350386'), '9780765350381');
	assert.strictEqual(text.isbn13('0-7653-5038-6'), '9780765350381');
	assert.strictEqual(text.isbn13('9780765350381'), '9780765350381');
	assert.strictEqual(text.isbn13('12345'), null);
});

// ---- !book link: resolving --------------------------------------------------------------------

test('"!book link Fahrenheit 451" describes Fahrenheit 451 and links nothing', async () => {
	const h = harness();
	const out = await run(h, OWNER, 'link Fahrenheit 451');
	assert.ok(!h.source.calls.some(c => c[0] === 'link'));
	assert.ok(h.source.calls.some(c => c[0] === 'describe' && c[1] === 'test-author/fahrenheit-451'));
	assert.match(out, /Fahrenheit 451/);
});

test('"!book link Final Empire 299" links that work to Calibre #299 and echoes it', async () => {
	const h = harness();
	const out = await run(h, OWNER, 'link Final Empire 299');
	const call = h.source.calls.find(c => c[0] === 'link');
	assert.deepStrictEqual(call.slice(1, 3), ['test-author/the-final-empire', { type: 'calibre', id: 299 }]);
	assert.strictEqual(call[3].by, OWNER);
	assert.match(out, /Linked The Final Empire to Calibre #299/);
});

test('a quoted title or an explicit target always links', async () => {
	const h = harness();
	await run(h, OWNER, 'link "Fahrenheit 451" id:12');
	await run(h, OWNER, 'link Fahrenheit off');
	const links = h.source.calls.filter(c => c[0] === 'link').map(c => [c[1], c[2]]);
	assert.deepStrictEqual(links, [['test-author/fahrenheit-451', { type: 'calibre', id: 12 }], ['test-author/fahrenheit', { type: 'off' }]]);
});

test('a trailing number that is not a known title shows the usage, never a guess', async () => {
	const h = harness();
	const out = await run(h, OWNER, 'link Nothing Like This 12');
	assert.match(out, /Usage/);
	assert.ok(!h.source.calls.some(c => c[0] === 'link'));
});

test('link needs a configured owner, and only the owner may use it', async () => {
	const h = harness();
	config.ownerId = '';
	assert.match(await run(h, OWNER, 'link Fahrenheit off'), /Set ownerId first \(`!config` → Access\)/);
	config.ownerId = OWNER;
	assert.match(await run(h, ANA, 'link Fahrenheit off'), /Only the bot owner/);
	assert.ok(!h.source.calls.some(c => c[0] === 'link' || c[0] === 'describe'));
});

test('in a guild channel the details name files only, and the full paths go to the owner by DM', async () => {
	const h = harness();
	const out = await run(h, OWNER, 'link The Final Empire');
	assert.ok(!/[A-Za-z]:[\\/]/.test(out), out);
	assert.ok(!/(^|[\s(“"])\/\w/.test(out), out);
	assert.match(out, /The Fake Book\.epub/);
	assert.match(out, /Full details \(with paths\) sent to your DMs/);
	assert.strictEqual(h.client.sent.length, 1);
	assert.match(h.client.sent[0].first.content, /D:\/Media\/Books\/Fake Book\/The Fake Book\.epub/);
});

test('in a DM the details show the full paths', async () => {
	const h = harness();
	const out = await run(h, OWNER, 'link The Final Empire', { inGuild: false });
	assert.match(out, /D:\/Media\/Books\/Fake Book\/The Fake Book\.epub/);
	assert.strictEqual(h.client.sent.length, 0);
});

test('with DMs closed the guild reply says how to see the paths instead', async () => {
	const h = harness();
	h.client.dmFail = 50007;
	const out = await run(h, OWNER, 'link The Final Empire');
	assert.match(out, /can't DM you; run `!book link test-author\/the-final-empire` in a DM/);
	assert.ok(!/[A-Za-z]:[\\/]/.test(out));
});

test('the sub-help lists the read-along and still fits an embed', async () => {
	const sent = [];
	await book.command.process({ config: { commandPrefix: '!' } }, null, { channel: { async send(p) { sent.push(p); } } }, '?');
	const d = sent[0].embeds[0].data.description;
	assert.match(d, /READ ALONG/);
	assert.match(d, /`!book text on`/);
	assert.match(d, /`!book link <title>/);
	assert.ok(d.length <= 4096, `${d.length}`);
});
