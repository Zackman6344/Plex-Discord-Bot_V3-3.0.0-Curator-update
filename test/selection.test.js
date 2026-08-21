const test = require('node:test');
const assert = require('node:assert');

const { discoveryQuota, weightedShuffle } = require('../helpers/selection.js');

// A deterministic RNG, so the probabilistic behaviour can be asserted exactly.
const fixed = (value) => () => value;

test('the quota honours the percentage at every queue size, not just round ones', () => {
    // Flooring used to make this zero at every size below 10 for a 10% setting, so the setting
    // appeared to do nothing at all on a typical 3-6 track queue.
    assert.strictEqual(discoveryQuota(3, 25, fixed(0.5)), 1, '0.75 rounds up half the time');
    assert.strictEqual(discoveryQuota(3, 25, fixed(0.9)), 0, 'and down the other half');
    assert.strictEqual(discoveryQuota(5, 10, fixed(0.4)), 1, '0.5 of a slot can still land');
    assert.strictEqual(discoveryQuota(20, 25, fixed(0.99)), 5, 'exact multiples are unaffected');
});

test('over many runs the quota averages the requested percentage', () => {
    for (const [size, percent] of [[3, 25], [5, 40], [6, 10], [7, 33]]) {
        let total = 0;
        const runs = 20000;
        for (let i = 0; i < runs; i++) total += discoveryQuota(size, percent);
        const actual = (100 * total) / (runs * size);
        assert.ok(
            Math.abs(actual - percent) < 1.5,
            `${size} tracks at ${percent}% averaged ${actual.toFixed(1)}%`
        );
    }
});

test('the quota never takes the whole queue and never goes negative', () => {
    assert.strictEqual(discoveryQuota(4, 100, fixed(0.1)), 3, 'always leaves a curated pick');
    assert.strictEqual(discoveryQuota(2, 90, fixed(0.1)), 1);
    assert.strictEqual(discoveryQuota(1, 50, fixed(0.1)), 0, 'a single-track queue stays curated');
    assert.strictEqual(discoveryQuota(10, 0, fixed(0.1)), 0, 'zero percent disables it');
});

test('the quota copes with nonsense inputs', () => {
    assert.strictEqual(discoveryQuota(NaN, 25), 0);
    assert.strictEqual(discoveryQuota(10, NaN), 0);
    assert.strictEqual(discoveryQuota(10, -5), 0);
    assert.strictEqual(discoveryQuota(0, 25), 0);
});

test('stronger matches surface near the top far more often', () => {
    // Six tracks: one matching six moods, one matching five, four matching one each.
    const items = [
        { id: 'six', score: 48 },
        { id: 'five', score: 40 },
        { id: 'a', score: 8 },
        { id: 'b', score: 8 },
        { id: 'c', score: 8 },
        { id: 'd', score: 8 }
    ];

    const runs = 4000;
    const firstPlace = {};
    let strongInTopTwo = 0;

    for (let i = 0; i < runs; i++) {
        const order = weightedShuffle(items, (it) => it.score);
        firstPlace[order[0].id] = (firstPlace[order[0].id] || 0) + 1;
        if (['six', 'five'].includes(order[0].id) || ['six', 'five'].includes(order[1].id)) strongInTopTwo++;
    }

    const sixRate = firstPlace.six / runs;
    const weakRate = (firstPlace.a || 0) / runs;

    assert.ok(sixRate > weakRate * 3, `strongest match leads far more often (${sixRate.toFixed(2)} vs ${weakRate.toFixed(2)})`);
    assert.ok(strongInTopTwo / runs > 0.7, 'a strong match is usually in the top two');
});

test('but a strong match is never guaranteed — weak tracks still win sometimes', () => {
    const items = [
        { id: 'strong', score: 48 },
        { id: 'weak', score: 8 }
    ];

    let weakWins = 0;
    for (let i = 0; i < 3000; i++) {
        if (weightedShuffle(items, (it) => it.score)[0].id === 'weak') weakWins++;
    }

    assert.ok(weakWins > 0, 'the weaker track does come first sometimes');
    assert.ok(weakWins < 1500, 'but clearly less than half the time');
});

test('weightedShuffle keeps every item exactly once', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, score: (i % 7) + 1 }));
    const out = weightedShuffle(items, (it) => it.score);

    assert.strictEqual(out.length, items.length);
    assert.deepStrictEqual(new Set(out.map((o) => o.id)).size, items.length, 'no duplicates, nothing dropped');
});

test('weightedShuffle survives zero, missing and negative weights', () => {
    const items = [{ id: 'zero', score: 0 }, { id: 'missing' }, { id: 'negative', score: -5 }, { id: 'fine', score: 10 }];
    const out = weightedShuffle(items, (it) => it.score);

    assert.strictEqual(out.length, 4, 'nothing is dropped for having a broken weight');
    assert.deepStrictEqual(weightedShuffle(null, () => 1), []);
});
