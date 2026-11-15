// test/fixtures/apmedia/songsSlotData.js
// slot_data_mixed.json as world 0.4.0 writes the same list at songs_per_unlock 3, for game tests of a
// playlist whose parts share one unlock: Road Trip's two parts (3 songs, then 1) both open through
// 'Road Trip: Next 3 Songs', part 1 with its first copy and part 2 with its second.
// apworld/tests/test_pure.py holds it equal to the slot_data the world's own modules write for that
// list (test_the_bots_songs_fixture_is_what_the_world_writes), unit ids included.

const FIXTURE = require('./slot_data_mixed.json');

/**
 * A fresh copy on every call.
 * @param {object} [changes] top-level keys laid over it
 * @returns {object}
 */
function songsSlotData(changes = {}) {
	const sd = JSON.parse(JSON.stringify(FIXTURE));
	const parts = sd.entries.filter((e) => e.k === 'mix').sort((a, b) => a.part - b.part);
	const shared = parts[0].u;
	const dropped = parts.slice(1).map((e) => e.u);
	// The registry numbers units in unit-key order, so every unit after a dropped part's moves down one.
	const renumber = (id) => id - dropped.filter((d) => d < id).length;
	parts.forEach((e, i) => {
		e.u = shared;
		e.s = i + 1;
	});
	sd.units = sd.units
		.filter((u) => !dropped.includes(u.id))
		.map((u) => (u.id === shared ? { ...u, name: 'Road Trip: Next 3 Songs', steps: parts.length } : u));
	for (const u of sd.units) u.id = renumber(u.id);
	for (const e of sd.entries) e.u = renumber(e.u);
	sd.songs_per_unlock = 3;
	return { ...sd, ...changes };
}

module.exports = { songsSlotData };
