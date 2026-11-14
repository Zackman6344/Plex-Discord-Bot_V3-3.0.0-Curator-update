# apworld/plex_media/options.py
# The YAML options of a Plex Media slot, built from the option tables in constants.py.
#
# The bot writes every one of these (/apmedia yaml), so ranges and defaults come from the tables the
# bot's helpers/apMediaContracts.js mirrors rather than from numbers typed twice. entries and
# list_info are machine-written: Visibility.none keeps them out of templates, option pages and the
# spoiler, and verify() checks them while Generate reads the YAML, where a bad entry is reported
# against its file instead of failing later in the middle of generation.
#
# The list_* options are instructions for the bot, so a player can start a YAML in the Archipelago
# Options Creator: /apmedia yaml reads them to pick the titles it writes into entries. Each docstring
# is the tooltip the Creator shows. Generation reads none of them (option_values leaves them out).

from dataclasses import dataclass

from Options import (Choice, DefaultOnToggle, FreeText, ItemsAccessibility, NamedRange, OptionDict, OptionError,
                     OptionGroup, OptionList, PerGameCommonOptions, Range, Toggle, Visibility)

from .constants import LIST_OPTIONS, OPTIONS, PRESETS
from .entries import EntryError, parse_entries, parse_list_info


def _span(key):
	spec = OPTIONS[key]
	return spec["min"], spec["max"], spec["default"]


def _list_span(key):
	"""range_start, range_end and the class default, a special name's number when the default is one."""
	spec = LIST_OPTIONS[key]
	return spec["min"], spec["max"], spec.get("special", {}).get(spec["default"], spec["default"])


_KIND_WORDS = {"movies": ("movie", "movies"), "shows": ("show", "shows"), "albums": ("album", "albums"),
               "books": ("audiobook", "audiobooks")}


def _mix(counts):
	words = [f"{n} {_KIND_WORDS[kind][n != 1]}" for kind, n in counts.items()]
	return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _preset_doc():
	# Built from PRESETS, which test_pure.py holds to the bot's table, so the tooltip cannot quote a
	# mix the bot no longer applies.
	lines = ["The bot reads this when it fills in your titles (/apmedia yaml): List: Movies, List: Shows, List: "
	         "Albums and List: Audiobooks take their numbers from here while they are left at Preset, and a kind "
	         "the preset leaves out gets 0."]
	lines += [f"{name}: {_mix(counts)}" for name, counts in PRESETS.items()]
	lines.append("none: 0 of each, so the list holds only the counts you set and the titles, playlist or "
	             "collection you name")
	return "\n".join(lines)


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
	"""Episodes one show unlock opens, when TV Unlock is episodes."""
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
	follow live still pays out. When on, a checkpoint needs everything before it heard: gaps under 30 s
	are forgiven, and in Plex, which the bot checks every 15 s by default, gaps up to about 50 s."""
	display_name = "Timesanity Strict"
	default = 0


class TimesanityTimer(NamedRange):
	special_range_names = {"off": 0}

	@classmethod
	def from_text(cls, text):
		# YAML 1.1 reads an unquoted off as false, and Range.from_text takes false as 0 only when the
		# default is not 0, so timesanity_albums (default off) refused the Launcher's own template,
		# which writes "off: 50" for it.
		if text.lower() == "false":
			return cls(0)
		return super().from_text(text)


class TimesanityMovies(TimesanityTimer):
	"""Minutes between checkpoints inside each movie (off: none). None fall in the last 10% of a title."""
	display_name = "Timesanity: Movies"
	range_start, range_end, default = _span("timesanity_movies")


class TimesanityEpisodes(TimesanityTimer):
	"""Minutes between checkpoints inside each episode (off: none)."""
	display_name = "Timesanity: Episodes"
	range_start, range_end, default = _span("timesanity_episodes")


class TimesanityAlbums(TimesanityTimer):
	"""Minutes between checkpoints inside each album or playlist (off: none). Every track of 30 s or more
	already has a check of its own."""
	display_name = "Timesanity: Albums"
	range_start, range_end, default = _span("timesanity_albums")


class TimesanityBooks(TimesanityTimer):
	"""Minutes between checkpoints inside each audiobook (off: none)."""
	display_name = "Timesanity: Books"
	range_start, range_end, default = _span("timesanity_books")


class WildTickets(Range):
	"""Wild Tickets in the pool. Each one unlocks any locked title of your choice (one step of a show)."""
	display_name = "Wild Tickets"
	range_start, range_end, default = _span("wild_tickets")


class SnackVariety(DefaultOnToggle):
	"""The filler items that are not traps come as seven snacks, dealt in turn: Popcorn, Nachos, Large Soda,
	Candy Bar, Hot Dog, Soft Pretzel and Ice Cream Sandwich. Off: they are all Popcorn. Every snack counts
	the same at the Snack Bar."""
	display_name = "Snack Variety"


class FastForwards(Range):
	"""Fast Forwards in the pool. Spent on a title with /apmedia ff, one earns the title's next checkpoint
	without playing it (with Timesanity Strict on, the 10 minutes after where you got to count as heard
	instead, and the checkpoints they complete are earned). Its watch, track or finish check still needs
	playing. A short list gets fewer: useful items go only where the unlocks leave room,
	Wild Tickets first."""
	display_name = "Fast Forwards"
	range_start, range_end, default = _span("fast_forwards")


class RemoteControls(Range):
	"""Remote Controls in the pool. One that arrives while a trap is running on your list ends it; else it
	is kept and blocks the next trap. A short list gets fewer: useful items go only where the unlocks leave
	room, after Wild Tickets and Fast Forwards."""
	display_name = "Remote Controls"
	range_start, range_end, default = _span("remote_controls")


class SnackBarTrades(Range):
	"""Trades the Snack Bar allows you (/apmedia snackbar): each buys a Fast Forward or a Remote Control
	with snacks you have received. 0: no trades."""
	display_name = "Snack Bar Trades"
	range_start, range_end, default = _span("snack_bar_trades")


class SnackBarPrice(Range):
	"""Snacks one Snack Bar trade costs."""
	display_name = "Snack Bar Price"
	range_start, range_end, default = _span("snack_bar_price")


class TrapPercentage(Range):
	"""Percent of the filler items that become traps, rounded down and shared among the traps by
	the Trap Weight options. 0: no traps. A list given a trap while every Trap Weight is 0 stops
	generation. Commercial Break, Shuffle Mode, Rewind, Intermission and Slow Motion act on the
	music or the audiobook the bot plays for you, and wait up to 12 hours for you to listen."""
	display_name = "Trap Percentage"
	range_start, range_end, default = _span("trap_percentage")


class BufferingWeight(Range):
	"""How often Buffering is picked among the traps (0: never). For 15 minutes from your next check, the
	checks you earn are held, then sent together; another Buffering adds 15 minutes, up to an hour."""
	display_name = "Trap Weight: Buffering"
	range_start, range_end, default = _span("buffering_weight")


class RightsExpiredWeight(Range):
	"""How often Rights Expired is picked among the traps (0: never). For 45 minutes, the checks of the
	title you are playing, or else of the first title on your list you can play, are held, then sent
	when the rights come back."""
	display_name = "Trap Weight: Rights Expired"
	range_start, range_end, default = _span("rights_expired_weight")


class CommercialBreakWeight(Range):
	"""How often Commercial Break is picked among the traps (0: never). The bot's music plays a commercial
	after the current track, or pauses for 30 s; an audiobook pauses for 30 s."""
	display_name = "Trap Weight: Commercial Break"
	range_start, range_end, default = _span("commercial_break_weight")


class ShuffleModeWeight(Range):
	"""How often Shuffle Mode is picked among the traps (0: never). The bot's music queue is shuffled after
	the current track; in an audiobook it is a Rewind."""
	display_name = "Trap Weight: Shuffle Mode"
	range_start, range_end, default = _span("shuffle_mode_weight")


class RewindWeight(Range):
	"""How often Rewind is picked among the traps (0: never). The bot's music starts the current track over;
	an audiobook jumps back 5 minutes."""
	display_name = "Trap Weight: Rewind"
	range_start, range_end, default = _span("rewind_weight")


class IntermissionWeight(Range):
	"""How often Intermission is picked among the traps (0: never). The bot's music or your audiobook
	pauses for 60 s, then plays on."""
	display_name = "Trap Weight: Intermission"
	range_start, range_end, default = _span("intermission_weight")


class SlowMotionWeight(Range):
	"""How often Slow Motion is picked among the traps (0: never). Your audiobook plays at 0.75x for
	10 minutes; the bot's music pauses for 30 s instead."""
	display_name = "Trap Weight: Slow Motion"
	range_start, range_end, default = _span("slow_motion_weight")


class ListPreset(Choice):
	__doc__ = _preset_doc()
	display_name = "List: Preset"
	option_movies = 0
	option_tv = 1
	option_music = 2
	option_books = 3
	option_mixed = 4
	option_none = 5
	default = 0


class ListMovies(NamedRange):
	"""The bot reads this when it fills in your titles (/apmedia yaml): how many movies the list holds in
	all. Movies you name in List: Titles, List: Playlist or List: Collection count toward it, and the bot
	picks the rest at random. Left at Preset, the number comes from List: Preset."""
	display_name = "List: Movies"
	range_start, range_end, default = _list_span("list_movies")
	special_range_names = dict(LIST_OPTIONS["list_movies"]["special"])


class ListShows(NamedRange):
	"""The bot reads this when it fills in your titles (/apmedia yaml): how many TV shows the list holds in
	all. Shows you name count toward it, and the bot picks the rest at random, taking up to
	List: Episodes per Show episodes from each. Left at Preset, the number comes from List: Preset."""
	display_name = "List: Shows"
	range_start, range_end, default = _list_span("list_shows")
	special_range_names = dict(LIST_OPTIONS["list_shows"]["special"])


class ListAlbums(NamedRange):
	"""The bot reads this when it fills in your titles (/apmedia yaml): how many music albums the list
	holds in all. Albums you name count toward it, and the bot picks the rest at random. Left at Preset,
	the number comes from List: Preset."""
	display_name = "List: Albums"
	range_start, range_end, default = _list_span("list_albums")
	special_range_names = dict(LIST_OPTIONS["list_albums"]["special"])


class ListBooks(NamedRange):
	"""The bot reads this when it fills in your titles (/apmedia yaml): how many audiobooks the list holds
	in all. Audiobooks you name count toward it, and the bot picks the rest at random. Left at Preset, the
	number comes from List: Preset."""
	display_name = "List: Audiobooks"
	range_start, range_end, default = _list_span("list_books")
	special_range_names = dict(LIST_OPTIONS["list_books"]["special"])


class ListTitles(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): titles to put on the list, split
	by semicolons, as in Alien; Aliens. Start one with movie:, show:, album: or book: to say what it is,
	add a year to pick one film, as in Halloween (2018), and give a show's seasons as show: Lost S1-2.
	At most 50 titles."""
	display_name = "List: Titles"
	default = LIST_OPTIONS["list_titles"]["default"]


class ListPlaylist(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): a Plex playlist, by name, whose
	titles go on the list in the playlist's order. A music playlist goes on in parts of 15 tracks."""
	display_name = "List: Playlist"
	default = LIST_OPTIONS["list_playlist"]["default"]


class ListCollection(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): a Plex movie or TV collection, by
	name, whose titles go on the list."""
	display_name = "List: Collection"
	default = LIST_OPTIONS["list_collection"]["default"]


class ListGenre(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): random picks come only from this
	genre, such as Horror or Jazz. Titles you name go on the list whatever their genre."""
	display_name = "List: Genre"
	default = LIST_OPTIONS["list_genre"]["default"]


class ListYears(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): random picks come only from these
	years, written as 1999 or 1990-1999. Audiobooks ignore it."""
	display_name = "List: Years"
	default = LIST_OPTIONS["list_years"]["default"]


class ListUnwatched(DefaultOnToggle):
	"""The bot reads this when it fills in your titles (/apmedia yaml): leave out the movies and episodes
	you have watched and the audiobooks you finished from the random picks, a collection, a video
	playlist and the shows you name without seasons, and start each show at your first unwatched
	episode. Movies, audiobooks and seasons you name in List: Titles stay on the list whole. Leaving out
	what you watched needs your Plex account, linked by the server owner with /apmedia account; finished
	audiobooks come from the bot's bookmarks."""
	display_name = "List: Unwatched Only"


class ListMaxEpisodes(Range):
	"""The bot reads this when it fills in your titles (/apmedia yaml): the most episodes it takes from
	one show, in order. With List: Unwatched Only on, it starts at your first unwatched episode and
	skips the ones you watched. It applies to random shows, the shows of a collection, and shows you
	name without seasons."""
	display_name = "List: Episodes per Show"
	range_start, range_end, default = _list_span("list_max_episodes")


class ListLabel(FreeText):
	"""The bot reads this when it fills in your titles (/apmedia yaml): the list's name, which the bot
	shows in its messages. Left empty, the list is called "<your name>'s list"."""
	display_name = "List: Name"
	default = LIST_OPTIONS["list_label"]["default"]


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
	snack_variety: SnackVariety
	fast_forwards: FastForwards
	remote_controls: RemoteControls
	snack_bar_trades: SnackBarTrades
	snack_bar_price: SnackBarPrice
	trap_percentage: TrapPercentage
	buffering_weight: BufferingWeight
	rights_expired_weight: RightsExpiredWeight
	commercial_break_weight: CommercialBreakWeight
	shuffle_mode_weight: ShuffleModeWeight
	rewind_weight: RewindWeight
	intermission_weight: IntermissionWeight
	slow_motion_weight: SlowMotionWeight
	list_preset: ListPreset
	list_movies: ListMovies
	list_shows: ListShows
	list_albums: ListAlbums
	list_books: ListBooks
	list_titles: ListTitles
	list_playlist: ListPlaylist
	list_collection: ListCollection
	list_genre: ListGenre
	list_years: ListYears
	list_unwatched: ListUnwatched
	list_max_episodes: ListMaxEpisodes
	list_label: ListLabel
	accessibility: ItemsAccessibility
	entries: Entries
	list_info: ListInfo


# The Options Creator lists a group's options in the dataclass's order and the templates in the
# group's, so both orders match. Options in no group (progression_balancing, accessibility) land in
# "Game Options", which comes first; AP adds "Item & Location Options" after these.
option_groups = [
	OptionGroup("Your list (the bot picks the titles)", [
		ListPreset, ListMovies, ListShows, ListAlbums, ListBooks, ListTitles, ListPlaylist, ListCollection, ListGenre,
		ListYears, ListUnwatched, ListMaxEpisodes, ListLabel,
	]),
	OptionGroup("Unlocks and goal", [
		StartingUnlocks, GoalPercent, TvUnlock, EpisodesPerUnlock, LockedWatches, WildTickets,
	]),
	OptionGroup("Timesanity", [
		CheckpointItems, TimesanityStrict, TimesanityMovies, TimesanityEpisodes, TimesanityAlbums, TimesanityBooks,
	]),
	OptionGroup("Items and traps", [
		SnackVariety, FastForwards, RemoteControls, SnackBarTrades, SnackBarPrice, TrapPercentage, BufferingWeight,
		RightsExpiredWeight, CommercialBreakWeight, ShuffleModeWeight, RewindWeight, IntermissionWeight,
		SlowMotionWeight,
	]),
]


def option_values(options):
	"""The game options (OPTIONS) as YAML names to YAML values (choices by name, toggles as bools).

	The list settings stay out: they tell the bot what to pick, and a seed must come out the same
	with or without them."""
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
