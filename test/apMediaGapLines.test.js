// P1 (spec 4.1): one line in the slot's channel when a title earns nothing: a strict title whose gap
// holds checkpoints back, or a locked title played under locked_watches ignore (a movie or book on its
// own, episodes and songs grouped). A check by hand or a Fast Forward names the gap it leaves in its reply.

const test = require('node:test');
const assert = require('node:assert');
const {
	contracts, commandCode, setup, linkSlot, settledPosts, runtime, slotData, MATRIX, HALLOWEEN, SLOT, OWNER, MIN_MS, sessionSpan,
	historyEvent, handTimers, unit, FIXTURE, N1917, WILD, receive, AFTER, loc,
} = require('./helpers/apMediaHarness.js');
const { waitFor } = require('./helpers/apServer.js');
const credit = require('../helpers/apMediaCredit.js');

const GAP = '\u{1F6A7}';
const MATRIX_KEY = 'movie|plex://movie/5d7768b2';

async function strictSlot(t, more = {}) {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }), ...more });
	const key = await linkSlot(h);
	await settledPosts(h);
	return { h, key, p: h.config.commandPrefix || '!' };
}

const span = (h, fromMin, toMin) => h.game._internal.handleEvent(sessionSpan(MATRIX.rk, fromMin * MIN_MS, toMin * MIN_MS));

function matrixLine(p, from, furthest) {
	return `${GAP} \`${SLOT}\`: **The Matrix (1999)** has nothing heard from ${from} to 20:00, so its checkpoints from 30m on wait.`
		+ ` Rewind to ${from}, or if you watched it: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at ${furthest}`)}.`;
}

// The channel buffer joins lines that come close together into one post.
const postedLines = async (h) => (await settledPosts(h)).flatMap((post) => post.split(String.fromCharCode(10)));

const gapEvents = (h) => h.events.filter((e) => e.kind === 'apmedia-gap');

test('a gap that holds a checkpoint back posts one line, whatever the announce settings say', async (t) => {
	const { h, key, p } = await strictSlot(t);
	h.config.apMediaAnnounce = 'off';
	h.store.bindings.patch(key, { announce: false });
	await span(h, 0, 16);
	assert.deepStrictEqual(await settledPosts(h), [], 'no gap yet');
	await span(h, 20, 31);
	assert.deepStrictEqual(await settledPosts(h), [matrixLine(p, '16:00', '31:00')]);
	assert.deepStrictEqual(gapEvents(h).map(({ fromMs, toMs, held, slot, title }) => ({ fromMs, toMs, held, slot, title })), [
		{ fromMs: 960000, toMs: 1200000, held: 1, slot: SLOT, title: 'The Matrix (1999)' },
	]);
	const told = h.store.bindings.get(key).told.titles[MATRIX_KEY];
	assert.deepStrictEqual(told.gap, [960000, h.clock, 1200000], 'told at once, with the reach and the gap\'s end');
	await span(h, 31, 33);
	assert.deepStrictEqual(await settledPosts(h), [], 'the same reach is told once a sitting');
	assert.strictEqual(gapEvents(h).length, 1);
});

test('a told gap repeats after three hours without a hit, and a partial rewind inside it says nothing', async (t) => {
	const { h, p } = await strictSlot(t);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.strictEqual((await settledPosts(h)).length, 1);
	h.clock += 2 * 60 * MIN_MS;
	await span(h, 31, 32);
	assert.deepStrictEqual(await settledPosts(h), [], 'two hours after the last hit is the same sitting');
	h.clock += 2 * 60 * MIN_MS;
	await span(h, 32, 33);
	assert.deepStrictEqual(await settledPosts(h), [], 'told four hours ago, but the last hit was two hours ago');
	h.clock += 3 * 60 * MIN_MS + MIN_MS;
	await span(h, 33, 34);
	assert.deepStrictEqual(await settledPosts(h), [matrixLine(p, '16:00', '34:00')]);
	await span(h, 16, 18);
	assert.deepStrictEqual(await settledPosts(h), [], 'the reach moved inside the same gap');
	await span(h, 18, 20);
	assert.deepStrictEqual(await settledPosts(h), [], 'a rewind that closes the gap says nothing');
});

test('filling the gap forward from its start posts nothing more in the sitting', async (t) => {
	const { h } = await strictSlot(t);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.strictEqual((await settledPosts(h)).length, 1);
	for (let ms = 16 * MIN_MS; ms < 19 * MIN_MS; ms += 15000) {
		h.clock += 15000;
		await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, ms, ms + 15000));
	}
	assert.deepStrictEqual(await settledPosts(h), [], 'the reach moving inside the same gap is not a new gap');
	assert.strictEqual(gapEvents(h).length, 1);
});

test('six lines an hour: the seventh is held back and logged once until the hour frees a place', async (t) => {
	const { h, key } = await strictSlot(t);
	const heldLog = () => h.logger.lines.filter((l) => l.level === 'info' && l.text.startsWith(`Plex Media: held back a line for ${SLOT} (6 an hour): `));
	await span(h, 0, 16);
	for (let from = 18; from < 40; from += 4) await span(h, from, from + 2);
	await span(h, 60, 70);
	for (let from = 16; from < 40; from += 4) await span(h, from, from + 2);
	const lines = await postedLines(h);
	assert.strictEqual(lines.length, 6, lines.join('\n'));
	assert.ok(lines[0].includes('nothing heard from 16:00 to 18:00'), lines[0]);
	assert.ok(lines[5].includes('nothing heard from 36:00 to 38:00'), lines[5]);
	assert.strictEqual(heldLog().length, 1);
	assert.ok(heldLog()[0].text.includes('nothing heard from 40:00 to 1:00:00'), heldLog()[0].text);
	for (let i = 0; i < 20; i += 1) await span(h, 60, 70);
	assert.deepStrictEqual(await settledPosts(h), []);
	assert.strictEqual(heldLog().length, 1, 'held back once per window, never per step');
	assert.strictEqual(h.store.bindings.get(key).told.titles[MATRIX_KEY].gap[0], 36 * MIN_MS, 'a held-back line marks nothing told');
	h.clock += 61 * MIN_MS;
	await span(h, 60, 70);
	const later = await postedLines(h);
	assert.strictEqual(later.length, 1);
	assert.ok(later[0].includes('nothing heard from 40:00 to 1:00:00'), later[0]);
});

test('with a Fast Forward on hand the line ends with it', async (t) => {
	const { h, key, p } = await strictSlot(t);
	h.server.pushItems(1, [{ item: contracts.IDS.fastForward, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key) && runtime(h, key).counts && runtime(h, key).counts.useful.fastForward > 0, 'the Fast Forward');
	await h.game._internal.idle();
	await settledPosts(h);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.deepStrictEqual(await settledPosts(h), [matrixLine(p, '16:00', '31:00')
		+ ` One Fast Forward covers the gap: ${commandCode(`${p}apmedia ff ${MATRIX_KEY}`)} (1 on hand).`]);
});

test('with no Fast Forward but 10 snacks and a trade left the line names the Snack Bar', async (t) => {
	const { h, key, p } = await strictSlot(t);
	h.server.pushItems(1, Array(10).fill(contracts.SNACKS.Popcorn).map((item) => ({ item, location: 999, player: 2, flags: 0 })));
	await waitFor(() => runtime(h, key) && runtime(h, key).counts && runtime(h, key).counts.snacks >= 10, 'the snacks');
	await h.game._internal.idle();
	await settledPosts(h);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.deepStrictEqual(await settledPosts(h), [matrixLine(p, '16:00', '31:00')
		+ ` One Fast Forward covers the gap, and the Snack Bar trades one for 10 snacks: ${commandCode(`${p}apmedia snackbar buy fast-forward`)}.`]);
});

test('a seed without Fast Forwards gets no Fast Forward tail, whatever the snacks', async (t) => {
	const sd = slotData({ timesanity_strict: true });
	delete sd.items.useful;
	const { h, key, p } = await strictSlot(t, { sd });
	h.server.pushItems(1, Array(10).fill(contracts.SNACKS.Popcorn).map((item) => ({ item, location: 999, player: 2, flags: 0 })));
	await waitFor(() => runtime(h, key) && runtime(h, key).counts && runtime(h, key).counts.snacks >= 10, 'the snacks');
	await h.game._internal.idle();
	await settledPosts(h);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.deepStrictEqual(await settledPosts(h), [matrixLine(p, '16:00', '31:00')]);
});

test('a gap longer than one Fast Forward gets no Fast Forward tail', async (t) => {
	const { h, key } = await strictSlot(t);
	h.server.pushItems(1, [{ item: contracts.IDS.fastForward, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key) && runtime(h, key).counts && runtime(h, key).counts.useful.fastForward > 0, 'the Fast Forward');
	await h.game._internal.idle();
	await settledPosts(h);
	await span(h, 0, 16);
	await span(h, 27, 40);
	const lines = await postedLines(h);
	assert.strictEqual(lines.length, 1, lines.join('\n'));
	assert.ok(lines[0].includes('nothing heard from 16:00 to 27:00'), lines[0]);
	assert.ok(!lines[0].includes('Fast Forward'), lines[0]);
});

test('a gap told before a restart is not told again in the same sitting', async (t) => {
	const { h } = await strictSlot(t);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.strictEqual((await settledPosts(h)).length, 1);
	h.game.stop();
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => h.game.status().bindings.every((r) => r.inventoryKnown), 'the slot back after the restart');
	await settledPosts(h);
	await span(h, 31, 33);
	await span(h, 16, 17);
	const lines = await postedLines(h);
	assert.ok(!lines.some((line) => line.startsWith(GAP)), lines.join('\n'));
	assert.strictEqual(gapEvents(h).length, 1);
});

test('a history row on a title with a gap posts no line, even in a new sitting', async (t) => {
	const { h } = await strictSlot(t);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.strictEqual((await settledPosts(h)).length, 1);
	h.clock += 3 * 60 * MIN_MS + MIN_MS;
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	const lines = await postedLines(h);
	assert.ok(!lines.some((line) => line.startsWith(GAP)), lines.join('\n'));
	assert.strictEqual(gapEvents(h).length, 1);
});

test('without strict a skipped stretch posts no gap line', async (t) => {
	const h = await setup(t, { sd: slotData({}) });
	await linkSlot(h);
	await settledPosts(h);
	await span(h, 0, 16);
	await span(h, 20, 31);
	assert.ok(!(await settledPosts(h)).some((line) => line.startsWith(GAP)));
	assert.strictEqual(gapEvents(h).length, 0);
});

const EPISODES = [2101, 2102, 2103, 2104, 2105, 2201, 2202];

async function episodeSlot(t) {
	const timers = handTimers();
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }), game: { trapTimers: timers } });
	const key = await linkSlot(h);
	h.server.pushItems(1, [unit(13), unit(13), unit(14)].map((item) => ({ item, location: 999, player: 2, flags: 1 })));
	await waitFor(() => {
		const counts = runtime(h, key) && runtime(h, key).counts;
		return counts && counts.units.get(unit(13)) >= 2 && counts.units.get(unit(14)) > 0;
	}, 'the TV units');
	await h.game._internal.idle();
	await settledPosts(h);
	return { h, key, p: h.config.commandPrefix || '!', timers };
}

// Plex's Skip Intro jumps 2:00 to 3:30, past what a session step forgives.
async function skipIntro(h, rk) {
	await h.game._internal.handleEvent(sessionSpan(rk, 0, 2 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(rk, 3.5 * MIN_MS, 10 * MIN_MS));
}

const episodeStanding = (h, key, rk) => h.game._internal.standing(key, contracts.entryKey(FIXTURE.entries.find((e) => e.rk === rk)));

function episodeAlone(h, key, p, rk) {
	const s = episodeStanding(h, key, rk);
	return `${GAP} \`${SLOT}\`: **${s.title}** has nothing heard from 2:00 to 3:30, so its checkpoints from 10m on wait.`
		+ ` Rewind to 2:00, or if you watched it: ${commandCode(`${p}apmedia check ${s.ref} at 10:00`)}.`;
}

function episodeBullet(h, key, p, rk) {
	const s = episodeStanding(h, key, rk);
	return `\u2022 **${s.title}**: nothing heard from 2:00 to 3:30. Rewind to 2:00, or ${commandCode(`${p}apmedia check ${s.ref} at 10:00`)}.`;
}

test('a Skip Intro gap on an episode posts its own line, and the next one inside half an hour waits for the timer', async (t) => {
	const { h, key, p, timers } = await episodeSlot(t);
	await skipIntro(h, 2101);
	assert.deepStrictEqual(await postedLines(h), [episodeAlone(h, key, p, 2101)]);
	assert.strictEqual(h.store.bindings.get(key).told.episodesAt, h.clock);
	h.clock += 20 * MIN_MS;
	await skipIntro(h, 2102);
	assert.deepStrictEqual(await settledPosts(h), [], 'twenty minutes after the last episodes line');
	assert.deepStrictEqual(timers.delays().filter((ms) => ms === 10 * MIN_MS), [10 * MIN_MS]);
	timers.fire(10 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), [episodeAlone(h, key, p, 2102)]);
	await h.game._internal.handleEvent(sessionSpan(2101, 10 * MIN_MS, 12 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(2102, 10 * MIN_MS, 12 * MIN_MS));
	h.clock += 31 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(2102, 12 * MIN_MS, 13 * MIN_MS));
	assert.deepStrictEqual(await settledPosts(h), [], 'told once a sitting');
	assert.strictEqual(gapEvents(h).length, 2);
});

test('seven episode gaps inside half an hour post two lines, the second naming five and one more', async (t) => {
	const { h, key, p, timers } = await episodeSlot(t);
	const start = h.clock;
	for (const rk of EPISODES) {
		await skipIntro(h, rk);
		h.clock += 3 * MIN_MS;
	}
	assert.deepStrictEqual(await postedLines(h), [episodeAlone(h, key, p, 2101)]);
	timers.fire(start + 30 * MIN_MS - (start + 3 * MIN_MS));
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), [
		`${GAP} \`${SLOT}\`: 6 episodes earn nothing yet.`,
		...EPISODES.slice(1, 6).map((rk) => episodeBullet(h, key, p, rk)),
		`And 1 more: ${commandCode(`${p}apmedia progress`)} lists them.`,
	]);
	assert.strictEqual(runtime(h, key).lineTimes.length, 2, 'the episodes line counts once');
	assert.strictEqual(runtime(h, key).episodesPending.size, 0);
	const told = h.store.bindings.get(key).told;
	for (const rk of EPISODES) assert.deepStrictEqual(told.titles[episodeStanding(h, key, rk).entryKey].gap[0], 2 * MIN_MS, `rk ${rk}`);
	for (const rk of EPISODES) await h.game._internal.handleEvent(sessionSpan(rk, 10 * MIN_MS, 11 * MIN_MS));
	assert.deepStrictEqual(await settledPosts(h), [], 'none repeats inside the sitting');
	assert.deepStrictEqual(timers.delays().filter((ms) => ms > MIN_MS), [], 'no episodes timer left');
});

test('an episodes timer whose slot was unlinked posts nothing', async (t) => {
	const { h, key, timers } = await episodeSlot(t);
	await skipIntro(h, 2101);
	await settledPosts(h);
	h.clock += 20 * MIN_MS;
	await skipIntro(h, 2102);
	h.store.bindings.remove(key);
	timers.fire(10 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await settledPosts(h), []);
});

test('stopping the game clears a waiting episodes timer and leaves its episodes unsaid', async (t) => {
	const { h, key, timers } = await episodeSlot(t);
	await skipIntro(h, 2101);
	await settledPosts(h);
	h.clock += 20 * MIN_MS;
	await skipIntro(h, 2102);
	const rt = runtime(h, key);
	assert.ok(rt.episodesTimer, 'armed');
	h.game.stop();
	assert.strictEqual(rt.episodesTimer, null);
	assert.deepStrictEqual(timers.delays().filter((ms) => ms === 10 * MIN_MS), []);
	assert.strictEqual(rt.episodesPending.size, 1);
});

test('a check by hand that leaves a gap names it, and the channel does not repeat it', async (t) => {
	const { h, key, p } = await strictSlot(t);
	await span(h, 0, 10);
	await span(h, 20, 40);
	assert.strictEqual((await postedLines(h)).length, 1, 'the channel line for reach 10:00');
	const reply = await h.game.creditManual(key, MATRIX_KEY, { atMs: '15m' });
	assert.strictEqual(reply.message, '\u2705 **The Matrix (1999)**: 1 check sent. Nothing heard from 15:00 to 20:00, so its checkpoints from 30m on wait.'
		+ ` Rewind to 15:00, or if you watched it: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at 40:00`)}.`);
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[MATRIX_KEY].gap, [15 * MIN_MS, h.clock, 20 * MIN_MS]);
	await span(h, 40, 41);
	assert.deepStrictEqual(await settledPosts(h), [], 'told by the reply');
});

test('a check by hand with no time under strict says how many checkpoints still wait', async (t) => {
	const { h, key, p } = await strictSlot(t);
	const reply = await h.game.creditManual(key, MATRIX_KEY);
	assert.ok(reply.message.endsWith(` 8 of its checkpoints still wait: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at 2:16:00`)} counts all of it as heard.`), reply.message);
});

test('a check by hand with no time and one checkpoint left says it still waits', async (t) => {
	const { h, key, p } = await strictSlot(t);
	assert.ok((await h.game.creditManual(key, MATRIX_KEY, { atMs: '1h45m' })).ok);
	const reply = await h.game.creditManual(key, MATRIX_KEY);
	assert.strictEqual(reply.message, '\u2705 **The Matrix (1999)**: 1 check sent.'
		+ ` 1 of its checkpoints still waits: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at 2:16:00`)} counts all of it as heard.`);
});

test('a check by hand with no time adds no wait for a locked title under ignore, nor before the items are known', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const locked = await h.game.creditManual(key, N1917_KEY);
	assert.strictEqual(locked.message, '**1917** is locked, and this slot ignores locked titles, so nothing counted.');
	runtime(h, key).counts = null;
	const early = await h.game.creditManual(key, HALLOWEEN.key);
	assert.strictEqual(early.message, `\u{1F512} **Halloween (2018)**: 1 check held until the room reports \`${SLOT}\`'s items.`);
});

test('a Fast Forward that leaves a gap over ten minutes names it, and the channel does not repeat it', async (t) => {
	const { h, key, p } = await strictSlot(t);
	h.server.pushItems(1, [{ item: contracts.IDS.fastForward, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key) && runtime(h, key).counts && runtime(h, key).counts.useful.fastForward > 0, 'the Fast Forward');
	await h.game._internal.idle();
	await span(h, 0, 16);
	await span(h, 40, 50);
	await settledPosts(h);
	const reply = await h.game.fastForward(key, MATRIX_KEY);
	assert.ok(reply.message.endsWith('0 Fast Forwards left. Nothing heard from 26:00 to 40:00, so its checkpoints from 30m on wait.'
		+ ` Rewind to 26:00, or if you watched it: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at 50:00`)}.`), reply.message);
	const b = h.store.bindings.get(key);
	assert.deepStrictEqual(b.told.titles[MATRIX_KEY].gap, [26 * MIN_MS, h.clock, 40 * MIN_MS]);
	assert.strictEqual(b.ffUsed, 1);
	await span(h, 50, 51);
	assert.deepStrictEqual(await settledPosts(h), [], 'told by the reply');
});

test('an episodes line over the hourly cap stays pending and posts when the hour frees a place', async (t) => {
	const { h, key, p, timers } = await episodeSlot(t);
	await span(h, 0, 16);
	for (let from = 18; from < 40; from += 4) await span(h, from, from + 2);
	await span(h, 60, 70);
	for (let from = 16; from < 36; from += 4) await span(h, from, from + 2);
	assert.strictEqual((await postedLines(h)).length, 6);
	await skipIntro(h, 2101);
	assert.deepStrictEqual(await settledPosts(h), [], 'held back');
	assert.strictEqual(runtime(h, key).episodesPending.size, 1);
	assert.strictEqual(h.store.bindings.get(key).told.episodesAt, null, 'a held-back line marks nothing told');
	h.clock += 60 * MIN_MS;
	timers.fire(60 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), [episodeAlone(h, key, p, 2101)]);
	assert.strictEqual(runtime(h, key).episodesPending.size, 0);
});

const N1917_KEY = `movie|rk:${N1917.rk}`;
const lockedPlays = (h) => h.events.filter((e) => e.kind === 'apmedia-locked-play');

async function ignoreSlot(t) {
	const h = await setup(t, { sd: slotData({ locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	return { h, key, p: h.config.commandPrefix || '!' };
}

const lockedLine = (tail) => `\u{1F512} \`${SLOT}\`: **1917** is locked, and this slot counts nothing played while a title is locked. ${tail}`;

test('a locked 1917 under ignore posts its locked line once a sitting, naming the Wild Ticket on hand', async (t) => {
	const { h, key, p } = await ignoreSlot(t);
	await receive(h, key, WILD);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [lockedLine(`It opens when **1917 (movie)** arrives. A Wild Ticket opens it: ${commandCode(`${p}apmedia redeem ${N1917_KEY}`)} (1 on hand).`)]);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 5 * MIN_MS, 10 * MIN_MS));
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	assert.deepStrictEqual(await postedLines(h), []);
	assert.strictEqual(lockedPlays(h).length, 1);
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY].locked, [0, h.clock]);
});

test('without a ticket the locked line names the unit that opens it', async (t) => {
	const { h } = await ignoreSlot(t);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [lockedLine('It opens when **1917 (movie)** arrives.')]);
});

test('a backfill, a play 4 hours old, an open title and a play before the items are known post no locked line', async (t) => {
	const { h, key } = await ignoreSlot(t);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS), key);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS, h.clock - 4 * 60 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 5 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), []);
	assert.strictEqual(lockedPlays(h).length, 0);
	assert.ok(AFTER >= h.clock - 3 * 60 * MIN_MS, 'the default event time is recent');
	runtime(h, key).counts = null;
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	assert.ok(!(await postedLines(h)).some((line) => line.startsWith('\u{1F512}')), 'nothing is called locked before the items are known');
	assert.strictEqual(lockedPlays(h).length, 0);
});

test('a credit carries an unwritten told along with the checks it sends', async (t) => {
	const { h, key } = await strictSlot(t);
	const rt = runtime(h, key);
	const told = { titles: { [N1917_KEY]: { locked: [5 * MIN_MS, h.clock] } }, songsAt: null, episodesAt: null };
	rt.told = told;
	rt.toldDirty = true;
	await span(h, 0, 16);
	assert.strictEqual(rt.toldDirty, false);
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [5 * MIN_MS, h.clock] });
});

const SHOW_KEY = 'show|plex://show/5eb6f2a1';

test('a locked show that opens while its line waits is dropped when the line goes', async (t) => {
	const timers = handTimers();
	const h = await setup(t, { sd: slotData({ locked_watches: 'ignore' }), game: { trapTimers: timers } });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(2101, 0, 5 * MIN_MS));
	assert.strictEqual((await postedLines(h)).length, 1);
	h.clock += 10 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(2201, 0, 5 * MIN_MS));
	assert.strictEqual(runtime(h, key).episodesPending.size, 1);
	h.server.pushItems(1, [{ item: unit(14), location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key).counts.units.get(unit(14)) > 0, 'the unit');
	timers.fire(20 * MIN_MS);
	assert.deepStrictEqual(await postedLines(h), [], 'the show opened before the line went');
	assert.strictEqual(runtime(h, key).episodesPending.size, 0);
});

test('three locked episodes of one show under ignore in one hour post one line naming the show once', async (t) => {
	const { h, key } = await ignoreSlot(t);
	const first = h.clock;
	for (const rk of [2101, 2102, 2103]) {
		await h.game._internal.handleEvent(sessionSpan(rk, 0, 5 * MIN_MS));
		h.clock += 20 * MIN_MS;
	}
	const opener = episodeStanding(h, key, 2101).text.opener;
	assert.strictEqual(opener, 'It opens when **Breaking Point: Next 3 Episodes** arrives.');
	assert.deepStrictEqual(await postedLines(h), [`\u{1F512} \`${SLOT}\`: **Breaking Point** is locked, and this slot counts nothing played while a title is locked. ${opener}`]);
	assert.strictEqual(lockedPlays(h).length, 1);
	const told = h.store.bindings.get(key).told;
	assert.deepStrictEqual(told.titles[SHOW_KEY], { locked: [0, first] });
	assert.strictEqual(told.episodesAt, first);
	assert.strictEqual(runtime(h, key).episodesPending.size, 0);
});

test('a locked third episode names the second copy of its show\'s unit, and how many came so far', async (t) => {
	const { h, key } = await ignoreSlot(t);
	const showLine = (opener) => `\u{1F512} \`${SLOT}\`: **Breaking Point** is locked, and this slot counts nothing played while a title is locked. ${opener}`;
	await h.game._internal.handleEvent(sessionSpan(2103, 0, 5 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [showLine('It opens with the 2nd **Breaking Point: Next 3 Episodes**.')]);
	await receive(h, key, unit(13));
	await settledPosts(h);
	h.clock += 3 * 60 * MIN_MS + MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(2103, 5 * MIN_MS, 10 * MIN_MS, h.clock));
	assert.deepStrictEqual(await postedLines(h), [showLine('It opens with the 2nd **Breaking Point: Next 3 Episodes** (1 so far).')], 'a new sitting');
});

test('under strict and ignore a locked title keeps how far it was played, written with the heard flush and never per step', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	const toldAt = h.clock;
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [5 * MIN_MS, toldAt] });
	assert.deepStrictEqual(await postedLines(h), [lockedLine('It opens when **1917 (movie)** arrives.')]);
	h.clock += MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 5 * MIN_MS, 12 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 2 * MIN_MS, 4 * MIN_MS));
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [5 * MIN_MS, toldAt] });
	assert.strictEqual(runtime(h, key).toldDirty, true);
	assert.deepStrictEqual(await postedLines(h), []);
	h.game.stop();
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [12 * MIN_MS, toldAt] });
});

test('a history row on a locked title keeps how far its plays went, not its whole runtime', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	const toldAt = h.clock;
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	assert.deepStrictEqual(runtime(h, key).told.titles[N1917_KEY], { locked: [5 * MIN_MS, toldAt] });
	h.game.stop();
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [5 * MIN_MS, toldAt] });
});

test('a locked episode played under strict keeps its reach with the time it was written, so it can expire', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const episodeKey = contracts.entryKey(FIXTURE.entries.find((e) => e.rk === 2101));
	await h.game._internal.handleEvent(sessionSpan(2101, 0, 5 * MIN_MS));
	const writtenAt = h.clock;
	h.clock += MIN_MS;
	h.game.stop();
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[episodeKey], { locked: [5 * MIN_MS, 0, writtenAt] });
});

test('under strict and ignore a gap 1917 was played through while locked gets the lock\'s line, with no check command', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 18 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [lockedLine('It opens when **1917 (movie)** arrives.')]);
	await receive(h, key, N1917.unit);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 18 * MIN_MS, 31 * MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [`${GAP} \`${SLOT}\`: **1917** was played to 18:00 while it was locked,`
		+ ' and this slot counts nothing played then, so its checkpoints from 15m on wait. Rewind to the start.']);
});

const DISCOVERY_KEY = contracts.entryKey(FIXTURE.entries.find((e) => e.rk === 2300));
const HOBBIT_KEY = contracts.entryKey(FIXTURE.entries.find((e) => e.w === 'j-r-r-tolkien/the-hobbit'));

test('under strict and ignore a locked track or book part keeps how far its title was played, from the track\'s or part\'s place on it', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }), game: { trapTimers: handTimers() } });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(23001, 0, 320000));
	await h.game._internal.handleEvent(sessionSpan(23002, 0, 100000));
	await h.game._internal.handleEvent(sessionSpan(27002, 0, 31 * MIN_MS));
	const told = runtime(h, key).told.titles;
	assert.deepStrictEqual(told[DISCOVERY_KEY].locked, [420000, 0, h.clock], 'track 2 starts at 5:20');
	assert.deepStrictEqual(told[HOBBIT_KEY].locked, [91 * MIN_MS, h.clock], 'part 2 starts an hour in, and its locked line told it');
	await h.game._internal.handleEvent(sessionSpan(23002, 100000, 212000));
	await receive(h, key, unit(1));
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(23003, 0, 15000));
	await h.game._internal.handleEvent(sessionSpan(23004, 0, 301000));
	assert.deepStrictEqual(await postedLines(h), [`${GAP} \`${SLOT}\`: **Daft Punk - Discovery** was played to 8:52 while it was locked,`
		+ ' and this slot counts nothing played then, so its checkpoints from 5m on wait. Rewind to the start.']);
});

const albumTitle = (h, key, rk) => h.game._internal.standing(key, contracts.entryKey(FIXTURE.entries.find((e) => e.rk === rk))).title;
const SONGS = `\u{1F512} \`${SLOT}\`: songs from locked titles count for nothing on this slot:`;

async function songsSlot(t) {
	const timers = handTimers();
	const h = await setup(t, { sd: slotData({ locked_watches: 'ignore' }), game: { trapTimers: timers } });
	const key = await linkSlot(h);
	await settledPosts(h);
	return { h, key, timers };
}

test('a locked song under ignore posts the songs line now, and the next inside half an hour waits for the timer', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	const first = h.clock;
	await h.game._internal.handleEvent(sessionSpan(23004, 0, MIN_MS));
	assert.deepStrictEqual(await postedLines(h), [`${SONGS} **${albumTitle(h, key, 2300)}**. They open as their items arrive.`]);
	assert.strictEqual(h.store.bindings.get(key).told.songsAt, first);
	await h.game._internal.handleEvent(sessionSpan(23004, MIN_MS, 2 * MIN_MS));
	h.clock += 10 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(24001, 0, MIN_MS));
	assert.deepStrictEqual(await settledPosts(h), [], 'ten minutes after the last songs line');
	assert.deepStrictEqual(timers.delays().filter((ms) => ms === 20 * MIN_MS), [20 * MIN_MS]);
	h.clock += 20 * MIN_MS;
	timers.fire(20 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), [`${SONGS} **${albumTitle(h, key, 2400)}**. They open as their items arrive.`]);
	assert.strictEqual(h.store.bindings.get(key).told.songsAt, h.clock);
	assert.strictEqual(runtime(h, key).songsPending.size, 0);
	assert.strictEqual(lockedPlays(h).length, 2);
});

test('the songs timer of a slot unlinked meanwhile posts nothing', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	await h.game._internal.handleEvent(sessionSpan(23004, 0, MIN_MS));
	await postedLines(h);
	h.clock += 10 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(24001, 0, MIN_MS));
	h.store.bindings.remove(key);
	timers.fire(20 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await settledPosts(h), []);
	assert.strictEqual(lockedPlays(h).length, 1);
});

const entryStanding = (h, key, find) => h.game._internal.standing(key, contracts.entryKey(FIXTURE.entries.find(find)));

async function songsAfterFirstLine(h, timers, rks) {
	await h.game._internal.handleEvent(sessionSpan(23004, 0, MIN_MS));
	await postedLines(h);
	h.clock += 10 * MIN_MS;
	for (const rk of rks) await h.game._internal.handleEvent(sessionSpan(rk, 0, MIN_MS));
	h.clock += 20 * MIN_MS;
	timers.fire(20 * MIN_MS);
	await h.game._internal.idle();
	return postedLines(h);
}

test('two locked songs waiting for the songs line are named together', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	const posted = await songsAfterFirstLine(h, timers, [24001, 25006]);
	const trip = entryStanding(h, key, (e) => e.t === 'Road Trip Part 1').title;
	assert.deepStrictEqual(posted, [`${SONGS} **${albumTitle(h, key, 2400)}** and **${trip}**. They open as their items arrive.`]);
});

test('three locked songs name two and count the third, and a Wild Ticket on hand redeems the first', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	await receive(h, key, WILD);
	await settledPosts(h);
	const posted = await songsAfterFirstLine(h, timers, [24001, 25006, 25011]);
	const first = entryStanding(h, key, (e) => e.rk === 2400);
	const trip = entryStanding(h, key, (e) => e.t === 'Road Trip Part 1').title;
	const p = h.config.commandPrefix || '!';
	assert.deepStrictEqual(posted, [`${SONGS} **${first.title}**, **${trip}** and 1 more. A Wild Ticket opens one: ${commandCode(`${p}apmedia redeem ${first.ref}`)} (1 on hand).`]);
	assert.strictEqual(runtime(h, key).songsPending.size, 0);
});

// A whole track heard through the bot, as apMediaVoice delivers it.
const voiceTrack = (h, [ratingKey, partId, artist, title, ms]) => h.game._internal.handleEvent({
	type: 'complete', source: 'voice', userIds: [OWNER], ratingKey, partId, artist, title, fromMs: 0, toMs: ms, at: h.clock,
});
const SONG_A = [25006, 250011, 'Artist A', 'Song A', 200000];
const ONE_MORE_TIME = [23001, 230001, 'Daft Punk', 'One More Time', 320000];
const SONG_D = [25011, 250021, 'Artist D', 'Song D', 240000];

test('a locked song heard in voice posts the songs line, and one 5 minutes later waits for the timer, after a restart too', async (t) => {
	const { h, timers } = await songsSlot(t);
	await voiceTrack(h, SONG_A);
	assert.deepStrictEqual(await postedLines(h), [`${SONGS} **Road Trip Part 1**. They open as their items arrive.`]);
	h.clock += 5 * MIN_MS;
	await voiceTrack(h, ONE_MORE_TIME);
	assert.deepStrictEqual(await settledPosts(h), []);
	h.clock += 25 * MIN_MS;
	timers.fire(25 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), [`${SONGS} **Daft Punk - Discovery**. They open as their items arrive.`]);
	h.game.stop();
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => h.game.status().bindings.every((r) => r.inventoryKnown), 'the slot back after the restart');
	await settledPosts(h);
	h.clock += 10 * MIN_MS;
	await voiceTrack(h, SONG_D);
	assert.deepStrictEqual(await settledPosts(h), [], 'ten minutes after the last songs line, before the restart');
	assert.deepStrictEqual(timers.delays().filter((ms) => ms === 20 * MIN_MS), [20 * MIN_MS]);
	assert.strictEqual(lockedPlays(h).length, 2);
});

const heldLog = (h) => h.logger.lines.filter((l) => l.level === 'info' && l.text.startsWith(`Plex Media: held back a line for ${SLOT} (6 an hour): `));

test('under strict and ignore a locked line the hourly cap held back posts once the hour frees, and once only', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	runtime(h, key).lineTimes = Array.from({ length: 6 }, () => h.clock);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS, h.clock));
	assert.deepStrictEqual(await postedLines(h), [], 'the hour is full');
	assert.strictEqual(heldLog(h).length, 1);
	h.clock += 61 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 5 * MIN_MS, 10 * MIN_MS, h.clock));
	const toldAt = h.clock;
	assert.deepStrictEqual(await postedLines(h), [lockedLine('It opens when **1917 (movie)** arrives.')]);
	h.clock += 30 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 10 * MIN_MS, 15 * MIN_MS, h.clock));
	assert.deepStrictEqual(await postedLines(h), [], 'told once a sitting');
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [10 * MIN_MS, toldAt] });
	assert.strictEqual(lockedPlays(h).length, 1);
});

// A hit noteLocked passes over: a backfill, or a play before the room reported the items.
async function unsaidFirstHit(h, key, first, rk) {
	if (first === 'backfill') {
		await h.game._internal.handleEvent(sessionSpan(rk, 0, 15000, h.clock), key);
		return;
	}
	const rt = runtime(h, key);
	const counts = rt.counts;
	rt.counts = null;
	await h.game._internal.handleEvent(sessionSpan(rk, 0, 15000, h.clock));
	rt.counts = counts;
}

test('under strict and ignore a locked 1917 whose first hit was a backfill or came before the items still gets its line', async (t) => {
	for (const first of ['backfill', 'no items']) {
		const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
		const key = await linkSlot(h);
		await settledPosts(h);
		await unsaidFirstHit(h, key, first, N1917.rk);
		assert.deepStrictEqual(await postedLines(h), [], `${first}: nothing yet`);
		h.clock += MIN_MS;
		await h.game._internal.handleEvent(sessionSpan(N1917.rk, 15000, 5 * MIN_MS, h.clock));
		assert.deepStrictEqual(await postedLines(h), [lockedLine('It opens when **1917 (movie)** arrives.')], first);
	}
});

test('a locked song whose first hit was a backfill, a play before the items or an old history row is still named in its sitting', async (t) => {
	for (const first of ['backfill', 'no items', 'old row']) {
		const { h, key } = await songsSlot(t);
		if (first === 'old row') await h.game._internal.handleEvent(historyEvent(23004, { at: h.clock - 4 * 60 * MIN_MS }));
		else await unsaidFirstHit(h, key, first, 23004);
		assert.deepStrictEqual(await postedLines(h), [], `${first}: nothing yet`);
		h.clock += MIN_MS;
		await h.game._internal.handleEvent(sessionSpan(23004, 15000, MIN_MS, h.clock));
		assert.deepStrictEqual(await postedLines(h), [`${SONGS} **Daft Punk - Discovery**. They open as their items arrive.`], first);
		h.clock += MIN_MS;
		await h.game._internal.handleEvent(sessionSpan(23004, MIN_MS, 2 * MIN_MS, h.clock));
		assert.deepStrictEqual(await settledPosts(h), [], `${first}: named once a sitting`);
	}
});

test('a locked song whose title opens while the songs line waits drops out, and with none left nothing posts', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	await h.game._internal.handleEvent(sessionSpan(23004, 0, MIN_MS));
	assert.strictEqual((await postedLines(h)).length, 1);
	const songsAt = h.store.bindings.get(key).told.songsAt;
	h.clock += 10 * MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(24001, 0, MIN_MS));
	assert.strictEqual(runtime(h, key).songsPending.size, 1);
	await receive(h, key, unit(2));
	await settledPosts(h);
	assert.strictEqual(entryStanding(h, key, (e) => e.rk === 2400).status, 'ready');
	h.clock += 20 * MIN_MS;
	timers.fire(20 * MIN_MS);
	await h.game._internal.idle();
	assert.deepStrictEqual(await postedLines(h), []);
	assert.strictEqual(runtime(h, key).songsPending.size, 0);
	assert.strictEqual(h.store.bindings.get(key).told.songsAt, songsAt, 'a line that never went paces nothing');
	assert.strictEqual(runtime(h, key).lineTimes.length, 1, 'nor takes a place in the hour');
	assert.strictEqual(lockedPlays(h).length, 1);
});

test('a songs line names only the titles still locked when it goes, and its ticket tail redeems one of them', async (t) => {
	const { h, key, timers } = await songsSlot(t);
	await receive(h, key, WILD);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(23004, 0, MIN_MS));
	await postedLines(h);
	h.clock += 10 * MIN_MS;
	for (const rk of [24001, 25006]) await h.game._internal.handleEvent(sessionSpan(rk, 0, MIN_MS));
	await receive(h, key, unit(2));
	await settledPosts(h);
	h.clock += 20 * MIN_MS;
	timers.fire(20 * MIN_MS);
	await h.game._internal.idle();
	const trip = entryStanding(h, key, (e) => e.t === 'Road Trip Part 1');
	const p = h.config.commandPrefix || '!';
	assert.deepStrictEqual(await postedLines(h), [`${SONGS} **${trip.title}**. A Wild Ticket opens one: ${commandCode(`${p}apmedia redeem ${trip.ref}`)} (1 on hand).`]);
});

test('a locked title the room has checked already gets no locked line, a movie or an album', async (t) => {
	const { h, key } = await songsSlot(t);
	const album = FIXTURE.entries.find((e) => e.rk === 2400);
	const done = [loc(70), ...credit.entryLocations(album).main];
	h.server.checkFromElsewhere(1, done);
	await waitFor(() => done.every((id) => runtime(h, key).checked.has(id)), 'the room\'s checks');
	await h.game._internal.idle();
	await settledPosts(h);
	assert.strictEqual(entryStanding(h, key, (e) => e.rk === N1917.rk).status, 'done');
	assert.strictEqual(entryStanding(h, key, (e) => e.rk === 2400).status, 'done');
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(24001, 0, MIN_MS));
	assert.deepStrictEqual(await postedLines(h), []);
	assert.strictEqual(lockedPlays(h).length, 0);
	assert.strictEqual(h.store.bindings.get(key).told.songsAt, null);
});

test('a Fast Forward that reaches no checkpoint writes the locked reach waiting for the heard flush', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	h.server.pushItems(1, [{ item: contracts.IDS.fastForward, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key).counts && runtime(h, key).counts.useful.fastForward > 0, 'the Fast Forward');
	await h.game._internal.idle();
	await settledPosts(h);
	await span(h, 0, 16);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 5 * MIN_MS));
	const toldAt = h.clock;
	h.clock += MIN_MS;
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 5 * MIN_MS, 12 * MIN_MS));
	assert.strictEqual(runtime(h, key).toldDirty, true, 'the reach waits for the heard flush');
	const reply = await h.game.fastForward(key, MATRIX_KEY);
	assert.ok(reply.message.includes(' That reaches no checkpoint yet. '), reply.message);
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles[N1917_KEY], { locked: [12 * MIN_MS, toldAt] });
	assert.strictEqual(runtime(h, key).toldDirty, false);
});

test('a check by hand for someone other than the slot\'s player leaves the commands out of its tail', async (t) => {
	const { h, key, p } = await strictSlot(t);
	const someone = '100000000000000002';
	h.server.pushItems(1, [{ item: contracts.IDS.fastForward, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => runtime(h, key).counts && runtime(h, key).counts.useful.fastForward > 0, 'the Fast Forward');
	await h.game._internal.idle();
	const whole = await h.game.creditManual(key, HALLOWEEN.key, { by: someone });
	assert.strictEqual(whole.message, '\u2705 **Halloween (2018)**: 1 check sent. 6 of its checkpoints still wait.');
	await span(h, 0, 10);
	await span(h, 20, 40);
	await settledPosts(h);
	const gap = await h.game.creditManual(key, MATRIX_KEY, { atMs: '15m', by: someone });
	assert.strictEqual(gap.message, '\u2705 **The Matrix (1999)**: 1 check sent. Nothing heard from 15:00 to 20:00, so its checkpoints from 30m on wait.'
		+ ' Rewind to 15:00. One Fast Forward covers the gap (1 on hand).');
	const own = await h.game.creditManual(key, MATRIX_KEY, { atMs: '16m', by: OWNER });
	assert.ok(own.message.endsWith(`Rewind to 16:00, or if you watched it: ${commandCode(`${p}apmedia check ${MATRIX_KEY} at 40:00`)}.`
		+ ` One Fast Forward covers the gap: ${commandCode(`${p}apmedia ff ${MATRIX_KEY}`)} (1 on hand).`), own.message);
});
