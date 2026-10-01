// Joining a tracker's location ids to names, per slot, and turning the logic worker's replies into
// answers.
//
// The sphere 1 arithmetic is covered by archipelagoSpheres.test.js and works in names or ids
// alone. Everything between it and the network is here: the caller's slot name becomes a slot
// number, the slot number becomes a game, the game picks a data package, and only then do integer
// location ids become the names a reply talks in. Any link in that chain can be wrong without
// throwing — a missing data package silently yields "checked nothing", which reads as a fresh slot
// rather than as a failure — so it is asserted directly.
//
// The road to the seed's own logic (archipelagoLogic.js) has links like that too. A query keyed by
// the wrong team reads as a slot that has received nothing, and is answered without complaint and
// answered wrong. The worker is faked here: what is tested is what it is asked, and what is made of
// its reply.
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
    // The Power Bomb is checked, so the X-Ray Scope is what sphere 1 has left.
    const out = monitor.suggestFor(prep({ '0:4': [82000] }), 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'sphere1');
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.source, 'spoiler');
});

test('a spoiler answer never counts what is left', () => {
    // The Playthrough lists only the placements completion needs. Its unchecked rows are a count
    // of required items still out there, which is a hint, and short of the slot's real total too.
    for (const checked of [{}, { '0:4': [82000] }, { '0:4': [82000, 82001, 82002] }]) {
        const out = monitor.suggestFor(prep(checked), 'DaveSMetroid');
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.open, null, JSON.stringify(checked));
    }
});

test('each slot is answered from its own game data package', () => {
    // The two id ranges do not overlap here, but the slot's game is what must pick the table:
    // reading Wordipelago's ids against Super Metroid's table yields nothing and looks like a
    // slot that has checked nothing at all.
    const p = prep({ '0:4': [82000, 82001], '0:28': [] });
    assert.strictEqual(monitor.suggestFor(p, 'ZackWord').locations[0], 'Used A');
    const dave = monitor.suggestFor(p, 'DaveSMetroid');
    assert.strictEqual(dave.ok, true, 'nothing listed rather than nothing left');
    assert.strictEqual(dave.sphere, null);
    assert.strictEqual(dave.total, 0);
});

test('a slot with no row in the tracker is treated as having checked nothing', () => {
    const out = monitor.suggestFor(prep({}), 'DaveSMetroid');
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)', 'X-Ray Scope']);
    assert.strictEqual(out.total, 2);
});

test('the checked set is keyed by team as well as slot', () => {
    // "0:4" and "4" are not the same key. Dropping the team would read an empty list and report
    // a well-explored slot as untouched.
    const out = monitor.suggestFor(prep({ 4: [82000, 82001] }), 'DaveSMetroid');
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)', 'X-Ray Scope'],
        'a bare slot number must not match');
    assert.strictEqual(out.total, 2);
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

test('a slot with every playthrough row checked is not told it has nothing left', () => {
    // Running out of rows says the slot has done what completion needs, not that it is done.
    // "Nothing left" would send a player away from locations that are still there.
    const out = monitor.suggestFor(prep({ '0:28': [91000, 91001] }), 'ZackWord');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.slot, 'ZackWord');
    assert.deepStrictEqual(out.locations, []);
    assert.strictEqual(out.sphere, null);
    assert.strictEqual(out.total, 0);
    assert.strictEqual(out.open, null);
});

test('a slot the playthrough never mentions is answered with nothing listed, not nothing left', () => {
    // A slot none of whose finds completion needed has no rows at all. It still has a world to
    // explore.
    const p = prep({});
    p.state.spheres.rows = p.state.spheres.rows.filter(r => r.finder !== 'ZackWord');
    const out = monitor.suggestFor(p, 'ZackWord');
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.locations, []);
    assert.strictEqual(out.open, null);
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
    assert.strictEqual(both[1].sphere, null, 'ZackWord cleared sphere 1, and nothing past it is vouched for');
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
    // Nothing in the sphere arithmetic knows a slot is done: the spoiler never says so, and the
    // table only once every location in it happens to be checked.
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

test('a finished slot says finished even with no sphere data to answer from', () => {
    // Being done needs no sphere data to know. Asking for a sphere file to be extracted, for a
    // slot that goaled, sends somebody off to do work that could not change the answer.
    const p = prep({}, { finished: { 28: 'goaled' } });
    p.state.spheres = null;
    assert.deepStrictEqual(monitor.suggestFor(p, 'ZackWord'),
        { ok: false, reason: 'finished', slot: 'ZackWord', how: 'goaled' });
    assert.strictEqual(monitor.suggestFor(p, 'DaveSMetroid').reason, 'no-spheres',
        'the slot still playing is the one that needs the data');
});

test('a slot the room does not have is refused as unknown even with no sphere data', () => {
    const p = prep({});
    p.state.spheres = null;
    assert.deepStrictEqual(monitor.suggestFor(p, 'NotARealSlot'),
        { ok: false, reason: 'unknown-slot', slot: 'NotARealSlot' });
});

// --- the multidata sphere table ----------------------------------------------------------------
//
// The better sphere source, and a simpler join than the spoiler's: it is keyed by location id, which
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
    assert.strictEqual(out.mode, 'sphere1');
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.locations, ['X-Ray Scope'], 'rendered as a name, not an id');
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.open, 3);
});

test('the multidata path covers locations no spoiler row mentions', () => {
    // The whole reason for this source. "Morphing Ball" (82003) is in the table at sphere 3 and
    // in no playthrough row for this slot, so the spoiler has nothing to list for it and no way
    // to count it.
    const checked = { '0:4': [82000, 82001, 82002] };
    const fromSpoiler = monitor.suggestFor(prep(checked), 'DaveSMetroid');
    assert.deepStrictEqual(fromSpoiler.locations, []);
    assert.strictEqual(fromSpoiler.open, null);

    const out = monitor.suggestFor(multidataPrep(checked), 'DaveSMetroid');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.open, 1, 'still counted as somewhere to go');
    assert.deepStrictEqual(out.locations, [], 'but not listed: sphere 3 is not sphere 1');
});

test('checking deep into the table never opens the spheres before it', () => {
    // The rule this replaced took a checked sphere 3 location to mean spheres 1 to 3 were open,
    // and listed Ridley here. That check says the slot held what THAT location needed, not every
    // item the whole multiworld had collected by sphere 2, which is what Ridley's number assumes.
    const out = monitor.suggestFor(multidataPrep({ '0:4': [82000, 82001, 82003] }), 'DaveSMetroid');
    assert.deepStrictEqual(out.locations, []);
    assert.strictEqual(out.sphere, null);
    assert.strictEqual(out.open, 1, 'Ridley is still counted, only not listed');
});

test('an id with no name in the data package is shown as an id, not dropped', () => {
    // The location is real and worth naming badly; dropping it would silently shrink the answer.
    const p = multidataPrep({});
    p.state.spheres.slots[4] = { 1: [82000, 999999] };
    const out = monitor.suggestFor(p, 'DaveSMetroid');
    assert.deepStrictEqual(out.locations, ['Location#999999', 'Power Bomb (Crateria surface)']);
});

test('a multidata answer lists its names in natural order, not by id or character by character', () => {
    // The table hands back ids, and ids follow nothing a player reads. Sorted as plain strings,
    // "Layer 100" would come before "Layer 67".
    const p = multidataPrep({});
    const names = p.client.locationNames.get('Super Metroid');
    names.set(82010, 'Layer 100');
    names.set(82011, 'Layer 67');
    names.set(82012, 'Layer 9');
    p.state.spheres.slots[4] = { 1: [82010, 82011, 82012] };
    assert.deepStrictEqual(monitor.suggestFor(p, 'DaveSMetroid').locations, ['Layer 9', 'Layer 67', 'Layer 100']);
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
    assert.strictEqual(word.sphere, null, 'sphere 1 cleared');
    assert.strictEqual(word.total, 0);
    assert.strictEqual(word.open, 1, 'its sphere 2 location is still counted');
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

// --- resolving a slot name ---------------------------------------------------------------------
//
// Shared by both paths, and where a slot is settled before any logic or sphere work is done.

test('a slot name resolves to the room\'s own spelling and its slot number', () => {
    const { client } = prep({});
    assert.deepStrictEqual(monitor.resolveSlot(client, '  davesmetroid '), { ok: true, slot: 'DaveSMetroid', slotId: 4 });
    assert.deepStrictEqual(monitor.resolveSlot(client, 'ZACKWORD'), { ok: true, slot: 'ZackWord', slotId: 28 });
});

test('a name the room does not have is refused with the name as typed', () => {
    // As typed, so the reply can repeat back what was asked for.
    const { client } = prep({});
    assert.deepStrictEqual(monitor.resolveSlot(client, 'NotARealSlot'),
        { ok: false, reason: 'unknown-slot', slot: 'NotARealSlot' });
});

test('a name the room knows but cannot number is refused too', () => {
    // With no number there is no tracker row and nothing to ask the worker, and answering anyway
    // would read as a slot that has checked and received nothing.
    const { client } = prep({});
    client.slotIdFor = () => null;
    assert.strictEqual(monitor.resolveSlot(client, 'DaveSMetroid').reason, 'unknown-slot');
});

test('a finished slot is settled here, saying how', () => {
    for (const how of ['goaled', 'released', 'complete']) {
        const { client } = prep({}, { finished: { 4: how } });
        assert.deepStrictEqual(monitor.resolveSlot(client, 'DaveSMetroid'),
            { ok: false, reason: 'finished', slot: 'DaveSMetroid', how }, how);
    }
});

// --- answers from the seed's own logic ---------------------------------------------------------
//
// The worker replies in location ids and sphere numbers, and nothing else it sends may reach an
// answer: a slot whose rebuild did not verify carries a reason, a query that raised carries an
// error, and either can hold the repr of a Python exception, which can quote an item by name.

/** One slot's worker reply, answered for DaveSMetroid unless another slot is named. */
function fromLogic(reply, slot = 'DaveSMetroid', client = prep({}).client) {
    return monitor.answerFromLogic(client, monitor.resolveSlot(client, slot), reply);
}

test('a logic answer names its locations from the slot\'s own game data package', () => {
    const out = fromLogic({ slot: 4, verified: true, locations: [[82001, 1], [82002, 2]], open: 3 });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.slot, 'DaveSMetroid');
    assert.strictEqual(out.mode, 'logic');
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.later, [{ sphere: 2, count: 1 }]);
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.open, 3);
    assert.strictEqual(out.why, undefined, 'nothing to explain when the logic answered');
});

test('an id is named from the asking slot\'s game, never from another\'s', () => {
    // Location ids are unique only within a game; one id in the live room's packages exists in
    // five of them. Named from the wrong package, a location sends somebody to a place their own
    // world does not have.
    const { client } = prep({});
    client.locationNames.get('Super Metroid').set(91000, 'Kraid');
    const reply = { verified: true, locations: [[91000, 1]], open: 1 };
    assert.deepStrictEqual(fromLogic({ slot: 28, ...reply }, 'ZackWord', client).locations, ['Used A']);
    assert.deepStrictEqual(fromLogic({ slot: 4, ...reply }, 'DaveSMetroid', client).locations, ['Kraid']);
});

test('an id the data package does not know is kept as Location#<id>, not dropped', () => {
    const out = fromLogic({ slot: 4, verified: true, locations: [[82001, 1], [999999, 1]], open: 2 });
    assert.deepStrictEqual(out.locations, ['Location#999999', 'X-Ray Scope']);
    assert.strictEqual(out.total, 2);
});

test('a logic answer works before the data package has loaded', () => {
    const { client } = prep({});
    client.locationNames = new Map();
    const out = fromLogic({ slot: 4, verified: true, locations: [[82001, 1]], open: 1 }, 'DaveSMetroid', client);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.locations, ['Location#82001']);
});

test('only the earliest sphere is listed, by name, and later ones are counted, with no known sphere last', () => {
    // A null sphere is a location generation gave no sphere to. The rules still say it is open,
    // so it is counted, only never ahead of anything whose sphere is known. It arrives first here
    // so that taking the worker's first location as the earliest would show.
    const out = fromLogic({
        slot: 4,
        verified: true,
        locations: [[82003, null], [82002, 2], [82001, 1], [82000, 1]],
        open: 4
    });
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)', 'X-Ray Scope']);
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.later, [{ sphere: 2, count: 1 }, { sphere: null, count: 1 }]);
    assert.strictEqual(out.total, 4);
});

test('later spheres come in sphere order, each counted exactly, with no group for a sphere holding nothing', () => {
    // Out of order, and with the unknown ones split up, so the counts only come out right if each
    // sphere's locations are gathered wherever the worker put them. Nothing is in sphere 4.
    const out = fromLogic({
        slot: 4,
        verified: true,
        locations: [
            [90005, 5], [82002, 3], [90009, null], [82001, 1], [90002, 2],
            [90006, 5], [82003, 3], [90010, null], [90007, 5], [90003, 3]
        ],
        open: 40
    });
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    assert.strictEqual(out.sphere, 1);
    assert.deepStrictEqual(out.later, [
        { sphere: 2, count: 1 },
        { sphere: 3, count: 3 },
        { sphere: 5, count: 3 },
        { sphere: null, count: 2 }
    ]);
});

test('a later sphere is never named, only counted', () => {
    // The reply has room for one sphere's names. A name from a later sphere listed beside them
    // would read as somewhere to go now.
    const out = fromLogic({ slot: 4, verified: true, locations: [[82002, 2], [82000, 1], [82003, null]], open: 3 });
    assert.deepStrictEqual(out.locations, ['Power Bomb (Crateria surface)']);
    const serialised = JSON.stringify(out);
    for (const later of ['Ridley', 'Morphing Ball']) {
        assert.ok(!serialised.includes(later), `${later} was named`);
    }
});

test('the total counts everything in logic: the names listed plus every later sphere\'s count', () => {
    // The reply says how much is locked as open minus total, so a total of only the names listed
    // would call everything in a later sphere locked.
    const replies = [
        [],
        [[82001, 1]],
        [[82003, null], [82002, null]],
        [[82002, 2], [82001, 1], [82000, 1], [82003, null]],
        [[90002, 2], [90003, 3], [90004, 3], [90005, 7], [90006, null]]
    ];
    for (const locations of replies) {
        const out = fromLogic({ slot: 4, verified: true, locations, open: 20 });
        const later = out.later.reduce((sum, group) => sum + group.count, 0);
        assert.strictEqual(out.total, locations.length, JSON.stringify(locations));
        assert.strictEqual(out.total, out.locations.length + later, JSON.stringify(locations));
    }
});

test('names within one sphere are in natural order, so "Layer 67" comes before "Layer 100"', () => {
    const { client } = prep({});
    const names = client.locationNames.get('Super Metroid');
    names.set(82010, 'Layer 100');
    names.set(82011, 'Layer 67');
    names.set(82012, 'Layer 9');
    const out = fromLogic({
        slot: 4, verified: true, locations: [[82010, 1], [82011, 1], [82012, 1]], open: 3
    }, 'DaveSMetroid', client);
    assert.deepStrictEqual(out.locations, ['Layer 9', 'Layer 67', 'Layer 100']);
});

test('a list with no known sphere at all lists every name under no sphere, not zero or Infinity, with nothing later', () => {
    // Unknown is the earliest there is here, so its names are the ones to show. Counted as a later
    // group instead, they would leave a slot with something in logic listing nothing.
    const out = fromLogic({ slot: 4, verified: true, locations: [[82003, null], [82002, null]], open: 2 });
    assert.deepStrictEqual(out.locations, ['Morphing Ball', 'Ridley']);
    assert.strictEqual(out.sphere, null);
    assert.deepStrictEqual(out.later, []);
    assert.strictEqual(out.total, 2);
});

test('a slot whose rebuild did not verify answers as sphere 1 only, and says why', () => {
    // The worker sends that slot's unchecked sphere 1 in place of a logic answer. Labelled as
    // logic, it would claim the seed's rules had been consulted for a slot they could not be.
    const out = fromLogic({
        slot: 4, verified: false, reason: 'sphere 3: 2 missing, 0 early', locations: [[82001, 1]], open: 3
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.mode, 'sphere1');
    assert.deepStrictEqual(out.locations, ['X-Ray Scope']);
    assert.strictEqual(out.open, 3);
    // A code the reply turns into its own words. The worker's reason is for the log only, since
    // it can quote an exception, and an exception can name an item.
    assert.strictEqual(out.why, 'unverified');
    assert.ok(!JSON.stringify(out).includes('missing'), 'none of the worker\'s reason reaches the answer');
});

test('a slot with nothing unchecked answers nothing-left', () => {
    assert.deepStrictEqual(fromLogic({ slot: 4, verified: true, locations: [], open: 0 }),
        { ok: false, reason: 'nothing-left', slot: 'DaveSMetroid' });
});

test('a slot with locations left but none in logic answers an empty list, not nothing-left', () => {
    // "Nothing in logic yet" and "nothing left" send a player different ways: one to wait for
    // items, the other to stop looking.
    const out = fromLogic({ slot: 4, verified: true, locations: [], open: 5 });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.locations, []);
    assert.strictEqual(out.sphere, null);
    assert.deepStrictEqual(out.later, []);
    assert.strictEqual(out.total, 0);
    assert.strictEqual(out.open, 5);
});

test('the worker not knowing the slot number answers unknown-slot', () => {
    assert.deepStrictEqual(fromLogic({ slot: 4, error: 'not a slot in this multiworld' }),
        { ok: false, reason: 'unknown-slot', slot: 'DaveSMetroid' });
});

test('any other worker error answers failed, with none of the error in it', () => {
    assert.deepStrictEqual(fromLogic({ slot: 4, error: "KeyError('Grapple Beam')" }),
        { ok: false, reason: 'failed', slot: 'DaveSMetroid' });
    assert.deepStrictEqual(fromLogic(undefined), { ok: false, reason: 'failed', slot: 'DaveSMetroid' },
        'a reply missing from the batch');
});

test('no logic answer carries an item, even when the worker\'s reason names one', () => {
    const out = fromLogic({
        slot: 4,
        verified: false,
        reason: "evaluation failed: KeyError('Progressive Sword')",
        locations: [[82001, 1]],
        open: 2
    });
    assert.ok(!JSON.stringify(out).includes('Progressive Sword'));
});

// --- asking the worker about every slot at once ------------------------------------------------
//
// One request covers every slot asked about. The tracker keys its rows "team:slot" and lists each
// received item as [item, location, finder, flags]; the worker wants a slot number and
// [item, location, flags]. The flags are what generation classified that copy as, which is not
// always what its name says, and the worker needs them to rebuild the item as it was. The location
// is what tells a found item from one the server handed out (/send, !getitem), which arrives at a
// negative location with flags 0 whatever the item is.

/**
 * A prepared read with a logic worker in it, the way prepareSuggest returns one when the seed's
 * logic loaded. `reply` answers one query; `asked` keeps every batch the worker was sent.
 */
function logicPrep(checked, received, reply, over) {
    const p = prep(checked, over);
    const asked = [];
    p.logic = { ok: true };
    p.spheres = null;
    p.receivedItems = new Map(Object.entries(received || {}));
    p.worker = {
        inLogic: async (queries) => {
            asked.push(queries);
            return queries.map(q => (reply ? reply(q) : { slot: q.slot, verified: true, locations: [], open: 1 }));
        }
    };
    p.asked = asked;
    return p;
}

test('the worker is asked with the slot number, received items as [item, location, flags], and checked ids', async () => {
    const p = logicPrep(
        { '0:4': [82000, 82001] },
        { '0:4': [[77001, 91000, 28, 1], [77002, 82000, 4, 0]] });
    await monitor.answerAll(p, ['DaveSMetroid']);
    assert.deepStrictEqual(p.asked,
        [[{ slot: 4, received: [[77001, 91000, 1], [77002, 82000, 0]], checked: [82000, 82001] }]]);
});

test('an item the server handed out reaches the worker with its negative location intact', async () => {
    // Its flags say 0 whatever the item is. Without the location beside them, a progression item
    // given by /send would be rebuilt as filler and everything it unlocks left out of logic.
    const p = logicPrep({}, { '0:4': [[77003, -1, 0, 0], [77004, -2, 0, 0]] });
    await monitor.answerAll(p, ['DaveSMetroid']);
    assert.deepStrictEqual(p.asked[0][0].received, [[77003, -1, 0], [77004, -2, 0]]);
});

test('the worker is asked about the client\'s team, never another team\'s row or a bare slot number', async () => {
    // Two teams in one room number their slots the same way, so either wrong row is another
    // player's progress, answered without complaint.
    const p = logicPrep(
        { '1:4': [82000], '0:4': [82001, 82002], 4: [82003] },
        { '1:4': [[77001, 91000, 28, 1]], '0:4': [[66001, 1, 1, 1]], 4: [[55001, 1, 1, 1]] });
    p.client.team = 1;
    await monitor.answerAll(p, ['DaveSMetroid']);
    assert.deepStrictEqual(p.asked, [[{ slot: 4, received: [[77001, 91000, 1]], checked: [82000] }]]);
});

test('a slot with no tracker row is asked about with nothing received and nothing checked', async () => {
    const p = logicPrep({}, {});
    await monitor.answerAll(p, ['ZackWord']);
    assert.deepStrictEqual(p.asked, [[{ slot: 28, received: [], checked: [] }]]);
});

test('finished and unknown slots are answered without being sent to the worker', async () => {
    // A finished slot has nothing worth asking about, and a name the room does not have has no
    // number to ask with.
    const p = logicPrep({}, {}, null, { finished: { 28: 'goaled' } });
    const out = await monitor.answerAll(p, ['ZackWord', 'NotARealSlot', 'DaveSMetroid']);
    assert.deepStrictEqual(p.asked, [[{ slot: 4, received: [], checked: [] }]]);
    assert.deepStrictEqual(out.results[0], { ok: false, reason: 'finished', slot: 'ZackWord', how: 'goaled' });
    assert.deepStrictEqual(out.results[1], { ok: false, reason: 'unknown-slot', slot: 'NotARealSlot' });
    assert.strictEqual(out.results[2].mode, 'logic');
});

test('answers come back in the order the slots were asked for, each with its own locations', async () => {
    // suggestNext reads results[0] as the answer for the one slot it asked about.
    const replies = {
        4: { verified: true, locations: [[82002, 2]], open: 2 },
        28: { verified: true, locations: [[91000, 1]], open: 2 }
    };
    const p = logicPrep({}, {}, q => ({ slot: q.slot, ...replies[q.slot] }));
    const out = await monitor.answerAll(p, ['ZackWord', 'DaveSMetroid']);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.logic, p.logic);
    assert.deepStrictEqual(out.results.map(r => [r.slot, r.locations]),
        [['ZackWord', ['Used A']], ['DaveSMetroid', ['Ridley']]]);
    assert.strictEqual(p.asked.length, 1, 'one request for every slot');
});

test('no answer from the logic path carries what a slot received', async () => {
    // The worker is told what each slot has received, which its player already knows. None of it
    // comes back: an answer is locations and counts.
    const p = logicPrep({}, { '0:4': [[77001, 91000, 28, 1]], '0:28': [[77002, 82000, 4, 1]] });
    const serialised = JSON.stringify(await monitor.answerAll(p, ['DaveSMetroid', 'ZackWord']));
    for (const item of ['77001', '77002']) {
        assert.ok(!serialised.includes(item), `received item ${item} leaked into an answer`);
    }
});

test('with no worker every slot is answered from sphere 1, carrying why the logic was unavailable', async () => {
    // The reply shows `why` beside its sphere 1 note, which is what tells "not set up" from "broken".
    // It is the reason code, never the detail: a detail can be a path on the bot's machine.
    const p = prep({ '0:4': [82000] });
    p.logic = { ok: false, reason: 'no-install', detail: 'no Archipelago install is set' };
    const out = await monitor.answerAll(p, ['DaveSMetroid']);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.logic, p.logic);
    assert.strictEqual(out.results[0].mode, 'sphere1');
    assert.deepStrictEqual(out.results[0].locations, ['X-Ray Scope']);
    assert.strictEqual(out.results[0].why, 'no-install');
    assert.ok(!JSON.stringify(out.results).includes(p.logic.detail));
});

test('a worker that fails mid-question falls back to sphere 1 from the sphere data on disk', async () => {
    // prepareSuggest found the worker ready, then waited seconds on the tracker; it can die or
    // stall in that gap. No sphere data was loaded then, since the logic was going to answer, so
    // the fallback has to fetch its own.
    const s = sphereScratch();
    const warned = [];
    const real = console.warn;
    try {
        s.table(TABLE_V1);
        const p = logicPrep({ '0:4': [82000] }, {});
        p.state = s.state;
        p.seed = 'SEED';
        p.worker = { inLogic: async () => { throw new Error('no answer after 120 s'); } };

        console.warn = (...args) => warned.push(args.join(' '));
        const out = await monitor.answerAll(p, ['DaveSMetroid', 'NotARealSlot'], s.dirs);
        console.warn = real;

        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.logic, { ok: false, reason: 'failed', detail: 'no answer after 120 s' });
        const [dave, unknown] = out.results;
        assert.strictEqual(dave.mode, 'sphere1');
        assert.strictEqual(dave.source, 'multidata');
        assert.deepStrictEqual(dave.locations, ['X-Ray Scope']);
        assert.strictEqual(dave.why, 'failed');
        assert.strictEqual(unknown.reason, 'unknown-slot');
        assert.ok(warned.some(l => /logic worker could not answer: no answer after 120 s/.test(l)));
    } finally {
        console.warn = real;
        s.done();
    }
});

test('a worker failure with no sphere data either asks for it, carrying why the logic failed', async () => {
    // The reply leads with that reason. Without it, it would ask for a sphere file with no word
    // on why the seed's own logic was not enough.
    const s = sphereScratch();
    const real = console.warn;
    try {
        const p = logicPrep({}, {});
        p.state = s.state;
        p.seed = 'SEED';
        p.worker = { inLogic: async () => { throw new Error('logic worker stopped: exited with code 1'); } };

        console.warn = () => {};
        const out = await monitor.answerAll(p, ['DaveSMetroid'], s.dirs);
        console.warn = real;

        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.reason, 'need-spheres');
        assert.match(out.want, /SEED\.json$/);
        assert.match(out.fallback, /SEED\.txt$/);
        assert.deepStrictEqual(out.logic,
            { ok: false, reason: 'failed', detail: 'logic worker stopped: exited with code 1' });
    } finally {
        console.warn = real;
        s.done();
    }
});

test('slots settled without the worker are still answered when the worker cannot be reached', async () => {
    // Every slot here is answered by resolveSlot alone, so a dead worker has nothing to spoil.
    // Asking it an empty question anyway turns "finished" into a demand for sphere data.
    const s = sphereScratch();
    const real = console.warn;
    try {
        const p = logicPrep({}, {}, null, { finished: { 28: 'goaled' } });
        p.state = s.state;
        p.seed = 'SEED';
        let asked = 0;
        p.worker = { inLogic: async () => { asked += 1; throw new Error('the logic worker is not ready'); } };

        console.warn = () => {};
        const out = await monitor.answerAll(p, ['ZackWord', 'NotARealSlot'], s.dirs);
        console.warn = real;

        assert.strictEqual(out.reason, undefined, 'answered, not refused');
        assert.deepStrictEqual(out.results.map(r => r.reason), ['finished', 'unknown-slot']);
        assert.strictEqual(asked, 0, 'nothing to ask');
    } finally {
        console.warn = real;
        s.done();
    }
});

test('a prep settled without the logic is answered slot by slot from the connection alone', async () => {
    // prepareSuggest settles a question whose slots are all finished or unknown before it starts
    // the worker, reads sphere data or fetches the tracker, since a minute's rebuild to be told
    // "finished" is a minute for nothing. A worker left on the prep must not be asked either.
    const p = prep({}, { finished: { 4: 'released', 28: 'goaled' } });
    let asked = 0;
    p.worker = { inLogic: async () => { asked += 1; return []; } };
    p.spheres = null;
    p.state.spheres = null;
    p.logic = null;
    p.settled = true;

    const names = ['ZackWord', 'NotARealSlot', 'DaveSMetroid'];
    const out = await monitor.answerAll(p, names);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.logic, null);
    assert.deepStrictEqual(out.results, names.map(n => monitor.resolveSlot(p.client, n)));
    assert.deepStrictEqual(out.results.map(r => r.reason), ['finished', 'unknown-slot', 'finished']);
    assert.strictEqual(asked, 0);
});

test('a worker answer carrying an error is logged with it and answers failed', async () => {
    // The error goes to the log, where somebody can act on it, and nowhere near the reply: it is
    // the repr of a Python exception, and this one names an item. The other slot is unaffected.
    const warned = [];
    const real = console.warn;
    try {
        const p = logicPrep({}, {}, q => (q.slot === 4
            ? { slot: 4, error: "KeyError('Grapple Beam')" }
            : { slot: q.slot, verified: true, locations: [[91000, 1]], open: 2 }));

        console.warn = (...args) => warned.push(args.join(' '));
        const out = await monitor.answerAll(p, ['DaveSMetroid', 'ZackWord']);
        console.warn = real;

        assert.deepStrictEqual(out.results[0], { ok: false, reason: 'failed', slot: 'DaveSMetroid' });
        assert.deepStrictEqual(out.results[1].locations, ['Used A']);
        assert.ok(!JSON.stringify(out.results).includes('Grapple Beam'));
        assert.ok(warned.some(l => /logic worker could not answer for DaveSMetroid: KeyError\('Grapple Beam'\)/.test(l)),
            warned.join('\n'));
        assert.ok(!warned.some(l => /could not answer for ZackWord/.test(l)), 'the slot that answered is not logged');
    } finally {
        console.warn = real;
    }
});

test('a slot missing from the worker\'s batch is logged and answers failed', async () => {
    // A short batch is a worker bug. Answering it silently would leave nothing to find it by.
    const warned = [];
    const real = console.warn;
    try {
        const p = logicPrep({}, {});
        p.worker = { inLogic: async () => [] };

        console.warn = (...args) => warned.push(args.join(' '));
        const out = await monitor.answerAll(p, ['DaveSMetroid']);
        console.warn = real;

        assert.deepStrictEqual(out.results[0], { ok: false, reason: 'failed', slot: 'DaveSMetroid' });
        assert.ok(warned.some(l => /logic worker could not answer for DaveSMetroid: no answer/.test(l)), warned.join('\n'));
    } finally {
        console.warn = real;
    }
});

// --- ordering slots by the earliest sphere with something in logic -----------------------------

const answer = (slot, sphere) => ({ ok: true, slot, mode: 'logic', sphere, total: 1, open: 3, locations: ['x'] });
const nothingListed = (slot) => ({ ok: true, slot, mode: 'logic', sphere: null, total: 0, open: 9, locations: [] });

test('slots are ordered by the earliest sphere they have something in logic in', () => {
    const out = monitor.orderBySoonest([answer('C', 4), answer('A', 1), answer('B', 2)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['A', 'B', 'C']);
});

test('a slot with nothing in logic yet comes after every slot with something to do', () => {
    // Even one whose earliest is sphere 17: sphere 17 in logic is still somewhere to go.
    const out = monitor.orderBySoonest([nothingListed('Aardvark'), answer('Zebra', 17)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['Zebra', 'Aardvark']);
});

test('a slot listing locations of no known sphere goes after every known sphere, before a slot listing none', () => {
    // It still has somewhere to go, which outranks having nowhere.
    const out = monitor.orderBySoonest([nothingListed('Abe'), answer('Beth', null), answer('Zed', 40)]);
    assert.deepStrictEqual(out.map(r => r.slot), ['Zed', 'Beth', 'Abe']);
});

test('slots with no answer at all come last', () => {
    const out = monitor.orderBySoonest([
        { ok: false, slot: 'A', reason: 'nothing-left' },
        { ok: false, slot: 'B', reason: 'unknown-slot' },
        nothingListed('C'),
        answer('D', 9),
        { ok: false, slot: 'AA', reason: 'finished', how: 'goaled' }
    ]);
    assert.deepStrictEqual(out.map(r => r.slot), ['D', 'C', 'A', 'AA', 'B']);
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

test('real suggestFor answers put a slot with sphere 1 open ahead of one that has cleared it', () => {
    // DaveSMetroid has cleared sphere 1 with deeper locations still open; ZackWord has checked
    // nothing. Asked Dave first, ZackWord comes out first.
    const p = multidataPrep({ '0:4': [82000, 82001, 82003] });
    const results = ['DaveSMetroid', 'ZackWord'].map(s => monitor.suggestFor(p, s));
    assert.deepStrictEqual(results.map(r => r.sphere), [null, 1]);
    assert.deepStrictEqual(monitor.orderBySoonest(results).map(r => r.slot), ['ZackWord', 'DaveSMetroid']);
});

test('a logic answer and a sphere 1 answer order by sphere, not by where they came from', () => {
    // DaveSMetroid is answered from the seed's rules with only sphere 2 open; ZackWord fell back
    // to sphere 1. Asked Dave first, ZackWord comes out first.
    const p = multidataPrep({});
    const dave = fromLogic({ slot: 4, verified: true, locations: [[82002, 2]], open: 4 }, 'DaveSMetroid', p.client);
    const word = monitor.suggestFor(p, 'ZackWord');
    assert.deepStrictEqual([dave.mode, word.mode], ['logic', 'sphere1']);
    assert.deepStrictEqual(monitor.orderBySoonest([dave, word]).map(r => r.slot), ['ZackWord', 'DaveSMetroid']);
});
