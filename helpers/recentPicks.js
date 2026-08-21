// helpers/recentPicks.js
//
// Short memory of which tracks the AI-curated commands have already served, so a library's
// well-tagged minority doesn't become the only music anyone ever hears. Tag-based selection is
// inherently biased toward whatever is tagged; without this, the same few hundred tracks win
// every single run.
//
// Deliberately a *penalty*, not a ban: a track that genuinely is the best match for a request
// should still be able to win, it just has to beat a handicap. Anything else would mean asking
// twice for the same vibe and getting worse music the second time.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

// Overridable so a test run uses its own file rather than the live rotation memory.
const FILE = process.env.PLEXBOT_RECENT_PICKS_FILE || path.join(__dirname, '..', 'data', 'recent_picks.json');
const TMP = FILE + '.tmp';
const DEFAULT_MEMORY = 300;

let store = null; // { version, picks: { [ratingKey]: isoTimestamp } }

function load() {
    if (store) return store;
    try {
        if (fs.existsSync(FILE)) {
            const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            if (parsed && parsed.picks && typeof parsed.picks === 'object') {
                store = { version: parsed.version || 1, picks: parsed.picks };
                return store;
            }
        }
    } catch (err) {
        logger.warn('Could not read data/recent_picks.json — starting fresh:', err.message || err);
    }
    store = { version: 1, picks: {} };
    return store;
}

function save() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(TMP, JSON.stringify(load(), null, 2));
        fs.renameSync(TMP, FILE);
        return true;
    } catch (err) {
        // Rotation is a nicety; failing to persist it must never break playback.
        logger.warn('Could not write data/recent_picks.json:', err.message || err);
        try { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); } catch (_) {}
        return false;
    }
}

/** Newest-first list of remembered rating keys. */
function keys() {
    return Object.entries(load().picks)
        .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
        .map(([k]) => k);
}

/**
 * How recently a track was served, as a 0..1 figure: 1 = most recent thing played, 0 = not in
 * memory at all. Callers turn this into whatever penalty suits their scoring.
 */
function recency(ratingKey, memory = DEFAULT_MEMORY) {
    if (!ratingKey) return 0;
    const ordered = keys();
    const idx = ordered.indexOf(String(ratingKey));
    if (idx === -1) return 0;
    const window = Math.max(1, Math.min(memory, ordered.length));
    if (idx >= window) return 0;
    return 1 - (idx / window);
}

function wasRecentlyPicked(ratingKey, memory = DEFAULT_MEMORY) {
    return recency(ratingKey, memory) > 0;
}

/**
 * Remember a batch of tracks, trimming to the configured memory size (newest kept).
 * A memory of 0 disables rotation entirely and clears what's stored.
 */
function record(ratingKeys = [], memory = DEFAULT_MEMORY) {
    const data = load();
    if (memory <= 0) {
        data.picks = {};
        save();
        return 0;
    }

    const now = Date.now();
    let i = 0;
    for (const rk of ratingKeys) {
        if (!rk) continue;
        // Stagger by index so a single batch keeps its internal order when sorted.
        data.picks[String(rk)] = new Date(now + (i++)).toISOString();
    }

    const ordered = keys();
    if (ordered.length > memory) {
        for (const stale of ordered.slice(memory)) delete data.picks[stale];
    }
    save();
    return Object.keys(data.picks).length;
}

function stats(memory = DEFAULT_MEMORY) {
    const ordered = keys();
    return { remembered: ordered.length, memory, file: FILE };
}

function clear() {
    load().picks = {};
    return save();
}

// exported for tests
function _reset() {
    store = null;
}

module.exports = { load, record, recency, wasRecentlyPicked, keys, stats, clear, DEFAULT_MEMORY, _reset, _file: FILE };
