// M1 (spec 5.2, 5.7): a forward jump over an episode's intro marker on a strict slot. With the `intro`
// switch on the skipped stretch counts as heard; with it off the gap stays, and its line names the
// switch. Harness on a strict slot_data_mixed.json, Breaking Point S01E01 (rk 2101, checkpoints 10m to
// 40m) with an intro 0:15-1:45. The tests that read Plex session rows drive the game's own watcher one
// pass at a time; the rest hand the game the jump that watcher would have made.

const test = require('node:test');
const assert = require('node:assert');

const {
	setup, linkSlot, runtime, row, unit, loc, slotData, contracts, commandCode, FIXTURE, waitFor, sessionSpan, MIN_MS, SLOT,
	AFTER, START, ALL_LOCATIONS, startApMediaServer, handTimers, settledPosts, receive, earned,
} = require('./helpers/apMediaHarness.js');

const RK = 2101;
const EPISODE_KEY = contracts.entryKey(FIXTURE.entries.find((e) => e.rk === RK));
const EPISODE_RKS = FIXTURE.entries.filter((e) => e.k === 'episode').map((e) => e.rk);
const INTRO = { type: 'intro', startMs: 15000, endMs: 105000, final: false };
const TEN = loc(17);
const GAP = '\u{1F6A7}';

async function introSlot(t, { sd = slotData({ timesanity_strict: true }) } = {}) {
	const timers = handTimers();
	const h = await setup(t, { sd, game: { trapTimers: timers } });
	const key = await linkSlot(h);
	h.server.pushItems(1, [unit(13), unit(13), unit(14)].map((item) => ({ item, location: 999, player: 2, flags: 1 })));
	await waitFor(() => {
		const counts = runtime(h, key) && runtime(h, key).counts;
		return counts && counts.units.get(unit(13)) >= 2 && counts.units.get(unit(14)) > 0;
	}, 'the TV units');
	await h.game._internal.idle();
	await settledPosts(h);
	for (const rk of EPISODE_RKS) h.pms.markerRows[rk] = [INTRO];
	return { h, key, p: h.config.commandPrefix || '!', timers };
}

// One pass of the game's own session watcher, wallMs after the last one, the owner's player at offsetMs.
async function pass(h, rk, offsetMs, { wallMs = 15000, type = 'episode' } = {}) {
	h.clock += wallMs;
	const duration = FIXTURE.entries.find((e) => e.rk === rk).d;
	h.pms.sessionRows = [{
		ratingKey: String(rk), type, viewOffset: offsetMs, duration,
		User: { id: '1', title: 'Owner' }, Player: { state: 'playing' }, Session: { id: `s${rk}` },
	}];
	await h.game._internal.watcher().pollSessions();
	await h.game._internal.idle();
}

async function playTo(h, rk, fromMs, toMs) {
	for (let at = fromMs + MIN_MS; at < toMs; at += MIN_MS) await pass(h, rk, at, { wallMs: MIN_MS });
	await pass(h, rk, toMs, { wallMs: MIN_MS });
}

// Plex's Skip Intro as the watcher sees it: 0:25, 0:40, then toMs 15 s later, then play to 10:30.
async function watchSkip(h, toMs = 115000) {
	await pass(h, RK, 25000);
	await pass(h, RK, 40000);
	await pass(h, RK, toMs);
	await playTo(h, RK, toMs, 10.5 * MIN_MS);
}

const jump = (h, rk = RK, toMs = 115000) => h.game._internal.introJump({ accountId: 1, ratingKey: rk, fromMs: 40000, toMs, wallMs: 15000, padMs: 25000, at: AFTER });

// The same skip handed over without the watcher: 0:00-0:40 heard, the jump, then 1:55-10:30.
async function skipTheIntro(h, rk = RK) {
	await h.game._internal.handleEvent(sessionSpan(rk, 0, 40000));
	await jump(h, rk);
	await h.game._internal.handleEvent(sessionSpan(rk, 115000, 10.5 * MIN_MS));
}

const standing = (h, key, rk = RK) => h.game._internal.standing(key, contracts.entryKey(FIXTURE.entries.find((e) => e.rk === rk)));
const introEvents = (h) => h.events.filter((e) => e.kind === 'apmedia-intro');
const postedLines = async (h) => (await settledPosts(h)).flatMap((post) => post.split(String.fromCharCode(10)));
const tail = (p) => ` Plex's Skip Intro made that gap: ${commandCode(`${p}apmedia switch intro on`)} counts a skipped intro as heard.`;

function gapLine(h, key, p, from, to, checkAt) {
	const { ref } = standing(h, key);
	return `${GAP} \`${SLOT}\`: **Breaking Point S01E01** has nothing heard from ${from} to ${to}, so its checkpoints from 10m on wait.`
		+ ` Rewind to ${from === '0:00' ? 'the start' : from}, or if you watched it: ${commandCode(`${p}apmedia check ${ref} at ${checkAt}`)}.`;
}

function countMarkerReads(h) {
	const reads = [];
	const markers = h.pms.markers;
	h.pms.markers = (rk) => {
		reads.push(Number(rk));
		return markers(rk);
	};
	return reads;
}

test('with the intro switch on, a skip the watcher sees counts as heard, earns the 10-minute checkpoint and posts nothing', async (t) => {
	const { h, key } = await introSlot(t);
	await h.game.setSwitch(key, 'intro', true);
	await watchSkip(h);
	const s = standing(h, key);
	assert.strictEqual(s.heard.gap, null);
	assert.strictEqual(s.heard.intro, null);
	assert.strictEqual(s.heard.throughMs, 10.5 * MIN_MS);
	assert.ok(earned(h, key, TEN), 'the 10-minute checkpoint');
	assert.deepStrictEqual(introEvents(h), [{ kind: 'apmedia-intro', slot: SLOT, title: 'Breaking Point S01E01', fromMs: 40000, toMs: 115000 }]);
	assert.deepStrictEqual(await settledPosts(h), []);
});

test('with the intro switch off the gap stays, and its line ends with the intro tail', async (t) => {
	const { h, key, p } = await introSlot(t);
	await watchSkip(h);
	assert.deepStrictEqual(await postedLines(h), [gapLine(h, key, p, '0:40', '1:55', '10:30') + tail(p)]);
	const s = standing(h, key);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 115000 });
	assert.deepStrictEqual(s.heard.intro, { fromMs: 40000, toMs: 115000 });
	assert.ok(!earned(h, key, TEN));
	assert.deepStrictEqual(introEvents(h), []);
});

test('a seek past the intro leaves a line with no tail', async (t) => {
	const { h, key, p } = await introSlot(t);
	await watchSkip(h, 6 * MIN_MS);
	assert.deepStrictEqual(await postedLines(h), [gapLine(h, key, p, '0:40', '6:00', '10:00')]);
	const s = standing(h, key);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 6 * MIN_MS });
	assert.strictEqual(s.heard.intro, null);
	assert.strictEqual(runtime(h, key).introSeen.size, 0);
});

for (const on of [false, true]) {
	test(`a new watcher whose first look at the episode is past the intro leaves the gap from the start with no tail (switch ${on ? 'on' : 'off'})`, async (t) => {
		const { h, key, p } = await introSlot(t);
		if (on) await h.game.setSwitch(key, 'intro', true);
		const reads = countMarkerReads(h);
		await pass(h, RK, 115000);
		await playTo(h, RK, 115000, 10.5 * MIN_MS);
		assert.deepStrictEqual(await postedLines(h), [gapLine(h, key, p, '0:00', '1:55', '10:30')]);
		const s = standing(h, key);
		assert.deepStrictEqual(s.heard.gap, { fromMs: 0, toMs: 115000 });
		assert.strictEqual(s.heard.intro, null);
		assert.deepStrictEqual(reads, [], 'a first sight is no jump');
	});
}

test('a gap wider than the skipped intro on either side gets no tail', async (t) => {
	const { h, key, p } = await introSlot(t);
	await pass(h, RK, 40000);
	await pass(h, RK, 115000);
	await playTo(h, RK, 115000, 10.5 * MIN_MS);
	assert.deepStrictEqual(await postedLines(h), [gapLine(h, key, p, '0:00', '1:55', '10:30')], 'first seen at 0:40, so 0:00-0:40 was never heard either');
	assert.ok(runtime(h, key).introSeen.has(EPISODE_KEY), 'the skip was seen');
	assert.strictEqual(standing(h, key).heard.intro, null);
	await h.game._internal.handleEvent(sessionSpan(2102, 0, 40000));
	await jump(h, 2102);
	await h.game._internal.handleEvent(sessionSpan(2102, 130000, 10.5 * MIN_MS));
	const s = standing(h, key, 2102);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 130000 }, 'nothing heard from the skip\'s end either');
	assert.strictEqual(s.heard.intro, null);
});

test('a movie row\'s step never reads markers, where the same step of an episode does', async (t) => {
	const { h, key } = await introSlot(t);
	await h.game.setSwitch(key, 'intro', true);
	const reads = countMarkerReads(h);
	for (const offset of [25000, 40000, 115000]) await pass(h, 2001, offset, { type: 'movie' });
	assert.deepStrictEqual(reads, []);
	for (const offset of [25000, 40000, 115000]) await pass(h, RK, offset);
	assert.deepStrictEqual(reads, [RK]);
});

test('a markers read that fails is logged at debug and changes nothing', async (t) => {
	const { h, key } = await introSlot(t);
	await h.game.setSwitch(key, 'intro', true);
	const markers = h.pms.markers;
	h.pms.markers = async () => { throw new Error('Plex answered HTTP 500'); };
	await skipTheIntro(h);
	const s = standing(h, key);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 115000 });
	assert.strictEqual(s.heard.intro, null);
	assert.deepStrictEqual(introEvents(h), []);
	const lines = h.logger.lines.filter((l) => l.text.startsWith('Plex Media could not read the markers'));
	assert.deepStrictEqual(lines, [{ level: 'debug', text: 'Plex Media could not read the markers of 2101 Plex answered HTTP 500' }]);
	h.pms.markers = markers;
	await jump(h);
	assert.strictEqual(standing(h, key).heard.gap, null, 'the next skip reads the markers again');
});

test('of two strict slots on one account, only the one with the switch on hears the skipped intro', async (t) => {
	const sd = slotData({ timesanity_strict: true });
	const h = await setup(t, {
		room: { known: true, slots: { [SLOT]: 'Plex Media', OtherPlex: 'Plex Media', Watcher: 'ChecksFinder' } },
		server: {
			slots: [{ name: SLOT, game: 'Plex Media' }, { name: 'OtherPlex', game: 'Plex Media' }, { name: 'Watcher', game: 'ChecksFinder' }],
			slotData: { 1: sd, 2: sd },
			locations: { 1: ALL_LOCATIONS, 2: ALL_LOCATIONS },
			startInventory: { 1: START, 2: START },
		},
	});
	const key = await linkSlot(h);
	const other = await linkSlot(h, { slot: 'OtherPlex' });
	h.pms.markerRows[RK] = [INTRO];
	await h.game.setSwitch(key, 'intro', true);
	await skipTheIntro(h);
	assert.strictEqual(standing(h, key).heard.gap, null);
	assert.deepStrictEqual(standing(h, other).heard.gap, { fromMs: 40000, toMs: 115000 });
	assert.deepStrictEqual(standing(h, other).heard.intro, { fromMs: 40000, toMs: 115000 });
	assert.deepStrictEqual(introEvents(h).map((e) => e.slot), [SLOT]);
});

async function lockedSlot(t) {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }), game: { trapTimers: handTimers() } });
	const key = await linkSlot(h);
	h.pms.markerRows[RK] = [INTRO];
	return { h, key };
}

test('under ignore a locked episode\'s skipped intro counts for nothing with the switch on', async (t) => {
	const { h, key } = await lockedSlot(t);
	await h.game.setSwitch(key, 'intro', true);
	await jump(h);
	assert.strictEqual((runtime(h, key).heard || {})[EPISODE_KEY], undefined, 'nothing heard');
	assert.deepStrictEqual(introEvents(h), []);
});

test('under ignore a locked episode\'s skipped intro leaves no tail for a gap after its unlock', async (t) => {
	const { h, key } = await lockedSlot(t);
	await jump(h);
	assert.strictEqual(runtime(h, key).introSeen.size, 0);
	await receive(h, key, unit(13));
	await h.game._internal.handleEvent(sessionSpan(RK, 0, 40000));
	await h.game._internal.handleEvent(sessionSpan(RK, 115000, 10.5 * MIN_MS));
	const s = standing(h, key);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 115000 });
	assert.strictEqual(s.heard.intro, null);
	assert.ok(!s.text.fix.includes('Skip Intro'), s.text.fix);
});

test('after a new seed starts the slot over, a skip seen on the old seed adds no tail', async (t) => {
	const sd = slotData({ timesanity_strict: true });
	const { h, key, p } = await introSlot(t, { sd });
	await skipTheIntro(h);
	assert.ok(standing(h, key).text.fix.endsWith(tail(p)), 'the tail before');
	const next = await startApMediaServer({ seedName: 'Seed_NEW', slotData: { 1: sd }, locations: { 1: ALL_LOCATIONS }, startInventory: { 1: START } });
	t.after(() => next.close());
	h.monitor.put(0, { target: next.target }, 'repointed');
	await waitFor(() => row(h, key).state === 'stale', 'the stale state');
	const res = await h.game.retry(key);
	assert.ok(res.ok, res.message);
	await waitFor(() => row(h, key).seedName === 'Seed_NEW' && row(h, key).inventoryKnown, 'the new seed');
	await h.game._internal.idle();
	await h.game._internal.handleEvent(sessionSpan(RK, 0, 40000));
	await h.game._internal.handleEvent(sessionSpan(RK, 115000, 10.5 * MIN_MS));
	const s = standing(h, key);
	assert.deepStrictEqual(s.heard.gap, { fromMs: 40000, toMs: 115000 });
	assert.strictEqual(s.heard.intro, null);
	assert.ok(!s.text.fix.includes('Skip Intro'), s.text.fix);
});

test('the slot keeps the 100 latest skipped intros, and a skip seen again counts as the latest', async (t) => {
	const { h, key } = await introSlot(t);
	const seen = runtime(h, key).introSeen;
	seen.set(EPISODE_KEY, { fromMs: 1000, toMs: 2000, at: 1 });
	for (let i = 1; i < 100; i += 1) seen.set(`episode|rk:${9000 + i}`, { fromMs: 1000, toMs: 2000, at: 1 });
	await jump(h);
	assert.strictEqual(seen.size, 100);
	assert.deepStrictEqual([...seen.keys()].pop(), EPISODE_KEY);
	assert.deepStrictEqual(seen.get(EPISODE_KEY), { fromMs: 40000, toMs: 115000, at: AFTER });
	await jump(h, 2102);
	assert.strictEqual(seen.size, 100);
	assert.ok(!seen.has('episode|rk:9001'), 'the oldest goes');
	assert.ok(seen.has(EPISODE_KEY), 'the one seen again stays');
	assert.strictEqual([...seen.keys()].pop(), 'episode|rk:2102');
});

for (const on of [false, true]) {
	test(`an episodes line naming gaps skipped intros made ends with the intro tail once${on ? ', unless the switch went on meanwhile' : ''}`, async (t) => {
		const { h, key, p, timers } = await introSlot(t);
		await skipTheIntro(h);
		const [first] = await postedLines(h);
		assert.ok(first.endsWith(tail(p)), first);
		h.clock += 10 * MIN_MS;
		await skipTheIntro(h, 2102);
		await skipTheIntro(h, 2103);
		assert.deepStrictEqual(await settledPosts(h), [], 'ten minutes after the last episodes line');
		if (on) {
			await h.game.setSwitch(key, 'intro', true);
			const s = standing(h, key);
			assert.deepStrictEqual(s.heard.intro, { fromMs: 40000, toMs: 115000 });
			assert.ok(!s.text.fix.includes('Skip Intro'), 'a switch already on names no switch');
		}
		timers.fire(20 * MIN_MS);
		await h.game._internal.idle();
		const bullet = (rk) => {
			const s = standing(h, key, rk);
			return `\u2022 **${s.title}**: nothing heard from 0:40 to 1:55. Rewind to 0:40, or ${commandCode(`${p}apmedia check ${s.ref} at 10:30`)}.`;
		};
		const introLine = `Plex's Skip Intro made a gap above: ${commandCode(`${p}apmedia switch intro on`)} counts a skipped intro as heard.`;
		assert.deepStrictEqual(await postedLines(h), [
			`${GAP} \`${SLOT}\`: 2 episodes earn nothing yet.`,
			bullet(2102),
			bullet(2103),
			...(on ? [] : [introLine]),
		]);
	});
}

test('without a strict slot the markers are never read', async (t) => {
	const { h } = await introSlot(t, { sd: slotData() });
	const reads = countMarkerReads(h);
	await watchSkip(h);
	await skipTheIntro(h);
	assert.deepStrictEqual(reads, []);
});
