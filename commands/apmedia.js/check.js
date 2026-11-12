// /apmedia check: count a title by hand, for a watch or listen the bot could not see.
//
//   !apmedia check <title>                     finished: the title's checks
//   !apmedia check <title> at 1h30m            watched up to there: its checkpoints so far
//   !apmedia check <title> @1:30:00 slot=Zack  the same, on one of several slots
//
// A typed title that is not one on the list in full is answered with the titles it is probably
// meant to be, never credited on a guess: a check sent for the wrong title cannot be taken back.
// A text that is a list title in full is never split at its "at": Murder at 1600 is a film.

const common = require('./common.js');

function parseDuration(text) {
	return require('../../helpers/apMediaCredit.js').parseDuration(text);
}

// Greedy, so the last "at" or "@" is the one tried: "Breakfast at Tiffany's at 45m".
const AT_WORD = /^(.*\S)\s+at\s+(\S.*)$/i;
const AT_SIGN = /^(.*\S)\s*@\s*(\S.*)$/;

/** "<title> at <time>" or "<title> @<time>": the title and the time text, when the tail reads as a time. */
function splitAt(text) {
	const s = String(text || '').trim();
	for (const re of [AT_WORD, AT_SIGN]) {
		const m = re.exec(s);
		if (m && parseDuration(m[2].trim()) !== null) return { title: m[1].trim(), at: m[2].trim() };
	}
	return { title: s, at: null };
}

/** loose: the time, if any, is still inside the title text (the prefix form without at=). */
function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const at = common.opt(ctx, 'at');
		return {
			title: String(common.opt(ctx, 'title') ?? '').trim(),
			at: at === undefined ? null : String(at).trim(),
			slot: String(common.opt(ctx, 'slot') ?? '').trim(),
			loose: false,
		};
	}
	const { values, rest } = common.takeKeys(ctx.rest, ['slot', 'at']);
	return {
		title: rest,
		at: values.at !== undefined ? values.at : null,
		slot: values.slot !== undefined ? values.slot : '',
		loose: values.at === undefined,
	};
}

async function run(ctx) {
	const input = readInput(ctx);
	if (!input.title) return ctx.say(`Which title? \`${ctx.p}apmedia check <title> [at 1h30m]\`.`);
	const r = common.slotFor(ctx, input.slot, { others: true });
	if (!r.ok) return ctx.say(r.message);
	let { title, at } = input;
	if (input.loose) {
		const split = splitAt(title);
		if (split.at !== null && !common.exactTitle(ctx, r.key, title)) ({ title, at } = split);
	}
	let atMs = null;
	if (at) {
		atMs = parseDuration(at);
		if (atMs === null || atMs <= 0) return ctx.say(`I could not read ${common.slot(at)} as a time into the title: write it like 45m, 1h30m or 1:30:00.`);
	}
	const found = common.findTitle(ctx, r.key, title);
	if (!found.ok) return ctx.say(found.message);
	const out = await ctx.game.creditManual(r.key, found.entryKey, { atMs });
	return ctx.say(out.message);
}

module.exports = { names: ['check'], run, splitAt };
