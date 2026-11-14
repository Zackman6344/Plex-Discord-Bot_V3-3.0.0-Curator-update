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
| Fast Forward | `/apmedia ff` spends one on a title: it earns the title's next checkpoint without playing it (with `timesanity_strict` on, the 10 minutes after where you got to count as heard instead, and the checkpoints they complete are earned). Never a watch, track or finish, so the goal still needs playing. On a locked title it banks, as a watch does, or is refused under `locked_watches: ignore` |
| Remote Control | Ends the trap at work on your list when it arrives; otherwise it is kept and blocks the next trap |
| Popcorn, Nachos, Large Soda, Candy Bar, Hot Dog, Soft Pretzel, Ice Cream Sandwich | Filler: the snacks. The Snack Bar trades them for a Fast Forward or a Remote Control |
| Buffering | Trap: from your next check, the checks you earn for 15 minutes are held, then sent together. Another one adds 15 minutes, up to an hour |
| Rights Expired | Trap: for 45 minutes, what the title you are playing earns (or else the first title on your list you can play) is held, then sent |
| Commercial Break | Trap: the bot's music plays a commercial after the current track, or pauses for 30 seconds; an audiobook pauses for 30 seconds |
| Shuffle Mode | Trap: the bot's music queue is shuffled after the current track; in an audiobook it is a Rewind |
| Rewind | Trap: the bot's music starts the current track over; an audiobook jumps back 5 minutes |
| Intermission | Trap: the bot's music or your audiobook pauses for 60 seconds, then plays on |
| Slow Motion | Trap: your audiobook plays at 0.75x for 10 minutes; the bot's music pauses for 30 seconds instead |

No trap takes away an item or a check: what Buffering and Rights Expired hold is sent when they end.
Commercial Break, Shuffle Mode, Rewind, Intermission and Slow Motion need you listening through the
bot, in its voice channel while it plays music or in an audiobook of your own; until you are, the
trap waits, for up to 12 hours. The bot's owner can turn traps off, and a trap then only says so.

The Snack Bar (`/apmedia snackbar`) trades `snack_bar_price` snacks you have received for a Fast
Forward or a Remote Control, `snack_bar_trades` times a slot. Every snack counts the same, Popcorn
included.

## Locations

| Location | Sent when |
|---|---|
| `Watch <title>` | A movie or episode is watched to the end (Plex counts a watch at 90%) |
| `<artist> - <album> #03 <track>` | That track is played through. Tracks under 30 seconds have no location |
| `Finish <book>` | The audiobook is finished |
| `<title> @ 1h30m` | Playback passes that point of the title (timesanity) |

Checkpoints stop before the last 10% of a title. By default, finishing a title also sends all of
its checkpoints, so a watch the bot could not follow live still pays out; `timesanity_strict: true`
turns that off. Under it, a checkpoint needs everything before it heard: gaps under 30 seconds are
forgiven, and in Plex, which the bot checks every 15 seconds by default, gaps up to about 50
seconds. By default checkpoints hold only filler or traps (`checkpoint_items: filler_only`), so no
one waits on another player reaching the middle of a film for a key item.

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

World 0.3.0 added the snacks, Fast Forward, Remote Control, the traps and the item groups Snacks,
Useful and Traps to the fixed names. Of a list's names only a movie without a year can be spelled
like one, so in a seed made with 0.3.0 or later a yearless movie called Rewind is
`Rewind [<rating key>]`. Only its name changes, never its ids, and a seed made before keeps the
names it had.

## Options

The Archipelago Options Creator shows Plex Media's options in four groups of their own, after
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

### Items and traps

| Option | Default | Range |
|---|---|---|
| `snack_variety` | `true` | `true`: filler comes as the seven snacks in turn; `false`: Popcorn only |
| `fast_forwards` | 2 | 0–10, fewer when the list is short |
| `remote_controls` | 1 | 0–10, fewer when the list is short |
| `snack_bar_trades` | 3 | 0–10 trades at the Snack Bar |
| `snack_bar_price` | 10 | 5–50 snacks a trade |
| `trap_percentage` | 0 | 0–100 percent of the filler |
| `buffering_weight` | 2 | 0–10 |
| `rights_expired_weight` | 2 | 0–10 |
| `commercial_break_weight` | 1 | 0–10 |
| `shuffle_mode_weight` | 1 | 0–10 |
| `rewind_weight` | 1 | 0–10 |
| `intermission_weight` | 1 | 0–10 |
| `slow_motion_weight` | 1 | 0–10 |

The pool holds one item for each of the list's locations, and nothing in it is left to chance.
Unlocks and useful items fit in the titles' own locations (the watches, tracks and finishes), so
every checkpoint keeps a snack or a trap: Wild Tickets take that room first, then Fast Forwards,
then Remote Controls, and a short list gets fewer than it asks for. Excluding a title's watch,
finish or track gives up useful items first: an excluded location holds only a snack or a trap, so
each of your own that `exclude_locations` names takes a place from that room, and the useful items
that no longer fit go, Remote Controls first, then Fast Forwards, then Wild Tickets. The rest is
filler. `trap_percentage` of it, rounded down, becomes traps, shared among the seven by their
weights (by largest remainder, a tie going to the trap listed first), and the other slots are
snacks, dealt in turn in the order of the Items table. A list due a trap while every weight is 0
stops generation, naming the player. These options move no id, name or location.

A YAML without these options, such as one written for world 0.2.0, gets their defaults: 2 Fast
Forwards and 1 Remote Control where the list has room for them, in places that held Popcorn before,
the other filler as the seven snacks, and no traps.

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
`start_location_hints` can only name `Unlock 1` to `Unlock 20000`, `Check 1` to `Check 60000`, the
other items in the Items table, the groups Snacks, Useful, Traps and Everything, and Everywhere,
which is all the Options Creator offers for them: a title gets its item and its locations only when
the seed is generated. Everything and Everywhere mean your own list's unlocks and locations. A
numbered name means the seed's unlock or location with that number, counted across every Plex
Media list in the seed: one that is not on your list is left out with a warning, and an `Unlock`
number past the seed's last unlock stops generation. Excluding a watch, finish or track of your own
list gives up useful items first, as Items and traps says.

`plando_items` reads none of those names: there, a numbered location finds nothing, which stops
generation when the block has `force: true`, and a numbered unlock is an extra copy. It takes the
names a seed gives your titles, such as `Watch Alien (1979)` for a movie's location.
