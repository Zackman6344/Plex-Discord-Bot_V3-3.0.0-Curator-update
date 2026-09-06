// helpers/archipelagoHints.js
//
// Which hints have already been announced, so a hint pings its finder exactly once.
//
// The server rebuilds the whole hint list on every read, and the bot re-reads it on every
// connect, which a hosted room forces roughly every two hours. Without a record of what has
// been seen, each cycle would re-announce every outstanding hint in the room.
//
// The first read of a multiworld is SEEDED SILENTLY. On the room this was built against there
// were 45 outstanding hints, 20 of them against a single slot, so announcing on discovery would
// have opened with twenty pings of pure backlog for whoever claimed it. Seeding records them as
// already seen without notifying anyone; only hints created after that point are news. The
// marker is explicit rather than inferred from "this seed has no keys yet", because a room whose
// first hint has not been placed would otherwise seed on that first hint and swallow it.
//
// Keyed by seed, like the goal tally and for the same reason: a hint belongs to a multiworld,
// which outlives the watch id pointing at it. `RoomInfo.seed_name` is stable for the life of a
// multiworld and unique across them.
//
// The team is part of the key because slot numbers repeat across teams, and a hint read from
// team T's key describes team T's world.

const path = require('path');
const { createStore } = require('./jsonStore.js');

const store = createStore({
    envVar: 'PLEXBOT_AP_HINTS_FILE',
    defaultPath: path.join(__dirname, '..', 'data', 'archipelago_hints.json'),
    key: 'hints',
    shape: 'object',
    label: 'hint',
    // Keys carry a server-supplied seed name; a null prototype keeps one called `__proto__`
    // from reaching the prototype chain.
    nullPrototype: true
});
const HINT_FILE = store.file;
const { load, persist } = store;

/** The identity of one hint, independent of who holds the slot or which watch is watching. */
function hintKey(seed, team, findingPlayer, location) {
    return `${String(seed || '').trim()}::${Number(team)}:${Number(findingPlayer)}:${Number(location)}`;
}

// Distinguishable from a real key, which always ends in three numbers.
function seedMarker(seed) {
    return `${String(seed || '').trim()}::seeded`;
}

function isSeeded(seed) {
    return !!load()[seedMarker(seed)];
}

/**
 * Record every key as seen without treating any of them as news.
 * @returns {boolean} false when the baseline could not be written, in which case the caller must
 *   not announce: a seed that did not reach disk replays the whole backlog on the next connect.
 */
function seedBaseline(seed, keys) {
    const all = load();
    const marker = seedMarker(seed);
    const added = [];
    const at = new Date().toISOString();

    if (!all[marker]) {
        all[marker] = { at };
        added.push(marker);
    }
    for (const key of keys || []) {
        if (all[key]) continue;
        all[key] = { at, seeded: true };
        added.push(key);
    }
    if (added.length > 0 && !persist()) {
        for (const key of added) delete all[key];
        return false;
    }
    return true;
}

/**
 * Record a batch of hint keys, reporting only the ones not seen before.
 * One write for the batch: a reconnect offers the whole hint list at once, and recording them
 * one at a time rewrote the file per hint on the socket's message handler.
 * @returns {string[]} the keys that were new
 */
function recordAll(keys) {
    const all = load();
    const added = [];
    const at = new Date().toISOString();

    for (const key of keys || []) {
        if (!key || all[key]) continue;
        all[key] = { at };
        added.push(key);
    }
    if (added.length > 0 && !persist()) {
        // Rolled back so "announced" and "on disk" cannot disagree. A ping sent against a record
        // that never persisted would be sent again on the next connect, and every one after it.
        for (const key of added) delete all[key];
        return [];
    }
    return added;
}

function seen(key) {
    return !!load()[key];
}

/** Drop everything remembered about one multiworld. */
function forgetSeed(seed) {
    const all = load();
    const prefix = `${String(seed || '').trim()}::`;
    let removed = 0;
    for (const key of Object.keys(all)) {
        if (!key.startsWith(prefix)) continue;
        delete all[key];
        removed++;
    }
    if (removed > 0) persist();
    return removed;
}

function count() {
    return Object.keys(load()).length;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
const reset = store.reset;

module.exports = { hintKey, isSeeded, seedBaseline, recordAll, seen, forgetSeed, count, reset, HINT_FILE };
