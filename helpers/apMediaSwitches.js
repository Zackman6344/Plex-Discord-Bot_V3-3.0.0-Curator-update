// helpers/apMediaSwitches.js
// The per-slot switches a Plex Media player turns on or off with `apmedia switch`, in list order.
// Data only: the game keeps each slot's setting and starts a switch's side effect, and the command
// reads the names here. A typed name is compared through switchWord, so `skip-intro` names `intro`.

const ON_OFF = new Map([
	['on', true], ['true', true], ['yes', true], ['1', true],
	['off', false], ['false', false], ['no', false], ['0', false],
]);

/** The on/off words onOffOf reads, on words first. */
const ON_OFF_WORDS = Object.freeze([...ON_OFF.keys()]);

function code(name) {
	return `\`${String(name ?? '').replace(/`/g, "'")}\``;
}

/** A typed switch name as the registry compares it: lower case, letters a-z only. */
function switchWord(text) {
	return String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** An on/off word, a boolean, or 1/0 as true or false; null for anything else. */
function onOffOf(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
	if (typeof value !== 'string') return null;
	const on = ON_OFF.get(value.trim().toLowerCase());
	return on === undefined ? null : on;
}

function spec(fields) {
	return Object.freeze({ ...fields, aliases: Object.freeze([...(fields.aliases || [])]) });
}

const SWITCHES = Object.freeze([
	spec({
		name: 'intro',
		aliases: ['skipintro'],
		label: 'Skip Intro as heard',
		short: 'A jump over an episode\'s intro counts as heard (Timesanity Strict).',
		help: 'With this on, a jump over a TV episode\'s intro marker, by Plex\'s Skip Intro button or its automatic skip, counts as heard on a slot with Timesanity Strict. Plex marks intros with Plex Pass intro detection; an episode without a marker still needs its intro played.',
		onText: (slot) => `Skip Intro now counts as heard for ${code(slot)}.`,
		offText: (slot) => `Skip Intro no longer counts as heard for ${code(slot)}: an intro jumped over leaves a gap again.`,
		warn: (index, cfg, slot) => (index && typeof index === 'object' && !index.strict
			? `${code(slot)} does not use Timesanity Strict, so this changes nothing for it.`
			: null),
	}),
]);

/** The switch a typed name or alias names, or null. */
function switchNamed(text) {
	const word = switchWord(text);
	if (!word) return null;
	return SWITCHES.find((s) => s.name === word || s.aliases.includes(word)) || null;
}

/** Every switch's name, in list order. */
function names() {
	return SWITCHES.map((s) => s.name);
}

/**
 * A switch's value for one slot. stored is the slot's switches ({name: boolean}) or the stored
 * boolean itself: an explicit setting wins, then the seed's own value when the index is known and
 * gives one, then off.
 */
function effective(spec, stored, index) {
	const set = typeof stored === 'boolean' ? stored
		: stored && typeof stored === 'object' ? stored[spec.name] : undefined;
	if (typeof set === 'boolean') return { on: set, from: 'switch' };
	if (index && typeof index === 'object' && typeof spec.seed === 'function') {
		const seeded = spec.seed(index);
		if (typeof seeded === 'boolean') return { on: seeded, from: 'seed' };
	}
	return { on: false, from: 'default' };
}

module.exports = { SWITCHES, ON_OFF_WORDS, switchWord, switchNamed, onOffOf, names, effective };
