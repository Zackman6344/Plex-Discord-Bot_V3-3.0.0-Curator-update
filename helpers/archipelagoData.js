// helpers/archipelagoData.js
//
// Disk cache for Archipelago data packages, keyed by (game, checksum).
//
// A data package is the id → name table for one game's items and locations. Some games
// ship tables in the megabytes, and every reconnect would otherwise re-download all of
// them for every game in the multiworld. The AP protocol hands out a checksum per game
// in RoomInfo precisely so clients can skip that: same checksum means the cached copy is
// still valid, and the file name carries the checksum so a stale copy can never be
// mistaken for a fresh one.
//
// Cache files live at data/archipelago/datapackage/<game>-<checksum>.json and are
// disposable — delete any of them and the next connect re-fetches.

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger.js');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'archipelago', 'datapackage');

// Game names are arbitrary strings from the multiworld ("Ocarina of Time", "Zillion")
// and end up in a file name, so anything path-significant has to go.
function safeName(text) {
    return String(text || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^[._]+/, '')
        .substring(0, 80) || 'unknown';
}

function cacheFilePath(game, checksum) {
    return path.join(CACHE_DIR, `${safeName(game)}-${safeName(checksum).substring(0, 40)}.json`);
}

// The wire format is name → id; every lookup we do goes the other way.
function invert(nameToId) {
    const out = new Map();
    if (!nameToId || typeof nameToId !== 'object') return out;
    for (const [name, id] of Object.entries(nameToId)) {
        out.set(Number(id), name);
    }
    return out;
}

// Returns { items: Map<id,name>, locations: Map<id,name> } or null on a miss.
async function load(game, checksum) {
    if (!checksum) return null;
    try {
        const raw = await fs.readFile(cacheFilePath(game, checksum), 'utf8');
        const parsed = JSON.parse(raw);
        return {
            items: invert(parsed.item_name_to_id),
            locations: invert(parsed.location_name_to_id)
        };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            logger.warn(`Archipelago data package cache read failed for "${game}":`, err.message);
        }
        return null;
    }
}

// Cache write failures are never fatal — the in-memory tables are already populated by
// the time we get here, so a full disk costs a re-download next boot and nothing else.
async function save(game, checksum, gameData) {
    if (!checksum || !gameData) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        const payload = {
            item_name_to_id: gameData.item_name_to_id || {},
            location_name_to_id: gameData.location_name_to_id || {},
            checksum
        };
        await fs.writeFile(cacheFilePath(game, checksum), JSON.stringify(payload), 'utf8');
    } catch (err) {
        logger.warn(`Archipelago data package cache write failed for "${game}":`, err.message);
    }
}

module.exports = { CACHE_DIR, safeName, cacheFilePath, invert, load, save };
