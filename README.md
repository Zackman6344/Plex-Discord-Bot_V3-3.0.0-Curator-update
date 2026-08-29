# Plex Discord Bot (AI Upgrade)

> This is my personal upgrade of the [Plex Discord Bot v2](https://github.com/danxfisher/Plex-Discord-Bot) originally made by **danxfisher** and updated by **irbyk**. They get all the credit for starting this project and moving it forward — I'm just bolting on AI features, modernizing dependencies, and adding game/trivia stuff.

This bot has been "vibecoded" to speed things up, though I do know what I've changed and have an awareness of what's in here. If you don't vibe with it, use v2.

A multipurpose Discord bot designed to integrate your Plex media server with your Discord community. It handles media requests, library searching, interactive movie trivia, and high-quality music playback directly from your server.

## Requirements

- **Node.js 18 or newer.** Node 16 is EOL and the bot now uses discord.js v14, which requires 18+.
- A Discord bot token (see the V2 setup section below for how to get one).
- *(Optional)* A **Gemini API key** — required for any AI command (`!trivia`, `!curate`, `!vibe`, `!identify`, `!quest`, `!hitster`, etc.). Without it, music and basic Plex commands still work; AI commands will fail at the API call.
- *(Optional)* A running [**Tautulli**](https://tautulli.com/) instance for `!stats`.
- *(Optional)* A **Playnite HTTP server** on the host PC for `!game`, `!launch`, `!backlog`, and the gaming-history half of `!profile`.
- *(Optional)* [**Kometa**](https://kometa.wiki/) and/or Playnite on the host PC for the automated broadcasts described in **Broadcasts & autostart** below.

Some features cost money to use (Gemini API beyond the free tier). Non-AI features don't. If you find the bot referencing my specific media library somewhere, open an issue so I can pull it out.

## Setup

After cloning and running `npm install`, set up your three config files.

> **Use `npm install`, not `npm ci`.** The committed lockfile is older than `package.json` and
> pins discord.js v13, which this bot no longer runs on. `npm ci` would install it anyway, and
> slash commands would silently never register.
 **Two of them are gitignored on purpose** so your tokens never end up in version control — copy the templates and fill them in locally:

```
cp config/keys.example.js config/keys.js
cp config/plex.example.js config/plex.js
```

(On Windows, `copy config\keys.example.js config\keys.js` etc.)

Then edit each one as below.

**`config/keys.js`** — secrets:

```js
module.exports = {
  'botToken'    : 'YOUR_DISCORD_BOT_TOKEN',
  'geminiApiKey': 'YOUR_GEMINI_API_KEY'   // leave blank to disable AI commands
};
```

**`config/plex.js`** — your Plex server. Get your token via [these instructions](https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token). Anything in `options` can be set to whatever you want:

```js
module.exports = {
  'hostname'    : 'PLEX_LOCAL_IP_OR_HOSTNAME',
  'port'        : '32400',
  'https'       : false,
  'token'       : 'PLEX_TOKEN',
  'managedUser' : '',                       // reserved for a future feature
  'options'     : {
    'identifier': 'APP_IDENTIFIER',
    'product'   : 'APP_PRODUCT_NAME',
    'version'   : 'APP_VERSION_NUMBER',
    'deviceName': 'APP_DEVICE_NAME',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};
```

**`config/config.js`** — feature toggles and display:

```js
module.exports = {
  'listenChannel'   : '',                  // limit bot to one channel name; empty = listen everywhere
  'commandPrefix'   : '!',                 // command prefix character(s)
  'playlistsDir'    : 'playlists/',        // where custom user playlists are stored on disk
  'language'        : 'lang/en.js',
  'youtube_quality' : 'lowestaudio',

  'serverName'      : 'My Plex Server',    // shown in stats/help/request messages

  'ownerId'         : '',                  // your Discord user ID — gates owner-only Playnite commands and DM alerts
  'launchRoleId'    : '',                  // optional Discord role allowed to use !launch
  'testGuildId'     : '',                  // register slash commands in this guild only (instant); blank = global, up to 1 hour

  'playniteEnabled' : false,               // toggle Playnite integration
  'tautulliEnabled' : false,               // toggle Tautulli integration
  'tautulliApiKey'  : '',
  'tautulliUrl'     : '',                  // e.g. http://localhost:8181

  // --- Automated broadcasts (Kometa runs + Playnite game launches) — see below ---
  'broadcastChannelId'  : '',              // fallback channel used when the two below are blank
  'kometaChannelId'     : '',              // Kometa run announcements (falls back to broadcastChannelId)
  'gameLaunchChannelId' : '',              // game-launch announcements (falls back to broadcastChannelId)
  'eventServerEnabled'  : false,           // localhost listener for Kometa/Playnite pushes
  'eventServerPort'     : 8799,
  'eventServerToken'    : '',              // optional ?token= shared secret
  'broadcastKometa'        : true,         // Kometa run summaries (start/end/error)
  'broadcastKometaChanges' : true,         // live per-collection updates during a run
  'kometaChangesMinAdds'   : 1,            // only report a collection that grew by ≥ N
  'broadcastGameLaunch'    : true,         // game launches via the Playnite script
  'gamePresenceEnabled'    : false,        // detect games via Discord activity (needs Presence Intent)
  'broadcastStartup'       : true,         // post "System has started" on boot (single channel)

  // Kometa Theater (silly mode) — see below
  'kometaTheaterEnabled'   : false,
  'kometaLogPath'          : 'C:/Kometa/config/logs/meta.log',   // point at your own Kometa meta.log
  'kometaTheaterModel'     : '',           // fast Gemini model; blank = the default model
  'kometaTheaterDelayMs'   : 5000,         // pacing between in-character "transmissions"

  // Archipelago room monitor (see below). All of this is editable from /config → Archipelago.
  'archipelagoEnabled'   : false,
  'archipelagoChannelId' : '',             // channel the room log posts to (its own, not the broadcast one)
  'archipelagoRoomUrl'   : '',             // https://archipelago.gg/room/<id>
  'archipelagoHost'      : '',             // or a host, for a server you run yourself
  'archipelagoPort'      : 38281,          // used with archipelagoHost
  'archipelagoSlot'      : '',             // an existing slot name in that multiworld
  'archipelagoPassword'  : '',             // only if the room has one
  'archipelagoBatchSeconds'    : 5,        // seconds of room log collected per Discord post
  'archipelagoProgressionOnly' : false,    // relay item sends only when they are progression
  'archipelagoShowItems'  : true,          // which categories of log line get relayed
  'archipelagoShowHints'  : true,
  'archipelagoShowChat'   : true,
  'archipelagoShowJoins'  : true,
  'archipelagoShowGoals'  : true,
  'archipelagoShowMisc'   : true,
  'archipelagoShowDeaths' : false          // DeathLink; reconnects the room to add the tag
};
```

Then start the bot:

```
node index.js
```

The console needs to stay open for the bot to keep running. The Docker setup in this repo uses Node 20.

### Editing settings from Discord

Once the bot is running and you've set `ownerId`, you (the owner) can change most `config.js`
settings without touching files: run **`/config`** (or `!config`). It opens a private panel —
pick a setting from the dropdown, then a pop-up modal (for text/numbers) or Enable/Disable
buttons (for toggles). Changes save instantly and **persist across restarts**.

- Saves are written to `data/config.overrides.json`, which is layered over the defaults in
  `config/config.js` on every boot. Delete that file to reset everything back to the file
  defaults.
- Most settings take effect immediately. Two are marked **(restart)** in the panel —
  `eventServerEnabled` and `eventServerPort` — because the event listener is bound once at boot.
- Discord/Gemini/Plex tokens (in `config/keys.js` and `config/plex.js`) are **not** editable
  from Discord by design; edit those files directly.
- If `ownerId` is still blank, `/config` runs in a one-time bootstrap mode so you can set the
  owner from Discord; after that it's owner-only.

## 📢 Broadcasts & autostart

Three optional conveniences for a Windows host that runs the bot alongside **Kometa** and **Playnite**:

1. **Announce when Kometa finishes a run.**
2. **Announce when a game is launched** on the PC (with the game's cover art), via Playnite.
3. **Auto-start the bot at login.**

The first two share one small **localhost-only** HTTP listener the bot opens when
`eventServerEnabled` is `true` (bound to `127.0.0.1` — never reachable from another machine).
Kometa and Playnite push events to it; the bot posts an embed to `broadcastChannelId`.

**1. Turn it on.** In `config/config.js`, set the broadcast channel(s) — right-click a channel
with Discord Developer Mode on → *Copy Channel ID*. Use `kometaChannelId` and
`gameLaunchChannelId` to send each broadcast type to its own channel, or just set
`broadcastChannelId` to send both to one place (it's the fallback for whichever specific one you
leave blank). Then flip `eventServerEnabled` to `true` and optionally set an `eventServerToken`
(a made-up secret). Restart the bot — the boot health check / `!diag` will show
`EventServer: listening on 127.0.0.1:8799`. (You can also set these later from Discord with
`/config`.)

On every boot the bot posts a **"System has started"** card to each assigned broadcast channel
(showing the event-listener status and which broadcasts are enabled) so you can confirm it's live
— turn this off with `broadcastStartup: false` if you don't want a message on each restart.

You can smoke-test the listener without Kometa/Playnite:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8799/kometa?token=YOUR_TOKEN" -Method Post `
  -ContentType application/json `
  -Body '{"event":"run_end","run_time":"00:14","collections_modified":3,"items_added":42}'
```

**2. Point Kometa at it.** In Kometa's `config.yml`:

```yaml
settings:
  webhooks:
    run_end: http://127.0.0.1:8799/kometa?token=YOUR_TOKEN
    error:   http://127.0.0.1:8799/kometa?token=YOUR_TOKEN
    changes: http://127.0.0.1:8799/kometa?token=YOUR_TOKEN   # live per-collection updates
```

(Drop the `?token=...` if you left `eventServerToken` blank.)

The `changes` webhook is what powers the **live, as-it-runs updates**: during a run, Kometa fires
one per collection that changes, and the bot posts a card when a collection is **created**, **grows**
(by at least `kometaChangesMinAdds` items), or has items **requested for the server** (Radarr/Sonarr
adds — Kometa's "recommendations to add"). Each card lists the added titles and the collection
poster. On a big first run this can be chatty — raise `kometaChangesMinAdds` (or turn off
`broadcastKometaChanges`) to quiet it down. Run summaries (`run_end`) and live changes toggle
independently.

**3. Point Playnite at it.** In Playnite: *Main menu → Settings… → Scripts*, set the language
selector to **PowerShell**, and paste the body of [`scripts/playnite-game-start.ps1`](scripts/playnite-game-start.ps1)
into the **"Execute script after starting a game"** box. Edit the `$port` / `$token` at the top
to match your config. **Note:** this only fires for games launched *through Playnite* — a game
started directly from Steam won't trigger it. For launcher-agnostic detection, use the presence
option below.

**Game-launch detection — two options.** There are two ways to broadcast game launches; use either
or both:

- **Playnite script** (`broadcastGameLaunch`, above) — richest card (cover art, store, platform),
  but only for games launched *through Playnite*.
- **Discord activity** (`gamePresenceEnabled`) — the bot watches your Discord "Playing X" status
  and posts when you start a game on **any** launcher (Steam, Playnite, Epic, …). This is usually
  what you want if you launch games straight from Steam. It requires two one-time steps:
  1. In the [Discord Developer Portal](https://discord.com/developers/applications) → your app →
     **Bot** → enable the **Presence Intent** (a "Privileged Gateway Intent").
  2. On your own Discord client: **Settings → Activity Privacy →** turn on *"Share your detected
     activities with others"* (and make sure game activity is being detected).

  Then set `gamePresenceEnabled: true` and **restart** the bot (the intent is chosen at startup).
  Game-launch broadcasts go to `gameLaunchChannelId`. If you enable *both* methods, a Playnite
  launch may post twice — pick one if that bugs you.

**4. Auto-start at login.** From your **main install directory** (not a worktree), run once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup-shortcut.ps1
```

That gives you a Startup-folder entry which launches the bot hidden (via `scripts/start-bot.vbs`)
at every login, plus three desktop shortcuts:

| Shortcut | What it does |
|---|---|
| **Start Plex Bot** | Starts it hidden, the same way login does |
| **Stop Plex Bot** | Stops it, and says so |
| **Plex Bot Status** | Whether it is running, how long for, and the tail of today's log |

Stopping matches on the full path to this install's `index.js` in the running process, so it
cannot take down an unrelated Node app on the same machine. The bot logs to `data/logs/`;
`data/logs/startup-stderr.log` catches anything that goes wrong too early for the logger,
truncated on each launch. Node must be on your PATH, which the installer checks rather than
letting you find out at the next reboot. To undo all of it, run
`scripts\uninstall-startup-shortcut.ps1`.

### 🎭 Kometa Theater (silly mode)

An optional, for-fun mode that **narrates a Kometa run in-character** instead of posting factual
change cards. As Kometa works, each collection reports to the server with its own themed
personality, paced deliberately on Discord's side (Kometa itself is never slowed).

- **Each collection has its own persona**, seeded from its name (every rating tier, every Cage
  collection, etc. is distinct), minted once via a fast Gemini model and remembered.
- A collection that is **brand-new *and* gained items** comes alive and introduces itself; a
  collection the bot already knows **reports in** every run (commenting on any additions/removals).
- A collection that's **unseen *and* gained nothing** is just **garbled static** — an unidentified
  signal. (No Gemini spent on those.)
- **No cap** — it's bounded only by how many collections Kometa processes.

**How it works:** it tails Kometa's `meta.log` for per-collection coverage (that's why it can see
even the unchanged ones) and uses your `changes` webhooks for the add/remove detail, posting to your
`kometaChannelId`. It **replaces** the factual `changes` cards while on.

**Turn it on:** set `kometaTheaterEnabled: true`, point `kometaLogPath` at your Kometa log, and set
`kometaTheaterModel` to a fast model your Gemini key can use (blank keeps the default). Restart the
bot. `kometaTheaterDelayMs` tunes the pace. Heads-up: it reads Kometa's *log wording*, so a future
Kometa version could change the format — it degrades gracefully (fewer lines) and never crashes the
bot, but may need a tweak.

## 🏷️ Inferred tags (filling gaps Plex leaves)

Plex only returns a track's moods and styles on a direct per-track lookup, never in a library
listing — and on a typical library most tracks have no mood data at all. That matters for `/vibe`,
which searches by tag: a track Plex never tagged can't be found by tag, so the same well-tagged
minority would play on repeat forever.

Two things address that, both tunable from Discord:

**A discovery quota.** A share of every `/vibe` queue is reserved for random untagged tracks —
25% by default. It is a share *of* the queue, not extra on top — a 5-track request stays 5
tracks, with roughly one of them a wildcard. Small queues are handled by rounding the fraction
probabilistically rather than down, so 25% of a 3-track queue means a wildcard three runs in four
rather than never; the average over runs is the percentage you asked for at every queue size.
Set it with `/tags discovery percent:<0-100>`, or 0 to
turn it off. Repeats are also avoided across the last 300 tracks served (`/tags memory`).

**A local tag sidecar.** After a run, the bot offers tags for the tracks it queued that Plex has
nothing for, and you review them **one track at a time**:

- **Approve** writes that single track to `data/inferred_tags.json` immediately.
- **Reject** writes nothing.
- **Tell it why & retry** opens a box for what it got wrong ("this is a sea shanty, not
  synthwave") and regenerates that track's suggestion with your note in mind. The note is kept,
  so a later run doesn't repeat the same mistake.

Nothing is ever written to Plex, and **Plex always wins**: wherever Plex has real data for a
dimension, that is what gets used, no matter what the sidecar holds. If the agent later supplies
data for a track, the inferred entry is retired automatically (and stays visible in `/tags list`
so you can see what happened).

Approved tags then make those tracks findable by `/vibe`, and anywhere they appear they're
labelled *(tags inferred, not from Plex)*.

`/tags coverage` estimates how much of the library Plex has tagged. `/tags export` writes a
portable copy — including each track's file path on the Plex host — for tagging tools outside
the bot.

## 🧾 Logs

The bot keeps two logs under `data/logs/`, both plain text, both pruned after 14 days:

- `bot-YYYY-MM-DD.log` — everything the console prints, minus the colours.
- `commands-YYYY-MM-DD.jsonl` — one line per event: a command being invoked (who, where, which
  arguments, prefix or slash or button), its outcome (ok / failed, how long it took, the stack if
  it threw), and every message the bot posted in response.

Read them back with:

```
npm run logs                     # last 15 commands, with what the bot replied
npm run logs -- --errors         # only the ones that failed
npm run logs -- --command=vibe   # one command
npm run logs -- --since=30m      # last half hour (s/m/h/d)
npm run logs -- --n=50           # more of them
npm run logs -- --stats          # totals and busiest commands
npm run logs -- --raw            # the underlying JSONL
```

Output is tied back to the command that caused it, so a session reads as a transcript:

```
11:43:14  slash vibe "1 hour of cyberpunk nightclub"  by zackman in #music
   ok 8423ms
   <- 🎵 **Vibe Check Initializing...**
   << 🎧 **Vibe Locked:** cyberpunk nightclub — queuing 5 tracks
   << [embed] 🏷️ Neon Rain — by Test Artist — moods: Ominous, Nocturnal
```

Your tokens are redacted before anything is written. Command arguments and the bot's replies are
stored as written, so treat `data/logs/` as being as private as the channels the bot posts in.
Set `PLEXBOT_COMMAND_LOG=0` to disable the command log, or `PLEXBOT_LOG_TO_FILE=0` for the
console mirror.

## 📚 Command Directory

Every command below works two ways: with the `!` prefix, or as a slash command of the same name.
Type any command by itself (e.g. `!hitster`, `!playlist`) to open its specific menu.

### Slash commands

All commands register with Discord on boot. With `testGuildId` set they appear in that one server
instantly; left blank they register globally and can take up to an hour to show up. Restart the bot
after adding or renaming a command so the set re-registers.

A few take a required option, because they can't do anything without one:

| Command | Required option |
| ------- | --------------- |
| `/vibe` | `vibe:` — the setting or mood. Optional `ttrpg:` skips the follow-up question |
| `/sonic` | `target:` — a vibe, or a specific song to build the station around |
| `/releasesurvival start` | `category:` — movies, shows or albums |
| `/survive start` | none, but `start` is the subcommand that begins a game (`difficulty:` is optional) |

Run `npm run check:slash` after editing any command's `slash` block. Registration is
all-or-nothing, so a single malformed spec makes *every* slash command disappear at once.

### 🤖 AI Arcade & Minigames

- `!hitster` — Competitive turn-based music timeline game. Guess the release year!
- `!trivia` — Classic movie & TV show plot trivia.
- `!badplot` — Guess the movie from the AI's terrible, sarcastic summary.
- `!castingcouch` — Guess the project based on vague job descriptions for the actors.
- `!quotethebard` — Guess the song translated into Shakespearean English.
- `!releasesurvival` — Rapid-fire *Higher or Lower* release year survival game.
- `!rumor` — Guess the modern movie rewritten as a D&D tavern quest hook.
- `!reviewbomb` — Guess the movie based on an unhinged, petty 1-star review.
- `!survive` — Interactive text-adventure. Can you survive the movie's plot?

### 🎵 Music & Audio Controls

- `!play [song/url]` — Add a song to the queue.
- `!pause` / `!resume` / `!stop` / `!skip` — Standard playback controls.
- `!volume [1-100]` — Adjust the bot's volume.
- `!loop` / `!shuffle` — Modify how the queue plays.
- `!viewqueue` / `!clearqueue` — Manage the current playlist.
- `!song` / `!album` / `!artist` — Search Plex for specific audio.
- `!youtube [url or search]` — Play a YouTube URL, or search and play the top result.
- `!playlist` — Access the custom playlist manager (create, add, play).
- `!mood [mood]` — Random song matching your given mood.
- `!sonic [vibe or song]` — Plex Sonic Analysis playlist built around a vibe or an anchor track.
- `!seek [time]` — Jump to a position in the current track.

### 🍿 Plex & Media Utilities

- `!request` — Anonymously request movies, shows, or albums for the server.
- `!curate` — Custom-tailored AI media recommendations.
- `!groupwatch` — Multiplayer curator to find a movie a group can agree on.
- `!quest` — Custom movie marathon based on a theme.
- `!identify` — Find that "tip of your tongue" movie from a vague description.
- `!vibe` — Generate a playlist or media queue based on a vibe.
- `!library` — View or search server libraries.
- `!random` — Random media pick.
- `!list` — Page through, search, or reset the last set of search results.

### 🧩 Archipelago room monitor

Off unless `archipelagoEnabled` is set. The bot joins a multiworld as a read-only tracker client and relays the server log into Discord.

**The easiest way in is `/config` → Archipelago**, which holds every setting for one room: its URL (or host and port), the slot to watch from, its password, the channel the log posts to, the batch window, and the seven category filters. Saving any of them re-points the bot immediately, with no restart. That room shows up as watch `#0`, and because `/config` owns it, `!ap` will not let you edit it from the command line.

`!ap` adds further rooms alongside it, each posting to the channel it was created in:

- `!ap watch [room url or host:port] [slot name]`: Start relaying a room's log here. The slot name has to match a real slot in that multiworld; the bot attaches to it as an observer, receives no items, and cannot affect the person playing it.
- `!ap list` / `!ap status [id]`: Watches, their connection state and how many lines each has relayed.
- `!ap filter [id] [items|hints|chat|joins|goals|deaths|misc] [on|off]`: Pick which lines get posted.
- `!ap progression [id] on`: Item sends only when they are progression. The usual fix for a noisy async.
- `!ap password [id] [password]`: Set or clear a room password. The prefix form deletes your message afterwards.
- `!ap unwatch [id]` / `!ap retry [id]`: Stop a watch, or reconnect one the server refused.

Two things worth knowing before switching it on: the room sees a client join on the slot being watched, and a held connection stops a room hosted on archipelago.gg from idling to sleep. Watches survive a restart and reconnect on their own, including after a hosted room comes back on a new port.

### 🛠️ Owner / Admin commands

- `!config` *(best as `/config`)* — Owner-only settings wizard. Opens a private panel to view and change most `config.js` settings from inside Discord (prefix, server name, integration toggles, broadcast settings, etc.). See **Editing settings from Discord** below.
- `!diag` *(alias: `!plextest`)* — Full diagnostic: Plex, Gemini, Tautulli, Playnite, event server. Bot also runs this every 15 minutes in the background and DMs the owner (if `ownerId` is set) on any status transition.
- `!stats` — Combined Plex (via Tautulli) + Playnite statistics.
- `!profile` — AI-generated D&D character sheet based on your gaming history.
- `!game [title]` — Search the host's game library and show metadata.
- `!launch [title]` — Boot a game on the host PC.
- `!backlog` — Random unplayed game from the library.
- `!pickgame [keywords]` — AI picks something from the game library for you.
- `!buildcharacter` / `!mysheet` — Create and view your AI D&D character sheet.
- `!tags` — Review locally inferred track tags, library tag coverage, and the `/vibe` rotation settings. See **Inferred tags** below.
- `!restart` — Restart the bot process.
- `!ulala` — Toggles a certain YouTube track. Inherited; left in.

> Most of these are gated on `playniteEnabled` and/or `ownerId` in `config/config.js`.

## 💬 Support & Community

If you have questions about this specific version or want to see it in action, my personal Discord: <https://discord.gg/dakj4au>

If you're feeling generous, I have a Patreon — random projects (Minecraft addons, a BO3 Twitch integration tool, and this thing). 🔗 [www.patreon.com/zackman634](https://www.patreon.com/zackman634). There's a free tier; active community members or paid patrons get access to my personal Plex server.

---

<details>
<summary><b>Click here to view the original Bot Instructions and Readme from V2</b></summary>

> ⚠️ The text below is preserved from the original V2 README. A few specifics are now out of date in this fork — most notably **Node.js 16 is no longer supported (use 18+)**, the `keys.js` file now also takes a `geminiApiKey`, and the Dockerfile here uses `node:20`. The current setup is documented at the top of this README.

Original README

Note : this is a personal upgrade of the Plex Discord bot made by danxfisher available here : https://github.com/danxfisher/Plex-Discord-Bot
He should have all the credit for starting this project.

Plex Discord Bot

You need Node.js v16

Installation

Clone the repo or download a zip and unpackage it.

If you to use Docker , skip the points 2 and 3.

Install Node.js: https://nodejs.org/

Navigate to the root folder and in the console, type npm install

You should see packages beginning to install

Once this is complete, go here: https://discordapp.com/developers/applications/me

Log in or create an account

Click New App

Fill in App Name and anything else you'd like to include

Click Create App

This will provide you with your Client ID and Client Secret

Click Create Bot User

This will provide you with your bot Username and Token

Take all of the information from the page and enter it into the config/keys.js file, replacing the placeholders.

Navigate to the config/plex.js file and replace the placeholders with your Plex Server information

To get your token, following the instructions here: https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token

The identifier, product, version, and deviceName can be anything you want

Once you have the configs set up correctly, you'll need to authorize your bot on a server you have administrative access to.  For documentation, you can read: https://discordapp.com/developers/docs/topics/oauth2#bots.  The steps are as follows:

Go to https://discordapp.com/api/oauth2/authorize?client_id=[CLIENT ID]&permissions=3197953&scope=bot where [CLIENT_ID] is the Discord App Client ID

Select Add a bot to a server and select the server to add it to

Click Authorize

You should now see your bot in your server listed as Offline.

If want want to use Docker, just go to the Docker section.

To bring your bot Online, navigate to the root of the app (where index.js is located) and in your console, type node index.js

This will start your server.  The console will need to be running for the bot to run.

If I am missing any steps, feel free to reach out or open  an issue/bug in the Issues for this repository.

Docker

If you are using Docker, you can use these commands to build and start your Plex bot (after downloading the source code and set the config file) :

go to your plex bot folder (cd your/plex/bot/folder)

docker build -t image/plexbot .

docker run -p 32400 -d --name plexbot image/plexbot

wait a few seconds and your bot should join your server and be active.
You can use docker logs plexbot to see the log of the bot (use docker logs -f plexbot if you want realtime log).

Note : you may need the sudo command/admin access depending of your user right.

Usage

Join a Discord voice channel.

Upon playing a song, the bot will join your channel and play your desired song.

Some Commands

!? : print all of the available commands.

!plexTest : a test to see make sure your Plex server is connected properly.

!clearqueue : clears all songs in queue.

!nextpage : get next page of songs if desired song is not listed.

!pause : pauses current song if one is playing.

!play <song title or artist> : bot will join voice channel and play song if one song available.  if more than one, bot will return a list to choose from.

!playsong <song number> : plays a song from the generated song list.

!removesong <song queue number> : removes song by index from the song queue.

!resume : resumes song if previously paused.

!skip : skips the current song if one is playing and plays the next song in queue if it exists.

!stop : stops song if one is playing.

!viewqueue : displays current song queue.

!playlist ? : displays all the playlist related commands.

Customization

Update the config\keys.js file with your information:

module.exports = {
  'botToken'      : 'DISCORD_BOT_TOKEN',
};


And update the config\plex.js file with your Plex information:

module.exports= {
  'hostname'    : 'PLEX_LOCAL_IP',
  'port'        : 'PLEX_LOCAL_PORT',
  'https'       : false,
  'token'       : 'PLEX_TOKEN',
  'managedUser' : 'PLEX_MANAGED_USERNAME',
  'options'     : {
    'identifier': 'APP_IDENTIFIER',
    'product'   : 'APP_PRODUCT_NAME',
    'version'   : 'APP_VERSION_NUMBER',
    'deviceName': 'APP_DEVICE_NAME',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};


You can find us on Discord : https://discord.gg/c39aRhB
Join it if you want to discuss or have any suggestions.

If you see any bugs use the issue tracker.  Thanks!

To Do:

????

Completed:

[x] youtube command.

[x] refactor the code base.

[x] add language support.

[x] plex mood support.

[x] plex playlist support.

[x] plex artist support.

[x] shuffle and loop support.

</details>
