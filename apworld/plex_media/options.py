# apworld/plex_media/options.py
# The YAML options of a Plex Media slot, built from the option table in constants.py.
#
# The bot writes every one of these (/apmedia yaml), so ranges and defaults come from the table the
# bot's helpers/apMediaContracts.js mirrors rather than from numbers typed twice. entries and
# list_info are machine-written: Visibility.none keeps them out of templates, option pages and the
# spoiler, and verify() checks them while Generate reads the YAML, where a bad entry is reported
# against its file instead of failing later in the middle of generation.

from dataclasses import dataclass

from Options import (Choice, ItemsAccessibility, NamedRange, OptionDict, OptionError, OptionList,
                     PerGameCommonOptions, Range, Toggle, Visibility)

from .constants import OPTIONS
from .entries import EntryError, parse_entries, parse_list_info


def _span(key):
	spec = OPTIONS[key]
	return spec["min"], spec["max"], spec["default"]


class Entries(OptionList):
	"""The titles on this list, one per line. Written by the bot: build the YAML with /apmedia yaml."""
	display_name = "Entries"
	visibility = Visibility.none
	default = []

	def verify(self, world, player_name, plando_options):
		super().verify(world, player_name, plando_options)
		try:
			parse_entries(self.value)
		except EntryError as err:
			raise OptionError(f"Plex Media list of {player_name}: {err}") from err


class ListInfo(OptionDict):
	"""Who the list was built for and when. Written by the bot."""
	display_name = "List Info"
	visibility = Visibility.none
	default = {}

	def verify(self, world, player_name, plando_options):
		super().verify(world, player_name, plando_options)
		try:
			parse_list_info(self.value)
		except EntryError as err:
			raise OptionError(f"Plex Media list of {player_name}: {err}") from err


class StartingUnlocks(Range):
	"""Unlocks you start with. A long list starts with at least one per 50 unlocks, and at least one
	unlock is always left for the multiworld to send."""
	display_name = "Starting Unlocks"
	range_start, range_end, default = _span("starting_unlocks")


class GoalPercent(Range):
	"""Percent of the list to finish for your goal (rounded down, at least one title)."""
	display_name = "Goal Percent"
	range_start, range_end, default = _span("goal_percent")


class TvUnlock(Choice):
	"""What one show unlock opens: the next few episodes, or the next season."""
	display_name = "TV Unlock"
	option_episodes = 0
	option_season = 1
	default = 0


class EpisodesPerUnlock(Range):
	"""Episodes one show unlock opens, when tv_unlock is episodes."""
	display_name = "Episodes per Unlock"
	range_start, range_end, default = _span("episodes_per_unlock")


class LockedWatches(Choice):
	"""What happens to a title you finish before it is unlocked. bank: its checks wait and are sent when the
	unlock arrives. ignore: nothing is sent, so watch it again later."""
	display_name = "Locked Watches"
	option_bank = 0
	option_ignore = 1
	default = 0


class CheckpointItems(Choice):
	"""What timesanity checkpoints may hold. filler_only keeps every unlock and useful item off them, so
	nobody waits on someone else reaching the middle of a film."""
	display_name = "Checkpoint Items"
	option_filler_only = 0
	option_anything = 1
	default = 0


class TimesanityStrict(Toggle):
	"""When off, finishing a title also earns every checkpoint inside it, so a watch the bot could not
	follow live still pays out. When on, a checkpoint is earned only by playing past it."""
	display_name = "Timesanity Strict"
	default = 0


class TimesanityMovies(NamedRange):
	"""Minutes between checkpoints inside each movie (off: none). None fall in the last 10% of a title."""
	display_name = "Timesanity: Movies"
	range_start, range_end, default = _span("timesanity_movies")
	special_range_names = {"off": 0}


class TimesanityEpisodes(NamedRange):
	"""Minutes between checkpoints inside each episode (off: none)."""
	display_name = "Timesanity: Episodes"
	range_start, range_end, default = _span("timesanity_episodes")
	special_range_names = {"off": 0}


class TimesanityAlbums(NamedRange):
	"""Minutes between checkpoints inside each album or playlist (off: none). Every track of 30 s or more
	already has a check of its own."""
	display_name = "Timesanity: Albums"
	range_start, range_end, default = _span("timesanity_albums")
	special_range_names = {"off": 0}


class TimesanityBooks(NamedRange):
	"""Minutes between checkpoints inside each audiobook (off: none)."""
	display_name = "Timesanity: Books"
	range_start, range_end, default = _span("timesanity_books")
	special_range_names = {"off": 0}


class WildTickets(Range):
	"""Wild Tickets in the pool. Each one unlocks any locked title of your choice (one step of a show)."""
	display_name = "Wild Tickets"
	range_start, range_end, default = _span("wild_tickets")


@dataclass
class PlexMediaOptions(PerGameCommonOptions):
	starting_unlocks: StartingUnlocks
	goal_percent: GoalPercent
	tv_unlock: TvUnlock
	episodes_per_unlock: EpisodesPerUnlock
	locked_watches: LockedWatches
	checkpoint_items: CheckpointItems
	timesanity_strict: TimesanityStrict
	timesanity_movies: TimesanityMovies
	timesanity_episodes: TimesanityEpisodes
	timesanity_albums: TimesanityAlbums
	timesanity_books: TimesanityBooks
	wild_tickets: WildTickets
	accessibility: ItemsAccessibility
	entries: Entries
	list_info: ListInfo


def option_values(options):
	"""The table's options as YAML names to YAML values (choices by name, the toggle as a bool)."""
	values = {}
	for key, spec in OPTIONS.items():
		option = getattr(options, key)
		if spec["type"] == "choice":
			values[key] = option.current_key
		elif spec["type"] == "toggle":
			values[key] = bool(option.value)
		else:
			values[key] = int(option.value)
	return values
