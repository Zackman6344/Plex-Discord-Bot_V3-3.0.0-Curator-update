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
// There are two sources, and they are not close in quality.
//
// **The multiworld's own sphere table, which is the good one.** Generation already worked all of
// this out and wrote it into the .archipelago multidata as a top-level `spheres` field: a list of
// spheres, each mapping player to the location ids that become reachable in it, covering EVERY
// location rather than only the progression ones. `scripts/extract-spheres.py` lifts it out into
// `data/archipelago/spheres/<seed_name>.json`. It is keyed by location id, which is also what the
// room's tracker reports, so nothing has to be matched by name. It needs the multidata, so it is
// available only for a multiworld generated on this machine.
//
// **The seed's spoiler log, which is the fallback.** Its Playthrough section lists placements
// whether or not anyone has reached them, but only the placements the seed's completion depends
// on. On the room this was built against that is 1,728 rows against 14,783 locations -- 11.7%,
// and 8% for one slot, whose 43 known locations ran out while 41 sat open and reachable. It is
// what there is for a room somebody else generated, and it is thin.
//
// Either way the answer is ordered by nothing but the sphere number, and held back to what the
// slot has shown it can reach.

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

    return reachOver(
        mine.map(r => ({ sphere: r.sphere, key: r.location })),
        entry => done.has(String(entry.key).trim().toLowerCase())
    );
}

/**
 * The same question against the multidata's sphere table for one slot.
 *
 * @param {Object} table  `{ "<sphere>": [locationId, ...] }`, as extract-spheres.py writes it
 * @param {Set<number>} checkedIds  location ids the tracker reports checked for this slot
 * @returns {Object|null} the shape soonestInLogic returns, with `locations` holding ids
 */
function soonestFromTable(table, checkedIds) {
    if (!table) return null;
    const done = new Set([...(checkedIds || [])].map(Number));

    const entries = [];
    for (const [sphere, ids] of Object.entries(table)) {
        for (const id of ids || []) entries.push({ sphere: Number(sphere), key: Number(id) });
    }
    if (entries.length === 0) return null;

    return reachOver(entries, entry => done.has(entry.key));
}

/**
 * The reach rule, in whatever currency the caller's keys are.
 *
 * Spheres are a property of the whole multiworld, not of one player's progress, so a slot's
 * lowest unchecked sphere can be one it has no way into yet: the items that open it are still in
 * somebody else's world. What is knowable without re-running the seed's logic is how far the slot
 * has demonstrably got. **If a location in sphere N has been checked, sphere N was reachable**,
 * and spheres are ordered by what they require, so everything at or below N is too. That highest
 * checked sphere is the reach.
 *
 * It is a floor, not the true frontier: a slot that has just received the item opening its next
 * sphere is held back until it checks something there. Erring that way is deliberate, because a
 * suggestion you cannot act on is the failure worth avoiding. A slot that has checked nothing has
 * a reach of 1, which needs nothing by definition.
 */
function reachOver(entries, isDone) {
    const cleared = entries.filter(isDone).map(e => e.sphere);
    const reach = cleared.length > 0 ? Math.max(...cleared) : 1;

    const open = entries.filter(e => !isDone(e));
    const reachable = open.filter(e => e.sphere <= reach);
    if (reachable.length === 0) {
        return open.length === 0 ? null
            : { sphere: null, locations: [], remaining: 0, reach, beyond: open.length };
    }

    const sphere = Math.min(...reachable.map(e => e.sphere));
    const locations = reachable.filter(e => e.sphere === sphere).map(e => e.key)
        .sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
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

/** Where the extracted sphere table for one multiworld is looked for. */
function spherePath(sphereDir, seed) {
    return path.join(sphereDir, `${String(seed || '').replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

/**
 * The multidata sphere table, if one has been extracted for this seed.
 * @returns {Promise<{slots: Object, source: 'multidata', path: string}|null>}
 */
async function loadSphereTable({ seed, sphereDir }) {
    if (!sphereDir || !seed) return null;
    const file = spherePath(sphereDir, seed);

    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        const slots = parsed && parsed.slots;
        // An object with no slots is a file that was written wrong, not a multiworld with no
        // locations. Falling through to the spoiler is better than answering "nothing left" for
        // every slot in the room.
        if (slots && Object.keys(slots).length > 0) {
            return { slots, source: 'multidata', path: file, slotNames: parsed.slotNames || {} };
        }
        logger.warn(`${file} carries no slots`);
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn(`Could not read ${file}:`, err.message);
    }
    return null;
}

/**
 * Sphere data for a multiworld, preferring the multidata table over the spoiler.
 *
 * The order matters and is not a tie-break: the multidata covers every location and the spoiler
 * covers the tenth of them the seed's completion depends on. A spoiler left in place next to an
 * extracted table is simply ignored.
 *
 * @returns {Promise<Object|null>} null when neither source is present, which is the only reason
 *   this can fail and the only thing a caller can act on
 */
async function loadSpheres({ seed, spoilerDir, sphereDir }) {
    const table = await loadSphereTable({ seed, sphereDir });
    if (table) return table;

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
    soonestFromTable,
    spoilerPath,
    spherePath,
    loadSphereTable,
    loadSpheres
};
