// helpers/apMediaCredit.js: the slot index, the 5.3 role table that turns a play into location
// ids, unlock counting, done/ready/locked, and duration parsing.
//
// The bug: credit that follows the event's source instead of the hit's role. A voice 'complete'
// for one album track credited the whole album; a Plexamp span inside book part 5 earned the
// book's first checkpoints; a twin album copy or a re-keyed item earned nothing; a checkpoint on
// the seam between two tracks was earned twice or never. Also: slot_data without generated_at fell
// back to a floor before the game began, and two emoji-only titles shared one title key.
//
// Harness: pure. The real slot_data that apworld/tests wrote for spec 4.10 scenario (b)
// (test/fixtures/apmedia/slot_data_mixed.json) plus small synthetic slot_data built inline.
// Non-ASCII test strings are built with String.fromCharCode so the file stays ASCII.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const credit = require('../helpers/apMediaCredit.js');
const contracts = require('../helpers/apMediaContracts.js');

const MIN = 60000;
const BASE = contracts.BASE_ID;
const FIXTURE = path.join(__dirname, 'fixtures', 'apmedia', 'slot_data_mixed.json');
const COMPLETE = { type: 'complete' };

function fixture() {
	return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function span(fromMs, toMs) {
	return { type: 'span', fromMs, toMs };
}

function only(hits) {
	assert.strictEqual(hits.length, 1, `expected one hit, got ${hits.length}`);
	return hits[0];
}

function slot(entries, extra = {}) {
	return {
		schema: 1, game: 'Plex Media', world_version: '0.1.0', builder: 1,
		generated_at: 1731300000, created_at: 1731200000, label: 'Test',
		goal_percent: 80, goal_count: 1, entry_count: entries.length,
		tv_unlock: 'episodes', episodes_per_unlock: 3, locked_watches: 'bank',
		checkpoint_items: 'filler_only', timesanity_strict: false,
		timesanity: { movie: 15, episode: 10, album: 15, book: 30 },
		items: { popcorn: BASE + 1, wild_ticket: BASE + 2 },
		units: [], entries, ...extra,
	};
}

const ix = credit.indexSlot(fixture());
const byId = (id) => ix.entries.find((e) => e.id === id);
const MATRIX = byId('plex://movie/5d7768b2');
const ALBUM = byId('plex://album/2300');
const MIX = byId('pl:2500:1');
const PRIDE = byId('book:jane-austen/pride-and-prejudice');
const HOBBIT = byId('book:j-r-r-tolkien/the-hobbit');

// --- the index over real slot_data -------------------------------------------------------------

test('the index reads the slot settings slot_data carries', () => {
	assert.strictEqual(ix.entries.length, 19);
	assert.strictEqual(ix.entryCount, 19);
	assert.strictEqual(ix.goalCount, 15);
	assert.strictEqual(ix.strict, false);
	assert.strictEqual(ix.lockedPolicy, 'bank');
	assert.strictEqual(ix.checkpointItems, 'filler_only');
	assert.strictEqual(ix.generatedAtMs, 1731300000 * 1000);
	assert.strictEqual(ix.label, 'Mixed list');
	// slot_data names no person: the room and archipelago.gg's tracker API hand it to anyone.
	const raw = fixture();
	assert.ok(!('account' in raw) && !('discord' in raw));
	assert.ok(!('account' in ix) && !('discord' in ix));
	assert.deepStrictEqual(ix.timesanity, { movie: 15, episode: 10, album: 5, book: 30 });
	assert.deepStrictEqual(ix.items, {
		popcorn: BASE + 1,
		wildTicket: BASE + 2,
		snacks: new Set([1, 3, 4, 5, 6, 7, 8].map((n) => BASE + n)),
		fastForward: BASE + 100,
		remoteControl: BASE + 101,
		traps: new Map(Object.entries(contracts.TRAPS).map(([key, trap]) => [trap.id, key])),
	});
	assert.deepStrictEqual(ix.snackBar, { trades: 3, price: 10 });
	assert.deepStrictEqual(ix.pool, {
		snacks: 69, fastForwards: 2, remoteControls: 1, wildTickets: 2,
		traps: { buffering: 0, rights_expired: 0, commercial_break: 0, shuffle_mode: 0, rewind: 0, intermission: 0, slow_motion: 0 },
	});
	assert.strictEqual(ix.units.size, 14);
	assert.deepStrictEqual(ix.units.get(1347001013), { id: 1347001013, name: 'Breaking Point: Next 3 Episodes', kind: 'show', steps: 2, start: 0 });
	for (const entry of ix.entries) {
		assert.strictEqual(ix.byKey.get(contracts.entryKey(entry)), entry);
		assert.ok(ix.units.has(entry.u), `${entry.id} names a unit slot_data lists`);
	}
});

test('every location id in the slot belongs to exactly one entry', () => {
	let total = 0;
	for (const entry of ix.entries) {
		const { main, checkpoints } = credit.entryLocations(entry);
		total += main.length + checkpoints.length;
		for (const id of main) assert.strictEqual(ix.byLocation.get(id), entry);
		for (const cp of checkpoints) assert.strictEqual(ix.byLocation.get(cp.id), entry);
	}
	assert.strictEqual(total, 86);
	assert.strictEqual(ix.byLocation.size, 86);
	for (let j = 1; j <= 86; j++) assert.ok(ix.byLocation.has(BASE + j), `Check ${j} is on the list`);
});

test('a whole completion of every entry earns its main locations and all its checkpoints', () => {
	const earned = new Set();
	for (const entry of ix.entries) {
		const { main, checkpoints } = credit.entryLocations(entry);
		const ids = credit.locationsFor(credit.wholeHit(entry), COMPLETE, false);
		assert.deepStrictEqual(ids, [...main, ...checkpoints.map((cp) => cp.id)]);
		for (const id of ids) earned.add(id);
	}
	assert.strictEqual(earned.size, 86);
});

test('movies and episodes index by ratingKey as whole hits', () => {
	const hit = only(ix.byRk.get(2001));
	assert.deepStrictEqual({ ...hit, entry: hit.entry.id }, { entry: MATRIX.id, role: 'whole', index: 0, startMs: 0, endMs: 8160000 });
	assert.strictEqual(only(ix.byRk.get(2105)).entry.en, 1);
	assert.strictEqual(only(ix.byRk.get(2105)).entry.sn, 0);
});

test('album tracks index by ratingKey and part id with their place on the album timeline', () => {
	const spans = [1, 2, 3, 4].map((n) => {
		const hit = only(ix.byRk.get(23000 + n));
		assert.strictEqual(hit, only(ix.byPid.get(230000 + n)));
		assert.strictEqual(hit.entry, ALBUM);
		assert.strictEqual(hit.role, 'track');
		assert.strictEqual(hit.index, n);
		return [hit.startMs, hit.endMs];
	});
	assert.deepStrictEqual(spans, [[0, 320000], [320000, 532000], [532000, 547000], [547000, 848000]]);
});

test('an album twin copy (alt) credits the same positions as the kept copy', () => {
	for (let n = 1; n <= 4; n++) {
		assert.strictEqual(only(ix.byRk.get(23100 + n)), only(ix.byRk.get(23000 + n)));
		assert.strictEqual(only(ix.byPid.get(231000 + n)), only(ix.byRk.get(23000 + n)));
	}
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23104)), COMPLETE, false), [BASE + 3, BASE + 5]);
});

test('book parts index by ratingKey and part id; the work id gives the whole book', () => {
	const part2 = only(ix.byPid.get(260002));
	assert.strictEqual(part2, only(ix.byRk.get(26002)));
	assert.deepStrictEqual([part2.role, part2.index, part2.startMs, part2.endMs], ['part', 2, 3600000, 6600000]);
	const whole = only(ix.byWorkId.get('jane-austen/pride-and-prejudice'));
	assert.deepStrictEqual([whole.entry, whole.role, whole.endMs], [PRIDE, 'whole', 6600000]);
	assert.strictEqual(whole, credit.wholeHit(PRIDE));
});

test('album and mix tracks index by "artist|track", mixes by each track\'s own artist', () => {
	const tokyo = MIX.tr[1][2];
	assert.strictEqual(only(ix.byTitle.get(credit.titleKey('Artist B', tokyo))), only(ix.byRk.get(25007)));
	assert.strictEqual(only(ix.byTitle.get(credit.titleKey('Daft Punk', 'Digital Love'))), only(ix.byRk.get(23004)));
	assert.strictEqual(ix.byTitle.get(credit.titleKey('Artist A', tokyo)), undefined);
	assert.ok(![...ix.byTitle.values()].flat().some((hit) => hit.entry.k === 'book'));
});

// --- locationsFor: the role table ---------------------------------------------------------------

test('a movie watched to the end earns the watch and every checkpoint, or only the watch when strict', () => {
	const hit = only(ix.byRk.get(2001));
	const cps = MATRIX.cp.map(([, id]) => id);
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, false), [MATRIX.w, ...cps]);
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, true), [MATRIX.w]);
});

test('one album track heard in voice earns that track and the checkpoints inside it, never the album', () => {
	const aerodynamic = only(ix.byRk.get(23002));
	const ids = credit.locationsFor(aerodynamic, COMPLETE, false);
	assert.deepStrictEqual(ids, [BASE + 2]);
	assert.strictEqual(credit.entryDone(ALBUM, ids), false);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23001)), COMPLETE, false), [BASE + 1, BASE + 4]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23001)), COMPLETE, true), [BASE + 1, BASE + 4]);
});

test('a track under 30 s has no location of its own and earns nothing it does not contain', () => {
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23003)), COMPLETE, false), []);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(25008)), COMPLETE, false), []);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(25007)), COMPLETE, false), [BASE + 44, BASE + 45]);
});

test('a whole album credited by hand earns every track location and, unless strict, its checkpoints', () => {
	const hit = credit.wholeHit(ALBUM);
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, false), [BASE + 1, BASE + 2, BASE + 3, BASE + 4, BASE + 5]);
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, true), [BASE + 1, BASE + 2, BASE + 3]);
});

test('a finished book part earns the checkpoints inside it; the last part also earns the finish', () => {
	const [cp30, cp60, cp90] = PRIDE.cp.map(([, id]) => id);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(26001)), COMPLETE, false), [cp30, cp60]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(26002)), COMPLETE, false), [PRIDE.f, cp30, cp60, cp90]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(26002)), COMPLETE, true), [PRIDE.f, cp90]);
});

test('a checkpoint on the seam between two parts belongs to the part that ends there', () => {
	const [cp30, cp60, cp90, cp120] = HOBBIT.cp.map(([, id]) => id);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(27001)), COMPLETE, true), [cp30, cp60]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(27002)), COMPLETE, true), [cp90, cp120]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(27003)), COMPLETE, true), [HOBBIT.f]);
});

test('a finished bookmark (by work id) is the whole book', () => {
	const hit = only(ix.byWorkId.get('j-r-r-tolkien/the-hobbit'));
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, false), [HOBBIT.f, ...HOBBIT.cp.map(([, id]) => id)]);
	assert.deepStrictEqual(credit.locationsFor(hit, COMPLETE, true), [HOBBIT.f]);
});

test('a span earns the checkpoints in (from, to], whatever the slot\'s strict setting', () => {
	const hit = only(ix.byRk.get(2001));
	const [cp15, cp30] = MATRIX.cp.map(([, id]) => id);
	assert.deepStrictEqual(credit.locationsFor(hit, span(0, 15 * MIN), true), [cp15]);
	assert.deepStrictEqual(credit.locationsFor(hit, span(15 * MIN, 30 * MIN - 1), false), []);
	assert.deepStrictEqual(credit.locationsFor(hit, span(15 * MIN - 1, 30 * MIN), false), [cp15, cp30]);
	assert.deepStrictEqual(credit.locationsFor(hit, span(30 * MIN, 15 * MIN), false), []);
	assert.deepStrictEqual(credit.locationsFor(hit, span(20 * MIN, 20 * MIN), false), []);
	assert.deepStrictEqual(credit.locationsFor(hit, span(NaN, 20 * MIN), false), []);
	assert.deepStrictEqual(credit.locationsFor(hit, { type: 'paused' }, false), []);
});

test('a Plexamp span inside a book part lands on the book timeline, not its first half hour', () => {
	const [cp30, , cp90] = HOBBIT.cp.map(([, id]) => id);
	const part2 = only(ix.byRk.get(27002));
	assert.deepStrictEqual(credit.locationsFor(part2, span(29 * MIN, 31 * MIN), false), [cp90]);
	assert.deepStrictEqual(credit.locationsFor(credit.wholeHit(HOBBIT), span(29 * MIN, 31 * MIN), false), [cp30]);
});

test('a span past the end of its track is cut at the track\'s end', () => {
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23002)), span(0, 300000), false), []);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23001)), span(-5000, 10 * 60 * MIN), false), [BASE + 4]);
	assert.deepStrictEqual(credit.locationsFor(only(ix.byRk.get(23004)), span(0, MIN), false), [BASE + 5]);
});

test('a span 0:00-4:00 on album track 5, which starts at 14:00, earns the album checkpoint at 15:00', () => {
	const tracks = [1, 2, 3, 4, 5].map((n) => [900 + n, n, `Track ${n}`, 210000, 9900 + n, BASE + 100 + n]);
	const album = { k: 'album', id: 'plex://album/x', rk: 900, ar: 'A', t: 'X', y: 2001, d: 1050000, tr: tracks, alt: [], u: BASE + 1001, s: 1, cp: [[15, BASE + 200]] };
	const index = credit.indexSlot(slot([album]));
	const track5 = only(index.byRk.get(905));
	assert.strictEqual(track5.startMs, 14 * MIN);
	assert.deepStrictEqual(credit.locationsFor(track5, span(0, 4 * MIN), false), [BASE + 200]);
	assert.deepStrictEqual(credit.locationsFor(track5, COMPLETE, true), [BASE + 105, BASE + 200]);
	assert.deepStrictEqual(credit.locationsFor(only(index.byRk.get(904)), COMPLETE, false), [BASE + 104]);
});

test('ids come back as numbers, deduped, even when slot_data spells them as strings', () => {
	const movie = { k: 'movie', id: 'rk:5', rk: '5', t: 'M', y: null, d: 3600000, u: String(BASE + 1001), s: 1, w: String(BASE + 10), cp: [[15, String(BASE + 11)], [30, BASE + 11], [45, null]] };
	const index = credit.indexSlot(slot([movie]));
	assert.deepStrictEqual(credit.locationsFor(only(index.byRk.get(5)), COMPLETE, false), [BASE + 10, BASE + 11]);
});

test('a hit whose role does not fit its entry earns nothing', () => {
	assert.deepStrictEqual(credit.locationsFor({ entry: MATRIX, role: 'track', index: 1 }, COMPLETE, false), []);
	assert.deepStrictEqual(credit.locationsFor({ entry: ALBUM, role: 'part', index: 1 }, COMPLETE, false), []);
	assert.deepStrictEqual(credit.locationsFor({ entry: ALBUM, role: 'track', index: 9 }, COMPLETE, false), []);
	assert.deepStrictEqual(credit.locationsFor(null, COMPLETE, false), []);
});

test('one ratingKey on two entries credits both', () => {
	const album = { k: 'album', id: 'plex://album/y', rk: 800, ar: 'Band', t: 'Y', y: 2000, d: 240000, tr: [[801, 1, 'Song', 240000, 8801, BASE + 1]], alt: [], u: BASE + 1001, s: 1, cp: [] };
	const mix = { k: 'mix', id: 'pl:7:1', pl: 7, part: 1, t: 'Mix Part 1', d: 240000, tr: [[801, 1, 'Song', 240000, 8801, 'Band', BASE + 2]], u: BASE + 1002, s: 1, cp: [] };
	const index = credit.indexSlot(slot([album, mix]));
	const hits = credit.hitsFor(index, { ratingKey: 801 });
	assert.deepStrictEqual(hits.map((h) => h.entry.k), ['album', 'mix']);
	assert.deepStrictEqual(hits.flatMap((h) => credit.locationsFor(h, COMPLETE, false)), [BASE + 1, BASE + 2]);
	assert.strictEqual(index.byTitle.get(credit.titleKey('Band', 'Song')).length, 2);
});

// --- finding hits ---------------------------------------------------------------------------------

test('hitsFor tries ratingKey, then part id, then work id, then artist and title', () => {
	assert.strictEqual(only(credit.hitsFor(ix, { ratingKey: '2001' })).entry, MATRIX);
	assert.strictEqual(only(credit.hitsFor(ix, { ratingKey: 999999, partId: '231004' })), only(ix.byRk.get(23004)));
	assert.strictEqual(only(credit.hitsFor(ix, { workId: 'j-r-r-tolkien/the-hobbit' })).entry, HOBBIT);
	assert.strictEqual(only(credit.hitsFor(ix, { artist: 'DAFT  PUNK', title: 'one more time!' })), only(ix.byRk.get(23001)));
	assert.deepStrictEqual(credit.hitsFor(ix, { ratingKey: 999999, artist: 'Nobody', title: 'Nothing' }), []);
	assert.deepStrictEqual(credit.hitsFor(ix, {}), []);
	const copy = credit.hitsFor(ix, { ratingKey: 2001 });
	copy.pop();
	assert.strictEqual(ix.byRk.get(2001).length, 1);
});

test('an unknown ratingKey matches through PMS metadata: movie guid, show + season/episode, album guid + track', () => {
	assert.strictEqual(only(credit.hitsForMetadata(ix, { type: 'movie', ratingKey: '99999', guid: 'plex://movie/5d7768b2' })).entry, MATRIX);
	const e3 = only(credit.hitsForMetadata(ix, { type: 'episode', grandparentGuid: 'plex://show/5eb6f2a1', parentIndex: 1, index: 3 }));
	assert.strictEqual(e3.entry.id, 'rk:2103');
	const tiny = only(credit.hitsForMetadata(ix, { type: 'episode', grandparentGuid: 'local://77', grandparentRatingKey: '2200', parentIndex: '1', index: '2' }));
	assert.strictEqual(tiny.entry.id, 'rk:2202');
	assert.strictEqual(only(credit.hitsForMetadata(ix, { type: 'track', parentGuid: 'plex://album/2300', index: 4, title: 'Digital Love' })), only(ix.byRk.get(23004)));
	assert.deepStrictEqual(credit.hitsForMetadata(ix, { type: 'movie', guid: 'plex://movie/other' }), []);
	assert.deepStrictEqual(credit.hitsForMetadata(ix, { type: 'artist', guid: 'plex://artist/1' }), []);
	assert.deepStrictEqual(credit.hitsForMetadata(ix, null), []);
});

test('a track number repeated on a two-disc album must also match the title', () => {
	const tr = [[1, 1, 'Opening', 200000, 11, BASE + 1], [2, 1, 'Second Disc Opener', 200000, 12, BASE + 2]];
	const album = { k: 'album', id: 'plex://album/z', rk: 10, ar: 'Z', t: 'Z', y: 2000, d: 400000, tr, alt: [], u: BASE + 1001, s: 1, cp: [] };
	const index = credit.indexSlot(slot([album]));
	const meta = (title) => ({ type: 'track', parentGuid: 'plex://album/z', index: 1, title });
	assert.strictEqual(only(credit.hitsForMetadata(index, meta('second disc opener'))).index, 2);
	assert.deepStrictEqual(credit.hitsForMetadata(index, meta('Something Else')), []);
});

// --- unlocks, done, progress ----------------------------------------------------------------------

test('unitCounts counts units by item id and Popcorn and Wild Tickets apart, with ids from slot_data', () => {
	const items = [11, 12, 12, 5, 5, 7].map((item, i) => ({ item, location: i ? 100 + i : -2, player: 1, flags: 0 }));
	const tally = credit.unitCounts(items, { items: { popcorn: 11, wild_ticket: 12 } });
	assert.deepStrictEqual([...tally.units], [[5, 2], [7, 1]]);
	assert.strictEqual(tally.wild, 2);
	assert.strictEqual(tally.popcorn, 1);
	const fixed = credit.unitCounts([{ item: BASE + 2 }, { item: String(BASE + 1) }, { item: 'junk' }, null]);
	assert.deepStrictEqual([fixed.units.size, fixed.wild, fixed.popcorn], [0, 1, 1]);
});

const TRAP = (key) => contracts.TRAPS[key].id;

test('unitCounts counts snacks (Popcorn among them), Fast Forwards, Remote Controls and each trap apart from the units', () => {
	const ids = [
		BASE + 1, BASE + 3, BASE + 3, BASE + 8, BASE + 2, BASE + 100, BASE + 101, BASE + 101,
		TRAP('buffering'), TRAP('rewind'), TRAP('rewind'), TRAP('slow_motion'), 1347001007, 1347001007,
	];
	const items = ids.map((item, i) => ({ item, location: 100 + i, player: 2, flags: 0 }));
	for (const source of [ix, fixture()]) {
		const tally = credit.unitCounts(items, source);
		assert.deepStrictEqual([...tally.units], [[1347001007, 2]], 'only the unlocks are units');
		assert.deepStrictEqual([tally.wild, tally.popcorn, tally.snacks], [1, 1, 4]);
		assert.deepStrictEqual(tally.useful, { fastForward: 1, remoteControl: 2 });
		assert.deepStrictEqual(tally.traps, { buffering: 1, rights_expired: 0, commercial_break: 0, shuffle_mode: 0, rewind: 2, intermission: 0, slow_motion: 1 });
	}
});

test('slot_data without the 0.3.0 keys has none of the new items: their ids stay units, and Popcorn is its only snack', () => {
	const old = credit.indexSlot(slot([]));
	assert.deepStrictEqual([old.items.fastForward, old.items.remoteControl, old.items.traps.size, [...old.items.snacks]], [null, null, 0, [BASE + 1]]);
	assert.deepStrictEqual([old.snackBar, old.pool], [null, null]);
	const items = [BASE + 1, BASE + 3, BASE + 100, TRAP('rewind')].map((item) => ({ item, location: 5, player: 2, flags: 0 }));
	const tally = credit.unitCounts(items, old);
	assert.deepStrictEqual([tally.popcorn, tally.snacks], [1, 1]);
	assert.deepStrictEqual(tally.useful, { fastForward: 0, remoteControl: 0 });
	assert.ok(Object.values(tally.traps).every((n) => n === 0), 'no trap');
	assert.deepStrictEqual([...tally.units.keys()], [BASE + 3, BASE + 100, TRAP('rewind')], 'unknown ids, as a 0.2.0 seed counts them');
	// Half the new keys, or a bad value: what can be read is, the rest is none.
	const half = credit.indexSlot(slot([], {
		items: { popcorn: BASE + 1, wild_ticket: BASE + 2, traps: { rewind: TRAP('rewind'), nope: BASE + 299, intermission: 'x' } },
		snack_bar: { trades: 2, price: 0 },
		pool: { snacks: '12', traps: { rewind: 3 } },
	}));
	assert.deepStrictEqual([...half.items.traps], [[TRAP('rewind'), 'rewind']]);
	assert.strictEqual(half.snackBar, null, 'a price of 0 is no Snack Bar');
	assert.deepStrictEqual([half.pool.snacks, half.pool.traps.rewind, half.pool.traps.buffering, half.pool.fastForwards], [12, 3, 0, 0]);
});

test('the starting copies open the starting titles and nothing else', () => {
	const start = [1347001007, 1347001008, 1347001009].map((item) => ({ item, location: -2, player: 1, flags: 1 }));
	const tally = credit.unitCounts(start, ix);
	const ready = ix.entries.filter((e) => credit.entryStatus(e, tally, [], new Set()) === 'ready').map((e) => e.id);
	assert.deepStrictEqual(ready, ['plex://movie/5d7768b2', 'rk:2002', 'rk:2003']);
	assert.strictEqual(credit.isUnlocked(MATRIX, tally.units), true);
	assert.strictEqual(credit.isUnlocked(ALBUM, tally), false);
});

test('a show opens one step per copy, and a Wild Ticket on an episode opens that episode\'s step', () => {
	const e3 = byId('rk:2103');
	const one = credit.unitCounts([{ item: 1347001013 }], ix);
	const status = () => ix.entries.filter((e) => e.u === 1347001013).map((e) => credit.entryStatus(e, one, redeemed, []));
	let redeemed = [];
	assert.deepStrictEqual(status(), ['ready', 'ready', 'locked', 'locked', 'ready']);
	const keys = credit.redeemKeys(ix, e3, one, redeemed);
	assert.deepStrictEqual(keys, ['episode|rk:2103', 'episode|rk:2104']);
	redeemed = new Set(keys);
	assert.deepStrictEqual(status(), ['ready', 'ready', 'ready', 'ready', 'ready']);
	assert.deepStrictEqual(credit.redeemKeys(ix, e3, one, redeemed), []);
	const two = credit.unitCounts([{ item: 1347001013 }, { item: 1347001013 }], ix);
	assert.strictEqual(credit.isUnlocked(e3, two, []), true);
	assert.deepStrictEqual(credit.redeemKeys(ix, ALBUM, two, []), ['album|plex://album/2300']);
});

test('a Wild Ticket on a show opens one step, never the steps after it', () => {
	const unit = BASE + 1001;
	const episodes = [1, 2, 3, 4, 5, 6, 7].map((en) => ({
		k: 'episode', id: `rk:${30 + en}`, rk: 30 + en, sh: 'Long Show', sid: 'rk:30', srk: 30, sn: 1, en, t: `E${en}`,
		d: 1200000, u: unit, s: Math.ceil(en / 3), w: BASE + en, cp: [],
	}));
	const index = credit.indexSlot(slot(episodes));
	const one = credit.unitCounts([{ item: unit }], index);
	assert.deepStrictEqual(credit.redeemKeys(index, episodes[3], one, []), ['episode|rk:34', 'episode|rk:35', 'episode|rk:36']);
	assert.deepStrictEqual(credit.redeemKeys(index, episodes[6], one, []), ['episode|rk:37']);
	assert.deepStrictEqual(credit.redeemKeys(index, episodes[5], one, ['episode|rk:34']), ['episode|rk:35', 'episode|rk:36']);
	assert.deepStrictEqual(credit.redeemKeys(index, episodes[0], one, []), []);
});

test('an album is done when every track with a location is checked; the short ones do not count', () => {
	assert.strictEqual(credit.entryDone(ALBUM, [BASE + 1, BASE + 2, BASE + 3]), true);
	assert.strictEqual(credit.entryDone(ALBUM, new Set([BASE + 1, BASE + 3])), false);
	assert.strictEqual(credit.entryDone(ALBUM, new Set([String(BASE + 1), String(BASE + 2), String(BASE + 3)])), true);
	assert.strictEqual(credit.entryDone(MATRIX, [MATRIX.w]), true);
	assert.strictEqual(credit.entryDone(PRIDE, PRIDE.cp.map(([, id]) => id)), false);
	assert.strictEqual(credit.entryDone(PRIDE, [PRIDE.f]), true);
	assert.strictEqual(credit.entryDone({ k: 'album', id: 'x', tr: [[1, 1, 'Skit', 10000, 1, null]] }, []), false);
});

test('progress counts done entries against the slot\'s goal', () => {
	assert.deepStrictEqual(credit.progress(ix, []), { done: 0, total: 19, goalCount: 15 });
	const mains = ix.entries.flatMap((e) => credit.entryLocations(e).main);
	assert.deepStrictEqual(credit.progress(ix, mains), { done: 19, total: 19, goalCount: 15 });
	assert.deepStrictEqual(credit.progress(ix, new Set([MATRIX.w, PRIDE.f, BASE + 1])), { done: 2, total: 19, goalCount: 15 });
	assert.strictEqual(credit.entryStatus(MATRIX, new Map(), [], [MATRIX.w]), 'done');
});

// --- slot_data edges --------------------------------------------------------------------------------

test('indexSlot refuses what is not Plex Media slot_data of schema 1', () => {
	assert.throws(() => credit.indexSlot(null), TypeError);
	assert.throws(() => credit.indexSlot({ ...slot([]), game: 'ChecksFinder' }), /ChecksFinder/);
	assert.throws(() => credit.indexSlot({ ...slot([]), schema: 2 }), /schema 2/);
	assert.throws(() => credit.indexSlot({ ...slot([]), entries: null }), /entries/);
});

test('a missing goal_count falls back to the formula', () => {
	const movies = [1, 2, 3, 4, 5].map((n) => ({ k: 'movie', id: `rk:${n}`, rk: n, t: `M${n}`, y: null, d: 0, u: BASE + 1000 + n, s: 1, w: BASE + n, cp: [] }));
	const index = credit.indexSlot({ ...slot(movies), goal_count: undefined });
	assert.strictEqual(index.goalCount, 4);
	const one = credit.indexSlot({ ...slot(movies.slice(0, 1)), goal_count: undefined, goal_percent: 1 });
	assert.strictEqual(one.goalCount, 1);
	assert.strictEqual(credit.indexSlot({ ...slot([]), timesanity_strict: true }).strict, true);
	assert.strictEqual(credit.indexSlot({ ...slot([]), locked_watches: 1 }).lockedPolicy, 'ignore');
});

test('slot_data without a usable generated_at is refused, never floored at created_at or at 0', () => {
	const refused = { name: 'TypeError', message: 'slot_data has no generated_at.' };
	for (const generated of [undefined, null, 0, -1731300000, NaN, Infinity, '1731300000', true]) {
		assert.throws(() => credit.indexSlot({ ...slot([]), generated_at: generated }), refused, String(generated));
	}
	const unstamped = slot([]);
	delete unstamped.generated_at;
	delete unstamped.created_at;
	assert.throws(() => credit.indexSlot(unstamped), refused);
	assert.strictEqual(credit.indexSlot({ ...slot([]), created_at: undefined }).generatedAtMs, 1731300000 * 1000);
});

// --- parsing ------------------------------------------------------------------------------------------

test('parseDuration reads the ways people type a position', () => {
	const cases = [
		['1h30m', 90 * MIN], ['1h 30m', 90 * MIN], ['1h30', 90 * MIN], ['90m', 90 * MIN], ['90 min', 90 * MIN],
		['1:30:00', 90 * MIN], ['45:00', 45 * MIN], ['15m', 15 * MIN], ['2h', 120 * MIN], [' 2 HOURS ', 120 * MIN],
		['1.5h', 90 * MIN], ['45s', 45000], ['1m30s', 90000], ['1:30', 90000], ['45', 45 * MIN], [90, 90 * MIN],
		['@ 1h30m', 90 * MIN], ['0', 0], ['0m', 0],
	];
	for (const [text, ms] of cases) assert.strictEqual(credit.parseDuration(text), ms, JSON.stringify(text));
	for (const bad of [null, undefined, '', '  ', 'abc', 'h', '1:60', '1:5', '-5', '500ms', '1h30m5', '1:30:00:00', {}, '1e3']) {
		assert.strictEqual(credit.parseDuration(bad), null, JSON.stringify(bad));
	}
});

test('normTitle folds case, width, composition, punctuation and whitespace, and agrees with sanitizeText', () => {
	const ch = (...codes) => String.fromCharCode(...codes);
	assert.strictEqual(credit.normTitle('  Daft   PUNK '), 'daft punk');
	assert.strictEqual(credit.normTitle("Don't Stop"), 'dont stop');
	assert.strictEqual(credit.normTitle(`Don${ch(0x2019)}t Stop`), 'dont stop');
	assert.strictEqual(credit.normTitle(ch(0xff24, 0xff41, 0xff46, 0xff54)), 'daft');
	assert.strictEqual(credit.normTitle(`Daft${ch(0xa0)}Punk`), 'daft punk');
	assert.strictEqual(credit.normTitle(`Daft${ch(0x200b)}Punk`), credit.normTitle('DaftPunk'));
	assert.strictEqual(credit.normTitle(`Ame${ch(0x301)}lie`), credit.normTitle(`Am${ch(0xe9)}lie`));
	const raw = `Digital${ch(0x85)}Love${ch(0x2028)}(Live)${ch(7)}\t`;
	assert.strictEqual(credit.normTitle(raw), credit.normTitle(contracts.sanitizeText(raw)));
	assert.strictEqual(credit.normTitle(raw), 'digital love live');
	assert.strictEqual(credit.normTitle(null), '');
});

test('titleKey needs both sides and cannot be confused by a pipe in a name', () => {
	assert.strictEqual(credit.titleKey('Daft Punk', 'One More Time'), 'daft punk|one more time');
	assert.strictEqual(credit.titleKey('a|b', 'c'), 'ab|c');
	assert.strictEqual(credit.titleKey('Daft Punk', '!!!'), null);
	assert.strictEqual(credit.titleKey('', 'Song'), null);
});

test('titleKey needs a letter or digit on each side, so two emoji titles with a variation selector share no key', () => {
	const ch = (...codes) => String.fromCharCode(...codes);
	const heart = ch(0x2764, 0xfe0f);
	const star = ch(0x2b50, 0xfe0f);
	assert.strictEqual(credit.titleKey('Band', heart), null);
	assert.strictEqual(credit.titleKey('Band', star), null);
	assert.strictEqual(credit.titleKey(heart, 'Song'), null);
	assert.strictEqual(credit.titleKey('Band', ch(0x301)), null, 'a lone combining mark');
	assert.strictEqual(credit.titleKey('Band', `Love ${heart}`), `band|love ${ch(0xfe0f)}`);
	assert.strictEqual(credit.titleKey('Band', '1999'), 'band|1999');

	const tr = [[1, 1, heart, 200000, 11, BASE + 1], [2, 2, star, 200000, 12, BASE + 2], [3, 3, 'Real Song', 200000, 13, BASE + 3]];
	const album = { k: 'album', id: 'plex://album/e', rk: 10, ar: 'Band', t: 'E', y: 2000, d: 600000, tr, alt: [], u: BASE + 1001, s: 1, cp: [] };
	const index = credit.indexSlot(slot([album]));
	assert.deepStrictEqual([...index.byTitle.keys()], ['band|real song']);
	assert.deepStrictEqual(credit.hitsFor(index, { artist: 'Band', title: star }), [], 'a play of one emoji title credits no other');
	assert.strictEqual(only(credit.hitsFor(index, { ratingKey: 2 })).index, 2, 'the ratingKey still finds it');
});

// --- timesanity_strict: everything before a checkpoint heard -------------------------------------

// The first rehearsal's audiobook: about 21 minutes heard, 16 skips to 29:54, and the 30:00
// checkpoint came from the ten seconds played across it. The owner wants all of it heard.
test('under strict a stretch played across a mark after a skip earns nothing; hearing the skipped stretch does', () => {
	const whole = credit.wholeHit(MATRIX);
	const [m15, m30] = credit.entryLocations(MATRIX).checkpoints.map((cp) => cp.id);
	let r = credit.strictLocations(whole, span(0, 21.5 * MIN), []);
	assert.deepStrictEqual(r.ids, [m15]);
	r = credit.strictLocations(whole, span(29.9 * MIN, 30.1 * MIN), r.heard);
	assert.ok(!r.ids.includes(m30), 'crossing the mark is not enough');
	assert.deepStrictEqual(r.heard, [[0, 21.5 * MIN], [29.9 * MIN, 30.1 * MIN]]);
	r = credit.strictLocations(whole, span(21.5 * MIN, 29.9 * MIN), r.heard);
	assert.deepStrictEqual(r.ids, [m15, m30]);
	assert.deepStrictEqual(r.heard, [[0, 30.1 * MIN]], 'what is reached is kept as one range');
	assert.deepStrictEqual(credit.locationsFor(whole, span(29.9 * MIN, 30.1 * MIN), true), [m30], 'locationsFor alone still counts a crossing');
});

test('under strict a gap shorter than 30 s is forgiven and one of 30 s is not, wherever it is', () => {
	const whole = credit.wholeHit(MATRIX);
	const m15 = credit.entryLocations(MATRIX).checkpoints[0].id;
	const SEC = 1000;
	assert.deepStrictEqual(credit.strictLocations(whole, span(29 * SEC, 16 * MIN), []).ids, [m15], 'a session\'s unseen first seconds');
	assert.deepStrictEqual(credit.strictLocations(whole, span(30 * SEC, 16 * MIN), []).ids, []);
	assert.deepStrictEqual(credit.strictLocations(whole, span(15 * MIN + 10 * SEC, 16 * MIN), [[0, 14 * MIN + 41 * SEC]]).ids, [m15]);
	assert.deepStrictEqual(credit.strictLocations(whole, span(15 * MIN + 10 * SEC, 16 * MIN), [[0, 14 * MIN + 40 * SEC]]).ids, []);
	assert.strictEqual(credit.HEARD_GAP_MS, 30 * SEC);
});

test('under strict a completion with no stretch earns its main locations alone and proves no listening', () => {
	const whole = credit.wholeHit(MATRIX);
	const r = credit.strictLocations(whole, COMPLETE, [[0, 10 * MIN]]);
	assert.deepStrictEqual(r.ids, [MATRIX.w], 'a Plex history row or a finished bookmark');
	assert.deepStrictEqual(r.heard, [[0, 10 * MIN]]);
	const track1 = only(ix.byRk.get(23001));
	assert.deepStrictEqual(credit.strictLocations(track1, COMPLETE, []).ids, [BASE + 1], 'a track from history: no 5:00');
	assert.deepStrictEqual(credit.strictLocations(track1, { type: 'complete', fromMs: 0, toMs: 320000 }, []).ids, [BASE + 1, BASE + 4], 'a track heard in voice');
	assert.deepStrictEqual(credit.strictLocations(track1, { type: 'complete', fromMs: 0, toMs: 272000 }, []).ids, [BASE + 1], 'heard to 85%: 5:00 is in the unheard tail');
});

test('under strict a track or part stretch lands on the album or book timeline, and sittings add up', () => {
	const track2 = only(ix.byRk.get(23002));
	let r = credit.strictLocations(track2, span(0, 212000), []);
	assert.deepStrictEqual(r.heard, [[320000, 532000]], 'track 2 starts at 5:20');
	assert.deepStrictEqual(r.ids, [], 'track 1 is still unheard');
	r = credit.strictLocations(only(ix.byRk.get(23001)), span(0, 320000), r.heard);
	assert.deepStrictEqual(r.ids, [BASE + 4]);
	const part2 = only(ix.byRk.get(27002));
	const [cp30, cp60, cp90] = credit.entryLocations(HOBBIT).checkpoints.map((cp) => cp.id);
	r = credit.strictLocations(part2, span(0, 31 * MIN), []);
	assert.deepStrictEqual(r.ids, [], 'part 2 alone, with part 1 unheard');
	r = credit.strictLocations(only(ix.byRk.get(27001)), span(0, 60 * MIN), r.heard);
	assert.deepStrictEqual(r.ids, [cp30, cp60, cp90]);
});

test('under strict the ranges come back empty once every checkpoint is reached, and stay small before', () => {
	const whole = credit.wholeHit(MATRIX);
	assert.deepStrictEqual(credit.strictLocations(whole, span(0, 136 * MIN), []).heard, []);
	const scattered = Array.from({ length: 400 }, (_, i) => [i * 2 * MIN + MIN, i * 2 * MIN + 90000]);
	const r = credit.strictLocations(whole, span(0, 30000), scattered);
	assert.strictEqual(r.heard.length, credit.HEARD_MAX_RANGES);
	assert.deepStrictEqual(r.heard[0], [0, 30000], 'the start is kept first');
	assert.deepStrictEqual(credit.strictLocations(whole, { type: 'span' }, [[5, 1], [0, 'x'], null, [0, 20]]).heard, [[0, 20]], 'bad stored ranges are dropped');
	assert.deepStrictEqual(credit.cleanRanges([[10, 20], [0, 5], [5, 12], [30, 40]]), [[0, 20], [30, 40]]);
	assert.strictEqual(credit.heardThrough([[0, 10000], [35000, 50000]]), 50000);
	assert.strictEqual(credit.heardThrough([[0, 10000], [40000, 50000]]), 10000);
	assert.strictEqual(credit.heardThrough([]), 0);
});
// A Plexamp stop and resume, or a track change, leaves a seam of up to two polls plus the client's lag
// that nobody skipped. Session ranges carry a pad for it; bot-played books and voice carry none.
test('under strict a seam between two Plex session ranges is forgiven up to their pads, a bot-book gap only below 30 s', () => {
	const whole = credit.wholeHit(MATRIX);
	const m15 = credit.entryLocations(MATRIX).checkpoints[0].id;
	const SEC = 1000;
	const session = (from, to) => ({ type: 'span', fromMs: from, toMs: to, padMs: 25 * SEC });
	let r = credit.strictLocations(whole, session(0, 10 * MIN), []);
	assert.deepStrictEqual(r.heard, [[0, 10 * MIN, 25 * SEC]], 'the pad rides on the range');
	r = credit.strictLocations(whole, session(10 * MIN + 45 * SEC, 16 * MIN), r.heard);
	assert.deepStrictEqual(r.ids, [m15], 'a 45 s seam between two session ranges at a 15 s poll');
	assert.deepStrictEqual(r.heard, [[0, 16 * MIN, 25 * SEC]], 'the reached range keeps the last pad');
	r = credit.strictLocations(whole, session(10 * MIN + 50 * SEC, 16 * MIN), [[0, 10 * MIN, 25 * SEC]]);
	assert.deepStrictEqual(r.ids, [], 'one of 50 s is not forgiven');
	r = credit.strictLocations(whole, span(10 * MIN + 35 * SEC, 16 * MIN), [[0, 10 * MIN]]);
	assert.deepStrictEqual(r.ids, [], 'a 35 s gap between bot-played ranges is not forgiven');
	r = credit.strictLocations(whole, span(10 * MIN + 29 * SEC, 16 * MIN), [[0, 10 * MIN, 25 * SEC]]);
	assert.deepStrictEqual(r.ids, [m15], 'a session range next to a bot-played one: below 30 s still forgiven');
	r = credit.strictLocations(whole, span(10 * MIN + 31 * SEC, 16 * MIN), [[0, 10 * MIN, 25 * SEC]]);
	assert.deepStrictEqual(r.ids, [], 'and 31 s is not, one pad being 25 s');
	assert.deepStrictEqual(credit.strictLocations(whole, { ...session(40 * SEC, 16 * MIN), padMs: 45 * SEC }, []).ids, [m15], 'a 2x Plexamp step pads its own head');
	assert.deepStrictEqual(credit.strictLocations(whole, session(40 * SEC, 16 * MIN), []).ids, [], 'at 1x, 40 s into the title is too late');
});

test('under strict touching ranges keep the larger pad, a pad stops at 90 s, and a bad pad counts as none', () => {
	assert.deepStrictEqual(credit.cleanRanges([[0, 10, 5], [10, 20, 9], [30, 40, 'x'], [50, 60, 999999]]), [[0, 20, 9], [30, 40], [50, 60, credit.HEARD_PAD_MAX_MS]]);
	assert.strictEqual(credit.HEARD_PAD_MAX_MS, 90000);
	assert.strictEqual(credit.heardThrough([[0, 60000, 25000], [105000, 200000, 25000]]), 200000);
	assert.strictEqual(credit.heardThrough([[0, 60000, 25000], [110000, 200000, 25000]]), 60000);
});

// Seeds already running when strict became all-heard earned checkpoints by crossing them; those, and
// a time credited by hand, carry on from their mark rather than from 0.
test('under strict a checkpoint already earned counts as everything before it heard', () => {
	const whole = credit.wholeHit(MATRIX);
	const [m15, m30, m45] = credit.entryLocations(MATRIX).checkpoints.map((cp) => cp.id);
	let r = credit.strictLocations(whole, span(15 * MIN, 31 * MIN), [], { floorMs: 15 * MIN });
	assert.deepStrictEqual(r.ids, [m15, m30]);
	assert.deepStrictEqual(r.heard, [[0, 31 * MIN]]);
	r = credit.strictLocations(whole, span(16 * MIN, 31 * MIN), [], { floorMs: 15 * MIN });
	assert.deepStrictEqual(r.ids, [m15], 'the floor is a mark, not a pass: 15:00 to 16:00 is still unheard');
	r = credit.strictLocations(whole, span(45 * MIN, 46 * MIN), [], { floorMs: 45 * MIN });
	assert.deepStrictEqual(r.ids, [m15, m30, m45]);
	assert.strictEqual(credit.heardThrough([[20 * MIN, 25 * MIN]], credit.HEARD_GAP_MS, 15 * MIN), 15 * MIN);
	assert.deepStrictEqual(credit.strictLocations(whole, span(0, 1000), [], { floorMs: 120 * MIN }).heard, [], 'the last checkpoint earned: nothing to keep');
});
