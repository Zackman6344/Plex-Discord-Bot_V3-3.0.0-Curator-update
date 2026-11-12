# apworld/plex_media/registry.py
# The seed's one table of Plex Media units and locations, with their ids and real names. No AP imports.
#
# AP 0.6.8 fixes names and ids at import, so every seed shares the placeholder ids ("Unlock i" is
# item BASE+1000+i, "Check j" is location BASE+j) and this table says what they mean in this seed.
# It is the union of every Plex slot: two friends with the same movie share its unit and locations,
# so a hint or a check for it means the same thing in both lists. Ids come from sorted keys only,
# never from player order, a clock or set order, because the !ap next worker rebuilds the seed in
# another process (another hash seed) and must arrive at the same ids. Only display text comes from
# player order: the first player to list a key names it.

import hashlib

from .constants import (COUNTER, GOAL_LOCATION, ITEM_GROUPS, LOCATION_GROUPS, MAX_CHECKS, MAX_UNLOCKS, POPCORN,
                        VICTORY, WILD_TICKET, check_id, unlock_id)
from .naming import checkpoint_name, main_location_name, make_unique, sanitize_text, unit_name
from .plan import LOCATION_PREFIX

# Group names are resolved before item and location names by the server, so a title may not take one.
RESERVED = frozenset(name.casefold() for name in (POPCORN, WILD_TICKET, VICTORY, COUNTER, GOAL_LOCATION,
                                                  *ITEM_GROUPS, *LOCATION_GROUPS))
UNIT_GROUP = {"movie": "Movies", "show": "Shows", "album": "Albums", "mix": "Playlists", "book": "Books"}
MAIN_GROUP = {"movie": "Movies", "episode": "Episodes", "album": "Albums", "mix": "Playlists", "book": "Books"}
CHECKPOINT_GROUP = "Checkpoints"


class RegistryError(ValueError):
	pass


def _tag(entry, for_unit):
	"""What tells two same-named titles apart in a name: the rating key, else the list id.

	Ids are kept as written, so a hand-edited YAML can put a control character in a book's work id;
	the tag is cleaned like any title. The bot writes slugs and numbers, which cleaning leaves alone,
	so builder 1's names stay as they were. A tag that cleans away to nothing becomes a hash of the
	id: sha1, since hash() changes with PYTHONHASHSEED and the !ap next worker rebuilds the names in
	another process.
	"""
	if entry["k"] == "episode" and for_unit:
		raw = str(entry["srk"])
	elif "rk" in entry:
		raw = str(entry["rk"])
	elif entry["k"] == "mix":
		raw = entry["id"][len("pl:"):]
	else:
		raw = entry["w"]
	return sanitize_text(raw) or hashlib.sha1(entry["id"].encode("utf-8", "surrogatepass")).hexdigest()[:8]


def _static_index(name, word):
	"""i for the exact placeholder "<word> i", else None ("Unlock 07" is not a placeholder)."""
	head = word + " "
	if not name.startswith(head):
		return None
	digits = name[len(head):]
	if not digits.isdigit() or not digits.isascii() or digits != str(int(digits)):
		return None
	return int(digits)


class Registry:
	def __init__(self, plans):
		"""plans: [(player, plan.Plan)] in player order."""
		self._build_units(plans)
		self._build_locations(plans)

	def _build_units(self, plans):
		source = {}
		for _player, plan in plans:
			for unit in plan.units:
				if unit.key not in source:
					source[unit.key] = (unit.kind, plan.entries[unit.first].entry)
		self.unit_keys = sorted(source)
		if len(self.unit_keys) > MAX_UNLOCKS:
			raise RegistryError(f"the Plex Media lists of this seed hold {len(self.unit_keys)} unlocks together; "
			                    f"at most {MAX_UNLOCKS} fit in one seed")
		self.unit_id = {key: unlock_id(i) for i, key in enumerate(self.unit_keys, 1)}
		self.unit_kind = {key: source[key][0] for key in self.unit_keys}
		names = {key: unit_name(key, source[key][1]) for key in self.unit_keys}
		tags = {key: _tag(source[key][1], True) for key in self.unit_keys}
		self.unit_name = make_unique(self.unit_keys, names, tags, self.unit_kind, RESERVED)
		self.unit_by_name = {name: key for key, name in self.unit_name.items()}

	def _build_locations(self, plans):
		records = {}
		for _player, plan in plans:
			for pe in plan.entries:
				mains, minutes = records.setdefault(pe.key, ({}, {}))
				for key, n in pe.main:
					mains.setdefault(key, (pe.entry, n))
				for minute in pe.minutes:
					minutes.setdefault(minute, pe.entry)
		self.location_keys = []
		names, tags, kinds = {}, {}, {}
		self.location_group = {}
		for entry_key in sorted(records):
			mains, minutes = records[entry_key]
			for key in sorted(mains, key=lambda k: (mains[k][1], k)):
				entry, n = mains[key]
				self.location_keys.append(key)
				names[key] = main_location_name(entry, n)
				tags[key] = _tag(entry, False)
				kinds[key] = entry["k"]
				self.location_group[key] = MAIN_GROUP[entry["k"]]
			for minute in sorted(minutes):
				entry = minutes[minute]
				key = f"{LOCATION_PREFIX[entry['k']]}|{entry['id']}|@{minute}"
				self.location_keys.append(key)
				names[key] = checkpoint_name(entry, minute)
				tags[key] = _tag(entry, False)
				kinds[key] = entry["k"]
				self.location_group[key] = CHECKPOINT_GROUP
		if len(self.location_keys) > MAX_CHECKS:
			raise RegistryError(f"the Plex Media lists of this seed make {len(self.location_keys)} locations together; "
			                    f"at most {MAX_CHECKS} fit in one seed")
		self.location_id = {key: check_id(j) for j, key in enumerate(self.location_keys, 1)}
		self.location_name = make_unique(self.location_keys, names, tags, kinds, RESERVED)

	def unit_for_static_name(self, name):
		i = _static_index(name, "Unlock")
		if i is None or not 1 <= i <= len(self.unit_keys):
			return None
		return self.unit_keys[i - 1]

	def location_for_static_name(self, name):
		j = _static_index(name, "Check")
		if j is None or not 1 <= j <= len(self.location_keys):
			return None
		return self.location_keys[j - 1]

	def item_groups(self):
		groups = {name: [] for name in ITEM_GROUPS}
		groups["Everything"] += [POPCORN, WILD_TICKET]
		for key in self.unit_keys:
			name = self.unit_name[key]
			groups[UNIT_GROUP[self.unit_kind[key]]].append(name)
			groups["Everything"].append(name)
		return groups

	def location_groups(self):
		groups = {name: [] for name in LOCATION_GROUPS}
		for key in self.location_keys:
			name = self.location_name[key]
			groups[self.location_group[key]].append(name)
			groups["Everywhere"].append(name)
		return groups
