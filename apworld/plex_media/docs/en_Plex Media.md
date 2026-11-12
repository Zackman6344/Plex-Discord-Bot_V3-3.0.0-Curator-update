# Plex Media

## What the game is

Plex Media turns a list of titles from a Plex server into an Archipelago slot. The list can hold
movies, TV episodes, music albums, chunks of an audio playlist (up to 15 tracks each) and
audiobooks. Every title starts locked except a few opening ones, and the multiworld sends the
unlocks. Watching or listening sends checks.

The Plex Discord Bot builds the list, follows the playback and sends the checks. A slot is played
through that bot and the server owner's Plex server, so this world is only useful on a server that
runs it.

## Items

| Item | What it does |
|---|---|
| A title's unlock, named after the title (`The Matrix (1999)`, `Daft Punk - Discovery`, `Pride and Prejudice by Jane Austen`) | Unlocks that movie, album, playlist part or book |
| `<Show>: Next 3 Episodes` (or `Next Episode`, `Next Season`) | Unlocks the next episodes of a show, in season and episode order; a show has as many copies as it has steps |
| Wild Ticket | Unlocks any locked title of your choice (one step of a show) through `/apmedia redeem` |
| Popcorn | Filler |

## Locations

| Location | Sent when |
|---|---|
| `Watch <title>` | A movie or episode is watched to the end (Plex counts a watch at 90%) |
| `<artist> - <album> #03 <track>` | That track is played through. Tracks under 30 seconds have no location |
| `Finish <book>` | The audiobook is finished |
| `<title> @ 1h30m` | Playback passes that point of the title (timesanity) |

Checkpoints stop before the last 10% of a title. By default, finishing a title also sends all of
its checkpoints, so a watch the bot could not follow live still pays out; `timesanity_strict: true`
turns that off. By default checkpoints hold only filler (`checkpoint_items: filler_only`), so no one
waits on another player reaching the middle of a film for a key item.

A title watched before its unlock arrives keeps its checks banked, and they are sent when the unlock
comes (`locked_watches: bank`). With `ignore`, the watch counts for nothing.

## Goal

Finish `goal_percent` of the list (default 80%, rounded down, at least one title). The bot sends the
goal once that many titles are done.

## Names everyone sees

Hints, the spoiler and the room show the real titles on the list. Every title on a list is visible
to the whole multiworld and to the public tracker. The slot data the bot reads, which any client
joined as your slot can fetch and archipelago.gg's tracker API serves, holds the list and its
options and names no Discord or Plex account.

Two slots that list the same title share its unlock name and its locations. A name that would clash
with another title, a fixed name or a group name gets a tag in brackets, such as
`Halloween (2018) [2003]`. The tag is the Plex rating key of the movie, episode or album. A show's
unlock uses the show's rating key. A playlist part uses its playlist's rating key and part number
(`[2500:2]`). An audiobook uses the bot's catalog id (`[jane-austen/emma]`). An all-number title
such as `1917` gets `(movie)`.

## Options

| Option | Default | Range |
|---|---|---|
| `starting_unlocks` | 3 | 1–50 unlock copies to start with; a long list starts with at least one per 50 copies |
| `goal_percent` | 80 | 1–100 |
| `tv_unlock` | `episodes` | `episodes` or `season` |
| `episodes_per_unlock` | 3 | 1–12 |
| `locked_watches` | `bank` | `bank` or `ignore` |
| `checkpoint_items` | `filler_only` | `filler_only` or `anything` |
| `timesanity_strict` | `false` | |
| `timesanity_movies` | 15 | 0–240 minutes, `off` = 0 |
| `timesanity_episodes` | 10 | 0–240 minutes |
| `timesanity_albums` | 0 | 0–240 minutes, covers playlists too |
| `timesanity_books` | 30 | 0–1440 minutes |
| `wild_tickets` | 2 | 0–20, fewer when the list is short |

`entries` and `list_info` hold the list itself. The bot writes them; they are not meant to be edited
by hand. A list holds at most 2,000 titles, 2,000 unlock copies, 10,000 locations and 16 MiB of
data, an id runs to at most 1,000 characters, and longer text is cut at 1,000.

Plex Media ignores `item_links`: generation logs a warning and the link stays empty.
