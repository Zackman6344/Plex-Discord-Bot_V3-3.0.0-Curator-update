// helpers/leaderboard.js
//
// One ranked-list renderer, so the bot presents rankings the same way everywhere.
//
// There are five hand-rolled copies of this in commands/ and they already disagree: reviewbomb,
// badplot and castingcouch use 🏅 from fourth place, hitster uses 🔹, and the Archipelago
// leaderboard used a bare "4." until it was moved onto this. Only the Archipelago one calls in so
// far. The other four are untested and each embeds the medal inside its own larger rendering, so
// they are deliberately left where they are; move one onto this the next time it is touched
// rather than in a pass of its own.

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * The marker for one zero-based rank.
 * Past third it is the position, not a medal. A ranked list whose entries below the podium are
 * all an identical 🏅 cannot be read as a ranking at all: fourth and twelfth look the same, and
 * ties give no order. The four game commands still use a flat 🏅 there; this is the shape they
 * should move to when one of them is next touched.
 */
function medal(index) {
    return MEDALS[index] || `${index + 1}.`;
}

/**
 * Render a ranked list, most first.
 * @param {Array} rows already sorted
 * @param {(row: any, index: number) => string} format the text after the medal
 * @param {{limit?: number, empty?: string}} [options]
 * @returns {string[]} one line per row, plus an overflow line when `limit` cuts it short
 */
function renderBoard(rows, format, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : rows.length;
    const shown = rows.slice(0, limit);
    const lines = shown.map((row, index) => `${medal(index)} ${format(row, index)}`);
    if (rows.length > shown.length) lines.push(`…and ${rows.length - shown.length} more.`);
    return lines;
}

module.exports = { medal, renderBoard, MEDALS };
