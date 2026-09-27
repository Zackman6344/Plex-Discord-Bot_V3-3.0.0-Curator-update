// Reading spheres out of a spoiler log or the multidata table, and the sphere 1 fallback `!ap next`
// shows when the seed's own logic cannot be had.
//
// The fallback is what stands between a player and a list of places they cannot get into yet.
// Spheres describe the whole multiworld, so the rule it replaced ("checked something in sphere N,
// so everything up to N is open") listed 11,409 locations on the live 79-slot room that could not
// be proven in logic. Sphere 1 needs nothing, so it is the one sphere that is always in logic.
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

// --- the sphere 1 fallback, from the spoiler ---------------------------------------------------
//
// What `!ap next` shows when the seed's own logic cannot be had. `locations` is what gets listed
// and `open` is what the "M further in" count is worked out from, so both are pinned everywhere.

const DAVE_ALL = ['Morphing Ball', 'Energy Tank, Brinstar Ceiling', 'Varia Suit', 'Missile (Draygon)'];

test('only sphere 1 is listed, however much else of the slot is unchecked', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.sphereOneFromRows(rows, new Set(), 'DaveSMetroid');
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling', 'Morphing Ball']);
    assert.strictEqual(next.open, 4, 'the sphere 2 and 3 locations are counted, never listed');
});

test('open counts every unchecked location of the slot, listed or not', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.sphereOneFromRows(rows, new Set(['Morphing Ball']), 'DaveSMetroid');
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling']);
    assert.strictEqual(next.open, 3);
});

test('a slot with sphere 1 done lists nothing but still counts what is further in', () => {
    // "Nothing open in sphere 1" and "finished" read very differently to the player, and `open`
    // is the only thing that tells them apart.
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.sphereOneFromRows(
        rows, new Set(['Morphing Ball', 'Energy Tank, Brinstar Ceiling']), 'DaveSMetroid');
    assert.deepStrictEqual(next, { locations: [], open: 2 });
});

test('checking deeper never opens a sphere 2 or 3 location (regression)', () => {
    // The bug this replaced: a check in sphere N was read as "everything up to N is open". Spheres
    // are multiworld-wide, so a slot reaching one sphere 3 location says nothing about the items
    // its other sphere 2 and 3 locations wait on. Two locations per deep sphere, so a sibling of
    // the checked one would show up here if the old rule crept back in.
    const rows = [
        { sphere: 1, finder: 'DaveSMetroid', location: 'Morphing Ball' },
        { sphere: 2, finder: 'DaveSMetroid', location: 'Varia Suit' },
        { sphere: 2, finder: 'DaveSMetroid', location: 'Missile (Crateria bottom)' },
        { sphere: 3, finder: 'DaveSMetroid', location: 'Missile (Draygon)' },
        { sphere: 3, finder: 'DaveSMetroid', location: 'Space Jump' }
    ];
    const answer = checked => spheres.sphereOneFromRows(rows, new Set(checked), 'DaveSMetroid');

    assert.deepStrictEqual(answer(['Varia Suit']), { locations: ['Morphing Ball'], open: 4 });
    assert.deepStrictEqual(answer(['Missile (Draygon)']), { locations: ['Morphing Ball'], open: 4 });
    assert.deepStrictEqual(answer(['Varia Suit', 'Missile (Draygon)']), { locations: ['Morphing Ball'], open: 3 });
    assert.deepStrictEqual(answer(['Morphing Ball', 'Missile (Draygon)']), { locations: [], open: 3 },
        'sphere 1 done and a sphere 3 check still lists nothing from spheres 2 or 3');
});

test('a checked name matches ignoring case and stray spacing', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    const next = spheres.sphereOneFromRows(rows, new Set(['  morphing BALL  ']), 'DaveSMetroid');
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling']);
    assert.strictEqual(next.open, 3, 'the matched name is out of the count too, not just the list');
});

test('a slot with everything checked answers open 0, not null', () => {
    // Null means the spoiler has never heard of the slot; a finished slot is a different answer.
    const rows = spheres.parsePlaythrough(SPOILER);
    assert.deepStrictEqual(spheres.sphereOneFromRows(rows, new Set(DAVE_ALL), 'DaveSMetroid'),
        { locations: [], open: 0 });
});

test('a slot the spoiler has no row for answers null', () => {
    const rows = spheres.parsePlaythrough(SPOILER);
    assert.strictEqual(spheres.sphereOneFromRows(rows, new Set(), 'NotARealSlot'), null);
    assert.strictEqual(spheres.sphereOneFromRows(rows, new Set(), ''), null);
    assert.strictEqual(spheres.sphereOneFromRows([], new Set(), 'DaveSMetroid'), null);
    assert.strictEqual(spheres.sphereOneFromRows(null, null, 'DaveSMetroid'), null);
});

test('one slot is never answered with another slot\'s rows', () => {
    // Two copies of the same game share every location name, so the finder is all that keeps
    // one slot's list and count apart from the other's.
    const rows = [...spheres.parsePlaythrough(SPOILER),
        { sphere: 1, finder: 'ZackSMetroid', location: 'Morphing Ball' }];
    assert.deepStrictEqual(spheres.sphereOneFromRows(rows, new Set(), 'ZackWord'),
        { locations: ['Used A'], open: 2 });
    assert.deepStrictEqual(spheres.sphereOneFromRows(rows, new Set(), 'ZackSMetroid'),
        { locations: ['Morphing Ball'], open: 1 });
});

test('event rows are dropped from both the list and the open count', () => {
    // The Playthrough lists events such as boss kills beside real locations. No tracker ever
    // reports an event checked, so one left in would be suggested forever and keep a finished
    // slot looking unfinished.
    const rows = [...spheres.parsePlaythrough(SPOILER),
        { sphere: 1, finder: 'DaveSMetroid', location: 'Ridley' }];
    const real = new Set(DAVE_ALL);
    const isLocation = name => real.has(name);

    const next = spheres.sphereOneFromRows(rows, new Set(), 'DaveSMetroid', isLocation);
    assert.deepStrictEqual(next.locations, ['Energy Tank, Brinstar Ceiling', 'Morphing Ball']);
    assert.strictEqual(next.open, 4);

    assert.deepStrictEqual(spheres.sphereOneFromRows(rows, real, 'DaveSMetroid', isLocation),
        { locations: [], open: 0 }, 'a slot whose only unchecked row is an event is finished');

    // Without a data package there is nothing to tell them apart, so the event stays in.
    assert.ok(spheres.sphereOneFromRows(rows, new Set(), 'DaveSMetroid').locations.includes('Ridley'));
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

test('only sphere 1 ids are listed from the table, and open counts the rest', () => {
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set([100])),
        { locations: [101, 102], open: 5 });
});

test('checking an id deeper never opens a sphere 2 or 3 id (regression)', () => {
    // The same bug as the spoiler's: 200 checked used to list its sphere 2 sibling 201, and 300
    // checked used to list the whole of sphere 2.
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set([200])),
        { locations: [100, 101, 102], open: 5 });
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set([300])),
        { locations: [100, 101, 102], open: 5 });
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set([100, 101, 102, 300])),
        { locations: [], open: 2 }, 'sphere 1 done and a sphere 3 check still lists nothing deeper');
});

test('ids come back in numeric order, not string order', () => {
    // "1000" sorts before "99" as a string, which would put the list in a nonsense order.
    const next = spheres.sphereOneFromTable({ 1: [99, 1000, 300] }, new Set());
    assert.deepStrictEqual(next.locations, [99, 300, 1000]);
});

test('ids compare as numbers whether they arrive as numbers or strings', () => {
    // The tracker answers in numbers and a hand-edited file could hold either, on either side.
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set(['100'])),
        { locations: [101, 102], open: 5 });
    const stringy = { '1': ['1000', '99', '300'], '2': ['200'] };
    assert.deepStrictEqual(spheres.sphereOneFromTable(stringy, new Set([99])),
        { locations: [300, 1000], open: 3 }, 'string ids come back as numbers, in numeric order');
});

test('a slot with every location checked answers open 0, not null', () => {
    assert.deepStrictEqual(spheres.sphereOneFromTable(TABLE, new Set([100, 101, 102, 200, 201, 300])),
        { locations: [], open: 0 });
});

test('a missing or empty table answers null rather than throwing', () => {
    assert.strictEqual(spheres.sphereOneFromTable(null, new Set()), null);
    assert.strictEqual(spheres.sphereOneFromTable(undefined, new Set([1])), null);
    assert.strictEqual(spheres.sphereOneFromTable({}, new Set()), null);
    assert.strictEqual(spheres.sphereOneFromTable({ 1: [], 2: [] }, null), null,
        'spheres with no ids in them are no table at all');
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
