// /apmedia link: tie a Plex Media slot of a watched room to a Discord user.
//
//   !apmedia link <slot> [watch=n]          your own slot, which you hold the !ap claim on
//   !apmedia link <slot> @user [watch=n]    the owner, for someone else
//
// The !ap claim is the proof a slot is yours: claiming is open to everyone but never takes a slot
// somebody else holds, and the owner can reassign one. Without it anybody could link a friend's
// slot to themselves, and their watching would then fill someone else's list.

const config = require('../../config/config.js');
const common = require('./common.js');

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const user = common.optUser(ctx, 'user');
		const watch = common.opt(ctx, 'watch');
		const slot = common.opt(ctx, 'slot');
		return { slot: typeof slot === 'string' ? slot.trim() : '', userId: user ? String(user.id) : null, watch: watch === undefined ? 0 : watch };
	}
	const { ids, rest } = common.takeMentions(ctx.rest);
	const { values, rest: slot } = common.takeKeys(rest, ['watch']);
	return { slot, userId: ids[0] || null, watch: values.watch === undefined ? 0 : values.watch };
}

function sameSlot(a, b) {
	return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function claimCommand(ctx, watchId, slotName) {
	return common.commandCode(`${ctx.p}ap claim ${watchId ? `${watchId} ` : ''}${slotName}`);
}

async function run(ctx) {
	const input = readInput(ctx);
	if (!input.slot) return ctx.say(`Which slot? \`${ctx.p}apmedia link <slot name> [watch=n]\`, once the seed's room is watched (\`${ctx.p}ap list\`).`);
	const watchId = typeof input.watch === 'number' ? input.watch : (/^\d+$/.test(String(input.watch).trim()) ? Number(String(input.watch).trim()) : NaN);
	if (!Number.isSafeInteger(watchId) || watchId < 0) return ctx.say('A watch id is a whole number from `/ap list` (0 is the room /config names).');
	const target = input.userId || ctx.userId;
	if (target !== ctx.userId) {
		const gate = common.ownerOnly(ctx, 'link a slot for someone else');
		if (gate) return ctx.say(gate);
	} else if (!common.isOwner(ctx.userId)) {
		if (!config.archipelagoEnabled) {
			return ctx.say('The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.');
		}
		let claims = null;
		try {
			claims = ctx.monitor().listClaims(watchId);
		} catch (_) {}
		if (!Array.isArray(claims)) return ctx.say(`There is no watch #${watchId}: \`${ctx.p}ap list\` shows the watched rooms.`);
		const holds = claims.some((c) => String(c.userId) === ctx.userId && sameSlot(c.slot, input.slot));
		if (!holds) {
			return ctx.say(`Claim the slot first: ${claimCommand(ctx, watchId, input.slot)} shows it is yours. Then link it again, or ask the bot owner to link it for you.`);
		}
	}
	const r = await ctx.game.link({ watchId, slot: input.slot, userId: target, by: ctx.userId });
	if (!r.ok) return ctx.say(r.message);
	const lines = [`\u{1F517} ${r.message}${target !== ctx.userId ? ` It is <@${target}>'s now.` : ''}`];
	for (const w of r.warnings || []) lines.push(`\u26A0\uFE0F ${w}`);
	lines.push('`/apmedia status` shows how it connects, and `/apmedia list` its titles once it has.');
	return ctx.say(lines.join('\n'));
}

module.exports = { names: ['link'], run };
