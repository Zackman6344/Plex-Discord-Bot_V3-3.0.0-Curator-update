// helpers/archipelagoSpheres.js
//
// Sphere data for a seed: where it comes from, and the sphere 1 fallback `!ap next` uses when the
// seed's own logic is unavailable.
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
// Neither says what is in logic past sphere 1; only the seed's rules can (archipelagoLogic.js).
// These answer `!ap next` with sphere 1 alone when those rules cannot be had.

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
 * Sphere 1 of one slot, for when the seed's own logic cannot be had (see archipelagoLogic.js).
 *
 * Sphere 1 is what generation found reachable with nothing but the starting inventory, so it is
 * the one sphere every slot can always enter. Nothing past it can be vouched for without the
 * rules: spheres describe the whole multiworld, so a slot's sphere 2 waits on items that may sit
 * in any world, and which of them each location needs is exactly what the rules say. The rule
 * this replaced took "checked something in sphere N" to mean everything up to N was open. On the
 * 79-slot room it was built against, that listed 11,409 locations whose items had not arrived.
 *
 * @param {Array} rows        sphere rows from the spoiler
 * @param {Set<string>} checked  location names already checked, compared case-insensitively
 * @param {string} finder     the slot to answer for
 * @param {Function} [isLocation]  whether a name is a real location in the finder's game. The
 *   Playthrough also lists events (boss kills, goals), which no tracker ever reports checked;
 *   without a data package to tell them apart they are left in.
 * @returns {{locations: string[], open: number}|null} `open` counts every unchecked row for the
 *   slot; null when the spoiler has no row for it at all
 */
function sphereOneFromRows(rows, checked, finder, isLocation) {
    const want = String(finder || '').trim().toLowerCase();
    if (!want) return null;

    const done = new Set([...(checked || [])].map(name => String(name).trim().toLowerCase()));
    const mine = (rows || []).filter(r => String(r.finder || '').trim().toLowerCase() === want
        && (!isLocation || isLocation(r.location)));
    if (mine.length === 0) return null;

    const open = mine.filter(r => !done.has(String(r.location).trim().toLowerCase()));
    return {
        locations: open.filter(r => r.sphere === 1).map(r => r.location).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        open: open.length
    };
}

/**
 * The same, from the multidata's sphere table for one slot.
 *
 * @param {Object} table  `{ "<sphere>": [locationId, ...] }`, as extract-spheres.py writes it
 * @param {Set<number>} checkedIds  location ids the tracker reports checked for this slot
 * @returns {{locations: number[], open: number}|null} ids in numeric order
 */
function sphereOneFromTable(table, checkedIds) {
    if (!table) return null;
    const done = new Set([...(checkedIds || [])].map(Number));

    let any = false;
    let open = 0;
    const locations = [];
    for (const [sphere, ids] of Object.entries(table)) {
        for (const raw of ids || []) {
            any = true;
            const id = Number(raw);
            if (done.has(id)) continue;
            open += 1;
            if (Number(sphere) === 1) locations.push(id);
        }
    }
    if (!any) return null;
    return { locations: locations.sort((a, b) => a - b), open };
}

/** Where a hand-supplied spoiler for one multiworld is looked for. */
function spoilerPath(spoilerDir, seed) {
    return path.join(spoilerDir, `${String(seed || '').replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`);
}

/** Where the extracted sphere table for one multiworld is looked for. */
function spherePath(sphereDir, seed) {
    return path.join(sphereDir, `${String(seed || '').replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

/** The fingerprint of a seed with no sphere source on disk at all. */
const NO_SOURCES = 'table:-|spoiler:-';

/**
 * Which source outranks which, the same order loadSpheres prefers them in. The multidata table
 * covers every location and the spoiler about a tenth, so a load that comes back with a lower
 * rank than the record already held has fallen back, not improved.
 */
function sourceRank(source) {
    return source === 'multidata' ? 2 : source === 'spoiler' ? 1 : 0;
}

/**
 * Whether a fingerprint shows the file behind one particular source on disk.
 *
 * What decides between "a file is mid-copy, keep what is held" and "the file was deleted, stop
 * answering from it" is the held record's OWN file, not whether anything at all is present: a
 * deleted table sitting beside an unusable spoiler is still a deleted table.
 */
function sourcePresent(fingerprint, source) {
    const half = source === 'multidata' ? 'table' : 'spoiler';
    const match = new RegExp(`(?:^|\|)${half}:([^|]*)`).exec(String(fingerprint || ''));
    return Boolean(match && match[1] && match[1] !== '-');
}

/**
 * What the sphere sources for a seed look like on disk right now, as one comparable string.
 *
 * A caller holding loaded sphere data compares this against the value it had when it loaded, and
 * reloads only when it moved: a better source arriving, a re-extracted table, a file removed. Two
 * stats rather than two reads, so it costs nothing to ask on every command.
 *
 * Size and modification time together. Either alone misses a case: a re-extraction of an edited
 * seed can land on the same size, and a copy tool can preserve the original modification time.
 * A file that cannot be statted reads as absent, which is also what loading it would conclude.
 *
 * @returns {Promise<string>} never throws
 */
async function sourceFingerprint({ seed, sphereDir, spoilerDir }) {
    const one = async (dir, pathFor) => {
        if (!dir || !seed) return '-';
        try {
            const stat = await fs.stat(pathFor(dir, seed));
            return `${stat.size}@${stat.mtimeMs}`;
        } catch (_) {
            return '-';
        }
    };
    const [table, spoiler] = await Promise.all([one(sphereDir, spherePath), one(spoilerDir, spoilerPath)]);
    return `table:${table}|spoiler:${spoiler}`;
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
    sphereOneFromRows,
    sphereOneFromTable,
    spoilerPath,
    spherePath,
    sourceFingerprint,
    sourceRank,
    sourcePresent,
    NO_SOURCES,
    loadSphereTable,
    loadSpheres
};
