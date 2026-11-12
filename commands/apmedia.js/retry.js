// /apmedia retry: reconnect a refused, stale or orphaned slot (the bound player, or the owner).

const common = require('./common.js');

async function run(ctx) {
	const text = common.isSlash(ctx) ? String(common.opt(ctx, 'slot') ?? '').trim() : ctx.rest;
	const r = common.slotFor(ctx, text, { others: true });
	if (!r.ok) return ctx.say(r.message);
	const out = await ctx.game.retry(r.key);
	return ctx.say(out.ok ? `\u{1F504} ${out.message}` : out.message);
}

module.exports = { names: ['retry', 'reconnect'], run };
