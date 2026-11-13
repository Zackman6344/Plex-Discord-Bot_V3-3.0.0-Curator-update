# Plex Media setup guide

## What you need

- Archipelago 0.6.8 or later on the PC that generates the seed.
- The Plex Discord Bot on a Discord server you share with the Plex server's owner, with its Plex
  Media feature turned on.
- A Plex account on the owner's server, linked by the owner, for watches made in Plex to count.
  Music and audiobooks played through the bot in a voice channel count without one.
- To make your YAML in the Options Creator: Archipelago 0.6.8 or later on your own PC.

## Install the world (server owner)

1. Run `/apmedia apworld` in Discord (or `npm run build:apworld` in the bot's folder, which writes
   `dist/plex_media.apworld`). The reply is public, so players can save the file from it too.
2. Open the Archipelago Launcher, choose **Install APWorld** and pick `plex_media.apworld`.
3. Restart the Launcher and any other Archipelago program that was open.

Every YAML the bot writes requires the world version it ships with (`requires:` names Plex Media
0.2.0), and Archipelago refuses the file while an older version is installed. Install the file
again whenever `/apmedia apworld` says the PC has another version.

**Keep the world installed for as long as a Plex Media seed's room is in use.** The bot's `!ap next`
rebuilds the seed with it, and answers every slot of the room from sphere 1 when it cannot.

## Before you build a list

Ask the owner to link your Plex account: `/apmedia account user:@you plex:<Plex name>`, giving its
full name or its id. Accept the bot's consent button, and your list can leave out what you have
already watched. Without a linked account, random movies or shows, a collection or a video
playlist need List: Unwatched Only turned off (`unwatched:False` on the command); titles you name do
not. `/apmedia account plex:none` takes your consent back at any time.

## Build a list in the Options Creator

1. Save `plex_media.apworld` from the owner's `/apmedia apworld` reply. In the Archipelago
   Launcher, choose **Install APWorld**, pick the file, and restart the Launcher.
2. Open **Options Creator** from the Launcher and pick **Plex Media** in the game list.
3. Type your slot name under Player Name: 1 to 16 characters, without `{`, `}` or `%`.
4. Open **Your list (the bot picks the titles)** and set what the bot picks. List: Preset gives a
   starting mix, and List: Movies, List: Shows, List: Albums and List: Audiobooks take their
   numbers from it while they stay at Preset. Name titles, a playlist or a collection, narrow the
   random picks with List: Genre and List: Years, and give the list a name if you like. Pointing
   at a setting's name shows what it does, and the game page lists every setting.
5. Change the game options in the other groups if you like. The bot copies them into the finished
   file as they are.
6. Choose **Export Options** and save the file.
7. In Discord, run `/apmedia yaml` with the file in `file:`, or attach it to a `!apmedia yaml`
   message. The bot picks the titles from the Plex library and replies with the finished YAML and a
   summary: titles, locations, how many titles start open and how many the goal needs.
8. Send the bot's file to whoever generates the seed.

The Creator's own file holds no titles. Generated as it is, it stops with "Plex Media list of
<name>: this YAML has no titles yet. Attach it to /apmedia yaml in Discord, and the bot picks them
from the Plex library."

A count at Preset shows -1 beside a slider at its left end, and stays at Preset until the slider
moves. Moving the slider sets a number of your own, and 0 leaves that kind out: to get 0, drag the
slider right and back to the left end, until the number reads 0 and the button Custom. Choose
Preset from the count's button to go back.

A game option with Random? turned on stays random in the finished file, and Archipelago rolls it
when the seed is generated; the bot's summary uses the option's default and says so. The list
settings cannot be random: the bot names each one that is and asks for a value. Its messages name
a setting as the Creator shows it, with the file's key after it: List: Episodes per Show
(`list_max_episodes`).

Options typed with the command replace the file's: `/apmedia yaml file:<your file> movies:20` picks
20 movies and keeps every other setting, and `name:` renames the slot. The finished file records
the list settings, and attached again it gets a fresh pick with the same settings in place of its
old titles. A list the bot built for someone else is theirs under its slot name: the owner adds
`for:` to pick it again for them, and anyone may give it a new name, with `name:` or in the file's
`name:` line, to make it a list of their own.

Triggers go under `Plex Media:`. A trigger that checks one of these settings sees it as your file
writes it: the bot writes that setting back in your spelling, unless you type the option with a
different value. A trigger cannot set a list setting, and the bot refuses one that does. A timer a
trigger sets is checked as a random one is: a list that would pass 10,000 locations at that value
is refused. If your file asks for a plando module in `requires`, such as `plando: items`, the
finished file asks for it too.

The Item & Location Options group offers only the world's fixed names, such as `Unlock 12` and
`Check 40`. Leave those options empty, or use Everything and Everywhere, which mean your own list's
unlocks and locations.
`plando_items` takes none of these: name your list's items and locations there as a seed names them,
such as `Watch Alien (1979)`.

A file from the Launcher's **Generate Template Options** gives every option weights. Generated as
it is, it stops at the same message as the Creator's own file. Its `Player{number}` needs a name
of its own, in the file or as `name:` on the command; each weighted option with one choice above 0
is that choice, as Archipelago rolls it, so an unedited template reads as an untouched Creator form.

## Or build a list with the command's options

1. Run `/apmedia yaml` with a slot name and a preset (`movies`, `tv`, `music`, `books` or `mixed`),
   or pick titles, a collection or a playlist; `preset:none` takes only what you count or name.
2. The bot replies with a YAML file and the same summary. Send the file to whoever generates the
   seed.

The YAML's `entries` and `list_info` are written by the bot. Edit the game options if you like; a
change to a list setting takes effect only when the file is attached to `/apmedia yaml` again. A
shorter timer adds checks, and a slot past 10,000 locations stops the whole seed from generating,
so attach the file again after you shorten one. The game page lists every option.

## Play

1. Once the room is up, claim your slot with `!ap claim <slot>`, then run `/apmedia link <slot>`.
   For a room added with `!ap watch`, give its id to both: `!ap claim <id> <slot>` and
   `/apmedia link slot:<slot> watch:<id>`.
2. `/apmedia list` shows what is open, locked or done; `/apmedia status` shows progress, banked
   checks and Wild Tickets.
3. Watch in Plex, or play music and audiobooks through the bot. Checks are sent as you go. Only
   playback after the seed was generated counts.
4. `/apmedia redeem` spends a Wild Ticket on a locked title.
5. `!ap hintpings <slot> dm` sends you hints for your titles in a direct message.

Hints work from any Archipelago text client: `!hint <title>` for one title, `!hint Movies` (or
`Shows`, `Albums`, `Playlists`, `Books`) for a group.

Universal Tracker cannot follow this game: it regenerates one slot on its own, and a Plex Media
slot's ids depend on every Plex Media list in the seed. Use `/apmedia status` and `/apmedia list`
instead.
