// helpers/readAlongCard.js: the read-along's page, no-text page and stubs.
//
// The bug: a page Discord refuses (an embed over its limits, a sixth button, a customId over 100
// characters), so the DM freezes on an old page; a line of the book starting "# " or "> " turning
// into a heading or a quote; a page with book text and no bookpage: row, which the command log
// would then write to disk; a stub that keeps live buttons; "Play from here" or "Follow in DMs"
// offered to someone in the voice channel who is not the listener; a ping from the page.
//
// Harness: pure, no Discord. Payloads are built by hand from synthetic NATO-alphabet text.

const test = require('node:test');
const assert = require('node:assert');

const card = require('../helpers/readAlongCard.js');
const { words } = require('./helpers/epubFixture.js');

const BASE = {
	surface: 'd',
	sid: 'a1b2c3',
	tag: '9f0c',
	word: 12345,
	page: 2,
	pageCount: 9,
	sectionLabel: 'Chapter 12: The *Bright* Road',
	sectionNo: 14,
	sectionCount: 80,
	bookTitle: 'The Fake_Book',
	text: `${words(60)}\n${words(60, 60)}\n${words(60, 120)}`,
	quality: { level: 'chapter', label: 'chapter-level' },
	dramatized: true,
	mode: 'following',
	note: null,
	isListener: true,
	isPaused: false,
	prevOk: true,
	nextOk: true
};

function page(over = {}) {
	return card.pagePayload(Object.assign({}, BASE, over));
}

function ids(payload) {
	return payload.components.flatMap(r => r.components).map(b => b.custom_id);
}

function assertDiscordShape(p, where) {
	assert.ok(p.components.length <= 5, where);
	for (const r of p.components) {
		assert.strictEqual(r.type, 1);
		assert.ok(r.components.length >= 1 && r.components.length <= 5, `${where}: 1 to 5 buttons`);
		for (const b of r.components) assert.ok(b.custom_id.length <= 100, `${where}: ${b.custom_id}`);
	}
	for (const e of p.embeds) {
		assert.ok(e.title.length <= 256, `${where}: title`);
		assert.ok(e.description.length <= 4096, `${where}: description`);
		assert.ok(e.footer.text.length <= 2048, `${where}: footer`);
	}
	assert.deepStrictEqual(p.allowedMentions, { parse: [] });
}

test('a DM page has one row: ◀ ▶ 📍 ↪ ✖, all bookpage ids carrying the start word in base 36', () => {
	const p = page();
	assertDiscordShape(p, 'dm');
	assert.deepStrictEqual(ids(p).map(id => id.split(':')[1]), ['prev', 'next', 'now', 'play', 'off']);
	for (const id of ids(p)) {
		assert.deepStrictEqual(card.parsePageId(id), { act: id.split(':')[1], surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 12345 });
		assert.ok(id.endsWith(':' + (12345).toString(36)));
	}
	assert.match(p.embeds[0].footer.text, /Approximate · dramatized edition · chapter-level · page 3 of 9 · following the narration/);
});

test('an ephemeral page offers ↪ and 📩 to the listener only; anyone else gets ◀ ▶ 📍', () => {
	const mine = page({ surface: 'e', mode: 'snapshot' });
	assert.deepStrictEqual(ids(mine).map(id => id.split(':')[1]), ['prev', 'next', 'now', 'play', 'dm']);
	assert.ok(!mine.components[0].components[3].disabled);
	const theirs = page({ surface: 'e', mode: 'snapshot', isListener: false });
	assertDiscordShape(theirs, 'theirs');
	assert.deepStrictEqual(ids(theirs).map(id => id.split(':')[1]), ['prev', 'next', 'now'], 'no ↪ and no 📩, not even disabled');
	const none = card.noTextPayload({ surface: 'e', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: null, mode: 'snapshot', isListener: false });
	assert.deepStrictEqual(ids(none).map(id => id.split(':')[1]), ['prev', 'next', 'now'], 'the no-text page too');
});

test('◀ and ▶ are disabled at the first and last body page', () => {
	const p = page({ prevOk: false, nextOk: false });
	assert.strictEqual(p.components[0].components[0].disabled, true);
	assert.strictEqual(p.components[0].components[1].disabled, true);
});

test('book text is escaped so no line becomes a heading, a quote, a list or a link', () => {
	const p = page({ text: '# not a heading\n> not a quote\n- not a list\n1. not a list\n[not](a link) *x* _y_' });
	const d = p.embeds[0].description;
	assert.ok(!/^#/m.test(d) && !/^>/m.test(d) && !/^-/m.test(d) && !/^\d+\./m.test(d), d);
	assert.match(d, /\\\[not\\\]/);
	assert.match(d, /\\\*x\\\*/);
	assert.match(p.embeds[0].title, /The Fake\\_Book · Chapter 12: The \\\*Bright\\\* Road/);
});

test('an oversized page is clipped to Discord\'s limits without leaving a dangling escape', () => {
	const huge = page({ text: '*'.repeat(5000), bookTitle: 'x'.repeat(400), sectionLabel: 'y'.repeat(400) });
	assertDiscordShape(huge, 'huge');
	assert.ok(huge.embeds[0].description.endsWith('…'));
	assert.ok(!/(^|[^\\])(\\\\)*\\…$/.test(huge.embeds[0].description), 'the ellipsis is not escaped');
});

test('a section with no label is named by its place among the body sections', () => {
	assert.match(page({ sectionLabel: '' }).embeds[0].title, /· Section 14 of 80$/);
});

test('modes and the "text updated" note read as plain words', () => {
	assert.match(page({ mode: 'browsing' }).embeds[0].footer.text, /browsing: 📍 Now follows again/);
	assert.match(page({ mode: 'paused' }).embeds[0].footer.text, /⏸ paused/);
	assert.match(page({ note: 'text-updated' }).content, /text was updated/);
	assert.strictEqual(page().content, '');
});

test('the no-text page keeps the row so the listener can still page, and names where text resumes', () => {
	const p = card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'The Fake Book', resumesAt: 'Prologue', mode: 'following', isListener: true });
	assertDiscordShape(p, 'no text');
	assert.match(p.embeds[0].description, /picks up at Prologue/);
	assert.ok(ids(p).every(id => id.startsWith('bookpage:')));
	assert.match(card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: null, mode: 'following', isListener: true }).embeds[0].description, /has ended/);
});

test('stubs and notices carry no buttons, no embed and no book text', () => {
	const fixture = words(30, 3);
	for (const [name, p] of [
		['preparing', card.preparingPayload({ bookTitle: 'The Fake Book' })],
		['ended', card.endedStub({ bookTitle: 'The Fake Book' })],
		['ended, no title', card.endedStub()],
		['off', card.offStub({ prefix: '?' })],
		['moved', card.movedStub()],
		['notice', card.noticePayload('Calibre isn\'t answering.')]
	]) {
		assert.deepStrictEqual(p.components, [], name);
		assert.deepStrictEqual(p.embeds, [], name);
		assert.ok(!p.content.includes(fixture), name);
		assert.deepStrictEqual(p.allowedMentions, { parse: [] }, name);
	}
	assert.match(card.offStub({ prefix: '?' }).content, /`\?book text on`/);
});

test('every payload that holds book text carries the bookpage row', () => {
	for (const over of [{}, { surface: 'e', mode: 'snapshot' }, { surface: 'e', isListener: false }, { mode: 'paused' }]) {
		const p = page(over);
		assert.ok(p.embeds[0].description.includes('alpha'), 'the page holds text');
		assert.ok(ids(p).length >= 3 && ids(p).every(id => id.startsWith('bookpage:')));
	}
});

test('parsePageId refuses anything it did not make', () => {
	for (const bad of ['bookpage:next:d:a1b2c3:9f0c', 'bookpage:jump:d:a1b2c3:9f0c:1', 'bookpage:next:x:a1b2c3:9f0c:1',
		'bookpage:next:d:A1B2C3:9f0c:1', 'bookpage:next:d:a1b2c3:9f0c:-1', 'book:next:d:a1b2c3:9f0c:1', '', null]) {
		assert.strictEqual(card.parsePageId(bad), null, String(bad));
	}
	const longest = card.pageId({ act: 'next', surface: 'e', sid: 'ffffff', tag: 'ffff', word: Number.MAX_SAFE_INTEGER });
	assert.ok(longest.length < 50, longest);
	assert.strictEqual(card.parsePageId(longest).word, Number.MAX_SAFE_INTEGER);
});

test('a TOC label on the no-text page cannot render as a masked link', () => {
	const p = card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: '[Chapter 1](https://evil.example/login)', mode: 'following', isListener: true });
	assert.ok(p.embeds[0].description.includes('\\[Chapter 1\\](https://evil.example/login)'), p.embeds[0].description);
});

test('the no-text page\'s buttons say so, and parsePageId reads the mark back', () => {
	const p = card.noTextPayload({ surface: 'e', sid: 'a1b2c3', tag: '9f0c', word: 720, bookTitle: 'B', resumesAt: 'Chapter 1', mode: 'snapshot', isListener: true });
	for (const id of ids(p)) assert.deepStrictEqual(card.parsePageId(id), { act: id.split(':')[1], surface: 'e', sid: 'a1b2c3', tag: '9f0c', word: 720, none: true });
	assert.strictEqual(card.parsePageId('bookpage:next:d:a1b2c3:9f0c:1:x'), null);
});
