// Reading spheres out of a spoiler log, and working out what a slot has open earliest.
//
// The fixture matches what Archipelago's Spoiler.to_file actually writes:
//
//   outfile.write('\n\nPlaythrough:\n\n')
//   '%s: {\n%s\n}' % (sphere_nr, '\n'.join(f"  {location}: {item}" ...))
//
// where a multiworld location and item each stringify as `Name (PlayerName)`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');

const spheres = require('../helpers/archipelagoSpheres.js');

const SPOILER = [
    'Archipelago Version 0.6.1  Seed: 86813421789565399455',
    '',
    'Playthrough:',
    '',
    '1: {',
    '  Morphing Ball (DaveSMetroid): Progressive Sword (Argus)',
    '  Energy Tank, Brinstar Ceiling (DaveSMetroid): Ocarina C Up Button (PK)',
    '  Used A (ZackWord): Money (DaveRoR2)',
    '}',
    '2: {',
    '  Varia Suit (DaveSMetroid): Lifesaver (MarysPop)',
    '  1 Correct Letter In Word (ZackWord): Ice Trap (PK)',
    '}',
    '3: {',
    '  Missile (Draygon) (DaveSMetroid): Lum Berry (Hilda)',
    '}',
    ''
].join('\n');

// --- parsing --------------------------------------------------------------------------------

test('the Playthrough section is read into sphere, finder and location', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    assert.strictEqual(rows.length, 6);
    assert.deepStrictEqual(rows[0], { sphere: 1, finder: 'DaveSMetroid', location: 'Morphing Ball' });
    assert.deepStrictEqual(rows[2], { sphere: 1, finder: 'ZackWord', location: 'Used A' });
    assert.deepStrictEqual(rows[3], { sphere: 2, finder: 'DaveSMetroid', location: 'Varia Suit' });
});

test('the item and receiver are never carried out of the parser', () => {
    // The whole point of the feature is that it says where to go, not what is there.
    for (const row of spheres.parsePlaythrough(SPOILER)) {
        assert.deepStrictEqual(Object.keys(row).sort(), ['finder', 'location', 'sphere']);
        const serialised = JSON.stringify(row);
        for (const item of ['Progressive Sword', 'Ocarina C Up Button', 'Money', 'Lifesaver', 'Ice Trap']) {
            assert.ok(!serialised.includes(item), `${item} must not survive parsing`);
        }
    }
});

test('a location whose own name has brackets is still read correctly', () => {
    // "Missile (Draygon)" is a real Super Metroid location, and taking the last bracketed run on
    // the line would have made the finder "Draygon".
    const row = spheres.parsePlaythrough(SPOILER).find(r => r.sphere === 3);
    assert.strictEqual(row.location, 'Missile (Draygon)');
    assert.strictEqual(row.finder, 'DaveSMetroid');
});

test('a file with no Playthrough section yields nothing rather than throwing', () => {
    assert.deepStrictEqual(spheres.parsePlaythrough('Archipelago Version 0.6.1\n\nLocations:\n  x: y'), []);
    assert.deepStrictEqual(spheres.parsePlaythrough(''), []);
    assert.deepStrictEqual(spheres.parsePlaythrough(null), []);
});

test('lines outside a sphere block are ignored', () => {
    const noisy = [
        'Playthrough:',
        '',
        '  Stray Location (Someone): Item (Other)',
        '1: {',
        '  Real Location (Someone): Item (Other)',
        '}',
        '  Trailing Junk (Someone): Item (Other)'
    ].join('\n');
    const rows = spheres.parsePlaythrough(noisy);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].location, 'Real Location');
});

// --- choosing what to suggest ----------------------------------------------------------------

test('the soonest reachable sphere is the answer, not the earliest unchecked one', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    // Checked the Morphing Ball in sphere 1, so sphere 1 is proven reachable and nothing beyond.
    const next = spheres.soonestInLogic(rows, new Set(['Morphing Ball']), 'DaveSMetroid');
    assert.strictEqual(next.sphere, 1);
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling']);
    assert.strictEqual(next.reach, 1);
    assert.strictEqual(next.remaining, 1, 'only what is within reach counts');
    assert.strictEqual(next.beyond, 2, 'the sphere 2 and 3 locations are held back');
});

test('a sphere the slot has not proven it can enter is never suggested', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    // Everything in sphere 1 done, nothing in 2 or 3. Sphere 2 needs items from elsewhere, so
    // pointing at it would be pointing at a door they cannot open.
    const next = spheres.soonestInLogic(
        rows, new Set(['Morphing Ball', 'Energy Tank, Brinstar Ceiling']), 'DaveSMetroid');
    assert.strictEqual(next.sphere, null, 'nothing reachable is not the same as nothing left');
    assert.strictEqual(next.beyond, 2);
    assert.strictEqual(next.reach, 1);
});

test('checking something deeper raises the reach and opens what was skipped', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    // Varia Suit is sphere 2, so sphere 2 is proven; the sphere 1 Energy Tank is now offered.
    const next = spheres.soonestInLogic(rows, new Set(['Morphing Ball', 'Varia Suit']), 'DaveSMetroid');
    assert.strictEqual(next.reach, 2);
    assert.strictEqual(next.sphere, 1);
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling']);
    assert.strictEqual(next.beyond, 1, 'the sphere 3 Missile is still out of reach');
});

test('a slot that has checked nothing gets sphere 1, which needs nothing', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.soonestInLogic(rows, new Set(), 'DaveSMetroid');
    assert.strictEqual(next.reach, 1);
    assert.strictEqual(next.sphere, 1);
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling', 'Morphing Ball']);
});

test('matching a checked location ignores case and stray spacing', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.soonestInLogic(rows, new Set(['  morphing BALL  ']), 'DaveSMetroid');
    assert.ok(!next.locations.includes('Morphing Ball'));
});

test('a slot with everything checked answers null, not an empty sphere', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const done = new Set(['Morphing Ball', 'Energy Tank, Brinstar Ceiling', 'Varia Suit', 'Missile (Draygon)']);
    assert.strictEqual(spheres.soonestInLogic(rows, done, 'DaveSMetroid'), null);
});

test('a slot nobody has heard of answers null', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    assert.strictEqual(spheres.soonestInLogic(rows, new Set(), 'NotARealSlot'), null);
    assert.strictEqual(spheres.soonestInLogic(rows, new Set(), ''), null);
});

test('one slot is never answered with another slot locations', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.soonestInLogic(rows, new Set(), 'ZackWord');
    assert.deepStrictEqual(next.locations, ['Used A']);
    assert.strictEqual(next.sphere, 1);
});

// --- finding the file ------------------------------------------------------------------------

test('the spoiler is looked for under a filename-safe form of the seed', () => {
    const p = spheres.spoilerPath('/spoilers', '86813421789565399455');
    assert.strictEqual(pathMod.basename(p), '86813421789565399455.txt');
    // A seed carrying path separators must not be able to point the read somewhere else.
    assert.strictEqual(pathMod.basename(spheres.spoilerPath('/spoilers', '../../etc/passwd')), '.._.._etc_passwd.txt');
});

test('loadSpheres reads a supplied spoiler and reports where it came from', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-spoilers-'));
    try {
        fs.writeFileSync(pathMod.join(dir, 'SEED123.txt'), SPOILER, 'utf8');
        const loaded = await spheres.loadSpheres({ seed: 'SEED123', spoilerDir: dir });
        assert.strictEqual(loaded.source, 'spoiler');
        assert.strictEqual(loaded.rows.length, 6);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadSpheres answers null when there is no spoiler to read', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-spoilers-'));
    try {
        assert.strictEqual(await spheres.loadSpheres({ seed: 'MISSING', spoilerDir: dir }), null);
        // A file that exists but holds something else is the same answer, not a crash.
        fs.writeFileSync(pathMod.join(dir, 'EMPTY.txt'), 'no playthrough in here', 'utf8');
        assert.strictEqual(await spheres.loadSpheres({ seed: 'EMPTY', spoilerDir: dir }), null);
        assert.strictEqual(await spheres.loadSpheres({ seed: '', spoilerDir: dir }), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- the multidata sphere table ----------------------------------------------------------------
//
// The good source. Generation writes a `spheres` field into the .archipelago multidata covering
// EVERY location, and scripts/extract-spheres.py reshapes it to {slot: {sphere: [location ids]}}.
// It is keyed by location id, which is what the room's tracker reports, so no name matching is
// involved at all.
//
// The numbers in these tests are the shape of the real thing: on the room this was built against
// the table held 14,783 locations against the spoiler Playthrough's 1,728.

const TABLE = { 1: [100, 101, 102], 2: [200, 201], 3: [300] };

test('the soonest reachable sphere is found by location id', () => {
    const next = spheres.soonestFromTable(TABLE, new Set([100]));
    assert.strictEqual(next.sphere, 1);
    assert.deepStrictEqual(next.locations, [101, 102]);
    assert.strictEqual(next.reach, 1);
    assert.strictEqual(next.beyond, 3, 'spheres 2 and 3 are held back');
});

test('a sphere the slot has proven it can enter opens what was skipped', () => {
    const next = spheres.soonestFromTable(TABLE, new Set([100, 200]));
    assert.strictEqual(next.reach, 2);
    assert.strictEqual(next.sphere, 1);
    assert.deepStrictEqual(next.locations, [101, 102]);
    assert.strictEqual(next.remaining, 3, '101, 102 and 201');
    assert.strictEqual(next.beyond, 1);
});

test('ids are returned in numeric order, not as strings', () => {
    // "1000" sorts before "99" as a string, which would put the list in a nonsense order.
    const next = spheres.soonestFromTable({ 1: [99, 1000, 300] }, new Set());
    assert.deepStrictEqual(next.locations, [99, 300, 1000]);
});

test('a slot with every location checked answers null', () => {
    assert.strictEqual(spheres.soonestFromTable(TABLE, new Set([100, 101, 102, 200, 201, 300])), null);
});

test('a missing or empty table answers null rather than throwing', () => {
    assert.strictEqual(spheres.soonestFromTable(null, new Set()), null);
    assert.strictEqual(spheres.soonestFromTable(undefined, new Set([1])), null);
    assert.strictEqual(spheres.soonestFromTable({}, new Set()), null);
});

test('checked ids match whether they arrive as numbers or strings', () => {
    // The tracker answers in numbers and a hand-edited file could hold either.
    const next = spheres.soonestFromTable(TABLE, new Set(['100']));
    assert.deepStrictEqual(next.locations, [101, 102]);
});

test('the table is read from a filename-safe form of the seed', () => {
    assert.strictEqual(pathMod.basename(spheres.spherePath('/spheres', 'SEED123')), 'SEED123.json');
    assert.strictEqual(pathMod.basename(spheres.spherePath('/spheres', '../../etc/passwd')), '.._.._etc_passwd.json');
});

test('the multidata table is preferred over a spoiler sitting beside it', async () => {
    // Not a tie-break: one covers every location and the other covers about a tenth. A spoiler
    // left in place after extracting the table must not quietly win.
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-both-'));
    try {
        fs.writeFileSync(pathMod.join(dir, 'SEED.txt'), SPOILER, 'utf8');
        fs.writeFileSync(pathMod.join(dir, 'SEED.json'),
            JSON.stringify({ seed: 'SEED', slots: { 4: TABLE } }), 'utf8');

        const loaded = await spheres.loadSpheres({ seed: 'SEED', spoilerDir: dir, sphereDir: dir });
        assert.strictEqual(loaded.source, 'multidata');
        assert.ok(loaded.slots['4'], 'the table came through keyed by slot');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a spoiler is still used when no table has been extracted', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-fallback-'));
    try {
        fs.writeFileSync(pathMod.join(dir, 'SEED.txt'), SPOILER, 'utf8');
        const loaded = await spheres.loadSpheres({ seed: 'SEED', spoilerDir: dir, sphereDir: dir });
        assert.strictEqual(loaded.source, 'spoiler');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a table written wrong falls through to the spoiler rather than emptying the room', async () => {
    // A slotless table would otherwise answer "nothing left" for every slot in the multiworld,
    // which reads as everybody being finished.
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-broken-'));
    try {
        fs.writeFileSync(pathMod.join(dir, 'SEED.txt'), SPOILER, 'utf8');
        fs.writeFileSync(pathMod.join(dir, 'SEED.json'), JSON.stringify({ seed: 'SEED', slots: {} }), 'utf8');
        assert.strictEqual((await spheres.loadSpheres({ seed: 'SEED', spoilerDir: dir, sphereDir: dir })).source, 'spoiler');

        fs.writeFileSync(pathMod.join(dir, 'SEED.json'), 'not json at all', 'utf8');
        assert.strictEqual((await spheres.loadSpheres({ seed: 'SEED', spoilerDir: dir, sphereDir: dir })).source, 'spoiler');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('neither source present is still null, not a throw', async () => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-neither-'));
    try {
        assert.strictEqual(await spheres.loadSpheres({ seed: 'MISSING', spoilerDir: dir, sphereDir: dir }), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- noticing that the files on disk changed --------------------------------------------------
//
// Sphere data used to be loaded once per seed and held for the life of the watch, so the order
// files arrived in mattered: a spoiler loaded first kept answering after a far better table was
// extracted beside it, until a restart. The fingerprint is what a holder compares to notice.

function fingerprintDir() {
    return fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-fingerprint-'));
}

test('a fingerprint is stable while nothing on disk changes', async () => {
    const dir = fingerprintDir();
    try {
        fs.writeFileSync(pathMod.join(dir, 'SEED.txt'), SPOILER, 'utf8');
        const dirs = { seed: 'SEED', sphereDir: dir, spoilerDir: dir };
        assert.strictEqual(await spheres.sourceFingerprint(dirs), await spheres.sourceFingerprint(dirs));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a table appearing beside a spoiler changes the fingerprint', async () => {
    // The case that needed a restart before.
    const dir = fingerprintDir();
    try {
        const dirs = { seed: 'SEED', sphereDir: dir, spoilerDir: dir };
        fs.writeFileSync(pathMod.join(dir, 'SEED.txt'), SPOILER, 'utf8');
        const before = await spheres.sourceFingerprint(dirs);
        fs.writeFileSync(pathMod.join(dir, 'SEED.json'), JSON.stringify({ seed: 'SEED', slots: { 4: TABLE } }), 'utf8');
        assert.notStrictEqual(await spheres.sourceFingerprint(dirs), before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a table rewritten at the same size still changes the fingerprint', async () => {
    // A re-extraction of an edited seed can land on exactly the same byte count, so size alone
    // would miss it.
    const dir = fingerprintDir();
    try {
        const file = pathMod.join(dir, 'SEED.json');
        const dirs = { seed: 'SEED', sphereDir: dir };
        fs.writeFileSync(file, '{"slots":{"1":{"1":[1]}}}', 'utf8');
        fs.utimesSync(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
        const before = await spheres.sourceFingerprint(dirs);

        fs.writeFileSync(file, '{"slots":{"1":{"1":[2]}}}', 'utf8');
        fs.utimesSync(file, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
        assert.notStrictEqual(await spheres.sourceFingerprint(dirs), before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a copy that keeps the old modification time still changes the fingerprint by size', async () => {
    // The other half: some copy tools preserve the source's timestamp, so time alone would miss it.
    const dir = fingerprintDir();
    try {
        const file = pathMod.join(dir, 'SEED.json');
        const when = new Date('2026-01-01T00:00:00Z');
        const dirs = { seed: 'SEED', sphereDir: dir };
        fs.writeFileSync(file, '{"slots":{"1":{"1":[1]}}}', 'utf8');
        fs.utimesSync(file, when, when);
        const before = await spheres.sourceFingerprint(dirs);

        fs.writeFileSync(file, '{"slots":{"1":{"1":[1,2,3]}}}', 'utf8');
        fs.utimesSync(file, when, when);
        assert.notStrictEqual(await spheres.sourceFingerprint(dirs), before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a removed file changes the fingerprint', async () => {
    const dir = fingerprintDir();
    try {
        const file = pathMod.join(dir, 'SEED.json');
        const dirs = { seed: 'SEED', sphereDir: dir };
        fs.writeFileSync(file, '{"slots":{}}', 'utf8');
        const before = await spheres.sourceFingerprint(dirs);
        fs.rmSync(file);
        assert.notStrictEqual(await spheres.sourceFingerprint(dirs), before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('another seed\'s files do not move this seed\'s fingerprint', async () => {
    // A new multiworld's table landing in the same folder must not reload an unrelated watch.
    const dir = fingerprintDir();
    try {
        const dirs = { seed: 'SEED', sphereDir: dir, spoilerDir: dir };
        fs.writeFileSync(pathMod.join(dir, 'SEED.json'), '{"slots":{"1":{"1":[1]}}}', 'utf8');
        const before = await spheres.sourceFingerprint(dirs);
        fs.writeFileSync(pathMod.join(dir, 'OTHER.json'), '{"slots":{"1":{"1":[9]}}}', 'utf8');
        assert.strictEqual(await spheres.sourceFingerprint(dirs), before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('missing folders or seed fingerprint as absent rather than throwing', async () => {
    const empty = await spheres.sourceFingerprint({ seed: 'SEED' });
    assert.strictEqual(empty, 'table:-|spoiler:-');
    assert.strictEqual(await spheres.sourceFingerprint({ seed: '', sphereDir: os.tmpdir() }), 'table:-|spoiler:-');
    assert.strictEqual(
        await spheres.sourceFingerprint({ seed: 'SEED', sphereDir: pathMod.join(os.tmpdir(), 'no-such-dir-plexbot') }),
        'table:-|spoiler:-');
});

// --- which source a fingerprint shows, and which source outranks which -------------------------

test('sourcePresent reads the half of the fingerprint belonging to that source', () => {
    // Real shape, decimal mtime and all, from the live multiworld.
    const fp = 'table:289458@1790223513858.9192|spoiler:-';
    assert.strictEqual(spheres.sourcePresent(fp, 'multidata'), true);
    assert.strictEqual(spheres.sourcePresent(fp, 'spoiler'), false);
    assert.strictEqual(spheres.sourcePresent('table:-|spoiler:12@3.5', 'spoiler'), true);
    assert.strictEqual(spheres.sourcePresent('table:-|spoiler:12@3.5', 'multidata'), false);
});

test('sourcePresent treats a missing or empty fingerprint as nothing present', () => {
    assert.strictEqual(spheres.sourcePresent(spheres.NO_SOURCES, 'multidata'), false);
    assert.strictEqual(spheres.sourcePresent(spheres.NO_SOURCES, 'spoiler'), false);
    assert.strictEqual(spheres.sourcePresent('', 'multidata'), false);
    assert.strictEqual(spheres.sourcePresent(null, 'spoiler'), false);
});

test('NO_SOURCES is exactly what sourceFingerprint answers with nothing on disk', async () => {
    assert.strictEqual(await spheres.sourceFingerprint({ seed: 'SEED' }), spheres.NO_SOURCES);
});

test('the multidata table outranks the spoiler, and both outrank nothing', () => {
    assert.ok(spheres.sourceRank('multidata') > spheres.sourceRank('spoiler'));
    assert.ok(spheres.sourceRank('spoiler') > spheres.sourceRank(undefined));
});
