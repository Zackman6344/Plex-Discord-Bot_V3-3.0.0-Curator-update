// /apmedia unlink: drop a slot link (the bound player, or the owner for anyone's).

const common = require('./common.js');

async function run(ctx) {
	const text = common.isSlash(ctx) ? String(common.opt(ctx, 'slot') ?? '').trim() : ctx.rest;
	if (!text) return ctx.say(`Which slot? \`${ctx.p}apmedia unlink <slot>\`; \`/apmedia status\` lists yours.`);
	const r = common.slotFor(ctx, text, { others: true });
	if (!r.ok) return ctx.say(r.message);
	const out = await ctx.game.unlink(r.key, ctx.userId);
	return ctx.say(out.message);
}

module.exports = { names: ['unlink'], run };
