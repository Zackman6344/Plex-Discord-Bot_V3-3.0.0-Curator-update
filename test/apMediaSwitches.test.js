// helpers/apMediaSwitches.js: the per-slot switch registry (spec 2.10, 5.1).
//
// The command reads `switch <name> <on|off> [slot]` and takes a two-word name when the registry
// knows it, so a name or alias that reads as another name followed by an on/off word would swallow
// the on/off word. The planned names of later waves are checked here too, before they ship.

const test = require('node:test');
const assert = require('node:assert');
const sw = require('../helpers/apMediaSwitches.js');

const PLANNED = [
	['intro', 'skipintro'],
	['played', 'playedonly'],
	['waiting', 'waitingfor'],
	['playlists', 'playlist', 'plexplaylists'],
	['deathlink', 'death', 'dl'],
	['traplink', 'tl'],
	['control', 'plexcontrol'],
	['stops', 'plexstops'],
];

function clashes(words) {
	const onOff = sw.ON_OFF_WORDS.map(sw.switchWord).filter(Boolean);
	const out = [];
	for (const word of words) {
		for (const base of words) {
			for (const tail of onOff) {
				if (sw.switchWord(base + tail) === word) out.push(`${word} = ${base} + ${tail}`);
			}
		}
	}
	return out;
}

test('wave 1 registers intro alone, with the texts of spec 5.1', () => {
	assert.deepStrictEqual(sw.names(), ['intro']);
	const intro = sw.SWITCHES[0];
	assert.deepStrictEqual([...intro.aliases], ['skipintro']);
	assert.strictEqual(intro.label, 'Skip Intro as heard');
	assert.strictEqual(intro.short, 'A jump over an episode\'s intro counts as heard (Timesanity Strict).');
	assert.match(intro.help, /^With this on, a jump over a TV episode's intro marker, by Plex's Skip Intro button/);
	assert.match(intro.help, /an episode without a marker still needs its intro played\.$/);
	assert.strictEqual(intro.onText('Zack'), 'Skip Intro now counts as heard for `Zack`.');
	assert.strictEqual(intro.offText('Zack'), 'Skip Intro no longer counts as heard for `Zack`: an intro jumped over leaves a gap again.');
	assert.strictEqual(intro.onText('a`b'), 'Skip Intro now counts as heard for `a\'b`.');
	assert.ok(Object.isFrozen(sw.SWITCHES) && Object.isFrozen(intro) && Object.isFrozen(intro.aliases));
});

test('intro warns only on a known index that is not strict', () => {
	const intro = sw.switchNamed('intro');
	assert.strictEqual(intro.warn({ strict: false }, {}, 'Zack'), '`Zack` does not use Timesanity Strict, so this changes nothing for it.');
	assert.strictEqual(intro.warn({ strict: true }, {}, 'Zack'), null);
	assert.strictEqual(intro.warn(null, {}, 'Zack'), null);
});

test('switchWord keeps the letters a-z in lower case', () => {
	assert.strictEqual(sw.switchWord('Skip-Intro'), 'skipintro');
	assert.strictEqual(sw.switchWord('skip intro 2'), 'skipintro');
	assert.strictEqual(sw.switchWord(null), '');
	assert.strictEqual(sw.switchWord('\u00e9t\u00e9'), 't');
});

test('switchNamed finds a switch by name or alias through switchWord', () => {
	assert.strictEqual(sw.switchNamed('intro').name, 'intro');
	assert.strictEqual(sw.switchNamed('skip-intro').name, 'intro');
	assert.strictEqual(sw.switchNamed('Skip Intro').name, 'intro');
	assert.strictEqual(sw.switchNamed('SKIPINTRO').name, 'intro');
	assert.strictEqual(sw.switchNamed('outro'), null);
	assert.strictEqual(sw.switchNamed(''), null);
	assert.strictEqual(sw.switchNamed('--'), null);
	assert.strictEqual(sw.switchNamed(undefined), null);
});

test('onOffOf reads the on/off words, booleans and 1/0, and nothing else', () => {
	for (const word of ['on', 'ON', ' yes ', 'true', '1']) assert.strictEqual(sw.onOffOf(word), true, word);
	for (const word of ['off', 'No', 'false', '0']) assert.strictEqual(sw.onOffOf(word), false, word);
	assert.strictEqual(sw.onOffOf(true), true);
	assert.strictEqual(sw.onOffOf(false), false);
	assert.strictEqual(sw.onOffOf(1), true);
	assert.strictEqual(sw.onOffOf(0), false);
	for (const value of ['', 'onn', 'intro', 2, null, undefined, {}]) assert.strictEqual(sw.onOffOf(value), null, String(value));
});

test('effective: a stored boolean wins, then the seed, then off', () => {
	const intro = sw.switchNamed('intro');
	assert.deepStrictEqual(sw.effective(intro, {}, { strict: true }), { on: false, from: 'default' });
	assert.deepStrictEqual(sw.effective(intro, { intro: true }, null), { on: true, from: 'switch' });
	assert.deepStrictEqual(sw.effective(intro, false, null), { on: false, from: 'switch' });
	const seeded = { name: 'deathlink', aliases: [], seed: (index) => index.links.deathLink };
	const index = { links: { deathLink: true } };
	assert.deepStrictEqual(sw.effective(seeded, {}, index), { on: true, from: 'seed' });
	assert.deepStrictEqual(sw.effective(seeded, { deathlink: false }, index), { on: false, from: 'switch' });
	assert.deepStrictEqual(sw.effective(seeded, null, null), { on: false, from: 'default' });
	assert.deepStrictEqual(sw.effective(seeded, { deathlink: 'yes' }, { links: {} }), { on: false, from: 'default' });
});

test('names and aliases are unique, lower-case letters, and none reads as a name plus an on/off word', () => {
	const words = sw.SWITCHES.flatMap((s) => [s.name, ...s.aliases]);
	assert.strictEqual(new Set(words).size, words.length);
	for (const word of words) assert.match(word, /^[a-z]{1,16}$/);
	assert.deepStrictEqual(clashes(words), []);
});

test('the planned names of later waves are unique and none reads as a name plus an on/off word', () => {
	const words = PLANNED.flat();
	assert.strictEqual(new Set(words).size, words.length);
	assert.deepStrictEqual(clashes(words), []);
	assert.deepStrictEqual(clashes([...words, 'waitingon']), ['waitingon = waiting + on']);
	for (const s of sw.SWITCHES) assert.ok(PLANNED.some((row) => row[0] === s.name && row.slice(1).join() === s.aliases.join()), s.name);
});
