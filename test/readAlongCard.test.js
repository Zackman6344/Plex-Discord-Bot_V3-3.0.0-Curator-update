// helpers/readAlongCard.js: the read-along's page, no-text page and stubs.
//
// The bug: a page Discord refuses (an embed over its limits, a sixth button, a customId over 100
// characters), so the DM freezes on an old page; a line of the book starting "# " or "> " turning
// into a heading or a quote; a page with book text and no bookpage: row, which the command log
// would then write to disk; a stub that keeps live buttons; "Play from here" or "Follow in DMs"
// offered to someone in the voice channel who is not the listener; a ping from the page; an
// omnibus book the ebook leaves out called "an intro, credits or music". A 📌 sync mark offered on
// an ephemeral page or a no-text page, or a sixth button in the first row to fit it. A picture
// that stays on screen because a stub or a plain page carried no `files` (an edit without them
// keeps the old attachments); an eleventh picture or a page over the upload size; a picture
// attached from a URL or a UNC path.
//
// Harness: pure, no Discord. Payloads are built by hand from synthetic NATO-alphabet text.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

const card = require('../helpers/readAlongCard.js');
const { words } = require('./helpers/epubFixture.js');

const PIC_DIR = pathMod.join(os.tmpdir(), 'plexbot-card-pictures', '0123456789abcdef');

function pic(page, over = {}) {
	const id = `p${String(page).padStart(3, '0')}`;
	return Object.assign({ id, name: `${id}.jpg`, path: pathMod.join(PIC_DIR, `${id}.jpg`), alt: `Picture from the printed book, page ${page}`, bytes: 150000 }, over);
}

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
	assert.ok(p.embeds.length <= 10, `${where}: at most 10 embeds`);
	assert.ok(Array.isArray(p.files) && p.files.length <= 10, `${where}: a files array of at most 10`);
	const names = p.files.map(f => f.name);
	for (const e of p.embeds) {
		if (e.image) assert.ok(names.includes(e.image.url.replace(/^attachment:\/\//, '')), `${where}: ${e.image.url} is attached`);
		// An image-only embed (a page's second picture onwards) has no title, text or footer.
		if (e.image && !e.title) {
			assert.deepStrictEqual(Object.keys(e).sort(), ['color', 'image'], `${where}: image-only`);
			continue;
		}
		assert.ok(e.title.length <= 256, `${where}: title`);
		assert.ok(e.description.length <= 4096, `${where}: description`);
		assert.ok(e.footer.text.length <= 2048, `${where}: footer`);
	}
	for (const f of p.files) assert.ok(f.description.length <= 1024, `${where}: alt text`);
	assert.deepStrictEqual(p.allowedMentions, { parse: [] });
}

test('a DM page has ◀ ▶ 📍 ↪ ✖ and a row of its own for 📌, all bookpage ids carrying the start word in base 36', () => {
	const p = page();
	assertDiscordShape(p, 'dm');
	assert.deepStrictEqual(p.components.map(r => r.components.map(b => b.custom_id.split(':')[1])), [['prev', 'next', 'now', 'play', 'off'], ['mark']]);
	assert.strictEqual(p.components[1].components[0].emoji.name, '📌');
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
	assert.ok(!ids(mine).some(id => id.startsWith('bookpage:mark:')), 'no 📌 on an ephemeral page, not even the listener\'s');
	const dmNone = card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: 'Prologue', mode: 'following', isListener: true });
	assert.ok(!ids(dmNone).some(id => id.startsWith('bookpage:mark:')), 'no 📌 where there is no first word to pin');
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
		assert.deepStrictEqual(p.files, [], `${name}: an edit to a stub clears a picture`);
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

test('an omnibus book the ebook lacks is named on the no-text page, escaped like a TOC label', () => {
	const p = card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: null, notInEbook: 'Book 5: The *Extra* Book', mode: 'following', isListener: true });
	assertDiscordShape(p, 'not in the ebook');
	assert.match(p.embeds[0].description, /Book 5: The \\\*Extra\\\* Book is not in the ebook, so there is no text for it\. The narrated text has ended\./);
	assert.doesNotMatch(p.embeds[0].description, /intro, credits or music/);
});

test('the no-text page\'s buttons say so, and parsePageId reads the mark back', () => {
	const p = card.noTextPayload({ surface: 'e', sid: 'a1b2c3', tag: '9f0c', word: 720, bookTitle: 'B', resumesAt: 'Chapter 1', mode: 'snapshot', isListener: true });
	for (const id of ids(p)) assert.deepStrictEqual(card.parsePageId(id), { act: id.split(':')[1], surface: 'e', sid: 'a1b2c3', tag: '9f0c', word: 720, none: true });
	assert.strictEqual(card.parsePageId('bookpage:next:d:a1b2c3:9f0c:1:x'), null);
});

test('the 📌 confirmation and the marked level read in the footer', () => {
	const p = page({ quality: { level: 'marked', label: 'marked' }, extra: '📌 Marked at 1:02:03' });
	assert.match(p.embeds[0].footer.text, /Approximate · dramatized edition · marked · page 3 of 9 · 📌 Marked at 1:02:03 · following the narration/);
	assert.deepStrictEqual(card.parsePageId(p.components[1].components[0].custom_id), { act: 'mark', surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 12345 });
});

// ---- pictures ---------------------------------------------------------------------------------

test('every payload the card builds carries its own files array, and only a page with pictures fills it', () => {
	const built = [
		page(),
		page({ surface: 'e', mode: 'snapshot', isListener: false }),
		card.noTextPayload({ surface: 'd', sid: 'a1b2c3', tag: '9f0c', word: 0, bookTitle: 'B', resumesAt: null, mode: 'following', isListener: true }),
		card.preparingPayload({ bookTitle: 'B' }),
		card.endedStub({ bookTitle: 'B' }),
		card.offStub(),
		card.movedStub(),
		card.noticePayload('x')
	];
	for (const p of built) assert.deepStrictEqual(p.files, []);
	// discord.js writes into some arrays it is handed, so no two payloads may share one.
	assert.strictEqual(new Set(built.map(p => p.files)).size, built.length);
	assert.deepStrictEqual(page({ pictures: [pic(22)], pictureCount: 1 }).files.map(f => f.name), ['p022.jpg']);
});

test('a page\'s first picture goes in its own embed, the rest in image-only embeds, each with its file and alt text', () => {
	const p = page({ pictures: [pic(28, { id: 'p028-029', name: 'p028-029.jpg', path: pathMod.join(PIC_DIR, 'p028-029.jpg') }), pic(30)], pictureCount: 2 });
	assertDiscordShape(p, 'two pictures');
	assert.strictEqual(p.embeds.length, 2);
	assert.strictEqual(p.embeds[0].image.url, 'attachment://p028-029.jpg');
	assert.ok(p.embeds[0].description.includes('alpha'), 'embeds[0] is still the text');
	assert.deepStrictEqual(p.embeds[1], { color: p.embeds[0].color, image: { url: 'attachment://p030.jpg' } });
	assert.deepStrictEqual(p.files, [
		{ attachment: pathMod.join(PIC_DIR, 'p028-029.jpg'), name: 'p028-029.jpg', description: 'Picture from the printed book, page 28' },
		{ attachment: pathMod.join(PIC_DIR, 'p030.jpg'), name: 'p030.jpg', description: 'Picture from the printed book, page 30' }
	]);
	assert.doesNotMatch(p.embeds[0].footer.text, /🖼/);
	assert.ok(ids(p).every(id => id.startsWith('bookpage:')), 'a picture page is still a page: the command log redacts it');
});

test('more than 10 pictures, or more than 8 MB, keeps the first that fit and the footer says how many', () => {
	const twelve = [];
	for (let n = 1; n <= 12; n++) twelve.push(pic(n));
	const many = page({ pictures: twelve, pictureCount: 12 });
	assertDiscordShape(many, 'twelve');
	assert.strictEqual(card.MAX_PAGE_PICTURES, 10);
	assert.deepStrictEqual(many.files.map(f => f.name), twelve.slice(0, 10).map(x => x.name));
	assert.match(many.embeds[0].footer.text, /page 3 of 9 · 🖼 10 of 12 pictures · following the narration/);
	const big = [pic(1, { bytes: 3 * 1024 * 1024 }), pic(2, { bytes: 3 * 1024 * 1024 }), pic(3, { bytes: 3 * 1024 * 1024 }), pic(4, { bytes: 1000 })];
	const heavy = page({ pictures: big, pictureCount: 4 });
	assert.deepStrictEqual(heavy.files.map(f => f.name), ['p001.jpg', 'p002.jpg'], `${card.MAX_MESSAGE_BYTES} bytes at most, in reading order`);
	assert.match(heavy.embeds[0].footer.text, /🖼 2 of 4 pictures/);
});

test('a picture is attached only with a bot-made name, a local absolute path and a known size, once', () => {
	const bad = [
		pic(1, { name: '../p001.jpg' }),
		pic(2, { name: 'p002.png' }),
		pic(3, { path: 'https://example.test/p003.jpg' }),
		pic(4, { path: '\\\\host\\share\\p004.jpg' }),
		pic(5, { path: '//host/share/p005.jpg' }),
		pic(6, { path: 'p006.jpg' }),
		pic(7, { bytes: undefined }),
		pic(8),
		pic(8)
	];
	const p = page({ pictures: bad, pictureCount: bad.length });
	assert.deepStrictEqual(p.files.map(f => f.name), ['p008.jpg']);
	assert.deepStrictEqual(p.embeds.map(e => e.image && e.image.url), ['attachment://p008.jpg']);
	assert.match(p.embeds[0].footer.text, /🖼 1 of 9 pictures/);
	assert.strictEqual(page({ pictures: [pic(9, { alt: 'x'.repeat(2000) })] }).files[0].description.length, 1024);
});

test('stripPictures gives the same page with no picture, no image-only embed and files: []', () => {
	const twelve = [];
	for (let n = 1; n <= 12; n++) twelve.push(pic(n));
	const p = page({ pictures: twelve, pictureCount: 12 });
	const s = card.stripPictures(p);
	assert.deepStrictEqual(s.files, []);
	assert.strictEqual(s.embeds.length, 1);
	assert.strictEqual(s.embeds[0].image, undefined);
	assert.strictEqual(s.embeds[0].description, p.embeds[0].description);
	assert.strictEqual(s.embeds[0].footer.text, page().embeds[0].footer.text, 'no "10 of 12" on a page that shows none');
	assert.deepStrictEqual([s.content, s.components, s.allowedMentions], [p.content, p.components, p.allowedMentions]);
	assertDiscordShape(s, 'stripped');
	assert.strictEqual(p.files.length, 10, 'the payload it was given is unchanged');
	assert.strictEqual(p.embeds[0].image.url, 'attachment://p001.jpg');
	assert.deepStrictEqual(card.stripPictures(card.movedStub()), card.movedStub());
});
