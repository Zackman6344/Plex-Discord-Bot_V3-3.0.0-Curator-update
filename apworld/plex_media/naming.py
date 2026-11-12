# apworld/plex_media/naming.py
# Display names for a seed's items and locations, and the text sanitiser shared with the bot.
#
# sanitize_text mirrors sanitizeText in helpers/apMediaContracts.js step for step and class for
# class; test_pure.py runs both on the same strings. The bot cleans every string before it writes a
# YAML and the world cleans it again on the way in, so both sides must agree on what a title is.
#
# Names are frozen per builder version, like ids: the server, the spoiler and every hint name a
# location by the text built here, and a seed keeps its names for as long as its room lives.

import re

from .constants import TITLE_MAX

# PyYAML refuses raw C0/C1 controls, surrogates and U+FFFE/U+FFFF anywhere in the file, quoted or
# not, and AP shows names in one-line chat. The whitespace class is spelled out because JS \s and
# Python's isspace() disagree (U+FEFF, U+001C-U+001F), and both sides must produce the same names.
_BREAKS = re.compile(r"[\t\n\v\f\r\x85\u2028\u2029]")
_DROPPED = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufeff\ufffe\uffff]")
_SPACES = re.compile(r"[ \xa0\u1680\u2000-\u200a\u202f\u205f\u3000]+")
_EDGES = re.compile(r"^ +| +\Z")

ELLIPSIS = "\u2026"


def sanitize_text(value):
	text = "" if value is None else str(value)
	text = _BREAKS.sub(" ", text)
	text = _DROPPED.sub("", text)
	text = _SPACES.sub(" ", text)
	return _EDGES.sub("", text)


def clip(text):
	if len(text) <= TITLE_MAX:
		return text
	return text[:TITLE_MAX - 1].rstrip(" ") + ELLIPSIS


def format_minutes(minutes):
	"""15m, 1h, 1h30m, 12h: a checkpoint written as h:mm reads as minutes:seconds in a player."""
	hours, rest = divmod(int(minutes), 60)
	if not hours:
		return f"{rest}m"
	return f"{hours}h{rest}m" if rest else f"{hours}h"


def track_norm(title):
	"""The part of an album or mix track's location key that tells two track lists apart."""
	return "".join(ch for ch in sanitize_text(title).casefold() if ch.isalnum())[:40]


def _movie(entry):
	title = clip(entry["t"])
	return f"{title} ({entry['y']})" if entry.get("y") else title


def _episode(entry):
	return f"{clip(entry['sh'])} S{entry['sn']:02}E{entry['en']:02}"


def _album(entry):
	return f"{clip(entry['ar'])} - {clip(entry['t'])}"


def unit_name(unit_key, entry):
	kind = entry["k"]
	if kind == "movie":
		return _movie(entry)
	if kind == "episode":
		show = clip(entry["sh"])
		if unit_key.startswith("show-season|"):
			return f"{show}: Next Season"
		per = int(unit_key[len("show-ep"):unit_key.index("|")])
		return f"{show}: Next Episode" if per == 1 else f"{show}: Next {per} Episodes"
	if kind == "album":
		return _album(entry)
	if kind == "mix":
		return f"{clip(entry['t'])} (playlist)"
	return f"{clip(entry['t'])} by {clip(entry['au'])}"


def main_location_name(entry, n):
	"""The watch, track or finish location; n is the track's 1-based position in tr (else 0)."""
	kind = entry["k"]
	if kind == "movie":
		return f"Watch {_movie(entry)}"
	if kind == "episode":
		return f"Watch {_episode(entry)}"
	if kind == "album":
		return f"{_album(entry)} #{n:02} {clip(entry['tr'][n - 1][2])}"
	if kind == "mix":
		track = entry["tr"][n - 1]
		return f"{clip(entry['t'])} #{n:02} {clip(track[5])} - {clip(track[2])}"
	return f"Finish {clip(entry['t'])}"


def checkpoint_name(entry, minute):
	kind = entry["k"]
	if kind == "movie":
		base = _movie(entry)
	elif kind == "episode":
		base = _episode(entry)
	elif kind == "album":
		base = _album(entry)
	else:
		base = clip(entry["t"])
	return f"{base} @ {format_minutes(minute)}"


def is_reserved(folded, reserved):
	"""True for a casefolded name a title may not take: a fixed name, a group, or a placeholder.

	The placeholders matter because create_item takes "Unlock i" to mean registry unit i (the
	!ap next worker replays placements by those names), so no real title may be spelled that way.
	"""
	return folded in reserved or _PLACEHOLDER.match(folded) is not None


_PLACEHOLDER = re.compile(r"(?:unlock|check) [0-9]+\Z")


def make_unique(order, names, tags, kinds, reserved):
	"""Names that differ from each other and from the reserved set once casefolded.

	The first key in `order` keeps a contested name; each later one gets " [<tag>]" appended until
	it is free. The server reads an all-numeric hint as an id (and calls int() on anything
	str.isnumeric() accepts, such as "1917" or "XII" in Roman numeral characters), so such a name
	gets " (<kind>)" first.
	"""
	taken = set(reserved)
	out = {}
	for key in order:
		name = names[key]
		if name.strip().isnumeric():
			name = f"{name} ({kinds[key]})"
		while is_reserved(name.casefold(), taken):
			name = f"{name} [{tags[key]}]"
		taken.add(name.casefold())
		out[key] = name
	return out
