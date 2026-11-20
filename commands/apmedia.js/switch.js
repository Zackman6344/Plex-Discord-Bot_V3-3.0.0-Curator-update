// /apmedia switch: a slot's opt-ins. With no name it lists each switch and what it does, with a
// name alone it shows that one, and with on or off it sets it. Only the bound player's own slot.
//
//   !apmedia switch                         every switch of the only linked slot
//   !apmedia switch intro                   one switch in full
//   !apmedia switch intro on                on (off, yes, no, true, false, 1 and 0 work too)
//   !apmedia switch skip intro on Zack      a name of two words, then the slot
//   !apmedia switch intro off slot="Zack 2" a slot name with a space
//   !apmedia switch Zack                    every switch of that slot

const common = require('./common.js');

const NOTHING = 'Nothing was changed.';
const ON_OFF = new Map([
	['on', true], ['true', true], ['yes', true], ['1', true],
	['off', false], ['false', false], ['no', false], ['0', false],
]);

function onOff(word) {
	const on = ON_OFF.get(String(word ?? '').trim().toLowerCase());
	return on === undefined ? null : on;
}

// switchName reads letters only, so `2 intro` names `intro`: a word with a digit or without a letter
// is part of a slot name (`slot=Zack 2 intro on`), never of a switch name of two words.
function nameWord(word) {
	return /[a-z]/i.test(word) && !/\d/.test(word);
}

function nameAt(ctx, words) {
	const [first, second] = words;
	if (first === undefined) return null;
	if (second !== undefined && onOff(second) === null && nameWord(first) && nameWord(second)) {
		const two = ctx.game.switchName(`${first} ${second}`);
		if (two) return { name: two, used: 2 };
	}
	const one = ctx.game.switchName(first);
	return one ? { name: one, used: 1 } : null;
}

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const on = common.opt(ctx, 'on');
		return {
			name: String(common.opt(ctx, 'name') ?? '').trim(),
			on: typeof on === 'boolean' ? on : null,
			slot: String(common.opt(ctx, 'slot') ?? '').trim(),
		};
	}
	const own = (words) => {
		const at = nameAt(ctx, words);
		return at ? Math.min(words.length, at.used + 1) : 0;
	};
	const isSlot = (name) => common.namesSlot(ctx, name, { others: false });
	const refusal = common.slotTail(ctx.rest, { own, nothing: NOTHING, isSlot });
	if (refusal) return { refusal };
	const { values, rest } = common.takeKeys(ctx.rest, ['slot']);
	const given = values.slot !== undefined;
	const words = rest.split(' ').filter(Boolean);
	if (!words.length) return { name: '', on: null, slot: given ? values.slot : '' };
	let at = nameAt(ctx, words);
	if (!at) {
		if (!given && isSlot(rest)) return { name: '', on: null, slot: rest };
		at = { name: words[0], used: 1 };
	}
	const word = words[at.used];
	return {
		name: at.name,
		on: word === undefined ? null : word,
		slot: given ? values.slot : words.slice(at.used + 1).join(' '),
	};
}

function state(row) {
	return row.on ? 'on' : 'off';
}

function footer(ctx) {
	if (common.isSlash(ctx)) return '`/apmedia switch <name> on` or `off` turns one on or off.';
	return `\`${ctx.p}apmedia switch <name> on|off\` turns one on or off.`;
}

function listPages(ctx, out) {
	const rows = out.rows.map((row) => `> \`${row.name}\`: ${state(row)}${row.from === 'seed' ? ', from the YAML' : ''}. ${row.short}`);
	return common.paginate([`${common.slot(out.slot)}'s switches:`], [{ title: null, rows: [...rows, footer(ctx)] }]);
}

function oneText(out, row) {
	return `\`${row.name}\` is ${state(row)} for ${common.slot(out.slot)}${row.from === 'seed' ? ', from its YAML' : ''}. ${row.help}`;
}

async function run(ctx) {
	const input = readInput(ctx);
	if (input.refusal) return ctx.say(input.refusal);
	const r = common.slotFor(ctx, input.slot, { others: false });
	if (!r.ok) return ctx.say(r.message);
	if (input.name && input.on !== null) {
		const set = await ctx.game.setSwitch(r.key, input.name, input.on, { by: ctx.userId });
		return ctx.say(set.message);
	}
	const out = await ctx.game.switches(r.key);
	if (!out.ok) return ctx.say(out.message);
	if (!input.name) return common.sendPages(ctx, listPages(ctx, out));
	const name = ctx.game.switchName(input.name);
	const row = name ? out.rows.find((x) => x.name === name) : null;
	if (!row) return ctx.say(`There is no switch called ${common.slot(input.name)}. The switches: ${out.rows.map((x) => x.name).join(', ')}.`);
	return ctx.say(oneText(out, row));
}

module.exports = { names: ['switch', 'switches'], run, readInput, listPages, oneText };
