"""Pull a multiworld's sphere table out of the .archipelago file its generation produced.

Why this exists
---------------
`!ap next` needs to know which of a slot's locations are reachable. The seed's spoiler log was
the first source and is a poor one: its Playthrough section lists only the placements the seed's
completion depends on. Measured on the room this was built against, that is 1,728 rows out of
14,783 locations -- 11.7%, and 8% for one slot. A player who has checked everything the
Playthrough happens to name is told "nothing reachable yet" while dozens of locations sit open.

The generator already computed the real answer and wrote it down. Archipelago's multidata carries
a top-level `spheres` field: a list of spheres, each a dict of player -> set of location ids,
covering EVERY location in the multiworld rather than only the progression ones. On the same room
that is all 14,783, including all 529 of the slot the spoiler knew 43 of.

So nothing here re-derives logic. It reads what generation already decided and reshapes it into
JSON the bot can load without Python.

Requirements
------------
The multidata for the seed, which means the multiworld has to have been generated on this
machine: `<Archipelago>/output/AP_<seed>.zip`. A room somebody else generated has no multidata
here, and falls back to the spoiler path with its 8%.

Usage
-----
    python scripts/extract-spheres.py <AP_*.zip or *.archipelago> [--out <dir>]

Writes <out>/<seed_name>.json. The default out is data/archipelago/spheres next to this repo.

Note on unpickling
------------------
The multidata is a zlib-compressed pickle referencing Archipelago's own classes. Importing them
means loading Archipelago's frozen bytecode, which is built for the interpreter it ships with and
will not import into a different minor version. None of those classes matter here -- the spheres
are plain ints and sets -- so the unpickler is handed a permissive stand-in for anything it
cannot resolve, and the real values come through untouched.

The file is one you generated. Do not point this at a multidata from someone you do not trust:
unpickling runs code by design, and the stand-in above does not change that.
"""

import argparse
import io
import json
import os
import pickle
import sys
import zipfile
import zlib

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_ROOT, "data", "archipelago", "spheres")


class _Stand_in:
    """Accepts whatever the pickle throws at it and holds nothing."""

    def __init__(self, *args, **kwargs):
        pass

    @classmethod
    def _make(cls, iterable):        # NamedTuple's own constructor
        return cls(*iterable)

    def __setstate__(self, state):
        pass


class _Unpickler(pickle.Unpickler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._made = {}

    def find_class(self, module, name):
        try:
            return super().find_class(module, name)
        except Exception:
            key = "%s.%s" % (module, name)
            if key not in self._made:
                self._made[key] = type(name, (_Stand_in,), {"__module__": module})
            return self._made[key]


def read_multidata(path):
    """The decoded multidata dict, from either an AP output zip or a loose .archipelago."""
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".archipelago")]
            if not names:
                raise SystemExit("%s holds no .archipelago file" % path)
            raw = archive.read(names[0])
    else:
        with open(path, "rb") as handle:
            raw = handle.read()

    # First byte is the format version; the rest is the compressed pickle.
    if not raw:
        raise SystemExit("%s is empty" % path)
    version = raw[0]
    if version > 3:
        raise SystemExit(
            "multidata format version %d is newer than this script understands (3). "
            "Archipelago changed the container; update this script." % version
        )
    return _Unpickler(io.BytesIO(zlib.decompress(raw[1:]))).load()


def build(data):
    """Reshape multidata into {seed, version, slots: {slot: {sphere: [location ids]}}}."""
    spheres = data.get("spheres")
    if not spheres:
        raise SystemExit(
            "This multidata carries no `spheres` field, so there is nothing to extract. "
            "It predates Archipelago writing one; the spoiler fallback is the only option "
            "for this seed."
        )

    slots = {}
    total = 0
    for index, sphere in enumerate(spheres, start=1):
        for player, locations in sphere.items():
            ids = sorted(int(loc) for loc in locations)
            if not ids:
                continue
            slots.setdefault(str(int(player)), {})[str(index)] = ids
            total += len(ids)

    names = {}
    for slot, info in (data.get("slot_info") or {}).items():
        name = getattr(info, "name", None)
        if isinstance(name, str) and name:
            names[str(int(slot))] = name

    return {
        "seed": str(data.get("seed_name") or ""),
        "version": list(data.get("version") or []),
        # Names are a convenience for reading the file by hand and for a sanity check at load
        # time; the bot resolves slot names from the live connection, not from here.
        "slotNames": names,
        "slots": slots,
    }, total


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("multidata", help="AP_<seed>.zip from Archipelago's output folder, or a loose .archipelago")
    parser.add_argument("--out", default=DEFAULT_OUT, help="directory to write <seed_name>.json into")
    args = parser.parse_args(argv)

    if not os.path.exists(args.multidata):
        raise SystemExit("no such file: %s" % args.multidata)

    built, total = build(read_multidata(args.multidata))
    if not built["seed"]:
        raise SystemExit("this multidata carries no seed_name, so there is nothing to file it under")

    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, "%s.json" % built["seed"])
    # Written through a temp file and renamed, so an interrupted write cannot leave a half-file
    # where a usable sphere table used to be.
    temp = target + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(built, handle, separators=(",", ":"))
    os.replace(temp, target)

    slots = built["slots"]
    print("seed %s (Archipelago %s)" % (built["seed"], ".".join(str(p) for p in built["version"])))
    print("%d slots, %d locations across %d spheres" % (len(slots), total, len(read_spheres_count(slots))))
    print("wrote %s (%.1f KB)" % (target, os.path.getsize(target) / 1024.0))
    return 0


def read_spheres_count(slots):
    seen = set()
    for table in slots.values():
        seen.update(table.keys())
    return seen


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
