# apworld/tests/test_creator.py
# The Options Creator half of scenario (h), beside test_generate.py's H_ListSettingsIgnored: a YAML
# made in the Archipelago Launcher's Options Creator, filled in by the bot, generated with the frozen
# Archipelago 0.6.8.
#
# The Creator lists Plex Media only while the world is not hidden, and shows its form only while
# web.options_page is True. fixtures/options_creator_default.yaml is what it exports for an untouched
# Plex Media form, and fixtures/options_creator_custom.yaml what it exports after the changes in
# CUSTOM_STEPS: a preset, a count, two titles, unwatched off, a list name with an accent,
# goal_percent randomized, the movie timer turned off by its special name and progression balancing
# moved. fixtures/options_creator_long.yaml has list texts long enough for Utils.dump to wrap them
# in each of its quoting styles, for test/apMediaCreatorFile.test.js to read back. All three are
# made here the way OptionsCreator.py makes them (test_generate.py's creator_panel and
# creator_untouched for the form, creator_step below for the changes) and written by Archipelago's
# own Utils.dump, and they must equal the committed files byte for byte, so a change in Archipelago
# or in the world's options shows up as a diff; run.py --update-golden rewrites them. git keeps them
# with LF line endings, and the comparison is made on those whatever core.autocrlf checked out.
#
# fixtures/launcher_template.yaml is the Launcher's Generate Template Options file for Plex Media,
# written by Options.generate_yaml_templates and held to it the same way. Each of its weighted options
# has one choice above 0, so with a name of its own the bot fills it in with every option at its
# default, and Generate.roll_settings reads the finished file so. Hand edits the bot keeps (a float key
# after its "+" twin, a "+" key inside triggers, one weighted choice, CR CR LF line ends) fill into
# files Archipelago's loader reads the way it reads the edits. A trigger on the albums timer's 'off'
# fires in the filled file as in the player's own, and a file that requires plando: items stops both
# files on a host without item plando and rolls the same plando_items in both with it.
#
# Unfilled, the default and the custom file must stop generation at the "no titles yet" message.
# fill_creator.js fills them in with the bot's real readPlayerYaml, validateParams and renderYaml,
# putting the 10 titles of fixtures/builder1_mixed.yaml where the Plex picks go, and the two filled
# files generate together: each slot_data holds those titles; each filled file keeps every Creator
# setting as Archipelago reads it, the random one still random until Archipelago rolls it; the seed
# passes test_generate.py's SeedChecks, regenerates identically in a child process under another
# PYTHONHASHSEED, and the !ap next worker rebuilds it from the filled files and verifies both slots.
#
# Harness: unittest, run by run.py after test_generate.prepare() has loaded Archipelago into a temp
# root that run.py removes afterwards; --only H runs this file's scenario with test_generate.py's
# H_ListSettingsIgnored. Every filled file and every Archipelago output stays inside that root. Bare
# assert is never used: -O strips it.

import json
import logging
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import ap_harness  # noqa: E402
from test_generate import (NO_TITLES, Seed, SeedChecks, check_worker, creator_panel, creator_untouched,  # noqa: E402
                           creator_widget, launcher_template, plain, run_child)

GAME = "Plex Media"
WORLD_VERSION = "0.2.0"
FILL = os.path.join(HERE, "fill_creator.js")
DEFAULT_YAML = os.path.join(HERE, "fixtures", "options_creator_default.yaml")
CUSTOM_YAML = os.path.join(HERE, "fixtures", "options_creator_custom.yaml")
LONG_YAML = os.path.join(HERE, "fixtures", "options_creator_long.yaml")
# The Launcher's Generate Template Options file for Plex Media, as Options.generate_yaml_templates writes it.
TEMPLATE_YAML = os.path.join(HERE, "fixtures", "launcher_template.yaml")
TEMPLATE_NAME = "Template Fan"
BUILDER1_YAML = os.path.join(HERE, "fixtures", "builder1_mixed.yaml")
SEED = 909
DEFAULT_NAME = "Default Fan"
CUSTOM_NAME = "Custom Fan"
LABEL = "Movie night at the caf" + chr(0xe9)
# fill_creator.js's fixed list_info.created_at.
CREATED_AT = 1731200000
# What a player does to the untouched form: (handler, option, what they pick).
CUSTOM_STEPS = (
	("choose", "list_preset", "mixed"),
	("slide", "list_movies", 4),
	("type", "list_titles", "Alien; Aliens"),
	("toggle", "list_unwatched", None),
	("type", "list_label", LABEL),
	("randomize", "goal_percent", None),
	("special", "timesanity_movies", "Off"),
	("slide", "progression_balancing", 30),
)
CUSTOM_CHANGES = {"list_preset": "mixed", "list_movies": 4, "list_titles": "Alien; Aliens", "list_unwatched": False,
                  "list_label": LABEL, "goal_percent": "random", "timesanity_movies": "off", "progression_balancing": 30}
LONG_NAME = "Long Fan"
# Texts past the 80 columns Utils.dump wraps at, so the bot's parser meets each of its quoting styles.
LONG_TITLES = ("movie: Alien (1979); Aliens; Alien 3; show: Lost S1-2; show: The Wire S1; album: Daft Punk - "
               "Discovery; book: The Hobbit; Heat (1995); The Thing; Blade Runner; Halloween (2018); Pride and Prejudice")
LONG_LABEL = ("Zo" + chr(0xeb) + "'s films and shows for the winter evenings at the lake cabin, " + chr(0x6771)
              + chr(0x4eac) + " edition")
LONG_PLAYLIST = "Road Trip: 90's #1"
LONG_STEPS = (
	("choose", "list_preset", "none"),
	("type", "list_titles", LONG_TITLES),
	("type", "list_label", LONG_LABEL),
	("type", "list_playlist", LONG_PLAYLIST),
	("type", "list_genre", "Sci-Fi & Fantasy"),
	("type", "list_years", "1990-1999"),
)

STATE = {"root": None, "update": False}


def prepare(root, update_golden=False):
	"""Called by run.py after test_generate.prepare(root, ...) has loaded Archipelago into root."""
	STATE.update(root=root, update=update_golden)


# OptionsCreator.py in AP 0.6.8, disassembled from lib/library.zip, stores what each widget's handler
# gives it: create_choice's dropdown (L414, set_value L398-401) the option's name; create_range's
# slider (update_text L322-325) an int; create_named_range's slider (set_to_custom L334-343) a
# special's name when the number is one, else an int; its dropdown (L372-377, set_value L348-354)
# the special's name lowercased; create_free_text (set_value L387-388) the text; create_toggle
# (set_value L439-444) the flipped bool; and the Random? toggle (randomize_option L539-548, offered
# only where option_can_be_randomized L54-60 allows) "random-" before the value, which
# export_options (L303-313) writes as random through check_random (L63-68).
def creator_step(option, current, action, arg):
	from Options import FreeText, TextChoice

	kind = creator_widget(option)
	if action == "choose" and kind == "choice" and arg in option.name_lookup.values():
		return arg
	if action == "slide" and kind in ("range", "named_range") and option.range_start <= arg <= option.range_end:
		if kind == "named_range" and arg in option.special_range_names.values():
			return next(name for name, value in option.special_range_names.items() if value == arg)
		return int(arg)
	if action == "special" and kind == "named_range" and arg in [name.title() for name in option.special_range_names]:
		return arg.lower()
	if action == "type" and kind == "text":
		return arg
	if action == "toggle" and kind == "toggle":
		return not bool(current)
	randomizable = option.supports_weighting and not (issubclass(option, FreeText) and not issubclass(option, TextChoice))
	if action == "randomize" and randomizable:
		return "random-" + str(current)
	raise ValueError(f"the Options Creator offers no {action} {arg!r} for {option.__name__}")


def check_random(value):
	return "random" if isinstance(value, str) and value.startswith("random-") else value


def creator_yaml(world, name, steps=()):
	"""The text Export Options saves for the form after steps (export_options_background L295-296)."""
	import Utils

	if not 1 <= len(name) <= 16:
		raise ValueError("the Creator exports names of 1 to 16 characters")
	values = {key: creator_untouched(option) for options in creator_panel(world).values() for key, option in options
	          if creator_widget(option) is not None}
	for action, key, arg in steps:
		values[key] = creator_step(world.options_dataclass.type_hints[key], values[key], action, arg)
	return Utils.dump({"name": name, "description": f"YAML generated by Archipelago {Utils.__version__}.",
	                   "game": world.game, world.game: {key: check_random(value) for key, value in values.items()}},
	                  sort_keys=False)


def committed(path):
	"""A committed fixture's text as git keeps it, with LF line endings."""
	with open(path, "rb") as handle:
		return handle.read().replace(b"\r\n", b"\n").decode("utf-8")


def fill(source, target):
	"""fill_creator.js on source, writing target; its JSON summary of what readPlayerYaml read."""
	node = shutil.which("node")
	if node is None:
		raise AssertionError("node is not on PATH")
	proc = subprocess.run([node, FILL, source, target], cwd=REPO, capture_output=True, timeout=120)
	if proc.returncode:
		raise AssertionError(f"fill_creator.js failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'replace')}")
	return json.loads(proc.stdout.decode("utf-8"))


class H_CreatorFiles(SeedChecks, unittest.TestCase):
	"""(h) the Options Creator's own files: unfilled they stop at "no titles yet", filled in by the bot they generate."""

	@classmethod
	def setUpClass(cls):
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		cls.hints = world.options_dataclass.type_hints
		cls.exported = {DEFAULT_YAML: creator_yaml(world, DEFAULT_NAME),
		                CUSTOM_YAML: creator_yaml(world, CUSTOM_NAME, CUSTOM_STEPS),
		                LONG_YAML: creator_yaml(world, LONG_NAME, LONG_STEPS)}
		cls.template = launcher_template()
		cls.sources = {}
		for path, text in (*cls.exported.items(), (TEMPLATE_YAML, cls.template)):
			if STATE["update"]:
				with open(path, "w", encoding="utf-8", newline="\n") as handle:
					handle.write(text)
			if os.path.exists(path):
				cls.sources[path] = path
			else:
				# Missing until --update-golden writes it: the rest runs on the export, and the fixture test fails.
				cls.sources[path] = os.path.join(STATE["root"], os.path.basename(path))
				with open(cls.sources[path], "w", encoding="utf-8", newline="\n") as handle:
					handle.write(text)
		cls.summaries = {}
		cls.filled = {}

		def write_players(folder):
			for name, path in ((DEFAULT_NAME, DEFAULT_YAML), (CUSTOM_NAME, CUSTOM_YAML)):
				target = os.path.join(folder, name.replace(" ", "_") + ".yaml")
				cls.summaries[name] = fill(cls.sources[path], target)
				with open(target, "rb") as handle:
					cls.filled[name] = handle.read()

		cls.seed = Seed("h_creator", SEED, write_players)

	def worlds_by_name(self):
		return {world.player_name: world for world in self.seed.worlds}

	def creator_text(self, path):
		return committed(self.sources[path])

	def test_the_creator_lists_the_world_and_shows_its_form(self):
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		# OptionsCreator.build (L669-671) leaves hidden worlds out of its list, and create_options_panel
		# (L572-596) shows no form for a falsy options_page and opens a browser for a URL.
		self.assertIs(world.hidden, False)
		self.assertIs(world.web.options_page, True)

	def test_the_fixtures_are_what_the_creator_exports(self):
		for path, text in self.exported.items():
			with self.subTest(fixture=os.path.basename(path)):
				# Utils.dump escapes the accent, so the Creator's file is the same whatever code page saves it.
				self.assertTrue(text.isascii())
				self.assertTrue(os.path.exists(path), f"{path} is missing: run run.py --update-golden once and commit it")
				self.assertEqual(committed(path), text, f"{os.path.basename(path)} is no longer what the Options Creator "
				                                        "exports; if the change is deliberate, rerun with --update-golden")

	def test_the_custom_file_holds_each_change_and_nothing_else(self):
		import Utils

		default = Utils.parse_yaml(self.exported[DEFAULT_YAML])
		custom = Utils.parse_yaml(self.exported[CUSTOM_YAML])
		for read, name in ((default, DEFAULT_NAME), (custom, CUSTOM_NAME)):
			self.assertEqual(list(read), ["name", "description", "game", GAME])
			self.assertEqual((read["name"], read["game"]), (name, GAME))
			self.assertNotIn("entries", read[GAME])
			self.assertNotIn("list_info", read[GAME])
		self.assertEqual(list(custom[GAME]), list(default[GAME]))
		changed = {key: value for key, value in custom[GAME].items() if default[GAME][key] != value}
		self.assertEqual(changed, CUSTOM_CHANGES)
		self.assertIn("  goal_percent: random\n", self.exported[CUSTOM_YAML])
		self.assertIn("  timesanity_movies: 'off'\n", self.exported[CUSTOM_YAML])
		self.assertIn('  list_label: "Movie night at the caf\\xE9"\n', self.exported[CUSTOM_YAML])

	def test_the_long_file_wraps_its_texts_in_each_quoting_style(self):
		import Utils

		backslash = chr(92)
		text = self.exported[LONG_YAML]
		lines = text.split("\n")
		titles = lines.index(next(line for line in lines if line.startswith("  list_titles: '")))
		self.assertTrue(lines[titles + 1].startswith("    S1; album:"), "single-quoted, folded onto the next lines")
		label = next(line for line in lines if line.startswith('  list_label: "'))
		self.assertTrue(label.endswith(backslash) and f"{backslash}xEB's films" in label, "double-quoted, escaped, continued")
		self.assertIn(f"    {backslash} {backslash}u6771{backslash}u4EAC edition\"", lines)
		self.assertIn("  list_playlist: 'Road Trip: 90''s #1'", lines)
		read = Utils.parse_yaml(text)
		self.assertEqual(read["name"], LONG_NAME)
		self.assertEqual((read[GAME]["list_titles"], read[GAME]["list_label"], read[GAME]["list_playlist"]),
		                 (LONG_TITLES, LONG_LABEL, LONG_PLAYLIST))

	def test_the_template_fixture_is_what_the_launcher_writes(self):
		self.assertTrue(os.path.exists(TEMPLATE_YAML), f"{TEMPLATE_YAML} is missing: run run.py --update-golden once and commit it")
		self.assertEqual(committed(TEMPLATE_YAML), self.template, "launcher_template.yaml is no longer what the Launcher's "
		                                                          "Generate Template Options writes; if the change is "
		                                                          "deliberate, rerun with --update-golden")

	def test_the_bot_fills_in_the_launcher_template_with_every_option_at_its_default(self):
		import Generate
		import Utils
		from worlds.AutoWorld import AutoWorldRegister

		text = self.template.replace("name: Player{number}", f"name: {TEMPLATE_NAME}")
		self.assertNotEqual(text, self.template)
		folder = os.path.join(STATE["root"], "h_template")
		os.makedirs(folder, exist_ok=True)
		source = os.path.join(folder, "template.yaml")
		target = os.path.join(folder, "filled.yaml")
		# As the Launcher saves it on Windows: a byte order mark and CRLF line ends.
		with open(source, "w", encoding="utf-8-sig", newline="\r\n") as handle:
			handle.write(text)
		summary = fill(source, target)
		self.assertEqual((summary["name"], summary["random"]), (TEMPLATE_NAME, []),
		                 "each weighted option has one choice above 0, which is all Archipelago can roll")
		with open(target, encoding="utf-8") as handle:
			filled = handle.read()
		self.assertIn("\n  goal_percent: 80\n", filled)
		self.assertIn("\n  list_preset: movies\n", filled)
		rolled = Generate.roll_settings(Utils.parse_yaml(filled))
		hints = AutoWorldRegister.world_types[GAME].options_dataclass.type_hints
		constants = sys.modules[AutoWorldRegister.world_types[GAME].__module__ + ".constants"]
		for key in [*constants.OPTIONS, *constants.LIST_OPTIONS]:
			self.assertEqual(getattr(rolled, key).value, hints[key].from_any(hints[key].default).value, key)
		self.assertEqual(rolled.progression_balancing.value, 50)

	def test_hand_edits_fill_into_files_archipelago_reads_the_same(self):
		import Utils

		custom = self.creator_text(CUSTOM_YAML)
		triggers = ("  triggers:\n  - option_category: Plex Media\n    option_name: wild_tickets\n    option_result: 3\n"
		            "    options:\n      Plex Media:\n        +local_items: [Wild Ticket]\n")
		cases = {
			"as exported": custom,
			"a float key after its + twin": custom + '  extra: {"+1": a, 1.0: b}\n',
			"a + key inside triggers": custom + triggers,
			"one weighted choice": custom.replace("  wild_tickets: 2\n", "  wild_tickets:\n    2: 0\n    5: 50\n"),
			"CR CR LF line ends": custom.replace("\n", "\r\r\n"),
		}
		folder = os.path.join(STATE["root"], "h_edits")
		os.makedirs(folder, exist_ok=True)
		filled = {}
		for what, text in cases.items():
			source = os.path.join(folder, "source.yaml")
			target = os.path.join(folder, "filled.yaml")
			with open(source, "w", encoding="utf-8", newline="") as handle:
				handle.write(text)
			fill(source, target)
			with open(target, encoding="utf-8") as handle:
				filled[what] = Utils.parse_yaml(handle.read())[GAME]
		extra = filled["a float key after its + twin"]["extra"]
		self.assertEqual(extra, {"+1": "a", 1.0: "b"})
		self.assertEqual([type(key) for key in extra], [str, float], "1.0 stays a float, which Python does not read as 1")
		self.assertEqual(filled["a + key inside triggers"]["triggers"], Utils.parse_yaml(cases["a + key inside triggers"])[GAME]["triggers"])
		self.assertEqual(filled["one weighted choice"]["wild_tickets"], 5)
		self.assertEqual(filled["CR CR LF line ends"], filled["as exported"], "a lone CR is a line break to both")

	def test_a_trigger_and_a_required_plando_work_in_the_filled_file_as_in_the_players_own(self):
		import copy
		import random

		import Generate
		import Utils
		from BaseClasses import PlandoOptions

		default = self.creator_text(DEFAULT_YAML)
		# The Creator writes the albums timer at off as 'off', which the bot would write as 0, and a trigger
		# compares the file's own spelling with its option_result.
		trigger = ("  triggers:\n  - option_category: Plex Media\n    option_name: timesanity_albums\n    option_result: 'off'\n"
		           "    options:\n      Plex Media:\n        wild_tickets: 5\n")
		plando = (default.replace(f"game: {GAME}\n", f"game: {GAME}\nrequires:\n  version: 0.6.8\n  plando: items\n", 1)
		          + "  plando_items:\n  - items: {Wild Ticket: 1}\n    locations: [Check 1]\n")
		folder = os.path.join(STATE["root"], "h_triggers")
		os.makedirs(folder, exist_ok=True)
		read = {}
		for what, text in (("trigger", default + trigger), ("plando", plando)):
			source = os.path.join(folder, f"{what}.yaml")
			target = os.path.join(folder, f"{what}.filled.yaml")
			with open(source, "w", encoding="utf-8", newline="") as handle:
				handle.write(text)
			fill(source, target)
			with open(target, encoding="utf-8") as handle:
				filled = Utils.parse_yaml(handle.read())
			original = Utils.parse_yaml(text)
			# The player's own file has no titles yet, and roll_settings checks them: it borrows the filled ones.
			original[GAME]["entries"] = filled[GAME]["entries"]
			read[what] = (original, filled)

		original, filled = read["trigger"]
		self.assertEqual(filled[GAME]["timesanity_albums"], "off")
		for seed in (1, 2, 3):
			rolled = []
			for doc in (original, filled):
				random.seed(seed)
				rolled.append(Generate.roll_settings(copy.deepcopy(doc)).wild_tickets.value)
			self.assertEqual(rolled, [5, 5], f"seed {seed}: the trigger fires in both")

		original, filled = read["plando"]
		self.assertEqual(filled["requires"]["plando"], "items")
		host = PlandoOptions.from_option_string("bosses, connections, texts")
		for doc in (original, filled):
			with self.assertRaises(Exception) as caught:
				Generate.roll_settings(copy.deepcopy(doc), host)
			self.assertEqual(str(caught.exception), "Settings reports required plando module items, which is not enabled.")
		with_items = host | PlandoOptions.items
		rolled = [repr(Generate.roll_settings(copy.deepcopy(doc), with_items).plando_items) for doc in (original, filled)]
		self.assertEqual(rolled[0], rolled[1])
		self.assertIn("Wild Ticket", rolled[1])

	def test_unfilled_both_files_stop_at_no_titles(self):
		folder = os.path.join(STATE["root"], "h_unfilled")
		players = os.path.join(folder, "players")
		out = os.path.join(folder, "out")
		os.makedirs(players)
		os.makedirs(out)
		try:
			for path in (DEFAULT_YAML, CUSTOM_YAML):
				shutil.copyfile(self.sources[path], os.path.join(players, os.path.basename(path)))
			# Generate logs each file's traceback at ERROR before it raises; the message is what is checked.
			logging.disable(logging.CRITICAL)
			try:
				with self.assertRaises(ValueError) as caught:
					ap_harness.generate(players, out, SEED)
			finally:
				logging.disable(logging.NOTSET)
			self.assertEqual(os.listdir(out), [])
		finally:
			shutil.rmtree(folder, ignore_errors=True)
		message = str(caught.exception)
		self.assertTrue(message.startswith("Encountered 2 error(s) in player files."), message)
		for name in (DEFAULT_NAME, CUSTOM_NAME):
			self.assertIn(f"Plex Media list of {name}: {NO_TITLES}", message)

	def test_the_bot_read_each_file_and_filled_in_the_titles(self):
		import Utils

		self.assertEqual(self.summaries[DEFAULT_NAME]["random"], [])
		self.assertEqual(self.summaries[CUSTOM_NAME]["random"], ["goal_percent"])
		self.assertEqual(self.summaries[CUSTOM_NAME]["label"], LABEL)
		with open(BUILDER1_YAML, encoding="utf-8") as handle:
			expected = Utils.parse_yaml(handle.read())[GAME]["entries"]
		self.assertEqual(len(expected), 10)
		labels = {DEFAULT_NAME: f"{DEFAULT_NAME}'s list", CUSTOM_NAME: LABEL}
		for name, world in self.worlds_by_name().items():
			with self.subTest(slot=name):
				self.assertEqual((self.summaries[name]["entriesCount"], self.summaries[name]["entries"]), (0, 10))
				data = plain(self.seed.md["slot_data"][world.player])
				self.assertEqual([(entry["k"], entry["id"], entry["t"]) for entry in data["entries"]],
				                 [(entry["k"], entry["id"], entry["t"]) for entry in expected])
				self.assertEqual((data["entry_count"], data["created_at"], data["label"]), (10, CREATED_AT, labels[name]))

	def test_each_filled_file_keeps_every_creator_setting_as_archipelago_reads_it(self):
		import Utils

		for name, path in ((DEFAULT_NAME, DEFAULT_YAML), (CUSTOM_NAME, CUSTOM_YAML)):
			with self.subTest(slot=name):
				creator = Utils.parse_yaml(self.creator_text(path))
				filled = Utils.parse_yaml(self.filled[name].decode("utf-8"))
				self.assertEqual(list(filled), ["name", "description", "game", "requires", GAME])
				self.assertEqual((filled["name"], filled["game"]), (name, GAME))
				self.assertEqual(filled["requires"], {"version": "0.6.8", "game": {GAME: WORLD_VERSION}})
				self.assertEqual(set(filled[GAME]), set(creator[GAME]) | {"list_info", "entries"})
				for key, value in creator[GAME].items():
					kept = filled[GAME][key]
					if value == "random":
						self.assertEqual(kept, "random", key)
					else:
						option = self.hints[key]
						self.assertEqual(option.from_any(kept).value, option.from_any(value).value, key)

	def test_archipelago_rolls_the_random_option_and_reads_the_rest(self):
		worlds = self.worlds_by_name()
		custom, default = worlds[CUSTOM_NAME], worlds[DEFAULT_NAME]
		self.assertIn(b'\n  goal_percent: "random"\n', self.filled[CUSTOM_NAME])
		rolled = custom.options.goal_percent.value
		self.assertTrue(1 <= rolled <= 100, rolled)
		data = plain(self.seed.md["slot_data"][custom.player])
		self.assertEqual((data["goal_percent"], data["goal_count"]), (rolled, custom.plan.goal_count))
		self.assertEqual(default.options.goal_percent.value, 80)
		self.assertEqual((custom.options.progression_balancing.value, default.options.progression_balancing.value), (30, 50))
		for world in (custom, default):
			self.assertEqual(world.options.accessibility.current_key, "items")
		# timesanity_movies chosen as off: the custom list's movies have no checkpoints, the default's do.
		self.assertEqual((data["timesanity"]["movie"], custom.options.timesanity_movies.value), (0, 0))
		movies = [entry["cp"] for entry in data["entries"] if entry["k"] == "movie"]
		self.assertEqual(movies, [[]] * 3)
		default_data = plain(self.seed.md["slot_data"][default.player])
		self.assertTrue(all(entry["cp"] for entry in default_data["entries"] if entry["k"] == "movie"))
		options = custom.options
		self.assertEqual((options.list_preset.current_key, options.list_movies.value, options.list_shows.value,
		                  options.list_titles.value, options.list_unwatched.value, options.list_label.value),
		                 ("mixed", 4, -1, "Alien; Aliens", 0, LABEL))
		options = default.options
		self.assertEqual((options.list_preset.current_key, options.list_movies.value, options.list_titles.value,
		                  options.list_unwatched.value, options.list_label.value), ("movies", -1, "", 1, ""))

	def test_regenerates_identically_under_another_hash_seed(self):
		mine = ap_harness.seed_digest(self.seed.md)
		hashseed = "1" if os.environ.get("PYTHONHASHSEED") != "1" else "2"
		child = run_child("regen", self.seed.players, os.path.join(self.seed.folder, "regen"), str(self.seed.seed),
		                  hashseed=hashseed)
		self.assertEqual(child["hashseed"], hashseed)
		self.assertEqual(child["digest"], mine)

	def test_the_ap_next_worker_rebuilds_and_verifies_both_slots(self):
		check_worker(self, self.seed, {"1": GAME, "2": GAME})


def run(only=None, verbosity=2):
	"""only: scenario class names to run (all when empty)."""
	module = sys.modules[__name__]
	if only:
		suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(getattr(module, name))
		                           for name in only)
	else:
		suite = unittest.defaultTestLoader.loadTestsFromModule(module)
	return unittest.TextTestRunner(verbosity=verbosity, stream=sys.stderr).run(suite).wasSuccessful()
