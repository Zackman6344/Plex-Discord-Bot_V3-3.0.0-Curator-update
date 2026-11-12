# apworld/plex_media/rules.py
# Access rules and the goal counter's arithmetic. No AP imports.
#
# Each rule is made by a call, so every location keeps its own unit and step; a lambda written in a
# loop would see only the loop's last values and still generate.
#
# The goal asks for goal_count unlocked entries. Adding those up on every evaluation costs a pass
# over every unit, and the spoiler playthrough evaluates the goal once per progression placement,
# so a counter is kept on the state instead: collecting the c-th copy of a unit opens
# prefix[c] - prefix[c - 1] more entries (nothing past the unit's last step).


def has(name, player, count=1):
	return lambda state: state.has(name, player, count)


def opened_by(steps, prefix, count):
	"""Entries the count-th copy of a unit opens (0 for a copy past its last step)."""
	if count < 1:
		return 0
	return prefix[min(count, steps)] - prefix[min(count - 1, steps)]
