# apworld/plex_media/plan.py
# One slot's plan from its parsed entries: units, steps, starting copies, locations, the goal and
# what the item pool holds.
#
# helpers/apMediaPlan.js mirrors this so the bot can describe a list before it is generated, and
# test/fixtures/apmedia/plan_cases.json holds this module's answers for that twin to match
# (apworld/tests/make_plan_cases.py writes it). Everything here depends on the entries and options
# alone: no randomness, no set order, no clock, because the !ap next worker rebuilds the seed in
# another process and must land on the same ids, and the bot's twin must count the same pool.

from .constants import (COPIES_PER_START, MAX_COPIES, MAX_ENTRIES, MAX_LOCATIONS, MIN_TRACK_MS, OPTIONS, POPCORN,
                        SNACKS, TIMER_KIND, TRAPS)
from .entries import entry_key
from .naming import track_norm

# CHECKPOINT_CUT (0.9) as an exact fraction, so a checkpoint right at the cut is decided the same
# way on every machine and by the JS twin.
CUT_NUMERATOR = 9
CUT_DENOMINATOR = 10

LOCATION_PREFIX = {"movie": "movie", "episode": "ep", "album": "album", "mix": "mix", "book": "book"}
UNIT_KIND = {"movie": "movie", "episode": "show", "album": "album", "mix": "mix", "book": "book"}
TIMER_OPTION = {"movie": "timesanity_movies", "episode": "timesanity_episodes", "album": "timesanity_albums",
                "book": "timesanity_books"}


class PlanError(ValueError):
	pass


class Unit:
	"""One unlock item's copies: c copies open the first prefix[c] entries of the unit."""
	__slots__ = ("key", "kind", "steps", "prefix", "start", "first")

	def __init__(self, key, kind, first):
		self.key = key
		self.kind = kind
		self.first = first
		self.steps = 1
		self.prefix = [0, 1]
		self.start = 0


class PlanEntry:
	__slots__ = ("index", "key", "entry", "unit", "step", "duration", "main", "minutes")

	def __init__(self, index, entry):
		self.index = index
		self.entry = entry
		self.key = entry_key(entry)
		self.unit = None
		self.step = 1
		self.duration = 0
		# (location key, n): n is the track's 1-based position in tr, 0 for watch and finish.
		self.main = []
		self.minutes = []

	@property
	def kind(self):
		return self.entry["k"]

	def checkpoint_key(self, minute):
		return f"{LOCATION_PREFIX[self.kind]}|{self.entry['id']}|@{minute}"

	def location_keys(self):
		return [key for key, _n in self.main] + [self.checkpoint_key(m) for m in self.minutes]


class Plan:
	"""filler counts every item slot left after the unlocks and the useful items, the traps among them;
	traps and snacks are counts by TRAPS key and by SNACKS name, in their tables' order. excluded counts
	the list's own watches, tracks and finishes that exclude_locations names (exclude_main)."""
	__slots__ = ("options", "entries", "units", "unit_by_key", "copies", "start", "wild", "main_count",
	             "checkpoint_count", "goal_count", "fast_forwards", "remote_controls", "filler", "traps", "snacks",
	             "excluded")


def plan_options(options=None):
	"""The plan's options with every missing key at its default (YAML names and values)."""
	merged = {key: spec["default"] for key, spec in OPTIONS.items()}
	merged.update(options or {})
	return merged


def unit_key(entry, season, per):
	if entry["k"] != "episode":
		return entry_key(entry)
	return f"show-season|{entry['sid']}" if season else f"show-ep{per}|{entry['sid']}"


def checkpoint_count(interval, duration):
	"""How many of interval, 2*interval, ... minutes fall before 90% of the duration (ms)."""
	if interval <= 0 or duration <= 0:
		return 0
	return (CUT_NUMERATOR * duration - 1) // (interval * 60000 * CUT_DENOMINATOR)


def checkpoint_minutes(interval, duration):
	return [interval * i for i in range(1, checkpoint_count(interval, duration) + 1)]


def _ceil_div(a, b):
	return -(-a // b)


def _shows(plan, season, per):
	episodes = {}
	for pe in plan.entries:
		if pe.kind == "episode":
			episodes.setdefault(pe.unit, []).append(pe)
	for key, members in episodes.items():
		ordered = sorted(members, key=lambda pe: (pe.entry["sn"], pe.entry["en"], pe.index))
		unit = plan.unit_by_key[key]
		if season:
			seasons = sorted({pe.entry["sn"] for pe in ordered})
			rank = {sn: r for r, sn in enumerate(seasons, 1)}
			sizes = [0] * (len(seasons) + 1)
			for pe in ordered:
				pe.step = rank[pe.entry["sn"]]
				sizes[pe.step] += 1
			unit.steps = len(seasons)
			unit.prefix = [sum(sizes[:c + 1]) for c in range(len(seasons) + 1)]
		else:
			for position, pe in enumerate(ordered, 1):
				pe.step = _ceil_div(position, per)
			count = len(ordered)
			unit.steps = _ceil_div(count, per)
			unit.prefix = [min(c * per, count) for c in range(unit.steps + 1)]


def _locations(pe, timers):
	entry = pe.entry
	kind = pe.kind
	prefix = f"{LOCATION_PREFIX[kind]}|{entry['id']}"
	if kind in ("movie", "episode"):
		pe.duration = entry["d"]
		pe.main = [(f"{prefix}|w", 0)]
	elif kind in ("album", "mix"):
		pe.duration = sum(track[3] for track in entry["tr"])
		pe.main = [(f"{prefix}|t{n}|{track_norm(track[2])}", n)
		           for n, track in enumerate(entry["tr"], 1) if track[3] >= MIN_TRACK_MS]
	else:
		pe.duration = sum(part[2] for part in entry["pa"])
		pe.main = [(f"{prefix}|f", 0)]
	return checkpoint_count(timers[TIMER_KIND[kind]], pe.duration)


def _hand_out(units, wanted):
	given = 0
	while given < wanted:
		before = given
		for unit in units:
			if given == wanted:
				break
			if unit.start < unit.steps:
				unit.start += 1
				given += 1
		if given == before:
			break
	return given


def split_by_weight(total, weights):
	"""total shared out in proportion to weights by largest remainder, a tie going to the earlier weight.

	Whole numbers only, so the JS twin lands on the same counts. Some weight must be above 0 whenever
	total is. A weight of 0 never gains one: the shares left to hand out are fewer than the weights
	with a fraction left over."""
	if total <= 0:
		return [0] * len(weights)
	whole = sum(weights)
	counts = [total * weight // whole for weight in weights]
	ranked = sorted(range(len(weights)), key=lambda i: (-(total * weights[i] % whole), i))
	for i in ranked[:total - sum(counts)]:
		counts[i] += 1
	return counts


def _pool(plan, opts):
	# Unlock copies and useful items together never outnumber the main locations left after the
	# excluded ones, so every checkpoint (EXCLUDED under filler_only) and every excluded watch, track
	# or finish is left a filler item or a trap: AP fills an EXCLUDED location with nothing else.
	room = plan.main_count - (plan.copies - plan.start) - plan.excluded
	plan.wild = max(0, min(opts["wild_tickets"], room))
	plan.fast_forwards = max(0, min(opts["fast_forwards"], room - plan.wild))
	plan.remote_controls = max(0, min(opts["remote_controls"], room - plan.wild - plan.fast_forwards))
	plan.filler = (plan.main_count + plan.checkpoint_count - (plan.copies - plan.start) - plan.wild
	               - plan.fast_forwards - plan.remote_controls)
	due = plan.filler * opts["trap_percentage"] // 100
	weights = [opts[f"{key}_weight"] for key in TRAPS]
	if due and not any(weights):
		raise PlanError(f"trap_percentage {opts['trap_percentage']} makes {due} of the list's {plan.filler} "
		                "filler items traps, but every trap weight is 0 (a trap weight above 0, or "
		                "trap_percentage 0, would help)")
	plan.traps = dict(zip(TRAPS, split_by_weight(due, weights)))
	dealt = list(SNACKS) if opts["snack_variety"] else [POPCORN]
	left = plan.filler - due
	plan.snacks = {name: 0 for name in SNACKS}
	for i, name in enumerate(dealt):
		plan.snacks[name] = left // len(dealt) + (1 if i < left % len(dealt) else 0)


def exclude_main(plan, count):
	"""The pool dealt again with count of the list's watches, tracks and finishes excluded.

	Each one takes a place from the useful items' room, so the useful items that no longer fit go,
	Remote Controls first, then Fast Forwards, then Wild Tickets, and their places become filler,
	trap_percentage of it traps. Only generation knows the exclusions (exclude_locations names
	placeholders until the registry exists), so plan_cases.json and the bot's twin plan without them.
	Raises PlanError when the larger filler is due a trap and every trap weight is 0."""
	plan.excluded = count
	_pool(plan, plan.options)


def plan_slot(entries, options=None):
	"""entries: parsed entries (entries.parse_entries); options: YAML option names to values."""
	opts = plan_options(options)
	season = opts["tv_unlock"] == "season"
	per = opts["episodes_per_unlock"]
	timers = {kind: opts[TIMER_OPTION[kind]] for kind in ("movie", "episode", "album", "book")}
	if len(entries) > MAX_ENTRIES:
		raise PlanError(f"the list has {len(entries)} entries; at most {MAX_ENTRIES} fit in one slot")

	plan = Plan()
	plan.options = opts
	plan.entries = [PlanEntry(index, entry) for index, entry in enumerate(entries)]
	plan.unit_by_key = {}
	for pe in plan.entries:
		pe.unit = unit_key(pe.entry, season, per)
		if pe.unit not in plan.unit_by_key:
			plan.unit_by_key[pe.unit] = Unit(pe.unit, UNIT_KIND[pe.kind], pe.index)
	plan.units = list(plan.unit_by_key.values())
	_shows(plan, season, per)

	plan.copies = sum(unit.steps for unit in plan.units)
	if plan.copies > MAX_COPIES:
		raise PlanError(f"the list needs {plan.copies} unlock copies; at most {MAX_COPIES} fit in one slot "
		                "(fewer episodes, a higher episodes_per_unlock or tv_unlock: season would help)")
	cut_counts = [_locations(pe, timers) for pe in plan.entries]
	plan.main_count = sum(len(pe.main) for pe in plan.entries)
	plan.checkpoint_count = sum(cut_counts)
	total = plan.main_count + plan.checkpoint_count
	if total > MAX_LOCATIONS:
		raise PlanError(f"the list makes {total} locations ({plan.main_count} titles and tracks, "
		                f"{plan.checkpoint_count} checkpoints); at most {MAX_LOCATIONS} fit in one slot "
		                "(longer timesanity timers or fewer titles would help)")
	for pe, count in zip(plan.entries, cut_counts):
		interval = timers[TIMER_KIND[pe.kind]]
		pe.minutes = [interval * i for i in range(1, count + 1)]

	wanted = max(opts["starting_unlocks"], _ceil_div(plan.copies, COPIES_PER_START))
	wanted = min(max(wanted, 1), max(1, plan.copies - 1))
	plan.start = _hand_out(plan.units, wanted)
	plan.goal_count = max(1, len(plan.entries) * opts["goal_percent"] // 100)
	plan.excluded = 0
	_pool(plan, opts)
	return plan


def summary(plan):
	"""The plan as plain data: the shape of an `expect` in plan_cases.json."""
	return {
		"C": plan.copies,
		"S": plan.start,
		"W": plan.wild,
		"N_main": plan.main_count,
		"N_checkpoints": plan.checkpoint_count,
		"goal_count": plan.goal_count,
		"FF": plan.fast_forwards,
		"RC": plan.remote_controls,
		"F": plan.filler,
		"T": sum(plan.traps.values()),
		"traps": dict(plan.traps),
		"snacks": dict(plan.snacks),
		"units": [{"key": u.key, "steps": u.steps, "start": u.start, "prefix": list(u.prefix)} for u in plan.units],
		"entries": [{"key": pe.key, "unit": pe.unit, "step": pe.step, "main": len(pe.main),
		             "checkpoints": list(pe.minutes)} for pe in plan.entries],
	}
