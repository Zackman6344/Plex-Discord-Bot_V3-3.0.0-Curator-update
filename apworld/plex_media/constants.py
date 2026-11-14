# apworld/plex_media/constants.py
# The world's fixed names, ids, limits and option table, mirroring helpers/apMediaContracts.js.
#
# test_pure.py compares these with the JS module through node, so the bot and the world cannot
# drift apart. Ids, keys and names are frozen per builder version: a seed keeps crediting for as
# long as its room lives, so a change to anything they are derived from ships as a new
# BUILDER_VERSION, never as an edit.

GAME = "Plex Media"
APWORLD_NAME = "plex_media"
WORLD_VERSION = "0.3.0"
MIN_AP_VERSION = "0.6.8"
BUILDER_VERSION = 1
SLOT_DATA_SCHEMA = 1

# Item ids and location ids are separate namespaces in AP, so Popcorn and "Check 1" share BASE_ID + 1.
BASE_ID = 1_347_000_000
UNLOCK_OFFSET = 1000
MAX_UNLOCKS = 20_000
MAX_CHECKS = 60_000
POPCORN_ID = BASE_ID + 1
WILD_TICKET_ID = BASE_ID + 2
FAST_FORWARD_ID = BASE_ID + 100
REMOTE_CONTROL_ID = BASE_ID + 101

POPCORN = "Popcorn"
WILD_TICKET = "Wild Ticket"
FAST_FORWARD = "Fast Forward"
REMOTE_CONTROL = "Remote Control"
VICTORY = "Victory"
GOAL_LOCATION = "Plex Media Goal"
# A state counter for the goal rule, never an item in the pool.
COUNTER = "Plex Media Unlocked Entries"

# The items that are not unlocks have fixed ids between BASE_ID + 1 and BASE_ID + 999, below the
# first unlock. A room names items by id for as long as it lives, so one is only ever added in a
# free id, never renumbered. SNACKS is the filler in the order the pool deals it out, Popcorn alone
# while snack_variety is off.
SNACKS = {
	POPCORN: POPCORN_ID,
	"Nachos": BASE_ID + 3,
	"Large Soda": BASE_ID + 4,
	"Candy Bar": BASE_ID + 5,
	"Hot Dog": BASE_ID + 6,
	"Soft Pretzel": BASE_ID + 7,
	"Ice Cream Sandwich": BASE_ID + 8,
}
# slot_data's items.useful and items.traps are keyed like these. A trap's weight is the option
# <key>_weight, and a tie in the trap split goes to the trap listed first.
USEFUL = {
	"fast_forward": {"name": FAST_FORWARD, "id": FAST_FORWARD_ID},
	"remote_control": {"name": REMOTE_CONTROL, "id": REMOTE_CONTROL_ID},
}
TRAPS = {
	"buffering": {"name": "Buffering", "id": BASE_ID + 200},
	"rights_expired": {"name": "Rights Expired", "id": BASE_ID + 201},
	"commercial_break": {"name": "Commercial Break", "id": BASE_ID + 202},
	"shuffle_mode": {"name": "Shuffle Mode", "id": BASE_ID + 203},
	"rewind": {"name": "Rewind", "id": BASE_ID + 204},
	"intermission": {"name": "Intermission", "id": BASE_ID + 205},
	"slow_motion": {"name": "Slow Motion", "id": BASE_ID + 206},
}

ITEM_GROUPS = ("Movies", "Shows", "Albums", "Playlists", "Books", "Snacks", "Useful", "Traps", "Everything")
# The item groups whose members are the same in every seed.
FIXED_GROUPS = {
	"Snacks": list(SNACKS),
	"Useful": [WILD_TICKET, FAST_FORWARD, REMOTE_CONTROL],
	"Traps": [trap["name"] for trap in TRAPS.values()],
}
LOCATION_GROUPS = ("Movies", "Episodes", "Albums", "Playlists", "Books", "Checkpoints", "Everywhere")

KINDS = ("movie", "episode", "album", "mix", "book")
# The albums timer covers mixes too.
TIMER_KIND = {"movie": "movie", "episode": "episode", "album": "album", "mix": "album", "book": "book"}

MAX_ENTRIES = 2000
MAX_COPIES = 2000
MAX_LOCATIONS = 10000
# Shorter tracks get no location: a skit or an interlude is over before anyone can count it.
MIN_TRACK_MS = 30000
# A checkpoint at or past 90% of the runtime would land in the credits.
CHECKPOINT_CUT = 0.9
# Starting copies are at least ceil(copies / 50), so a long list never opens with one title.
COPIES_PER_START = 50
MIX_TRACKS = 15
SLOT_NAME_MAX = 16
TITLE_MAX = 100
WARN_COPIES = 600
WARN_LOCATIONS = 1500
WARN_HOURS_TO_GOAL = 50

# The YAML option table, in the order the YAML writes it. entries and list_info come after these.
OPTIONS = {
	"starting_unlocks": {"type": "range", "min": 1, "max": 50, "default": 3},
	"goal_percent": {"type": "range", "min": 1, "max": 100, "default": 80},
	"tv_unlock": {"type": "choice", "values": ["episodes", "season"], "default": "episodes"},
	"episodes_per_unlock": {"type": "range", "min": 1, "max": 12, "default": 3},
	"locked_watches": {"type": "choice", "values": ["bank", "ignore"], "default": "bank"},
	"checkpoint_items": {"type": "choice", "values": ["filler_only", "anything"], "default": "filler_only"},
	"timesanity_strict": {"type": "toggle", "default": False},
	"timesanity_movies": {"type": "range", "min": 0, "max": 240, "default": 15},
	"timesanity_episodes": {"type": "range", "min": 0, "max": 240, "default": 10},
	"timesanity_albums": {"type": "range", "min": 0, "max": 240, "default": 0},
	"timesanity_books": {"type": "range", "min": 0, "max": 1440, "default": 30},
	"wild_tickets": {"type": "range", "min": 0, "max": 20, "default": 2},
	"snack_variety": {"type": "toggle", "default": True},
	"fast_forwards": {"type": "range", "min": 0, "max": 10, "default": 2},
	"remote_controls": {"type": "range", "min": 0, "max": 10, "default": 1},
	"snack_bar_trades": {"type": "range", "min": 0, "max": 10, "default": 3},
	"snack_bar_price": {"type": "range", "min": 5, "max": 50, "default": 10},
	"trap_percentage": {"type": "range", "min": 0, "max": 100, "default": 0},
	"buffering_weight": {"type": "range", "min": 0, "max": 10, "default": 2},
	"rights_expired_weight": {"type": "range", "min": 0, "max": 10, "default": 2},
	"commercial_break_weight": {"type": "range", "min": 0, "max": 10, "default": 1},
	"shuffle_mode_weight": {"type": "range", "min": 0, "max": 10, "default": 1},
	"rewind_weight": {"type": "range", "min": 0, "max": 10, "default": 1},
	"intermission_weight": {"type": "range", "min": 0, "max": 10, "default": 1},
	"slow_motion_weight": {"type": "range", "min": 0, "max": 10, "default": 1},
}

# The list settings, in the order the YAML writes them (after OPTIONS): what the bot picks from the
# Plex library when /apmedia yaml fills in a YAML's titles, which lets a player start the YAML in the
# Archipelago Options Creator. Generation never reads them, so a seed's ids, names and slot_data are
# the same with or without them. A count at preset (-1, out of the slider's range so no number means
# it by accident) takes its number from PRESETS[list_preset]; none sets those counts to 0.
LIST_OPTIONS = {
	"list_preset": {"type": "choice", "values": ["movies", "tv", "music", "books", "mixed", "none"],
	                "default": "movies"},
	"list_movies": {"type": "named_range", "min": 0, "max": 200, "special": {"preset": -1}, "default": "preset"},
	"list_shows": {"type": "named_range", "min": 0, "max": 50, "special": {"preset": -1}, "default": "preset"},
	"list_albums": {"type": "named_range", "min": 0, "max": 200, "special": {"preset": -1}, "default": "preset"},
	"list_books": {"type": "named_range", "min": 0, "max": 50, "special": {"preset": -1}, "default": "preset"},
	"list_titles": {"type": "text", "default": ""},
	"list_playlist": {"type": "text", "default": ""},
	"list_collection": {"type": "text", "default": ""},
	"list_genre": {"type": "text", "default": ""},
	"list_years": {"type": "text", "default": ""},
	"list_unwatched": {"type": "toggle", "default": True},
	"list_max_episodes": {"type": "range", "min": 1, "max": 500, "default": 24},
	"list_label": {"type": "text", "default": ""},
}

# What each list_preset gives the counts left at preset; a kind left out is 0. The bot applies these
# (helpers/apMediaContracts.js PRESETS); the world only quotes them in list_preset's description.
PRESETS = {
	"movies": {"movies": 15},
	"tv": {"shows": 3},
	"music": {"albums": 10},
	"books": {"books": 3},
	"mixed": {"movies": 6, "shows": 1, "albums": 4, "books": 1},
}


def unlock_id(i):
	return BASE_ID + UNLOCK_OFFSET + i


def check_id(j):
	return BASE_ID + j


def unlock_name(i):
	return f"Unlock {i}"


def check_name(j):
	return f"Check {j}"


def fixed_items():
	"""Every item that is not an unlock, name to id: Popcorn and Wild Ticket first, then the rest by id."""
	table = {POPCORN: POPCORN_ID, WILD_TICKET: WILD_TICKET_ID, **SNACKS}
	for item in (*USEFUL.values(), *TRAPS.values()):
		table[item["name"]] = item["id"]
	return table


def static_item_table():
	table = fixed_items()
	for i in range(1, MAX_UNLOCKS + 1):
		table[unlock_name(i)] = unlock_id(i)
	return table


def static_location_table():
	return {check_name(j): check_id(j) for j in range(1, MAX_CHECKS + 1)}
