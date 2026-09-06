// Hint reading, the silent baseline, and the per-claim opt-in.
//
// The shapes here come from a live 29-slot room: 2,031 hint entries collapsing to 1,043 unique,
// of which 45 were outstanding and 20 of those sat against a single slot. That concentration is
// what the baseline exists to absorb.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

const SUFFIX = process.pid + '_' + Math.random().toString(36).slice(2, 8);
process.env.PLEXBOT_AP_HINTS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-hints-' + SUFFIX + '.json');
process.env.PLEXBOT_AP_CLAIMS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-hintclaims-' + SUFFIX + '.json');

const fs = require('fs');
const hints = require('../helpers/archipelagoHints.js');
const claims = require('../helpers/archipelagoClaims.js');
const { ArchipelagoClient } = require('../helpers/archipelagoClient.js');

test.afterEach(() => {
    for (const f of [process.env.PLEXBOT_AP_HINTS_FILE, process.env.PLEXBOT_AP_CLAIMS_FILE]) {
        try { fs.rmSync(f, { force: true }); } catch (_) {}
    }
    hints.reset();
    claims.reset();
});

function hint(over) {
    return Object.assign({
        receiving_player: 1, finding_player: 8, location: 2009128,
        item: 5, found: false, entrance: '', item_flags: 0, status: 0
    }, over || {});
}

function makeClient() {
    return new ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 's' });
}

// --- the client reading them --------------------------------------------------------------

test('a hint stored under both slots is counted once', () => {
    const c = makeClient();
    c.team = 0;
    c.slotNames.set('0:1', 'Argus');
    c.slotNames.set('0:8', 'Alice');

    // The server keeps each hint under the finder AND the receiver, so reading every slot
    // returns roughly two entries per hint.
    c._absorbHints({ '_read_hints_0_8': [hint()], '_read_hints_0_1': [hint()] });
    assert.strictEqual(c.hints.size, 1, 'keyed on finder and location, so the pair collapses');
    assert.strictEqual(c.outstandingHints().length, 1);
    c.stop();
});

test('a found hint is history, not something anyone is waiting on', () => {
    const c = makeClient();
    c.team = 0;
    c.slotNames.set('0:8', 'Alice');
    c._absorbHints({ '_read_hints_0_8': [hint({ found: true, status: 40 }), hint({ location: 99 })] });
    assert.strictEqual(c.hints.size, 2);
    assert.strictEqual(c.outstandingHints().length, 1);
    assert.strictEqual(c.hintsToFindIn(8).length, 1);
    assert.strictEqual(c.hintsAwaitedBy(1).length, 1);
    c.stop();
});

test('a null key says nothing, unlike a slot answering with no hints', () => {
    const c = makeClient();
    c.team = 0;
    c._absorbHints({ '_read_hints_0_4': null, '_read_hints_0_5': [] });
    assert.strictEqual(c.hints.size, 0);
    c.stop();
});

test('a reconnect to a different room does not keep the old room hints', () => {
    const c = makeClient();
    c.team = 0;
    c.slotNames.set('0:8', 'Alice');
    c._absorbHints({ '_read_hints_0_8': [hint()] });
    assert.strictEqual(c.hints.size, 1);

    c._handleConnected({ team: 0, slot: 28, players: [], slot_info: {} });
    assert.strictEqual(c.hints.size, 0, 'cleared on connect, like the slot maps');
    c.stop();
});

test('hints are requested for every slot on this team only', () => {
    const c = makeClient();
    c.team = 0;
    c.slotNames.set('0:1', 'Argus');
    c.slotNames.set('0:8', 'Alice');
    c.slotNames.set('1:8', 'OtherTeam');
    assert.deepStrictEqual(c._hintKeys().sort(), ['_read_hints_0_1', '_read_hints_0_8']);
    c.stop();
});

// --- the baseline ---------------------------------------------------------------------------

test('the first read of a room is recorded without announcing anything', () => {
    const seed = 'Wordipelago_42';
    const backlog = Array.from({ length: 20 }, (_, i) => hints.hintKey(seed, 0, 23, 1000 + i));

    assert.strictEqual(hints.isSeeded(seed), false);
    assert.strictEqual(hints.seedBaseline(seed, backlog), true);
    assert.strictEqual(hints.isSeeded(seed), true);

    // Twenty hints against one slot is what the live room actually held. None are news.
    assert.deepStrictEqual(hints.recordAll(backlog), []);
});

test('a hint placed after the baseline is news exactly once', () => {
    const seed = 'Wordipelago_42';
    hints.seedBaseline(seed, [hints.hintKey(seed, 0, 23, 1)]);

    const fresh = hints.hintKey(seed, 0, 23, 2);
    assert.deepStrictEqual(hints.recordAll([fresh]), [fresh]);
    // Every reconnect replays the whole list; the second offer must be silent.
    assert.deepStrictEqual(hints.recordAll([fresh]), []);
});

test('the marker is explicit, so a room with no hints yet does not swallow its first one', () => {
    const seed = 'Empty_Room';
    assert.strictEqual(hints.seedBaseline(seed, []), true);
    assert.strictEqual(hints.isSeeded(seed), true);

    const first = hints.hintKey(seed, 0, 3, 77);
    assert.deepStrictEqual(hints.recordAll([first]), [first], 'the first real hint is still news');
});

test('hints from different multiworlds cannot collide', () => {
    const a = hints.hintKey('SeedA', 0, 23, 500);
    const b = hints.hintKey('SeedB', 0, 23, 500);
    assert.notStrictEqual(a, b);
    hints.seedBaseline('SeedA', [a]);
    assert.deepStrictEqual(hints.recordAll([b]), [b], 'same slot and location, different room');
});

test('teams do not collide either', () => {
    assert.notStrictEqual(hints.hintKey('S', 0, 5, 1), hints.hintKey('S', 1, 5, 1));
});

test('forgetSeed drops one room and leaves the others', () => {
    hints.seedBaseline('SeedA', [hints.hintKey('SeedA', 0, 1, 1)]);
    hints.seedBaseline('SeedB', [hints.hintKey('SeedB', 0, 1, 1)]);
    const before = hints.count();
    assert.ok(hints.forgetSeed('SeedA') >= 2, 'the keys and the marker');
    assert.strictEqual(hints.isSeeded('SeedA'), false);
    assert.strictEqual(hints.isSeeded('SeedB'), true);
    assert.ok(hints.count() < before);
});

// --- the opt-in -----------------------------------------------------------------------------

test('a new claim is not opted in to hint pings', () => {
    const entry = claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' });
    assert.strictEqual(entry.hintPings, 'off');
    assert.strictEqual(claims.hintPingMode(entry), 'off');
});

test('a claim written before the setting existed reads as off, not undefined', () => {
    assert.strictEqual(claims.hintPingMode({ watchId: 1, slot: 'x', userId: 'u1' }), 'off');
    assert.strictEqual(claims.hintPingMode({ hintPings: 'nonsense' }), 'off');
    assert.strictEqual(claims.hintPingMode(null), 'off');
});

test('hint pings are set separately from item pings', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1', pings: 'all' });
    const updated = claims.setHintPings(1, 'zackword', 'dm');

    assert.strictEqual(updated.hintPings, 'dm');
    assert.strictEqual(updated.pings, 'all', 'the item setting is untouched');
    assert.throws(() => claims.setHintPings(1, 'ZackWord', 'sometimes'), /must be one of/);
});

test('re-claiming a slot you already hold keeps your hint setting', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' });
    claims.setHintPings(1, 'ZackWord', 'channel');
    const again = claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' });
    assert.strictEqual(again.hintPings, 'channel');
});

test('a slot changing hands does not inherit the previous holder choice', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' });
    claims.setHintPings(1, 'ZackWord', 'channel');
    const taken = claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u2' });
    assert.strictEqual(taken.hintPings, 'off', 'the new holder starts off, like anyone else');
});
