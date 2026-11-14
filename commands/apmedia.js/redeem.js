// /apmedia redeem: spend a Wild Ticket to open a locked title on your own slot (a show: the
// episodes of that title's step). Only the bound player spends their tickets.
//
//   !apmedia redeem <title>              the only linked slot
//   !apmedia redeem <title> slot=Zack    one of several; slot="Zack 2" for a name with a space
//   !apmedia redeem slot=Zack <title>    the same with slot= first

const common = require('./common.js');

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		return { title: String(common.opt(ctx, 'title') ?? '').trim(), slot: String(common.opt(ctx, 'slot') ?? '').trim() };
	}
	const problem = common.slotTail(ctx.rest, { isSlot: (name) => common.namesSlot(ctx, name) });
	if (problem) return { problem };
	const { values, rest } = common.takeKeys(ctx.rest, ['slot']);
	return { title: rest, slot: values.slot !== undefined ? values.slot : '' };
}

async function run(ctx) {
	const input = readInput(ctx);
	if (input.problem) return ctx.say(input.problem);
	if (!input.title) return ctx.say(`Which title? \`${ctx.p}apmedia redeem <locked title>\`; \`/apmedia list show:locked\` lists them.`);
	const r = common.slotFor(ctx, input.slot, { others: false });
	if (!r.ok) return ctx.say(r.message);
	const found = common.findTitle(ctx, r.key, input.title);
	if (!found.ok) return ctx.say(found.message);
	const out = await ctx.game.redeem(r.key, found.entryKey);
	return ctx.say(out.message);
}

module.exports = { names: ['redeem'], run };
