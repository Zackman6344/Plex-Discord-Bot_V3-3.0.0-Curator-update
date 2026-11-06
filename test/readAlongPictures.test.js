// helpers/readAlong.js with the pictures of a scanned PDF (helpers/bookPictures.js): which page
// carries which picture, and that no message keeps one it should not.
//
// The bug: a picture left on screen after its page turned (an edit with no `files` keeps the old
// attachments), above all on the refusal that replaces the 📖 page of someone who left the voice
// channel; a picture shown a page early (its word at a page's end); a page frozen because Discord
// refused one upload or the sweep deleted one JPG; a pictures change that edits every open page,
// or another book's, or draws a page from a text that changed or after the pager shut down; a
// pictures change that lands while the first DM is on its way and is lost;
// the setting turned off with pictures still showing; a picture placed in back matter the
// narration never reaches, which never shows; a card render or a failed open that starts reading a
// PDF; a picture's path in the bot log.
//
// Harness: the real pager on test/helpers/readAlongFakes.js (a manual clock, a fake director, a
// synthetic NATO-alphabet ebook, a recording Discord client) with fakePictures() standing in for
// helpers/bookPictures.js: it serves the pictures a test puts on a work, by word, and emits changes
// as the real one does. The 📖 clicks go through the real helpers/readAlongButtons.js. discord.js
// never sees these payloads, so a picture's path names nothing; the one file written is a cache
// pair in a temp folder, for the handle's paths.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');
const fs = require('node:fs');

const T = require('./helpers/readAlongFakes.js');
const { createReadAlong, narratedPictures } = require('../helpers/readAlong.js');
const model = require('../helpers/readAlongModel.js');
const card = require('../helpers/readAlongCard.js');
const buttons = require('../helpers/readAlongButtons.js');

const TWO = [{ label: 'Chapter 1', words: 900 }, { label: 'Chapter 2', words: 900 }];
// Back matter no label list knows, so it counts as body.
const BACKED = [...TWO, { label: 'A Second Look', words: 300 }];
const ANA = { id: 'u1', username: 'Ana' };
const BEN = { id: 'u2', username: 'Ben' };

// The map of the end-matter fix to readAlongModel.buildMap (b28486b, on experimental but not yet
// on this branch): a chapter with no keyed section after it ends at its own last word, so back
// matter that counts as body is no longer narrated. This branch's map with its last narrated
// stretch cut at the end of its own section; checked equal to that fix's segments on BACKED and on
// the real #384 index. A no-op once the fix is merged.
function endsAtOwnWord(map) {
	const segs = map.segments;
	let k = segs.length - 1;
	while (k >= 0 && segs[k].level === 'none') k--;
	const sec = map.sections[model.locate(map, segs[k].fromWord).section];
	segs[k] = Object.assign({}, segs[k], { toWord: Math.min(segs[k].toWord, sec.wordStart + sec.words) });
	return map;
}
const OWN_END_MODEL = Object.assign({}, model, { buildMap: (...a) => endsAtOwnWord(model.buildMap(...a)) });

function memoryStore() {
	const on = new Map();
	return {
		readers: {
			isOn: u => on.get(String(u)) === true,
			set: (u, v) => {
				if (v) on.set(String(u), true);
				else on.delete(String(u));
				return true;
			}
		}
	};
}

let open = [];
test.afterEach(() => {
	for (const ra of open) ra.shutdown();
	open = [];
});

// `workSections` names the audio's tracks when they differ from the ebook's sections; `mapModel`
// is the readAlongModel the pager builds its map with.
function harness({ sections = TWO, workSections = sections, session = {}, status = 'ready', mapModel = model } = {}) {
	const clock = T.manualClock();
	const text = T.makeText(sections);
	const work = T.makeWork(workSections);
	const books = T.fakeBooks(clock);
	const source = T.fakeSource(text, { status });
	const client = T.fakeClient();
	const store = memoryStore();
	const pics = T.fakePictures();
	const logs = [];
	const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
	const ra = createReadAlong({
		client, books, source, store, logger, timers: clock, pictures: pics, model: mapModel,
		cfg: { commandPrefix: '!', audiobookTextEnabled: true },
		catalog: { work: () => null }
	});
	open.push(ra);
	const s = books.add(Object.assign({ work }, session));
	const exp = T.expectedPages(work, text);
	return { clock, text, work, books, source, client, store, pics, logs, ra, s, guild: T.fakeGuild('g1'), map: mapModel.buildMap(work, text.index), pages: exp.pages };
}

/** A harness whose listener has the DM page open on page 0, which holds printed page 22. */
async function onPicturePage(over = {}) {
	const h = harness(Object.assign({ session: { audible: false } }, over));
	h.pic = h.pics.picture(22, h.pages[0].word + 40);
	h.pics.set(h.work.id, [h.pic]);
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	h.msg = h.client.sent[0];
	assert.deepStrictEqual(h.msg.first.files.map(f => f.name), ['p022.jpg'], 'the page went out with its picture');
	return h;
}

function last(msg) {
	return msg.edits.length ? msg.edits[msg.edits.length - 1] : msg.first;
}

function images(payload) {
	return (payload.embeds || []).map(e => (e.image ? e.image.url : null));
}

function pageButton(h, act, surface, word) {
	return card.pageId({ act, surface, sid: h.s.id, tag: h.text.handle.tag, word });
}

function clickDm(h, msg, act, word, user = ANA) {
	const id = card.parsePageId(pageButton(h, act, 'd', word));
	const interaction = T.fakeInteraction({ customId: pageButton(h, act, 'd', word), user, message: msg });
	return h.ra.onPageButton(interaction, id).then(() => interaction);
}

// Through the real router, as Discord delivers a click: bookread:<sid> (📖 on the card) or a
// bookpage: id on the 📖 page.
async function press(h, customId, user) {
	const i = T.fakeInteraction({ customId, user, guild: h.guild });
	await buttons.handle(i, { books: h.books, readAlong: h.ra }, null, {});
	return i;
}

function lastReply(i) {
	const replies = i.calls.filter(c => c[0] === 'editReply');
	return replies[replies.length - 1][1];
}

function enoent(file) {
	return Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), { code: 'ENOENT', errno: -4058, syscall: 'stat', path: file });
}

// ---- which page carries which picture -----------------------------------------------------------

test('a page holding a picture\'s word carries it in the page embed, with the file named to match', async () => {
	const h = await onPicturePage();
	const first = h.msg.first;
	assert.strictEqual(T.pageWordOf(first), h.pages[0].word);
	assert.deepStrictEqual(images(first), ['attachment://p022.jpg'], 'one card: text, picture, footer');
	assert.match(first.embeds[0].description, /\w/, 'the text stays in the same embed');
	assert.deepStrictEqual(first.files, [{ attachment: h.pic.path, name: 'p022.jpg', description: 'Picture from the printed book, page 22' }]);
	assert.doesNotMatch(first.embeds[0].footer.text, /🖼/, 'nothing was left out, so the footer says nothing');
});

test('the next turn edits the page with files: [], so the picture goes with its page', async () => {
	const h = harness();
	h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	await h.clock.advance(model.wordToMs(h.map, h.pages[0].endWord) + 1000);
	assert.deepStrictEqual(T.wordsOf(msg), [h.pages[0].word, h.pages[1].word]);
	assert.deepStrictEqual(last(msg).files, []);
	assert.deepStrictEqual(images(last(msg)), [null]);
});

test('a picture whose word is a page\'s endWord belongs to the next page', async () => {
	const h = harness();
	h.pics.set(h.work.id, [h.pics.picture(23, h.pages[0].endWord)]);
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	assert.deepStrictEqual(msg.first.files, []);
	await h.clock.advance(model.wordToMs(h.map, h.pages[0].endWord) + 1000);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[1].word);
	assert.strictEqual(h.pages[1].word, h.pages[0].endWord);
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p023.jpg']);
});

test('pictures on one page go in reading order: word, then printed page; the first in the page embed', async () => {
	const h = harness({ session: { audible: false } });
	const w = h.pages[0].word;
	const late = h.pics.picture(31, w + 120);
	const text = h.pics.picture(30, w + 10);
	const spread = h.pics.picture(28, w + 10, { spread: true });
	h.pics.set(h.work.id, [late, text, spread]);
	await h.ra.turnOn({ userId: 'u1' });
	const first = h.client.sent[0].first;
	assert.deepStrictEqual(first.files.map(f => f.name), ['p028-029.jpg', 'p030.jpg', 'p031.jpg']);
	assert.deepStrictEqual(images(first), ['attachment://p028-029.jpg', 'attachment://p030.jpg', 'attachment://p031.jpg']);
	assert.ok(first.embeds[0].title && first.embeds[0].description, 'embeds[0] stays the text embed');
	for (const e of first.embeds.slice(1)) assert.deepStrictEqual(Object.keys(e).sort(), ['color', 'image'], 'the rest are image-only');
});

test('the 📖 page carries the same pictures for the listener and a voice member, and none for someone outside', async () => {
	const h = harness({ session: { audible: false } });
	h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	const ana = lastReply(await press(h, `bookread:${h.s.id}`, ANA));
	assert.deepStrictEqual(ana.files.map(f => f.name), ['p022.jpg']);
	h.guild.join('u2', 'v1');
	const ben = lastReply(await press(h, `bookread:${h.s.id}`, BEN));
	assert.deepStrictEqual(ben.files, ana.files);
	assert.deepStrictEqual(images(ben), images(ana));
	h.guild.leave('u2');
	const out = lastReply(await press(h, `bookread:${h.s.id}`, BEN));
	assert.deepStrictEqual(out.files, []);
	assert.deepStrictEqual(out.embeds, []);
	assert.match(out.content, /Join/);
});

// ---- nothing keeps a picture it should not -----------------------------------------------------------

const CLEARING = [
	['the book ended', async (h) => {
		h.books.end(h.s);
		await T.flush(10);
		return last(h.msg);
	}],
	['✖ Off on the page', async (h) => {
		await clickDm(h, h.msg, 'off', h.pages[0].word);
		return last(h.msg);
	}],
	['!book text off', async (h) => {
		await h.ra.turnOff('u1');
		await T.flush(10);
		return last(h.msg);
	}],
	['!book text now (the old page moved)', async (h) => {
		assert.strictEqual((await h.ra.sendNow('u1')).code, 'sent');
		assert.deepStrictEqual(h.client.sent[1].first.files.map(f => f.name), ['p022.jpg'], 'the fresh page has it');
		return last(h.msg);
	}],
	['a click on an older page', async (h) => {
		await h.ra.sendNow('u1');
		const i = await clickDm(h, h.msg, 'next', h.pages[0].word);
		return lastReply(i);
	}],
	['the book linked to off', async (h) => {
		h.source.openResult = { ok: false, code: 'off', text: 'Read-along is off for this book.' };
		h.books.setPos(h.s, 5000);
		h.books.emit(h.s, 'moved');
		await T.flush(10);
		return last(h.msg);
	}],
	['the read-along switched off in /config', async (h) => {
		h.source.openResult = { ok: false, code: 'disabled', text: 'Read-along is turned off.' };
		h.books.setPos(h.s, 5000);
		h.books.emit(h.s, 'moved');
		await T.flush(10);
		return last(h.msg);
	}],
	['a viewer who left the voice channel', async (h) => {
		h.guild.join('u2', 'v1');
		assert.deepStrictEqual(lastReply(await press(h, `bookread:${h.s.id}`, BEN)).files.map(f => f.name), ['p022.jpg']);
		h.guild.leave('u2');
		return lastReply(await press(h, pageButton(h, 'next', 'e', h.pages[0].word), BEN));
	}]
];

for (const [name, act] of CLEARING) {
	test(`after a picture page, ${name} leaves no picture on screen (files: [])`, async () => {
		const h = await onPicturePage();
		const p = await act(h);
		assert.ok(p, 'something was sent');
		assert.deepStrictEqual(p.files, [], name);
		assert.ok(images(p).every(x => x === null), name);
	});
}

// ---- pictures that change under an open page ----------------------------------------------------

test('a pictures change edits only the open page whose pictures changed, and no other work\'s page', async () => {
	const h = harness({ session: { audible: false } });
	const other = T.makeWork(TWO, { id: 'test-author/another-book', title: 'Another Book' });
	const s2 = h.books.add({ id: 'b2c3d4', userId: 'u2', guildId: 'g2', voiceChannelId: 'v2', work: h.work, audible: false });
	h.books.setPos(s2, model.wordToMs(h.map, h.pages[3].word) + 1000);
	const s3 = h.books.add({ id: 'c3d4e5', userId: 'u3', guildId: 'g3', voiceChannelId: 'v3', work: other, audible: false });
	for (const uid of ['u1', 'u2', 'u3']) assert.strictEqual((await h.ra.turnOn({ userId: uid })).code, 'sent', uid);
	const [m1, m2, m3] = h.client.sent;
	assert.strictEqual(T.pageWordOf(m2.first), h.pages[3].word);
	assert.strictEqual(s3.workId, other.id);

	h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	h.pics.set(other.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	h.pics.emit(h.work.id);
	await T.flush(10);
	assert.strictEqual(m1.edits.length, 1, 'the page that holds the new picture is drawn again');
	assert.deepStrictEqual(m1.edits[0].files.map(f => f.name), ['p022.jpg']);
	assert.strictEqual(T.pageWordOf(m1.edits[0]), h.pages[0].word, 'in place');
	assert.strictEqual(m2.edits.length, 0, 'same book, but its page has no picture: no edit');
	assert.strictEqual(m3.edits.length, 0, 'another book: not even looked at');

	h.pics.emit(h.work.id);
	await T.flush(10);
	assert.strictEqual(m1.edits.length, 1, 'nothing changed, nothing edited');
	h.pics.emit(other.id);
	await T.flush(10);
	assert.deepStrictEqual(m3.edits.map(p => p.files.map(f => f.name)), [['p022.jpg']]);
});

test('turning the setting off clears every open picture page at once, and on brings them back', async () => {
	const h = await onPicturePage();
	h.pics.setting = false;
	h.pics.emit('*');
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, 1);
	assert.deepStrictEqual(last(h.msg).files, []);
	assert.strictEqual(T.pageWordOf(last(h.msg)), h.pages[0].word, 'the same page, without the picture');
	h.pics.setting = true;
	h.pics.emit('*');
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, 2);
	assert.deepStrictEqual(last(h.msg).files.map(f => f.name), ['p022.jpg']);
});

test('a pictures change that leaves a page\'s own pictures as they were does not redraw it', async () => {
	const h = await onPicturePage();
	h.source.text = T.makeText(TWO, { base: 'b2c3d4e5f6071829' });
	h.source.emit(h.work.id);
	await T.flush(10);
	assert.match(last(h.msg).content, /text was updated/);
	assert.deepStrictEqual(last(h.msg).files.map(f => f.name), ['p022.jpg']);
	const edits = h.msg.edits.length;
	h.pics.set(h.work.id, [h.pic, h.pics.picture(25, h.pages[1].word + 3)]);
	h.pics.emit(h.work.id);
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, edits, 'only another page gained a picture, so this one keeps its note');
});

// A pictures redraw waits on the reader's chain and on the text's open. The page it would draw is
// the one on screen, in the text that page was drawn from: drawn against a newer text, it shows
// that text's page at the old one's place with no "text was updated" note, and the note never comes.
test('a pictures redraw queued while the text changes draws nothing; the text change draws the page, with its note', async () => {
	const h = await onPicturePage();
	let release;
	h.source.hold = new Promise(r => { release = r; });
	h.pics.set(h.work.id, [h.pic, h.pics.picture(23, h.pages[0].word + 60)]);
	h.pics.emit(h.work.id);
	await T.flush(10);
	h.source.text = T.makeText(TWO, { base: 'b2c3d4e5f6071829' });
	release();
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, 0, 'no page drawn from a text it was not drawn from');
	h.source.emit(h.work.id);
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, 1);
	assert.match(last(h.msg).content, /text was updated/);
	assert.strictEqual(card.parsePageId(last(h.msg).components[0].components[0].custom_id).tag, 'b2c3');
	assert.deepStrictEqual(last(h.msg).files.map(f => f.name), ['p022.jpg', 'p023.jpg'], 'with the pictures the change brought');
});

// On !restart a page's reader can outlive its pager: a redraw queued behind an edit in flight must
// not edit the page once the pager has shut down.
test('a pictures redraw queued as the pager shuts down draws nothing', async () => {
	const h = await onPicturePage();
	let release;
	h.source.hold = new Promise(r => { release = r; });
	h.source.emit(h.work.id);
	await T.flush(10);
	h.pics.set(h.work.id, [h.pic, h.pics.picture(23, h.pages[0].word + 60)]);
	h.pics.emit(h.work.id);
	h.ra.shutdown();
	release();
	await T.flush(10);
	assert.strictEqual(h.msg.edits.length, 0);
	assert.ok(h.ra._reader('u1'), 'the reader was still there to draw');
});

test('a page the listener browsed to is redrawn in browsing mode when its pictures change', async () => {
	const h = await onPicturePage();
	h.pics.set(h.work.id, [h.pic, h.pics.picture(25, h.pages[1].word + 3)]);
	await clickDm(h, h.msg, 'next', h.pages[0].word);
	assert.deepStrictEqual(last(h.msg).files.map(f => f.name), ['p025.jpg']);
	h.pics.set(h.work.id, [h.pic]);
	h.pics.emit(h.work.id);
	await T.flush(10);
	assert.strictEqual(T.pageWordOf(last(h.msg)), h.pages[1].word, 'still the browsed page');
	assert.deepStrictEqual(last(h.msg).files, []);
	assert.match(last(h.msg).embeds[0].footer.text, /browsing/);
});

// The first open of a book in a run loads its kept set in the background, and the DM's REST round
// trip usually outlasts that load: the change is emitted while the reader has no message to edit.
test('pictures that arrive while the first DM is on its way are drawn once it lands', async () => {
	const h = harness({ session: { audible: false } });
	h.client.dmFail = () => {
		h.client.dmFail = null;
		h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
		h.pics.emit(h.work.id);
		return null;
	};
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	await T.flush(10);
	const msg = h.client.sent[0];
	assert.deepStrictEqual(msg.first.files, [], 'built before the set arrived');
	assert.strictEqual(msg.edits.length, 1);
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p022.jpg']);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[0].word, 'in place');
	await h.clock.advance(1000);
	assert.strictEqual(msg.edits.length, 1, 'drawn once');
});

test('pictures switched off while the first DM is on its way are cleared once it lands', async () => {
	const h = harness({ session: { audible: false } });
	h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	h.client.dmFail = () => {
		h.client.dmFail = null;
		h.pics.setting = false;
		h.pics.emit('*');
		return null;
	};
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	await T.flush(10);
	const msg = h.client.sent[0];
	assert.deepStrictEqual(msg.first.files.map(f => f.name), ['p022.jpg'], 'built before the switch');
	assert.strictEqual(msg.edits.length, 1);
	assert.deepStrictEqual(last(msg).files, []);
	assert.deepStrictEqual(images(last(msg)), [null]);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[0].word, 'the same page, without the picture');
});

test('a first DM whose pictures did not change during the send is not drawn again', async () => {
	const h = harness({ session: { audible: false } });
	h.pics.set(h.work.id, [h.pics.picture(22, h.pages[0].word + 40)]);
	h.client.dmFail = () => {
		h.client.dmFail = null;
		h.pics.emit(h.work.id);
		return null;
	};
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	await T.flush(10);
	assert.strictEqual(h.client.sent[0].edits.length, 0);
});

// ---- where the narration reaches a picture -------------------------------------------------------

test('narratedPictures keeps a narrated word, else takes a narrated fallback, else keeps the word', () => {
	// A chapter-named track per chapter, an intro before them, and back matter [1800, 2100) that is
	// body but that no stretch narrates.
	const map = {
		segments: [
			{ fromMs: 0, toMs: 5000, fromWord: 0, toWord: 0, level: 'none' },
			{ fromMs: 5000, toMs: 300000, fromWord: 0, toWord: 900, level: 'chapter' },
			{ fromMs: 300000, toMs: 600000, fromWord: 900, toWord: 1800, level: 'chapter' }
		],
		bodyEndWord: 2100
	};
	const pic = (page, word, fallback) => Object.freeze(Object.assign({ id: `p${page}`, word, pages: Object.freeze([page]) }, fallback === undefined ? {} : { fallback }));
	const own = pic(240, 1500, 1499);
	const late = pic(256, 1795);
	const moved = pic(259, 1800, 1700);
	const stuck = pic(262, 1850, 1820);
	const bare = pic(264, 1900);
	const list = Object.freeze([own, late, moved, stuck, bare]);
	const out = narratedPictures(list, map);
	assert.deepStrictEqual(out.map(p => [p.id, p.word]), [['p240', 1500], ['p259', 1700], ['p256', 1795], ['p262', 1850], ['p264', 1900]], 'sorted again by word after the move');
	assert.strictEqual(out[0], own, 'a picture that stays is the set\'s own');
	assert.deepStrictEqual(Object.assign({}, out[1], { word: 1800 }), Object.assign({}, moved), 'only the word changes');
	assert.strictEqual(moved.word, 1800, 'the set is not changed');
	assert.strictEqual(narratedPictures(list, { segments: [{ fromMs: 0, toMs: 600000, fromWord: 0, toWord: 2100, level: 'pace' }] }), list, 'every word narrated: the list itself');
	const words = m => narratedPictures([pic(259, 1800, 1700)], m)[0].word;
	assert.strictEqual(words({ segments: [...map.segments, { fromMs: 600000, toMs: 600000, fromWord: 1800, toWord: 2100, level: 'none' }] }), 1700, 'a no-text stretch narrates nothing');
	assert.strictEqual(words({ segments: [...map.segments.slice(0, 2), { fromMs: 300000, toMs: 600000, fromWord: 1750, toWord: 1800, level: 'pace' }] }), 1800, 'a jump left the fallback unnarrated too: the word stays');
	assert.strictEqual(words({ segments: [...map.segments.slice(0, 2), { fromMs: 300000, toMs: 600000, fromWord: 900, toWord: 1801, level: 'pace' }] }), 1800, 'a stretch that reaches its own word keeps it');
	assert.strictEqual(words(null), 1800, 'no map: the word');
	assert.deepStrictEqual(narratedPictures(null, map), []);
});

// A track of its own narrates the back matter, with or without the end-matter fix.
test('a picture keeps its own page while the map narrates its word, even with a fallback', async () => {
	const h = harness({ sections: BACKED, workSections: BACKED, session: { audible: false } });
	const back = h.pages.find(p => p.sec === 2);
	const before = h.pages[h.pages.indexOf(back) - 1];
	assert.ok(h.map.segments.some(x => x.level !== 'none' && x.fromWord <= back.word && back.word < x.toWord), 'the back matter is narrated');
	h.pics.set(h.work.id, [h.pics.picture(259, back.word, { fallback: back.word - 1 })]);
	h.books.setPos(h.s, model.wordToMs(h.map, before.word) + 1000);
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	const msg = h.client.sent[0];
	assert.strictEqual(T.pageWordOf(msg.first), before.word);
	assert.deepStrictEqual(msg.first.files, []);
	await clickDm(h, msg, 'next', before.word);
	assert.strictEqual(T.pageWordOf(last(msg)), back.word);
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p259.jpg']);
});

test('under a map whose last chapter ends before the back matter, a picture there shows on its fallback\'s page', async () => {
	const h = harness({ sections: BACKED, workSections: TWO, session: { audible: false }, mapModel: OWN_END_MODEL });
	const back = h.pages.find(p => p.sec === 2);
	const before = h.pages[h.pages.indexOf(back) - 1];
	const fallback = back.word - 1;
	assert.ok(before.word <= fallback && fallback < before.endWord, 'the fallback is the last word of the page before');
	assert.strictEqual(h.map.segments[h.map.segments.length - 1].toWord, back.word, 'the last chapter ends at its own last word');
	h.pics.set(h.work.id, [h.pics.picture(259, back.word, { fallback })]);
	h.books.setPos(h.s, model.wordToMs(h.map, before.word) + 1000);
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	const msg = h.client.sent[0];
	assert.strictEqual(T.pageWordOf(msg.first), before.word);
	assert.deepStrictEqual(msg.first.files.map(f => f.name), ['p259.jpg'], 'on the page that holds the fallback');
	await clickDm(h, msg, 'next', before.word);
	assert.strictEqual(T.pageWordOf(last(msg)), back.word);
	assert.deepStrictEqual(last(msg).files, [], 'and no longer on its own page');
	const i = await press(h, pageButton(h, 'prev', 'e', back.word), ANA);
	assert.deepStrictEqual(lastReply(i).files.map(f => f.name), ['p259.jpg'], 'the 📖 page places it the same way');
});

test('a picture whose fallback the map does not narrate either keeps its own word', async () => {
	const h = harness({ sections: BACKED, workSections: TWO, session: { audible: false }, mapModel: OWN_END_MODEL });
	const back = h.pages.find(p => p.sec === 2);
	const before = h.pages[h.pages.indexOf(back) - 1];
	const back2 = h.pages[h.pages.indexOf(back) + 1];
	assert.strictEqual(back2.sec, 2, 'the back matter has a second page');
	h.pics.set(h.work.id, [h.pics.picture(262, back2.word + 10, { fallback: back.word + 10 })]);
	h.books.setPos(h.s, model.wordToMs(h.map, before.word) + 1000);
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	assert.deepStrictEqual(msg.first.files, []);
	await clickDm(h, msg, 'next', before.word);
	assert.strictEqual(T.pageWordOf(last(msg)), back.word);
	assert.deepStrictEqual(last(msg).files, [], 'not moved to its unnarrated fallback');
	await clickDm(h, msg, 'next', back.word);
	assert.strictEqual(T.pageWordOf(last(msg)), back2.word);
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p262.jpg'], 'still on the page that holds its word');
});

test('the placement is worked out once per set and map, not on every render', async () => {
	const h = harness({ sections: BACKED, workSections: TWO, session: { audible: false }, mapModel: OWN_END_MODEL });
	const back = h.pages.find(p => p.sec === 2);
	const before = h.pages[h.pages.indexOf(back) - 1];
	h.pics.set(h.work.id, [h.pics.picture(259, back.word, { fallback: back.word - 1 })]);
	// The real module serves one frozen set object until it installs another.
	let set = h.pics.forText(h.work, h.text.handle);
	h.pics.forText = () => set;
	const lists = [];
	const between = h.pics.between;
	h.pics.between = (list, ...rest) => {
		lists.push(list);
		return between(list, ...rest);
	};
	h.books.setPos(h.s, model.wordToMs(h.map, before.word) + 1000);
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	await clickDm(h, msg, 'next', before.word);
	await clickDm(h, msg, 'prev', back.word);
	await press(h, `bookread:${h.s.id}`, ANA);
	assert.ok(lists.length >= 4, `${lists.length}`);
	assert.strictEqual(new Set(lists).size, 1, 'one placement for every render');
	assert.notStrictEqual(lists[0], set.pictures, 'the picture was moved to its fallback');
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p259.jpg']);

	set = Object.assign({}, set);
	await clickDm(h, msg, 'next', before.word);
	assert.strictEqual(new Set(lists).size, 2, 'a new set is placed again');

	const marks = [{ id: 'k1', ms: model.wordToMs(h.map, h.pages[2].word), word: h.pages[2].word, text: h.text.handle.base, rec: null, at: 1 }];
	h.store.marks = { list: () => marks };
	await clickDm(h, msg, 'prev', back.word);
	assert.strictEqual(new Set(lists).size, 3, 'a mark\'s new map is placed again');
	assert.deepStrictEqual(last(msg).files.map(f => f.name), ['p259.jpg']);
});

// ---- when a PDF is looked at ------------------------------------------------------------------

test('opening a text asks for its pictures once per open, never on a failed open, a card render or a probe', async () => {
	const h = harness({ session: { audible: false } });
	h.books.textInfo(h.s);
	h.books.emit(h.s, 'started');
	await T.flush(10);
	assert.ok(h.source.calls.some(c => c[0] === 'probe'), 'the start probe ran');
	assert.deepStrictEqual(h.pics.callsOf('ensure'), [], 'a card render and a probe never look at the PDF');
	await h.ra.turnOn({ userId: 'u1' });
	assert.deepStrictEqual(h.pics.callsOf('ensure'), [['ensure', h.work.id, h.text.handle]]);
	await h.ra.sendNow('u1');
	assert.strictEqual(h.pics.callsOf('ensure').length, 2);

	const f = harness();
	f.source.openResult = { ok: false, code: 'no-ebook', text: 'No ebook was found for this book.' };
	assert.strictEqual((await f.ra.turnOn({ userId: 'u1' })).code, 'no-ebook');
	assert.deepStrictEqual(f.pics.callsOf('ensure'), []);
});

test('a text handle with its cache paths reaches the pictures as the source opened it', async () => {
	const dir = pathMod.join(os.tmpdir(), `plexbot-test-readalong-pictures-${process.pid}`);
	try {
		const text = T.makeText(TWO, { paths: dir });
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(text.handle.indexPath, 'utf8')), text.index);
		const sec = text.index.sections[1];
		assert.strictEqual(fs.readFileSync(text.handle.textPath).subarray(sec.byteStart, sec.byteStart + sec.byteLen).toString('utf8'), text.texts[1]);
		const h = harness({ session: { audible: false } });
		h.source.text = text;
		await h.ra.turnOn({ userId: 'u1' });
		const [, , handle] = h.pics.callsOf('ensure')[0];
		assert.strictEqual(handle, text.handle);
		assert.deepStrictEqual([handle.textPath, handle.indexPath], [pathMod.join(dir, `${text.handle.base}.txt`), pathMod.join(dir, `${text.handle.base}.json`)]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---- a refused upload or a missing file ---------------------------------------------------------

test('a missing file (ENOENT) on the first DM sends the page once more without its pictures', async () => {
	const h = harness({ session: { audible: false } });
	const pic = h.pics.picture(22, h.pages[0].word + 40);
	h.pics.set(h.work.id, [pic]);
	const tries = [];
	h.client.dmFail = (p) => {
		tries.push(p);
		return p.files.length ? enoent(pic.path) : null;
	};
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	assert.strictEqual(tries.length, 2);
	assert.strictEqual(h.client.sent.length, 1, 'one DM');
	const first = h.client.sent[0].first;
	assert.strictEqual(T.pageWordOf(first), h.pages[0].word);
	assert.deepStrictEqual(first.files, []);
	assert.deepStrictEqual(images(first), [null]);
	assert.ok(h.ra._reader('u1'), 'the reader follows on as usual');
});

test('Discord refusing an edit\'s upload (40005) sends the page once more without its pictures', async () => {
	const h = await onPicturePage();
	h.pics.set(h.work.id, [h.pic, h.pics.picture(25, h.pages[1].word + 3)]);
	let tries = 0;
	h.msg.editFail = (p) => {
		tries++;
		return p.files.length ? 40005 : null;
	};
	await clickDm(h, h.msg, 'next', h.pages[0].word);
	assert.strictEqual(tries, 2);
	assert.strictEqual(h.msg.edits.length, 1);
	assert.strictEqual(T.pageWordOf(last(h.msg)), h.pages[1].word, 'the page still turned');
	assert.deepStrictEqual(last(h.msg).files, []);
	assert.deepStrictEqual(images(last(h.msg)), [null]);
});

test('a 413 on a 📖 page click answers once more without pictures', async () => {
	const h = harness({ session: { audible: false } });
	h.pics.set(h.work.id, [h.pics.picture(25, h.pages[1].word + 3)]);
	const i = T.fakeInteraction({ customId: pageButton(h, 'next', 'e', h.pages[0].word), user: ANA, guild: h.guild });
	const sent = i.editReply;
	const tries = [];
	i.editReply = async (p) => {
		tries.push(p);
		if (p.files.length) throw Object.assign(new Error('Request entity too large'), { status: 413 });
		return sent(p);
	};
	await buttons.handle(i, { books: h.books, readAlong: h.ra }, null, {});
	assert.deepStrictEqual(tries.map(p => p.files.length), [1, 0]);
	assert.strictEqual(T.pageWordOf(lastReply(i)), h.pages[1].word);
});

test('a missing file on the first 📖 click answers once more without pictures, and an unrelated failure is not retried', async () => {
	const h = harness({ session: { audible: false } });
	const pic = h.pics.picture(22, h.pages[0].word + 40);
	h.pics.set(h.work.id, [pic]);
	const i = T.fakeInteraction({ customId: `bookread:${h.s.id}`, user: ANA, guild: h.guild });
	const sent = i.editReply;
	const tries = [];
	i.editReply = async (p) => {
		tries.push(p);
		if (p.files && p.files.length) throw enoent(pic.path);
		return sent(p);
	};
	await buttons.handle(i, { books: h.books, readAlong: h.ra }, null, {});
	assert.deepStrictEqual(tries.map(p => p.files.length), [1, 0]);
	assert.strictEqual(T.pageWordOf(lastReply(i)), h.pages[0].word, 'the page, not "Preparing"');
	assert.deepStrictEqual(images(lastReply(i)), [null]);
	assert.ok(!JSON.stringify(h.logs).includes('.jpg'), 'no picture name in the log');

	const j = T.fakeInteraction({ customId: `bookread:${h.s.id}`, user: ANA, guild: h.guild });
	const once = [];
	j.editReply = async (p) => {
		once.push(p);
		throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
	};
	await buttons.handle(j, { books: h.books, readAlong: h.ra }, null, {});
	assert.strictEqual(once.length, 1, 'only a refusal of the pictures is retried');
});

test('a deleted DM page (10008) still drops the reader, and other refusals are not retried without pictures', async () => {
	const h = await onPicturePage();
	h.pics.set(h.work.id, [h.pic, h.pics.picture(25, h.pages[1].word + 3)]);
	let tries = 0;
	h.msg.editFail = () => {
		tries++;
		return 50035;
	};
	await clickDm(h, h.msg, 'next', h.pages[0].word);
	assert.strictEqual(tries, 1, 'an invalid form is not about the pictures');
	assert.ok(h.ra._reader('u1'), 'and keeps the reader');
	h.msg.editFail = () => {
		tries++;
		return 10008;
	};
	await clickDm(h, h.msg, 'prev', h.pages[1].word);
	assert.strictEqual(tries, 2);
	assert.strictEqual(h.ra._reader('u1'), null);
	assert.strictEqual(h.msg.edits.length, 0);
});

test('a pictures module that throws costs the pictures, never the page', async () => {
	const h = harness({ session: { audible: false } });
	h.pics.forText = () => { throw enoent(pathMod.join(h.pics.dir, 'p022.jpg')); };
	h.pics.ensure = () => { throw enoent(pathMod.join(h.pics.dir, 'p022.jpg')); };
	h.pics.status = () => { throw enoent(pathMod.join(h.pics.dir, 'p022.jpg')); };
	assert.strictEqual((await h.ra.turnOn({ userId: 'u1' })).code, 'sent');
	assert.deepStrictEqual(h.client.sent[0].first.files, []);
	assert.doesNotMatch(await h.ra.status('u1'), /🖼/);
	assert.ok(h.logs.some(l => /^Read-along pictures:/.test(l[0])), 'logged by code');
});

// ---- the status line, the log and shutdown ----------------------------------------------------------

test('!book text puts the 🖼 line after the sync lines and before the DM line', async () => {
	const h = await onPicturePage();
	h.pics.statusValue = { state: 'ready', count: 3, pdfId: 1 };
	const lines = (await h.ra.status('u1')).split('\n');
	const at = lines.findIndex(l => l.startsWith('🖼'));
	assert.strictEqual(lines[at], '🖼 ready: 3 pictures (!book link)', 'the module\'s own line, with the prefix');
	assert.ok(lines.findIndex(l => l.startsWith('🔗 Sync')) < at);
	assert.strictEqual(lines[at + 1], '📩 Your page is in your DMs.');
	assert.deepStrictEqual(h.pics.callsOf('status').map(c => [c[1], c[2]]), [[h.work.id, h.text.handle]]);
	h.pics.statusValue = null;
	assert.doesNotMatch(await h.ra.status('u1'), /🖼/, 'no line when the module has nothing to say');
});

test('no logger line names a picture or its path', async () => {
	const h = await onPicturePage();
	h.pics.set(h.work.id, [h.pic, h.pics.picture(25, h.pages[1].word + 3)]);
	h.msg.editFail = p => (p.files.length ? enoent(pathMod.join(h.pics.dir, 'p025.jpg')) : null);
	await clickDm(h, h.msg, 'next', h.pages[0].word);
	h.pics.status = () => { throw enoent(h.pic.path); };
	await h.ra.status('u1');
	const logged = JSON.stringify(h.logs);
	assert.match(logged, /Read-along pictures: a page went out without its pictures:","ENOENT"/);
	assert.ok(!logged.includes('.jpg') && !logged.includes('plexbot-fake-pictures'), logged);
});

// The fake above stands in for the module everywhere else; this pins what the pager relies on in
// the real one: its own between and statusLine travel with the instance, a word at `toWord` is the
// next page's, and with no book_text folder under the test runner it serves nothing.
test('the production wiring pairs helpers/bookPictures.js with its own between and statusLine', () => {
	const lib = require('../helpers/bookPictures.js');
	const clock = T.manualClock();
	const text = T.makeText(TWO);
	const work = T.makeWork(TWO);
	const logs = [];
	const ra = createReadAlong({
		client: T.fakeClient(), books: T.fakeBooks(clock), source: T.fakeSource(text), store: memoryStore(), timers: clock,
		logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
		cfg: { commandPrefix: '!', audiobookTextEnabled: true, audiobookTextPictures: true },
		catalog: { work: () => null }
	});
	open.push(ra);
	assert.deepStrictEqual(logs, [], 'it started');
	assert.strictEqual(ra.pictures.between, lib.between);
	assert.strictEqual(ra.pictures.statusLine, lib.statusLine);
	for (const m of ['forText', 'ensure', 'status', 'describe', 'command', 'onChange', 'shutdown']) assert.strictEqual(typeof ra.pictures[m], 'function', m);
	assert.strictEqual(ra.pictures.forText(work, text.handle), null);
	const list = [{ id: 'p010', word: 5, bytes: 1 }, { id: 'p011', word: 10, bytes: 1 }];
	assert.deepStrictEqual(lib.between(list, 5, 10), { shown: [list[0]], count: 1 });
	assert.strictEqual(card.MAX_PAGE_PICTURES, lib.MAX_PAGE_PICTURES);
	assert.strictEqual(card.MAX_MESSAGE_BYTES, lib.MAX_MESSAGE_BYTES);
});

test('the pager exposes its pictures, and shutdown unhooks from them and shuts them down', () => {
	const h = harness();
	assert.strictEqual(h.ra.pictures, h.pics);
	assert.strictEqual(h.pics.listenerCount(), 1);
	h.ra.shutdown();
	assert.strictEqual(h.pics.listenerCount(), 0);
	assert.ok(h.pics.calls.some(c => c[0] === 'shutdown'));
});
