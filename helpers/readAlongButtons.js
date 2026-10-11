// helpers/readAlongButtons.js
//
// The read-along's buttons: bookread:<sid> (📖 on the public book card) and bookpage:* (the
// page buttons, on a DM page or on the ephemeral page 📖 opens). A separate namespace from
// book:*, so helpers/bookButtons.js never claims them (it compares the whole first segment).
//
// 📖 is for the listener and for anyone in the book's voice channel at that moment, who hears the
// same words anyway; anyone else is told to join it and sees no text, because the page shows
// exactly where the listener is and could spoil a book someone else is reading. The page is
// always an ephemeral reply, never a channel message.
//
// Every click is acknowledged at once (deferReply or deferUpdate), because a first download and
// parse can take minutes; the clicker sees "Preparing the text" instead of "thinking…".

const logger = require('./logger.js');
const card = require('./readAlongCard.js');
const { readerAccess, joinToReadText } = require('./readAlong.js');

const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const STALE = 'That book is no longer playing.';

function report(opts, payload) {
	if (typeof opts.onInteractionResponse !== 'function') return;
	try { opts.onInteractionResponse(payload); } catch (_) {}
}

function codeOf(err) {
	return (err && (err.code || err.name)) || 'error';
}

async function say(interaction, opts, content) {
	const payload = { content, flags: EPHEMERAL, allowedMentions: NO_PINGS };
	report(opts, payload);
	const method = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
	try {
		await interaction[method](payload);
	} catch (err) {
		logger.warn('Read-along button could not answer:', codeOf(err));
	}
}

async function cardClick(interaction, bot, sid, opts) {
	try {
		await interaction.deferReply({ flags: EPHEMERAL });
	} catch (err) {
		logger.warn('Read-along button could not defer:', codeOf(err));
		return;
	}
	const answer = async (payload) => {
		report(opts, payload);
		try {
			await interaction.editReply(payload);
		} catch (err) {
			logger.warn('Read-along button could not answer:', codeOf(err));
		}
	};
	const s = bot.books.sessionById(sid);
	if (!s || s.state === 'ended') return answer(card.noticePayload(STALE));
	const uid = String((interaction.user && interaction.user.id) || '');
	if (!readerAccess(s, interaction)) return answer(card.noticePayload(joinToReadText(s)));
	// Only when a download or parse may follow; a known "no text" answers at once anyway.
	const st = bot.readAlong.statusOf(s);
	if (st === 'available' || st === 'unknown') await answer(card.preparingPayload({ bookTitle: s.work && s.work.title }));
	let payload;
	try {
		payload = await bot.readAlong.ephemeralFor(s, uid, null);
	} catch (err) {
		logger.error('Read-along page failed:', codeOf(err));
		payload = card.noticePayload('❌ That did not work; check the bot log.');
	}
	return answer(payload);
}

/**
 * @param {object} interaction a ButtonInteraction
 * @param {object} bot the Bot; bot.books is the director, bot.readAlong the pager
 * @param {object} client unused, kept for the router's common signature
 * @param {{ onInteractionResponse?: Function }} [opts]
 * @returns {Promise<boolean>} true when the customId is bookread:* or bookpage:*
 */
async function handle(interaction, bot, client, opts = {}) {
	if (!interaction || typeof interaction.customId !== 'string') return false;
	const [namespace, sid] = interaction.customId.split(':');
	if (namespace !== 'bookread' && namespace !== card.NAMESPACE) return false;

	if (!bot || !bot.books || !bot.readAlong) {
		await say(interaction, opts, '📖 Read-along is not available right now.');
		return true;
	}
	try {
		if (namespace === 'bookread') {
			await cardClick(interaction, bot, sid, opts);
			return true;
		}
		const id = card.parsePageId(interaction.customId);
		if (!id) {
			await say(interaction, opts, '❌ Unknown page button.');
			return true;
		}
		// 📌 pins "now", and the deferUpdate below is a Discord round trip of its own.
		const captured = id.act === 'mark' && typeof bot.readAlong.capture === 'function' ? bot.readAlong.capture(id.sid) : null;
		await interaction.deferUpdate();
		await bot.readAlong.onPageButton(interaction, id, { report: p => report(opts, p), captured });
	} catch (err) {
		logger.error('Read-along button threw:', codeOf(err));
		await say(interaction, opts, '❌ That did not work; check the bot log.');
	}
	return true;
}

module.exports = { handle };
