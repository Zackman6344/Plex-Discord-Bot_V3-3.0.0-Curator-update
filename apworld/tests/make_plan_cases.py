# apworld/tests/make_plan_cases.py
# Writes test/fixtures/apmedia/plan_cases.json: plan.py's answers for the JS twin (helpers/apMediaPlan.js).
#
# Each case is {name, options, entries, expect}. options holds every option of the table in
# constants.py by its YAML name, entries are YAML entries exactly as the bot writes them, and expect
# is plan.summary() of the plan:
#   {C, S, W, N_main, N_checkpoints, goal_count,
#    FF, RC, F, T,                               Fast Forwards, Remote Controls, the filler slots and
#                                                the traps among them
#    traps: {buffering: n, ...}                  by trap key, in TRAPS order
#    snacks: {Popcorn: n, ...}                   by name, in SNACKS order; F - T in all
#    units: [{key, steps, start, prefix}]        in order of first appearance in entries
#    entries: [{key, unit, step, main, checkpoints}]}  in YAML order; main counts the entry's watch,
#                                                     finish or track locations, checkpoints lists
#                                                     its checkpoint minutes
# test_pure.py fails when the file and plan.py disagree. After a deliberate change to plan.py, run
#   py -3.13 -O -s -S -B apworld/tests/make_plan_cases.py
# and commit the new file with the change.

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import purelib  # noqa: E402

OUT = os.path.join(purelib.REPO, "test", "fixtures", "apmedia", "plan_cases.json")


def movie(rk, title, d, y=2000):
	return {"k": "movie", "id": f"rk:{rk}", "rk": rk, "t": title, "y": y, "d": d}


def episode(rk, show, sid, srk, sn, en, d=1320000):
	return {"k": "episode", "id": f"rk:{rk}", "rk": rk, "t": f"Episode {en}", "sh": show, "sid": sid, "srk": srk,
	        "sn": sn, "en": en, "d": d}


def album(rk, artist, title, tracks):
	tr = [[rk * 100 + n, n, name, d, rk * 1000 + n] for n, (name, d) in enumerate(tracks, 1)]
	return {"k": "album", "id": f"plex://album/{rk}", "rk": rk, "g": f"plex://album/{rk}", "ar": artist,
	        "t": title, "y": 2001, "d": sum(d for _name, d in tracks), "tr": tr}


def mix(pl, part, title, tracks):
	tr = [[pl * 100 + n, n, name, d, pl * 1000 + n, artist] for n, (name, artist, d) in enumerate(tracks, 1)]
	return {"k": "mix", "id": f"pl:{pl}:{part}", "pl": pl, "part": part, "t": title,
	        "d": sum(d for _name, _artist, d in tracks), "tr": tr}


def book(work, title, author, parts):
	pa = [[7000 + n, 8000 + n, d] for n, d in enumerate(parts, 1)]
	return {"k": "book", "id": f"book:{work}", "w": work, "t": title, "au": author, "d": sum(parts), "pa": pa}


def show(sid, srk, name, episodes, rk=1000):
	"""episodes: [(season, episode)] in the order the YAML lists them."""
	return [episode(rk + i, name, sid, srk, sn, en) for i, (sn, en) in enumerate(episodes)]


SEVEN = [(2, 3), (1, 1), (1, 2), (2, 1), (1, 3), (1, 4), (2, 2)]
MIX_TRACKS = [(f"Song {n}", f"Artist {n % 4}", 150000 + n * 1000) for n in range(1, 16)]
# Six 100-minute films at 15 minutes: 6 watches and 30 checkpoints, 3 unlocks in the pool.
SIX_FILMS = [movie(n, f"Film {n}", 6000000) for n in range(1, 7)]
NO_TRAPS = {"buffering_weight": 0, "rights_expired_weight": 0, "commercial_break_weight": 0,
            "shuffle_mode_weight": 0, "rewind_weight": 0, "intermission_weight": 0, "slow_motion_weight": 0}


def cases():
	return [
		("movies at the defaults", {}, [
			movie(1, "Long Film", 102 * 60000),
			movie(2, "Short Film", 90 * 60000),
			movie(3, "Unknown Length", 0),
		]),
		("the 0.9 cut at 15 minutes", {"timesanity_movies": 15}, [
			movie(1, "Exactly At The Cut", 1000000),
			movie(2, "One Past The Cut", 1000001),
			movie(3, "One Short Of The Cut", 999999),
		]),
		("the 0.9 cut at 10 minutes", {"timesanity_movies": 10}, [
			movie(1, "One Hundred Minutes", 6000000),
			movie(2, "One Hundred Minutes Plus", 6000001),
		]),
		("episodes, three per unlock", {"episodes_per_unlock": 3}, show("plex://show/a", 50, "Show A", SEVEN)),
		("episodes, one per unlock", {"episodes_per_unlock": 1}, show("plex://show/a", 50, "Show A", SEVEN)),
		("episodes, twelve per unlock", {"episodes_per_unlock": 12}, show("plex://show/a", 50, "Show A", SEVEN)),
		("episodes with specials", {"episodes_per_unlock": 2},
		 show("rk:60", 60, "Show B", [(1, 1), (0, 2), (1, 2), (0, 1), (1, 3)])),
		("season mode", {"tv_unlock": "season"},
		 show("plex://show/c", 70, "Show C", [(3, 1), (1, 1), (0, 1), (1, 2), (3, 2), (3, 3)])
		 + show("plex://show/d", 80, "Show D", [(2, 1), (2, 2)], rk=2000)
		 + [movie(9, "A Film", 7200000)]),
		("album with short tracks", {"timesanity_albums": 2}, [
			album(30, "An Artist", "An Album", [("Exactly Thirty", 30000), ("Just Short", 29999),
			                                    ("Long One", 200000), ("Skit", 15000)]),
		]),
		("a playlist mix on the albums timer", {"timesanity_albums": 10}, [
			mix(40, 1, "Road Trip Part 1", MIX_TRACKS),
		]),
		("three books, one starting unlock", {"starting_unlocks": 1}, [
			book("author-a/book-one", "Book One", "Author A", [3600000, 2700000]),
			book("author-a/book-two", "Book Two", "Author A", [5400000]),
			book("author-b/book-three", "Book Three", "Author B", [1800000, 1800000, 1800000]),
		]),
		("starting copies round robin", {"starting_unlocks": 7, "episodes_per_unlock": 1, "timesanity_episodes": 0},
		 show("rk:91", 91, "Show E", [(1, n) for n in range(1, 6)])
		 + show("rk:92", 92, "Show F", [(1, n) for n in range(1, 6)], rk=2000)
		 + [movie(9, "A Film", 7200000)]),
		("starting copies from a long list", {"starting_unlocks": 1, "timesanity_movies": 0},
		 [movie(100 + n, f"Film {n:03}", 6000000) for n in range(120)]),
		("a single title", {}, [movie(1, "Only Film", 6000000)]),
		("wild tickets clamped", {"episodes_per_unlock": 1, "wild_tickets": 20, "timesanity_episodes": 0},
		 show("rk:93", 93, "Show G", [(1, n) for n in range(1, 6)])),
		("no wild tickets", {"wild_tickets": 0}, [movie(n, f"Film {n}", 6000000) for n in range(1, 5)]),
		("goal of three at 80 percent", {"goal_percent": 80}, [movie(n, f"Film {n}", 0) for n in range(1, 4)]),
		("goal of one at 1 percent", {"goal_percent": 1}, [movie(1, "Film", 0)]),
		("goal of fifty at 80 percent", {"goal_percent": 80, "timesanity_movies": 0},
		 [movie(n, f"Film {n}", 0) for n in range(1, 51)]),
		("everything mixed", {"timesanity_movies": 15, "timesanity_episodes": 10, "timesanity_albums": 5,
		                      "timesanity_books": 30, "episodes_per_unlock": 2, "starting_unlocks": 2}, [
			movie(1, "A Film", 8160000),
			*show("plex://show/h", 94, "Show H", [(1, 1), (1, 2), (1, 3)]),
			album(31, "Band", "Record", [("Intro", 20000), ("Song", 240000), ("Outro", 180000)]),
			mix(41, 2, "Party Part 2", MIX_TRACKS[:4]),
			book("author-c/novel", "Novel", "Author C", [7200000, 3600000]),
		]),
		("timesanity off", {"timesanity_movies": 0, "timesanity_episodes": 0, "timesanity_albums": 0,
		                    "timesanity_books": 0}, [
			movie(1, "A Film", 8160000),
			*show("plex://show/h", 94, "Show H", [(1, 1), (1, 2)]),
			book("author-c/novel", "Novel", "Author C", [7200000]),
		]),
		("traps at 40 percent", {"trap_percentage": 40}, SIX_FILMS),
		("every filler slot a trap, equal weights", {"trap_percentage": 100, **{key: 1 for key in NO_TRAPS}},
		 SIX_FILMS),
		("snack variety off", {"snack_variety": False, "trap_percentage": 10}, SIX_FILMS),
		("a weight of 0 never gains a trap", {"trap_percentage": 17, **NO_TRAPS, "rights_expired_weight": 3,
		                                      "rewind_weight": 1}, SIX_FILMS),
		("useful items clamped by the room the unlocks leave", {"starting_unlocks": 5, "wild_tickets": 1,
		                                                        "fast_forwards": 3, "remote_controls": 10},
		 [movie(n, f"Film {n}", 6000000) for n in range(1, 11)]),
	]


def build_cases():
	pure = purelib.load()
	out = []
	for name, options, entries in cases():
		full = pure.plan.plan_options(options)
		plan = pure.plan.plan_slot(pure.entries.parse_entries(entries), full)
		out.append({"name": name, "options": full, "entries": entries, "expect": pure.plan.summary(plan)})
	return out


def _one(value):
	return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _rows(lines, key, rows, indent, last):
	lines.append(f'{indent}"{key}": [')
	for i, row in enumerate(rows):
		lines.append(f"{indent}\t{_one(row)}{',' if i < len(rows) - 1 else ''}")
	lines.append(f"{indent}]{'' if last else ','}")


def render(built):
	lines = ["["]
	for c, case in enumerate(built):
		expect = case["expect"]
		lines.append("\t{")
		lines.append(f'\t\t"name": {_one(case["name"])},')
		lines.append(f'\t\t"options": {_one(case["options"])},')
		_rows(lines, "entries", case["entries"], "\t\t", False)
		lines.append('\t\t"expect": {')
		for key in ("C", "S", "W", "N_main", "N_checkpoints", "goal_count", "FF", "RC", "F", "T"):
			lines.append(f'\t\t\t"{key}": {expect[key]},')
		for key in ("traps", "snacks"):
			lines.append(f'\t\t\t"{key}": {_one(expect[key])},')
		_rows(lines, "units", expect["units"], "\t\t\t", False)
		_rows(lines, "entries", expect["entries"], "\t\t\t", True)
		lines.append("\t\t}")
		lines.append("\t}" + ("," if c < len(built) - 1 else ""))
	lines.append("]")
	return "\n".join(lines) + "\n"


def main():
	text = render(build_cases())
	os.makedirs(os.path.dirname(OUT), exist_ok=True)
	with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
		handle.write(text)
	print(f"wrote {OUT}")


if __name__ == "__main__":
	main()
