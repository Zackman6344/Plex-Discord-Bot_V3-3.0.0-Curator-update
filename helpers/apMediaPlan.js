// helpers/apMediaPlan.js
// What one Plex Media slot adds up to: unlock units and their steps, starting copies, locations,
// checkpoint minutes, the goal count, and the pool's Wild Tickets, Fast Forwards, Remote Controls,
// traps and snacks.
//
// The JS twin of apworld/plex_media/plan.py (spec 4.5). The YAML builder runs it to tell a player
// what a list will be before anything generates, and test/apMediaPlan.test.js checks it against
// test/fixtures/apmedia/plan_cases.json, which plan.py writes. Every rule here is the Python one,
// arithmetic included: the 0.9 cut is decided in integers (minute m counts while
// m * 60000 * 10 < 9 * duration), so a checkpoint right at the cut falls the same way on both sides,
// and the trap split and the snack deal divide as Python's // and % do.
//
// Episodes of one show that share a (season, episode) pair keep their list order, as plan.py's
// sort by (season, episode, list index) does. Any other tie rule moves steps between the two sides.
//
// The pool counts are the ones before exclude_locations: the world takes the useful items' room
// for a list's own excluded watches, tracks and finishes only at generation (plan.exclude_main),
// once the seed's registry names its locations, and writes what it dealt to slot_data's pool.

const contracts = require('./apMediaContracts.js');

const KINDS = new Set(contracts.KINDS);
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
// contracts.LIMITS.checkpointCut (0.9) as an exact fraction.
const CUT_NUMERATOR = 9;
const CUT_DENOMINATOR = 10;

function sum(values) {
	let total = 0;
	for (const v of values) total += Number(v) || 0;
	return total;
}

// Python's Choice and Toggle options also arrive as their integer values, so a fixture written from
// the Python side reads the same here.
function optionValue(key, spec, raw) {
	if (spec.type === 'range') {
		if (!Number.isInteger(raw) || raw < spec.min || raw > spec.max) {
			throw new RangeError(`${key} must be a whole number from ${spec.min} to ${spec.max}.`);
		}
		return raw;
	}
	if (spec.type === 'choice') {
		if (Number.isInteger(raw) && raw >= 0 && raw < spec.values.length) return spec.values[raw];
		if (!spec.values.includes(raw)) throw new RangeError(`${key} must be one of ${spec.values.join(', ')}.`);
		return raw;
	}
	if (spec.type === 'toggle') {
		if (raw === 0 || raw === 1) return raw === 1;
		if (typeof raw !== 'boolean') throw new TypeError(`${key} must be true or false.`);
		return raw;
	}
	return raw;
}

/** The slot's options with every missing key at its default, keyed as the YAML spells them. */
function resolveOptions(options = {}) {
	const out = {};
	for (const [key, spec] of Object.entries(contracts.OPTIONS)) {
		const raw = options ? options[key] : undefined;
		out[key] = raw === undefined || raw === null ? spec.default : optionValue(key, spec, raw);
	}
	return out;
}

function isIndex(v) {
	return Number.isInteger(v) && v >= 0;
}

function checkEntry(entry, index) {
	const where = `Entry ${index}`;
	if (!entry || typeof entry !== 'object') throw new TypeError(`${where} is not an object.`);
	if (!KINDS.has(entry.k)) throw new TypeError(`${where} has an unknown kind ${JSON.stringify(entry.k)}.`);
	if (typeof entry.id !== 'string' || !entry.id) throw new TypeError(`${where} has no id.`);
	if (entry.k === 'episode') {
		if (typeof entry.sid !== 'string' || !entry.sid) throw new TypeError(`${where} has no show id (sid).`);
		if (!isIndex(entry.sn) || !isIndex(entry.en)) throw new TypeError(`${where} needs whole season and episode numbers.`);
	}
	if ((entry.k === 'album' || entry.k === 'mix') && (!Array.isArray(entry.tr) || !entry.tr.length || !entry.tr.every(Array.isArray))) {
		throw new TypeError(`${where} needs at least one track.`);
	}
	if (entry.k === 'book' && (!Array.isArray(entry.pa) || !entry.pa.length || !entry.pa.every(Array.isArray))) {
		throw new TypeError(`${where} needs at least one part.`);
	}
}

/** The entry's timeline length: its own duration, or the tracks or parts end to end. */
function durationOf(entry) {
	if (entry.k === 'album' || entry.k === 'mix') return sum(entry.tr.map((t) => t[3]));
	if (entry.k === 'book') return sum(entry.pa.map((p) => p[2]));
	return Number(entry.d) || 0;
}

function mainCount(entry) {
	if (entry.k === 'album' || entry.k === 'mix') {
		return entry.tr.filter((t) => (Number(t[3]) || 0) >= contracts.LIMITS.minTrackMs).length;
	}
	return 1;
}

/** Checkpoint minutes I, 2I, ... while the minute is before 90% of the duration; none when I is 0. */
function checkpointMinutes(durationMs, interval) {
	const out = [];
	if (!(interval > 0)) return out;
	for (let m = interval; m * MS_PER_MINUTE * CUT_DENOMINATOR < CUT_NUMERATOR * durationMs; m += interval) out.push(m);
	return out;
}

function clamp(value, lo, hi) {
	return Math.max(lo, Math.min(value, hi));
}

function floorDiv(a, b) {
	return Math.floor(a / b);
}

function floorMod(a, b) {
	return ((a % b) + b) % b;
}

/**
 * total shared out in proportion to weights by largest remainder, a tie going to the earlier weight:
 * plan.py's split_by_weight. Some weight must be above 0 whenever total is.
 */
function splitByWeight(total, weights) {
	if (total <= 0) return weights.map(() => 0);
	const whole = sum(weights);
	const counts = weights.map((w) => floorDiv(total * w, whole));
	const ranked = weights.map((_, i) => i).sort((a, b) => floorMod(total * weights[b], whole) - floorMod(total * weights[a], whole) || a - b);
	for (const i of ranked.slice(0, total - sum(counts))) counts[i] += 1;
	return counts;
}

/**
 * The pool beside the unlock copies, as plan.py's _pool deals it: Wild Tickets, then Fast Forwards,
 * then Remote Controls take the room the unlocks leave in the main locations, the rest is filler,
 * trap_percentage of it traps by weight and the other slots snacks in turn.
 */
function poolOf(o, N_main, N_checkpoints, C, S) {
	const room = N_main - (C - S);
	const W = clamp(o.wild_tickets, 0, room);
	const FF = clamp(o.fast_forwards, 0, room - W);
	const RC = clamp(o.remote_controls, 0, room - W - FF);
	const F = N_main + N_checkpoints - (C - S) - W - FF - RC;
	const T = floorDiv(F * o.trap_percentage, 100);
	const trapKeys = Object.keys(contracts.TRAPS);
	const weights = trapKeys.map((key) => o[`${key}_weight`]);
	if (T !== 0 && weights.every((w) => w === 0)) {
		throw new Error(`trap_percentage ${o.trap_percentage} makes ${T} of the list's ${F} filler items traps, but every trap weight is 0 `
			+ '(a trap weight above 0, or trap_percentage 0, would help)');
	}
	const split = splitByWeight(T, weights);
	const traps = Object.fromEntries(trapKeys.map((key, i) => [key, split[i]]));
	const names = Object.keys(contracts.SNACKS);
	const dealt = o.snack_variety ? names : [contracts.NAMES.popcorn];
	const left = F - T;
	const snacks = Object.fromEntries(names.map((name) => [name, 0]));
	dealt.forEach((name, i) => { snacks[name] = floorDiv(left, dealt.length) + (i < floorMod(left, dealt.length) ? 1 : 0); });
	return { W, FF, RC, F, T, traps, snacks };
}

function showSteps(members, entries, rows, tvUnlock, perUnlock) {
	const eps = members
		.map((i) => ({ i, sn: entries[i].sn, en: entries[i].en }))
		.sort((a, b) => a.sn - b.sn || a.en - b.en);
	if (tvUnlock === 'season') {
		const seasons = [...new Set(eps.map((e) => e.sn))];
		const prefix = [0];
		for (const s of seasons) prefix.push(prefix[prefix.length - 1] + eps.filter((e) => e.sn === s).length);
		for (const e of eps) rows[e.i].step = seasons.indexOf(e.sn) + 1;
		return { steps: seasons.length, prefix };
	}
	const n = eps.length;
	const steps = Math.ceil(n / perUnlock);
	const prefix = [];
	for (let c = 0; c <= steps; c++) prefix.push(Math.min(c * perUnlock, n));
	eps.forEach((e, pos) => { rows[e.i].step = Math.ceil((pos + 1) / perUnlock); });
	return { steps, prefix };
}

/**
 * Plans one slot exactly as plan.py does.
 * @param {object[]} entries the list, in YAML order (contracts Entry shape)
 * @param {object} [options] YAML option keys (contracts.OPTIONS); missing keys take their defaults
 * @returns {{
 *   C: number, S: number, W: number, N_main: number, N_checkpoints: number, goal_count: number,
 *   FF: number, RC: number, F: number, T: number,
 *   traps: Object<string, number>, snacks: Object<string, number>,
 *   units: Array<{key: string, steps: number, start: number, prefix: number[]}>,
 *   entries: Array<{key: string, unit: string, step: number, main: number, checkpoints: number[]}>,
 *   options: object, entryCount: number, counts: object, shows: number, locations: number,
 *   durationMs: number, hours: number, startOpen: number, startOpenMs: number, hoursToGoal: number,
 *   byKind: object
 * }}
 */
function planSlot(entries, options = {}) {
	if (!Array.isArray(entries)) throw new TypeError('entries must be an array.');
	const o = resolveOptions(options);
	const tvUnlock = o.tv_unlock;
	const perUnlock = o.episodes_per_unlock;
	const timers = {
		movie: o.timesanity_movies,
		episode: o.timesanity_episodes,
		album: o.timesanity_albums,
		book: o.timesanity_books,
	};

	const keys = new Set();
	const units = new Map();
	const rows = entries.map((entry, index) => {
		checkEntry(entry, index);
		const key = contracts.entryKey(entry);
		if (keys.has(key)) throw new Error(`Entry ${index}: ${key} is on the list twice.`);
		keys.add(key);
		const unit = contracts.unitKey(entry, { tvUnlock, episodesPerUnlock: perUnlock });
		if (!units.has(unit)) units.set(unit, { key: unit, kind: entry.k, members: [] });
		units.get(unit).members.push(index);
		const durationMs = durationOf(entry);
		return {
			key,
			unit,
			step: 1,
			main: mainCount(entry),
			checkpoints: checkpointMinutes(durationMs, timers[contracts.TIMER_KIND[entry.k]]),
			kind: entry.k,
			durationMs,
		};
	});

	const unitList = [...units.values()].map((u) => {
		const shape = u.kind === 'episode'
			? showSteps(u.members, entries, rows, tvUnlock, perUnlock)
			: { steps: 1, prefix: [0, 1] };
		return { key: u.key, kind: u.kind, steps: shape.steps, start: 0, prefix: shape.prefix };
	});

	const C = sum(unitList.map((u) => u.steps));
	const wanted = clamp(Math.max(o.starting_unlocks, Math.ceil(C / contracts.LIMITS.copiesPerStart)), 1, Math.max(1, C - 1));
	// S is what was handed out, as in plan.py: an empty list wants 1 copy and gets 0.
	let S = 0;
	while (S < wanted) {
		let moved = false;
		for (const u of unitList) {
			if (S >= wanted) break;
			if (u.start < u.steps) {
				u.start += 1;
				S += 1;
				moved = true;
			}
		}
		if (!moved) break;
	}

	const N_main = sum(rows.map((r) => r.main));
	const N_checkpoints = sum(rows.map((r) => r.checkpoints.length));
	const { W, FF, RC, F, T, traps, snacks } = poolOf(o, N_main, N_checkpoints, C, S);
	const goal_count = Math.max(1, Math.floor((entries.length * o.goal_percent) / 100));

	const startByUnit = new Map(unitList.map((u) => [u.key, u.start]));
	const counts = Object.fromEntries(contracts.KINDS.map((k) => [k, 0]));
	const byKind = Object.fromEntries(contracts.KINDS.map((k) => [k, { entries: 0, main: 0, checkpoints: 0, ms: 0 }]));
	let durationMs = 0;
	let startOpen = 0;
	let startOpenMs = 0;
	for (const r of rows) {
		counts[r.kind] += 1;
		const b = byKind[r.kind];
		b.entries += 1;
		b.main += r.main;
		b.checkpoints += r.checkpoints.length;
		b.ms += r.durationMs;
		durationMs += r.durationMs;
		if (r.step <= startByUnit.get(r.unit)) {
			startOpen += 1;
			startOpenMs += r.durationMs;
		}
	}
	const hours = durationMs / MS_PER_HOUR;

	return {
		C,
		S,
		W,
		N_main,
		N_checkpoints,
		goal_count,
		FF,
		RC,
		F,
		T,
		traps,
		snacks,
		units: unitList.map((u) => ({ key: u.key, steps: u.steps, start: u.start, prefix: u.prefix })),
		entries: rows.map((r) => ({ key: r.key, unit: r.unit, step: r.step, main: r.main, checkpoints: r.checkpoints })),
		options: o,
		entryCount: entries.length,
		counts,
		shows: unitList.filter((u) => u.kind === 'episode').length,
		locations: N_main + N_checkpoints,
		durationMs,
		hours,
		startOpen,
		startOpenMs,
		hoursToGoal: entries.length ? (hours * goal_count) / entries.length : 0,
		byKind,
	};
}

module.exports = {
	planSlot,
	resolveOptions,
	durationOf,
	checkpointMinutes,
};
