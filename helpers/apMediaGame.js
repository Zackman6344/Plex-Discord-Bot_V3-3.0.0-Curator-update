// helpers/apMediaGame.js
// The Plex Media world's orchestrator: one game client per bound slot, every source of credit
// turned into location checks, the announcements, and the data /apmedia shows.
//
// Everything that changes a binding runs on one queue (a promise chain): credit from Plex history
// and sessions, from the bot's voice and audiobooks and from /apmedia check, a slot's connection,
// inventory and checks, and every command. apMediaBooks delivers its finishes and its spans from
// separate timers, so without the queue two credits could read the same pending list and the
// second write would drop the first one's checks. Plex lookups run before a credit joins the
// queue, so a slow metadata read holds up nothing else.
//
// Locked or unlocked is decided only once the slot's client has reported its inventory. Until then
// (at boot, while a room is unreachable, between a Connected and its items) a credit is banked and
// saved, and the next 'items' sorts it out: a wrong "locked" under locked_watches 'ignore' would
// drop that credit for good.
//
// A repeat is free: apMediaBooks re-sends every finished bookmark each minute and a span every 10 s
// while a book plays, and apMediaVoice sends one event per !loop pass. A credit with nothing new
// left writes nothing and says nothing.
//
// !restart runs stop() then start() in one process. Bindings live in the store, and the slot
// indexes, the watcher and the announcement buffers in this module, so all of that survives. The
// game clients do not: each one reconnects, and its join and leave lines are kept out of the relay
// by the PlexMediaBot tag. Lines still waiting to post are held for the next Discord client for up
// to HOLD_MS, as the Archipelago relay holds its own.
//
// Accounts: the owner (config.ownerId) is read as Plex account 1, the server owner, with consent
// given, unless they linked another account. Nobody else's history is read before the owner linked
// their account and they accepted.

const crypto = require('crypto');
const { escapeMarkdown } = require('discord.js');
const contracts = require('./apMediaContracts.js');
const credit = require('./apMediaCredit.js');

const HOLD_MS = 5 * 60 * 1000;
// 1900 keeps a chunk inside Discord's 2000-character message limit, as the relay does.
const MAX_CHUNK = 1900;
const MAX_HELD_LINES = 200;
const MAX_NOTES = 1000;
const MAX_UNMATCHED = 20000;
const WELCOME_TITLES = 8;
// !diag posts the health detail in one message, and a room can refuse with any text it likes.
const HEALTH_NAMES = 5;
const HEALTH_TEXT = 60;
const ROOM_TEXT = 100;
const OWNER_ACCOUNT = 1;
const LIST_STATES = Object.freeze(['ready', 'locked', 'done']);
// A refused slot keeps earning: a changed room password refuses the game client, and a retry with
// the new one sends what was earned meanwhile. An orphaned or stale slot has no room left to send to.
const CREDITED = new Set(['active', 'refused']);
// hitsForMetadata can place a movie, an episode or an album track; a list without those has
// nothing a metadata read could find.
const META_KINDS = new Set(['movie', 'episode', 'album']);
const VERB = Object.freeze({ movie: 'watched', episode: 'watched', album: 'listened to', mix: 'listened to', book: 'finished' });
// The registry's collision tag, and the 4.8 duration format, for reading a hinted location's name.
const TAG_TAIL = / \[([^\]]+)\]$/;
const DURATION_NAME = /^\d+h(?:\d+m)?$|^\d+m$/;
const ICON = Object.freeze({
	done: '\u2705',
	locked: '\u{1F512}',
	unlocked: '\u{1F513}',
	progress: '\u23F1\uFE0F',
	refused: '\u{1F534}',
	stale: '\u{1F7E1}',
	orphaned: '\u26A0\uFE0F',
	welcome: '\u{1F3AC}',
	ticket: '\u{1F39F}\uFE0F',
});
const ELLIPSIS = '\u2026';

function errText(err) {
	return (err && err.message) || String(err);
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** At most max characters, cut between code points. */
function clip(text, max) {
	const chars = [...String(text ?? '')];
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}${ELLIPSIS}` : chars.join('');
}

/** A slot name in inline code, the way /ap shows one: a backtick inside would end the span. */
function code(name) {
	return `\`${String(name ?? '').replace(/`/g, "'")}\``;
}

/**
 * Text nobody here wrote (a title, a typed name) as Markdown that shows it as typed. A list title
 * can come from a hand-edited YAML, and escapeMarkdown leaves a masked link [text](url) working:
 * its maskedLink option escapes only the first of several in one string, so every [ is escaped.
 */
function md(text) {
	return escapeMarkdown(String(text ?? '')).replace(/\[/g, '\\[');
}

/** A slot name or a room's words inside !diag's code block, which a backtick would end. */
function plain(text, max = HEALTH_TEXT) {
	return clip(String(text ?? '').replace(/`/g, "'"), max);
}

function firstFew(items, show) {
	const shown = items.slice(0, HEALTH_NAMES).map(show);
	return items.length > shown.length ? `${shown.join(', ')} and ${items.length - shown.length} more` : shown.join(', ');
}

/**
 * A command in inline code, kept exact: code() turns a slot name's backtick into a quote, and the
 * command would then name another slot. A space next to a backtick at either end keeps it apart
 * from the fence; Discord drops that space.
 */
function commandCode(text) {
	const s = String(text ?? '');
	const longest = Math.max(0, ...(s.match(/`+/g) || []).map((run) => run.length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}${s.startsWith('`') ? ' ' : ''}${s}${s.endsWith('`') ? ' ' : ''}${fence}`;
}

const SWITCH_WORDS = new Map([
	['on', true], ['true', true], ['yes', true], ['1', true],
	['off', false], ['false', false], ['no', false], ['0', false],
]);

// A prefix command or a string option hands over the word, and !!'off' is true.
function switchOf(value) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
	if (typeof value !== 'string') return null;
	const on = SWITCH_WORDS.get(value.trim().toLowerCase());
	return on === undefined ? null : on;
}

function bold(text) {
	return `**${md(text)}**`;
}

function pad2(n) {
	return String(Number(n) || 0).padStart(2, '0');
}

/** `2h16m`, `45m`, `1h`, or `<1m`. */
function formatDuration(ms) {
	const minutes = Math.round(Math.max(0, Number(ms) || 0) / 60000);
	if (minutes < 1) return '<1m';
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (!h) return `${m}m`;
	return m ? `${h}h${m}m` : `${h}h`;
}

/** How a list title reads to a person: `The Matrix (1999)`, `Show S01E02`, `Artist - Album`. */
function entryLabel(entry) {
	if (!entry || typeof entry !== 'object') return '';
	switch (entry.k) {
		case 'movie': return entry.y ? `${entry.t} (${entry.y})` : String(entry.t ?? '');
		case 'episode': return `${entry.sh} S${pad2(entry.sn)}E${pad2(entry.en)}`;
		case 'album': return `${entry.ar} - ${entry.t}`;
		case 'book': return entry.au ? `${entry.t} by ${entry.au}` : String(entry.t ?? '');
		default: return String(entry.t ?? '');
	}
}

function discordIdOf(value) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const s = String(value).trim();
	return /^\d{1,32}$/.test(s) ? s : null;
}

function union(...sets) {
	const out = new Set();
	for (const set of sets) for (const v of set || []) out.add(Number(v));
	return out;
}

function chunkLines(lines, max = MAX_CHUNK) {
	const out = [];
	let current = '';
	for (const raw of lines) {
		const line = raw.length > max ? `${raw.slice(0, max - 1)}${ELLIPSIS}` : raw;
		if (current && current.length + 1 + line.length > max) {
			out.push(current);
			current = line;
		} else {
			current = current ? `${current}\n${line}` : line;
		}
	}
	if (current) out.push(current);
	return out;
}

function clientVersion() {
	const v = require('./archipelagoClient.js').CLIENT_VERSION || {};
	return [v.major, v.minor, v.build].map((part) => part ?? 0).join('.');
}

// The room and password a client was built for, so a re-pointed or re-passworded watch is noticed.
// Hashed: the password stays in the watch store, not in a second copy here.
function signature(watch) {
	return crypto.createHash('sha256').update(JSON.stringify([watch.target || null, watch.password || null])).digest('hex');
}

function groupOf(entry) {
	switch (entry.k) {
		case 'episode': return { key: `show|${entry.sid}`, name: String(entry.sh ?? ''), kind: 'show' };
		case 'album': return { key: 'albums', name: 'Albums', kind: 'album' };
		case 'mix': return { key: `mix|${entry.pl}`, name: String(entry.t ?? '').replace(/ Part \d+$/, ''), kind: 'mix' };
		case 'book': return { key: 'books', name: 'Books', kind: 'book' };
		default: return { key: 'movies', name: 'Movies', kind: 'movie' };
	}
}

// Location names (SPEC 4.8), for hints whose rows carry only the name. The name is rebuilt from
// the same sanitised slot_data fields the registry named it from; a component clipped at 100
// characters does not match, which only costs a hint marker.
function locationBase(entry) {
	switch (entry.k) {
		case 'movie': return entry.y ? `${entry.t} (${entry.y})` : String(entry.t ?? '');
		case 'episode': return `${entry.sh} S${pad2(entry.sn)}E${pad2(entry.en)}`;
		case 'album': return `${entry.ar} - ${entry.t}`;
		default: return String(entry.t ?? '');
	}
}

function entryTags(entry) {
	if (entry.k === 'mix') return [`${entry.pl}:${entry.part}`];
	if (entry.k === 'book') return [String(entry.w)];
	return [String(entry.rk)];
}

function baseNames(entry, name) {
	const base = locationBase(entry);
	if (!base) return false;
	if ((entry.k === 'movie' || entry.k === 'episode') && name === `Watch ${base}`) return true;
	if (entry.k === 'book' && name === `Finish ${base}`) return true;
	if ((entry.k === 'album' || entry.k === 'mix') && name.startsWith(`${base} #`)) return true;
	return name.startsWith(`${base} @ `) && DURATION_NAME.test(name.slice(base.length + 3));
}

// A track title may end in brackets of its own ("[Remastered]"), so the whole name is tried
// before any tail is read as a collision tag.
function namesLocation(entry, name) {
	if (baseNames(entry, name)) return true;
	let rest = name;
	const tags = [];
	let m;
	while ((m = TAG_TAIL.exec(rest))) {
		tags.unshift(m[1]);
		rest = rest.slice(0, m.index);
		if (baseNames(entry, rest)) {
			const own = entryTags(entry);
			return tags.every((tag) => own.includes(tag));
		}
	}
	return false;
}

/**
 * The Plex Media orchestrator. The module exports one shared instance; tests build their own.
 * Every dependency is optional and defaults to the real module, required on first use.
 * @param {object} [options]
 * @param {object} [options.store] helpers/apMediaStore.js (an instance)
 * @param {object} [options.monitor] helpers/archipelagoMonitor.js: getWatch, describeSlot,
 *   onWatchChange, listHints, listClaims
 * @param {object} [options.config] config/config.js
 * @param {object} [options.configStore] helpers/configStore.js: onChange
 * @param {object} [options.pms] helpers/apMediaPlex.js createPms()
 * @param {Function} [options.createWatcher] helpers/apMediaWatch.js createWatcher
 * @param {object} [options.watcherTimers] passed to createWatcher
 * @param {Function} [options.Client] helpers/apMediaClient.js ApMediaClient
 * @param {object} [options.voice] helpers/apMediaVoice.js
 * @param {object} [options.books] helpers/apMediaBooks.js
 * @param {object} [options.booksTimers] passed to apMediaBooks.attach
 * @param {Function} [options.voiceDefer] passed to apMediaVoice.attach
 * @param {object} [options.bookmarks] helpers/bookmarks.js
 * @param {object} [options.catalogStore] helpers/bookCatalogStore.js
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] announcement batching
 * @param {() => number} [options.now]
 * @param {object} [options.logger]
 * @param {object} [options.commandLog] recordEvent(kind, detail)
 */
function createGame(options = {}) {
	const deps = { ...options };
	const made = new Map();
	function dep(name, make) {
		if (deps[name] !== undefined && deps[name] !== null) return deps[name];
		if (!made.has(name)) made.set(name, make());
		return made.get(name);
	}
	const cfg = () => dep('config', () => require('../config/config.js'));
	const store = () => dep('store', () => require('./apMediaStore.js'));
	const monitor = () => dep('monitor', () => require('./archipelagoMonitor.js'));
	const configStore = () => dep('configStore', () => require('./configStore.js'));
	const log = () => dep('logger', () => require('./logger.js'));
	const commandLog = () => dep('commandLog', () => require('./commandLog.js'));
	const pms = () => dep('pms', () => require('./apMediaPlex.js').createPms());
	const Client = () => dep('Client', () => require('./apMediaClient.js').ApMediaClient);
	const voiceModule = () => dep('voice', () => require('./apMediaVoice.js'));
	const booksModule = () => dep('books', () => require('./apMediaBooks.js'));
	const bookmarks = () => dep('bookmarks', () => require('./bookmarks.js'));
	const catalogStore = () => dep('catalogStore', () => require('./bookCatalogStore.js'));
	const timers = () => dep('timers', () => ({ setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) }));
	const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
	// One per process, shared with /apmedia: its playlist cache is what the autocomplete reads.
	const yamlBuilder = () => dep('builder', () => require('./apMediaYaml.js').createBuilder({
		pms: pms(),
		catalogStore: catalogStore(),
		bookmarks: bookmarks(),
		now,
	}));

	const kept = { discord: null, bot: null };
	let running = false;
	let configBound = false;
	let startError = null;
	let watchOff = null;
	let watcher = null;
	let attachedBot = null;
	let voiceDetach = null;
	let booksDetach = null;
	let chain = Promise.resolve();
	const runtimes = new Map();
	const channels = new Map();
	const unmatched = new WeakMap();
	const loggedMisses = new Set();
	const backfilling = new Set();

	function record(kind, detail) {
		try {
			commandLog().recordEvent(kind, detail);
		} catch (_) {}
	}

	// --- the queue -------------------------------------------------------------------------

	function serial(task) {
		const run = chain.then(() => task());
		chain = run.catch(() => {});
		return run;
	}

	function queue(task, what) {
		serial(task).catch((err) => log().error(`Plex Media: ${what} failed:`, errText(err)));
	}

	function api(what, task) {
		return serial(task).catch((err) => {
			log().error(`Plex Media: ${what} failed:`, errText(err));
			return { ok: false, message: `That did not work: ${errText(err)}` };
		});
	}

	async function idle() {
		let tail;
		do {
			tail = chain;
			await tail;
		} while (tail !== chain);
	}

	// --- accounts --------------------------------------------------------------------------

	function accountOf(userId) {
		const id = discordIdOf(userId);
		if (!id) return null;
		const rec = store().accounts.get(id);
		if (rec) {
			return { accountId: rec.accountId, name: rec.name || null, consent: rec.consent, implicit: false, linkedAt: rec.linkedAt, linkedBy: rec.linkedBy };
		}
		const owner = discordIdOf(cfg().ownerId);
		if (owner && owner === id) {
			return { accountId: OWNER_ACCOUNT, name: null, consent: 'granted', implicit: true, linkedAt: null, linkedBy: null };
		}
		return null;
	}

	function consentedAccount(userId) {
		const account = accountOf(userId);
		return account && account.consent === 'granted' ? account.accountId : null;
	}

	function accountText(account) {
		if (!account) return 'none';
		if (account.implicit) return 'the server owner (account 1)';
		return account.name ? `${code(account.name)} (account ${account.accountId})` : `account ${account.accountId}`;
	}

	/** The Discord users a Plex account is read for, other than `except`: the owner holds account 1 unlinked. */
	function holdersOf(accountId, except = null) {
		const id = Number(accountId);
		const out = [];
		for (const rec of store().accounts.list()) {
			if (rec.userId !== except && Number(rec.accountId) === id) out.push({ userId: rec.userId, implicit: false });
		}
		const owner = discordIdOf(cfg().ownerId);
		if (id === OWNER_ACCOUNT && owner && owner !== except && !store().accounts.get(owner)) out.push({ userId: owner, implicit: true });
		return out;
	}

	// What was read for an account nobody holds any more goes with its last link: the history mark
	// and the watcher's last session sample.
	function forgetAccount(accountId) {
		const id = Number(accountId);
		if (!Number.isSafeInteger(id) || id <= 0 || holdersOf(id).length) return;
		try {
			store().marks.remove(id);
		} catch (err) {
			log().warn(`Plex Media: could not drop the history mark of Plex account ${id}:`, errText(err));
		}
		if (watcher && typeof watcher.forget === 'function') watcher.forget(id);
	}

	// --- bindings and their runtime --------------------------------------------------------

	function bindings() {
		return store().bindings.list();
	}

	function bindingByKey(key) {
		return typeof key === 'string' && key ? store().bindings.get(key) : null;
	}

	function summary(b) {
		return { key: b.key, watchId: b.watchId, slot: b.slot, userId: b.userId, state: b.state, seedName: b.seedName, announce: b.announce };
	}

	function runtimeOf(key) {
		let rt = runtimes.get(key);
		if (!rt) {
			rt = {
				key,
				client: null,
				connection: 'stopped',
				detail: null,
				index: null,
				indexSeed: null,
				badSeed: null,
				checked: new Set(),
				checkedSeed: null,
				counts: null,
				notes: [],
				targetSig: null,
				channelId: null,
				refetched: false,
			};
			runtimes.set(key, rt);
		}
		return rt;
	}

	// The slot index for the binding's seed, from memory or the slot_data cache, so a slot credits
	// while its room is unreachable.
	function indexFor(b) {
		if (!b || !b.seedName) return null;
		const rt = runtimeOf(b.key);
		if (rt.index && rt.indexSeed === b.seedName) return rt.index;
		if (rt.badSeed === b.seedName) return null;
		let slotData = null;
		try {
			slotData = store().cache.read(b.seedName, b.slot);
		} catch (err) {
			log().warn(`Plex Media: could not read the cached slot_data of ${b.slot}:`, errText(err));
		}
		if (!slotData) return null;
		try {
			rt.index = credit.indexSlot(slotData);
			rt.indexSeed = b.seedName;
			return rt.index;
		} catch (err) {
			rt.badSeed = b.seedName;
			// Dropped, as apMediaStore drops a copy it cannot parse: the next Connect then asks the room
			// for slot_data instead of being told the cache holds it.
			store().cache.drop(b.seedName, b.slot);
			log().warn(`Plex Media: the cached slot_data of ${b.slot} is unusable, so the next connect fetches it again: ${errText(err)}`);
			return null;
		}
	}

	function forgetSeed(rt) {
		rt.index = null;
		rt.indexSeed = null;
		rt.badSeed = null;
		rt.checked = new Set();
		rt.checkedSeed = null;
		rt.counts = null;
		rt.notes = [];
	}

	function activeIndexes() {
		const out = [];
		for (const b of bindings()) {
			if (!CREDITED.has(b.state)) continue;
			const index = indexFor(b);
			if (index) out.push(index);
		}
		return out;
	}

	function boundUsers() {
		return [...new Set(bindings().filter((b) => CREDITED.has(b.state)).map((b) => b.userId))];
	}

	// The watcher's accounts: consented ones with a crediting binding whose list is known, each from
	// the earliest generated_at among its bindings.
	function targets() {
		const floors = new Map();
		for (const b of bindings()) {
			if (!CREDITED.has(b.state)) continue;
			const accountId = consentedAccount(b.userId);
			if (!accountId) continue;
			const index = indexFor(b);
			if (!index || !(index.generatedAtMs > 0)) continue;
			const floorS = Math.floor(index.generatedAtMs / 1000);
			floors.set(accountId, Math.min(floors.get(accountId) ?? floorS, floorS));
		}
		return [...floors].map(([accountId, floorS]) => ({ accountId, floorS }));
	}

	function countsFor(rt, index) {
		if (rt && rt.counts) return { counts: rt.counts, known: true };
		const units = new Map();
		if (index) for (const unit of index.units.values()) if (unit.start > 0) units.set(unit.id, unit.start);
		return { counts: { units, wild: 0, popcorn: 0 }, known: false };
	}

	function byEntry(index, ids) {
		const groups = new Map();
		for (const raw of ids) {
			const id = Number(raw);
			const entry = index.byLocation.get(id);
			if (!entry) continue;
			if (!groups.has(entry)) groups.set(entry, []);
			groups.get(entry).push(id);
		}
		return groups;
	}

	// --- credit ----------------------------------------------------------------------------

	function eventBindings(event, only) {
		let list = bindings().filter((b) => CREDITED.has(b.state));
		if (only) list = list.filter((b) => b.key === only);
		if (event.source === 'history' || event.source === 'session') {
			const accountId = Number(event.accountId);
			if (!Number.isSafeInteger(accountId) || accountId <= 0) return [];
			return list.filter((b) => consentedAccount(b.userId) === accountId);
		}
		const users = new Set((Array.isArray(event.userIds) ? event.userIds : []).map(String));
		return list.filter((b) => users.has(b.userId));
	}

	async function eventHits(b, index, event) {
		if (event.source === 'book') {
			// slot_data keeps the work id from when the list was built; a catalog rebuild can since have
			// made it an alias, which apMediaBooks lists after the current id.
			const ids = Array.isArray(event.workIds) && event.workIds.length ? event.workIds : [event.workId];
			for (const workId of ids) {
				if (workId === undefined || workId === null || workId === '') continue;
				const hits = credit.hitsFor(index, { workId });
				if (hits.length) return hits;
			}
			return [];
		}
		if (event.source === 'voice') {
			return credit.hitsFor(index, { ratingKey: event.ratingKey, partId: event.partId, artist: event.artist, title: event.title });
		}
		const hits = credit.hitsFor(index, { ratingKey: event.ratingKey });
		return hits.length ? hits : metadataHits(b, index, event.ratingKey);
	}

	// A twin copy of a listed album, or a title Plex re-keyed after a rescan, plays under a ratingKey
	// the list does not hold; its metadata names the guid the list was built from.
	async function metadataHits(b, index, ratingKey) {
		const rk = Number(ratingKey);
		if (!Number.isSafeInteger(rk) || rk <= 0) return [];
		if (!index.entries.some((e) => META_KINDS.has(e.k))) return [];
		let misses = unmatched.get(index);
		if (!misses) {
			misses = new Set();
			unmatched.set(index, misses);
		}
		if (misses.has(rk)) return [];
		const meta = await pms().metadata(rk);
		const hits = credit.hitsForMetadata(index, meta);
		if (hits.length) return hits;
		if (misses.size >= MAX_UNMATCHED) misses.clear();
		misses.add(rk);
		noteMiss(rk, meta);
		return [];
	}

	function noteMiss(rk, meta) {
		if (loggedMisses.has(rk)) return;
		if (loggedMisses.size >= MAX_UNMATCHED) loggedMisses.clear();
		loggedMisses.add(rk);
		const type = meta && meta.type ? String(meta.type) : 'no longer in Plex';
		const line = `Plex Media: ratingKey ${rk} (${type}) matches no title on a bound list.`;
		// Most of what a music listener plays is on no list; a movie or an episode that matches
		// nothing is more likely a list title Plex re-keyed, so that one is worth reading.
		if (type === 'movie' || type === 'episode') log().info(line);
		else log().debug(line);
	}

	/**
	 * One credit event from any watcher. The returned promise settles once the credit is applied;
	 * it rejects only when a Plex read failed, so the history poll tries that row again.
	 * @param {object} event a CreditEvent (apMediaContracts)
	 * @param {string|null} [only] a binding key: credit that binding alone (a backfill)
	 */
	async function handleEvent(event, only = null) {
		if (!event || typeof event !== 'object' || !contracts.EVENT_TYPES.includes(event.type)) return;
		const at = Number(event.at);
		if (!Number.isFinite(at)) return;
		const plans = [];
		let failure = null;
		for (const b of eventBindings(event, only)) {
			const index = indexFor(b);
			if (!index || at < index.generatedAtMs) continue;
			try {
				const hits = await eventHits(b, index, event);
				if (hits.length) plans.push({ key: b.key, index, hits });
			} catch (err) {
				failure = failure || err;
			}
		}
		if (plans.length) await serial(() => applyEvent(event, plans));
		if (failure) throw failure;
	}

	function applyEvent(event, plans) {
		for (const { key, index, hits } of plans) {
			const b = store().bindings.get(key);
			if (!b || !CREDITED.has(b.state) || indexFor(b) !== index) continue;
			const ids = [];
			for (const hit of hits) ids.push(...credit.locationsFor(hit, event, index.strict));
			creditIds(b, index, ids, Number(event.at), event.source);
		}
	}

	/**
	 * Location ids earned by one binding: new ones go out (unlocked), wait in the bank (locked, or
	 * the inventory is not known yet) or are dropped (locked under 'ignore').
	 * @returns {{sent: number, banked: number, dropped: number, provisional: boolean, entries: string[]}}
	 */
	function creditIds(b, index, ids, at, source) {
		const rt = runtimeOf(b.key);
		const pending = new Set(b.pending);
		const banked = new Set(b.banked);
		const fresh = [];
		for (const raw of ids) {
			const id = Number(raw);
			if (!Number.isSafeInteger(id) || id <= 0 || rt.checked.has(id) || pending.has(id) || banked.has(id) || fresh.includes(id)) continue;
			fresh.push(id);
		}
		const known = !!rt.counts;
		const out = { sent: 0, banked: 0, dropped: 0, provisional: !known, entries: [] };
		if (!fresh.length) return out;
		const groups = byEntry(index, fresh);
		const send = [];
		const bank = [];
		let dropped = 0;
		for (const [entry, list] of groups) {
			out.entries.push(entryLabel(entry));
			if (!known) bank.push(...list);
			else if (credit.isUnlocked(entry, rt.counts, b.redeemed)) send.push(...list);
			else if (index.lockedPolicy === 'bank') bank.push(...list);
			else dropped += list.length;
		}
		out.sent = send.length;
		out.banked = bank.length;
		out.dropped = dropped;
		if (!send.length && !bank.length) return out;
		const title = out.entries[0];
		const next = store().bindings.patch(b.key, {
			pending: [...b.pending, ...send],
			banked: [...b.banked, ...bank],
			lastCredit: { at, title },
		});
		if (send.length && rt.client) rt.client.sendChecks(send);
		record('apmedia-credit', { slot: b.slot, source, title, sent: send.length, banked: bank.length });
		if (!known) {
			for (const [entry, list] of groups) rt.notes.push({ seed: rt.indexSeed, entryKey: contracts.entryKey(entry), ids: list });
			if (rt.notes.length > MAX_NOTES) rt.notes.splice(0, rt.notes.length - MAX_NOTES);
		} else {
			const sentSet = new Set(send);
			const bankSet = new Set(bank);
			for (const [entry, list] of groups) {
				announce(next, creditLine(next, entry, list.filter((id) => sentSet.has(id)), list.filter((id) => bankSet.has(id)), rt.checked, pending, banked));
			}
		}
		if (send.length) maybeGoal(next, rt, index, false);
		return out;
	}

	function creditLine(b, entry, sent, held, checked, pendingBefore, bankedBefore) {
		const mode = announceMode();
		const label = bold(entryLabel(entry));
		const verb = VERB[entry.k] || 'finished';
		if (sent.length) {
			const base = union(checked, pendingBefore);
			if (!credit.entryDone(entry, base) && credit.entryDone(entry, union(base, sent))) {
				return `${ICON.done} ${code(b.slot)} ${verb} ${label}, ${plural(sent.length, 'check')} sent`;
			}
			return mode === 'all' ? `${ICON.progress} ${code(b.slot)} ${label}: ${plural(sent.length, 'check')} sent` : null;
		}
		if (held.length) {
			const base = union(checked, pendingBefore, bankedBefore);
			if (!credit.entryDone(entry, base) && credit.entryDone(entry, union(base, held))) {
				return `${ICON.locked} ${code(b.slot)} ${verb} ${label}, ${plural(held.length, 'check')} waiting for its unlock`;
			}
			return mode === 'all' ? `${ICON.locked} ${code(b.slot)} ${label}: ${plural(held.length, 'check')} waiting for its unlock` : null;
		}
		return null;
	}

	// Sent on every Connected once reached (the server keeps a goal, so a repeat is harmless and a
	// goal lost to a dropped socket is sent again), elsewhere only until it went once. Never
	// announced: the relay posts the room's own Goal line.
	function maybeGoal(b, rt, index, always) {
		const client = rt.client;
		if (!b || !index || !client || !client.isReady) return;
		if (b.goalSent && !always) return;
		const { done, goalCount } = credit.progress(index, union(rt.checked, b.pending));
		if (done < goalCount) return;
		if (!client.sendGoal()) return;
		if (b.goalSent) return;
		store().bindings.patch(b.key, { goalSent: true });
		log().info(`Plex Media: ${b.slot} reached its goal (${done} of ${index.entries.length} finished, ${goalCount} needed).`);
		record('apmedia-goal', { slot: b.slot, done, goal: goalCount });
	}

	// --- the game clients ------------------------------------------------------------------

	// The server matches a slot name exactly. A name linked before the watch had read the room is
	// put in the room's spelling once the watch knows it, rather than after an InvalidSlot refusal.
	function canonicalize(b) {
		let d = null;
		try {
			d = monitor().describeSlot(b.watchId, b.slot);
		} catch (_) {}
		if (!d || !d.known || !d.canonical || d.canonical === b.slot) return b;
		return store().bindings.patch(b.key, { slot: d.canonical }) || b;
	}

	function buildClient(binding, watch) {
		const rt = runtimeOf(binding.key);
		dropClient(rt);
		if (!running) return null;
		const b = canonicalize(binding);
		const Ctor = Client();
		const watchId = b.watchId;
		const client = new Ctor({
			label: `apmedia:${b.slot}`,
			slot: b.slot,
			resolveWatch: () => {
				const w = monitor().getWatch(watchId);
				return w ? { target: w.target, password: w.password || null } : null;
			},
			hasSlotData: (seed, slot) => store().cache.has(seed, slot),
		});
		rt.client = client;
		rt.counts = null;
		rt.connection = 'connecting';
		rt.detail = null;
		rt.targetSig = signature(watch);
		if (watch.channelId) rt.channelId = String(watch.channelId);
		client.on('status', (s) => {
			if (rt.client !== client || !s) return;
			rt.connection = s.state;
			rt.detail = s.detail || null;
		});
		client.on('connected', (info) => queue(() => onConnected(rt, client, info), `${b.slot}'s connection`));
		client.on('items', (info) => queue(() => onItems(rt, client, info), `${b.slot}'s items`));
		client.on('checked', (info) => queue(() => onChecked(rt, client, info), `${b.slot}'s checks`));
		client.on('fatal', (info) => queue(() => onFatal(rt, client, info), `${b.slot}'s refusal`));
		client.on('orphaned', () => queue(() => onOrphaned(rt, client), `${b.slot}'s lost watch`));
		store().bindings.patch(b.key, {
			lastTarget: { target: watch.target || null, hasPassword: !!watch.password },
			watchChannelId: watch.channelId ? String(watch.channelId) : null,
		});
		client.start();
		return client;
	}

	// Never stop() then start() one client: packets still queued from its old socket would run.
	function dropClient(rt) {
		const client = rt.client;
		rt.client = null;
		rt.counts = null;
		rt.connection = 'stopped';
		if (!client) return;
		try {
			client.stop();
		} catch (_) {}
		client.removeAllListeners();
	}

	function onConnected(rt, client, info) {
		if (rt.client !== client) return;
		const b = store().bindings.get(rt.key);
		if (!b || !CREDITED.has(b.state)) {
			dropClient(rt);
			return;
		}
		const seed = info && info.seedName ? String(info.seedName) : null;
		if (!seed) {
			refuse(b, rt, 'seed', ['the room did not say which seed it runs']);
			return;
		}
		if (b.seedName && seed !== b.seedName) {
			goStale(b, rt, seed);
			return;
		}
		// A binding is unique per watch, and two watches can point at one room: the same slot bound
		// twice would credit one list with two people's watching and spend its Wild Tickets twice.
		// The binding that holds the seed first keeps it.
		const twin = bindings().find((o) => o.key !== b.key && o.seedName === seed && CREDITED.has(o.state)
			&& o.slot.toLowerCase() === b.slot.toLowerCase()
			&& !(o.state === 'refused' && o.stateDetail && o.stateDetail.reason === 'duplicate'));
		if (twin) {
			refuse(b, rt, 'duplicate', [`watch #${twin.watchId}`]);
			return;
		}
		const sent = info.slotData || null;
		let index = rt.index && rt.indexSeed === seed ? rt.index : null;
		if (!index) {
			const slotData = sent || store().cache.read(seed, b.slot);
			if (!slotData) {
				// The cache said it held the copy, so this Connect asked for none; a fresh client asks.
				if (!rt.refetched) {
					rt.refetched = true;
					log().warn(`Plex Media: the cached slot_data of ${b.slot} went missing; reconnecting to fetch it.`);
					const watch = monitor().getWatch(b.watchId);
					if (watch) buildClient(b, watch);
					else orphan(b, rt);
					return;
				}
				refuse(b, rt, 'slot_data', ['the server sent no slot_data']);
				return;
			}
			try {
				index = credit.indexSlot(slotData);
			} catch (err) {
				// Not kept: with a copy in the cache the next Connect asks the room for none, so a retry
				// would read this one again; and a binding that never stored the seed leaves its copy
				// behind at unlink, since seed folders are released through the bindings' seedName.
				store().cache.drop(seed, b.slot);
				refuse(b, rt, 'slot_data', [errText(err)]);
				return;
			}
		}
		// Written even with an index in hand: the server sends slot_data only when the cache said it
		// held none, so a copy that failed to save is saved now.
		if (sent) store().cache.write(seed, b.slot, sent);
		rt.refetched = false;
		rt.index = index;
		rt.indexSeed = seed;
		rt.badSeed = null;
		rt.checked = new Set([...((info && info.checked) || [])].map(Number));
		rt.checkedSeed = seed;
		rt.counts = null;
		const pending = b.pending.filter((id) => !rt.checked.has(id));
		const banked = b.banked.filter((id) => !rt.checked.has(id));
		const fields = {};
		if (b.seedName !== seed) fields.seedName = seed;
		if (b.state !== 'active') {
			fields.state = 'active';
			fields.stateDetail = null;
			log().info(`Plex Media: ${b.slot} connected after its refusal.`);
		}
		if (pending.length !== b.pending.length) fields.pending = pending;
		if (banked.length !== b.banked.length) fields.banked = banked;
		const next = Object.keys(fields).length ? store().bindings.patch(b.key, fields) : b;
		if (pending.length) client.sendChecks(pending);
		maybeGoal(next, rt, index, true);
		maybeBackfill(next);
	}

	function onItems(rt, client, info) {
		if (rt.client !== client) return;
		const b = store().bindings.get(rt.key);
		const index = rt.index;
		if (!b || !CREDITED.has(b.state) || !index) return;
		rt.counts = credit.unitCounts((info && info.items) || [], index);
		const settled = settleBank(b, rt, index);
		const next = settled.next;
		resolveNotes(next, rt, index);
		for (const line of settled.lines) announce(next, line);
		if (!next.welcomed) welcome(next, rt, index);
		maybeGoal(next, rt, index, false);
	}

	// Under 'ignore' the bank holds only credit from before the inventory was known; a title that
	// turned out locked earns nothing under that policy, so its share goes rather than waiting.
	function settleBank(b, rt, index) {
		const provisional = new Set();
		for (const note of rt.notes) if (note.seed === rt.indexSeed) for (const id of note.ids) provisional.add(id);
		const release = [];
		const keep = [];
		const lines = [];
		for (const [entry, ids] of byEntry(index, b.banked)) {
			if (credit.isUnlocked(entry, rt.counts, b.redeemed)) {
				release.push(...ids);
				// A credit banked only because the inventory was not known yet is announced as what
				// it was (resolveNotes); the rest were waiting for this unlock.
				const waited = ids.filter((id) => !provisional.has(id)).length;
				if (waited) lines.push(`${ICON.unlocked} ${code(b.slot)} ${bold(entryLabel(entry))} unlocked, ${plural(waited, 'check')} sent`);
			} else if (index.lockedPolicy !== 'ignore') {
				keep.push(...ids);
			}
		}
		if (!release.length && keep.length === b.banked.length) return { next: b, lines: [] };
		const next = store().bindings.patch(b.key, { pending: [...b.pending, ...release], banked: keep });
		if (release.length && rt.client) rt.client.sendChecks(release);
		return { next, lines };
	}

	// Credit that came while the inventory was unknown: announced now, against what the room
	// reported, so a title already done before is not announced again. Ids the room had checked
	// already left pending and the bank on Connected, so they count as neither sent nor held.
	function resolveNotes(b, rt, index) {
		const notes = rt.notes.filter((note) => note.seed === rt.indexSeed);
		rt.notes = [];
		if (!notes.length) return;
		const merged = new Map();
		for (const note of notes) {
			const ids = merged.get(note.entryKey) || [];
			for (const id of note.ids) if (!ids.includes(id)) ids.push(id);
			merged.set(note.entryKey, ids);
		}
		const pending = new Set(b.pending);
		const banked = new Set(b.banked);
		for (const [entryKey, ids] of merged) {
			const entry = index.byKey.get(entryKey);
			if (!entry) continue;
			const sent = ids.filter((id) => pending.has(id));
			const held = ids.filter((id) => banked.has(id));
			const pendingBefore = [...pending].filter((id) => !sent.includes(id));
			const bankedBefore = [...banked].filter((id) => !held.includes(id));
			announce(b, creditLine(b, entry, sent, held, rt.checked, pendingBefore, bankedBefore));
		}
	}

	function onChecked(rt, client, info) {
		if (rt.client !== client) return;
		for (const id of (info && info.ids) || []) rt.checked.add(Number(id));
		const b = store().bindings.get(rt.key);
		if (!b || !CREDITED.has(b.state)) return;
		const pending = b.pending.filter((id) => !rt.checked.has(id));
		const banked = b.banked.filter((id) => !rt.checked.has(id));
		const next = pending.length !== b.pending.length || banked.length !== b.banked.length
			? store().bindings.patch(b.key, { pending, banked })
			: b;
		maybeGoal(next, rt, rt.index, false);
	}

	function onFatal(rt, client, info) {
		if (rt.client !== client) return;
		const b = store().bindings.get(rt.key);
		if (!b) {
			dropClient(rt);
			return;
		}
		// The room's own words: kept short, since they are saved with the binding and shown in posts.
		const errors = Array.isArray(info && info.errors) ? info.errors.slice(0, 10).map((e) => clip(e, ROOM_TEXT)) : [];
		refuse(b, rt, clip((info && info.reason) || errors.join(', ') || 'refused', ROOM_TEXT), errors);
	}

	function onOrphaned(rt, client) {
		if (rt.client !== client) return;
		const b = store().bindings.get(rt.key);
		if (b) orphan(b, rt);
		else dropClient(rt);
	}

	function fixFor(b, reason, errors) {
		const has = (name) => reason === name || errors.includes(name);
		if (has('InvalidSlot')) {
			let d = null;
			try {
				d = monitor().describeSlot(b.watchId, b.slot);
			} catch (_) {}
			if (d && d.known && d.canonical && d.canonical !== b.slot) {
				return `The room spells it ${code(d.canonical)}: \`/apmedia retry\` connects with that spelling.`;
			}
			if (d && d.known && !d.canonical) {
				return 'The room has no slot by that name, so it is probably on a new seed: link that seed\'s slot with `/apmedia link`.';
			}
			return `The room has no slot spelled exactly ${code(b.slot)}: check its case, then \`/apmedia retry\`, or link a new seed's slot with \`/apmedia link\`.`;
		}
		if (has('InvalidGame')) {
			return 'That slot plays another game in this room, not Plex Media: `/apmedia unlink` it and link the room\'s Plex Media slot.';
		}
		if (has('InvalidPassword')) {
			let managed = false;
			try {
				managed = !!(monitor().getWatch(b.watchId) || {}).managed;
			} catch (_) {}
			return managed
				? 'The room\'s password changed: set it in `/config` (Archipelago, Room password), then `/apmedia retry`.'
				: `The room's password changed: set it with \`${cfg().commandPrefix || '!'}ap password ${b.watchId} <password>\`, then \`/apmedia retry\`.`;
		}
		if (has('IncompatibleVersion')) {
			return `The room was hosted with an exact-version compatibility setting, and the bot's client reports ${clientVersion()}: host it with the default compatibility, then \`/apmedia retry\`.`;
		}
		if (reason === 'slot_data') {
			// The error can quote the room's own slot_data, and a room server can send any text.
			return `Its slot_data is not Plex Media data this bot can read (${code(clip(errors[0] || 'unknown', ROOM_TEXT))}): the seed may come from another version of the apworld.`;
		}
		if (reason === 'duplicate') {
			return `This seed's ${code(b.slot)} is linked on ${errors[0] || 'another watch'} already, and only that link counts: \`/apmedia unlink\` this one.`;
		}
		return 'Fix that, then `/apmedia retry`.';
	}

	function refuse(b, rt, reason, errors) {
		dropClient(rt);
		const repeat = b.state === 'refused' && !!b.stateDetail && b.stateDetail.reason === reason;
		const fix = fixFor(b, reason, errors);
		store().bindings.patch(b.key, { state: 'refused', stateDetail: { reason, errors, at: now(), fix } });
		log().warn(`Plex Media: the room refused ${b.slot} (${reason}).`);
		record('apmedia-refused', { slot: b.slot, watchId: b.watchId, reason });
		// A start() retries every refused slot; the same refusal again needs no second notice.
		if (!repeat) notice(b, `${ICON.refused} ${code(b.slot)}: the room refused its Plex Media client (${code(reason)}). ${fix}`);
	}

	function orphan(b, rt) {
		dropClient(rt);
		if (b.state === 'orphaned') return;
		const fix = `Once the room is watched again: \`/apmedia retry\` if it is back as watch #${b.watchId}, or \`/apmedia unlink\` and \`/apmedia link\` the slot on its new watch.`;
		store().bindings.patch(b.key, { state: 'orphaned', stateDetail: { reason: 'orphaned', errors: [], at: now(), fix } });
		log().warn(`Plex Media: watch #${b.watchId} of ${b.slot} is gone.`);
		record('apmedia-orphaned', { slot: b.slot, watchId: b.watchId });
		notice(b, `${ICON.orphaned} ${code(b.slot)}: watch #${b.watchId} is gone, so its Plex Media client stopped and nothing more counts for it. ${fix}`);
	}

	function goStale(b, rt, seed) {
		dropClient(rt);
		const fix = '`/apmedia retry` adopts the new seed (the old seed\'s progress does not carry over), or `/apmedia unlink` it.';
		store().bindings.patch(b.key, {
			state: 'stale',
			stateDetail: { reason: 'stale', errors: [], at: now(), oldSeed: b.seedName, newSeed: seed, fix },
		});
		log().warn(`Plex Media: the room of ${b.slot} moved to another seed.`);
		record('apmedia-stale', { slot: b.slot, watchId: b.watchId });
		notice(b, `${ICON.stale} ${code(b.slot)}: the room is on another seed now, so this list from the old seed no longer counts. ${fix}`);
	}

	function welcome(b, rt, index) {
		const next = store().bindings.patch(b.key, { welcomed: true });
		const checked = union(rt.checked, b.pending);
		const open = index.entries.filter((e) => credit.entryStatus(e, rt.counts, b.redeemed, checked) === 'ready');
		const shown = open.slice(0, WELCOME_TITLES).map((e) => `${md(entryLabel(e))} (${formatDuration(e.d)})`);
		const more = open.length > shown.length ? `, and ${open.length - shown.length} more` : '';
		const titles = shown.length ? `: ${shown.join(', ')}${more}` : '';
		const account = accountOf(b.userId);
		const videos = index.entries.filter((e) => e.k === 'movie' || e.k === 'episode').length;
		let plex;
		if (account && account.consent === 'granted') {
			// The channel is public, and the Plex account names are the owner's to hand out (the
			// account list goes only to them): /apmedia status names it to the player.
			plex = account.implicit ? `Plex account: ${accountText(account)}.` : 'Plex account: linked.';
		} else {
			const why = account ? 'waiting for its consent' : 'none';
			plex = `Plex account: ${why}, so only Discord listening counts for now${videos ? `, and its ${plural(videos, 'video title')} need one` : ''} (the owner links one with \`/apmedia account\`).`;
		}
		const prefix = cfg().commandPrefix || '!';
		const id = b.watchId === 0 ? '' : `${b.watchId} `;
		const lines = [
			`${ICON.welcome} ${code(b.slot)} is in the game with ${open.length} of ${plural(index.entries.length, 'title')} open${titles}. Goal: finish ${index.goalCount}.`,
			plex,
			`\`/apmedia list\` shows the list. To hear when someone needs a title of yours: ${commandCode(`${prefix}ap claim ${id}${b.slot}`)}, then ${commandCode(`${prefix}ap hintpings ${id}${b.slot} dm`)}.`,
		];
		announce(next, lines.join('\n'));
	}

	// --- watches ---------------------------------------------------------------------------

	function reconcile({ retry = false } = {}) {
		if (!running) return;
		const archipelago = !!cfg().archipelagoEnabled;
		const keys = new Set();
		for (const b of bindings()) {
			keys.add(b.key);
			const rt = runtimeOf(b.key);
			indexFor(b);
			if (!CREDITED.has(b.state) || !archipelago) {
				dropClient(rt);
				continue;
			}
			const watch = monitor().getWatch(b.watchId);
			if (!watch) {
				orphan(b, rt);
				continue;
			}
			const sig = signature(watch);
			if (rt.client && rt.targetSig === sig) continue;
			// A refused slot is tried again by start(), /apmedia retry and a change of its room;
			// rebuilding it for any other archipelago* setting would only be refused again.
			if (!rt.client && b.state === 'refused' && !retry && rt.targetSig === sig) continue;
			buildClient(b, watch);
		}
		for (const [key, rt] of runtimes) {
			if (keys.has(key)) continue;
			dropClient(rt);
			runtimes.delete(key);
		}
		for (const b of bindings()) maybeBackfill(b);
	}

	function applyWatchChange(watchId, change) {
		if (!running) return;
		const id = Number(watchId);
		for (const b of bindings()) {
			if (b.watchId !== id) continue;
			const rt = runtimeOf(b.key);
			if (change === 'removed') {
				if (CREDITED.has(b.state)) orphan(b, rt);
				else dropClient(rt);
			} else if (change === 'disabled') {
				dropClient(rt);
			} else if (CREDITED.has(b.state) && cfg().archipelagoEnabled) {
				const watch = monitor().getWatch(id);
				if (watch) buildClient(b, watch);
				else orphan(b, rt);
			}
		}
	}

	// A binding that joins an account the history poll already follows misses the rows that poll
	// has marked seen, and those older than its 7-day window: one read from the seed's start covers
	// both, for this binding alone. An account never polled is read from the floor anyway.
	function maybeBackfill(b) {
		if (!running || !watcher || !b || !CREDITED.has(b.state)) return;
		const seed = b.seedName;
		const accountId = consentedAccount(b.userId);
		const index = indexFor(b);
		if (!seed || !accountId || !index || b.backfillSeed === seed || backfilling.has(b.key)) return;
		if (!store().marks.get(accountId)) {
			store().bindings.patch(b.key, { backfillSeed: seed });
			return;
		}
		backfilling.add(b.key);
		const key = b.key;
		watcher.backfill({ accountId, floorS: Math.floor(index.generatedAtMs / 1000), deliver: (event) => handleEvent(event, key) })
			.then(() => queue(() => {
				const current = store().bindings.get(key);
				if (current && current.seedName === seed) store().bindings.patch(key, { backfillSeed: seed });
			}, 'a backfill'))
			.catch((err) => log().warn(`Plex Media: could not read the Plex history of ${b.slot} from its seed's start:`, errText(err)))
			.finally(() => backfilling.delete(key));
	}

	// --- announcements ---------------------------------------------------------------------

	function announceMode() {
		const mode = cfg().apMediaAnnounce;
		const spec = contracts.SETTINGS.apMediaAnnounce;
		return spec.values.includes(mode) ? mode : spec.default;
	}

	function batchMs() {
		const seconds = Number(cfg().archipelagoBatchSeconds);
		return Math.max(1000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000);
	}

	function channelFor(b) {
		const configured = String(cfg().apMediaChannelId || '').trim();
		if (configured) return configured;
		let watch = null;
		try {
			watch = monitor().getWatch(b.watchId);
		} catch (_) {}
		if (watch && watch.channelId) return String(watch.channelId);
		// The watch may be gone (that is what an orphan notice says), so its channel is kept too.
		const rt = runtimes.get(b.key);
		return (rt && rt.channelId) || (b.watchChannelId ? String(b.watchChannelId) : null);
	}

	/** A credit line: off with apMediaAnnounce 'off' or the binding's own announce flag. */
	function announce(b, line) {
		if (!line || !b || b.announce === false || announceMode() === 'off') return;
		post(channelFor(b), line);
	}

	/** A refusal, a lost watch or a new seed: posted whatever the announce settings, it needs a fix. */
	function notice(b, line) {
		post(channelFor(b), line);
	}

	function bufferOf(channelId) {
		let buf = channels.get(channelId);
		if (!buf) {
			buf = { lines: [], timer: null, heldAt: null, dropped: 0, sending: Promise.resolve() };
			channels.set(channelId, buf);
		}
		return buf;
	}

	// Only lines with no Discord client to post them are capped: a running batch empties itself every
	// archipelagoBatchSeconds, and a backfill can bring hundreds of lines into one batch.
	function capHeld(buf) {
		const over = buf.lines.length - MAX_HELD_LINES;
		if (over <= 0) return;
		buf.lines.splice(0, over);
		buf.dropped += over;
	}

	function reportDropped(channelId, buf) {
		if (!buf.dropped) return;
		log().warn(`Plex Media: dropped the oldest ${plural(buf.dropped, 'line')} for channel ${channelId}: at most ${MAX_HELD_LINES} wait while no Discord client can post them.`);
		buf.dropped = 0;
	}

	function post(channelId, line) {
		if (!channelId) {
			log().info(`Plex Media: no channel to post in (set apMediaChannelId): ${line}`);
			return;
		}
		const buf = bufferOf(channelId);
		buf.lines.push(line);
		if (running && kept.discord) {
			arm(channelId, buf);
			return;
		}
		if (buf.heldAt === null) buf.heldAt = now();
		capHeld(buf);
	}

	// One message per channel per archipelagoBatchSeconds, read when the batch starts, so a /config
	// change applies to the next one.
	function arm(channelId, buf) {
		if (buf.timer) return;
		const handle = timers().setTimeout(() => {
			buf.timer = null;
			flush(channelId);
		}, batchMs());
		if (handle && typeof handle.unref === 'function') handle.unref();
		buf.timer = handle;
	}

	function flush(channelId) {
		const buf = channels.get(channelId);
		if (!buf) return Promise.resolve();
		if (buf.timer) {
			timers().clearTimeout(buf.timer);
			buf.timer = null;
		}
		const discord = kept.discord;
		if (!buf.lines.length || !discord) return buf.sending;
		const lines = buf.lines.splice(0);
		buf.heldAt = null;
		reportDropped(channelId, buf);
		buf.sending = buf.sending
			.then(() => sendLines(discord, channelId, buf, lines))
			.catch((err) => log().warn(`Plex Media: posting to channel ${channelId} failed:`, errText(err)));
		return buf.sending;
	}

	// A send through a client !restart destroyed meanwhile goes back in the buffer for the next one,
	// a line at a time, so the held cap and the dropped count stay in lines.
	function requeue(channelId, buf, chunks) {
		buf.lines.unshift(...chunks.flatMap((chunk) => chunk.split('\n')));
		if (buf.heldAt === null) buf.heldAt = now();
		if (running && kept.discord) arm(channelId, buf);
		else capHeld(buf);
	}

	async function sendLines(discord, channelId, buf, lines) {
		const chunks = chunkLines(lines);
		let channel = null;
		try {
			channel = await discord.channels.fetch(channelId);
		} catch (err) {
			if (kept.discord !== discord) return requeue(channelId, buf, chunks);
			log().warn(`Plex Media: channel ${channelId} is unavailable:`, errText(err));
			return;
		}
		if (!channel || typeof channel.send !== 'function') {
			log().warn(`Plex Media: channel ${channelId} cannot take messages.`);
			return;
		}
		for (let i = 0; i < chunks.length; i++) {
			try {
				await channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
			} catch (err) {
				if (kept.discord !== discord) return requeue(channelId, buf, chunks.slice(i));
				log().warn(`Plex Media: a post to channel ${channelId} failed:`, errText(err));
			}
		}
	}

	function holdLines() {
		for (const buf of channels.values()) {
			if (buf.timer) {
				timers().clearTimeout(buf.timer);
				buf.timer = null;
			}
			if (buf.lines.length && buf.heldAt === null) buf.heldAt = now();
			capHeld(buf);
		}
	}

	function releaseHeld() {
		if (!running || !kept.discord) return;
		for (const [channelId, buf] of channels) {
			if (!buf.lines.length) continue;
			if (buf.heldAt !== null && now() - buf.heldAt > HOLD_MS) {
				log().warn(`Plex Media: dropped ${plural(buf.lines.length + buf.dropped, 'line')} for channel ${channelId}, held longer than ${HOLD_MS / 60000} min.`);
				buf.lines.length = 0;
				buf.heldAt = null;
				buf.dropped = 0;
				continue;
			}
			arm(channelId, buf);
		}
	}

	async function flushAll() {
		await Promise.all([...channels.keys()].map((id) => flush(id)));
	}

	// --- lifecycle -------------------------------------------------------------------------

	function ensureWatcher() {
		if (!watcher) {
			const create = deps.createWatcher || require('./apMediaWatch.js').createWatcher;
			watcher = create({
				pms: pms(),
				targets,
				onEvent: (event) => handleEvent(event),
				marks: store().marks,
				config: cfg,
				timers: deps.watcherTimers,
				now: deps.now,
				logger: log(),
			});
		}
		return watcher;
	}

	function attachPlayers() {
		const bot = kept.bot;
		if (bot === attachedBot) return;
		detachPlayers();
		if (!bot) return;
		attachedBot = bot;
		try {
			const voice = voiceModule();
			voiceDetach = voice.attach({
				bot,
				resolve: voice.createResolver(activeIndexes),
				onEvent: (event) => handleEvent(event),
				getConfig: cfg,
				defer: deps.voiceDefer,
				now: deps.now,
			});
		} catch (err) {
			log().warn('Plex Media: voice credit could not start:', errText(err));
		}
		if (!bot.books) return;
		try {
			booksDetach = booksModule().attach({
				books: bot.books,
				bookmarks: bookmarks(),
				catalogStore: catalogStore(),
				users: boundUsers,
				onEvent: (event) => handleEvent(event),
				timers: deps.booksTimers,
				now: deps.now,
			});
		} catch (err) {
			log().warn('Plex Media: audiobook credit could not start:', errText(err));
		}
	}

	function detachPlayers() {
		for (const off of [voiceDetach, booksDetach]) {
			if (!off) continue;
			try {
				off();
			} catch (_) {}
		}
		voiceDetach = null;
		booksDetach = null;
		attachedBot = null;
	}

	function begin() {
		if (running) {
			attachPlayers();
			releaseHeld();
			return { running: true, reason: null };
		}
		running = true;
		startError = null;
		try {
			watchOff = monitor().onWatchChange((e) => queue(() => applyWatchChange(e && e.watchId, e && e.change), 'a watch change'));
			ensureWatcher().start();
			attachPlayers();
		} catch (err) {
			startError = errText(err);
			log().error('Plex Media failed to start:', startError);
			halt();
			return { running: false, reason: startError };
		}
		queue(() => reconcile({ retry: true }), 'start');
		releaseHeld();
		warmPlaylists();
		log().info('Plex Media started.');
		return { running: true, reason: null };
	}

	// Autocomplete never waits on Plex, so without this the first playlist keystroke after a boot
	// would find the cache empty.
	function warmPlaylists() {
		try {
			Promise.resolve(yamlBuilder().playlists('')).catch((err) => {
				log().debug('Plex Media could not read the Plex playlists yet:', errText(err));
			});
		} catch (err) {
			log().debug('Plex Media could not read the Plex playlists yet:', errText(err));
		}
	}

	function halt() {
		if (!running) return;
		running = false;
		if (watchOff) {
			try {
				watchOff();
			} catch (_) {}
			watchOff = null;
		}
		if (watcher) {
			try {
				watcher.stop();
			} catch (_) {}
		}
		detachPlayers();
		for (const rt of runtimes.values()) dropClient(rt);
		holdLines();
	}

	// Once per process, so turning the feature on in /config can start it after a boot that found
	// it off; and once only, or each !restart would add another listener.
	function bindConfig() {
		if (configBound) return;
		configBound = true;
		configStore().onChange((key, value) => {
			if (typeof key !== 'string') return;
			try {
				if (key === 'apMediaEnabled') {
					const on = typeof value === 'boolean' ? value : !!cfg().apMediaEnabled;
					if (on) begin();
					else halt();
				} else if (key === 'apMediaHistorySeconds' || key === 'apMediaSessionSeconds') {
					if (watcher) watcher.rearm();
				} else if (key.startsWith('archipelago') && running) {
					queue(() => reconcile(), 'an Archipelago setting change');
				}
			} catch (err) {
				log().error('Plex Media could not apply a config change:', errText(err));
			}
		});
	}

	/**
	 * Start, or keep the Discord client and bot for a later start when apMediaEnabled is off.
	 * Call after startArchipelagoMonitor and bot.books.start(). Safe to repeat.
	 * @param {{discord?: object, bot?: object}} [opts]
	 * @returns {{running: boolean, reason: string|null}}
	 */
	function start({ discord, bot } = {}) {
		if (discord !== undefined) kept.discord = discord || null;
		if (bot !== undefined) kept.bot = bot || null;
		bindConfig();
		if (!cfg().apMediaEnabled) return { running: false, reason: 'apMediaEnabled is off' };
		return begin();
	}

	/** Stop everything and let go of the Discord client and bot (app/utils.js stop). Safe to repeat. */
	function stop() {
		halt();
		kept.discord = null;
		kept.bot = null;
	}

	// --- reading -----------------------------------------------------------------------------

	function connectionOf(b, rt) {
		if (!running) return 'off';
		if (b.state === 'stale' || b.state === 'orphaned') return b.state;
		if (!cfg().archipelagoEnabled) return 'waiting';
		const client = rt && rt.client;
		if (!client) return b.state === 'refused' ? 'refused' : 'stopped';
		if (client.isReady) return 'connected';
		return rt.connection === 'connected' ? 'connecting' : rt.connection;
	}

	function sessionReach(account, index) {
		if (!watcher || !account || account.consent !== 'granted') return null;
		const last = watcher.lastSession(account.accountId);
		if (!last) return null;
		const hit = index ? credit.hitsFor(index, { ratingKey: last.ratingKey })[0] || null : null;
		const seen = watcher.lastSeen(account.accountId, last.ratingKey);
		const fraction = typeof seen === 'number' ? seen : last.fraction;
		// Floored, since Plex counts a watch only from 90% and 89.6% must not read as 90%; the
		// epsilon keeps 0.29 * 100, which is 28.999... in floating point, at 29.
		const percent = Math.floor(fraction * 100 + 1e-9);
		const video = !!hit && (hit.entry.k === 'movie' || hit.entry.k === 'episode');
		return {
			ratingKey: last.ratingKey,
			entryKey: hit ? contracts.entryKey(hit.entry) : null,
			title: hit ? entryLabel(hit.entry) : null,
			fraction,
			percent,
			at: last.at,
			note: video && fraction < 0.9 ? `${percent}%: Plex counts a watch at 90%` : null,
		};
	}

	function statusRow(b) {
		const rt = runtimes.get(b.key) || null;
		const index = indexFor(b);
		const checked = union(rt && rt.checked, b.pending);
		const { counts, known } = countsFor(rt, index);
		let progress = null;
		let ready = null;
		let locked = null;
		if (index) {
			progress = credit.progress(index, checked);
			ready = 0;
			locked = 0;
			for (const entry of index.entries) {
				const s = credit.entryStatus(entry, counts, b.redeemed, checked);
				if (s === 'ready') ready += 1;
				else if (s === 'locked') locked += 1;
			}
		}
		const account = accountOf(b.userId);
		const received = known ? counts.wild : null;
		const detail = b.stateDetail && typeof b.stateDetail === 'object' ? { ...b.stateDetail } : null;
		return {
			key: b.key,
			watchId: b.watchId,
			slot: b.slot,
			userId: b.userId,
			state: b.state,
			stateDetail: detail,
			seedName: b.seedName,
			label: index ? index.label : null,
			connection: connectionOf(b, rt),
			indexKnown: !!index,
			inventoryKnown: known,
			done: progress ? progress.done : null,
			total: progress ? progress.total : null,
			goalCount: index ? index.goalCount : null,
			goalPercent: index ? index.goalPercent : null,
			goalReached: !!progress && progress.done >= progress.goalCount,
			goalSent: b.goalSent,
			ready,
			locked,
			pending: b.pending.length,
			banked: b.banked.length,
			wildTickets: { received, used: b.wildUsed, available: received === null ? null : Math.max(0, received - b.wildUsed) },
			account: account ? { accountId: account.accountId, name: account.name, consent: account.consent, implicit: account.implicit } : null,
			lastSession: sessionReach(account, index),
			lastCredit: b.lastCredit,
			announce: b.announce,
		};
	}

	// Kept in step with connectionOf: its 'off' comes from the first two causes, 'waiting' from the third.
	function stoppedReason() {
		const c = cfg();
		if (!c.apMediaEnabled) return 'Plex Media is off (`apMediaEnabled`), so no slot connects and nothing counts.';
		if (!running) {
			return startError
				? `Plex Media failed to start: ${startError.replace(/\.$/, '')}.`
				: 'Plex Media is not running yet: it starts once the bot is connected to Discord.';
		}
		if (!c.archipelagoEnabled) return 'The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.';
		return null;
	}

	/**
	 * Per-binding status. target: a binding key, a Discord user id (their bindings), or nothing (all).
	 * @returns {{ok: true, message: string, reason: string|null, bindings: object[]}} reason says why
	 *   no slot can connect (rows with connection 'off' or 'waiting') and ends message too; else null
	 */
	function status(target) {
		let list = bindings();
		if (typeof target === 'string' && target.includes('::')) {
			list = list.filter((b) => b.key === target);
		} else if (target !== undefined && target !== null && target !== '') {
			const user = discordIdOf(target);
			list = list.filter((b) => b.userId === user);
		}
		const rows = list.map(statusRow);
		const reason = stoppedReason();
		let message = rows.length ? plural(rows.length, 'Plex Media slot') : 'No Plex Media slot is linked.';
		if (reason) message = `${message.replace(/\.$/, '')}. ${reason}`;
		return { ok: true, message, reason, bindings: rows };
	}

	function hintedEntries(b, index) {
		const out = new Map();
		let rows = null;
		try {
			rows = monitor().listHints(b.watchId);
		} catch (_) {}
		if (!Array.isArray(rows)) return out;
		const slot = b.slot.toLowerCase();
		for (const row of rows) {
			if (!row || String(row.finder || '').toLowerCase() !== slot) continue;
			const location = Number(row.location ?? row.locationId);
			let entries;
			if (Number.isSafeInteger(location) && location > 0) {
				const entry = index.byLocation.get(location);
				entries = entry ? [entry] : [];
			} else {
				const name = typeof row.where === 'string' ? row.where : '';
				entries = name ? index.entries.filter((e) => namesLocation(e, name)) : [];
			}
			for (const entry of entries) {
				const key = contracts.entryKey(entry);
				if (!out.has(key)) out.set(key, []);
				if (row.receiver && !out.get(key).includes(String(row.receiver))) out.get(key).push(String(row.receiver));
			}
		}
		return out;
	}

	// Discord caps a choice value at 100 characters; a long work id makes a longer entry key.
	function refOf(entry, positions) {
		const key = contracts.entryKey(entry);
		return key.length <= 100 ? key : `#${positions.get(entry)}`;
	}

	/**
	 * One slot's list, grouped (movies, each show, albums, each playlist, books).
	 * @returns {object} see apiNotes
	 */
	function list(key, which = 'ready') {
		const b = bindingByKey(key);
		if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
		const state = String(which || 'ready').toLowerCase();
		if (!LIST_STATES.includes(state)) return { ok: false, message: `Pick one of ${LIST_STATES.join(', ')}.` };
		const index = indexFor(b);
		if (!index) return { ok: false, message: `${code(b.slot)} has not connected yet, so its list is not known.` };
		const rt = runtimes.get(b.key) || null;
		const checked = union(rt && rt.checked, b.pending);
		const { counts, known } = countsFor(rt, index);
		const hinted = hintedEntries(b, index);
		const positions = new Map(index.entries.map((e, i) => [e, i + 1]));
		const groups = new Map();
		const totals = { ready: 0, locked: 0, done: 0, total: index.entries.length };
		for (const entry of index.entries) {
			const status = credit.entryStatus(entry, counts, b.redeemed, checked);
			totals[status] += 1;
			const g = groupOf(entry);
			let group = groups.get(g.key);
			if (!group) {
				group = { key: g.key, name: g.name, kind: g.kind, total: 0, ready: 0, locked: 0, done: 0, next: null, rows: [] };
				groups.set(g.key, group);
			}
			group.total += 1;
			group[status] += 1;
			if (status === 'ready' && group.next === null) group.next = entryLabel(entry);
			if (status !== state) continue;
			const entryKey = contracts.entryKey(entry);
			const unit = index.units.get(Number(entry.u));
			const row = {
				entryKey,
				ref: refOf(entry, positions),
				kind: entry.k,
				title: entryLabel(entry),
				runtimeMs: Number(entry.d) || 0,
				runtime: formatDuration(entry.d),
				status,
				hinted: hinted.has(entryKey),
				hintedFor: hinted.get(entryKey) || [],
				unit: unit ? unit.name : null,
				step: Number(entry.s) || 1,
			};
			if (entry.k === 'album' || entry.k === 'mix') {
				const main = credit.entryLocations(entry).main;
				row.tracks = { done: main.filter((id) => checked.has(id)).length, total: main.length };
			}
			group.rows.push(row);
		}
		const shown = [...groups.values()].filter((g) => g.rows.length);
		const note = known ? '' : ' (its items are not reported yet, so this shows what was open at the start)';
		return {
			ok: true,
			message: `${code(b.slot)}: ${totals.ready} ready, ${totals.locked} locked, ${totals.done} done of ${totals.total}${note}.`,
			key: b.key,
			slot: b.slot,
			which: state,
			inventoryKnown: known,
			totals,
			groups: shown,
		};
	}

	/**
	 * A list title from what a person typed: `#n` (list position), an entry key, or a title.
	 * @returns {{ok: true, entry: object, entryKey: string, title: string}|{ok: false, message: string, candidates?: string[]}}
	 */
	function findEntry(key, text) {
		const b = bindingByKey(key);
		if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
		const index = indexFor(b);
		if (!index) return { ok: false, message: `${code(b.slot)} has not connected yet, so its list is not known.` };
		const raw = typeof text === 'string' ? text.trim() : '';
		if (!raw) return { ok: false, message: 'Name a title from the list.' };
		const found = (entry) => ({ ok: true, entry, entryKey: contracts.entryKey(entry), title: entryLabel(entry) });
		const position = /^#(\d+)$/.exec(raw);
		if (position) {
			const entry = index.entries[Number(position[1]) - 1];
			return entry ? found(entry) : { ok: false, message: `The list has no title #${position[1]}.` };
		}
		if (index.byKey.has(raw)) return found(index.byKey.get(raw));
		const wanted = credit.normTitle(raw);
		if (!wanted) return { ok: false, message: 'Name a title from the list.' };
		const pick = (test) => index.entries.filter(test);
		let matches = pick((e) => credit.normTitle(entryLabel(e)) === wanted);
		if (!matches.length) matches = pick((e) => e.k !== 'episode' && credit.normTitle(e.t) === wanted);
		if (!matches.length) matches = pick((e) => credit.normTitle(entryLabel(e)).includes(wanted));
		if (matches.length === 1) return found(matches[0]);
		if (!matches.length) return { ok: false, message: `Nothing on ${code(b.slot)}'s list matches ${bold(raw)}.` };
		const candidates = matches.slice(0, 5).map(entryLabel);
		return { ok: false, message: `Several titles match: ${candidates.map(bold).join(', ')}${matches.length > 5 ? ', ...' : ''}.`, candidates };
	}

	/**
	 * The binding a command means: a binding key or a slot name, among the user's own bindings, or
	 * every binding when `all` is true. Empty text picks the user's only binding.
	 * @returns {{ok: true, key: string, binding: object}|{ok: false, message: string, candidates?: object[]}}
	 */
	function resolveBinding(text, { userId = null, all = false } = {}) {
		const raw = typeof text === 'string' ? text.trim() : '';
		const user = discordIdOf(userId);
		const reachable = (b) => all === true || b.userId === user;
		// A key is scoped like a name: autocomplete offers keys, and Discord takes any text typed
		// instead, so someone else's key would otherwise reach their slot.
		if (raw.includes('::')) {
			const b = bindingByKey(raw);
			if (b && reachable(b)) return { ok: true, key: b.key, binding: summary(b) };
		}
		let pool = bindings().filter(reachable);
		if (raw) pool = pool.filter((b) => b.slot.toLowerCase() === raw.toLowerCase());
		if (pool.length === 1) return { ok: true, key: pool[0].key, binding: summary(pool[0]) };
		if (!pool.length) {
			return { ok: false, message: raw ? `No linked Plex Media slot is called ${code(raw)}.` : 'No Plex Media slot is linked to you.' };
		}
		return {
			ok: false,
			message: `Several slots match: ${pool.map((b) => `${code(b.slot)} on watch #${b.watchId}`).join(', ')}. Name one.`,
			candidates: pool.map(summary),
		};
	}

	/** Bindings of one Discord user, from memory (autocomplete). */
	function bindingsFor(userId) {
		const user = discordIdOf(userId);
		return user ? bindings().filter((b) => b.userId === user).map(summary) : [];
	}

	/** Autocomplete choices for bound slots: [{name, value: binding key}], at most 25; one user's with userId. */
	function slotNames(prefix = '', userId = null) {
		const wanted = String(prefix || '').trim().toLowerCase();
		const anyone = userId === null || userId === undefined;
		const user = anyone ? null : discordIdOf(userId);
		if (!anyone && !user) return [];
		const pool = bindings().filter((b) => (anyone || b.userId === user) && b.slot.toLowerCase().includes(wanted));
		const watches = new Set(pool.map((b) => b.watchId));
		return pool.slice(0, 25).map((b) => ({
			name: (watches.size > 1 || b.watchId !== 0 ? `${b.slot} (watch #${b.watchId})` : b.slot).slice(0, 100),
			value: b.key.slice(0, 100),
		}));
	}

	/** Autocomplete choices for one slot's titles: [{name, value}] (value: entry key or `#n`), at most 25. */
	function titles(key, prefix = '') {
		const b = bindingByKey(key);
		const index = b ? indexFor(b) : null;
		if (!index) return [];
		const wanted = credit.normTitle(prefix || '');
		const positions = new Map(index.entries.map((e, i) => [e, i + 1]));
		const out = [];
		for (const entry of index.entries) {
			const label = entryLabel(entry);
			if (wanted && !credit.normTitle(label).includes(wanted)) continue;
			out.push({ name: label.length > 100 ? `${label.slice(0, 99)}${ELLIPSIS}` : label, value: refOf(entry, positions) });
			if (out.length >= 25) break;
		}
		return out;
	}

	function health() {
		const c = cfg();
		if (!c.apMediaEnabled) return { status: 'disabled', detail: 'apMediaEnabled is false in config/config.js' };
		if (!c.archipelagoEnabled) {
			return { status: 'missing', detail: 'needs the Archipelago monitor (archipelagoEnabled is off): Plex Media slots connect through its watches' };
		}
		const list = bindings();
		const problems = [];
		// Slot names are the players' and refusal reasons the room's, and !diag shows this detail to
		// anyone inside one code block: a backtick in either would end the block early.
		if (!running && startError) problems.push(`failed to start: ${plain(startError, 200)}`);
		const refused = list.filter((b) => b.state === 'refused');
		const orphaned = list.filter((b) => b.state === 'orphaned');
		if (refused.length) {
			const why = firstFew(refused, (b) => `${plain(b.slot)}: ${plain((b.stateDetail && b.stateDetail.reason) || 'refused')}`);
			problems.push(`${plural(refused.length, 'slot')} refused (${why})`);
		}
		if (orphaned.length) {
			problems.push(`${plural(orphaned.length, 'slot')} lost ${orphaned.length === 1 ? 'its' : 'their'} watch (${firstFew(orphaned, (b) => plain(b.slot))})`);
		}
		const wh = watcher ? watcher.health() : null;
		// A pass with no linked account asks Plex nothing, so the failures are an earlier pass's.
		if (wh && wh.accounts !== 0 && wh.historyFailures >= 3) {
			problems.push(`the Plex history read failed ${wh.historyFailures} times in a row (${plain(wh.lastHistoryError || 'no detail', 200)})`);
		}
		if (problems.length) return { status: 'error', detail: problems.join('; ') };
		if (!running) return { status: 'ok', detail: `${plural(list.length, 'slot')}, waiting to start` };
		const connected = list.filter((b) => {
			const rt = runtimes.get(b.key);
			return !!(rt && rt.client && rt.client.isReady);
		}).length;
		return { status: 'ok', detail: `${plural(list.length, 'slot')}, ${connected} connected, ${historyText(wh)}` };
	}

	function historyText(wh) {
		const accounts = wh && typeof wh.accounts === 'number' ? wh.accounts : targets().length;
		if (accounts === 0) return 'no linked accounts';
		if (!wh || !wh.lastHistoryOkAt) return 'Plex history not read yet';
		const minutes = Math.max(0, Math.round((now() - wh.lastHistoryOkAt) / 60000));
		return `Plex history read ${minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`} ago`;
	}

	// --- changing ---------------------------------------------------------------------------

	/**
	 * Bind a slot of a watched room to a Discord user.
	 * @returns {Promise<{ok: boolean, message: string, binding?: object, warnings?: string[]}>}
	 */
	function link({ watchId = 0, slot, userId, by = null } = {}) {
		return api('link', () => {
			const id = Number(watchId);
			if (!Number.isSafeInteger(id) || id < 0) return { ok: false, message: 'A watch id is a whole number (0 is the room /config names).' };
			const name = typeof slot === 'string' ? slot.trim() : '';
			if (!name) return { ok: false, message: 'Name the slot to link.' };
			const user = discordIdOf(userId);
			if (!user) return { ok: false, message: 'That is not a Discord user.' };
			if (!cfg().archipelagoEnabled) {
				return { ok: false, message: 'The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.' };
			}
			const mon = monitor();
			const watch = mon.getWatch(id);
			if (!watch) return { ok: false, message: `There is no watch #${id}. \`/ap list\` shows the watched rooms.` };
			const d = mon.describeSlot(id, name);
			if (d && d.known && d.canonical === null) return { ok: false, message: `The room has no slot called ${code(name)}.` };
			if (d && d.known && d.game !== null && d.game !== contracts.GAME) {
				return { ok: false, message: `${code(d.canonical)} plays ${d.game} in that room, not ${contracts.GAME}.` };
			}
			const canonical = d && d.known && d.canonical ? d.canonical : name;
			const existing = store().bindings.find(id, canonical);
			if (existing) {
				if (existing.userId !== user) {
					return { ok: false, message: `${code(existing.slot)} on watch #${id} is linked to someone else already; they or the owner can \`/apmedia unlink\` it first.` };
				}
				const hint = existing.state === 'active' ? '' : ` It is ${existing.state}: \`/apmedia retry\` reconnects it.`;
				return { ok: true, message: `${code(existing.slot)} is linked already.${hint}`, binding: summary(existing), warnings: [] };
			}
			const b = store().bindings.put({ watchId: id, slot: canonical, userId: user, boundBy: discordIdOf(by) });
			const warnings = [];
			if (!d || !d.known) {
				warnings.push(`The room has not been read yet, so ${code(canonical)} is taken as typed: the server only takes the exact spelling.`);
			} else if (d.game === null) {
				warnings.push('The slot\'s game is not known yet; a slot of another game is refused when it connects.');
			}
			if (!consentedAccount(user)) {
				const account = accountOf(user);
				warnings.push(account
					? 'Their Plex account link waits for their consent, so only Discord listening counts until they accept.'
					: 'No Plex account is linked for them, so only Discord listening counts until the owner links one (`/apmedia account`).');
			}
			if (running && cfg().archipelagoEnabled) buildClient(b, watch);
			log().info(`Plex Media: linked ${canonical} on watch #${id}.`);
			return { ok: true, message: `Linked ${code(canonical)} on watch #${id}.`, binding: summary(b), warnings };
		});
	}

	/** @returns {Promise<{ok: boolean, message: string, binding?: object}>} */
	function unlink(key, by = null) {
		return api('unlink', () => {
			const b = bindingByKey(key);
			if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
			const rt = runtimes.get(b.key);
			if (rt) {
				dropClient(rt);
				runtimes.delete(b.key);
			}
			store().bindings.remove(b.key);
			const unsent = b.pending.length + b.banked.length;
			log().info(`Plex Media: unlinked ${b.slot} on watch #${b.watchId}${by ? ` (by ${discordIdOf(by) || 'someone'})` : ''}.`);
			return {
				ok: true,
				message: `Unlinked ${code(b.slot)}.${unsent ? ` Its ${plural(unsent, 'unsent check')} went with it.` : ''}`,
				binding: summary(b),
			};
		});
	}

	/**
	 * Reconnect a binding. A stale one adopts the room's new seed and starts over.
	 * @returns {Promise<{ok: boolean, message: string, binding?: object}>}
	 */
	function retry(key) {
		return api('retry', () => {
			const b = bindingByKey(key);
			if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
			if (!cfg().archipelagoEnabled) {
				return { ok: false, message: 'The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.' };
			}
			const watch = monitor().getWatch(b.watchId);
			if (!watch) return { ok: false, message: `Watch #${b.watchId} is gone: watch the room again, then \`/apmedia unlink\` and \`/apmedia link\` the slot on its new watch.` };
			const fields = { state: 'active', stateDetail: null };
			let note = '';
			const rt = runtimeOf(b.key);
			if (b.state === 'stale') {
				Object.assign(fields, {
					seedName: null, pending: [], banked: [], redeemed: [], wildUsed: 0,
					goalSent: false, welcomed: false, lastCredit: null, backfillSeed: null,
				});
				forgetSeed(rt);
				note = ' It takes on the room\'s new seed: the old seed\'s progress does not carry over.';
			}
			const next = canonicalize(store().bindings.patch(b.key, fields));
			if (running) buildClient(next, watch);
			return {
				ok: true,
				message: `Reconnecting ${code(next.slot)}${running ? '' : ' once Plex Media is running'}.${note}`,
				binding: summary(next),
			};
		});
	}

	/** The Plex server's accounts for /apmedia account, through the game's own PMS reader. */
	function plexAccounts() {
		return pms().accounts();
	}

	/**
	 * Credit a title by hand. With atMs (ms, or text such as `1h30m` for parseDuration): the
	 * checkpoints up to that point (a span 0..atMs of the title); without: the title finished.
	 * @returns {Promise<{ok: boolean, message: string, title?: string, sent?: number, banked?: number, dropped?: number, provisional?: boolean}>}
	 */
	function creditManual(key, entryRef, { atMs = null } = {}) {
		return api('manual credit', () => {
			const b = bindingByKey(key);
			if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
			if (!CREDITED.has(b.state)) return { ok: false, message: `${code(b.slot)} is ${b.state}, so nothing counts for it: \`/apmedia retry\` first.` };
			const found = findEntry(key, entryRef);
			if (!found.ok) return found;
			const index = indexFor(b);
			const entry = found.entry;
			let event;
			if (atMs !== null && atMs !== undefined && atMs !== '') {
				const ms = typeof atMs === 'string' ? credit.parseDuration(atMs) : Number(atMs);
				if (!Number.isFinite(ms) || ms <= 0) return { ok: false, message: 'Give a time into the title, such as `45m` or `1h30m`.' };
				event = { type: 'span', source: 'manual', fromMs: 0, toMs: ms, at: now() };
			} else {
				event = { type: 'complete', source: 'manual', at: now() };
			}
			const ids = credit.locationsFor(credit.wholeHit(entry), event, index.strict);
			const out = creditIds(b, index, ids, event.at, 'manual');
			const title = bold(found.title);
			let message;
			if (out.sent) message = `${ICON.done} ${title}: ${plural(out.sent, 'check')} sent.`;
			else if (out.banked && out.provisional) message = `${ICON.locked} ${title}: ${plural(out.banked, 'check')} held until the room reports ${code(b.slot)}'s items.`;
			else if (out.banked) message = `${ICON.locked} ${title} is locked: ${plural(out.banked, 'check')} waiting for its unlock.`;
			else if (out.dropped) message = `${title} is locked, and this slot ignores locked titles, so nothing counted.`;
			else if (!ids.length) message = `${title} has no check ${event.type === 'span' ? 'up to that point' : 'left'} to earn.`;
			else message = `Nothing new: ${title}'s checks up to there were counted already.`;
			return { ok: true, message, title: found.title, sent: out.sent, banked: out.banked, dropped: out.dropped, provisional: out.provisional };
		});
	}

	/**
	 * Spend a Wild Ticket on a locked title (a show: every locked episode of that step).
	 * @returns {Promise<{ok: boolean, message: string, opened?: string[], released?: number, ticketsLeft?: number}>}
	 */
	function redeem(key, entryRef) {
		return api('redeem', () => {
			const b = bindingByKey(key);
			if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
			if (!CREDITED.has(b.state)) return { ok: false, message: `${code(b.slot)} is ${b.state}: \`/apmedia retry\` first.` };
			const rt = runtimes.get(b.key);
			const index = indexFor(b);
			if (!rt || !rt.counts || !index) {
				return { ok: false, message: `${code(b.slot)} has not reported its items yet, so its Wild Tickets are not known: try again once it is connected.` };
			}
			const found = findEntry(key, entryRef);
			if (!found.ok) return found;
			const entry = found.entry;
			if (credit.entryDone(entry, union(rt.checked, b.pending))) return { ok: false, message: `${bold(found.title)} is done already.` };
			const keys = credit.redeemKeys(index, entry, rt.counts, b.redeemed);
			if (!keys.length) return { ok: false, message: `${bold(found.title)} is open already.` };
			const available = rt.counts.wild - b.wildUsed;
			if (available <= 0) {
				return { ok: false, message: `${code(b.slot)} has no Wild Ticket to spend (${rt.counts.wild} received, ${b.wildUsed} used).` };
			}
			const next = store().bindings.patch(b.key, { redeemed: [...b.redeemed, ...keys], wildUsed: b.wildUsed + 1 });
			const settled = settleBank(next, rt, index);
			for (const line of settled.lines) announce(settled.next, line);
			maybeGoal(settled.next, rt, index, false);
			const opened = keys.map((k) => entryLabel(index.byKey.get(k)));
			const released = settled.next.pending.length - next.pending.length;
			const others = opened.length > 1 ? ` (with ${plural(opened.length - 1, 'more episode')} of that step)` : '';
			const sent = released ? ` ${plural(released, 'banked check')} went out.` : '';
			return {
				ok: true,
				message: `${ICON.ticket} Spent a Wild Ticket on ${bold(found.title)}${others}.${sent} ${plural(available - 1, 'ticket')} left.`,
				opened,
				released,
				ticketsLeft: available - 1,
			};
		});
	}

	/**
	 * Turn a binding's credit lines on or off. on: a boolean, 1 or 0, or one of on/off, true/false,
	 * yes/no, 1/0 in any case; anything else is refused with nothing changed.
	 * @returns {Promise<{ok: boolean, message: string, binding?: object}>}
	 */
	function setAnnounce(key, on) {
		return api('announce', () => {
			const b = bindingByKey(key);
			if (!b) return { ok: false, message: 'There is no such Plex Media slot.' };
			const want = switchOf(on);
			if (want === null) return { ok: false, message: 'Say `on` or `off`.' };
			const next = store().bindings.patch(b.key, { announce: want });
			return { ok: true, message: `Announcements for ${code(next.slot)} are ${next.announce ? 'on' : 'off'}.`, binding: summary(next) };
		});
	}

	/**
	 * Link a Discord user to a Plex account on the server. The owner linking themselves is granted
	 * at once; anyone else's link waits for their consent (grantConsent). An account already linked
	 * to somebody else is refused unless `shared` says both of them use it.
	 * @returns {Promise<{ok: boolean, message: string, account?: object, needsConsent?: boolean, sharedWith?: string[], heldBy?: string[]}>}
	 */
	function linkAccount(userId, { accountId, name = '', by = null, shared = false } = {}) {
		return api('account link', () => {
			const user = discordIdOf(userId);
			if (!user) return { ok: false, message: 'That is not a Discord user.' };
			const id = Number(accountId);
			if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, message: 'A Plex account id is a whole number (1 is the server owner).' };
			// Consent is asked of the person linked, never of whoever else that history belongs to:
			// a second link would credit, announce and filter by somebody else's watching.
			const holders = holdersOf(id, user);
			const label = name ? `${code(name)} (id ${id})` : `${id}`;
			const who = holders.map((h) => (h.implicit ? `<@${h.userId}> (as the server owner)` : `<@${h.userId}>`)).join(', ');
			if (holders.length && shared !== true) {
				return {
					ok: false,
					message: `Plex account ${label} is already linked to ${who}. Unlink it there first, or link it as shared if they use that account together.`,
					heldBy: holders.map((h) => h.userId),
				};
			}
			const owner = discordIdOf(cfg().ownerId);
			const self = !!owner && user === owner && discordIdOf(by) === owner;
			const before = accountOf(user);
			const prev = store().accounts.get(user);
			const same = !!prev && prev.accountId === id && prev.consent === 'granted';
			const consent = self || same ? 'granted' : 'pending';
			store().accounts.set(user, {
				accountId: id,
				name: name ?? '',
				linkedBy: discordIdOf(by),
				consent,
				consentAt: same ? prev.consentAt : undefined,
			});
			if (before && Number(before.accountId) !== id) forgetAccount(before.accountId);
			if (consent === 'granted') for (const b of bindings()) if (b.userId === user) maybeBackfill(b);
			const account = accountOf(user);
			const also = holders.length ? `, shared with ${who}` : '';
			return {
				ok: true,
				message: consent === 'granted'
					? `Linked to Plex account ${accountText(account)}${also}: its Plex history counts for their slots.`
					: `Linked to Plex account ${accountText(account)}${also}, waiting for their consent: nothing is read until they accept.`,
				account,
				needsConsent: consent === 'pending',
				sharedWith: holders.map((h) => h.userId),
			};
		});
	}

	/**
	 * @param {string} userId
	 * @param {{linkedAt?: number}} [opts] the link the user was shown: a re-link since then is not granted
	 * @returns {Promise<{ok: boolean, message: string, account?: object}>}
	 */
	function grantConsent(userId, { linkedAt } = {}) {
		return api('consent', () => {
			const user = discordIdOf(userId);
			const rec = user ? store().accounts.get(user) : null;
			if (!rec) return { ok: false, message: 'There is no Plex account link waiting for you.' };
			// The button checked linkedAt before this task was queued, and the owner may re-link in between.
			if (linkedAt !== undefined && Number(rec.linkedAt) !== Number(linkedAt)) {
				return { ok: false, message: 'The owner has linked your Plex account again since this request: answer the newer one.' };
			}
			if (rec.consent !== 'granted') {
				store().accounts.patch(user, { consent: 'granted' });
				for (const b of bindings()) if (b.userId === user) maybeBackfill(b);
			}
			const account = accountOf(user);
			return { ok: true, message: `Accepted: the Plex history of ${accountText(account)} counts for your Plex Media slots.`, account };
		});
	}

	/**
	 * @returns {Promise<{ok: boolean, message: string, account?: object|null, sharedWith?: string[]}>}
	 *   sharedWith: who else holds account 1 when the owner is read as it again
	 */
	function unlinkAccount(userId) {
		return api('account unlink', () => {
			const user = discordIdOf(userId);
			if (!user) return { ok: false, message: 'That is not a Discord user.' };
			const was = store().accounts.remove(user);
			const account = accountOf(user);
			if (!was) {
				return account && account.implicit
					? { ok: false, message: 'The owner has no linked account to remove: they are read as the server owner (account 1).', account }
					: { ok: false, message: 'No Plex account is linked for them.', account };
			}
			forgetAccount(was.accountId);
			// Linked elsewhere, the owner left account 1 free to link to somebody without `shared`.
			const sharedWith = account && account.implicit ? holdersOf(OWNER_ACCOUNT, user).map((h) => h.userId) : [];
			let after = '';
			if (account && account.implicit) {
				const also = sharedWith.length ? `, which is also linked to ${sharedWith.map((id) => `<@${id}>`).join(', ')}` : '';
				after = ` The owner is read as the server owner (account 1) again${also}.`;
			}
			return { ok: true, message: `Unlinked their Plex account: its history is no longer read.${after}`, account, sharedWith };
		});
	}

	return {
		start,
		stop,
		health,
		builder: yamlBuilder,
		status,
		list,
		findEntry,
		resolveBinding,
		bindingsFor,
		slotNames,
		titles,
		accountOf,
		plexAccounts,
		link,
		unlink,
		retry,
		creditManual,
		redeem,
		setAnnounce,
		linkAccount,
		grantConsent,
		unlinkAccount,
		_internal: {
			handleEvent,
			idle,
			flushAll,
			runtime: (key) => runtimes.get(key) || null,
			watcher: () => watcher,
			targets,
			get running() { return running; },
			get kept() { return { ...kept }; },
		},
	};
}

const shared = createGame();

module.exports = {
	...shared,
	createGame,
	entryLabel,
	formatDuration,
	commandCode,
	escapeText: md,
	HOLD_MS,
};
