# apworld/tests/test_e2e.py
# Scenario (g): the whole Plex Media feature end to end against a real Archipelago 0.6.8 MultiServer.
#
# One seed: a Plex Media list in the exact text the bot's renderYaml() writes (two movies on a
# 15-minute timer and an episode; one title opens at the start, the goal is two of the three) beside
# a ChecksFinder slot, generated with the frozen Archipelago. MultiServer hosts it the way its main()
# does, minus the console and the save file, in this process: a background thread's event loop on a
# free loopback port. The bot's side is apworld/tests/e2e_bot.test.js under node --test: the real
# apMediaGame, ApMediaClient and archipelagoMonitor against that room, a fake PMS and a fake Discord
# client. It reads the room's own record (location_checks, client_game_state, the clients on each
# slot) from GET /state, which this file serves on loopback and reads on the room's loop. Where the
# locked title's unlock sits comes from the multidata: in the ChecksFinder world, the node side
# sends that location as the ChecksFinder player through a raw client; in the Plex world, the bot
# sends it by watching the title that holds it.
#
# Harness: unittest, run by run.py after test_generate.prepare() has loaded Archipelago into a temp
# root that run.py removes afterwards; --only G runs this scenario alone. setUpClass generates,
# hosts and runs node once (its output is shown when it fails), then stops the room, and the tests
# read what that run left: the node verdict, the room's final record, whether the room's thread
# ended, and the checkout's data/ folder, which no store may write to. One test hosts the seed
# again to force the Windows connection reset that some runs hit by chance, which must not hold the
# room open. Bare assert is never used: -O strips it.

import asyncio
import collections
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import ap_harness  # noqa: E402
from test_generate import episode, movie, plain, rendered_yaml, write_checksfinder  # noqa: E402

GAME = "Plex Media"
FINDER_GAME = "ChecksFinder"
DRIVER = os.path.join(HERE, "e2e_bot.test.js")
DATA = os.path.join(REPO, "data")
# Puts the locked film's unlock on a ChecksFinder tile, so its release crosses the multiworld;
# read_facts follows whichever placement a seed makes, should the fill ever change.
SEED = 707
NODE_TIMEOUT = 150
CLIENT_GOAL = 30
OWNER = "100000000000000009"
OPEN_FILM = movie(7101, "Opening Night", 2400000, 2001)
LOCKED_FILM = movie(7102, "Second Feature", 2100000, 2002)
PILOT = episode(7201, "Late Show", "rk:7200", 7200, 1, 1, 1320000)
DOC = {"name": "E2E Plex", "label": "End-to-end list", "createdAt": 1731200000,
       "options": {"starting_unlocks": 1, "goal_percent": 67, "timesanity_movies": 15, "wild_tickets": 0},
       "entries": [OPEN_FILM, LOCKED_FILM, PILOT], "listInfo": {"account": 1, "discord": OWNER}}

STATE = {"root": None}


def prepare(root):
	"""Called by run.py after test_generate.prepare(root, ...) has loaded Archipelago into root."""
	STATE["root"] = root


class Room:
	"""One seed hosted by MultiServer on a free loopback port, on a background thread's event loop."""

	def __init__(self, zip_path, close_seconds=5):
		import MultiServer

		self.ctx = MultiServer.Context("127.0.0.1", 0, "", "", 1, 10, False)
		self.ctx.load(zip_path)
		# No init_save(): saving stays off, so nothing is written beside the zip.
		self.close_seconds = close_seconds
		self.resets = 0
		self.loop = asyncio.new_event_loop()
		self.loop.set_exception_handler(self._loop_error)
		self.port = None
		self.error = None
		self._stop = None
		self._ready = threading.Event()
		self._thread = threading.Thread(target=self._run, name="plex-media-e2e-room", daemon=True)
		self._thread.start()
		if not self._ready.wait(30):
			raise RuntimeError("MultiServer did not start listening within 30 s")
		if self.error is not None:
			raise RuntimeError(f"MultiServer did not start: {self.error!r}")

	def _run(self):
		asyncio.set_event_loop(self.loop)
		try:
			self.loop.run_until_complete(self._serve())
		except BaseException as err:
			self.error = err
		finally:
			self._ready.set()
			try:
				self.loop.run_until_complete(self.loop.shutdown_asyncgens())
			finally:
				self.loop.close()

	def _loop_error(self, loop, context):
		# Windows' Proactor loop: once a peer has reset a connection, _call_connection_lost raises
		# WinError 10054 from shutdown() before it detaches the transport from the server. It says
		# nothing about the bot, so it is counted rather than logged; _serve's bounded close is what
		# keeps the stranded transport from holding the room open.
		error = context.get("exception")
		if isinstance(error, ConnectionResetError) and any(
				frame.f_code.co_name == "_call_connection_lost" for frame, _line in traceback.walk_tb(error.__traceback__)):
			self.resets += 1
			return
		loop.default_exception_handler(context)

	async def _serve(self):
		import MultiServer
		import websockets

		self._stop = asyncio.Event()
		server = await websockets.serve(functools.partial(MultiServer.server, ctx=self.ctx), host="127.0.0.1", port=0,
		                                extensions=[MultiServer.server_per_message_deflate_factory])
		self.port = server.sockets[0].getsockname()[1]
		self._ready.set()
		try:
			await self._stop.wait()
		finally:
			server.close()
			# asyncio.Server.wait_closed() waits for every transport to detach, which one stranded by
			# such a reset never does.
			try:
				await asyncio.wait_for(server.wait_closed(), self.close_seconds)
			except TimeoutError:
				pass
			# What is left (MultiServer's async_start broadcasts, a close stuck on a stranded transport)
			# would otherwise die with the loop.
			rest = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
			for task in rest:
				task.cancel()
			await asyncio.gather(*rest, return_exceptions=True)

	def snapshot(self, timeout=10):
		"""The room's own record, read on its loop between two packets."""

		async def read():
			ctx = self.ctx
			slots = sorted(ctx.slot_info)
			return {
				"checked": {str(slot): sorted(ctx.location_checks.get((0, slot), ())) for slot in slots},
				"status": {str(slot): int(ctx.client_game_state.get((0, slot), 0)) for slot in slots},
				"clients": {str(slot): [{"tags": list(client.tags), "noLocations": bool(client.no_locations),
				                         "noText": bool(client.no_text)} for client in ctx.clients[0].get(slot, [])]
				            for slot in slots},
				"endpoints": len(ctx.endpoints),
			}

		return asyncio.run_coroutine_threadsafe(read(), self.loop).result(timeout)

	def settle(self, predicate, seconds):
		"""The first snapshot predicate accepts, or the last one taken once seconds have passed."""
		deadline = time.monotonic() + seconds
		while True:
			state = self.snapshot()
			if predicate(state) or time.monotonic() > deadline:
				return state
			time.sleep(0.05)

	def stop(self, seconds=15):
		"""Whether the room's thread has ended, given up to seconds to do so."""
		if self._stop is not None:
			try:
				self.loop.call_soon_threadsafe(self._stop.set)
			except RuntimeError:
				pass
		self._thread.join(seconds)
		return not self._thread.is_alive()


class StateServer:
	"""GET /state on loopback: Room.snapshot() as JSON, so the node side can read the room mid-run."""

	def __init__(self, room):
		class Handler(http.server.BaseHTTPRequestHandler):
			def do_GET(self):
				if self.path != "/state":
					self.send_error(404)
					return
				try:
					body = json.dumps(room.snapshot()).encode("utf-8")
				except Exception as err:
					self.send_error(500, "the room could not be read", repr(err))
					return
				self.send_response(200)
				self.send_header("Content-Type", "application/json")
				self.send_header("Content-Length", str(len(body)))
				self.end_headers()
				self.wfile.write(body)

			def log_message(self, *_args):
				pass

		self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
		self.port = self.httpd.server_address[1]
		self._thread = threading.Thread(target=self.httpd.serve_forever, name="plex-media-e2e-state", daemon=True)
		self._thread.start()

	def stop(self):
		self.httpd.shutdown()
		self.httpd.server_close()
		self._thread.join(10)


def ids_of(entry):
	"""A movie's or an episode's location ids: its watch location, then its checkpoints."""
	return [entry["w"]] + [location for _minute, location in entry["cp"]]


def label(entry):
	"""A movie or an episode as the bot names it (entryLabel in helpers/apMediaGame.js)."""
	if entry["k"] == "episode":
		return f"{entry['sh']} S{entry['sn']:02}E{entry['en']:02}"
	return f"{entry['t']} ({entry['y']})" if entry.get("y") else entry["t"]


def read_facts(md):
	"""Who plays what, which title the list opens with, and the locked title the test watches with
	how its unlock reaches the bot: the first title still locked once the open one is watched whose
	unlock the ChecksFinder player holds, else one whose unlock sits at a title that is open by then."""
	slot_info = md["slot_info"]
	plex = next(slot for slot, info in slot_info.items() if info.game == GAME)
	finder = next(slot for slot, info in slot_info.items() if info.game == FINDER_GAME)
	data = plain(md["slot_data"][plex])
	units = {unit["id"]: unit for unit in data["units"]}
	entries = data["entries"]
	table = md["locations"]

	def unlocked(entry, received):
		return units[entry["u"]]["start"] + received[entry["u"]] >= entry["s"]

	opening = [entry for entry in entries if unlocked(entry, collections.Counter())]
	if not opening:
		raise AssertionError("the seed opens no title")
	first = opening[0]
	# What the first title's own checks hand the list once the bot sends them.
	received = collections.Counter(table[plex][location][0] for location in ids_of(first)
	                               if table[plex][location][1] == plex)
	open_after = [entry for entry in entries if unlocked(entry, received)]
	still_locked = [entry for entry in entries if entry not in open_after]
	spots = collections.defaultdict(list)
	for slot, locations in table.items():
		for location, (item, receiver, _flags) in locations.items():
			if receiver == plex and item in units:
				spots[item].append((slot, location))
	tile_names = {code: name for name, code in md["datapackage"][FINDER_GAME]["location_name_to_id"].items()}
	plex_names = {code: name for name, code in md["datapackage"][GAME]["location_name_to_id"].items()}
	picked = None
	for entry in still_locked:
		tiles = [location for slot, location in spots[entry["u"]] if slot == finder]
		if tiles:
			picked = (entry, {"kind": "checksfinder", "location": tiles[0], "locationName": tile_names[tiles[0]]})
			break
	if picked is None:
		for entry in still_locked:
			holders = [(other, location) for slot, location in spots[entry["u"]] if slot == plex
			           for other in open_after if other is not first and location in ids_of(other)]
			if holders:
				other, location = holders[0]
				picked = (entry, {"kind": "plex", "entry": other, "ids": ids_of(other), "location": location,
				                  "locationName": plex_names[location]})
				break
	if picked is None:
		raise AssertionError(f"seed {SEED} leaves no locked title whose unlock one step can deliver; pick another seed")
	locked, deliver = picked
	return {"plex": plex, "finder": finder, "data": data, "entries": entries, "opening": opening, "first": first,
	        "locked": locked, "unit": units[locked["u"]]["name"], "deliver": deliver}


def plan_for(md, facts, port, state_port, result_file):
	info = md["slot_info"]
	plex, finder = facts["plex"], facts["finder"]
	return {
		"port": port,
		"statePort": state_port,
		"resultFile": result_file,
		"owner": OWNER,
		"seedName": md["seed_name"],
		"generatedAt": facts["data"]["generated_at"],
		"plex": {"slot": plex, "name": info[plex].name, "entries": len(facts["entries"]),
		         "goalCount": facts["data"]["goal_count"]},
		"finder": {"slot": finder, "name": info[finder].name},
		"open": {"entry": facts["first"], "ids": ids_of(facts["first"])},
		"locked": {"entry": facts["locked"], "ids": ids_of(facts["locked"]), "unit": facts["unit"]},
		"deliver": facts["deliver"],
	}


def data_tree():
	"""Every folder and file under the checkout's data/, which nothing in a test run may add to."""
	found = set()
	for folder, dirs, files in os.walk(DATA):
		for name in dirs + files:
			found.add(os.path.relpath(os.path.join(folder, name), DATA))
	return found


def kill_tree(proc):
	# node --test runs the file in a child process of its own, which killing node alone would orphan.
	if os.name == "nt":
		subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
	else:
		proc.kill()


def run_node(plan_path):
	"""(exit code or None on a timeout, output) of the bot's side under node --test."""
	node = shutil.which("node")
	if node is None:
		raise AssertionError("node is not on PATH")
	# Under the test runner a store opens memory-only unless its PLEXBOT_* variable names a file.
	env = {key: value for key, value in os.environ.items() if not key.startswith("PLEXBOT_") and key != "NODE_TEST_CONTEXT"}
	env["PLEXMEDIA_E2E_PLAN"] = plan_path
	proc = subprocess.Popen([node, "--test", "--test-reporter=tap", DRIVER], cwd=REPO, env=env, stdout=subprocess.PIPE,
	                        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
	try:
		output, _ = proc.communicate(timeout=NODE_TIMEOUT)
	except subprocess.TimeoutExpired:
		kill_tree(proc)
		output, _ = proc.communicate()
		return None, f"(killed after {NODE_TIMEOUT} s)\n{output}"
	return proc.returncode, output


class G_EndToEnd(unittest.TestCase):
	"""(g) one seed played end to end by the bot against MultiServer, beside a ChecksFinder player."""

	room = None
	http = None

	@classmethod
	def setUpClass(cls):
		cls.folder = os.path.join(STATE["root"], "g_e2e")
		try:
			cls.play()
		except BaseException:
			cls.tearDownClass()
			raise

	@classmethod
	def play(cls):
		players = os.path.join(cls.folder, "players")
		out = os.path.join(cls.folder, "out")
		os.makedirs(players)
		os.makedirs(out)
		cls.yaml = rendered_yaml(DOC)
		with open(os.path.join(players, "E2E_Plex.yaml"), "wb") as handle:
			handle.write(cls.yaml)
		write_checksfinder(players)
		clock = time.perf_counter()
		low = int(time.time())
		zip_path = cls.zip_path = ap_harness.generate(players, out, SEED, spoiler=1)[1]
		cls.window = (low, int(time.time()) + 1)
		cls.md, _spoiler = ap_harness.read_output(zip_path)
		cls.facts = read_facts(cls.md)
		cls.room = Room(zip_path)
		cls.http = StateServer(cls.room)
		result_file = os.path.join(cls.folder, "result.json")
		cls.plan = plan_for(cls.md, cls.facts, cls.room.port, cls.http.port, result_file)
		plan_path = os.path.join(cls.folder, "plan.json")
		with open(plan_path, "w", encoding="utf-8") as handle:
			json.dump(cls.plan, handle)
		before = data_tree()
		node_clock = time.perf_counter()
		cls.exit_code, cls.output = run_node(plan_path)
		cls.node_seconds = time.perf_counter() - node_clock
		cls.data_added = sorted(data_tree() - before)
		cls.result = None
		if os.path.exists(result_file):
			with open(result_file, encoding="utf-8") as handle:
				cls.result = json.load(handle)
		cls.final = cls.room.settle(lambda state: state["endpoints"] == 0, 10)
		room = cls.room
		cls.room_stopped = cls.close_room()
		cls.resets = room.resets
		cls.seconds = time.perf_counter() - clock

	@classmethod
	def close_room(cls):
		"""Stops the state endpoint, then the room, each once; whether the room's thread ended."""
		stopped = True
		if cls.http is not None:
			cls.http.stop()
			cls.http = None
		if cls.room is not None:
			clock = time.perf_counter()
			stopped = cls.room.stop()
			cls.stop_seconds = time.perf_counter() - clock
			cls.room = None
		return stopped

	@classmethod
	def tearDownClass(cls):
		cls.close_room()
		shutil.rmtree(cls.folder, ignore_errors=True)

	def expected_checks(self):
		plan = self.plan
		ids = set(plan["open"]["ids"]) | set(plan["locked"]["ids"])
		if plan["deliver"]["kind"] == "plex":
			ids |= set(plan["deliver"]["ids"])
		return ids

	def test_the_rendered_list_opens_one_title_and_needs_two(self):
		data = self.facts["data"]
		self.assertIn(b"; goal: finish 2 of 3\n", self.yaml)
		self.assertEqual([entry["id"] for entry in data["entries"]], [entry["id"] for entry in DOC["entries"]])
		self.assertEqual([entry["id"] for entry in self.facts["opening"]], [OPEN_FILM["id"]])
		self.assertEqual((data["entry_count"], data["goal_count"], data["timesanity_strict"]), (3, 2, False))
		self.assertEqual([[minute for minute, _id in entry["cp"]] for entry in data["entries"]], [[15, 30], [15, 30], [10]])
		low, high = self.window
		self.assertTrue(low <= data["generated_at"] <= high, data["generated_at"])
		locked = self.facts["locked"]
		start = {unit["id"]: unit["start"] for unit in data["units"]}
		self.assertEqual((start[locked["u"]], locked["s"]), (0, 1), "the title the test banks starts locked")

	def test_the_bot_side_passes_every_step(self):
		tail = self.output[-6000:]
		self.assertEqual(self.exit_code, 0, f"node --test {os.path.basename(DRIVER)} failed:\n{tail}")
		self.assertIsNotNone(self.result, f"the node test did not run to its end (was it skipped?):\n{tail}")
		self.assertTrue(self.result["ok"])
		deliver = self.plan["deliver"]
		how = (f"{self.plan['finder']['name']} checking {deliver['locationName']}" if deliver["kind"] == "checksfinder"
		       else f"the bot watching {label(deliver['entry'])}, which held its unlock")
		resets = f" after {self.resets} connection reset(s)" if self.resets else ""
		sys.stderr.write(f"\n(g) {label(self.plan['locked']['entry'])} banked, then released by {how}; goal reached; "
		                 f"{self.result['relayed']} relay posts; node {self.node_seconds:.1f} s, room stopped in "
		                 f"{self.stop_seconds:.1f} s{resets}, scenario {self.seconds:.1f} s\n")

	def test_the_room_holds_exactly_the_earned_checks_and_the_goal(self):
		plex, finder = str(self.facts["plex"]), str(self.facts["finder"])
		self.assertEqual(set(self.final["checked"][plex]), self.expected_checks())
		self.assertEqual(self.final["status"][plex], CLIENT_GOAL)
		deliver = self.plan["deliver"]
		self.assertEqual(self.final["checked"][finder], [deliver["location"]] if deliver["kind"] == "checksfinder" else [])
		if self.result is not None:
			self.assertEqual(set(self.result["sent"]), self.expected_checks(), "the bot sent exactly what the room holds")

	def test_every_client_left_the_room_stopped_and_nothing_landed_in_data(self):
		self.assertEqual(self.final["endpoints"], 0)
		self.assertEqual({slot: clients for slot, clients in self.final["clients"].items() if clients}, {})
		self.assertTrue(self.room_stopped, f"the room's thread was still running {self.stop_seconds:.1f} s after Room.stop()")
		self.assertEqual(self.data_added, [], "the run wrote into the checkout's data/ folder")

	def test_a_reset_that_strands_a_connection_cannot_hold_the_room_open(self):
		# Forces what a few runs hit by chance: the room's side of a closing connection raises WinError
		# 10054 from shutdown(), as after a peer's reset, so the Proactor never detaches its transport.
		room = Room(self.zip_path, close_seconds=0.5)
		real_shutdown = socket.socket.shutdown

		def reset(sock, how):
			try:
				port = sock.getsockname()[1]
			except OSError:
				port = None
			if port == room.port:
				raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")
			return real_shutdown(sock, how)

		try:
			with mock.patch.object(socket.socket, "shutdown", reset):
				socket.create_connection(("127.0.0.1", room.port), timeout=5).close()
				deadline = time.monotonic() + 5
				while not room.resets and time.monotonic() < deadline:
					time.sleep(0.02)
		finally:
			clock = time.perf_counter()
			stopped = room.stop(10)
			seconds = time.perf_counter() - clock
		self.assertEqual(room.resets, 1, "the forced reset reached the room's loop, which absorbed it")
		self.assertTrue(stopped, f"the room's thread was still running {seconds:.1f} s after Room.stop()")

	def test_its_test_generate_helpers_are_the_copy_run_py_prepared(self):
		# run.py loads test_generate.py under another name; a second copy's STATE was never prepared.
		self.assertEqual(sys.modules[plain.__module__].STATE["root"], STATE["root"])


def run(only=None, verbosity=2):
	"""only: scenario class names to run (all when empty)."""
	module = sys.modules[__name__]
	if only:
		suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(getattr(module, name))
		                           for name in only)
	else:
		suite = unittest.defaultTestLoader.loadTestsFromModule(module)
	return unittest.TextTestRunner(verbosity=verbosity, stream=sys.stderr).run(suite).wasSuccessful()
