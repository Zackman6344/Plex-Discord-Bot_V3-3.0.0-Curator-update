// /book play: resolve the work, join, post the public card (the engine does both), and answer
// the caller once with where it started.

const logger = require('../../helpers/logger.js');

const RESTART_FLAGS = new Set(['--restart', '--from-start', '--fromstart']);
const CUSTOM_ID_MAX = 100;

/**
 * Arms bookLibrary's hourly check when audiobooks were switched on after boot; clientReady only
 * starts it while the setting is already on. start() is idempotent but runs a library check, so
 * it is skipped once the timer is armed.
 */
function ensureLibrary(bot) {
	try {
		const lib = require('../../helpers/bookLibrary.js');
		if (typeof lib.armed === 'function' && lib.armed()) return;
	} catch (_) {}
	try {
		const p = bot && bot.books ? bot.books.start() : null;
		if (p && typeof p.catch === 'function') p.catch(() => {});
	} catch (err) {
		logger.warn('Audiobook library failed to start:', (err && err.message) || err);
	}
}

function parseArgs(rest) {
	let fromStart = false;
	const words = String(rest || '').split(/\s+/).filter((w) => {
		if (RESTART_FLAGS.has(w.toLowerCase())) {
			fromStart = true;
			return false;
		}
		return true;
	});
	return { query: words.join(' '), fromStart };
}

function clip(text, max) {
	const s = String(text);
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** "Which one?" as buttons, one per edition; each plays that work for whoever clicks it. */
function choiceRow(choices) {
	const buttons = (choices || []).slice(0, 5).map((c) => {
		const voice = c.narrator || c.edition;
		const pct = c.percent !== null && c.percent !== undefined ? ` · ${c.percent}%` : '';
		return { type: 2, style: 2, custom_id: `book:play:${c.id}`, label: clip(`${c.title}${voice ? ` (${voice})` : ''}${pct}`, 80) };
	}).filter(b => b.custom_id.length <= CUSTOM_ID_MAX);
	return buttons.length ? [{ type: 1, components: buttons }] : [];
}

function withStale(text, info) {
	return info && info.stale ? `${text}\n(The library list may be stale: the last refresh failed.)` : text;
}

async function run(ctx) {
	const { query, fromStart } = parseArgs(ctx.rest);
	ensureLibrary(ctx.bot);
	const r = await ctx.bot.books.play({
		guild: ctx.guild,
		member: ctx.member,
		userId: ctx.userId,
		textChannel: ctx.textChannel,
		query,
		fromStart
	});
	if (r.code === 'ambiguous') return ctx.say({ content: r.text, components: choiceRow(r.choices) });
	return ctx.say(withStale(r.text, r.info));
}

module.exports = { names: ['play', 'start', 'listen'], run, ensureLibrary, parseArgs, choiceRow };
