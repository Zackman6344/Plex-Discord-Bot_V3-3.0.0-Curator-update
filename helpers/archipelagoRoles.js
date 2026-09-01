// helpers/archipelagoRoles.js
//
// Discord roles for the Archipelago monitor: one role for "plays in a multiworld here", and one
// per distinct goal count ("3 Games Goaled"), moved as people finish.
//
// Every role this creates is recorded by id in data/archipelago_roles.json, and cleanup only
// ever touches ids in that file. Matching by name instead would let the bot delete a role
// somebody made by hand that happened to fit the pattern.
//
// The sweep asks the goal tally which counts are still held rather than asking Discord who holds
// a role. `role.members` reads the member cache, and the bot runs without the GuildMembers
// intent, so that cache holds only members it has happened to see. The tally is the thing this
// file is rendering anyway, which makes it the better authority as well as the cheaper one.
//
// Nothing here is allowed to throw into the relay. A guild with the permission missing is logged
// once and then left alone.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const ROLE_FILE = process.env.PLEXBOT_AP_ROLES_FILE || path.join(__dirname, '..', 'data', 'archipelago_roles.json');
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_ROLES_FILE;

// Archipelago's own purple, so the role reads as the same thing as the progression colour.
const MEMBER_ROLE_COLOR = 0xAF52DE;

let cache = null;
// Guilds already reported as lacking Manage Roles. One line each, not one per goal.
const warned = new Set();

function load() {
    if (cache) return cache;
    if (!usable) {
        cache = {};
        return cache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(ROLE_FILE, 'utf8'));
        cache = parsed && typeof parsed.guilds === 'object' && parsed.guilds ? parsed.guilds : {};
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('Archipelago role file unreadable:', err.message);
        cache = {};
    }
    return cache;
}

function persist() {
    if (!usable) return;
    try {
        fs.mkdirSync(path.dirname(ROLE_FILE), { recursive: true });
        fs.writeFileSync(ROLE_FILE, JSON.stringify({ guilds: load() }, null, 4));
    } catch (err) {
        logger.error('Could not persist Archipelago roles:', err.message);
    }
}

function guildEntry(guildId) {
    const all = load();
    return all[guildId] || (all[guildId] = { member: null, counts: {} });
}

/** "3 Games Goaled", "1 Game Goaled". */
function countRoleName(count) {
    return `${count} Game${count === 1 ? '' : 's'} Goaled`;
}

function canManageRoles(guild) {
    const me = guild && guild.members && guild.members.me;
    if (!me || !me.permissions || typeof me.permissions.has !== 'function') return false;
    return me.permissions.has('ManageRoles');
}

/**
 * The role for a recorded id, or null if it has been deleted in Discord since.
 * Roles the bot cannot actually assign are treated as absent, so a role dragged above the bot in
 * the hierarchy is replaced rather than retried forever.
 */
function usableRole(guild, roleId) {
    if (!roleId) return null;
    const role = guild.roles.cache.get(roleId);
    if (!role) return null;
    const me = guild.members.me;
    if (me && me.roles && me.roles.highest && role.position >= me.roles.highest.position) return null;
    return role;
}

async function ensureMemberRole(guild, name) {
    const entry = guildEntry(guild.id);
    const existing = usableRole(guild, entry.member);
    if (existing) return existing;

    const role = await guild.roles.create({
        name,
        color: MEMBER_ROLE_COLOR,
        // Mentionable so the room's players can be pinged as a group, which is most of the point
        // of having the role at all.
        mentionable: true,
        hoist: false,
        reason: 'Archipelago monitor: multiworld participants'
    });
    entry.member = role.id;
    persist();
    logger.info(`[AP roles] created "${name}" in ${guild.name}`);
    return role;
}

async function ensureCountRole(guild, count) {
    const entry = guildEntry(guild.id);
    const existing = usableRole(guild, entry.counts[count]);
    if (existing) return existing;

    const role = await guild.roles.create({
        name: countRoleName(count),
        // Left uncoloured on purpose: a coloured count role would outrank the participant role
        // and repaint everyone's name every time they goal.
        mentionable: false,
        hoist: false,
        reason: 'Archipelago monitor: goal count'
    });
    entry.counts[count] = role.id;
    persist();
    logger.info(`[AP roles] created "${countRoleName(count)}" in ${guild.name}`);
    return role;
}

/** Fetch a member without relying on the cache, which is thin without the GuildMembers intent. */
async function fetchMember(guild, userId) {
    try {
        return await guild.members.fetch(userId);
    } catch (err) {
        // 10007 Unknown Member: they claimed a slot from another guild, or have since left.
        if (err && (err.code === 10007 || err.status === 404)) return null;
        throw err;
    }
}

/**
 * Bring one member's roles in line with what they have claimed and goaled.
 * @param {Object} guild
 * @param {string} userId
 * @param {{claimed: boolean, goals: number, memberRoleName: string}} state
 */
async function syncMember(guild, userId, state = {}) {
    if (!guild || !userId) return null;
    if (!canManageRoles(guild)) {
        if (!warned.has(guild.id)) {
            warned.add(guild.id);
            logger.warn(`[AP roles] no Manage Roles permission in ${guild.name} — roles are off for this guild`);
        }
        return null;
    }

    const member = await fetchMember(guild, userId);
    if (!member) return null;

    const entry = guildEntry(guild.id);
    const goals = Number(state.goals) || 0;
    const applied = { added: [], removed: [] };

    // The participant role follows whether they hold any claim at all.
    const memberRole = state.claimed
        ? await ensureMemberRole(guild, state.memberRoleName || 'Archipelago')
        : usableRole(guild, entry.member);
    if (memberRole) {
        const has = member.roles.cache.has(memberRole.id);
        if (state.claimed && !has) {
            await member.roles.add(memberRole, 'Archipelago: claimed a slot');
            applied.added.push(memberRole.name);
        } else if (!state.claimed && has) {
            await member.roles.remove(memberRole, 'Archipelago: no slots claimed');
            applied.removed.push(memberRole.name);
        }
    }

    // Exactly one count role at a time. Goals are a lifetime tally, so this one is never removed
    // for having dropped, only ever swapped upwards.
    const wanted = goals > 0 ? await ensureCountRole(guild, goals) : null;
    for (const roleId of Object.values(entry.counts)) {
        if (wanted && roleId === wanted.id) continue;
        if (!member.roles.cache.has(roleId)) continue;
        const stale = guild.roles.cache.get(roleId);
        if (!stale) continue;
        await member.roles.remove(stale, 'Archipelago: goal count changed');
        applied.removed.push(stale.name);
    }
    if (wanted && !member.roles.cache.has(wanted.id)) {
        await member.roles.add(wanted, `Archipelago: ${goals} goal(s)`);
        applied.added.push(wanted.name);
    }

    return applied;
}

/**
 * Delete count roles nobody is on any more.
 * @param {Object} guild
 * @param {Set<number>|Array<number>} heldCounts every goal count currently held by anybody
 */
async function sweepCounts(guild, heldCounts) {
    if (!guild || !canManageRoles(guild)) return 0;
    const entry = guildEntry(guild.id);
    const keep = new Set([...(heldCounts || [])].map(Number));

    let deleted = 0;
    let changed = false;
    for (const [count, roleId] of Object.entries(entry.counts)) {
        if (keep.has(Number(count))) continue;
        const role = guild.roles.cache.get(roleId);
        if (role) {
            try {
                await role.delete('Archipelago: nobody is on this goal count any more');
                deleted++;
            } catch (err) {
                // Keep the record so the next sweep tries again rather than orphaning the role.
                logger.debug(`[AP roles] could not delete "${role.name}": ${err.message}`);
                continue;
            }
        }
        delete entry.counts[count];
        changed = true;
    }
    if (changed) persist();
    return deleted;
}

function reset() {
    cache = null;
    warned.clear();
}

module.exports = {
    countRoleName,
    canManageRoles,
    usableRole,
    ensureMemberRole,
    ensureCountRole,
    syncMember,
    sweepCounts,
    reset,
    MEMBER_ROLE_COLOR,
    ROLE_FILE
};
