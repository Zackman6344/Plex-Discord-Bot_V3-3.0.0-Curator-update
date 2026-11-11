"""Answer "which of this slot's unchecked locations are in logic?" with the seed's own rules.

Why this exists
---------------
`!ap next` used to guess from sphere numbers: a slot that had checked something in sphere N was
taken to reach everything at or below N. Spheres describe the whole multiworld, not one player,
so that listed thousands of locations whose items had not arrived yet. The only real answer is the
one Archipelago itself gives: evaluate each location's access rule against the items received.
Universal Tracker does that for one player at a time; this does it for every slot of a seed
generated on this machine, from the same Archipelago install that generated it.

How
---
1. Import the frozen Archipelago install as a library. It is a cx_Freeze build, so its compiled
   modules only load into the same Python minor version it was built with (3.13 for 0.6.x), and
   only once a few things cx_Freeze's own startup does are repeated here (see bootstrap()).
2. Re-roll the seed's yamls with its real number and run generation unchanged up to the fill.
   Everything that decides logic (options, regions, rules, entrances, events, locked items) is
   settled by then; the fill only places items, and it is the nine minutes of the run. The
   multidata has only the seed NAME, which is derived from the number. The number is on the first
   line of the spoiler inside the same output zip, and in the Generate log, which Archipelago
   deletes after a week. The yamls come from --players-dir, the bot's own copy of the ones the
   Generate log names, because the Players folder moves on to the next async.
3. Put generation's real items back into the rebuilt locations. Some rules read what a location
   holds: Dungeon Defenders wraps every location in the multiworld so that one holding a hero's
   action is only in logic once that hero has been received (hero_logic.install_hero_order_rule).
4. Check the rebuild against the multidata before trusting it, by replaying generation's own
   spheres: one state holding every slot's items, as the sphere search held them, must make
   exactly each sphere's locations reachable in turn. A slot that disagrees anywhere is answered
   with sphere 1 only, which needs nothing by definition. So is every slot when the rebuild cannot
   be made at all; the multidata alone still says what sphere 1 is.
5. Answer queries until stdin closes, each against one state built from every slot's received
   items. A rule reading another slot's items (the Dungeon Defenders one above) is then answered
   the way generation answered it, which a state holding one slot's items cannot do.

Nothing is written into the Archipelago install. An audit hook refuses any attempt, and host.yaml's
save-on-exit, ROM file dialogs and pip auto-updates are all switched off first.

Protocol
--------
JSON lines. Requests arrive on stdin; replies and events leave on the ORIGINAL stdout. Worlds print
freely while they import, so file descriptor 1 is pointed at stderr before anything is imported and
the protocol keeps a duplicate of the real one to itself.

  event    {"event": "progress", "stage": "importing"|"building"|"checking"}
  event    {"event": "ready", "seedName": str, "slots": {slot: {"verified": bool, "reason"?: str}},
            "rebuildError": str|null, "injected": {...}|null, ...}
  event    {"event": "fatal", "error": str}                        (then exit 1)
  request  {"id": n, "op": "inLogic", "received": {slot: [[item, location, flags], ...]},
            "slots": [{"slot": int, "checked": [location, ...]}, ...]}
  reply    {"id": n, "ok": true, "results": [{"slot": int, "verified": bool, "locations":
            [[location, sphere|null, name|null], ...], "open": int, "reason"?: str}
            | {"slot": int, "error": str}]}
  request  {"id": n, "op": "ping"}  ->  {"id": n, "ok": true}

`received` holds every slot's NetworkItems from the room tracker, less the finder, whichever slots
are asked about. `locations` is every unchecked location in logic when `verified`, and the
unchecked sphere 1 locations when not. `open` counts every unchecked location either way. Names
come from the data package inside the multidata.

Usage
-----
    <python 3.13> -O -s -S -B scripts/ap-logic-worker.py --ap-dir C:\\ProgramData\\Archipelago \\
        --seed-name <seed name> --multidata <AP_<seed name>.zip> [--seed <seed number>] \\
        [--players-dir <folder of the seed's yamls>] [--plando <the run's plando options>]

--seed is only needed when the output zip carries no spoiler to read the number from. Without
--players-dir the install's own Players folder is rolled, less any yaml whose players are not the
seed's (select_players). --plando is the run's own setting from its Generate log, since host.yaml's
may have changed since.

-O because the frozen build compiled everything with optimize=1, and an assert that fires here but
was stripped there would make the rebuild differ. -s -S so nothing installed into this Python can
shadow what library.zip ships. -B so nothing is compiled into the install's folders.
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict

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
    parser.add_argument("--players-dir", default=None)
    parser.add_argument("--plando", default=None)
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


def select_players(multidata):
    """The Players folder's yamls whose players are this seed's, copied to a folder of their own, or
    None when the folder holds nothing else or cannot be read.

    For a seed the bot never copied while its Generate log still named the files: the folder has
    usually moved on to the next async, and one yaml too many renumbers every slot after it. A file
    is the seed's when every player it holds is named like one of the seed's slots. A name with
    {player} or {number} in it is matched as a pattern, and one that is not a plain string (weighted)
    cannot be told apart, so its file is kept. Runs before anything is rolled, so the global random
    stream is untouched; the rolled names and games are still checked against the seed afterwards.
    """
    import re
    import shutil
    import tempfile
    import Generate
    import settings

    folder = str(settings.get_settings().generator.player_files_path)
    names = {getattr(info, "name", None) for info in (multidata.get("slot_info") or {}).values()
             if not getattr(info, "group_members", None)}

    def matches(name):
        if not isinstance(name, str):
            return True
        if "{" in name:
            pattern = re.escape(name)
            for key in ("player", "PLAYER", "number", "NUMBER"):
                pattern = pattern.replace(re.escape("{" + key + "}"), r"\d*")
            return any(isinstance(n, str) and re.fullmatch(pattern, n) for n in names)
        return name in names

    keep, extra = [], False
    for entry in sorted(os.scandir(folder), key=lambda e: e.name.casefold()):
        if not entry.is_file() or entry.name.startswith(".") or entry.name.lower().endswith(".ini"):
            continue
        try:
            documents = [d for d in Generate.read_weights_yamls(entry.path) if d]
        except Exception:
            keep.append(entry.path)
            continue
        if all(matches(d.get("name") if isinstance(d, dict) else None) for d in documents):
            keep.append(entry.path)
        else:
            extra = True
    if not extra:
        return None
    chosen = tempfile.mkdtemp(prefix="ap-players-")
    for path in keep:
        shutil.copy2(path, chosen)
    print(f"rolling {len(keep)} of the Players folder's yamls, the ones whose players are seed slots", file=sys.stderr)
    return chosen


def rebuild(seed, seed_name, multidata, players_dir=None, plando=None):
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
    argv = ["--seed", str(seed), "--skip_output", "--outputpath", scratch]
    if players_dir:
        argv += ["--player_files_path", players_dir]
    if plando is not None:
        argv += ["--plando", plando]
    args = Generate.mystery_argparse(argv)
    # The run's own settings rather than today's host.yaml: main() has refused a race seed already,
    # and a race flag set since for another async would reseed the roll from the clock.
    args.race = False
    erargs, rolled_seed = Generate.main(args)
    if str(erargs.outputname) != str(seed_name):
        raise RuntimeError(f"seed {seed} rolls as {erargs.outputname}, not {seed_name}")
    # The seed name comes from the seed number alone, so it cannot notice a yaml folder that moved
    # on to the next async. Players are numbered in filename order, so one yaml added or removed
    # renumbers every slot after it; caught here, before the half-minute build.
    expected = {int(slot): (getattr(info, "name", None), getattr(info, "game", None))
                for slot, info in (multidata.get("slot_info") or {}).items()
                if not getattr(info, "group_members", None)}
    rolled = {int(p): (erargs.name[p], erargs.game[p]) for p in erargs.name}
    if rolled != expected:
        differing = sorted(p for p in set(rolled) | set(expected) if rolled.get(p) != expected.get(p))
        raise RuntimeError(f"the yamls no longer match seed {seed_name} "
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


def inject_placements(multiworld, multidata):
    """Put generation's real items into the rebuilt, unfilled locations.

    The pool's own Items go back where the multidata says they went, matched by receiver, code
    and flags the way the fill handed them out, so a rule that looks at what a location holds sees
    what it saw during generation. An item the pool cannot supply is made fresh.
    """
    from BaseClasses import ItemClassification

    by_flags, by_code = defaultdict(list), defaultdict(list)
    for item in multiworld.itempool:
        code = item.code if isinstance(item.code, int) else \
            multiworld.worlds[item.player].item_name_to_id.get(item.name)
        by_flags[(item.player, code, item.flags)].append(item)
        by_code[(item.player, code)].append(item)

    def take(spares):
        while spares:
            item = spares.pop()
            if item.location is None:
                return item
        return None

    by_address = {(l.player, l.address): l for l in multiworld.get_locations() if isinstance(l.address, int)}
    counts = {"placed": 0, "made": 0, "missing": 0}
    for player, table in multidata["locations"].items():
        for address, entry in table.items():
            location = by_address.get((player, address))
            if location is None or location.item is not None:
                continue
            code, receiver, flags = entry[:3]
            item = take(by_flags.get((receiver, code, flags), [])) or take(by_code.get((receiver, code), []))
            if item is None:
                world = multiworld.worlds.get(receiver)
                try:
                    item = world.create_item(world.item_id_to_name[code])
                    counts["made"] += 1
                except Exception:
                    counts["missing"] += 1
                    continue
            # Upgrades a world makes after the fill (Stardew's) reach the multidata as flags.
            if flags & 1 and not item.advancement:
                item.classification |= ItemClassification.progression
            location.item = item
            item.location = location
            counts["placed"] += 1
    return counts


class Logic:
    """What the rebuild says is in logic, or, with no rebuild, what the multidata alone says."""

    def __init__(self, multiworld, multidata):
        self.multiworld = multiworld
        self.addressed = {}
        self.events = []
        if multiworld is not None:
            from BaseClasses import CollectionState, ItemClassification

            self.CollectionState = CollectionState
            self.ItemClassification = ItemClassification
            for player in multiworld.player_ids:
                self.addressed[player] = [l for l in multiworld.get_locations(player) if isinstance(l.address, int)]
            # Every slot's events, not only the asked slot's: a rule may wait on another slot's.
            self.events = [l for l in multiworld.get_locations() if l.address is None]

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
        self.members = {}
        self.games = {}
        for slot, info in (multidata.get("slot_info") or {}).items():
            group = list(getattr(info, "group_members", ()) or ())
            if group:
                self.members[int(slot)] = group
            self.games[int(slot)] = getattr(info, "game", None)
        self.datapackage = multidata.get("datapackage") or {}
        self.name_tables = {}
        self.item_cache = {}
        self.names_by_id = {}
        self.unmade = set()
        self.verified = {}

    def location_names(self, player):
        game = self.games.get(player)
        if game not in self.name_tables:
            table = (self.datapackage.get(game) or {}).get("location_name_to_id") or {}
            self.name_tables[game] = {code: name for name, code in table.items()}
        return self.name_tables[game]

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

    def state_for(self, received):
        """One state holding every slot's received items, the way generation's sphere search held
        every player's items at once. Start inventory is not among them, since the tracker API
        leaves it out; CollectionState collects the multiworld's precollected items itself.

        `received` is keyed by slot, as JSON gives it. An item addressed to an item-link group is
        already in each member's list on the tracker, so nothing is expanded here.
        """
        state = self.CollectionState(self.multiworld)
        for player, items in (received or {}).items():
            world = self.multiworld.worlds.get(int(player))
            if world is None:
                continue
            for item_id, location, flags in items:
                made = self.item(world, int(item_id), int(flags), placed=int(location) >= 0)
                if made is not None:
                    state.collect(made, True)
        # Events only: every addressed location now holds its real item, and sweeping those would
        # hand out everything reachable as if it had been checked.
        state.sweep_for_advancements(locations=self.events)
        return state

    def self_check(self, multidata):
        """Replay generation's own spheres and demand exactly the same answer, slot by slot.

        Sphere k is what became reachable once every item from the spheres before it was
        collected, every slot's at once. So one state is built up sphere by sphere from the
        multidata's placements, through the same item and evaluation code queries use, and each
        slot's newly reachable locations must be exactly its locations in that sphere: anything
        missing means the rebuild is stricter than the real seed, anything extra that it is looser,
        and either way that slot is not answered from the rebuild.

        The last multidata sphere is special. When generation left locations unreachable it yields
        an empty sphere and then all of them, and Main.py drops the empty one, so the last entry
        is either a real sphere or that unreachable remainder with nothing to tell them apart. The
        rebuild tells them apart: its locations are reachable with every earlier item, or they are
        not. It is one fact about the whole multiworld, so every slot has to agree on it.
        """
        spheres = multidata["spheres"]
        placements = multidata["locations"]
        last = len(spheres) - 1
        verdicts = {}
        pending = {}
        for player in self.multiworld.player_ids:
            mine = {l.address: l for l in self.addressed[player]}
            if set(mine) != set(placements.get(player, {})):
                name = self.multiworld.player_name[player]
                verdicts[player] = ("mismatch", f"location ids differ from the multidata for {name}")
            else:
                pending[player] = mine

        try:
            state = self.state_for({})
            for index, sphere in enumerate(spheres):
                for player, open_here in pending.items():
                    if player in verdicts:
                        continue
                    try:
                        newly = {a for a, l in open_here.items() if l.can_reach(state)}
                    except Exception as err:
                        verdicts[player] = ("mismatch", f"evaluation failed: {err!r}"[:300])
                        continue
                    want = set(sphere.get(player, ()))
                    if index < last:
                        if newly != want:
                            verdicts[player] = ("mismatch", f"sphere {index + 1}: {len(want - newly)} missing, "
                                                            f"{len(newly - want)} early")
                            continue
                    elif want and newly == want:
                        verdicts[player] = ("real", None)
                    elif want and not newly:
                        verdicts[player] = ("unreachable", None)
                    elif newly != want:
                        verdicts[player] = ("mismatch", f"final sphere: {len(newly ^ want)} differ")
                    for address in newly:
                        del open_here[address]
                for finder, ids in sphere.items():
                    for location in ids:
                        item_id, receiver, flags = placements[finder][location][:3]
                        for player in self.members.get(receiver, [receiver]):
                            world = self.multiworld.worlds.get(player)
                            made = self.item(world, item_id, flags) if world is not None else None
                            if made is not None:
                                state.collect(made, True)
                state.sweep_for_advancements(locations=self.events)
        except Exception as err:
            reason = f"the replay failed: {err!r}"[:300]
            for player in self.multiworld.player_ids:
                verdicts.setdefault(player, ("mismatch", reason))

        # Slots that disagree cannot all be right, and nothing says which side is, so every slot
        # with a vote in it is answered from sphere 1 rather than trusting either.
        kinds = {v[0] for v in verdicts.values()}
        conflict = "unreachable" in kinds and "real" in kinds
        self.last_is_unreachable = None if conflict else "unreachable" in kinds
        for player in self.multiworld.player_ids:
            kind, reason = verdicts.get(player, ("either", None))
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

    def answer(self, query, state, fallback_reason):
        player = int(query["slot"])
        if player not in self.seed_locations:
            return {"slot": player, "error": "not a slot in this multiworld"}
        checked = set(int(c) for c in query.get("checked") or ())
        unchecked = self.seed_locations[player] - checked
        ok, reason = self.verified.get(player, (False, fallback_reason))
        if ok and state is None:
            ok, reason = False, fallback_reason
        if ok:
            try:
                ids = {l.address for l in self.addressed[player] if l.address not in checked and l.can_reach(state)}
            except Exception as err:
                print(f"P{player} evaluation failed: {err!r}", file=sys.stderr)
                ok, reason = False, f"evaluation failed: {err!r}"[:300]
        if not ok:
            ids = {i for i in unchecked if self.sphere_of.get((player, i)) == 1}
        names = self.location_names(player)
        result = {
            "slot": player,
            "verified": ok,
            "locations": sorted(([i, self.sphere(player, i), names.get(i)] for i in ids),
                                key=lambda entry: (entry[1] or 1 << 30, entry[0])),
            "open": len(unchecked),
        }
        if not ok:
            result["reason"] = reason
        return result

    def answer_all(self, request, unavailable):
        """Every asked slot, against one state built once for the whole request."""
        queries = request.get("slots") or ()
        received = request.get("received")
        if received is None:
            received = {str(q.get("slot")): q.get("received") or () for q in queries}
        state, reason = None, unavailable
        if self.multiworld is not None and any(self.verified.get(int(q["slot"]), (False,))[0] for q in queries):
            try:
                state = self.state_for(received)
            except Exception as err:
                print(f"could not build the state: {err!r}", file=sys.stderr)
                reason = f"could not build the state: {err!r}"[:300]
        results = []
        for query in queries:
            try:
                results.append(self.answer(query, state, reason))
            except Exception as err:
                results.append({"slot": query.get("slot"), "error": f"{err!r}"[:300]})
        return results


def serve(logic, unavailable):
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
                send({"id": request_id, "ok": True, "results": logic.answer_all(request, unavailable)})
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

    # Anything that stops the rebuild leaves the multidata, which still says what sphere 1 is, so
    # every slot is answered from that instead of the worker giving up.
    multiworld, rebuild_error, injected = None, None, None
    try:
        seed = seed_from_spoiler(os.path.abspath(options.multidata)) or options.seed
        if multidata.get("race_mode"):
            raise RuntimeError("the seed was generated in race mode, which cannot be reproduced")
        if not seed:
            raise RuntimeError("no seed number: the output zip has no spoiler and no Generate log names it")
        send({"event": "progress", "stage": "building", "elapsedMs": elapsed_ms()})
        if options.players_dir:
            players_dir = os.path.abspath(options.players_dir)
        else:
            try:
                players_dir = select_players(multidata)
            except Exception as err:
                print(f"could not pick the seed's yamls out of the Players folder: {err!r}", file=sys.stderr)
                players_dir = None
        multiworld = rebuild(seed, options.seed_name, multidata, players_dir, options.plando)
        injected = inject_placements(multiworld, multidata)
    except Exception as err:
        multiworld = None
        rebuild_error = f"could not rebuild seed {options.seed_name}: {err!r}"[:400]
        print(rebuild_error, file=sys.stderr)

    send({"event": "progress", "stage": "checking", "elapsedMs": elapsed_ms()})
    logic = Logic(multiworld, multidata)
    if multiworld is not None:
        logic.self_check(multidata)

    slots = {}
    for player in sorted(logic.seed_locations):
        ok, reason = logic.verified.get(player, (False, rebuild_error or "not checked"))
        slots[str(player)] = {"verified": ok, **({"reason": reason} if reason and not rebuild_error else {})}
    send({
        "event": "ready",
        "seedName": options.seed_name,
        "slots": slots,
        "lastSphereUnreachable": logic.last_is_unreachable,
        "rebuildError": rebuild_error,
        "injected": injected,
        "elapsedMs": elapsed_ms(),
    })
    serve(logic, rebuild_error or "not checked")


if __name__ == "__main__":
    main(sys.argv[1:])
