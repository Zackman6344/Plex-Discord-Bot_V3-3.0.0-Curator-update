// /apmedia announce: turn the channel lines about your own slot on or off. Refusals and other
// problems that need a fix are posted either way.

const common = require('./common.js');

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		return { mode: String(common.opt(ctx, 'mode') ?? '').trim(), slot: String(common.opt(ctx, 'slot') ?? '').trim() };
	}
	const { values, rest } = common.takeKeys(ctx.rest, ['slot']);
	const words = rest.split(/\s+/).filter(Boolean);
	const mode = words.shift() || '';
	return { mode, slot: values.slot !== undefined ? values.slot : words.join(' ') };
}

async function run(ctx) {
	const input = readInput(ctx);
	if (!input.mode) return ctx.say(`On or off? \`${ctx.p}apmedia announce on|off [slot]\`.`);
	const r = common.slotFor(ctx, input.slot, { others: false });
	if (!r.ok) return ctx.say(r.message);
	const out = await ctx.game.setAnnounce(r.key, input.mode);
	return ctx.say(out.message);
}

module.exports = { names: ['announce'], run };
