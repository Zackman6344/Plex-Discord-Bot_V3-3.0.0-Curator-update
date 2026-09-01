// The goal tally and the Discord roles it drives.
//
// The rule this file exists to pin down: only a real goal counts. A release and a 100%-checked
// slot both make hasFinished() true for the relay filter, and neither is a finished game.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const tmp = (name) => pathMod.join(os.tmpdir(), `plexbot-test-ap-${name}-${process.pid}.json`);
process.env.PLEXBOT_AP_GOALS_FILE = tmp('goals');
process.env.PLEXBOT_AP_ROLES_FILE = tmp('roles');
process.env.PLEXBOT_AP_CLAIMS_FILE = tmp('goalclaims');
process.env.PLEXBOT_AP_WATCHES_FILE = tmp('goalwatches');

const goals = require('../helpers/archipelagoGoals.js');
const roles = require('../helpers/archipelagoRoles.js');
const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');

const ZACK = '111111111111111111';
const ALICE = '222222222222222222';

function fresh() {
    for (const file of [goals.GOAL_FILE, roles.ROLE_FILE, claims.CLAIM_FILE]) {
        try { fs.unlinkSync(file); } catch (_) {}
    }
    goals.reset();
    roles.reset();
    claims.reset();
}

test.beforeEach(fresh);
test.after(fresh);

// --- the tally ----------------------------------------------------------------------------

test('the same goal recorded twice counts once', () => {
    const key = goals.goalKey('Seed_ABC', 'ZackWord');

    assert.strictEqual(goals.record(ZACK, key), true);
    assert.strictEqual(goals.record(ZACK, key), false, 'a reconnect re-offers every goal');
    assert.strictEqual(goals.countFor(ZACK), 1);
});

test('the key separates rooms and slots, so the tally spans multiworlds', () => {
    goals.record(ZACK, goals.goalKey('Seed_ABC', 'ZackWord'));
    goals.record(ZACK, goals.goalKey('Seed_ABC', 'ZackREPO'));   // same room, another slot
    goals.record(ZACK, goals.goalKey('Seed_XYZ', 'ZackWord'));   // another room, same slot name

    assert.strictEqual(goals.countFor(ZACK), 3);
    assert.strictEqual(goals.countFor(ALICE), 0);
});

test('leaderboard ranks by count and skips the empty', () => {
    goals.record(ZACK, goals.goalKey('S1', 'a'));
    goals.record(ZACK, goals.goalKey('S1', 'b'));
    goals.record(ALICE, goals.goalKey('S1', 'c'));

    assert.deepStrictEqual(goals.leaderboard(), [
        { userId: ZACK, count: 2 },
        { userId: ALICE, count: 1 }
    ]);
});

test('the tally survives a reload, and forget clears one person', () => {
    goals.record(ZACK, goals.goalKey('S1', 'a'), { slot: 'a' });
    goals.reset();
    assert.strictEqual(goals.countFor(ZACK), 1);
    assert.strictEqual(goals.entriesFor(ZACK)[0].slot, 'a');

    assert.strictEqual(goals.forget(ZACK), 1);
    assert.strictEqual(goals.countFor(ZACK), 0);
});

// --- what counts as goaled ----------------------------------------------------------------

function fakeState({ goaled = [], released = [], fullyChecked = [], seedName = 'Seed_ABC', target } = {}) {
    const names = { 1: 'ZackWord', 2: 'ZackREPO', 3: 'ZackRisk' };
    return {
        watch: {
            id: 1,
            label: 'test',
            target: target || { kind: 'direct', host: 'archipelago.gg', port: 35217 }
        },
        client: {
            seedName,
            goaled: new Set(goaled.map(s => `0:${s}`)),
            released: new Set(released.map(s => `0:${s}`)),
            fullyChecked: new Set(fullyChecked.map(s => `0:${s}`)),
            slotNameFor: (id) => names[id]
        }
    };
}

test('a release and a 100%-checked slot are not goals', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    claims.claim({ watchId: 1, slot: 'ZackREPO', userId: ZACK });
    claims.claim({ watchId: 1, slot: 'ZackRisk', userId: ZACK });

    // Slot 1 goaled. Slot 2 released, slot 3 fully checked: both make hasFinished() true and
    // neither is a finished game.
    const changed = monitor.recordGoals(fakeState({ goaled: [1], released: [2], fullyChecked: [3] }));

    assert.deepStrictEqual([...changed], [ZACK]);
    assert.strictEqual(goals.countFor(ZACK), 1);
    assert.deepStrictEqual(goals.entriesFor(ZACK).map(e => e.slot), ['ZackWord']);
});

test('goals on unclaimed slots are ignored, and re-reading changes nothing', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    const state = fakeState({ goaled: [1, 2, 3] });   // only slot 1 is claimed

    assert.strictEqual(monitor.recordGoals(state).size, 1);
    assert.strictEqual(goals.countFor(ZACK), 1);

    // Every reconnect rebuilds the goal set and calls this again.
    assert.strictEqual(monitor.recordGoals(state).size, 0, 'nothing new the second time');
    assert.strictEqual(goals.countFor(ZACK), 1);
});

// --- surviving a restart --------------------------------------------------------------------
//
// A restart re-reads the tally off disk and reconnects, and reconnecting rebuilds the goal set
// from the server. Every goal is therefore offered again on every boot, and must not count again.

test('a restart does not re-count a goal already on disk', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    const state = fakeState({ goaled: [1] });

    assert.strictEqual(monitor.recordGoals(state).size, 1);
    assert.strictEqual(goals.countFor(ZACK), 1);

    // What a process restart does: in-memory copy gone, file still there, room re-read.
    goals.reset();
    claims.reset();

    assert.strictEqual(monitor.recordGoals(state).size, 0, 'nothing new after a restart');
    assert.strictEqual(goals.countFor(ZACK), 1);

    // And again, for a bot that gets restarted a lot.
    goals.reset();
    monitor.recordGoals(state);
    goals.reset();
    monitor.recordGoals(state);
    assert.strictEqual(goals.countFor(ZACK), 1);
});

test('a hosted room moving to a new port does not re-count', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });

    // Same multiworld, same seed, different port after the room spun back up.
    monitor.recordGoals(fakeState({ goaled: [1], target: { kind: 'direct', host: 'archipelago.gg', port: 35217 } }));
    goals.reset();
    monitor.recordGoals(fakeState({ goaled: [1], target: { kind: 'direct', host: 'archipelago.gg', port: 41902 } }));

    assert.strictEqual(goals.countFor(ZACK), 1, 'the seed name is what identifies the game');
});

test('goal identity prefers the seed, falls back to a room URL, and refuses a bare host', () => {
    const room = { kind: 'room', roomUrl: 'https://archipelago.gg/room/abcdefgh' };
    const direct = { kind: 'direct', host: 'archipelago.gg', port: 35217 };

    assert.strictEqual(monitor.goalIdentity(fakeState({ seedName: 'Seed_ABC', target: direct })), 'Seed_ABC');
    assert.strictEqual(monitor.goalIdentity(fakeState({ seedName: null, target: room })), room.roomUrl);
    // A moving port cannot be told apart from a new game, so it is not counted at all.
    assert.strictEqual(monitor.goalIdentity(fakeState({ seedName: null, target: direct })), null);
});

test('a watch with no stable identity records nothing rather than double counting', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    const state = fakeState({ goaled: [1], seedName: null, target: { kind: 'direct', host: 'archipelago.gg', port: 35217 } });

    assert.strictEqual(monitor.recordGoals(state).size, 0);
    assert.strictEqual(goals.countFor(ZACK), 0);
    // Warned once, not once per goal per reconnect.
    assert.strictEqual(monitor.recordGoals(state).size, 0);
    assert.strictEqual(state.warnedNoSeed, true);
});

test('a room URL keeps the tally stable across a restart when no seed name arrives', () => {
    claims.claim({ watchId: 1, slot: 'ZackWord', userId: ZACK });
    const room = { kind: 'room', roomUrl: 'https://archipelago.gg/room/abcdefgh' };

    monitor.recordGoals(fakeState({ goaled: [1], seedName: null, target: room }));
    goals.reset();
    monitor.recordGoals(fakeState({ goaled: [1], seedName: null, target: room }));

    assert.strictEqual(goals.countFor(ZACK), 1);
});

// --- roles --------------------------------------------------------------------------------

function fakeGuild({ canManage = true, present = [ZACK, ALICE] } = {}) {
    const roleCache = new Map();
    const held = new Map();
    let nextId = 100;

    const guild = {
        id: 'guild-1',
        name: 'Test Guild',
        roles: {
            cache: roleCache,
            create: async ({ name }) => {
                const id = `role-${nextId++}`;
                const role = {
                    id, name, position: 1,
                    delete: async () => { roleCache.delete(id); }
                };
                roleCache.set(id, role);
                return role;
            }
        },
        members: {
            me: {
                permissions: { has: () => canManage },
                roles: { highest: { position: 99 } }
            },
            fetch: async (userId) => {
                if (!present.includes(userId)) {
                    const err = new Error('Unknown Member');
                    err.code = 10007;
                    throw err;
                }
                if (!held.has(userId)) held.set(userId, new Set());
                const mine = held.get(userId);
                return {
                    id: userId,
                    roles: {
                        cache: { has: (id) => mine.has(id) },
                        add: async (role) => { mine.add(role.id); },
                        remove: async (role) => { mine.delete(role.id); }
                    }
                };
            }
        }
    };

    const namesFor = (userId) => [...(held.get(userId) || [])]
        .map(id => roleCache.get(id) && roleCache.get(id).name)
        .filter(Boolean)
        .sort();

    return { guild, namesFor, roleNames: () => [...roleCache.values()].map(r => r.name).sort() };
}

test('claiming grants the participant role, goaling adds a count role', async () => {
    const { guild, namesFor } = fakeGuild();

    await roles.syncMember(guild, ZACK, { claimed: true, goals: 0, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(namesFor(ZACK), ['Archipelago']);

    await roles.syncMember(guild, ZACK, { claimed: true, goals: 1, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(namesFor(ZACK), ['1 Game Goaled', 'Archipelago'], 'singular at one');

    await roles.syncMember(guild, ZACK, { claimed: true, goals: 3, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(namesFor(ZACK), ['3 Games Goaled', 'Archipelago'], 'exactly one count role');
});

test('releasing the last claim drops the participant role and keeps the count', async () => {
    const { guild, namesFor } = fakeGuild();
    await roles.syncMember(guild, ZACK, { claimed: true, goals: 2, memberRoleName: 'Archipelago' });

    await roles.syncMember(guild, ZACK, { claimed: false, goals: 2, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(namesFor(ZACK), ['2 Games Goaled'], 'goals are a lifetime tally');
});

test('a count role is reused rather than duplicated', async () => {
    const { guild, roleNames } = fakeGuild();
    await roles.syncMember(guild, ZACK, { claimed: true, goals: 3, memberRoleName: 'Archipelago' });
    await roles.syncMember(guild, ALICE, { claimed: true, goals: 3, memberRoleName: 'Archipelago' });

    assert.deepStrictEqual(roleNames(), ['3 Games Goaled', 'Archipelago']);
});

test('the sweep deletes only counts nobody holds', async () => {
    const { guild, roleNames } = fakeGuild();
    await roles.syncMember(guild, ZACK, { claimed: true, goals: 3, memberRoleName: 'Archipelago' });
    await roles.syncMember(guild, ALICE, { claimed: true, goals: 5, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(roleNames(), ['3 Games Goaled', '5 Games Goaled', 'Archipelago']);

    // Zack moves 3 -> 4. Nobody is on 3 any more; 5 is still held.
    await roles.syncMember(guild, ZACK, { claimed: true, goals: 4, memberRoleName: 'Archipelago' });
    assert.strictEqual(await roles.sweepCounts(guild, [4, 5]), 1);
    assert.deepStrictEqual(roleNames(), ['4 Games Goaled', '5 Games Goaled', 'Archipelago']);
});

test('a missing member and a missing permission are both survivable', async () => {
    const absent = fakeGuild({ present: [] });
    assert.strictEqual(await roles.syncMember(absent.guild, ZACK, { claimed: true, goals: 1 }), null);
    assert.deepStrictEqual(absent.roleNames(), [], 'no roles made for somebody who is not here');

    const locked = fakeGuild({ canManage: false });
    assert.strictEqual(await roles.syncMember(locked.guild, ZACK, { claimed: true, goals: 1 }), null);
    assert.strictEqual(await roles.sweepCounts(locked.guild, [1]), 0);
    assert.deepStrictEqual(locked.roleNames(), []);
});

test('a role dragged above the bot is replaced rather than retried forever', async () => {
    const { guild, namesFor } = fakeGuild();
    await roles.syncMember(guild, ZACK, { claimed: true, goals: 0, memberRoleName: 'Archipelago' });

    // Somebody moves the role above the bot's own, so it can no longer be assigned.
    const original = [...guild.roles.cache.values()][0];
    original.position = 200;

    await roles.syncMember(guild, ALICE, { claimed: true, goals: 0, memberRoleName: 'Archipelago' });
    assert.deepStrictEqual(namesFor(ALICE), ['Archipelago']);
    assert.strictEqual(guild.roles.cache.size, 2, 'a fresh one, the unusable one left alone');
});
