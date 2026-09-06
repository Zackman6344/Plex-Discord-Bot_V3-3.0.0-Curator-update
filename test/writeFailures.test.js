// What the Archipelago stores do when they cannot write.
//
// Every one of these covers a path that was reported as a success while nothing reached disk, or
// that destroyed the file it had just promised to preserve. None of them had a test: the suite
// exercised the quarantine path thoroughly and never joined it up to what happens next, so a
// failed write announced a goal, moved a Discord role, and vanished on the next restart.
//
// A write is broken here by putting a DIRECTORY where the store's `.tmp` file goes, so
// writeFileSync fails with EISDIR. That is closer to the real causes (a full disk, a locked file,
// EACCES on data/) than stubbing fs, and it leaves the store's own code path untouched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const stores = require('./helpers/apServer.js').useTempStores('writefail');

const claims = require('../helpers/archipelagoClaims.js');
const goals = require('../helpers/archipelagoGoals.js');
const roles = require('../helpers/archipelagoRoles.js');

/** Make every write to `file` fail, and hand back the undo. */
function breakWrites(file) {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(tmp, { recursive: true });
    return () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} };
}

function freshStores() {
    for (const p of Object.values(stores.paths)) {
        try { fs.unlinkSync(p); } catch (_) {}
    }
    claims.reset();
    goals.reset();
    roles.reset();
}

test.beforeEach(freshStores);
test.after(() => {
    stores.cleanup();
    for (const p of Object.values(stores.paths)) {
        try { fs.rmSync(`${p}.tmp`, { recursive: true, force: true }); } catch (_) {}
    }
});

test('a goal that cannot be written is not reported as recorded', () => {
    goals.countFor('seed');                       // load before writes break
    const undo = breakWrites(goals.GOAL_FILE);
    try {
        assert.strictEqual(goals.record('u1', 'SEED::A'), false,
            'record() must report the failure, not claim the goal was counted');
        assert.deepStrictEqual(goals.recordAll([{ userId: 'u1', key: 'SEED::B' }]), [],
            'recordAll() must return nothing new when the batch did not land');
        // The cache matters as much as the return value: a goal left in memory was announced,
        // role-synced, then re-credited on the next connect to whoever held the slot by then.
        assert.strictEqual(goals.countFor('u1'), 0, 'nothing may linger in the cache either');
    } finally {
        undo();
    }
});

test('a claim that cannot be written refuses instead of confirming', () => {
    claims.all();
    const undo = breakWrites(claims.CLAIM_FILE);
    try {
        assert.throws(() => claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' }),
            /not writable/i, 'the caller has to hear about it, since !ap claim replies "you are now on ..."');
        assert.strictEqual(claims.forWatch(1).length, 0, 'and the refused claim leaves no phantom entry');
    } finally {
        undo();
    }
});

test('a re-claim that cannot be written puts the previous holder back', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'first' });
    const undo = breakWrites(claims.CLAIM_FILE);
    try {
        assert.throws(() => claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'second' }), /not writable/i);
        assert.strictEqual(claims.find(1, 'ZackWord').userId, 'first',
            'a failed reassignment must not leave the new holder in the cache');
    } finally {
        undo();
    }
});

test('a release that cannot be written refuses and keeps the claim', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1' });
    const undo = breakWrites(claims.CLAIM_FILE);
    try {
        assert.throws(() => claims.release(1, 'ZackWord'), /not writable/i);
        assert.strictEqual(claims.forWatch(1).length, 1,
            'a release announced but not written comes back on the next restart');
    } finally {
        undo();
    }
});

test('a ping change that cannot be written refuses and keeps the old mode', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: 'u1', pings: 'progression' });
    const undo = breakWrites(claims.CLAIM_FILE);
    try {
        assert.throws(() => claims.setPings(1, 'ZackWord', 'off'), /not writable/i);
        assert.strictEqual(claims.find(1, 'ZackWord').pings, 'progression',
            'the mode the user was told was saved must not linger in the cache');
    } finally {
        undo();
    }
});

test('releaseWatch rolls back and reports nothing released, rather than throwing', () => {
    // The /config sync paths reach this one, and a throw there abandons a reconfiguration
    // half-applied — so this is the one that answers 0 instead.
    claims.claim({ watchId: 7, slot: 'A', userId: 'u1' });
    claims.claim({ watchId: 7, slot: 'B', userId: 'u2' });
    const undo = breakWrites(claims.CLAIM_FILE);
    try {
        let count = null;
        assert.doesNotThrow(() => { count = claims.releaseWatch(7); });
        assert.strictEqual(count, 0, 'the caller must not report claims released that are still on disk');
        assert.strictEqual(claims.forWatch(7).length, 2, 'and both claims are still there');
    } finally {
        undo();
    }
});

test('a damaged file that cannot be moved aside is never overwritten', () => {
    const PRECIOUS = '{"goals": {"SEED::IRREPLACEABLE": {"userId":"u9"';
    fs.writeFileSync(goals.GOAL_FILE, PRECIOUS);
    goals.reset();

    // Quarantine fails, ordinary writes would not. This is the split that made the old code
    // destroy the file one line after logging "Refusing to overwrite; fix it by hand".
    const realRename = fs.renameSync;
    fs.renameSync = function (from, to) {
        if (String(to).includes('.corrupt-')) {
            throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return realRename.apply(fs, arguments);
    };
    try {
        goals.countFor('anyone');                 // triggers the load, and the failed quarantine
        assert.strictEqual(goals.record('u1', 'SEED::NEW'), false, 'the write must be refused');
        assert.strictEqual(fs.readFileSync(goals.GOAL_FILE, 'utf8'), PRECIOUS,
            'the only copy of the damaged data must still be there for salvage');
    } finally {
        fs.renameSync = realRename;
    }
});

test('a member keeps the count role they already hold when a new one cannot be created', async () => {
    const events = [];
    const memberRoles = new Set();
    let n = 0;
    const guild = {
        id: 'g1',
        name: 'Guild',
        roles: {
            cache: new Map(),
            create: async ({ name }) => {
                const id = `r${n++}`;
                const role = {
                    id, name, position: 1,
                    setName: async () => {},
                    delete: async () => { guild.roles.cache.delete(id); }
                };
                guild.roles.cache.set(id, role);
                return role;
            }
        },
        members: {
            me: { permissions: { has: () => true }, roles: { highest: { position: 99 } } },
            fetch: async () => ({
                id: 'u1',
                roles: {
                    cache: { has: (id) => memberRoles.has(id) },
                    add: async (role) => { memberRoles.add(role.id); events.push(`add:${role.name}`); },
                    remove: async (role) => { memberRoles.delete(role.id); events.push(`remove:${role.name}`); }
                }
            })
        }
    };
    const held = () => [...memberRoles].map(id => (guild.roles.cache.get(id) || {}).name);

    await roles.syncMember(guild, 'u1', { claimed: true, goals: 3, memberRoleName: 'Archipelago' });
    assert.ok(held().includes('3 Games Goaled'), 'precondition: the member is on a count role');

    const undo = breakWrites(roles.ROLE_FILE);
    try {
        // The first failure throws out of remember(), which syncRoles catches per user. The one
        // that mattered is the NEXT sync, where canCreate() is false and ensureCountRole returns
        // null: `wanted` being null used to mean "remove every count role this member holds".
        for (const count of [4, 5]) {
            try {
                await roles.syncMember(guild, 'u1', { claimed: true, goals: count, memberRoleName: 'Archipelago' });
            } catch (_) { /* syncRoles swallows this per user */ }
        }
        assert.ok(held().includes('3 Games Goaled'),
            'the brake logs "existing ones keep working", so it must not strip the one they have');
    } finally {
        undo();
    }
});

test('an unparseable day-file date is kept, not deleted', () => {
    const logPrune = require('../helpers/logPrune.js');
    const dir = pathMod.join(os.tmpdir(), `plexbot-test-prune-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    const saved = process.env.PLEXBOT_LOG_RETENTION_DAYS;
    process.env.PLEXBOT_LOG_RETENTION_DAYS = '7';

    // Both match the filename pattern; neither is a real date, so Date.getTime() is NaN. NaN fails
    // every comparison, so testing `>= cutoff` and skipping deleted what `< cutoff` had kept.
    const undatable = ['bot-2024-13-01.log', 'bot-2025-00-00.log'];
    const ancient = 'bot-1999-01-01.log';
    for (const name of [...undatable, ancient]) fs.writeFileSync(pathMod.join(dir, name), 'x');

    try {
        logPrune.resetThrottle();
        logPrune.pruneDayFiles(dir, /^bot-(\d{4}-\d{2}-\d{2})\.log$/, `prune-test-${process.pid}`);
        for (const name of undatable) {
            assert.ok(fs.existsSync(pathMod.join(dir, name)),
                `${name} cannot be placed in time, so housekeeping must leave it alone`);
        }
        assert.ok(!fs.existsSync(pathMod.join(dir, ancient)), 'a real date past the window still goes');
    } finally {
        if (saved === undefined) delete process.env.PLEXBOT_LOG_RETENTION_DAYS;
        else process.env.PLEXBOT_LOG_RETENTION_DAYS = saved;
        logPrune.resetThrottle();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
