// Joining a tracker's location ids to a spoiler's location names, per slot.
//
// `soonestInLogic` is covered by archipelagoSpheres.test.js and works in names alone. Everything
// between it and the network is here: the caller's slot name becomes a slot number, the slot
// number becomes a game, the game picks a data package, and only then do the tracker's integer
// location ids become the names the spoiler talks in. Any link in that chain can be wrong
// without throwing — a missing data package silently yields "checked nothing", which reads as a
// fresh slot rather than as a failure — so it is asserted directly.
//
// The names and ids below are real ones lifted from a live room: "Power Bomb (Crateria surface)"
// is a Super Metroid location whose own name carries brackets, which is the case that made the
// spoiler parser take the FIRST bracketed run rather than the last.

const test = require('node:test');
const assert = require('node:assert');

const stores = require('./helpers/apServer.js').useTempStores('suggest');
test.after(() => stores.cleanup());

const monitor = require('../helpers/archipelagoMonitor.js');
const spheres = require('../helpers/archipelagoSpheres.js');

const METROID = {
    'Power Bomb (Crateria surface)': 82000,
    'X-Ray Scope': 82001,
    Ridley: 82002,
    'Morphing Ball': 82003
};
const WORDIPELAGO = { 'Used A': 91000, '1 Correct Letter In Word': 91001 };

const SPOILER = [
    'Playthrough:',
    '',
    '1: {',
    '  Power Bomb (Crateria surface) (DaveSMetroid): Progressive Sword (ZackWord)',
    '  X-Ray Scope (DaveSMetroid): Money (ZackWord)',
    '  Used A (ZackWord): Missile (DaveSMetroid)',
    '}',
    '2: {',
    '  Ridley (DaveSMetroid): Ice Trap (ZackWord)',
    '  1 Correct Letter In Word (ZackWord): Grapple Beam (DaveSMetroid)',
    '}',
    ''
].join('\n');

/** The maps the real client builds, with the same keying: slotGames by number, the rest by name. */
function prep(checked) {
    const invert = (table) => new Map(Object.entries(table).map(([name, id]) => [id, name]));
    const names = { 4: 'DaveSMetroid', 28: 'ZackWord' };

    const client = {
        team: 0,
        slotGames: new Map([[4, 'Super Metroid'], [28, 'Wordipelago']]),
        locationNames: new Map([
            ['Super Metroid', invert(METROID)],
            ['Wordipelago', invert(WORDIPELAGO)]
        ]),
        canonicalSlotName: (n) =>
            Object.values(names).find(v => v.toLowerCase() === String(n).trim().toLowerCase()) || null,
        slotIdFor: (n) => {
            const hit = Object.entries(names).find(([, v]) => v.toLowerCase() === String(n).trim().toLowerCase());
            return hit ? Number(hit[0]) : null;
        }
    };

    return {
        ok: true,
        client,
        checkedIds: new Map(Object.entries(checked || {})),
        state: { spheres: { seed: 'SEED', source: 'spoiler', rows: spheres.parsePlaythrough(SPOILER) } }
    };
}

test('a tracker id becomes the spoiler name for the right slot', () => {
    // Sphere 1's Power Bomb is checked, so sphere 1 is proven and the X-Ray Scope is what is left.
    const out = monitor.suggestFor(prep({ '0:4': [82000] }), 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    assert.strictEqual(out.source, 'spoiler');
});

test('each slot is answered from its own game data package', () => {
    // The two id ranges do not overlap here, but the slot's game is what must pick the table:
    // reading Wordipelago's ids against Super Metroid's table yields nothing and looks like a
    // slot that has checked nothing at all.
    const p = prep({ '0:4': [82000, 82001], '0:28': [] });
    assert.strictEqual(monitor.suggestFor(p, 'ZackWord').locations[0], 'Used A');
    // DaveSMetroid cleared all of sphere 1 and has not proven sphere 2.
    const dave = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(dave.sphere, null, 'nothing reachable rather than nothing left');
    assert.strictEqual(dave.beyond, 1);
});

test('a slot with no row in the tracker is treated as having checked nothing', () => {
    const out = monitor.suggestFor(prep({}), 'DaveSMetroid');
    assert.strictEqual(out.reach, 1);
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)', 'X-Ray Scope']);
});

test('the checked set is keyed by team as well as slot', () => {
    // "0:4" and "4" are not the same key. Dropping the team would read an empty list and report
    // a well-explored slot as untouched.
    const out = monitor.suggestFor(prep({ 4: [82000, 82001] }), 'DaveSMetroid');
    assert.strictEqual(out.reach, 1, 'a bare slot number must not match');
    assert.strictEqual(out.remaining, 2);
});

test('an id the data package does not know is skipped, not counted as a name', () => {
    const out = monitor.suggestFor(prep({ '0:4': [82000, 999999] }), 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
});

test('a slot name is matched however it was typed', () => {
    for (const typed of ['davesmetroid', '  DaveSMetroid  ', 'DAVESMETROID']) {
        assert.strictEqual(monitor.suggestFor(prep({}), typed).slot, 'DaveSMetroid', typed);
    }
});

test('a slot the room does not have is refused rather than answered emptily', () => {
    const out = monitor.suggestFor(prep({}), 'NotARealSlot');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'unknown-slot');
    assert.strictEqual(out.slot, 'NotARealSlot');
});

test('a slot with nothing left in the playthrough says so', () => {
    const out = monitor.suggestFor(prep({ '0:28': [91000, 91001] }), 'ZackWord');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'nothing-left');
    assert.strictEqual(out.slot, 'ZackWord');
});

test('no answer ever carries the item that is at the location', () => {
    // The whole feature is "where to go", not "what is there".
    const p = prep({ '0:4': [82000] });
    for (const slot of ['DaveSMetroid', 'ZackWord']) {
        const serialised = JSON.stringify(monitor.suggestFor(p, slot));
        for (const item of ['Progressive Sword', 'Money', 'Ice Trap', 'Grapple Beam', 'Missile']) {
            assert.ok(!serialised.includes(item), `${item} leaked into a ${slot} suggestion`);
        }
    }
});

test('slots are answered independently off one prepared read', () => {
    // What the all-claimed-slots default relies on: one tracker fetch, many answers.
    const p = prep({ '0:4': [82000], '0:28': [91000] });
    const both = ['DaveSMetroid', 'ZackWord'].map(s => monitor.suggestFor(p, s));
    assert.deepStrictEqual(both.map(r => r.slot), ['DaveSMetroid', 'ZackWord']);
    assert.deepStrictEqual(both[0].locations, ['X-Ray Scope']);
    assert.strictEqual(both[1].sphere, null, 'ZackWord cleared sphere 1 and cannot reach 2 yet');
});
