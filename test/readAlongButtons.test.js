// helpers/readAlongButtons.js: 📖 on the book card and the bookpage:* page buttons.
//
// The bug: 📖 answered in the channel, or showing the listener's page to someone outside the
// book's voice channel (it shows exactly where the listener is in the book); a member who left
// the voice channel still turning pages; someone else in the channel offered ↪ or 📩, or moving
// the listener's book with a forged one; a first click that sits on "thinking…" through a whole
// download and parse; a page click left unacknowledged ("This interaction failed"); a DM click
// crashing on the null guild and member a DM interaction has; book:* clicks swallowed by the new
// handler, or bookpage:* ones by the old.
//
// Harness: the real handler and the real pager (helpers/readAlong.js) on
// test/helpers/readAlongFakes.js: a fake director whose session plays by a manual clock in voice
// channel v1, a guild whose voice-state cache the test moves people through, a source serving a
// synthetic ebook from memory, recording interactions. Nothing touches disk.

const test = require('node:test');
const assert = require('node:assert');

const T = require('./helpers/readAlongFakes.js');
const { createReadAlong } = require('../helpers/readAlong.js');
const card = require('../helpers/readAlongCard.js');
const buttons = require('../helpers/readAlongButtons.js');

const EPHEMERAL = 64;
const SECTIONS = [{ label: 'Chapter 1', words: 900 }, { label: 'Chapter 2', words: 900 }];
const ANA = { id: 'u1', username: 'Ana' };
const BEN = { id: 'u2', username: 'Ben' };

let open = [];
test.afterEach(() => {
	for (const ra of open) ra.shutdown();
	open = [];
});

function harness({ status = 'ready' } = {}) {
	const clock = T.manualClock();
	const text = T.makeText(SECTIONS);
	const work = T.makeWork(SECTIONS);
	const books = T.fakeBooks(clock);
	const source = T.fakeSource(text, { status });
	const client = T.fakeClient();
	const on = new Set();
	const store = { readers: { isOn: u => on.has(u), set: (u, v) => (v ? on.add(u) : on.delete(u), true) } };
	const ra = createReadAlong({ client, books, source, store, timers: clock, logger: { info() {}, warn() {}, error() {} }, cfg: { commandPrefix: '!' }, catalog: { work: () => null } });
	open.push(ra);
	const s = books.add({ work, audible: false });
	const reported = [];
	const guild = T.fakeGuild('g1');
	return { clock, text, work, books, source, client, ra, s, guild, bot: { books, readAlong: ra }, reported, opts: { onInteractionResponse: p => reported.push(p) }, pages: T.expectedPages(work, text).pages };
}

async function press(h, customId, { user = ANA, message = null, inGuild = true, voice = null } = {}) {
	const i = T.fakeInteraction({ customId, user, message, guild: inGuild ? h.guild : null, voice });
	const claimed = await buttons.handle(i, h.bot, null, h.opts);
	return { i, claimed };
}

function pageButton(h, act, surface, word, over = {}) {
	return card.pageId(Object.assign({ act, surface, sid: h.s.id, tag: h.text.handle.tag, word }, over));
}

test('📖 by the listener defers privately, shows "Preparing" while the text is read, then the page', async () => {
	const h = harness({ status: 'available' });
	const { i, claimed } = await press(h, `bookread:${h.s.id}`);
	assert.strictEqual(claimed, true);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferReply', 'editReply', 'editReply']);
	assert.deepStrictEqual(i.calls[0][1], { flags: EPHEMERAL });
	assert.match(i.calls[1][1].content, /Preparing the text/);
	const page = i.calls[2][1];
	assert.strictEqual(T.pageWordOf(page), h.pages[0].word);
	assert.ok(page.components[0].components.every(b => b.custom_id.startsWith('bookpage:') && b.custom_id.includes(':e:')), 'ephemeral page buttons');
	assert.deepStrictEqual(h.reported, [i.calls[1][1], page], 'every payload is reported as sent');
});

test('📖 with the text ready goes straight to the page', async () => {
	const h = harness();
	const { i } = await press(h, `bookread:${h.s.id}`);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferReply', 'editReply']);
	assert.strictEqual(T.pageWordOf(i.calls[1][1]), h.pages[0].word);
});

function assertJoinRefusal(p, where) {
	assert.match(p.content, /Join <#v1> to read along/, where);
	assert.deepStrictEqual(p.embeds, [], where);
	assert.deepStrictEqual(p.components, [], where);
	assert.deepStrictEqual(p.allowedMentions, { parse: [] }, where);
}

test('📖 from someone outside the book\'s voice channel tells them to join it and shows no text', async () => {
	const h = harness({ status: 'available' });
	const nowhere = await press(h, `bookread:${h.s.id}`, { user: BEN });
	h.guild.join(BEN.id, 'v2');
	const elsewhere = await press(h, `bookread:${h.s.id}`, { user: BEN });
	for (const [name, { i }] of [['in no voice channel', nowhere], ['in another voice channel', elsewhere]]) {
		assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferReply', 'editReply'], name);
		assert.deepStrictEqual(i.calls[0][1], { flags: EPHEMERAL }, name);
		assertJoinRefusal(i.calls[1][1], name);
	}
	assert.ok(!h.source.calls.some(c => c[0] === 'open' || c[0] === 'probe'), 'the text is never even opened for them');
	assert.ok(!h.reported.some(p => /Preparing/.test(p.content || '')), 'no "Preparing" either');
});

test('📖 from someone in the book\'s voice channel shows them the page, without ↪ or 📩', async () => {
	const h = harness({ status: 'available' });
	h.guild.join(BEN.id, 'v1');
	const { i } = await press(h, `bookread:${h.s.id}`, { user: BEN });
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferReply', 'editReply', 'editReply']);
	assert.deepStrictEqual(i.calls[0][1], { flags: EPHEMERAL });
	const page = i.calls[2][1];
	assert.strictEqual(T.pageWordOf(page), h.pages[0].word);
	assert.deepStrictEqual(page.components[0].components.map(b => card.parsePageId(b.custom_id).act), ['prev', 'next', 'now']);
	assert.ok(page.components[0].components.every(b => b.custom_id.includes(':e:')), 'ephemeral page buttons');
	assert.strictEqual(h.client.sent.length, 0, 'nothing in anyone\'s DMs');
});

test('the voice channel comes from the guild\'s voice states, with the member\'s own as the fallback', async () => {
	const h = harness();
	const viaMember = await press(h, `bookread:${h.s.id}`, { user: BEN, voice: { channelId: 'v1' } });
	assert.strictEqual(T.pageWordOf(viaMember.i.calls[1][1]), h.pages[0].word, 'no cached voice state: the member\'s voice counts');
	h.guild.leave(BEN.id);
	const stale = await press(h, `bookread:${h.s.id}`, { user: BEN, voice: { channelId: 'v1' } });
	assertJoinRefusal(stale.i.calls[1][1], 'the cache says they left, whatever the member object says');
	const noGuild = await press(h, `bookread:${h.s.id}`, { user: BEN, inGuild: false });
	assertJoinRefusal(noGuild.i.calls[1][1], 'no guild, no voice channel');
});

test('📖 on an old card says the book is no longer playing', async () => {
	const h = harness();
	const { i } = await press(h, 'bookread:ffffff');
	assert.match(i.calls[1][1].content, /no longer playing/);
});

test('an ephemeral page button acknowledges with deferUpdate and edits that reply', async () => {
	const h = harness();
	const { i } = await press(h, pageButton(h, 'next', 'e', h.pages[0].word));
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferUpdate', 'editReply']);
	assert.strictEqual(T.pageWordOf(i.calls[1][1]), h.pages[1].word);
	assert.match(i.calls[1][1].embeds[0].footer.text, /only you can see this/);
});

test('a DM page button works with the null guild and member of a DM interaction', async () => {
	const h = harness();
	await h.ra.turnOn({ userId: 'u1' });
	const msg = h.client.sent[0];
	const { i, claimed } = await press(h, pageButton(h, 'next', 'd', h.pages[0].word), { message: msg, inGuild: false });
	assert.strictEqual(claimed, true);
	assert.strictEqual(i.guild, null);
	assert.strictEqual(i.member, null);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferUpdate']);
	assert.strictEqual(T.pageWordOf(msg.edits[msg.edits.length - 1]), h.pages[1].word, 'the reader\'s page turned');
});

test('someone in the voice channel pages with ◀ ▶ 📍, and an old tag shows the updated text', async () => {
	const h = harness();
	h.guild.join(BEN.id, 'v1');
	const next = await press(h, pageButton(h, 'next', 'e', h.pages[0].word), { user: BEN });
	assert.deepStrictEqual(next.i.calls.map(c => c[0]), ['deferUpdate', 'editReply']);
	assert.strictEqual(T.pageWordOf(next.i.calls[1][1]), h.pages[1].word);
	assert.deepStrictEqual(next.i.calls[1][1].components[0].components.map(b => card.parsePageId(b.custom_id).act), ['prev', 'next', 'now']);
	const back = await press(h, pageButton(h, 'prev', 'e', h.pages[1].word), { user: BEN });
	assert.strictEqual(T.pageWordOf(back.i.calls[1][1]), h.pages[0].word);
	const now = await press(h, pageButton(h, 'now', 'e', h.pages[3].word), { user: BEN });
	assert.strictEqual(T.pageWordOf(now.i.calls[1][1]), h.pages[0].word, '📍 goes to where the narration is');
	const old = await press(h, pageButton(h, 'next', 'e', h.pages[0].word, { tag: 'ffff' }), { user: BEN });
	assert.match(old.i.calls[1][1].content, /text was updated/);
	assert.deepStrictEqual(h.books.calls, [], 'the listener\'s book was never touched');
});

test('a member who leaves the voice channel gets the refusal on their next click, and no text', async () => {
	const h = harness();
	h.guild.join(BEN.id, 'v1');
	const first = await press(h, `bookread:${h.s.id}`, { user: BEN });
	assert.strictEqual(T.pageWordOf(first.i.calls[1][1]), h.pages[0].word);
	h.guild.leave(BEN.id);
	const reportedBefore = h.reported.length;
	for (const act of ['next', 'prev', 'now']) {
		const { i } = await press(h, pageButton(h, act, 'e', h.pages[1].word), { user: BEN });
		assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferUpdate', 'editReply'], act);
		assertJoinRefusal(i.calls[1][1], `${act}: their page becomes the refusal`);
	}
	h.guild.join(BEN.id, 'v2');
	const moved = await press(h, pageButton(h, 'next', 'e', h.pages[0].word), { user: BEN });
	assertJoinRefusal(moved.i.calls[1][1], 'moved to another voice channel');
	assert.ok(!h.reported.slice(reportedBefore).some(p => p.embeds && p.embeds.length), 'no page was reported after they left');
	h.guild.join(BEN.id, 'v1');
	const back = await press(h, pageButton(h, 'next', 'e', h.pages[0].word), { user: BEN });
	assert.strictEqual(T.pageWordOf(back.i.calls[1][1]), h.pages[1].word, 'back in the channel, back to reading');
});

test('a forged ↪ or 📩 from someone in the voice channel is refused and moves nothing', async () => {
	const h = harness();
	h.guild.join(BEN.id, 'v1');
	const before = h.books.position(h.s);
	const play = await press(h, pageButton(h, 'play', 'e', h.pages[5].word), { user: BEN });
	assert.deepStrictEqual(play.i.calls.map(c => c[0]), ['deferUpdate', 'followUp']);
	assert.match(play.i.calls[1][1].content, /Only Ana can move their book/);
	assert.strictEqual(play.i.calls[1][1].flags, EPHEMERAL);
	assert.deepStrictEqual(play.i.calls[1][1].allowedMentions, { parse: [] });
	const dm = await press(h, pageButton(h, 'dm', 'e', h.pages[1].word), { user: BEN });
	assert.deepStrictEqual(dm.i.calls.map(c => c[0]), ['deferUpdate', 'followUp']);
	assert.match(dm.i.calls[1][1].content, /Following in DMs is for Ana/);
	const stale = await press(h, pageButton(h, 'play', 'e', h.pages[1].word, { tag: 'ffff' }), { user: BEN });
	assert.deepStrictEqual(stale.i.calls.map(c => c[0]), ['deferUpdate', 'followUp'], 'a ↪ with an old tag is refused, not re-rendered');
	assert.strictEqual(h.books.position(h.s), before);
	assert.deepStrictEqual(h.books.calls, [], 'the engine was never asked');
	assert.strictEqual(h.client.sent.length, 0, 'no DM page was opened for them');
	assert.ok(!h.reported.some(p => p.embeds && p.embeds.length), 'no page was reported for them');
});

test('someone outside the voice channel gets no text from any page button, forged or replayed', async () => {
	const h = harness();
	for (const act of ['prev', 'next', 'now', 'dm', 'play']) {
		const { i } = await press(h, pageButton(h, act, 'e', h.pages[1].word), { user: BEN });
		assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferUpdate', 'editReply'], act);
		assertJoinRefusal(i.calls[1][1], act);
	}
	const stale = await press(h, pageButton(h, 'next', 'e', h.pages[1].word, { tag: 'ffff' }), { user: BEN });
	assertJoinRefusal(stale.i.calls[1][1], 'an old tag');
	assert.ok(!h.reported.some(p => p.embeds && p.embeds.length), 'no page was reported for them');
	assert.ok(!h.source.calls.some(c => c[0] === 'open'), 'the text is never opened for them');
	assert.deepStrictEqual(h.books.calls, [], 'the engine was never asked');
	assert.strictEqual(h.client.sent.length, 0, 'no DM page was opened for them');
});

test('the listener reads from anywhere and keeps ↪ and 📩', async () => {
	const h = harness();
	h.guild.join(ANA.id, 'v9');
	const { i } = await press(h, `bookread:${h.s.id}`);
	assert.deepStrictEqual(i.calls[1][1].components[0].components.map(b => card.parsePageId(b.custom_id).act), ['prev', 'next', 'now', 'play', 'dm']);
	const play = await press(h, pageButton(h, 'play', 'e', h.pages[2].word));
	assert.deepStrictEqual(play.i.calls.map(c => c[0]), ['deferUpdate', 'editReply']);
	assert.deepStrictEqual(h.books.calls.map(c => c[0]), ['goto'], '↪ still moves the listener\'s book');
});

test('📩 Follow in DMs from the ephemeral page opens the DM page', async () => {
	const h = harness();
	const { i } = await press(h, pageButton(h, 'dm', 'e', h.pages[0].word));
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['deferUpdate', 'followUp']);
	assert.match(i.calls[1][1].content, /Sent to your DMs/);
	assert.strictEqual(h.client.sent.length, 1);
});

test('only bookread and bookpage ids are claimed; a malformed page id is answered, not dropped', async () => {
	const h = harness();
	for (const id of ['book:toggle:a1b2c3', 'playback:pause', 'bookreader:x', 'tag:1']) {
		const { i, claimed } = await press(h, id);
		assert.strictEqual(claimed, false, id);
		assert.deepStrictEqual(i.calls, [], id);
	}
	const { i, claimed } = await press(h, 'bookpage:next:d:zz:1:1');
	assert.strictEqual(claimed, true);
	assert.deepStrictEqual(i.calls.map(c => c[0]), ['reply']);
	assert.strictEqual(i.calls[0][1].flags, EPHEMERAL);
});

test('with the read-along missing, its buttons still get an answer', async () => {
	const i = T.fakeInteraction({ customId: 'bookread:a1b2c3' });
	assert.strictEqual(await buttons.handle(i, { books: {} }, null, {}), true);
	assert.match(i.calls[0][1].content, /not available/);
});
