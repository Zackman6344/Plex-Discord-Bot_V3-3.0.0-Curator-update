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

const crypto = require('crypto');
const contracts = require('./apMediaContracts.js');
const { planSlot, resolveOptions } = require('./apMediaPlan.js');

const PARAMS = new Set([
	'name', 'label', 'preset', 'movies', 'shows', 'albums', 'books', 'maxEpisodes', 'unwatched',
	'genre', 'years', 'collection', 'playlist', 'titles', 'timeMovies', 'timeEpisodes', 'timeAlbums',
	'timeBooks', 'goalPercent', 'episodesPerUnlock', 'tvUnlock', 'startingUnlocks', 'wildTickets',
	'strict', 'lockedWatches', 'checkpointItems', 'accountId', 'discordUserId',
]);
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
});
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

function yearsParam(raw) {
	const m = /^\s*(\d{4})\s*(?:-\s*(\d{4}))?\s*$/.exec(String(raw));
	if (!m) throw new Error('years must look like 1990 or 1990-1999.');
	const from = Number(m[1]);
	const to = m[2] === undefined ? from : Number(m[2]);
	if (from < 1800 || to > 2200 || from > to) throw new Error('years must be a range like 1990-1999, earliest first.');
	return { from, to };
}

const TITLE_PREFIX = /^(movie|show|album|book)\s*:\s*/i;
const SEASON_RANGE = /\s+s(\d{1,3})(?:\s*-\s*s?(\d{1,3}))?\s*$/i;
const TITLE_YEAR = /\s*\((\d{4})\)\s*$/;

function parseTitle(raw) {
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
	if (!text) throw new Error(`titles: "${query}" names no title.`);
	if ([...text].length > MAX_TEXT) throw new Error(`titles: "${query.slice(0, 40)}..." is too long.`);
	return { query, text, kind, seasons, year };
}

function titlesParam(raw) {
	const list = String(raw).split(';').map((s) => s.trim()).filter(Boolean);
	if (list.length > MAX_TITLES) throw new Error(`titles can name at most ${MAX_TITLES} titles.`);
	return list.map(parseTitle);
}

// A snowflake is past 2^53, so a number is accepted only while it is still exact.
function discordParam(raw) {
	const text = String(raw).trim();
	const ok = typeof raw === 'number' ? Number.isSafeInteger(raw) && raw > 0 : /^\d{1,25}$/.test(text);
	if (!ok) throw new Error('discordUserId must be a Discord user id.');
	return text;
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
	if (given(params.preset)) {
		base = contracts.PRESETS[choiceParam('preset', params.preset, Object.keys(contracts.PRESETS))];
	} else if (!Object.keys(explicit).length && !p.titles.length && !p.playlist && !p.collection) {
		base = contracts.PRESETS[contracts.DEFAULT_PRESET];
	}
	p.counts = {};
	for (const key of COUNT_KEYS) p.counts[key] = explicit[key] !== undefined ? explicit[key] : (base[key] || 0);

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
		account: Number.isInteger(account) && account > 0 ? account : null,
		discord: discord === undefined || discord === null ? null : (clean(discord) || null),
	};
}

/**
 * The player YAML for one slot, in the spec 5.11 layout: two-space indents, every scalar that comes
 * from data JSON-quoted, one JSON object per entry line.
 * @param {object} doc
 * @param {string} doc.name the slot name
 * @param {object[]} doc.entries contracts Entry objects, in list order
 * @param {string} [doc.label] defaults to "<name>'s list"
 * @param {object} [doc.options] YAML option keys; missing ones take their defaults
 * @param {number} [doc.createdAt] unix seconds; defaults to listInfo.created_at, else now
 * @param {object} [doc.listInfo] {builder, created_at, label, account, discord}
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
	const entries = (Array.isArray(doc.entries) ? doc.entries : []).map(orderedEntry);
	const plan = planSlot(entries, options);
	const date = new Date(createdAt * 1000).toISOString().slice(0, 10);
	const n = plan.entryCount;
	const lines = [
		`# ${label}: Plex Media list built ${date} for ${name}`,
		`# ${plural(n, ['entry', 'entries'])}${n ? ` (${kindPhrase(plan.counts)})` : ''}, ${plural(plan.locations, ['location', 'locations'])}, `
			+ `about ${hoursText(plan.hours)} h; starts with ${plan.startOpen} open; goal: finish ${plan.goal_count} of ${n}`,
		`name: ${JSON.stringify(name)}`,
		`description: ${JSON.stringify(label)}`,
		`game: ${contracts.GAME}`,
		'requires:',
		`  version: ${contracts.MIN_AP_VERSION}`,
		'  game:',
		`    ${contracts.GAME}: ${contracts.WORLD_VERSION}`,
		`${contracts.GAME}:`,
	];
	for (const key of Object.keys(contracts.OPTIONS)) lines.push(`  ${key}: ${String(options[key])}`);
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
 * Human lines for the reply: the counts, the start, the goal, warnings, misses and the next steps.
 * @param {object} summary build().summary
 * @param {string} name the slot name
 * @returns {string[]}
 */
function summaryLines(summary, name) {
	const lines = [
		`${plural(summary.entries, ['entry', 'entries'])} (${kindPhrase(summary.counts)}), ${plural(summary.locations, ['location', 'locations'])}, about ${hoursText(summary.hours)} h.`,
		`Starts with ${summary.startOpen} open; goal: finish ${summary.goalCount} of ${summary.entries} (about ${hoursText(summary.hoursToGoal)} h).`,
	];
	for (const w of summary.warnings) lines.push(`Warning: ${w}`);
	for (const miss of summary.misses) {
		lines.push(`Not found: ${miss.query}${miss.didYouMean.length ? ` (did you mean ${miss.didYouMean.join(', ')}?)` : ''}`);
	}
	lines.push(`Next: send this file to the owner. Once the seed is up, run \`/apmedia link ${String(name).replace(/`/g, '')}\`.`);
	lines.push('Every title on the list is visible to the whole room and on the public tracker.');
	return lines;
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
					warnings.push(`${show.title} starts at its first episode: without a linked Plex account nothing is known as watched.`);
				}
				const chosen = parsed.seasons
					? eps.filter((e) => e.sn >= parsed.seasons[0] && e.sn <= parsed.seasons[1])
					: runOf(eps, await lib.watchedIfKnown(), p.maxEpisodes);
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
					if (score >= MATCH_MIN && (!best || score > best.score || (score === best.score && length < best.length))) {
						best = { ...c, score, length };
					}
				}
			}
			if (!best && parsed.kind !== 'movie' && parsed.kind !== 'show' && parsed.kind !== 'album' && typeof catalogStore.findWorks === 'function') {
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
			if (!entries.length) {
				misses.push({ query: parsed.query, didYouMean: [] });
				warnings.push(`${displayOf(best.kind, best.item)} has nothing that fits${parsed.seasons ? ` in S${parsed.seasons[0]}-${parsed.seasons[1]}` : ''}.`);
				return;
			}
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

		function findByName(rows, wanted, titleOf, rkOf) {
			const raw = String(wanted).trim();
			if (/^\d+$/.test(raw)) {
				const hit = rows.find((r) => rkOf(r) === Number(raw));
				if (hit) return hit;
			}
			const want = norm(raw);
			const exact = rows.find((r) => norm(titleOf(r)) === want);
			if (exact) return exact;
			let best = null;
			for (const r of rows) {
				const score = matchScore(raw, titleOf(r));
				if (score >= MATCH_MIN && (!best || score > best.score)) best = { r, score };
			}
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
			const pl = findByName(all, p.playlist, (x) => x.title, (x) => x.rk);
			if (!pl) {
				const names = all.slice(0, 10).map((x) => x.title).join(', ');
				throw new Error(`No playlist called "${p.playlist}".${names ? ` Playlists: ${names}.` : ''}`);
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
			const hit = findByName(found, p.collection, (c) => c.title, (c) => Number(c.ratingKey));
			if (!hit) {
				const names = found.slice(0, 10).map((c) => clean(c.title)).join(', ');
				throw new Error(`No movie or TV collection called "${p.collection}".${names ? ` Some collections: ${names}.` : ''}`);
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
			if (p.years) warnings.push('years does not apply to books.');
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

		if (!list.size) {
			const missed = misses.length ? ` Not found: ${misses.map((m) => m.query).join('; ')}.` : '';
			throw new Error(`Nothing on the list: no title matched what was asked for.${missed}`);
		}

		const entries = list.values();
		const createdAt = Math.floor(now() / 1000);
		const plan = planSlot(entries, p.options);
		const L = contracts.LIMITS;
		if (plan.entryCount > L.maxEntries || plan.C > L.maxCopies || plan.locations > L.maxLocations) {
			throw new Error(`That list is too big for one slot: ${plan.entryCount} entries (at most ${L.maxEntries}), `
				+ `${plan.C} unlock copies (at most ${L.maxCopies}), ${plan.locations} locations (at most ${L.maxLocations}). `
				+ 'Lower the counts or maxEpisodes, raise episodesPerUnlock, or turn timers down.');
		}
		if (plan.C > L.warnCopies) warnings.push(`${plan.C} unlock copies: above ${L.warnCopies}, generating the seed gets slow.`);
		if (plan.locations > L.warnLocations) warnings.push(`${plan.locations} locations: above ${L.warnLocations}, that is a very long list.`);
		if (plan.hoursToGoal > L.warnHoursToGoal) warnings.push(`About ${Math.round(plan.hoursToGoal)} h to the goal (more than ${L.warnHoursToGoal} h).`);
		if (plan.C - plan.S < 2) warnings.push('Almost everything starts open: fewer than 2 unlocks are left for the multiworld to find.');
		if (p.options.tv_unlock === 'season') {
			const single = plan.units.filter((u) => u.key.startsWith('show-season|') && u.steps === 1).length;
			if (single) warnings.push(`Season mode: ${plural(single, ['show is', 'shows are'])} one season on this list, so one unlock opens all of it.`);
		}

		const yaml = renderYaml({
			name: p.name,
			label: p.label,
			createdAt,
			options: p.options,
			listInfo: { builder: contracts.BUILDER_VERSION, account: p.accountId, discord: p.discordUserId },
			entries,
		});
		const summary = {
			counts: plan.counts,
			shows: plan.shows,
			entries: plan.entryCount,
			locations: plan.locations,
			copies: plan.C,
			startCopies: plan.S,
			wildTickets: plan.W,
			startOpen: plan.startOpen,
			goalCount: plan.goal_count,
			hours: Math.round(plan.hours * 10) / 10,
			hoursToGoal: Math.round(plan.hoursToGoal * 10) / 10,
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
	summaryLines,
	validateParams,
	ACCOUNT_FIX,
	_internal: { parseTitle, matchScore, similarity, norm, isPlaceholderAlbum, orderedEntry, safeFileName },
};
