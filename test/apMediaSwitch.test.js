// /apmedia switch, command half (05-wave2.md 5.1): the parser, the list, one switch and the
// status line, against a fake game whose switches, setSwitch and switchName stand in for W1-A's.

const test = require('node:test');
const assert = require('node:assert');

const switchCmd = require('../commands/apmedia.js/switch.js');
const status = require('../commands/apmedia.js/status.js');

const INTRO = {
	name: 'intro', label: 'Skip Intro as heard', on: false, from: 'default',
	short: 'A jump over an episode\'s intro counts as heard (Timesanity Strict).',
	help: 'With this on, a jump over a TV episode\'s intro marker counts as heard.',
};
const DEATH = { name: 'deathlink', label: 'DeathLink', on: true, from: 'seed', short: 'Deaths are shared.', help: 'Deaths travel.' };

function letters(text) {
	return String(text).toLowerCase().replace(/[^a-z]/g, '');
}

function fakeCtx({ rest = '', slash = null, rows = [INTRO], slots = ['Zack', 'Zack 2'] } = {}) {
	const calls = { resolve: [], set: [], said: [] };
	const ctx = {
		rest, p: '!', userId: 'U1',
		say: async (x) => { calls.said.push(x); },
		buttons: { firstPage: ({ pages }) => ({ content: pages[0], components: [] }) },
		game: {
			resolveBinding: (text, opts) => {
				calls.resolve.push([text, opts]);
				if (!text || slots.includes(text)) return { ok: true, key: 'k1' };
				return { ok: false, message: 'There is no such Plex Media slot.' };
			},
			switches: async () => ({ ok: true, slot: 'Zack', rows }),
			setSwitch: async (key, word, on, opts) => { calls.set.push([key, word, on, opts]); return { ok: true, message: 'set' }; },
			switchName: (text) => (['intro', 'skipintro'].includes(letters(text)) ? 'intro' : null),
		},
	};
	if (slash) {
		ctx.interaction = { options: { get: (name) => (slash[name] === undefined ? null : { value: slash[name] }) } };
	}
	return { ctx, calls };
}

async function said(opts) {
	const { ctx, calls } = fakeCtx(opts);
	await switchCmd.run(ctx);
	return calls;
}

test('no name lists every switch with what it does, and the footer of the form used', async () => {
	const prefix = await said({ rows: [INTRO, DEATH] });
	assert.deepStrictEqual(prefix.said, [
		'`Zack`\'s switches:\n' +
		`> \`intro\`: off. ${INTRO.short}\n` +
		'> `deathlink`: on, from the YAML. Deaths are shared.\n' +
		'`!apmedia switch <name> on|off` turns one on or off.'
	]);
	assert.deepStrictEqual(prefix.set, []);
	const slash = await said({ slash: {} });
	assert.ok(slash.said[0].endsWith('\n`/apmedia switch <name> on` or `off` turns one on or off.'), slash.said[0]);
});

test('a name and an on/off word set the switch, by the caller', async () => {
	for (const [rest, word] of [['intro on', 'on'], ['skip-intro on', 'on'], ['skip intro off', 'off'], ['intro 1', '1'], ['intro 0', '0']]) {
		const calls = await said({ rest });
		assert.deepStrictEqual(calls.set, [['k1', 'intro', word, { by: 'U1' }]], rest);
		assert.deepStrictEqual(calls.said, ['set'], rest);
		assert.deepStrictEqual(calls.resolve, [['', { userId: 'U1', all: false }]], rest);
	}
});

test('the slot comes from slot= or the words after the on/off word, own slots only', async () => {
	const keyed = await said({ rest: 'intro on slot=Zack' });
	assert.deepStrictEqual(keyed.resolve, [['Zack', { userId: 'U1', all: false }]]);
	assert.deepStrictEqual(keyed.set, [['k1', 'intro', 'on', { by: 'U1' }]]);
	const tail = await said({ rest: 'intro off Zack 2' });
	assert.deepStrictEqual(tail.resolve, [['Zack 2', { userId: 'U1', all: false }]]);
	const quoted = await said({ rest: 'intro on slot="Zack 2"' });
	assert.deepStrictEqual(quoted.resolve, [['Zack 2', { userId: 'U1', all: false }]]);
	const listed = await said({ rest: 'Zack 2' });
	assert.deepStrictEqual(listed.set, []);
	assert.match(listed.said[0], /^`Zack`'s switches:/);
	assert.deepStrictEqual(listed.resolve.at(-1), ['Zack 2', { userId: 'U1', all: false }]);
});

test('the owner cannot flip a friend\'s switch: the slot is looked up among their own', async () => {
	const config = require('../config/config.js');
	const saved = config.ownerId;
	config.ownerId = 'U1';
	try {
		const calls = await said({ rest: 'intro on slot=Ana' });
		assert.deepStrictEqual(calls.resolve, [['Ana', { userId: 'U1', all: false }]]);
		assert.deepStrictEqual(calls.set, []);
	} finally {
		config.ownerId = saved;
	}
});

test('a two-word slot without quotes gets the hint, and nothing is set', async () => {
	const calls = await said({ rest: 'intro on slot=Zack 2' });
	assert.deepStrictEqual(calls.said, ['Is the slot `Zack 2`? Then put it in quotes: `slot="Zack 2"`. If it is `Zack`, put `slot=Zack` last. Nothing was changed.']);
	assert.deepStrictEqual(calls.set, []);
});

// The bug: switchName reads letters only, so `2 intro` named `intro`, the slot's second word went
// into the switch name, and the switch flipped on `Zack`.
test('a slot word with a digit or no letter never joins a two-word switch name, so slot= first gets the hint too', async () => {
	const slots = ['Zack', 'Zack 2', 'Zack #1', 'Zack &', 'Zack 2.0', 'Zack skip2', 'Zack skip'];
	for (const [rest, whole] of [
		['slot=Zack 2 intro on', 'Zack 2'],
		['slot=Zack #1 intro on', 'Zack #1'],
		['slot=Zack & intro on', 'Zack &'],
		['slot=Zack 2.0 skip intro off', 'Zack 2.0'],
		['slot=Zack skip2 intro on', 'Zack skip2'],
		['slot=Zack skip intro2 on', 'Zack skip'],
	]) {
		const calls = await said({ rest, slots });
		assert.deepStrictEqual(calls.said, [`Is the slot \`${whole}\`? Then put it in quotes: \`slot="${whole}"\`. If it is \`Zack\`, put \`slot=Zack\` last. Nothing was changed.`], rest);
		assert.deepStrictEqual(calls.set, [], rest);
	}
	const keyed = await said({ rest: 'slot=Zack intro on', slots });
	assert.deepStrictEqual(keyed.set, [['k1', 'intro', 'on', { by: 'U1' }]]);
	assert.deepStrictEqual(keyed.resolve, [['Zack', { userId: 'U1', all: false }]]);
	const listed = await said({ rest: 'Zack 2', slots });
	assert.deepStrictEqual(listed.set, []);
	assert.deepStrictEqual(listed.resolve.at(-1), ['Zack 2', { userId: 'U1', all: false }]);
});

test('an unknown name goes to setSwitch with its word; alone it lists the names', async () => {
	const set = await said({ rest: 'bogus on' });
	assert.deepStrictEqual(set.set, [['k1', 'bogus', 'on', { by: 'U1' }]]);
	const alone = await said({ rest: 'bogus', rows: [INTRO, DEATH] });
	assert.deepStrictEqual(alone.said, ['There is no switch called `bogus`. The switches: intro, deathlink.']);
});

test('a name without on/off shows that switch; a word that is not one reaches setSwitch', async () => {
	const view = await said({ rest: 'skip intro' });
	assert.deepStrictEqual(view.said, [`\`intro\` is off for \`Zack\`. ${INTRO.help}`]);
	assert.deepStrictEqual(view.set, []);
	const seed = await said({ rest: 'deathlink', rows: [{ ...DEATH }] });
	assert.deepStrictEqual(seed.said, ['There is no switch called `deathlink`. The switches: deathlink.']);
	const maybe = await said({ rest: 'intro maybe' });
	assert.deepStrictEqual(maybe.set, [['k1', 'intro', 'maybe', { by: 'U1' }]]);
});

test('slash options do the same', async () => {
	const set = await said({ slash: { name: 'intro', on: true, slot: 'Zack' } });
	assert.deepStrictEqual(set.set, [['k1', 'intro', true, { by: 'U1' }]]);
	assert.deepStrictEqual(set.resolve, [['Zack', { userId: 'U1', all: false }]]);
	const off = await said({ slash: { name: 'skip intro', on: false } });
	assert.deepStrictEqual(off.set, [['k1', 'skip intro', false, { by: 'U1' }]]);
	const view = await said({ slash: { name: 'Skip Intro' } });
	assert.deepStrictEqual(view.said, [`\`intro\` is off for \`Zack\`. ${INTRO.help}`]);
	const refused = await said({ slash: { slot: 'Ana' } });
	assert.deepStrictEqual(refused.said, ['There is no such Plex Media slot.']);
});

test('autocomplete offers the caller\'s own switches by the typed start, and nothing for another person\'s slot', async () => {
	const config = require('../config/config.js');
	const apmedia = require('../commands/apmedia.js/index.js');
	const saved = { enabled: config.apMediaEnabled, owner: config.ownerId };
	const asked = [];
	const restore = apmedia._internal.use({ game: {
		resolveBinding: (text, opts) => { asked.push([text, opts]); return text === 'Ana' ? { ok: false, message: 'no' } : { ok: true, key: 'k1' }; },
		switches: () => ({ ok: true, slot: 'Zack', rows: [INTRO, DEATH] }),
	} });
	const focus = (value, slot) => {
		const responded = [];
		return {
			responded, commandName: 'apmedia', user: { id: 'U1' },
			options: {
				getFocused: () => ({ name: 'name', value }),
				getSubcommand: () => 'switch',
				get: (n) => (n === 'slot' && slot !== undefined ? { name: n, value: slot } : null),
			},
			async respond(choices) { responded.push(choices); },
		};
	};
	try {
		config.apMediaEnabled = true;
		config.ownerId = 'U1';
		const all = focus('');
		await apmedia.command.slash.autocomplete(all);
		assert.deepStrictEqual(all.responded, [[{ name: 'intro: off', value: 'intro' }, { name: 'deathlink: on', value: 'deathlink' }]]);
		const typed = focus('In');
		await apmedia.command.slash.autocomplete(typed);
		assert.deepStrictEqual(typed.responded, [[{ name: 'intro: off', value: 'intro' }]]);
		const other = focus('', 'Ana');
		await apmedia.command.slash.autocomplete(other);
		assert.deepStrictEqual(other.responded, [[]]);
		assert.deepStrictEqual(asked, [['', { userId: 'U1', all: false }], ['', { userId: 'U1', all: false }], ['Ana', { userId: 'U1', all: false }]]);
	} finally {
		restore();
		config.apMediaEnabled = saved.enabled;
		config.ownerId = saved.owner;
	}
});

test('switch sits after announce in the slash spec, within the wave 1 budget', () => {
	const apmedia = require('../commands/apmedia.js/index.js');
	const { buildSpec } = require('../helpers/slashRegistry.js');
	const { commandChars } = require('../scripts/validate-slash.js');
	const names = apmedia._internal.SUBCOMMANDS.map((s) => s.name);
	assert.strictEqual(names[names.indexOf('announce') + 1], 'switch');
	assert.ok(names.length <= 16, `${names.length} subcommands`);
	assert.ok(commandChars(buildSpec('apmedia', apmedia.command.slash)) <= 3635);
	assert.strictEqual(apmedia._internal.HANDLERS.switches, apmedia._internal.HANDLERS.switch);
	assert.ok(!apmedia._internal.PUBLIC.has('switch'));
});

test('the status block prints Switches on only when a row has a switch on', () => {
	const base = {
		slot: 'Zack', key: 'k1', state: 'connected', goalCount: 3, goalReached: false, inventoryKnown: true,
		ready: 2, locked: 1, account: null,
	};
	const lines = (switches) => status.block({ ...base, switches }, { showUser: false }).rows.filter((l) => /Switches on/.test(l));
	assert.deepStrictEqual(lines(undefined), []);
	assert.deepStrictEqual(lines([INTRO]), []);
	assert.deepStrictEqual(lines([{ ...INTRO, on: true, from: 'switch' }, DEATH]), ['> Switches on: Skip Intro as heard, DeathLink (from the YAML).']);
});
