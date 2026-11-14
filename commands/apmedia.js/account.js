// /apmedia account: the Plex server's accounts, and the link from a Discord user to one.
//
//   !apmedia account                                  (owner) the accounts, privately (by DM on the prefix path)
//   !apmedia account @user                            (owner) who they are linked to
//   !apmedia account @user <name or id>               (owner) link them; they accept with a button first
//   !apmedia account @user <name or id> shared=yes    (owner) the same, for an account somebody else holds
//   !apmedia account @user none                       (owner) unlink them
//   !apmedia account none                             (anyone) drop your own link
//
// A friend's Plex history is read only after they accept: the owner holds the token that reads
// every account on the server, and the link alone is the owner's choice, not theirs, so taking it
// back is theirs too. The Accept button goes by DM, with the account's name; when their DMs are
// shut, this channel only asks them to open them, since the Plex account names are not for it.
//
// A name counts only in full (or the account's id): the link reads that account's whole history,
// so part of a name is answered with a question. In full means every letter and digit in order:
// case, spaces and punctuation are left out of the comparison, since a Plex name like
// "movie night crew" gets typed as movienightcrew.

const logger = require('../../helpers/logger.js');
const common = require('./common.js');

const NONE = new Set(['none', 'off', 'unlink', 'remove']);
const SWITCH = new Map([
	['yes', true], ['true', true], ['on', true], ['1', true],
	['no', false], ['false', false], ['off', false], ['0', false],
]);

function readInput(ctx) {
	if (common.isSlash(ctx)) {
		const user = common.optUser(ctx, 'user');
		const plex = common.opt(ctx, 'plex');
		return {
			user: user ? { id: String(user.id), user } : null,
			plex: typeof plex === 'string' ? plex.trim() : '',
			shared: common.opt(ctx, 'shared') === true,
		};
	}
	const { values, rest: text } = common.takeKeys(ctx.rest, ['shared']);
	let shared = false;
	if (values.shared !== undefined) {
		shared = SWITCH.get(String(values.shared).trim().toLowerCase());
		if (shared === undefined) return { error: 'shared= takes yes or no.' };
	}
	const { ids, rest } = common.takeMentions(text);
	if (!ids.length) return { user: null, plex: rest, shared };
	const id = ids[0];
	let user = null;
	try {
		const mentions = ctx.message && ctx.message.mentions && ctx.message.mentions.users;
		if (mentions && typeof mentions.get === 'function') user = mentions.get(id) || null;
		if (!user && mentions && typeof mentions.first === 'function') {
			const first = mentions.first();
			if (first && String(first.id) === id) user = first;
		}
	} catch (_) {}
	return { user: { id, user }, plex: rest, shared };
}

function accountLine(a) {
	return `\u2022 ${common.slot(a.name)}: id ${a.id}${Number(a.id) === 1 ? ', the server owner' : ''}`;
}

/** The accounts, or null once the failure is answered. */
async function readAccounts(ctx) {
	try {
		return await ctx.game.plexAccounts();
	} catch (err) {
		logger.warn('/apmedia account could not read the Plex accounts:', (err && err.message) || err);
		const code = common.plexCode(err);
		await ctx.say(`\u274C Could not read the Plex server's accounts${code ? ` (${code})` : ''}; the bot log has the details.`);
		return null;
	}
}

/**
 * A reply that names other people's Plex accounts: as it is on slash (private), by DM on the
 * prefix path, which answers in the channel.
 * @param {{sent: string, failed: string}} what how the DM is named in the channel note
 */
async function privately(ctx, text, what) {
	if (ctx.interaction) return ctx.say(text);
	try {
		await ctx.message.author.send({ content: text.length > 2000 ? `${text.slice(0, 1999)}\u2026` : text, allowedMentions: common.NO_PINGS });
		return ctx.say(`\u{1F4EC} Sent you ${what.sent} by DM.`);
	} catch (err) {
		logger.info(`/apmedia account could not DM ${what.sent}:`, (err && err.message) || err);
		return ctx.say(`I could not DM you ${what.failed}: \`/apmedia account\` shows it privately.`);
	}
}

async function listAccounts(ctx) {
	const accounts = await readAccounts(ctx);
	if (!accounts) return null;
	const text = accounts.length
		? [`Plex accounts on this server (link one with \`/apmedia account user:@someone plex:<name or id>\`):`, ...accounts.map(accountLine)].join('\n')
		: 'The Plex server lists no accounts besides the owner\'s own.';
	return privately(ctx, text, { sent: 'the Plex account list', failed: 'the account list' });
}

function showLink(ctx, user) {
	const a = ctx.game.accountOf(user.id);
	if (!a) return ctx.say(`<@${user.id}> has no Plex account linked: \`/apmedia account user:@them plex:<name or id>\` links one.`);
	if (a.implicit) return ctx.say(`<@${user.id}> is the bot owner, read as the server owner (account 1) unless you link another.`);
	const name = a.name ? `${common.slot(a.name)} ` : '';
	return ctx.say(`<@${user.id}> is linked to Plex account ${name}(id ${a.accountId}), ${a.consent === 'granted' ? 'accepted' : 'waiting for their consent'}.`);
}

// Marks stay: a Devanagari or Thai vowel sign is part of the name, and without it two names share
// their consonants. A key with no letter or digit at all is no key, or one emoji's variation
// selector would match another's.
function letters(name) {
	const key = String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
	return /[\p{L}\p{N}]/u.test(key) ? key : '';
}

/** @returns {{account: object}|{error: string, names?: boolean}} names: the error names accounts */
function pickAccount(accounts, text) {
	const want = text.toLowerCase();
	const exact = accounts.filter((a) => String(a.name).toLowerCase() === want);
	if (/^\d+$/.test(text)) {
		// An id first; a Plex user name can be all digits too.
		const hit = accounts.find((a) => Number(a.id) === Number(text)) || (exact.length === 1 ? exact[0] : null);
		return hit ? { account: hit } : { error: `No Plex account on this server has id ${text}: \`/apmedia account\` lists them.` };
	}
	if (exact.length === 1) return { account: exact[0] };
	if (exact.length > 1) return { error: `Several Plex accounts are called ${common.slot(text)}: give the id (${exact.map((a) => a.id).join(', ')}).` };
	const key = letters(text);
	const same = key ? accounts.filter((a) => letters(a.name) === key) : [];
	if (same.length === 1) return { account: same[0] };
	if (same.length > 1) return { error: `Several Plex accounts match ${common.slot(text)}: give the id (${same.map((a) => a.id).join(', ')}).` };
	const starts = accounts.filter((a) => String(a.name).toLowerCase().startsWith(want) || (key && letters(a.name).startsWith(key)));
	const near = starts.length ? starts : accounts.filter((a) => String(a.name).toLowerCase().includes(want) || (key && letters(a.name).includes(key)));
	if (near.length === 1) {
		return { error: `No Plex account is called ${common.slot(text)}. Did you mean ${common.slot(near[0].name)} (id ${near[0].id})? Give its full name or its id.`, names: true };
	}
	if (near.length > 1) {
		const shown = near.slice(0, 10).map((a) => `${common.slot(a.name)} (id ${a.id})`).join(', ');
		return { error: `No Plex account is called ${common.slot(text)}. Did you mean one of ${shown}${near.length > 10 ? ', ...' : ''}? Give the full name or the id.`, names: true };
	}
	return { error: `No Plex account is called ${common.slot(text)}: \`/apmedia account\` lists them.` };
}

function consentText(account, sharedWith = []) {
	const name = account.name ? `the Plex account ${common.slot(account.name)}` : `Plex account ${account.accountId}`;
	const lines = [
		`\u{1F3AC} **Plex Media (Archipelago):** the bot owner linked you to ${name} on their Plex server.`,
		'If you accept, the bot reads that account\'s Plex history (what was watched or listened to, and when) to count the titles on your Plex Media list, and posts the ones you finish in the game\'s channel. Nothing is read before you accept, and `/apmedia account plex:none` takes it back at any time.',
	];
	if (sharedWith.length) {
		lines.push(`That account is also linked to ${sharedWith.map((id) => `<@${id}>`).join(', ')}: what any of you watches on it counts for all of you.`);
	}
	return lines.join('\n');
}

/** Sends the Accept button; returns the line that tells the owner where it went. */
async function askConsent(ctx, user, account, sharedWith) {
	const components = [ctx.buttons.consentRow(user.id, account.linkedAt)];
	let target = user.user;
	if (!target && ctx.client && ctx.client.users && typeof ctx.client.users.fetch === 'function') {
		try {
			target = await ctx.client.users.fetch(user.id);
		} catch (_) {}
	}
	if (target && typeof target.send === 'function') {
		try {
			await target.send({ content: consentText(account, sharedWith), components, allowedMentions: common.NO_PINGS });
			return '\u{1F4E8} They have a DM with an Accept button.';
		} catch (err) {
			logger.info('/apmedia account could not DM the consent request:', (err && err.message) || err);
		}
	}
	try {
		await ctx.textChannel.send({
			content: `<@${user.id}>: the bot owner linked you to a Plex account for Plex Media, and your DMs are closed to the bot. Open them for this server, then ask the owner to link you again: the request comes by DM.`,
			allowedMentions: common.NO_PINGS,
		});
		return 'Their DMs are closed to the bot, so this channel asks them to open them (naming them without a ping): link them again once they have.';
	} catch (err) {
		logger.warn('/apmedia account could not post the consent request:', (err && err.message) || err);
		return '\u26A0\uFE0F The request could not reach them, by DM or here: link them again once they can get it.';
	}
}

async function linkTo(ctx, user, text, shared) {
	const accounts = await readAccounts(ctx);
	if (!accounts) return null;
	const pick = pickAccount(accounts, text);
	if (pick.error) {
		return pick.names ? privately(ctx, pick.error, { sent: 'the Plex accounts that match', failed: 'the accounts that match' }) : ctx.say(pick.error);
	}
	const r = await ctx.game.linkAccount(user.id, { accountId: pick.account.id, name: pick.account.name, by: ctx.userId, shared });
	if (!r.ok) {
		if (!r.heldBy || !r.heldBy.length) return ctx.say(r.message);
		return ctx.say(`${r.message} To link it anyway, add ${common.isSlash(ctx) ? '`shared:True`' : '`shared=yes`'}.`);
	}
	const lines = [`<@${user.id}>: ${r.message}`];
	if (Number(pick.account.id) === 1 && user.id !== common.ownerId()) {
		lines.push('\u26A0\uFE0F Account 1 is the server owner\'s own account, so your history would count for them.');
	}
	if (r.needsConsent && r.account) lines.push(await askConsent(ctx, user, r.account, r.sharedWith || []));
	return ctx.say(lines.join('\n'));
}

async function unlinkSelf(ctx) {
	const r = await ctx.game.unlinkAccount(ctx.userId);
	if (!r.ok) return ctx.say(r.account && r.account.implicit ? r.message : 'No Plex account is linked for you.');
	let owner = '';
	if (r.account && r.account.implicit) {
		const others = (r.sharedWith || []).map((id) => `<@${id}>`);
		owner = ` You are read as the server owner (account 1) again${others.length ? `, which is also linked to ${others.join(', ')}` : ''}.`;
	}
	return ctx.say(`Your Plex account link is gone: its history is no longer read for you.${owner}`);
}

async function run(ctx) {
	const input = readInput(ctx);
	if (input.error) return ctx.say(input.error);
	// Anyone may take back their own link: their consent is theirs to withdraw, owner or not.
	const self = !input.user || input.user.id === String(ctx.userId);
	if (self && input.plex && NONE.has(input.plex.toLowerCase())) return unlinkSelf(ctx);
	const gate = common.ownerOnly(ctx, 'see and link Plex accounts');
	if (gate) return ctx.say(gate);
	if (!input.user) {
		if (input.plex) return ctx.say(`Name who to link it to: ${common.commandCode(`${ctx.p}apmedia account @someone ${input.plex}`)}.`);
		return listAccounts(ctx);
	}
	if (!input.plex) return showLink(ctx, input.user);
	if (NONE.has(input.plex.toLowerCase())) {
		const r = await ctx.game.unlinkAccount(input.user.id);
		return ctx.say(`<@${input.user.id}>: ${r.message}`);
	}
	return linkTo(ctx, input.user, input.plex, input.shared);
}

module.exports = { names: ['account', 'accounts'], run, pickAccount, consentText };
