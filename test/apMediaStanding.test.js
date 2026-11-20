// standing(b, entry): one title's view for a slot (spec 2.6) and the sentences it shares (2.7).

const test = require('node:test');
const assert = require('node:assert');
const {
	contracts, commandCode, setup, linkSlot, settledPosts, runtime, receive, waitFor, slotData, row,
	startApMediaServer, ALL_LOCATIONS, START, MATRIX, N1917, WILD, MIN_MS, sessionSpan, historyEvent, SLOT, SEED, unit, loc,
} = require('./helpers/apMediaHarness.js');

const FF = contracts.IDS.fastForward;
const DASH = String.fromCharCode(0x2013);

const MATRIX_KEY = 'movie|plex://movie/5d7768b2';
const N1917_KEY = `movie|rk:${N1917.rk}`;

function entryOf(h, key, entryKey) {
	const b = h.store.bindings.get(key);
	const s = h.game._internal.standing(key, entryKey);
	return { b, s };
}

function countPatches(h) {
	const was = h.store.bindings.patch;
	const calls = [];
	h.store.bindings.patch = (...args) => {
		calls.push(args);
		return was.apply(h.store.bindings, args);
	};
	return calls;
}

async function pushUseful(h, key, items, done) {
	h.server.pushItems(1, items.map((item) => ({ item, location: 999, player: 2, flags: 1 })));
	await waitFor(() => {
		const counts = runtime(h, key) && runtime(h, key).counts;
		return counts && done(counts);
	}, 'the pushed items');
	await h.game._internal.idle();
}

test('a fresh title stands ready with its first checkpoint next, and reading it patches nothing', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	const patches = countPatches(h);
	const { s } = entryOf(h, key, MATRIX_KEY);
	assert.strictEqual(s.status, 'ready');
	assert.strictEqual(s.ref, s.entryKey);
	assert.strictEqual(s.title, 'The Matrix (1999)');
	assert.deepStrictEqual(s.checkpoints, { total: 8, earned: 0, next: { minute: 15, atMs: 15 * MIN_MS, id: MATRIX.ids[1] } });
	assert.strictEqual(s.heard, null, 'heard only under strict');
	assert.strictEqual(s.fix, null);
	assert.strictEqual(s.opener, null);
	assert.strictEqual(s.distanceMs, 15 * MIN_MS);
	assert.deepStrictEqual(s.waiting, { pending: 0, banked: 0, held: 0 });
	assert.deepStrictEqual(s.text, { gap: null, gapAlone: null, fix: null, opener: null, tag: null });
	assert.strictEqual(patches.length, 0, 'no binding patch');
	assert.strictEqual(runtime(h, key).heard, null, 'no runtime heard copy');
	assert.strictEqual(h.game._internal.standing(key, 'movie|rk:999999'), null, 'an entry outside the list');
});

test('a title watched through stands done with no checkpoint next and nothing to open or fix', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await waitFor(() => entryOf(h, key, MATRIX_KEY).s.status === 'done', 'the title done');
	await h.game._internal.idle();
	const { s } = entryOf(h, key, MATRIX_KEY);
	assert.deepStrictEqual(s.checkpoints, { total: 8, earned: 8, next: null });
	assert.strictEqual(s.opener, null);
	assert.strictEqual(s.fix, null);
	assert.deepStrictEqual(s.text, { gap: null, gapAlone: null, fix: null, opener: null, tag: null });
});

test('a locked title names its opener, and a Wild Ticket on hand adds the redeem command', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	const p = h.config.commandPrefix || '!';
	let { s } = entryOf(h, key, N1917_KEY);
	assert.strictEqual(s.status, 'locked');
	assert.deepStrictEqual(s.opener, { unit: '1917 (movie)', step: 1, have: 0, tickets: 0 });
	assert.strictEqual(s.text.opener, 'It opens when **1917 (movie)** arrives.');
	await receive(h, key, WILD);
	({ s } = entryOf(h, key, N1917_KEY));
	assert.strictEqual(s.opener.tickets, 1);
	assert.strictEqual(s.text.opener, `It opens when **1917 (movie)** arrives. A Wild Ticket opens it: ${commandCode(`${p}apmedia redeem ${s.ref}`)} (1 on hand).`);
	const other = h.game._internal.standing(key, N1917_KEY, { commands: false }).text;
	assert.strictEqual(other.opener, 'It opens when **1917 (movie)** arrives. A Wild Ticket opens it (1 on hand).', 'for another player, no command');
});

test('under strict a gap holds its later checkpoints back, with a rewind and a check command to fix it', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const p = h.config.commandPrefix || '!';
	const [, m15, m30] = MATRIX.ids;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(m15), 'the 15-minute checkpoint');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	await h.game._internal.idle();
	let { s } = entryOf(h, key, MATRIX_KEY);
	assert.deepStrictEqual(s.heard, {
		throughMs: 16 * MIN_MS,
		furthestMs: 31 * MIN_MS,
		gap: { fromMs: 16 * MIN_MS, toMs: 20 * MIN_MS },
		heldBack: [{ minute: 30, atMs: 30 * MIN_MS, id: m30 }],
		byLock: false,
		playedLockedToMs: null,
		intro: null,
	});
	assert.deepStrictEqual(s.fix, { rewindMs: 16 * MIN_MS, checkAtMs: 31 * MIN_MS, ff: null });
	assert.strictEqual(s.text.tag, `gap 16:00${DASH}20:00, heard to 31:00`);
	assert.strictEqual(s.text.gap, 'has nothing heard from 16:00 to 20:00, so its checkpoints from 30m on wait');
	assert.strictEqual(s.text.gapAlone, 'Nothing heard from 16:00 to 20:00, so its checkpoints from 30m on wait.');
	assert.strictEqual(s.text.fix, `Rewind to 16:00, or if you watched it: ${commandCode(`${p}apmedia check ${s.ref} at 31:00`)}.`);
	assert.strictEqual(s.distanceMs, 14 * MIN_MS, 'to the 30-minute checkpoint from what was heard through');
	await pushUseful(h, key, [FF], (counts) => counts.useful.fastForward > 0);
	({ s } = entryOf(h, key, MATRIX_KEY));
	assert.deepStrictEqual(s.fix.ff, { have: 1 });
	assert.strictEqual(s.heard.byLock, false, 'byLock only under locked_watches: ignore');
	assert.strictEqual(s.text.fix, `Rewind to 16:00, or if you watched it: ${commandCode(`${p}apmedia check ${s.ref} at 31:00`)}.`
		+ ` One Fast Forward covers the gap: ${commandCode(`${p}apmedia ff ${s.ref}`)} (1 on hand).`);
	const other = h.game._internal.standing(key, MATRIX_KEY, { commands: false }).text;
	assert.deepStrictEqual([other.gapAlone, other.fix], [s.text.gapAlone, 'Rewind to 16:00. One Fast Forward covers the gap (1 on hand).'], 'for another player, no command');
});

test('under locked_watches ignore a gap a locked watch made says so, and its fix is a rewind alone', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const [, m15] = MATRIX.ids;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(m15), 'the 15-minute checkpoint');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	await h.game._internal.idle();
	const lockedTo = 19.5 * MIN_MS;
	const toldLocked = (ms) => {
		const told = { titles: { [MATRIX_KEY]: { locked: [ms, h.clock] } }, songsAt: null, episodesAt: null };
		h.store.bindings.patch(key, { told });
		runtime(h, key).told = told;
	};
	toldLocked(lockedTo);
	let { s } = entryOf(h, key, MATRIX_KEY);
	assert.strictEqual(s.heard.byLock, true);
	assert.strictEqual(s.heard.playedLockedToMs, lockedTo);
	assert.deepStrictEqual(s.fix, { rewindMs: 16 * MIN_MS, checkAtMs: null, ff: null });
	assert.strictEqual(s.text.gap, 'was played to 19:30 while it was locked, and this slot counts nothing played then, so its checkpoints from 30m on wait');
	assert.strictEqual(s.text.gapAlone, 'It was played to 19:30 while it was locked, and this slot counts nothing played then, so its checkpoints from 30m on wait.');
	assert.strictEqual(s.text.fix, 'Rewind to 16:00.');
	assert.strictEqual(s.text.tag, 'played while locked to 19:30');
	toldLocked(16 * MIN_MS);
	({ s } = entryOf(h, key, MATRIX_KEY));
	assert.strictEqual(s.heard.byLock, false, 'a locked watch that stopped at the gap did not make it');
	assert.strictEqual(s.heard.playedLockedToMs, null);
});

test('a slot that takes a new seed on reads the default told, and no patch writes the old titles back', async (t) => {
	const sd = slotData({ timesanity_strict: true, locked_watches: 'ignore' });
	const h = await setup(t, { sd });
	const key = await linkSlot(h);
	await settledPosts(h);
	const [, m15] = MATRIX.ids;
	const fresh = { titles: {}, songsAt: null, episodesAt: null };
	const old = { titles: { [MATRIX_KEY]: { locked: [19.5 * MIN_MS, h.clock] } }, songsAt: null, episodesAt: null };
	h.store.bindings.patch(key, { told: old });
	runtime(h, key).told = old;
	runtime(h, key).toldDirty = true;
	const rt = runtime(h, key);
	rt.gapsToTell.set(MATRIX_KEY, 1);
	rt.seen.set(MATRIX_KEY, 1);
	rt.lineTimes.push(h.clock);
	rt.songsPending.set('song', 1);
	rt.songsNamed.set('song', 1);
	rt.episodesPending.set('episode', 1);
	rt.heldBackKeys.add(MATRIX_KEY);
	rt.introSeen.set(MATRIX_KEY, 1);
	rt.songsTimer = setTimeout(() => {}, 1e9).unref();
	rt.episodesTimer = setTimeout(() => {}, 1e9).unref();
	const patches = countPatches(h);

	const next = await startApMediaServer({ seedName: 'Seed_NEW', slotData: { 1: sd }, locations: { 1: ALL_LOCATIONS }, startInventory: { 1: START } });
	t.after(() => next.close());
	h.monitor.put(0, { target: next.target }, 'repointed');
	await waitFor(() => row(h, key).state === 'stale', 'the stale state');
	const res = await h.game.retry(key);
	assert.ok(res.ok, res.message);
	await waitFor(() => row(h, key).seedName === 'Seed_NEW' && row(h, key).inventoryKnown, 'the new seed');
	await h.game._internal.idle();
	assert.ok(patches.some(([, fields]) => fields && fields.told), 'startOver patched told');
	assert.deepStrictEqual(h.store.bindings.get(key).told, fresh);
	assert.strictEqual(runtime(h, key).told, null, 'no runtime told copy of the old seed');
	assert.strictEqual(runtime(h, key).toldDirty, false);
	const after = runtime(h, key);
	assert.strictEqual(after.songsTimer, null);
	assert.strictEqual(after.episodesTimer, null);
	for (const name of ['gapsToTell', 'seen', 'songsPending', 'songsNamed', 'episodesPending', 'heldBackKeys', 'introSeen']) assert.strictEqual(after[name].size, 0, name);
	assert.deepStrictEqual(after.lineTimes, []);

	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await waitFor(() => next.checkedOf(1).has(m15), 'the 15-minute checkpoint on the new seed');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	await h.game._internal.idle();
	const { s } = entryOf(h, key, MATRIX_KEY);
	assert.strictEqual(s.heard.byLock, false, 'the old seed\'s locked watch made no gap here');
	assert.strictEqual(s.heard.playedLockedToMs, null);
	assert.strictEqual(s.text.tag, `gap 16:00${DASH}20:00, heard to 31:00`);
	const writesOld = patches.filter(([, fields]) => fields && fields.told && fields.told.titles && fields.told.titles[MATRIX_KEY] && fields.told.titles[MATRIX_KEY].locked);
	assert.deepStrictEqual(writesOld, [], 'no patch writes the old titles back');
	assert.deepStrictEqual(h.store.bindings.get(key).told.titles, { [MATRIX_KEY]: { gap: [16 * MIN_MS, h.clock, 20 * MIN_MS] } }, 'only the new seed\'s gap line is told');
});

test('clock reads a player position back through parseDuration, and ordinal names a step', () => {
	const { clock, ordinal } = require('../helpers/apMediaGame.js');
	const { parseDuration } = require('../helpers/apMediaCredit.js');
	const cases = [[0, '0:00'], [545000, '9:05'], [1127999, '18:47'], [3599999, '59:59'], [3725000, '1:02:05'], [-5, '0:00']];
	for (const [ms, text] of cases) assert.strictEqual(clock(ms), text, `clock(${ms})`);
	for (const [ms, text] of cases.slice(0, 5)) assert.strictEqual(parseDuration(text), Math.floor(ms / 1000) * 1000, text);
	const ordinals = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [111, '111th']];
	for (const [n, text] of ordinals) assert.strictEqual(ordinal(n), text);
});

function readyInListOrder(h, key) {
	const out = [];
	for (let n = 1; ; n += 1) {
		const found = h.game.findEntry(key, `#${n}`);
		if (!found.ok) return out;
		const s = h.game._internal.standing(key, found.entryKey);
		if (s.status === 'ready') out.push({ s, n });
	}
}

test('progress ranks a priority hint, then a hint, then a started title, then the rest by distance', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	assert.deepStrictEqual(h.game.progress('nobody::nothing'), { ok: false, message: 'There is no such Plex Media slot.' });
	await pushUseful(h, key, [unit(13), unit(13), unit(14)], (counts) => counts.units.get(unit(13)) >= 2 && counts.units.get(unit(14)) > 0);
	await settledPosts(h);
	const ready = readyInListOrder(h, key);
	assert.ok(ready.length > 5, `${ready.length} open titles`);
	let out = h.game.progress(key);
	const byDistance = [...ready].sort((x, y) => x.s.distanceMs - y.s.distanceMs || x.n - y.n).map((x) => x.s.entryKey);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.key, key);
	assert.strictEqual(out.slot, SLOT);
	assert.strictEqual(out.open, ready.length);
	assert.strictEqual(h.game.list(key, 'ready').totals.ready, out.open);
	assert.deepStrictEqual(out.picks.map((s) => s.entryKey), byDistance.slice(0, 5));
	const [first, second] = [...ready].reverse().filter((x) => x.s.entryKey !== MATRIX_KEY && x.s.checkpoints.next);
	h.monitor.setHints([
		{ finder: SLOT, receiver: 'Ann', item: 'Key', location: second.s.checkpoints.next.id, priority: false },
		{ finder: SLOT, receiver: 'Bob', item: 'Shield', location: first.s.checkpoints.next.id, priority: true },
	]);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[1]), 'the 15-minute checkpoint');
	await h.game._internal.idle();
	out = h.game.progress(key);
	assert.deepStrictEqual(out.picks.slice(0, 3).map((s) => s.entryKey), [first.s.entryKey, second.s.entryKey, MATRIX_KEY]);
	assert.deepStrictEqual(out.picks[0].hints, [{ receiver: 'Bob', item: 'Shield', priority: true, locationId: first.s.checkpoints.next.id }]);
	assert.strictEqual(out.picks.length, 5);
	const row = h.game.list(key, 'ready').groups.flatMap((g) => g.rows).find((r) => r.entryKey === first.s.entryKey);
	assert.deepStrictEqual(row.hintedFor, ['Bob']);
	const one = h.game.progress(key, 'The Matrix');
	assert.strictEqual(one.ok, true);
	assert.strictEqual(one.slot, SLOT);
	assert.strictEqual(one.standing.entryKey, MATRIX_KEY);
	assert.strictEqual(h.game.standingOf(key, 'The Matrix').entryKey, MATRIX_KEY);
	assert.strictEqual(h.game.progress(key, 'Nothing Like This At All').ok, false);
	assert.strictEqual(h.game.standingOf(key, 'Nothing Like This At All'), null);
	assert.strictEqual(h.game.status(key).bindings[0].heldBack, 0, 'no strict, nothing held back');
});

test('the next describer tags a checkpoint a gap holds back, and status counts the title until the gap is heard', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const [main, m15, m30, m45] = MATRIX.ids;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(m15), 'the 15-minute checkpoint');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	await h.game._internal.idle();
	const b = h.store.bindings.get(key);
	const other = N1917.ids[1];
	const q = { watchId: b.watchId, seedName: SEED, team: 0, slot: SLOT.toUpperCase(), slotId: 1, ids: [main, m15, m30, m45, other] };
	const tag = `gap 16:00${DASH}20:00, heard to 31:00`;
	assert.deepStrictEqual(h.game._internal.describeNext(q), new Map([[m30, tag], [m45, tag]]));
	assert.deepStrictEqual(h.game._internal.describeNext({ ...q, watchId: 999 }), new Map([[m30, tag], [m45, tag]]), 'another watch of the same seed');
	for (const bad of [{ ...q, seedName: 'Seed_OTHER' }, { ...q, slot: 'Nobody' }, { ...q, ids: 5 }, null, 'garbage', { ids: [m30] }]) {
		assert.deepStrictEqual(h.game._internal.describeNext(bad), new Map());
	}
	assert.strictEqual(h.game.status(key).bindings[0].heldBack, 1);
	await pushUseful(h, key, [unit(13), unit(13), unit(14)], (counts) => counts.units.get(unit(13)) >= 2 && counts.units.get(unit(14)) > 0);
	await h.game._internal.handleEvent(sessionSpan(2101, 0, 2 * MIN_MS));
	await h.game._internal.idle();
	const [gapPick, startedPick] = h.game.progress(key).picks;
	assert.strictEqual(gapPick.entryKey, MATRIX_KEY, 'a title held back by a gap comes before a nearer started one');
	assert.strictEqual(startedPick.kind, 'episode');
	assert.ok(startedPick.distanceMs < gapPick.distanceMs, `${startedPick.distanceMs} < ${gapPick.distanceMs}`);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 16 * MIN_MS, 20 * MIN_MS));
	await h.game._internal.idle();
	assert.strictEqual(h.game.status(key).bindings[0].heldBack, 0);
	assert.deepStrictEqual(h.game._internal.describeNext(q), new Map());
});

const HALLOWEEN_KEY = 'movie|rk:2002';

test('progress lists every title a gap holds back, a finished one too, in list order, and status counts the same titles', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const gapOn = async (rk) => {
		await h.game._internal.handleEvent(sessionSpan(rk, 0, 16 * MIN_MS));
		await h.game._internal.handleEvent(sessionSpan(rk, 20 * MIN_MS, 31 * MIN_MS));
	};
	await gapOn(2002);
	await gapOn(N1917.rk);
	await gapOn(MATRIX.rk);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.strictEqual(entryOf(h, key, MATRIX_KEY).s.status, 'done');
	const locked = entryOf(h, key, N1917_KEY).s;
	assert.strictEqual(locked.status, 'locked');
	assert.deepStrictEqual(locked.heard.heldBack.map((cp) => cp.minute), [30], 'banked while locked, and held back by its gap too');
	const gap = { fromMs: 16 * MIN_MS, toMs: 20 * MIN_MS };
	const out = h.game.progress(key);
	assert.deepStrictEqual(out.held, [
		{ entryKey: MATRIX_KEY, title: 'The Matrix (1999)', ref: MATRIX_KEY, gap, furthestMs: 31 * MIN_MS },
		{ entryKey: HALLOWEEN_KEY, title: 'Halloween (2018)', ref: HALLOWEEN_KEY, gap, furthestMs: 31 * MIN_MS },
	]);
	assert.strictEqual(out.picks[0].entryKey, HALLOWEEN_KEY, 'the picks keep their ranking');
	assert.ok(!out.picks.some((s) => s.status !== 'ready'), 'and their open titles only');
	assert.strictEqual(row(h, key).heldBack, out.held.length);
	assert.strictEqual(h.game.progress(key, 'The Matrix').held, undefined, 'one title in full has no list');
});

test('one progress, status or next read on a list of 1,000 titles builds the slot\'s checked and earned ids once', async (t) => {
	const sd = slotData({ timesanity_strict: true });
	for (let i = 0; i < 990; i += 1) {
		const at = 1000 + 3 * i;
		sd.entries.push({ k: 'movie', id: `rk:${30000 + i}`, rk: 30000 + i, t: `Film ${i}`, y: 2000, d: 40 * MIN_MS, u: unit(7), s: 1, w: loc(at), cp: [[15, loc(at + 1)], [30, loc(at + 2)]] });
	}
	sd.entry_count = sd.entries.length;
	const h = await setup(t, { sd });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	const rt = runtime(h, key);
	await waitFor(() => rt.checked.has(MATRIX.ids[1]), 'the 15-minute checkpoint');
	await h.game._internal.idle();
	let walks = 0;
	rt.checked = new (class extends Set {
		[Symbol.iterator]() {
			walks += 1;
			return super[Symbol.iterator]();
		}
	})(rt.checked);
	const b = h.store.bindings.get(key);
	const ids = sd.entries.flatMap((e) => (Array.isArray(e.cp) ? e.cp.map(([, id]) => id) : []));
	const reads = {
		progress: () => assert.ok(h.game.progress(key).open > 990),
		status: () => assert.strictEqual(row(h, key).heldBack, 1),
		next: () => assert.strictEqual(h.game._internal.describeNext({ watchId: b.watchId, seedName: SEED, slot: SLOT, ids }).size, 7),
	};
	for (const [name, read] of Object.entries(reads)) {
		walks = 0;
		read();
		assert.ok(walks >= 1 && walks <= 2, `${name} walked the checked ids ${walks} times`);
	}
});

test('a slot without strict gets no describer tags', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS));
	await h.game._internal.idle();
	const b = h.store.bindings.get(key);
	assert.deepStrictEqual(h.game._internal.describeNext({ watchId: b.watchId, seedName: SEED, slot: SLOT, ids: MATRIX.ids }), new Map());
});

test('start registers the next describer and stop removes it; a monitor without the registry still starts', async (t) => {
	const h = await setup(t);
	await linkSlot(h);
	await settledPosts(h);
	assert.strictEqual(h.monitor.describers.length, 1);
	assert.strictEqual(h.monitor.describers[0].game, 'Plex Media');
	assert.strictEqual(h.monitor.describers[0].describer.next, h.game._internal.describeNext);
	h.game.stop();
	assert.strictEqual(h.monitor.describers.length, 0);
	delete h.monitor.setGameDescriber;
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	assert.strictEqual(h.game._internal.running, true);
	assert.strictEqual(h.monitor.describers.length, 0);
});
