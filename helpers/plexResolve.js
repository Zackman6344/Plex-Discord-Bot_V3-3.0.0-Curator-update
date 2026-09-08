// helpers/plexResolve.js
//
// Find a track's current Plex part key again when the stored one has gone dead.
//
// A saved playlist stores `cle`, a part key of the form
// `/library/parts/<partId>/<updatedAt>/file.flac`. That key is only valid while the library row
// behind it is, and it stops being valid whenever the file moves: a re-scan, a re-import, or a
// drive changing letter. Nothing about the key survives that, so a playlist saved months ago is
// a list of paths into a library that has moved on.
//
// The stable half of a saved track is what a person would use to find it again: its title and
// artist. So the stored key stays the fast path, and this is the fallback when the fast path
// 404s.
//
// Plex answers a dead key with an HTML 404 rather than an error, which is why the caller has to
// check `response.ok` before trusting a stream. That check is the thing that turns "the queue
// silently drained in ten seconds" into "this track could not be fetched".

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger.js');

/** Case and punctuation insensitive, because a stored title and a Plex title rarely agree exactly. */
function normalise(text) {
    return String(text || '')
        .toLowerCase()
        // Apostrophes are DROPPED rather than turned into a separator, so "Don't Look Back" and
        // "Dont Look Back" agree. Turning them into a space split the word instead, giving
        // "don t look back", which matched neither spelling.
        .replace(/[‘’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Plex puts the performing artist in one of two fields depending on how the file was tagged. */
function artistOf(track) {
    return track.originalTitle || track.grandparentTitle || '';
}

function keyOf(track) {
    const media = track && track.Media && track.Media[0];
    const part = media && media.Part && media.Part[0];
    return (part && part.key) || null;
}

/**
 * Pick the track a saved entry meant, from what a search returned.
 *
 * Artist has to agree. A title alone is not enough to bet on: a search for "Daisy" comes back
 * with every cover and remix in the library, and picking the first would quietly queue the wrong
 * recording, which is worse than reporting the track as missing.
 *
 * @returns {Object|null} the matching track, or null when nothing is confidently right
 */
function bestMatch(tracks, wanted) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const title = normalise(wanted && wanted.title);
    const artist = normalise(wanted && wanted.artist);
    if (!title) return null;

    const withKey = tracks.filter(keyOf);
    const titled = withKey.filter(t => normalise(t.title) === title);

    // Title and artist both agree: the answer, even if several copies exist.
    const exact = titled.filter(t => artist && normalise(artistOf(t)) === artist);
    if (exact.length > 0) return exact[0];

    // No artist recorded on the saved entry, and exactly one track carries the title. Anything
    // more than one is ambiguous and gets refused.
    if (!artist && titled.length === 1) return titled[0];

    return null;
}

/**
 * Search Plex for a saved track and hand back its current part key.
 * @param {Object} bot   the Bot instance, for findTracksOnPlex
 * @param {{title: string, artist: string}} wanted
 * @returns {Promise<{key: string, title: string, artist: string}|null>}
 */
async function resolveKey(bot, wanted) {
    if (!bot || typeof bot.findTracksOnPlex !== 'function') return null;
    const title = wanted && wanted.title;
    if (!title) return null;

    try {
        // Searched on title alone. Plex's search is not reliable on "artist title" as one string,
        // and the artist is applied by bestMatch afterwards where it can be compared properly.
        const res = await bot.findTracksOnPlex(title, 0, 20, 10);
        const found = (res && res.MediaContainer && res.MediaContainer.Metadata) || [];
        const hit = bestMatch(Array.isArray(found) ? found : [found], wanted);
        if (!hit) return null;
        return { key: keyOf(hit), title: hit.title, artist: artistOf(hit) };
    } catch (err) {
        logger.warn(`Plex re-resolve failed for "${title}":`, err.message || err);
        return null;
    }
}

/**
 * Write a repaired key back into the playlist file it came from, so the search is paid once
 * rather than on every play.
 *
 * The file is re-read rather than rewritten from whatever the queue was built from: the queue is
 * a snapshot taken at play time, and the playlist may have been edited since. Only the entry
 * whose title and artist match is touched.
 *
 * Never throws. A repair that cannot be saved has already served its purpose, since playback is
 * using the new key regardless.
 * @returns {Promise<boolean>} whether the file was changed
 */
async function persistKey(playlistsDir, playlistName, wanted, newKey) {
    if (!playlistName || !newKey) return false;
    const file = path.join(playlistsDir, `${playlistName}.playlist`);

    try {
        const playlist = JSON.parse(await fs.readFile(file, 'utf8'));
        const entries = playlist && playlist.musiques;
        if (!Array.isArray(entries)) return false;

        const title = normalise(wanted && wanted.title);
        const artist = normalise(wanted && wanted.artist);
        let changed = false;
        for (const entry of entries) {
            if (normalise(entry.titre) !== title) continue;
            if (artist && normalise(entry.artiste) !== artist) continue;
            if (entry.cle === newKey) continue;
            entry.cle = newKey;
            changed = true;
        }
        if (!changed) return false;

        // Written through a sibling temp file and renamed, so an interrupted write cannot leave
        // a half-file where a playlist used to be.
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(playlist), 'utf8');
        await fs.rename(tmp, file);
        return true;
    } catch (err) {
        logger.warn(`Could not save the repaired key into ${playlistName}.playlist:`, err.message || err);
        return false;
    }
}

module.exports = { normalise, artistOf, keyOf, bestMatch, resolveKey, persistKey };
