// helpers/readAlong.js: 📌 sync marks on the listener's DM page.
//
// The bug: a 📌 that pins the moment the button was handled instead of the moment it was clicked,
// so every mark lands a round trip late; no allowance for the listener's reaction; a mark taken on
// a page the listener had browsed to, chapters from the voice; a second try at the same spot that
// leaves two marks fighting; a mark that only the marker's page ever sees, until a restart; 📌
// offered on the 📖 page, or a forged one from someone in the voice channel accepted; a mark made
// against one parse of the ebook applied to another; a 📌 click whose reply carries book text.
//
// Harness: the real pager on test/helpers/readAlongFakes.js (manual clock, fake director, a source
// serving a synthetic NATO-alphabet ebook, a recording Discord client) and the real
// helpers/bookTextStore.js on pid-suffixed temp files, so a mark goes through the same store the
// marks commands read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-readalong-marks-${process.pid}`);
process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE = `${BASE}-marks.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-works.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const T = require('./helpers/readAlongFakes.js');
const textStore = require('../helpers/bookTextStore.js');
const { createReadAlong } = require('../helpers/readAlong.js');
const card = require('../helpers/readAlongCard.js');
const buttons = require('../helpers/readAlongButtons.js');
const commandLog = require('../helpers/commandLog.js');

const SIX = [1, 2, 3, 4, 5, 6].map(n => ({ label: `Chapter ${n}`, words: 900 }));
const ANA = { id: 'u1', username: 'Ana' };
const BEN = { id: 'u2', username: 'Ben' };

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	textStore.reset();
}

let open = [];
test.beforeEach(cleanup);
test.afterEach(() => {
	for (const ra of open) ra.shutdown();
	open = [];
	cleanup();
});
test.after(cleanup);

function harness({ session = {}, sections = SIX, parts = null } = {}) {
	const clock = T.manualClock();
	const text = T.makeText(sections);
	const work = T.makeWork(sections, { parts });
	const books = T.fakeBooks(clock);
	const source = T.fakeSource(text);
	const client = T.fakeClient();
	const logs = [];
	const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
	const ra = createReadAlong({
		client, books, source, store: textStore, logger, timers: clock,
		cfg: { commandPrefix: '!', audiobookTextEnabled: true },
		catalog: { work: () => null }
	});
	open.push(ra);
	const s = books.add(Object.assign({ work }, session));
	const exp = T.expectedPages(work, text);
	return { clock, text, work, books, source, client, ra, s, logs, map: exp.map, pages: exp.pages, bot: { books, readAlong: ra } };
}

async function openPage(h, ms) {
	h.books.setPos(h.s, ms);
	await h.ra.turnOn({ userId: 'u1' });
	return h.client.sent[0];
}

function click(h, msg, act, word, { user = ANA, sid = null, surface = 'd', guild = null, captured = null, report = null } = {}) {
	const id = { act, surface, sid: sid || h.s.id, tag: h.text.handle.tag, word };
	const interaction = T.fakeInteraction({ customId: card.pageId(id), user, message: msg, guild });
	return h.ra.onPageButton(interaction, id, { captured, report: report || (() => {}) }).then(() => interaction);
}

function last(msg) {
	return msg.edits.length ? msg.edits[msg.edits.length - 1] : msg.first;
}

function footer(payload) {
	return payload.embeds[0].footer.text;
}

function said(interaction) {
	return interaction.calls.filter(c => c[0] === 'followUp').map(c => c[1].content).join('\n');
}

function marks(h) {
	return textStore.marks.list(h.work);
}

test('📌 pins the page\'s first word to the click less 700 ms, and the page snaps there', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[1].word, 'the map puts 70 s on the second page');
	const P = h.pages[2];
	await click(h, msg, 'mark', P.word);
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word, m.text, m.tag, m.by]), [[69300, P.word, h.text.handle.base, h.text.handle.tag, 'u1']]);
	assert.strictEqual(T.pageWordOf(last(msg)), P.word, 'the DM page shows the marked page');
	assert.match(footer(last(msg)), /marked · page 3 of 5 · 📌 Marked at 0:01:09 · following the narration/);
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), P.word, 'the map itself moved: 📖 shows it too');
	h.books.pause(h.s);
	await T.flush();
	assert.doesNotMatch(footer(last(msg)), /Marked at/, 'the confirmation shows once');
	assert.match(footer(last(msg)), /paused/);
});

test('the reaction allowance is wall-clock: at 2x it is 1.4 s of audio', async () => {
	const h = harness({ session: { speed: 2 } });
	const msg = await openPage(h, 70000);
	await click(h, msg, 'mark', h.pages[2].word);
	assert.deepStrictEqual(marks(h).map(m => m.ms), [68600]);
});

test('the position is taken as the click arrives, before the deferUpdate round trip', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	const customId = card.pageId({ act: 'mark', surface: 'd', sid: h.s.id, tag: h.text.handle.tag, word: h.pages[2].word });
	const i = T.fakeInteraction({ customId, user: ANA, message: msg });
	i.deferUpdate = async () => {
		i.calls.push(['deferUpdate']);
		h.books.setPos(h.s, 75000);
	};
	assert.strictEqual(await buttons.handle(i, h.bot, null, {}), true);
	assert.deepStrictEqual(marks(h).map(m => m.ms), [69300]);
});

// Two hour-long splits that name no chapter, over the same six 900-word chapters.
const HOUR_SPLITS = [0, 1].map(i => ({ ordinal: i + 1, title: `Part 0${i + 1}`, durationMs: 900000, partKey: `/p/${i}`, file: `p${i}.mp3` }));

test('on hour splits a page far from the narration is refused with a note; within 10 pages it is taken even in another chapter', async () => {
	const h = harness({ parts: HOUR_SPLITS });
	const msg = await openPage(h, 70000);
	const far = h.pages[15];
	const i = await click(h, msg, 'mark', far.word);
	assert.match(said(i), /too far from where the narrator is\. Page to where the narrator is, and press 📌 when the voice reaches the page's first words/);
	assert.deepStrictEqual(marks(h), []);
	assert.strictEqual(msg.edits.length, 0, 'the page on screen is left alone');
	h.books.setPos(h.s, 290000);
	const near = h.pages[10];
	const j = await click(h, msg, 'mark', near.word);
	assert.strictEqual(said(j), '');
	assert.deepStrictEqual(marks(h).map(m => m.word), [near.word], 'six pages on, in chapter 3, while the pace estimate is in chapter 1');
});

// The bug: while a chapter-named track played, a 📌 on a page up to 10 pages into the next chapter
// was taken. The chapter's start is exact there, so that pin is a misclick, and as a mark it beat
// the next chapter's own track end and start and turned the stretch after it into 'marked' pace.
test('a page in another chapter is refused while a chapter-named track plays, however near', async () => {
	const h = harness();
	const msg = await openPage(h, 290000);
	const chapterOf = (p) => h.pages.filter(x => x.sec === p.sec);
	const next = chapterOf(h.pages[5]);
	assert.notStrictEqual(next[0].sec, h.pages[0].sec, 'the fixture: page 6 opens chapter 2');
	const i = await click(h, msg, 'mark', next[0].word);
	assert.match(said(i), /📌 That page is outside the chapter now playing\./);
	assert.deepStrictEqual(marks(h), []);
	assert.strictEqual(msg.edits.length, 0, 'the page on screen is left alone');
	h.books.setPos(h.s, 300000 + 60000);
	const back = await click(h, msg, 'mark', h.pages[4].word);
	assert.match(said(back), /outside the chapter now playing/, 'the chapter before is refused too');
	assert.ok(!/alpha|bravo|charlie|delta/i.test(said(i) + said(back)), 'no book text in the note');
	assert.deepStrictEqual(marks(h), []);
	const same = await click(h, msg, 'mark', next[2].word);
	assert.strictEqual(said(same), '');
	assert.deepStrictEqual(marks(h).map(m => m.word), [next[2].word], 'a later page of the chapter playing is taken');
});

test('a 📌 on the next chapter\'s first page 400 ms into its track is taken, though the allowance lands in the chapter before', async () => {
	const h = harness();
	const msg = await openPage(h, 300000 + 400);
	const first = h.pages.find(p => p.sec === h.pages[5].sec);
	const i = await click(h, msg, 'mark', first.word);
	assert.strictEqual(said(i), '');
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word]), [[299700, first.word]]);
});

test('two 📌 at two later pages of one chapter are both stored and both used', async () => {
	const ONE = [{ label: 'Chapter 1', words: 5400 }, { label: 'Chapter 2', words: 900 }];
	const h = harness({ sections: ONE });
	const msg = await openPage(h, 600000);
	const at = (w) => h.pages.findIndex(p => p.word === w);
	const first = h.pages[at(T.pageWordOf(last(msg))) + 2];
	await click(h, msg, 'mark', first.word);
	h.books.setPos(h.s, 1200000);
	await T.flush();
	const plainSecond = h.pages[at(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')))];
	const second = h.pages[at(plainSecond.word) + 2];
	assert.strictEqual(second.sec, first.sec, 'the fixture: both pins are in chapter 1');
	const j = await click(h, msg, 'mark', second.word);
	assert.strictEqual(said(j), '');
	const stored = marks(h);
	assert.deepStrictEqual(stored.map(m => [m.ms, m.word]), [[599300, first.word], [1199300, second.word]]);
	const model = require('../helpers/readAlongModel.js');
	const map = model.buildMap(h.work, h.text.index, { extraAnchors: stored });
	assert.deepStrictEqual(map.marks.used.slice().sort(), stored.map(m => m.id).sort());
	for (const [m, P] of [[stored[0], first], [stored[1], second]]) {
		h.books.setPos(h.s, m.ms + 1000);
		const page = await h.ra.ephemeralFor(h.s, 'u1');
		assert.strictEqual(T.pageWordOf(page), P.word, `the pager follows the pin at ${m.ms} ms`);
		assert.match(footer(page), /marked/);
	}
});

test('a later listen uses the saved pins with no new click', async () => {
	const ONE = [{ label: 'Chapter 1', words: 5400 }, { label: 'Chapter 2', words: 900 }];
	const h = harness({ sections: ONE });
	const msg = await openPage(h, 600000);
	const at = (w) => h.pages.findIndex(p => p.word === w);
	const plain = at(T.pageWordOf(last(msg)));
	const P = h.pages[plain + 2];
	await click(h, msg, 'mark', P.word);
	assert.strictEqual(marks(h).length, 1);
	h.ra.shutdown();
	open = open.filter(ra => ra !== h.ra);
	textStore.reset();
	const later = harness({ sections: ONE, session: { id: 'c3d4e5', atMs: 600000 + 1000 } });
	assert.strictEqual(later.text.handle.base, h.text.handle.base, 'the fixture: the same ebook text');
	assert.strictEqual(later.client.sent.length, 0);
	const page = await later.ra.ephemeralFor(later.s, 'u1');
	assert.strictEqual(T.pageWordOf(page), P.word, `the marked page, not page ${plain + 1} of the plain map`);
	assert.match(footer(page), / · marked · /);
	const model = require('../helpers/readAlongModel.js');
	const map = model.buildMap(later.work, later.text.index, { extraAnchors: textStore.marks.list(later.work) });
	assert.deepStrictEqual(model.msToWord(map, 599300), { word: P.word, level: 'marked', segmentIndex: model.msToWord(map, 599300).segmentIndex });
});

test('a mark within 20 s of another, or on the same word, replaces it; a mark further on is added', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	await click(h, msg, 'mark', h.pages[2].word);
	h.books.setPos(h.s, 85000);
	await click(h, msg, 'mark', h.pages[3].word);
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word]), [[84300, h.pages[3].word]], '15 s apart: replaced');
	h.books.setPos(h.s, 130000);
	await click(h, msg, 'mark', h.pages[3].word);
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word]), [[129300, h.pages[3].word]], 'the same word: replaced');
	h.books.setPos(h.s, 200000);
	await click(h, msg, 'mark', h.pages[4].word);
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word]), [[129300, h.pages[3].word], [199300, h.pages[4].word]]);
});

test('every open page of the same recording re-renders on its next event after a mark', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	const s2 = h.books.add({ id: 'b2c3d4', guildId: 'g2', userId: 'u2', listenerName: 'Ben', voiceChannelId: 'v2', work: h.work, atMs: 250000 });
	await h.ra.turnOn({ userId: 'u2' });
	const other = h.client.sent[1];
	assert.strictEqual(other.userId, 'u2');
	h.books.emit(s2, 'moved');
	await T.flush();
	assert.strictEqual(other.edits.length, 0, 'nothing changed for Ben yet');
	await click(h, msg, 'mark', h.pages[2].word);
	h.books.emit(s2, 'moved');
	await h.clock.advance(2000);
	assert.strictEqual(other.edits.length, 1, 'Ben\'s page re-rendered');
	assert.strictEqual(T.pageWordOf(last(other)), T.pageWordOf(other.first), 'on the same page: only the map\'s revision changed');
	assert.match(footer(last(other)), /marked/);
	assert.doesNotMatch(footer(last(other)), /Marked at/, 'the confirmation is the marker\'s alone');
});

test('the 📖 page has no 📌, and a forged one is refused for the listener and for the voice channel', async () => {
	const h = harness();
	h.books.setPos(h.s, 70000);
	const page = await h.ra.ephemeralFor(h.s, 'u1');
	assert.ok(!page.components.flatMap(r => r.components).some(b => b.custom_id.startsWith('bookpage:mark:')));
	const mine = await click(h, null, 'mark', h.pages[2].word, { surface: 'e' });
	assert.match(said(mine), /Marks are set from your DM page \(`!book text on`\)/);
	const guild = T.fakeGuild('g1');
	guild.join('u2', 'v1');
	const theirs = await click(h, null, 'mark', h.pages[2].word, { surface: 'e', user: BEN, guild });
	assert.match(said(theirs), /Only Ana, the listener, can set marks/);
	assert.deepStrictEqual(marks(h), []);
});

test('someone other than the listener cannot mark from the listener\'s DM page', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	const i = await click(h, msg, 'mark', h.pages[2].word, { user: BEN });
	assert.deepStrictEqual(marks(h), []);
	const answer = i.calls.find(c => c[0] === 'editReply');
	assert.ok(answer && answer[1].components.length === 0 && answer[1].embeds.length === 0, 'a stub, no text');
	assert.strictEqual(msg.edits.length, 0);
});

test('a paused book refuses a mark', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	h.books.pause(h.s);
	await T.flush();
	const i = await click(h, msg, 'mark', h.pages[2].word);
	assert.match(said(i), /Marks need the book playing/);
	assert.deepStrictEqual(marks(h), []);
});

test('marks made against another parse of the ebook are ignored, not deleted, and return with it', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	await click(h, msg, 'mark', h.pages[2].word);
	const original = h.source.text;
	h.source.text = T.makeText(SIX, { base: 'ffee0011aabbccdd' });
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), h.pages[1].word, 'the new text maps 70 s by the tracks alone');
	assert.strictEqual(marks(h).length, 1, 'the mark is still stored');
	h.source.text = original;
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), h.pages[2].word);
});

test('a 📌 click reports no book text, logs ids only, and the page it edits is logged as private', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	const reported = [];
	await click(h, msg, 'mark', h.pages[15].word, { report: p => reported.push(p) });
	await click(h, msg, 'mark', h.pages[2].word, { report: p => reported.push(p) });
	assert.strictEqual(reported.length, 1, 'only the refusal is a reply');
	assert.ok(!reported[0].embeds && !/alpha|bravo|charlie|delta/.test(reported[0].content));
	assert.ok(!/alpha|bravo|charlie|delta/.test(JSON.stringify(h.logs)));
	assert.ok(h.logs.some(l => /Read-along: mark [0-9a-f]{8} at 69300 ms, word \d+\./.test(l[0])));
	const logged = commandLog.summarise(last(msg));
	assert.strictEqual(logged.embeds[0].title, '[book text not logged]');
	assert.strictEqual(logged.embeds[0].description, null);
});

// Five-minute chapter tracks of 900 words each, with intro and credits tracks of two minutes.
function tracks(titles) {
	return titles.map((title, i) => ({ ordinal: i + 1, title, durationMs: /Intro|Credits/.test(title) ? 120000 : 300000, partKey: `/p/${i}`, file: `p${i}.mp3` }));
}

// The bug: a 📌 pressed during the closing credits, after paging back from the "no text" page to
// the last chapter, was accepted. The model pinned it to the credits' end, which beat the chapter's
// own track end, so the rest of that chapter fell to 'pace' for every listener.
test('a 📌 while the closing credits play is refused, even on a page of the last chapter', async () => {
	const h = harness({ parts: tracks([...SIX.map(x => x.label), 'Closing Credits']) });
	const msg = await openPage(h, 6 * 300000 + 60000);
	const lastChapter = h.pages.filter(p => p.sec === h.pages[h.pages.length - 1].sec);
	const i = await click(h, msg, 'mark', lastChapter[1].word);
	assert.match(said(i), /📌 The narrator is not reading the ebook here/);
	assert.deepStrictEqual(marks(h), []);
	assert.strictEqual(msg.edits.length, 0);
});

test('a 📌 while an omnibus plays a book the ebook leaves out is refused', async () => {
	const sections = [
		{ label: 'Alpha Test', words: 20 }, { label: '1', words: 900 }, { label: '2', words: 900 },
		{ label: 'Beta Test', words: 20 }, { label: '1', words: 900 }, { label: '2', words: 900 },
	];
	const parts = tracks([
		'Book 1 - Alpha Test - Chapter 1', 'Book 1 - Alpha Test - Chapter 2',
		'Book 2 - Extra Bits - Chapter 1', 'Book 2 - Extra Bits - Chapter 2',
		'Book 3 - Beta Test - Chapter 1', 'Book 3 - Beta Test - Chapter 2',
	]);
	const h = harness({ sections, parts });
	assert.ok(h.map.books, 'the fixture is an omnibus');
	const msg = await openPage(h, 2 * 300000 + 60000);
	const bookOneEnd = h.pages.filter(p => p.sec === 2);
	const i = await click(h, msg, 'mark', bookOneEnd[1].word);
	assert.match(said(i), /📌 The narrator is not reading the ebook here/);
	assert.deepStrictEqual(marks(h), []);
});

test('a 📌 on a chapter\'s first page just after an intro is taken, though its allowance lands in the intro', async () => {
	const h = harness({ parts: tracks(['Chapter 1', 'Part Two Intro', ...SIX.slice(1).map(x => x.label)]) });
	const start = 300000 + 120000;
	const msg = await openPage(h, start + 300);
	const first = h.pages.find(p => p.sec === 1);
	assert.strictEqual(T.pageWordOf(last(msg)), first.word);
	const i = await click(h, msg, 'mark', first.word);
	assert.strictEqual(said(i), '');
	assert.deepStrictEqual(marks(h).map(m => [m.ms, m.word]), [[start - 400, first.word]]);
	assert.match(footer(last(msg)), /📌 Marked at 0:06:59/);
});

// The bug: after a mark moved the map back, the other readers of the recording were only
// re-timed. A timed turn never goes back, so a reader left pages ahead of the voice stayed there,
// with the old sync label, until the narration caught up minutes later.
test('another reader of the recording left ahead of the voice by a mark jumps back without an engine event', async () => {
	const ONE = [{ label: 'Chapter 1', words: 5400 }, { label: 'Chapter 2', words: 900 }];
	const h = harness({ sections: ONE, session: { atMs: 600000 } });
	const msg = await openPage(h, 600000);
	const s2 = h.books.add({ id: 'b2c3d4', guildId: 'g2', userId: 'u2', listenerName: 'Ben', voiceChannelId: 'v2', work: h.work, atMs: 610000 });
	await h.ra.turnOn({ userId: 'u2' });
	const other = h.client.sent[1];
	const at = (w) => h.pages.findIndex(p => p.word === w);
	const ana = at(T.pageWordOf(last(msg)));
	const ben = at(T.pageWordOf(last(other)));
	await click(h, msg, 'mark', h.pages[ana - 8].word);
	assert.strictEqual(marks(h).length, 1);
	await h.clock.advance(2000);
	const now = at(T.pageWordOf(last(other)));
	assert.ok(now <= ben - 6, `Ben went from page ${ben} to page ${now}`);
	assert.match(footer(last(other)), /marked/);
});

// The bug: marks were tied to a recording only by its work id, so a narration replaced in place
// (same folder, same id) inherited the old narration's marks, and they beat its own chapters.
test('marks made against another recording under the same work id are ignored, not deleted', async () => {
	const h = harness();
	const msg = await openPage(h, 70000);
	await click(h, msg, 'mark', h.pages[2].word);
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), h.pages[2].word);
	const original = h.s.work;
	h.s.work = Object.assign({}, original, { parts: original.parts.map(p => Object.assign({}, p, { durationMs: p.durationMs + 30000 })) });
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), h.pages[1].word, 'the new recording maps 70 s by its tracks alone');
	assert.strictEqual(marks(h).length, 1, 'the mark is still stored');
	h.s.work = original;
	assert.strictEqual(T.pageWordOf(await h.ra.ephemeralFor(h.s, 'u1')), h.pages[2].word);
});
