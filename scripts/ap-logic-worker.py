"""Answer "which of this slot's unchecked locations are in logic?" with the seed's own rules.

Why this exists
---------------
`!ap next` used to guess from sphere numbers: a slot that had checked something in sphere N was
taken to reach everything at or below N. Spheres describe the whole multiworld, not one player,
so that listed thousands of locations whose items had not arrived yet. The only real answer is the
one Archipelago itself gives: evaluate each location's access rule against the items the slot has
received. Universal Tracker does that for one player at a time; this does it for every slot of a
seed generated on this machine, from the same Archipelago install that generated it.

How
---
1. Import the frozen Archipelago install as a library. It is a cx_Freeze build, so its compiled
   modules only load into the same Python minor version it was built with (3.13 for 0.6.7), and
   only once a few things cx_Freeze's own startup does are repeated here (see bootstrap()).
2. Re-roll the Players yamls with the seed's real number and run generation unchanged up to the
   fill. Everything that decides logic (options, regions, rules, entrances, events, locked items)
   is settled by then; the fill only places items, and it is the nine minutes of the run. The
   multidata has only the seed NAME, which is derived from the number. The number is on the first
   line of the spoiler inside the same output zip, and in the Generate log, which Archipelago
   deletes after a week.
3. Check the rebuild against the seed's multidata before trusting it: every slot's location ids,
   then generation's own spheres replayed through the same evaluation queries use. A slot that
   disagrees anywhere is answered with sphere 1 only, which needs nothing by definition.
4. Answer queries until stdin closes.

Nothing is written into the Archipelago install. An audit hook refuses any attempt, and host.yaml's
save-on-exit, ROM file dialogs and pip auto-updates are all switched off first.

Protocol
--------
JSON lines. Requests arrive on stdin; replies and events leave on the ORIGINAL stdout. Worlds print
freely while they import, so file descriptor 1 is pointed at stderr before anything is imported and
the protocol keeps a duplicate of the real one to itself.

  event    {"event": "progress", "stage": "importing"|"building"|"checking"}
  event    {"event": "ready", "seedName": str, "slots": {slot: {"verified": bool, "reason"?: str}}, ...}
  event    {"event": "fatal", "error": str}                        (then exit 1)
  request  {"id": n, "op": "inLogic", "slots": [{"slot": int, "received": [[item, location, flags], ...],
                                                 "checked": [location, ...]}, ...]}
  reply    {"id": n, "ok": true, "results": [{"slot": int, "verified": bool, "locations":
            [[location, sphere|null], ...], "open": int, "reason"?: str} | {"slot": int, "error": str}]}
  request  {"id": n, "op": "ping"}  ->  {"id": n, "ok": true}

`received` is the tracker's NetworkItems for the slot, less the finder. `locations` is every
unchecked location in logic when `verified`, and the unchecked sphere 1 locations when not. `open`
counts every unchecked location either way.

Usage
-----
    <python 3.13> -O -s -S -B scripts/ap-logic-worker.py --ap-dir C:\\ProgramData\\Archipelago \\
        --seed-name <seed name> --multidata <AP_<seed name>.zip> [--seed <seed number>]

--seed is only needed when the output zip carries no spoiler to read the number from.

-O because the frozen build compiled everything with optimize=1, and an assert that fires here but
was stripped there would make the rebuild differ. -s -S so nothing installed into this Python can
shadow what library.zip ships. -B so nothing is compiled into the install's folders.
"""

import argparse
import json
import os
import sys
import time

T0 = time.perf_counter()

# The protocol's own copy of stdout, taken before anything can print into it.
_PROTOCOL = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(message):
    _PROTOCOL.write(json.dumps(message, separators=(",", ":")) + "\n")
    _PROTOCOL.flush()


def elapsed_ms():
    return int((time.perf_counter() - T0) * 1000)


def fatal(error):
    send({"event": "fatal", "error": str(error)})
    sys.exit(1)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Archipelago logic worker for !ap next")
    parser.add_argument("--ap-dir", required=True)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--seed-name", required=True)
    parser.add_argument("--multidata", required=True)
    return parser.parse_args(argv)


def seed_from_spoiler(path):
    """The seed number off the spoiler's first line ("Archipelago Version 0.6.7  -  Seed: <n>"),
    from inside the output zip. None when the seed was generated without a spoiler."""
    import re
    import zipfile

    if not path.lower().endswith(".zip"):
        return None
    with zipfile.ZipFile(path) as archive:
        names = [n for n in archive.namelist() if n.endswith("_Spoiler.txt")]
        if not names:
            return None
        with archive.open(names[0]) as handle:
            first = handle.readline(4096).decode("utf-8-sig", "replace")
    match = re.search(r"\bSeed:\s*(\d+)", first)
    return int(match.group(1)) if match else None


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


def read_multidata(path):
    import zipfile
    import zlib
    from Utils import restricted_loads

    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".archipelago")]
            if not names:
                raise ValueError(f"{path} holds no .archipelago file")
            raw = archive.read(names[0])
    else:
        with open(path, "rb") as handle:
            raw = handle.read()
    return restricted_loads(zlib.decompress(raw[1:]))


class StopBeforeFill(Exception):
    def __init__(self, multiworld):
        super().__init__("stopped before fill")
        self.multiworld = multiworld


def rebuild(seed, seed_name, multidata):
    """The seed's MultiWorld with every rule in place and nothing filled.

    Generate.main first and only then anything that imports worlds: options are rolled from the
    global `random` right after it is seeded, and a world that draws from it at import must draw in
    the same place it did in the real run.

    Main.main then runs unchanged, and is stopped where it hands the multiworld to the fill.
    --skip_output only matters for what it skips before that point, the assert_generate stage,
    which is where worlds go looking for ROMs.
    """
    import tempfile
    import Generate

    if "worlds" in sys.modules:
        raise RuntimeError("worlds were imported before the yamls were rolled")
    scratch = tempfile.mkdtemp(prefix="ap-logic-")
    args = Generate.mystery_argparse(["--seed", str(seed), "--skip_output", "--outputpath", scratch])
    erargs, rolled_seed = Generate.main(args)
    if str(erargs.outputname) != str(seed_name):
        raise RuntimeError(f"seed {seed} rolls as {erargs.outputname}, not {seed_name}")
    # The seed name comes from the seed number alone, so it cannot notice a Players folder that
    # moved on to the next async. Players are numbered in filename order, so one yaml added or
    # removed renumbers every slot after it; caught here, before the half-minute build.
    expected = {int(slot): (getattr(info, "name", None), getattr(info, "game", None))
                for slot, info in (multidata.get("slot_info") or {}).items()
                if not getattr(info, "group_members", None)}
    rolled = {int(p): (erargs.name[p], erargs.game[p]) for p in erargs.name}
    if rolled != expected:
        differing = sorted(p for p in set(rolled) | set(expected) if rolled.get(p) != expected.get(p))
        raise RuntimeError(f"the Players folder no longer matches seed {seed_name} "
                           f"({len(differing)} slot(s) differ, first slot {differing[0]})")

    import Main

    def stop(multiworld, *args, **kwargs):
        raise StopBeforeFill(multiworld)

    Main.distribute_items_restrictive = stop
    Main.flood_items = stop
    try:
        Main.main(erargs, rolled_seed)
    except StopBeforeFill as stopped:
        multiworld = stopped.multiworld
    else:
        raise RuntimeError("generation finished without reaching the fill")

    # Stage hooks that run after the fill but read only the item pool and the rules. Super Metroid
    # sets part of its logic state here (onlyBossLeft), and every CollectionState copies it. A
    # stage hook that needs placements fails here, and the self-check catches what that costs.
    for world_type in sorted({type(w) for w in multiworld.worlds.values()}, key=lambda t: t.__name__):
        hook = getattr(world_type, "stage_post_fill", None)
        if hook:
            try:
                hook(multiworld)
            except Exception as err:
                print(f"{world_type.__name__}.stage_post_fill skipped: {err!r}", file=sys.stderr)
    return multiworld


class Logic:
    def __init__(self, multiworld, multidata):
        from BaseClasses import CollectionState, ItemClassification

        self.CollectionState = CollectionState
        self.ItemClassification = ItemClassification
        self.multiworld = multiworld
        self.addressed = {}
        self.events = {}
        for player in multiworld.player_ids:
            locations = multiworld.get_locations(player)
            self.addressed[player] = [l for l in locations if isinstance(l.address, int)]
            self.events[player] = [l for l in locations if l.address is None]

        self.sphere_of = {}
        for index, sphere in enumerate(multidata["spheres"], start=1):
            for player, ids in sphere.items():
                for location in ids:
                    self.sphere_of[(player, location)] = index
        self.last_sphere = len(multidata["spheres"])
        # True, False, or None when the slots could not agree (see self_check).
        self.last_is_unreachable = False
        # The seed's own location ids per slot, which answers that do not come from the rebuild
        # are built from, so a slot the rebuild got wrong is still answered about its real world.
        self.seed_locations = {int(p): set(ids) for p, ids in multidata["locations"].items()}
        self.item_cache = {}
        self.names_by_id = {}
        self.unmade = set()
        self.verified = {}

    def item(self, world, item_id, flags, placed=True):
        """The Item the server's (id, flags) stands for, classified the way the server sent it.

        The server's flags are what generation ended with, which is not always what create_item
        says: surplus copies of a counted item are made useful or filler, and some worlds upgrade
        classifications after the fill. Setting them exactly is what reproduces the seed's spheres.

        Except for an item nobody found: /send, /send_multiple and !getitem hand one out from
        location -1 with flags 0, whatever it is. A key given out that way still opens its door,
        so it keeps what create_item says it is.

        One id can belong to two names (Kingdom Two Crowns gives 755177 to both "Progressive
        Castle Unlock T6" and a junk item), so the flags pick between them.
        """
        key = (world.player, item_id, flags)
        if key in self.item_cache:
            name = self.item_cache[key]
        else:
            by_id = self.names_by_id.get(world.game)
            if by_id is None:
                by_id = self.names_by_id[world.game] = {}
                for item_name, code in world.item_name_to_id.items():
                    by_id.setdefault(code, []).append(item_name)
            names = by_id.get(item_id, [])
            name = names[0] if names else None
            if len(names) > 1:
                wants_progression = bool(flags & 1)
                for candidate in names:
                    try:
                        if world.create_item(candidate).advancement == wants_progression:
                            name = candidate
                            break
                    except Exception:
                        continue
            self.item_cache[key] = name
        if name is None:
            return None
        try:
            made = world.create_item(name)
        except Exception as err:
            if key not in self.unmade:
                self.unmade.add(key)
                print(f"P{world.player} could not create {name!r} ({item_id}): {err!r}", file=sys.stderr)
            return None
        server_flags = self.ItemClassification(flags & 0b111)
        made.classification = server_flags if placed else made.classification | server_flags
        return made

    def reachable(self, player, received, checked=()):
        """Universal Tracker's evaluation (TrackerCore.updateTracker), strict tier only.

        A fresh state every call: some worlds keep logic caches on the state, and a state reused
        across calls would carry one slot's items into the next answer. Start inventory is not in
        `received`; the tracker API leaves it out, and CollectionState collects the multiworld's
        precollected items itself.
        """
        world = self.multiworld.worlds[player]
        state = self.CollectionState(self.multiworld)
        for item_id, location, flags in received:
            made = self.item(world, int(item_id), int(flags), placed=int(location) >= 0)
            if made is not None:
                state.collect(made, True)
        state.sweep_for_advancements(locations=self.events[player])
        done = set(checked)
        return {l.address for l in self.addressed[player] if l.address not in done and l.can_reach(state)}

    def self_check(self, multidata):
        """Replay generation's own spheres through reachable() and demand the same answer.

        Sphere k is exactly what became reachable once every item from the spheres before it was
        collected. So for each slot, with the items it received from spheres before k, reachable()
        has to return precisely its locations in spheres up to k: anything missing means the
        rebuild is stricter than the real seed, anything extra means it is looser, and either way
        that slot is not answered from the rebuild. This runs the exact code path queries use, so
        it also covers the per-slot assumption (a rule reading another slot's items fails here).

        The last multidata sphere is special. When generation left locations unreachable it yields
        an empty sphere and then all of them, and Main.py drops the empty one, so the last entry
        is either a real sphere or that unreachable remainder with nothing to tell them apart. The
        rebuild tells them apart: its locations are reachable with every earlier item, or they are
        not. It is one fact about the whole multiworld, so every slot has to agree on it.
        """
        spheres = multidata["spheres"]
        placements = multidata["locations"]
        members = {}
        for slot, info in (multidata.get("slot_info") or {}).items():
            group = list(getattr(info, "group_members", ()) or ())
            if group:
                members[slot] = group

        received_by = {}
        for index, sphere in enumerate(spheres):
            for finder, ids in sphere.items():
                for location in ids:
                    item_id, receiver, flags = placements[finder][location][:3]
                    for player in members.get(receiver, [receiver]):
                        received_by.setdefault(player, {}).setdefault(index, []).append((item_id, location, flags))

        last = len(spheres) - 1
        verdicts = {}
        for player in self.multiworld.player_ids:
            name = self.multiworld.player_name[player]
            mine = {l.address for l in self.addressed[player]}
            if mine != set(placements.get(player, {})):
                verdicts[player] = ("mismatch", f"location ids differ from the multidata for {name}")
                continue
            received, before, reached = [], set(), set()
            verdict = None
            try:
                for index, sphere in enumerate(spheres):
                    got = self.reachable(player, received)
                    before = set(reached)
                    reached |= set(sphere.get(player, ()))
                    if index < last:
                        if got != reached:
                            verdict = ("mismatch", f"sphere {index + 1}: {len(reached - got)} missing, "
                                                   f"{len(got - reached)} early")
                            break
                    elif got == reached and got != before:
                        verdict = ("real", None)
                    elif got == before and got != reached:
                        verdict = ("unreachable", None)
                    elif got == reached:
                        verdict = ("either", None)
                    else:
                        verdict = ("mismatch", f"final sphere: {len(got ^ reached)} differ")
                    received.extend(received_by.get(player, {}).get(index, []))
            except Exception as err:
                verdict = ("mismatch", f"evaluation failed: {err!r}"[:300])
            verdicts[player] = verdict or ("either", None)

        # Slots that disagree cannot all be right, and nothing says which side is, so every slot
        # with a vote in it is answered from sphere 1 rather than trusting either.
        kinds = {v[0] for v in verdicts.values()}
        conflict = "unreachable" in kinds and "real" in kinds
        self.last_is_unreachable = None if conflict else "unreachable" in kinds
        for player, (kind, reason) in verdicts.items():
            if kind == "mismatch":
                self.verified[player] = (False, reason)
            elif conflict and kind in ("real", "unreachable"):
                self.verified[player] = (False, "the slots disagree about whether the final sphere is reachable")
            else:
                self.verified[player] = (True, None)

    def sphere(self, player, location):
        index = self.sphere_of.get((player, location))
        if index == self.last_sphere and self.last_is_unreachable is True:
            return None
        return index

    def answer(self, query):
        player = int(query["slot"])
        if player not in self.seed_locations:
            return {"slot": player, "error": "not a slot in this multiworld"}
        checked = set(int(c) for c in query.get("checked") or ())
        unchecked = self.seed_locations[player] - checked
        ok, reason = self.verified.get(player, (False, "not checked"))
        if ok:
            try:
                ids = self.reachable(player, query.get("received") or (), checked)
            except Exception as err:
                print(f"P{player} evaluation failed: {err!r}", file=sys.stderr)
                ok, reason = False, f"evaluation failed: {err!r}"[:300]
        if not ok:
            ids = {i for i in unchecked if self.sphere_of.get((player, i)) == 1}
        result = {
            "slot": player,
            "verified": ok,
            "locations": sorted(([i, self.sphere(player, i)] for i in ids), key=lambda p: (p[1] or 1 << 30, p[0])),
            "open": len(unchecked),
        }
        if not ok:
            result["reason"] = reason
        return result


def serve(logic):
    sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            if op == "ping":
                send({"id": request_id, "ok": True})
            elif op == "inLogic":
                results = []
                for query in request.get("slots") or ():
                    try:
                        results.append(logic.answer(query))
                    except Exception as err:
                        results.append({"slot": query.get("slot"), "error": f"{err!r}"[:300]})
                send({"id": request_id, "ok": True, "results": results})
            else:
                send({"id": request_id, "ok": False, "error": f"unknown op {op!r}"})
        except Exception as err:
            send({"id": request_id, "ok": False, "error": f"{err!r}"[:300]})


def main(argv):
    options = parse_args(argv)
    ap_dir = os.path.abspath(options.ap_dir)

    wanted = frozen_python_minor(ap_dir)
    if wanted is None:
        fatal(f"{ap_dir} does not look like a frozen Archipelago install (no python3XX.dll)")
    if sys.version_info[:2] != wanted:
        fatal(f"this is Python {sys.version_info[0]}.{sys.version_info[1]}; the install was built "
              f"with {wanted[0]}.{wanted[1]} and its modules only load into that version")

    send({"event": "progress", "stage": "importing", "elapsedMs": elapsed_ms()})
    try:
        bootstrap(ap_dir)
        import logging
        logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
        multidata = read_multidata(os.path.abspath(options.multidata))
    except Exception as err:
        fatal(f"could not load Archipelago: {err!r}")
    if str(multidata.get("seed_name")) != str(options.seed_name):
        fatal(f"{options.multidata} is seed {multidata.get('seed_name')}, not {options.seed_name}")
    if multidata.get("race_mode"):
        fatal("this seed was generated in race mode, which cannot be reproduced")

    try:
        seed = seed_from_spoiler(os.path.abspath(options.multidata)) or options.seed
    except Exception as err:
        fatal(f"could not read the spoiler in {options.multidata}: {err!r}")
    if not seed:
        fatal(f"no seed number for {options.seed_name}: the output zip has no spoiler and no Generate log names it")

    send({"event": "progress", "stage": "building", "elapsedMs": elapsed_ms()})
    try:
        multiworld = rebuild(seed, options.seed_name, multidata)
    except Exception as err:
        fatal(f"could not rebuild seed {options.seed_name}: {err!r}")

    send({"event": "progress", "stage": "checking", "elapsedMs": elapsed_ms()})
    logic = Logic(multiworld, multidata)
    logic.self_check(multidata)

    slots = {}
    for player, (ok, reason) in sorted(logic.verified.items()):
        slots[str(player)] = {"verified": ok, **({"reason": reason} if reason else {})}
    send({
        "event": "ready",
        "seedName": options.seed_name,
        "slots": slots,
        "lastSphereUnreachable": logic.last_is_unreachable,
        "elapsedMs": elapsed_ms(),
    })
    serve(logic)


if __name__ == "__main__":
    main(sys.argv[1:])
