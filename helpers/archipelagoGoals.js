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

const path = require('path');
const { createStore } = require('./jsonStore.js');

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

const store = createStore({
    envVar: 'PLEXBOT_AP_GOALS_FILE',
    defaultPath: path.join(__dirname, '..', 'data', 'archipelago_goals.json'),
    key: 'goals',
    shape: 'object',
    label: 'goal',
    migrate,
    // Keys are seed::slot strings built from server data; a null prototype keeps a hand-edited
    // or migrated file from reaching Object.prototype through one.
    nullPrototype: true
});
const GOAL_FILE = store.file;
const { load, persist } = store;

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
    if (!persist()) {
        // Rolled back so "recorded" and "on disk" cannot disagree. Leaving it in the cache meant
        // the goal was announced and role-synced from memory, then absent after a restart — and
        // re-credited on the next connect to whoever held the slot by then, which is exactly the
        // ownership this file's header says a goal must keep.
        delete all[key];
        return false;
    }
    return true;
}

/**
 * Record a batch of goals with a single write.
 * A first connect to a room where several claimed slots have already goaled offered them one at
 * a time, and each record() rewrote the whole file synchronously on the socket's message handler.
 * @param {Array<{userId: string, key: string, meta?: Object}>} entries
 * @returns {Array<{userId: string, key: string}>} only the ones that were new
 */
function recordAll(entries) {
    const all = load();
    const added = [];
    const at = new Date().toISOString();

    for (const { userId, key, meta } of entries || []) {
        if (!userId || !key || all[key]) continue;
        all[key] = { ...(meta || {}), userId: String(userId), at };
        added.push({ userId, key });
    }
    if (added.length > 0 && !persist()) {
        for (const { key } of added) delete all[key];
        return [];
    }
    return added;
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
const reset = store.reset;

module.exports = { goalKey, record, recordAll, holderOf, countFor, entriesFor, leaderboard, forget, reset, GOAL_FILE };
