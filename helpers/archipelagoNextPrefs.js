// helpers/archipelagoNextPrefs.js
//
// What each person has chosen for their own `!ap next`. Kept per Discord user rather than on a
// claim, because it is about how somebody wants to be answered, across every slot and room they play.
//
// One choice so far, `hideFinished`: leave out the checks whose items go to slots that have goaled
// or released (`!ap nexthide`). It is the one part of `!ap next` that depends on what a location
// holds, which the command otherwise never reads, so nobody has it until they turn it on themselves.

const path = require('path');
const { createStore } = require('./jsonStore.js');

const store = createStore({
	envVar: 'PLEXBOT_AP_NEXT_FILE',
	defaultPath: path.join(__dirname, '..', 'data', 'archipelago_next.json'),
	key: 'users',
	shape: 'object',
	label: '!ap next setting',
	// Keyed by Discord user id. A hand-edited file could hold any key, and `__proto__` must not reach
	// the prototype chain through one.
	nullPrototype: true
});
const NEXT_FILE = store.file;
const { load, persist } = store;

/** Whether this person's `!ap next` leaves out checks for slots that are done. Off for anyone who never said. */
function hidesFinished(userId) {
	if (!userId) return false;
	const entry = load()[String(userId)];
	return !!(entry && typeof entry === 'object' && entry.hideFinished === true);
}

/**
 * Turn `hideFinished` on or off for one person.
 * @returns {boolean} the setting now in force
 * @throws when it could not be saved, with nothing changed: saying "done" for a setting that is
 *   gone after the next restart is worse than saying it failed
 */
function setHideFinished(userId, on) {
	if (!userId) throw new Error('I could not work out who that setting is for.');
	const all = load();
	const key = String(userId);
	const before = all[key];
	all[key] = { ...(before && typeof before === 'object' ? before : {}), hideFinished: !!on };
	if (!persist()) {
		if (before === undefined) delete all[key];
		else all[key] = before;
		throw new Error('I could not save that setting — the settings file is not writable. Nothing changed.');
	}
	return !!on;
}

/** Test seam: drop the in-memory copy so the next read comes off disk. */
const reset = store.reset;

module.exports = { hidesFinished, setHideFinished, reset, NEXT_FILE };
