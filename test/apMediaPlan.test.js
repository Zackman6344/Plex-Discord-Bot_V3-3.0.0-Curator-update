// helpers/apMediaPlan.js: the JS twin of apworld/plex_media/plan.py. Units, steps and prefix
// tables, starting copies, locations, checkpoint minutes, goal_count, and the pool's Wild Tickets,
// Fast Forwards, Remote Controls, traps and snacks (spec 4.5).
//
// The YAML builder shows players these numbers before any seed exists. A rule that drifts from the
// Python side tells a player their list opens with titles it does not, so each rule is pinned here
// on the worked examples of spec 4.10 and on its edges, and every case plan.py wrote to
// test/fixtures/apmedia/plan_cases.json must plan identically.
//
// Harness: pure. Entries are built inline in the contracts Entry shape; the golden cases are read
// from the file apworld/tests/make_plan_cases.py writes (skipped while it does not exist).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { planSlot, resolveOptions, checkpointMinutes } = require('../helpers/apMediaPlan.js');
const contracts = require('../helpers/apMediaContracts.js');

const MIN = 60000;

function movie(id, d = 100 * MIN) {
	return { k: 'movie', id, rk: 1, t: `Movie ${id}`, y: 2000, d };
}

function episode(sid, sn, en, d = 24 * MIN, id = `rk:${sid}-${sn}-${en}`) {
	return { k: 'episode', id, rk: 1, sh: `Show ${sid}`, sid, srk: 1, sn, en, t: `E${en}`, d };
}

function show(sid, count, sn = 1) {
	return Array.from({ length: count }, (_, i) => episode(sid, sn, i + 1));
}

function album(id, durations) {
	return {
		k: 'album', id, rk: 1, ar: 'Artist', t: `Album ${id}`, y: 2001,
		d: durations.reduce((a, b) => a + b, 0),
		tr: durations.map((d, i) => [100 + i, i + 1, `Track ${i + 1}`, d, 900 + i]),
	};
}

function mix(id, durations) {
	return {
		k: 'mix', id, pl: 5, part: 1, t: `Mix ${id}`,
		d: durations.reduce((a, b) => a + b, 0),
		tr: durations.map((d, i) => [200 + i, i + 1, `Song ${i + 1}`, d, 800 + i, 'Someone']),
	};
}

function book(w, parts) {
	return {
		k: 'book', id: `book:${w}`, w, t: `Book ${w}`, au: 'Author',
		d: parts.reduce((a, b) => a + b, 0),
		pa: parts.map((d, i) => [300 + i, 700 + i, d]),
	};
}

test('a 102-minute movie on a 15-minute timer gets checkpoints at 15m to 1h30m and one watch location', () => {
	const plan = planSlot([movie('m1', 102 * MIN)], { timesanity_movies: 15 });
	assert.deepStrictEqual(plan.entries, [{ key: 'movie|m1', unit: 'movie|m1', step: 1, main: 1, checkpoints: [15, 30, 45, 60, 75, 90] }]);
	assert.deepStrictEqual(plan.units, [{ key: 'movie|m1', steps: 1, start: 1, prefix: [0, 1] }]);
	assert.strictEqual(plan.N_main, 1);
	assert.strictEqual(plan.N_checkpoints, 6);
});

test('a checkpoint exactly at 90% of the runtime is cut', () => {
	assert.deepStrictEqual(checkpointMinutes(100 * MIN, 15), [15, 30, 45, 60, 75]);
	assert.deepStrictEqual(checkpointMinutes(100 * MIN + 1, 15), [15, 30, 45, 60, 75, 90]);
	assert.deepStrictEqual(checkpointMinutes(10 * MIN, 9), []);
	assert.deepStrictEqual(checkpointMinutes(0, 15), []);
});

test('a timer of 0 means no checkpoints for that kind', () => {
	const plan = planSlot([movie('m1'), book('b1', [3 * 3600000])], { timesanity_movies: 0, timesanity_books: 30 });
	assert.deepStrictEqual(plan.entries[0].checkpoints, []);
	assert.deepStrictEqual(plan.entries[1].checkpoints, [30, 60, 90, 120, 150]);
});

test('albums and mixes: tracks of 30 s or more are locations, the albums timer covers both, the timeline is the tracks end to end', () => {
	const tracks = [20000, 30000, 200000, 400000];
	const plan = planSlot([album('a1', tracks), mix('pl:5:1', tracks)], { timesanity_albums: 5 });
	for (const e of plan.entries) {
		assert.strictEqual(e.main, 3, 'the 20 s track gets no location; 30 s exactly does');
		assert.deepStrictEqual(e.checkpoints, [5], '650 s total: 5m is before the 9.75 min cut, 10m is not');
	}
	assert.strictEqual(plan.N_main, 6);
});

test('the d field of an album does not move its checkpoints; the track sum does', () => {
	const a = album('a1', [600000, 600000]);
	a.d = 1;
	const plan = planSlot([a], { timesanity_albums: 5 });
	assert.deepStrictEqual(plan.entries[0].checkpoints, [5, 10, 15]);
});

test('a book has one finish location and checkpoints over its parts end to end', () => {
	const plan = planSlot([book('b1', [3600000, 3600000, 1800000])], { timesanity_books: 30 });
	assert.deepStrictEqual(plan.entries[0], { key: 'book|book:b1', unit: 'book|book:b1', step: 1, main: 1, checkpoints: [30, 60, 90, 120] });
});

test('episodes mode: steps are ceil(n/k), prefix[c] = min(c*k, n), and each episode steps by its (season, episode) place', () => {
	const eps = [episode('s', 2, 1), episode('s', 1, 3), episode('s', 1, 1), episode('s', 1, 2), episode('s', 2, 3), episode('s', 2, 2), episode('s', 3, 1)];
	const plan = planSlot(eps, { episodes_per_unlock: 3 });
	assert.deepStrictEqual(plan.units.map((u) => [u.key, u.steps, u.prefix]), [['show-ep3|s', 3, [0, 3, 6, 7]]]);
	const stepOf = Object.fromEntries(plan.entries.map((e, i) => [`${eps[i].sn}x${eps[i].en}`, e.step]));
	assert.deepStrictEqual(stepOf, { '1x1': 1, '1x2': 1, '1x3': 1, '2x1': 2, '2x2': 2, '2x3': 2, '3x1': 3 });
});

test('episodes mode with k = 1 and k = 12', () => {
	const one = planSlot(show('s', 5), { episodes_per_unlock: 1 });
	assert.deepStrictEqual(one.units[0], { key: 'show-ep1|s', steps: 5, start: 3, prefix: [0, 1, 2, 3, 4, 5] });
	assert.deepStrictEqual(one.entries.map((e) => e.step), [1, 2, 3, 4, 5]);
	const twelve = planSlot(show('s', 25), { episodes_per_unlock: 12 });
	assert.deepStrictEqual(twelve.units[0].prefix, [0, 12, 24, 25]);
	assert.strictEqual(twelve.units[0].steps, 3);
});

test('season mode: one step per season in the slot, prefix is the running episode count, specials are a season', () => {
	const eps = [...show('s', 2, 0), ...show('s', 3, 1), ...show('s', 2, 2), ...show('s', 1, 4)];
	const plan = planSlot(eps, { tv_unlock: 'season', starting_unlocks: 1 });
	assert.deepStrictEqual(plan.units, [{ key: 'show-season|s', steps: 4, start: 1, prefix: [0, 2, 5, 7, 8] }]);
	assert.deepStrictEqual(plan.entries.map((e) => e.step), [1, 1, 2, 2, 2, 3, 3, 4], 'season 4 is the fourth season present');
});

test('two shows are two units; the unit key follows contracts.unitKey', () => {
	const eps = [...show('a', 4), ...show('b', 2)];
	const plan = planSlot(eps, { episodes_per_unlock: 2 });
	assert.deepStrictEqual(plan.units.map((u) => u.key), ['show-ep2|a', 'show-ep2|b']);
	for (let i = 0; i < eps.length; i++) {
		assert.strictEqual(plan.entries[i].unit, contracts.unitKey(eps[i], { tvUnlock: 'episodes', episodesPerUnlock: 2 }));
	}
});

test('worked example: 3 books with starting_unlocks 1 open 1 and leave 2 locked', () => {
	const plan = planSlot([book('a', [3600000]), book('b', [3600000]), book('c', [3600000])], { starting_unlocks: 1 });
	assert.strictEqual(plan.C, 3);
	assert.strictEqual(plan.S, 1);
	assert.deepStrictEqual(plan.units.map((u) => u.start), [1, 0, 0]);
	assert.strictEqual(plan.startOpen, 1);
});

test('3 books at the default starting_unlocks (3) still leave one locked: S is at most C - 1', () => {
	const plan = planSlot([book('a', [3600000]), book('b', [3600000]), book('c', [3600000])]);
	assert.strictEqual(plan.S, 2);
	assert.deepStrictEqual(plan.units.map((u) => u.start), [1, 1, 0]);
});

test('worked example: 1 show of 24 episodes, k = 3, S = 3 opens E01 to E09', () => {
	const plan = planSlot(show('s', 24), { episodes_per_unlock: 3, starting_unlocks: 3 });
	assert.strictEqual(plan.C, 8);
	assert.strictEqual(plan.S, 3);
	assert.deepStrictEqual(plan.units[0].prefix[plan.units[0].start], 9);
	const open = plan.entries.filter((e) => e.step <= plan.units[0].start).length;
	assert.strictEqual(open, 9);
	assert.strictEqual(plan.startOpen, 9);
});

test('a single title opens: S never drops below 1', () => {
	const plan = planSlot([movie('m1')], { starting_unlocks: 1 });
	assert.strictEqual(plan.C, 1);
	assert.strictEqual(plan.S, 1);
	assert.strictEqual(plan.units[0].start, 1);
});

test('S is at least ceil(C / 50) so a long list never opens with one title', () => {
	const many = Array.from({ length: 120 }, (_, i) => movie(`m${i}`));
	const plan = planSlot(many, { starting_unlocks: 1 });
	assert.strictEqual(plan.S, 3);
});

test('starting copies go round robin over units in order of first appearance, never past the steps of a unit', () => {
	const entries = [...show('a', 9), movie('m1'), movie('m2')];
	const four = planSlot(entries, { episodes_per_unlock: 3, starting_unlocks: 4 });
	assert.deepStrictEqual(four.units.map((u) => [u.key, u.start]), [['show-ep3|a', 2], ['movie|m1', 1], ['movie|m2', 1]]);

	const capped = planSlot([...show('a', 9), movie('m1')], { episodes_per_unlock: 3, starting_unlocks: 3 });
	assert.deepStrictEqual(capped.units.map((u) => u.start), [2, 1]);

	const order = planSlot([movie('m2'), ...show('a', 3), movie('m1')], { episodes_per_unlock: 3, starting_unlocks: 1 });
	assert.deepStrictEqual(order.units.map((u) => [u.key, u.start]), [['movie|m2', 1], ['show-ep3|a', 0], ['movie|m1', 0]]);
});

test('Wild Tickets are clamped so Popcorn always covers the checkpoints', () => {
	const books = planSlot([book('a', [3600000]), book('b', [3600000]), book('c', [3600000])], { starting_unlocks: 1, wild_tickets: 5 });
	assert.strictEqual(books.N_main - (books.C - books.S), 1);
	assert.strictEqual(books.W, 1);

	const roomy = planSlot([album('a1', [60000, 60000, 60000, 60000]), movie('m1'), movie('m2')], { starting_unlocks: 1, wild_tickets: 2 });
	assert.strictEqual(roomy.W, 2);

	const short = planSlot([mix('pl:1:1', [10000, 10000]), mix('pl:1:2', [10000])], { starting_unlocks: 1, wild_tickets: 2 });
	assert.strictEqual(short.N_main, 0);
	assert.strictEqual(short.W, 0, 'a negative cap clamps to 0');
});

test('goal_count = max(1, floor(entries * goal_percent / 100))', () => {
	assert.strictEqual(planSlot([movie('m1')], { goal_percent: 1 }).goal_count, 1);
	const fifty = Array.from({ length: 50 }, (_, i) => movie(`m${i}`));
	assert.strictEqual(planSlot(fifty, { goal_percent: 80 }).goal_count, 40);
	assert.strictEqual(planSlot([movie('a'), movie('b'), movie('c')], { goal_percent: 80 }).goal_count, 2);
	assert.strictEqual(planSlot([movie('a'), movie('b'), movie('c')], { goal_percent: 100 }).goal_count, 3);
});

test('episodes sharing a (season, episode) pair keep their list order, like Python sorted()', () => {
	const eps = [episode('s', 1, 2, 24 * MIN, 'second-listed'), episode('s', 1, 1, 24 * MIN, 'tie-a'), episode('s', 1, 1, 24 * MIN, 'tie-b')];
	const plan = planSlot(eps, { episodes_per_unlock: 1 });
	assert.deepStrictEqual(plan.entries.map((e) => [e.key, e.step]), [['episode|second-listed', 3], ['episode|tie-a', 1], ['episode|tie-b', 2]]);
});

test('options also take Python integer choice and toggle values, and refuse anything out of range', () => {
	assert.strictEqual(resolveOptions({ tv_unlock: 1 }).tv_unlock, 'season');
	assert.strictEqual(resolveOptions({ checkpoint_items: 1 }).checkpoint_items, 'anything');
	assert.strictEqual(resolveOptions({ timesanity_strict: 1 }).timesanity_strict, true);
	assert.deepStrictEqual(resolveOptions({}), Object.fromEntries(Object.entries(contracts.OPTIONS).map(([k, s]) => [k, s.default])));
	assert.throws(() => resolveOptions({ starting_unlocks: 0 }), /starting_unlocks/);
	assert.throws(() => resolveOptions({ timesanity_books: 1441 }), /timesanity_books/);
	assert.throws(() => resolveOptions({ tv_unlock: 'weekly' }), /tv_unlock/);
	assert.throws(() => resolveOptions({ episodes_per_unlock: 2.5 }), /episodes_per_unlock/);
});

test('a title listed twice, an unknown kind, or an episode with no show id is refused', () => {
	assert.throws(() => planSlot([movie('m1'), movie('m1')]), /movie\|m1 is on the list twice/);
	assert.throws(() => planSlot([{ k: 'track', id: 'x' }]), /unknown kind/);
	assert.throws(() => planSlot([{ ...episode('s', 1, 1), sid: '' }]), /show id/);
	assert.throws(() => planSlot([{ ...album('a', [60000]), tr: [] }]), /at least one track/);
	assert.throws(() => planSlot([{ ...book('b', [60000]), pa: [] }]), /at least one part/);
});

test('the summary numbers: counts, locations, hours, start and the goal estimate', () => {
	const entries = [movie('m1', 120 * MIN), movie('m2', 60 * MIN), ...show('s', 6, 1).map((e) => ({ ...e, d: 30 * MIN })), book('b1', [4 * 3600000])];
	const plan = planSlot(entries, { starting_unlocks: 2, episodes_per_unlock: 3, timesanity_movies: 0, timesanity_episodes: 0, timesanity_books: 60 });
	assert.deepStrictEqual(plan.counts, { movie: 2, episode: 6, album: 0, mix: 0, book: 1 });
	assert.strictEqual(plan.shows, 1);
	assert.strictEqual(plan.entryCount, 9);
	assert.strictEqual(plan.locations, 9 + 3, 'one main each, book checkpoints at 60, 120, 180 (240 is past the cut)');
	assert.strictEqual(plan.hours, 2 + 1 + 3 + 4);
	assert.strictEqual(plan.S, 2);
	assert.strictEqual(plan.startOpen, 2, 'the two movies take the two starting copies');
	assert.strictEqual(plan.goal_count, 7);
	assert.strictEqual(plan.hoursToGoal, 10 * 7 / 9);
	assert.deepStrictEqual(plan.byKind.book, { entries: 1, main: 1, checkpoints: 3, ms: 4 * 3600000 });
});

test('the pool: useful items take the room the unlocks leave, trap_percentage of the filler is traps by weight, the rest snacks in turn', () => {
	const films = Array.from({ length: 6 }, (_, i) => movie(`m${i}`));
	const plan = planSlot(films, { trap_percentage: 40 });
	assert.deepStrictEqual([plan.W, plan.FF, plan.RC, plan.F, plan.T], [2, 1, 0, 30, 12], '6 watches, 3 unlocks in the pool: a room of 3');
	assert.deepStrictEqual(Object.values(plan.traps), [3, 3, 2, 1, 1, 1, 1]);
	assert.deepStrictEqual(Object.values(plan.snacks), [3, 3, 3, 3, 2, 2, 2]);
	const off = planSlot(films, { trap_percentage: 40, snack_variety: false });
	assert.deepStrictEqual(Object.values(off.snacks), [18, 0, 0, 0, 0, 0, 0]);
	assert.strictEqual(planSlot(films).T, 0, 'no traps by default');
	const zero = Object.fromEntries(Object.keys(contracts.TRAPS).map((key) => [`${key}_weight`, 0]));
	assert.throws(() => planSlot(films, { trap_percentage: 40, ...zero }),
		/^Error: trap_percentage 40 makes 12 of the list's 30 filler items traps, but every trap weight is 0 \(a trap weight above 0, or trap_percentage 0, would help\)$/);
	assert.strictEqual(planSlot(films, { trap_percentage: 3, ...zero }).T, 0, 'no trap due: the weights do not matter');
});

test('an empty list plans to nothing without throwing, and hands out no copies', () => {
	const plan = planSlot([]);
	assert.strictEqual(plan.C, 0);
	assert.strictEqual(plan.S, 0);
	assert.strictEqual(plan.N_main, 0);
	assert.deepStrictEqual(plan.units, []);
	assert.strictEqual(plan.startOpen, 0);
});

const CASES = path.join(__dirname, 'fixtures', 'apmedia', 'plan_cases.json');

test('every case plan.py wrote to plan_cases.json plans the same here', { skip: fs.existsSync(CASES) ? false : 'plan_cases.json is not written yet' }, () => {
	const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
	assert.ok(Array.isArray(cases) && cases.length > 0);
	for (const c of cases) {
		const plan = planSlot(c.entries, c.options);
		const got = {
			C: plan.C, S: plan.S, W: plan.W, N_main: plan.N_main, N_checkpoints: plan.N_checkpoints, goal_count: plan.goal_count,
			FF: plan.FF, RC: plan.RC, F: plan.F, T: plan.T, traps: plan.traps, snacks: plan.snacks, units: plan.units, entries: plan.entries,
		};
		assert.deepStrictEqual(got, c.expect, c.name);
		assert.deepStrictEqual(Object.keys(plan.traps), Object.keys(contracts.TRAPS), `${c.name}: traps in table order`);
		assert.deepStrictEqual(Object.keys(plan.snacks), Object.keys(contracts.SNACKS), `${c.name}: snacks in table order`);
	}
});
