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
// Role creations in flight, keyed guild + role. syncRoles is fire-and-forget, so two goals in
// the same frame both reached the check-then-create below and made duplicate roles that the
// store never recorded and the sweep could therefore never delete.
const creating = new Map();
// Set when the file could not be parsed. Overwriting it would orphan every role it recorded.
let readOnly = false;

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
        cache = {};
        if (err.code !== 'ENOENT') {
            readOnly = true;
            logger.error(`Archipelago role file unreadable (${err.message}) — role bookkeeping is ` +
                `frozen for this run rather than overwritten, so the roles it recorded are not orphaned. ` +
                `Move ${ROLE_FILE} aside to start fresh.`);
        }
    }
    return cache;
}

function persist() {
    if (!usable || readOnly) return;
    try {
        fs.mkdirSync(path.dirname(ROLE_FILE), { recursive: true });
        const tmp = `${ROLE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ guilds: load() }, null, 4));
        fs.renameSync(tmp, ROLE_FILE);
    } catch (err) {
        logger.error('Could not persist Archipelago roles:', err.message);
    }
}

/**
 * Serialise role creation per guild+key, so overlapping syncs share one create instead of racing.
 * @param {string} key stable identity for the role being created, e.g. "member" or "count:3"
 */
function once(guildId, key, make) {
    const id = `${guildId}:${key}`;
    if (creating.has(id)) return creating.get(id);
    const inflight = make().finally(() => creating.delete(id));
    creating.set(id, inflight);
    return inflight;
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
    if (existing) {
        // archipelagoRoleName is a live setting, so follow it rather than leaving the role stuck
        // on whatever it was first created as.
        if (existing.name !== name) {
            try {
                await existing.setName(name, 'Archipelago monitor: participant role renamed in /config');
                logger.info(`[AP roles] renamed the participant role to "${name}" in ${guild.name}`);
            } catch (err) {
                logger.warn(`[AP roles] could not rename the participant role in ${guild.name}: ${err.message}`);
            }
        }
        return existing;
    }

    return once(guild.id, 'member', async () => {
        // Re-check inside the guard: a run that queued behind another may find it already made.
        const made = usableRole(guild, guildEntry(guild.id).member);
        if (made) return made;

        const role = await guild.roles.create({
            name,
            color: MEMBER_ROLE_COLOR,
            // Mentionable so the room's players can be pinged as a group, which is most of the
            // point of having the role at all.
            mentionable: true,
            hoist: false,
            reason: 'Archipelago monitor: multiworld participants'
        });
        guildEntry(guild.id).member = role.id;
        persist();
        logger.info(`[AP roles] created "${name}" in ${guild.name}`);
        return role;
    });
}

async function ensureCountRole(guild, count) {
    const existing = usableRole(guild, guildEntry(guild.id).counts[count]);
    if (existing) return existing;

    return once(guild.id, `count:${count}`, async () => {
        const made = usableRole(guild, guildEntry(guild.id).counts[count]);
        if (made) return made;

        const role = await guild.roles.create({
            name: countRoleName(count),
            // Left uncoloured on purpose: a coloured count role would outrank the participant
            // role and repaint everyone's name every time they goal.
            mentionable: false,
            hoist: false,
            reason: 'Archipelago monitor: goal count'
        });
        guildEntry(guild.id).counts[count] = role.id;
        persist();
        logger.info(`[AP roles] created "${countRoleName(count)}" in ${guild.name}`);
        return role;
    });
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
    // Add the new one before removing the old. The other order leaves the member on no count role
    // at all if the add fails — a 429 burst when several slots goal in one flush is enough — and
    // nothing retries, because syncGoalsAndRoles only fires when the tally actually changes and
    // by then the goal is already recorded.
    if (wanted && !member.roles.cache.has(wanted.id)) {
        await member.roles.add(wanted, `Archipelago: ${goals} goal(s)`);
        applied.added.push(wanted.name);
    }
    for (const roleId of Object.values(entry.counts)) {
        if (wanted && roleId === wanted.id) continue;
        if (!member.roles.cache.has(roleId)) continue;
        const stale = guild.roles.cache.get(roleId);
        if (!stale) continue;
        await member.roles.remove(stale, 'Archipelago: goal count changed');
        applied.removed.push(stale.name);
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
    readOnly = false;
    warned.clear();
    creating.clear();
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
