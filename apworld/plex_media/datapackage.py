# apworld/plex_media/datapackage.py
# The seed's own Plex Media data package: the real names on the ids the placeholders hold.
#
# Main embeds the package worlds built at import (placeholder names) and stage_modify_multidata
# swaps this one in. The room server, archipelago.gg and every client name items and locations by
# it, and archipelago.gg's upload re-sorts the top-level keys and recomputes the checksum, refusing
# the seed when it differs. So the dict is new (the embedded one is worlds.network_data_package's
# own object), its keys are in alphabetical order, its groups are sorted lists of str, and the
# checksum is taken from exactly the dict that ships.

from .constants import POPCORN, POPCORN_ID, WILD_TICKET, WILD_TICKET_ID


def build_package(registry):
	items = {POPCORN: POPCORN_ID, WILD_TICKET: WILD_TICKET_ID}
	for key in registry.unit_keys:
		items[registry.unit_name[key]] = registry.unit_id[key]
	locations = {registry.location_name[key]: registry.location_id[key] for key in registry.location_keys}
	item_groups = registry.item_groups()
	location_groups = registry.location_groups()
	return {
		"item_name_groups": {name: sorted(item_groups[name]) for name in sorted(item_groups)},
		"item_name_to_id": items,
		"location_name_groups": {name: sorted(location_groups[name]) for name in sorted(location_groups)},
		"location_name_to_id": locations,
	}


def checksummed(package):
	from worlds.AutoWorld import data_package_checksum

	package["checksum"] = data_package_checksum(package)
	return package
