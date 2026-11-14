# apworld/tests/test_generate.py
# Generates real seeds with the owner's frozen Archipelago 0.6.8 and the built dist/plex_media.apworld.
#
# Scenarios (SPEC 4.10): (a) two solo lists, one in the YAML text the bot itself writes
# (renderYaml() of helpers/apMediaYaml.js, run through node -e) and the committed builder-1 fixture
# YAML, (b) a mixed list with every kind and every timer, (c) two Plex lists sharing titles beside a
# ChecksFinder slot, one with half its filler traps and Popcorn alone, the other excluding two of
# its tracks, which take room from its useful items, (d) season mode with checkpoints open to
# anything, (e) 600 unlock copies solo at spoiler 3 inside 90 s, and, beyond the SPEC's list, (f)
# two Plex lists naming one item link, which the world must warn about and leave empty while the
# multiworld still generates, and (h) a list with every list_* setting changed, which must give the
# same seed as the list without them. A1 runs the Archipelago Options Creator's own rules
# (OptionsCreator.py in AP 0.6.8) on the world's options: its groups, a widget for every option,
# what it exports for an untouched form, and that such a YAML, like the Launcher's own template,
# stops at the "no titles yet" message until the bot fills it in. Every seed must ship a data
# package of real names that passes archipelago.gg's upload check, name ids by title in MultiServer
# (a !hint for a title resolves), put every slot_data id in that slot's own locations or starting
# items, show titles in its spoiler, keep excluded locations to filler and traps, place exactly the
# plan's useful items, traps and snacks and say so in slot_data's pool, and give each location the
# rule of its own unit and step. (c) is generated again in a child process under another
# PYTHONHASHSEED and must come out identical, and the bot's own !ap next worker must rebuild (c) and
# (f) and verify every slot, and pick (f)'s yamls out of a Players folder that has moved on.
#
# Harness: unittest, run by run.py after it builds dist/plex_media.apworld with node
# scripts/build-apworld.js; prepare() loads Archipelago through ap_harness into a temp root that
# run.py removes afterwards (outputs embed host.yaml's server_options). Generations run one at a time
# because the PC runs hot. Bare assert is never used: -O strips it. Golden files are compared, or
# rewritten when run.py gets --update-golden: fixtures/builder1_mixed.expect.json pins builder 1's
# ids and names, test/fixtures/apmedia/slot_data_mixed.json is scenario (b)'s slot_data for the JS side.

import collections
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import ap_harness  # noqa: E402

GAME = "Plex Media"
WORLD_VERSION = "0.3.0"
CHILD = os.path.join(HERE, "ap_child.py")
FIXTURE_YAML = os.path.join(HERE, "fixtures", "builder1_mixed.yaml")
FIXTURE_EXPECT = os.path.join(HERE, "fixtures", "builder1_mixed.expect.json")
GOLDEN_SLOT_DATA = os.path.join(REPO, "test", "fixtures", "apmedia", "slot_data_mixed.json")
FIXED_GENERATED_AT = 1731300000
PLACEHOLDER = re.compile(r"\b(?:Unlock|Check) [0-9]+\b")

STATE = {"root": None, "apworld": None, "update": False, "warnings": None}


def prepare(root, apworld, update_golden=False):
	STATE.update(root=root, apworld=apworld, update=update_golden)
	ap_harness.load(root, apworld)
	STATE["warnings"] = ap_harness.quiet_logging()


def js(value):
	return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_text(path, text):
	with open(path, "w", encoding="utf-8", newline="\n") as handle:
		handle.write(text)


def write_list(folder, file_name, name, entries, options=None, extra=None, label=None):
	info = {"builder": 1, "created_at": 1731200000, "label": label or f"{name} list", "account": 1, "discord": "1234"}
	lines = [f"name: {js(name)}", f"description: {js(info['label'])}", "game: Plex Media", "requires:",
	         "  version: 0.6.8", "  game:", "    Plex Media: 0.1.0", "Plex Media:"]
	for key, value in {**(options or {}), **(extra or {})}.items():
		lines.append(f"  {key}: {js(value)}")
	lines.append(f"  list_info: {js(info)}")
	lines.append("  entries:")
	lines += [f"    - {js(entry)}" for entry in entries]
	write_text(os.path.join(folder, file_name), "\n".join(lines) + "\n")


def write_checksfinder(folder):
	write_text(os.path.join(folder, "C_Checks.yaml"), "name: Check Probe\ngame: ChecksFinder\nChecksFinder: {}\n")


def rendered_yaml(doc):
	"""The bytes of the file /apmedia yaml would attach for doc: helpers/apMediaYaml.js renderYaml()."""
	script = ("const { renderYaml } = require('./helpers/apMediaYaml.js'); "
	          "process.stdout.write(renderYaml(JSON.parse(require('fs').readFileSync(0, 'utf8'))));")
	proc = subprocess.run([shutil.which("node") or "node", "-e", script], input=json.dumps(doc).encode("utf-8"),
	                      cwd=REPO, capture_output=True, timeout=120)
	if proc.returncode:
		raise AssertionError(f"renderYaml failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'replace')}")
	return proc.stdout


def movie(rk, title, d, y=2000, guid=None):
	entry = {"k": "movie", "id": guid or f"rk:{rk}", "rk": rk}
	if guid:
		entry["g"] = guid
	entry.update(t=title, y=y, d=d)
	return entry


def episode(rk, show, sid, srk, sn, en, d):
	return {"k": "episode", "id": f"rk:{rk}", "rk": rk, "t": f"Episode {en}", "sh": show, "sid": sid, "srk": srk,
	        "sn": sn, "en": en, "d": d}


def album(rk, artist, title, tracks, twin=None):
	tr = [[rk * 10 + n, n, name, d, rk * 100 + n] for n, (name, d) in enumerate(tracks, 1)]
	entry = {"k": "album", "id": f"plex://album/{rk}", "rk": rk, "g": f"plex://album/{rk}", "ar": artist, "t": title,
	         "y": 2001, "d": sum(d for _n, d in tracks), "tr": tr}
	if twin:
		entry["alt"] = [[twin, [[twin * 10 + n, twin * 100 + n] for n in range(1, len(tracks) + 1)]]]
	return entry


def mix(pl, part, title, tracks):
	tr = [[pl * 10 + part * 5 + n, n, name, d, pl * 100 + part * 10 + n, artist]
	      for n, (name, artist, d) in enumerate(tracks, 1)]
	return {"k": "mix", "id": f"pl:{pl}:{part}", "pl": pl, "part": part, "t": title,
	        "d": sum(d for _n, _a, d in tracks), "tr": tr}


def book(rk, work, title, author, parts):
	return {"k": "book", "id": f"book:{work}", "w": work, "t": title, "au": author, "d": sum(parts),
	        "pa": [[rk * 10 + n, rk * 100 + n, d] for n, d in enumerate(parts, 1)]}


AMELIE = "Am" + chr(0xe9) + 'lie: "Le" #fabuleux ' + chr(0x1f37f)
TOKYO = chr(0x6771) + chr(0x4eac)
MATRIX = movie(2001, "The Matrix", 8160000, 1999, guid="plex://movie/5d7768b2")
BREAKING = ("Breaking Point", "plex://show/5eb6f2a1", 2100)


def mixed_entries():
	return [
		MATRIX,
		movie(2002, "Halloween", 6360000, 2018),
		movie(2003, "Halloween", 6300000, 2018),
		movie(2004, "1917", 7140000, None),
		movie(2005, "Popcorn", 600000, None),
		movie(2006, AMELIE, 7380000, 2001),
		*[episode(2100 + n, *BREAKING, 1, n, 2700000) for n in (1, 2, 3, 4)],
		episode(2105, *BREAKING, 0, 1, 1500000),
		episode(2201, "Tiny Show", "rk:2200", 2200, 1, 1, 1320000),
		episode(2202, "Tiny Show", "rk:2200", 2200, 1, 2, 1320000),
		album(2300, "Daft Punk", "Discovery", [("One More Time", 320000), ("Aerodynamic", 212000), ("Interlude", 15000),
		                                       ("Digital Love", 301000)], twin=2310),
		album(2400, "Daft Punk", "Discovery", [("Bonus Disc", 200000)]),
		mix(2500, 1, "Road Trip Part 1", [("Song A", "Artist A", 200000), (TOKYO, "Artist B", 180000),
		                                  ("Short One", "Artist C", 20000)]),
		mix(2500, 2, "Road Trip Part 2", [("Song D", "Artist D", 240000)]),
		book(2600, "jane-austen/pride-and-prejudice", "Pride and Prejudice", "Jane Austen", [3600000, 3000000]),
		book(2700, "j-r-r-tolkien/the-hobbit", "The Hobbit", "J. R. R. Tolkien", [3600000, 3600000, 2400000]),
	]


MIXED_OPTIONS = {"timesanity_movies": 15, "timesanity_episodes": 10, "timesanity_albums": 5, "timesanity_books": 30}

RENDERED_ENTRIES = [MATRIX, movie(2004, "1917", 7140000, None), movie(2006, AMELIE, 7380000, 2001),
                    episode(2101, *BREAKING, 1, 1, 2700000)]
RENDERED_DOC = {"name": "Render Fan", "label": "Rendered list", "createdAt": 1731200000,
                "options": {"goal_percent": 50, "wild_tickets": 1}, "entries": RENDERED_ENTRIES,
                "listInfo": {"account": 1, "discord": "1234"}}


class Seed:
	def __init__(self, name, seed, write_players, spoiler=3):
		self.folder = os.path.join(STATE["root"], name)
		self.players = os.path.join(self.folder, "players")
		self.out = os.path.join(self.folder, "out")
		os.makedirs(self.players)
		os.makedirs(self.out)
		write_players(self.players)
		self.seed = seed
		started = time.time()
		clock = time.perf_counter()
		self.multiworld, self.zip = ap_harness.generate(self.players, self.out, seed, spoiler)
		self.seconds = time.perf_counter() - clock
		self.window = (int(started), int(time.time()) + 1)
		self.md, self.spoiler = ap_harness.read_output(self.zip)
		self.worlds = list(self.multiworld.get_game_worlds(GAME))

	def remove(self):
		shutil.rmtree(self.folder, ignore_errors=True)


def golden(path, value):
	"""value matches the committed file, or (run.py --update-golden) becomes it."""
	if STATE["update"]:
		os.makedirs(os.path.dirname(path), exist_ok=True)
		write_text(path, json.dumps(value, ensure_ascii=False, indent="\t") + "\n")
		return None
	if not os.path.exists(path):
		return f"{path} is missing: run run.py --update-golden once and commit it"
	with open(path, encoding="utf-8") as handle:
		committed = json.load(handle)
	if committed != value:
		return f"{os.path.basename(path)} no longer matches; if the change is deliberate, rerun with --update-golden"
	return None


def plain(value):
	return json.loads(json.dumps(value))


def slot_location_ids(entry):
	ids = [checkpoint[1] for checkpoint in entry["cp"]]
	if entry["k"] in ("movie", "episode"):
		ids.append(entry["w"])
	elif entry["k"] == "book":
		ids.append(entry["f"])
	else:
		ids += [track[-1] for track in entry["tr"] if track[-1] is not None]
	return ids


class SeedChecks:
	"""What every scenario's seed must pass; each subclass makes cls.seed in setUpClass."""

	seed = None

	@classmethod
	def tearDownClass(cls):
		if cls.seed is not None:
			cls.seed.remove()

	def test_data_package_ships_real_names_and_passes_the_upload_check(self):
		import schema
		import worlds
		from worlds.AutoWorld import data_package_checksum

		md = self.seed.md
		package = md["datapackage"][GAME]
		self.assertEqual(list(package), ["item_name_groups", "item_name_to_id", "location_name_groups",
		                                 "location_name_to_id", "checksum"])
		# WebHostLib/upload.py L27-34 and L55-67, as archipelago.gg runs it on upload.
		games_package_schema = schema.Schema({
			"item_name_groups": {str: [str]},
			"item_name_to_id": {str: int},
			"location_name_groups": {str: [str]},
			"location_name_to_id": {str: int},
			schema.Optional("checksum"): str,
			schema.Optional("version"): int,
		})
		for game, game_data in md["datapackage"].items():
			data = dict(game_data)
			original = data.pop("checksum")
			data = games_package_schema.validate(data)
			data = {key: value for key, value in sorted(data.items())}
			self.assertEqual(data_package_checksum(data), original, game)
		units = {world.registry.unit_name[unit.key] for world in self.seed.worlds for unit in world.plan.units}
		constants = sys.modules[type(self.seed.worlds[0]).__module__ + ".constants"]
		self.assertEqual(set(package["item_name_to_id"]), set(constants.fixed_items()) | units)
		locations = set()
		for world in self.seed.worlds:
			locations |= set(md["locations"][world.player])
		self.assertEqual(set(package["location_name_to_id"].values()), locations)
		for name in list(package["item_name_to_id"]) + list(package["location_name_to_id"]):
			self.assertIsNone(PLACEHOLDER.fullmatch(name), name)
		static = worlds.network_data_package["games"][GAME]
		self.assertEqual(static["item_name_to_id"]["Unlock 1"], 1347001001, "the static package is untouched")

	def test_server_names_ids_by_title_and_resolves_a_hint(self):
		import MultiServer
		import Utils

		md = self.seed.md
		package = md["datapackage"][GAME]
		ctx = MultiServer.Context("127.0.0.1", 0, "", "", 1, 10, False)
		ctx.load(self.seed.zip)
		for name, code in package["item_name_to_id"].items():
			self.assertEqual(ctx.item_names[GAME][code], name)
		for name, code in package["location_name_to_id"].items():
			self.assertEqual(ctx.location_names[GAME][code], name)
		self.assertIn("Movies", ctx.all_item_and_group_names[GAME])
		world = self.seed.worlds[0]
		unit = next(unit for unit in world.plan.units if unit.steps > unit.start)
		name = world.registry.unit_name[unit.key]
		picked, usable, _response = Utils.get_intended_text(name.lower(), ctx.all_item_and_group_names[GAME])
		self.assertTrue(usable)
		self.assertEqual(picked, name)
		self.assertEqual(len(MultiServer.collect_hints(ctx, 0, world.player, picked)), unit.steps - unit.start)

	def test_slot_data_ids_are_the_slots_own(self):
		md = self.seed.md
		for world in self.seed.worlds:
			player = world.player
			data = plain(md["slot_data"][player])
			self.assertEqual(data["schema"], 1)
			self.assertEqual(data["world_version"], WORLD_VERSION)
			low, high = self.seed.window
			self.assertTrue(low <= data["generated_at"] <= high, data["generated_at"])
			used = [i for entry in data["entries"] for i in slot_location_ids(entry)]
			self.assertEqual(len(used), len(set(used)))
			self.assertEqual(set(used), set(md["locations"][player]))
			placed = collections.Counter(code for table in md["locations"].values()
			                             for (code, receiver, _flags) in table.values() if receiver == player)
			start = collections.Counter(md["precollected_items"][player])
			self.assertEqual(len(data["units"]), len(world.plan.units))
			for unit in data["units"]:
				self.assertEqual(start[unit["id"]], unit["start"], unit["name"])
				self.assertEqual(placed[unit["id"]], unit["steps"] - unit["start"], unit["name"])
			self.assertEqual(placed[data["items"]["wild_ticket"]], world.plan.wild)
			items = data["items"]
			self.assertEqual([placed[items["useful"][key]] for key in ("fast_forward", "remote_control")],
			                 [world.plan.fast_forwards, world.plan.remote_controls])
			self.assertEqual({key: placed[code] for key, code in items["traps"].items()}, world.plan.traps)
			self.assertEqual({name: placed[code] for name, code in items["snacks"].items()}, world.plan.snacks)
			self.assertEqual(data["snack_bar"], {"trades": world.options.snack_bar_trades.value,
			                                     "price": world.options.snack_bar_price.value})
			# The counts the plan placed above, after exclude_locations took its share of the useful items.
			self.assertEqual(data["pool"], {"snacks": sum(world.plan.snacks.values()), "traps": world.plan.traps,
			                                "fast_forwards": world.plan.fast_forwards,
			                                "remote_controls": world.plan.remote_controls, "wild_tickets": world.plan.wild})
			self.assertEqual(sum(start.values()), world.plan.start)

	def test_spoiler_shows_titles_not_placeholders(self):
		spoiler = self.seed.spoiler
		found = PLACEHOLDER.search(spoiler)
		self.assertIsNone(found, found and found[0])
		for world in self.seed.worlds:
			location = world.placed[0][0]
			self.assertIn(location.name, spoiler)

	def test_excluded_locations_hold_only_filler_and_traps(self):
		from BaseClasses import LocationProgressType

		md = self.seed.md
		for world in self.seed.worlds:
			filler_only = world.options.checkpoint_items.current_key == "filler_only"
			checkpoint_ids = {world.registry.location_id[pe.checkpoint_key(minute)]
			                  for pe in world.plan.entries for minute in pe.minutes}
			for location, _pe in world.placed:
				if location.address not in checkpoint_ids:
					excluded = location.name in world.options.exclude_locations.value
					self.assertEqual(location.progress_type == LocationProgressType.EXCLUDED, excluded, location.name)
					if excluded:
						_code, _receiver, flags = md["locations"][world.player][location.address]
						self.assertEqual(flags & 0b011, 0, location.name)
					continue
				excluded = location.progress_type == LocationProgressType.EXCLUDED
				self.assertEqual(excluded, filler_only, location.name)
				if filler_only:
					_code, _receiver, flags = md["locations"][world.player][location.address]
					self.assertEqual(flags & 0b011, 0, location.name)

	def test_rules_use_their_own_unit_and_step(self):
		from BaseClasses import CollectionState

		for world in self.seed.worlds:
			state = CollectionState(self.seed.multiworld)
			player = world.player
			for location, pe in world.placed:
				unit = world.registry.unit_name[pe.unit]
				state.prog_items[player] = collections.Counter({unit: pe.step - 1})
				self.assertFalse(location.access_rule(state), location.name)
				state.prog_items[player] = collections.Counter({unit: pe.step})
				self.assertTrue(location.access_rule(state), location.name)
			counter = "Plex Media Unlocked Entries"
			state.prog_items[player] = collections.Counter({counter: world.plan.goal_count - 1})
			self.assertFalse(world.goal_location.access_rule(state))
			state.prog_items[player] = collections.Counter({counter: world.plan.goal_count})
			self.assertTrue(world.goal_location.access_rule(state))

	def test_goal_counter_follows_collect_and_remove(self):
		from BaseClasses import CollectionState

		counter = "Plex Media Unlocked Entries"
		start = CollectionState(self.seed.multiworld)
		# Without the sweep: after the fill a sweep would collect every placed copy a second time.
		full = self.seed.multiworld.get_all_state(perform_sweep=False)
		for world in self.seed.worlds:
			player = world.player
			self.assertEqual(start.prog_items[player][counter],
			                 sum(unit.prefix[unit.start] for unit in world.plan.units))
			self.assertEqual(full.prog_items[player][counter], len(world.plan.entries))
			unit = max(world.plan.units, key=lambda u: (u.steps, u.key))
			name = world.registry.unit_name[unit.key]
			item = next(item for item in self.seed.multiworld.itempool if item.player == player and item.name == name)
			full.remove(item)
			self.assertEqual(full.prog_items[player][counter],
			                 len(world.plan.entries) - (unit.prefix[unit.steps] - unit.prefix[unit.steps - 1]))
			full.collect(item, True)
			self.assertEqual(full.prog_items[player][counter], len(world.plan.entries))


class A0_BuiltApworld(unittest.TestCase):
	"""The file Archipelago loaded is the one scripts/build-apworld.js wrote, and its options match the table."""

	def test_loaded_from_the_built_zip(self):
		import zipfile
		from worlds.AutoWorld import AutoWorldRegister

		with zipfile.ZipFile(STATE["apworld"]) as archive:
			self.assertIsNone(archive.testzip())
			# The Launcher's Install APWorld check (worlds/LauncherComponents.py L148-155).
			folders = [entry.name for entry in zipfile.Path(archive).iterdir() if entry.is_dir()]
			self.assertEqual(folders, ["plex_media"])
			archive.open("plex_media/__init__.py").close()
		world = AutoWorldRegister.world_types[GAME]
		self.assertEqual(world.world_version.as_simple_string(), WORLD_VERSION)
		self.assertEqual(sys.modules[world.__module__ + ".constants"].WORLD_VERSION, WORLD_VERSION)
		self.assertEqual(world.manifest.get("minimum_ap_version"), "0.6.8")
		loaded = os.path.join(STATE["root"], "worlds", "plex_media.apworld")
		self.assertEqual(os.path.normcase(str(world.zip_path)), os.path.normcase(loaded))
		with open(loaded, "rb") as installed, open(STATE["apworld"], "rb") as built:
			self.assertEqual(installed.read(), built.read())
		self.assertEqual(len(world.item_name_to_id), 20017)
		groups = {name: set(members) for name, members in world.item_name_groups.items() if name != "Everything"}
		self.assertEqual(groups, {
			"Snacks": {"Popcorn", "Nachos", "Large Soda", "Candy Bar", "Hot Dog", "Soft Pretzel", "Ice Cream Sandwich"},
			"Useful": {"Wild Ticket", "Fast Forward", "Remote Control"},
			"Traps": {"Buffering", "Rights Expired", "Commercial Break", "Shuffle Mode", "Rewind", "Intermission",
			          "Slow Motion"},
		})
		self.assertEqual(len(world.location_name_to_id), 60000)

	def test_option_classes_follow_the_table(self):
		from worlds.AutoWorld import AutoWorldRegister

		table = sys.modules[AutoWorldRegister.world_types[GAME].__module__ + ".constants"].OPTIONS
		hints = AutoWorldRegister.world_types[GAME].options_dataclass.type_hints
		for key, spec in table.items():
			option = hints[key]
			with self.subTest(option=key):
				if spec["type"] == "range":
					self.assertEqual((option.range_start, option.range_end, option.default),
					                 (spec["min"], spec["max"], spec["default"]))
				elif spec["type"] == "choice":
					self.assertEqual([option.name_lookup[i] for i in sorted(option.name_lookup)], spec["values"])
					self.assertEqual(option.name_lookup[option.default], spec["default"])
				else:
					self.assertEqual(bool(option.default), spec["default"])
		for key in ("entries", "list_info", "accessibility"):
			self.assertIn(key, hints)
		self.assertNotIn("start_inventory_from_pool", hints)

	def test_hidden_options_named_offs_and_world_flags(self):
		from Options import NamedRange, Visibility
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		hints = world.options_dataclass.type_hints
		for key in ("entries", "list_info"):
			self.assertEqual(hints[key].visibility, Visibility.none, key)
		for key in ("timesanity_movies", "timesanity_episodes", "timesanity_albums", "timesanity_books"):
			self.assertTrue(issubclass(hints[key], NamedRange), key)
			self.assertEqual(hints[key].special_range_names, {"off": 0}, key)
		self.assertIs(world.disable_ut, True)
		self.assertEqual(tuple(world.required_client_version), (0, 5, 0))

	def test_each_timer_reads_an_unquoted_off_as_off(self):
		import Utils
		from worlds.AutoWorld import AutoWorldRegister

		hints = AutoWorldRegister.world_types[GAME].options_dataclass.type_hints
		for key in ("timesanity_movies", "timesanity_episodes", "timesanity_albums", "timesanity_books"):
			option = hints[key]
			with self.subTest(option=key):
				# Archipelago reads YAML 1.1, where unquoted off, no and false are all the boolean false.
				for written in ("off", "Off", "no", "false"):
					read = Utils.parse_yaml(f"{key}: {written}\n")[key]
					self.assertIs(read, False, written)
					self.assertEqual(option.from_any(read).value, 0, written)
				for given in ("off", "OFF", "false", "False", 0, "0"):
					self.assertEqual(option.from_any(given).value, 0, given)
				# true keeps Range's rule, the default when it is not 0, which the bot's parser follows.
				if option.default:
					self.assertEqual(option.from_any(True).value, option.default)
				else:
					with self.assertRaises(Exception):
						option.from_any(True)

	def test_tooltips_name_options_as_the_creator_shows_them(self):
		import re

		from Options import Visibility
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		constants = sys.modules[world.__module__ + ".constants"]
		hints = world.options_dataclass.type_hints
		shown = {key: option for key, option in hints.items()
		         if option.__module__ == world.__module__ + ".options" and option.visibility & Visibility.simple_ui}
		self.assertEqual(set(shown), {*constants.OPTIONS, *constants.LIST_OPTIONS})
		titles = [option.display_name for option in shown.values()]
		keys = [key for key in hints if "_" in key]
		for key, option in shown.items():
			doc = option.__doc__
			with self.subTest(option=key):
				# The Options Creator labels each option with its display_name; a YAML key is never on screen.
				for other in keys:
					self.assertIsNone(re.search(rf"\b{re.escape(other)}\b", doc), other)
				# filter_tooltip (OptionsCreator.py L44-51) turns each newline into a line break, so a name
				# wrapped across two source lines would break on screen too.
				for found in re.finditer(r"List:\s", doc):
					self.assertTrue(any(doc.startswith(title, found.start()) for title in titles),
					                doc[found.start():found.start() + 40])
		self.assertIn("taking up to List: Episodes per Show episodes from each",
		              " ".join(shown["list_shows"].__doc__.split()))

	def test_list_option_classes_follow_the_list_table(self):
		from Options import Choice, DefaultOnToggle, FreeText, NamedRange, Range, TextChoice, Toggle, Visibility
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		table = sys.modules[world.__module__ + ".constants"].LIST_OPTIONS
		hints = world.options_dataclass.type_hints
		self.assertEqual([key for key in hints if key in table], list(table))
		for key, spec in table.items():
			option = hints[key]
			with self.subTest(option=key):
				self.assertEqual(option.visibility, Visibility.all)
				self.assertTrue(option.__doc__.startswith("The bot reads this when it fills in your titles (/apmedia "
				                                          "yaml): "), option.__doc__)
				if spec["type"] == "named_range":
					self.assertTrue(issubclass(option, NamedRange))
					self.assertEqual((option.range_start, option.range_end), (spec["min"], spec["max"]))
					self.assertEqual(option.special_range_names, spec["special"])
					self.assertEqual(option.default, spec["special"][spec["default"]])
				elif spec["type"] == "range":
					self.assertTrue(issubclass(option, Range) and not issubclass(option, NamedRange))
					self.assertEqual((option.range_start, option.range_end, option.default),
					                 (spec["min"], spec["max"], spec["default"]))
				elif spec["type"] == "choice":
					self.assertTrue(issubclass(option, Choice) and not issubclass(option, TextChoice))
					self.assertEqual([option.name_lookup[i] for i in sorted(option.name_lookup)], spec["values"])
					self.assertEqual(option.name_lookup[option.default], spec["default"])
				elif spec["type"] == "toggle":
					self.assertTrue(issubclass(option, DefaultOnToggle if spec["default"] else Toggle))
					self.assertEqual(bool(option.default), spec["default"])
				else:
					self.assertEqual(spec["type"], "text")
					self.assertTrue(issubclass(option, FreeText))
					self.assertEqual(option.default, spec["default"])
		self.assertEqual(hints["list_preset"].__doc__.splitlines()[1:], [
			"movies: 15 movies", "tv: 3 shows", "music: 10 albums", "books: 3 audiobooks",
			"mixed: 6 movies, 1 show, 4 albums and 1 audiobook",
			"none: 0 of each, so the list holds only the counts you set and the titles, playlist or collection you name",
		])


# OptionsCreator.py in AP 0.6.8, disassembled from lib/library.zip: create_option (L520-536) asks in
# this order, and an option it matches nothing for gets "This option isn't supported by the option
# creator". It reads web.option_groups (create_options_panel L602-612) and offers what it stores for
# an option the player leaves alone (create_range L330, create_named_range L361-381, create_toggle
# L446, create_choice L419, create_free_text L391, create_option_set_list_counter L499-505).
def creator_widget(option):
	from Options import Choice, FreeText, NamedRange, OptionCounter, OptionList, OptionSet, Range, TextChoice, Toggle

	for kind, base in (("named_range", NamedRange), ("range", Range), ("toggle", Toggle), ("text_choice", TextChoice),
	                   ("choice", Choice), ("text", FreeText)):
		if issubclass(option, base):
			return kind
	if any(issubclass(option, base) for base in (OptionSet, OptionList, OptionCounter)):
		return "list"
	return None


def creator_panel(world):
	"""{group name: [(option name, class)]} as the Creator lays them out, hidden options left out."""
	from Options import Visibility

	groups = {name: [] for name in ["Game Options", *(group.name for group in world.web.option_groups)]}
	for key, option in world.options_dataclass.type_hints.items():
		group = next((group.name for group in world.web.option_groups if option in group.options), "Game Options")
		groups[group].append((key, option))
	shown = {name: [(key, option) for key, option in options if key and option.visibility & Visibility.simple_ui]
	         for name, options in groups.items()}
	return {name: options for name, options in shown.items() if options}


def creator_untouched(option):
	"""What the Creator exports for an option nobody touched, or None when it has no widget for it."""
	import copy

	from Options import OptionCounter

	kind = creator_widget(option)
	if kind in ("range", "text"):
		return option.default
	if kind == "named_range":
		if option.default not in option.special_range_names and option.default in option.special_range_names.values():
			return next(name for name, value in option.special_range_names.items() if value == option.default)
		return option.default
	if kind == "toggle":
		return bool(option.default)
	if kind in ("choice", "text_choice"):
		return option.default if isinstance(option.default, str) else option.name_lookup[option.default]
	if kind == "list":
		return copy.deepcopy(option.default) if issubclass(option, OptionCounter) else sorted(option.default)
	return None


def creator_export(world, name):
	"""The file the Creator's Export Options writes for an untouched form (OptionsCreator.export_options)."""
	import Utils

	values = {}
	for options in creator_panel(world).values():
		for key, option in options:
			if creator_widget(option) is not None:
				values[key] = creator_untouched(option)
	return Utils.dump({"name": name, "description": f"YAML generated by Archipelago {Utils.__version__}.",
	                   "game": world.game, world.game: values}, sort_keys=False)


def launcher_template():
	"""The text of the Launcher's Generate Template Options file for Plex Media, made once per root."""
	import Options

	folder = os.path.join(STATE["root"], "templates")
	path = os.path.join(folder, f"{GAME}.yaml")
	if not os.path.exists(path):
		Options.generate_yaml_templates(folder, False)
	with open(path, encoding="utf-8-sig") as handle:
		return handle.read()


LIST_GROUP = "Your list (the bot picks the titles)"
ITEMS_GROUP = "Items and traps"
NO_TITLES = ("this YAML has no titles yet. Attach it to /apmedia yaml in Discord, and the bot picks them from the "
             "Plex library.")


class A1_OptionsCreator(unittest.TestCase):
	"""The Archipelago Options Creator's rules, run on the loaded world: what a player sees and exports."""

	@staticmethod
	def loaded():
		from worlds.AutoWorld import AutoWorldRegister

		world = AutoWorldRegister.world_types[GAME]
		return world, sys.modules[world.__module__ + ".constants"]

	def test_every_game_and_list_option_gets_a_widget_in_its_group(self):
		world, constants = self.loaded()
		panel = creator_panel(world)
		names = {group: [key for key, _option in options] for group, options in panel.items()}
		self.assertEqual(list(names)[:5], ["Game Options", LIST_GROUP, "Unlocks and goal", "Timesanity", ITEMS_GROUP])
		self.assertEqual(names["Game Options"], ["progression_balancing", "accessibility"])
		self.assertEqual(names[LIST_GROUP], list(constants.LIST_OPTIONS))
		self.assertEqual(names["Unlocks and goal"], ["starting_unlocks", "goal_percent", "tv_unlock",
		                                             "episodes_per_unlock", "locked_watches", "wild_tickets"])
		self.assertEqual(names["Timesanity"], ["checkpoint_items", "timesanity_strict", "timesanity_movies",
		                                       "timesanity_episodes", "timesanity_albums", "timesanity_books"])
		self.assertEqual(names[ITEMS_GROUP], ["snack_variety", "fast_forwards", "remote_controls", "snack_bar_trades",
		                                      "snack_bar_price", "trap_percentage", "buffering_weight",
		                                      "rights_expired_weight", "commercial_break_weight", "shuffle_mode_weight",
		                                      "rewind_weight", "intermission_weight", "slow_motion_weight"])
		shown = {key: option for options in panel.values() for key, option in options}
		for key in ("entries", "list_info"):
			self.assertNotIn(key, shown)
		for key in [*constants.OPTIONS, *constants.LIST_OPTIONS]:
			with self.subTest(option=key):
				self.assertIn(key, shown)
				self.assertIsNotNone(creator_widget(shown[key]))
		for key, spec in constants.LIST_OPTIONS.items():
			self.assertEqual(creator_widget(shown[key]), spec["type"], key)
		# The templates list each group in the group's own order; the Creator uses the dataclass's.
		from Options import get_option_groups

		templated = get_option_groups(world)
		for group in (LIST_GROUP, "Unlocks and goal", "Timesanity", ITEMS_GROUP):
			self.assertEqual(list(templated[group]), names[group], group)

	def test_an_untouched_form_exports_the_list_defaults(self):
		world, constants = self.loaded()
		hints = world.options_dataclass.type_hints
		untouched = {key: creator_untouched(hints[key]) for key in constants.LIST_OPTIONS}
		self.assertEqual(untouched, {"list_preset": "movies", "list_movies": "preset", "list_shows": "preset",
		                             "list_albums": "preset", "list_books": "preset", "list_titles": "",
		                             "list_playlist": "", "list_collection": "", "list_genre": "", "list_years": "",
		                             "list_unwatched": True, "list_max_episodes": 24, "list_label": ""})
		for key in ("list_movies", "list_shows", "list_albums", "list_books"):
			option = hints[key]
			# data/optionscreator.kv puts the slider at min(max(default, start), end) for a number default,
			# and create_named_range then names the special on the button.
			self.assertEqual(min(max(option.default, option.range_start), option.range_end), 0, key)
			self.assertEqual(creator_untouched(option).title(), "Preset", key)

	def test_counts_take_preset_by_name_and_by_number(self):
		world, _constants = self.loaded()
		hints = world.options_dataclass.type_hints
		for key in ("list_movies", "list_shows", "list_albums", "list_books"):
			option = hints[key]
			with self.subTest(option=key):
				# Range.from_text reads default and true as the default, and false as 0, whenever range_start is
				# 0 and the default is not: so a YAML boolean on a count means preset or none to AP.
				for given in (option.default, "preset", "Preset", -1, "-1", "default", True, "true"):
					self.assertEqual(option.from_any(given).value, -1, given)
				for given, value in ((0, 0), (False, 0), ("low", 0), ("high", option.range_end),
				                     (option.range_end, option.range_end), (str(option.range_end), option.range_end)):
					self.assertEqual(option.from_any(given).value, value, given)
				for bad in (-2, option.range_end + 1, "lots"):
					with self.assertRaises(Exception, msg=bad):
						option.from_any(bad)

	def test_a_creator_yaml_stops_at_no_titles_until_the_bot_fills_it_in(self):
		import Generate
		import Utils
		from Options import OptionError

		world, _constants = self.loaded()
		text = creator_export(world, "Creator Fan")
		weights = Utils.parse_yaml(text)
		self.assertNotIn("requires", weights)
		self.assertEqual(weights[GAME]["list_movies"], "preset")
		with self.assertRaises(OptionError) as caught:
			Generate.roll_settings(weights)
		self.assertEqual(str(caught.exception), f"Plex Media list of Creator Fan: {NO_TITLES}")
		filled = Utils.parse_yaml(text)
		filled[GAME]["entries"] = [MATRIX]
		rolled = Generate.roll_settings(filled)
		self.assertEqual((rolled.list_preset.current_key, rolled.list_movies.value, rolled.list_titles.value,
		                  rolled.list_unwatched.value, rolled.list_max_episodes.value), ("movies", -1, "", 1, 24))

	def test_the_template_offers_every_list_setting(self):
		import Utils

		text = launcher_template()
		template = Utils.parse_yaml(text)[GAME]
		world, constants = self.loaded()
		self.assertEqual([key for key in template if key in constants.LIST_OPTIONS], list(constants.LIST_OPTIONS))
		self.assertNotIn("entries", template)
		self.assertNotIn("list_info", template)
		self.assertIn(f"# {LIST_GROUP} #", text)
		self.assertIn("preset: 50 # equivalent to -1", text)
		self.assertEqual(template["list_movies"], {"preset": 50, "random": 0, "random-low": 0, "random-high": 0,
		                                           "random-range-0-200": 0})
		self.assertEqual(template["list_preset"], {"movies": 50, "tv": 0, "music": 0, "books": 0, "mixed": 0, "none": 0})
		self.assertEqual(template["list_titles"], {"": 50})
		self.assertEqual(template["list_unwatched"], {"false": 0, "true": 50})
		hints = world.options_dataclass.type_hints
		for key in constants.LIST_OPTIONS:
			weights = template[key]
			picked = max(weights, key=weights.get)
			option = hints[key]
			self.assertEqual(option.from_any(picked).value, option.from_any(option.default).value, key)

	def test_the_launcher_template_stops_at_no_titles_until_the_bot_fills_it_in(self):
		import Generate
		import Utils
		from Options import OptionError

		text = launcher_template()
		weights = Utils.parse_yaml(text)
		# timesanity_albums defaults to its special off, so the template writes an unquoted off for it,
		# which YAML 1.1 reads as false.
		self.assertIn("    off: 50 # equivalent to 0\n", text)
		self.assertEqual(weights[GAME]["timesanity_albums"][False], 50)
		with self.assertRaises(OptionError) as caught:
			Generate.roll_settings(weights)
		self.assertEqual(str(caught.exception), f"Plex Media list of {weights['name']}: {NO_TITLES}")
		filled = Utils.parse_yaml(text)
		filled[GAME]["entries"] = [MATRIX]
		rolled = Generate.roll_settings(filled)
		world, constants = self.loaded()
		hints = world.options_dataclass.type_hints
		for key in [*constants.OPTIONS, *constants.LIST_OPTIONS]:
			self.assertEqual(getattr(rolled, key).value, hints[key].from_any(hints[key].default).value, key)
		self.assertEqual(rolled.timesanity_albums.value, 0)


class A_FixtureSolo(SeedChecks, unittest.TestCase):
	"""(a) the committed builder-1 YAML, rolled solo; its ids and names are frozen."""

	@classmethod
	def setUpClass(cls):
		cls.seed = Seed("a_fixture", 101, lambda folder: shutil.copyfile(
			FIXTURE_YAML, os.path.join(folder, "builder1_mixed.yaml")))

	def test_builder_1_ids_and_names_are_unchanged(self):
		md = self.seed.md
		package = md["datapackage"][GAME]
		data = plain(md["slot_data"][1])
		data.pop("generated_at")
		problem = golden(FIXTURE_EXPECT, {
			"item_name_to_id": package["item_name_to_id"],
			"location_name_to_id": package["location_name_to_id"],
			"slot_data": data,
		})
		self.assertIsNone(problem, problem)

	def test_fixture_reads_as_written(self):
		data = plain(self.seed.md["slot_data"][1])
		self.assertEqual((data["label"], data["created_at"]), ("Fixture list", 1731200000))
		# list_info's account and discord stay in the YAML: slot_data is readable by any client of the slot.
		self.assertNotIn("account", data)
		self.assertNotIn("discord", data)
		self.assertEqual((data["entry_count"], data["goal_count"]), (10, 8))
		names = set(self.seed.md["datapackage"][GAME]["item_name_to_id"])
		self.assertIn("1917 (movie)", names)
		self.assertIn("Show: \"Quoted\" #1 " + chr(0x1f3ac) + ": Next 3 Episodes", names)


class A_RenderedSolo(SeedChecks, unittest.TestCase):
	"""(a) a list in the exact text the bot's renderYaml() writes, rolled solo."""

	@classmethod
	def setUpClass(cls):
		cls.yaml = rendered_yaml(RENDERED_DOC)

		def write_players(folder):
			with open(os.path.join(folder, "Render_Fan.yaml"), "wb") as handle:
				handle.write(cls.yaml)

		cls.seed = Seed("a_rendered", 102, write_players)

	def test_rendered_list_reads_as_written(self):
		self.assertNotIn(b"\r", self.yaml)
		data = plain(self.seed.md["slot_data"][1])
		self.assertEqual((data["label"], data["created_at"], data["builder"]), ("Rendered list", 1731200000, 1))
		self.assertNotIn("discord", data)
		self.assertIn(b'"discord":"1234"', self.yaml)
		self.assertEqual((data["entry_count"], data["goal_percent"], data["goal_count"]), (4, 50, 2))
		# slot_data carries no wild_tickets. Dropped, the option's default 2 would give 2 here: W = clamp(wt, 0, 3).
		world = self.seed.worlds[0]
		self.assertEqual((world.options.wild_tickets.value, world.plan.wild), (1, 1))
		self.assertEqual([entry["id"] for entry in data["entries"]], [entry["id"] for entry in RENDERED_ENTRIES])
		names = set(self.seed.md["datapackage"][GAME]["item_name_to_id"])
		for expected in ("The Matrix (1999)", "1917 (movie)", f"{AMELIE} (2001)", "Breaking Point: Next 3 Episodes"):
			self.assertIn(expected, names)


class B_MixedSolo(SeedChecks, unittest.TestCase):
	"""(b) every kind and every timer; its slot_data is the JS side's golden file."""

	@classmethod
	def setUpClass(cls):
		cls.seed = Seed("b_mixed", 202, lambda folder: write_list(folder, "B_Mixed.yaml", "Mixed Fan", mixed_entries(),
		                                                         MIXED_OPTIONS, label="Mixed list"))

	def test_slot_data_golden_file(self):
		data = plain(self.seed.md["slot_data"][1])
		data["generated_at"] = FIXED_GENERATED_AT
		problem = golden(GOLDEN_SLOT_DATA, data)
		self.assertIsNone(problem, problem)

	def test_collisions_and_numeric_titles(self):
		names = set(self.seed.md["datapackage"][GAME]["item_name_to_id"])
		for expected in ("The Matrix (1999)", "Halloween (2018)", "Halloween (2018) [2003]", "1917 (movie)",
		                 "Popcorn", "Popcorn [2005]", "Daft Punk - Discovery", "Daft Punk - Discovery [2400]",
		                 "Breaking Point: Next 3 Episodes", "Road Trip Part 1 (playlist)",
		                 "Pride and Prejudice by Jane Austen", f"{AMELIE} (2001)"):
			self.assertIn(expected, names)
		locations = self.seed.md["datapackage"][GAME]["location_name_to_id"]
		self.assertIn("Daft Punk - Discovery #04 Digital Love", locations)
		self.assertNotIn("Daft Punk - Discovery #03 Interlude", locations)
		self.assertIn(f"Road Trip Part 1 #02 Artist B - {TOKYO}", locations)
		self.assertIn("Breaking Point S00E01 @ 10m", locations)
		self.assertIn("The Hobbit @ 2h", locations)
		self.assertNotIn("The Hobbit @ 2h30m", locations)
		self.assertIn("Halloween (2018) @ 15m [2003]", locations)
		# Album and mix checkpoints run on the sum of the tracks (14m08s and 6m40s here), cut at 90%.
		self.assertIn("Daft Punk - Discovery @ 5m", locations)
		self.assertIn("Daft Punk - Discovery @ 10m", locations)
		self.assertNotIn("Daft Punk - Discovery @ 15m", locations)
		self.assertIn("Road Trip Part 1 @ 5m", locations)


def shared_players(folder):
	alpha = [MATRIX, movie(3001, "Alpha Only", 5400000),
	         *[episode(2100 + n, *BREAKING, 1, n, 1500000) for n in (1, 2, 3, 4)],
	         album(3100, "Band", "Record", [("One", 200000), ("Two", 200000), ("Three", 200000)])]
	beta = [MATRIX, *[episode(2100 + n, *BREAKING, 1, n, 1500000) for n in (3, 4, 5, 6)],
	        album(3100, "Band", "Record", [("One", 200000), ("Deux", 200000), ("Three", 200000)]),
	        book(3200, "someone/beta-book", "Beta Book", "Someone", [3600000])]
	write_list(folder, "A_Alpha.yaml", "Alpha Fan", alpha,
	           {"timesanity_episodes": 10, "trap_percentage": 50, "snack_variety": False},
	           {"local_items": ["Everything"]})
	write_list(folder, "B_Beta.yaml", "Beta Fan", beta,
	           {"timesanity_movies": 20, "timesanity_episodes": 15, "starting_unlocks": 1},
	           {"start_hints": ["Unlock 1"], "exclude_locations": ["Check 1", "Check 2", "Check 3"],
	            "start_inventory": {"Popcorn": 1}})
	write_checksfinder(folder)


def run_child(mode, players, target, *rest, hashseed=None):
	"""ap_child.py <mode> <root> <players> <out or zip> <result> [seed], one child at a time."""
	result = os.path.join(STATE["root"], f"child-{mode}.json")
	env = dict(os.environ)
	if hashseed is not None:
		env["PYTHONHASHSEED"] = hashseed
	command = [sys.executable, "-O", "-s", "-S", "-B", CHILD, mode, STATE["root"], players, target, result, *rest]
	proc = subprocess.run(command, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
	                      timeout=900)
	if proc.returncode or not os.path.exists(result):
		raise AssertionError(f"ap_child {mode} failed ({proc.returncode}):\n{proc.stderr[-4000:]}")
	with open(result, encoding="utf-8") as handle:
		return json.load(handle)


def check_worker(test, seed, games):
	"""The bot's !ap next worker rebuilds the seed, puts its placements back and verifies every slot."""
	child = run_child("worker", seed.players, seed.zip)
	test.assertEqual(child["games"], games)
	for slot, (ok, reason) in child["verified"].items():
		test.assertTrue(ok, f"slot {slot}: {reason}")
	test.assertEqual(child["injected"]["missing"], 0)
	for answer in child["answers"]:
		test.assertTrue(answer["verified"], answer)
		test.assertGreater(answer["now"], 0, answer)
	return child


class C_SharedTitles(SeedChecks, unittest.TestCase):
	"""(c) two Plex lists that share titles, beside ChecksFinder."""

	@classmethod
	def setUpClass(cls):
		cls.seed = Seed("c_shared", 303, shared_players)

	def test_shared_titles_share_ids(self):
		alpha, beta = self.seed.worlds
		self.assertIs(alpha.registry, beta.registry)
		registry = alpha.registry
		self.assertEqual(sorted(u.key for u in alpha.plan.units if u.key in {v.key for v in beta.plan.units}),
		                 ["album|plex://album/3100", "movie|plex://movie/5d7768b2", "show-ep3|plex://show/5eb6f2a1"])
		md = self.seed.md
		shared = set(md["locations"][alpha.player]) & set(md["locations"][beta.player])
		self.assertIn(registry.location_id["ep|rk:2103|w"], shared)
		self.assertIn(registry.location_id["album|plex://album/3100|t1|one"], shared)
		self.assertNotIn(registry.location_id["album|plex://album/3100|t2|two"], set(md["locations"][beta.player]))

	def test_common_options_point_at_real_names(self):
		alpha, beta = self.seed.worlds
		registry = alpha.registry
		alpha_units = {registry.unit_name[u.key] for u in alpha.plan.units}
		self.assertEqual(alpha.options.local_items.value, alpha_units)
		album = registry.unit_name["album|plex://album/3100"]
		self.assertEqual(beta.options.start_hints.value, {album})
		self.assertEqual(beta.options.exclude_locations.value, {
			registry.location_name["album|plex://album/3100|t1|one"],
			registry.location_name["album|plex://album/3100|t2|deux"],
		})
		self.assertEqual(dict(beta.options.start_inventory.value), {})
		self.assertIn("exclude_locations leaves out 1 location(s)", STATE["warnings"].getvalue())
		md = self.seed.md
		album_id = registry.unit_id["album|plex://album/3100"]
		self.assertTrue(any(hint.item == album_id for hint in md["precollected_hints"][beta.player]))
		alpha_ids = {registry.unit_id[u.key] for u in alpha.plan.units}
		for finder, table in md["locations"].items():
			for code, receiver, _flags in table.values():
				if receiver == alpha.player and code in alpha_ids:
					self.assertEqual(finder, alpha.player, "local_items keeps Alpha's unlocks in Alpha's list")

	def test_excluded_tracks_take_useful_room_and_traps_land_on_excluded_checkpoints(self):
		from BaseClasses import LocationProgressType

		alpha, beta = self.seed.worlds
		# Beta's room is 5 (9 main locations, 4 unlocks in the pool), filled by 2 Wild Tickets, 2 Fast
		# Forwards and the Remote Control. Its 2 excluded tracks take 2 of it: the Remote Control and a
		# Fast Forward become snacks, so the 11 checkpoints and the 2 tracks get 13.
		self.assertEqual((beta.plan.excluded, beta.plan.wild, beta.plan.fast_forwards, beta.plan.remote_controls,
		                  beta.plan.filler), (2, 2, 1, 0, 13))
		# Alpha: 23 filler at trap_percentage 50 make 11 traps by the default weights, and Popcorn alone the rest.
		self.assertEqual((alpha.plan.excluded, alpha.plan.filler, list(alpha.plan.traps.values()),
		                  sum(alpha.plan.snacks.values()), alpha.plan.snacks["Popcorn"]),
		                 (0, 23, [3, 3, 1, 1, 1, 1, 1], 12, 12))
		md = self.seed.md
		on_checkpoints = 0
		for world in self.seed.worlds:
			checkpoint_ids = {world.registry.location_id[pe.checkpoint_key(minute)]
			                  for pe in world.plan.entries for minute in pe.minutes}
			for location, _pe in world.placed:
				if location.address in checkpoint_ids:
					self.assertEqual(location.progress_type, LocationProgressType.EXCLUDED, location.name)
					_code, _receiver, flags = md["locations"][world.player][location.address]
					on_checkpoints += bool(flags & 0b100)
		# 36 snacks and traps for 34 EXCLUDED locations (ChecksFinder brings none), 2 of them Beta's
		# tracks: at least 7 of Alpha's 11 traps sit on checkpoints.
		self.assertGreaterEqual(on_checkpoints, 7)

	def test_bad_names_and_bad_lists_raise_option_errors_naming_the_player(self):
		from Options import OptionError

		alpha, _beta = self.seed.worlds
		registry = alpha.registry
		own = {registry.unit_name[u.key] for u in alpha.plan.units}
		unknown = f"Unlock {len(registry.unit_keys) + 1}"
		with self.assertRaises(OptionError) as caught:
			alpha._real_items("local_items", {unknown}, own)
		self.assertEqual(str(caught.exception), f"Alpha Fan: local_items names {unknown!r}, but this seed has "
		                                        f"{len(registry.unit_keys)} Plex Media unlocks")
		beta_only = f"Unlock {registry.unit_keys.index('book|book:someone/beta-book') + 1}"
		with self.assertLogs("Plex Media", level="WARNING") as logs:
			self.assertEqual(alpha._real_items("start_hints", {beta_only}, own), set())
		self.assertEqual(logs.output, [f"WARNING:Plex Media:Alpha Fan: start_hints leaves out 1 unlock(s) that "
		                               f"belong to other lists: {beta_only}"])

		world_type = type(alpha)
		hints = world_type.options_dataclass.type_hints
		with self.assertRaises(OptionError) as caught:
			hints["entries"]([MATRIX, dict(MATRIX, id="rk:9", t=" \t")]).verify(world_type, "Probe Fan", None)
		self.assertEqual(str(caught.exception), "Plex Media list of Probe Fan: entry 2: t is empty")
		newer = sys.modules[world_type.__module__ + ".constants"].BUILDER_VERSION + 1
		with self.assertRaises(OptionError) as caught:
			hints["list_info"]({"builder": newer}).verify(world_type, "Probe Fan", None)
		self.assertTrue(str(caught.exception).startswith(
			f"Plex Media list of Probe Fan: this list was built for Plex Media builder {newer}, "), caught.exception)

		# verify() cannot see the plan's caps, so generate_early raises those, naming the player the same
		# way. The world is shared with this class's other tests: its plan and list_info must come through.
		plan, info, entries = alpha.plan, alpha.info, alpha.options.entries.value
		alpha.options.entries.value = [book(3300, "someone/endless", "Endless", "Someone", [30_000_000_000])]
		try:
			with self.assertRaises(OptionError) as caught:
				alpha.generate_early()
		finally:
			alpha.options.entries.value, alpha.info = entries, info
		self.assertTrue(str(caught.exception).startswith("Plex Media list of Alpha Fan: the list makes "),
		                caught.exception)
		self.assertIn("at most 10000 fit in one slot", str(caught.exception))
		self.assertIs(alpha.plan, plan)

		# Beta's 2 excluded tracks free filler, which the plan's trap split must still be able to deal:
		# with every weight 0, a trap due from it stops the list the same way, on a copy of its plan.
		_alpha, beta = self.seed.worlds
		traps = sys.modules[world_type.__module__ + ".constants"].TRAPS
		kept = beta.plan
		beta.plan = copy.deepcopy(kept)
		beta.plan.options = {**kept.options, "trap_percentage": 100, **{f"{key}_weight": 0 for key in traps}}
		try:
			with self.assertRaises(OptionError) as caught:
				beta.make_room_for_exclusions()
		finally:
			beta.plan = kept
		self.assertEqual(str(caught.exception), "Plex Media list of Beta Fan: trap_percentage 100 makes 13 of the list's 13 "
		                                        "filler items traps, but every trap weight is 0 (a trap weight above 0, or "
		                                        "trap_percentage 0, would help)")

	def test_regenerates_identically_under_another_hash_seed(self):
		mine = ap_harness.seed_digest(self.seed.md)
		hashseed = "1" if os.environ.get("PYTHONHASHSEED") != "1" else "2"
		child = run_child("regen", self.seed.players, os.path.join(self.seed.folder, "regen"), str(self.seed.seed),
		                  hashseed=hashseed)
		self.assertEqual(child["hashseed"], hashseed)
		self.assertEqual(child["digest"], mine)
		sys.stderr.write(f"\n(c) PYTHONHASHSEED={hashseed} child: locations {mine['locations'][:12]}, "
		                 f"package {mine['checksum'][:12]}, slot_data {mine['slot_data'][:12]}, all equal\n")

	def test_the_ap_next_worker_rebuilds_and_verifies_every_slot(self):
		child = check_worker(self, self.seed, {"1": GAME, "2": GAME, "3": "ChecksFinder"})
		sys.stderr.write(f"\n(c) !ap next worker: {sum(ok for ok, _r in child['verified'].values())} of "
		                 f"{len(child['verified'])} slots verified, placements {child['injected']}\n")


class D_SeasonMode(SeedChecks, unittest.TestCase):
	"""(d) season mode, checkpoints open to any item, strict timesanity."""

	@classmethod
	def setUpClass(cls):
		long_show = ("Long Show", "plex://show/60a1b2c3", 4100)
		entries = [
			*[episode(4100 + i, *long_show, sn, en, 2400000)
			  for i, (sn, en) in enumerate([(1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (0, 1)], 1)],
			episode(4201, "Short Show", "rk:4200", 4200, 1, 1, 1320000),
			episode(4202, "Short Show", "rk:4200", 4200, 1, 2, 1320000),
			movie(4300, "Season Film", 6600000),
		]
		options = {"tv_unlock": "season", "checkpoint_items": "anything", "timesanity_strict": True}
		cls.seed = Seed("d_season", 404, lambda folder: write_list(folder, "D_Season.yaml", "Season Fan", entries,
		                                                          options))

	def test_seasons_are_the_steps(self):
		data = plain(self.seed.md["slot_data"][1])
		self.assertEqual((data["tv_unlock"], data["checkpoint_items"], data["timesanity_strict"]),
		                 ("season", "anything", True))
		units = {unit["name"]: (unit["kind"], unit["steps"]) for unit in data["units"]}
		self.assertEqual(units["Long Show: Next Season"], ("show", 4))
		self.assertEqual(units["Short Show: Next Season"], ("show", 1))
		steps = {entry["rk"]: entry["s"] for entry in data["entries"] if entry["k"] == "episode"}
		self.assertEqual([steps[4100 + i] for i in range(1, 7)], [2, 2, 3, 3, 4, 1])


class E_ScaleSolo(SeedChecks, unittest.TestCase):
	"""(e) 600 unlock copies solo at spoiler 3, the size /apmedia yaml starts warning at."""

	@classmethod
	def setUpClass(cls):
		entries = [movie(5000 + i, f"Film {i:03}", 6000000, 1950 + i % 70) for i in range(600)]
		cls.seed = Seed("e_scale", 505, lambda folder: write_list(folder, "E_Scale.yaml", "Scale Fan", entries))

	def test_generates_inside_90_seconds(self):
		self.assertEqual(self.seed.worlds[0].plan.copies, 600)
		self.assertLess(self.seed.seconds, 90.0)
		sys.stderr.write(f"\n(e) 600 copies, {len(self.seed.worlds[0].placed)} locations: "
		                 f"{self.seed.seconds:.1f} s at spoiler 3\n")


PLEX_LINK = {"name": "PlexLink", "item_pool": ["Everything"], "replacement_item": None}


def linked_players(folder):
	extra = {"item_links": [PLEX_LINK]}
	write_list(folder, "A_LinkA.yaml", "Link A", [MATRIX, movie(6001, "Only A", 5400000),
	                                               movie(6002, "Third A", 5400000)], extra=extra)
	write_list(folder, "B_LinkB.yaml", "Link B", [MATRIX, movie(6003, "Only B", 5400000)], extra=extra)


class F_ItemLinks(SeedChecks, unittest.TestCase):
	"""(f) two Plex lists naming one item link: the world warns, empties the link and keeps every unlock home."""

	@classmethod
	def setUpClass(cls):
		cls.seed = Seed("f_links", 606, linked_players)

	def group_id(self):
		groups = self.seed.multiworld.get_game_groups(GAME)
		self.assertEqual(len(groups), 1)
		return groups[0]

	def test_the_link_is_warned_about_and_left_empty(self):
		from NetUtils import SlotType

		multiworld, md = self.seed.multiworld, self.seed.md
		group_id = self.group_id()
		group = multiworld.groups[group_id]
		self.assertEqual(group["name"], "PlexLink")
		for key in ("item_pool", "local_items", "non_local_items"):
			self.assertEqual(group[key], set(), key)
		warnings = STATE["warnings"].getvalue()
		self.assertIn("Plex Media cannot link items (item link PlexLink)", warnings)
		for world in self.seed.worlds:
			self.assertEqual(world.options.item_links.value, [], world.player_name)
			self.assertIn(f"{world.player_name}: Plex Media ignores item_links", warnings)
		self.assertEqual([item.name for item in multiworld.itempool if item.player == group_id], [])
		receivers = {receiver for table in md["locations"].values() for _code, receiver, _flags in table.values()}
		self.assertNotIn(group_id, receivers)
		# With nothing left to share, link_items drops every member, so only the slot type still says group.
		info = md["slot_info"][group_id]
		self.assertEqual((info.type, list(info.group_members)), (SlotType.group, []))

	def test_the_group_world_makes_items_from_a_players_registry(self):
		group_world = self.seed.multiworld.worlds[self.group_id()]
		self.assertIsNone(group_world.registry)
		registry = self.seed.worlds[0].registry
		first = registry.unit_keys[0]
		expected = (registry.unit_name[first], registry.unit_id[first], group_world.player)
		for name in ("Unlock 1", registry.unit_name[first]):
			made = group_world.create_item(name)
			self.assertEqual((made.name, made.code, made.player), expected, name)

	def test_the_ap_next_worker_rebuilds_and_verifies_every_slot(self):
		# Before ap-logic-worker.py told a group by its slot type, this member-less group read as a
		# third player and the rebuild was refused, so !ap next fell back to sphere 1 for every slot.
		check_worker(self, self.seed, {"1": GAME, "2": GAME})

	def test_the_ap_next_worker_picks_only_the_seeds_yamls_from_a_players_folder(self):
		# A Players folder that moved on to the next async. The link's group is no player of this seed,
		# so a yaml whose player is named PlexLink is left out like the stranger's.
		folder = os.path.join(self.seed.folder, "moved_on")
		os.makedirs(folder)
		for name in os.listdir(self.seed.players):
			shutil.copyfile(os.path.join(self.seed.players, name), os.path.join(folder, name))
		write_list(folder, "C_PlexLink.yaml", "PlexLink", [movie(6101, "Next Async", 5400000)])
		write_list(folder, "D_Stranger.yaml", "Someone Else", [movie(6102, "Other Film", 5400000)])
		child = run_child("select", folder, self.seed.zip)
		self.assertEqual(child["kept"], ["A_LinkA.yaml", "B_LinkB.yaml"])


# Every list setting at a value other than its default. list_label differs from the list_info label
# H writes, so a world that took its slot_data label from list_label would change the seed.
LIST_SETTINGS = {"list_preset": "none", "list_movies": 7, "list_shows": 2, "list_albums": 0, "list_books": 1,
                 "list_titles": "Alien; show: Lost S1-2", "list_playlist": "Road Trip", "list_collection": "Pixar",
                 "list_genre": "Horror", "list_years": "1990-1999", "list_unwatched": False, "list_max_episodes": 6,
                 "list_label": "Renamed list"}
H_LABEL = "Settings list"


class H_ListSettingsIgnored(SeedChecks, unittest.TestCase):
	"""(h) the mixed list with every list_* setting changed: the same seed as the list without them."""

	bare = None

	@classmethod
	def setUpClass(cls):
		def players(extra):
			return lambda folder: write_list(folder, "H_List.yaml", "Settings Fan", mixed_entries(), MIXED_OPTIONS,
			                                 extra, label=H_LABEL)

		cls.bare = Seed("h_plain", 808, players(None))
		cls.seed = Seed("h_settings", 808, players(LIST_SETTINGS))

	@classmethod
	def tearDownClass(cls):
		if cls.bare is not None:
			cls.bare.remove()
		super().tearDownClass()

	def test_the_settings_were_read(self):
		self.assertNotEqual(LIST_SETTINGS["list_label"], H_LABEL)
		options = self.seed.worlds[0].options
		for key, value in LIST_SETTINGS.items():
			option = getattr(options, key)
			read = option.current_key if key == "list_preset" else option.value
			self.assertEqual(read, int(value) if isinstance(value, bool) else value, key)
		self.assertEqual(self.bare.worlds[0].options.list_movies.value, -1)
		self.assertEqual(plain(self.seed.md["slot_data"][1])["label"], H_LABEL)

	def test_the_seed_is_the_same_without_them(self):
		md, other = self.seed.md, self.bare.md
		self.assertEqual(ap_harness.seed_digest(md), ap_harness.seed_digest(other))
		self.assertEqual(md["datapackage"][GAME], other["datapackage"][GAME])
		self.assertEqual(md["locations"], other["locations"])
		self.assertEqual(md["precollected_items"], other["precollected_items"])
		data, bare_data = plain(md["slot_data"][1]), plain(other["slot_data"][1])
		data.pop("generated_at")
		bare_data.pop("generated_at")
		self.assertEqual(data, bare_data)


def run(only=None, verbosity=2):
	"""only: scenario class names to run (all when empty), to spare the PC a full pass."""
	module = sys.modules[__name__]
	if only:
		suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(getattr(module, name))
		                           for name in only)
	else:
		suite = unittest.defaultTestLoader.loadTestsFromModule(module)
	return unittest.TextTestRunner(verbosity=verbosity, stream=sys.stderr).run(suite).wasSuccessful()
