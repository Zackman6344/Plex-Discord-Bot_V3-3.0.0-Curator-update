# Plex Media setup guide

## What you need

- Archipelago 0.6.8 or later on the PC that generates the seed.
- The Plex Discord Bot on a Discord server you share with the Plex server's owner, with its Plex
  Media feature turned on.
- A Plex account on the owner's server, linked by the owner, for watches made in Plex to count.
  Music and audiobooks played through the bot in a voice channel count without one.

## Install the world (server owner)

1. Run `/apmedia apworld` in Discord (or `npm run build:apworld` in the bot's folder, which writes
   `dist/plex_media.apworld`).
2. Open the Archipelago Launcher, choose **Install APWorld** and pick `plex_media.apworld`.
3. Restart the Launcher and any other Archipelago program that was open.

**Keep the world installed for as long as a Plex Media seed's room is in use.** The bot's `!ap next`
rebuilds the seed with it, and answers every slot of the room from sphere 1 when it cannot.

## Build a list

1. Ask the owner to link your Plex account: `/apmedia account user:@you plex:<Plex name>`, giving
   its full name or its id. Accept the bot's consent button, and your list can leave out what you
   have already watched. Without a linked account, a list with movies or shows needs
   `unwatched:False`. `/apmedia account plex:none` takes your consent back at any time.
2. Run `/apmedia yaml` with a slot name and a preset (`movies`, `tv`, `music`, `books` or `mixed`),
   or pick titles, a collection or a playlist.
3. The bot replies with a YAML file and a summary: titles, locations, how many titles start open
   and how many the goal needs. Send the file to whoever generates the seed.

The YAML's `entries` and `list_info` are written by the bot. Edit the other options if you like;
the game page lists them.

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
