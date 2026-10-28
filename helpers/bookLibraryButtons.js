// helpers/bookLibraryButtons.js
//
// The `/book library` components, all under book:lib:
//   book:lib:open:<token>      select, "Open a section" on the landing
//   book:lib:play:<token>      select, "▶ Play ..." (values are bookSearch.shortKey of a work id)
//   book:lib:page:<token>:<n>  ◀ / ▶, edits the list in place
//   book:lib:home:<token>      back to the landing
//   book:lib:noop:<token>      the disabled "n / N" label
//
// A view lives in memory under its token: who asked (every page shows that person's marks, the
// same as the reply they asked for), the filter and the page. Pages are rendered again from the
// catalog on each click, so a rebuild in between shows the books as they are now. An hour without
// a click, or a restart of the process, forgets the view (`/restart` runs in the same process and
// keeps it); its buttons then say so. The play select needs no view: its value is resolved against
// the catalog, through the work's aliases too, so it keeps working while the book exists.
//
// Anyone may page a public list. A play pick plays for the clicker, through the book card's own
// play path (voice checks, the music gate, voice claims), and answers privately; the list stays
// where it is, drawn again.

const crypto = require('crypto');
const logger = require('./logger.js');
const bookSearch = require('./bookSearch.js');

const PREFIX = 'book:lib:';
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const TTL_MS = 60 * 60 * 1000;
const MAX_VIEWS = 500;

const views = new Map();

function report(opts, payload) {
	if (typeof opts.onInteractionResponse !== 'function') return;
	try { opts.onInteractionResponse(payload); } catch (_) {}
}

function owns(customId) {
	return typeof customId === 'string' && customId.startsWith(PREFIX);
}

function sweep(now) {
	for (const [token, v] of views) if (now - v.usedAt > TTL_MS) views.delete(token);
	while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
}

/**
 * Keep a view and hand back its token (8 hex characters). The object itself is kept, because
 * rendering it records its section names and page count on it.
 * @param {object} view { userId, cmd, query, page, sections? }
 * @param {number} [now]
 */
function remember(view, now = Date.now()) {
	sweep(now);
	let token;
	do token = crypto.randomBytes(4).toString('hex'); while (views.has(token));
	view.usedAt = now;
	views.set(token, view);
	return token;
}

/** The view under a token, or null once it has expired. Each read keeps it alive. */
function recall(token, now = Date.now()) {
	const v = views.get(token);
	if (!v) return null;
	if (now - v.usedAt > TTL_MS) {
		views.delete(token);
		return null;
	}
	v.usedAt = now;
	return v;
}

// A slash command's reply carries its interaction; a prefix reply has none.
function expiredText(interaction, prefix) {
	const m = interaction && interaction.message;
	const slash = !!(m && (m.interactionMetadata || m.interaction));
	return `This list has expired. Run \`${slash ? '/book library' : `${prefix}book library`}\` again.`;
}

async function privately(interaction, opts, content) {
	const payload = { content, flags: EPHEMERAL, allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
		else await interaction.reply(payload);
	} catch (err) {
		logger.warn(`Library control ${interaction.customId} could not answer:`, (err && err.message) || err);
	}
}

async function edit(interaction, opts, payload) {
	const out = Object.assign({ embeds: [] }, payload, { allowedMentions: NO_PINGS });
	report(opts, out);
	try {
		await interaction.update(out);
	} catch (err) {
		logger.warn(`Library control ${interaction.customId} could not update the list:`, (err && err.message) || err);
	}
}

async function redraw(interaction, opts, payload) {
	const out = Object.assign({ embeds: [] }, payload, { allowedMentions: NO_PINGS });
	report(opts, out);
	try {
		await interaction.editReply(out);
	} catch (err) {
		logger.warn(`Library control ${interaction.customId} could not redraw the list:`, (err && err.message) || err);
	}
}

function prefixOf(opts) {
	if (opts.prefix) return opts.prefix;
	try {
		return require('../config/config.js').commandPrefix || '!';
	} catch (_) {
		return '!';
	}
}

/**
 * @param {object} interaction a ButtonInteraction or StringSelectMenuInteraction under book:lib:
 * @param {object} bot
 * @param {{ onInteractionResponse?: Function, now?: () => number, library?: object,
 *   catalog?: object, play?: Function, prefix?: string }} [opts] test seams besides the logger hook
 * @returns {Promise<boolean>} true when the customId is a library one
 */
async function handle(interaction, bot, opts = {}) {
	if (!interaction || !owns(interaction.customId)) return false;
	const [, , action, token, arg] = interaction.customId.split(':');
	const now = typeof opts.now === 'function' ? opts.now() : Date.now();
	const library = opts.library || require('../commands/book.js/library.js');
	const value = Array.isArray(interaction.values) ? interaction.values[0] : undefined;

	if (action === 'noop') {
		try { await interaction.deferUpdate(); } catch (_) {}
		return true;
	}
	if (action === 'play') {
		const catalog = opts.catalog || require('./bookCatalogStore.js');
		const work = value ? bookSearch.byShortKey(String(value), catalog.works() || []) : null;
		if (!work) {
			await privately(interaction, opts, expiredText(interaction, prefixOf(opts)));
			return true;
		}
		const play = opts.play || require('./bookButtons.js').playFromList;
		await play(interaction, bot, work.id, opts);
		// Discord keeps showing the picked option until the message changes, and picking the same
		// option again sends nothing, so the list is drawn again (with the asker's new mark).
		const view = recall(token, now);
		if (view) await redraw(interaction, opts, library.renderView(view, token));
		return true;
	}

	const view = recall(token, now);
	if (!view) {
		await privately(interaction, opts, expiredText(interaction, prefixOf(opts)));
		return true;
	}
	if (action === 'page') {
		view.page = Math.max(0, Number(arg) || 0);
	} else if (action === 'home') {
		view.query = { type: 'landing' };
		view.page = 0;
	} else if (action === 'open') {
		const name = Array.isArray(view.sections) ? view.sections[Number(value)] : undefined;
		view.query = name === undefined ? { type: 'landing' } : { type: 'list', filter: library.sectionFilter(name) };
		view.page = 0;
	} else {
		await privately(interaction, opts, '❌ Unknown library control.');
		return true;
	}
	await edit(interaction, opts, library.renderView(view, token));
	return true;
}

function _reset() {
	views.clear();
}

module.exports = { handle, owns, remember, recall, expiredText, PREFIX, TTL_MS, MAX_VIEWS, _reset };
