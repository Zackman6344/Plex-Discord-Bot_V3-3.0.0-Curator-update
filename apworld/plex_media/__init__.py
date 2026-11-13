# apworld/plex_media/__init__.py
# The Plex Media world: each slot is one person's list of movies, episodes, albums, playlist mixes
# and audiobooks from the owner's Plex server, unlocked by the multiworld and checked by watching.
#
# AP 0.6.8 names items and locations once, at import, so the class tables hold placeholders
# ("Unlock i", "Check j") on the ids every seed shares. The seed's real titles go on the Item and
# Location objects (the fill, the rules and the spoiler see them) and replace the placeholders in
# the data package embedded in the multidata (stage_modify_multidata), which is what the room
# server, archipelago.gg and the bot name things by. The registry behind both is built from every
# Plex slot at once in stage_generate_early, from the YAMLs alone.
#
# The bot's !ap next worker (scripts/ap-logic-worker.py) rebuilds a seed in another process and
# replays its placements by the placeholder names, so create_item takes "Unlock i" to mean registry
# unit i, and nothing here may depend on a clock, a random draw or set order. A Plex seed therefore
# needs this apworld installed on the bot's PC for as long as its room lives.

import logging
import time

from BaseClasses import Item, ItemClassification, Location, LocationProgressType, Region, Tutorial
from Options import OptionError
from worlds.AutoWorld import WebWorld, World

from .constants import (COUNTER, GAME, GOAL_LOCATION, MAX_CHECKS, MAX_UNLOCKS, POPCORN, POPCORN_ID, VICTORY,
                        WILD_TICKET, WILD_TICKET_ID, WORLD_VERSION, check_name, static_item_table,
                        static_location_table, unlock_name)
from .datapackage import build_package, checksummed
from .entries import EntryError, parse_entries, parse_list_info
from .options import PlexMediaOptions, option_groups, option_values
from .plan import PlanError, plan_slot
from .registry import Registry, RegistryError
from .rules import has, opened_by
from .slotdata import build_slot_data

logger = logging.getLogger("Plex Media")


class PlexMediaItem(Item):
	game = GAME


class PlexMediaLocation(Location):
	game = GAME


class PlexMediaWeb(WebWorld):
	theme = "partyTime"
	option_groups = option_groups
	tutorials = [Tutorial(
		"Multiworld Setup Guide",
		"Build a Plex Media list with the Plex Discord Bot and play it in a multiworld.",
		"English",
		"setup_en.md",
		"setup/en",
		["Plex Discord Bot"],
	)]


def _covers_all(names, placeholder, count):
	"""True when an option holds every placeholder, which is what AP leaves of "Everything" or
	"Everywhere" once it has checked the option against the class tables."""
	return len(names) >= count and all(placeholder(i) in names for i in range(1, count + 1))


class PlexMediaWorld(World):
	"""Watch and listen through a list from a Plex server: movies, TV episodes, albums, playlists and
	audiobooks. Every title is locked until the multiworld sends its unlock, and finishing it, or
	playing past timestamps inside it, sends checks."""

	game = GAME
	web = PlexMediaWeb()
	options_dataclass = PlexMediaOptions
	options: PlexMediaOptions
	topology_present = False
	item_name_to_id = static_item_table()
	location_name_to_id = static_location_table()
	required_client_version = (0, 5, 0)
	# Universal Tracker regenerates one slot on its own, so its registry, and every id it reads,
	# would differ from the seed's whenever the seed holds more than one Plex slot.
	disable_ut = True

	def __init__(self, multiworld, player):
		super().__init__(multiworld, player)
		self.plan = None
		self.info = None
		self.registry = None
		self.unit_info = {}
		self.placed = []
		self.goal_location = None

	def generate_early(self):
		try:
			entries = parse_entries(self.options.entries.value)
			self.info = parse_list_info(self.options.list_info.value)
			self.plan = plan_slot(entries, option_values(self.options))
		except (EntryError, PlanError) as err:
			raise OptionError(f"Plex Media list of {self.player_name}: {err}") from err

	@classmethod
	def stage_generate_early(cls, multiworld):
		players = multiworld.get_game_players(GAME)
		try:
			registry = Registry([(player, multiworld.worlds[player].plan) for player in players])
		except RegistryError as err:
			raise OptionError(f"Plex Media: {err}") from err
		for player in players:
			world = multiworld.worlds[player]
			world.registry = registry
			# Before any copy is collected: create_items' push_precollected collects into the
			# multiworld's state, and the counter must count those copies too.
			world.unit_info = {registry.unit_name[unit.key]: (unit.steps, unit.prefix) for unit in world.plan.units}
			world.translate_common_options()
		for group_id in multiworld.get_game_groups(GAME):
			group = multiworld.groups[group_id]
			if group.get("item_pool"):
				logger.warning("Plex Media cannot link items (item link %s): its unlocks carry each seed's own "
				               "titles, so the link is left empty.", group.get("name", group_id))
				group["item_pool"] = set()
				group["local_items"] = set()
				group["non_local_items"] = set()

	def translate_common_options(self):
		"""Point the common options that name items and locations at this slot's real names.

		AP checks them against the class tables, so a YAML can only say "Unlock i", "Check j",
		Everything or Everywhere, while core compares them with Item.name and Location.name, which
		here are titles. A placeholder is translated only to this slot's own units and locations.
		"""
		registry = self.registry
		own_units = {registry.unit_name[unit.key] for unit in self.plan.units}
		own_locations = {}
		for pe in self.plan.entries:
			for key in pe.location_keys():
				own_locations[key] = registry.location_name[key]
		own_location_names = set(own_locations.values())
		for name in ("local_items", "non_local_items", "start_hints"):
			option = getattr(self.options, name)
			if option.value:
				option.value = self._real_items(name, set(option.value), own_units)
		for name in ("exclude_locations", "priority_locations", "start_location_hints"):
			option = getattr(self.options, name)
			if option.value:
				option.value = self._real_locations(name, set(option.value), own_locations, own_location_names)
		if self.options.start_inventory.value:
			logger.warning("%s: Plex Media ignores start_inventory; starting_unlocks sets the opening titles.",
			               self.player_name)
			self.options.start_inventory.value.clear()
		if self.options.item_links.value:
			logger.warning("%s: Plex Media ignores item_links: its unlocks carry each seed's own titles.",
			               self.player_name)
			self.options.item_links.value = []

	def _real_items(self, option_name, names, own_units):
		# Everything means the list's unlocks. Popcorn kept home as well cannot always fit once other
		# games' items have taken some of the list's locations, and generation stops on a FillError.
		if _covers_all(names, unlock_name, MAX_UNLOCKS):
			return set(own_units)
		out, foreign = set(), []
		for name in sorted(names):
			if name in (POPCORN, WILD_TICKET) or name in own_units:
				out.add(name)
				continue
			key = self.registry.unit_for_static_name(name)
			if key is None:
				raise OptionError(f"{self.player_name}: {option_name} names {name!r}, but this seed has "
				                  f"{len(self.registry.unit_keys)} Plex Media unlocks")
			real = self.registry.unit_name[key]
			if real in own_units:
				out.add(real)
			else:
				foreign.append(name)
		if foreign:
			logger.warning("%s: %s leaves out %d unlock(s) that belong to other lists: %s", self.player_name,
			               option_name, len(foreign), ", ".join(foreign[:5]))
		return out

	def _real_locations(self, option_name, names, own_locations, own_location_names):
		if _covers_all(names, check_name, MAX_CHECKS):
			return set(own_location_names)
		out, dropped = set(), []
		for name in sorted(names):
			if name in own_location_names:
				out.add(name)
				continue
			key = self.registry.location_for_static_name(name)
			if key in own_locations:
				out.add(own_locations[key])
			else:
				dropped.append(name)
		if dropped:
			logger.warning("%s: %s leaves out %d location(s) that are not on this list: %s", self.player_name,
			               option_name, len(dropped), ", ".join(dropped[:5]))
		return out

	def _any_registry(self):
		if self.registry is not None:
			return self.registry
		for world in self.multiworld.get_game_worlds(GAME):
			if world.registry is not None:
				return world.registry
		return None

	def create_item(self, name):
		if name == POPCORN:
			return PlexMediaItem(name, ItemClassification.filler, POPCORN_ID, self.player)
		if name == WILD_TICKET:
			return PlexMediaItem(name, ItemClassification.useful, WILD_TICKET_ID, self.player)
		if name == VICTORY:
			return PlexMediaItem(name, ItemClassification.progression, None, self.player)
		registry = self._any_registry()
		if registry is None:
			raise KeyError(f"Plex Media has no registry yet to make {name!r} from")
		key = registry.unit_by_name.get(name)
		if key is None:
			key = registry.unit_for_static_name(name)
		if key is None:
			raise KeyError(f"{name!r} is not a Plex Media item in this seed")
		return PlexMediaItem(registry.unit_name[key], ItemClassification.progression, registry.unit_id[key],
		                     self.player)

	def get_filler_item_name(self):
		return POPCORN

	def create_regions(self):
		registry = self.registry
		menu = Region("Menu", self.player, self.multiworld)
		library = Region("Library", self.player, self.multiworld)
		self.multiworld.regions += [menu, library]
		menu.connect(library)
		exclude = self.options.checkpoint_items.current_key == "filler_only"
		self.placed = []
		for pe in self.plan.entries:
			for key, _n in pe.main:
				self.placed.append((self._location(library, registry, key), pe))
			for minute in pe.minutes:
				location = self._location(library, registry, pe.checkpoint_key(minute))
				if exclude:
					location.progress_type = LocationProgressType.EXCLUDED
				self.placed.append((location, pe))
		self.goal_location = PlexMediaLocation(self.player, GOAL_LOCATION, None, library)
		self.goal_location.place_locked_item(self.create_item(VICTORY))
		library.locations.append(self.goal_location)

	def _location(self, region, registry, key):
		location = PlexMediaLocation(self.player, registry.location_name[key], registry.location_id[key], region)
		region.locations.append(location)
		return location

	def create_items(self):
		for unit in self.plan.units:
			for _ in range(unit.start):
				self.multiworld.push_precollected(self.create_item(self.registry.unit_name[unit.key]))
		pool = []
		for unit in self.plan.units:
			name = self.registry.unit_name[unit.key]
			pool += [self.create_item(name) for _ in range(unit.steps - unit.start)]
		pool += [self.create_item(WILD_TICKET) for _ in range(self.plan.wild)]
		pool += [self.create_item(POPCORN) for _ in range(len(self.placed) - len(pool))]
		self.multiworld.itempool += pool

	def set_rules(self):
		rules = {}
		for location, pe in self.placed:
			needed = (pe.unit, pe.step)
			if needed not in rules:
				rules[needed] = has(self.registry.unit_name[pe.unit], self.player, pe.step)
			location.access_rule = rules[needed]
		self.goal_location.access_rule = has(COUNTER, self.player, self.plan.goal_count)
		self.multiworld.completion_condition[self.player] = has(VICTORY, self.player)

	def collect(self, state, item):
		changed = super().collect(state, item)
		if changed:
			unit = self.unit_info.get(item.name)
			if unit is not None:
				held = state.prog_items[self.player]
				opened = opened_by(unit[0], unit[1], held[item.name])
				if opened:
					held[COUNTER] += opened
		return changed

	def remove(self, state, item):
		changed = super().remove(state, item)
		if changed:
			unit = self.unit_info.get(item.name)
			if unit is not None:
				held = state.prog_items[self.player]
				opened = opened_by(unit[0], unit[1], held[item.name] + 1)
				if opened:
					held[COUNTER] -= opened
					if held[COUNTER] < 1:
						del held[COUNTER]
		return changed

	def fill_slot_data(self):
		version = self.world_version.as_simple_string() if tuple(self.world_version) != (0, 0, 0) else WORLD_VERSION
		return build_slot_data(self.plan, self.registry, self.info, version, int(time.time()))

	@classmethod
	def stage_modify_multidata(cls, multiworld, multidata):
		for world in multiworld.get_game_worlds(GAME):
			if world.registry is not None:
				multidata["datapackage"][GAME] = checksummed(build_package(world.registry))
				return
