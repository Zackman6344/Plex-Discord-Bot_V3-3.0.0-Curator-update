// commands/apmedia.js: /apmedia and !apmedia, the Plex Media Archipelago world.
//
// This file holds the slash spec, autocomplete, the sub-help and the dispatch. The subcommands
// live in yaml.js, apworld.js, account.js, link.js, unlink.js, retry.js, status.js, list.js,
// check.js, redeem.js and announce.js, each exporting { names, run(ctx) }, and are required
// explicitly so a stray file can never become a subcommand. helpers/apMediaGame.js does the work
// and trusts its caller, so every permission check is made here, before it is called.
//
// Replies go through say(): the first is message.reply (on slash, the editReply that closes the
// defer), later ones an ephemeral followUp on slash and a channel message on prefix. The adapter
// would post a slash command's second reply publicly, and most of these replies are about one
// person's slot or Plex account.

const { EmbedBuilder } = require('discord.js');
const config = require('../../config/config.js');
const logger = require('../../helpers/logger.js');
const commandLog = require('../../helpers/commandLog.js');
const contracts = require('../../helpers/apMediaContracts.js');
const common = require('./common.js');

const yaml = require('./yaml.js');
const apworld = require('./apworld.js');
const account = require('./account.js');
const link = require('./link.js');
const unlink = require('./unlink.js');
const retry = require('./retry.js');
const status = require('./status.js');
const list = require('./list.js');
const check = require('./check.js');
const redeem = require('./redeem.js');
const announce = require('./announce.js');

const EPHEMERAL = 64;
const CONTENT_MAX = 2000;
const CHOICE_MAX = 100;
const MAX_CHOICES = 25;
// The world file is for the owner to pass on; everything else is about one person's slot or account.
const PUBLIC = new Set(['apworld']);
// Where the owner may name anybody's slot; redeem and announce are the bound player's own.
const OTHERS = new Set(['unlink', 'retry', 'status', 'list', 'check']);

// No prototype: `!apmedia constructor` would otherwise find Object and throw instead of answering.
const HANDLERS = Object.create(null);
for (const mod of [yaml, apworld, account, link, unlink, retry, status, list, check, redeem, announce]) {
	for (const name of mod.names) HANDLERS[name] = mod;
}

const deps = { game: null, builder: null, monitor: null, apworld: null, buttons: null, installedApworld: undefined };
let sharedBuilder = null;

function game() {
	return deps.game || require('../../helpers/apMediaGame.js');
}

// The game's builder, whose playlist cache the game warms when it starts; the autocomplete reads it.
function builder() {
	if (deps.builder) return deps.builder;
	const g = game();
	if (g && typeof g.builder === 'function') return g.builder();
	if (!sharedBuilder) sharedBuilder = require('../../helpers/apMediaYaml.js').createBuilder();
	return sharedBuilder;
}

function monitor() {
	return deps.monitor || require('../../helpers/archipelagoMonitor.js');
}

function apworldBuild() {
	return deps.apworld || require('../../helpers/apworldBuild.js');
}

function buttons() {
	return deps.buttons || require('../../helpers/apMediaButtons.js');
}

/** The installed world file the apworld reply compares against, or null with no install set. */
function installedApworld() {
	if (deps.installedApworld !== undefined) return deps.installedApworld;
	const dir = String(config.archipelagoInstallDir || '').trim();
	return dir ? require('path').join(dir, 'custom_worlds', `${contracts.APWORLD_NAME}.apworld`) : null;
}

function offText(p) {
	return `\u{1F3AC} Plex Media is turned off. The bot owner can turn it on with \`${p}config\`, under AP Media (\`apMediaEnabled\`).`;
}

const SLOT = (description, required = false) => ({ name: 'slot', type: 'STRING', description, required, autocomplete: true });
const TITLE = (description) => ({ name: 'title', type: 'STRING', description, required: true, autocomplete: true });
const MINUTES = (name, what, given) => ({ name, type: 'INTEGER', description: `${what} checkpoint every N minutes (0 is off, default ${given})` });
const PRESET_CHOICES = Object.keys(contracts.PRESETS).map((value) => ({ name: value, value }));
const ONE_SLOT = 'The linked slot (empty: your only one)';

const SUBCOMMANDS = [
	{ name: 'yaml', description: 'Build your Plex Media list: a YAML for the next Archipelago seed',
		options: [
			{ name: 'name', type: 'STRING', required: true, description: 'Your slot name in the room, 1-16 characters' },
			{ name: 'for', type: 'USER', description: 'Owner: build it for someone else', omitFromQuery: true },
			{ name: 'preset', type: 'STRING', description: 'A starting mix when no counts are given (default movies)', choices: PRESET_CHOICES },
			{ name: 'movies', type: 'INTEGER', description: 'Movies in all, hand-picks included (0-200)' },
			{ name: 'shows', type: 'INTEGER', description: 'TV shows in all (0-50)' },
			{ name: 'albums', type: 'INTEGER', description: 'Music albums in all (0-200)' },
			{ name: 'books', type: 'INTEGER', description: 'Audiobooks in all (0-50)' },
			{ name: 'titles', type: 'STRING', description: 'Hand-picks split by ; (prefix movie:, show:, album: or book:; show: X S1-2)' },
			{ name: 'playlist', type: 'STRING', description: 'A Plex playlist to add, in its order', autocomplete: true },
			{ name: 'collection', type: 'STRING', description: 'A Plex collection to add' },
			{ name: 'genre', type: 'STRING', description: 'Random picks of this genre only' },
			{ name: 'years', type: 'STRING', description: 'Random picks from these years only: 1990 or 1990-1999' },
			{ name: 'unwatched', type: 'BOOLEAN', description: 'Leave out what you watched (default true; needs your Plex account)' },
			{ name: 'max-episodes', type: 'INTEGER', description: 'Episodes per random show (1-500, default 24)' },
			MINUTES('time-movies', 'Movie', 15),
			MINUTES('time-episodes', 'Episode', 10),
			MINUTES('time-albums', 'Album and playlist', 0),
			MINUTES('time-books', 'Audiobook', 30),
			{ name: 'goal-percent', type: 'INTEGER', description: 'Share of the list to finish (1-100, default 80)' },
			{ name: 'tv-unlock', type: 'STRING', description: 'What one show item opens (default episodes)',
				choices: [{ name: 'a few episodes', value: 'episodes' }, { name: 'a season', value: 'season' }] },
			{ name: 'episodes-per-unlock', type: 'INTEGER', description: 'Episodes one show item opens (1-12, default 3)' },
			{ name: 'more', type: 'STRING', description: 'More as key=value: label, starting_unlocks, wild_tickets, strict, locked_watches, checkpoint_items' }
		] },
	{ name: 'apworld', description: 'Owner: the Plex Media world file to install in Archipelago' },
	{ name: 'account', description: 'Owner: the server\'s Plex accounts, or link one to someone. Anyone: plex:none drops your own link',
		options: [
			{ name: 'user', type: 'USER', description: 'Who to link (empty: list the accounts)', omitFromQuery: true },
			{ name: 'plex', type: 'STRING', description: 'Their Plex account name or id, or none to unlink' },
			{ name: 'shared', type: 'BOOLEAN', description: 'Owner: link an account someone else has too (they use it together)', flag: 'shared=yes' }
		] },
	{ name: 'link', description: 'Tie a Plex Media slot of a watched room to you (/ap claim it first)',
		options: [
			{ name: 'slot', type: 'STRING', required: true, description: 'The slot name in the room' },
			{ name: 'user', type: 'USER', description: 'Owner: link it for someone else', omitFromQuery: true },
			{ name: 'watch', type: 'INTEGER', description: 'Watch id from /ap list (default 0)' }
		] },
	{ name: 'unlink', description: 'Drop a slot link (its unsent checks go with it)', options: [SLOT('The linked slot', true)] },
	{ name: 'retry', description: 'Reconnect a refused or stale slot', options: [SLOT(ONE_SLOT)] },
	{ name: 'status', description: 'Progress, goal, connection and Plex account of your slots',
		options: [SLOT('One linked slot (empty: all of yours)'), { name: 'user', type: 'USER', description: 'Owner: someone else\'s slots', omitFromQuery: true }] },
	{ name: 'list', description: 'Your list: what is ready, locked or done',
		options: [
			{ name: 'show', type: 'STRING', description: 'Which titles (default ready)',
				choices: [{ name: 'ready', value: 'ready' }, { name: 'locked', value: 'locked' }, { name: 'done', value: 'done' }] },
			SLOT(ONE_SLOT)
		] },
	{ name: 'check', description: 'Count a title by hand: finished, or watched up to a time',
		options: [TITLE('A title on your list'), { name: 'at', type: 'STRING', description: 'Only up to here: 45m, 1h30m or 1:30:00' }, SLOT(ONE_SLOT)] },
	{ name: 'redeem', description: 'Spend a Wild Ticket to open a locked title', options: [TITLE('A locked title on your list'), SLOT(ONE_SLOT)] },
	{ name: 'announce', description: 'Turn your slot\'s lines in the channel on or off',
		options: [
			{ name: 'mode', type: 'STRING', required: true, description: 'on or off', choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] },
			SLOT(ONE_SLOT)
		] }
];

function fences(text) {
	return (text.match(/```/g) || []).length;
}

// By code point, so an emoji is never cut in half. An odd fence count would leave the ellipsis,
// and everything after it in the client, inside a code block.
function clipContent(text) {
	if (text.length <= CONTENT_MAX) return text;
	const take = (budget) => {
		let out = '';
		for (const ch of text) {
			if (out.length + ch.length > budget) break;
			out += ch;
		}
		return out;
	};
	let out = take(CONTENT_MAX - 1);
	if (fences(out) % 2) {
		out = take(CONTENT_MAX - 1 - '\n```\n'.length);
		if (fences(out) % 2) out += '\n```\n';
	}
	return `${out}\u2026`;
}

/**
 * Message-shaped replies that never reject and never ping.
 * @param {object} message a Message or the interaction adapter
 * @param {{ ephemeral: boolean }} opts whether slash follow-ups are private
 */
function makeSay(message, { ephemeral = true } = {}) {
	let first = true;
	return async function say(payload) {
		const body = Object.assign(typeof payload === 'string' ? { content: payload } : Object.assign({}, payload), { allowedMentions: common.NO_PINGS });
		// Discord rejects the whole reply over the limit, and on slash the first reply is the only
		// thing that closes the "thinking..." defer.
		if (typeof body.content === 'string') body.content = clipContent(body.content);
		try {
			if (first) {
				first = false;
				return await message.reply(body);
			}
			if (message.interaction) {
				return await message.interaction.followUp(ephemeral ? Object.assign(body, { flags: EPHEMERAL }) : body);
			}
			return await message.channel.send(body);
		} catch (err) {
			logger.warn('/apmedia could not reply:', (err && err.message) || err);
			return null;
		}
	};
}

function helpEmbed(bot) {
	const p = common.prefixOf(bot);
	return new EmbedBuilder()
		.setColor('#E5A00D')
		.setTitle('\u{1F3AC} PLEX MEDIA (ARCHIPELAGO)')
		.setDescription(
			'Your Plex to-watch list as an Archipelago game: items from the multiworld unlock its titles, and watching or listening sends the checks. Everything works as `/apmedia ...` too.\n\n' +
			'**\u{1F4DD} JOINING A SEED**\n' +
			`> \`${p}apmedia yaml name=You [movies=10] [titles="Alien; Aliens"] [unwatched=false]\`: Build your list and send the file to the owner. Keys: preset, movies, shows, albums, books, titles, playlist, collection, genre, years, unwatched, max_episodes, time_movies, time_episodes, time_albums, time_books, goal_percent, tv_unlock, episodes_per_unlock, label, starting_unlocks, wild_tickets, strict, locked_watches, checkpoint_items.\n` +
			`> \`${p}ap claim <slot>\`, then \`${p}apmedia link <slot> [watch=n]\`: Once the seed is up, tie your slot to you.\n\n` +
			'**\u{1F37F} PLAYING**\n' +
			`> \`${p}apmedia list [ready|locked|done] [slot]\`: Your titles by show and album; \u{1F4A1} marks one somebody hinted.\n` +
			`> \`${p}apmedia status [slot]\`: Progress, goal, connection, Plex account and how far your last Plex session got.\n` +
			`> \`${p}apmedia check <title> [at 1h30m] [slot=x]\`: Count a title by hand: finished, or up to a time.\n` +
			`> \`${p}apmedia redeem <title> [slot=x]\`: Spend a Wild Ticket on a locked title (a show: its next few episodes).\n` +
			`> \`${p}apmedia announce on|off [slot]\`: Your slot's lines in the channel.\n` +
			`> \`${p}apmedia retry [slot]\` / \`${p}apmedia unlink <slot>\`: Reconnect a refused or stale slot, or drop it.\n` +
			`> \`${p}apmedia account none\`: Take back your Plex account link; its history is no longer read.\n\n` +
			'**\u{1F527} OWNER**\n' +
			`> \`${p}apmedia account [@user <plex name|id|none>] [shared=yes]\`: The server's Plex accounts by DM, or link one to someone; they accept with a button before anything is read. An account somebody else has needs shared=yes.\n` +
			`> \`${p}apmedia apworld\`: The world file to install in Archipelago.\n` +
			`> \`${p}apmedia link <slot> @user\` / \`${p}apmedia yaml for=@user ...\`: Do it for someone else.`
		);
}

// ---- autocomplete ---------------------------------------------------------------------------
// Answered from memory: the game's bindings and slot indexes, and the builder's playlist cache.
// Nothing here waits on Plex. The game fills the playlist cache when it starts, and a cache that
// is ten minutes old starts one background refresh (apMediaYaml cachedPlaylists: never awaited,
// one in flight at most).

function choice(name, value) {
	const text = String(name);
	return { name: text.length > CHOICE_MAX ? `${text.slice(0, CHOICE_MAX - 1)}\u2026` : text, value };
}

function slotChoices(sub, userId, typed) {
	const all = OTHERS.has(sub) && common.isOwner(userId);
	return game().slotNames(typed || '', all ? null : userId);
}

// A Wild Ticket only opens a locked title, so redeem offers those alone.
function lockedChoices(key, typed) {
	const res = game().list(key, 'locked');
	if (!res || !res.ok) return [];
	const normTitle = require('../../helpers/apMediaCredit.js').normTitle;
	const want = normTitle(typed || '');
	const out = [];
	for (const group of res.groups) {
		for (const row of group.rows) {
			if (want && !normTitle(row.title).includes(want)) continue;
			if (row.ref && row.ref.length <= CHOICE_MAX) out.push(choice(row.title, row.ref));
			if (out.length >= MAX_CHOICES) return out;
		}
	}
	return out;
}

function titleChoices(sub, userId, interaction, typed) {
	const got = interaction.options.get('slot');
	const text = got && typeof got.value === 'string' ? got.value.trim() : '';
	const all = !!text && OTHERS.has(sub) && common.isOwner(userId);
	const r = game().resolveBinding(text, { userId, all });
	if (!r.ok) return [];
	return sub === 'redeem' ? lockedChoices(r.key, typed) : game().titles(r.key, typed || '');
}

function playlistChoices(typed) {
	const lists = builder().cachedPlaylists(typed || '');
	return lists
		.map((pl) => choice(`${pl.title} (${pl.type}${pl.items ? `, ${pl.items} items` : ''})`, String(pl.rk)))
		.filter((c) => c.value.length <= CHOICE_MAX);
}

async function autocomplete(interaction) {
	let choices = [];
	try {
		if (config.apMediaEnabled) {
			const focused = interaction.options.getFocused(true);
			let sub = null;
			try { sub = interaction.options.getSubcommand(false); } catch (_) {}
			const userId = interaction.user ? String(interaction.user.id) : null;
			if (focused.name === 'slot') choices = slotChoices(sub, userId, focused.value);
			else if (focused.name === 'title') choices = titleChoices(sub, userId, interaction, focused.value);
			else if (focused.name === 'playlist') choices = playlistChoices(focused.value);
			commandLog.noteTyped({ userId, command: interaction.commandName || 'apmedia', sub, text: focused.value });
		}
	} catch (err) {
		logger.warn('/apmedia autocomplete failed:', (err && err.message) || err);
		choices = [];
	}
	try { await interaction.respond(choices.slice(0, MAX_CHOICES)); } catch (_) {}
}

function unknownText(p, word) {
	const lower = word.toLowerCase();
	const near = lower.length >= 4 ? Object.keys(HANDLERS).find((n) => require('../../helpers/bookSearch.js').damerau(lower, n) <= 1) : null;
	const known = `\`${p}apmedia ?\` lists them.`;
	return near
		? `Unknown /apmedia command "${common.esc(word)}". Did you mean \`${p}apmedia ${near}\`? ${known}`
		: `Unknown /apmedia command "${common.esc(word)}". ${known}`;
}

module.exports = {
	name: 'apmedia',
	command: {
		usage: '<yaml|apworld|account|link|unlink|retry|status|list|check|redeem|announce>',
		description: 'Plex Media: your Plex to-watch list as an Archipelago game. Type "!apmedia ?" for more help.',
		slash: {
			description: 'Plex Media: your Plex to-watch list as an Archipelago game',
			ephemeral: (i) => !PUBLIC.has(i.options.getSubcommand(false)),
			subcommands: SUBCOMMANDS,
			autocomplete
		},
		process: async function(bot, client, message, query) {
			const text = String(query || '').trim();
			const first = text.split(/\s+/)[0] || '';
			const sub = first.toLowerCase();
			const p = common.prefixOf(bot);
			if (!text || sub === '?' || sub === 'help') {
				try {
					await message.channel.send({ embeds: [helpEmbed(bot)], allowedMentions: common.NO_PINGS });
				} catch (err) {
					logger.warn('Could not send the /apmedia help:', (err && err.message) || err);
				}
				return;
			}
			const say = makeSay(message, { ephemeral: !PUBLIC.has(sub) });
			const handler = HANDLERS[sub];
			if (!handler) return say(unknownText(p, first));
			if (!config.apMediaEnabled) return say(offText(p));
			const interaction = message.interaction || null;
			const ctx = {
				bot,
				client,
				message,
				interaction,
				sub,
				rest: text.slice(first.length).trim(),
				guild: message.guild || null,
				guildId: message.guild ? message.guild.id : null,
				member: message.member || null,
				userId: message.author ? String(message.author.id) : null,
				textChannel: interaction ? interaction.channel : message.channel,
				say,
				p,
				game: game(),
				builder,
				monitor,
				apworld: apworldBuild,
				buttons: buttons(),
				installedApworld
			};
			try {
				return await handler.run(ctx);
			} catch (err) {
				logger.error(`/apmedia ${sub} failed:`, (err && err.stack) || err);
				return say('\u274C That did not work; the bot log has the error.');
			}
		}
	}
};

/** Tests: swap the game, the YAML builder, the monitor, the apworld builder or the buttons. */
function use(overrides = {}) {
	const before = { ...deps };
	Object.assign(deps, overrides);
	return () => Object.assign(deps, before);
}

module.exports._internal = { makeSay, clipContent, helpEmbed, offText, use, SUBCOMMANDS, HANDLERS, PUBLIC };
