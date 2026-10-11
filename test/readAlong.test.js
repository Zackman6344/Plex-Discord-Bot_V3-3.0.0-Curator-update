// helpers/readAlong.js: the pager that keeps a DM page in step with the narration.
//
// The bug: a page that skips ahead at 2x or 3x (the display jumps to the estimate instead of
// turning one page at a time); a run of short pages that turns faster than Discord's edit limit;
// "Play from here" that lands on the previous page, or does not play a paused book, or rewinds;
// a seek that walks page by page through a whole chapter of edits; an old DM page fighting the
// new one over one reader; a closed DM that pings the channel with every play; a page that keeps
// turning after the book stopped; 📖 offered on a book with no ebook. From review: ▶ on the
// credits page skipping the first page of text; one failed section read leaving a reader that
// answers "already in your DMs" all session; a seek during the first send walking page by page;
// ↪'s pin hiding a back-30; a failed timed turn freezing the page; a fresh page left live when
// the book ended mid-send; a renamed work's source events missing the card; ✖ Off needing text.
// An omnibus page showing another book's chapter 1, or no word that a recorded book is missing
// from the ebook.
//
// Harness: the real pager with test/helpers/readAlongFakes.js: a manual clock whose advance()
// runs each due timer and lets the promise chains settle, a fake director whose session plays by
// that clock (position = anchor + elapsed x speed) and notifies like bookEngine.js, a source
// serving a synthetic NATO-alphabet ebook from memory, and a Discord client whose DM sends and
// edits are recorded. The readers store is an in-memory fake. Nothing touches disk.

const test = require('node:test');
const assert = require('node:assert');

const T = require('./helpers/readAlongFakes.js');
const { createReadAlong, MIN_TURN_GAP_MS, EDIT_COALESCE_MS } = require('../helpers/readAlong.js');
const model = require('../helpers/readAlongModel.js');
const card = require('../helpers/readAlongCard.js');

const TWO = [{ label: 'Chapter 1', words: 900 }, { label: 'Chapter 2', words: 900 }];

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

function harness({ sections = TWO, status = 'ready', session = {}, work = null } = {}) {
	const clock = T.manualClock();
	const text = T.makeText(sections);
	const w = work || T.makeWork(sections);
	const books = T.fakeBooks(clock);
	const source = T.fakeSource(text, { status });
	const client = T.fakeClient();
	const store = memoryStore();
	const logs = [];
	const logger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
	const ra = createReadAlong({
		client, books, source, store, logger, timers: clock,
		cfg: { commandPrefix: '!', audiobookTextEnabled: true },
		catalog: { work: () => null }
	});
	open.push(ra);
	const s = books.add(Object.assign({ work: w }, session));
	const exp = T.expectedPages(w, text);
	return { clock, text, work: w, books, source, client, store, logs, ra, s, map: exp.map, pages: exp.pages };
}

function click(h, msg, act, word, { tag = null, sid = null, user = { id: 'u1', username: 'Ana' } } = {}) {
	const id = { act, surface: 'd', sid: sid || h.s.id, tag: tag || h.text.handle.tag, word };
	const interaction = T.fakeInteraction({ customId: card.pageId(id), user, message: msg });
	return h.ra.onPageButton(interaction, id).then(() => interaction);
}

function last(msg) {
	return msg.edits.length ? msg.edits[msg.edits.length - 1] : msg.first;
}

function footer(payload) {
	return payload.embeds[0].footer.text;
}

// ---- opening ----------------------------------------------------------------------------------

test('turning on with a book playing sends one DM page at the narration\'s place', async () => {
	const h = harness({ session: { audible: false } });
	h.books.setPos(h.s, 70000);
	const r = await h.ra.turnOn({ userId: 'u1' });
	assert.strictEqual(r.code, 'sent');
	assert.strictEqual(h.client.sent.length, 1);
	assert.strictEqual(T.pageWordOf(h.client.sent[0].first), h.pages[1].word, '70 s is word 210, on the second page');
	assert.ok(h.store.readers.isOn('u1'), 'the preference is kept');
	assert.match(footer(h.client.sent[0].first), /following the narration/);
});

test('turning on with no book playing remembers the preference and sends nothing', async () => {
	const h = harness();
	h.books.end(h.s);
	const r = await h.ra.turnOn({ userId: 'u1' });
	assert.strictEqual(r.code, 'on');
	assert.match(r.text, /next book you play/);
	assert.strictEqual(h.client.sent.length, 0);
	assert.ok(h.store.readers.isOn('u1'));
});

test('a slow first read sends "Preparing" after 1.5 s, then the page; a quick one sends the page', async () => {
	const h = harness({ status: 'available', session: { audible: false } });
	let release;
	h.source.hold = new Promise(res => { release = res; });
	const pending = h.ra.turnOn({ userId: 'u1' });
	await T.flush();
	assert.strictEqual(h.client.sent.length, 0, 'nothing yet: the read may still answer quickly');
	await h.clock.advance(1500);
	const r = await pending;
	assert.strictEqual(r.code, 'preparing');
	const msg = h.client.sent[0];
	assert.match(msg.first.content, /Preparing the text/);
	assert.strictEqual(msg.first.components.length, 0, 'a stub carries no buttons and no text');
	release();
	await T.flush();
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[0].word);

	const quick = harness({ status: 'available', session: { audible: false } });
	assert.strictEqual((await quick.ra.turnOn({ userId: 'u1' })).code, 'sent');
	assert.strictEqual(T.pageWordOf(quick.client.sent[0].first), quick.pages[0].word);
});

test('a first read that fails quickly answers the command and sends no DM', async () => {
	const h = harness({ status: 'unknown' });
	h.source.openResult = { ok: false, code: 'calibre-unreachable', text: 'Calibre isn\'t answering.' };
	const r = await h.ra.turnOn({ userId: 'u1' });
	assert.deepStrictEqual([r.code, r.text], ['calibre-unreachable', 'Calibre isn\'t answering.']);
	assert.strictEqual(h.client.sent.length, 0);
	assert.strictEqual(h.ra._reader('u1'), null);
	assert.ok(h.store.readers.isOn('u1'), 'the preference stays on');
});

// ---- following --------------------------------------------------------------------------------

for (const speed of [1, 1.5, 2, 3]) {
	test(`following at ${speed}x shows every page of both sections once and in order`, async () => {
		const h = harness({ session: { speed } });
		await h.ra.turnOn({ userId: 'u1' });
		const msg = h.client.sent[0];
		const total = h.work.parts.reduce((n, p) => n + p.durationMs, 0);
		const boundary = h.work.parts[0].durationMs;
		let crossed = false;
		while (h.books.position(h.s) < total - 2000) {
			await h.clock.advance(1000);
			if (!crossed && h.books.position(h.s) >= boundary) {
				crossed = true;
				// What the engine sends at a part boundary: startAt's move, then the first frame.
				h.books.emit(h.s, 'moved');
				h.books.emit(h.s, 'audible');
				await T.flush();
			}
		}
		assert.deepStrictEqual(T.wordsOf(msg), h.pages.map(p => p.word));
	});
}

test('a run of 20-word pages turns one page per 12 s and skips none', async () => {
	const sections = [];
	for (let i = 1; i <= 6; i++) sections.push({ label: `Chapter ${i}`, words: 20 });
	sections.push({ label: 'Chapter 7', words: 900 });
	const h = harness({ sections });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	const times = [];
	const edit = msg.edit;
	msg.edit = (p) => { times.push(h.clock.now()); return edit(p); };
	const total = h.work.parts.reduce((n, p) => n + p.durationMs, 0);
	const bounds = [];
	let acc = 0;
	for (const p of h.work.parts) bounds.push(acc += p.durationMs);
	while (h.books.position(h.s) < total - 2000) {
		const before = h.books.position(h.s);
		await h.clock.advance(1000);
		if (bounds.some(b => before < b && h.books.position(h.s) >= b)) {
			h.books.emit(h.s, 'moved');
			h.books.emit(h.s, 'audible');
			await T.flush();
		}
	}
	assert.deepStrictEqual(T.wordsOf(msg), h.pages.map(p => p.word));
	for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= MIN_TURN_GAP_MS, `turn ${i} came ${times[i] - times[i - 1]} ms after the last`);
});

test('a seek past two pages goes straight to the estimate; a part boundary inside the window steps one page', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[6].word) + 1000);
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.deepStrictEqual(T.wordsOf(msg), [h.pages[0].word, h.pages[6].word], 'one edit, at the estimate, nothing in between');
	await h.clock.advance(MIN_TURN_GAP_MS);
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[7].word) + 1000);
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.deepStrictEqual(T.wordsOf(msg).slice(-1), [h.pages[7].word]);
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[9].word) + 1000);
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.strictEqual(T.wordsOf(msg).slice(-1)[0], h.pages[7].word, 'two pages ahead inside the 12 s gap: the turn timer takes it, not the event');
});

test('jumps within 1.5 s are coalesced into one trailing edit at the last estimate', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	for (const i of [5, 8, 3]) {
		h.books.setPos(h.s, model.wordToMs(h.map, h.pages[i].word) + 1000);
		h.books.emit(h.s, 'moved');
		await T.flush();
	}
	assert.deepStrictEqual(T.wordsOf(msg), [h.pages[0].word, h.pages[5].word], 'the first jump shows at once, the rest wait');
	await h.clock.advance(EDIT_COALESCE_MS);
	assert.deepStrictEqual(T.wordsOf(msg), [h.pages[0].word, h.pages[5].word, h.pages[3].word]);
});

test('an event that changes nothing on screen sends no edit', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	for (let i = 0; i < 3; i++) h.books.emit(h.s, 'audible');
	await T.flush();
	assert.strictEqual(h.client.sent[0].edits.length, 0);
});

test('pause shows the same page as paused and stops the turns; ended stubs the page', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	await h.clock.advance(5000);
	h.books.pause(h.s);
	await T.flush();
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[0].word);
	assert.match(footer(last(msg)), /paused/);
	const edits = msg.edits.length;
	await h.clock.advance(10 * 60000);
	assert.strictEqual(msg.edits.length, edits, 'no turn while paused');
	h.books.end(h.s);
	await T.flush();
	assert.deepStrictEqual(last(msg).components, [], 'the ended stub has no buttons');
	assert.match(last(msg).content, /stopped/);
	assert.strictEqual(h.ra._reader('u1'), null);
});

test('◀ ▶ browse and stop following until 📍 Now', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	await click(h, msg, 'next', h.pages[0].word);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[1].word);
	assert.match(footer(last(msg)), /browsing/);
	const edits = msg.edits.length;
	await h.clock.advance(5 * 60000);
	assert.strictEqual(msg.edits.length, edits, 'browsing never turns by itself');
	await click(h, msg, 'now', h.pages[1].word);
	const est = model.msToWord(h.map, h.books.position(h.s)).word;
	const want = h.pages.filter(p => p.word <= est).pop();
	assert.strictEqual(T.pageWordOf(last(msg)), want.word);
	assert.match(footer(last(msg)), /following/);
	await click(h, msg, 'prev', h.pages[5].word);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[4].word, '◀ crosses back into the previous chapter');
});

// ---- play from here ---------------------------------------------------------------------------

test('↪ sets the pin before the engine call and stays on the clicked page when the engine lands a word short', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	const P = h.pages[2];
	let seen = null;
	const emit = h.books.emit;
	h.books.emit = (s, kind) => {
		if (kind === 'moved' && !seen) {
			const r = h.ra._reader('u1');
			seen = { pin: r.pin && r.pin.word, follow: r.follow, shown: r.shown && r.shown.word, inControl: r.inControl };
		}
		emit(s, kind);
	};
	h.books.gotoOffsetMs = -400;
	await click(h, msg, 'play', P.word);
	assert.deepStrictEqual(seen, { pin: P.word, follow: true, shown: P.word, inControl: true });
	assert.deepStrictEqual(h.books.calls.map(c => c[0]), ['goto']);
	assert.strictEqual(T.pageWordOf(last(msg)), P.word);
	assert.match(footer(last(msg)), /following/);
	assert.ok(model.msToWord(h.map, h.books.position(h.s)).word < P.word, 'the engine landed a hair before the page');
	h.s.audible = true;
	h.books.setPos(h.s, h.books.position(h.s));
	h.books.emit(h.s, 'audible');
	await T.flush();
	assert.strictEqual(T.pageWordOf(last(msg)), P.word, 'the pin holds the clicked page');
	const endMs = model.wordToMs(h.map, P.endWord);
	await h.clock.advance(endMs - h.books.position(h.s) - 2000);
	assert.strictEqual(T.pageWordOf(last(msg)), P.word, 'still the clicked page just before its end');
	await h.clock.advance(3000 + MIN_TURN_GAP_MS);
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[3].word, 'then the next page, as usual');
	assert.strictEqual(h.ra._reader('u1').pin, null);
});

test('↪ on a paused book resumes and then moves, landing on the page start with no rewind', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.books.pause(h.s);
	await T.flush();
	const P = h.pages[4];
	await click(h, msg, 'play', P.word);
	assert.deepStrictEqual(h.books.calls.map(c => c[0]), ['resume', 'goto']);
	assert.strictEqual(h.s.state, 'playing');
	const pos = h.books.position(h.s);
	assert.strictEqual(pos, model.wordToMs(h.map, P.word), 'the goto superseded the resume\'s rewind');
	const w = model.msToWord(h.map, pos).word;
	assert.ok(w >= P.word && w < P.endWord);
	assert.strictEqual(T.pageWordOf(last(msg)), P.word);
	assert.match(footer(last(msg)), /following/);
});

test('a refused ↪ keeps the page, clears the pin and reports the engine\'s text', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.books.forbid = 'Still joining the voice channel, one moment.';
	const i = await click(h, msg, 'play', h.pages[3].word);
	const r = h.ra._reader('u1');
	assert.strictEqual(r.pin, null);
	assert.strictEqual(r.shown.word, h.pages[0].word, 'the reader still knows which page is on screen');
	assert.strictEqual(msg.edits.length, 0);
	const said = i.calls.find(c => c[0] === 'followUp');
	assert.ok(said && /Still joining/.test(said[1].content));
});

// ---- stopping, failures -----------------------------------------------------------------------

test('✖ Off stubs the page and clears the preference', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	await click(h, msg, 'off', h.pages[0].word);
	assert.match(last(msg).content, /Read-along is off/);
	assert.deepStrictEqual(last(msg).components, []);
	assert.strictEqual(h.store.readers.isOn('u1'), false);
	assert.strictEqual(h.ra._reader('u1'), null);
});

test('closed DMs: the command says so, and an automatic open posts one quiet line per session', async () => {
	const h = harness();
	h.client.dmFail = 50007;
	const r = await h.ra.turnOn({ userId: 'u1' });
	assert.strictEqual(r.code, 'dm-closed');
	assert.match(r.text, /DMs are closed/);
	assert.strictEqual(h.s.textChannel.sent.length, 0, 'a command reply already explains it');
	h.books.emit(h.s, 'started');
	await T.flush();
	h.books.emit(h.s, 'started');
	await T.flush();
	assert.strictEqual(h.s.textChannel.sent.length, 1, 'once per session');
	const line = h.s.textChannel.sent[0];
	assert.deepStrictEqual(line.allowedMentions, { parse: [] });
	assert.ok(!/<@/.test(line.content), 'no mention');
	assert.ok(!line.embeds && !line.components, 'one line, no page');
});

test('a deleted DM page (10008) drops the reader and keeps the preference', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	h.client.sent[0].editFail = 10008;
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[7].word));
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.strictEqual(h.ra._reader('u1'), null);
	assert.ok(h.store.readers.isOn('u1'));
});

// ---- started: the card's 📖 and the automatic page --------------------------------------------

test('started probes in the background and refreshes the card only when the 📖 answer changed', async () => {
	const h = harness({ status: 'unknown' });
	h.source.probeValue = 'available';
	assert.deepStrictEqual(h.ra.cardInfo(h.s), { button: false }, 'the first card render');
	h.books.emit(h.s, 'started');
	assert.strictEqual(h.source.calls.filter(c => c[0] === 'probe').length, 0, 'not inside the engine call');
	await T.flush();
	assert.strictEqual(h.source.calls.filter(c => c[0] === 'probe').length, 1);
	assert.deepStrictEqual(h.books.refreshes, [h.s.id]);
	h.books.emit(h.s, 'started');
	await T.flush();
	assert.deepStrictEqual(h.books.refreshes, [h.s.id], 'no change, no card edit');
	assert.strictEqual(h.client.sent.length, 0, 'the preference is off: no DM');
});

test('cardInfo offers 📖 only for a text that is ready or available, never for a podcast', () => {
	const h = harness();
	for (const [st, want] of [['ready', true], ['available', true], ['none', false], ['off', false], ['unknown', false]]) {
		h.source.statusValue = st;
		assert.deepStrictEqual(h.ra.cardInfo(h.s), { button: want }, st);
	}
	h.source.statusValue = 'ready';
	h.s.work = Object.assign({}, h.s.work, { kind: 'podcast' });
	assert.deepStrictEqual(h.ra.cardInfo(h.s), { button: false });
});

test('with the preference on, started opens a page; switching guilds stubs the old one and opens a new one', async () => {
	const h = harness({ session: { audible: false } });
	h.store.readers.set('u1', true);
	h.books.emit(h.s, 'started');
	await T.flush();
	assert.strictEqual(h.client.sent.length, 1);
	const old = h.client.sent[0];
	h.books.end(h.s);
	const b = h.books.add({ id: 'b2c3d4', guildId: 'g2', work: h.work, audible: false });
	h.books.emit(b, 'started');
	await T.flush();
	assert.match(last(old).content, /stopped/);
	assert.strictEqual(h.client.sent.length, 2);
	assert.strictEqual(h.ra._reader('u1').sid, 'b2c3d4');
	assert.strictEqual(h.ra._reader('u1').message, h.client.sent[1]);
});

test('no automatic page when the probe finds no ebook', async () => {
	const h = harness({ status: 'none' });
	h.store.readers.set('u1', true);
	h.books.emit(h.s, 'started');
	await T.flush();
	assert.strictEqual(h.client.sent.length, 0);
});

// ---- stale pages ------------------------------------------------------------------------------

test('a click on an older page turns only that page into "moved"; the current page is untouched', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const r = await h.ra.sendNow('u1');
	assert.strictEqual(r.code, 'sent');
	const [older, newer] = h.client.sent;
	assert.match(last(older).content, /moved/);
	const before = { message: h.ra._reader('u1').message, shown: h.ra._reader('u1').shown, edits: newer.edits.length };
	const i = await click(h, older, 'next', h.pages[0].word);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['editReply']);
	assert.match(i.calls[0][1].content, /moved/);
	assert.strictEqual(h.ra._reader('u1').message, before.message);
	assert.strictEqual(h.ra._reader('u1').shown, before.shown);
	assert.strictEqual(newer.edits.length, before.edits);
});

test('a page from before a restart is adopted when its user has a live book and no page', async () => {
	const h = harness({ session: { audible: false } });
	const orphan = h.client.makeMsg({ content: 'old', embeds: [], components: [] }, 'u1');
	await click(h, orphan, 'next', 0, { sid: 'ffffff' });
	assert.strictEqual(h.ra._reader('u1').message, orphan);
	assert.strictEqual(T.pageWordOf(last(orphan)), h.pages[0].word);
	assert.match(last(orphan).components[0].components[0].custom_id, new RegExp(`:${h.s.id}:`), 'now driven by the live session');
});

test('a page whose book is over, with no live book, becomes the ended stub', async () => {
	const h = harness();
	h.books.end(h.s);
	const orphan = h.client.makeMsg({ content: 'old', embeds: [], components: [] }, 'u1');
	const i = await click(h, orphan, 'next', 0);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['editReply']);
	assert.deepStrictEqual(i.calls[0][1].components, []);
	assert.strictEqual(h.ra._reader('u1'), null);
});

test('a button from an older text re-renders at the narration with a note, never at its word', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[2].word) + 1000);
	await click(h, msg, 'next', h.pages[8].word, { tag: 'ffff' });
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[2].word);
	assert.match(last(msg).content, /text was updated/);
});

test('the pager logs codes only, never a word of the book', async () => {
	const h = harness();
	h.client.dmFail = 'EWEIRD';
	await h.ra.turnOn({ userId: 'u1' });
	const logged = JSON.stringify(h.logs);
	assert.ok(h.logs.length >= 1, 'the failure was logged');
	assert.ok(!/alpha bravo|charlie delta/.test(logged));
});

test('shutdown unhooks from the director and shuts the source down', () => {
	const h = harness();
	assert.strictEqual(h.books.listenerCount(), 1);
	assert.strictEqual(typeof h.books.textInfo, 'function');
	h.ra.shutdown();
	assert.strictEqual(h.books.listenerCount(), 0);
	assert.strictEqual(h.books.textInfo, null);
	assert.ok(h.source.calls.some(c => c[0] === 'shutdown'));
});

// ---- review fixes -----------------------------------------------------------------------------

function buttonId(payload, act) {
	const b = payload.components[0].components.find(x => card.parsePageId(x.custom_id).act === act);
	return card.parsePageId(b.custom_id);
}

function press(h, msg, act) {
	const id = buttonId(last(msg), act);
	const interaction = T.fakeInteraction({ customId: card.pageId(id), user: { id: 'u1', username: 'Ana' }, message: msg });
	return h.ra.onPageButton(interaction, id).then(() => interaction);
}

function holdDms(client) {
	let release;
	const gate = new Promise(r => { release = r; });
	const fetch = client.users.fetch;
	client.users.fetch = async (uid) => {
		const u = await fetch(uid);
		const createDM = u.createDM;
		u.createDM = async () => {
			const dm = await createDM();
			const send = dm.send;
			dm.send = async (p) => { await gate; return send(p); };
			return dm;
		};
		return u;
	};
	return () => release();
}

const CH_MS = Math.round(900 * T.MS_PER_WORD);

function creditsWork(where) {
	const parts = [
		{ ordinal: 1, title: 'Chapter 1', durationMs: CH_MS, partKey: '/p/1' },
		{ ordinal: 2, title: 'Chapter 2', durationMs: CH_MS, partKey: '/p/2' }
	];
	const credits = { title: where === 'start' ? 'Opening Credits' : 'End Credits', durationMs: 30000, partKey: '/p/0' };
	if (where === 'start') parts.unshift(credits);
	else parts.push(credits);
	parts.forEach((p, i) => { p.ordinal = i + 1; });
	return T.makeWork(TWO, { parts });
}

function omnibusWork(sections) {
	const tracks = [[1, 'The First Test', 1], [1, 'The First Test', 2], [2, 'The Second Test', 1], [2, 'The Second Test', 2], [3, 'The Extra Test', 1]];
	const parts = tracks.map(([n, title, c], i) => ({ ordinal: i + 1, title: `Book ${n}  ${title} - Chapter 0${c}`, durationMs: CH_MS, partKey: `/p/${i}` }));
	return T.makeWork(sections, { parts });
}

test('an omnibus page follows its own book, and a recorded book the ebook lacks says so', async () => {
	const sections = [
		{ label: 'The First Test', words: 900 }, { label: '2', words: 900 },
		{ label: 'The Second Test', words: 20 }, { label: '1', words: 900 }, { label: '2', words: 900 }
	];
	const h = harness({ sections, work: omnibusWork(sections), session: { atMs: 10000, audible: false } });
	assert.match((await h.ra.ephemeralFor(h.s, 'u1')).embeds[0].title, /The First Test$/, 'book 1 chapter 1 is the heading section');
	h.books.setPos(h.s, 2 * CH_MS + 10000);
	assert.match((await h.ra.ephemeralFor(h.s, 'u1')).embeds[0].title, /· 1$/, 'book 2 chapter 1');
	h.books.setPos(h.s, 4 * CH_MS + 10000);
	const extra = (await h.ra.ephemeralFor(h.s, 'u1')).embeds[0].description;
	assert.match(extra, /Book 3: The Extra Test is not in the ebook/);
	assert.match(extra, /narrated text has ended/);
});

test('▶ on the opening-credits page shows the first page of the text, not the second', async () => {
	const h = harness({ work: creditsWork('start'), session: { atMs: 10000, audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	assert.match(last(msg).embeds[0].description, /No text for this part/);
	await press(h, msg, 'next');
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[0].word);
});

test('◀ on the "narrated text has ended" page shows the last page, not the one before it', async () => {
	const h = harness({ work: creditsWork('end'), session: { atMs: 2 * CH_MS + 10000, audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	assert.match(last(msg).embeds[0].description, /narrated text has ended/);
	await press(h, msg, 'prev');
	assert.strictEqual(T.pageWordOf(last(msg)), h.pages[h.pages.length - 1].word);
});

test('▶ on the 📖 page during the opening credits shows the first page of the text', async () => {
	const h = harness({ work: creditsWork('start'), session: { atMs: 10000, audible: false } });
	const page = await h.ra.ephemeralFor(h.s, 'u1');
	assert.match(page.embeds[0].description, /No text for this part/);
	const id = buttonId(page, 'next');
	const interaction = T.fakeInteraction({ customId: card.pageId(id), user: { id: 'u1', username: 'Ana' } });
	await h.ra.onPageButton(interaction, id);
	const answered = interaction.calls.find(c => c[0] === 'editReply')[1];
	assert.strictEqual(T.pageWordOf(answered), h.pages[0].word);
});

test('a page that fails to open leaves no reader behind, so the next !book text on sends one', async () => {
	const h = harness();
	const read = h.text.handle.readSection;
	let fail = 1;
	h.text.handle.readSection = async (i) => {
		if (fail-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
		return read(i);
	};
	const first = await h.ra.turnOn({ userId: 'u1' });
	assert.strictEqual(first.ok, false);
	assert.strictEqual(h.ra._reader('u1'), null);
	const again = await h.ra.turnOn({ userId: 'u1' });
	assert.strictEqual(again.code, 'sent');
	assert.strictEqual(h.client.sent.length, 1);
});

test('a seek while the first page is on its way jumps to the new place once the page arrives', async () => {
	const sections = [];
	for (let i = 1; i <= 4; i++) sections.push({ label: `Chapter ${i}`, words: 1800 });
	const h = harness({ sections });
	const release = holdDms(h.client);
	const pending = h.ra.turnOn({ userId: 'u1' });
	await T.flush(10);
	const ch3 = h.pages.find(p => h.map.sections[p.sec].label === 'Chapter 3');
	h.books.setPos(h.s, model.wordToMs(h.map, ch3.word));
	h.books.emit(h.s, 'moved');
	h.books.emit(h.s, 'audible');
	await T.flush(10);
	release();
	await pending;
	await T.flush(10);
	const msg = h.client.sent[0];
	assert.strictEqual(T.pageWordOf(last(msg)), ch3.word);
});

test('a deliberate rewind after ↪ shows the page the narration went back to', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	const P = h.pages[3];
	await click(h, msg, 'play', P.word);
	h.books.emit(h.s, 'audible');
	await T.flush();
	await h.clock.advance(10000);
	assert.strictEqual(T.pageWordOf(last(msg)), P.word);
	h.books.setPos(h.s, h.books.position(h.s) - 30000);
	h.books.emit(h.s, 'moved');
	await T.flush(10);
	const word = model.msToWord(h.map, h.books.position(h.s)).word;
	const want = h.pages.find(p => word >= p.word && word < p.endWord);
	assert.strictEqual(want.word, h.pages[2].word, 'the rewind crossed back a page');
	assert.strictEqual(T.pageWordOf(last(msg)), want.word);
	assert.strictEqual(h.ra._reader('u1').pin, null);
});

test('a timed turn that fails once tries again instead of leaving the page frozen', async () => {
	const sections = [{ label: 'Chapter 1', words: 400 }, { label: 'Chapter 2', words: 3000 }];
	const w = T.makeWork(sections, { parts: [{ ordinal: 1, title: 'Part 01', durationMs: Math.round(3400 * T.MS_PER_WORD), partKey: '/p/0' }] });
	const h = harness({ sections, work: w });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	const read = h.text.handle.readSection;
	let failed = false;
	h.text.handle.readSection = async (i) => {
		if (i === 1 && !failed) {
			failed = true;
			throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
		}
		return read(i);
	};
	await h.clock.advance(10 * 60 * 1000);
	assert.ok(failed, 'the read failed once');
	const word = model.msToWord(h.map, h.books.position(h.s)).word;
	const want = h.pages.find(p => word >= p.word && word < p.endWord);
	assert.ok(h.pages.indexOf(want) - h.pages.findIndex(p => p.word === T.pageWordOf(last(msg))) <= 1, 'the page kept up with the narration');
	assert.ok(h.clock.pending() >= 1, 'a turn is still scheduled');
});

test('a book that ends while !book text now is sending stubs the fresh page too', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const old = h.client.sent[0];
	const release = holdDms(h.client);
	const pending = h.ra.sendNow('u1');
	await T.flush(10);
	h.books.end(h.s);
	await T.flush(10);
	release();
	const res = await pending;
	await T.flush(10);
	const fresh = h.client.sent[1];
	assert.notStrictEqual(res.code, 'sent');
	assert.deepStrictEqual(old.edits.map(p => p.content), ['📕 The Fake Book: the book stopped, so this page did too.']);
	assert.deepStrictEqual(fresh.payload.components, [], 'no live buttons on the fresh page');
	assert.match(fresh.payload.content, /stopped/);
	assert.strictEqual(h.ra._reader('u1'), null);
});

test('a source change under a work\'s new id after a rename still refreshes the card', async () => {
	const h = harness({ status: 'unknown' });
	h.ra.shutdown();
	const ra = createReadAlong({
		client: h.client, books: h.books, source: h.source, store: h.store, logger: { info() {}, warn() {}, error() {} }, timers: h.clock,
		cfg: { commandPrefix: '!', audiobookTextEnabled: true },
		catalog: { work: id => (id === h.s.workId ? Object.assign({}, h.work, { id: 'test-author/the-fake-book-renamed' }) : null) }
	});
	open.push(ra);
	assert.deepStrictEqual(ra.cardInfo(h.s), { button: false });
	h.source.statusValue = 'ready';
	h.source.emit('test-author/the-fake-book-renamed');
	await T.flush();
	assert.deepStrictEqual(h.books.refreshes, [h.s.id]);
});

test('✖ Off on the DM page works even when the text can no longer be opened', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.source.openResult = { ok: false, code: 'drm', text: 'This ebook is DRM-protected, so its text can\'t be read.' };
	const i = await click(h, msg, 'off', h.pages[0].word);
	assert.strictEqual(h.store.readers.isOn('u1'), false);
	assert.match(last(msg).content, /Read-along is off/);
	assert.deepStrictEqual(last(msg).components, []);
	assert.ok(!i.calls.some(c => c[0] === 'followUp'));
	assert.strictEqual(h.ra._reader('u1'), null);
});

test('turning the read-along off live closes an open page on its next event; Calibre closing does not', async () => {
	const h = harness({ session: { audible: false } });
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	h.source.openResult = { ok: false, code: 'calibre-unreachable', text: 'Calibre isn\'t answering.' };
	h.books.setPos(h.s, model.wordToMs(h.map, h.pages[6].word));
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.ok(h.ra._reader('u1'), 'a transient failure keeps the page');
	h.source.openResult = { ok: false, code: 'disabled', text: 'Read-along is turned off (`!config` → Audiobooks).' };
	h.books.emit(h.s, 'moved');
	await T.flush();
	assert.strictEqual(h.ra._reader('u1'), null);
	assert.match(last(msg).content, /turned off/);
	assert.deepStrictEqual(last(msg).components, []);
});
