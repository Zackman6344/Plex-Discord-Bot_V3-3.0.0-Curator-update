// helpers/archipelagoNextButtons.js
//
// ◀ ▶ on a one-slot `!ap next` reply, walking everything the slot has in logic a page at a time.
//
// The pages are rendered when the command runs and kept here under a token carried in the
// buttons' custom id, so a click shows the list the command worked out rather than asking the
// logic worker again. A list is kept for half an hour after its last use, and a click on one that
// has gone says to ask again. Only the person who asked can turn the pages: the reply answers for
// their slot, and a page turned by somebody else would move it under them.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('./logger.js');

const PREFIX = 'apnext';
const TTL_MS = 30 * 60 * 1000;
const KEPT = 50;
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };

const lists = new Map();
let issued = 0;

function prune(now = Date.now()) {
	for (const [token, entry] of lists) {
		if (now - entry.at > TTL_MS) lists.delete(token);
	}
	// Oldest first, which is Map order, since a page turn re-inserts the list it turned.
	while (lists.size > KEPT) lists.delete(lists.keys().next().value);
}

/**
 * Keep a reply's pages for its buttons.
 * @param {{userId: string, pages: string[]}} list each page is a whole message
 * @returns {string} the token the buttons carry
 */
function register({ userId, pages }) {
	issued += 1;
	const token = `${Date.now().toString(36)}${issued.toString(36)}`;
	lists.set(token, { userId: String(userId || ''), pages: [...pages], at: Date.now() });
	prune();
	return token;
}

/** The ◀ ▶ row for a page, each button carrying the page it turns to. */
function row(token, page, total) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${PREFIX}:${token}:${page - 1}`)
			.setLabel('◀')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page <= 0),
		new ButtonBuilder()
			.setCustomId(`${PREFIX}:${token}:${page + 1}`)
			.setLabel('▶')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page >= total - 1)
	);
}

function owns(customId) {
	return typeof customId === 'string' && customId.startsWith(`${PREFIX}:`);
}

function report(opts, payload) {
	if (typeof opts.onInteractionResponse !== 'function') return;
	try { opts.onInteractionResponse(payload); } catch (_) { /* only an observer */ }
}

async function refuse(interaction, opts, content) {
	const payload = { content, flags: EPHEMERAL, allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction.reply(payload);
	} catch (err) {
		logger.warn('!ap next page could not answer:', (err && (err.code || err.message)) || err);
	}
}

/**
 * Turn the page a click asks for.
 * @returns {Promise<boolean>} false when the button is not one of these
 */
async function handle(interaction, bot, client, opts = {}) {
	if (!owns(interaction.customId)) return false;
	const [, token, rawPage] = interaction.customId.split(':');
	// Checked here as well as on register: on a quiet server nobody registers another list, and an
	// hours-old page would otherwise keep turning as if it were what is in logic now.
	prune();
	const entry = lists.get(token);
	if (!entry) {
		await refuse(interaction, opts, 'This list has expired. Ask for it again to see what is in logic now.');
		return true;
	}
	const clicker = interaction.user && String(interaction.user.id);
	if (entry.userId && clicker !== entry.userId) {
		await refuse(interaction, opts, 'Only the person who asked can turn these pages.');
		return true;
	}
	const page = Math.max(0, Math.min(entry.pages.length - 1, Math.trunc(Number(rawPage)) || 0));
	entry.at = Date.now();
	lists.delete(token);
	lists.set(token, entry);
	const payload = { content: entry.pages[page], components: [row(token, page, entry.pages.length)], allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction.update(payload);
	} catch (err) {
		logger.warn('!ap next page could not turn:', (err && (err.code || err.message)) || err);
	}
	return true;
}

module.exports = {
	register,
	row,
	owns,
	handle,
	// For the tests.
	_lists: lists,
	_ttlMs: TTL_MS
};
