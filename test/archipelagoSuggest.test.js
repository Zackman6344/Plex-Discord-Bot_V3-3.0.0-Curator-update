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

// --- reporting what loaded -------------------------------------------------------------------
//
// The first multidata-backed `!ap next` answered "I could not work that out (Cannot read
// properties of undefined (reading 'length'))". The suggestion was correct; a log line reaching
// for `loaded.rows.length` threw inside prepareSuggest's try, and the catch turned a working
// answer into a failure. Two sources with two shapes means anything touching a loaded object has
// to ask which one it got.

test('each source is described by the field it actually has', () => {
    assert.strictEqual(
        monitor.describeSpheres({ source: 'multidata', slots: { 4: {}, 28: {} } }), 'multidata, 2 slots');
    assert.strictEqual(
        monitor.describeSpheres({ source: 'spoiler', rows: [{}, {}, {}] }), 'spoiler, 3 rows');
});

test('describing a multidata load never reaches for rows', () => {
    // The exact shape that threw: a multidata load has no `rows` at all.
    const loaded = { source: 'multidata', slots: { 4: { 1: [1, 2] } }, path: '/x.json' };
    assert.ok(!('rows' in loaded));
    assert.doesNotThrow(() => monitor.describeSpheres(loaded));
    assert.match(monitor.describeSpheres(loaded), /^multidata, 1 slot$/);
});

test('a malformed or absent load is described, not thrown over', () => {
    // This runs inside prepareSuggest's try block, so anything it throws is reported to the user
    // as a failed suggestion. It must never be the thing that fails.
    assert.strictEqual(monitor.describeSpheres({ source: 'multidata' }), 'multidata, 0 slots');
    assert.strictEqual(monitor.describeSpheres({ source: 'spoiler' }), 'spoiler, 0 rows');
    assert.strictEqual(monitor.describeSpheres({}), 'unknown, 0 rows');
    assert.strictEqual(monitor.describeSpheres(null), 'nothing');
    assert.strictEqual(monitor.describeSpheres(undefined), 'nothing');
});

test('singulars read properly, since this goes in the log', () => {
    assert.strictEqual(monitor.describeSpheres({ source: 'multidata', slots: { 4: {} } }), 'multidata, 1 slot');
    assert.strictEqual(monitor.describeSpheres({ source: 'spoiler', rows: [{}] }), 'spoiler, 1 row');
});

// --- picking up a better source without a restart ----------------------------------------------
//
// ensureSpheres used to load once per seed and keep it for the life of the watch. Drop a spoiler,
// let somebody run `!ap next`, then extract the multidata table, and the watch went on answering
// from the spoiler's tenth of the locations until the bot was restarted. These drive the real
// function against real files in a temp folder.

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const TABLE_V1 = { seed: 'SEED', slots: { 4: { 1: [82000, 82001] } } };
const TABLE_V2 = { seed: 'SEED', slots: { 4: { 1: [82000, 82001, 82002] }, 28: { 1: [91000] } } };

function sphereScratch() {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'plexbot-ensure-'));
    return {
        dir,
        dirs: { sphereDir: dir, spoilerDir: dir },
        state: { watch: { label: 'test' }, spheres: null },
        spoiler: (seed = 'SEED') => nodeFs.writeFileSync(nodePath.join(dir, `${seed}.txt`), SPOILER, 'utf8'),
        table: (body, seed = 'SEED') => nodeFs.writeFileSync(nodePath.join(dir, `${seed}.json`), JSON.stringify(body), 'utf8'),
        remove: (name) => nodeFs.rmSync(nodePath.join(dir, name), { force: true }),
        done: () => nodeFs.rmSync(dir, { recursive: true, force: true })
    };
}

test('a table extracted after the spoiler was loaded is picked up without a restart', async () => {
    // The case that prompted this: exactly the order a person would do it in.
    const s = sphereScratch();
    try {
        s.spoiler();
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).ok, true);
        assert.strictEqual(s.state.spheres.source, 'spoiler');

        s.table(TABLE_V1);
        const again = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(again.reloaded, true);
        assert.strictEqual(s.state.spheres.source, 'multidata', 'the better source took over');
    } finally {
        s.done();
    }
});

test('nothing is reloaded while nothing on disk has changed', async () => {
    // Asked on every command, so an unchanged folder must cost two stats and no reads.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).reloaded, true);
        const held = s.state.spheres;
        const second = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(second.reloaded, false);
        assert.strictEqual(s.state.spheres, held, 'the very same object is kept');
    } finally {
        s.done();
    }
});

test('a re-extracted table replaces the one held', async () => {
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.deepStrictEqual(Object.keys(s.state.spheres.slots), ['4']);

        s.table(TABLE_V2);
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).reloaded, true);
        assert.deepStrictEqual(Object.keys(s.state.spheres.slots).sort(), ['28', '4']);
    } finally {
        s.done();
    }
});

test('deleting the table falls back to the spoiler', async () => {
    const s = sphereScratch();
    try {
        s.spoiler();
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.source, 'multidata');

        s.remove('SEED.json');
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.source, 'spoiler');
    } finally {
        s.done();
    }
});

test('a spoiler changing beside a table leaves the table in charge', async () => {
    // It moves the fingerprint, so there is a reload, but the priority between sources holds.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        s.spoiler();
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.source, 'multidata');
    } finally {
        s.done();
    }
});

test('with every source gone the held data is dropped and both paths are named', async () => {
    // Answering from memory after the files were deleted would hide that they were.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        s.remove('SEED.json');

        const out = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.reason, 'need-spheres');
        assert.match(out.want, /SEED\.json$/);
        assert.match(out.fallback, /SEED\.txt$/);
        assert.strictEqual(s.state.spheres, null);
    } finally {
        s.done();
    }
});

test('a missing source is asked for again on the next call, not remembered as missing', async () => {
    // The ordinary first-time path: run `!ap next`, be told to extract, extract, run it again.
    const s = sphereScratch();
    try {
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).ok, false);
        s.table(TABLE_V1);
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).ok, true);
    } finally {
        s.done();
    }
});

test('a different seed loads its own file', async () => {
    const s = sphereScratch();
    try {
        s.table(TABLE_V1, 'OLD');
        s.table(TABLE_V2, 'NEW');
        await monitor.ensureSpheres(s.state, 'OLD', s.dirs);
        assert.strictEqual(s.state.spheres.seed, 'OLD');
        await monitor.ensureSpheres(s.state, 'NEW', s.dirs);
        assert.strictEqual(s.state.spheres.seed, 'NEW');
        assert.deepStrictEqual(Object.keys(s.state.spheres.slots).sort(), ['28', '4']);
    } finally {
        s.done();
    }
});

test('the held record keeps its own seed and fingerprint over anything the loader returns', async () => {
    // The table file carries a `seed` of its own. If that ever came through and overwrote the
    // held one, a mismatch would reload on every single command.
    const s = sphereScratch();
    try {
        s.table({ seed: 'SOMETHING-ELSE', slots: { 4: { 1: [1] } } });
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.seed, 'SEED');
        assert.match(s.state.spheres.fingerprint, /^table:/);
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).reloaded, false);
    } finally {
        s.done();
    }
});

// --- overlapping calls, and a file still being copied in ------------------------------------
//
// Found by review, reproduced by three reviewers independently. prepareSuggest chooses the sphere
// data, then awaits a multi-second tracker fetch. suggestFor used to read the live
// state.spheres afterwards, and ensureSpheres can now set that to null, so a second `!ap next`
// in the gap made the first one throw "Cannot read properties of null (reading 'source')".
//
// The trigger is more ordinary than deleting a file: Windows copy tools hold the destination open
// exclusively, so every read during a copy fails with EBUSY. Truncated JSON stands in for that
// here, since both reach loadSpheres as "present but would not load".

test('a call keeps answering from the data it chose even after the shared field is dropped', async () => {
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        const a = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        const prepA = { ...prep({ '0:4': [82000] }), state: s.state, spheres: a.spheres };

        // Call B, arriving while A waits on the tracker: every source is gone.
        s.remove('SEED.json');
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).ok, false);
        assert.strictEqual(s.state.spheres, null, 'B dropped the shared field');

        // A resumes. This threw before.
        const out = monitor.suggestFor(prepA, 'DaveSMetroid');
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    } finally {
        s.done();
    }
});

test('ensureSpheres hands back the record to answer from, on every path that succeeds', async () => {
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        const first = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(first.spheres, s.state.spheres, 'the load path');
        const second = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(second.spheres, first.spheres, 'the unchanged path');
    } finally {
        s.done();
    }
});

test('the snapshot wins over whatever the shared field holds by then', async () => {
    // Not only null: a reload in the gap could swap in a different record, and the call should
    // finish on the one it started with.
    const p = prep({ '0:4': [82000] });
    const chosen = p.state.spheres;
    p.spheres = chosen;
    p.state.spheres = { seed: 'SEED', source: 'multidata', slots: {} };
    assert.strictEqual(monitor.suggestFor(p, 'DaveSMetroid').source, 'spoiler');
});

test('a file that will not load mid-copy keeps the held data answering', async () => {
    // Before, this dropped the good record and told the user there was no sphere data while the
    // file sat right there.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        const good = (await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).spheres;

        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.json'), '{"seed":"SEED","slots":{"4":{"1":[8200', 'utf8');
        const during = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(during.ok, true);
        assert.strictEqual(during.stale, true);
        assert.strictEqual(during.spheres, good);
        assert.strictEqual(s.state.spheres, good, 'the shared field is not dropped either');
    } finally {
        s.done();
    }
});

test('once the copy finishes, the next call loads it', async () => {
    // The held fingerprint is deliberately left at its old value during a failed load, so the
    // finished file still reads as a change.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.json'), '{"seed":"SEED","sl', 'utf8');
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);

        s.table(TABLE_V2);
        const after = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(after.reloaded, true);
        assert.deepStrictEqual(Object.keys(s.state.spheres.slots).sort(), ['28', '4']);
    } finally {
        s.done();
    }
});

test('a broken file with nothing held still asks for a source', async () => {
    // There is no earlier record to fall back on, so this is the honest answer.
    const s = sphereScratch();
    try {
        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.json'), 'not json', 'utf8');
        const out = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.reason, 'need-spheres');
    } finally {
        s.done();
    }
});

test('a held record for another seed is never served for this one', async () => {
    // The stale fallback is for the same multiworld only.
    const s = sphereScratch();
    try {
        s.table(TABLE_V1, 'OLD');
        await monitor.ensureSpheres(s.state, 'OLD', s.dirs);
        nodeFs.writeFileSync(nodePath.join(s.dir, 'NEW.json'), 'not json', 'utf8');
        const out = await monitor.ensureSpheres(s.state, 'NEW', s.dirs);
        assert.strictEqual(out.ok, false);
    } finally {
        s.done();
    }
});

test('suggestFor with no sphere data at all answers rather than throwing', () => {
    const p = prep({});
    p.state.spheres = null;
    const out = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'no-spheres');
});

// --- the held record's own file decides, not whether anything is present ----------------------
//
// Found in the second review round, reproduced with real copies (cmd copy, robocopy, Copy-Item)
// and end to end against a live multiworld. Stale-or-drop used to turn on whether loadSpheres
// returned anything and whether any file at all was present. Both go wrong when there are two
// sources on disk.

test('a table copied over the held one does not hand every answer to the spoiler', async () => {
    // During the copy the table read fails and loadSpheres falls back to the spoiler beside it.
    // That used to be stored, so every answer dropped to a tenth of the locations for as long as
    // the copy ran; the end-to-end run saw a location vanish from a reply mid-copy.
    const s = sphereScratch();
    try {
        s.spoiler();
        s.table(TABLE_V1);
        const good = (await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).spheres;
        assert.strictEqual(good.source, 'multidata');

        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.json'), '{"seed":"SEED","slo', 'utf8');
        const during = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(during.stale, true);
        assert.strictEqual(during.spheres.source, 'multidata', 'the spoiler did not take over');
        assert.strictEqual(s.state.spheres, good);

        s.table(TABLE_V2);
        const after = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(after.reloaded, true);
        assert.strictEqual(after.spheres.source, 'multidata');
        assert.deepStrictEqual(Object.keys(after.spheres.slots).sort(), ['28', '4']);
    } finally {
        s.done();
    }
});

test('a table deleted on purpose is not answered from memory beside an unusable spoiler', async () => {
    // "Something is present" used to be enough to keep serving the held table, so deleting a
    // wrong table while a spoiler with no Playthrough sat beside it changed nothing, forever.
    const s = sphereScratch();
    try {
        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.txt'), 'Archipelago spoiler with no playthrough', 'utf8');
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.source, 'multidata');

        s.remove('SEED.json');
        const out = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.reason, 'need-spheres');
        assert.strictEqual(s.state.spheres, null);
    } finally {
        s.done();
    }
});

test('a spoiler deleted on purpose is not answered from memory beside an empty table', async () => {
    // The mirror case: the held record came from the spoiler, and the only thing left is a table
    // that parses but holds no slots.
    const s = sphereScratch();
    try {
        s.spoiler();
        s.table({ seed: 'SEED', slots: {} });
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(s.state.spheres.source, 'spoiler');

        s.remove('SEED.txt');
        assert.strictEqual((await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).ok, false);
        assert.strictEqual(s.state.spheres, null);
    } finally {
        s.done();
    }
});

test('a spoiler being rewritten keeps answering when there is no table', async () => {
    const s = sphereScratch();
    try {
        s.spoiler();
        const good = (await monitor.ensureSpheres(s.state, 'SEED', s.dirs)).spheres;
        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.txt'), 'Playthrough:\n\n1: {\n', 'utf8');
        const during = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(during.stale, true);
        assert.strictEqual(during.spheres, good);
    } finally {
        s.done();
    }
});

test('a better source still takes over from a held spoiler', async () => {
    // The rank check only stops a downgrade. An upgrade is the reason any of this exists.
    const s = sphereScratch();
    try {
        s.spoiler();
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        s.table(TABLE_V1);
        const out = await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        assert.strictEqual(out.stale, undefined);
        assert.strictEqual(out.spheres.source, 'multidata');
    } finally {
        s.done();
    }
});

test('the stale warning is logged once per state of the disk, not on every command', async () => {
    const s = sphereScratch();
    const warned = [];
    const real = console.warn;
    try {
        s.table(TABLE_V1);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        nodeFs.writeFileSync(nodePath.join(s.dir, 'SEED.json'), 'not json', 'utf8');

        console.warn = (...args) => warned.push(args.join(' '));
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        await monitor.ensureSpheres(s.state, 'SEED', s.dirs);
        console.warn = real;

        assert.strictEqual(warned.filter(l => /still answering from what was held/.test(l)).length, 1);
    } finally {
        console.warn = real;
        s.done();
    }
});

// --- ordering slots by the earliest sphere still within reach ----------------------------------

const answer = (slot, sphere) => ({ ok: true, slot, sphere, reach: 5, remaining: 1, beyond: 0, locations: ['x'] });

test('slots are ordered by the earliest sphere still within reach', () => {
    const out = monitor.orderBySoonest([answer('C', 4), answer('A', 1), answer('B', 2)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['A', 'B', 'C']);
});

test('a slot with nothing reachable yet comes after every slot with something to do', () => {
    // Even one whose only open sphere is 17: sphere 17 in reach is still somewhere to go.
    const stuck = { ok: true, slot: 'Aardvark', sphere: null, reach: 2, remaining: 0, beyond: 9, locations: [] };
    const out = monitor.orderBySoonest([stuck, answer('Zebra', 17)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['Zebra', 'Aardvark']);
});

test('slots with no answer at all come last', () => {
    const out = monitor.orderBySoonest([
        { ok: false, slot: 'A', reason: 'nothing-left' },
        { ok: false, slot: 'B', reason: 'unknown-slot' },
        { ok: true, slot: 'C', sphere: null, reach: 1, remaining: 0, beyond: 1, locations: [] },
        answer('D', 9)
    ]);
    assert.deepStrictEqual(out.map(r => r.slot), ['D', 'C', 'A', 'B']);
});

test('a tie goes by slot name, ignoring case, so the same room always lists the same way', () => {
    const out = monitor.orderBySoonest([answer('zackWord', 2), answer('ZackBanner', 2), answer('pkOoT', 2)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['pkOoT', 'ZackBanner', 'zackWord']);
});

test('the list passed in is not reordered', () => {
    const input = [answer('B', 2), answer('A', 1)];
    monitor.orderBySoonest(input);
    assert.deepStrictEqual(input.map(r => r.slot), ['B', 'A']);
});

test('nothing to order is an empty list, not a throw', () => {
    assert.deepStrictEqual(monitor.orderBySoonest([]), []);
    assert.deepStrictEqual(monitor.orderBySoonest(null), []);
    assert.deepStrictEqual(monitor.orderBySoonest(undefined), []);
});

test('real suggestFor answers come out in sphere order', () => {
    // DaveSMetroid has checked into sphere 3 with a sphere-2 location still open; ZackWord has
    // checked nothing, so its soonest is sphere 1. Asked Dave first, ZackWord comes out first.
    const p = multidataPrep({ '0:4': [82000, 82001, 82003] });
    const results = ['DaveSMetroid', 'ZackWord'].map(s => monitor.suggestFor(p, s));
    assert.deepStrictEqual(results.map(r => r.sphere), [2, 1]);
    assert.deepStrictEqual(monitor.orderBySoonest(results).map(r => r.slot), ['ZackWord', 'DaveSMetroid']);
});
