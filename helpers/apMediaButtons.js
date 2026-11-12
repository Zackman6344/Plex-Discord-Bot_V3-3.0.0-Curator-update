// helpers/apMediaButtons.js
// The buttons /apmedia puts on its replies: the page buttons of a long list or status, and the
// Accept button a friend presses before the bot reads their Plex history.
//
// Pages are rendered when the command runs and kept here under a token the buttons carry, as
// archipelagoNextButtons keeps !ap next's: a list is kept for half an hour after its last use, and
// only the person who asked turns its pages (the reply is about their slot, and somebody else's
// click would move it under them).
//
// An Accept button keeps nothing here. It carries the Discord user it asks and the moment the
// owner made the link, and the game's account store is read when it is pressed: the button still
// works after the bot restarted, and a newer link (the owner picked another account) turns an older
// button stale, so nobody accepts an account they were not shown.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('./logger.js');

const PAGE = 'apmedia:page:';
const CONSENT = 'apmedia:consent:';
const TTL_MS = 30 * 60 * 1000;
// Long enough for a friend who reads their DMs a few days late, short enough that an old request
// cannot be accepted after it was forgotten.
const CONSENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEPT = 50;
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const CONTENT_MAX = 2000;
const CONSENT_TOKEN = /^(\d{1,25})\.([0-9a-z]{1,12})$/;

const lists = new Map();
let issued = 0;
const deps = { game: null, now: null };

function now() {
	return typeof deps.now === 'function' ? deps.now() : Date.now();
}

function game() {
	return deps.game || require('./apMediaGame.js');
}

// Discord refuses the whole message over the limit, and a click then reads "This interaction
// failed". A cut between the halves of a surrogate pair would leave half an emoji.
function clip(text) {
	const s = String(text ?? '');
	if (s.length <= CONTENT_MAX) return s;
	let out = s.slice(0, CONTENT_MAX - 1);
	const last = out.charCodeAt(out.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
	return `${out}\u2026`;
}

function prune(at = now()) {
	for (const [token, entry] of lists) {
		if (at - entry.at > TTL_MS) lists.delete(token);
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
	const token = `${now().toString(36)}${issued.toString(36)}`;
	lists.set(token, { userId: String(userId || ''), pages: [...pages], at: now() });
	prune();
	return token;
}

/** The previous and next buttons for a page, each carrying the page it turns to. */
function row(token, page, total) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${PAGE}${token}:${page - 1}`)
			.setLabel('\u25C0')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page <= 0),
		new ButtonBuilder()
			.setCustomId(`${PAGE}${token}:${page + 1}`)
			.setLabel('\u25B6')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page >= total - 1)
	);
}

/**
 * The first page as a reply payload: with its buttons when there is more than one, the pages
 * then kept for the asker.
 * @returns {{content: string, components: object[]}}
 */
function firstPage({ userId, pages }) {
	if (pages.length <= 1) return { content: pages[0] || '', components: [] };
	const token = register({ userId, pages });
	return { content: pages[0], components: [row(token, 0, pages.length)] };
}

function consentToken(userId, linkedAt) {
	return `${String(userId)}.${Math.max(0, Math.trunc(Number(linkedAt) || 0)).toString(36)}`;
}

/** The Accept button of the account link made at linkedAt for this Discord user. */
function consentRow(userId, linkedAt) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${CONSENT}${consentToken(userId, linkedAt)}`)
			.setLabel('Accept')
			.setStyle(ButtonStyle.Success)
	);
}

function owns(customId) {
	return typeof customId === 'string' && (customId.startsWith(PAGE) || customId.startsWith(CONSENT));
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
		logger.warn('/apmedia button could not answer:', (err && (err.code || err.message)) || err);
	}
}

async function turnPage(interaction, rest, opts) {
	const [token, rawPage] = rest.split(':');
	// Checked here as well as on register: on a quiet server nobody registers another list, and an
	// hours-old page would otherwise keep turning as if it were the list now.
	prune();
	const entry = lists.get(token);
	if (!entry) {
		await refuse(interaction, opts, 'This list has expired. Ask for it again to see it as it is now.');
		return;
	}
	const clicker = interaction.user && String(interaction.user.id);
	if (entry.userId && clicker !== entry.userId) {
		await refuse(interaction, opts, 'Only the person who asked can turn these pages.');
		return;
	}
	const page = Math.max(0, Math.min(entry.pages.length - 1, Math.trunc(Number(rawPage)) || 0));
	entry.at = now();
	lists.delete(token);
	lists.set(token, entry);
	const payload = { content: clip(entry.pages[page]), components: [row(token, page, entry.pages.length)], allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction.update(payload);
	} catch (err) {
		logger.warn('/apmedia page could not turn:', (err && (err.code || err.message)) || err);
	}
}

// Ends a request for good: the button goes, the message says why.
async function close(interaction, opts, content) {
	const payload = { content: clip(content), components: [], allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction.update(payload);
	} catch (err) {
		logger.warn('/apmedia consent could not answer:', (err && (err.code || err.message)) || err);
	}
}

async function consent(interaction, rest, opts) {
	const m = CONSENT_TOKEN.exec(rest);
	if (!m) {
		await refuse(interaction, opts, 'This button is not one the bot can read. Ask the owner to link your Plex account again.');
		return;
	}
	const userId = m[1];
	const linkedAt = parseInt(m[2], 36);
	const clicker = interaction.user && String(interaction.user.id);
	if (clicker !== userId) {
		await refuse(interaction, opts, `Only <@${userId}> can accept this.`);
		return;
	}
	let account = null;
	try {
		account = game().accountOf(userId);
	} catch (err) {
		logger.warn('/apmedia consent could not read the account link:', (err && err.message) || err);
		await refuse(interaction, opts, 'The bot could not read your account link just now. Try again in a moment.');
		return;
	}
	if (!account || account.implicit) {
		await close(interaction, opts, 'This request was withdrawn: no Plex account is linked for you now.');
		return;
	}
	if (Number(account.linkedAt) !== linkedAt) {
		await close(interaction, opts, 'The owner has linked your Plex account again since this request: answer the newer one.');
		return;
	}
	if (account.consent === 'granted') {
		await close(interaction, opts, '\u2705 You accepted this already.');
		return;
	}
	if (now() - linkedAt > CONSENT_TTL_MS) {
		await close(interaction, opts, 'This request has expired. Ask the owner to link your Plex account again.');
		return;
	}
	// The game answers from its own queue, which can sit behind a credit for a moment, and Discord
	// gives a click only three seconds before it fails.
	try {
		await interaction.deferUpdate();
	} catch (err) {
		logger.warn('/apmedia consent could not acknowledge the click:', (err && (err.code || err.message)) || err);
		return;
	}
	const result = await game().grantConsent(userId, { linkedAt });
	if (!result || !result.ok) {
		const payload = { content: (result && result.message) || 'That did not work; the bot log says why.', flags: EPHEMERAL, allowedMentions: NO_PINGS };
		report(opts, payload);
		try { await interaction.followUp(payload); } catch (_) {}
		return;
	}
	const before = interaction.message && typeof interaction.message.content === 'string' ? `${interaction.message.content}\n\n` : '';
	const payload = { content: clip(`${before}\u2705 ${result.message}`), components: [], allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction.editReply(payload);
	} catch (err) {
		logger.warn('/apmedia consent could not update its message:', (err && (err.code || err.message)) || err);
	}
}

/**
 * Answer a click on one of these buttons.
 * @returns {Promise<boolean>} false when the button is not one of these
 */
async function handle(interaction, bot, client, opts = {}) {
	const id = interaction && interaction.customId;
	if (!owns(id)) return false;
	if (id.startsWith(PAGE)) await turnPage(interaction, id.slice(PAGE.length), opts);
	else await consent(interaction, id.slice(CONSENT.length), opts);
	return true;
}

/** Tests: swap the game or the clock; returns a function that puts them back. */
function _use(overrides = {}) {
	const before = { ...deps };
	Object.assign(deps, overrides);
	return () => Object.assign(deps, before);
}

module.exports = {
	register,
	row,
	firstPage,
	consentRow,
	consentToken,
	owns,
	handle,
	TTL_MS,
	CONSENT_TTL_MS,
	// For the tests.
	_lists: lists,
	_use,
};
