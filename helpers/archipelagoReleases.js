// helpers/archipelagoReleases.js
//
// The slots each watch has heard released, per seed, so a release outlives a restart of the bot.
//
// A release reaches the bot once, as a live PrintJSON, and the server keeps no record of it to read
// back. Without this file a restart forgot every one, and a slot the host released without a goal
// read as still playing to `!ap next` and to `!ap nexthide`, which in a seed that collects on goal
// is most of what that setting has to leave out.
//
// This is the only copy, so the store is durable (fsync before the rename, and an hourly `.bak` to
// fall back on), unlike the catch-up record, whose loss costs a silent baseline. It is written only
// when a release is new, a handful of times a seed.

const path = require('path');
const { createStore } = require('./jsonStore.js');

const store = createStore({
	envVar: 'PLEXBOT_AP_RELEASES_FILE',
	defaultPath: path.join(__dirname, '..', 'data', 'archipelago_releases.json'),
	key: 'released',
	shape: 'object',
	label: 'release',
	// Keys carry a server-supplied seed name.
	nullPrototype: true,
	durable: true
});
const RELEASES_FILE = store.file;

function recordKey(watchId, seed) {
	return `${Number(watchId)}::${String(seed)}`;
}

// Slot 0 is the server itself, and Number() turns null, false and '' into it.
function slotNumber(value) {
	const n = typeof value === 'string' ? Number(value) : value;
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** The slot numbers this watch heard released on this seed. */
function heard(watchId, seed) {
	const list = store.load()[recordKey(watchId, seed)];
	return new Set(Array.isArray(list) ? list.map(slotNumber).filter(n => n !== null) : []);
}

/**
 * Add the slots heard released, writing at once if any is new.
 * @param {Iterable<number>} slots slot numbers on the watch's team
 * @returns {boolean} false only when something new could not be written; memory then stays as the
 *   file is, so the two never disagree
 */
function note(watchId, seed, slots) {
	const all = store.load();
	const key = recordKey(watchId, seed);
	const have = heard(watchId, seed);
	const before = have.size;
	for (const slot of slots || []) {
		const n = slotNumber(slot);
		if (n !== null) have.add(n);
	}
	if (have.size === before) return true;
	const previous = all[key];
	all[key] = [...have].sort((a, b) => a - b);
	if (store.persist()) return true;
	if (previous === undefined) delete all[key];
	else all[key] = previous;
	return false;
}

/**
 * Drop every seed's list for a watch, for when the watch itself goes. Its id can name another room
 * later: #0 passes to whatever room /config names next.
 * @returns {number} how many lists went
 */
function forgetWatch(watchId) {
	const all = store.load();
	const prefix = `${Number(watchId)}::`;
	const gone = Object.keys(all).filter(key => key.startsWith(prefix));
	if (gone.length === 0) return 0;
	const saved = gone.map(key => [key, all[key]]);
	for (const key of gone) delete all[key];
	if (store.persist()) return gone.length;
	for (const [key, list] of saved) all[key] = list;
	return 0;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
const reset = store.reset;

module.exports = { heard, note, forgetWatch, reset, RELEASES_FILE };
