# apworld/plex_media/slotdata.py
# One slot's slot_data (schema 1): everything the bot needs to credit the list. No AP imports.
#
# The bot never derives an id: every location and item id it sends or counts is read from here, so
# each entry carries its own. Plain JSON only (lists, not tuples or sets): Main converts slot_data
# with convert_to_base_types and the client receives it as JSON. Album and mix durations are the
# sum of their tracks and a book's of its parts, the timeline the checkpoints were cut from.
#
# World 0.3.0 added items.snacks, items.useful, items.traps, snack_bar and pool without a new schema:
# the bot reads a missing key as "this seed has none", so a 0.2.0 seed keeps crediting as it did.
# items.snacks holds Popcorn too, so the bot counts snacks from it alone. pool is what the slot's item
# pool holds after exclude_locations took its share of the useful items, which only generation knows:
# the bot reads what a list holds from it instead of planning it again.

from .constants import GAME, POPCORN_ID, SLOT_DATA_SCHEMA, SNACKS, TRAPS, USEFUL, WILD_TICKET_ID


def _entry(pe, registry):
	entry = pe.entry
	kind = entry["k"]
	location = registry.location_id
	by_position = {n: location[key] for key, n in pe.main}
	checkpoints = [[minute, location[pe.checkpoint_key(minute)]] for minute in pe.minutes]
	out = {"k": kind, "id": entry["id"]}
	if kind in ("movie", "episode", "album"):
		out["rk"] = entry["rk"]
	elif kind == "mix":
		out["pl"] = entry["pl"]
		out["part"] = entry["part"]
	else:
		out["w"] = entry["w"]
	if "g" in entry:
		out["g"] = entry["g"]
	if kind == "movie":
		out.update(t=entry["t"], y=entry["y"])
	elif kind == "episode":
		out.update(sh=entry["sh"], sid=entry["sid"], srk=entry["srk"], sn=entry["sn"], en=entry["en"], t=entry["t"])
	elif kind == "album":
		out.update(ar=entry["ar"], t=entry["t"], y=entry["y"])
	elif kind == "mix":
		out["t"] = entry["t"]
	else:
		out.update(t=entry["t"], au=entry["au"])
	out["d"] = pe.duration
	if kind in ("album", "mix"):
		out["tr"] = [list(track) + [by_position.get(n)] for n, track in enumerate(entry["tr"], 1)]
	if kind == "album":
		out["alt"] = [[copy[0], [list(pair) for pair in copy[1]]] for copy in entry["alt"]]
	if kind == "book":
		out["pa"] = [list(part) for part in entry["pa"]]
	out["u"] = registry.unit_id[pe.unit]
	out["s"] = pe.step
	if kind in ("movie", "episode"):
		out["w"] = by_position[0]
	elif kind == "book":
		out["f"] = by_position[0]
	out["cp"] = checkpoints
	return out


def build_slot_data(plan, registry, info, world_version, generated_at):
	"""plan: plan.Plan; info: entries.parse_list_info(); generated_at: unix seconds.

	Nothing here names a person: the room hands slot_data to any client joined as the slot, and
	archipelago.gg's tracker API serves it to anyone, so list_info's account and discord stay in the
	YAML."""
	opts = plan.options
	return {
		"schema": SLOT_DATA_SCHEMA,
		"game": GAME,
		"world_version": world_version,
		"builder": info["builder"],
		"generated_at": generated_at,
		"created_at": info["created_at"],
		"label": info["label"],
		"goal_percent": opts["goal_percent"],
		"goal_count": plan.goal_count,
		"entry_count": len(plan.entries),
		"tv_unlock": opts["tv_unlock"],
		"episodes_per_unlock": opts["episodes_per_unlock"],
		"locked_watches": opts["locked_watches"],
		"checkpoint_items": opts["checkpoint_items"],
		"timesanity_strict": bool(opts["timesanity_strict"]),
		"timesanity": {
			"movie": opts["timesanity_movies"],
			"episode": opts["timesanity_episodes"],
			"album": opts["timesanity_albums"],
			"book": opts["timesanity_books"],
		},
		"items": {
			"popcorn": POPCORN_ID,
			"wild_ticket": WILD_TICKET_ID,
			"snacks": dict(SNACKS),
			"useful": {key: item["id"] for key, item in USEFUL.items()},
			"traps": {key: trap["id"] for key, trap in TRAPS.items()},
		},
		"snack_bar": {"trades": opts["snack_bar_trades"], "price": opts["snack_bar_price"]},
		"pool": {
			"snacks": sum(plan.snacks.values()),
			"traps": dict(plan.traps),
			"fast_forwards": plan.fast_forwards,
			"remote_controls": plan.remote_controls,
			"wild_tickets": plan.wild,
		},
		"units": [{"id": registry.unit_id[unit.key], "name": registry.unit_name[unit.key], "kind": unit.kind,
		           "steps": unit.steps, "start": unit.start} for unit in plan.units],
		"entries": [_entry(pe, registry) for pe in plan.entries],
	}
