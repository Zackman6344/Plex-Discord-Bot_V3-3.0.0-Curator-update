// /apmedia link: tie a Plex Media slot of a watched room to a Discord user.
//
//   !apmedia link <slot> [watch=n]          your own slot, which you hold the !ap claim on
//   !apmedia link <slot> @user [watch=n]    the owner, for someone else
//
// The !ap claim is the proof a slot is yours: claiming is open to everyone but never takes a slot
// somebody else holds, and the owner can reassign one. Without it anybody could link a friend's
// slot to themselves, and their watching would then fill someone else's list.
//
// Without watch= the link goes to the one room where that person holds a claim on the slot, unless
// another room read so far has a slot of that name too, or to the only room watched. Anything else
// is asked back with the watches' ids and never guessed, as !ap does: a rehearsal room and the live
// room can both have a slot of that name.

const config = require('../../config/config.js');
const contracts = require('../../helpers/apMediaContracts.js');
const common = require('./common.js');

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const user = common.optUser(ctx, 'user');
		const slot = common.opt(ctx, 'slot');
		return { slot: typeof slot === 'string' ? slot.trim() : '', userId: user ? String(user.id) : null, watch: common.opt(ctx, 'watch') };
	}
	const { ids, rest } = common.takeMentions(ctx.rest);
	const { values, rest: slot } = common.takeKeys(rest, ['watch']);
	return { slot, userId: ids[0] || null, watch: values.watch };
}

function sameSlot(a, b) {
	return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function watches(ctx) {
	try {
		const entries = ctx.monitor().listWatches();
		return Array.isArray(entries) ? entries.map((e) => e && e.watch).filter(Boolean) : [];
	} catch (_) {
		return [];
	}
}

/** The watch's claims, or null when there is no such watch. */
function claimsOn(ctx, watchId) {
	try {
		const claims = ctx.monitor().listClaims(watchId);
		return Array.isArray(claims) ? claims : null;
	} catch (_) {
		return null;
	}
}

function holdsOn(ctx, watchId, userId, slotName) {
	return (claimsOn(ctx, watchId) || []).some((c) => String(c.userId) === userId && sameSlot(c.slot, slotName));
}

function describe(ctx, watchId, slotName) {
	try {
		return ctx.monitor().describeSlot(watchId, slotName);
	} catch (_) {
		return null;
	}
}

// game.link's own refusal: a room known to give this slot another game is no room to link it in.
function otherGame(seen) {
	return !!seen && seen.known && !!seen.canonical && seen.game !== null && seen.game !== contracts.GAME;
}

/**
 * The watches whose room is read and has a Plex Media slot of this name. unread: some room has not
 * been read yet, a paused watch or one whose room never answered, so it may have the slot too.
 * @returns {{found: object[], unread: boolean}}
 */
function roomsWith(ctx, list, slotName) {
	const found = [];
	let unread = false;
	for (const w of list) {
		const seen = describe(ctx, w.id, slotName);
		if (!seen || !seen.known) unread = true;
		else if (seen.canonical && !otherGame(seen)) found.push(w);
	}
	return { found, unread };
}

function roomName(w) {
	return `#${w.id}${w.label ? ` ${common.esc(w.label)}` : ''}${w.slot ? ` (as ${common.slot(w.slot)})` : ''}`;
}

/**
 * @param {number|string|null} watchId null leaves the id out, for when one room is watched; it
 *   stays in for a slot whose first word is a number, which !ap would read as the id
 */
function claimCommand(ctx, watchId, slotName) {
	const id = watchId !== null ? watchId : (/^\d+$/.test(String(slotName).trim().split(/\s+/)[0]) ? soleId(ctx) : null);
	return common.commandCode(`${ctx.p}ap claim ${id === null ? '' : `${id} `}${slotName}`);
}

function soleId(ctx) {
	const list = watches(ctx);
	return list.length === 1 ? list[0].id : null;
}

/** The command to send again with the watch filled in; for someone else it keeps who it is for. */
function linkCommand(ctx, watchId, slotName, target) {
	const other = target && target !== ctx.userId;
	if (common.isSlash(ctx)) return `${common.commandCode(`/apmedia link slot:${slotName} watch:${watchId}`)}${other ? ` with user: <@${target}>` : ''}`;
	return common.commandCode(`${ctx.p}apmedia link ${slotName}${other ? ` <@${target}>` : ''} watch=${watchId}`);
}

/** @returns {{watchId: number}|{reply: string}} */
function pickWatch(ctx, slotName, target, list) {
	if (!list.length) {
		return { reply: common.isOwner(ctx.userId)
			? `No room is being watched yet: \`${ctx.p}ap watch <room> <slot>\` starts one, then link the slot.`
			: 'No room is being watched yet: ask the bot owner to watch the seed\'s room, then link the slot.' };
	}
	const held = list.filter((w) => holdsOn(ctx, w.id, target, slotName) && !otherGame(describe(ctx, w.id, slotName)));
	const { found, unread } = roomsWith(ctx, list, slotName);
	const name = common.slot(slotName);
	const player = target === ctx.userId && !common.isOwner(ctx.userId);
	if (held.length === 1) {
		// A claim can be left over in an earlier room, a rehearsal's, while a newer room has the same
		// slot. A room not read yet says nothing either way, so only the read ones can ask.
		const also = found.filter((w) => w.id !== held[0].id);
		if (!also.length) return { watchId: held[0].id };
		const has = `${also.map(roomName).join(', ')} ${also.length === 1 ? 'has' : 'have'} a slot of that name too`;
		if (!player) return { reply: `${name} is claimed on ${roomName(held[0])}, and ${has}, so say which: ${linkCommand(ctx, '<id>', slotName, target)}.` };
		// A player can link only where they hold the claim, so another room starts with its own.
		const id = also.length === 1 ? also[0].id : '<id>';
		return { reply: `${name} is claimed on ${roomName(held[0])}: ${linkCommand(ctx, held[0].id, slotName, target)} links it there. ${has}: for ${also.length === 1 ? 'that one' : 'one of those'}, ${claimCommand(ctx, id, slotName)} first, then ${linkCommand(ctx, id, slotName, target)}.` };
	}
	if (list.length === 1) return { watchId: list[0].id };
	if (held.length > 1) {
		return { reply: `${name} is claimed on more than one watch, so say which: ${linkCommand(ctx, '<id>', slotName, target)}. Claimed on ${held.map(roomName).join(', ')}.` };
	}
	const only = !unread && found.length === 1 ? found[0] : null;
	const watched = `Watched: ${list.map(roomName).join(', ')}.`;
	if (player) {
		return { reply: only
			? `Claim the slot first: ${claimCommand(ctx, only.id, slotName)} shows it is yours. Then link it again, or ask the bot owner to link it for you.`
			: `Claim the slot first, with the id of its room: ${claimCommand(ctx, '<id>', slotName)} shows it is yours. Then link it again, or ask the bot owner to link it for you. ${watched}` };
	}
	return { reply: only
		? `More than one room is being watched, and ${name} is in ${roomName(only)}: ${linkCommand(ctx, only.id, slotName, target)}.`
		: `More than one room is being watched, so say which: ${linkCommand(ctx, '<id>', slotName, target)}. ${watched}` };
}

async function run(ctx) {
	const input = readInput(ctx);
	if (!input.slot) return ctx.say(`Which slot? \`${ctx.p}apmedia link <slot name> [watch=n]\`, once the seed's room is watched (\`${ctx.p}ap list\`).`);
	let watchId = null;
	if (input.watch !== undefined) {
		watchId = typeof input.watch === 'number' ? input.watch : (/^\d+$/.test(String(input.watch).trim()) ? Number(String(input.watch).trim()) : NaN);
		if (!Number.isSafeInteger(watchId) || watchId < 0) return ctx.say('A watch id is a whole number from `/ap list` (0 is the room /config names).');
	}
	const target = input.userId || ctx.userId;
	const player = target === ctx.userId && !common.isOwner(ctx.userId);
	if (target !== ctx.userId) {
		const gate = common.ownerOnly(ctx, 'link a slot for someone else');
		if (gate) return ctx.say(gate);
	}
	if (!config.archipelagoEnabled) {
		return ctx.say('The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.');
	}
	const list = watches(ctx);
	if (watchId === null) {
		const picked = pickWatch(ctx, input.slot, target, list);
		if (picked.reply) return ctx.say(picked.reply);
		watchId = picked.watchId;
	}
	if (player) {
		const claims = claimsOn(ctx, watchId);
		if (!claims) return ctx.say(`There is no watch #${watchId}: \`${ctx.p}ap list\` shows the watched rooms.`);
		if (!claims.some((c) => String(c.userId) === ctx.userId && sameSlot(c.slot, input.slot))) {
			return ctx.say(`Claim the slot first: ${claimCommand(ctx, list.length > 1 ? watchId : null, input.slot)} shows it is yours. Then link it again, or ask the bot owner to link it for you.`);
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
