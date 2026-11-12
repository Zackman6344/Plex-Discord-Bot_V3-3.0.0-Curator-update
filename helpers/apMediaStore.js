// helpers/apMediaStore.js
// The Plex Media world's saved state: slot bindings, Plex account links, history marks and each
// slot's cached slot_data.
//
// Bindings are durable (fsync + hourly .bak): a binding's pending and banked checks exist nowhere
// else once the history row behind them is marked seen, so a torn write after a BSOD would lose that
// credit for good. Account links are durable too: they are written only on a link or a consent, and
// losing one silently stops a friend's history being read. History marks are not: a lost mark only
// re-reads history from the seed's start, and the game's dedupe makes the repeats free.
//
// Every read hands back a copy. jsonStore's load() returns the very object persist() writes, so a
// caller editing a returned record would change what the next unrelated write puts on disk. A write
// whose record comes out identical is skipped, because the watcher writes each account's mark on
// every poll.
//
// Records keep fields this module does not know (as JSON), so the game can add one without a change
// here, but never a field named like a password, token or secret, at any depth, and a binding's
// lastTarget keeps only whether the room has a password: the password itself stays in the watch store.
//
// slot_data is cached as one file per seed and slot, outside jsonStore: it can be megabytes, it never
// changes for a seed so it is written once, and a damaged copy is simply deleted and fetched again
// with the next Connect. Seed and slot names come from the AP server, so each path segment is a
// sanitized prefix (only A-Z, a-z, 0-9, _ and -) plus a hash of the full name: no traversal, no drive
// or stream colon, never a dot after a device name (`CON.x`), never exactly a device name because of
// the hash, and two names that sanitize alike stay apart. Slot names fold case, as AP's do.
//
// Under the test runner, as with jsonStore, nothing touches disk unless the env var is set.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contracts = require('./apMediaContracts.js');
const { createStore } = require('./jsonStore.js');
const logger = require('./logger.js');

const FEATURE = 'Plex Media';
const ROOT = path.join(__dirname, '..');
const PREFIX_MAX = 32;
const HASH_HEX = 12;
const SECRET_FIELD = /password|token|secret/i;
const DISCORD_ID = /^\d{1,32}$/;

const BINDING_FIELDS = new Set([
	'key', 'watchId', 'slot', 'userId', 'boundAt', 'boundBy', 'seedName', 'state', 'stateDetail',
	'pending', 'banked', 'redeemed', 'wildUsed', 'goalSent', 'announce', 'welcomed', 'lastCredit', 'lastTarget',
]);
const ACCOUNT_FIELDS = new Set(['userId', 'accountId', 'name', 'linkedAt', 'linkedBy', 'consent', 'consentAt']);
const MARK_FIELDS = new Set(['accountId', 'newestViewedAt', 'seen']);

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function own(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function items(value) {
	if (value instanceof Set || Array.isArray(value)) return [...value];
	return [];
}

function idList(value) {
	const out = [];
	const seen = new Set();
	for (const v of items(value)) {
		if (typeof v !== 'number' && typeof v !== 'string') continue;
		const n = Number(v);
		if (v === '' || !Number.isSafeInteger(n) || n <= 0 || seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

function stringList(value) {
	const out = [];
	const seen = new Set();
	for (const v of items(value)) {
		if (typeof v !== 'string' && typeof v !== 'number') continue;
		const s = String(v);
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

function timeOf(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function textOrNull(value) {
	if (value === null || value === undefined) return null;
	const s = String(value);
	return s ? s : null;
}

// A snowflake is past 2^53: one that went through Number() has lost digits and names somebody else,
// so a number is taken only while it is exact, and one that is not throws rather than bind or read
// the wrong person.
function discordId(value) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new TypeError(`A Discord user id must be a string of digits; the number ${value} cannot hold one exactly.`);
	}
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const s = String(value).trim();
	return DISCORD_ID.test(s) ? s : null;
}

function stripSecrets(value) {
	if (Array.isArray(value)) return value.map(stripSecrets);
	if (!value || typeof value !== 'object') return value;
	const out = {};
	for (const [k, v] of Object.entries(value)) if (!SECRET_FIELD.test(k)) out[k] = stripSecrets(v);
	return out;
}

/** A JSON copy with every field named like a password, token or secret dropped, at any depth. */
function withoutSecrets(value) {
	return stripSecrets(clone(value));
}

/** Unknown fields, JSON-cloned so memory holds what a restart would read back, secrets left out. */
function extras(input, known) {
	const out = {};
	for (const [k, v] of Object.entries(input)) {
		if (known.has(k) || SECRET_FIELD.test(k) || v === undefined) continue;
		out[k] = withoutSecrets(v);
	}
	return out;
}

// An undefined field is one not given, as it is for unknown fields above. Spread in as it is, it
// would reach the shaper as "no value" and take the default: `{banked: next.banked}` with nothing
// new would empty the banked checks, hand back spent Wild Tickets or revoke a consent.
function given(fields) {
	if (fields === null || fields === undefined) return {};
	if (typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('A patch must be an object of fields.');
	return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/**
 * The binding key: `<watchId>::<slot, trimmed and lower-cased>`. AP slot names are unique per seed
 * regardless of case, so two spellings of one slot share a binding.
 * @returns {string|null} null when the watch id or the slot is unusable
 */
function bindingKey(watchId, slot) {
	if (watchId === null || watchId === undefined || watchId === '') return null;
	const watch = Number(watchId);
	if (!Number.isSafeInteger(watch) || watch < 0) return null;
	const name = typeof slot === 'string' ? slot.trim() : '';
	return name ? `${watch}::${name.toLowerCase()}` : null;
}

/**
 * One cache path segment for a name from the AP server (see the header).
 * @returns {string|null} null for an empty name
 */
function safeSegment(name) {
	const raw = typeof name === 'string' || typeof name === 'number' ? String(name) : '';
	if (!raw) return null;
	const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, HASH_HEX);
	const prefix = raw
		.normalize('NFKC')
		.replace(/[^A-Za-z0-9_-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^[_-]+|[_-]+$/g, '')
		.slice(0, PREFIX_MAX)
		.replace(/[_-]+$/, '');
	return `${prefix || 'x'}-${hash}`;
}

function shapeBinding(input, now) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('A Plex Media binding must be an object.');
	}
	const key = bindingKey(input.watchId, input.slot);
	if (!key) throw new TypeError('A Plex Media binding needs a watch id (0 or more) and a slot name.');
	const userId = discordId(input.userId);
	if (!userId) throw new TypeError('A Plex Media binding needs the Discord user id it belongs to.');
	const state = input.state === undefined || input.state === null ? 'active' : input.state;
	if (!contracts.BINDING_STATES.includes(state)) {
		throw new TypeError(`A binding's state must be one of ${contracts.BINDING_STATES.join(', ')}, not ${JSON.stringify(state)}.`);
	}
	const wildUsed = Number(input.wildUsed);
	const credit = input.lastCredit && typeof input.lastCredit === 'object'
		? { at: timeOf(input.lastCredit.at), title: String(input.lastCredit.title ?? '') }
		: null;
	const target = input.lastTarget && typeof input.lastTarget === 'object'
		? { target: withoutSecrets(input.lastTarget.target) ?? null, hasPassword: !!input.lastTarget.hasPassword }
		: null;
	return {
		key,
		watchId: Number(input.watchId),
		slot: input.slot.trim(),
		userId,
		boundAt: timeOf(input.boundAt) ?? now(),
		boundBy: textOrNull(input.boundBy),
		seedName: textOrNull(input.seedName),
		state,
		stateDetail: input.stateDetail === undefined ? null : withoutSecrets(input.stateDetail),
		pending: idList(input.pending),
		banked: idList(input.banked),
		redeemed: stringList(input.redeemed),
		wildUsed: Number.isSafeInteger(wildUsed) && wildUsed > 0 ? wildUsed : 0,
		goalSent: input.goalSent === true,
		announce: input.announce !== false,
		welcomed: input.welcomed === true,
		lastCredit: credit,
		lastTarget: target,
		...extras(input, BINDING_FIELDS),
	};
}

function shapeAccount(input, now) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('A Plex account link must be an object.');
	}
	const accountId = Number(input.accountId);
	if (!Number.isSafeInteger(accountId) || accountId <= 0) {
		throw new TypeError('A Plex account link needs the Plex account id (a whole number, 1 for the owner).');
	}
	const consent = input.consent === undefined || input.consent === null ? 'pending' : input.consent;
	if (!contracts.CONSENT_STATES.includes(consent)) {
		throw new TypeError(`Consent must be one of ${contracts.CONSENT_STATES.join(', ')}, not ${JSON.stringify(consent)}.`);
	}
	return {
		accountId,
		name: contracts.sanitizeText(input.name),
		linkedAt: timeOf(input.linkedAt) ?? now(),
		linkedBy: textOrNull(input.linkedBy),
		consent,
		consentAt: consent === 'granted' ? (timeOf(input.consentAt) ?? now()) : null,
		...extras(input, ACCOUNT_FIELDS),
	};
}

function shapeMark(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('A history mark must be an object.');
	}
	const newest = Number(input.newestViewedAt);
	return {
		newestViewedAt: Number.isFinite(newest) && newest > 0 ? newest : 0,
		seen: stringList(input.seen),
		...extras(input, MARK_FIELDS),
	};
}

function accountKey(accountId) {
	if (accountId === null || accountId === undefined || accountId === '') return null;
	const n = Number(accountId);
	return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

/** Repairs records on read and drops the ones nothing could use, so a hand edit cannot wedge a lookup. */
function migrator(shape, keyOf, label) {
	return (raw) => {
		const out = Object.create(null);
		for (const [k, rec] of Object.entries(raw)) {
			try {
				const shaped = shape(rec, k);
				out[keyOf(shaped, k)] = shaped;
			} catch (err) {
				logger.warn(`${FEATURE}: dropped an unusable ${label} record (${err.message}).`);
			}
		}
		return out;
	};
}

function createRecords(store) {
	function data() {
		return store.load();
	}

	function read(key) {
		const all = data();
		return key !== null && own(all, key) ? clone(all[key]) : null;
	}

	function write(key, record) {
		const all = data();
		if (!own(all, key) || JSON.stringify(all[key]) !== JSON.stringify(record)) {
			all[key] = record;
			store.persist();
		}
		return clone(record);
	}

	function drop(key) {
		const all = data();
		if (key === null || !own(all, key)) return null;
		const was = all[key];
		delete all[key];
		store.persist();
		return clone(was);
	}

	function values() {
		const all = data();
		return Object.keys(all).map((k) => clone(all[k]));
	}

	return { data, read, write, drop, values };
}

function createCache({ dir, memoryOnly }) {
	const memory = new Map();
	let failed = false;

	function locate(seed, slot) {
		const seedPart = safeSegment(seed);
		const slotPart = safeSegment(typeof slot === 'string' ? slot.trim().toLowerCase() : slot);
		if (!seedPart || !slotPart) return null;
		const seedDir = path.join(dir, seedPart);
		return { memKey: `${seedPart}/${slotPart}`, seedPart, seedDir, file: path.join(seedDir, `${slotPart}.json`) };
	}

	function usable(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value)
			&& value.game === contracts.GAME && Array.isArray(value.entries);
	}

	// Parsed, not just found: a Connect that says the slot_data is held gets none on that connection,
	// so a damaged copy noticed only after Connected would leave the binding with no index until
	// something reconnected it. The parse is the one Connected would make, kept for the read after.
	function has(seed, slot) {
		const at = locate(seed, slot);
		if (!at) return false;
		if (memory.has(at.memKey)) return true;
		return !memoryOnly && read(seed, slot) !== null;
	}

	function read(seed, slot) {
		const at = locate(seed, slot);
		if (!at) return null;
		if (memory.has(at.memKey)) return memory.get(at.memKey);
		if (memoryOnly) return null;
		let text;
		try {
			text = fs.readFileSync(at.file, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') logger.warn(`${FEATURE}: could not read cached slot_data ${at.file}: ${err.message}`);
			return null;
		}
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch (_) {
			parsed = null;
		}
		if (!usable(parsed)) {
			logger.warn(`${FEATURE}: cached slot_data ${at.file} is unusable; removed so the next connect fetches it again.`);
			try {
				fs.rmSync(at.file, { force: true });
			} catch (_) {}
			return null;
		}
		memory.set(at.memKey, parsed);
		return parsed;
	}

	function write(seed, slot, slotData) {
		const at = locate(seed, slot);
		if (!at || !usable(slotData)) return false;
		memory.set(at.memKey, slotData);
		if (memoryOnly || fs.existsSync(at.file)) return true;
		const tmp = `${at.file}.tmp`;
		try {
			fs.mkdirSync(at.seedDir, { recursive: true });
			fs.writeFileSync(tmp, JSON.stringify(slotData));
			fs.renameSync(tmp, at.file);
			failed = false;
			return true;
		} catch (err) {
			failed = true;
			logger.warn(`${FEATURE}: could not cache slot_data in ${at.file}: ${err.message}`);
			try {
				fs.rmSync(tmp, { force: true });
			} catch (_) {}
			return false;
		}
	}

	function drop(seed, slot) {
		const at = locate(seed, slot);
		if (!at) return false;
		const held = memory.delete(at.memKey);
		if (memoryOnly) return held;
		const there = fs.existsSync(at.file);
		try {
			fs.rmSync(at.file, { force: true });
		} catch (err) {
			logger.warn(`${FEATURE}: could not remove cached slot_data ${at.file}: ${err.message}`);
		}
		return held || there;
	}

	function dropSeed(seed) {
		const seedPart = safeSegment(seed);
		if (!seedPart) return false;
		let held = false;
		for (const k of [...memory.keys()]) {
			if (k.startsWith(`${seedPart}/`)) {
				memory.delete(k);
				held = true;
			}
		}
		if (memoryOnly) return held;
		const seedDir = path.join(dir, seedPart);
		const there = fs.existsSync(seedDir);
		try {
			fs.rmSync(seedDir, { recursive: true, force: true });
		} catch (err) {
			logger.warn(`${FEATURE}: could not remove the slot_data cache ${seedDir}: ${err.message}`);
		}
		return held || there;
	}

	function reset() {
		memory.clear();
		failed = false;
	}

	return {
		dir,
		memoryOnly,
		has,
		read,
		write,
		drop,
		dropSeed,
		fileFor: (seed, slot) => (locate(seed, slot) || {}).file || null,
		healthy: () => !failed,
		reset,
	};
}

/**
 * A full set of Plex Media stores. Env vars are read now, so a test sets them before calling.
 * @param {{now?: () => number}} [options] clock for boundAt, linkedAt, consentAt and the `.bak` interval
 */
function createApMediaStore({ now = Date.now } = {}) {
	const slotsStore = createStore({
		envVar: contracts.STORES.slots.env,
		defaultPath: path.join(ROOT, contracts.STORES.slots.file),
		key: 'bindings',
		shape: 'object',
		label: 'slot binding',
		feature: FEATURE,
		nullPrototype: true,
		pretty: false,
		durable: true,
		now,
		migrate: migrator((rec) => shapeBinding(rec, now), (shaped) => shaped.key, 'slot binding'),
	});
	const accountsStore = createStore({
		envVar: contracts.STORES.accounts.env,
		defaultPath: path.join(ROOT, contracts.STORES.accounts.file),
		key: 'accounts',
		shape: 'object',
		label: 'account link',
		feature: FEATURE,
		nullPrototype: true,
		durable: true,
		now,
		migrate: migrator((rec, k) => {
			if (!discordId(k)) throw new TypeError(`${JSON.stringify(k)} is not a Discord user id`);
			return shapeAccount(rec, now);
		}, (shaped, k) => discordId(k), 'account link'),
	});
	const marksStore = createStore({
		envVar: contracts.STORES.marks.env,
		defaultPath: path.join(ROOT, contracts.STORES.marks.file),
		key: 'marks',
		shape: 'object',
		label: 'history mark',
		feature: FEATURE,
		nullPrototype: true,
		pretty: false,
		migrate: migrator((rec, k) => {
			if (!accountKey(k)) throw new TypeError(`${JSON.stringify(k)} is not a Plex account id`);
			return shapeMark(rec);
		}, (shaped, k) => accountKey(k), 'history mark'),
	});

	const cacheEnv = process.env[contracts.STORES.cache.env];
	const cache = createCache({
		dir: cacheEnv || path.join(ROOT, contracts.STORES.cache.dir),
		memoryOnly: !!process.env.NODE_TEST_CONTEXT && !cacheEnv,
	});

	const slotRecords = createRecords(slotsStore);
	const accountRecords = createRecords(accountsStore);
	const markRecords = createRecords(marksStore);

	function releaseSeed(seedName) {
		if (!seedName) return;
		const all = slotRecords.data();
		for (const k of Object.keys(all)) if (all[k].seedName === seedName) return;
		cache.dropSeed(seedName);
	}

	const bindings = {
		list: () => slotRecords.values(),
		get: (key) => slotRecords.read(typeof key === 'string' ? key : null),
		find: (watchId, slot) => slotRecords.read(bindingKey(watchId, slot)),
		put(binding) {
			const shaped = shapeBinding(binding, now);
			const was = slotRecords.read(shaped.key);
			const out = slotRecords.write(shaped.key, shaped);
			if (was && was.seedName !== shaped.seedName) releaseSeed(was.seedName);
			return out;
		},
		patch(key, fields) {
			const changes = given(fields);
			const was = slotRecords.read(typeof key === 'string' ? key : null);
			if (!was) return null;
			const shaped = shapeBinding({ ...was, ...changes }, now);
			if (shaped.key !== was.key) throw new TypeError("A patch cannot move a binding to another watch or slot; remove it and put a new one.");
			const out = slotRecords.write(was.key, shaped);
			if (was.seedName !== shaped.seedName) releaseSeed(was.seedName);
			return out;
		},
		remove(key) {
			const was = slotRecords.drop(typeof key === 'string' ? key : null);
			if (was) releaseSeed(was.seedName);
			return was;
		},
		file: slotsStore.file,
		healthy: slotsStore.healthy,
	};

	const withUser = (userId, record) => (record ? { userId, ...record } : null);
	const accounts = {
		get(userId) {
			const key = discordId(userId);
			return withUser(key, accountRecords.read(key));
		},
		set(userId, record) {
			const key = discordId(userId);
			if (!key) throw new TypeError('A Plex account link is keyed by a Discord user id.');
			return withUser(key, accountRecords.write(key, shapeAccount(record, now)));
		},
		patch(userId, fields) {
			const changes = given(fields);
			const key = discordId(userId);
			const was = accountRecords.read(key);
			if (!was) return null;
			return withUser(key, accountRecords.write(key, shapeAccount({ ...was, ...changes }, now)));
		},
		remove(userId) {
			const key = discordId(userId);
			return withUser(key, accountRecords.drop(key));
		},
		list() {
			const all = accountRecords.data();
			return Object.keys(all).map((k) => withUser(k, clone(all[k])));
		},
		file: accountsStore.file,
		healthy: accountsStore.healthy,
	};

	const marks = {
		get: (accountId) => markRecords.read(accountKey(accountId)),
		set(accountId, mark) {
			const key = accountKey(accountId);
			if (!key) throw new TypeError('A history mark is keyed by a Plex account id (a whole number, 1 for the owner).');
			return markRecords.write(key, shapeMark(mark));
		},
		remove: (accountId) => markRecords.drop(accountKey(accountId)),
		list() {
			const all = markRecords.data();
			return Object.keys(all).map((k) => ({ accountId: Number(k), ...clone(all[k]) }));
		},
		file: marksStore.file,
		healthy: marksStore.healthy,
	};

	function health() {
		return {
			bindings: slotsStore.healthy(),
			accounts: accountsStore.healthy(),
			marks: marksStore.healthy(),
			cache: cache.healthy(),
		};
	}

	/** Test seam: forget everything held in memory so the next read comes off disk. */
	function reset() {
		slotsStore.reset();
		accountsStore.reset();
		marksStore.reset();
		cache.reset();
	}

	return {
		bindings,
		accounts,
		marks,
		cache,
		health,
		healthy: () => Object.values(health()).every(Boolean),
		reset,
	};
}

const shared = createApMediaStore();

module.exports = {
	...shared,
	createApMediaStore,
	bindingKey,
	safeSegment,
};
