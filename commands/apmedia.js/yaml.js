// /apmedia yaml: build a player's Plex Media YAML from the Plex library and attach it.
//
// Prefix form: `!apmedia yaml name=Zack movies=10 titles="Alien; Aliens" unwatched=false`. A slash
// command has room for 25 options, so the rarer settings arrive in `more` the same key=value way.
//
// A YAML can come with the command (slash: the file option; prefix: attached to the message): one
// made in the Archipelago Launcher's Options Creator, or a list the bot wrote before. Its list
// settings say what to pick, its other settings stay as they are, and an option typed with the
// command replaces the file's.
//
// "Unwatched" reads the history of exactly one Plex account: the one linked to the person the list
// is for, and only with their consent (the owner counts as the server owner, account 1, unless they
// linked another). Nobody gets anybody else's history, so the account and the Discord id are filled
// in here, never typed, and never read from a file.

const logger = require('../../helpers/logger.js');
const contracts = require('../../helpers/apMediaContracts.js');
const common = require('./common.js');

// Anyone may build a list, and one build reads every movie, show and album listing and then the
// tracks or episodes of every pick: hundreds of Plex requests and seconds of matching.
const MAX_BUILDS = 2;
const building = new Set();

// The attachment URL comes from Discord, but only its own file server is ever fetched.
const FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const FILE_TIMEOUT_MS = 15000;
const FILE_NAME_SHOWN = 60;
// Discord takes 10 MiB from a bot on a server without boosts, and a reply it refuses is only logged,
// which leaves the player with no answer at all. A list near its caps is a few MB. The reader takes
// files of this size too (FILE_MAX_BYTES in helpers/apMediaYaml.js), so every list sent can be
// attached again.
const REPLY_FILE_MAX = 8 * 1024 * 1024;
// Discord's limit on a message's text, which say() clips to.
const CONTENT_MAX = 2000;
// The settings a file left random that the reply names one by one; the rest are counted.
const RANDOM_SHOWN = 6;

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
	snackvariety: 'snackVariety',
	fastforwards: 'fastForwards',
	remotecontrols: 'remoteControls',
	snackbartrades: 'snackBarTrades',
	snackbarprice: 'snackBarPrice',
	trappercentage: 'trapPercentage',
	bufferingweight: 'bufferingWeight',
	rightsexpiredweight: 'rightsExpiredWeight',
	commercialbreakweight: 'commercialBreakWeight',
	shufflemodeweight: 'shuffleModeWeight',
	rewindweight: 'rewindWeight',
	intermissionweight: 'intermissionWeight',
	slowmotionweight: 'slowMotionWeight',
});
const FILLED_IN = new Map([
	['accountid', 'from the linked Plex account'],
	['account', 'from the linked Plex account'],
	['discorduserid', 'with the Discord id of the person the list is for'],
	['discord', 'with the Discord id of the person the list is for'],
]);
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
	+ 'starting_unlocks, wild_tickets, strict, locked_watches, checkpoint_items, snack_variety, fast_forwards, remote_controls, '
	+ 'snack_bar_trades, snack_bar_price, trap_percentage, buffering_weight, rights_expired_weight, commercial_break_weight, '
	+ 'shuffle_mode_weight, rewind_weight, intermission_weight, slow_motion_weight, for';

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
		if (FILLED_IN.has(k)) return { params, forId, error: `${common.esc(word.key)} is filled in by the bot ${FILLED_IN.get(k)}; leave it out.` };
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

function fileError(message) {
	const err = new Error(message);
	err.forPlayer = true;
	return err;
}

function tooBig(bytes, max) {
	const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
	const most = max / (1024 * 1024);
	return fileError(mb > most ? `That file is ${mb} MB, and the bot reads files up to ${most} MB.` : `That file is over ${most} MB, the most the bot reads.`);
}

// Read in chunks, so a file that lied about its size stops at the limit instead of filling memory.
async function bodyBytes(res, max) {
	const length = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
	if (Number.isFinite(length) && length > max) throw tooBig(length, max);
	if (!res.body || typeof res.body.getReader !== 'function') {
		const whole = Buffer.from(await res.arrayBuffer());
		if (whole.length > max) throw tooBig(whole.length, max);
		return whole;
	}
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			reader.cancel().catch(() => {});
			throw tooBig(total, max);
		}
		chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
	}
	return Buffer.concat(chunks);
}

/**
 * The text of a file attached to the command: fetched from Discord's file server only, at most
 * FILE_MAX_BYTES, 8 MB (refused by its stated size before anything is fetched), within 15 s.
 * @param {{url: string, size?: number}} file a discord.js Attachment
 * @param {{fetch?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} decoded as UTF-8, without a byte order mark
 */
async function readAttachment(file, { fetch = (...args) => globalThis.fetch(...args), timeoutMs = FILE_TIMEOUT_MS } = {}) {
	const max = require('../../helpers/apMediaYaml.js').FILE_MAX_BYTES;
	let url = null;
	try {
		url = new URL(String(file && file.url));
	} catch (_) {}
	if (!url || url.protocol !== 'https:' || !FILE_HOSTS.has(url.hostname)) {
		throw fileError('That file is not on Discord\'s file server: attach the YAML to the command itself.');
	}
	const size = Number(file.size);
	if (Number.isFinite(size) && size > max) throw tooBig(size, max);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	let bytes;
	try {
		const res = await fetch(url.href, { signal: controller.signal, redirect: 'error' });
		if (!res || !res.ok) throw fileError(`Discord did not hand over the file (HTTP ${res ? res.status : 'error'}): attach it again.`);
		bytes = await bodyBytes(res, max);
	} catch (err) {
		if (err && err.forPlayer) throw err;
		if (timedOut) throw fileError(`Discord took more than ${Math.round(timeoutMs / 1000)} s to hand over the file: try again in a minute.`);
		logger.warn('/apmedia yaml could not download the attached file:', (err && err.message) || err);
		throw fileError('Discord could not hand over the file: try again in a minute.');
	} finally {
		clearTimeout(timer);
	}
	try {
		// The decoder drops a leading byte order mark.
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (_) {
		throw fileError('The file is not UTF-8 text: save it as UTF-8 (the Options Creator does) and attach it again.');
	}
}

function fileNameShown(file) {
	const chars = [...String((file && file.name) || 'your file')];
	return common.slot(chars.length > FILE_NAME_SHOWN ? `${chars.slice(0, FILE_NAME_SHOWN - 1).join('')}\u2026` : chars.join(''));
}

/** A setting as the Options Creator names it, with the file's key after it. */
function settingName(key) {
	return contracts.SETTING_NAMES[key] ? `${contracts.SETTING_NAMES[key]} (\`${key}\`)` : `\`${key}\``;
}

/**
 * The reply's lines about the attached file: where the settings came from and what changed (head),
 * and the settings left random (middle). A file can leave all 25 game options random, so that line
 * names a few and counts the rest, and fitLines may still leave it out to keep the next steps.
 * @returns {{head: string[], middle: string[]}}
 */
function fileLines(fromFile, file, typed) {
	const overrode = Object.values(typed).some((v) => v !== undefined && v !== null && String(v).trim() !== '');
	const head = [`\u{1F4C4} Settings from ${fileNameShown(file)}${overrode ? '; the options you typed replace the file\'s' : ''}.`];
	const n = fromFile.entriesCount;
	if (n) head.push(`\u267B\uFE0F ${n === 1 ? 'The file\'s 1 title was' : `The file's ${n} titles were`} replaced by a fresh pick from Plex.`);
	const random = fromFile.random.map((key) => `${settingName(key)}, default ${contracts.OPTIONS[key].default}`);
	const middle = [];
	if (random.length) {
		const shown = random.slice(0, RANDOM_SHOWN);
		const more = random.length - shown.length;
		middle.push(`\u26A0\uFE0F Left random in your file for Archipelago to roll: ${shown.join('; ')}${more ? `; and ${more} more` : ''}. `
			+ `The numbers above use ${random.length === 1 ? 'the default' : 'the defaults'}.`);
	}
	return { head, middle };
}

/**
 * The reply's lines, at most CONTENT_MAX characters: the head and tail whole, and as many of the
 * middle lines (warnings and misses) as fit, in order, with a count of the rest. A line too long
 * to fit is left out, not the short ones after it. Clipping the end instead would cut the next
 * step and the line about the public tracker.
 */
function fitLines(head, middle, tail) {
	const size = (lines) => lines.join('\n').length;
	const all = [...head, ...middle, ...tail];
	// With nothing to leave out, say() clips what is too long.
	if (size(all) <= CONTENT_MAX || !middle.length) return all;
	const more = (n) => `\u2026 and ${n} more ${n === 1 ? 'line' : 'lines'} not shown.`;
	const kept = [];
	for (const line of middle) {
		// The count reserved here covers the lines skipped before this one as well.
		if (size([...head, ...kept, line, more(middle.length - kept.length - 1), ...tail]) > CONTENT_MAX) continue;
		kept.push(line);
	}
	return [...head, ...kept, more(middle.length - kept.length), ...tail];
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

// A player YAML pasted into the message: Discord keeps a paste under 2,000 characters as text.
const PASTED_YAML = /^[ \t]*(?:`{3}[\w-]*[ \t]*)?(?:name|game|description|requires|Plex Media)[ \t]*:/im;

async function run(ctx) {
	const rest = String(ctx.rest || '');
	if (!common.isSlash(ctx) && /[\r\n]/.test(rest) && PASTED_YAML.test(rest) && !common.attachmentOf(ctx, 'file')) {
		return ctx.say(`\u274C The bot reads a YAML only as a file: drag the file into Discord with \`${ctx.p}apmedia yaml\` as its message, or use \`/apmedia yaml file:\`.`);
	}
	const read = common.isSlash(ctx) ? readSlash(ctx) : parsePairs(ctx.rest);
	if (read.error) return ctx.say(read.error);
	const params = read.params;
	const file = common.attachmentOf(ctx, 'file');
	if (!file && (typeof params.name !== 'string' || !params.name)) {
		return ctx.say(`Give the list a slot name: \`${ctx.p}apmedia yaml name=You movies=10\`, or attach a YAML from the Archipelago Options Creator. Options: ${KEY_LIST}.`);
	}
	const target = read.forId || ctx.userId;
	const forOther = target !== ctx.userId;
	if (forOther) {
		const gate = common.ownerOnly(ctx, 'build a list for someone else');
		if (gate) return ctx.say(gate);
	}
	const account = ctx.game.accountOf(target);
	const filledIn = { accountId: account && account.consent === 'granted' ? account.accountId : null, discordUserId: String(target) };

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
	const option = (key, value) => common.commandCode(common.isSlash(ctx) ? `${key}:${value}` : `${key}=${value}`);
	let out;
	let fromFile = null;
	building.add(caller);
	try {
		let buildParams = { ...params, ...filledIn };
		if (file) {
			const text = await readAttachment(file, ctx.fetch ? { fetch: ctx.fetch } : {});
			fromFile = yamlModule.readPlayerYaml(text, params);
			// A list the bot wrote for someone else, under their slot name, would be stamped with the
			// wrong person's Discord id and picked from the wrong Plex history.
			if (fromFile.listFor && fromFile.listFor !== String(target)) {
				const own = fromFile.listFor === caller;
				const again = !own && common.isOwner(ctx.userId) ? ` To pick it again for them, add ${option('for', '@them')}.` : '';
				const fresh = forOther ? `To build a new list for <@${target}> from it` : 'To make it a list of your own';
				return ctx.say(`\u274C ${own ? 'This is your own list.' : `This list was built for <@${fromFile.listFor}>.`}${again} `
					+ `${fresh}, give it a new name with ${option('name', 'Name')}.`);
			}
			buildParams = { ...fromFile.params, ...filledIn };
		}
		out = await ctx.builder().build(buildParams);
	} catch (err) {
		const message = (err && err.message) || String(err);
		if (message === yamlModule.ACCOUNT_FIX) {
			const off = `${option('unwatched', 'false')}${file ? ` (or ${settingName('list_unwatched')} set to false in the file)` : ''}`;
			const pending = account && account.consent === 'pending';
			if (forOther) {
				return ctx.say(pending
					? `<@${target}> has not accepted the link to their Plex account yet, so what they watched cannot be left out: they accept it in the bot's DM, or build with ${off}.`
					: `<@${target}> has no Plex account linked with their consent, so what they watched cannot be left out: link theirs with \`/apmedia account\` (they accept it), or build with ${off}.`);
			}
			if (pending) {
				return ctx.say(`\u274C Leaving out what you have already watched needs your Plex account, and its link waits for you to accept it in the bot's DM `
					+ `(or ask the owner to link it again). Or build the list with ${off}.`);
			}
			return ctx.say(`\u274C ${message.replace('unwatched=false.', `${off}.`)}`);
		}
		const plex = common.plexCode(err);
		if (plex) {
			logger.warn('/apmedia yaml could not read Plex:', message);
			return ctx.say(`\u274C Plex could not be read (${plex}), so no list was built. Try again in a while; the bot log has the details.`);
		}
		// An empty list says which filters left nothing, such as a genre no section has.
		const said = Array.isArray(err && err.warnings) ? err.warnings.map((w) => `\u26A0\uFE0F ${common.esc(w)}`) : [];
		return ctx.say(fitLines([`\u274C ${message}`], said, []).join('\n'));
	} finally {
		building.delete(caller);
	}
	const bytes = Buffer.byteLength(out.yaml, 'utf8');
	if (bytes > REPLY_FILE_MAX) {
		const mb = Math.ceil((bytes / (1024 * 1024)) * 10) / 10;
		return ctx.say(`\u274C The finished YAML would be ${mb} MB, over the ${REPLY_FILE_MAX / (1024 * 1024)} MB the bot sends through Discord: build a shorter list.`);
	}
	const summary = out.summary;
	const name = fromFile ? fromFile.name : params.name;
	const head = [
		`\u{1F4DD} ${common.slot(name)}: ${forOther ? `a list for <@${target}>` : 'your list'}, attached as \`${out.fileName}\`.`,
		...yamlModule.summaryLines(summary, name).slice(0, 3),
	];
	const fromLines = fromFile ? fileLines(fromFile, file, params) : { head: [], middle: [] };
	head.push(...fromLines.head);
	if (account && account.consent === 'pending') {
		head.push(forOther
			? `\u26A0\uFE0F <@${target}> has not accepted the link to their Plex account yet: until they do, the bot knows nothing they watched.`
			: '\u26A0\uFE0F Your Plex account link waits for you to accept it in the bot\'s DM: until you do, the bot knows nothing you watched.');
	}
	const middle = [...fromLines.middle, ...(summary.warnings || []).map((w) => `\u26A0\uFE0F ${common.esc(w)}`)];
	for (const miss of summary.misses || []) {
		const near = miss.didYouMean && miss.didYouMean.length ? ` (did you mean ${miss.didYouMean.map(common.bold).join(', ')}?)` : '';
		middle.push(`\u2753 Not found: ${common.esc(miss.query)}${near}`);
	}
	return ctx.say({
		content: fitLines(head, middle, nextSteps(ctx, name, forOther ? target : null)).join('\n'),
		files: [{ attachment: Buffer.from(out.yaml, 'utf8'), name: out.fileName }],
	});
}

module.exports = { names: ['yaml'], run, parsePairs, readAttachment, fitLines, fileLines, KEYS, FILE_HOSTS, FILE_TIMEOUT_MS, REPLY_FILE_MAX, CONTENT_MAX, RANDOM_SHOWN };
