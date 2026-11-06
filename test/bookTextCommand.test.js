// commands/book.js/text.js: `!book text` and `!book link`, through the real /book dispatcher.
//
// The bug: a reply that carries a line of the book, or tells the user to use `/config` (slash
// commands are not reachable for them); `!book link Fahrenheit 451` linking "Fahrenheit" to
// Calibre #451 instead of showing "Fahrenheit 451"; an ISBN-10 that never matches the ISBN-13
// Calibre stores; `!book link` usable by anyone while ownerId is blank (it reads files on this
// PC); a guild-channel `!book link <book>` that prints local paths for the whole channel.
//
// The PDF pictures' owner controls ride on `!book link <book> pictures:redo|off|on`: the bug would
// be one that relinks the ebook or refreshes the catalog, one anyone may use, or a `!book link
// <book>` report that names a picture's path.
//
// Harness: the real command module with recording prefix messages and slash interactions (as in
// test/bookCommand.test.js), and the real pager (helpers/readAlong.js) on
// test/helpers/readAlongFakes.js: a fake director, a fake source serving a synthetic ebook and
// answering link/describe, fake pictures answering describe/command, a fake Discord client. The
// catalog store is the real one on a pid-suffixed temp file, seeded with made-up works.

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
	const pictures = T.fakePictures();
	const client = T.fakeClient();
	const ra = createReadAlong({ client, books, source, pictures, timers: clock, logger: { info() {}, warn() {}, error() {} }, catalog: { work: () => null } });
	live.push(ra);
	if (playing) books.add({ work: w, userId: ANA, audible: false });
	return { clock, books, source, pictures, client, ra, bot: { books, readAlong: ra } };
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

// The bug: Calibre had the playing book only as AZW3, and `!book text` gave no hint that its text
// would be converted on first open, or why there was no 📖 when it could not be.
test('text status says when the book is converted from MOBI or AZW3 on its first open', async () => {
	const h = harness();
	h.source.statusValue = 'available';
	h.source.probeValue = 'available';
	h.source.pendingConversion = () => 'azw3';
	const out = await run(h, ANA, 'text');
	assert.match(out, /an ebook was found/);
	assert.match(out, /\n🔄 Calibre has this book as AZW3; it is converted to EPUB the first time its text opens, which takes from a few seconds to a minute\.$/);
	h.source.pendingConversion = () => null;
	assert.doesNotMatch(await run(h, ANA, 'text'), /🔄/);
	assert.doesNotMatch(out, /—/);
});

// The bug: after a conversion timed out, a plain `!book text` opened the book explicitly, which
// skips the 10-minute back-off, so asking for the status started another conversion of up to 5
// minutes and the reply waited for it.
test('text status during a conversion timeout\'s back-off reports it without opening the book', async () => {
	const h = harness();
	h.source.statusValue = 'unknown';
	h.source.probeValue = 'unknown';
	h.source.lastFailure = () => ({ code: 'convert-timeout', text: 'Converting this ebook to EPUB took too long. Try again in a few minutes.' });
	const out = await run(h, ANA, 'text');
	assert.match(out, /: Converting this ebook to EPUB took too long\. Try again in a few minutes\.$/);
	assert.ok(!h.source.calls.some((c) => c[0] === 'open'), h.source.calls.map((c) => c[0]).join(','));
	h.source.lastFailure = () => ({ code: 'calibre-unreachable', text: 'Calibre isn\'t answering.' });
	await run(h, ANA, 'text');
	assert.ok(h.source.calls.some((c) => c[0] === 'open'), 'any other failure is asked again, as before');
});

test('the link details name each Calibre candidate\'s format and whether ebook-convert can run', () => {
	const base = {
		workId: 'test-author/the-final-empire', title: 'The Final Empire', status: 'available', link: null, cache: null, lastError: null,
		candidates: {
			calibre: [
				{ id: 352, title: 'Hollow Book', epub: false, format: 'mobi', accepted: true },
				{ id: 12, title: 'Scanned', epub: false, format: null, accepted: false },
				{ id: 7, title: 'Plain', epub: true, format: 'epub', accepted: false }
			],
			sidecars: [], calibreError: null
		}
	};
	const ready = text.formatDescribe({ ...base, converter: { ok: true } }, '!');
	assert.match(ready, /#352 “Hollow Book” \(MOBI, converted to EPUB\) ✅ · #12 “Scanned” \(no EPUB, and no format that converts\) · #7 “Plain”/);
	assert.match(ready, /🔄 A book Calibre has only as MOBI, AZW3 or similar is converted to EPUB with Calibre's ebook-convert the first time its text opens/);
	assert.match(text.formatDescribe({ ...base, converter: { ok: false, code: 'convert-off' } }, '!'), /🔄 Converting MOBI or AZW3 ebooks to EPUB is turned off \(audiobookTextConvert in `!config` → Audiobooks\)/);
	assert.match(text.formatDescribe({ ...base, converter: { ok: false, code: 'convert-missing', reason: 'not-found' } }, '!'), /🔄 Calibre's ebook-convert wasn't found on this PC/);
	assert.match(text.formatDescribe({ ...base, converter: { ok: false, code: 'convert-missing', reason: 'not-converter' } }, '!'), /🔄 calibreConvertPath doesn't point at Calibre's ebook-convert/);
	const epubOnly = { ...base, converter: { ok: true }, candidates: { calibre: [base.candidates.calibre[2]], sidecars: [], calibreError: null } };
	assert.doesNotMatch(text.formatDescribe(epubOnly, '!'), /🔄/);
});

test('the link details add the PDF pictures line and flag each Calibre candidate\'s PDF', () => {
	const MB = 1048576;
	const base = {
		workId: 'test-author/the-final-empire', title: 'The Final Empire', status: 'ready', link: null, cache: null, lastError: null, converter: { ok: true },
		candidates: {
			calibre: [
				{ id: 384, title: 'Illustrated', epub: true, format: 'epub', pdf: true, accepted: true },
				{ id: 383, title: 'Converted', epub: false, format: 'azw3', pdf: true, accepted: false },
				{ id: 12, title: 'Scanned', epub: false, format: null, pdf: true, accepted: false },
				{ id: 7, title: 'Plain', epub: true, format: 'epub', pdf: false, accepted: false }
			],
			sidecars: [], calibreError: null
		}
	};
	const pdf = { id: 384, size: 29224426, mtime: '2026-11-05T19:48:19.486724+00:00' };
	const at = `<t:${Math.round(Date.parse(pdf.mtime) / 1000)}:d>`;
	const show = pictures => text.formatDescribe({ ...base, pictures }, '!');
	const none = show(null);
	assert.match(none, /#384 “Illustrated”, \+ PDF ✅ · #383 “Converted” \(AZW3, converted to EPUB\), \+ PDF · #12 “Scanned” \(PDF only: no text, so no pictures either\) · #7 “Plain”(\n|$)/);
	assert.doesNotMatch(none, /🖼|pictures:redo/, 'no report, no line');
	const ready = show({ state: 'ready', pdfId: 384, pdf, pages: 264, count: 60, quality: { share: 0.977 } });
	assert.match(ready, new RegExp(`\\n🖼 Pictures: 60 from Calibre #384's PDF \\(${(pdf.size / MB).toFixed(1)} MB, 264 pages, ${at}\\), lined up with this text \\(98% of its pages placed\\)\\.\\n`));
	assert.match(ready, /`off` or `auto`\. `pictures:redo`, `pictures:off` or `pictures:on` reads its PDF again, hides or shows the pictures\.$/);
	assert.match(show({ state: 'ready', pdf, count: 0 }), /🖼 Pictures: none found in Calibre #384's PDF \(27\.9 MB, <t:\d+:d>\)\./);
	assert.match(show({ state: 'available', pdfId: 384, pdf }), /🖼 Pictures: Calibre #384's PDF \(27\.9 MB, <t:\d+:d>\) is read the next time this book's text opens\./);
	assert.match(show({ state: 'running', pdfId: 384, progress: { stage: 'render', done: 120, total: 264 } }), /🖼 Pictures: reading Calibre #384's PDF, page 120 of 264\./);
	assert.match(show({ state: 'running', pdfId: 384, progress: { stage: 'find', done: 300, total: 264 } }), /🖼 Pictures: reading Calibre #384's PDF, page 264 of 264\./);
	// pdftotext reads the whole text layer as one step of one: no "page 1 of 1" for a 264-page PDF.
	for (const done of [0, 1]) assert.match(show({ state: 'running', pdfId: 384, progress: { stage: 'text', done, total: 1 } }), /🖼 Pictures: reading Calibre #384's PDF\.\n/);
	assert.match(show({ state: 'failed', pdfId: 384, code: 'pdf-encrypted' }), /🖼 Pictures: none from Calibre #384's PDF: it is encrypted\./);
	assert.match(show({ state: 'failed', pdfId: 384, code: 'align-failed', quality: { share: 0.12 } }), /: its pages don't match this ebook \(12% of its pages placed\)\./);
	const soon = Date.now() + 120000;
	assert.match(show({ state: 'waiting', pdfId: 384, code: 'calibre-unreachable', retryAt: soon }), new RegExp(`🖼 Pictures: reading Calibre #384's PDF failed \\(Calibre isn't answering\\); it tries again <t:${Math.round(soon / 1000)}:R>\\.`));
	// Only a text open moves a wait on: hours later, with nobody reading, the time has passed.
	assert.match(show({ state: 'waiting', pdfId: 384, code: 'calibre-unreachable', retryAt: Date.now() - 3 * 3600000 }), /🖼 Pictures: reading Calibre #384's PDF failed \(Calibre isn't answering\); it tries again the next time the book's text opens\./);
	assert.match(show({ state: 'waiting', pdfId: 384, code: 'pdf-missing', retryAt: soon }), /🖼 Pictures: reading Calibre #384's PDF failed \(Calibre lists a PDF but has no file for it\); it tries again <t:\d+:R>\./);
	assert.match(show({ state: 'waiting', pdfId: 384, code: 'disk-error', retryAt: soon }), /🖼 Pictures: reading Calibre #384's PDF failed \(the bot couldn't read or write its picture files\); it tries again <t:\d+:R>\./);
	assert.match(show({ state: 'failed', pdfId: 384, code: 'gave-up' }), /🖼 Pictures: none from Calibre #384's PDF: reading it failed 3 times\./);
	assert.match(show({ state: 'off', count: 60 }), /🖼 Pictures: off for every book \(audiobookTextPictures in `!config` → Audiobooks\); 60 kept\./);
	assert.match(show({ state: 'book-off', pdfId: 384 }), /🖼 Pictures: switched off for this book\./);
	assert.match(show({ state: 'no-pdf', pdfId: 384 }), /🖼 Pictures: none; Calibre #384 has no PDF\./);
	assert.match(show({ state: 'no-pdf', pdfId: 384, code: 'record-changed' }), /🖼 Pictures: none; Calibre #384 no longer holds the book this text came from\./);
	assert.match(show({ state: 'no-pdf', pdfId: 384, code: 'pdf-only' }), /🖼 Pictures: none; Calibre #384 has only its PDF left, no text to line it up with\./);
	assert.match(show({ state: 'failed', pdfId: 384, code: 'bad-result' }), /🖼 Pictures: none from Calibre #384's PDF: the PDF reader left no usable pictures\./);
	assert.match(show({ state: 'unknown' }), /🖼 Pictures: not checked yet; the PDF is looked for when the text first opens\./);
	// The record check itself failed, so whether the record has a PDF is not known.
	assert.match(show({ state: 'unknown', pdfId: 384, code: 'calibre-unreachable' }), /🖼 Pictures: not checked \(Calibre isn't answering\)\./);
	assert.match(show({ state: 'unknown', pdfId: 384, code: 'calibre-off' }), /🖼 Pictures: not checked \(Calibre is turned off\)\./);
	assert.match(show({ state: 'unknown', pdfId: 384, code: 'calibre-auth' }), /🖼 Pictures: not checked \(Calibre asked for a login\)\./);
	assert.match(show({ state: 'tools-missing' }), /🖼 Pictures: Calibre's PDF tools weren't found on this PC; install Calibre here\./);
	const file = show({ state: 'not-calibre' });
	assert.match(file, /🖼 Pictures: none; only a PDF on the Calibre record the text comes from has them\./);
	assert.doesNotMatch(file, /pictures:redo/, 'nothing to redo for an EPUB file');
	for (const out of [none, ready, file]) assert.doesNotMatch(out, /—|[A-Za-z]:[\\/]/);
});

// Every state and code helpers/bookPictures.js's describe() can report, with and without the
// PDF's facts: no line may read "undefined", "null" or "NaN", and a failure is named in words.
test('the pictures line has words for every state and code the pictures can report', () => {
	const STATES = ['off', 'book-off', 'not-calibre', 'unknown', 'no-pdf', 'available', 'checking', 'queued', 'downloading', 'running', 'aligning', 'ready', 'failed', 'waiting', 'tools-missing'];
	const FAILED = ['pdf-encrypted', 'pdf-damaged', 'no-text-layer', 'too-large', 'gave-up', 'align-failed', 'bad-result', 'disk-error'];
	const WAITING = ['calibre-unreachable', 'calibre-auth', 'calibre-off', 'io-error', 'pdf-missing', 'disk-error', 'timeout', 'crash'];
	const UNKNOWN = ['calibre-unreachable', 'calibre-off', 'calibre-auth', 'io-error'];
	const CODES = [null, undefined, 'no-pdf', 'record-changed', 'pdf-only', 'tools-missing', 'cancelled', 'shutdown', ...FAILED, ...WAITING];
	const full = { pdfId: 384, pdf: { id: 384, size: 29224426, mtime: '2026-11-05T19:48:19.486724+00:00' }, pages: 264, count: 116, found: 121, share: 0.968, quality: { textPages: 217, aligned: 210, share: 0.968 }, progress: { stage: 'render', done: 120, total: 264 }, retryAt: Date.now() + 600000 };
	const bare = { pdfId: null, pdf: null, pages: null, count: null, found: null, share: null, quality: null, progress: null, retryAt: null };
	const lineOf = r => text.formatDescribe({ workId: 'test-author/x', title: 'X', status: 'ready', link: null, cache: null, lastError: null, candidates: {}, pictures: r }, '!').split('\n').find(l => l.startsWith('🖼'));
	for (const state of STATES) {
		for (const code of CODES) {
			for (const facts of [full, bare]) {
				const line = lineOf(Object.assign({ enabled: true, state, code, off: false, offBy: null, offAt: null, key: null, base: null }, facts));
				assert.ok(line, `${state}/${code}`);
				assert.doesNotMatch(line, /undefined|null|NaN|\[object/, `${state}/${code}: ${line}`);
			}
		}
	}
	for (const [state, codes] of [['failed', FAILED], ['waiting', WAITING], ['unknown', UNKNOWN]]) {
		for (const code of codes) {
			const line = lineOf(Object.assign({ state, code }, full));
			assert.ok(!line.includes(code), `${state}/${code} is named in words: ${line}`);
		}
	}
});

test('text status carries the pictures\' own 🖼 line', async () => {
	const h = harness();
	await run(h, ANA, 'text on');
	h.pictures.statusValue = { state: 'ready', count: 4 };
	const out = await run(h, ANA, 'text');
	assert.match(out, /\n🖼 ready: 4 pictures \(!book link\)\n📩 Your page is in your DMs\.$/);
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
		['Fahrenheit 451', { split: { workText: 'Fahrenheit', target: { type: 'calibre', id: 451 }, explicit: false } }],
		['Final Empire pictures:redo', { split: { workText: 'Final Empire', target: { type: 'pictures', action: 'redo' }, explicit: true } }],
		['"Fahrenheit 451" Pictures:OFF', { quoted: { workText: 'Fahrenheit 451', target: { type: 'pictures', action: 'off' } } }],
		['test-author/the-final-empire pictures:on', { split: { workText: 'test-author/the-final-empire', target: { type: 'pictures', action: 'on' }, explicit: true } }],
		['Final Empire pictures:delete', {}]
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

// The bug (review): a new link changed which Calibre book fills the blanks, but the catalog kept
// the old fills until the next rebuild.
test('a successful link lays the metadata over the catalog again, and a refused one does not', async (t) => {
	const refreshed = t.mock.method(catalog, 'refreshMetadata', () => ({ ok: true }));
	const h = harness();
	await run(h, OWNER, 'link Final Empire 299');
	assert.strictEqual(refreshed.mock.callCount(), 1);
	h.source.link = async () => ({ ok: false, code: 'not-found', text: 'No such book.' });
	await run(h, OWNER, 'link Final Empire 300');
	assert.strictEqual(refreshed.mock.callCount(), 1);
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

// The bug: "!book link auto" took "auto" as a title and answered 'Nothing in the audiobook
// library matches "auto"'.
test('a link target with no book applies to the book playing here, else your newest bookmark, and says which', async () => {
	const h = harness();
	const GUILD = '200000000000000001';
	let playing = 'test-author/fahrenheit';
	h.books.session = (guildId) => (guildId === GUILD && playing ? { workId: playing, work: catalog.work(playing) } : null);
	const here = await run(h, OWNER, 'link auto');
	assert.match(here, /^📖 For \*\*Fahrenheit\*\*, the book playing here:\n🔗 Linked Fahrenheit/);
	await run(h, OWNER, 'link id:12');
	playing = null;
	bookmarks.record(OWNER, catalog.work('test-author/fahrenheit-451'), { absoluteMs: 600000 }, { force: true });
	bookmarks.record(OWNER, catalog.work('test-author/the-final-empire'), { absoluteMs: 900000 }, { force: true });
	const mine = await run(h, OWNER, 'link off');
	assert.match(mine, /^📖 For \*\*The Final Empire\*\*, your most recent book:/);
	const links = h.source.calls.filter(c => c[0] === 'link').map(c => [c[1], c[2]]);
	assert.deepStrictEqual(links, [
		['test-author/fahrenheit', { type: 'auto' }],
		['test-author/fahrenheit', { type: 'calibre', id: 12 }],
		['test-author/the-final-empire', { type: 'off' }]
	]);
	bookmarks.reset();
	fs.rmSync(process.env.PLEXBOT_BOOK_BOOKMARKS_FILE, { force: true });
	const none = await run(h, OWNER, 'link auto');
	assert.match(none, /^Which book\? Nothing is playing here and you have no bookmarked book\.\nUsage/);
	assert.strictEqual(h.source.calls.filter(c => c[0] === 'link').length, 3, 'nothing more was linked');
});

test('a title named "Off" is still described, never read as a target', async () => {
	catalog.replace({ meta: { builtAt: 1 }, works: JSON.parse(JSON.stringify(WORKS.concat([work('test-author/off', 'Off')]))) });
	const h = harness();
	await run(h, OWNER, 'link off');
	assert.ok(h.source.calls.some(c => c[0] === 'describe' && c[1] === 'test-author/off'));
	assert.ok(!h.source.calls.some(c => c[0] === 'link'));
});

// ---- !book link: the PDF pictures ----------------------------------------------------------------

test('"!book link <book> pictures:redo|off|on" goes to the pictures only: no relink, no catalog refresh', async (t) => {
	const refreshed = t.mock.method(catalog, 'refreshMetadata', () => ({ ok: true }));
	const h = harness();
	const redo = await run(h, OWNER, 'link "The Final Empire" pictures:redo');
	assert.strictEqual(redo, '🖼 Reading Calibre #1\'s PDF for pictures again; it takes a few minutes.');
	await run(h, OWNER, 'link Fahrenheit PICTURES:off');
	await run(h, OWNER, 'link test-author/fahrenheit-451 pictures:on');
	assert.deepStrictEqual(h.pictures.callsOf('command').map(c => c.slice(1)), [
		['test-author/the-final-empire', 'redo', { by: OWNER }],
		['test-author/fahrenheit', 'off', { by: OWNER }],
		['test-author/fahrenheit-451', 'on', { by: OWNER }]
	]);
	assert.ok(!h.source.calls.some(c => c[0] === 'link'), 'the ebook link is untouched');
	assert.strictEqual(refreshed.mock.callCount(), 0);
	h.pictures.commandResult = { ok: false, code: 'not-calibre', text: 'The Final Empire\'s text is not from a Calibre record, so it has no PDF pictures.' };
	assert.strictEqual(await run(h, OWNER, 'link "The Final Empire" pictures:redo'), '⛔ The Final Empire\'s text is not from a Calibre record, so it has no PDF pictures.');
	h.pictures.command = async () => { throw Object.assign(new Error('D:\\Calibre Library\\x.pdf'), { code: 'EBUSY' }); };
	assert.strictEqual(await run(h, OWNER, 'link "The Final Empire" pictures:redo'), '❌ That did not work; check the bot log.');
});

test('"!book link pictures:off" with no book applies to the book playing here and says which', async () => {
	const h = harness();
	const GUILD = '200000000000000001';
	h.books.session = (guildId) => (guildId === GUILD ? { workId: 'test-author/fahrenheit', work: catalog.work('test-author/fahrenheit') } : null);
	h.pictures.commandResult = { ok: true, code: 'off', text: 'Pictures are off for Fahrenheit.' };
	const out = await run(h, OWNER, 'link pictures:off');
	assert.strictEqual(out, '📖 For **Fahrenheit**, the book playing here:\n🖼 Pictures are off for Fahrenheit.');
	assert.deepStrictEqual(h.pictures.callsOf('command').map(c => c.slice(1, 3)), [['test-author/fahrenheit', 'off']]);
});

test('the pictures controls are the owner\'s, like every !book link', async () => {
	const h = harness();
	assert.match(await run(h, ANA, 'link "The Final Empire" pictures:redo'), /Only the bot owner/);
	config.ownerId = '';
	assert.match(await run(h, OWNER, 'link "The Final Empire" pictures:off'), /Set ownerId first/);
	assert.deepStrictEqual(h.pictures.callsOf('command'), []);
});

test('"!book link <book>" adds the pictures line, asks the pictures once, and names no path in a guild', async () => {
	const h = harness();
	h.pictures.describeValue = { state: 'ready', pdfId: 7, pdf: { id: 7, size: 2097152, mtime: '2026-11-05T19:48:19+00:00' }, count: 12, share: 0.9 };
	const out = await run(h, OWNER, 'link The Final Empire');
	assert.match(out, /\n🖼 Pictures: 12 from Calibre #7's PDF \(2\.0 MB, <t:\d+:d>\), lined up with this text \(90% of its pages placed\)\.\n/);
	assert.ok(!/[A-Za-z]:[\\/]/.test(out), out);
	assert.match(h.client.sent[0].first.content, /🖼 Pictures: 12 from Calibre #7's PDF/, 'the DM with paths has it too');
	assert.deepStrictEqual(h.pictures.callsOf('describe').map(c => c[1]), ['test-author/the-final-empire']);
	h.pictures.describe = async () => { throw new Error('boom'); };
	const without = await run(h, OWNER, 'link The Final Empire');
	assert.doesNotMatch(without, /🖼/, 'a failing pictures report costs only its line');
	assert.match(without, /Full details/);
});

test('the sub-help lists the read-along and still fits an embed', async () => {
	const sent = [];
	await book.command.process({ config: { commandPrefix: '!' } }, null, { channel: { async send(p) { sent.push(p); } } }, '?');
	const d = sent[0].embeds[0].data.description;
	assert.match(d, /READ ALONG/);
	assert.match(d, /`!book text on`/);
	assert.match(d, /`!book link <title>/);
	assert.match(d, /\n> 🖼 Pictures: a book whose Calibre record also holds a scanned PDF shows its illustrations on your page as the narration reaches them \(owner setting\)\.\n/);
	assert.ok(d.length <= 4096, `${d.length}`);
});

test('the slash link option names the pictures forms within Discord\'s 100 characters', () => {
	const linkSub = book._internal.SUBCOMMANDS.find(s => s.name === 'link');
	const ebook = linkSub.options.find(o => o.name === 'ebook');
	assert.strictEqual(ebook.description, 'Calibre id, ISBN, EPUB path, off, auto or pictures:redo/off/on (empty: show)');
	assert.ok(ebook.description.length <= 100);
	assert.match(text.linkUsage('!'), /`!book link <book> pictures:redo` reads the book's Calibre PDF for pictures again; `pictures:off` and `pictures:on` hide and show them for that book\./);
	assert.ok(text.linkUsage('!').length < 2000);
});
