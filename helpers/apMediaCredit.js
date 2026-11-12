// helpers/apMediaCredit.js
// Pure credit logic for Plex Media slots: what a play of something earns, what is unlocked, what is done.
//
// Every location id comes from slot_data; nothing here derives one (see apMediaContracts.js).
//
// locationsFor dispatches on the hit's role, never on the event's source. Voice, Plex history and
// manual credit all report one album track as a 'complete', and treating that as the album's
// completion credited every track and checkpoint after one song.
//
// Spans arrive relative to whatever was playing: a Plexamp session's viewOffset is inside one track
// or one book part. Track and part spans are moved onto the entry's timeline before checkpoints are
// compared, or a book's part 5 would earn the checkpoints of its first half hour.
//
// Every boundary is (from, to]: a checkpoint on the seam between two tracks belongs to the track
// that ends there, and a span that stops exactly on a checkpoint earns it.
//
// One ratingKey can sit in several entries (a playlist track that is also on a listed album), and an
// album position can have twin copies on other drives (`alt`), so lookups return arrays and one play
// credits every entry that holds it.

const contracts = require('./apMediaContracts.js');

const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
// Where the location id sits in a slot_data track tuple: album [rk, index, title, d, partId, loc],
// mix [rk, index, title, d, partId, artist, loc].
const TRACK_LOC = Object.freeze({ album: 5, mix: 6 });
const SUB_ROLE = Object.freeze({ album: 'track', mix: 'track', book: 'part' });

const derivedByEntry = new WeakMap();

function list(value) {
	return Array.isArray(value) ? value : [];
}

/** A positive safe integer id, or null. Ids reach here as numbers, numeric strings or null. */
function idOf(value) {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	if (value === '') return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function msOf(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(value, low, high) {
	return Math.min(Math.max(value, low), high);
}

function stepOf(entry) {
	const s = Number(entry && entry.s);
	return Number.isSafeInteger(s) && s >= 1 ? s : 1;
}

/**
 * The key byTitle uses for one side of "artist|track". The bot's queue carries raw Plex strings
 * while slot_data's went through sanitizeText, so that runs first and both converge. Punctuation,
 * symbols and invisible format characters are dropped rather than spaced, so `Don't` with either
 * apostrophe meets `Dont`.
 * @param {*} value
 * @returns {string}
 */
function normTitle(value) {
	return contracts.sanitizeText(value)
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[\p{P}\p{S}\p{Cf}]+/gu, '')
		.replace(/\s+/gu, ' ')
		.trim();
}

// normTitle keeps marks, so an emoji's variation selector (U+FE0F) outlives the emoji itself.
const MEANINGFUL = /[\p{L}\p{N}]/u;

/**
 * The byTitle key for a track, or null when either side keeps no letter or digit once normalised
 * (a title made only of punctuation or emoji would otherwise match every other one).
 * @returns {string|null}
 */
function titleKey(artist, title) {
	const a = normTitle(artist);
	const t = normTitle(title);
	return MEANINGFUL.test(a) && MEANINGFUL.test(t) ? `${a}|${t}` : null;
}

function buildDerived(entry) {
	const kind = entry.k;
	const spans = [];
	const main = [];
	let durationMs = 0;
	if (kind === 'album' || kind === 'mix') {
		for (const tuple of list(entry.tr)) {
			const t = Array.isArray(tuple) ? tuple : [];
			const d = msOf(t[3]);
			const loc = idOf(t[TRACK_LOC[kind]]);
			spans.push({
				startMs: durationMs,
				endMs: durationMs + d,
				loc,
				rk: idOf(t[0]),
				index: Number(t[1]),
				pid: idOf(t[4]),
				title: t[2],
				artist: kind === 'mix' ? t[5] : entry.ar,
			});
			if (loc !== null) main.push(loc);
			durationMs += d;
		}
	} else if (kind === 'book') {
		for (const tuple of list(entry.pa)) {
			const p = Array.isArray(tuple) ? tuple : [];
			const d = msOf(p[2]);
			spans.push({ startMs: durationMs, endMs: durationMs + d, loc: null, rk: idOf(p[0]), pid: idOf(p[1]) });
			durationMs += d;
		}
		const finish = idOf(entry.f);
		if (finish !== null) main.push(finish);
	} else if (kind === 'movie' || kind === 'episode') {
		durationMs = msOf(entry.d);
		// A book's `w` is its work id; only a movie's or an episode's is the watch location.
		const watch = idOf(entry.w);
		if (watch !== null) main.push(watch);
	}
	const checkpoints = [];
	for (const pair of list(entry.cp)) {
		if (!Array.isArray(pair)) continue;
		const minute = Number(pair[0]);
		const id = idOf(pair[1]);
		if (!Number.isFinite(minute) || minute <= 0 || id === null) continue;
		checkpoints.push({ minute, atMs: minute * MS_PER_MINUTE, id });
	}
	checkpoints.sort((a, b) => a.atMs - b.atMs);
	const role = SUB_ROLE[kind] || null;
	const whole = Object.freeze({ entry, role: 'whole', index: 0, startMs: 0, endMs: durationMs });
	const positions = role
		? spans.map((s, i) => Object.freeze({ entry, role, index: i + 1, startMs: s.startMs, endMs: s.endMs }))
		: [];
	return { kind, durationMs, spans, main, checkpoints, whole, positions };
}

function derive(entry) {
	let info = derivedByEntry.get(entry);
	if (!info) {
		info = buildDerived(entry);
		derivedByEntry.set(entry, info);
	}
	return info;
}

/**
 * The hit that stands for a whole entry: what a movie or episode play, a finished bookmark (by
 * work id) or a manual credit of a title resolves to.
 * @param {object} entry a slot_data entry
 * @returns {{entry: object, role: 'whole', index: 0, startMs: 0, endMs: number}|null}
 */
function wholeHit(entry) {
	return entry && typeof entry === 'object' ? derive(entry).whole : null;
}

/**
 * The slot's location ids for one entry: main (watch, finish, or every track location that is
 * not null, in play order) and checkpoints (ascending).
 * @returns {{main: number[], checkpoints: Array<{minute: number, atMs: number, id: number}>, durationMs: number}}
 */
function entryLocations(entry) {
	const info = derive(entry);
	return { main: info.main.slice(), checkpoints: info.checkpoints.map((cp) => ({ ...cp })), durationMs: info.durationMs };
}

function push(map, key, value) {
	const was = map.get(key);
	if (!was) map.set(key, [value]);
	else if (!was.includes(value)) was.push(value);
}

function choice(value, values, fallback) {
	if (Number.isInteger(value) && value >= 0 && value < values.length) return values[value];
	return values.includes(value) ? value : fallback;
}

function secondsToMs(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

/**
 * Lookups for one slot's slot_data (schema 1).
 * @param {object} slotData
 * @returns {object} see the module's apiNotes; Maps hold arrays of frozen Hit objects
 * @throws {TypeError} when slotData is not Plex Media slot_data of schema 1, or its generated_at
 *   is not a positive number of unix seconds
 */
function indexSlot(slotData) {
	if (!slotData || typeof slotData !== 'object' || Array.isArray(slotData)) {
		throw new TypeError('Plex Media slot_data must be an object.');
	}
	// Quoted short: the message reaches a refusal notice, and a room server can send any value here.
	const quote = (value) => (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: JSON.stringify(String(value).slice(0, 40)));
	if (slotData.game !== undefined && slotData.game !== contracts.GAME) {
		throw new TypeError(`slot_data is for ${quote(slotData.game)}, not ${contracts.GAME}.`);
	}
	if (Number(slotData.schema) !== contracts.SLOT_DATA_SCHEMA) {
		throw new TypeError(`slot_data schema ${quote(slotData.schema)} is not the ${contracts.SLOT_DATA_SCHEMA} this bot reads.`);
	}
	if (!Array.isArray(slotData.entries)) throw new TypeError('slot_data has no entries list.');
	// Credit counts only from the seed's generation (SPEC 1, 4.9). Any older floor would credit
	// what was watched before the game existed: created_at, the YAML's build time, can be weeks early.
	const generatedAt = slotData.generated_at;
	if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || generatedAt <= 0) {
		throw new TypeError('slot_data has no generated_at.');
	}

	const kinds = new Set(contracts.KINDS);
	const entries = slotData.entries.filter((e) => e && typeof e === 'object' && kinds.has(e.k));
	const byKey = new Map();
	const byRk = new Map();
	const byPid = new Map();
	const byWorkId = new Map();
	const byTitle = new Map();
	const byLocation = new Map();
	const byUnit = new Map();

	for (const entry of entries) {
		byKey.set(contracts.entryKey(entry), entry);
		const unit = idOf(entry.u);
		if (unit !== null) push(byUnit, unit, entry);
		const info = derive(entry);
		for (const id of info.main) byLocation.set(id, entry);
		for (const cp of info.checkpoints) byLocation.set(cp.id, entry);

		if (entry.k === 'movie' || entry.k === 'episode') {
			const rk = idOf(entry.rk);
			if (rk !== null) push(byRk, rk, info.whole);
			continue;
		}
		info.spans.forEach((span, i) => {
			const hit = info.positions[i];
			if (span.rk !== null) push(byRk, span.rk, hit);
			if (span.pid !== null) push(byPid, span.pid, hit);
			if (entry.k !== 'book') {
				const key = titleKey(span.artist, span.title);
				if (key) push(byTitle, key, hit);
			}
		});
		if (entry.k === 'album') {
			for (const copy of list(entry.alt)) {
				if (!Array.isArray(copy)) continue;
				list(copy[1]).forEach((pair, i) => {
					const hit = info.positions[i];
					if (!hit || !Array.isArray(pair)) return;
					const rk = idOf(pair[0]);
					const pid = idOf(pair[1]);
					if (rk !== null) push(byRk, rk, hit);
					if (pid !== null) push(byPid, pid, hit);
				});
			}
		}
		if (entry.k === 'book' && entry.w !== undefined && entry.w !== null && String(entry.w)) {
			push(byWorkId, String(entry.w), info.whole);
		}
	}

	const units = new Map();
	for (const u of list(slotData.units)) {
		const id = idOf(u && u.id);
		if (id === null) continue;
		units.set(id, {
			id,
			name: String(u.name ?? ''),
			kind: String(u.kind ?? ''),
			steps: Number(u.steps) || 0,
			start: Number(u.start) || 0,
		});
	}

	const items = slotData.items || {};
	const timer = slotData.timesanity || {};
	const goalPercent = Number(slotData.goal_percent) || contracts.OPTIONS.goal_percent.default;
	const statedGoal = Number(slotData.goal_count);
	const goalCount = Number.isSafeInteger(statedGoal) && statedGoal >= 1
		? statedGoal
		: Math.max(1, Math.floor((entries.length * goalPercent) / 100));
	const statedCount = Number(slotData.entry_count);

	return {
		schema: contracts.SLOT_DATA_SCHEMA,
		worldVersion: String(slotData.world_version ?? ''),
		builder: Number(slotData.builder) || contracts.BUILDER_VERSION,
		entries,
		byKey,
		byRk,
		byPid,
		byWorkId,
		byTitle,
		byLocation,
		byUnit,
		units,
		items: {
			popcorn: idOf(items.popcorn) ?? contracts.IDS.popcorn,
			wildTicket: idOf(items.wild_ticket ?? items.wildTicket) ?? contracts.IDS.wildTicket,
		},
		goalCount,
		goalPercent,
		entryCount: Number.isSafeInteger(statedCount) && statedCount >= 0 ? statedCount : entries.length,
		timesanity: {
			movie: Number(timer.movie) || 0,
			episode: Number(timer.episode) || 0,
			album: Number(timer.album) || 0,
			book: Number(timer.book) || 0,
		},
		lockedPolicy: choice(slotData.locked_watches, contracts.OPTIONS.locked_watches.values, contracts.OPTIONS.locked_watches.default),
		strict: slotData.timesanity_strict === true || slotData.timesanity_strict === 1,
		checkpointItems: choice(slotData.checkpoint_items, contracts.OPTIONS.checkpoint_items.values, contracts.OPTIONS.checkpoint_items.default),
		tvUnlock: choice(slotData.tv_unlock, contracts.OPTIONS.tv_unlock.values, contracts.OPTIONS.tv_unlock.default),
		episodesPerUnlock: Number(slotData.episodes_per_unlock) || contracts.OPTIONS.episodes_per_unlock.default,
		generatedAtMs: generatedAt * 1000,
		createdAtMs: secondsToMs(slotData.created_at),
		label: String(slotData.label ?? ''),
	};
}

/**
 * The hits for what a watcher saw, first match wins: ratingKey, then part id, then work id, then
 * the normalised "artist|title". A ratingKey that matches nothing falls through, so a voice entry
 * from an album copy the list does not know can still match by its part or its title.
 * @param {object} index indexSlot()
 * @param {{ratingKey?: *, partId?: *, workId?: *, artist?: *, title?: *}} what
 * @returns {object[]} hits, possibly empty
 */
function hitsFor(index, what) {
	if (!index || !what) return [];
	const rk = idOf(what.ratingKey);
	if (rk !== null && index.byRk.has(rk)) return index.byRk.get(rk).slice();
	const pid = idOf(what.partId);
	if (pid !== null && index.byPid.has(pid)) return index.byPid.get(pid).slice();
	if (what.workId !== undefined && what.workId !== null && index.byWorkId.has(String(what.workId))) {
		return index.byWorkId.get(String(what.workId)).slice();
	}
	const key = titleKey(what.artist, what.title);
	if (key && index.byTitle.has(key)) return index.byTitle.get(key).slice();
	return [];
}

function guidOf(value) {
	return typeof value === 'string' && value.includes('://') ? value : null;
}

function entryGuids(entry) {
	return [guidOf(entry.g), guidOf(entry.id)].filter(Boolean);
}

/**
 * The hits for a ratingKey the slot does not know, from that item's PMS metadata
 * (apMediaPlex.metadata): a movie by guid, an episode by its show (grandparentGuid, or
 * `rk:<grandparentRatingKey>` for an unmatched show) plus season and episode number, an album
 * track by the album's guid (parentGuid) plus its track number. Track numbers repeat on
 * multi-disc albums, so a number held by more than one position must also match the title.
 * @param {object} index indexSlot()
 * @param {object|null} meta one MediaContainer.Metadata item
 * @returns {object[]}
 */
function hitsForMetadata(index, meta) {
	if (!index || !meta || typeof meta !== 'object') return [];
	const out = [];
	if (meta.type === 'movie') {
		const guid = guidOf(meta.guid);
		if (!guid) return out;
		for (const entry of index.entries) {
			if (entry.k === 'movie' && entryGuids(entry).includes(guid)) out.push(derive(entry).whole);
		}
	} else if (meta.type === 'episode') {
		const shows = [guidOf(meta.grandparentGuid)];
		const showRk = idOf(meta.grandparentRatingKey);
		if (showRk !== null) shows.push(`rk:${showRk}`);
		const sn = Number(meta.parentIndex);
		const en = Number(meta.index);
		if (!Number.isInteger(sn) || !Number.isInteger(en)) return out;
		for (const entry of index.entries) {
			if (entry.k !== 'episode' || !shows.includes(entry.sid)) continue;
			if (Number(entry.sn) === sn && Number(entry.en) === en) out.push(derive(entry).whole);
		}
	} else if (meta.type === 'track') {
		const album = guidOf(meta.parentGuid);
		const number = Number(meta.index);
		if (!album || !Number.isInteger(number)) return out;
		const title = normTitle(meta.title);
		for (const entry of index.entries) {
			if (entry.k !== 'album' || !entryGuids(entry).includes(album)) continue;
			const info = derive(entry);
			let found = info.positions.filter((hit) => info.spans[hit.index - 1].index === number);
			if (found.length > 1) found = found.filter((hit) => normTitle(info.spans[hit.index - 1].title) === title);
			out.push(...found);
		}
	}
	return out;
}

/**
 * The location ids one hit earns from one event (spec 5.3). Deduped; main locations first in
 * play order, then checkpoints ascending. The span of a track or part is read from the entry, so
 * a hit's own startMs/endMs are informational.
 * @param {{entry: object, role: 'whole'|'track'|'part', index: number}} hit
 * @param {{type: 'complete'|'span', fromMs?: number, toMs?: number}} event
 * @param {boolean} strict the slot's timesanity_strict: a completion then earns no checkpoints
 *   beyond those inside a completed track's or part's own span
 * @returns {number[]}
 */
function locationsFor(hit, event, strict) {
	if (!hit || !hit.entry || typeof hit.entry !== 'object' || !event) return [];
	const info = derive(hit.entry);
	let span = null;
	if (hit.role === 'whole') {
		span = { startMs: 0, endMs: info.durationMs };
	} else if (hit.role === SUB_ROLE[info.kind]) {
		const n = Number(hit.index);
		if (!Number.isInteger(n) || n < 1 || n > info.spans.length) return [];
		span = info.spans[n - 1];
	} else {
		return [];
	}

	let main = [];
	let earns;
	if (event.type === 'span') {
		const from = Number(event.fromMs);
		const to = Number(event.toMs);
		if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
		const length = span.endMs - span.startMs;
		const lo = span.startMs + clamp(from, 0, length);
		const hi = span.startMs + clamp(to, 0, length);
		if (!(hi > lo)) return [];
		earns = (atMs) => atMs > lo && atMs <= hi;
	} else if (event.type === 'complete') {
		if (hit.role === 'whole') {
			main = info.main;
			earns = () => !strict;
		} else {
			const n = Number(hit.index);
			const last = n === info.spans.length;
			if (hit.role === 'track') main = span.loc === null ? [] : [span.loc];
			else if (last) main = info.main;
			const inside = (atMs) => (n === 1 ? atMs >= 0 : atMs > span.startMs) && atMs <= span.endMs;
			earns = hit.role === 'part' && last && !strict ? () => true : inside;
		}
	} else {
		return [];
	}
	const out = new Set(main);
	for (const cp of info.checkpoints) if (earns(cp.atMs)) out.add(cp.id);
	return [...out];
}

/**
 * Received items counted by item id. Popcorn and Wild Tickets are not units: they are counted on
 * their own, with their ids read from slot_data's `items` (the contracts' fixed ids otherwise).
 * @param {Array<{item: number}|number>} items NetworkItem objects (start inventory included)
 * @param {object} [source] indexSlot() result or raw slot_data
 * @returns {{units: Map<number, number>, wild: number, popcorn: number}}
 */
function unitCounts(items, source) {
	const named = (source && source.items) || {};
	const popcornId = idOf(named.popcorn) ?? contracts.IDS.popcorn;
	const wildId = idOf(named.wildTicket ?? named.wild_ticket) ?? contracts.IDS.wildTicket;
	const units = new Map();
	let wild = 0;
	let popcorn = 0;
	for (const it of list(items)) {
		const id = idOf(it && typeof it === 'object' ? it.item : it);
		if (id === null) continue;
		if (id === wildId) wild += 1;
		else if (id === popcornId) popcorn += 1;
		else units.set(id, (units.get(id) || 0) + 1);
	}
	return { units, wild, popcorn };
}

function countsMap(counts) {
	if (counts instanceof Map) return counts;
	return counts && counts.units instanceof Map ? counts.units : null;
}

function isRedeemed(entry, redeemed) {
	if (!redeemed) return false;
	const key = contracts.entryKey(entry);
	if (redeemed instanceof Set) return redeemed.has(key);
	return Array.isArray(redeemed) && redeemed.includes(key);
}

/**
 * Whether an entry is open: its unit's received copies reach its step, or a Wild Ticket redeemed it.
 * @param {object} entry
 * @param {Map<number, number>|{units: Map<number, number>}} counts unitCounts() or its `units`
 * @param {Set<string>|string[]} [redeemed] entry keys (`<k>|<id>`)
 */
function isUnlocked(entry, counts, redeemed) {
	if (!entry || typeof entry !== 'object') return false;
	if (isRedeemed(entry, redeemed)) return true;
	const map = countsMap(counts);
	const unit = idOf(entry.u);
	const have = map && unit !== null ? Number(map.get(unit)) || 0 : 0;
	return have >= stepOf(entry);
}

/**
 * The entry keys one Wild Ticket spent on `entry` would add to `redeemed`: the entry itself, or for
 * an episode every locked episode of its show that shares its step (a show opens one step at a
 * time). Empty when it is already open.
 * @returns {string[]}
 */
function redeemKeys(index, entry, counts, redeemed) {
	if (!entry || typeof entry !== 'object' || isUnlocked(entry, counts, redeemed)) return [];
	if (entry.k !== 'episode') return [contracts.entryKey(entry)];
	const unit = idOf(entry.u);
	const peers = (index && unit !== null && index.byUnit.get(unit)) || [entry];
	const step = stepOf(entry);
	return peers
		.filter((e) => stepOf(e) === step && !isUnlocked(e, counts, redeemed))
		.map((e) => contracts.entryKey(e));
}

function idSet(checked) {
	if (checked instanceof Set) return checked;
	const set = new Set();
	for (const v of list(checked)) {
		const id = idOf(v);
		if (id !== null) set.add(id);
	}
	return set;
}

function hasId(set, id) {
	return set.has(id) || set.has(String(id));
}

/**
 * Movie/episode: watched. Album/mix: every track location that is not null. Book: finished.
 * An entry with no main location is never done.
 * @param {object} entry
 * @param {Set<number>|number[]} checked location ids
 */
function entryDone(entry, checked) {
	if (!entry || typeof entry !== 'object') return false;
	const main = derive(entry).main;
	if (!main.length) return false;
	const set = idSet(checked);
	return main.every((id) => hasId(set, id));
}

/** @returns {{done: number, total: number, goalCount: number}} */
function progress(index, checked) {
	const set = idSet(checked);
	let done = 0;
	for (const entry of index.entries) if (entryDone(entry, set)) done += 1;
	return { done, total: index.entries.length, goalCount: index.goalCount };
}

/** @returns {'done'|'ready'|'locked'} */
function entryStatus(entry, counts, redeemed, checked) {
	if (entryDone(entry, checked)) return 'done';
	return isUnlocked(entry, counts, redeemed) ? 'ready' : 'locked';
}

const CLOCK_HMS = /^(\d+):([0-5]\d):([0-5]\d)$/;
// Two parts read as m:ss, the way media players show elapsed time; minutes may pass 59.
const CLOCK_MS = /^(\d+):([0-5]\d)$/;
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const UNITS = new RegExp(
	`^(?:${NUMBER}\\s*h(?:ours?|rs?)?)?\\s*(?:${NUMBER}\\s*m(?:in(?:ute)?s?)?)?\\s*(?:${NUMBER}\\s*s(?:ec(?:ond)?s?)?)?$`,
	'i'
);
// `1h30`: what follows the hours with no unit is minutes.
const HOURS_MINUTES = new RegExp(`^${NUMBER}\\s*h(?:ours?|rs?)?\\s*(\\d+)$`, 'i');
const BARE = new RegExp(`^${NUMBER}$`);

/**
 * A position or a length typed by a person, in ms, or null when it does not parse. Accepts
 * `1h30m`, `1h 30m`, `1h30`, `90m`, `90 min`, `2h`, `45s`, `1.5h`, `1:30:00` (h:mm:ss) and
 * `45:00` (m:ss). A bare number is minutes, the unit every timer and checkpoint uses. A leading
 * `@` is ignored, so a checkpoint name's `@ 1h30m` pastes as is.
 * @param {*} text
 * @returns {number|null}
 */
function parseDuration(text) {
	if (typeof text !== 'string' && typeof text !== 'number') return null;
	const s = String(text).trim().replace(/^@\s*/, '');
	if (!s) return null;
	let ms = null;
	let m;
	if ((m = CLOCK_HMS.exec(s))) {
		ms = Number(m[1]) * MS_PER_HOUR + Number(m[2]) * MS_PER_MINUTE + Number(m[3]) * 1000;
	} else if ((m = CLOCK_MS.exec(s))) {
		ms = Number(m[1]) * MS_PER_MINUTE + Number(m[2]) * 1000;
	} else if ((m = BARE.exec(s))) {
		ms = Number(m[1]) * MS_PER_MINUTE;
	} else if ((m = HOURS_MINUTES.exec(s))) {
		ms = Number(m[1]) * MS_PER_HOUR + Number(m[2]) * MS_PER_MINUTE;
	} else if ((m = UNITS.exec(s)) && (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined)) {
		ms = (Number(m[1]) || 0) * MS_PER_HOUR + (Number(m[2]) || 0) * MS_PER_MINUTE + (Number(m[3]) || 0) * 1000;
	}
	if (ms === null || !Number.isFinite(ms)) return null;
	const rounded = Math.round(ms);
	return Number.isSafeInteger(rounded) ? rounded : null;
}

module.exports = {
	normTitle,
	titleKey,
	indexSlot,
	wholeHit,
	entryLocations,
	hitsFor,
	hitsForMetadata,
	locationsFor,
	unitCounts,
	isUnlocked,
	redeemKeys,
	entryDone,
	progress,
	entryStatus,
	parseDuration,
};
