// helpers/tagSidecar.js
//
// A local store of AI-inferred track tags for the ~70% of the library Plex has no mood/genre
// data for. Nothing here writes to Plex: the sidecar is consulted *alongside* Plex, never
// instead of it.
//
// Precedence is absolute and per-dimension: if Plex has moods for a track, Plex's moods are the
// moods and the inferred ones are ignored — even if the sidecar has more of them. An inferred
// dimension that Plex later fills is marked superseded rather than deleted, so it's visible in
// `/tags list` what the agent has since taken over.
//
// Entries are only written after a human approves them (see stage/approve below), so a bad
// batch of guesses can never quietly become the library's metadata.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const FILE = path.join(__dirname, '..', 'data', 'inferred_tags.json');
const DIMENSIONS = ['moods', 'genres', 'styles'];
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

let store = null;                 // { version, entries: { [ratingKey]: entry } }
const proposals = new Map();      // id -> { id, requesterId, entries, createdAt }

function load() {
    if (store) return store;
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.entries) {
                store = parsed;
                return store;
            }
        }
    } catch (err) {
        // A corrupt sidecar must not stop the bot; it's an optional enrichment layer.
        logger.warn('Ignoring unreadable data/inferred_tags.json:', err.message || err);
    }
    store = { version: 1, entries: {} };
    return store;
}

function save() {
    const data = load();
    try {
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        logger.error('Could not write data/inferred_tags.json:', err.message || err);
        return false;
    }
}

function get(ratingKey) {
    const entry = load().entries[String(ratingKey)];
    return entry || null;
}

/**
 * Which tag dimensions Plex itself has nothing for on this track. Callers use this both to
 * decide what's worth inferring and to keep from proposing over real data.
 *
 * @param {Object} plexTrack - a track as returned by /library/metadata/<key>
 * @returns {string[]} subset of DIMENSIONS
 */
function missingDimensions(plexTrack) {
    const has = (field) => Array.isArray(plexTrack && plexTrack[field]) && plexTrack[field].length > 0;
    const present = { moods: has('Mood'), genres: has('Genre'), styles: has('Style') };
    return DIMENSIONS.filter((d) => !present[d]);
}

/**
 * The tags that should actually be used for a track: Plex's where Plex has any, the approved
 * inferred ones only where it doesn't. Also reports which dimensions came from the sidecar so
 * callers can label them honestly to the user.
 */
function effectiveTags(ratingKey, plexTrack) {
    const fromPlex = {
        moods: ((plexTrack && plexTrack.Mood) || []).map((t) => t.tag),
        genres: ((plexTrack && plexTrack.Genre) || []).map((t) => t.tag),
        styles: ((plexTrack && plexTrack.Style) || []).map((t) => t.tag)
    };
    const entry = get(ratingKey);
    const inferredDims = [];

    for (const dim of DIMENSIONS) {
        if (fromPlex[dim].length > 0) continue;
        if (entry && Array.isArray(entry[dim]) && entry[dim].length) {
            fromPlex[dim] = entry[dim].slice();
            inferredDims.push(dim);
        }
    }
    return { ...fromPlex, inferredDimensions: inferredDims };
}

/**
 * Approved inferred entries matching any of the requested tag names. This is what makes the
 * sidecar worth having: a track Plex never tagged can't come back from a Plex tag query, so
 * without this pass it stays invisible to tag-based search forever.
 */
function findByTags({ moods = [], genres = [], styles = [] } = {}) {
    const want = {
        moods: new Set(moods.map((m) => String(m).toLowerCase())),
        genres: new Set(genres.map((g) => String(g).toLowerCase())),
        styles: new Set(styles.map((s) => String(s).toLowerCase()))
    };
    const hits = [];

    for (const [ratingKey, entry] of Object.entries(load().entries)) {
        if (entry.supersededAt) continue;
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

/**
 * Hold a batch of proposed entries in memory until a human approves them. Nothing reaches disk
 * from here — `approve` is the only writer.
 *
 * @returns {string} short id used by the approve/discard buttons
 */
function stage(entries, requesterId) {
    const id = Math.random().toString(36).slice(2, 8);
    proposals.set(id, { id, requesterId, entries, createdAt: Date.now() });

    for (const [key, p] of proposals) {
        if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) proposals.delete(key);
    }
    return id;
}

function getProposal(id) {
    const p = proposals.get(id);
    if (!p) return null;
    if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) { proposals.delete(id); return null; }
    return p;
}

function discard(id) {
    return proposals.delete(id);
}

/**
 * Persist an approved batch. Existing entries are replaced wholesale so re-approving a track
 * is a correction rather than an append.
 *
 * @returns {{written: number, saved: boolean}}
 */
function approve(id, approvedBy) {
    const proposal = getProposal(id);
    if (!proposal) return { written: 0, saved: false };

    const data = load();
    let written = 0;
    for (const entry of proposal.entries) {
        if (!entry || !entry.ratingKey) continue;
        data.entries[String(entry.ratingKey)] = {
            title: entry.title || null,
            artist: entry.artist || null,
            album: entry.album || null,
            moods: entry.moods || [],
            genres: entry.genres || [],
            styles: entry.styles || [],
            source: entry.source || 'inferred',
            approvedBy: approvedBy || null,
            at: new Date().toISOString(),
            supersededAt: null
        };
        written++;
    }
    proposals.delete(id);
    return { written, saved: save() };
}

/**
 * Record that Plex has since supplied official data for a track, so the inferred entry stops
 * being consulted. Kept rather than deleted so it stays auditable.
 */
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
    save();
    return true;
}

function stats() {
    const entries = Object.values(load().entries);
    const active = entries.filter((e) => !e.supersededAt);
    const tagCount = (dim) => active.reduce((n, e) => n + ((e[dim] || []).length), 0);
    return {
        tracks: entries.length,
        active: active.length,
        superseded: entries.length - active.length,
        moods: tagCount('moods'),
        genres: tagCount('genres'),
        styles: tagCount('styles'),
        file: FILE
    };
}

/** Newest first, for the review command. */
function list(limit = 10) {
    return Object.entries(load().entries)
        .map(([ratingKey, entry]) => ({ ratingKey, ...entry }))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .slice(0, limit);
}

// exported for tests
function _reset() {
    store = null;
    proposals.clear();
}

module.exports = {
    DIMENSIONS,
    load, get, missingDimensions, effectiveTags, findByTags,
    stage, getProposal, discard, approve, supersede, forget, stats, list,
    _reset, _file: FILE
};
