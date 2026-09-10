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
function prep(checked, over) {
    const invert = (table) => new Map(Object.entries(table).map(([name, id]) => [id, name]));
    const names = { 4: 'DaveSMetroid', 28: 'ZackWord' };

    const finished = (over && over.finished) || {};
    const client = {
        team: 0,
        hasGoaled: (slot) => finished[slot] === 'goaled',
        hasReleased: (slot) => finished[slot] === 'released',
        hasFullyChecked: (slot) => finished[slot] === 'complete',
        hasFinished: (slot) => Boolean(finished[slot]),
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

// --- slots that are already done ---------------------------------------------------------------
//
// Measured on the live room this was built against: of six finished slots, three carried
// client_status 30 and three carried 0 while sitting at 100% checked. All three of the latter
// were releases. A release hands out every remaining item, which is why it reaches 100%, and it
// is only ever seen live in a PrintJSON — there is no data-storage key to read it back from
// after a restart. So "100% checked with no goal status" cannot be resolved to goal or release,
// and is reported as neither.

test('a goaled slot is skipped rather than given a sphere', () => {
    // It would otherwise reach "nothing left" only once every playthrough row happened to be
    // checked, which is a different question and a slower way to get there.
    const out = monitor.suggestFor(prep({}, { finished: { 28: 'goaled' } }), 'ZackWord');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'finished');
    assert.strictEqual(out.how, 'goaled');
    assert.strictEqual(out.slot, 'ZackWord');
});

test('a released slot is skipped, and says released', () => {
    // A release ends a slot without the spoiler's view of it changing at all, so nothing in the
    // sphere arithmetic would ever notice.
    const out = monitor.suggestFor(prep({}, { finished: { 4: 'released' } }), 'DaveSMetroid');
    assert.strictEqual(out.reason, 'finished');
    assert.strictEqual(out.how, 'released');
});

test('100% checked with no goal status is reported as neither', () => {
    // The honest answer. A slot released while the bot was down looks exactly like one that
    // goaled without its client ever saying so, and this room proved the first is the common case.
    const out = monitor.suggestFor(prep({}, { finished: { 28: 'complete' } }), 'ZackWord');
    assert.strictEqual(out.reason, 'finished');
    assert.strictEqual(out.how, 'complete');
});

test('a finished slot is skipped even with locations still open in the spoiler', () => {
    // ZackWord has both its playthrough rows unchecked here, so the sphere path would happily
    // suggest one. Being done outranks that.
    const open = monitor.suggestFor(prep({}), 'ZackWord');
    assert.strictEqual(open.ok, true, 'the same slot has an answer when it is not finished');
    const out = monitor.suggestFor(prep({}, { finished: { 28: 'goaled' } }), 'ZackWord');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'finished');
});

test('one slot finishing does not silence the others', () => {
    // The case the all-claimed-slots default has to get right: a player deep into a big async
    // has more done than running, and the running ones are the whole point of the reply.
    const p = prep({ '0:4': [82000] }, { finished: { 28: 'released' } });
    assert.strictEqual(monitor.suggestFor(p, 'ZackWord').reason, 'finished');
    const dave = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(dave.ok, true);
    assert.deepStrictEqual(dave.locations, ['X-Ray Scope']);
});

test('a client with no finished-state predicates still answers', () => {
    // suggestFor is exported and called with a prepared read; a client built before these
    // predicates existed must not take the command down.
    const p = prep({ '0:4': [82000] });
    delete p.client.hasFinished;
    assert.strictEqual(monitor.suggestFor(p, 'DaveSMetroid').ok, true);
});

// --- the multidata sphere table ----------------------------------------------------------------
//
// The preferred source, and a simpler join than the spoiler's: it is keyed by location id, which
// is exactly what the tracker reports, so ids never have to become names to be compared. The data
// package is consulted only for the handful of locations about to be shown.

function multidataPrep(checked, over) {
    const p = prep(checked, over);
    p.state.spheres = {
        seed: 'SEED',
        source: 'multidata',
        slots: {
            4: { 1: [82000, 82001], 2: [82002], 3: [82003] },
            28: { 1: [91000], 2: [91001] }
        }
    };
    return p;
}

test('a multidata answer joins ids to names only for what it shows', () => {
    const out = monitor.suggestFor(multidataPrep({ '0:4': [82000] }), 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.source, 'multidata');
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.locations, ['X-Ray Scope'], 'rendered as a name, not an id');
    assert.strictEqual(out.reach, 1);
});

test('the multidata path covers locations no spoiler row mentions', () => {
    // The whole reason for this source. "Morphing Ball" (82003) is in the table at sphere 3 and
    // in no playthrough row for this slot, so the spoiler path could never suggest it.
    const out = monitor.suggestFor(multidataPrep({ '0:4': [82000, 82001, 82002] }), 'DaveSMetroid');
    assert.strictEqual(out.reach, 2);
    assert.strictEqual(out.beyond, 1, 'sphere 3 is still past the proven reach');

    const deeper = monitor.suggestFor(multidataPrep({ '0:4': [82000, 82001, 82003] }), 'DaveSMetroid');
    assert.strictEqual(deeper.reach, 3);
    assert.deepStrictEqual(deeper.locations, ['Ridley'], 'the sphere 2 location is now offered');
});

test('an id with no name in the data package is shown as an id, not dropped', () => {
    // The location is real and worth naming badly; dropping it would silently shrink the answer.
    const p = multidataPrep({});
    p.state.spheres.slots[4] = { 1: [82000, 999999] };
    const out = monitor.suggestFor(p, 'DaveSMetroid');
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)', 'Location#999999']);
});

test('a multidata answer works before the data package has loaded', () => {
    // Names are needed only to render. A slot whose package is still downloading must still get
    // the right locations rather than an empty or wrong answer.
    const p = multidataPrep({ '0:4': [82000] });
    p.client.locationNames = new Map();
    const out = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.locations, ['Location#82001']);
});

test('each slot reads its own row of the table', () => {
    const p = multidataPrep({ '0:4': [82000], '0:28': [91000] });
    assert.deepStrictEqual(monitor.suggestFor(p, 'DaveSMetroid').locations, ['X-Ray Scope']);
    const word = monitor.suggestFor(p, 'ZackWord');
    assert.strictEqual(word.sphere, null, 'sphere 1 cleared, sphere 2 not proven');
    assert.strictEqual(word.beyond, 1);
});

test('a slot missing from the table answers nothing-left rather than throwing', () => {
    const p = multidataPrep({});
    delete p.state.spheres.slots[4];
    const out = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'nothing-left');
});

test('a finished slot is skipped on the multidata path too', () => {
    const out = monitor.suggestFor(multidataPrep({}, { finished: { 28: 'goaled' } }), 'ZackWord');
    assert.strictEqual(out.reason, 'finished');
    assert.strictEqual(out.how, 'goaled');
});

test('no multidata answer carries an item either', () => {
    const p = multidataPrep({ '0:4': [82000] });
    const serialised = JSON.stringify(monitor.suggestFor(p, 'DaveSMetroid'));
    for (const item of ['Progressive Sword', 'Money', 'Ice Trap', 'Grapple Beam']) {
        assert.ok(!serialised.includes(item), `${item} leaked`);
    }
});
