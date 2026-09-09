// helpers/archipelagoSpheres.js
//
// Which of a slot's unchecked locations became reachable earliest.
//
// A sphere is a generation-time idea: sphere 1 is reachable with nothing, sphere 2 needs sphere
// 1's items, and so on. Nothing in the network protocol carries it.
//
// **The item is never read.** The source names the item at every location, and is parsed so that
// column is dropped where it is read rather than carried around and filtered later. The
// suggestion is "this location came up earliest", never "this location is worth your time",
// because the second sentence is the spoiler.
//
// **The web sphere tracker cannot answer this, and that was measured rather than assumed.**
// `/sphere_tracker/<id>` looks like the obvious source and is not one: it lists only locations
// that have ALREADY been checked. Across the room this was built against, every slot's row count
// equalled its checked count exactly, and so did the totals, 13,768 against 13,768. DaveSMetroid
// had 87 rows for 87 checks with 13 locations unchecked and absent. It is a record of what has
// been found, sphere by sphere, so asking it what to do next can only ever answer "nothing".
//
// That leaves the seed's spoiler log, whose Playthrough section lists placements whether or not
// anyone has reached them. A spoiler has to be supplied per multiworld for this to work at all.
//
// The Playthrough lists only the placements the seed's completion depends on, so suggestions are
// few and every one of them is load-bearing. They are ordered by nothing but the sphere number.

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger.js');

/**
 * Rows from a spoiler log's Playthrough section.
 *
 * The format each sphere is written in is:
 *
 *   1: {
 *     <Location> (<Finder>): <Item> (<Receiver>)
 *   }
 *
 * The line is split at the finder's closing bracket, and everything past it is discarded unread.
 * A location name containing its own brackets is why the finder is matched as a bracketed run
 * with no brackets inside it, rather than by taking the last pair on the line.
 * @returns {Array<{sphere: number, finder: string, location: string}>}
 */
function parsePlaythrough(text) {
    const body = String(text || '');
    const start = body.indexOf('Playthrough:');
    if (start === -1) return [];

    const rows = [];
    let sphere = null;
    for (const raw of body.slice(start).split(/\r?\n/)) {
        const header = /^\s*(\d+):\s*\{/.exec(raw);
        if (header) {
            sphere = Number(header[1]);
            continue;
        }
        if (/^\s*\}/.test(raw)) {
            sphere = null;
            continue;
        }
        if (sphere === null) continue;

        const entry = /^\s+(.+?)\s+\(([^()]+)\):\s/.exec(raw);
        if (!entry) continue;
        rows.push({ sphere, finder: entry[2].trim(), location: entry[1].trim() });
    }
    return rows;
}

/**
 * The earliest sphere a slot still has unchecked locations in, and those locations.
 *
 * Only the earliest is returned rather than a ranked list of everything: a slot part-way through
 * a big game has hundreds of unchecked locations, and "here are the ones you could have reached
 * first" is a shorter and more actionable answer than an ordering of all of them.
 *
 * @param {Array} rows        sphere rows from the spoiler
 * @param {Set<string>} checked  location names already checked, compared case-insensitively
 * @param {string} finder     the slot to answer for
 * @returns {{sphere: number, locations: string[], remaining: number}|null}
 */
function earliestUnchecked(rows, checked, finder) {
    const want = String(finder || '').trim().toLowerCase();
    if (!want) return null;

    const done = new Set([...(checked || [])].map(name => String(name).trim().toLowerCase()));
    const open = (rows || []).filter(r =>
        String(r.finder || '').trim().toLowerCase() === want &&
        !done.has(String(r.location || '').trim().toLowerCase()));
    if (open.length === 0) return null;

    const sphere = Math.min(...open.map(r => r.sphere));
    const locations = open.filter(r => r.sphere === sphere).map(r => r.location).sort();
    return { sphere, locations, remaining: open.length };
}

/** Where a hand-supplied spoiler for one multiworld is looked for. */
function spoilerPath(spoilerDir, seed) {
    return path.join(spoilerDir, `${String(seed || '').replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`);
}

/**
 * Sphere rows for a multiworld, from the spoiler supplied for it.
 * @returns {Promise<{rows: Array, source: 'spoiler', path: string}|null>} null when there is no
 *   usable spoiler, which is the only reason this can fail and the only thing a caller can act on
 */
async function loadSpheres({ seed, spoilerDir }) {
    if (!spoilerDir || !seed) return null;
    const file = spoilerPath(spoilerDir, seed);

    try {
        const rows = parsePlaythrough(await fs.readFile(file, 'utf8'));
        if (rows.length > 0) return { rows, source: 'spoiler', path: file };
        logger.warn(`${file} has no readable Playthrough section`);
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn(`Could not read ${file}:`, err.message);
    }
    return null;
}

module.exports = {
    parsePlaythrough,
    earliestUnchecked,
    spoilerPath,
    loadSpheres
};
