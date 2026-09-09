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
// few and every one of them is load-bearing. They are ordered by nothing but the sphere number,
// and held back to what the slot has shown it can reach.

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
 * The soonest locations a slot can actually reach right now.
 *
 * "Earliest unchecked sphere" is the wrong answer on its own. Spheres are a property of the
 * whole multiworld, not of one player's progress: a slot's lowest unchecked sphere can be one it
 * has no way into yet, because the items that open it are still sitting in somebody else's
 * world. Pointing someone at a location they cannot see is worse than saying nothing.
 *
 * What is knowable without the seed's logic rules is how far the slot has demonstrably got.
 * **If a location in sphere N has been checked, sphere N was reachable**, and spheres are ordered
 * by what they require, so everything at or below N is reachable too. That highest checked sphere
 * is the reach, and only unchecked locations at or below it are offered.
 *
 * It is a floor, not the true frontier. A slot may have just received the item opening the next
 * sphere and not checked anything there yet, in which case that sphere is held back until it
 * does. Erring that way is deliberate: a suggestion you cannot act on is the failure worth
 * avoiding.
 *
 * A slot that has checked nothing has a reach of sphere 1, which needs nothing by definition.
 *
 * @param {Array} rows        sphere rows from the spoiler
 * @param {Set<string>} checked  location names already checked, compared case-insensitively
 * @param {string} finder     the slot to answer for
 * @returns {{sphere: number, locations: string[], remaining: number, reach: number,
 *   beyond: number}|null} `remaining` counts what is open within reach, `beyond` what is open
 *   past it, so a caller can say "nothing you can reach yet" rather than "nothing left"
 */
function soonestInLogic(rows, checked, finder) {
    const want = String(finder || '').trim().toLowerCase();
    if (!want) return null;

    const done = new Set([...(checked || [])].map(name => String(name).trim().toLowerCase()));
    const mine = (rows || []).filter(r => String(r.finder || '').trim().toLowerCase() === want);
    if (mine.length === 0) return null;

    const isDone = r => done.has(String(r.location || '').trim().toLowerCase());
    const cleared = mine.filter(isDone).map(r => r.sphere);
    const reach = cleared.length > 0 ? Math.max(...cleared) : 1;

    const open = mine.filter(r => !isDone(r));
    const reachable = open.filter(r => r.sphere <= reach);
    if (reachable.length === 0) {
        return open.length === 0 ? null
            : { sphere: null, locations: [], remaining: 0, reach, beyond: open.length };
    }

    const sphere = Math.min(...reachable.map(r => r.sphere));
    const locations = reachable.filter(r => r.sphere === sphere).map(r => r.location).sort();
    return {
        sphere,
        locations,
        remaining: reachable.length,
        reach,
        beyond: open.length - reachable.length
    };
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
    soonestInLogic,
    spoilerPath,
    loadSpheres
};
