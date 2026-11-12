# apworld/tests/ap_child.py
# The child processes test_generate.py starts, each a fresh Python so the worlds load anew.
#
#   regen  <root> <players> <out> <result> <seed>   generate the folder's YAMLs again (test_generate.py
#                                                  sets another PYTHONHASHSEED) and record the digest
#   worker <root> <players> <zip> <result>          rebuild the seed with scripts/ap-logic-worker.py,
#                                                  put generation's placements back and self-check
#   select <root> <players> <zip> <result>          let the worker's select_players pick the seed's
#                                                  yamls out of <players> as if it were the Players
#                                                  folder (!ap next without --players-dir); no rebuild
#
# Run with py -3.13 -O -s -S -B. The answer goes to the <result> JSON file, never stdout: importing
# the worker points file descriptor 1 at stderr.

import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
WORKER = os.path.join(REPO, "scripts", "ap-logic-worker.py")
sys.path.insert(0, HERE)
import ap_harness  # noqa: E402


def write(result, data):
	with open(result, "w", encoding="utf-8") as handle:
		json.dump(data, handle)


def regen(root, players, out, result, seed):
	ap_harness.load(root, os.path.join(root, "worlds", "plex_media.apworld"))
	ap_harness.quiet_logging()
	_multiworld, zip_path = ap_harness.generate(players, out, int(seed), spoiler=1)
	md, _spoiler = ap_harness.read_output(zip_path)
	write(result, {"digest": ap_harness.seed_digest(md), "hashseed": os.environ.get("PYTHONHASHSEED")})
	shutil.rmtree(out, ignore_errors=True)


def load_worker(root):
	spec = importlib.util.spec_from_file_location("ap_logic_worker", WORKER)
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	module.bootstrap(ap_harness.AP_DIR)
	ap_harness.point_at(root, ("plex_media", "checksfinder"))
	# rebuild() and select_players() make scratch folders they never remove; keep them inside the root
	# the parent deletes.
	tempfile.tempdir = os.path.join(root, "tmp")
	os.makedirs(tempfile.tempdir, exist_ok=True)
	import logging

	logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
	return module


def select(root, players, zip_path, result):
	module = load_worker(root)
	import settings

	# select_players takes no folder: it reads the Players folder from host.yaml's generator settings.
	generator = settings.get_settings().generator
	generator.player_files_path = type(generator.player_files_path)(players)
	chosen = module.select_players(module.read_multidata(zip_path))
	write(result, {"kept": sorted(os.listdir(chosen)) if chosen else None})


def worker(root, players, zip_path, result):
	module = load_worker(root)
	multidata = module.read_multidata(zip_path)
	seed = module.seed_from_spoiler(zip_path)
	multiworld = module.rebuild(seed, multidata["seed_name"], multidata, players)
	injected = module.inject_placements(multiworld, multidata)
	logic = module.Logic(multiworld, multidata)
	logic.self_check(multidata)
	answers = logic.answer_all({"slots": [{"slot": p, "checked": []} for p in multiworld.player_ids], "received": {}},
	                           "not checked")
	write(result, {
		"games": {str(p): multiworld.game[p] for p in multiworld.player_ids},
		"verified": {str(p): list(logic.verified.get(p, (False, "not checked"))) for p in multiworld.player_ids},
		"injected": injected,
		"answers": [{"slot": a.get("slot"), "verified": a.get("verified"), "open": a.get("open"),
		             "now": len(a.get("locations") or []), "error": a.get("error")} for a in answers],
	})


def main(argv):
	sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
	mode = argv[0]
	if mode == "regen":
		regen(*argv[1:6])
	elif mode == "worker":
		worker(*argv[1:5])
	elif mode == "select":
		select(*argv[1:5])
	else:
		raise SystemExit(f"unknown mode {mode!r}")


if __name__ == "__main__":
	main(sys.argv[1:])
