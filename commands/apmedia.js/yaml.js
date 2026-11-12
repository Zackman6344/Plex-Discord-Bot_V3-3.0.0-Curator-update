// /apmedia yaml: build a player's Plex Media YAML from the Plex library and attach it.
//
// Prefix form: `!apmedia yaml name=Zack movies=10 titles="Alien; Aliens" unwatched=false`. A slash
// command has room for 25 options, so the rarer settings arrive in `more` the same key=value way.
//
// "Unwatched" reads the history of exactly one Plex account: the one linked to the person the list
// is for, and only with their consent (the owner counts as the server owner, account 1, unless they
// linked another). Nobody gets anybody else's history, so the account and the Discord id are filled
// in here, never typed.

const logger = require('../../helpers/logger.js');
const common = require('./common.js');

// Anyone may build a list, and one build reads every movie, show and album listing and then the
// tracks or episodes of every pick: hundreds of Plex requests and seconds of matching.
const MAX_BUILDS = 2;
const building = new Set();

// User-facing keys, without case, dashes or underscores, to the builder's parameter names.
const KEYS = Object.freeze({
	name: 'name',
	label: 'label',
	preset: 'preset',
	movies: 'movies',
	shows: 'shows',
	albums: 'albums',
	books: 'books',
	titles: 'titles',
	title: 'titles',
	playlist: 'playlist',
	collection: 'collection',
	genre: 'genre',
	years: 'years',
	year: 'years',
	unwatched: 'unwatched',
	maxepisodes: 'maxEpisodes',
	timemovies: 'timeMovies',
	timesanitymovies: 'timeMovies',
	timeepisodes: 'timeEpisodes',
	timesanityepisodes: 'timeEpisodes',
	timealbums: 'timeAlbums',
	timesanityalbums: 'timeAlbums',
	timebooks: 'timeBooks',
	timesanitybooks: 'timeBooks',
	goalpercent: 'goalPercent',
	goal: 'goalPercent',
	episodesperunlock: 'episodesPerUnlock',
	tvunlock: 'tvUnlock',
	startingunlocks: 'startingUnlocks',
	wildtickets: 'wildTickets',
	strict: 'strict',
	timesanitystrict: 'strict',
	lockedwatches: 'lockedWatches',
	checkpointitems: 'checkpointItems',
});
const FILLED_IN = new Set(['accountid', 'account', 'discorduserid', 'discord']);
const SLASH = Object.freeze({
	name: 'name',
	preset: 'preset',
	movies: 'movies',
	shows: 'shows',
	albums: 'albums',
	books: 'books',
	titles: 'titles',
	playlist: 'playlist',
	collection: 'collection',
	genre: 'genre',
	years: 'years',
	unwatched: 'unwatched',
	'max-episodes': 'maxEpisodes',
	'time-movies': 'timeMovies',
	'time-episodes': 'timeEpisodes',
	'time-albums': 'timeAlbums',
	'time-books': 'timeBooks',
	'goal-percent': 'goalPercent',
	'tv-unlock': 'tvUnlock',
	'episodes-per-unlock': 'episodesPerUnlock',
});
const KEY_LIST = 'name, preset, movies, shows, albums, books, titles, playlist, collection, genre, years, unwatched, max_episodes, '
	+ 'time_movies, time_episodes, time_albums, time_books, goal_percent, tv_unlock, episodes_per_unlock, label, '
	+ 'starting_unlocks, wild_tickets, strict, locked_watches, checkpoint_items, for';

/**
 * key=value words into builder params. A bare word is the name when name= is not given, and a
 * mention (or for=@user) is who the list is for.
 * @returns {{params: object, forId: string|null, error?: string}}
 */
function parsePairs(text, { allowName = true, allowFor = true } = {}) {
	const params = {};
	let forId = null;
	const bare = [];
	for (const word of common.tokenize(text)) {
		const mention = /^<@!?(\d{15,25})>$/.exec(word.raw);
		if (mention && allowFor) {
			forId = mention[1];
			continue;
		}
		if (word.key === null) {
			bare.push(word.value);
			continue;
		}
		const k = common.normKey(word.key);
		if (k === 'for' && allowFor) {
			const id = /^<@!?(\d{15,25})>$/.exec(word.value) || /^(\d{15,25})$/.exec(word.value);
			if (!id) return { params, forId, error: 'for= takes a mention: for=@someone.' };
			forId = id[1];
			continue;
		}
		if (FILLED_IN.has(k)) return { params, forId, error: `${word.key} is filled in by the bot from the linked Plex account; leave it out.` };
		const param = KEYS[k];
		if (!param || (param === 'name' && !allowName)) {
			return { params, forId, error: `I do not know the option ${common.esc(word.key)}. The options are: ${KEY_LIST}.` };
		}
		if (Object.prototype.hasOwnProperty.call(params, param)) return { params, forId, error: `${common.esc(word.key)} is given twice.` };
		params[param] = word.value;
	}
	if (bare.length) {
		if (bare.length === 1 && allowName && params.name === undefined) params.name = bare[0];
		else return { params, forId, error: `Write each option as key=value, with quotes around spaces: titles="Alien; Aliens". "${common.esc(bare.join(' '))}" is not one.` };
	}
	return { params, forId };
}

function readSlash(ctx) {
	const params = {};
	for (const [option, param] of Object.entries(SLASH)) {
		const value = common.opt(ctx, option);
		if (value !== undefined) params[param] = value;
	}
	const forUser = common.optUser(ctx, 'for');
	const more = common.opt(ctx, 'more');
	if (typeof more === 'string' && more.trim()) {
		const extra = parsePairs(more, { allowName: false, allowFor: false });
		if (extra.error) return { params, forId: null, error: extra.error };
		for (const [param, value] of Object.entries(extra.params)) {
			if (Object.prototype.hasOwnProperty.call(params, param)) return { params, forId: null, error: `${param} is given twice.` };
			params[param] = value;
		}
	}
	return { params, forId: forUser ? String(forUser.id) : null };
}

function nextSteps(ctx, name, forId) {
	const claim = common.commandCode(`${ctx.p}ap claim ${name}`);
	const linkCmd = common.commandCode(`/apmedia link ${name}`);
	const who = forId ? `<@${forId}> claims the slot with ${claim} and links it with ${linkCmd} (or you link it for them)` : `claim the slot with ${claim}, then link it with ${linkCmd}`;
	const send = common.isOwner(ctx.userId) ? 'Next: put the file in Archipelago\'s Players folder before you generate.' : 'Next: send this file to the bot owner.';
	return [
		`${send} Once the seed is up, ${who}.`,
		'Every title on the list is visible to the whole room and on the public tracker.',
	];
}

async function run(ctx) {
	const read = common.isSlash(ctx) ? readSlash(ctx) : parsePairs(ctx.rest);
	if (read.error) return ctx.say(read.error);
	const params = read.params;
	if (typeof params.name !== 'string' || !params.name) {
		return ctx.say(`Give the list a slot name: \`${ctx.p}apmedia yaml name=You movies=10\`. Options: ${KEY_LIST}.`);
	}
	const target = read.forId || ctx.userId;
	const forOther = target !== ctx.userId;
	if (forOther) {
		const gate = common.ownerOnly(ctx, 'build a list for someone else');
		if (gate) return ctx.say(gate);
	}
	const account = ctx.game.accountOf(target);
	params.accountId = account && account.consent === 'granted' ? account.accountId : null;
	params.discordUserId = String(target);

	const caller = String(ctx.userId);
	if (building.has(caller)) return ctx.say('\u23F3 Your last list is still being built: wait for it, then ask again.');
	if (building.size >= MAX_BUILDS) return ctx.say(`\u23F3 ${MAX_BUILDS} lists are being built right now: try again in a minute.`);
	if (!ctx.interaction && ctx.message && ctx.message.channel && typeof ctx.message.channel.sendTyping === 'function') {
		try {
			const typing = ctx.message.channel.sendTyping();
			if (typing && typeof typing.catch === 'function') typing.catch(() => {});
		} catch (_) {}
	}
	const yamlModule = require('../../helpers/apMediaYaml.js');
	let out;
	building.add(caller);
	try {
		out = await ctx.builder().build(params);
	} catch (err) {
		const message = (err && err.message) || String(err);
		if (message === yamlModule.ACCOUNT_FIX && forOther) {
			return ctx.say(`<@${target}> has no Plex account linked with their consent, so what they watched cannot be left out: link theirs with \`/apmedia account\` (they accept it), or build with unwatched=false.`);
		}
		const plex = common.plexCode(err);
		if (plex) {
			logger.warn('/apmedia yaml could not read Plex:', message);
			return ctx.say(`\u274C Plex could not be read (${plex}), so no list was built. Try again in a while; the bot log has the details.`);
		}
		return ctx.say(`\u274C ${message}`);
	} finally {
		building.delete(caller);
	}
	const summary = out.summary;
	const lines = [
		`\u{1F4DD} ${common.slot(params.name)}: ${forOther ? `a list for <@${target}>` : 'your list'}, attached as \`${out.fileName}\`.`,
		...yamlModule.summaryLines(summary, params.name).slice(0, 2),
	];
	for (const w of summary.warnings || []) lines.push(`\u26A0\uFE0F ${common.esc(w)}`);
	for (const miss of summary.misses || []) {
		const near = miss.didYouMean && miss.didYouMean.length ? ` (did you mean ${miss.didYouMean.map(common.bold).join(', ')}?)` : '';
		lines.push(`\u2753 Not found: ${common.esc(miss.query)}${near}`);
	}
	lines.push(...nextSteps(ctx, params.name, forOther ? target : null));
	return ctx.say({
		content: lines.join('\n'),
		files: [{ attachment: Buffer.from(out.yaml, 'utf8'), name: out.fileName }],
	});
}

module.exports = { names: ['yaml'], run, parsePairs, KEYS };
