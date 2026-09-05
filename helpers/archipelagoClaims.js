// helpers/archipelagoClaims.js
//
// Who to ping when an Archipelago slot receives something.
//
// A claim ties one Discord user to one slot in one watched room. The room is part of the key
// because a slot name only means anything inside its own multiworld, and the same name turns up
// in different rooms. The reverse is deliberately not constrained: one person routinely holds
// half a dozen slots in a big async, so a user may claim as many as they like.
//
// This file is storage and lookup only. Whether a given log line is worth a ping is a filtering
// decision and lives beside the other filters, in archipelagoMonitor.shouldPing().
//
// Slot names are compared case-insensitively — nobody types "SpuneBuckshot" correctly first
// time — but the canonical spelling the room reports is what gets stored, so the ping message
// and the room agree.

const path = require('path');
const { createStore } = require('./jsonStore.js');

// How much of a slot's incoming traffic is worth a notification. Progression is the default
// because it is the only class that changes whether booting the game up is worth it — filler is
// most of what arrives and pinging on it would train people to mute the channel.
// One table, so the vocabulary, its descriptions and the slash choices cannot disagree. They were
// declared in three places, and adding a mode to the list alone would have made setPings accept
// something the reply rendered as "pinging for undefined" and the slash form refused to offer.
const PING_HELP = {
    all: 'every item that reaches the slot',
    progression: 'progression items only',
    off: 'nothing — the claim stays, the pings stop'
};
const PING_MODES = Object.keys(PING_HELP);
const DEFAULT_PING_MODE = 'progression';

const store = createStore({
    envVar: 'PLEXBOT_AP_CLAIMS_FILE',
    defaultPath: path.join(__dirname, '..', 'data', 'archipelago_claims.json'),
    key: 'claims',
    shape: 'array',
    label: 'claim'
});
const CLAIM_FILE = store.file;
const { load, persist } = store;

function sameSlot(a, b) {
    // The hot path is notePing, once per relayed line, comparing the room's canonical spelling
    // against the spelling stored from it — already equal byte for byte. The folding below costs
    // six string allocations per claim examined, so it is worth skipping when it cannot matter.
    if (a === b) return true;
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// Readers get copies. `all()` cloned the array but not its elements, which advertised a
// defensive copy while `setPings` relied on the opposite: that a returned claim was live and
// mutating it changed the store. A caller following the first signal would have edited the cache
// with nothing persisting it, and the change would then vanish on restart or be written out
// later by an unrelated claim.
const copy = (claim) => (claim ? { ...claim } : null);

/** The live entry, for the few places inside this module that mean to write through it. */
function locate(watchId, slot) {
    return load().find(c => c.watchId === watchId && sameSlot(c.slot, slot)) || null;
}

/** Every claim, across every watch. */
function all() {
    return load().map(copy);
}

/** The claim on one slot, or null. At most one person holds a given slot. */
function find(watchId, slot) {
    return copy(locate(watchId, slot));
}

function forWatch(watchId) {
    return load().filter(c => c.watchId === watchId).map(copy);
}

function forUser(watchId, userId) {
    return load().filter(c => c.watchId === watchId && c.userId === userId).map(copy);
}

/**
 * Claim a slot for a user, replacing whoever held it before.
 * @param {{watchId: number, slot: string, userId: string, pings?: string}} options
 */
function claim({ watchId, slot, userId, pings }) {
    const name = String(slot || '').trim();
    if (!name) throw new Error('I need a slot name to claim.');
    if (!userId) throw new Error('I need a Discord user to claim it for.');

    const mode = PING_MODES.includes(pings) ? pings : DEFAULT_PING_MODE;
    const claims = load();
    const existing = claims.findIndex(c => c.watchId === watchId && sameSlot(c.slot, name));

    const entry = {
        watchId,
        slot: name,
        userId: String(userId),
        // A re-claim of a slot you already hold keeps the ping mode you had set on it.
        pings: existing >= 0 && claims[existing].userId === String(userId) ? claims[existing].pings : mode,
        claimedAt: new Date().toISOString()
    };

    const previous = existing >= 0 ? claims[existing] : null;
    if (existing >= 0) claims[existing] = entry;
    else claims.push(entry);
    if (!persist()) {
        // Put the cache back and say so. Reporting "✅ you are now on <slot>" for a claim that
        // never reached disk is worse than refusing: the pings work until the next restart and
        // then stop, with nothing to point at.
        if (existing >= 0) claims[existing] = previous;
        else claims.pop();
        throw new Error('I could not save that claim — the claims file is not writable. Nothing changed.');
    }
    return entry;
}

/** @returns {Object|null} the claim that was removed */
function release(watchId, slot) {
    const claims = load();
    const index = claims.findIndex(c => c.watchId === watchId && sameSlot(c.slot, slot));
    if (index < 0) return null;
    const [removed] = claims.splice(index, 1);
    persist();
    return removed;
}

/**
 * Drop every claim on a watch. Called when a watch is forgotten, so claims can't outlive the
 * room they refer to and then attach themselves to a later watch that reuses the id.
 * @returns {number} how many were removed
 */
function releaseWatch(watchId) {
    const claims = load();
    // Spliced in place rather than by swapping the cache, so the store owns the array and this
    // module never has to reach into its internals.
    let removed = 0;
    for (let i = claims.length - 1; i >= 0; i--) {
        if (claims[i].watchId !== watchId) continue;
        claims.splice(i, 1);
        removed++;
    }
    if (removed > 0) persist();
    return removed;
}

function setPings(watchId, slot, mode) {
    if (!PING_MODES.includes(mode)) throw new Error(`Ping mode must be one of ${PING_MODES.join(', ')}.`);
    const entry = locate(watchId, slot);
    if (!entry) return null;
    entry.pings = mode;
    persist();
    return copy(entry);
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
const reset = store.reset;

module.exports = {
    all,
    find,
    forWatch,
    forUser,
    claim,
    release,
    releaseWatch,
    setPings,
    sameSlot,
    reset,
    PING_MODES,
    PING_HELP,
    DEFAULT_PING_MODE,
    CLAIM_FILE
};
