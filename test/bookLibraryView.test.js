// commands/book.js/library.js and helpers/bookLibraryButtons.js: the `/book library` landing, its
// section pages, the filter keywords and the pager and menus.
//
// The bug: the old list printed every work in up to 5 messages with no way to act on one, split a
// series heading from its first book across messages, sorted groups by the order the catalog
// happened to hold them in, and silently dropped buttons for the work ids over 100 characters.
//
// Harness: a synthetic catalog and bookmark store handed to libraryReply and renderView through
// their test seams (works, marks and sections are all stubs), and recording fake interactions for
// the handlers. The real view memory in bookLibraryButtons is used and cleared between tests.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-view-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = `${BASE}-overrides.json`;

const library = require('../commands/book.js/library.js');
const buttons = require('../helpers/bookLibraryButtons.js');
const bookButtons = require('../helpers/bookButtons.js');
const bookSearch = require('../helpers/bookSearch.js');

const H = 3600000;
const ANA = 'ana';
const EPHEMERAL = 64;

test.afterEach(() => buttons._reset());

function work(id, title, author, hours, extra = {}) {
	return Object.assign({ id, title, author, kind: 'book', series: null, sequence: null, narrator: null, edition: null, parts: [{ durationMs: Math.round(hours * H) }] }, extra);
}

function seriesOf(prefix, series, author, count, hours, extra = {}) {
	return Array.from({ length: count }, (_, i) => work(`${prefix}/${i + 1}`, `${series} Volume ${i + 1}: A Rather Long Subtitle for Testing`, author, hours, Object.assign({ series, sequence: i + 1 }, extra)));
}

// sections: { workId: section }; marks: { workId: { absoluteMs, finished, lastListenedAt } } for ANA.
function world(works, sections = {}, marks = {}) {
	const byId = new Map(works.map(w => [w.id, w]));
	const map = new Map(works.map(w => [w.id, { section: sections[w.id] || 'More books', source: 'test' }]));
	const given = {
		catalog: {
			works: () => works,
			work: id => byId.get(id) || null,
			findWorks(text) {
				const q = String(text).toLowerCase();
				return works.filter(w => [w.title, w.author, w.series].some(v => v && v.toLowerCase().includes(q)));
			}
		},
		bookmarks: {
			get: (userId, w) => (userId === ANA && marks[w.id]) || null,
			forUser: userId => (userId === ANA ? Object.entries(marks).map(([workId, m]) => Object.assign({ workId }, m)) : [])
		},
		sections: () => map
	};
	const lib = { renderView: (view, token) => library.renderView(view, token, given), sectionFilter: library.sectionFilter };
	return { works, given, lib };
}

function bigLibrary() {
	const works = [
		...Array.from({ length: 40 }, (_, i) => work(`myth/${i}`, `Myths and Legends of the Ancient World, Book ${String(i).padStart(2, '0')}`, `Author ${i}`, 3 + i)),
		...seriesOf('sa', 'The Stormlight Archive', 'B. Sanders', 5, 40),
		...seriesOf('mb', 'Mistborn', 'B. Sanders', 7, 20),
		work('fan/solo', 'A Solo Fantasy', 'C. Writer', 2),
		...seriesOf('wt', 'The Wheel of Time', 'R. Jordan', 3, 30),
		work('pod/1', 'Episode Feed', 'Lantern Hollow', 11, { kind: 'podcast', series: 'Lantern Hollow' }),
		work('odd/1', 'An Odd One', 'D. Writer', 4)
	];
	const sections = {};
	for (const w of works) {
		if (w.id.startsWith('myth/')) sections[w.id] = 'Mythology';
		else if (w.id.startsWith('pod/')) sections[w.id] = 'Podcasts';
		else if (w.id.startsWith('odd/')) sections[w.id] = 'More books';
		else sections[w.id] = 'Fantasy';
	}
	return { works, sections };
}

function rowsOf(payload) {
	return (payload.components || []).map(r => r.components);
}

function selectOf(payload, kind) {
	return rowsOf(payload).flat().find(c => c.type === 3 && c.custom_id.startsWith(`book:lib:${kind}:`)) || null;
}

function buttonOf(payload, test) {
	return rowsOf(payload).flat().find(c => c.type === 2 && test(c)) || null;
}

function assertWithinLimits(payload) {
	assert.ok(payload.content.length <= 1900, `content ${payload.content.length}`);
	assert.ok(rowsOf(payload).length <= 5, 'at most 5 rows');
	for (const c of rowsOf(payload).flat()) {
		assert.ok(c.custom_id.length <= 100, c.custom_id);
		if (c.type !== 3) continue;
		assert.ok(c.options.length >= 1 && c.options.length <= 25, `${c.options.length} options`);
		for (const o of c.options) {
			assert.ok(o.label.length <= 100 && o.value.length <= 100 && (o.description || '').length <= 100, o.label);
		}
		assert.strictEqual(new Set(c.options.map(o => o.value)).size, c.options.length, 'distinct values');
	}
}

// A series heading is "*Name*..." and a section heading "**Name** (n)"; either must have a book
// line right after it on the same page.
function assertNoLoneHeading(text) {
	const lines = text.split('\n');
	lines.forEach((line, i) => {
		if (/^\*[^*]/.test(line) || /^\*\*[^*]+\*\* \(\d+\)/.test(line)) {
			assert.ok(lines[i + 1] && (lines[i + 1].startsWith('•') || /^\*[^*]/.test(lines[i + 1])), `heading cut from its first book: ${line}`);
		}
	});
}

function click(customId, { values, slash = false, ephemeral = false } = {}) {
	const calls = [];
	return {
		calls,
		customId,
		values,
		user: { id: 'ben' },
		member: { id: 'ben' },
		guild: { id: 'g' },
		channel: { id: 'c' },
		message: Object.assign({ flags: { has: f => ephemeral && f === EPHEMERAL } }, slash ? { interactionMetadata: { id: 'i' } } : {}),
		replied: false,
		deferred: false,
		async update(p) { calls.push(['update', p]); this.replied = true; },
		async reply(p) { calls.push(['reply', p]); this.replied = true; },
		async deferUpdate() { calls.push(['deferUpdate']); this.deferred = true; },
		async deferReply(p) { calls.push(['deferReply', p]); this.deferred = true; },
		async editReply(p) { calls.push(['editReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); }
	};
}

function tokenOf(payload) {
	return rowsOf(payload).flat()[0].custom_id.split(':')[3];
}

// ---- landing --------------------------------------------------------------------------------

test('the landing has one line per section with counts and hours, podcasts last, in one message', () => {
	const { works, sections } = bigLibrary();
	const { given } = world(works, sections, { 'sa/1': { absoluteMs: 4 * H, lastListenedAt: 2 }, 'mb/2': { absoluteMs: H, lastListenedAt: 5 }, 'odd/1': { absoluteMs: 4 * H, finished: true } });
	const r = library.libraryReply(ANA, '', { cmd: '!book library' }, given);
	assertWithinLimits(r);
	const lines = r.content.split('\n');
	assert.match(lines[0], /^📚 \*\*Audiobook library\*\* · 58 works, \d+ h \d\d m$/);
	const sectionLines = lines.filter(l => /^\*\*[^*]+\*\* · \d+ works?, /.test(l)).map(l => l.split('**')[1]);
	assert.deepStrictEqual(sectionLines, ['Mythology', 'Fantasy', 'More books', 'Podcasts']);
	assert.match(r.content, /\*\*Fantasy\*\* · 16 works, 432 h 00 m/);
	assert.match(r.content, /`!book library mythology`/);
	const open = selectOf(r, 'open');
	assert.deepStrictEqual(open.options.map(o => o.label), sectionLines);
	assert.strictEqual(open.options[1].description, '16 works · 432 h 00 m');
	const play = selectOf(r, 'play');
	assert.deepStrictEqual(play.options.map(o => o.label.split(':')[0]), ['#2 Mistborn Volume 2', '#1 The Stormlight Archive Volume 1'], 'newest first, finished left out');
	assert.strictEqual(play.options[0].value, bookSearch.shortKey('mb/2'));
	assert.match(play.options[0].description, /^5% · 19 h 00 m left · B\. Sanders$/);
});

test('the landing has no play menu for someone with nothing in progress, and caps its menu at 25 sections', () => {
	const works = Array.from({ length: 30 }, (_, i) => work(`s${i}/w`, `Work ${i}`, `Author ${i}`, 1));
	const sections = Object.fromEntries(works.map((w, i) => [w.id, `Section number ${String(i).padStart(2, '0')}`]));
	const { given } = world(works, sections);
	const r = library.libraryReply('ben', '', {}, given);
	assertWithinLimits(r);
	assert.strictEqual(selectOf(r, 'play'), null);
	assert.strictEqual(selectOf(r, 'open').options.length, 25);
	assert.match(r.content, /Section number 29/, 'every section is still named in the text');
});

test('a library with one section skips the landing and lists the books', () => {
	const { given } = world([work('a/1', 'One', 'A', 1), work('a/2', 'Two', 'A', 1)]);
	const r = library.libraryReply(ANA, '', {}, given);
	assert.match(r.content, /^📚 \*\*Audiobook library\*\* · 2 works/);
	assert.match(r.content, /• One · A · 1 h 00 m\n• Two · A · 1 h 00 m/);
	assert.strictEqual(buttonOf(r, c => c.custom_id.startsWith('book:lib:home:')), null, 'nowhere else to go');
});

// ---- section pages --------------------------------------------------------------------------

test('a section page groups series under headings sorted by the name shown, never splitting one from its first book', async () => {
	const { works, sections } = bigLibrary();
	const w = world(works, sections, { 'mb/1': { absoluteMs: 10 * H }, 'mb/2': { absoluteMs: 0, finished: true } });
	const r = library.libraryReply(ANA, 'fantasy', { cmd: '!book library' }, w.given);
	assertWithinLimits(r);
	assert.match(r.content, /^📚 \*\*Fantasy\*\* · 16 works/);
	assert.match(r.content, /\n\n• A Solo Fantasy · C\. Writer · 2 h 00 m\n\n\*Mistborn\* · B\. Sanders\n• #1 Mistborn Volume 1: A Rather Long Subtitle for Testing · 20 h 00 m · 50%\n• #2 [^\n]* · ✅\n/);
	const headings = r.content.split('\n').filter(l => /^\*[^*]/.test(l));
	assert.deepStrictEqual(headings, ['*Mistborn* · B. Sanders', '*The Stormlight Archive* · B. Sanders', '*The Wheel of Time* · R. Jordan'], 'The Stormlight Archive sorts under S, before The Wheel of Time under W');
	assertNoLoneHeading(r.content);
	assert.strictEqual(selectOf(r, 'play').options.length, 16);
});

test('a long section is cut into pages of 25 works and 1,900 characters that page in place', async () => {
	const { works, sections } = bigLibrary();
	const w = world(works, sections);
	const first = library.libraryReply(ANA, 'mythology', { cmd: '!book library' }, w.given);
	const pages = [first];
	for (;;) {
		const cur = pages[pages.length - 1];
		const next = buttonOf(cur, c => c.custom_id.startsWith('book:lib:page:') && c.emoji.name === '▶️');
		if (!next || next.disabled) break;
		const i = click(next.custom_id);
		assert.strictEqual(await buttons.handle(i, null, { library: w.lib }), true);
		assert.strictEqual(i.calls[0][0], 'update', 'edits the list in place');
		pages.push(i.calls[0][1]);
	}
	assert.strictEqual(pages.length, 2);
	const counts = pages.map(p => selectOf(p, 'play').options.length);
	assert.deepStrictEqual(counts, [25, 15]);
	for (const p of pages) {
		assertWithinLimits(p);
		assertNoLoneHeading(p.content);
	}
	assert.strictEqual(buttonOf(pages[0], c => c.emoji && c.emoji.name === '◀️').disabled, true);
	assert.strictEqual(buttonOf(pages[1], c => c.custom_id.startsWith('book:lib:noop:')).label, '2 / 2');
	assert.strictEqual(buttonOf(pages[1], c => c.emoji && c.emoji.name === '▶️').disabled, true);
	const firstTitles = selectOf(pages[0], 'play').options.map(o => o.label);
	const secondTitles = selectOf(pages[1], 'play').options.map(o => o.label);
	assert.ok(!firstTitles.some(t => secondTitles.includes(t)), 'each page lists its own works');
});

test('a page that opens inside a series repeats its heading as continued', () => {
	const works = [
		...Array.from({ length: 20 }, (_, i) => work(`solo/${i}`, `Standalone ${String(i).padStart(2, '0')}`, 'A', 1)),
		...seriesOf('long', 'Long Saga', 'B', 12, 2)
	];
	const { given } = world(works);
	const r = library.libraryReply(ANA, '', {}, given);
	const token = tokenOf(r);
	const view = buttons.recall(token);
	view.page = 1;
	const second = library.renderView(view, token, given);
	assert.match(second.content, /\n\n\*Long Saga\* · B \(cont\.\)\n• #6 /);
	assertNoLoneHeading(r.content);
	assertNoLoneHeading(second.content);
});

test('a work id over 100 characters gets a short hashed option value that resolves to it', async () => {
	const longId = `${'an-author-with-a-very-long-name'.repeat(2)}/${'a-title-that-goes-on-and-on'.repeat(3)}`;
	assert.ok(longId.length > 100);
	const w = world([work(longId, 'Long One', 'A', 1), work('b/1', 'Short One', 'B', 1)]);
	const r = library.libraryReply(ANA, '', {}, w.given);
	const opt = selectOf(r, 'play').options.find(o => o.label === 'Long One');
	assert.strictEqual(opt.value, bookSearch.shortKey(longId));
	const played = [];
	const i = click(selectOf(r, 'play').custom_id, { values: [opt.value] });
	await buttons.handle(i, 'BOT', { library: w.lib, catalog: w.given.catalog, play: async (inter, bot, id) => played.push([bot, id]) });
	assert.deepStrictEqual(played, [['BOT', longId]]);
});

// ---- filters --------------------------------------------------------------------------------

test('filters combine a section, author:, series:, status, length and podcasts', () => {
	const names = ['Fantasy', 'Mythology', 'Science Fiction'];
	assert.strictEqual(library.parseFilter('', names), null);
	assert.strictEqual(library.parseFilter('science  FICTION', names).section, 'Science Fiction');
	const f = library.parseFilter('author:"b. sanders" unread long', names);
	assert.deepStrictEqual([f.author, f.status, f.length, f.words], ['b. sanders', ['unread'], ['long'], '']);
	const g = library.parseFilter('series:wheel of time listening', names);
	assert.deepStrictEqual([g.series, g.status], ['wheel of time', ['listening']]);
	const h = library.parseFilter('fantasy volume 2', names);
	assert.deepStrictEqual([h.section, h.words, h.edgeOf], ['Fantasy', 'volume 2', 'fantasy volume 2']);
	const s = library.parseFilter('section:myth short', names);
	assert.deepStrictEqual([s.section, s.sectionLoose, s.length], ['myth', true, ['short']]);

	const { works, sections } = bigLibrary();
	const marks = { 'sa/1': { absoluteMs: H }, 'mb/1': { absoluteMs: 20 * H, finished: true } };
	const { given } = world(works, sections, marks);
	const count = q => {
		const r = library.libraryReply(ANA, q, {}, given);
		return /^📚/.test(r.content) ? Number(/· (\d+) works?,/.exec(r.content.split('\n')[0])[1]) : 0;
	};
	assert.strictEqual(count('unread'), works.length - 2);
	assert.strictEqual(count('listening'), 1);
	assert.strictEqual(count('finished'), 1);
	assert.strictEqual(count('short'), 4, 'under 5 h: two myths, the solo fantasy, the odd one');
	assert.strictEqual(count('long'), 40 - 17 + 5 + 7 + 3, '20 h or more');
	assert.strictEqual(count('podcasts'), 1);
	assert.strictEqual(count('author:sanders'), 12);
	assert.strictEqual(count('series:mistborn unread'), 6);
	assert.strictEqual(count('fantasy short'), 1);
	assert.strictEqual(count('fantasy mistborn'), 7, 'a section name in front of the words');
	assert.strictEqual(count('section:myth long'), 40 - 17);
});

test('words that start with a section name still find a title outside that section', () => {
	const works = [work('m/1', 'Fantasy Island Tales', 'A', 3), work('f/1', 'Dragons', 'B', 3)];
	const { given } = world(works, { 'm/1': 'Mythology', 'f/1': 'Fantasy' });
	const r = library.libraryReply(ANA, 'fantasy island', {}, given);
	assert.match(r.content, /matching "fantasy island" · 1 work/);
	assert.match(r.content, /Fantasy Island Tales/);
});

test('a typo answers "Did you mean" with play buttons and remembers no list', () => {
	const { given } = world([work('a/salt', 'The Salt Crown', 'Avery Quill', 4), work('a/ember', 'The Ember Throne', 'Avery Quill', 4)]);
	const r = library.libraryReply(ANA, 'slat crown', {}, given);
	assert.strictEqual(r.content, 'Nothing in the audiobook library matches "slat crown". Did you mean **The Salt Crown**?');
	assert.deepStrictEqual(rowsOf(r).flat().map(c => c.custom_id), ['book:play:a/salt']);
	const none = library.libraryReply(ANA, 'zzqq', { cmd: '!book library' }, given);
	assert.match(none.content, /^Nothing in the audiobook library matches "zzqq"\.\nSections: \*\*More books\*\*\./);
	assert.deepStrictEqual(none.components, []);
});

// ---- pager and menus ------------------------------------------------------------------------

test('an expired list says so privately, naming the command the list came from', async () => {
	const prefix = click('book:lib:page:deadbeef:1');
	await buttons.handle(prefix, null, { prefix: '!' });
	assert.deepStrictEqual(prefix.calls, [['reply', { content: 'This list has expired. Run `!book library` again.', flags: EPHEMERAL, allowedMentions: { parse: [] } }]]);
	const slash = click('book:lib:open:deadbeef', { values: ['0'], slash: true });
	await buttons.handle(slash, null, {});
	assert.match(slash.calls[0][1].content, /Run `\/book library` again\./);

	const { works, sections } = bigLibrary();
	const w = world(works, sections);
	const r = library.libraryReply(ANA, 'mythology', {}, w.given);
	const next = buttonOf(r, c => c.emoji && c.emoji.name === '▶️');
	const late = click(next.custom_id);
	await buttons.handle(late, null, { library: w.lib, prefix: '!', now: () => Date.now() + buttons.TTL_MS + 1000 });
	assert.match(late.calls[0][1].content, /This list has expired/);
	assert.strictEqual(late.calls[0][1].flags, EPHEMERAL);
});

test('open a section, then go back to all sections', async () => {
	const { works, sections } = bigLibrary();
	const w = world(works, sections);
	const landing = library.libraryReply(ANA, '', {}, w.given);
	const open = selectOf(landing, 'open');
	const i = click(open.custom_id, { values: [open.options.findIndex(o => o.label === 'Fantasy').toString()] });
	await buttons.handle(i, null, { library: w.lib });
	const page = i.calls[0][1];
	assert.match(page.content, /^📚 \*\*Fantasy\*\* · 16 works/);
	const home = buttonOf(page, c => c.custom_id.startsWith('book:lib:home:'));
	const back = click(home.custom_id);
	await buttons.handle(back, null, { library: w.lib });
	assert.strictEqual(back.calls[0][1].content, landing.content);
	const noop = click(`book:lib:noop:${tokenOf(landing)}`);
	await buttons.handle(noop, null, { library: w.lib });
	assert.deepStrictEqual(noop.calls, [['deferUpdate']]);
});

test('a play pick plays for the clicker and draws the list again; a vanished book says the list expired', async () => {
	const { works, sections } = bigLibrary();
	const w = world(works, sections);
	const r = library.libraryReply(ANA, 'fantasy', {}, w.given);
	const sel = selectOf(r, 'play');
	const played = [];
	const i = click(sel.custom_id, { values: [bookSearch.shortKey('mb/3')] });
	await buttons.handle(i, 'BOT', { library: w.lib, catalog: w.given.catalog, play: async (inter, bot, id) => played.push([inter.user.id, id]) });
	assert.deepStrictEqual(played, [['ben', 'mb/3']]);
	assert.strictEqual(i.calls[0][0], 'editReply');
	assert.strictEqual(i.calls[0][1].content, r.content, 'the same page, the menu reset');

	const gone = click(sel.custom_id, { values: [bookSearch.shortKey('no/such')] });
	await buttons.handle(gone, 'BOT', { library: w.lib, catalog: w.given.catalog, prefix: '!', play: async () => played.push('wrong') });
	assert.strictEqual(played.length, 1);
	assert.match(gone.calls[0][1].content, /This list has expired/);
});

test('the book: router hands library controls over, and a library pick goes through the card play path', async () => {
	const plays = [];
	const bot = { books: { async play(ctx) { plays.push(ctx); return { ok: true, text: '▶ Starting Mistborn', info: {} }; } } };
	const expired = click('book:lib:page:deadbeef:1');
	assert.strictEqual(await bookButtons.handle(expired, bot, null, {}), true);
	assert.match(expired.calls[0][1].content, /This list has expired/);

	const pick = click('book:lib:play:deadbeef', { values: ['~x'], ephemeral: true });
	await bookButtons.playFromList(pick, bot, 'mb/1', { ensureLibrary() {} });
	assert.deepStrictEqual(pick.calls.map(c => c[0]), ['deferUpdate', 'followUp'], 'acknowledged on the list, even a private one, and answered privately');
	assert.deepStrictEqual(pick.calls[1][1], { content: '▶ Starting Mistborn', flags: EPHEMERAL, allowedMentions: { parse: [] } });
	assert.strictEqual(plays[0].workId, 'mb/1');
	assert.strictEqual(plays[0].member.id, 'ben', 'for the clicker');
});
