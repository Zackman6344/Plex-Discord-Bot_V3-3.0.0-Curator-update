// Slot claims: who owns which slot in which room, and which log lines are worth pinging them
// about. Storage lives in archipelagoClaims; the "is this line ping-worthy" decision lives with
// the other line filters in archipelagoMonitor.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

// Its own files, so a run can never read or rewrite the real ones.
process.env.PLEXBOT_AP_CLAIMS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-ap-claims-' + process.pid + '.json');
process.env.PLEXBOT_AP_WATCHES_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-ap-watches-' + process.pid + '.json');

const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const { ArchipelagoClient, ANSI, stripAnsi, ITEM_FLAG_PROGRESSION, ITEM_FLAG_TRAP } = require('../helpers/archipelagoClient.js');

const ZACK = '111111111111111111';
const ALICE = '222222222222222222';

function fresh() {
    try { fs.unlinkSync(claims.CLAIM_FILE); } catch (_) {}
    claims.reset();
}

test.beforeEach(fresh);
test.after(fresh);

// --- storage ------------------------------------------------------------------------------

test('a claim is found by any casing but stored as the room spells it', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });

    assert.strictEqual(claims.find(1, 'zackword').userId, ZACK);
    assert.strictEqual(claims.find(1, 'ZACKWORD').slot, 'ZackWord');
    assert.strictEqual(claims.find(1, '  zackword  ').userId, ZACK);
    // A different room with the same slot name is a different claim.
    assert.strictEqual(claims.find(2, 'ZackWord'), null);
});

test('one user holds many slots, one slot has a single holder', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    claims.claim({ watchId: 1, slot: 'ZackREPO', userId: ZACK });
    claims.claim({ watchId: 1, slot: 'Hilda', userId: ALICE });

    assert.strictEqual(claims.forUser(1, ZACK).length, 2);
    assert.strictEqual(claims.forWatch(1).length, 3);

    // A takeover replaces rather than duplicating.
    claims.claim({ watchId: 1, slot: 'hilda', userId: ZACK });
    assert.strictEqual(claims.forWatch(1).length, 3);
    assert.strictEqual(claims.find(1, 'Hilda').userId, ZACK);
});

test('re-claiming your own slot keeps its ping mode; a takeover resets to the default', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    claims.setPings(1, 'ZackWord', 'all');

    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    assert.strictEqual(claims.find(1, 'ZackWord').pings, 'all', 'own re-claim should not reset the mode');

    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ALICE });
    assert.strictEqual(claims.find(1, 'ZackWord').pings, claims.DEFAULT_PING_MODE);
});

test('release drops one slot, releaseWatch drops a room and leaves others alone', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    claims.claim({ watchId: 1, slot: 'ZackREPO', userId: ZACK });
    claims.claim({ watchId: 2, slot: 'Elsewhere', userId: ALICE });

    assert.strictEqual(claims.release(1, 'zackword').slot, 'ZackWord');
    assert.strictEqual(claims.release(1, 'zackword'), null, 'releasing twice is a no-op');
    assert.strictEqual(claims.forWatch(1).length, 1);

    assert.strictEqual(claims.releaseWatch(1), 1);
    assert.strictEqual(claims.forWatch(1).length, 0);
    assert.strictEqual(claims.forWatch(2).length, 1, 'another room keeps its claims');
});

test('setPings validates the mode and reports an unknown slot', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });

    assert.strictEqual(claims.setPings(1, 'ZackWord', 'off').pings, 'off');
    assert.strictEqual(claims.setPings(1, 'NoSuchSlot', 'all'), null);
    assert.throws(() => claims.setPings(1, 'ZackWord', 'sometimes'), /Ping mode must be/);
});

test('claims survive a reload from disk', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    claims.setPings(1, 'ZackWord', 'all');

    claims.reset();   // drop the in-memory copy; the next read comes off disk

    const reloaded = claims.find(1, 'ZackWord');
    assert.strictEqual(reloaded.userId, ZACK);
    assert.strictEqual(reloaded.pings, 'all');
});

test('a claim needs both a slot and a user', () => {
    assert.throws(() => claims.claim({ watchId: 1, slot: '   ', userId: ZACK }), /slot name/);
    assert.throws(() => claims.claim({ watchId: 1, slot: 'ZackWord', userId: '' }), /Discord user/);
});

// --- ping policy --------------------------------------------------------------------------

const progression = { group: 'items', flags: ITEM_FLAG_PROGRESSION };
const trap = { group: 'items', flags: ITEM_FLAG_TRAP };
const filler = { group: 'items', flags: 0 };

test('shouldPing honours the claim ping mode', () => {
    assert.strictEqual(monitor.shouldPing({ pings: 'all' }, filler), true);
    assert.strictEqual(monitor.shouldPing({ pings: 'all' }, progression), true);

    assert.strictEqual(monitor.shouldPing({ pings: 'progression' }, progression), true);
    assert.strictEqual(monitor.shouldPing({ pings: 'progression' }, filler), false);
    assert.strictEqual(monitor.shouldPing({ pings: 'progression' }, trap), false);

    assert.strictEqual(monitor.shouldPing({ pings: 'off' }, progression), false);
});

test('shouldPing ignores unclaimed slots and non-item lines', () => {
    assert.strictEqual(monitor.shouldPing(null, progression), false);
    assert.strictEqual(monitor.shouldPing({ pings: 'all' }, { group: 'chat', flags: 0 }), false);
    assert.strictEqual(monitor.shouldPing({ pings: 'all' }, { group: 'hints', flags: ITEM_FLAG_PROGRESSION }), false);
    assert.strictEqual(monitor.shouldPing({ pings: 'all' }, null), false);
});

// --- slot names ---------------------------------------------------------------------------

test('slot lookups use the seed name, not a display alias', () => {
    const client = new ArchipelagoClient({ target: { kind: 'direct', host: 'localhost', port: 1 }, slot: 'ZackWord' });
    client._absorbPlayers({
        players: [
            { team: 0, slot: 1, name: 'ZackWord', alias: 'Zack (afk)' },
            { team: 0, slot: 2, name: 'Hilda', alias: 'Hilda' }
        ]
    });

    // players carries the alias for rendering; slotNames carries the name claims are keyed on.
    // Both are keyed team:slot, because slot numbers repeat across teams.
    assert.strictEqual(client.players.get('0:1'), 'Zack (afk)');
    assert.strictEqual(client.slotNameFor(1), 'ZackWord');
    assert.deepStrictEqual(client.slotsOnTeam(0), [1, 2]);

    assert.strictEqual(client.canonicalSlotName('zackword'), 'ZackWord');
    assert.strictEqual(client.canonicalSlotName('  HILDA '), 'Hilda');
    // An alias is not a claimable name — claiming one would break the moment it changed.
    assert.strictEqual(client.canonicalSlotName('Zack (afk)'), null);
    assert.strictEqual(client.canonicalSlotName('nobody'), null);
    assert.strictEqual(client.canonicalSlotName(''), null);
});

test('stripAnsi clears colour but leaves the mobile markers alone', () => {
    const coloured = `${ANSI.progression}🟪 Progressive Sword${ANSI.reset}`;
    assert.strictEqual(stripAnsi(coloured), '🟪 Progressive Sword');
    assert.strictEqual(stripAnsi('plain'), 'plain');
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
});
