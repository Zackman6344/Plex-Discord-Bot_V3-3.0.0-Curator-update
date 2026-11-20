// The game half of the per-slot switches (spec 5.1, 2.10).

const test = require('node:test');
const assert = require('node:assert');
const { setup, linkSlot, settledPosts, slotData, SLOT } = require('./helpers/apMediaHarness.js');
const switchRegistry = require('../helpers/apMediaSwitches.js');

const ON = `Skip Intro now counts as heard for \`${SLOT}\`.`;
const switchEvents = (h) => h.events.filter((e) => e.kind === 'apmedia-switch');

async function strictSlot(t, sd = slotData({ timesanity_strict: true })) {
	const h = await setup(t, { sd });
	const key = await linkSlot(h);
	await settledPosts(h);
	return { h, key };
}

test('a switch is off and nothing is stored until it is set, and setting it twice answers already', async (t) => {
	const { h, key } = await strictSlot(t);
	assert.deepStrictEqual(h.store.bindings.get(key).switches, {});
	const intro = switchRegistry.SWITCHES[0];
	assert.deepStrictEqual(h.game.switches(key), {
		ok: true,
		slot: SLOT,
		rows: [{ name: 'intro', label: intro.label, short: intro.short, help: intro.help, on: false, from: 'default' }],
	});
	assert.deepStrictEqual(await h.game.setSwitch(key, 'skip-intro', 'on', { by: '42' }), { ok: true, message: ON, name: 'intro', on: true });
	assert.deepStrictEqual(h.store.bindings.get(key).switches, { intro: true });
	assert.deepStrictEqual(switchEvents(h).map(({ slot, name, on, by }) => ({ slot, name, on, by })), [{ slot: SLOT, name: 'intro', on: true, by: '42' }]);
	assert.deepStrictEqual(await h.game.setSwitch(key, 'intro', true), { ok: true, message: `\`intro\` is already on for \`${SLOT}\`.`, name: 'intro', on: true });
	assert.strictEqual(switchEvents(h).length, 1);
	const off = await h.game.setSwitch(key, 'intro', '0');
	assert.strictEqual(off.message, `Skip Intro no longer counts as heard for \`${SLOT}\`: an intro jumped over leaves a gap again.`);
	assert.deepStrictEqual(h.store.bindings.get(key).switches, { intro: false });
	assert.deepStrictEqual(h.game.status(key).bindings[0].switches.map(({ name, on, from }) => ({ name, on, from })), [{ name: 'intro', on: false, from: 'switch' }]);
});

test('a switch on a slot without Timesanity Strict says it changes nothing there', async (t) => {
	const { h, key } = await strictSlot(t, slotData({}));
	const set = await h.game.setSwitch(key, 'intro', 'yes');
	assert.strictEqual(set.message, `${ON} \`${SLOT}\` does not use Timesanity Strict, so this changes nothing for it.`);
	assert.strictEqual(h.game.status(key).bindings[0].switches[0].on, true);
});

test('setSwitch refuses an unknown slot, an unknown name and a missing on or off', async (t) => {
	const { h, key } = await strictSlot(t);
	const p = h.config.commandPrefix || '!';
	assert.deepStrictEqual(await h.game.setSwitch('nope', 'intro', true), { ok: false, message: 'There is no such Plex Media slot.' });
	assert.deepStrictEqual(await h.game.setSwitch(key, 'outro', true), { ok: false, message: 'There is no switch called `outro`. The switches: intro.' });
	assert.deepStrictEqual(await h.game.setSwitch(key, 'intro', 'maybe'), { ok: false, message: `Say \`on\` or \`off\`: \`${p}apmedia switch intro on|off [slot]\`.` });
	assert.deepStrictEqual(h.store.bindings.get(key).switches, {});
	assert.deepStrictEqual(h.game.switches('nope'), { ok: false, message: 'There is no such Plex Media slot.' });
	assert.deepStrictEqual([h.game.switchName('Skip Intro'), h.game.switchName('INTRO'), h.game.switchName('outro')], ['intro', 'intro', null]);
});

test('switch names and aliases are unique, and none reads as another followed by an on or off word', () => {
	const words = switchRegistry.SWITCHES.flatMap((s) => [s.name, ...s.aliases]);
	assert.strictEqual(new Set(words).size, words.length);
	for (const word of words) {
		for (const onOff of ['on', 'off', 'yes', 'no', 'true', 'false']) {
			assert.ok(!words.includes(switchRegistry.switchWord(word + onOff)), `${word} ${onOff}`);
		}
	}
	assert.deepStrictEqual(switchRegistry.effective({ name: 'x', seed: () => true }, {}, {}), { on: true, from: 'seed' });
	assert.deepStrictEqual(switchRegistry.effective({ name: 'x', seed: () => true }, { x: false }, {}), { on: false, from: 'switch' });
});
