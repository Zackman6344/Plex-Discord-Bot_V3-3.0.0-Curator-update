// /apmedia progress: where one title of a slot stands and what holds it back, or with no title, every
// title whose checkpoints a gap holds back (the ones /apmedia status counts) and up to five open titles
// to watch next. The owner may name any slot; on someone else's the reply leaves out the commands the
// game's sentences give, since redeem, ff, snackbar buy and switch take only the caller's own slots.
//
//   !apmedia progress                     what to watch next on the only linked slot
//   !apmedia progress <title>             one title in full
//   !apmedia progress <title> slot=Zack   one of several; slot="Zack 2" for a name with a space
//   !apmedia progress slot=Zack <title>   the same with slot= first

const common = require('./common.js');

const DOT = ' \u00b7 ';
const ICONS = { ready: '\u{1F513}', locked: '\u{1F512}', done: '\u2705' };
const STATES = { ready: 'open', locked: 'locked', done: 'done' };
const NOTE = '\u{1F6A7}';
const HINT = '\u{1F4A1}';
const EXPIRED = '\u26d4';
const HINTS_SHOWN = 3;
const COMMAND = '(`+)[^`]*apmedia [\\s\\S]*?\\1(?!`)';
const COMMAND_CLAUSE = new RegExp(`(?:, or [^,:.]*)?: ${COMMAND}[^.(]*?(?= \\(|\\.)`, 'g');
const COMMAND_LEFT = new RegExp(` ?${COMMAND}`, 'g');

function duration(ms) {
	return require('../../helpers/apMediaGame.js').formatDuration(ms);
}

function clock(ms) {
	return require('../../helpers/apMediaGame.js').clock(ms);
}

function joinAnd(parts) {
	if (parts.length < 2) return parts.join('');
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function hintText(h) {
	return `${common.bold(h.item)} for ${common.slot(h.receiver)}${h.priority ? ' (priority)' : ''}`;
}

function heardLine(heard) {
	if (heard.gap) return `> Heard through ${clock(heard.throughMs)}, and from ${clock(heard.gap.toMs)} to ${clock(heard.furthestMs)}.`;
	if (!(heard.throughMs > 0)) return '> Nothing heard yet.';
	return `> Heard through ${clock(heard.throughMs)}.`;
}

function waitingLine(w) {
	const parts = [];
	if (w.pending > 0) parts.push(`${common.plural(w.pending, 'check')} to send`);
	if (w.banked > 0) parts.push(`${w.banked} banked until it unlocks`);
	if (w.held > 0) parts.push(`${w.held} held by a trap`);
	return parts.length ? `> Waiting: ${joinAnd(parts)}.` : null;
}

/** A game sentence with each `<p>apmedia ...` command and the words that lead to it cut out. */
function withoutCommands(sentence) {
	return String(sentence).replace(COMMAND_CLAUSE, '').replace(COMMAND_LEFT, '');
}

/** `slot=<name>` as takeKeys reads it back, or null when it cannot: a quote first, or one beside a space. */
function slotPair(name) {
	const s = String(name ?? '');
	if (!/\s/.test(s) && !common.QUOTES.includes(s.charAt(0) || ' ')) return `slot=${s}`;
	if (![...s].some((c) => common.QUOTES.includes(c))) return `slot="${s}"`;
	return null;
}

/** One title in full, from progress()'s `{slot, standing}`; own is false for a slot of someone else. */
function progressText(out, own = true) {
	const s = out.standing;
	const text = s.text || {};
	const said = (sentence) => (own ? sentence : withoutCommands(sentence));
	const lines = [`${ICONS[s.status] || ICONS.ready} ${common.bold(s.title)} on ${common.slot(out.slot)}${DOT}${duration(s.runtimeMs)}${DOT}${STATES[s.status] || s.status}`];
	if (s.status === 'locked' && text.opener) lines.push(`> ${said(text.opener)}`);
	const cp = s.checkpoints;
	if (cp && cp.total > 0) {
		lines.push(cp.next
			? `> Checkpoints: ${cp.earned} of ${cp.total} earned; the next is at ${duration(cp.next.atMs)}.`
			: `> Checkpoints: ${cp.total} of ${cp.total} earned.`);
	}
	if (s.tracks) lines.push(`> Tracks: ${s.tracks.done} of ${s.tracks.total} done.`);
	if (s.heard) {
		lines.push(heardLine(s.heard));
		if (s.heard.heldBack && s.heard.heldBack.length && text.gapAlone) lines.push(`> ${said(text.gapAlone)}${text.fix ? ` ${said(text.fix)}` : ''}`);
	}
	const waiting = s.waiting ? waitingLine(s.waiting) : null;
	if (waiting) lines.push(waiting);
	if (s.expiredUntil) lines.push(`> ${EXPIRED} Rights expired until <t:${Math.floor(s.expiredUntil / 1000)}:t>.`);
	const hints = Array.isArray(s.hints) ? s.hints : [];
	if (hints.length) {
		const more = hints.length > HINTS_SHOWN ? ` and ${hints.length - HINTS_SHOWN} more` : '';
		lines.push(`> ${HINT} Hinted: ${hints.slice(0, HINTS_SHOWN).map(hintText).join('; ')}${more}.`);
	}
	return lines.join('\n');
}

function pickLine(s) {
	const head = `\u2022 ${common.bold(s.title)}${DOT}${duration(s.runtimeMs)}`;
	const next = s.checkpoints && s.checkpoints.next;
	if (s.heard && s.heard.heldBack && s.heard.heldBack.length && s.heard.gap) {
		return `${head}${DOT}${NOTE} held back by a gap from ${clock(s.heard.gap.fromMs)} to ${clock(s.heard.gap.toMs)}`;
	}
	const hints = Array.isArray(s.hints) ? s.hints : [];
	if (hints.length) {
		const h = hints.find((x) => x.priority) || hints[0];
		return `${head}${DOT}${HINT} hinted for ${common.slot(h.receiver)}${h.priority ? ' (priority)' : ''}${next ? `${DOT}next check at ${duration(next.atMs)}` : ''}`;
	}
	if (!next) return `${head}${DOT}${duration(s.distanceMs)} to finish`;
	const started = (s.checkpoints.earned > 0) || s.distanceMs < next.atMs;
	if (started) return `${head}${DOT}next check at ${duration(next.atMs)}, ${duration(s.distanceMs)} away`;
	return `${head}${DOT}first check at ${duration(next.atMs)}`;
}

function heldLine(h) {
	const gap = h.gap ? `${DOT}gap from ${clock(h.gap.fromMs)} to ${clock(h.gap.toMs)}, heard to ${clock(h.furthestMs)}` : '';
	return `> ${common.bold(h.title)}${gap}`;
}

function headLine(out) {
	return out.picks && out.picks.length
		? `What to watch next on ${common.slot(out.slot)}: ${common.plural(out.open, 'title')} open.`
		: `Nothing on ${common.slot(out.slot)}'s list is open and unfinished.`;
}

function footerLine(out, p, own) {
	const pair = own ? '' : slotPair(out.slot);
	return pair === null ? null : `${common.commandCode(`${p}apmedia progress <title>${pair && ` ${pair}`}`)} shows one in full.`;
}

/**
 * What to watch next, from progress()'s `{slot, open, picks}`; p is the command prefix. On a slot of
 * someone else (own false) the footer names that slot, and goes when its name cannot be typed.
 */
function picksText(out, p, own = true) {
	if (!out.picks || !out.picks.length) return headLine(out);
	const footer = footerLine(out, p, own);
	return [headLine(out), ...out.picks.map(pickLine), ...(footer ? [footer] : [])].join('\n');
}

/**
 * The reply with no title, as pages: the titles in progress()'s `held`, whose checkpoints a gap holds
 * back (the ones status counts, finished ones too), in a block of their own, then the picks not among
 * them. Without held titles it is picksText's one page.
 */
function picksPages(out, p, own = true) {
	const held = Array.isArray(out.held) ? out.held : [];
	if (!held.length) return [picksText(out, p, own)];
	const named = new Set(held.map((h) => h.entryKey));
	const picks = (out.picks || []).filter((s) => !named.has(s.entryKey));
	const footer = footerLine(out, p, own);
	const count = held.length === 1 ? '1 title has' : `${held.length} titles have`;
	return common.paginate([headLine(out)], [
		{ title: `${NOTE} ${count} checkpoints held back by a gap`, rows: held.map(heldLine) },
		{ title: null, rows: [...picks.map(pickLine), ...(footer ? [footer] : [])] },
	]);
}

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		return { title: String(common.opt(ctx, 'title') ?? '').trim(), slot: String(common.opt(ctx, 'slot') ?? '').trim() };
	}
	const { values, rest } = common.takeKeys(ctx.rest, ['slot']);
	return { title: rest, slot: values.slot !== undefined ? values.slot : '' };
}

async function run(ctx) {
	const input = readInput(ctx);
	const r = common.slotFor(ctx, input.slot, { others: true });
	if (!r.ok) return ctx.say(r.message);
	let entryKey = null;
	if (input.title) {
		const found = common.findTitle(ctx, r.key, input.title);
		if (!found.ok) return ctx.say(found.message);
		entryKey = found.entryKey;
	}
	const out = await ctx.game.progress(r.key, entryKey);
	if (!out.ok) return ctx.say(out.message);
	const own = common.slotFor(ctx, r.key).ok;
	return common.sendPages(ctx, out.standing ? [progressText(out, own)] : picksPages(out, ctx.p, own));
}

module.exports = { names: ['progress'], run, progressText, picksText, picksPages, withoutCommands, slotPair };
