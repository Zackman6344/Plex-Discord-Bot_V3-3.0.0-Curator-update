// helpers/apMediaYaml.js
// Builds a player's Plex Media YAML from the Plex library: hand-picked titles, a Plex playlist or
// collection, and random picks, with a summary of what the list adds up to.
//
// One bad character in one title makes the whole file invalid to AP's YAML loader (LibYAML refuses
// raw C1 controls, U+FFFE/U+FFFF and any surrogate escape, quoted or not), and an invalid file stops
// the whole multiworld from generating. So every string goes through contracts.sanitizeText and
// every data scalar is written JSON-quoted. The options sit under `Plex Media:`, the only place AP
// reads a game's options from.
//
// "Unwatched" reads only the account the command resolved. A friend's list filtered by the owner's
// history would drop what the owner has seen and keep what the friend has, so a missing account is
// an error, never a fallback.
//
// Music: only matched albums (plex:// or mbid:// guid) with 3 to 40 tracks, at least 3 of them 30 s
// or longer. Copies of one album sit on several drives under one guid; the copy with more tracks
// (then the lower ratingKey) is kept, and same-length copies go into `alt`, so a play of the other
// copy still credits. Tracks and episodes are read only for the albums and shows actually picked:
// the full track listing is about 25 MB.
//
// readPlayerYaml reads a YAML a player made in the Archipelago Launcher's Options Creator (or one
// the bot wrote before) into build() params: its list_* settings say what to pick, every other
// setting is copied into the new file as it was, and the titles are picked fresh.

const crypto = require('crypto');
const contracts = require('./apMediaContracts.js');
const { planSlot, resolveOptions } = require('./apMediaPlan.js');

const PARAMS = new Set([
	'name', 'label', 'preset', 'movies', 'shows', 'albums', 'books', 'maxEpisodes', 'unwatched',
	'genre', 'years', 'collection', 'playlist', 'titles', 'timeMovies', 'timeEpisodes', 'timeAlbums',
	'timeBooks', 'goalPercent', 'episodesPerUnlock', 'tvUnlock', 'startingUnlocks', 'wildTickets',
	'strict', 'lockedWatches', 'checkpointItems', 'snackVariety', 'fastForwards', 'remoteControls', 'snackBarTrades',
	'snackBarPrice', 'trapPercentage', 'bufferingWeight', 'rightsExpiredWeight', 'commercialBreakWeight',
	'shuffleModeWeight', 'rewindWeight', 'intermissionWeight', 'slowMotionWeight', 'accountId', 'discordUserId',
	'passthrough', 'asWritten', 'plando',
]);
const NO_PRESET = 'none';
const PRESET_NAMES = Object.freeze([...Object.keys(contracts.PRESETS), NO_PRESET]);
const PICK_NOTHING = 'Your list settings pick nothing: choose a preset, set a count, or name titles, a playlist or a collection.';
const OLD_LIST = 'This list comes from an older version of the bot, which did not save what to pick: give a preset, a count, '
	+ 'or titles, a playlist or a collection with the command.';
// The list settings by YAML key, to the builder param each one sets.
const LIST_PARAMS = Object.freeze({
	list_preset: 'preset',
	list_movies: 'movies',
	list_shows: 'shows',
	list_albums: 'albums',
	list_books: 'books',
	list_titles: 'titles',
	list_playlist: 'playlist',
	list_collection: 'collection',
	list_genre: 'genre',
	list_years: 'years',
	list_unwatched: 'unwatched',
	list_max_episodes: 'maxEpisodes',
	list_label: 'label',
});
// Keys under "Plex Media:" that the bot always writes itself, so a copied setting never replaces them.
const BOT_WRITTEN = new Set([...Object.keys(contracts.LIST_OPTIONS), 'entries', 'list_info']);
const OPTION_PARAMS = Object.freeze({
	startingUnlocks: 'starting_unlocks',
	goalPercent: 'goal_percent',
	tvUnlock: 'tv_unlock',
	episodesPerUnlock: 'episodes_per_unlock',
	lockedWatches: 'locked_watches',
	checkpointItems: 'checkpoint_items',
	strict: 'timesanity_strict',
	timeMovies: 'timesanity_movies',
	timeEpisodes: 'timesanity_episodes',
	timeAlbums: 'timesanity_albums',
	timeBooks: 'timesanity_books',
	wildTickets: 'wild_tickets',
	snackVariety: 'snack_variety',
	fastForwards: 'fast_forwards',
	remoteControls: 'remote_controls',
	snackBarTrades: 'snack_bar_trades',
	snackBarPrice: 'snack_bar_price',
	trapPercentage: 'trap_percentage',
	bufferingWeight: 'buffering_weight',
	rightsExpiredWeight: 'rights_expired_weight',
	commercialBreakWeight: 'commercial_break_weight',
	shuffleModeWeight: 'shuffle_mode_weight',
	rewindWeight: 'rewind_weight',
	intermissionWeight: 'intermission_weight',
	slowMotionWeight: 'slow_motion_weight',
});
const OPTION_KEYS = Object.freeze(Object.fromEntries(Object.entries(OPTION_PARAMS).map(([param, key]) => [key, param])));
const COUNT_KEYS = Object.freeze(['movies', 'shows', 'albums', 'books']);
const ENTRY_ORDER = Object.freeze({
	movie: ['k', 'id', 'rk', 'g', 't', 'y', 'd'],
	episode: ['k', 'id', 'rk', 'g', 'sh', 'sid', 'srk', 'sn', 'en', 't', 'd'],
	album: ['k', 'id', 'rk', 'g', 'ar', 't', 'y', 'd', 'tr', 'alt'],
	mix: ['k', 'id', 'pl', 'part', 't', 'd', 'tr'],
	book: ['k', 'id', 'w', 't', 'au', 'd', 'pa'],
});
const KIND_WORDS = Object.freeze({
	movie: ['movie', 'movies'],
	episode: ['episode', 'episodes'],
	album: ['album', 'albums'],
	mix: ['playlist part', 'playlist parts'],
	book: ['book', 'books'],
});
const PLEX_TYPE = Object.freeze({ movie: 1, show: 2, album: 9 });
const MAX_TITLES = 50;
const MAX_TEXT = 200;
const MAX_LABEL = 100;
const MAX_ALBUM_TRACKS = 40;
const MAX_PICKED_ALBUM_TRACKS = 100;
const MIN_ALBUM_TRACKS = 3;
const MAX_ALBUM_COPIES = 4;
// A smart playlist can hold the whole library (All Music: 14,174 tracks here); 40 parts of 15 is
// plenty, and reading all of it to keep the start is megabytes of JSON parsed on the main thread.
// Audio reads twice what 40 parts use, since book parts and short tracks drop out only after the
// read; video reads at most what one slot can hold.
const MAX_MIX_PARTS = 40;
const MIX_READ_MAX = MAX_MIX_PARTS * contracts.LIMITS.mixTracks * 2;
const VIDEO_READ_MAX = contracts.LIMITS.maxEntries;
const MAX_SOURCE_SHOWS = contracts.COUNT_RANGES.shows.max;
const MAX_SOURCE_MOVIES = contracts.COUNT_RANGES.movies.max;
const PLAYLIST_TTL_MS = 10 * 60 * 1000;
const MATCH_MIN = 60;
// Below this a match is the nearest title rather than the one named, and the reply says what it took.
const MATCH_CLOSE = 95;
// A name of "random" may be a player asking for a random pick, so it takes only a title of that name.
const RANDOM_NAME = /^random(?:$|-)/i;
// The near matches the reply names one by one; 50 titles of 200 characters would fill it.
const LOOSE_SHOWN = 10;
const LOOSE_CHARS = 900;
// The titles an empty list's refusal names, the rest counted.
const MISSES_SHOWN = 10;
const SUGGEST_MIN = 0.35;

const ACCOUNT_FIX = 'Leaving out what you have already watched needs your Plex account: ask the owner: '
	+ '`/apmedia account @you <plex name>`. Or build the list with unwatched=false.';

// Names Windows opens as a device, not a file, even with an extension after them (NUL.txt is NUL).
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3])$/i;
const NAME_HASH_HEX = 8;
const NAME_HASH_TAIL = new RegExp(`-[0-9a-f]{${NAME_HASH_HEX}}$`, 'i');

function clean(value) {
	return contracts.sanitizeText(value);
}

function given(value) {
	return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function intParam(name, raw, min, max) {
	const n = typeof raw === 'number' ? raw : (/^\s*-?\d+\s*$/.test(String(raw)) ? Number(raw) : NaN);
	if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
	return n;
}

function boolParam(name, raw) {
	if (typeof raw === 'boolean') return raw;
	const s = String(raw).trim().toLowerCase();
	if (['true', 'yes', 'on', '1'].includes(s)) return true;
	if (['false', 'no', 'off', '0'].includes(s)) return false;
	throw new Error(`${name} must be true or false.`);
}

function choiceParam(name, raw, values) {
	const s = String(raw).trim().toLowerCase();
	if (!values.includes(s)) throw new Error(`${name} must be one of: ${values.join(', ')}.`);
	return s;
}

function textParam(name, raw, max) {
	const s = clean(raw);
	if (!s) throw new Error(`${name} cannot be empty.`);
	if ([...s].length > max) throw new Error(`${name} can be at most ${max} characters.`);
	return s;
}

function optionParam(param, key, raw) {
	const spec = contracts.OPTIONS[key];
	if (spec.type === 'range') {
		const value = /^timesanity_/.test(key) && /^\s*off\s*$/i.test(String(raw)) ? 0 : raw;
		return intParam(param, value, spec.min, spec.max);
	}
	if (spec.type === 'choice') return choiceParam(param, raw, spec.values);
	return boolParam(param, raw);
}

function yearsParam(raw, name = 'years') {
	const m = /^\s*(\d{4})\s*(?:-\s*(\d{4}))?\s*$/.exec(String(raw));
	if (!m) throw new Error(`${name} must look like 1990 or 1990-1999.`);
	const from = Number(m[1]);
	const to = m[2] === undefined ? from : Number(m[2]);
	if (from < 1800 || to > 2200 || from > to) throw new Error(`${name} must be a range like 1990-1999, earliest first.`);
	return { from, to };
}

const TITLE_PREFIX = /^(movie|show|album|book)\s*:\s*/i;
const SEASON_RANGE = /\s+s(\d{1,3})(?:\s*-\s*s?(\d{1,3}))?\s*$/i;
const TITLE_YEAR = /\s*\((\d{4})\)\s*$/;

function parseTitle(raw, name = 'titles') {
	const query = clean(raw);
	let text = query;
	let kind = null;
	let seasons = null;
	let year = null;
	const prefix = TITLE_PREFIX.exec(text);
	if (prefix) {
		kind = prefix[1].toLowerCase();
		text = text.slice(prefix[0].length).trim();
	}
	if (kind === 'show') {
		const s = SEASON_RANGE.exec(text);
		if (s) {
			const a = Number(s[1]);
			const b = s[2] === undefined ? a : Number(s[2]);
			seasons = [Math.min(a, b), Math.max(a, b)];
			text = text.slice(0, s.index).trim();
		}
	}
	if (kind !== 'show' && kind !== 'book') {
		const y = TITLE_YEAR.exec(text);
		if (y) {
			year = Number(y[1]);
			text = text.slice(0, y.index).trim();
		}
	}
	if (!text) throw new Error(`${name}: ${codeSpan(query)} names no title.`);
	if ([...text].length > MAX_TEXT) throw new Error(`${name}: ${codeSpan(query, 40)} is too long.`);
	return { query, text, kind, seasons, year };
}

function titlesParam(raw, name = 'titles') {
	const list = String(raw).split(';').map((s) => s.trim()).filter(Boolean);
	if (list.length > MAX_TITLES) throw new Error(`${name} can name at most ${MAX_TITLES} titles.`);
	return list.map((title) => parseTitle(title, name));
}

// The members of Archipelago's PlandoOptions, which a player file's requires: plando names, split by
// commas; none asks for no module.
const PLANDO_NAMES = new Set(['none', 'items', 'connections', 'texts', 'bosses']);
// What Python's str.strip() takes as space: \s without U+FEFF, and with U+001C to U+001F and U+0085.
const PY_STRIP_SPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp(`^${PY_STRIP_SPACE}+|${PY_STRIP_SPACE}+$`, 'g');
// What int() takes around a number: the same without U+001C to U+001F, which it reads as characters.
const PY_INT_SPACE = '[\\t-\\r\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

/** requires: plando as Archipelago's PlandoOptions.from_option_string reads it: text naming its modules. */
function plandoParam(raw, name = 'plando') {
	const hint = 'items, connections, texts or bosses, split by commas';
	if (typeof raw !== 'string') throw new Error(`${name} must be text naming ${hint}.`);
	const unknown = raw.split(',').map((part) => part.replace(PY_STRIP, '').toLowerCase()).find((part) => part && !PLANDO_NAMES.has(part));
	if (unknown !== undefined) throw new Error(`${name} names ${keySpan(unknown)}, which Archipelago does not know: it takes ${hint}.`);
	return raw;
}

// A snowflake is past 2^53, so a number is accepted only while it is still exact.
function discordParam(raw) {
	const text = String(raw).trim();
	const ok = typeof raw === 'number' ? Number.isSafeInteger(raw) && raw > 0 : /^\d{1,25}$/.test(text);
	if (!ok) throw new Error('discordUserId must be a Discord user id.');
	return text;
}

function pickNothing(counts, p) {
	return COUNT_KEYS.every((key) => counts[key] === 0) && !p.titles.length && !p.playlist && !p.collection;
}

function has(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key);
}

/** Text from a player's file, as an inline code span a reply can show: no Markdown, no line break. */
function codeSpan(text, max = 60) {
	const chars = [...clean(text).replace(/`/g, "'")];
	const shown = chars.length > max ? `${chars.slice(0, max - 1).join('')}\u2026` : chars.join('');
	return `\`${shown || ' '}\``;
}

// Copied values are written back for Archipelago's YAML loader, which refuses a lone surrogate and a
// raw DEL or C1 control, U+FFFE or U+FFFF, and reads a raw NEL, U+2028 or U+2029 as a line break.
// Written as escapes, these stay the characters they were.
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const RAW_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Plain words YAML 1.1 reads as a boolean or null; a key spelled like one is written quoted.
const YAML11_WORD = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL)$/;
const MAX_FLOW_DEPTH = 32;
// Archipelago's YAML reader takes a key without a "?" of at most 1,024 characters, and escapes can
// make a key longer once written: a key written out longer than this is refused. It is counted in
// the yaml package's units, where an emoji takes two, so the bot can read back every key it writes.
const KEY_MAX = 1000;
const KEY_TOO_LONG = `more than ${KEY_MAX} characters as the bot writes it (an emoji counts as two), which Archipelago cannot read back: shorten it`;
// The lines the copied settings become, in bytes. The Options Creator's own file is under 1 KB, and
// an alias writes its whole value out again, so the count runs while a value is written and stops
// it partway: a few lines of input can never turn into megabytes of reply.
const COPY_MAX_BYTES = 32 * 1024;

/** Text in double quotes with every invisible or unsafe character as an escape. */
function escapedText(text) {
	return JSON.stringify(text).replace(RAW_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function quoted(text, where) {
	if (LONE_SURROGATE.test(text)) throw new Error(`${where} holds a broken character Archipelago cannot read.`);
	return escapedText(text);
}

function isPlainObject(value) {
	if (!value || typeof value !== 'object') return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Room left for the copied settings of one file, in bytes; see COPY_MAX_BYTES. */
function copyRoom() {
	return { left: COPY_MAX_BYTES };
}

function take(room, bytes, where) {
	if (!room) return;
	room.left -= bytes;
	if (room.left < 0) {
		throw new Error(`The settings the bot copies as they are can take ${COPY_MAX_BYTES / 1024} KB in all, and ${where} goes past that: shorten it or take it out of the file.`);
	}
}

function spend(room, text, where) {
	if (room) take(room, Buffer.byteLength(text, 'utf8'), where);
	return text;
}

/** A float as PyYAML reads one back: .nan, .inf, or Python's str() of it with a decimal point. */
function floatText(n) {
	if (Number.isNaN(n)) return '.nan';
	if (!Number.isFinite(n)) return n > 0 ? '.inf' : '-.inf';
	const text = pyFloatText(n);
	// PyYAML reads 1e+16 as text: its floats need the point.
	return text.includes('.') ? text : text.replace('e', '.0e');
}

/**
 * A value copied from a player's file, as one line of YAML flow that PyYAML reads back as the same
 * value: text quoted, numbers and booleans plain, a float with its decimal point, lists and
 * mappings in brackets and braces.
 * @param {string} where the setting, as a reply shows it, for the error
 * @param {{left: number}|null} [room] what is left of the copied settings' room; each piece written spends it
 */
function flowValue(value, where, room = null, depth = 0) {
	if (depth > MAX_FLOW_DEPTH) throw new Error(`${where} is nested more than ${MAX_FLOW_DEPTH} levels deep.`);
	if (value === null) return spend(room, 'null', where);
	if (typeof value === 'boolean') return spend(room, value ? 'true' : 'false', where);
	if (value instanceof PyFloat) return spend(room, floatText(value.value), where);
	if (typeof value === 'number') {
		if (Number.isSafeInteger(value)) return spend(room, String(value), where);
		// A whole number is an int here (a float with one is a PyFloat), and past 2**53 it lost digits.
		if (Number.isInteger(value)) throw new Error(`${where} holds a number too large for the bot to copy exactly: write a smaller one.`);
		return spend(room, floatText(value), where);
	}
	if (typeof value === 'string') return spend(room, quoted(value, where), where);
	// The brackets and the ", " between items are spent before the items, so a long list stops early.
	const frame = (n) => take(room, 2 + 2 * Math.max(0, n - 1), where);
	if (Array.isArray(value)) {
		frame(value.length);
		return `[${value.map((v) => flowValue(v, where, room, depth + 1)).join(', ')}]`;
	}
	if (value instanceof Map || isPlainObject(value)) {
		const pairs = value instanceof Map ? [...value] : Object.entries(value);
		frame(pairs.length);
		return `{${pairs.map(([k, v]) => `${flowKey(k, where, room)}${spend(room, ': ', where)}${flowValue(v, where, room, depth + 1)}`).join(', ')}}`;
	}
	throw new Error(`${where} holds a value the bot cannot copy (a date, a set or binary data): write it as text, numbers, lists or mappings.`);
}

function flowKey(key, where, room = null) {
	if (typeof key === 'string') {
		const text = quoted(key, where);
		if (text.length > KEY_MAX) throw new Error(`${where} has a key of ${KEY_TOO_LONG}.`);
		return spend(room, text, where);
	}
	if (key === null || typeof key === 'boolean' || typeof key === 'number' || key instanceof PyFloat) return flowValue(key, where, room);
	if (key instanceof YamlTimestamp) throw new Error(`${where} uses a date as a key, which the bot does not copy: put it in quotes.`);
	if (key instanceof Uint8Array) throw new Error(`${where} uses binary data as a key, which the bot does not copy.`);
	throw new Error(`${where} uses a list or a mapping as a key, which Archipelago cannot read.`);
}

/** A key under "Plex Media:", plain when YAML reads it back as the same text, else quoted. */
function yamlKey(key) {
	const text = PLAIN_KEY.test(key) && !YAML11_WORD.test(key) ? key : quoted(key, codeSpan(key));
	if (text.length > KEY_MAX) throw new Error(`The setting name ${codeSpan(key)} is ${KEY_TOO_LONG}.`);
	return text;
}

/** The line a copied setting becomes under "Plex Media:", its bytes and line break spent from the room. */
function copiedLine(key, value, room) {
	const where = codeSpan(key);
	const head = spend(room, `  ${yamlKey(key)}: `, where);
	const line = `${head}${flowValue(value, where, room)}`;
	spend(room, '\n', where);
	return line;
}

/**
 * Why a setting name that starts with + or - cannot stand under "Plex Media:", or null. Archipelago
 * merges and removes with them only inside triggers (Generate.roll_settings), and anywhere else one
 * stops the whole seed.
 */
function triggerTagProblem(key) {
	if (!/^[+-]/.test(key)) return null;
	return `${codeSpan(key)} starts with ${key[0]}, which Archipelago takes only inside triggers, and here it stops the whole seed: `
		+ 'write the setting without it, or take it out of the file.';
}

/**
 * Settings copied as they are from a player's file, each with the line it becomes, in file order.
 * A game option among them (a random or weighted one) yields to the same option given as a param.
 * @param {Array<[string, *]>|undefined} raw [key, value] pairs
 * @param {object} options the game options given as params, by YAML key
 * @returns {Array<{key: string, value: *, line: string}>}
 */
function copiedSettings(raw, options) {
	if (raw === undefined || raw === null) return [];
	const bad = () => new TypeError('passthrough must be a list of [key, value] pairs.');
	if (!Array.isArray(raw)) throw bad();
	const seen = new Set();
	const room = copyRoom();
	const out = [];
	for (const pair of raw) {
		if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0]) throw bad();
		const [key, value] = pair;
		const where = codeSpan(key);
		if (BOT_WRITTEN.has(key)) throw new Error(`${where} is written by the bot, so a copied setting cannot replace it.`);
		const tag = triggerTagProblem(key);
		if (tag) throw new Error(tag);
		if (seen.has(key)) throw new Error(`${where} is given twice.`);
		seen.add(key);
		if (has(contracts.OPTIONS, key) && has(options, key)) continue;
		out.push({ key, value, line: copiedLine(key, value, room) });
	}
	return out;
}

/** copiedSettings as the [key, value] pairs build() takes. */
function passthroughParam(raw, options) {
	return copiedSettings(raw, options).map(({ key, value }) => [key, value]);
}

/**
 * Game options and list settings to write as a player's file wrote them, in place of the bot's own
 * spelling, each with the line it becomes: a trigger in the file compares that spelling.
 * @param {Array<[string, *]>|undefined} raw [key, value] pairs
 * @returns {Map<string, string>} the line by key
 */
function asWrittenLines(raw) {
	const out = new Map();
	if (raw === undefined || raw === null) return out;
	const bad = () => new TypeError('asWritten must be a list of [key, value] pairs of game options and list settings, each once.');
	if (!Array.isArray(raw)) throw bad();
	const room = copyRoom();
	for (const pair of raw) {
		if (!Array.isArray(pair) || pair.length !== 2) throw bad();
		const [key, value] = pair;
		if (typeof key !== 'string' || out.has(key) || (!has(contracts.OPTIONS, key) && !has(contracts.LIST_OPTIONS, key))) throw bad();
		out.set(key, copiedLine(key, value, room));
	}
	return out;
}

/** Checks and normalises build() params; throws an Error whose message is for the user. */
function validateParams(params) {
	if (!params || typeof params !== 'object') throw new Error('No options given.');
	for (const key of Object.keys(params)) {
		if (!PARAMS.has(key) && given(params[key])) throw new Error(`Unknown option ${key}.`);
	}
	const name = params.name;
	const problem = contracts.slotNameProblem(name);
	if (problem) throw new Error(problem);

	const p = { name };
	p.label = given(params.label) ? textParam('label', params.label, MAX_LABEL) : `${name}'s list`;

	const explicit = {};
	for (const key of COUNT_KEYS) {
		if (given(params[key])) explicit[key] = intParam(key, params[key], contracts.COUNT_RANGES[key].min, contracts.COUNT_RANGES[key].max);
	}
	p.titles = given(params.titles) ? titlesParam(params.titles) : [];
	p.playlist = given(params.playlist) ? textParam('playlist', params.playlist, MAX_TEXT) : null;
	p.collection = given(params.collection) ? textParam('collection', params.collection, MAX_TEXT) : null;
	let base = {};
	let preset = NO_PRESET;
	if (given(params.preset)) {
		preset = choiceParam('preset', params.preset, PRESET_NAMES);
		base = contracts.PRESETS[preset] || {};
	} else if (!Object.keys(explicit).length && !p.titles.length && !p.playlist && !p.collection) {
		preset = contracts.DEFAULT_PRESET;
		base = contracts.PRESETS[preset];
	}
	p.counts = {};
	for (const key of COUNT_KEYS) p.counts[key] = explicit[key] !== undefined ? explicit[key] : (base[key] || 0);
	if (pickNothing(p.counts, p)) throw new Error(PICK_NOTHING);

	const ep = contracts.COUNT_RANGES.maxEpisodes;
	p.maxEpisodes = given(params.maxEpisodes) ? intParam('maxEpisodes', params.maxEpisodes, ep.min, ep.max) : ep.default;
	p.unwatched = given(params.unwatched) ? boolParam('unwatched', params.unwatched) : true;
	p.genre = given(params.genre) ? textParam('genre', params.genre, 60) : null;
	p.years = given(params.years) ? yearsParam(params.years) : null;

	const options = {};
	for (const [param, key] of Object.entries(OPTION_PARAMS)) {
		if (given(params[param])) options[key] = optionParam(param, key, params[param]);
	}
	p.options = resolveOptions(options);
	p.passthrough = passthroughParam(params.passthrough, options);
	asWrittenLines(params.asWritten);
	p.asWritten = Array.isArray(params.asWritten) ? params.asWritten.map(([key, value]) => [key, value]) : [];
	p.plando = params.plando === undefined || params.plando === null ? null : plandoParam(params.plando);
	p.list = {
		list_preset: preset,
		list_titles: p.titles.map((t) => t.query).join('; '),
		list_playlist: p.playlist || '',
		list_collection: p.collection || '',
		list_genre: p.genre || '',
		list_years: !p.years ? '' : (p.years.from === p.years.to ? `${p.years.from}` : `${p.years.from}-${p.years.to}`),
		list_unwatched: p.unwatched,
		list_max_episodes: p.maxEpisodes,
		// Empty means "<name>'s list", so a copy of the file under another name gets its own label.
		list_label: given(params.label) ? p.label : '',
	};
	// A count the preset gives is written as preset, so the file follows another preset given with it later.
	for (const key of COUNT_KEYS) p.list[`list_${key}`] = p.counts[key] === (base[key] || 0) ? 'preset' : p.counts[key];

	if (given(params.accountId)) {
		const id = Number(params.accountId);
		if (!Number.isInteger(id) || id <= 0) throw new Error('accountId must be a Plex account id.');
		p.accountId = id;
	} else {
		p.accountId = null;
	}
	p.discordUserId = given(params.discordUserId) ? discordParam(params.discordUserId) : null;
	return p;
}

function norm(text) {
	return clean(text)
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/['`\p{Pi}\p{Pf}]/gu, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function dropArticle(text) {
	return text.replace(/^(the|a|an) /, '');
}

function matchScore(query, title) {
	return normScore(norm(query), norm(title));
}

function normScore(q, t) {
	if (!q || !t) return 0;
	if (q === t) return 100;
	const qa = dropArticle(q);
	const ta = dropArticle(t);
	if (qa === ta) return 95;
	if (t.startsWith(`${q} `)) return 80;
	if (ta.startsWith(`${qa} `)) return 78;
	const words = ta.split(' ');
	if (qa.split(' ').every((w) => words.some((x) => x.startsWith(w)))) return MATCH_MIN;
	return 0;
}

function bigrams(text) {
	const out = new Map();
	const t = ` ${text} `;
	for (let i = 0; i < t.length - 1; i++) {
		const g = t.slice(i, i + 2);
		out.set(g, (out.get(g) || 0) + 1);
	}
	return out;
}

function similarity(a, b) {
	if (!a || !b) return 0;
	return overlap(bigrams(a), bigrams(b));
}

function overlap(A, B) {
	let shared = 0;
	let total = 0;
	for (const [g, n] of A) {
		total += n;
		shared += Math.min(n, B.get(g) || 0);
	}
	for (const n of B.values()) total += n;
	return total ? (2 * shared) / total : 0;
}

function shuffle(list, random) {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function ms(value) {
	const n = Math.round(Number(value));
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function yearOf(value) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function plexGuid(guid) {
	const g = String(guid || '');
	return g.startsWith('plex://') ? g : null;
}

function matchedAlbumGuid(guid) {
	const g = String(guid || '');
	return g.startsWith('plex://') || g.startsWith('mbid://') ? g : null;
}

function partIdOf(part) {
	const id = Number(part && part.id);
	if (Number.isInteger(id) && id > 0) return id;
	const m = /^\/library\/parts\/(\d+)\//.exec(String((part && part.key) || ''));
	return m ? Number(m[1]) : 0;
}

function firstPart(row) {
	const media = Array.isArray(row && row.Media) ? row.Media[0] : null;
	return media && Array.isArray(media.Part) ? media.Part[0] : null;
}

function isPlaceholderAlbum(row) {
	const artist = clean(row && row.parentTitle);
	const title = clean(row && row.title);
	if (!artist || !title) return true;
	if (/^\[?\s*unknown album\s*\]?$/i.test(title)) return true;
	return /^(various artists|music)$/i.test(artist) && /music uploads/i.test(title);
}

// A read that stopped at its limit was cut unless the source's own count says that was all of it.
// The count is no proof the other way: leafCount can include an item Plex no longer returns.
function wasCut(read, limit, total) {
	return read.length >= limit && !(total > 0 && total <= read.length);
}

function inYears(years, value) {
	if (!years) return true;
	const y = yearOf(value);
	return y !== null && y >= years.from && y <= years.to;
}

function hasGenreTag(row, genre) {
	const want = norm(genre);
	return (Array.isArray(row && row.Genre) ? row.Genre : []).some((g) => norm(g && g.tag) === want);
}

function plural(n, words) {
	return `${n} ${n === 1 ? words[0] : words[1]}`;
}

function hoursText(hours) {
	if (hours < 10) return `${Math.round(hours * 10) / 10}`;
	return `${Math.round(hours)}`;
}

/**
 * "16 entries (15 movies, 1 album), 113 locations, about 26 h", as the file's second line and the
 * reply both say it. Hours go in unrounded: rounded to a tenth first, 26.4996 read 27 in the reply
 * and 26 in the file.
 */
function sizeText(n, counts, locations, hours) {
	return `${plural(n, ['entry', 'entries'])}${n ? ` (${kindPhrase(counts)})` : ''}, ${plural(locations, ['location', 'locations'])}, about ${hoursText(hours)} h`;
}

function andList(items) {
	return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function kindPhrase(counts) {
	return contracts.KINDS.filter((k) => counts[k] > 0).map((k) => plural(counts[k], KIND_WORDS[k])).join(', ');
}

function cleanDeep(value) {
	if (typeof value === 'string') return clean(value);
	if (Array.isArray(value)) return value.map(cleanDeep);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = cleanDeep(v);
		return out;
	}
	return value;
}

function orderedEntry(entry) {
	const e = cleanDeep(entry);
	const out = {};
	for (const key of ENTRY_ORDER[e.k] || ['k', 'id']) {
		if (e[key] !== undefined) out[key] = e[key];
	}
	for (const [key, value] of Object.entries(e)) {
		if (!(key in out) && value !== undefined) out[key] = value;
	}
	return out;
}

function listInfoOf(doc, label, createdAt) {
	const info = doc.listInfo && typeof doc.listInfo === 'object' ? doc.listInfo : {};
	const account = Number(info.account !== undefined ? info.account : doc.account);
	const discord = info.discord !== undefined ? info.discord : doc.discord;
	return {
		builder: Number.isInteger(info.builder) ? info.builder : contracts.BUILDER_VERSION,
		created_at: createdAt,
		label,
		// The slot the list was built under, which the file's name stops matching once someone renames it.
		slot: doc.name,
		account: Number.isInteger(account) && account > 0 ? account : null,
		discord: discord === undefined || discord === null ? null : (clean(discord) || null),
	};
}

// The recorded list settings as the YAML writes them: a count as a number or its special name.
function listValue(key, spec, raw) {
	const wrong = () => new TypeError(`${key} cannot be ${JSON.stringify(raw)}.`);
	if (spec.type === 'text') {
		if (typeof raw !== 'string') throw wrong();
		return JSON.stringify(clean(raw));
	}
	if (spec.type === 'toggle') {
		if (typeof raw !== 'boolean') throw wrong();
		return String(raw);
	}
	if (spec.type === 'choice') {
		if (!spec.values.includes(raw)) throw wrong();
		return raw;
	}
	const specials = spec.special || {};
	if (typeof raw === 'string' && has(specials, raw)) return raw;
	const special = Object.keys(specials).find((word) => specials[word] === raw);
	if (special) return special;
	if (!Number.isInteger(raw) || raw < spec.min || raw > spec.max) throw wrong();
	return String(raw);
}

/**
 * The player YAML for one slot, in the spec 5.11 layout: two-space indents, every scalar that comes
 * from data JSON-quoted, one JSON object per entry line. Under "Plex Media:" come the game options,
 * the list settings the titles were picked with, the settings copied from the player's own file,
 * then list_info and the entries.
 * @param {object} doc
 * @param {string} doc.name the slot name
 * @param {object[]} doc.entries contracts Entry objects, in list order
 * @param {string} [doc.label] defaults to "<name>'s list"
 * @param {object} [doc.options] YAML option keys; missing ones take their defaults
 * @param {object} [doc.list] list settings by YAML key (list_preset...); missing ones take their defaults
 * @param {Array<[string, *]>} [doc.passthrough] settings copied as they are, in file order; a game
 *   option among them (random or weighted) is written in that option's place instead of doc.options
 * @param {Array<[string, *]>} [doc.asWritten] game options and list settings written as a player's
 *   file wrote them, in place of doc.options and doc.list, which the plan and the picks still follow
 * @param {string} [doc.plando] requires: plando, the plando modules the player's file asks for
 * @param {number} [doc.createdAt] unix seconds; defaults to listInfo.created_at, else now
 * @param {object} [doc.listInfo] {builder, created_at, label, account, discord}; the slot is doc.name
 * @returns {string} LF line endings, ending with a newline
 */
function renderYaml(doc) {
	if (!doc || typeof doc !== 'object') throw new TypeError('renderYaml needs a doc.');
	const name = doc.name;
	const problem = contracts.slotNameProblem(name);
	if (problem) throw new Error(problem);
	const label = clean(doc.label) || `${name}'s list`;
	const infoCreated = doc.listInfo && Number.isInteger(doc.listInfo.created_at) ? doc.listInfo.created_at : null;
	const createdAt = Number.isInteger(doc.createdAt) ? doc.createdAt : (infoCreated !== null ? infoCreated : Math.floor(Date.now() / 1000));
	const options = resolveOptions(doc.options || {});
	const copied = copiedSettings(doc.passthrough, {});
	const kept = new Map(copied.map(({ key, line }) => [key, line]));
	const written = asWrittenLines(doc.asWritten);
	for (const key of written.keys()) {
		if (kept.has(key)) throw new TypeError(`${key} is both copied as it is and written as the file wrote it.`);
	}
	const plando = doc.plando === undefined || doc.plando === null ? null : plandoParam(doc.plando);
	const listLines = Object.entries(contracts.LIST_OPTIONS).map(([key, spec]) => {
		if (written.has(key)) return written.get(key);
		const raw = doc.list && doc.list[key] !== undefined && doc.list[key] !== null ? doc.list[key] : spec.default;
		return `  ${key}: ${listValue(key, spec, raw)}`;
	});
	const entries = (Array.isArray(doc.entries) ? doc.entries : []).map(orderedEntry);
	const plan = planSlot(entries, plannedOptions(options, doc.passthrough));
	const date = new Date(createdAt * 1000).toISOString().slice(0, 10);
	const n = plan.entryCount;
	// A game option copied as it is stays random, and the plan was made with a value of its own.
	const random = copied.filter(({ key }) => has(contracts.OPTIONS, key)).map(({ key }) => key);
	const one = random.length === 1;
	const lines = [
		`# ${label}: Plex Media list built ${date} for ${name}`,
		`# ${sizeText(n, plan.counts, plan.locations, plan.hours)}; starts with ${plan.startOpen} open; goal: finish ${plan.goal_count} of ${n}`,
		...(random.length ? [`# ${andList(random)} ${one ? 'stays' : 'stay'} random until Archipelago rolls ${one ? 'it' : 'them'}: `
			+ `the line above plans ${one ? 'it' : 'them'} at ${andList(random.map((key) => String(options[key])))}`] : []),
		`name: ${JSON.stringify(name)}`,
		`description: ${JSON.stringify(label)}`,
		`game: ${contracts.GAME}`,
		'requires:',
		`  version: ${contracts.MIN_AP_VERSION}`,
		...(plando !== null ? [`  plando: ${quoted(plando, 'requires: plando')}`] : []),
		'  game:',
		`    ${contracts.GAME}: ${contracts.WORLD_VERSION}`,
		`${contracts.GAME}:`,
	];
	for (const key of Object.keys(contracts.OPTIONS)) {
		lines.push(kept.has(key) ? kept.get(key) : (written.has(key) ? written.get(key) : `  ${key}: ${String(options[key])}`));
	}
	lines.push(...listLines);
	for (const { key, line } of copied) {
		if (!has(contracts.OPTIONS, key)) lines.push(line);
	}
	lines.push(`  list_info: ${JSON.stringify(listInfoOf(doc, label, createdAt))}`);
	if (entries.length) {
		lines.push('  entries:');
		for (const entry of entries) lines.push(`    - ${JSON.stringify(entry)}`);
	} else {
		lines.push('  entries: []');
	}
	return `${lines.join('\n')}\n`;
}

/**
 * What renderYaml takes for a list built from validateParams' result p, with its picks.
 * @param {{createdAt: number, entries: object[]}} picked
 */
function listDoc(p, { createdAt, entries }) {
	return {
		name: p.name,
		label: p.label,
		createdAt,
		options: p.options,
		list: p.list,
		passthrough: p.passthrough,
		asWritten: p.asWritten,
		plando: p.plando,
		listInfo: { builder: contracts.BUILDER_VERSION, account: p.accountId, discord: p.discordUserId },
		entries,
	};
}

/**
 * The YAML's file name. The owner saves every player's YAML into one Players folder, so two slot
 * names must never share a file: letters and digits of any script stay, and a name that lost or
 * changed any character, or that Windows would open as a device (CON, NUL.txt), gets a hash of its
 * exact spelling. A name that already ends like such a hash gets one too, so a kept name can never
 * equal a changed one, not even on a file system that ignores case.
 */
function safeFileName(name) {
	const raw = String(name);
	let base = raw.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_.]+|[_.]+$/g, '');
	const device = WINDOWS_DEVICE.test(base.split('.')[0]);
	if (base === raw && !device && !NAME_HASH_TAIL.test(base)) return `${base}.yaml`;
	if (device) base = base.replace(/\./g, '_');
	const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, NAME_HASH_HEX);
	return `${base || 'plex-media'}-${hash}.yaml`;
}

/**
 * "Items: 2 Fast Forwards, 1 Remote Control, 6 traps (2 Buffering, 2 Rights Expired, 2 Rewind), 24 snacks.",
 * naming only what the pool holds. The counts are the plan's, before the world takes room from the
 * useful items for the list's own excluded watches, tracks and finishes.
 */
function itemsText(summary) {
	const traps = Object.entries(contracts.TRAPS).filter(([key]) => summary.traps && summary.traps[key] > 0);
	const trapCount = traps.reduce((total, [key]) => total + summary.traps[key], 0);
	const held = [
		[summary.fastForwards, ['Fast Forward', 'Fast Forwards']],
		[summary.remoteControls, ['Remote Control', 'Remote Controls']],
	].filter(([n]) => n > 0).map(([n, words]) => plural(n, words));
	if (trapCount) held.push(`${plural(trapCount, ['trap', 'traps'])} (${traps.map(([key, trap]) => `${summary.traps[key]} ${trap.name}`).join(', ')})`);
	if (summary.snacks > 0) held.push(plural(summary.snacks, ['snack', 'snacks']));
	return held.length ? `Items: ${held.join(', ')}.` : 'Items: no Fast Forwards, Remote Controls, traps or snacks.';
}

/**
 * Human lines for the reply: the counts, the start and the goal, what the pool holds, then warnings,
 * misses and the next steps. The command shows the first three as they are.
 * @param {object} summary build().summary
 * @param {string} name the slot name
 * @returns {string[]}
 */
function summaryLines(summary, name) {
	const lines = [
		`${sizeText(summary.entries, summary.counts, summary.locations, summary.hours)}.`,
		`Starts with ${summary.startOpen} open; goal: finish ${summary.goalCount} of ${summary.entries} (about ${hoursText(summary.hoursToGoal)} h).`,
		itemsText(summary),
	];
	for (const w of summary.warnings) lines.push(`Warning: ${w}`);
	for (const miss of summary.misses) {
		lines.push(`Not found: ${miss.query}${miss.didYouMean.length ? ` (did you mean ${miss.didYouMean.join(', ')}?)` : ''}`);
	}
	lines.push(`Next: send this file to the owner. Once the seed is up, run \`/apmedia link ${String(name).replace(/`/g, '')}\`.`);
	lines.push('Every title on the list is visible to the whole room and on the public tracker.');
	return lines;
}

// ---- a player's own YAML ----------------------------------------------------------------------
// Archipelago reads player files with PyYAML, so scalars here resolve by PyYAML's YAML 1.1 rules,
// not the yaml package's own 1.1 ones: "n" and "1e5" stay text, "on" is true, "010" is 8 and "1:30"
// is 90. A value copied into the new file then means to Archipelago what it meant in the old one.

// The most the bot sends a finished list in (REPLY_FILE_MAX in commands/apmedia.js/yaml.js), so any
// list it wrote can be attached again. Only the settings are parsed, SETTINGS_MAX of them at most.
const FILE_MAX_BYTES = 8 * 1024 * 1024;
// Everything but a trailing entries block is parsed on the main thread, which voice playback shares:
// the worst 64 K of small values measured took 0.2 s, and a megabyte 3 to 4 s. Counted in UTF-16
// units, the parser's own unit of work, a list the bot wrote still fits with 50 titles of 200
// characters each and COPY_MAX_BYTES of copied settings.
const SETTINGS_MAX = 64 * 1024;
const MAX_ALIASES = 20;
const TOO_MANY_ALIASES = `The file repeats values through aliases (*name) more than ${MAX_ALIASES} times: write them out instead.`;
const FILE_TOP_KEYS = new Set(['name', 'description', 'game', 'requires', contracts.GAME]);
// The first line of every list the bot writes, which names the slot it was built under.
const BUILT_FOR = /^\uFEFF?# .*: Plex Media list built \d{4}-\d{2}-\d{2} for (.+)/;

/** A setting as an error about a player's file names it: the Options Creator's name, then the YAML key. */
function settingName(key) {
	return has(contracts.SETTING_NAMES, key) ? `${contracts.SETTING_NAMES[key]} (\`${key}\`)` : key;
}

/** A key or value from a player's file as a reply shows it: as the bot read it, a float as Python writes it, and null, .nan and .inf in YAML's words. */
function keyShown(value) {
	if (value === null) return 'null';
	if (value instanceof PyFloat) return pyFloatText(value.value);
	if (typeof value === 'number') {
		if (Number.isNaN(value)) return '.nan';
		if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf';
	}
	if (Array.isArray(value)) return 'a list';
	if (value instanceof Map) return 'a mapping';
	return String(value);
}

/**
 * keyShown in a code span, or the words "a list" or "a mapping" as they are. Text that a code span
 * would change, such as one with a space around it, is shown quoted with its escapes.
 */
function keySpan(value) {
	if (Array.isArray(value) || value instanceof Map) return keyShown(value);
	const text = keyShown(value);
	return codeSpan(typeof value === 'string' && clean(text) !== text ? escapedText(text) : text);
}
// Normalised like the command's keys.
const BOT_ONLY = new Map([
	['account', 'from the linked Plex account'],
	['accountid', 'from the linked Plex account'],
	['discord', 'with the Discord id of the person the list is for'],
	['discorduserid', 'with the Discord id of the person the list is for'],
]);
const PY_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const PY_INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const PY_FLOAT = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const PY_TIMESTAMP = /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/;

/** A YAML date or time, kept as its text: no Archipelago option takes one, so it is never copied. */
class YamlTimestamp {
	constructor(text) {
		this.text = text;
	}

	toString() {
		return this.text;
	}
}
// The one spelling PyYAML makes a date of, and Python's str() of that date.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A YAML float that holds a whole number, such as 50.0, which JavaScript would make an int: PyYAML
 * keeps it a float, Archipelago's ranges and choices refuse one, and a copy writes it back as one.
 */
class PyFloat {
	constructor(value) {
		this.value = value;
	}

	toString() {
		return pyFloatText(this.value);
	}
}

function sexagesimal(text) {
	return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

function signed(text) {
	if (text[0] === '-') return [-1, text.slice(1)];
	if (text[0] === '+') return [1, text.slice(1)];
	return [1, text];
}

function pyInt(source) {
	const [sign, s] = signed(source.replace(/_/g, ''));
	if (s === '0') return 0;
	if (s.startsWith('0b')) return sign * parseInt(s.slice(2), 2);
	if (s.startsWith('0x')) return sign * parseInt(s.slice(2), 16);
	if (s.includes(':')) return sign * sexagesimal(s);
	if (s[0] === '0') return sign * parseInt(s, 8);
	return sign * Number(s);
}

function pyFloat(source) {
	const [sign, s] = signed(source.replace(/_/g, '').toLowerCase());
	if (s === '.inf') return sign * Infinity;
	if (s === '.nan') return NaN;
	const n = sign * (s.includes(':') ? sexagesimal(s) : Number(s));
	return Number.isInteger(n) ? new PyFloat(n) : n;
}

/** Python's str() of the int a PY_INT source reads as, exact at any size. */
function pyIntText(source) {
	const [sign, s] = signed(source.replace(/_/g, ''));
	let n;
	if (s.startsWith('0b')) n = BigInt(`0b${s.slice(2)}`);
	else if (s.startsWith('0x')) n = BigInt(`0x${s.slice(2)}`);
	else if (s.includes(':')) n = s.split(':').reduce((sum, part) => sum * 60n + BigInt(part), 0n);
	else if (s.length > 1 && s[0] === '0') n = BigInt(`0o${s.slice(1)}`);
	else n = BigInt(s);
	return String(sign < 0 ? -n : n);
}

/** Python's str() of a float: the shortest digits that read back, in exponent form below 1e-4 or from 1e16 up. */
function pyFloatText(n) {
	if (Number.isNaN(n)) return 'nan';
	if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
	if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
	const [digits, power] = n.toExponential().split('e');
	const exp = Number(power);
	if (exp < -4 || exp >= 16) return `${digits}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
	const text = String(n);
	return text.includes('.') ? text : `${text}.0`;
}

const PY_SCALARS = [
	{ tag: 'tag:yaml.org,2002:bool', default: true, test: PY_BOOL, resolve: (s) => /^(?:yes|true|on)$/i.test(s), identify: (v) => typeof v === 'boolean' },
	{ tag: 'tag:yaml.org,2002:int', default: true, test: PY_INT, resolve: pyInt, identify: (v) => Number.isInteger(v) },
	{ tag: 'tag:yaml.org,2002:float', default: true, test: PY_FLOAT, resolve: pyFloat, identify: (v) => typeof v === 'number' || v instanceof PyFloat },
	{ tag: 'tag:yaml.org,2002:timestamp', default: true, test: PY_TIMESTAMP, resolve: (s) => new YamlTimestamp(s), identify: (v) => v instanceof YamlTimestamp },
];
const PY_TAG_NAMES = new Set(PY_SCALARS.map((t) => t.tag));
const PARSE_OPTIONS = Object.freeze({
	version: '1.1',
	// The package's own check compares each key with every key before it in its mapping: seconds of
	// main thread for a file of many keys. structureProblem finds the same repeats in one pass.
	uniqueKeys: false,
	customTags: (tags) => [...tags.filter((t) => !PY_TAG_NAMES.has(t.tag)), ...PY_SCALARS],
});
const YAML_PROBLEMS = Object.freeze({
	DUPLICATE_KEY: 'a key is given twice',
	TAB_AS_INDENT: 'a tab indents a line, and YAML takes spaces only',
	BAD_INDENT: 'the indenting is off',
	// Archipelago reads a few explicit tags the bot does not, such as !!float 16.
	TAG_RESOLVE_FAILED: 'it uses a !tag the bot does not read',
	BAD_DQ_ESCAPE: 'a quoted text has a broken \\ escape',
	// The package also ends a quoted text at a next line that is not indented, which LibYAML reads on.
	MISSING_CHAR: 'a quoted text or a bracket is not closed, or a line of it is not indented',
	MULTILINE_IMPLICIT_KEY: 'a key runs over two lines',
	KEY_OVER_1024_CHARS: 'a key runs past 1,024 characters (an emoji counts as two), more than the bot reads',
});

let yamlPackage = null;

// No install command is named: a full npm install re-resolves the bot's whole dependency tree.
function yamlMissing() {
	let version = null;
	try {
		version = require('../package.json').dependencies.yaml;
	} catch (_) {}
	return `The bot cannot read YAML files yet: the owner has to install its yaml package${typeof version === 'string' ? ` (${version})` : ''}.`;
}

function yamlLib() {
	if (!yamlPackage) {
		try {
			yamlPackage = require('yaml');
		} catch (_) {
			throw new Error(yamlMissing());
		}
	}
	return yamlPackage;
}

/** @param {number|null} [line] where the problem starts, when that is not where the package noticed it */
function yamlProblem(err, line = null) {
	const where = line !== null ? line : (Array.isArray(err.linePos) && err.linePos[0] ? err.linePos[0].line : null);
	return `The file could not be read${where !== null ? ` at line ${where}` : ''}: ${YAML_PROBLEMS[err.code] || 'it is not valid YAML there'}.`;
}

// The package's message for a bracket left open inside the file's mappings (BAD_INDENT), which it
// notices at the next line not indented past the bracket's key. The message ends with the file's text.
const FLOW_LEFT_OPEN = /^Flow (?:map|sequence) (?:in block collection )?must /;

/**
 * The line where the quoted text or bracket left open starts, or null: the innermost one a
 * MISSING_CHAR error is inside, or the outermost bracket a BAD_INDENT for an open bracket is inside.
 * The package notices an unclosed quote only where the file ends, which can be far below the edit
 * that left it open, and an open bracket a line or more below it.
 */
function openedAt(YAML, doc, err, lineAt) {
	const bracket = err.code === 'BAD_INDENT' && FLOW_LEFT_OPEN.test(err.message);
	if ((err.code !== 'MISSING_CHAR' && !bracket) || !Array.isArray(err.pos)) return null;
	const at = err.pos[0];
	let found = null;
	YAML.visit(doc, (_, node) => {
		if (!node || !Array.isArray(node.range)) return undefined;
		const quote = !bracket && YAML.isScalar(node) && (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE');
		if (!(quote || (YAML.isCollection(node) && node.flow)) || !(node.range[0] < at && at <= node.range[2])) return undefined;
		found = node;
		return bracket ? YAML.visit.BREAK : undefined;
	});
	return found ? lineAt(found.range[0]) : null;
}

/**
 * The earlier text key of the same mapping that Archipelago's loader (Utils.UniqueKeyLoader) refuses
 * beside this one, the two differing by a leading "+"; null when there is none. The loader compares
 * Python's str() of the key with the text keys before it, so 1 clashes with an earlier "+1" while
 * "+1" passes an earlier 1; a null key is "None" to it, a float key "1.0" and a date "2001-01-31".
 */
function plusTwin(key, textKeys) {
	const { value } = key;
	const source = String(key.source);
	let text = null;
	if (typeof value === 'string') text = value;
	else if (typeof value === 'boolean') text = value ? 'True' : 'False';
	else if (value === null) text = 'None';
	else if (value instanceof PyFloat) text = pyFloatText(value.value);
	else if (value instanceof YamlTimestamp && DATE_ONLY.test(value.text)) text = value.text;
	else if (typeof value === 'number' && PY_INT.test(source)) text = pyIntText(source);
	else if (typeof value === 'number' && PY_FLOAT.test(source)) text = pyFloatText(value);
	if (text === null) return null;
	if (text.startsWith('+') && textKeys.has(text.slice(1))) return text.slice(1);
	return textKeys.has(`+${text}`) ? `+${text}` : null;
}

/**
 * A key as Archipelago's loader compares it with the keys before it in a Python dict: True is 1,
 * False is 0 and 1.0 is 1, while 1 and "1" stay apart, and an int past 2**53 keeps its exact
 * digits, as a float of the same whole value does. PyYAML makes every .nan one shared float, and a
 * dict finds that one by itself, so a second .nan repeats the first; two equal dates repeat too.
 * @param {function(string): symbol} intern one symbol per text for the file being read, which
 *   Symbol.for would keep for as long as the bot runs
 */
function keyId(key, intern) {
	const { value } = key;
	if (typeof value === 'boolean') return Number(value);
	if (value instanceof PyFloat) return Number.isSafeInteger(value.value) ? value.value : intern(`int ${BigInt(value.value)}`);
	if (value instanceof YamlTimestamp && DATE_ONLY.test(value.text)) return intern(`date ${value.text}`);
	if (typeof value !== 'number') return value;
	if (Number.isNaN(value)) return intern('nan');
	const source = String(key.source);
	if (Number.isInteger(value) && !Number.isSafeInteger(value) && PY_INT.test(source)) return intern(`int ${pyIntText(source)}`);
	return value;
}

const MERGE_TAG = 'tag:yaml.org,2002:merge';

/**
 * Why Archipelago's loader refuses a plain << or =, or null. PyYAML resolves a plain << to a merge
 * and a plain = to a value, untagged or tagged with a bare !, and the loader builds neither. Tagged
 * as text they are text to it, but the package still merges at a key << tagged so.
 */
function pyUnreadable(node, isKey = false) {
	if (node.type !== 'PLAIN') return null;
	const untagged = !node.tag || node.tag === '!';
	if (node.source === '<<') {
		if (untagged || node.tag === MERGE_TAG) return 'it uses a << merge, which Archipelago cannot read: write the keys out instead';
		return isKey ? 'it tags a << key, which the bot does not read: write "<<" in quotes instead' : null;
	}
	if (node.source === '=' && untagged) return 'it has a bare =, which Archipelago cannot read: put it in quotes';
	return null;
}

/** Whether an empty key at this offset has no "?" before it: LibYAML refuses that, and the package reads it as null. */
function implicitEmptyKey(text, offset) {
	let i = offset;
	while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1;
	return text[i - 1] !== '?';
}

const OMAP_TAGS = new Set(['tag:yaml.org,2002:omap', 'tag:yaml.org,2002:pairs']);

/**
 * The first thing in the file that Archipelago's loader reads otherwise or refuses, as the reply
 * says it, or more aliases than the bot follows; null when there is none. A key repeats or meets
 * its "+" twin the way the loader has it (keyId, plusTwin), an alias used as a key included, which
 * the loader reads as the key it names. A value tagged with a bare ! is typed as if untagged by the
 * loader and kept as text by the package, and !!omap or !!pairs is a list of pairs to the loader and
 * a mapping or a list of mappings to the package, so those are refused too. So is an anchor named
 * twice, a list or a mapping used as a key and a key left empty without a "?", which the loader
 * cannot read and the package reads anyway. Aliases count over the whole file: the package caps
 * the uses of each anchor only, and it resolves every alias by walking all the anchors and aliases
 * before it.
 * @param {string} text the file as parsed, for what the nodes leave out
 */
function structureProblem(YAML, doc, lineOf, text) {
	const anchors = new Map();
	const keysOf = new Map();
	const symbols = new Map();
	const intern = (id) => {
		if (!symbols.has(id)) symbols.set(id, Symbol(id));
		return symbols.get(id);
	};
	let aliases = 0;
	let problem = null;
	const stop = (message) => {
		problem = message;
		return YAML.visit.BREAK;
	};
	const at = (node, what) => stop(`The file could not be read at line ${lineOf(node)}: ${what}.`);
	YAML.visit(doc, (_, node, path) => {
		if (YAML.isPair(node)) {
			const map = path[path.length - 1];
			const key = YAML.isAlias(node.key) ? anchors.get(node.key.source) : node.key;
			if (!YAML.isMap(map)) return undefined;
			if (YAML.isCollection(key)) return at(node.key, 'it uses a list or a mapping as a key, which Archipelago cannot read');
			if (!YAML.isScalar(key)) return undefined;
			if (key === node.key && key.type === 'PLAIN' && key.source === '' && implicitEmptyKey(text, key.range[0])) {
				return at(node.key, 'it has a : with no key before it, which Archipelago cannot read: give it a key');
			}
			const unreadable = pyUnreadable(key, true);
			if (unreadable) return at(node.key, unreadable);
			if (!keysOf.has(map)) keysOf.set(map, { all: new Set(), text: new Set() });
			const seen = keysOf.get(map);
			const id = keyId(key, intern);
			if (seen.all.has(id)) return at(node.key, YAML_PROBLEMS.DUPLICATE_KEY);
			const twin = plusTwin(key, seen.text);
			if (twin !== null) {
				const shown = typeof key.source === 'string' ? key.source : String(key.value);
				return at(node.key, `it gives both ${codeSpan(twin)} and ${codeSpan(shown)}, which Archipelago refuses together`);
			}
			seen.all.add(id);
			if (typeof key.value === 'string') seen.text.add(key.value);
			return undefined;
		}
		if (YAML.isAlias(node)) {
			aliases += 1;
			if (!anchors.has(node.source)) {
				return at(node, `the alias ${codeSpan(`*${node.source}`)} has no anchor ${codeSpan(`&${node.source}`)} above it`);
			}
			return aliases > MAX_ALIASES ? stop(TOO_MANY_ALIASES) : undefined;
		}
		if (YAML.isScalar(node)) {
			const unreadable = pyUnreadable(node);
			if (unreadable) return at(node, unreadable);
			if (node.tag === '!') return at(node, 'it tags a value with a bare !, which the bot does not read: take the ! out');
		} else if (node && OMAP_TAGS.has(node.tag)) {
			return at(node, 'it uses !!omap or !!pairs, which the bot does not copy: write a mapping or a list instead');
		}
		if (node && node.anchor) {
			if (anchors.has(node.anchor)) return at(node, `it names the anchor ${codeSpan(`&${node.anchor}`)} a second time, which Archipelago refuses: rename one`);
			anchors.set(node.anchor, node);
		}
		return undefined;
	});
	return problem;
}

/**
 * The one document of a player's file as data: mappings as Maps in file order, keys as typed.
 * @param {{at: number, by: number}|null} [shift] lines taken out of the file before offset `at` of
 *   the text, which a reply's line numbers past it count back in
 */
function parsePlayerFile(text, shift = null) {
	const YAML = yamlLib();
	const lineCounter = new YAML.LineCounter();
	const lineAt = (offset) => lineCounter.linePos(offset).line + (shift && offset >= shift.at ? shift.by : 0);
	let docs;
	try {
		docs = YAML.parseAllDocuments(text, { ...PARSE_OPTIONS, lineCounter });
	} catch (_) {
		throw new Error('The file could not be read as YAML.');
	}
	// Archipelago skips an empty document (a stray --- before or after the player, or --- ~), so
	// it holds no second player here either. The package reads one as a null scalar.
	const empty = (doc) => doc.contents === null || (YAML.isScalar(doc.contents) && doc.contents.value === null);
	const real = [...docs].filter((doc) => doc.errors.length || doc.warnings.length || !empty(doc));
	if (!real.length) throw new Error('The file is empty: attach the YAML the Options Creator saved.');
	if (real.length > 1) throw new Error(`The file holds ${real.length} YAML documents (split by ---), and the bot takes one player per file.`);
	const doc = real[0];
	const problem = doc.errors[0] || doc.warnings[0];
	if (problem) {
		let line = null;
		try {
			line = openedAt(YAML, doc, problem, lineAt);
		} catch (_) {}
		// An open bracket found where it starts is the one left open, not a line indented wrong.
		if (line !== null && problem.code === 'BAD_INDENT') throw new Error(yamlProblem({ code: 'MISSING_CHAR' }, line));
		const noticed = Array.isArray(problem.linePos) && problem.linePos[0] && Array.isArray(problem.pos) ? lineAt(problem.pos[0]) : null;
		throw new Error(yamlProblem(problem, line !== null ? line : noticed));
	}
	let found;
	try {
		found = structureProblem(YAML, doc, (node) => lineAt(node.range[0]), text);
	} catch (_) {
		throw new Error('The file could not be read as YAML.');
	}
	if (found) throw new Error(found);
	try {
		// The package counts the anchored value itself as one use, and an anchor's uses times the
		// aliases inside it, so a repeat nested in a repeat stops here.
		return doc.toJS({ mapAsMap: true, maxAliasCount: MAX_ALIASES + 1 });
	} catch (err) {
		if (err instanceof ReferenceError && /^Excessive alias count/.test(err.message)) throw new Error(TOO_MANY_ALIASES);
		throw new Error('The file could not be read as YAML.');
	}
}

// Archipelago's YAML reader (LibYAML) ends a line at a lone CR as well, as an old Mac file or a
// doubled conversion leaves them, and at a raw NEL, U+2028 or U+2029, which the yaml package reads
// as characters; it refuses a raw C0 or C1 control, DEL, U+FFFE and U+FFFF. A lone CR is made the
// line break it is to Archipelago; the rest is refused, naming its line.
const LONE_CR = /\r(?!\n)/g;
const RAW_REFUSED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\uFFFE\uFFFF]/;
const RAW_BREAKS = new Set([0x85, 0x2028, 0x2029]);

/** The first refused raw character as the reply says it, or null; its line counts a lone CR as a break. */
function rawCharProblem(text) {
	const found = RAW_REFUSED.exec(text);
	if (!found) return null;
	let line = 1;
	for (let i = 0; i < found.index; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
	}
	const code = found[0].charCodeAt(0);
	const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
	if (RAW_BREAKS.has(code)) {
		return `The file could not be read at line ${line}: it holds an invisible line break (${hex}), which Archipelago would split the line at: delete it.`;
	}
	return `The file could not be read at line ${line}: it holds an invisible control character (${hex}), which Archipelago refuses: delete it.`;
}

// A file the bot wrote ends with its entries, one per line, and they are dropped anyway: parsing
// 2,000 of them holds the main thread for about half a second, which voice playback hears. The
// file is up to 8 MB, so it is searched without splitting it into lines: a file of millions of
// line breaks would hold the thread longer than parsing a list does.
const ENTRIES_AT = /(?:^|\r\n|\r|\n)( {2}entries:[ \t]*(?:#[^\r\n]*)?)(?=\r\n|\r|\n|$)/;
const NON_BLANK = /\S/g;
const LINE_END = /[\r\n]/g;
// The lines of an entries block looked at, at most: a list holds 2,000 entries, and one that a
// YAML tool wrote out again takes a line for each field.
const ENTRY_LINES_MAX = contracts.LIMITS.maxEntries * 16;
const WHOLE = (text) => ({ text, count: null, shift: null });

/** The line breaks from one line start to another, a CRLF pair or a lone CR counting as one. */
function breaksBetween(text, from, to) {
	let n = 0;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) n++;
	}
	return n;
}

/**
 * The file without its entries block, with LF line ends, the entries it had, and the lines taken out
 * before the offset where the rest of the file goes on (shift, null when the block ends the file);
 * the whole file as it is and count null when there is no block to take out. The block is every
 * line after "  entries:" that is blank, a comment, an item ("- " at one indent of 2 or more, at
 * most 2,000 of them) or indented past the items; a line at a setting's indent after it is kept. A
 * lone CR ends a line.
 */
function withoutEntries(text) {
	const m = ENTRIES_AT.exec(text);
	if (!m) return WHOLE(text);
	const start = m.index + m[0].length - m[1].length;
	// A CRLF pair at most halves the settings, so these are refused whatever follows.
	if (start > 2 * SETTINGS_MAX + 2) return { text: text.slice(0, start), count: 0, shift: null };
	const from = start + m[1].length;
	let count = 0;
	let lines = 0;
	let item = null;
	let end = text.length;
	NON_BLANK.lastIndex = from;
	for (let n = NON_BLANK.exec(text); n; n = NON_BLANK.exec(text)) {
		const p = n.index;
		// Spaces alone indent YAML: a tab or another blank before the text leaves the file whole.
		let s = p;
		while (text.charCodeAt(s - 1) === 32) s--;
		const c = text.charCodeAt(s - 1);
		if (c !== 10 && c !== 13) return WHOLE(text);
		if (++lines > ENTRY_LINES_MAX) return WHOLE(text);
		const indent = p - s;
		const dash = text[p] === '-' && /^[ \t\r\n]?$/.test(text.slice(p + 1, p + 2));
		if (dash && indent >= 2 && (item === null || indent === item)) {
			item = indent;
			if (++count > contracts.LIMITS.maxEntries) return WHOLE(text);
		} else if (text[p] !== '#' && !(indent > 2 && (item === null || indent > item))) {
			if (indent > 2) return WHOLE(text);
			end = s;
			break;
		}
		LINE_END.lastIndex = p;
		const e = LINE_END.exec(text);
		if (!e) break;
		NON_BLANK.lastIndex = e.index;
	}
	const before = start ? text.slice(0, start).replace(/\r\n?/g, '\n') : '\n';
	if (end === text.length) return { text: before, count, shift: null };
	if (text.length - end > 2 * SETTINGS_MAX + 2) return WHOLE(text);
	const kept = start ? before : '';
	return { text: kept + text.slice(end).replace(/\r\n?/g, '\n'), count, shift: { at: kept.length, by: breaksBetween(text, start, end) } };
}

const RANDOM = Symbol('random');
// What Archipelago reads as random for a Range: random, random-low/-middle/-high,
// random-range-<min>-<max> and random-range-low/-middle/-high-<min>-<max>. A Choice or Toggle
// takes random alone.
const RANGE_RANDOM = /^random(?:-(?:low|middle|high)|-range-(?:(?:low|middle|high)-)?\d+-\d+)?$/i;
// A text Python's int() reads: its spaces around it, and decimal digits of any script with _ between them.
const PY_INT_TEXT = new RegExp(`^${PY_INT_SPACE}*[-+]?\\p{Nd}+(?:_\\p{Nd}+)*${PY_INT_SPACE}*$`, 'u');
const DIGIT = /\p{Nd}/u;

/** A decimal digit's value: Unicode puts every script's digits in runs of ten, from 0 to 9. */
function digitValue(ch) {
	const code = ch.codePointAt(0);
	if (code >= 48 && code <= 57) return code - 48;
	let start = code;
	while (start > 0 && DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
	return (code - start) % 10;
}

/** Python's int() of a text, or null where it raises. */
function pyIntOfText(text) {
	if (!PY_INT_TEXT.test(text)) return null;
	const body = text.replace(PY_STRIP, '');
	let n = 0;
	for (const ch of body.replace(/^[-+]|_/g, '')) n = n * 10 + digitValue(ch);
	return body[0] === '-' ? -n : n;
}
const LIST_FIX = Object.freeze({
	choice: 'choose one',
	named_range: 'set a number',
	range: 'set a number',
	toggle: 'set true or false',
	text: 'write it as one text',
});

function specialsOf(key, spec) {
	if (spec.special) return spec.special;
	// The world's timesanity options are NamedRanges with off = 0; the table does not list it.
	return /^timesanity_/.test(key) ? { off: 0 } : {};
}

/**
 * A plain Range or NamedRange value the way Archipelago reads it: a number, or a special name for a list count.
 * @param {string} [name] the setting as an error names it; the key by default
 */
function rangeValue(key, spec, value, name = key) {
	const specials = specialsOf(key, spec);
	const words = Object.keys(specials);
	const bad = () => new Error(`${name} must be a whole number from ${spec.min} to ${spec.max}${words.length ? ` or ${words.join(', ')}` : ''}.`);
	const named = (n) => {
		const word = words.find((w) => specials[w] === n);
		return word !== undefined && spec.type === 'named_range' ? word : n;
	};
	const special = (n) => words.some((w) => specials[w] === n);
	// Archipelago reads true as the default and false as 0 when the range starts at 0 and the
	// default is not 0. The world's timers read false as 0 whatever their default, so an unquoted
	// "off" (false in YAML 1.1) turns even the albums timer off.
	const bool = (on) => {
		if (!on && /^timesanity_/.test(key)) return 0;
		const fallback = typeof spec.default === 'string' ? specials[spec.default] : spec.default;
		if (spec.min !== 0 || fallback === 0) throw bad();
		return on ? named(fallback) : 0;
	};
	let n;
	if (typeof value === 'boolean') return bool(value);
	if (value instanceof PyFloat) throw new Error(`${name} must be a whole number from ${spec.min} to ${spec.max}, written without a decimal point.`);
	if (typeof value === 'number') {
		n = value;
	} else if (typeof value === 'string') {
		const text = value.toLowerCase();
		if (has(specials, text)) return named(specials[text]);
		if (text === 'default') return spec.default;
		if (text === 'high') return spec.max;
		if (text === 'low') return spec.min;
		if (text === 'true' || text === 'false') return bool(text === 'true');
		n = pyIntOfText(text);
		if (n === null) throw bad();
	} else {
		throw bad();
	}
	if (Number.isInteger(n) && special(n)) return named(n);
	if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw bad();
	return n;
}

// Archipelago's Toggle words, in any case.
const TOGGLE_OFF = new Set(['null', 'disabled', 'false', 'off', '0', 'no', 'none']);
const TOGGLE_ON = new Set(['true', 'enabled', 'yes', '1', 'on']);

/** A Toggle the way Archipelago reads it: true or false, one of its words as written, or a number (on unless int() makes it 0). */
function toggleValue(key, value) {
	if (typeof value === 'boolean') return value;
	const n = value instanceof PyFloat ? value.value : value;
	if (typeof n === 'number' && Number.isFinite(n)) return Math.trunc(n) !== 0;
	if (typeof value === 'string') {
		const word = value.toLowerCase();
		if (TOGGLE_OFF.has(word)) return false;
		if (TOGGLE_ON.has(word)) return true;
	}
	throw new Error(`${key} must be true or false.`);
}

/** A plain value of a Range, NamedRange, Choice or Toggle option as Archipelago reads it, or an Error naming the setting. */
function plainValue(key, spec, value, name = key) {
	if (spec.type === 'range' || spec.type === 'named_range') return rangeValue(key, spec, value, name);
	if (spec.type === 'choice') {
		if (typeof value === 'string' && spec.values.includes(value.toLowerCase())) return value.toLowerCase();
		// Archipelago also takes a choice's number, and the world numbers its choices in table order.
		if (Number.isInteger(value) && value >= 0 && value < spec.values.length) return spec.values[value];
		throw new Error(`${name} must be one of: ${spec.values.join(', ')}.`);
	}
	return toggleValue(name, value);
}

// Python's int() of a weight, or null where it raises.
function pyIntWeight(value) {
	if (typeof value === 'boolean') return Number(value);
	const n = value instanceof PyFloat ? value.value : value;
	if (typeof n === 'number') return Number.isFinite(n) ? Math.trunc(n) : null;
	return typeof value === 'string' ? pyIntOfText(value) : null;
}

/**
 * What Archipelago's get_choice can roll from a weighted mapping or a list: the keys whose weight
 * Python's int() makes more than 0, or any item of the list. An empty mapping rolls nothing, which
 * reads as an empty value. A mapping with no weight above 0 is refused, as get_choice refuses it
 * (every weight 0) or random.choices does (weights that int() makes 0), and so is an empty list and
 * a weight int() cannot read. A weight below 0 is refused too: random.choices rolls past one
 * without a word, so the bot does not guess what it was meant to do.
 * @returns {Array<*>|null} null for an empty mapping
 */
function rolls(name, value) {
	if (Array.isArray(value)) {
		if (!value.length) throw new Error(`${name} is an empty list, which Archipelago cannot pick from: give it a value.`);
		return value;
	}
	if (!value.size) return null;
	const out = [];
	for (const [choice, weight] of value) {
		const n = pyIntWeight(weight);
		const what = keySpan(choice);
		if (n === null) throw new Error(`${name} gives ${what} a weight that is not a whole number, which Archipelago cannot roll.`);
		if (n < 0) throw new Error(`${name} gives ${what} a weight below 0, which the bot does not read: use 0 to leave a choice out.`);
		if (n > 0) out.push(choice);
	}
	if (!out.length) throw new Error(`${name} has every choice weighted 0, which Archipelago refuses: give one a weight above 0.`);
	return out;
}

/**
 * A game option's single value from the file: its value, or RANDOM when Archipelago picks it. An
 * empty one is refused: no option of the world reads the None that Archipelago makes of it.
 * @param {boolean} [rolled] the value is one choice of a weighted mapping or a list
 */
function optionChoice(key, name, spec, value, rolled = false) {
	if (value === null) {
		throw new Error(rolled ? `${name} can roll an empty value, which Archipelago refuses: give each choice a value.`
			: `${name} is empty, which Archipelago refuses: give it a value or take the line out.`);
	}
	const said = `${name} ${rolled ? 'can roll' : 'is'} ${keySpan(value)}`;
	if (typeof value === 'string' && /^random/i.test(value)) {
		// Archipelago lowercases a Range's or a Choice's text, but takes a Toggle's random only as written.
		const reads = spec.type === 'range' ? RANGE_RANDOM.test(value) : (spec.type === 'choice' ? /^random$/i.test(value) : value === 'random');
		// Archipelago reads more random-range spellings than the bot, and no other random- word.
		if (!reads) {
			throw new Error(spec.type === 'range'
				? `${said}, which the bot does not read: random, random-low, random-middle, random-high or random-range-<min>-<max> picks at random.`
				: `${said}, which Archipelago does not read: random picks at random.`);
		}
		const span = /-range-(?:[a-z]+-)?(\d+)-(\d+)$/i.exec(value);
		if (span) {
			const [low, high] = [Number(span[1]), Number(span[2])].sort((a, b) => a - b);
			if (low < spec.min || high > spec.max) throw new Error(`${said}, which Archipelago refuses: a random range has to stay within ${spec.min} to ${spec.max}.`);
		}
		return RANDOM;
	}
	try {
		return plainValue(key, spec, value, name);
	} catch (err) {
		if (!rolled || !err.message.startsWith(`${name} `)) throw err;
		throw new Error(`${said}: it ${err.message.slice(name.length + 1)}`);
	}
}

/**
 * A game option from the file: its value, or RANDOM to keep it as it is. A weighted mapping or a
 * list is Archipelago's to roll, and each choice it can roll has to be one Archipelago reads; a
 * mapping that can roll only one choice, as a Launcher template's do, is that choice.
 */
function fileOption(key, value) {
	const spec = contracts.OPTIONS[key];
	const name = settingName(key);
	if (!(value instanceof Map) && !Array.isArray(value)) return optionChoice(key, name, spec, value);
	const choices = rolls(name, value);
	// get_choice makes None of an empty mapping.
	if (choices === null) return optionChoice(key, name, spec, null);
	const read = choices.map((choice) => optionChoice(key, name, spec, choice, true));
	return read.length === 1 ? read[0] : RANDOM;
}

class RandomListSetting extends Error {
	constructor(message, setting) {
		super(message);
		this.setting = setting;
	}
}

/**
 * A list setting from the file: a count may stay "preset"; anything random is refused, with a
 * RandomListSetting so the reply can name every one. A mapping that can roll only one choice, as a
 * Launcher template's do, is that choice. An empty value reads as Archipelago reads it: no preset,
 * no text, and refused for a number or a toggle.
 */
function fileListValue(key, value) {
	const spec = contracts.LIST_OPTIONS[key];
	const name = settingName(key);
	const random = () => new RandomListSetting(`${name} is random: ${LIST_FIX[spec.type]}, the bot needs it to pick titles.`, name);
	let one = value;
	if (value instanceof Map || Array.isArray(value)) {
		const choices = rolls(name, value);
		if (choices !== null && choices.length > 1) throw random();
		one = choices === null ? null : choices[0];
	}
	if (one === null) {
		if (spec.type === 'choice') return NO_PRESET;
		if (spec.type === 'text') return undefined;
		throw new Error(`${name} is empty, which Archipelago refuses: ${LIST_FIX[spec.type]}.`);
	}
	if (one instanceof Map || Array.isArray(one)) throw new Error(`${name} must be ${spec.type === 'text' ? 'text' : 'one value'}, not a list or a mapping.`);
	// Archipelago never rolls a plain text setting and the Options Creator offers one no Random?, so a
	// playlist called Random is a name here, as it is on the command.
	if (spec.type !== 'text' && typeof one === 'string' && /^random(?:$|-)/i.test(one)) throw random();
	if (spec.type !== 'text') return plainValue(key, spec, one, name);
	// An unquoted list_years: 1999 reads as a number; the new file writes it back as text, as Python's str() writes it.
	if (typeof one === 'number' && Number.isInteger(one) && !Number.isSafeInteger(one)) {
		throw new Error(`${name} holds a number too large for the bot to read exactly: put it in quotes.`);
	}
	let text = one;
	if (one instanceof PyFloat) text = pyFloatText(one.value);
	else if (typeof one === 'number' && Number.isFinite(one)) text = Number.isInteger(one) ? String(one) : pyFloatText(one);
	if (typeof text !== 'string') throw new Error(`${name} must be text: put it in quotes.`);
	if (!clean(text)) return '';
	if (key === 'list_titles') titlesParam(text, name);
	else if (key === 'list_years') yearsParam(text, name);
	else textParam(name, text, key === 'list_genre' ? 60 : key === 'list_label' ? MAX_LABEL : MAX_TEXT);
	return text;
}

/** What a top-level game or name can roll, as Archipelago's get_choice reads it: one value, RANDOM for more, or undefined for none. */
function oneRoll(what, value) {
	if (!(value instanceof Map) && !Array.isArray(value)) return value;
	const can = new Set(rolls(what, value) || []);
	return can.size > 1 ? RANDOM : [...can][0];
}

function fileName(data, overrides) {
	if (given(overrides.name)) return overrides.name;
	const name = oneRoll('The name in the file', data.get('name'));
	if (name === RANDOM) throw new Error('The file picks its name at random: give the slot one with the name option.');
	if (name === undefined || name === null || name === '') throw new Error('The file has no name: give the slot one with the name option.');
	if (typeof name !== 'string') throw new Error('The name in the file is not text: give the slot one with the name option.');
	const problem = contracts.slotNameProblem(name);
	if (problem) throw new Error(`${problem} That is the name in the file: give the slot another with the name option.`);
	return name;
}

/**
 * A player's YAML (from the Archipelago Launcher's Options Creator, or one the bot wrote) as
 * build() params. The list settings say what to pick; each game option becomes its param; every
 * other setting under "Plex Media:" is kept as it is, in file order, in passthrough. A random or
 * weighted game option is kept that way too and listed in `random`, and the plan uses its default.
 * The file's entries and list_info are dropped: the titles are picked fresh, and list_info is the
 * bot's to fill in. A list with entries or list_info but no list settings (the bot's before 0.2.0)
 * is refused unless the command says what to pick, and keeps the label its list_info names.
 * A setting a trigger in the file checks keeps the file's own spelling too (asWritten), since
 * Archipelago compares that spelling with the trigger's option_result.
 * @param {string} text the file, decoded
 * @param {object} [overrides] build() params given with the command: each replaces the file's
 *   value, which is then not read at all, and the name and "picks something" checks look at the result
 * @returns {{name: string, label?: string, params: object, passthrough: Array<[string, *]>, random: string[], entriesCount: number, listFor?: string}}
 *   listFor: the Discord id the file's list_info names, while the slot keeps the name the list was built under
 */
function readPlayerYaml(text, overrides = {}) {
	if (typeof text !== 'string') throw new TypeError('readPlayerYaml needs the file as text.');
	if (Buffer.byteLength(text, 'utf8') > FILE_MAX_BYTES) throw new Error(`The file is over ${FILE_MAX_BYTES / (1024 * 1024)} MB, the most the bot reads.`);
	const raw = rawCharProblem(text);
	if (raw) throw new Error(raw);
	// The cut also takes a line "  entries:" inside a quoted text that runs over lines, which LibYAML
	// reads on, and the file is then refused. Neither the Options Creator nor the bot writes one.
	const short = withoutEntries(text);
	if (short.text.length > SETTINGS_MAX) {
		throw new Error(`The file's settings take more than ${SETTINGS_MAX / 1024} KB, the most the bot reads: attach the YAML the Options Creator saved, or a list the bot wrote.`);
	}
	const data = parsePlayerFile(short.count === null ? short.text.replace(LONE_CR, '\n') : short.text, short.shift);
	if (!(data instanceof Map)) throw new Error(`The file is not a player YAML: it needs name, game and ${contracts.GAME} at the top.`);
	// The game first: another game's file always has that game's settings at the top as well.
	const game = oneRoll("The file's game", data.get('game'));
	if (game === RANDOM) throw new Error(`The file picks its game at random: set game: ${contracts.GAME}.`);
	if (game === undefined || game === null) throw new Error(`The file names no game: set game: ${contracts.GAME}.`);
	if (game !== contracts.GAME) throw new Error(`The file's game is ${codeSpan(keyShown(game))}, and the bot fills in ${contracts.GAME} lists only.`);
	for (const key of data.keys()) {
		if (key === 'triggers') throw new Error(`The file has \`triggers\` at the top: the bot reads triggers under ${contracts.GAME}: only, so move them there.`);
		if (key === 'linked_options') throw new Error('The file has `linked_options` at the top, which the bot does not copy: take them out.');
		if (typeof key !== 'string' || !FILE_TOP_KEYS.has(key)) {
			throw new Error(`The file has ${keySpan(key)} at the top, and the bot takes one player per file: name, description, game, requires and ${contracts.GAME} only.`);
		}
	}
	// The bot writes requires itself, but for the plando a player asks for there. Archipelago skips
	// a requires that Python reads as false, such as 0 or [].
	const requires = data.get('requires');
	if (!pyFalsy(requires) && !(requires instanceof Map)) {
		throw new Error('The file\'s requires: needs its settings under it, one per line, as a template from the Launcher writes them.');
	}
	const plando = requires instanceof Map ? requires.get('plando') : undefined;
	if (plando !== undefined) plandoParam(plando, "The file's requires: plando");
	if (!data.has(contracts.GAME)) throw new Error(`The file has no ${contracts.GAME} settings: save it again from the Options Creator.`);
	const section = data.get(contracts.GAME);
	if (section !== null && !(section instanceof Map)) {
		throw new Error(`The file's ${contracts.GAME}: needs its settings under it, one per line, as the Options Creator writes them.`);
	}

	const checked = section === null ? new Set() : triggerChecked(section.get('triggers'), section.has('triggers'));
	const typedRaw = (key) => overrides[has(contracts.LIST_OPTIONS, key) ? LIST_PARAMS[key] : OPTION_KEYS[key]];
	const typed = (key) => given(typedRaw(key));
	for (const key of checked) {
		if (!section.has(key) && !typed(key)) throw new Error(`A trigger in your file checks ${settingName(key)}, which the file does not set: set it in the file.`);
	}
	// A typed option that a trigger checks replaces the file's, unless it reads the same: then the
	// file's spelling stays for the trigger to compare.
	const replaced = (key, value) => typed(key) && !(checked.has(key) && typedReadsAsFile(key, value, typedRaw(key)));
	const options = {};
	const list = {};
	const kept = [];
	const asWritten = [];
	const room = copyRoom();
	let entriesCount = short.count || 0;
	let recorded = false;
	let listFor = null;
	let builtAs = null;
	const randomLists = [];
	for (const [key, value] of section || []) {
		if (typeof key !== 'string') throw new Error(`The ${contracts.GAME} settings have ${keySpan(key)} where a setting name goes.`);
		if (key === '') throw new Error(`The ${contracts.GAME} settings have a setting with no name: take that line out.`);
		if (key === 'entries') {
			if (Array.isArray(value)) entriesCount = value.length;
			continue;
		}
		if (key === 'list_info') {
			const info = value instanceof Map ? value : new Map();
			const discord = info.get('discord');
			if (typeof discord === 'string' && /^\d{15,25}$/.test(discord)) listFor = discord;
			if (typeof info.get('slot') === 'string') builtAs = info.get('slot');
			continue;
		}
		const tag = triggerTagProblem(key);
		if (tag) throw new Error(tag);
		const filled = BOT_ONLY.get(key.toLowerCase().replace(/[-_]/g, ''));
		if (filled) throw new Error(`${codeSpan(key)} is filled in by the bot ${filled}: take it out of the file.`);
		// An option typed with the command replaces the file's, so the file's value is never read.
		if (has(contracts.LIST_OPTIONS, key)) {
			recorded = true;
			if (replaced(key, value)) continue;
			let v;
			try {
				v = fileListValue(key, value);
			} catch (err) {
				if (!(err instanceof RandomListSetting)) throw err;
				randomLists.push(err);
				continue;
			}
			if (v !== undefined) list[key] = v;
			if (checked.has(key)) {
				copiedLine(key, value, room);
				asWritten.push([key, value]);
			}
			continue;
		}
		const game = has(contracts.OPTIONS, key);
		if (game && replaced(key, value)) continue;
		const v = game ? fileOption(key, value) : RANDOM;
		if (v === RANDOM) {
			copiedLine(key, value, room);
			kept.push([key, value]);
			continue;
		}
		options[key] = v;
		if (checked.has(key)) {
			copiedLine(key, value, room);
			asWritten.push([key, value]);
		}
	}
	if (randomLists.length === 1) throw new Error(randomLists[0].message);
	if (randomLists.length > 1) throw new Error(`${andList(randomLists.map((err) => err.setting))} are random: the bot needs a value in each to pick titles.`);

	// A list the bot built before 0.2.0 has its titles and list_info but no list settings, and the
	// defaults would quietly turn it into 15 movies.
	const old = !recorded && (short.count !== null || (section !== null && (section.has('entries') || section.has('list_info'))));
	if (old && !['preset', ...COUNT_KEYS, 'titles', 'playlist', 'collection'].some((param) => given(overrides[param]))) throw new Error(OLD_LIST);

	const params = { name: fileName(data, overrides) };
	const setting = (key) => (has(list, key) ? list[key] : contracts.LIST_OPTIONS[key].default);
	if (old) {
		// The file says nothing about what to pick, so the typed options decide it as they do without a file.
		if (given(overrides.preset)) params.preset = overrides.preset;
	} else {
		const preset = given(overrides.preset) ? choiceParam('preset', overrides.preset, PRESET_NAMES) : setting('list_preset');
		const base = contracts.PRESETS[preset] || {};
		params.preset = preset;
		for (const kind of COUNT_KEYS) {
			const v = setting(`list_${kind}`);
			params[kind] = v === 'preset' ? (base[kind] || 0) : v;
		}
	}
	for (const [key, param] of Object.entries(LIST_PARAMS)) {
		if (param === 'preset' || COUNT_KEYS.includes(param)) continue;
		const v = setting(key);
		if (v !== '') params[param] = v;
	}
	// The slot a list the bot wrote was built under: list_info names it, and a list from before it did
	// names it in its first line.
	const header = builtAs === null ? BUILT_FOR.exec(text) : null;
	const builtUnder = builtAs !== null ? builtAs : (header ? header[1] : data.get('name'));
	// The old bot kept a label only in list_info. One that is just "<name>'s list" is left to follow
	// the slot's name.
	const info = old && section !== null ? section.get('list_info') : undefined;
	const oldLabel = info instanceof Map ? info.get('label') : undefined;
	if (typeof oldLabel === 'string' && clean(oldLabel) && [...clean(oldLabel)].length <= MAX_LABEL && oldLabel !== `${builtUnder}'s list`) {
		params.label = oldLabel;
	}
	for (const [key, value] of Object.entries(options)) params[OPTION_KEYS[key]] = value;
	for (const [param, value] of Object.entries(overrides)) {
		if (param !== 'preset' && given(value)) params[param] = value;
	}
	params.passthrough = kept;
	if (asWritten.length) params.asWritten = asWritten;
	if (typeof plando === 'string') params.plando = plando;

	const counts = COUNT_KEYS.map((kind) => Number(params[kind]));
	if (counts.every((n) => n === 0) && !given(params.titles) && !given(params.playlist) && !given(params.collection)) {
		throw new Error(PICK_NOTHING);
	}
	const out = {
		name: params.name,
		params,
		passthrough: params.passthrough.map(([key, value]) => [key, value]),
		random: params.passthrough.filter(([key]) => has(contracts.OPTIONS, key)).map(([key]) => key),
		entriesCount,
	};
	if (given(params.label)) out.label = clean(params.label);
	// A list the bot wrote names in list_info whom it was for: under a name other than the one it was
	// built under, it is a new slot.
	if (listFor !== null && params.name === builtUnder) out.listFor = listFor;
	return out;
}

/** Whether Python reads a YAML value as false, as `if requirements:` does. */
function pyFalsy(value) {
	if (value === undefined || value === null || value === false || value === '') return true;
	if (value instanceof PyFloat) return value.value === 0;
	if (typeof value === 'number') return value === 0;
	if (Array.isArray(value)) return !value.length;
	if (value instanceof Map) return !value.size;
	return false;
}

// What a trigger's option_category can name in a file the bot writes: the section, or requires.
const TRIGGER_CATEGORIES = new Set([contracts.GAME, 'requires']);

/**
 * The settings a trigger's options set under Plex Media, as [setting, value, prefix]: Archipelago
 * merges a value whose key starts with + and takes one away with -.
 */
function* triggerSettings(trigger) {
	const options = trigger instanceof Map ? trigger.get('options') : null;
	const own = options instanceof Map ? options.get(contracts.GAME) : null;
	if (!(own instanceof Map)) return;
	for (const [key, value] of own) {
		if (typeof key !== 'string') continue;
		const setting = key.replace(/^[+-]+/, '');
		yield [setting, value, key.slice(0, key.length - setting.length)];
	}
}

/**
 * The game options and list settings the file's triggers check, which keep the file's spelling: a
 * trigger whose option_category is Plex Media compares the setting its option_name rolls. Refused,
 * naming the trigger: what Generate.roll_triggers refuses on every roll (triggers that are not a
 * list of mappings, an option_category the file does not have, an option_name that cannot roll), a
 * trigger on description or requires, which the bot writes, a trigger that sets a list setting,
 * entries or list_info, which the picks would not follow, and a value Archipelago refuses.
 * @param {boolean} present the file has a triggers line, even an empty one
 */
function triggerChecked(triggers, present) {
	const out = new Set();
	if (!present || triggers === '' || (triggers instanceof Map && !triggers.size)) return out;
	if (!Array.isArray(triggers)) throw new Error('The file\'s triggers: needs a list of triggers under it, each starting with "- ", which Archipelago refuses otherwise.');
	triggers.forEach((trigger, i) => {
		const refuse = (what) => new Error(`Trigger ${i + 1} in your file ${what}`);
		if (!(trigger instanceof Map)) throw refuse('is not a mapping of option_category, option_name, option_result and options, which Archipelago refuses.');
		const category = trigger.get('option_category');
		if (!pyFalsy(category) && !(typeof category === 'string' && TRIGGER_CATEGORIES.has(category))) {
			const what = Array.isArray(category) || category instanceof Map ? `${keySpan(category)} as its option_category` : `the option_category ${keySpan(category)}`;
			throw refuse(`has ${what}, which Archipelago cannot find in the file: use ${contracts.GAME}.`);
		}
		const name = trigger.get('option_name');
		let names = name === undefined ? [] : [name];
		if (Array.isArray(name)) {
			if (!name.length) throw refuse('has an empty list as its option_name, which Archipelago cannot pick from.');
			names = name;
		} else if (name instanceof Map) {
			const weights = [...name.values()].map(pyIntWeight);
			if (name.size && (weights.includes(null) || weights.reduce((sum, n) => sum + n, 0) <= 0)) {
				throw refuse('has an option_name that cannot roll, which Archipelago refuses: give its choices whole-number weights, one of them above 0.');
			}
			// random.choices never lands on a weight of 0 or below.
			names = [...name.keys()].filter((_, j) => weights[j] > 0);
		}
		const top = names.find((n) => n === 'description' || n === 'requires');
		if (pyFalsy(category) && top) throw refuse(`checks \`${top}\` at the top of the file, which the bot writes itself: check a ${contracts.GAME} setting instead.`);
		if (category === contracts.GAME) {
			for (const n of names) if (typeof n === 'string' && (has(contracts.OPTIONS, n) || has(contracts.LIST_OPTIONS, n))) out.add(n);
		}
		for (const [setting, value, prefix] of triggerSettings(trigger)) {
			if (has(contracts.LIST_OPTIONS, setting)) throw refuse(`sets ${settingName(setting)}, which the bot does not follow: set it in the file itself.`);
			if (setting === 'entries' || setting === 'list_info') throw refuse(`sets \`${setting}\`, which the bot writes: take it out of the trigger.`);
			if (!prefix && has(contracts.OPTIONS, setting)) {
				try {
					fileOption(setting, value);
				} catch (err) {
					throw new Error(`Trigger ${i + 1} in your file: ${err.message}`);
				}
			}
		}
	});
	return out;
}

/**
 * The timers the file's triggers set, as [key, value]: Generate.roll_triggers writes a trigger's
 * value over the file's before the slot is planned. Every trigger counts, whether or not it fires,
 * and a key with -, which only takes choices away, does not.
 */
function triggerTimers(passthrough) {
	const pair = passthrough.find(([key]) => key === 'triggers');
	const out = [];
	if (!pair || !Array.isArray(pair[1])) return out;
	for (const trigger of pair[1]) {
		for (const [setting, value, prefix] of triggerSettings(trigger)) {
			if (/^timesanity_/.test(setting) && has(contracts.OPTIONS, setting) && prefix[0] !== '-') out.push([setting, value]);
		}
	}
	return out;
}

/** Whether a value typed with the command reads as the file's own value of the setting. */
function typedReadsAsFile(key, value, raw) {
	try {
		if (has(contracts.OPTIONS, key)) {
			const read = fileOption(key, value);
			return read !== RANDOM && read === optionParam(OPTION_KEYS[key], key, raw);
		}
		const spec = contracts.LIST_OPTIONS[key];
		const read = fileListValue(key, value);
		if (spec.type === 'text') return typeof read === 'string' && clean(read) === clean(raw);
		if (spec.type === 'toggle') return read === boolParam(key, raw);
		if (spec.type === 'choice') return read === choiceParam(key, raw, spec.values);
		return read === intParam(key, raw, spec.min, spec.max);
	} catch (_) {
		return false;
	}
}

/** The smallest interval above 0 that one choice of a timer can roll, as Archipelago reads it; 0 for off, null for a choice it cannot read. */
function choiceFloor(spec, choice) {
	if (typeof choice === 'boolean') return choice ? spec.default : 0;
	if (Number.isInteger(choice)) return choice;
	if (typeof choice !== 'string') return null;
	const number = pyIntOfText(choice);
	if (number !== null) return number;
	const text = choice.trim().toLowerCase();
	const span = /^random-range-(?:(?:low|middle|high)-)?(\d+)-(\d+)$/.exec(text);
	if (span) {
		const [low, high] = [Number(span[1]), Number(span[2])].sort((a, b) => a - b);
		return high < 1 ? 0 : Math.max(1, low);
	}
	if (/^random(?:-(?:low|middle|high))?$/.test(text)) return Math.max(1, spec.min);
	if (text === 'default' || text === 'true') return spec.default;
	if (text === 'high') return spec.max;
	if (text === 'low' || text === 'off' || text === 'false') return spec.min;
	return null;
}

/**
 * The smallest interval above 0 a timer kept random can roll: a weighted mapping's choices with a
 * weight, or a list's items. Null when it only rolls off. A choice outside the option's range is
 * Archipelago's to refuse whatever the list, so it is left out.
 */
function lowestRoll(spec, value) {
	const choices = value instanceof Map
		? [...value].filter(([, weight]) => pyIntWeight(weight) > 0).map(([choice]) => choice)
		: (Array.isArray(value) ? value : [value]);
	let low = null;
	for (const choice of choices) {
		const n = choiceFloor(spec, choice);
		if (n !== null && n > 0 && n <= spec.max && (low === null || n < low)) low = n;
	}
	return low;
}

/**
 * A timer kept random is planned at its default, and Archipelago may roll it as low as 1 minute; a
 * trigger may set one lower too. A long list that fits at the file's values can then make more
 * locations than one slot holds, and that stops the whole multiworld from generating. Says so, with
 * the lowest interval that fits, or null when every value fits. Plans run between event loop turns,
 * so voice playback keeps its pace.
 */
async function randomTimerProblem(entries, p) {
	const max = contracts.LIMITS.maxLocations;
	const lows = [];
	const add = (key, value, trigger) => {
		if (!/^timesanity_/.test(key) || !has(contracts.OPTIONS, key)) return;
		const low = lowestRoll(contracts.OPTIONS[key], value);
		if (low === null) return;
		const same = lows.find((x) => x.key === key && x.trigger === trigger);
		if (!same) lows.push({ key, low, trigger });
		else same.low = Math.min(same.low, low);
	};
	for (const [key, value] of p.passthrough) add(key, value, false);
	for (const [key, value] of triggerTimers(p.passthrough)) add(key, value, true);
	const planned = plannedOptions(p.options, p.passthrough);
	const locations = async (over) => {
		await new Promise((resolve) => setImmediate(resolve));
		return planSlot(entries, { ...planned, ...over }).locations;
	};
	for (const { key, low, trigger } of lows) {
		const at = await locations({ [key]: low });
		if (at <= max) continue;
		const top = contracts.OPTIONS[key].max;
		const said = trigger
			? `A trigger in your file sets ${settingName(key)}, and at ${low} the list makes ${at} locations (at most ${max})`
			: `${settingName(key)} is random in your file, and a roll of ${low} would make ${at} locations (at most ${max})`;
		if (await locations({ [key]: top }) > max) return `${said}: ${trigger ? 'have the trigger turn it off' : 'set a number'}.`;
		// Locations only fall as the interval grows, so halving finds the lowest that fits.
		let lo = low + 1;
		let hi = top;
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (await locations({ [key]: mid }) <= max) hi = mid;
			else lo = mid + 1;
		}
		return trigger ? `${said}: have the trigger set it to ${lo} or more.` : `${said}: set a number, or use random-range-${lo}-${top}.`;
	}
	const lowest = new Map();
	for (const { key, low } of lows) lowest.set(key, lowest.has(key) ? Math.min(lowest.get(key), low) : low);
	if (lowest.size < 2) return null;
	const at = await locations(Object.fromEntries(lowest));
	if (at <= max) return null;
	const names = andList([...lowest.keys()].map(settingName));
	if (lows.some((x) => x.trigger)) {
		return `${names} are random in your file or set by a trigger in it, and if they all take their lowest the list makes ${at} `
			+ `locations (at most ${max}): raise one of them.`;
	}
	return `${names} are random in your file, and if they all roll their lowest the list makes ${at} locations (at most ${max}): set a number for one of them.`;
}

/** The highest value one choice of a game option can roll, as Archipelago reads it, or null for none it reads. */
function choiceCeiling(key, spec, choice) {
	if (typeof choice === 'string' && RANGE_RANDOM.test(choice)) {
		const span = /-range-(?:[a-z]+-)?(\d+)-(\d+)$/i.exec(choice);
		return span ? Math.min(spec.max, Math.max(Number(span[1]), Number(span[2]))) : spec.max;
	}
	try {
		const n = plainValue(key, spec, choice);
		return typeof n === 'number' ? n : null;
	} catch (_) {
		return null;
	}
}

/** The highest value a game option kept random can roll: a weighted mapping's choices with a weight, or a list's items. */
function highestRoll(key, value) {
	const spec = contracts.OPTIONS[key];
	const choices = value instanceof Map
		? [...value].filter(([, weight]) => pyIntWeight(weight) > 0).map(([choice]) => choice)
		: (Array.isArray(value) ? value : [value]);
	let high = null;
	for (const choice of choices) {
		const n = choiceCeiling(key, spec, choice);
		if (n !== null && (high === null || n > high)) high = n;
	}
	return high;
}

/** The values the file's triggers set for one game option; a key with - only takes choices away. */
function triggerValues(passthrough, key) {
	const pair = passthrough.find(([k]) => k === 'triggers');
	const out = [];
	if (!pair || !Array.isArray(pair[1])) return out;
	for (const trigger of pair[1]) {
		for (const [setting, value, prefix] of triggerSettings(trigger)) {
			if (setting === key && prefix[0] !== '-') out.push(value);
		}
	}
	return out;
}

/**
 * The options a list is planned with: the file's, except that while every Trap Weight in it is 0, a
 * weight a trigger may set above 0 is planned at the highest it can set. A fixed Trap Percentage is
 * then judged by randomTrapProblem, as a random one is, instead of by the plan's own error.
 * @param {Array<[string, *]>} [passthrough] the settings copied as they are, triggers among them
 */
function plannedOptions(options, passthrough) {
	if (!Array.isArray(passthrough)) return options;
	const o = resolveOptions(options);
	const keys = Object.keys(contracts.TRAPS).map((trap) => `${trap}_weight`);
	if (keys.some((key) => o[key] > 0)) return options;
	const set = {};
	for (const key of keys) {
		const high = Math.max(0, ...triggerValues(passthrough, key).map((value) => highestRoll(key, value)).filter((n) => typeof n === 'number'));
		if (high > 0) set[key] = high;
	}
	return Object.keys(set).length ? { ...options, ...set } : options;
}

/**
 * The plan takes a Trap Percentage kept random at its default, and a trigger's value not at all.
 * With no Trap Weight able to roll above 0, a roll or a trigger that makes a trap due leaves the
 * world no trap to pick, and its OptionError stops the whole multiworld from generating. Says so,
 * or null when nothing can make a trap due. A Trap Weight a trigger may set above 0 counts as one
 * that can roll above 0.
 * @param {{F: number}} plan the list's plan at the file's values: F filler slots
 */
function randomTrapProblem(plan, p) {
	const kept = new Map(p.passthrough.filter(([key]) => has(contracts.OPTIONS, key)));
	const highestOf = (key) => {
		const rolls = triggerValues(p.passthrough, key).map((value) => highestRoll(key, value));
		rolls.push(kept.has(key) ? highestRoll(key, kept.get(key)) : p.options[key]);
		return Math.max(0, ...rolls.filter((n) => typeof n === 'number'));
	};
	if (Object.keys(contracts.TRAPS).some((trap) => highestOf(`${trap}_weight`) > 0)) return null;
	const due = (percent) => typeof percent === 'number' && Math.floor((plan.F * percent) / 100) >= 1;
	const name = settingName('trap_percentage');
	const fix = 'Set a Trap Weight above 0, or Trap Percentage to 0.';
	const need = plan.F > 0 ? Math.ceil(100 / plan.F) : null;
	if (kept.has('trap_percentage') && due(highestRoll('trap_percentage', kept.get('trap_percentage')))) {
		return `${name} is random in your file while every Trap Weight is 0: a roll of ${need} or more makes a trap due among the list's `
			+ `${plan.F} filler items with no trap to pick, and that stops the whole multiworld from generating. ${fix}`;
	}
	const set = triggerValues(p.passthrough, 'trap_percentage').map((value) => highestRoll('trap_percentage', value)).filter(due);
	if (!set.length) return null;
	return `A trigger in your file sets ${name} while every Trap Weight is 0: at ${Math.max(...set)} a trap is due among the list's `
		+ `${plan.F} filler items with no trap to pick, and that stops the whole multiworld from generating. ${fix}`;
}

class EntryList {
	constructor() {
		this.map = new Map();
		this.shows = new Set();
		this.albums = new Set();
	}

	key(entry) {
		return contracts.entryKey(entry);
	}

	has(entry) {
		return this.map.has(this.key(entry));
	}

	add(entry) {
		const key = this.key(entry);
		if (this.map.has(key)) return false;
		this.map.set(key, entry);
		if (entry.k === 'episode') this.shows.add(entry.sid);
		if (entry.k === 'album') this.albums.add(entry.id);
		return true;
	}

	get size() {
		return this.map.size;
	}

	values() {
		return [...this.map.values()];
	}
}

function interleave(groupsByKind) {
	const out = [];
	const lists = groupsByKind.map((g) => [...g]);
	while (lists.some((l) => l.length)) {
		for (const l of lists) if (l.length) out.push(l.shift());
	}
	return out;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.pms] helpers/apMediaPlex.js createPms()
 * @param {object} [deps.catalogStore] helpers/bookCatalogStore.js shape: works(), work(id), findWorks?(text)
 * @param {object} [deps.longForm] helpers/longForm.js shape: withExclusion, partition, isLongFormAlbum?, enabled?
 * @param {object} [deps.bookmarks] helpers/bookmarks.js shape: forUser(discordUserId)
 * @param {() => number} [deps.now] ms
 * @param {() => number} [deps.random] [0, 1)
 */
function createBuilder(deps = {}) {
	const pms = deps.pms || require('./apMediaPlex.js').createPms();
	const catalogStore = deps.catalogStore || require('./bookCatalogStore.js');
	const longForm = deps.longForm || require('./longForm.js');
	const bookmarks = deps.bookmarks || require('./bookmarks.js');
	const now = deps.now || Date.now;
	const random = deps.random || Math.random;
	let playlistCache = { at: -Infinity, list: null, pending: null };

	// The title becomes a mix's t, and entries.py refuses an empty t, which stops the whole seed.
	function normPlaylist(row) {
		const smart = row.smart === true || row.smart === 1 || row.smart === '1';
		const rk = Number(row.ratingKey);
		return { rk, title: clean(row.title) || `Playlist ${rk}`, type: String(row.playlistType || ''), smart, items: Number(row.leafCount) || 0 };
	}

	function loadPlaylists(force) {
		if (!force && playlistCache.list && now() - playlistCache.at < PLAYLIST_TTL_MS) return Promise.resolve(playlistCache.list);
		if (!playlistCache.pending) {
			playlistCache.pending = Promise.resolve()
				.then(() => pms.playlists())
				.then((rows) => {
					const list = rows.map(normPlaylist).filter((pl) => Number.isInteger(pl.rk) && (pl.type === 'video' || pl.type === 'audio'));
					playlistCache = { at: now(), list, pending: null };
					return list;
				}, (err) => {
					playlistCache.pending = null;
					throw err;
				});
		}
		return playlistCache.pending;
	}

	function filterPlaylists(list, prefix) {
		const q = norm(prefix);
		if (!q) return list.slice(0, 25);
		const starts = list.filter((pl) => norm(pl.title).startsWith(q));
		const inside = list.filter((pl) => !starts.includes(pl) && norm(pl.title).includes(q));
		return [...starts, ...inside].slice(0, 25);
	}

	/** Audio and video playlists whose title starts with (then contains) the prefix, at most 25. */
	async function playlists(prefix = '') {
		return filterPlaylists(await loadPlaylists(false), prefix);
	}

	/** The same from memory only, for autocomplete; a stale list is refreshed in the background. */
	function cachedPlaylists(prefix = '') {
		if (!playlistCache.list || now() - playlistCache.at >= PLAYLIST_TTL_MS) loadPlaylists(false).catch(() => {});
		return filterPlaylists(playlistCache.list || [], prefix);
	}

	function library(p, warnings) {
		const memo = new Map();
		const once = (key, fn) => {
			if (!memo.has(key)) memo.set(key, fn());
			return memo.get(key);
		};

		const sectionsOf = async (type) => (await once('sections', () => pms.sections())).filter((s) => s.type === type);

		// A movie or show section's own genre list is the one the `genre=<key>` filter was verified with.
		async function genreKey(section) {
			const list = await once(`genres:${section.key}`, () => pms.genres(section.key));
			const want = norm(p.genre);
			const hit = list.find((g) => norm(g.title) === want);
			return hit ? hit.key : null;
		}

		async function listing(type, plexType, withGenre) {
			const out = [];
			for (const section of await sectionsOf(type)) {
				const params = { type: plexType };
				if (withGenre) {
					const key = await genreKey(section);
					if (key === null) {
						warnings.push(`${section.title || 'A section'} has no ${p.genre} genre.`);
						continue;
					}
					params.genre = key;
				}
				for (const row of await pms.pages(`/library/sections/${section.key}/all`, params)) out.push(row);
			}
			return out;
		}

		const movieRows = () => once('movies', () => listing('movie', PLEX_TYPE.movie, false));
		const movieCandidates = () => once('movies:genre', () => (p.genre ? listing('movie', PLEX_TYPE.movie, true) : movieRows()));
		const showRows = () => once('shows', () => listing('show', PLEX_TYPE.show, false));
		const showCandidates = () => once('shows:genre', () => (p.genre ? listing('show', PLEX_TYPE.show, true) : showRows()));

		const albumRows = () => once('albums', async () => {
			const out = [];
			const exclude = typeof longForm.withExclusion === 'function' ? longForm.withExclusion : (u) => u;
			for (const section of await sectionsOf('artist')) {
				const rows = await pms.pages(exclude(`/library/sections/${section.key}/all?type=${PLEX_TYPE.album}`));
				for (const row of rows) {
					if (typeof longForm.isLongFormAlbum === 'function' && longForm.isLongFormAlbum(row)) continue;
					out.push(row);
				}
			}
			return out;
		});

		const albumsByGuid = () => once('albums:guid', async () => {
			const map = new Map();
			for (const row of await albumRows()) {
				const guid = matchedAlbumGuid(row.guid);
				if (!guid) continue;
				if (!map.has(guid)) map.set(guid, []);
				map.get(guid).push(row);
			}
			return map;
		});

		const showInfo = (row) => {
			const rk = Number(row.ratingKey);
			return { rk, title: clean(row.title) || `Show ${rk}`, sid: plexGuid(row.guid) || `rk:${rk}` };
		};

		const showByRk = () => once('shows:rk', async () => new Map((await showRows()).map((row) => [Number(row.ratingKey), showInfo(row)])));

		async function showFor(item) {
			const srk = Number(item.grandparentRatingKey);
			const known = (await showByRk()).get(srk);
			if (known) return known;
			return { rk: srk, title: clean(item.grandparentTitle) || `Show ${srk}`, sid: plexGuid(item.grandparentGuid) || `rk:${srk}` };
		}

		function episodeOf(row) {
			const sn = Number(row.parentIndex);
			const en = Number(row.index);
			const rk = Number(row.ratingKey);
			if (!Number.isInteger(rk) || rk <= 0 || !Number.isInteger(sn) || sn < 0 || !Number.isInteger(en) || en < 0) return null;
			return { rk, guid: String(row.guid || ''), title: clean(row.title) || `Episode ${en}`, sn, en, d: ms(row.duration) };
		}

		const episodesOf = (showRk) => once(`leaves:${showRk}`, async () => {
			const eps = (await pms.leaves(showRk)).filter((r) => !r.type || r.type === 'episode').map(episodeOf).filter(Boolean);
			return eps.sort((a, b) => a.sn - b.sn || a.en - b.en);
		});

		async function historyKeys(type) {
			const keys = new Set();
			for (const section of await sectionsOf(type)) {
				const rows = await pms.pages('/status/sessions/history/all', { sort: 'viewedAt:asc', accountID: p.accountId, librarySectionID: section.key });
				for (const row of rows) {
					const rk = Number(row.ratingKey);
					if (Number.isInteger(rk) && rk > 0) keys.add(rk);
				}
			}
			return keys;
		}

		/** What the account has watched, by ratingKey; throws when no account was resolved. */
		const watched = () => {
			if (p.accountId === null) return Promise.reject(new Error(ACCOUNT_FIX));
			return once('watched', async () => new Set([...await historyKeys('movie'), ...await historyKeys('show')]));
		};

		/** As watched(), or null when the list is not filtered or there is no account to read. */
		const watchedIfKnown = () => (p.unwatched && p.accountId !== null ? watched() : Promise.resolve(null));

		function trackOf(row, position) {
			const rk = Number(row.ratingKey);
			if (!Number.isInteger(rk) || rk <= 0) return null;
			const index = Number(row.index);
			return {
				rk,
				index: Number.isInteger(index) && index >= 0 ? index : position,
				title: clean(row.title) || `Track ${position}`,
				d: ms(row.duration),
				partId: partIdOf(firstPart(row)),
				artist: clean(row.originalTitle) || clean(row.grandparentTitle) || 'Unknown artist',
				disc: Number(row.parentIndex) || 1,
			};
		}

		function splitBooks(rows) {
			if (typeof longForm.partition !== 'function') return { music: rows, books: [] };
			return longForm.partition(rows);
		}

		// null when any track is a catalogued audiobook part: that album is a book, not music.
		const tracksOf = (albumRk) => once(`tracks:${albumRk}`, async () => {
			const rows = (await pms.children(albumRk)).filter((r) => !r.type || r.type === 'track');
			const { music, books } = splitBooks(rows);
			if (books.length) return null;
			const tracks = music.map((row, i) => trackOf(row, i + 1)).filter(Boolean);
			return tracks.sort((a, b) => a.disc - b.disc || a.index - b.index);
		});

		function works() {
			try {
				return (catalogStore.works() || []).filter((w) => w && typeof w.id === 'string' && Array.isArray(w.parts) && w.parts.length);
			} catch (err) {
				warnings.push('The audiobook catalog could not be read, so no books were picked.');
				return [];
			}
		}

		function finishedWorks() {
			const out = new Set();
			if (!p.discordUserId || !bookmarks || typeof bookmarks.forUser !== 'function') return out;
			for (const mark of bookmarks.forUser(p.discordUserId) || []) {
				if (!mark || !mark.finished) continue;
				const work = typeof catalogStore.work === 'function' ? catalogStore.work(mark.workId) : null;
				out.add(work ? work.id : mark.workId);
			}
			return out;
		}

		return {
			movieRows, movieCandidates, showRows, showCandidates, albumRows, albumsByGuid, showInfo, showFor,
			episodesOf, episodeOf, watched, watchedIfKnown, tracksOf, trackOf, splitBooks, works, finishedWorks,
			sectionsOf, genreKey,
		};
	}

	function movieEntry(row) {
		const rk = Number(row.ratingKey);
		const guid = String(row.guid || '');
		const entry = { k: 'movie', id: plexGuid(guid) || `rk:${rk}`, rk };
		if (guid) entry.g = guid;
		entry.t = clean(row.title) || `Movie ${rk}`;
		entry.y = yearOf(row.year);
		entry.d = ms(row.duration);
		return entry;
	}

	function episodeEntry(ep, show) {
		const entry = { k: 'episode', id: plexGuid(ep.guid) || `rk:${ep.rk}`, rk: ep.rk };
		if (ep.guid) entry.g = ep.guid;
		Object.assign(entry, { sh: show.title, sid: show.sid, srk: show.rk, sn: ep.sn, en: ep.en, t: ep.title, d: ep.d });
		return entry;
	}

	function albumEntry(row, tracks, alt) {
		const rk = Number(row.ratingKey);
		const guid = String(row.guid || '');
		const entry = { k: 'album', id: matchedAlbumGuid(guid) || `rk:${rk}`, rk };
		if (guid) entry.g = guid;
		entry.ar = clean(row.parentTitle) || 'Unknown artist';
		entry.t = clean(row.title) || `Album ${rk}`;
		entry.y = yearOf(row.year);
		entry.d = tracks.reduce((n, t) => n + t.d, 0);
		entry.tr = tracks.map((t) => [t.rk, t.index, t.title, t.d, t.partId]);
		if (alt.length) entry.alt = alt;
		return entry;
	}

	function bookEntry(work) {
		const parts = [...work.parts].sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0));
		const pa = parts.map((part) => [
			Number(part.trackRatingKey) || 0,
			partIdOf({ key: part.partKey }),
			ms(part.durationMs),
		]);
		return {
			k: 'book',
			id: `book:${work.id}`,
			w: work.id,
			t: clean(work.title) || work.id,
			au: clean(work.author) || 'Unknown author',
			d: pa.reduce((n, x) => n + x[2], 0),
			pa,
		};
	}

	function displayOf(kind, item) {
		if (kind === 'movie') return `${clean(item.title)}${yearOf(item.year) ? ` (${yearOf(item.year)})` : ''}`;
		if (kind === 'album') return `${clean(item.parentTitle)} - ${clean(item.title)}`;
		if (kind === 'book') return `${clean(item.title)} by ${clean(item.author) || 'unknown'}`;
		return clean(item.title);
	}

	async function build(params) {
		const p = validateParams(params);
		const warnings = [];
		const misses = [];
		// Names that took the nearest title rather than one of that name: [what was asked, what was taken].
		const loose = [];
		const lib = library(p, warnings);
		const list = new EntryList();
		const norms = new Map();
		const normOf = (text) => {
			const key = String(text ?? '');
			if (!norms.has(key)) norms.set(key, norm(key));
			return norms.get(key);
		};
		const grams = new Map();
		const gramsOf = (normed) => {
			if (!grams.has(normed)) grams.set(normed, bigrams(normed));
			return grams.get(normed);
		};

		// Said before Plex is read whenever it is already certain; hand-picks or a playlist may still
		// fill the counts, and then lib.watched() says it only if random video picks are needed.
		const certain = !!p.collection || (!p.titles.length && !p.playlist && (p.counts.movies > 0 || p.counts.shows > 0));
		if (p.unwatched && p.accountId === null && certain) throw new Error(ACCOUNT_FIX);

		function runOf(eps, watchedSet, max) {
			const regular = eps.filter((e) => e.sn >= 1);
			if (!watchedSet) return regular.slice(0, max);
			const first = regular.findIndex((e) => !watchedSet.has(e.rk));
			if (first < 0) return [];
			return regular.slice(first).filter((e) => !watchedSet.has(e.rk)).slice(0, max);
		}

		async function candidatesFor(kind, parsed) {
			if (kind === 'movie') {
				const rows = await lib.movieRows();
				return rows.filter((r) => parsed.year === null || yearOf(r.year) === parsed.year).map((r) => ({ kind, item: r, names: [r.title] }));
			}
			if (kind === 'show') return (await lib.showRows()).map((r) => ({ kind, item: r, names: [r.title] }));
			if (kind === 'album') {
				const rows = (await lib.albumRows()).filter((r) => !isPlaceholderAlbum(r));
				return rows
					.filter((r) => parsed.year === null || yearOf(r.year) === parsed.year)
					.map((r) => ({ kind, item: r, names: [r.title, `${clean(r.parentTitle)} ${clean(r.title)}`] }));
			}
			return lib.works().map((w) => ({ kind, item: w, names: [w.title, `${clean(w.author)} ${clean(w.title)}`] }));
		}

		async function entriesForPick(hit, parsed) {
			if (hit.kind === 'movie') return [movieEntry(hit.item)];
			if (hit.kind === 'book') return [bookEntry(hit.item)];
			if (hit.kind === 'show') {
				const show = lib.showInfo(hit.item);
				const eps = await lib.episodesOf(show.rk);
				if (!parsed.seasons && p.unwatched && p.accountId === null) {
					warnings.push(`${show.title} starts at its first episode: the bot knows nothing you have watched.`);
				}
				if (parsed.seasons) return eps.filter((e) => e.sn >= parsed.seasons[0] && e.sn <= parsed.seasons[1]).map((e) => episodeEntry(e, show));
				const watched = await lib.watchedIfKnown();
				const chosen = runOf(eps, watched, p.maxEpisodes);
				const seasons = [...new Set(eps.filter((e) => e.sn >= 1).map((e) => e.sn))];
				if (!chosen.length && watched && seasons.length) {
					const span = seasons.length > 1 ? `S${Math.min(...seasons)}-${Math.max(...seasons)}` : `S${seasons[0]}`;
					warnings.push(`${show.title}: every episode has been watched, so it was left out. To keep it, name its seasons `
						+ `(show: ${show.title} ${span}) or turn unwatched off.`);
					return null;
				}
				return chosen.map((e) => episodeEntry(e, show));
			}
			const guid = matchedAlbumGuid(hit.item.guid);
			const copies = guid ? ((await lib.albumsByGuid()).get(guid) || [hit.item]) : [hit.item];
			const entry = await albumFrom(copies, false);
			return entry ? [entry] : [];
		}

		async function pickTitle(parsed) {
			// Once the listings are read, the picks run on promises alone, and scoring a miss against
			// every title takes a while: each pick lets voice and the timers have a turn first.
			await new Promise((resolve) => setImmediate(resolve));
			const kinds = parsed.kind ? [parsed.kind] : ['movie', 'show', 'album', 'book'];
			const q = normOf(parsed.text);
			const min = RANDOM_NAME.test(parsed.text.trim()) ? MATCH_CLOSE : MATCH_MIN;
			const pools = [];
			let best = null;
			for (const kind of kinds) {
				// A later kind can at best tie an exact match, and a tie keeps the earlier kind.
				if (best && best.score === 100) break;
				const pool = await candidatesFor(kind, parsed);
				pools.push(pool);
				for (const c of pool) {
					let score = 0;
					let length = Infinity;
					for (const name of c.names) {
						const s = normScore(q, normOf(name));
						const l = normOf(name).length;
						if (s > score || (s === score && l < length)) {
							score = s;
							length = l;
						}
					}
					if (score >= min && (!best || score > best.score || (score === best.score && length < best.length))) {
						best = { ...c, score, length };
					}
				}
			}
			if (!best && min === MATCH_MIN && parsed.kind !== 'movie' && parsed.kind !== 'show' && parsed.kind !== 'album' && typeof catalogStore.findWorks === 'function') {
				let found = [];
				try { found = catalogStore.findWorks(parsed.text) || []; } catch (_) { found = []; }
				const work = found.find((w) => w && Array.isArray(w.parts) && w.parts.length);
				if (work) best = { kind: 'book', item: work, score: MATCH_MIN };
			}
			if (!best) {
				const near = [];
				const Q = q ? bigrams(q) : null;
				for (const c of pools.flat()) {
					const sim = Q ? Math.max(...c.names.map((n) => {
						const name = normOf(n);
						return name ? overlap(Q, gramsOf(name)) : 0;
					})) : 0;
					if (sim >= SUGGEST_MIN) near.push({ sim, text: displayOf(c.kind, c.item) });
				}
				const didYouMean = [...new Set(near.sort((a, b) => b.sim - a.sim).map((x) => x.text))].slice(0, 3);
				misses.push({ query: parsed.query, didYouMean });
				return;
			}
			const entries = await entriesForPick(best, parsed);
			// A show watched to the end was found and left out; a warning says so.
			if (entries === null) return;
			if (!entries.length) {
				misses.push({ query: parsed.query, didYouMean: [] });
				warnings.push(`${displayOf(best.kind, best.item)} has nothing that fits${parsed.seasons ? ` in S${parsed.seasons[0]}-${parsed.seasons[1]}` : ''}.`);
				return;
			}
			if (best.score < MATCH_CLOSE) loose.push([parsed.text, displayOf(best.kind, best.item)]);
			for (const e of entries) list.add(e);
		}

		async function albumFrom(copies, strict) {
			const loaded = [];
			for (const copy of copies.slice(0, MAX_ALBUM_COPIES)) {
				const tracks = await lib.tracksOf(Number(copy.ratingKey));
				if (tracks && tracks.length) loaded.push({ copy, tracks });
			}
			if (!loaded.length) return null;
			loaded.sort((a, b) => b.tracks.length - a.tracks.length || Number(a.copy.ratingKey) - Number(b.copy.ratingKey));
			const best = loaded[0];
			const long = best.tracks.filter((t) => t.d >= contracts.LIMITS.minTrackMs).length;
			if (strict && (best.tracks.length > MAX_ALBUM_TRACKS || long < MIN_ALBUM_TRACKS || isPlaceholderAlbum(best.copy))) return null;
			// entries.py refuses an album with no track of 30 s or more: it would have nothing to check.
			if (!strict && (best.tracks.length > MAX_PICKED_ALBUM_TRACKS || long < 1)) return null;
			const alt = loaded.slice(1)
				.filter((x) => x.tracks.length === best.tracks.length)
				.map((x) => [Number(x.copy.ratingKey), x.tracks.map((t) => [t.rk, t.partId])]);
			return albumEntry(best.copy, best.tracks, alt);
		}

		/** The row named, by its ratingKey or its title; else the nearest title, which `what` then names in the reply. */
		function findByName(rows, wanted, titleOf, rkOf, what) {
			const raw = String(wanted).trim();
			if (/^\d+$/.test(raw)) {
				const hit = rows.find((r) => rkOf(r) === Number(raw));
				if (hit) return hit;
			}
			const want = norm(raw);
			const exact = rows.find((r) => norm(titleOf(r)) === want);
			if (exact) return exact;
			const min = RANDOM_NAME.test(raw) ? MATCH_CLOSE : MATCH_MIN;
			let best = null;
			for (const r of rows) {
				const score = matchScore(raw, titleOf(r));
				if (score >= min && (!best || score > best.score)) best = { r, score };
			}
			if (best && best.score < MATCH_CLOSE) loose.push([raw, `${what} ${clean(titleOf(best.r))}`]);
			return best ? best.r : null;
		}

		async function addVideoItems(items, source, total = 0) {
			const seenShows = new Set();
			let movies = 0;
			let shows = 0;
			let showless = 0;
			let capped = false;
			for (const item of items) {
				if (item.type === 'movie') {
					if (movies >= MAX_SOURCE_MOVIES) { capped = true; continue; }
					if (p.unwatched && (await lib.watched()).has(Number(item.ratingKey))) continue;
					if (list.add(movieEntry(item))) movies += 1;
				} else if (item.type === 'episode') {
					if (p.unwatched && (await lib.watched()).has(Number(item.ratingKey))) continue;
					const ep = lib.episodeOf(item);
					if (!ep) continue;
					const show = await lib.showFor(item);
					// entries.py refuses an episode without its show's ratingKey (srk), and that stops the whole seed.
					if (!Number.isSafeInteger(show.rk) || show.rk <= 0) {
						showless += 1;
						continue;
					}
					list.add(episodeEntry(ep, show));
				} else if (item.type === 'show') {
					const show = lib.showInfo(item);
					if (seenShows.has(show.sid)) continue;
					if (shows >= MAX_SOURCE_SHOWS) { capped = true; continue; }
					seenShows.add(show.sid);
					const run = runOf(await lib.episodesOf(show.rk), p.unwatched ? await lib.watched() : null, p.maxEpisodes);
					if (run.length) shows += 1;
					for (const e of run) list.add(episodeEntry(e, show));
				}
			}
			if (showless) {
				warnings.push(`${source}: ${plural(showless, ['episode was', 'episodes were'])} left out because Plex did not say which show ${showless === 1 ? 'it is' : 'they are'} from.`);
			}
			if (capped) warnings.push(`${source} is long: only its first ${MAX_SOURCE_MOVIES} movies and ${MAX_SOURCE_SHOWS} shows were used.`);
			if (wasCut(items, VIDEO_READ_MAX, total)) warnings.push(`${source} has ${Math.max(total, items.length)} items; only the first ${items.length} were read.`);
		}

		async function addPlaylist() {
			const all = await loadPlaylists(true);
			const pl = findByName(all, p.playlist, (x) => x.title, (x) => x.rk, 'the playlist');
			if (!pl) {
				// A refusal goes out as written, so the library's names are code spans too.
				const names = all.slice(0, 10).map((x) => codeSpan(x.title)).join(', ');
				throw new Error(`No playlist called ${codeSpan(p.playlist)}.${names ? ` Playlists: ${names}.` : ''}`);
			}
			if (pl.type === 'video') {
				if (p.unwatched && p.accountId === null) throw new Error(ACCOUNT_FIX);
				await addVideoItems(await pms.playlistItems(pl.rk, { limit: VIDEO_READ_MAX }), `The playlist ${pl.title}`, pl.items);
				return;
			}
			const read = await pms.playlistItems(pl.rk, { limit: MIX_READ_MAX });
			const cut = wasCut(read, MIX_READ_MAX, pl.items);
			const rows = read.filter((r) => !r.type || r.type === 'track');
			const { music, books } = lib.splitBooks(rows);
			if (books.length) warnings.push(`${plural(books.length, ['audiobook part', 'audiobook parts'])} in ${pl.title} were left out.`);
			let tracks = music.map((row, i) => lib.trackOf(row, i + 1)).filter(Boolean).map((t, i) => ({ ...t, index: i + 1 }));
			const max = MAX_MIX_PARTS * contracts.LIMITS.mixTracks;
			if (tracks.length > max || cut) {
				const total = cut ? Math.max(pl.items, read.length) : tracks.length;
				tracks = tracks.slice(0, max);
				warnings.push(`${pl.title} has ${total} tracks; only the first ${tracks.length} were used.`);
			}
			const size = contracts.LIMITS.mixTracks;
			const chunks = [];
			for (let i = 0; i < tracks.length; i += size) chunks.push(tracks.slice(i, i + size));
			// entries.py refuses a part with no track of 30 s or more, and that stops the whole seed.
			const usable = chunks.filter((chunk) => chunk.some((t) => t.d >= contracts.LIMITS.minTrackMs));
			if (usable.length < chunks.length) {
				const left = chunks.filter((chunk) => !usable.includes(chunk)).reduce((n, chunk) => n + chunk.length, 0);
				warnings.push(`${plural(left, ['short track', 'short tracks'])} of ${pl.title} were left out: a part needs one track of 30 s or more.`);
			}
			if (!usable.length) {
				warnings.push(`${pl.title} has no music tracks to check.`);
				return;
			}
			const parts = usable.length;
			for (let part = 1; part <= parts; part++) {
				const chunk = usable[part - 1];
				list.add({
					k: 'mix',
					id: `pl:${pl.rk}:${part}`,
					pl: pl.rk,
					part,
					t: parts > 1 ? `${pl.title} Part ${part}` : pl.title,
					d: chunk.reduce((n, t) => n + t.d, 0),
					tr: chunk.map((t) => [t.rk, t.index, t.title, t.d, t.partId, t.artist]),
				});
			}
		}

		async function addCollection() {
			const found = [];
			for (const type of ['movie', 'show']) {
				for (const section of await lib.sectionsOf(type)) {
					for (const c of await pms.collections(section.key)) found.push(c);
				}
			}
			const hit = findByName(found, p.collection, (c) => c.title, (c) => Number(c.ratingKey), 'the collection');
			if (!hit) {
				const names = found.slice(0, 10).map((c) => codeSpan(c.title)).join(', ');
				throw new Error(`No movie or TV collection called ${codeSpan(p.collection)}.${names ? ` Some collections: ${names}.` : ''}`);
			}
			const items = await pms.collectionItems(Number(hit.ratingKey), { limit: VIDEO_READ_MAX });
			await addVideoItems(items, `The collection ${clean(hit.title)}`, Number(hit.childCount) || 0);
		}

		function short(word, total, have, picked) {
			if (have + picked < total) warnings.push(`Only ${have + picked} of ${total} ${word} fit the filters.`);
		}

		async function pickMovies(total, have) {
			const n = total - have;
			if (n <= 0) return [];
			const watchedSet = p.unwatched ? await lib.watched() : null;
			const pool = (await lib.movieCandidates()).filter((r) => inYears(p.years, r.year)
				&& ms(r.duration) > 0
				&& !(watchedSet && watchedSet.has(Number(r.ratingKey))));
			const groups = [];
			const taken = new Set();
			for (const row of shuffle(pool, random)) {
				if (groups.length >= n) break;
				const entry = movieEntry(row);
				const key = contracts.entryKey(entry);
				if (list.has(entry) || taken.has(key)) continue;
				taken.add(key);
				groups.push([entry]);
			}
			short('movies', total, have, groups.length);
			return groups;
		}

		async function pickShows(total, have) {
			const n = total - have;
			if (n <= 0) return [];
			const watchedSet = p.unwatched ? await lib.watched() : null;
			const pool = (await lib.showCandidates()).filter((r) => inYears(p.years, r.year));
			const groups = [];
			const taken = new Set();
			let tries = 0;
			for (const row of shuffle(pool, random)) {
				if (groups.length >= n || tries >= n * 4 + 10) break;
				const show = lib.showInfo(row);
				if (list.shows.has(show.sid) || taken.has(show.sid)) continue;
				tries += 1;
				const run = runOf(await lib.episodesOf(show.rk), watchedSet, p.maxEpisodes);
				const entries = run.map((e) => episodeEntry(e, show)).filter((e) => !list.has(e));
				if (!entries.length) continue;
				taken.add(show.sid);
				groups.push(entries);
			}
			short('shows', total, have, groups.length);
			return groups;
		}

		async function pickAlbums(total, have) {
			const n = total - have;
			if (n <= 0) return [];
			if (typeof longForm.enabled === 'function' && !longForm.enabled()) {
				warnings.push('The audiobook catalog is empty or off, so audiobooks are not kept out of the album picks.');
			}
			const byGuid = await lib.albumsByGuid();
			const pool = (await lib.albumRows()).filter((r) => matchedAlbumGuid(r.guid)
				&& !isPlaceholderAlbum(r)
				&& inYears(p.years, r.year)
				&& (!p.genre || hasGenreTag(r, p.genre)));
			const guids = [...new Set(pool.map((r) => matchedAlbumGuid(r.guid)))];
			const groups = [];
			let tries = 0;
			for (const guid of shuffle(guids, random)) {
				if (groups.length >= n || tries >= n * 4 + 20) break;
				if (list.albums.has(guid)) continue;
				tries += 1;
				const entry = await albumFrom(byGuid.get(guid) || [], true);
				if (entry && !list.has(entry)) groups.push([entry]);
			}
			short('albums', total, have, groups.length);
			return groups;
		}

		function pickBooks(total, have) {
			const n = total - have;
			if (n <= 0) return [];
			if (p.years) warnings.push('The years filter does not apply to books.');
			const finished = p.unwatched ? lib.finishedWorks() : new Set();
			const pool = lib.works().filter((w) => (w.kind || 'book') === 'book'
				&& !finished.has(w.id)
				&& (!p.genre || (Array.isArray(w.genres) && w.genres.some((g) => norm(g) === norm(p.genre)))));
			const groups = [];
			for (const work of shuffle(pool, random)) {
				if (groups.length >= n) break;
				const entry = bookEntry(work);
				if (entry.d <= 0 || list.has(entry)) continue;
				groups.push([entry]);
			}
			short('books', total, have, groups.length);
			return groups;
		}

		for (const parsed of p.titles) await pickTitle(parsed);
		if (p.playlist) await addPlaylist();
		if (p.collection) await addCollection();
		// The counts are totals: hand-picked and playlist titles count toward them.
		const listed = (k) => list.values().filter((e) => e.k === k).length;
		const random4 = [
			await pickMovies(p.counts.movies, listed('movie')),
			await pickShows(p.counts.shows, list.shows.size),
			await pickAlbums(p.counts.albums, listed('album')),
			pickBooks(p.counts.books, listed('book')),
		];
		for (const group of interleave(random4)) for (const entry of group) list.add(entry);
		if (loose.length) {
			// Named up to a count and a length, so the line leaves room in the reply for what was not found.
			const named = [];
			for (const [asked, taken] of loose.slice(0, LOOSE_SHOWN)) {
				const pair = `"${asked}" as ${taken}`;
				if (named.length && named.join('; ').length + pair.length > LOOSE_CHARS) break;
				named.push(pair);
			}
			const rest = loose.length - named.length;
			warnings.push(`Nearest matches taken: ${named.join('; ')}${rest ? `; and ${rest} more` : ''}.`);
		}

		if (!list.size) {
			// The warnings say which filter left nothing, such as a genre no section has; the reply shows them.
			const shown = misses.slice(0, MISSES_SHOWN).map((m) => codeSpan(m.query)).join(', ');
			const rest = misses.length > MISSES_SHOWN ? ` and ${misses.length - MISSES_SHOWN} more` : '';
			const err = new Error(misses.length
				? `Nothing on the list: no title matched what was asked for. Not found: ${shown}${rest}.`
				: 'Nothing on the list: nothing in the library fits these settings.');
			err.warnings = [...new Set(warnings)];
			throw err;
		}

		const entries = list.values();
		const createdAt = Math.floor(now() / 1000);
		const plan = planSlot(entries, plannedOptions(p.options, p.passthrough));
		const L = contracts.LIMITS;
		if (plan.entryCount > L.maxEntries || plan.C > L.maxCopies || plan.locations > L.maxLocations) {
			throw new Error(`That list is too big for one slot: ${plan.entryCount} entries (at most ${L.maxEntries}), `
				+ `${plan.C} unlock copies (at most ${L.maxCopies}), ${plan.locations} locations (at most ${L.maxLocations}). `
				+ 'Lower the counts or the episodes per show, raise the episodes per unlock, or turn the timers down.');
		}
		const risky = await randomTimerProblem(entries, p);
		if (risky) throw new Error(risky);
		const trapRisk = randomTrapProblem(plan, p);
		if (trapRisk) throw new Error(trapRisk);
		if (plan.C > L.warnCopies) warnings.push(`${plan.C} unlock copies: above ${L.warnCopies}, generating the seed gets slow.`);
		if (plan.locations > L.warnLocations) warnings.push(`${plan.locations} locations: above ${L.warnLocations}, that is a very long list.`);
		if (plan.hoursToGoal > L.warnHoursToGoal) warnings.push(`About ${Math.round(plan.hoursToGoal)} h to the goal (more than ${L.warnHoursToGoal} h).`);
		if (plan.C - plan.S < 2) warnings.push('Almost everything starts open: fewer than 2 unlocks are left for the multiworld to find.');
		if (p.options.tv_unlock === 'season') {
			const single = plan.units.filter((u) => u.key.startsWith('show-season|') && u.steps === 1).length;
			if (single) warnings.push(`Season mode: ${plural(single, ['show is', 'shows are'])} one season on this list, so one unlock opens all of it.`);
		}

		const yaml = renderYaml(listDoc(p, { createdAt, entries }));
		const summary = {
			counts: plan.counts,
			shows: plan.shows,
			entries: plan.entryCount,
			locations: plan.locations,
			copies: plan.C,
			startCopies: plan.S,
			wildTickets: plan.W,
			fastForwards: plan.FF,
			remoteControls: plan.RC,
			traps: plan.traps,
			snacks: Object.values(plan.snacks).reduce((total, n) => total + n, 0),
			startOpen: plan.startOpen,
			goalCount: plan.goal_count,
			hours: plan.hours,
			hoursToGoal: plan.hoursToGoal,
			warnings: [...new Set(warnings)],
			misses,
		};
		return { yaml, fileName: safeFileName(p.name), summary };
	}

	return { build, playlists, cachedPlaylists, renderYaml };
}

module.exports = {
	createBuilder,
	renderYaml,
	readPlayerYaml,
	summaryLines,
	validateParams,
	listDoc,
	ACCOUNT_FIX,
	PICK_NOTHING,
	FILE_MAX_BYTES,
	_internal: {
		parseTitle, matchScore, similarity, norm, isPlaceholderAlbum, orderedEntry, safeFileName, flowValue, yamlKey, codeSpan, LIST_PARAMS,
		parsePlayerFile, lowestRoll, highestRoll, randomTrapProblem, COPY_MAX_BYTES, SETTINGS_MAX, PyFloat, LOOSE_CHARS, MISSES_SHOWN, sizeText,
	},
};
