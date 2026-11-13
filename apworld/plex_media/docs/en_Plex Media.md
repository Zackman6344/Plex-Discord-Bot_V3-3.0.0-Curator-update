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

The Archipelago Options Creator shows Plex Media's options in three groups of their own, after
Archipelago's Game Options and before its Item & Location Options. The setup guide walks through
making a YAML there.

### Your list (the bot picks the titles)

The bot reads these when `/apmedia yaml` fills in a YAML's titles. Generation ignores them: a seed
comes out the same with or without them.

| Option | In the Options Creator | Default | Values |
|---|---|---|---|
| `list_preset` | List: Preset | `movies` | `movies` (15 movies), `tv` (3 shows), `music` (10 albums), `books` (3 audiobooks), `mixed` (6 movies, 1 show, 4 albums and 1 audiobook), `none` |
| `list_movies` | List: Movies | `preset` | 0–200 |
| `list_shows` | List: Shows | `preset` | 0–50 |
| `list_albums` | List: Albums | `preset` | 0–200 |
| `list_books` | List: Audiobooks | `preset` | 0–50 |
| `list_titles` | List: Titles | empty | Titles split by `;`, at most 50 |
| `list_playlist` | List: Playlist | empty | A Plex playlist, by name |
| `list_collection` | List: Collection | empty | A Plex movie or TV collection, by name |
| `list_genre` | List: Genre | empty | A genre, such as `Horror` or `Jazz` |
| `list_years` | List: Years | empty | `1999` or `1990-1999` |
| `list_unwatched` | List: Unwatched Only | `true` | `true` or `false` |
| `list_max_episodes` | List: Episodes per Show | 24 | 1–500 |
| `list_label` | List: Name | empty | The list's name, up to 100 characters |

The four counts are totals for each kind, the titles you name included, and the bot picks the rest
at random. A count left at `preset` takes its number from `list_preset`, and a kind the preset
leaves out gets 0. `none` gives 0 of each, so the list holds only what you count or name. A list
that counts nothing and names nothing is refused.

In `list_titles`, `movie:`, `show:`, `album:` or `book:` in front of a title says what it is, a
year picks one film (`Halloween (2018)`), and a show takes a range of seasons
(`show: Lost S1-2`). A playlist goes on the list in its own order, a music playlist in parts of 15
tracks. `list_genre` and `list_years` narrow only the random picks, and audiobooks ignore
`list_years`. `list_unwatched` leaves the movies and episodes you have watched and the audiobooks
you finished out of the random picks, a collection, a video playlist and the shows you name without
seasons, and starts each show at your first unwatched episode; a show you named and have watched to
the end is left out. The movies, audiobooks and seasons you name in `list_titles` stay on the list
whole. Leaving out what you watched needs your Plex account, linked by the server owner with your
consent; finished audiobooks come from the bot's own bookmarks. `list_max_episodes` is the most
episodes the bot takes from one show, for random shows, the shows of a collection and shows named
without seasons. An empty `list_label` names the list "<your name>'s list".

These settings cannot be random, and a trigger cannot set them. A weighted setting with one choice
above 0, as every one in a file from the Launcher's Generate Template Options, is that choice.

### Unlocks and goal

| Option | Default | Range |
|---|---|---|
| `starting_unlocks` | 3 | 1–50 unlock copies to start with; a long list starts with at least one per 50 copies |
| `goal_percent` | 80 | 1–100 |
| `tv_unlock` | `episodes` | `episodes` or `season` |
| `episodes_per_unlock` | 3 | 1–12 |
| `locked_watches` | `bank` | `bank` or `ignore` |
| `wild_tickets` | 2 | 0–20, fewer when the list is short |

### Timesanity

| Option | Default | Range |
|---|---|---|
| `checkpoint_items` | `filler_only` | `filler_only` or `anything` |
| `timesanity_strict` | `false` | |
| `timesanity_movies` | 15 | 0–240 minutes, `off` = 0 |
| `timesanity_episodes` | 10 | 0–240 minutes |
| `timesanity_albums` | 0 | 0–240 minutes, covers playlists too |
| `timesanity_books` | 30 | 0–1440 minutes |

### Written by the bot

`entries` and `list_info` hold the list itself. The bot writes them; they are not meant to be edited
by hand, and the Options Creator does not show them. A YAML exported from the Options Creator has
none, and generated before the bot has filled it in, it stops with "Plex Media list of <name>: this
YAML has no titles yet. Attach it to /apmedia yaml in Discord, and the bot picks them from the Plex
library."

A list holds at most 2,000 titles, 2,000 unlock copies, 10,000 locations and 16 MiB of data, an id
runs to at most 1,000 characters, and longer text is cut at 1,000.

### Archipelago's own options

Plex Media ignores `start_inventory` and `item_links`, and generation logs a warning for each:
`starting_unlocks` opens the first titles, and a link stays empty.

`local_items`, `non_local_items`, `start_hints`, `exclude_locations`, `priority_locations` and
`start_location_hints` can only name `Unlock 1` to `Unlock 20000`, `Check 1` to `Check 60000`,
Popcorn, Wild Ticket, Everything and Everywhere, which is all the Options Creator offers for them: a
title gets its item and its locations only when the seed is generated. Everything and Everywhere
mean your own list's unlocks and locations. A numbered name means the seed's unlock or location
with that number, counted across every Plex Media list in the seed: one that is not on your list
is left out with a warning, and an `Unlock` number past the seed's last unlock stops generation.

`plando_items` reads none of those names: there, a numbered location finds nothing, which stops
generation when the block has `force: true`, and a numbered unlock is an extra copy. It takes the
names a seed gives your titles, such as `Watch Alien (1979)` for a movie's location.
