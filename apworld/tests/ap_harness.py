# apworld/tests/ap_harness.py
# Loads the owner's frozen Archipelago 0.6.8 into this Python, read-only, with only the worlds a test needs.
#
# frozen_python_minor() and bootstrap() are copies of scripts/ap-logic-worker.py L135-231 (keep them in
# step): the install is a cx_Freeze build, so its modules load only into Python 3.13 run with
# -O -s -S -B, and only once its startup steps are repeated; an audit hook refuses every write inside
# the install. load() then points Utils.user_path at a temp root: its worlds/ folder stands in for
# custom_worlds, so the built plex_media.apworld goes through the real loader (zip and manifest), and
# a default host.yaml is created there, so no output carries the owner's server options.
# AP_TEST_WORLDS, honoured once unittest is imported, keeps the other 80 custom worlds out.
#
# bootstrap() rewrites sys.argv and drops its own folder from sys.path: read arguments and import
# sibling modules before calling it.

import io
import os
import shutil
import sys
import zipfile
import zlib

AP_DIR = r"C:\ProgramData\Archipelago"


def frozen_python_minor(ap_dir):
	"""The Python the install was frozen with, read off the python3XX.dll cx_Freeze ships beside it."""
	for name in os.listdir(ap_dir):
		lower = name.lower()
		if lower.startswith("python3") and lower.endswith(".dll") and lower[7:-4].isdigit():
			return 3, int(lower[7:-4])
	return None


def bootstrap(ap_dir):
	"""Make this interpreter load the install the way ArchipelagoGenerate.exe does, read-only."""
	lib = os.path.join(ap_dir, "lib")
	ap_norm = os.path.normcase(os.path.abspath(ap_dir))

	# ModuleUpdate.update() runs at import and pip-installs anything it thinks is missing, into
	# this Python, unless the process looks frozen or this is set.
	os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"
	sys.frozen = True
	# Utils.local_path is the folder of argv[0] in a frozen process.
	sys.argv = [os.path.join(ap_dir, "ArchipelagoGenerate.exe")]
	sys.dont_write_bytecode = True
	# The script's own folder must not shadow anything the install provides.
	here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
	sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.abspath(p or ".")) != here]
	sys.path += [os.path.join(lib, "library.zip"), lib]

	from importlib.machinery import EXTENSION_SUFFIXES, ExtensionFileLoader, ModuleSpec

	class CxFreezeExtensionFinder:
		"""cx_Freeze keeps a zipped package's extension modules flat in lib, as
		lib/bsdiff4.core.cp313-win_amd64.pyd, and its startup script adds this finder for them.
		Without it every world that imports one fails to load."""

		@classmethod
		def find_spec(cls, fullname, path=None, target=None):
			if path is None:
				return None
			for suffix in EXTENSION_SUFFIXES:
				location = os.path.join(lib, fullname + suffix)
				if os.path.isfile(location):
					return ModuleSpec(fullname, ExtensionFileLoader(fullname, location), origin=location)
			return None

	sys.meta_path.append(CxFreezeExtensionFinder)
	os.add_dll_directory(lib)

	writing_events = {"os.mkdir", "os.rename", "os.replace", "os.remove", "os.rmdir", "os.truncate",
	                  "shutil.rmtree", "shutil.move", "shutil.copyfile", "os.symlink", "os.link",
	                  "os.chmod", "os.utime"}
	target_is_second = {"shutil.copyfile", "os.symlink", "os.link"}
	# A move changes the folder it leaves as much as the one it lands in.
	both_ends = {"os.rename", "os.replace", "shutil.move"}

	def inside_install(target):
		try:
			return os.path.normcase(os.path.abspath(os.fsdecode(target))).startswith(ap_norm)
		except Exception:
			return False

	def refuse_writes(event, args):
		if event == "open":
			target, mode, flags = args
			if target is None or isinstance(target, int):
				return
			writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
				mode is None and isinstance(flags, int)
				and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
			if writes and inside_install(target):
				raise PermissionError(f"refusing to write {target} inside the Archipelago install")
		elif event in writing_events:
			if event in both_ends:
				targets = args[:2]
			else:
				targets = [args[1] if event in target_is_second else args[0]]
			# makedirs(exist_ok=True) on a folder that is already there changes nothing.
			if event == "os.mkdir" and os.path.isdir(os.fsdecode(targets[0])):
				return
			for target in targets:
				if inside_install(target):
					raise PermissionError(f"refusing {event} on {target} inside the Archipelago install")

	sys.addaudithook(refuse_writes)
	os.chdir(ap_dir)

	import logging
	import Utils
	import settings

	Utils.local_path.cached_path = ap_dir
	Utils.user_path.cached_path = ap_dir
	# A world asking for a missing ROM opens a file dialog and waits for somebody to click it.
	Utils.messagebox = lambda title, text, error=False: logging.error("%s: %s", title, text)
	Utils.open_filename = lambda *args, **kwargs: None
	Utils.open_directory = lambda *args, **kwargs: None
	settings.skip_autosave = True
	settings.no_gui = True


def point_at(root, test_worlds):
	"""After bootstrap(): user files under root and only test_worlds loading. Imports nothing from worlds."""
	import unittest  # noqa: F401  (worlds honours AP_TEST_WORLDS only under a test runner)
	import Utils
	import settings

	os.environ["AP_TEST_WORLDS"] = ",".join(test_worlds)
	Utils.user_path.cached_path = root
	settings.skip_autosave = True
	os.makedirs(os.path.join(root, "worlds"), exist_ok=True)
	# get_settings() would save a missing host.yaml, and saving imports every world (Settings.dump),
	# before the apworld is in place and before the !ap next worker may import them.
	host = os.path.join(root, "host.yaml")
	if not os.path.exists(host):
		with open(host, "w", encoding="utf-8") as handle:
			handle.write("# Archipelago's defaults, written by apworld/tests/ap_harness.py.\n")
	settings.get_settings()


def load(root, apworld, test_worlds=("plex_media", "checksfinder")):
	"""Bootstrap the install, put the apworld in root/worlds and import worlds."""
	wanted = frozen_python_minor(AP_DIR)
	if wanted is not None and sys.version_info[:2] != wanted:
		raise RuntimeError(f"Archipelago was frozen with Python {wanted[0]}.{wanted[1]}; this is {sys.version_info[0]}."
		                   f"{sys.version_info[1]}")
	bootstrap(AP_DIR)
	point_at(root, test_worlds)
	target = os.path.join(root, "worlds", "plex_media.apworld")
	if os.path.abspath(apworld) != os.path.abspath(target):
		shutil.copyfile(apworld, target)
	import worlds

	return worlds


def generate(players, out, seed, spoiler=3):
	"""Generate.main + Main.main, as ArchipelagoGenerate.exe runs them. Returns (multiworld, output zip)."""
	import Generate
	import Main

	args = Generate.mystery_argparse(["--seed", str(seed), "--player_files_path", players, "--outputpath", out,
	                                  "--spoiler", str(spoiler)])
	args.race = False
	erargs, rolled = Generate.main(args)
	multiworld = Main.main(erargs, rolled)
	zips = [name for name in os.listdir(out) if name.endswith(".zip")]
	if len(zips) != 1:
		raise RuntimeError(f"expected one output zip in {out}, found {zips}")
	return multiworld, os.path.join(out, zips[0])


def read_output(zip_path):
	"""(multidata, spoiler text) from a generation's output zip."""
	from Utils import restricted_loads

	with zipfile.ZipFile(zip_path) as archive:
		names = archive.namelist()
		raw = archive.read(next(name for name in names if name.endswith(".archipelago")))
		spoilers = [name for name in names if name.endswith("_Spoiler.txt")]
		spoiler = archive.read(spoilers[0]).decode("utf-8-sig") if spoilers else ""
	return restricted_loads(zlib.decompress(raw[1:])), spoiler


def seed_digest(md):
	"""What a regeneration of the same YAMLs and seed must reproduce exactly."""
	import hashlib
	import json

	def sha(value):
		return hashlib.sha1(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()

	# An item-link group of the game has a slot of its own but no slot_data.
	plex = sorted(slot for slot, info in md["slot_info"].items()
	              if info.game == "Plex Media" and slot in md["slot_data"])
	return {
		"seed_name": md["seed_name"],
		"locations": sha({str(p): sorted([a, list(v)] for a, v in t.items()) for p, t in md["locations"].items()}),
		"precollected": sha({str(p): list(items) for p, items in md["precollected_items"].items()}),
		"checksum": md["datapackage"]["Plex Media"]["checksum"],
		"slot_data": sha({str(s): {k: v for k, v in md["slot_data"][s].items() if k != "generated_at"} for s in plex}),
	}


def quiet_logging():
	"""Archipelago logs every stage at INFO; keep warnings, and keep the Plex Media ones to read back."""
	import logging

	logging.basicConfig(level=logging.WARNING, stream=sys.stderr, force=True)
	captured = io.StringIO()
	handler = logging.StreamHandler(captured)
	handler.setLevel(logging.WARNING)
	logging.getLogger("Plex Media").addHandler(handler)
	return captured
