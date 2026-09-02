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
const REST = '🏅';

/** The marker for one zero-based rank. */
function medal(index) {
    return MEDALS[index] || REST;
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

module.exports = { medal, renderBoard, MEDALS, REST };
