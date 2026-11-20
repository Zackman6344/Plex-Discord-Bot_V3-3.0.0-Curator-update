// game.earningFilter, the game half of /playlist play's `-e`: which saved-playlist songs still earn
// on the invoker's Plex Media slots. Harness: test/helpers/apMediaHarness.js on slot_data_mixed.json,
// where Discovery (unit 1) has checkpoints at 5 and 10 minutes, Interlude is too short for a
// location of its own, and Road Trip's parts 1 and 2 are units 5 and 6.

const test = require('node:test');
const assert = require('node:assert');

const credit = require('../helpers/apMediaCredit.js');
const { setup, linkSlot, runtime, receive, unit, loc, slotData, contracts, FIXTURE, OWNER, FRIEND, SLOT } = require('./helpers/apMediaHarness.js');

const song = (partId, extra = {}) => ({ artist: '', title: '', key: `/library/parts/${partId}/1/file.mp3`, ...extra });
const ONE_MORE_TIME = song(230001);
const AERODYNAMIC = song(230002);
const INTERLUDE = song(230003);
const DIGITAL_LOVE = song(230004);
const SONG_A = song(250011);
const SONG_D = song(250021);
const DISCOVERY = [ONE_MORE_TIME, AERODYNAMIC, INTERLUDE, DIGITAL_LOVE];
const DISCOVERY_KEY = contracts.entryKey(credit.indexSlot(FIXTURE).entries.find((entry) => entry.k === 'album'));

function earning(h, user = OWNER) {
	const filter = h.game.earningFilter(user);
	assert.ok(filter.ok, JSON.stringify(filter));
	return filter;
}

test('an open part\'s song earns, and not once its location is checked', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(6));
	const filter = earning(h);
	assert.deepStrictEqual(filter.slots, [SLOT]);
	assert.strictEqual(filter.earns(SONG_D), true);
	runtime(h, key).checked.add(loc(46));
	assert.strictEqual(earning(h).earns(SONG_D), false);
});

for (const mode of ['bank', 'ignore']) {
	test(`a locked part's song earns nothing under locked_watches ${mode}`, async (t) => {
		const h = await setup(t, { sd: slotData({ locked_watches: mode }) });
		const key = await linkSlot(h);
		assert.deepStrictEqual([SONG_A, SONG_D].map(earning(h).earns), [false, false]);
		await receive(h, key, unit(5));
		assert.deepStrictEqual([SONG_A, SONG_D].map(earning(h).earns), [true, false]);
	});
}

// Discovery's tracks: One More Time 0-5:20 (loc 1), Aerodynamic 5:20-8:52 (loc 2), Interlude
// 8:52-9:07 (none), Digital Love 9:07-14:08 (loc 3); checkpoints at 5:00 (loc 4) and 10:00 (loc 5).
test('a track earns for its own location or a checkpoint inside its own span, not for the album\'s other checkpoints', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	const rt = runtime(h, key);
	for (const n of [1, 3, 4]) rt.checked.add(loc(n));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, true, false, true]);
	rt.checked.add(loc(5));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, true, false, false]);
});

test('an album with every track checked still keeps the track whose span holds an unearned checkpoint', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	const rt = runtime(h, key);
	for (const n of [1, 2, 3, 4]) rt.checked.add(loc(n));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, false, false, true]);
	rt.checked.add(loc(5));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, false, false, false]);
});

test('under strict a track not yet heard earns while a checkpoint at or after it waits', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	const rt = runtime(h, key);
	for (const n of [1, 3, 4]) rt.checked.add(loc(n));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [true, true, true, true]);
	rt.heard = { ...(rt.heard || {}), [DISCOVERY_KEY]: [[0, 547000]] };
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, true, false, true]);
	rt.heard = { ...rt.heard, [DISCOVERY_KEY]: [[0, 320000], [532000, 547000]] };
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, true, false, true]);
	rt.checked.add(loc(5));
	assert.deepStrictEqual(DISCOVERY.map(earning(h).earns), [false, true, false, false]);
});

test('a song found by its part key alone and one found by artist and title both earn', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	const filter = earning(h);
	assert.strictEqual(filter.earns({ key: '/library/parts/230002/1/file.mp3' }), true);
	assert.strictEqual(filter.earns(song(999999, { artist: 'Daft Punk', title: 'Digital Love' })), true);
	assert.strictEqual(filter.earns(song(999999, { artist: 'Daft Punk', title: 'Not On The List' })), false);
});

test('another user\'s slot never counts', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	await receive(h, key, unit(1));
	assert.deepStrictEqual(h.game.earningFilter(OWNER), { ok: false, reason: 'none', slots: [] });
	assert.strictEqual(earning(h, FRIEND).earns(AERODYNAMIC), true);
});

test('earningFilter answers off, none and unknown', async (t) => {
	const h = await setup(t, { startGame: false });
	assert.deepStrictEqual(h.game.earningFilter(OWNER), { ok: false, reason: 'off', slots: [] });
	await h.game.start({ discord: h.discord, bot: h.bot });
	assert.deepStrictEqual(h.game.earningFilter(OWNER), { ok: false, reason: 'none', slots: [] });
	const key = await linkSlot(h);
	assert.ok(earning(h).ok);
	const rt = runtime(h, key);
	const counts = rt.counts;
	rt.counts = null;
	assert.deepStrictEqual(h.game.earningFilter(OWNER), { ok: false, reason: 'unknown', slots: [SLOT] });
	rt.counts = counts;
	h.config.apMediaEnabled = false;
	assert.deepStrictEqual(h.game.earningFilter(OWNER), { ok: false, reason: 'off', slots: [] });
});
