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

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const GOAL_FILE = process.env.PLEXBOT_AP_GOALS_FILE || path.join(__dirname, '..', 'data', 'archipelago_goals.json');
// Same gate as the watch and claim files: a test run has no business rewriting the real tally.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_GOALS_FILE;

let cache = null;

function load() {
    if (cache) return cache;
    if (!usable) {
        cache = {};
        return cache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(GOAL_FILE, 'utf8'));
        cache = parsed && typeof parsed.goals === 'object' && parsed.goals ? parsed.goals : {};
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('Archipelago goal file unreadable:', err.message);
        cache = {};
    }
    return cache;
}

function persist() {
    if (!usable) return;
    try {
        fs.mkdirSync(path.dirname(GOAL_FILE), { recursive: true });
        fs.writeFileSync(GOAL_FILE, JSON.stringify({ goals: load() }, null, 4));
    } catch (err) {
        logger.error('Could not persist Archipelago goals:', err.message);
    }
}

/** The identity of one person's game: stable across reconnects, room restarts and watch ids. */
function goalKey(seed, slot) {
    return `${String(seed || 'unknown-seed').trim()}::${String(slot || '').trim()}`;
}

/**
 * Record one goal.
 * @returns {boolean} true only the first time this seed/slot pair is seen for this user, so a
 *   caller can use it to decide whether anything downstream needs updating.
 */
function record(userId, key, meta = {}) {
    if (!userId || !key) return false;
    const all = load();
    const mine = all[userId] || (all[userId] = {});
    if (mine[key]) return false;

    mine[key] = { at: new Date().toISOString(), ...meta };
    persist();
    return true;
}

function countFor(userId) {
    const mine = load()[userId];
    return mine ? Object.keys(mine).length : 0;
}

function entriesFor(userId) {
    const mine = load()[userId];
    return mine ? Object.entries(mine).map(([key, value]) => ({ key, ...value })) : [];
}

/** Everyone with at least one goal, most first. */
function leaderboard() {
    return Object.entries(load())
        .map(([userId, entries]) => ({ userId, count: Object.keys(entries).length }))
        .filter(row => row.count > 0)
        .sort((a, b) => b.count - a.count);
}

/** Drop one user's whole tally. Owner-only escape hatch for a bad import or a test account. */
function forget(userId) {
    const all = load();
    if (!all[userId]) return 0;
    const had = Object.keys(all[userId]).length;
    delete all[userId];
    persist();
    return had;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
function reset() {
    cache = null;
}

module.exports = { goalKey, record, countFor, entriesFor, leaderboard, forget, reset, GOAL_FILE };
