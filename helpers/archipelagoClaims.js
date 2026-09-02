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

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

// Overridable so a test run can point at its own file, and so the store can be relocated.
const CLAIM_FILE = process.env.PLEXBOT_AP_CLAIMS_FILE || path.join(__dirname, '..', 'data', 'archipelago_claims.json');
// Under the test runner that override is required rather than optional, the same gate the watch
// file uses. The real file maps real people to slots, and a test run has no business rewriting it.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_CLAIMS_FILE;

// How much of a slot's incoming traffic is worth a notification. Progression is the default
// because it is the only class that changes whether booting the game up is worth it — filler is
// most of what arrives and pinging on it would train people to mute the channel.
const PING_MODES = ['all', 'progression', 'off'];
const DEFAULT_PING_MODE = 'progression';

let cache = null;
// Set when the file on disk could not be parsed. Writing then would replace claims that may
// still be salvageable by hand with whatever this process holds, so the store goes read-only.
let readOnly = false;

function load() {
    if (cache) return cache;
    if (!usable) {
        cache = [];
        return cache;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(CLAIM_FILE, 'utf8'));
        cache = Array.isArray(parsed.claims) ? parsed.claims : [];
    } catch (err) {
        cache = [];
        if (err.code !== 'ENOENT') {
            readOnly = true;
            logger.error(`Archipelago claim file unreadable (${err.message}) — claims are frozen ` +
                `for this run so the file is not overwritten. Move ${CLAIM_FILE} aside to start fresh.`);
        }
    }
    return cache;
}

function persist() {
    if (!usable || readOnly) return;
    try {
        fs.mkdirSync(path.dirname(CLAIM_FILE), { recursive: true });
        // Write-then-rename, so a kill partway through cannot leave a truncated file that the
        // next boot parse-fails on and then overwrites.
        const tmp = `${CLAIM_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ claims: load() }, null, 4));
        fs.renameSync(tmp, CLAIM_FILE);
    } catch (err) {
        logger.error('Could not persist Archipelago claims:', err.message);
    }
}

function sameSlot(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** Every claim, across every watch. */
function all() {
    return [...load()];
}

/** The claim on one slot, or null. At most one person holds a given slot. */
function find(watchId, slot) {
    return load().find(c => c.watchId === watchId && sameSlot(c.slot, slot)) || null;
}

function forWatch(watchId) {
    return load().filter(c => c.watchId === watchId);
}

function forUser(watchId, userId) {
    return load().filter(c => c.watchId === watchId && c.userId === userId);
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

    if (existing >= 0) claims[existing] = entry;
    else claims.push(entry);
    persist();
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
    const keep = claims.filter(c => c.watchId !== watchId);
    const removed = claims.length - keep.length;
    if (removed > 0) {
        cache = keep;
        persist();
    }
    return removed;
}

function setPings(watchId, slot, mode) {
    if (!PING_MODES.includes(mode)) throw new Error(`Ping mode must be one of ${PING_MODES.join(', ')}.`);
    const entry = find(watchId, slot);
    if (!entry) return null;
    entry.pings = mode;
    persist();
    return entry;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
function reset() {
    cache = null;
    readOnly = false;
}

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
    DEFAULT_PING_MODE,
    CLAIM_FILE
};
