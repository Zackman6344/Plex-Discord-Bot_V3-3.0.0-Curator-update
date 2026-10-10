// helpers/bookButtons.js
//
// The book:* button namespace: the live card's controls, the ended card's Resume / My shelf /
// Mark finished, the shelf's Resume buttons, the "Which one?" picks and the forget confirm.
//
// Every click is acknowledged exactly once within Discord's 3 s. A control click runs the engine
// action synchronously (a resource build starts unawaited) and answers with interaction.update,
// which acks and edits the card in one call, so nothing new is posted to the channel.

const logger = require('./logger.js');
const bookCard = require('./bookCard.js');

const NAMESPACE = 'book';
const CONTROLS = new Set(['prevch', 'back', 'toggle', 'fwd', 'nextch', 'speed', 'sleep', 'stop']);
const EPHEMERAL = 64;
const NO_PINGS = { parse: [] };
const STALE = 'That card is from an earlier session. /book now shows the current one.';

function report(opts, payload) {
	if (typeof opts.onInteractionResponse !== 'function') return;
	try { opts.onInteractionResponse(payload); } catch (_) {}
}

async function say(interaction, opts, content, method = 'reply') {
	const payload = { content, flags: EPHEMERAL, allowedMentions: NO_PINGS };
	report(opts, payload);
	try {
		await interaction[method](payload);
	} catch (err) {
		logger.warn(`Book button ${interaction.customId} could not answer:`, (err && err.message) || err);
	}
}

function isEphemeralMessage(message) {
	const flags = message && message.flags;
	if (!flags) return false;
	if (typeof flags.has === 'function') return flags.has(EPHEMERAL);
	return (Number(flags.bitfield !== undefined ? flags.bitfield : flags) & EPHEMERAL) !== 0;
}

function withStale(text, info) {
	return info && info.stale ? `${text}\n(The library list may be stale: the last refresh failed.)` : text;
}

async function control(interaction, bot, action, sid, opts) {
	const s = bot.books.sessionById(sid);
	if (!s || s.state === 'ended') {
		try {
			await interaction.update({ components: [] });
			report(opts, { components: [] });
		} catch (err) {
			logger.warn('Could not strip a stale book card:', (err && err.message) || err);
		}
		await say(interaction, opts, STALE, 'followUp');
		return;
	}
	const r = bot.books.controlSession(s, interaction.member, action, undefined, { cardUpdated: true });
	if (r.code === 'forbidden' || r.code === 'starting' || r.code === 'no-session') {
		await say(interaction, opts, r.text);
		return;
	}
	let card = null;
	try {
		card = r.view && r.view.state === 'ended' ? bookCard.endedCard(r.view) : bookCard.buildCard(r.view);
	} catch (err) {
		logger.error('Audiobook card render failed:', (err && err.message) || err);
	}
	try {
		if (card) {
			await interaction.update(card);
			report(opts, card);
		} else {
			await interaction.deferUpdate();
		}
	} catch (err) {
		logger.warn(`Book button ${interaction.customId} could not update the card:`, (err && err.message) || err);
		return;
	}
	if (r.code !== 'ok') await say(interaction, opts, r.text, 'followUp');
}

// The disambiguation list, the shelf and the forget confirm are ephemeral and only make sense
// once, so they are replaced by the answer; a public ended card is left as it is.
async function deferFor(interaction) {
	const replace = isEphemeralMessage(interaction.message);
	if (replace) await interaction.deferUpdate();
	else await interaction.deferReply({ flags: EPHEMERAL });
	return replace;
}

async function answerDeferred(interaction, opts, replace, content, extra = {}) {
	const payload = Object.assign({ content, allowedMentions: NO_PINGS }, replace ? { embeds: [], components: [] } : {}, extra);
	report(opts, payload);
	try {
		await interaction.editReply(payload);
	} catch (err) {
		logger.warn(`Book button ${interaction.customId} could not answer:`, (err && err.message) || err);
	}
}

async function play(interaction, bot, workId, opts) {
	let replace;
	try {
		replace = await deferFor(interaction);
	} catch (err) {
		logger.warn(`Book button ${interaction.customId} could not defer:`, (err && err.message) || err);
		return;
	}
	let r;
	try {
		(opts.ensureLibrary || require('../commands/book.js/play.js').ensureLibrary)(bot);
		r = await bot.books.play({
			guild: interaction.guild,
			member: interaction.member,
			textChannel: interaction.channel,
			workId
		});
	} catch (err) {
		logger.error('Audiobook play from a button failed:', (err && err.message) || err);
		r = { text: '❌ That did not work; check the bot log.' };
	}
	await answerDeferred(interaction, opts, replace, withStale(r.text, r.info));
}

async function forget(interaction, bot, workId, opts) {
	let replace;
	try {
		replace = await deferFor(interaction);
	} catch (err) {
		logger.warn(`Book button ${interaction.customId} could not defer:`, (err && err.message) || err);
		return;
	}
	const userId = interaction.user && interaction.user.id;
	let r;
	try {
		r = bot.books.forget(userId, workId);
	} catch (err) {
		logger.error('Audiobook forget failed:', (err && err.message) || err);
		r = { text: '❌ That did not work; check the bot log.' };
	}
	await answerDeferred(interaction, opts, replace, r.text);
}

async function finish(interaction, bot, workId, listenerId, opts) {
	const userId = interaction.user && interaction.user.id;
	if (!listenerId || userId !== listenerId) {
		await say(interaction, opts, 'Only the listener can mark their book finished.');
		return;
	}
	let r;
	try {
		r = bot.books.finish(userId, workId, { guildId: interaction.guildId });
	} catch (err) {
		logger.error('Audiobook finish failed:', (err && err.message) || err);
		r = { ok: false, text: '❌ That did not work; check the bot log.' };
	}
	if (!r.ok) {
		await say(interaction, opts, r.text);
		return;
	}
	const card = bookCard.finishedOnCard(interaction.message);
	try {
		await interaction.update(card);
		report(opts, card);
	} catch (err) {
		logger.warn('Could not update the ended book card:', (err && err.message) || err);
	}
}

async function shelf(interaction, opts) {
	let payload;
	try {
		const { buildShelf } = require('../commands/book.js/library.js');
		payload = buildShelf(interaction.user && interaction.user.id);
	} catch (err) {
		logger.error('Audiobook shelf failed:', (err && err.message) || err);
		payload = { content: '❌ Could not read your shelf; check the bot log.' };
	}
	const out = Object.assign({}, payload, { flags: EPHEMERAL, allowedMentions: NO_PINGS });
	report(opts, out);
	try {
		await interaction.reply(out);
	} catch (err) {
		logger.warn('Could not show the book shelf:', (err && err.message) || err);
	}
}

/**
 * @param {object} interaction a ButtonInteraction
 * @param {object} bot the Bot; bot.books is the BookDirector
 * @param {object} client unused, kept for the router's common signature
 * @param {{ onInteractionResponse?: Function, ensureLibrary?: Function }} [opts]
 * @returns {Promise<boolean>} true when the customId is in the book: namespace
 */
async function handle(interaction, bot, client, opts = {}) {
	if (!interaction || typeof interaction.customId !== 'string') return false;
	const [namespace, action, ...rest] = interaction.customId.split(':');
	if (namespace !== NAMESPACE) return false;

	if (!bot || !bot.books) {
		await say(interaction, opts, '📚 Audiobooks are not available right now.');
		return true;
	}
	try {
		if (CONTROLS.has(action)) await control(interaction, bot, action, rest[0], opts);
		else if (action === 'resume' || action === 'play') await play(interaction, bot, rest[0], opts);
		else if (action === 'finish') await finish(interaction, bot, rest[0], rest[1], opts);
		else if (action === 'forget') await forget(interaction, bot, rest[0], opts);
		else if (action === 'shelf') await shelf(interaction, opts);
		else await say(interaction, opts, '❌ Unknown book button.');
	} catch (err) {
		logger.error(`Book button ${interaction.customId} threw:`, (err && err.message) || err);
		const method = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
		await say(interaction, opts, '❌ That did not work; check the bot log.', method);
	}
	return true;
}

module.exports = { handle, NAMESPACE };
