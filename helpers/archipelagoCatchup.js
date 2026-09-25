// helpers/archipelagoCatchup.js
//
// What each watch has already put in its channel, so lines missed while the bot was down can be
// rebuilt from the room's web tracker and posted afterwards.
//
// The room log itself is out of reach: /log/<room> needs the room owner's browser session, and the
// server replays no history to a client that connects. What the tracker API does keep is every item
// ever sent (`player_items_received`), and the socket re-reads every goal and hint on connect. So a
// missed line is recoverable exactly when it was an item send, a goal or a hint; chat, joins,
// deaths and Release/Collect notices are gone for good once the bot misses them.
//
// Identity keys, shared by the live relay and the catch-up so both sides agree on "already said":
//   i:<sender>:<location>   an item send. Cheats (location <= 0) are never keyed: `!getitem` and
//                           admin `/send` both use location -1, so their keys would collide.
//   g:<slot>                a goal
//   h:<finder>:<location>   a hint
//
// Keyed by `<watchId>::<seed>` rather than by seed. Relay is per channel, so a seed-keyed record
// would let one watch's live posts hide a catch-up that a second channel on the same room needs.
//
// A key is recorded only once the message carrying it was accepted by Discord, or when the watch's
// filters dropped it (so turning a category back on never dumps what it hid). A crash between a
// send and the write that follows it therefore costs one message of duplicates, never a lost line.

const path = require('path');
const { createStore } = require('./jsonStore.js');
const { renderPrintJSON } = require('./archipelagoClient.js');
const logger = require('./logger.js');

const store = createStore({
    envVar: 'PLEXBOT_AP_CATCHUP_FILE',
    defaultPath: path.join(__dirname, '..', 'data', 'archipelago_catchup.json'),
    key: 'reported',
    shape: 'object',
    label: 'catch-up',
    // Record keys carry a server-supplied seed name.
    nullPrototype: true,
    // A full 79-slot room is about 1.1 MB per watch indented, and the file is rewritten after
    // every posted chunk.
    pretty: false
});
const CATCHUP_FILE = store.file;

// The Sets that answer has() live here and never inside the jsonStore object. load() hands back
// the very object persist() stringifies, and JSON.stringify writes a Set as `{}`: the record would
// keep its seededAt and lose every key, and the next catch-up would post the room's whole history.
// Sorted arrays are written back into the cached object immediately before each persist, only
// for the records that changed since the last one.
const index = new Map();
const changed = new Set();
let dirty = false;

function recordKey(watchId, seed) {
    return `${Number(watchId)}::${String(seed)}`;
}

/** @returns {string} the identity of an item send */
function itemKey(sender, location) {
    return `i:${Number(sender)}:${Number(location)}`;
}

/** @returns {string} the identity of a goal */
function goalKey(slot) {
    return `g:${Number(slot)}`;
}

/** @returns {string} the identity of a hint */
function hintKey(finder, location) {
    return `h:${Number(finder)}:${Number(location)}`;
}

function emptyRecord() {
    return { seededAt: null, team: 0, lastPostedAt: null, finished: [], items: {}, goals: [], hints: [] };
}

function numbers(list) {
    return Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : [];
}

/** The Set index for one record, built from the stored arrays the first time it is asked for. */
function setsFor(key, create) {
    const cached = index.get(key);
    if (cached) return cached;

    const all = store.load();
    let raw = all[key];
    if (!raw || typeof raw !== 'object') {
        if (!create) return null;
        raw = emptyRecord();
        all[key] = raw;
    }

    const items = new Map();
    if (raw.items && typeof raw.items === 'object') {
        for (const [sender, locations] of Object.entries(raw.items)) {
            items.set(Number(sender), new Set(numbers(locations)));
        }
    }
    const sets = {
        raw,
        items,
        goals: new Set(numbers(raw.goals)),
        hints: new Set(Array.isArray(raw.hints) ? raw.hints.map(String) : []),
        finished: new Set(numbers(raw.finished))
    };
    index.set(key, sets);
    return sets;
}

function grows(set, value) {
    const before = set.size;
    return set.add(value).size !== before;
}

/** @returns {boolean} whether the key was new to this record */
function addKey(sets, key) {
    const parts = String(key).split(':');
    if (parts[0] === 'i' && parts.length === 3) {
        const sender = Number(parts[1]);
        let locations = sets.items.get(sender);
        if (!locations) {
            locations = new Set();
            sets.items.set(sender, locations);
        }
        return grows(locations, Number(parts[2]));
    }
    if (parts[0] === 'g' && parts.length === 2) return grows(sets.goals, Number(parts[1]));
    if (parts[0] === 'h' && parts.length === 3) return grows(sets.hints, `${Number(parts[1])}:${Number(parts[2])}`);
    return false;
}

// Goal, release and a full check cannot be undone, so the snapshot only grows. Replacing it let
// the first post after a restart, made before the tracker poll or the status read, shrink it.
/** @returns {boolean} whether any slot was new */
function addFinished(sets, finished) {
    let grew = false;
    for (const slot of finished) {
        const n = Number(slot);
        if (Number.isFinite(n) && grows(sets.finished, n)) grew = true;
    }
    return grew;
}

function markChanged(key) {
    changed.add(key);
    dirty = true;
}

function hasKey(sets, key) {
    const parts = String(key).split(':');
    if (parts[0] === 'i' && parts.length === 3) {
        const locations = sets.items.get(Number(parts[1]));
        return !!locations && locations.has(Number(parts[2]));
    }
    if (parts[0] === 'g' && parts.length === 2) return sets.goals.has(Number(parts[1]));
    if (parts[0] === 'h' && parts.length === 3) return sets.hints.has(`${Number(parts[1])}:${Number(parts[2])}`);
    return false;
}

const byNumber = (a, b) => a - b;

function writeBack() {
    for (const key of changed) {
        const sets = index.get(key);
        if (!sets) continue;
        const items = {};
        for (const sender of [...sets.items.keys()].sort(byNumber)) {
            items[sender] = [...sets.items.get(sender)].sort(byNumber);
        }
        sets.raw.items = items;
        sets.raw.goals = [...sets.goals].sort(byNumber);
        sets.raw.hints = [...sets.hints].sort();
        sets.raw.finished = [...sets.finished].sort(byNumber);
    }
    changed.clear();
}

/** Has this key been posted, or deliberately filtered, by this watch for this seed? */
function has(watchId, seed, key) {
    const sets = setsFor(recordKey(watchId, seed), false);
    return !!sets && hasKey(sets, key);
}

/** Has this watch recorded its silent first-sight baseline for this seed? */
function isSeeded(watchId, seed) {
    const sets = setsFor(recordKey(watchId, seed), false);
    return !!sets && !!sets.raw.seededAt;
}

/**
 * A read-only view of one record.
 * @returns {{seededAt: string|null, lastPostedAt: string|null, team: number, finished: Set<number>}|null}
 */
function record(watchId, seed) {
    const sets = setsFor(recordKey(watchId, seed), false);
    if (!sets) return null;
    return {
        seededAt: sets.raw.seededAt || null,
        lastPostedAt: sets.raw.lastPostedAt || null,
        team: Number(sets.raw.team) || 0,
        finished: new Set(sets.finished)
    };
}

/**
 * Record everything the room holds right now as already reported, without posting any of it.
 * Drops this watch's records for every other seed, since a watch follows one room at a time.
 * @param {Object} [options]
 * @param {number} [options.team]
 * @param {Iterable<number>} [options.finished] slots finished at this moment, for the skip-goaled
 *   filter on the first catch-up after a gap
 * @returns {boolean} false when it could not be written. The caller must not treat the watch as
 *   seeded or post anything: an unsaved baseline would replay the whole room on the next boot.
 */
function baseline(watchId, seed, keys, options = {}) {
    const key = recordKey(watchId, seed);
    const all = store.load();
    const prefix = `${Number(watchId)}::`;
    for (const other of Object.keys(all)) {
        if (other.startsWith(prefix) && other !== key) {
            delete all[other];
            index.delete(other);
            changed.delete(other);
        }
    }

    const sets = setsFor(key, true);
    const previous = sets.raw.seededAt;
    for (const k of keys || []) addKey(sets, k);
    sets.raw.seededAt = new Date().toISOString();
    if (typeof options.team === 'number') sets.raw.team = options.team;
    if (options.finished) addFinished(sets, options.finished);
    markChanged(key);
    if (!persist()) {
        sets.raw.seededAt = previous || null;
        return false;
    }
    return true;
}

/**
 * Mark keys as reported. Does not write; call persist() once the batch is done.
 * @param {Object} [options]
 * @param {string} [options.postedAt] ISO time of the post that carried them. Left out for keys
 *   that were filtered rather than posted.
 * @param {Iterable<number>} [options.finished] slots finished now, added to the stored snapshot
 */
function commit(watchId, seed, keys, options = {}) {
    const key = recordKey(watchId, seed);
    const sets = setsFor(key, true);
    let grew = false;
    for (const k of keys || []) {
        if (addKey(sets, k)) grew = true;
    }
    if (options.finished && addFinished(sets, options.finished)) grew = true;
    if (options.postedAt && sets.raw.lastPostedAt !== options.postedAt) {
        sets.raw.lastPostedAt = options.postedAt;
        grew = true;
    }
    if (grew) markChanged(key);
}

/** @returns {boolean} whether everything committed so far is on disk */
function persist() {
    if (!dirty) return true;
    writeBack();
    const ok = store.persist();
    if (ok) dirty = false;
    return ok;
}

/** Drop every record for a watch, for when the watch itself goes. Watch ids are reused. */
function forgetWatch(watchId) {
    const all = store.load();
    const prefix = `${Number(watchId)}::`;
    let removed = 0;
    for (const key of Object.keys(all)) {
        if (!key.startsWith(prefix)) continue;
        delete all[key];
        index.delete(key);
        changed.delete(key);
        removed++;
    }
    if (removed > 0) {
        dirty = true;
        persist();
    }
    return removed;
}

/** Test seam: drop the in-memory copy and the Set index so the next read comes off disk. */
function reset() {
    store.reset();
    index.clear();
    changed.clear();
    dirty = false;
}

// app/utils.js quits with process.exit(0) straight away, so anything committed since the last
// chunk's persist would otherwise be lost and reposted on the next boot. 'exit' handlers must be
// synchronous, which persist() is. Registered once per process through a shared registry, so a
// test that clears the require cache and loads this module again adds no second listener.
const EXIT_HOOKS = Symbol.for('plexbot.archipelagoCatchup.exitHooks');
function flushOnExit() {
    if (!store.usable || !dirty) return;
    try {
        persist();
    } catch (_) {}
}
if (!process[EXIT_HOOKS]) {
    process[EXIT_HOOKS] = new Set();
    process.on('exit', () => {
        for (const hook of process[EXIT_HOOKS]) hook();
    });
}
process[EXIT_HOOKS].add(flushOnExit);

// --- rebuilding missed lines from the tracker --------------------------------------------

const HINT_STATUS_TEXT = { 0: '(unspecified)', 10: '(no priority)', 20: '(avoid)', 30: '(priority)', 40: '(found)' };

/** Each sender's last new check, epoch ms or null, from the tracker's activity_timers. */
function activityFrom(trackerData, team = 0) {
    const out = new Map();
    for (const entry of (trackerData && trackerData.activity_timers) || []) {
        if (!entry || (Number(entry.team) || 0) !== team) continue;
        const at = entry.time ? Date.parse(entry.time) : NaN;
        out.set(Number(entry.player), Number.isFinite(at) ? at : null);
    }
    return out;
}

function isGroupOf(client, slot) {
    return typeof client.isGroup === 'function' && client.isGroup(slot);
}

function slotSetOf(client, slot) {
    return typeof client.slotSet === 'function' ? client.slotSet(slot) : new Set([Number(slot)]);
}

/**
 * Every item send in the tracker, with the receivers it was listed under.
 * @returns {{items: Map<string, Object>, chains: string[][]}} chains are each receiver's keys in
 *   the order the server appended them
 */
function readItems(trackerData, team, skip) {
    const items = new Map();
    const chains = [];
    for (const entry of (trackerData && trackerData.player_items_received) || []) {
        if (!entry || (Number(entry.team) || 0) !== team || !Array.isArray(entry.items)) continue;
        const receiver = Number(entry.player);
        const chain = [];
        for (const tuple of entry.items) {
            if (!Array.isArray(tuple) || tuple.length < 3) continue;
            const [item, location, sender, flags] = tuple.map(Number);
            if (!(location > 0)) continue;
            const key = itemKey(sender, location);
            if (skip(key)) continue;
            let found = items.get(key);
            if (!found) {
                found = { key, item, location, sender, flags: Number.isFinite(flags) ? flags : 0, receivers: new Set() };
                items.set(key, found);
            }
            if (!found.receivers.has(receiver)) {
                found.receivers.add(receiver);
                chain.push(key);
            }
        }
        if (chain.length > 0) chains.push(chain);
    }
    return { items, chains };
}

function readGoals(client, team, skip) {
    const out = [];
    for (const id of client.goaled || []) {
        const [goalTeam, slot] = String(id).split(':').map(Number);
        if (goalTeam !== team || !Number.isFinite(slot)) continue;
        // A group is goaled from the moment the room loads and live never announces it.
        if (isGroupOf(client, slot)) continue;
        const key = goalKey(slot);
        if (skip(key)) continue;
        out.push({ key, slot, team: goalTeam });
    }
    return out.sort((a, b) => a.slot - b.slot);
}

function readHints(client, team, skip) {
    const watched = client.slotId;
    const out = [];
    if (typeof watched !== 'number' || !client.hints) return out;
    for (const hint of client.hints.values()) {
        if (!hint || (Number(hint.team) || 0) !== team || typeof hint.location !== 'number') continue;
        // The server sends a Hint line to every client on the receiver's slot set plus the finder,
        // so a hint for an item-link group reaches the bot through its member slot.
        if (hint.finding_player !== watched && !slotSetOf(client, hint.receiving_player).has(watched)) continue;
        const key = hintKey(hint.finding_player, hint.location);
        if (skip(key)) continue;
        out.push({ key, hint });
    }
    return out.sort((a, b) => a.hint.finding_player - b.hint.finding_player || a.hint.location - b.hint.location);
}

/**
 * Every key the room holds right now, whatever the filters say. What a baseline records.
 * @returns {{all: string[], counts: {items: number, goals: number, hints: number}}}
 */
function collectKeys({ tracker: trackerData, client }) {
    const team = client.team || 0;
    const none = () => false;
    const items = [...readItems(trackerData, team, none).items.keys()];
    const goals = readGoals(client, team, none).map(g => g.key);
    const hints = readHints(client, team, none).map(h => h.key);
    return { all: [...items, ...goals, ...hints], counts: { items: items.length, goals: goals.length, hints: hints.length } };
}

/** The receiver live would have named. An item-link send is one packet addressed to the group. */
function receiverFor(entry, client) {
    const receivers = [...entry.receivers].sort(byNumber);
    if (receivers.length < 2) return receivers[0];
    const groups = client.slotGroups instanceof Map ? [...client.slotGroups.entries()].sort((a, b) => a[0] - b[0]) : [];
    const matches = groups.filter(([, members]) =>
        members.size === receivers.length && receivers.every(r => members.has(r)));
    if (matches.length > 1) {
        logger.debug(`[AP:${client.label || '?'}] ${entry.key} matches ${matches.length} item-link groups; naming the lowest`);
    }
    return matches.length > 0 ? matches[0][0] : receivers[0];
}

// Kahn's algorithm over each receiver's append order. Every list is a subsequence of one global
// append order, so any order consistent with all of them is one the room could have produced. Ties
// keep a sender's run together (a release is one sender's burst), then go to whoever checked least
// recently, since a later activity time means that sender was still sending later.
function orderItems(entries, chains, activity) {
    const byKey = new Map(entries.map(e => [e.key, e]));
    const indegree = new Map(entries.map(e => [e.key, 0]));
    const next = new Map();
    for (const chain of chains) {
        const kept = chain.filter(k => byKey.has(k));
        for (let i = 1; i < kept.length; i++) {
            if (!next.has(kept[i - 1])) next.set(kept[i - 1], []);
            next.get(kept[i - 1]).push(kept[i]);
            indegree.set(kept[i], indegree.get(kept[i]) + 1);
        }
    }

    const at = (sender) => (activity.has(sender) ? activity.get(sender) : null);
    let previous = null;
    const before = (a, b) => {
        const sameA = a.sender === previous;
        const sameB = b.sender === previous;
        if (sameA !== sameB) return sameA;
        const ta = at(a.sender);
        const tb = at(b.sender);
        if (ta !== tb) {
            if (ta === null) return true;
            if (tb === null) return false;
            return ta < tb;
        }
        if (a.sender !== b.sender) return a.sender < b.sender;
        return a.location < b.location;
    };

    const ready = entries.filter(e => indegree.get(e.key) === 0);
    const out = [];
    while (ready.length > 0) {
        let best = 0;
        for (let i = 1; i < ready.length; i++) if (before(ready[i], ready[best])) best = i;
        const chosen = ready[best];
        ready[best] = ready[ready.length - 1];
        ready.pop();
        out.push(chosen);
        previous = chosen.sender;
        for (const k of next.get(chosen.key) || []) {
            indegree.set(k, indegree.get(k) - 1);
            if (indegree.get(k) === 0) ready.push(byKey.get(k));
        }
    }
    // Only reachable if the tracker's lists contradict each other. Nothing is dropped over it.
    if (out.length < entries.length) {
        const placed = new Set(out.map(e => e.key));
        out.push(...entries.filter(e => !placed.has(e.key)));
    }
    return out;
}

function renderOptions(client) {
    return { ansi: !!client.colorize, markers: client.markers !== false };
}

function itemPacket(entry, receiver) {
    const { item, location, sender, flags } = entry;
    const itemPart = { type: 'item_id', text: String(item), player: receiver, flags };
    const locationPart = { type: 'location_id', text: String(location), player: sender };
    const data = receiver === sender
        ? [{ type: 'player_id', text: String(sender) }, { text: ' found their ' }, itemPart,
            { text: ' (' }, locationPart, { text: ')' }]
        : [{ type: 'player_id', text: String(sender) }, { text: ' sent ' }, itemPart, { text: ' to ' },
            { type: 'player_id', text: String(receiver) }, { text: ' (' }, locationPart, { text: ')' }];
    return { cmd: 'PrintJSON', type: 'ItemSend', receiving: receiver, item: { item, location, player: sender, flags }, data };
}

function hintPacket(hint) {
    const receiving = hint.receiving_player;
    const finding = hint.finding_player;
    const flags = Number(hint.item_flags) || 0;
    const status = hint.found ? '(found)' : (HINT_STATUS_TEXT[hint.status] ?? '(unknown)');
    const data = [
        { text: '[Hint]: ' },
        { type: 'player_id', text: String(receiving) },
        { text: "'s " },
        { type: 'item_id', text: String(hint.item), player: receiving, flags },
        { text: ' is at ' },
        { type: 'location_id', text: String(hint.location), player: finding },
        { text: ' in ' },
        { type: 'player_id', text: String(finding) },
        ...(hint.entrance
            ? [{ text: "'s World at " }, { type: 'entrance_name', text: String(hint.entrance) }]
            : [{ text: "'s World" }]),
        { text: '. ' },
        { type: 'hint_status', text: status }
    ];
    return {
        cmd: 'PrintJSON', type: 'Hint', receiving,
        item: { item: hint.item, location: hint.location, player: finding, flags },
        found: !!hint.found, data
    };
}

/**
 * The lines the live feed would have posted that this watch has not, rebuilt from the tracker.
 *
 * Pure apart from reading `client`. Nothing is recorded here; the caller commits `hidden` and
 * commits each line's key once the message carrying it has been accepted.
 *
 * @param {Object} input
 * @param {Object} input.tracker   /api/tracker JSON
 * @param {Object} input.client    the watch's ArchipelagoClient (or anything shaped like one)
 * @param {Object} input.watch     the watch, for its filters
 * @param {(key: string) => boolean} input.reportedHas  already posted or filtered by this watch
 * @param {Set<string>} [input.inflight]  keys sitting in the live buffer, about to be posted
 * @param {Set<number>} [input.finishedBefore]  slots finished before the gap. Items for them are
 *   treated as live would have: skipped by skip-goaled. A slot that finished DURING the gap is
 *   not in here, so its earlier items still post, as they would have live.
 * @param {Map<number, number|null>} [input.activity]  defaults to the tracker's activity_timers
 * @param {(watch: Object, line: Object) => boolean} [input.shouldRelay] the monitor's filter
 * @returns {{lines: Array<{key: string, text: string, line: Object, receiving: number|null,
 *   sender: number|null}>, hidden: string[], counts: {items: number, goals: number, hints: number}}}
 */
function buildCatchup(input) {
    const { tracker: trackerData, client, watch } = input;
    const reportedHas = input.reportedHas || (() => false);
    const inflight = input.inflight || new Set();
    const finishedBefore = input.finishedBefore || new Set();
    const relay = input.shouldRelay || (() => true);
    const team = client.team || 0;
    const activity = input.activity || activityFrom(trackerData, team);
    const skip = (key) => reportedHas(key) || inflight.has(key);
    const tables = client.lookupTables();
    const options = renderOptions(client);

    const lines = [];
    const hidden = [];
    const counts = { items: 0, goals: 0, hints: 0 };
    const keep = (entry, kind) => {
        if (relay(watch, entry.line)) {
            lines.push(entry);
            counts[kind]++;
        } else {
            hidden.push(entry.key);
        }
    };

    const { items, chains } = readItems(trackerData, team, skip);
    for (const entry of orderItems([...items.values()], chains, activity)) {
        const receiver = receiverFor(entry, client);
        const rendered = renderPrintJSON(itemPacket(entry, receiver), tables, options);
        keep({
            key: entry.key,
            text: rendered.text,
            receiving: receiver,
            sender: entry.sender,
            line: {
                type: 'ItemSend',
                group: 'items',
                flags: entry.flags,
                receiving: receiver,
                recipientFinished: isGroupOf(client, receiver) || finishedBefore.has(receiver),
                self: false
            }
        }, 'items');
    }

    for (const goal of readGoals(client, team, skip)) {
        const name = tables.playerName(goal.slot) || `Player#${goal.slot}`;
        keep({
            key: goal.key,
            text: `${name} (Team #${goal.team + 1}) has completed their goal.`,
            receiving: null,
            sender: goal.slot,
            line: { type: 'Goal', group: 'goals', flags: 0, self: false }
        }, 'goals');
    }

    for (const { key, hint } of readHints(client, team, skip)) {
        const packet = hintPacket(hint);
        const rendered = renderPrintJSON(packet, tables, options);
        keep({
            key,
            text: rendered.text,
            receiving: hint.receiving_player,
            sender: hint.finding_player,
            line: {
                type: 'Hint',
                group: 'hints',
                flags: packet.item.flags,
                receiving: hint.receiving_player,
                recipientFinished: false,
                self: false
            }
        }, 'hints');
    }

    return { lines, hidden, counts };
}

module.exports = {
    itemKey,
    goalKey,
    hintKey,
    has,
    isSeeded,
    record,
    baseline,
    commit,
    persist,
    forgetWatch,
    reset,
    activityFrom,
    collectKeys,
    buildCatchup,
    CATCHUP_FILE
};
