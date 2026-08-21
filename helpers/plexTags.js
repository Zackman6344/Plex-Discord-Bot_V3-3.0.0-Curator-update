// helpers/plexTags.js
//
// Plex exposes mood/genre/style as *filters* on a music section, but never returns Mood or
// Style inline on a track in a section listing — only a direct /library/metadata/<key> fetch
// carries them. Scoring `item.Mood` off a listing therefore always scores against an empty
// array, no matter how well tagged the library is.
//
// Filtering server-side avoids that entirely: the vocabulary costs two queries, and each tag
// query returns only its own matching tracks (tens to hundreds) instead of the whole library.
// It also means every tag we attribute to a track is one Plex actually assigned, so anything
// downstream — including an LLM asked to justify its picks — is reasoning about real metadata.

const { getPlex } = require('./plexClient.js');
const logger = require('./logger.js');

const VOCAB_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TAG_LIMIT = 400;

let vocabCache = null; // { at, sectionKey, moods, genres, styles }

async function findMusicSection(plex) {
    const sections = await plex.query('/library/sections');
    const dirs = (sections.MediaContainer && sections.MediaContainer.Directory) || [];
    const music = dirs.find((s) => s.type === 'artist');
    return music ? music.key : null;
}

async function loadTagList(plex, sectionKey, kind) {
    try {
        const res = await plex.query(`/library/sections/${sectionKey}/${kind}?type=10`);
        const dirs = (res.MediaContainer && res.MediaContainer.Directory) || [];
        return dirs
            .filter((d) => d.title && d.key)
            .map((d) => ({ title: d.title, key: d.key }));
    } catch (err) {
        logger.warn(`Could not load ${kind} vocabulary from Plex:`, err.message || err);
        return [];
    }
}

/**
 * The tag vocabulary the music section actually has, cached for an hour. Callers get the exact
 * tag names Plex will accept, so a caller (or an LLM) can be held to a closed list instead of
 * inventing tags that match nothing.
 *
 * @returns {Promise<{sectionKey: string|null, moods: Array, genres: Array, styles: Array}>}
 */
async function getVocabulary(force = false) {
    if (!force && vocabCache && Date.now() - vocabCache.at < VOCAB_TTL_MS) return vocabCache;

    const plex = getPlex();
    const sectionKey = await findMusicSection(plex);
    if (!sectionKey) {
        vocabCache = { at: Date.now(), sectionKey: null, moods: [], genres: [], styles: [] };
        return vocabCache;
    }

    const [moods, genres, styles] = await Promise.all([
        loadTagList(plex, sectionKey, 'mood'),
        loadTagList(plex, sectionKey, 'genre'),
        loadTagList(plex, sectionKey, 'style')
    ]);

    vocabCache = { at: Date.now(), sectionKey, moods, genres, styles };
    return vocabCache;
}

/** Case-insensitive lookup of a tag name against a vocabulary list. */
function resolveTag(list, name) {
    if (!name) return null;
    const wanted = String(name).trim().toLowerCase();
    return list.find((t) => t.title.toLowerCase() === wanted) || null;
}

/**
 * Every track carrying the given tag. Returns [] rather than throwing so one bad tag can't
 * take down a whole multi-tag search.
 */
async function fetchTracksByTag(sectionKey, kind, tagKey, limit = DEFAULT_TAG_LIMIT) {
    try {
        const plex = getPlex();
        const res = await plex.query(
            `/library/sections/${sectionKey}/all?type=10&${kind}=${encodeURIComponent(tagKey)}` +
            `&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`
        );
        return (res.MediaContainer && res.MediaContainer.Metadata) || [];
    } catch (err) {
        logger.warn(`Plex ${kind} query failed for tag ${tagKey}:`, err.message || err);
        return [];
    }
}

/**
 * Resolve tag names against the vocabulary, fetch each one's tracks, and union them —
 * recording which of the requested tags each track actually matched.
 *
 * The per-track `matchedMoods` / `matchedGenres` are ground truth: the track is in the result
 * because Plex says it carries that tag.
 *
 * @param {string[]} moodNames  - tag names, matched case-insensitively against the vocabulary
 * @param {string[]} genreNames
 * @returns {Promise<{tracks: Array, usedMoods: string[], usedGenres: string[], unknown: string[]}>}
 */
async function fetchTracksByTags(moodNames = [], genreNames = []) {
    const vocab = await getVocabulary();
    if (!vocab.sectionKey) return { tracks: [], usedMoods: [], usedGenres: [], unknown: [] };

    const unknown = [];
    const wanted = [];
    for (const name of moodNames) {
        const tag = resolveTag(vocab.moods, name);
        tag ? wanted.push({ kind: 'mood', tag }) : unknown.push(name);
    }
    for (const name of genreNames) {
        const tag = resolveTag(vocab.genres, name);
        tag ? wanted.push({ kind: 'genre', tag }) : unknown.push(name);
    }

    const byKey = new Map();
    const usedMoods = new Set();
    const usedGenres = new Set();

    // Sequential on purpose: a few dozen tag queries at ~30-130ms each is quick, and hammering
    // Plex with them in parallel makes it slower, not faster.
    for (const { kind, tag } of wanted) {
        const tracks = await fetchTracksByTag(vocab.sectionKey, kind, tag.key);
        if (tracks.length) (kind === 'mood' ? usedMoods : usedGenres).add(tag.title);
        for (const track of tracks) {
            const id = track.ratingKey;
            if (!byKey.has(id)) byKey.set(id, { track, matchedMoods: [], matchedGenres: [] });
            const entry = byKey.get(id);
            (kind === 'mood' ? entry.matchedMoods : entry.matchedGenres).push(tag.title);
        }
    }

    return {
        tracks: [...byKey.values()],
        usedMoods: [...usedMoods],
        usedGenres: [...usedGenres],
        unknown
    };
}

// exported for tests
function _resetCache() {
    vocabCache = null;
}

module.exports = { getVocabulary, fetchTracksByTag, fetchTracksByTags, resolveTag, _resetCache };
