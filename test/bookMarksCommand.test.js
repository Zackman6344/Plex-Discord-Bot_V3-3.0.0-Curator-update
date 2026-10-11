// commands/book.js/marks.js: `!book marks` and `!book unmark`, through the real /book dispatcher.
//
// The bug: a marks list that quotes the book, or hides that a mark is not being used (the ebook
// changed, a newer mark disagrees); `!book unmark` removing someone else's mark, or anyone
// clearing a whole book; a slash form that parses differently from the prefix one; an unmark the
// open DM pages never hear about.
//
// Harness: the real command module with recording prefix messages and slash interactions (as in
// test/bookTextCommand.test.js), the real catalog, bookmark and read-along stores on pid-suffixed
// temp files seeded with made-up works and marks, and the fake director of
// test/helpers/readAlongFakes.js for the book that is playing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-marks-command-${process.pid}`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-works.json`;
process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE = `${BASE}-marks.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const catalog = require('../helpers/bookCatalogStore.js');
const bookmarks = require('../helpers/bookmarks.js');
const textStore = require('../helpers/bookTextStore.js');
const slashRegistry = require('../helpers/slashRegistry.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const book = require('../commands/book.js');
const { parseUnmark } = require('../commands/book.js/marks.js');
const T = require('./helpers/readAlongFakes.js');

const OWNER = '100000000000000009';
const ANA = '100000000000000001';
const BEN = '100000000000000002';
const TEXT = 'a1b2c3d4e5f60718';
const SECTIONS = [{ label: 'Chapter 1', words: 900 }, { label: 'Chapter 2', words: 900 }];
const WORK = Object.assign(T.makeWork(SECTIONS), { narrator: 'Nora Reed' });
const OTHER = Object.assign(T.makeWork(SECTIONS, { id: 'test-author/the-fake-book-full-cast', title: 'The Fake Book' }), { edition: 'Full Cast' });
const DAY = Date.UTC(2026, 9, 11, 12);

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

test.beforeEach(() => {
	cleanup();
	catalog.replace({ meta: { builtAt: 1 }, works: JSON.parse(JSON.stringify([WORK, OTHER])) });
	textStore.works.set(WORK.id, { base: TEXT, fingerprint: 'fake', via: 'auto', source: { type: 'calibre', id: 1 }, at: 1 });
	config.ownerId = OWNER;
	config.audiobooksEnabled = true;
	config.audiobookTextEnabled = true;
});
test.afterEach(() => {
	Object.assign(config, saved);
	cleanup();
});
test.after(cleanup);

function harness({ playing = true } = {}) {
	const books = T.fakeBooks(T.manualClock());
	const changed = [];
	if (playing) books.add({ work: WORK, userId: ANA, audible: false });
	return { books, changed, bot: { books, readAlong: { marksChanged: w => changed.push(w.id) } } };
}

function seed(ms, by, at, { text = TEXT, word = Math.round(ms / T.MS_PER_WORD) } = {}) {
	return textStore.marks.add(WORK, { ms, word, text, tag: text.slice(0, 4), by, at }).mark;
}

function prefixMessage(userId, query) {
	const calls = [];
	const user = { id: userId, username: 'Ana' };
	return {
		calls,
		author: user,
		member: { id: userId, user },
		guild: { id: '200000000000000001' },
		content: `!book ${query}`,
		channel: { id: '400000000000000001', name: 'books', async send(p) { calls.push(['send', p]); return {}; } },
		async reply(p) { calls.push(['reply', p]); return {}; }
	};
}

async function run(h, userId, query) {
	const m = prefixMessage(userId, query);
	await book.command.process(h.bot, null, m, query);
	return m.calls.map(c => c[1].content).join('\n');
}

const ids = () => textStore.marks.list(WORK).map(m => m.id);

test('!book marks lists audio time, the audio\'s chapter, who and when, and never the book\'s words', async () => {
	const h = harness();
	seed(69300, ANA, DAY);
	seed(400000, BEN, DAY + 86400000);
	const out = await run(h, ANA, 'marks');
	assert.match(out, /📌 \*\*The Fake Book\*\* \(read by Nora Reed\): 2 sync marks, shared by everyone who plays this recording\./);
	assert.match(out, new RegExp(`\\n1\\. 0:01:09 · Chapter 1 · <@${ANA}> · 11 Oct 2026\\n2\\. 0:06:40 · Chapter 2 · <@${BEN}> · 12 Oct 2026\\n`));
	assert.match(out, /`!book unmark` removes your latest mark, `!book unmark <n>` one of yours from this list\.$/);
	assert.ok(!/alpha|bravo|charlie|delta/.test(out));
	assert.strictEqual(await run(h, BEN, 'marks The Fake Book'), 'Which one? Use the id:\n• `test-author/the-fake-book` The Fake Book (read by Nora Reed)\n• `test-author/the-fake-book-full-cast` The Fake Book (Full Cast)');
	assert.strictEqual(await run(h, BEN, `marks ${WORK.id}`), out, 'by id, from someone not playing it');
	assert.match(await run(h, OWNER, 'marks'), /Which book\? `!book marks <title>`, or run it while the book plays\./);
	assert.match(await run(h, OWNER, `marks ${WORK.id}`), /, `!book unmark all <title> confirm` clears them all\.$/);
});

test('the list says which marks are not used: another ebook text, another recording, or a newer mark that disagrees', async () => {
	const h = harness();
	seed(60000, ANA, DAY, { text: 'ffee0011aabbccdd' });
	seed(120000, ANA, DAY, { word: 500 });
	seed(150000, BEN, DAY + 1, { word: 400 });
	textStore.marks.add(WORK, { ms: 200000, word: 600, text: TEXT, rec: '2-00000000', by: BEN, at: DAY });
	const out = await run(h, ANA, 'marks');
	assert.match(out, /\n1\. 0:01:00 · Chapter 1 · <@\d+> · 11 Oct 2026 · not used \(old ebook text\)\n/);
	assert.match(out, /\n2\. 0:02:00 · Chapter 1 · <@\d+> · 11 Oct 2026 · not used \(a newer mark disagrees\)\n/);
	assert.match(out, /\n3\. 0:02:30 · Chapter 1 · <@\d+> · 11 Oct 2026\n/);
	assert.match(out, /\n4\. 0:03:20 · Chapter 1 · <@\d+> · 11 Oct 2026 · not used \(another recording\)\n/);
});

// The bug: 20 lines of long chapter titles passed Discord's 2000 characters, and the reply was cut
// mid-list, taking the "…and N more" line, the unmark instructions and some marks' numbers with it.
test('a long marks list stays inside one message and still ends with the count left out and the instructions', async () => {
	const LONG = T.makeWork(SECTIONS, {
		id: 'test-author/the-long-book', title: 'The Long Book',
		parts: Array.from({ length: 24 }, (_, i) => ({ ordinal: i + 1, title: `Chapter ${i + 1}: The Long Road to the Northern Keep and Beyond It`, durationMs: 150000 }))
	});
	catalog.replace({ meta: { builtAt: 2 }, works: JSON.parse(JSON.stringify([WORK, OTHER, LONG])) });
	textStore.works.set(LONG.id, { base: TEXT, fingerprint: 'fake', via: 'auto', source: { type: 'calibre', id: 2 }, at: 1 });
	const h = harness({ playing: false });
	for (let i = 0; i < 24; i++) textStore.marks.add(LONG, { ms: i * 150000 + 60000, word: i * 40 + 1, text: 'ffee0011aabbccdd', by: BEN, at: DAY });
	const out = await run(h, OWNER, `marks ${LONG.id}`);
	assert.ok(out.length <= 1900, `length ${out.length}`);
	const shown = out.split('\n').filter(l => /^\d+\. /.test(l));
	assert.ok(shown.length >= 10, `${shown.length} lines`);
	shown.forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), l));
	assert.match(shown[0], /^1\. 0:01:00 · Chapter 1: The Long Road to the Norther… · <@\d+> · 11 Oct 2026 · not used \(old ebook text\)$/);
	assert.match(out, new RegExp(`\\n…and ${24 - shown.length} more\\.\\n\`!book unmark\` removes your latest mark`));
	assert.match(out, /`!book unmark all <title> confirm` clears them all\.$/);
});

// The bug: a title starting with "All" or made of digits was read as the keyword, so the owner's
// `!book unmark All Systems Red` cleared every listener's marks on that book, and
// `!book unmark 1984` could not name the book at all.
test('a title that starts with "All" or is a number is read as the title, not the keyword', async () => {
	const ALL = T.makeWork(SECTIONS, { id: 'test-author/all-systems-red', title: 'All Systems Red' });
	const NUM = T.makeWork(SECTIONS, { id: 'test-author/1984', title: '1984' });
	catalog.replace({ meta: { builtAt: 2 }, works: JSON.parse(JSON.stringify([WORK, OTHER, ALL, NUM])) });
	const h = harness({ playing: false });
	const add = (w, ms, word, by) => textStore.marks.add(w, { ms, word, text: TEXT, by, at: DAY + ms }).mark;
	add(ALL, 60000, 10, OWNER);
	add(ALL, 400000, 900, BEN);
	assert.match(await run(h, OWNER, 'unmark All Systems Red'), /📌 Removed the mark at 0:01:00 \(Chapter 1\) on \*\*All Systems Red\*\*\./);
	assert.deepStrictEqual(textStore.marks.list(ALL).map(m => m.by), [BEN]);
	add(NUM, 60000, 10, BEN);
	assert.match(await run(h, BEN, 'unmark 1984'), /📌 Removed the mark at 0:01:00 \(Chapter 1\) on \*\*1984\*\*\./);
	assert.deepStrictEqual(textStore.marks.list(NUM), []);
	add(NUM, 60000, 10, BEN);
	assert.match(await run(h, OWNER, 'unmark all All Systems Red'), /This clears all 1 mark of \*\*All Systems Red\*\*/);
	assert.strictEqual(textStore.marks.list(ALL).length, 1, 'asked first, nothing cleared');
});

test('!book unmark removes your own latest mark on the book you are playing, and tells the pages', async () => {
	const h = harness();
	const first = seed(60000, ANA, DAY);
	seed(200000, ANA, DAY + 5);
	const bens = seed(400000, BEN, DAY + 9);
	assert.match(await run(h, ANA, 'unmark'), /📌 Removed the mark at 0:03:20 \(Chapter 1\) on \*\*The Fake Book\*\* \(read by Nora Reed\)\./);
	assert.deepStrictEqual(ids(), [first.id, bens.id]);
	assert.deepStrictEqual(h.changed, [WORK.id]);
	assert.match(await run(h, OWNER, `unmark ${WORK.id}`), /You have no marks on/);
});

test('!book unmark <n> removes a listed mark of yours; someone else\'s only the owner may remove', async () => {
	const h = harness();
	seed(60000, ANA, DAY);
	const bens = seed(400000, BEN, DAY);
	assert.match(await run(h, ANA, 'unmark 2'), new RegExp(`⛔ Mark 2 is <@${BEN}>'s; only they or the bot owner can remove it\\.`));
	assert.match(await run(h, ANA, 'unmark 3'), /has no mark 3; `!book marks` lists 1 to 2\./);
	assert.match(await run(h, ANA, 'unmark 1'), /Removed the mark at 0:01:00/);
	assert.deepStrictEqual(ids(), [bens.id]);
	assert.match(await run(h, OWNER, `unmark 1 ${WORK.id}`), /Removed the mark at 0:06:40 \(Chapter 2\)/);
	assert.deepStrictEqual(ids(), []);
});

test('!book unmark all is the owner\'s, needs ownerId, asks first, and clears every mark of the book', async () => {
	const h = harness();
	seed(60000, ANA, DAY);
	seed(400000, BEN, DAY);
	seed(500000, BEN, DAY, { text: 'ffee0011aabbccdd' });
	assert.match(await run(h, ANA, 'unmark all'), /⛔ Only the bot owner can clear all of a book's marks\. `!book unmark` removes your own latest one\./);
	config.ownerId = '';
	assert.match(await run(h, ANA, 'unmark all'), /⛔ Set ownerId first \(`!config` → Access\)/);
	config.ownerId = OWNER;
	assert.strictEqual(await run(h, OWNER, `unmark all ${WORK.id}`), `📌 This clears all 3 marks of **The Fake Book** (read by Nora Reed), set by 2 listeners, for everyone who plays this recording. Run \`!book unmark all ${WORK.id} confirm\` to do it.`);
	assert.strictEqual(ids().length, 3);
	assert.deepStrictEqual(h.changed, []);
	assert.match(await run(h, OWNER, `unmark all ${WORK.id} confirm`), /📌 Cleared all 3 marks of \*\*The Fake Book\*\*/);
	assert.deepStrictEqual(ids(), []);
	assert.deepStrictEqual(h.changed, [WORK.id]);
	assert.match(await run(h, OWNER, `unmark all ${WORK.id} confirm`), /has no marks to clear/);
});

function slash(sub, values) {
	const calls = [];
	const interaction = {
		commandName: 'book', user: { id: ANA, username: 'Ana' }, member: { id: ANA }, guild: { id: 'g1' }, guildId: 'g1', client: {}, deferred: true,
		channel: { id: 'c1', async send(p) { calls.push(['send', p]); } },
		options: { data: [], getSubcommand: () => sub, get: n => (n in values ? { name: n, value: values[n] } : null), getUser: () => null },
		async editReply(p) { calls.push(['editReply', p]); return {}; },
		async followUp(p) { calls.push(['followUp', p]); return {}; }
	};
	return { interaction, calls };
}

test('the slash forms reach the same handlers: /book marks, /book unmark which:1 title:<book>', async () => {
	const h = harness();
	seed(60000, ANA, DAY);
	const list = slash('marks', {});
	const q1 = slashRegistry.buildQueryString(list.interaction, book.command.slash);
	assert.strictEqual(q1, 'marks');
	await book.command.process(h.bot, null, adaptInteraction(list.interaction, q1), q1);
	assert.match(list.calls[0][1].content, /1\. 0:01:00 · Chapter 1/);
	const un = slash('unmark', { which: '1', title: WORK.id });
	const q2 = slashRegistry.buildQueryString(un.interaction, book.command.slash);
	assert.strictEqual(q2, `unmark 1 ${WORK.id}`);
	await book.command.process(h.bot, null, adaptInteraction(un.interaction, q2), q2);
	assert.match(un.calls[0][1].content, /Removed the mark at 0:01:00/);
	assert.deepStrictEqual(ids(), []);
	seed(60000, ANA, DAY);
	const owner = (values) => {
		const x = slash('unmark', values);
		x.interaction.user = { id: OWNER, username: 'Owner' };
		x.interaction.member = { id: OWNER };
		return x;
	};
	const ask = owner({ which: 'all', title: WORK.id });
	const q3 = slashRegistry.buildQueryString(ask.interaction, book.command.slash);
	await book.command.process(h.bot, null, adaptInteraction(ask.interaction, q3), q3);
	assert.ok(ask.calls[0][1].content.endsWith(`Run \`/book unmark which:all confirm title:${WORK.id}\` to do it.`), ask.calls[0][1].content);
	assert.strictEqual(ids().length, 1);
	const yes = owner({ which: 'all confirm', title: WORK.id });
	const q4 = slashRegistry.buildQueryString(yes.interaction, book.command.slash);
	assert.strictEqual(q4, `unmark all confirm ${WORK.id}`);
	await book.command.process(h.bot, null, adaptInteraction(yes.interaction, q4), q4);
	assert.match(yes.calls[0][1].content, /Cleared all 1 mark of/);
	assert.deepStrictEqual(ids(), []);
});

test('parseUnmark reads latest, a number, all with or without confirm, and a bare title', () => {
	assert.deepStrictEqual(parseUnmark(''), { kind: 'latest', title: '' });
	assert.deepStrictEqual(parseUnmark('3'), { kind: 'n', n: 3, title: '' });
	assert.deepStrictEqual(parseUnmark('2 The Fake Book'), { kind: 'n', n: 2, title: 'The Fake Book' });
	assert.deepStrictEqual(parseUnmark('ALL The Fake Book'), { kind: 'all', title: 'The Fake Book', confirm: false });
	assert.deepStrictEqual(parseUnmark('all The Fake Book confirm'), { kind: 'all', title: 'The Fake Book', confirm: true });
	assert.deepStrictEqual(parseUnmark('all confirm The Fake Book'), { kind: 'all', title: 'The Fake Book', confirm: true });
	assert.deepStrictEqual(parseUnmark('all confirm'), { kind: 'all', title: '', confirm: true });
	assert.deepStrictEqual(parseUnmark('The Fake Book'), { kind: 'latest', title: 'The Fake Book' });
});

test('the sub-help lists 📌 and the marks commands and still fits an embed', async () => {
	const sent = [];
	await book.command.process({ config: { commandPrefix: '!' } }, null, { channel: { async send(p) { sent.push(p); } } }, '?');
	const d = sent[0].embeds[0].data.description;
	assert.match(d, /📌 on your DM page/);
	assert.match(d, /`!book marks \[title\]` \/ `!book unmark \[n\]`/);
	assert.match(d, /`!book unmark all \[title\] confirm` \(owner\)/);
	assert.ok(d.length <= 4096, `${d.length}`);
});
