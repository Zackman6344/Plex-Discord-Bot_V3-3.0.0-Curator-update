# apworld/tests/run.py
# Runs the apworld's tests: test_pure.py always, then test_generate.py, test_e2e.py and
# test_creator.py against the frozen Archipelago.
#
# npm run test:apworld runs py -3.13 -O -s -S -B apworld/tests/run.py, the flags the frozen build and
# the !ap next worker run with: -O because the install was compiled with optimize=1 (an assert that
# fires here but was stripped there would change what generates), -s -S so nothing installed into
# this Python shadows what library.zip ships, -B so nothing is compiled into apworld/plex_media.
# The Archipelago part is skipped, with a message, when C:\ProgramData\Archipelago is missing, and
# refused without those flags. It builds dist/plex_media.apworld with node first and loads that file.
#
#   --update-golden  rewrite the golden files instead of comparing with them
#   --pure           run test_pure.py only
#   --only A,G       run only those scenario classes of test_generate.py, test_e2e.py and
#                    test_creator.py (by name prefix; G is the end-to-end run against MultiServer,
#                    H the list settings and the Options Creator's files)
#
# Exit status 0 when everything that ran passed, 1 otherwise.

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
APWORLD = os.path.join(REPO, "dist", "plex_media.apworld")
AP_DIR = r"C:\ProgramData\Archipelago"
FLAGS = "py -3.13 -O -s -S -B apworld/tests/run.py"


def say(text):
	sys.stderr.write(text + "\n")
	sys.stderr.flush()


def run_pure():
	sys.path.insert(0, HERE)
	import test_pure

	suite = unittest.defaultTestLoader.loadTestsFromModule(test_pure)
	return unittest.TextTestRunner(verbosity=1, stream=sys.stderr).run(suite).wasSuccessful()


def build():
	node = shutil.which("node")
	if node is None:
		say("node is not on PATH, so dist/plex_media.apworld cannot be built.")
		return False
	proc = subprocess.run([node, os.path.join("scripts", "build-apworld.js")], cwd=REPO, capture_output=True,
	                      text=True, encoding="utf-8", errors="replace")
	say((proc.stdout + proc.stderr).strip())
	return proc.returncode == 0


def load(name, file_name):
	spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file_name))
	module = importlib.util.module_from_spec(spec)
	sys.modules[name] = module
	spec.loader.exec_module(module)
	return module


def scenarios(module, only):
	return sorted(attr for attr in dir(module) if isinstance(getattr(module, attr), type)
	              and issubclass(getattr(module, attr), unittest.TestCase)
	              and any(attr.startswith(prefix + "_") for prefix in only))


def run_generate(update_golden, only):
	# All load before prepare(): its bootstrap takes this folder off sys.path, and test_e2e and
	# test_creator import test_generate's helpers from it.
	generate = load("plex_media_test_generate", "test_generate.py")
	# Under its import name too, so that import finds this copy, the one prepare() sets up, and does
	# not load a second one whose STATE nobody prepares.
	sys.modules["test_generate"] = generate
	e2e = load("plex_media_test_e2e", "test_e2e.py")
	creator = load("plex_media_test_creator", "test_creator.py")
	picked = [(module, scenarios(module, only)) for module in (generate, e2e, creator)]
	if only and not any(classes for _module, classes in picked):
		say(f"No scenario matches {', '.join(only)}.")
		return False
	root = tempfile.mkdtemp(prefix="plexmedia-aptest-")
	try:
		generate.prepare(root, APWORLD, update_golden)
		e2e.prepare(root)
		creator.prepare(root, update_golden)
		ok = True
		for module, classes in picked:
			# An empty list runs the whole module, so a module --only picked nothing from is skipped.
			if classes or not only:
				ok = module.run(classes) and ok
		return ok
	finally:
		shutil.rmtree(root, ignore_errors=True)
		if os.path.exists(root):
			say(f"Could not remove {root}; delete it by hand (Archipelago outputs embed host.yaml's server options).")


def main(argv):
	# Titles carry emoji and CJK, and a Windows console's code page cannot print them.
	for stream in (sys.stdout, sys.stderr):
		stream.reconfigure(encoding="utf-8", errors="backslashreplace")
	update_golden = "--update-golden" in argv
	only = []
	if "--only" in argv and argv.index("--only") + 1 < len(argv):
		only = [name.strip() for name in argv[argv.index("--only") + 1].split(",") if name.strip()]
	ok = run_pure()
	if "--pure" in argv:
		return 0 if ok else 1
	if not os.path.isdir(AP_DIR):
		say(f"Skipping the Archipelago part: {AP_DIR} is not here.")
		return 0 if ok else 1
	if sys.flags.optimize != 1 or not sys.flags.no_site or not sys.flags.no_user_site or not sys.dont_write_bytecode:
		say(f"Refusing the Archipelago part: run it as {FLAGS} (the flags the frozen build uses).")
		return 1
	if not build():
		return 1
	ok = run_generate(update_golden, only) and ok
	say("All apworld tests passed." if ok else "Some apworld tests failed.")
	return 0 if ok else 1


if __name__ == "__main__":
	sys.exit(main(sys.argv[1:]))
