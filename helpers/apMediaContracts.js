// helpers/apMediaContracts.js
// Names, ids, limits and data shapes shared by the Plex Media Archipelago world's modules.
//
// apworld/plex_media/constants.py mirrors the ids, names, limits and option table below, and
// apworld/plex_media/naming.py mirrors sanitizeText character for character. Ids, keys and names
// are frozen per builder version: a seed keeps crediting for as long as its room lives, so a change
// to anything an id, a key or a name is derived from ships as a new BUILDER_VERSION, never an edit.
//
// Location keys (`movie|<id>|w`, `ep|<id>|@<m>`, ...) exist only in Python. The bot never derives
// a location id: it reads every id it sends from the slot's slot_data.

const GAME = 'Plex Media';
const APWORLD_NAME = 'plex_media';
const WORLD_VERSION = '0.1.0';
const MIN_AP_VERSION = '0.6.8';
const BUILDER_VERSION = 1;
const SLOT_DATA_SCHEMA = 1;

// Item ids and location ids are separate namespaces in AP, so Popcorn and "Check 1" share BASE_ID + 1.
const BASE_ID = 1347000000;
const UNLOCK_OFFSET = 1000;
const MAX_UNLOCKS = 20000;
const MAX_CHECKS = 60000;
const IDS = Object.freeze({
	popcorn: BASE_ID + 1,
	wildTicket: BASE_ID + 2,
});

function unlockId(i) { return BASE_ID + UNLOCK_OFFSET + i; }
function checkId(j) { return BASE_ID + j; }
function unlockName(i) { return `Unlock ${i}`; }
function checkName(j) { return `Check ${j}`; }

const NAMES = Object.freeze({
	popcorn: 'Popcorn',
	wildTicket: 'Wild Ticket',
	victory: 'Victory',
	goalLocation: 'Plex Media Goal',
	// A state counter for the goal rule, never an item in the pool.
	counter: 'Plex Media Unlocked Entries',
});
const ITEM_GROUPS = Object.freeze(['Movies', 'Shows', 'Albums', 'Playlists', 'Books', 'Everything']);
const LOCATION_GROUPS = Object.freeze(['Movies', 'Episodes', 'Albums', 'Playlists', 'Books', 'Checkpoints', 'Everywhere']);

// The server refuses checks and the goal from Tracker, TextOnly and HintGame clients, so the game
// client carries none of those tags. The bot tag lets the observer on the same room recognise the
// bot's own Join and Part lines and keep them out of the relay.
const BOT_GAME_TAG = 'PlexMediaBot';
const CLIENT_TAGS = Object.freeze(['AP', BOT_GAME_TAG, 'NoText']);
const ITEMS_HANDLING = 7;
const CLIENT_GOAL = 30;

const KINDS = Object.freeze(['movie', 'episode', 'album', 'mix', 'book']);
// The albums timer covers mixes too.
const TIMER_KIND = Object.freeze({ movie: 'movie', episode: 'episode', album: 'album', mix: 'album', book: 'book' });

const LIMITS = Object.freeze({
	maxEntries: 2000,
	maxCopies: 2000,
	maxLocations: 10000,
	// Shorter tracks get no location: a skit or an interlude is over before anyone can count it.
	minTrackMs: 30000,
	// A checkpoint at or past 90% of the runtime would land in the credits.
	checkpointCut: 0.9,
	// Starting copies are at least ceil(copies / 50), so a long list never opens with one title.
	copiesPerStart: 50,
	mixTracks: 15,
	slotNameMax: 16,
	titleMax: 100,
	warnCopies: 600,
	warnLocations: 1500,
	warnHoursToGoal: 50,
});

// The YAML option table, in the order the YAML writes it. OptionList and OptionDict values
// (entries, list_info) are written after these.
const OPTIONS = Object.freeze({
	starting_unlocks: Object.freeze({ type: 'range', min: 1, max: 50, default: 3 }),
	goal_percent: Object.freeze({ type: 'range', min: 1, max: 100, default: 80 }),
	tv_unlock: Object.freeze({ type: 'choice', values: Object.freeze(['episodes', 'season']), default: 'episodes' }),
	episodes_per_unlock: Object.freeze({ type: 'range', min: 1, max: 12, default: 3 }),
	locked_watches: Object.freeze({ type: 'choice', values: Object.freeze(['bank', 'ignore']), default: 'bank' }),
	checkpoint_items: Object.freeze({ type: 'choice', values: Object.freeze(['filler_only', 'anything']), default: 'filler_only' }),
	timesanity_strict: Object.freeze({ type: 'toggle', default: false }),
	timesanity_movies: Object.freeze({ type: 'range', min: 0, max: 240, default: 15 }),
	timesanity_episodes: Object.freeze({ type: 'range', min: 0, max: 240, default: 10 }),
	timesanity_albums: Object.freeze({ type: 'range', min: 0, max: 240, default: 0 }),
	timesanity_books: Object.freeze({ type: 'range', min: 0, max: 1440, default: 30 }),
	wild_tickets: Object.freeze({ type: 'range', min: 0, max: 20, default: 2 }),
});

const PRESETS = Object.freeze({
	movies: Object.freeze({ movies: 15 }),
	tv: Object.freeze({ shows: 3 }),
	music: Object.freeze({ albums: 10 }),
	books: Object.freeze({ books: 3 }),
	mixed: Object.freeze({ movies: 6, shows: 1, albums: 4, books: 1 }),
});
const DEFAULT_PRESET = 'movies';
const COUNT_RANGES = Object.freeze({
	movies: Object.freeze({ min: 0, max: 200 }),
	shows: Object.freeze({ min: 0, max: 50 }),
	albums: Object.freeze({ min: 0, max: 200 }),
	books: Object.freeze({ min: 0, max: 50 }),
	maxEpisodes: Object.freeze({ min: 1, max: 500, default: 24 }),
});

// Never an archipelago* key: archipelagoMonitor re-applies its config on every one of those.
const SETTINGS = Object.freeze({
	apMediaEnabled: Object.freeze({ default: false }),
	apMediaChannelId: Object.freeze({ default: '' }),
	apMediaHistorySeconds: Object.freeze({ default: 120, min: 30 }),
	apMediaSessionSeconds: Object.freeze({ default: 15, min: 5 }),
	apMediaVoiceCredit: Object.freeze({ default: true }),
	apMediaAnnounce: Object.freeze({ default: 'completions', values: Object.freeze(['completions', 'all', 'off']) }),
});

const STORES = Object.freeze({
	slots: Object.freeze({ file: 'data/apmedia_slots.json', env: 'PLEXBOT_APMEDIA_SLOTS_FILE' }),
	accounts: Object.freeze({ file: 'data/apmedia_accounts.json', env: 'PLEXBOT_APMEDIA_ACCOUNTS_FILE' }),
	marks: Object.freeze({ file: 'data/apmedia_marks.json', env: 'PLEXBOT_APMEDIA_MARKS_FILE' }),
	cache: Object.freeze({ dir: 'data/archipelago/apmedia', env: 'PLEXBOT_APMEDIA_CACHE_DIR' }),
});
const BINDING_STATES = Object.freeze(['active', 'stale', 'refused', 'orphaned']);
const CONSENT_STATES = Object.freeze(['pending', 'granted']);

const EVENT_TYPES = Object.freeze(['complete', 'span']);
const EVENT_SOURCES = Object.freeze(['history', 'session', 'voice', 'book', 'manual']);
const HIT_ROLES = Object.freeze(['whole', 'track', 'part']);

const VOICE = Object.freeze({ heardFraction: 0.85, naturalMinMs: 30000 });

function entryKey(entry) {
	return `${entry.k}|${entry.id}`;
}

function unitKey(entry, { tvUnlock = OPTIONS.tv_unlock.default, episodesPerUnlock = OPTIONS.episodes_per_unlock.default } = {}) {
	if (entry.k !== 'episode') return `${entry.k}|${entry.id}`;
	return tvUnlock === 'season' ? `show-season|${entry.sid}` : `show-ep${episodesPerUnlock}|${entry.sid}`;
}

// PyYAML refuses raw C0/C1 controls, surrogates and U+FFFE/U+FFFF anywhere in the file, quoted or
// not, and AP shows names in one-line chat. The whitespace class is spelled out because JS \s and
// Python's isspace() disagree (U+FEFF, U+001C-U+001F), and both sides must produce the same names.
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const DROPPED = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufeff\ufffe\uffff]/gu;
const SPACES = /[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

function sanitizeText(value) {
	return String(value ?? '')
		.replace(BREAKS, ' ')
		.replace(DROPPED, '')
		.replace(SPACES, ' ')
		.replace(/^ +| +$/g, '');
}

/** Why AP would refuse or mangle this slot name, or null when it is fine. */
function slotNameProblem(name) {
	if (typeof name !== 'string' || name.length === 0) return 'Give the slot a name of 1 to 16 characters.';
	if (/^\s|\s$/.test(name)) return 'The name cannot start or end with a space.';
	if ([...name].length > LIMITS.slotNameMax) return 'The name can be at most 16 characters: Archipelago cuts longer names.';
	// Generate substitutes %player%, {player}, %number% and {number}, and a lone brace breaks it.
	if (/[{}%]/.test(name)) return 'The name cannot contain {, } or %.';
	if (name.toLowerCase() === 'archipelago') return '"Archipelago" is reserved by the server.';
	if (sanitizeText(name) !== name) return 'The name has a line break, a control character or a doubled space.';
	return null;
}

/**
 * One list entry, as the YAML carries it and as slot_data repeats it (slot_data adds the fields
 * marked "slot_data").
 * @typedef {object} Entry
 * @property {'movie'|'episode'|'album'|'mix'|'book'} k
 * @property {string} id   movie/episode/album: a plex:// (album: or mbid://) guid, else `rk:<rk>`;
 *                         mix: `pl:<playlist rk>:<part>`; book: `book:<work id>`
 * @property {string} t
 * @property {number} d    duration in ms; album/mix/book: the sum of the tracks or parts
 * @property {string} [g]
 * @property {number} [rk]                                   movie, episode, album
 * @property {number|null} [y]                               movie, album
 * @property {string} [sh] @property {string} [sid] @property {number} [srk]
 * @property {number} [sn] @property {number} [en]          episode (sn 0 = specials)
 * @property {string} [ar]                                   album
 * @property {Array} [tr]   album: [rk, index, title, d, partId] (+ location id or null in slot_data);
 *                          mix: [rk, index, title, d, partId, artist] (+ location id or null)
 * @property {Array} [alt]  album twins: [[albumRk, [[trackRk, partId], ...]], ...], same positions as tr
 * @property {number} [pl] @property {number} [part]         mix
 * @property {string} [au]                                  book
 * @property {string|number} [w]  book: the catalog work id (a string);
 *                                slot_data movie/episode: the watch location id (a number)
 * @property {Array} [pa]   book: [[trackRk, partId, d], ...] in play order
 * @property {number} [u]   slot_data: the unit's item id
 * @property {number} [s]   slot_data: the copies of that unit this entry needs
 * @property {number} [f]   slot_data, book: the finish location id
 * @property {Array<[number, number]>} [cp]  slot_data: [minute, location id], ascending
 */

/**
 * slot_data, schema 1.
 * @typedef {object} SlotData
 * @property {1} schema @property {'Plex Media'} game @property {string} world_version
 * @property {number} builder
 * @property {number} generated_at  unix seconds; credit counts only from here
 * @property {number} created_at    unix seconds the YAML was built
 * @property {string} label  (no account or Discord id: anyone joined as the slot, or reading
 *   archipelago.gg's tracker API, gets slot_data; those stay in the YAML's list_info)
 * @property {number} goal_percent @property {number} goal_count @property {number} entry_count
 * @property {'episodes'|'season'} tv_unlock @property {number} episodes_per_unlock
 * @property {'bank'|'ignore'} locked_watches @property {'filler_only'|'anything'} checkpoint_items
 * @property {boolean} timesanity_strict
 * @property {{movie: number, episode: number, album: number, book: number}} timesanity  minutes, 0 = off
 * @property {{popcorn: number, wild_ticket: number}} items
 * @property {Array<{id: number, name: string, kind: 'movie'|'show'|'album'|'mix'|'book', steps: number, start: number}>} units
 * @property {Entry[]} entries  in YAML order; album tr tuples carry the track's location id at
 *                              index 5 and mix tr tuples at index 6 (null for a track under 30 s)
 */

/**
 * What the watchers hand to the game. `at` is ms since the epoch; an event before the slot's
 * generated_at counts for nothing.
 * @typedef {object} CreditEvent
 * @property {'complete'|'span'} type
 * @property {'history'|'session'|'voice'|'book'|'manual'} source
 * @property {number} at
 * @property {number} [accountId]   history, session: the Plex account (owner = 1)
 * @property {string[]} [userIds]   voice, book, manual: Discord user ids
 * @property {number} [ratingKey]   history, session, voice
 * @property {string} [librarySectionID]   history
 * @property {number} [partId] @property {string} [artist] @property {string} [title]   voice
 * @property {string} [workId]      book
 * @property {string[]} [workIds]   book events: the current catalog work id first, then its old ids,
 *                                  then the raw id
 * @property {number} [fromMs] @property {number} [toMs]   span: playback position, ms
 */

/**
 * Where an event's media sits inside one entry.
 * @typedef {object} Hit
 * @property {Entry} entry
 * @property {'whole'|'track'|'part'} role
 * @property {number} index    track/part position, 1-based; 0 for whole
 * @property {number} startMs  where the track/part starts inside the entry's timeline
 * @property {number} endMs
 */

module.exports = {
	GAME,
	APWORLD_NAME,
	WORLD_VERSION,
	MIN_AP_VERSION,
	BUILDER_VERSION,
	SLOT_DATA_SCHEMA,
	BASE_ID,
	UNLOCK_OFFSET,
	MAX_UNLOCKS,
	MAX_CHECKS,
	IDS,
	NAMES,
	ITEM_GROUPS,
	LOCATION_GROUPS,
	BOT_GAME_TAG,
	CLIENT_TAGS,
	ITEMS_HANDLING,
	CLIENT_GOAL,
	KINDS,
	TIMER_KIND,
	LIMITS,
	OPTIONS,
	PRESETS,
	DEFAULT_PRESET,
	COUNT_RANGES,
	SETTINGS,
	STORES,
	BINDING_STATES,
	CONSENT_STATES,
	EVENT_TYPES,
	EVENT_SOURCES,
	HIT_ROLES,
	VOICE,
	unlockId,
	checkId,
	unlockName,
	checkName,
	entryKey,
	unitKey,
	sanitizeText,
	slotNameProblem,
};
