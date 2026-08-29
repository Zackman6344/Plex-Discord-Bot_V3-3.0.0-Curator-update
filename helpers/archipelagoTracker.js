// helpers/archipelagoTracker.js
//
// Reads per-slot completion off a room's multiworld tracker page.
//
// Why scrape rather than ask the server: the network protocol has no way for a client to see
// another slot's locations. The read-only data storage keys cover hints, slot data, name groups,
// client status and race mode, and RoomUpdate's checked_locations is only ever the connected
// slot's. The Tracker tag grants no extra access. The web host's tracker is the only place the
// per-slot totals exist.
//
// The JSON API at /api/tracker/<id> was the obvious candidate and does not work for this: it
// gives player_checks_done (the ids checked) but no per-slot total to compare against, since the
// host computes that from the seed. The HTML table has both, in a "124/124" column.
//
// Everything here degrades to "no information" rather than throwing, because this is an
// enhancement to a filter and must never take the log relay down with it.

const USER_AGENT = 'PlexDiscordBot-ArchipelagoMonitor/1.0';
// The room page links both /tracker/<id> and a /tracker/<id>/<team>/<slot> per player, so the
// trailing path has to be optional or only the bare link would ever match.
const TRACKER_LINK = /href=["'][^"']*?\/tracker\/([A-Za-z0-9_-]{8,64})(?:\/[^"']*)?["']/i;

function stripTags(html) {
    return String(html)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&percnt;/gi, '%')
        .replace(/&amp;/gi, '&')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The multiworld tracker id linked from a room page. */
function extractTrackerId(html) {
    const match = TRACKER_LINK.exec(String(html || ''));
    return match ? match[1] : null;
}

/**
 * Rows of the tracker's player table.
 * Columns are located by their header text rather than by position, so a new column added to
 * the page shifts nothing here.
 * @returns {Array<{slot: number, name: string, checked: number, total: number, status: string}>}
 */
function parseTrackerRows(html) {
    const text = String(html || '');
    const headerBlock = /<thead[\s\S]*?<\/thead>/i.exec(text);
    if (!headerBlock) return [];

    const headers = [...headerBlock[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
        .map(m => stripTags(m[1]).toLowerCase());
    const slotCol = headers.findIndex(h => h === '#' || h === 'slot');
    const checksCol = headers.findIndex(h => h.startsWith('check'));
    const nameCol = headers.findIndex(h => h === 'name');
    const statusCol = headers.findIndex(h => h === 'status');
    if (slotCol === -1 || checksCol === -1) return [];

    const rows = [];
    for (const match of text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]));
        if (cells.length <= Math.max(slotCol, checksCol)) continue;

        const slot = Number(cells[slotCol]);
        const checks = /^(\d+)\s*\/\s*(\d+)$/.exec(cells[checksCol]);
        if (!Number.isInteger(slot) || !checks) continue;

        rows.push({
            slot,
            name: nameCol >= 0 ? cells[nameCol] : '',
            status: statusCol >= 0 ? cells[statusCol] : '',
            checked: Number(checks[1]),
            total: Number(checks[2])
        });
    }
    return rows;
}

/** Slots with every location checked, as a Set of "team:slot". */
function fullyCheckedSlots(rows, team = 0) {
    const out = new Set();
    for (const row of rows) {
        if (row.total > 0 && row.checked >= row.total) out.add(`${team}:${row.slot}`);
    }
    return out;
}

async function fetchText(url, timeoutMs) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/**
 * Resolve a room URL to its tracker and read per-slot completion from it.
 * @returns {Promise<{rows: Array, fullyChecked: Set<string>, trackerUrl: string}>}
 */
async function readCompletion(roomUrl, options = {}) {
    const team = options.team || 0;
    const timeoutMs = options.timeoutMs || 30000;

    let trackerUrl = options.trackerUrl;
    if (!trackerUrl) {
        const roomHtml = await fetchText(roomUrl, timeoutMs);
        const id = extractTrackerId(roomHtml);
        if (!id) throw new Error('no tracker linked from the room page');
        trackerUrl = `${new URL(roomUrl).origin}/tracker/${id}`;
    }

    const rows = parseTrackerRows(await fetchText(trackerUrl, timeoutMs));
    if (rows.length === 0) throw new Error('could not read the tracker table');

    return { rows, fullyChecked: fullyCheckedSlots(rows, team), trackerUrl };
}

module.exports = { extractTrackerId, parseTrackerRows, fullyCheckedSlots, readCompletion };
