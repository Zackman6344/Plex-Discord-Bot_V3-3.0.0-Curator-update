// /apmedia ff: spend a Fast Forward on a title of your own slot. It earns the title's next checkpoint,
// however far along it is; under timesanity_strict the 10 minutes after the furthest point heard count
// as heard instead. Only the bound player spends their Fast Forwards.
//
//   !apmedia ff <title>              the only linked slot
//   !apmedia ff <title> slot=Zack    one of several; slot="Zack 2" for a name with a space
//   !apmedia ff slot=Zack <title>    the same with slot= first

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
	if (!input.title) return ctx.say(`Which title? \`${ctx.p}apmedia ff <title>\` earns its next checkpoint (with Timesanity Strict on, 10 minutes of it count as heard).`);
	const r = common.slotFor(ctx, input.slot, { others: false });
	if (!r.ok) return ctx.say(r.message);
	const found = common.findTitle(ctx, r.key, input.title);
	if (!found.ok) return ctx.say(found.message);
	const out = await ctx.game.fastForward(r.key, found.entryKey);
	return ctx.say(out.message);
}

module.exports = { names: ['ff'], run };
