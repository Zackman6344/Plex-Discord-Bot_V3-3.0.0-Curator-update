# apworld/tests/purelib.py
# Loads the apworld's AP-free modules (entries, plan, registry, naming, slotdata, ...) without AP.
#
# Importing plex_media.plan the normal way runs plex_media/__init__.py, which imports BaseClasses
# from the AP install. A stub package with __path__ pointing at the sources lets the submodules'
# relative imports resolve while __init__.py never runs.

import importlib
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(REPO, "apworld", "plex_media")
PURE = ("constants", "naming", "entries", "plan", "registry", "rules", "slotdata", "datapackage")


def load():
	existing = sys.modules.get("plex_media")
	if existing is None or getattr(existing, "__path__", None) != [SRC]:
		for name in [name for name in sys.modules if name == "plex_media" or name.startswith("plex_media.")]:
			del sys.modules[name]
		stub = types.ModuleType("plex_media")
		stub.__path__ = [SRC]
		sys.modules["plex_media"] = stub
	return types.SimpleNamespace(**{name: importlib.import_module(f"plex_media.{name}") for name in PURE})
