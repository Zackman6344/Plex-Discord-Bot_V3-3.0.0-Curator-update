// helpers/archipelagoGoals.js
//
// A lifetime count of multiworlds each person has actually goaled.
//
// Only a real goal counts. A release hands out everything the slot was holding and a
// fully-checked slot may still be waiting on an item, so neither is a finish by this file's
// reckoning even though archipelagoClient.hasFinished() folds all three together for the relay
// filter. Read `client.goaled` when feeding this, never hasFinished().
//
// Records are keyed by seed and slot rather than by watch, because a count is meant to outlive
// the room it was earned in: watches get removed, their ids get handed out again, and the tally
// has to survive both. RoomInfo.seed_name is stable for the life of a multiworld and unique
// across them, which makes `<seed>::<slot>` the identity of one person's game.
//
// Recording is idempotent for that reason too. The goal set is rebuilt from the server on every
// reconnect, so the same goal is offered to this file many times and must only ever count once.
//
// The record is keyed by the goal, not by the person: `{ "<seed>::<slot>": { userId, at } }`.
// Keying it per user made the idempotence per user as well, so a slot changing hands re-counted
// a game the previous holder had already finished — the new claimant simply had no key for it.
// The goal belongs to whoever was on the slot when it landed, and stays there.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const GOAL_FILE = process.env.PLEXBOT_AP_GOALS_FILE || path.join(__dirname, '..', 'data', 'archipelago_goals.json');
// Same gate as the watch and claim files: a test run has no business rewriting the real tally.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_GOALS_FILE;

let cache = null;
// Set when the file on disk could not be parsed. Writing then would replace a tally that may
// still be salvageable by hand with whatever this process happens to have in memory, so the
// store goes read-only for the rest of the run instead.
let readOnly = false;

/**
 * Accept both the goal-keyed shape and the original user-keyed one.
 * Idempotent, so it can run on every load without a version flag.
 */
function migrate(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (!value || typeof value !== 'object') continue;
        if (typeof value.userId === 'string') {
            out[key] = value;                       // already goal-keyed
            continue;
        }
        // Original shape: the key is a Discord user id and the value maps goalKey -> meta.
        for (const [goalKey, meta] of Object.entries(value)) {
            if (!meta || typeof meta !== 'object') continue;
            if (!out[goalKey]) out[goalKey] = { userId: key, ...meta };
        }
    }
    return out;
}

function load() {
    if (cache) return cache;
    if (!usable) {
        cache = Object.create(null);
        return cache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(GOAL_FILE, 'utf8'));
        cache = Object.assign(Object.create(null), migrate(parsed && parsed.goals));
    } catch (err) {
        cache = Object.create(null);
        if (err.code !== 'ENOENT') {
            readOnly = true;
            logger.error(`Archipelago goal file unreadable (${err.message}) — the tally is frozen ` +
                `for this run so the file is not overwritten. Move ${GOAL_FILE} aside to start fresh.`);
        }
    }
    return cache;
}

function persist() {
    if (!usable || readOnly) return;
    try {
        fs.mkdirSync(path.dirname(GOAL_FILE), { recursive: true });
        // Write to a sibling and rename over the target. A kill partway through a plain write
        // leaves a truncated file, and the next boot would parse-fail and then overwrite it with
        // an empty tally — losing a count that cannot be re-derived from any server.
        const tmp = `${GOAL_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ goals: load() }, null, 4));
        fs.renameSync(tmp, GOAL_FILE);
    } catch (err) {
        logger.error('Could not persist Archipelago goals:', err.message);
    }
}

/** The identity of one game in one multiworld, independent of who was playing it. */
function goalKey(seed, slot) {
    return `${String(seed || '').trim()}::${String(slot || '').trim()}`;
}

/**
 * Record one goal against the user who held the slot when it landed.
 * @returns {boolean} true only the first time this seed/slot pair is seen at all — for anyone —
 *   so a caller can use it to decide whether anything downstream needs updating.
 */
function record(userId, key, meta = {}) {
    if (!userId || !key) return false;
    const all = load();
    if (all[key]) return false;

    all[key] = { ...meta, userId: String(userId), at: new Date().toISOString() };
    persist();
    return true;
}

/** Who is credited with one goal, or null. */
function holderOf(key) {
    const entry = load()[key];
    return entry ? entry.userId : null;
}

function countFor(userId) {
    let count = 0;
    for (const entry of Object.values(load())) {
        if (entry.userId === userId) count++;
    }
    return count;
}

function entriesFor(userId) {
    return Object.entries(load())
        .filter(([, entry]) => entry.userId === userId)
        .map(([key, entry]) => ({ key, ...entry }));
}

/** Everyone with at least one goal, most first. */
function leaderboard() {
    const counts = new Map();
    for (const entry of Object.values(load())) {
        counts.set(entry.userId, (counts.get(entry.userId) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([userId, count]) => ({ userId, count }))
        .sort((a, b) => b.count - a.count);
}

/** Drop one user's whole tally. Owner-only escape hatch for a bad import or a test account. */
function forget(userId) {
    const all = load();
    let removed = 0;
    for (const [key, entry] of Object.entries(all)) {
        if (entry.userId !== userId) continue;
        delete all[key];
        removed++;
    }
    if (removed > 0) persist();
    return removed;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
function reset() {
    cache = null;
    readOnly = false;
}

module.exports = { goalKey, record, holderOf, countFor, entriesFor, leaderboard, forget, reset, GOAL_FILE };
