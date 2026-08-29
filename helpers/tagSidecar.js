// helpers/tagSidecar.js
//
// A local store of AI-inferred track tags for the large share of the library Plex has no
// mood/genre data for. Nothing here writes to Plex: the sidecar is consulted *alongside* it,
// never instead of it.
//
// Precedence is absolute and per-dimension: if Plex has moods for a track, Plex's moods are the
// moods and the inferred ones are ignored — however many the sidecar holds. An inferred
// dimension Plex later fills is marked superseded rather than deleted, so it stays auditable.
//
// Durability rules, because this file is the only record of work a human approved:
//   - writes go to a temp file and are renamed over the target, so a crash mid-write cannot
//     leave a half-written sidecar;
//   - the previous contents are restored in memory if the write fails, so what's on disk and
//     what's in memory never silently diverge;
//   - pending proposals are persisted too, so a restart between "proposed" and "approved"
//     doesn't strand a review card with nothing behind it.
//
// The on-disk shape is deliberately plain and stable, so external tooling can read it:
//   { version, entries: { "<plexRatingKey>": { title, artist, album, file,
//                                              moods[], genres[], styles[],
//                                              source, approvedBy, at, supersededAt } },
//     pending: { "<id>": { requesterId, createdAt, entries[] } },
//     settings: { discoveryPercent, repeatMemory } }

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

// Overridable so a test run can never touch the real store — which now holds work a human
// approved by hand — and so an external workflow can point the bot at a sidecar it manages.
const FILE = process.env.PLEXBOT_TAGS_FILE || path.join(__dirname, '..', 'data', 'inferred_tags.json');
const TMP = FILE + '.tmp';
// Under the test runner that override is required rather than optional, the same way
// commandLog.js gates on PLEXBOT_LOG_DIR. The line above claims a test run can never touch the
// real store; this is what makes the claim true when a test file forgets to set it, which is
// how a wiring test quietly rewrote a real sidecar. Without it, the store stays in memory.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_TAGS_FILE;
const DIMENSIONS = ['moods', 'genres', 'styles'];
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TAGS_PER_DIMENSION = 40;

let store = null;

// Tuning for the commands that consume the sidecar. Kept here so there is one file to back up
// and one place to look, and so a fresh install needs no config edit to get sane behaviour.
const SETTING_DEFAULTS = { discoveryPercent: 25, repeatMemory: 300 };
const SETTING_BOUNDS = { discoveryPercent: [0, 100], repeatMemory: [0, 2000] };

function blank() {
    return { version: 1, entries: {}, pending: {}, feedback: {}, settings: { ...SETTING_DEFAULTS } };
}

/** Current tuning, with defaults filled in for anything unset or out of range. */
function getSettings() {
    const raw = (load().settings) || {};
    const out = {};
    for (const [key, fallback] of Object.entries(SETTING_DEFAULTS)) {
        const [min, max] = SETTING_BOUNDS[key];
        const value = Number(raw[key]);
        out[key] = Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
    }
    return out;
}

/**
 * @returns {{ok: boolean, value?: number, reason?: string}}
 */
function setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key)) return { ok: false, reason: 'unknown-setting' };
    const [min, max] = SETTING_BOUNDS[key];
    const num = Number(value);
    if (!Number.isFinite(num) || num < min || num > max) return { ok: false, reason: `must be a number between ${min} and ${max}` };

    const data = load();
    if (!data.settings) data.settings = { ...SETTING_DEFAULTS };
    const previous = data.settings[key];
    data.settings[key] = Math.round(num);
    if (!save()) {
        data.settings[key] = previous;
        return { ok: false, reason: 'could not write the settings file' };
    }
    return { ok: true, value: Math.round(num) };
}

function load() {
    if (store) return store;
    if (!usable) {
        store = blank();
        return store;
    }
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
                store = {
                    version: parsed.version || 1,
                    entries: parsed.entries,
                    pending: parsed.pending || {},
                    feedback: parsed.feedback || {},
                    settings: parsed.settings || { ...SETTING_DEFAULTS }
                };
                prunePending();
                return store;
            }
            logger.warn('data/inferred_tags.json has an unexpected shape — starting a fresh sidecar (the file is left alone).');
        }
    } catch (err) {
        // A corrupt sidecar must never stop the bot; it's an optional enrichment layer. The bad
        // file is kept, not overwritten, so it can be inspected or salvaged by hand.
        logger.warn('Could not read data/inferred_tags.json:', err.message || err);
    }
    store = blank();
    return store;
}

/** Atomic write. Returns false (and keeps memory consistent with disk) if anything fails. */
function save() {
    const data = load();
    if (!usable) return true;
    const previous = fs.existsSync(FILE) ? (() => { try { return fs.readFileSync(FILE, 'utf8'); } catch (_) { return null; } })() : null;
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(TMP, JSON.stringify(data, null, 2));
        fs.renameSync(TMP, FILE);
        return true;
    } catch (err) {
        logger.error('Could not write data/inferred_tags.json:', err.message || err);
        try { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); } catch (_) {}
        // Roll memory back to whatever is actually on disk, so a later successful write can't
        // silently persist state the user was told had failed.
        if (previous !== null) {
            try {
                const parsed = JSON.parse(previous);
                store = {
                    version: parsed.version || 1,
                    entries: parsed.entries || {},
                    pending: parsed.pending || {},
                    feedback: parsed.feedback || {},
                    settings: parsed.settings || { ...SETTING_DEFAULTS }
                };
            } catch (_) { /* leave memory as-is; disk is unreadable anyway */ }
        }
        return false;
    }
}

function get(ratingKey) {
    return load().entries[String(ratingKey)] || null;
}

/** Coerce anything into a clean, bounded array of non-empty tag strings. */
function cleanTagList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const tag = raw.trim().slice(0, 80);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
        if (out.length >= MAX_TAGS_PER_DIMENSION) break;
    }
    return out;
}

function cleanText(value, max = 300) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** A proposal entry is only usable if it identifies a track and carries at least one tag. */
function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ratingKey = raw.ratingKey === 0 || raw.ratingKey ? String(raw.ratingKey).trim() : '';
    // Rating keys are opaque ids used as JSON object keys — keep them to plain id characters so
    // nothing path-like or structural can ever reach the store.
    if (!ratingKey || !/^[\w-]{1,64}$/.test(ratingKey)) return null;

    const entry = {
        ratingKey,
        title: cleanText(raw.title),
        artist: cleanText(raw.artist),
        album: cleanText(raw.album),
        file: cleanText(raw.file, 1000),
        moods: cleanTagList(raw.moods),
        genres: cleanTagList(raw.genres),
        styles: cleanTagList(raw.styles),
        source: cleanText(raw.source, 60) || 'inferred',
        // Which dimensions Plex had nothing for, so a regeneration knows what it may fill.
        missing: Array.isArray(raw.missing) ? raw.missing.filter((d) => DIMENSIONS.includes(d)) : DIMENSIONS.slice(),
        status: ['approved', 'rejected'].includes(raw.status) ? raw.status : 'pending',
        feedback: cleanText(raw.feedback, 500)
    };
    if (!entry.moods.length && !entry.genres.length && !entry.styles.length) return null;
    return entry;
}

/**
 * Which tag dimensions Plex itself has nothing for on this track.
 * @returns {string[]} subset of DIMENSIONS
 */
function missingDimensions(plexTrack) {
    const has = (field) => Array.isArray(plexTrack && plexTrack[field]) && plexTrack[field].length > 0;
    const present = { moods: has('Mood'), genres: has('Genre'), styles: has('Style') };
    return DIMENSIONS.filter((d) => !present[d]);
}

/**
 * The tags that should actually be used for a track: Plex's wherever Plex has any, the approved
 * inferred ones only where it doesn't.
 */
function effectiveTags(ratingKey, plexTrack) {
    const result = {
        moods: ((plexTrack && plexTrack.Mood) || []).map((t) => t.tag).filter(Boolean),
        genres: ((plexTrack && plexTrack.Genre) || []).map((t) => t.tag).filter(Boolean),
        styles: ((plexTrack && plexTrack.Style) || []).map((t) => t.tag).filter(Boolean)
    };
    const entry = get(ratingKey);
    const inferredDimensions = [];

    for (const dim of DIMENSIONS) {
        if (result[dim].length > 0) continue;
        if (entry && !entry.supersededAt && Array.isArray(entry[dim]) && entry[dim].length) {
            result[dim] = entry[dim].slice();
            inferredDimensions.push(dim);
        }
    }
    return { ...result, inferredDimensions };
}

/**
 * Approved inferred entries matching any requested tag name. This is what makes the sidecar
 * worth having: a track Plex never tagged cannot come back from a Plex tag query, so without
 * this pass it stays invisible to tag-based search forever.
 */
function findByTags({ moods = [], genres = [], styles = [] } = {}) {
    const want = {
        moods: new Set(moods.map((m) => String(m).toLowerCase())),
        genres: new Set(genres.map((g) => String(g).toLowerCase())),
        styles: new Set(styles.map((s) => String(s).toLowerCase()))
    };
    const hits = [];

    for (const [ratingKey, entry] of Object.entries(load().entries)) {
        if (!entry || entry.supersededAt) continue;
        const matched = { moods: [], genres: [], styles: [] };
        let any = false;
        for (const dim of DIMENSIONS) {
            for (const tag of entry[dim] || []) {
                if (want[dim].has(String(tag).toLowerCase())) { matched[dim].push(tag); any = true; }
            }
        }
        if (any) hits.push({ ratingKey, entry, matched });
    }
    return hits;
}

function prunePending() {
    if (!store || !store.pending) return 0;
    let dropped = 0;
    for (const [id, p] of Object.entries(store.pending)) {
        if (!p || typeof p.createdAt !== 'number' || Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
            delete store.pending[id];
            dropped++;
        }
    }
    return dropped;
}

/**
 * Hold a batch of proposed entries until a human approves them. Persisted so a restart between
 * proposal and approval doesn't leave a review card pointing at nothing — but persisted under
 * `pending`, entirely separate from approved `entries`.
 *
 * @returns {string|null} id used by the approve/discard buttons, or null if nothing was usable
 */
function stage(entries, requesterId) {
    const clean = (Array.isArray(entries) ? entries : []).map(sanitizeEntry).filter(Boolean);
    if (clean.length === 0) return null;

    const data = load();
    prunePending();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    data.pending[id] = { requesterId: requesterId || null, createdAt: Date.now(), entries: clean };
    save(); // best effort: a failure here only costs restart-survival, not the in-memory proposal
    return id;
}

function getProposal(id) {
    const data = load();
    const p = data.pending[String(id)];
    if (!p) return null;
    if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
        delete data.pending[String(id)];
        save();
        return null;
    }
    return { id: String(id), ...p };
}

function discard(id) {
    const data = load();
    if (!data.pending[String(id)]) return false;
    delete data.pending[String(id)];
    save();
    return true;
}

/**
 * Persist an approved batch. The proposal is only cleared once the write succeeds, so a failed
 * save leaves the card re-clickable instead of losing the batch.
 *
 * @returns {{written: number, saved: boolean, reason?: string}}
 */
function approve(id, approvedBy) {
    const proposal = getProposal(id);
    if (!proposal) return { written: 0, saved: false, reason: 'expired' };

    const data = load();
    const snapshot = JSON.stringify(data.entries);
    let written = 0;

    for (const raw of proposal.entries) {
        const entry = sanitizeEntry(raw);
        if (!entry) continue;
        data.entries[entry.ratingKey] = {
            title: entry.title,
            artist: entry.artist,
            album: entry.album,
            file: entry.file,
            moods: entry.moods,
            genres: entry.genres,
            styles: entry.styles,
            source: entry.source,
            approvedBy: approvedBy || null,
            at: new Date().toISOString(),
            supersededAt: null
        };
        written++;
    }

    if (written === 0) {
        delete data.pending[proposal.id];
        save();
        return { written: 0, saved: false, reason: 'nothing-valid' };
    }

    delete data.pending[proposal.id];
    const saved = save();
    if (!saved) {
        // Put everything back exactly as it was, including the proposal, so the user can retry.
        try { data.entries = JSON.parse(snapshot); } catch (_) {}
        data.pending[proposal.id] = { requesterId: proposal.requesterId, createdAt: proposal.createdAt, entries: proposal.entries };
        return { written: 0, saved: false, reason: 'write-failed' };
    }
    return { written, saved: true };
}

/** Write one proposal entry to the store. Shared by approveOne and approveRemaining. */
function writeEntry(entry, approvedBy) {
    const data = load();
    data.entries[entry.ratingKey] = {
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        file: entry.file,
        moods: entry.moods,
        genres: entry.genres,
        styles: entry.styles,
        source: entry.source,
        note: entry.feedback || null,
        approvedBy: approvedBy || null,
        at: new Date().toISOString(),
        supersededAt: null
    };
}

/**
 * Approve a single track from a proposal. Each decision is written immediately, so a review
 * interrupted halfway keeps the songs already approved.
 *
 * @returns {{ok: boolean, reason?: string, entry?: Object}}
 */
function approveOne(id, index, approvedBy) {
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, reason: 'expired' };
    const entry = proposal.entries[index];
    if (!entry) return { ok: false, reason: 'no-such-track' };
    if (entry.status === 'approved') return { ok: true, entry };

    const data = load();
    const snapshot = JSON.stringify(data.entries);
    writeEntry(entry, approvedBy);
    data.pending[proposal.id].entries[index].status = 'approved';

    if (!save()) {
        try { data.entries = JSON.parse(snapshot); } catch (_) {}
        data.pending[proposal.id].entries[index].status = 'pending';
        return { ok: false, reason: 'write-failed' };
    }
    if (entry.feedback) recordFeedback(entry.ratingKey, entry.feedback, approvedBy, 'approved');
    return { ok: true, entry };
}

/**
 * Reject a single track. Nothing is written to the store, but the reason (when given) is
 * remembered so a future run can do better instead of proposing the same thing again.
 */
function rejectOne(id, index, by, feedbackText) {
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, reason: 'expired' };
    const entry = proposal.entries[index];
    if (!entry) return { ok: false, reason: 'no-such-track' };

    const data = load();
    data.pending[proposal.id].entries[index].status = 'rejected';
    if (feedbackText) data.pending[proposal.id].entries[index].feedback = cleanText(feedbackText, 500);
    save();
    recordFeedback(entry.ratingKey, feedbackText || null, by, 'rejected');
    return { ok: true, entry };
}

/** Approve everything still undecided in one go. */
function approveRemaining(id, approvedBy) {
    const proposal = getProposal(id);
    if (!proposal) return { written: 0, saved: false, reason: 'expired' };

    const data = load();
    const snapshot = JSON.stringify(data.entries);
    const flipped = [];
    for (let i = 0; i < proposal.entries.length; i++) {
        const entry = proposal.entries[i];
        if (entry.status !== 'pending') continue;
        writeEntry(entry, approvedBy);
        data.pending[proposal.id].entries[i].status = 'approved';
        flipped.push(i);
    }
    if (flipped.length === 0) return { written: 0, saved: true };

    if (!save()) {
        try { data.entries = JSON.parse(snapshot); } catch (_) {}
        // Only the entries this call approved. Reverting everything marked approved would also
        // undo decisions from earlier successful clicks, whose tags are still in the store.
        for (const i of flipped) data.pending[proposal.id].entries[i].status = 'pending';
        return { written: 0, saved: false, reason: 'write-failed' };
    }
    return { written: flipped.length, saved: true };
}

/** Replace a proposal entry's tags in place — used after a feedback-driven regeneration. */
function updateProposalEntry(id, index, patch) {
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, reason: 'expired' };
    const existing = proposal.entries[index];
    if (!existing) return { ok: false, reason: 'no-such-track' };

    const merged = sanitizeEntry({ ...existing, ...patch, status: 'pending' });
    if (!merged) return { ok: false, reason: 'nothing-usable' };

    load().pending[proposal.id].entries[index] = merged;
    save();
    return { ok: true, entry: merged };
}

/**
 * What the user has said about a track before. Fed back into later inference so a correction
 * only has to be made once.
 */
function recordFeedback(ratingKey, text, by, outcome) {
    if (!ratingKey) return false;
    const data = load();
    if (!data.feedback) data.feedback = {};
    const key = String(ratingKey);
    const previous = data.feedback[key] || {};
    data.feedback[key] = {
        text: cleanText(text, 500) || previous.text || null,
        outcome: outcome || previous.outcome || null,
        by: by || previous.by || null,
        at: new Date().toISOString()
    };
    return save();
}

function getFeedback(ratingKey) {
    return (load().feedback || {})[String(ratingKey)] || null;
}

/** Decision counts for the review card's progress line. */
function proposalSummary(id) {
    const proposal = getProposal(id);
    if (!proposal) return null;
    const counts = { total: proposal.entries.length, approved: 0, rejected: 0, pending: 0 };
    for (const e of proposal.entries) counts[e.status === 'approved' ? 'approved' : e.status === 'rejected' ? 'rejected' : 'pending']++;
    return counts;
}

/** Record that Plex now has official data, so the inferred entry stops being consulted. */
function supersede(ratingKey) {
    const entry = get(ratingKey);
    if (!entry || entry.supersededAt) return false;
    entry.supersededAt = new Date().toISOString();
    save();
    return true;
}

function forget(ratingKey) {
    const data = load();
    if (!data.entries[String(ratingKey)]) return false;
    delete data.entries[String(ratingKey)];
    return save();
}

function stats() {
    const entries = Object.values(load().entries).filter(Boolean);
    const active = entries.filter((e) => !e.supersededAt);
    const count = (dim) => active.reduce((n, e) => n + ((e[dim] || []).length), 0);
    return {
        tracks: entries.length,
        active: active.length,
        superseded: entries.length - active.length,
        pending: Object.keys(load().pending || {}).length,
        moods: count('moods'),
        genres: count('genres'),
        styles: count('styles'),
        withFilePath: active.filter((e) => e.file).length,
        file: FILE
    };
}

/** Newest first, for the review command. */
function list(limit = 10) {
    return Object.entries(load().entries)
        .filter(([, e]) => e)
        .map(([ratingKey, entry]) => ({ ratingKey, ...entry }))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, limit);
}

/** Every active entry, for export to tooling outside the bot. */
function activeEntries() {
    return Object.entries(load().entries)
        .filter(([, e]) => e && !e.supersededAt)
        .map(([ratingKey, entry]) => ({ ratingKey, ...entry }));
}

// exported for tests
function _reset() {
    store = null;
}

module.exports = {
    DIMENSIONS, PROPOSAL_TTL_MS, SETTING_DEFAULTS, getSettings, setSetting,
    load, save, get, missingDimensions, effectiveTags, findByTags,
    stage, getProposal, discard, approve, supersede, forget, stats, list, activeEntries,
    approveOne, rejectOne, approveRemaining, updateProposalEntry,
    recordFeedback, getFeedback, proposalSummary,
    sanitizeEntry, _reset, _file: FILE
};
