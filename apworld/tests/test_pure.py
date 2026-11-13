# apworld/tests/test_pure.py
# Tests the apworld's AP-free modules: entries, plan, registry, naming, slotdata, datapackage, rules.
#
# These decide every id and name a Plex seed carries, so they are pinned here without the AP install:
# per-field validation, the text cut and the id and list-size caps, steps and prefix tables for both
# TV modes, checkpoint minutes at the 0.9 cut, starting copies, the Wild Ticket clamp, goal rounding,
# the union of two slots, name collisions, the plan's caps, slot_data naming no person, the list
# settings (list_*) as the Options Creator offers them and that they move no id, name or slot_data,
# that constants.py and sanitize_text still mirror helpers/apMediaContracts.js, and that run.py
# loads and runs every test file that holds scenarios. The option classes themselves import AP, so
# test_generate.py's A0 and A1 check them against these tables.
#
# Harness: plain unittest, run by run.py or on its own with py -3.13 -O -s -S -B apworld/tests/test_pure.py.
# purelib loads the modules through a stub package, so __init__.py (and AP) never loads. Bare
# assert is never used: -O strips it. The JS mirror checks run node on helpers/apMediaContracts.js
# and skip when node is not on PATH.

import ast
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_plan_cases  # noqa: E402
import purelib  # noqa: E402

P = purelib.load()
C = P.constants


def movie(rk, title, d=6000000, y=2000):
	return {"k": "movie", "id": f"rk:{rk}", "rk": rk, "t": title, "y": y, "d": d}


def episode(rk, sn, en, show="Show", sid="plex://show/s", srk=50, d=1500000):
	return {"k": "episode", "id": f"rk:{rk}", "rk": rk, "t": f"Episode {en}", "sh": show, "sid": sid, "srk": srk,
	        "sn": sn, "en": en, "d": d}


def album(rk, tracks, artist="Band", title="Record"):
	tr = [[rk * 100 + n, n, name, d, rk * 1000 + n] for n, (name, d) in enumerate(tracks, 1)]
	return {"k": "album", "id": f"plex://album/{rk}", "rk": rk, "ar": artist, "t": title, "y": 2001,
	        "d": sum(d for _n, d in tracks), "tr": tr}


def mix(pl, part, tracks):
	tr = [[pl * 100 + n, n, name, d, pl * 1000 + n, "Artist"] for n, (name, d) in enumerate(tracks, 1)]
	return {"k": "mix", "id": f"pl:{pl}:{part}", "pl": pl, "part": part, "t": f"Mix Part {part}",
	        "d": sum(d for _n, d in tracks), "tr": tr}


def book(work, parts, title="Novel", author="Author"):
	return {"k": "book", "id": f"book:{work}", "w": work, "t": title, "au": author, "d": sum(parts),
	        "pa": [[9000 + n, 9500 + n, d] for n, d in enumerate(parts, 1)]}


def plan_of(entries, **options):
	return P.plan.plan_slot(P.entries.parse_entries(entries), P.plan.plan_options(options))


def registry_of(*plans):
	return P.registry.Registry(list(enumerate(plans, 1)))


def open_entries(plan):
	"""Keys of the entries the starting copies open."""
	held = {unit.key: unit.start for unit in plan.units}
	return [pe.key for pe in plan.entries if held[pe.unit] >= pe.step]


GOOD = {
	"movie": movie(1, "Film"),
	"episode": episode(2, 1, 1),
	"album": album(3, [("Song", 200000)]),
	"mix": mix(4, 1, [("Song", 200000)]),
	"book": book("a/b", [3600000]),
}


def _set(field, value):
	return lambda entry: entry.__setitem__(field, value)


def _drop(field):
	return lambda entry: entry.pop(field)


def _track(position, value):
	return lambda entry: entry["tr"][0].__setitem__(position, value)


ID_CAP = P.entries.ID_MAX

BAD = [
	("movie", _set("k", "song"), "k must be one of"),
	("movie", _drop("id"), "id must be non-empty text"),
	("movie", _set("id", "   "), "id must be non-empty text"),
	("movie", _set("t", ""), "t is empty"),
	("movie", _set("t", chr(0x7f) + chr(0x2028) + " "), "t is empty"),
	("movie", _set("t", 12), "t must be text"),
	("movie", _set("d", -1), "d must be a whole number"),
	("movie", _set("d", True), "d must be a whole number"),
	("movie", _set("d", 1.5), "d must be a whole number"),
	("movie", _drop("rk"), "rk must be a whole number"),
	("movie", _set("rk", "12"), "rk must be a whole number"),
	("movie", _set("rk", 2 ** 53), "rk must be a whole number"),
	("movie", _set("y", "1999"), "y must be a whole number or null"),
	("movie", _set("g", ""), "g must be non-empty text"),
	("episode", _set("sh", " "), "sh is empty"),
	("episode", _set("sid", None), "sid must be non-empty text"),
	("episode", _set("srk", None), "srk must be a whole number"),
	("episode", _set("sn", -1), "sn must be a whole number"),
	("episode", _set("en", "5"), "en must be a whole number"),
	("album", _set("ar", ""), "ar is empty"),
	("album", _set("tr", []), "tr must hold at least 1 items"),
	("album", _set("tr", "tracks"), "tr must be a list"),
	("album", _set("tr", [[1, 1, "Song", 200000]]), "track 1 must be a list of 5 values"),
	("album", _track(0, "1"), "track 1 rating key must be a whole number"),
	("album", _track(1, "1"), "track 1 index must be a whole number or null"),
	("album", _track(2, " "), "track 1 title is empty"),
	("album", _track(3, None), "track 1 duration must be a whole number"),
	("album", _track(3, 29999), "has no track of 30 s or more"),
	("album", _track(4, "x"), "track 1 part id must be a whole number or null"),
	("album", _set("alt", [[5, []]]), "alt copy 1 tracks must hold 1 to 1 items"),
	("album", _set("alt", "x"), "alt must be a list"),
	("mix", _set("pl", None), "pl must be a whole number"),
	("mix", _set("part", 0), "part must be a whole number of at least 1"),
	("mix", _set("id", "pl:9:1"), "a mix's id must be pl:<pl>:<part>"),
	("mix", lambda e: e["tr"][0].__setitem__(5, ""), "track 1 artist is empty"),
	("mix", lambda e: e.__setitem__("tr", e["tr"] * 16), "tr must hold 1 to 15 items"),
	("book", _set("w", ""), "w must be non-empty text"),
	("book", _set("id", "book:x/y"), "a book's id must be book:<w>"),
	("book", _set("au", ""), "au is empty"),
	("book", _set("pa", []), "pa must hold at least 1 items"),
	("book", lambda e: e["pa"][0].__setitem__(2, -5), "part 1 duration must be a whole number"),
	("movie", _set("id", "x" * (ID_CAP + 1)), f"id must be at most {ID_CAP} characters, not {ID_CAP + 1}"),
	("episode", _set("sid", "s" * (ID_CAP + 1)), f"sid must be at most {ID_CAP} characters, not {ID_CAP + 1}"),
	("book", lambda e: e.update(id="book:" + "w" * ID_CAP, w="w" * ID_CAP),
	 f"id must be at most {ID_CAP} characters, not {ID_CAP + 5}"),
]


class ValidationTest(unittest.TestCase):
	def test_good_entries_parse(self):
		parsed = P.entries.parse_entries(list(GOOD.values()))
		self.assertEqual([e["k"] for e in parsed], list(C.KINDS))

	def test_each_bad_field_names_its_entry(self):
		for kind, mutate, fragment in BAD:
			entry = copy.deepcopy(GOOD[kind])
			mutate(entry)
			with self.subTest(kind=kind, fragment=fragment):
				with self.assertRaises(P.entries.EntryError) as caught:
					P.entries.parse_entries([GOOD["movie"] if kind != "movie" else movie(9, "Other"), entry])
				self.assertEqual(caught.exception.index, 1)
				self.assertTrue(str(caught.exception).startswith("entry 2: "), str(caught.exception))
				self.assertIn(fragment, str(caught.exception))

	def test_list_level_errors(self):
		for value, fragment in (([], "this YAML has no titles yet"), ("x", "entries must be a list"),
		                        ({}, "entries must be a list"),
		                        ([movie(n, "F") for n in range(C.MAX_ENTRIES + 1)], "at most 2000")):
			with self.subTest(fragment=fragment):
				with self.assertRaises(P.entries.EntryError) as caught:
					P.entries.parse_entries(value)
				self.assertIsNone(caught.exception.index)
				self.assertIn(fragment, str(caught.exception))
		with self.assertRaises(P.entries.EntryError) as caught:
			P.entries.parse_entries([movie(1, "A"), movie(2, "B"), movie(1, "A again")])
		self.assertEqual(caught.exception.index, 2)
		self.assertIn("repeats entry 1 (movie|rk:1)", str(caught.exception))

	def test_a_list_without_titles_says_to_let_the_bot_fill_it_in(self):
		# The Options Creator's YAML has no entries, and AP reads a missing option as its default, [].
		with self.assertRaises(P.entries.EntryError) as caught:
			P.entries.parse_entries([])
		self.assertIsNone(caught.exception.index)
		self.assertEqual(str(caught.exception), "this YAML has no titles yet. Attach it to /apmedia yaml in Discord, "
		                                        "and the bot picks them from the Plex library.")

	def test_specials_and_extra_fields_are_allowed(self):
		special = episode(5, 0, 1)
		special["extra"] = "ignored"
		track = album(6, [("Song", 200000)])
		track["tr"][0].append("a seventh value")
		parsed = P.entries.parse_entries([special, track])
		self.assertEqual(parsed[0]["sn"], 0)
		self.assertNotIn("extra", parsed[0])
		self.assertEqual(len(parsed[1]["tr"][0]), 5)

	def test_text_is_sanitised_and_ids_are_not(self):
		entry = movie(1, "  The" + chr(0x3000) + chr(0x3000) + "Matrix" + chr(0x2028))
		entry["id"] = "rk:1"
		parsed = P.entries.parse_entries([entry])[0]
		self.assertEqual(parsed["t"], "The Matrix")
		odd = book("odd  id", [3600000])
		self.assertEqual(P.entries.parse_entries([odd])[0]["w"], "odd  id")

	def test_long_text_is_cut_and_moves_no_name_or_id(self):
		cap = P.entries.TEXT_MAX

		def listing(words, letters):
			entries = [movie(1, words), episode(2, 1, 1, show=words),
			           album(3, [(words, 200000)], artist=letters, title=words), mix(4, 1, [(words, 200000)]),
			           book("a/b", [3600000], title=words, author=letters)]
			entries[3]["tr"][0][5] = letters
			return entries

		parsed = P.entries.parse_entries(listing("Word " * 400, "A" * 3000))
		# The cut lands on a space, which goes with it.
		cut = ("Word " * 200).rstrip(" ")
		self.assertEqual(len(cut), cap - 1)
		self.assertEqual([parsed[0]["t"], parsed[1]["sh"], parsed[2]["t"], parsed[2]["tr"][0][2], parsed[3]["tr"][0][2],
		                  parsed[4]["t"]], [cut] * 6)
		self.assertEqual([parsed[2]["ar"], parsed[3]["tr"][0][5], parsed[4]["au"]], ["A" * cap] * 3)
		whole = registry_of(P.plan.plan_slot(parsed, P.plan.plan_options({"timesanity_albums": 1})))
		short = registry_of(plan_of(listing("Word " * 30, "A" * 150), timesanity_albums=1))
		for table in ("unit_name", "location_name", "location_id"):
			self.assertEqual(getattr(whole, table), getattr(short, table), table)

	def test_ids_up_to_the_cap_parse_and_a_long_guid_is_kept(self):
		at_cap = [book("w" * (ID_CAP - len("book:")), [3600000]), episode(5, 1, 1, sid="s" * ID_CAP),
		          dict(movie(6, "Film"), g="com.plexapp.agents.lastfm://" + "%E6%9D%B1" * 400)]
		parsed = P.entries.parse_entries(at_cap)
		self.assertEqual([len(parsed[0]["id"]), len(parsed[1]["sid"])], [ID_CAP, ID_CAP])
		self.assertEqual(parsed[2]["g"], at_cap[2]["g"])

	def test_the_list_is_capped_by_its_size_in_slot_data(self):
		entries = [movie(n, "Film " + chr(0x6771) * 50) for n in range(1, 41)]
		# A YAML escape can put a lone surrogate in an id, and the size is still measured.
		entries[0]["id"] = "rk:" + chr(0xd800)
		parsed = P.entries.parse_entries(entries)
		sizes = [len(json.dumps(e, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "surrogatepass"))
		         for e in parsed]
		saved = P.entries.LIST_BYTES_MAX
		try:
			P.entries.LIST_BYTES_MAX = sum(sizes)
			self.assertEqual(len(P.entries.parse_entries(entries)), 40)
			P.entries.LIST_BYTES_MAX = sum(sizes[:10])
			with self.assertRaises(P.entries.EntryError) as caught:
				P.entries.parse_entries(entries)
		finally:
			P.entries.LIST_BYTES_MAX = saved
		self.assertIsNone(caught.exception.index)
		self.assertEqual(str(caught.exception), f"the list comes to {sum(sizes[:11]):,} bytes by entry 11; at most "
		                                        f"{sum(sizes[:10]):,} fit in one slot, so split it across two slots")

	def test_a_list_at_the_builders_caps_is_far_under_the_size_cap(self):
		# helpers/apMediaYaml.js's caps: 200 random albums of up to 40 tracks and 50 picked ones of up to 100,
		# each with up to three twin copies, a playlist in 40 parts of 15, 50 random and 50 picked books (300
		# parts each here, a long recording), and 2,000 entries in all.
		entries = []
		for a in range(250):
			n, rk = (40 if a < 200 else 100), 10_000 + a
			tr = [[rk * 1000 + i, i, f"A Track Title Of Some Length {i:03}", 240000, rk * 1000 + 500 + i]
			      for i in range(1, n + 1)]
			alt = [[rk + 500_000 + c, [[rk * 1000 + 700 + i, rk * 1000 + 900 + i] for i in range(1, n + 1)]]
			       for c in range(3)]
			entries.append({"k": "album", "id": f"plex://album/{rk:024x}", "rk": rk, "g": f"plex://album/{rk:024x}",
			                "ar": "An Artist With A Long Name", "t": "An Album Title Of Ordinary Length (Deluxe)",
			                "y": 2001, "d": 240000 * n, "tr": tr, "alt": alt})
		for part in range(1, 41):
			entries.append(mix(777, part, [(f"Playlist Track {i:02}", 200000) for i in range(1, 16)]))
		for b in range(100):
			entries.append(book(f"some-author-name/a-book-title-of-ordinary-length-{b:03}", [1800000] * 300,
			                    title=f"A Book Title Of Ordinary Length {b}", author="Some Author Name"))
		entries += [dict(episode(50_000 + e, 1 + e // 25, 1 + e % 25, show="A Show With An Ordinary Name",
		                         sid=f"plex://show/{e // 100:024x}", srk=60_000 + e // 100),
		                 id=f"plex://episode/{e:024x}", g=f"plex://episode/{e:024x}")
		            for e in range(2000 - len(entries))]
		parsed = P.entries.parse_entries(entries)
		size = sum(len(json.dumps(e, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) for e in parsed)
		self.assertEqual(len(parsed), C.MAX_ENTRIES)
		self.assertLess(size, P.entries.LIST_BYTES_MAX // 4, f"{size:,} bytes")

	def test_list_info(self):
		parse = P.entries.parse_list_info
		self.assertEqual(parse({}), {"builder": 1, "created_at": 0, "label": ""})
		self.assertEqual(parse({"builder": 1, "created_at": 1731200000, "label": " Zack's\tlist ", "account": 1,
		                        "discord": 1234}),
		                 {"builder": 1, "created_at": 1731200000, "label": "Zack's list"})
		self.assertEqual(parse({"created_at": "soon", "account": "me", "label": 5}),
		                 {"builder": 1, "created_at": 0, "label": ""})
		self.assertEqual(parse({"label": "L" * 1500})["label"], "L" * P.entries.TEXT_MAX)
		for builder, fragment in ((2, "install the newer plex_media.apworld"), (0, "at least 1"), ("1", "at least 1")):
			with self.subTest(builder=builder):
				with self.assertRaises(P.entries.EntryError) as caught:
					parse({"builder": builder})
				self.assertIn(fragment, str(caught.exception))


class PlanTest(unittest.TestCase):
	def test_episode_steps_and_prefix_for_each_k(self):
		eps = [episode(10 + n, 1 + (n > 4), n) for n in range(1, 8)]
		for per, steps, prefix in ((1, 7, [0, 1, 2, 3, 4, 5, 6, 7]), (2, 4, [0, 2, 4, 6, 7]), (3, 3, [0, 3, 6, 7]),
		                           (7, 1, [0, 7]), (12, 1, [0, 7])):
			with self.subTest(per=per):
				plan = plan_of(eps, episodes_per_unlock=per)
				unit = plan.units[0]
				self.assertEqual(unit.key, f"show-ep{per}|plex://show/s")
				self.assertEqual((unit.steps, unit.prefix), (steps, prefix))
				self.assertEqual([pe.step for pe in plan.entries], [-(-n // per) for n in range(1, 8)])

	def test_episodes_follow_season_and_number_not_yaml_order(self):
		eps = [episode(1, 2, 1), episode(2, 1, 2), episode(3, 0, 5), episode(4, 1, 1)]
		plan = plan_of(eps, episodes_per_unlock=1)
		self.assertEqual([pe.step for pe in plan.entries], [4, 3, 1, 2])

	def test_season_mode(self):
		eps = [episode(1, 3, 1), episode(2, 1, 1), episode(3, 1, 2), episode(4, 0, 1), episode(5, 3, 2)]
		plan = plan_of(eps, tv_unlock="season")
		unit = plan.units[0]
		self.assertEqual(unit.key, "show-season|plex://show/s")
		self.assertEqual((unit.steps, unit.prefix), (3, [0, 1, 3, 5]))
		self.assertEqual([pe.step for pe in plan.entries], [3, 2, 2, 1, 3])

	def test_checkpoint_minutes_and_the_cut(self):
		minutes = P.plan.checkpoint_minutes
		self.assertEqual(minutes(15, 102 * 60000), [15, 30, 45, 60, 75, 90])
		self.assertEqual(minutes(15, 1000000), [])
		self.assertEqual(minutes(15, 1000001), [15])
		self.assertEqual(minutes(10, 6000000), [10, 20, 30, 40, 50, 60, 70, 80])
		self.assertEqual(minutes(10, 6000001), [10, 20, 30, 40, 50, 60, 70, 80, 90])
		self.assertEqual(minutes(0, 6000000), [])
		self.assertEqual(minutes(15, 0), [])
		self.assertEqual(P.plan.checkpoint_count(1, 10 ** 15), (9 * 10 ** 15 - 1) // 600000)
		self.assertEqual(P.plan.CUT_NUMERATOR / P.plan.CUT_DENOMINATOR, C.CHECKPOINT_CUT)

	def test_album_and_mix_timelines(self):
		plan = plan_of([album(1, [("Intro", 20000), ("Song", 240000), ("Exactly", 30000)]),
		                mix(2, 1, [("A", 100000), ("B", 25000)])], timesanity_albums=2)
		first, second = plan.entries
		self.assertEqual(first.duration, 290000)
		self.assertEqual(first.main, [("album|plex://album/1|t2|song", 2), ("album|plex://album/1|t3|exactly", 3)])
		self.assertEqual(first.minutes, [2, 4])
		self.assertEqual(second.main, [("mix|pl:2:1|t1|a", 1)])
		self.assertEqual(second.minutes, [])

	def test_three_books_one_starting_unlock(self):
		plan = plan_of([book("a/1", [3600000]), book("a/2", [3600000]), book("a/3", [3600000])], starting_unlocks=1)
		self.assertEqual((plan.copies, plan.start), (3, 1))
		self.assertEqual(open_entries(plan), ["book|book:a/1"])
		self.assertEqual(open_entries(plan_of([book("a/1", [1]), book("a/2", [1]), book("a/3", [1])])),
		                 ["book|book:a/1", "book|book:a/2"])

	def test_one_show_of_24_episodes_opens_nine(self):
		plan = plan_of([episode(100 + n, 1 + (n > 12), n) for n in range(1, 25)], episodes_per_unlock=3,
		               starting_unlocks=3)
		self.assertEqual((plan.copies, plan.start, plan.units[0].start), (8, 3, 3))
		self.assertEqual(open_entries(plan), [f"episode|rk:{100 + n}" for n in range(1, 10)])

	def test_starting_copies_clamps(self):
		self.assertEqual(plan_of([movie(1, "Only")], starting_unlocks=50).start, 1)
		self.assertEqual(plan_of([movie(n, "F") for n in range(1, 5)], starting_unlocks=50).start, 3)
		self.assertEqual(plan_of([movie(n, "F") for n in range(1, 152)], starting_unlocks=1).start, 4)
		plan = plan_of([episode(n, 1, n, sid="a") for n in range(1, 6)]
		               + [episode(10 + n, 1, n, sid="b") for n in range(1, 6)] + [movie(1, "M")],
		               episodes_per_unlock=1, starting_unlocks=7)
		self.assertEqual([unit.start for unit in plan.units], [3, 3, 1])

	def test_wild_tickets_clamp(self):
		eps = [episode(n, 1, n) for n in range(1, 6)]
		self.assertEqual(plan_of(eps, episodes_per_unlock=1, wild_tickets=20).wild, 3)
		self.assertEqual(plan_of(eps, episodes_per_unlock=1, wild_tickets=0).wild, 0)
		self.assertEqual(plan_of([movie(1, "A"), movie(2, "B")], wild_tickets=20).wild, 1)
		for entries in ([movie(n, "F") for n in range(1, 30)], eps, [album(1, [("A", 100000)] * 3)]):
			plan = plan_of(entries, episodes_per_unlock=1, wild_tickets=20, starting_unlocks=1)
			popcorn = plan.main_count + plan.checkpoint_count - (plan.copies - plan.start) - plan.wild
			self.assertGreaterEqual(popcorn, plan.checkpoint_count)

	def test_goal_count(self):
		self.assertEqual(plan_of([movie(1, "A")], goal_percent=1).goal_count, 1)
		self.assertEqual(plan_of([movie(n, "F") for n in range(50)], goal_percent=80).goal_count, 40)
		self.assertEqual(plan_of([movie(n, "F") for n in range(3)], goal_percent=80).goal_count, 2)
		self.assertEqual(plan_of([movie(n, "F") for n in range(3)], goal_percent=100).goal_count, 3)

	def test_caps(self):
		with self.assertRaises(P.plan.PlanError) as caught:
			plan_of([book("a/b", [200 * 3600000])], timesanity_books=1)
		self.assertIn("at most 10000", str(caught.exception))
		with self.assertRaises(P.plan.PlanError):
			plan_of([book("a/b", [10 ** 15])], timesanity_books=1)
		saved = P.plan.MAX_COPIES
		P.plan.MAX_COPIES = 5
		try:
			with self.assertRaises(P.plan.PlanError) as caught:
				plan_of([movie(n, "F") for n in range(6)])
			self.assertIn("6 unlock copies", str(caught.exception))
		finally:
			P.plan.MAX_COPIES = saved

	def test_plan_cases_file_matches(self):
		with open(make_plan_cases.OUT, encoding="utf-8") as handle:
			committed = json.load(handle)
		self.assertEqual(committed, make_plan_cases.build_cases(),
		                 "plan.py and plan_cases.json disagree: run make_plan_cases.py after a deliberate change")


class RegistryTest(unittest.TestCase):
	def test_two_slots_share_a_show(self):
		eps = {n: episode(200 + n, 1, n, d=25 * 60000) for n in range(1, 7)}
		a = plan_of([eps[n] for n in (1, 2, 3, 4)], timesanity_episodes=10)
		b = plan_of([eps[n] for n in (3, 4, 5, 6)], timesanity_episodes=15)
		registry = registry_of(a, b)
		self.assertEqual(registry.unit_keys, ["show-ep3|plex://show/s"])
		ep3 = [key for key in registry.location_keys if key.startswith("ep|rk:203|")]
		self.assertEqual(ep3, ["ep|rk:203|w", "ep|rk:203|@10", "ep|rk:203|@15", "ep|rk:203|@20"])
		ids = [registry.location_id[key] for key in ep3]
		self.assertEqual(ids, sorted(ids))
		self.assertEqual(len(registry.location_keys), 18)
		info = P.entries.parse_list_info({})
		data_a = P.slotdata.build_slot_data(a, registry, info, "0.1.0", 0)
		data_b = P.slotdata.build_slot_data(b, registry, info, "0.1.0", 0)
		self.assertEqual([m for m, _id in data_a["entries"][2]["cp"]], [10, 20])
		self.assertEqual([m for m, _id in data_b["entries"][0]["cp"]], [15])
		self.assertEqual(data_a["entries"][2]["w"], data_b["entries"][0]["w"])
		own_a = {i for e in data_a["entries"] for i in [e["w"]] + [c[1] for c in e["cp"]]}
		self.assertNotIn(registry.location_id["ep|rk:203|@15"], own_a)

	def test_album_track_lists_that_differ(self):
		a = plan_of([album(7, [("One", 200000), ("Two", 200000), ("Three", 200000)])])
		b = plan_of([album(7, [("One", 200000), ("Deux", 200000), ("Three", 200000)])])
		registry = registry_of(a, b)
		keys = [key for key in registry.location_keys if "|t" in key]
		self.assertEqual(keys, ["album|plex://album/7|t1|one", "album|plex://album/7|t2|deux",
		                        "album|plex://album/7|t2|two", "album|plex://album/7|t3|three"])
		self.assertEqual(registry.location_name["album|plex://album/7|t2|deux"], "Band - Record #02 Deux")
		self.assertEqual(registry.location_name["album|plex://album/7|t2|two"], "Band - Record #02 Two")
		data_b = P.slotdata.build_slot_data(b, registry, P.entries.parse_list_info({}), "0.1.0", 0)
		self.assertEqual(data_b["entries"][0]["tr"][1][5], registry.location_id["album|plex://album/7|t2|deux"])

	def test_ids_do_not_depend_on_player_order(self):
		a = plan_of([movie(1, "Shared"), movie(2, "Only A"), episode(5, 1, 1)])
		b = plan_of([movie(1, "Shared Renamed"), movie(3, "Only B"), episode(6, 1, 2)], timesanity_movies=10)
		first, second = registry_of(a, b), registry_of(b, a)
		self.assertEqual(first.unit_id, second.unit_id)
		self.assertEqual(first.location_id, second.location_id)
		self.assertEqual(first.unit_name["movie|rk:1"], "Shared (2000)")
		self.assertEqual(second.unit_name["movie|rk:1"], "Shared Renamed (2000)")

	def test_collisions_reserved_names_and_numeric_titles(self):
		roman = chr(0x216B)
		plan = plan_of([
			movie(1, "Halloween", y=2018), movie(2, "Halloween", y=2018), movie(3, "halloween", y=2018),
			movie(4, "1917", y=None), movie(5, "Popcorn", y=None), movie(6, "Movies", y=None),
			movie(7, "Unlock 5", y=None), movie(8, roman, y=None), movie(9, "Plex Media Goal", y=None),
			movie(10, "Wild ticket", y=None),
		])
		names = registry_of(plan).unit_name
		self.assertEqual(names["movie|rk:1"], "Halloween (2018)")
		self.assertEqual(names["movie|rk:2"], "Halloween (2018) [2]")
		self.assertEqual(names["movie|rk:3"], "halloween (2018) [3]")
		self.assertEqual(names["movie|rk:4"], "1917 (movie)")
		self.assertEqual(names["movie|rk:5"], "Popcorn [5]")
		self.assertEqual(names["movie|rk:6"], "Movies [6]")
		self.assertEqual(names["movie|rk:7"], "Unlock 5 [7]")
		self.assertEqual(names["movie|rk:8"], roman + " (movie)")
		self.assertEqual(names["movie|rk:9"], "Plex Media Goal [9]")
		self.assertEqual(names["movie|rk:10"], "Wild ticket [10]")
		folded = [name.casefold() for name in names.values()]
		self.assertEqual(len(folded), len(set(folded)))

	def test_a_suffix_that_collides_again_keeps_growing(self):
		plan = plan_of([movie(1, "Twin", y=None), movie(2, "Twin [7]", y=None), movie(7, "Twin", y=None)])
		names = registry_of(plan).unit_name
		self.assertEqual(names, {"movie|rk:1": "Twin", "movie|rk:2": "Twin [7]", "movie|rk:7": "Twin [7] [7]"})

	def test_a_tag_taken_from_an_id_is_clean(self):
		# chr(1) sorts first and keeps the plain name, so the id that cleans away to nothing is chr(2).
		works = [chr(0x01), chr(0x02), "a/" + chr(0x07) + "c", "jane-austen/emma"]
		plan = plan_of([book(work, [3600000]) for work in works] + [mix(4, 1, [("Song", 200000)]),
		                                                           mix(5, 1, [("Song", 200000)])])
		registry = registry_of(plan)
		digest = hashlib.sha1(("book:" + chr(0x02)).encode("utf-8")).hexdigest()[:8]
		self.assertEqual([registry.unit_name[f"book|book:{work}"] for work in works],
		                 ["Novel by Author", f"Novel by Author [{digest}]", "Novel by Author [a/c]",
		                  "Novel by Author [jane-austen/emma]"])
		self.assertEqual([registry.location_name[f"book|book:{work}|f"] for work in works],
		                 ["Finish Novel", f"Finish Novel [{digest}]", "Finish Novel [a/c]",
		                  "Finish Novel [jane-austen/emma]"])
		self.assertEqual(registry.location_name[f"book|book:{works[2]}|@30"], "Novel @ 30m [a/c]")
		self.assertEqual(registry.unit_name["mix|pl:5:1"], "Mix Part 1 (playlist) [5:1]")
		for name in list(registry.unit_name.values()) + list(registry.location_name.values()):
			self.assertEqual(P.naming.sanitize_text(name), name)

	def test_location_names(self):
		long_title = "x" * 150
		plan = plan_of([movie(1, "Film", d=40 * 60000), episode(2, 1, 5), movie(3, long_title, y=None, d=0),
		                book("a/b", [3600000 * 2], title="Novel", author="Ann"),
		                mix(4, 2, [("Song", 130000)]), album(5, [("Song", 130000)])],
		               timesanity_movies=15, timesanity_books=90, timesanity_albums=1)
		registry = registry_of(plan)
		names = [registry.location_name[key] for key in registry.location_keys]
		clipped = "x" * 99 + P.naming.ELLIPSIS
		self.assertEqual(names, [
			"Band - Record #01 Song", "Band - Record @ 1m",
			"Finish Novel", "Novel @ 1h30m",
			"Watch Show S01E05", "Show S01E05 @ 10m", "Show S01E05 @ 20m",
			"Mix Part 2 #01 Artist - Song", "Mix Part 2 @ 1m",
			"Watch Film (2000)", "Film (2000) @ 15m", "Film (2000) @ 30m",
			f"Watch {clipped}",
		])
		self.assertEqual(registry.unit_name["show-ep3|plex://show/s"], "Show: Next 3 Episodes")
		self.assertEqual(registry.unit_name["book|book:a/b"], "Novel by Ann")
		self.assertEqual(registry.unit_name["mix|pl:4:2"], "Mix Part 2 (playlist)")
		self.assertEqual(registry.unit_name["album|plex://album/5"], "Band - Record")
		one = registry_of(plan_of([episode(2, 1, 5)], episodes_per_unlock=1)).unit_name
		season = registry_of(plan_of([episode(2, 1, 5)], tv_unlock="season")).unit_name
		self.assertEqual(list(one.values()), ["Show: Next Episode"])
		self.assertEqual(list(season.values()), ["Show: Next Season"])

	def test_static_names(self):
		registry = registry_of(plan_of([movie(1, "A"), movie(2, "B")]))
		self.assertEqual(registry.unit_for_static_name("Unlock 2"), "movie|rk:2")
		for name in ("Unlock 3", "Unlock 0", "Unlock 02", "unlock 1", "Unlock 1 ", "Check 1"):
			self.assertIsNone(registry.unit_for_static_name(name), name)
		self.assertEqual(registry.location_for_static_name("Check 1"), registry.location_keys[0])
		self.assertIsNone(registry.location_for_static_name(f"Check {len(registry.location_keys) + 1}"))

	def test_seed_caps(self):
		saved = P.registry.MAX_UNLOCKS, P.registry.MAX_CHECKS
		try:
			P.registry.MAX_UNLOCKS = 1
			with self.assertRaises(P.registry.RegistryError):
				registry_of(plan_of([movie(1, "A")]), plan_of([movie(2, "B")]))
			P.registry.MAX_UNLOCKS, P.registry.MAX_CHECKS = saved[0], 3
			with self.assertRaises(P.registry.RegistryError):
				registry_of(plan_of([movie(n, "F") for n in range(4)], timesanity_movies=0))
		finally:
			P.registry.MAX_UNLOCKS, P.registry.MAX_CHECKS = saved


def _plain(value, path="slot_data"):
	if isinstance(value, dict):
		for key, item in value.items():
			if not isinstance(key, str):
				raise AssertionError(f"{path} has a non-text key {key!r}")
			_plain(item, f"{path}.{key}")
	elif isinstance(value, list):
		for i, item in enumerate(value):
			_plain(item, f"{path}[{i}]")
	elif value is not None and type(value) not in (str, int, bool):
		raise AssertionError(f"{path} is a {type(value).__name__}")


class OutputTest(unittest.TestCase):
	def setUp(self):
		cases = {case[0]: case for case in make_plan_cases.cases()}
		_name, options, entries = cases["everything mixed"]
		self.plan = plan_of(entries, **options)
		self.registry = registry_of(self.plan)

	def test_slot_data_is_plain_json_with_every_id(self):
		info = P.entries.parse_list_info({"created_at": 5, "label": "L"})
		data = P.slotdata.build_slot_data(self.plan, self.registry, info, "0.1.0", 1731300000)
		_plain(data)
		self.assertEqual(list(data)[:9], ["schema", "game", "world_version", "builder", "generated_at", "created_at",
		                                  "label", "goal_percent", "goal_count"])
		self.assertEqual(data["timesanity"], {"movie": 15, "episode": 10, "album": 5, "book": 30})
		self.assertEqual(data["entry_count"], len(self.plan.entries))
		self.assertEqual([u["start"] for u in data["units"]], [u.start for u in self.plan.units])
		ids = set(self.registry.location_id.values())
		for entry in data["entries"]:
			used = [c[1] for c in entry["cp"]] + [entry[k] for k in ("w", "f") if isinstance(entry.get(k), int)]
			used += [t[-1] for t in entry.get("tr", []) if t[-1] is not None]
			self.assertTrue(set(used) <= ids, entry["id"])
			self.assertIn(entry["u"], set(self.registry.unit_id.values()))
		by_kind = {entry["k"]: entry for entry in data["entries"]}
		self.assertEqual(list(by_kind["movie"]), ["k", "id", "rk", "t", "y", "d", "u", "s", "w", "cp"])
		self.assertEqual(list(by_kind["episode"]), ["k", "id", "rk", "sh", "sid", "srk", "sn", "en", "t", "d", "u", "s",
		                                            "w", "cp"])
		self.assertEqual(list(by_kind["album"]), ["k", "id", "rk", "g", "ar", "t", "y", "d", "tr", "alt", "u", "s",
		                                          "cp"])
		self.assertEqual(list(by_kind["mix"]), ["k", "id", "pl", "part", "t", "d", "tr", "u", "s", "cp"])
		self.assertEqual(list(by_kind["book"]), ["k", "id", "w", "t", "au", "d", "pa", "u", "s", "f", "cp"])
		self.assertIsNone(by_kind["album"]["tr"][0][5])
		self.assertEqual(by_kind["album"]["d"], 440000)

	def test_slot_data_names_no_person(self):
		# The room hands slot_data to any client joined as the slot, and archipelago.gg serves it to anyone.
		info = P.entries.parse_list_info({"label": "L", "account": 7, "discord": "123456789012345678"})
		data = P.slotdata.build_slot_data(self.plan, self.registry, info, "0.1.0", 1731300000)
		self.assertNotIn("account", data)
		self.assertNotIn("discord", data)
		self.assertNotIn("123456789012345678", json.dumps(data))

	def test_data_package(self):
		package = P.datapackage.build_package(self.registry)
		self.assertEqual(list(package), ["item_name_groups", "item_name_to_id", "location_name_groups",
		                                 "location_name_to_id"])
		items, locations = package["item_name_to_id"], package["location_name_to_id"]
		self.assertEqual(list(items)[:2], ["Popcorn", "Wild Ticket"])
		self.assertEqual(len(set(items.values())), len(items))
		self.assertEqual(len(set(locations.values())), len(locations))
		for groups, expected in ((package["item_name_groups"], C.ITEM_GROUPS),
		                         (package["location_name_groups"], C.LOCATION_GROUPS)):
			self.assertEqual(list(groups), sorted(expected))
			for members in groups.values():
				self.assertEqual(members, sorted(members))
		self.assertEqual(package["item_name_groups"]["Everything"], sorted(items))
		self.assertEqual(package["location_name_groups"]["Everywhere"], sorted(locations))
		self.assertEqual(package["item_name_groups"]["Shows"], ["Show H: Next 2 Episodes"])

	def test_goal_counter_arithmetic(self):
		opened = P.rules.opened_by
		self.assertEqual([opened(3, [0, 3, 6, 7], c) for c in range(0, 6)], [0, 3, 3, 1, 0, 0])
		self.assertEqual([opened(1, [0, 1], c) for c in range(0, 3)], [0, 1, 0])


COUNT = {"type": "named_range", "special": {"preset": -1}, "default": "preset"}
TEXT = {"type": "text", "default": ""}
# The list settings as designed, in the order the bot writes them.
DESIGNED_LIST_OPTIONS = {
	"list_preset": {"type": "choice", "values": ["movies", "tv", "music", "books", "mixed", "none"], "default": "movies"},
	"list_movies": dict(COUNT, min=0, max=200),
	"list_shows": dict(COUNT, min=0, max=50),
	"list_albums": dict(COUNT, min=0, max=200),
	"list_books": dict(COUNT, min=0, max=50),
	"list_titles": TEXT,
	"list_playlist": TEXT,
	"list_collection": TEXT,
	"list_genre": TEXT,
	"list_years": TEXT,
	"list_unwatched": {"type": "toggle", "default": True},
	"list_max_episodes": {"type": "range", "min": 1, "max": 500, "default": 24},
	"list_label": TEXT,
}
# The types AP 0.6.8's Options Creator gives a widget (OptionsCreator.create_option); test_generate.py's
# A1 runs its dispatch on the real classes.
CREATOR_TYPES = ("named_range", "range", "toggle", "choice", "text")
# One value of every list setting, none of them its default.
LIST_SETTINGS = {"list_preset": "none", "list_movies": 7, "list_shows": 2, "list_albums": 0, "list_books": 1,
                 "list_titles": "Alien; show: Lost S1-2", "list_playlist": "Road Trip", "list_collection": "Pixar",
                 "list_genre": "Horror", "list_years": "1990-1999", "list_unwatched": False, "list_max_episodes": 6,
                 "list_label": "Mixed Fan's list"}


class ListSettingsTest(unittest.TestCase):
	def test_the_list_settings_are_the_designed_table(self):
		self.assertEqual(C.LIST_OPTIONS, DESIGNED_LIST_OPTIONS)
		self.assertEqual(list(C.LIST_OPTIONS), list(DESIGNED_LIST_OPTIONS))
		self.assertFalse(set(C.LIST_OPTIONS) & set(C.OPTIONS))
		self.assertEqual(C.LIST_OPTIONS["list_preset"]["values"], list(C.PRESETS) + ["none"])
		self.assertEqual(set(LIST_SETTINGS), set(C.LIST_OPTIONS))
		for key, spec in {**C.OPTIONS, **C.LIST_OPTIONS}.items():
			with self.subTest(option=key):
				self.assertIn(spec["type"], CREATOR_TYPES)
				for name, number in spec.get("special", {}).items():
					# A slider or a typed count can never mean preset by accident.
					self.assertFalse(spec["min"] <= number <= spec["max"], name)

	def test_list_settings_move_no_id_name_or_slot_data(self):
		cases = {case[0]: case for case in make_plan_cases.cases()}
		_name, options, entries = cases["everything mixed"]
		info = P.entries.parse_list_info({"created_at": 5, "label": "L"})
		built = []
		# The world hands the plan only OPTIONS (options.option_values); this holds even if the list
		# settings reached it.
		for given in (options, {**options, **LIST_SETTINGS}):
			plan = plan_of(entries, **given)
			registry = registry_of(plan)
			data = P.slotdata.build_slot_data(plan, registry, info, C.WORLD_VERSION, 1731300000)
			built.append({"plan": P.plan.summary(plan), "units": registry.unit_name, "unit_ids": registry.unit_id,
			              "locations": registry.location_name, "location_ids": registry.location_id,
			              "package": P.datapackage.build_package(registry), "slot_data": data})
		for part in built[0]:
			with self.subTest(part=part):
				self.assertEqual(built[1][part], built[0][part])
		self.assertNotIn("list_", json.dumps(list(built[1]["slot_data"])))
		self.assertNotIn(LIST_SETTINGS["list_label"], json.dumps(built[1]["slot_data"], ensure_ascii=False))


def run_node(script):
	node = shutil.which("node")
	if node is None:
		raise unittest.SkipTest("node is not on PATH")
	proc = subprocess.run([node, "-"], input=script, capture_output=True, text=True, encoding="utf-8",
	                      cwd=purelib.REPO, timeout=120)
	if proc.returncode:
		raise AssertionError(f"node failed: {proc.stderr}")
	return json.loads(proc.stdout)


def _lists(value):
	return json.loads(json.dumps(value))


SAMPLES = [
	None, "", "plain", "  lead and trail  ", "tab\tnew\nline\r\nend", "\x00\x01nul\x1f\x7fdel\x80\x9f",
	"\x1c\x1d\x1e\x1fseparators", "a" + chr(0x85) + "b", "a" + chr(0x2028) + "b" + chr(0x2029) + "c",
	chr(0xfeff) + "bom", chr(0xfffe) + chr(0xffff) + "x", "nb" + chr(0xa0) + chr(0xa0) + "sp",
	"".join(chr(c) for c in (0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000)) + "wide",
	"zero" + chr(0x200b) + "width", chr(0xd800) + "lone", "end" + chr(0xdfff), "film " + chr(0x1f3ac),
	"Am" + chr(0xe9) + "lie", " " + chr(0xa0) + " ", "x  " + chr(0x3000) + " y", "\v\f",
]


class MirrorTest(unittest.TestCase):
	def test_constants_and_sanitiser_match_the_js_contracts(self):
		payload = json.dumps(json.dumps(SAMPLES))
		units = [episode(1, 1, 1), movie(2, "M"), album(3, [("S", 60000)])]
		js = run_node(
			"const c = require('./helpers/apMediaContracts.js');\n"
			f"const samples = JSON.parse({payload});\n"
			f"const units = JSON.parse({json.dumps(json.dumps(units))});\n"
			"const out = {GAME: c.GAME, APWORLD_NAME: c.APWORLD_NAME, WORLD_VERSION: c.WORLD_VERSION,\n"
			"  MIN_AP_VERSION: c.MIN_AP_VERSION, BUILDER_VERSION: c.BUILDER_VERSION, SLOT_DATA_SCHEMA: c.SLOT_DATA_SCHEMA,\n"
			"  BASE_ID: c.BASE_ID, UNLOCK_OFFSET: c.UNLOCK_OFFSET, MAX_UNLOCKS: c.MAX_UNLOCKS, MAX_CHECKS: c.MAX_CHECKS,\n"
			"  IDS: c.IDS, NAMES: c.NAMES, ITEM_GROUPS: c.ITEM_GROUPS, LOCATION_GROUPS: c.LOCATION_GROUPS,\n"
			"  KINDS: c.KINDS, TIMER_KIND: c.TIMER_KIND, LIMITS: c.LIMITS, OPTIONS: c.OPTIONS,\n"
			"  LIST_OPTIONS: c.LIST_OPTIONS === undefined ? null : c.LIST_OPTIONS, PRESETS: c.PRESETS,\n"
			"  ids: [c.unlockId(1), c.unlockId(20000), c.checkId(1), c.checkId(60000), c.unlockName(7), c.checkName(9)],\n"
			"  sanitized: samples.map(c.sanitizeText),\n"
			"  units: units.map((e) => [c.entryKey(e), c.unitKey(e), c.unitKey(e, {tvUnlock: 'season'}),\n"
			"    c.unitKey(e, {episodesPerUnlock: 5})])};\n"
			"process.stdout.write(JSON.stringify(out));\n"
		)
		mine = {
			"GAME": C.GAME, "APWORLD_NAME": C.APWORLD_NAME, "WORLD_VERSION": C.WORLD_VERSION,
			"MIN_AP_VERSION": C.MIN_AP_VERSION, "BUILDER_VERSION": C.BUILDER_VERSION,
			"SLOT_DATA_SCHEMA": C.SLOT_DATA_SCHEMA, "BASE_ID": C.BASE_ID, "UNLOCK_OFFSET": C.UNLOCK_OFFSET,
			"MAX_UNLOCKS": C.MAX_UNLOCKS, "MAX_CHECKS": C.MAX_CHECKS,
			"IDS": {"popcorn": C.POPCORN_ID, "wildTicket": C.WILD_TICKET_ID},
			"NAMES": {"popcorn": C.POPCORN, "wildTicket": C.WILD_TICKET, "victory": C.VICTORY,
			          "goalLocation": C.GOAL_LOCATION, "counter": C.COUNTER},
			"ITEM_GROUPS": C.ITEM_GROUPS, "LOCATION_GROUPS": C.LOCATION_GROUPS, "KINDS": C.KINDS,
			"TIMER_KIND": C.TIMER_KIND,
			"LIMITS": {"maxEntries": C.MAX_ENTRIES, "maxCopies": C.MAX_COPIES, "maxLocations": C.MAX_LOCATIONS,
			           "minTrackMs": C.MIN_TRACK_MS, "checkpointCut": C.CHECKPOINT_CUT,
			           "copiesPerStart": C.COPIES_PER_START, "mixTracks": C.MIX_TRACKS,
			           "slotNameMax": C.SLOT_NAME_MAX, "titleMax": C.TITLE_MAX, "warnCopies": C.WARN_COPIES,
			           "warnLocations": C.WARN_LOCATIONS, "warnHoursToGoal": C.WARN_HOURS_TO_GOAL},
			"OPTIONS": C.OPTIONS,
			"LIST_OPTIONS": C.LIST_OPTIONS,
			"PRESETS": C.PRESETS,
			"ids": [C.unlock_id(1), C.unlock_id(20000), C.check_id(1), C.check_id(60000), C.unlock_name(7),
			        C.check_name(9)],
			"sanitized": [P.naming.sanitize_text(sample) for sample in SAMPLES],
			"units": [[P.entries.entry_key(e), P.plan.unit_key(e, False, 3), P.plan.unit_key(e, True, 3),
			           P.plan.unit_key(e, False, 5)] for e in units],
		}
		mine = _lists(mine)
		for key in mine:
			with self.subTest(key=key):
				self.assertEqual(js[key], mine[key])

	def test_list_counts_follow_the_bots_ranges_and_default_preset(self):
		js = run_node("const c = require('./helpers/apMediaContracts.js');\n"
		              "process.stdout.write(JSON.stringify({ranges: c.COUNT_RANGES, preset: c.DEFAULT_PRESET}));\n")
		for kind in ("movies", "shows", "albums", "books"):
			spec = C.LIST_OPTIONS[f"list_{kind}"]
			with self.subTest(kind=kind):
				self.assertEqual({"min": spec["min"], "max": spec["max"]}, js["ranges"][kind])
		episodes = C.LIST_OPTIONS["list_max_episodes"]
		self.assertEqual({"min": episodes["min"], "max": episodes["max"], "default": episodes["default"]},
		                 js["ranges"]["maxEpisodes"])
		self.assertEqual(C.LIST_OPTIONS["list_preset"]["default"], js["preset"])

	def test_the_manifest_carries_the_world_version(self):
		# fill_slot_data falls back to WORLD_VERSION when AP reads no version from the manifest.
		with open(os.path.join(purelib.SRC, "archipelago.json"), encoding="utf-8") as handle:
			self.assertEqual(json.load(handle)["world_version"], C.WORLD_VERSION)

	def test_sanitiser_is_idempotent(self):
		for sample in SAMPLES:
			once = P.naming.sanitize_text(sample)
			self.assertEqual(P.naming.sanitize_text(once), once)


def parse_source(path):
	with open(path, encoding="utf-8") as handle:
		return ast.parse(handle.read(), path)


class RunnerTest(unittest.TestCase):
	def test_run_py_runs_every_file_that_holds_scenarios(self):
		# run.py runs only the modules it loads and loops over, so a file it leaves out is skipped
		# with nothing failing to show it.
		tests = os.path.dirname(os.path.abspath(__file__))
		holding = set()
		for name in sorted(os.listdir(tests)):
			if not (name.startswith("test_") and name.endswith(".py")) or name == "test_pure.py":
				continue
			tree = parse_source(os.path.join(tests, name))
			if any(isinstance(node, ast.ClassDef) and any(ast.unparse(base) in ("unittest.TestCase", "TestCase")
			                                               for base in node.bases) for node in tree.body):
				holding.add(name)
		self.assertGreaterEqual(holding, {"test_generate.py", "test_e2e.py", "test_creator.py"})
		runner = parse_source(os.path.join(tests, "run.py"))
		loaded = {}
		for node in ast.walk(runner):
			if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
			        and ast.unparse(node.value.func) == "load"):
				loaded[ast.unparse(node.targets[0])] = node.value.args[1].value
		self.assertEqual(sorted(loaded.values()), sorted(holding))
		picked = next(node.value for node in ast.walk(runner)
		              if isinstance(node, ast.Assign) and ast.unparse(node.targets[0]) == "picked")
		looped = next(node.iter for node in ast.walk(picked) if isinstance(node, ast.comprehension))
		self.assertEqual(sorted(ast.unparse(element) for element in looped.elts), sorted(loaded))


if __name__ == "__main__":
	unittest.main(verbosity=2)
