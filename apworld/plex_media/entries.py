# apworld/plex_media/entries.py
# Reads and checks a slot's list (the YAML's entries and list_info), with no AP imports.
#
# Every entry comes back as a new dict holding only its kind's fields, display text run through
# sanitize_text and cut at TEXT_MAX, and ids kept exactly as written, since an id is identity. A
# bad entry stops the whole multiworld from generating, so each check names the entry and the
# field. A YAML that any earlier builder version emitted must keep rolling: loosen a check, and
# never tighten one past what a builder wrote, unless the change ships as a new builder version.

import json

from .constants import BUILDER_VERSION, KINDS, MAX_ENTRIES, MIN_TRACK_MS, MIX_TRACKS
from .naming import sanitize_text

# The bot reads every id as a JS number, so nothing above 2^53 - 1 survives the trip.
MAX_INT = 2 ** 53 - 1

# slot_data repeats every entry, every client of the slot downloads it, and the bot caches and
# indexes it, so a hand-edited list may not make it any size it likes (the bot's client takes at
# most 128 MiB a frame). A book's id also lands in the bracket tag of each of its names when two
# titles clash. The caps sit far above what the builder writes: a list at all of its caps comes to
# about 3 MiB, and its ids are Plex guids, rating keys and catalog slugs. Text is cut rather than
# refused, because the builder copies Plex text whole. Names clip at TITLE_MAX and a track's key
# reads its first 40 letters and digits, so the cut moves no name, and no id unless a title's first
# TEXT_MAX characters hold fewer than 40 letters and digits.
TEXT_MAX = 1000
ID_MAX = 1000
LIST_BYTES_MAX = 16 * 1024 * 1024


class EntryError(ValueError):
	def __init__(self, index, message):
		self.index = index
		self.detail = message
		super().__init__(message if index is None else f"entry {index + 1}: {message}")


def _is_int(value):
	return type(value) is int


def _int(index, entry, field, low=0):
	value = entry.get(field)
	if not _is_int(value) or not low <= value <= MAX_INT:
		raise EntryError(index, f"{field} must be a whole number of at least {low}, not {value!r}")
	return value


def _int_or_none(index, value, what):
	if value is None:
		return None
	if not _is_int(value) or not 0 <= value <= MAX_INT:
		raise EntryError(index, f"{what} must be a whole number or null, not {value!r}")
	return value


def _cut(text):
	return text if len(text) <= TEXT_MAX else text[:TEXT_MAX].rstrip(" ")


def _text(index, value, what):
	if not isinstance(value, str):
		raise EntryError(index, f"{what} must be text, not {value!r}")
	text = sanitize_text(value)
	if not text:
		raise EntryError(index, f"{what} is empty")
	return _cut(text)


def _ident(index, value, what, high=ID_MAX):
	if not isinstance(value, str) or not value.strip():
		raise EntryError(index, f"{what} must be non-empty text, not {value!r}")
	if high is not None and len(value) > high:
		raise EntryError(index, f"{what} must be at most {high} characters, not {len(value)}")
	return value


def _list(index, value, what, low=1, high=None):
	if not isinstance(value, (list, tuple)):
		raise EntryError(index, f"{what} must be a list, not {value!r}")
	if len(value) < low or (high is not None and len(value) > high):
		span = f"at least {low}" if high is None else f"{low} to {high}"
		raise EntryError(index, f"{what} must hold {span} items, not {len(value)}")
	return value


def _tuple(index, value, what, size):
	if not isinstance(value, (list, tuple)) or len(value) < size:
		raise EntryError(index, f"{what} must be a list of {size} values, not {value!r}")
	return value


def _tracks(index, entry, mixed):
	size = 6 if mixed else 5
	tracks = _list(index, entry.get("tr"), "tr", 1, MIX_TRACKS if mixed else None)
	out = []
	for n, raw in enumerate(tracks, 1):
		what = f"track {n}"
		raw = _tuple(index, raw, what, size)
		rk = raw[0]
		if not _is_int(rk) or not 0 <= rk <= MAX_INT:
			raise EntryError(index, f"{what} rating key must be a whole number, not {rk!r}")
		track = [
			rk,
			_int_or_none(index, raw[1], f"{what} index"),
			_text(index, raw[2], f"{what} title"),
			_int_or_none(index, raw[3], f"{what} duration"),
			_int_or_none(index, raw[4], f"{what} part id"),
		]
		if track[3] is None:
			raise EntryError(index, f"{what} duration must be a whole number, not null")
		if mixed:
			track.append(_text(index, raw[5], f"{what} artist"))
		out.append(track)
	# Without a track of 30 s or more the entry has no location of its own, yet its unlock still
	# counts toward the goal, and the pool could no longer promise Popcorn for every checkpoint.
	if not any(track[3] >= MIN_TRACK_MS for track in out):
		raise EntryError(index, "has no track of 30 s or more, so nothing on it could be checked")
	return out


def _alt(index, entry, count):
	copies = entry.get("alt")
	if copies is None:
		return []
	copies = _list(index, copies, "alt", 0)
	out = []
	for c, raw in enumerate(copies, 1):
		what = f"alt copy {c}"
		raw = _tuple(index, raw, what, 2)
		album = _int_or_none(index, raw[0], f"{what} rating key")
		tracks = _list(index, raw[1], f"{what} tracks", count, count)
		pairs = []
		for n, pair in enumerate(tracks, 1):
			pair = _tuple(index, pair, f"{what} track {n}", 2)
			pairs.append([
				_int_or_none(index, pair[0], f"{what} track {n} rating key"),
				_int_or_none(index, pair[1], f"{what} track {n} part id"),
			])
		out.append([album, pairs])
	return out


def _parts(index, entry):
	parts = _list(index, entry.get("pa"), "pa", 1)
	out = []
	for n, raw in enumerate(parts, 1):
		what = f"part {n}"
		raw = _tuple(index, raw, what, 3)
		track = _int_or_none(index, raw[0], f"{what} rating key")
		part = _int_or_none(index, raw[1], f"{what} part id")
		length = raw[2]
		if not _is_int(length) or not 0 <= length <= MAX_INT:
			raise EntryError(index, f"{what} duration must be a whole number, not {length!r}")
		out.append([track, part, length])
	return out


def _guid(index, entry):
	value = entry.get("g")
	if value is None:
		return None
	# A legacy agent's guid spells out the artist and album, so the builder's can run long. It is in
	# no name or key, and LIST_BYTES_MAX bounds it.
	return _ident(index, value, "g", None)


def parse_entry(index, raw):
	if not isinstance(raw, dict):
		raise EntryError(index, f"must be a mapping, not {raw!r}")
	kind = raw.get("k")
	if kind not in KINDS:
		raise EntryError(index, f"k must be one of {', '.join(KINDS)}, not {kind!r}")
	ident = _ident(index, raw.get("id"), "id")
	entry = {"k": kind, "id": ident}
	guid = _guid(index, raw)
	if kind in ("movie", "episode", "album"):
		entry["rk"] = _int(index, raw, "rk")
		if guid is not None:
			entry["g"] = guid
	if kind == "movie":
		entry["t"] = _text(index, raw.get("t"), "t")
		entry["y"] = _int_or_none(index, raw.get("y"), "y")
		entry["d"] = _int(index, raw, "d")
	elif kind == "episode":
		entry["t"] = _text(index, raw.get("t"), "t")
		entry["sh"] = _text(index, raw.get("sh"), "sh")
		entry["sid"] = _ident(index, raw.get("sid"), "sid")
		entry["srk"] = _int(index, raw, "srk")
		entry["sn"] = _int(index, raw, "sn")
		entry["en"] = _int(index, raw, "en")
		entry["d"] = _int(index, raw, "d")
	elif kind == "album":
		entry["ar"] = _text(index, raw.get("ar"), "ar")
		entry["t"] = _text(index, raw.get("t"), "t")
		entry["y"] = _int_or_none(index, raw.get("y"), "y")
		entry["d"] = _int(index, raw, "d")
		entry["tr"] = _tracks(index, raw, False)
		entry["alt"] = _alt(index, raw, len(entry["tr"]))
	elif kind == "mix":
		entry["pl"] = _int(index, raw, "pl")
		entry["part"] = _int(index, raw, "part", 1)
		if guid is not None:
			entry["g"] = guid
		if ident != f"pl:{entry['pl']}:{entry['part']}":
			raise EntryError(index, f"a mix's id must be pl:<pl>:<part>, here pl:{entry['pl']}:{entry['part']}, not {ident!r}")
		entry["t"] = _text(index, raw.get("t"), "t")
		entry["d"] = _int(index, raw, "d")
		entry["tr"] = _tracks(index, raw, True)
	else:
		entry["w"] = _ident(index, raw.get("w"), "w")
		if guid is not None:
			entry["g"] = guid
		if ident != f"book:{entry['w']}":
			raise EntryError(index, f"a book's id must be book:<w>, here book:{entry['w']}, not {ident!r}")
		entry["t"] = _text(index, raw.get("t"), "t")
		entry["au"] = _text(index, raw.get("au"), "au")
		entry["d"] = _int(index, raw, "d")
		entry["pa"] = _parts(index, raw)
	return entry


def entry_key(entry):
	return f"{entry['k']}|{entry['id']}"


def parse_entries(value):
	if not isinstance(value, (list, tuple)):
		raise EntryError(None, f"entries must be a list, not {type(value).__name__}")
	if not value:
		# What a YAML from the Archipelago Options Creator says until the bot fills in its titles.
		raise EntryError(None, "this YAML has no titles yet. Attach it to /apmedia yaml in Discord, and the bot "
		                       "picks them from the Plex library.")
	if len(value) > MAX_ENTRIES:
		raise EntryError(None, f"the list has {len(value)} entries; at most {MAX_ENTRIES} fit in one slot, "
		                       "so split it across two slots")
	out = []
	seen = {}
	size = 0
	for index, raw in enumerate(value):
		entry = parse_entry(index, raw)
		key = entry_key(entry)
		if key in seen:
			raise EntryError(index, f"repeats entry {seen[key] + 1} ({key})")
		seen[key] = index
		size += _bytes(entry)
		if size > LIST_BYTES_MAX:
			raise EntryError(None, f"the list comes to {size:,} bytes by entry {index + 1}; at most "
			                       f"{LIST_BYTES_MAX:,} fit in one slot, so split it across two slots")
		out.append(entry)
	return out


def _bytes(entry):
	# What the entry costs in slot_data's JSON. An id may hold a lone surrogate (a YAML escape can
	# write one), which plain UTF-8 refuses to encode.
	text = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
	return len(text.encode("utf-8", "surrogatepass"))


def parse_list_info(value):
	"""list_info as slot_data repeats it, so without the YAML's account and discord (see
	slotdata.build_slot_data). Only the builder version can stop a seed: the rest is information,
	so a field of the wrong type is dropped rather than refused."""
	info = value if isinstance(value, dict) else {}
	builder = info.get("builder", BUILDER_VERSION)
	if not _is_int(builder) or builder < 1:
		raise EntryError(None, f"list_info.builder must be a whole number of at least 1, not {builder!r}")
	if builder > BUILDER_VERSION:
		raise EntryError(None, f"this list was built for Plex Media builder {builder}, but this apworld only "
		                       f"knows builder {BUILDER_VERSION}: install the newer plex_media.apworld")
	created = info.get("created_at")
	label = info.get("label")
	return {
		"builder": builder,
		"created_at": created if _is_int(created) and 0 <= created <= MAX_INT else 0,
		"label": _cut(sanitize_text(label)) if isinstance(label, str) else "",
	}
