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
- *(Optional)* [**Calibre**](https://calibre-ebook.com/) with its content server running, or `.epub` files next to the audio, for the audiobook read-along (`!book text`). See **Reading along** below.
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

  // Calibre, for the audiobook read-along (see "Reading along"). Read-only. /config → Integrations.
  'calibreUrl'       : 'http://127.0.0.1:8080', // Calibre's content server; blank = Calibre off
  'calibreLibraryId' : '',                 // blank = the server's default library
  'calibreUsername'  : '',                 // only if you turn on Calibre's login
  'calibrePassword'  : '',                 // never put the login in the URL; it is refused there

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
  'archipelagoSkipGoaled'      : true,     // hide items sent to slots that already finished
  'archipelagoInferFinished'   : true,     // also count a 100%-checked slot as finished
  'archipelagoTrackerPollMinutes' : 15,    // how often to re-read the room tracker for that
  'archipelagoCatchup'         : true,     // post what the relay missed while down (config.js only)
  'archipelagoColorLines'      : true,     // colour items by class (desktop and web only)
  'archipelagoItemMarkers'     : true,     // mark items by class; plain text, works on mobile
  'archipelagoInstallDir' : 'C:\\ProgramData\\Archipelago', // install !ap next rebuilds logic from; blank = off
  'archipelagoPython'     : '',            // Python for that (3.13 for AP 0.6.7); blank = py launcher
  'archipelagoShowItems'  : true,          // which categories of log line get relayed
  'archipelagoShowHints'  : true,
  'archipelagoShowChat'   : true,
  'archipelagoShowJoins'  : true,
  'archipelagoShowGoals'  : true,
  'archipelagoShowMisc'   : true,
  'archipelagoShowDeaths' : false,         // DeathLink; reconnects the room to add the tag

  // Audiobooks and podcasts (see below). All editable from /config → Audiobooks, all live.
  'audiobooksEnabled'            : false,  // turn /book on; off = no library reads, no proxy port
  'audiobooksExcludeFromMusic'   : true,   // keep catalogued books out of music pickers and search
  'audiobookSaveSeconds'         : 15,     // bookmark save interval (5-300); the most a crash can lose
  'audiobookDefaultSpeed'        : '1',    // a listener's first speed: '0.75' '0.9' '1' '1.1' '1.25' '1.5' '1.75' '2'
  'audiobookIdleLeaveMinutes'    : 10,     // a paused book leaves voice after this (1-180)
  'audiobookResumeRewindSeconds' : 10,     // rewind after 5+ min away, 3x after a day (0-120)
  'audiobookTextEnabled'         : true,   // !book text and the card's 📖 (see "Reading along")
  'audiobookTextSidecars'        : true,   // also look for .epub files next to a book's audio

  // Voice (see "If voice audio stutters"). Both editable from /config → Voice, both live.
  'processPriority'    : 'above_normal',   // or 'normal' if a game running beside the bot suffers
  'voiceHealthEnabled' : false             // per-minute voice log behind !voicehealth
};
```

Then start the bot:

```
node index.js
```

The console needs to stay open for the bot to keep running. The Docker setup in this repo uses Node 20.

### Editing settings from Discord

Once the bot is running and you've set `ownerId`, you (the owner) can change most `config.js`
settings without touching files: run **`/config`** (or `!config`). It opens a panel listing the
current values by section. `/config` shows it only to you; `!config` posts it in the channel,
where anyone can read it but only you can use it. Pick a section from the first menu, then a
setting from the menu below it. Text and numbers open a pop-up modal, toggles get
Enable/Disable buttons, and a setting with fixed options (YouTube audio quality) gets a menu of
its own. Changes save instantly and **persist across restarts**.

- Saves are written to `data/config.overrides.json`, which is layered over the defaults in
  `config/config.js` on every boot. Delete that file to reset everything back to the file
  defaults.
- Most settings take effect immediately. Four are marked **(restart)** in the panel, because
  each starts or skips something at boot: `eventServerEnabled` and `eventServerPort` bind the
  event listener, `gamePresenceEnabled` decides whether the bot asks Discord for the presence
  intent, and `kometaTheaterEnabled` decides whether the Kometa log is tailed. **Turning
  `kometaTheaterEnabled` on silences the Kometa cards until that restart**, since webhooks go to
  the theater as soon as it is saved and the theater has not started.
- The sections are General, Access, Integrations, Broadcasts, Archipelago, Audiobooks and Voice.
  Every Audiobooks and Voice setting applies at once, with no restart: turning
  `audiobooksEnabled` on makes `/book` work on its next use, and `processPriority` and
  `voiceHealthEnabled` switch over as soon as they are saved.
- Integrations holds the four Calibre settings for the read-along. `calibrePassword` is masked in
  the panel like the Tautulli API key and never written to the logs, and a `calibreUrl` with a
  login typed into it is refused.
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

At every login the bot comes up in a console window titled **Plex Discord Bot**. **Closing that
window stops the bot.** You also get three desktop shortcuts:

| Shortcut | What it does |
|---|---|
| **Start Plex Bot** | Starts it, same as login does |
| **Stop Plex Bot** | Stops it without hunting for the window |
| **Plex Bot Status** | Whether it is running, how long for, and the tail of today's log |

If the bot exits on its own, the window stays open with the exit code so you can read what
happened instead of watching it vanish.

**Only one copy runs at a time.** Starting the bot while it is already running, from any shortcut
or by hand, ends the new copy before it logs in, with exit code 1 and a line naming the running
copy's PID. `scripts\stop-bot.ps1` finds only a copy started by the shortcuts or the start scripts;
end one started by hand through its window or that PID. Two copies logged in with the same token both answered every command and kept
separate queues, so a Stop click reached one of them and the other's queue played at the next
`!play`. The check keys on the bot token, so a second install or a worktree configured with the
same token is refused too. It only sees copies on the same operating system: a copy inside a
Docker container or WSL and a copy outside it do not see each other, and neither does a copy on
another machine.

**The window shows no log, on purpose.** A Windows console that enters selection mode — one click
or drag inside it is enough — blocks whatever process owns it on its next write, until the
selection is cleared. With the log mirrored there, a stray click froze the entire bot: it stopped
relaying, stopped answering commands, and the log file stopped dead at that moment with nothing in
it to say why. Read the log with **Plex Bot Status** or `scripts/status-bot.ps1` instead. Running
`node index.js` by hand still prints everything.

Prefer no window at all? Run the installer with `-Hidden` and it wires up `scripts/start-bot.vbs`
instead; stopping is then the **Stop Plex Bot** shortcut. Either way, stopping matches on the
full path to this install's `index.js` in the running process, so it cannot take down an
unrelated Node app on the same machine.

The bot logs to `data/logs/`. Node must be on your PATH, which the installer checks rather than
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

## 📖 Audiobooks and podcasts

`/book` plays audiobooks and podcasts that live in your Plex **music** library, and remembers each
person's place in each one: chapters, ±30 s, speed from 0.75x to 3x without the chipmunk effect,
a sleep timer, a shelf of what you are partway through, and hours-listened stats. The full command
list is under **Command Directory** below.

**Turning it on.** It is off by default. As the owner, run `/config`, open **Audiobooks**, and
enable **Audiobooks and podcasts (/book)**. No restart. The first `/book play` or `/book library`
after that (or the next boot) reads your music library once in the background (about 20 seconds
on a large library) to work out which albums are books; until that finishes, `/book play` says it
is still reading. After that it checks Plex for changes once an
hour, so a book you add shows up within the hour, and `/book rescan` (owner only) re-reads it on
demand.

**What counts as a book.** The bot looks at folders on disk rather than Plex albums, because a
hand-ripped library rarely lines up album-for-book. A folder of at least 2 hours becomes a book
when its tracks are long (a median of 15 minutes or more), when its name says so ("unabridged",
"audiobook", "read by", GraphicAudio), or when it is a long run of low-bitrate mono files. A folder
whose tracks are mostly numbered episodes of 20 minutes or more is a podcast. Hour-long music mixes
stay music: nothing is decided by track length alone. `/book library` shows what it found, and
`/book rescan` also names the five longest folders of 2 hours or more that it left as music, so you
can pull one in, and the books whose part order it is unsure of.

**Books stay out of music.** While `audiobooksExcludeFromMusic` is on (the default), catalogued
books and podcasts never come up in `!random`, `!mood`, `/vibe`, `/sonic`, Hitster, `/quotethebard`,
`!list` browsing or smart Plex playlists. A search such as `!play`, `!album` or `!artist` still
shows its music hits, and adds a line pointing at the book instead:
"📚 Also in your books: Title (Author), `/book play title`". When a full page of results is mostly
chapters, a lone song on it is listed for you to pick rather than played, and `!nextpage` still
reaches the next page. The AI recommenders (`!curate`,
`!groupwatch`, `!quest`) and Release Survival's albums leave books out too, and `!identify`'s
vault mode shows each book as one suspect rather than one per chapter. A regular (non-smart) Plex
playlist plays exactly what you put in it. All of a podcast artist's albums stay out of music while
that podcast is catalogued, a soundtrack album included. No override gives back one album: the
only ways to return them to music are excluding the podcast in the overrides file or turning
`audiobooksExcludeFromMusic` off. Turning
`audiobooksEnabled` back off does not let books back into music once they have been catalogued;
turning `audiobooksExcludeFromMusic` off does.

**Sharing the voice channel with music.** One guild plays either music or a book, never both.
`/book play` refuses while music is playing or loading (stop it with `!stop` first). Music
requested during a book is queued with a short reply ("📚 Queued behind Ana's book (2 waiting).")
and starts when the listener runs `/book stop` or presses the card's Stop, or when someone runs a
bare `!play` after that. A sleep timer, leaving voice or finishing the book never starts music on
its own. While a book plays, `!pause`, `!resume`, `!skip` (one chapter forward) and `!stop` act on
the book for anyone allowed to control it, and `!stop` also clears the music queue. Hitster cannot
start during a book, and a book cannot start during a Hitster game.

**Who controls a book.** The person who started it controls everything. The bot owner, and anyone
in the book's voice channel while the listener has left it, may pause or stop it. Everyone has
their own shelf and stats, and a place is always saved to the listener, never to whoever pressed
a button.

**Your place.** It is saved every 15 seconds while playing and on every pause, jump, stop and
shutdown, so a crash loses at most 15 seconds, and resuming after more than 5 minutes rewinds 10
seconds (30 after a day) so you hear the end of the last sentence again. A book is only marked
finished when its last part plays out, when you run `/book finish`, or when you press **Mark
finished** on the card (offered when you stop within 2 minutes of the end); stopping near the end
never finishes it for you. Playing a finished book starts it again; playing a podcast you had
caught up on starts at its first new episode. A podcast plays in episode order, and a new season
added to the same folder that numbers its episodes from 1 again plays after the season before it.

**Fixing the catalog by hand.** Create `data/book_overrides.json` (the bot only ever reads it) to
correct series, order, titles or what counts as a book. Every key is optional:

```json
{
	"authors": {
		"jane-author": { "series": "The Example Cycle", "order": { "first book": 1, "second book": 2 } }
	},
	"works": {
		"jane-author/second-book": { "sequence": 2.5, "narrator": "Sam Reader" },
		"jane-author/box-set": { "partOrder": ["01 Intro.mp3", "02 Chapter 1.mp3", "03 Chapter 2.mp3"] },
		"some-artist/not-a-book": { "exclude": true }
	},
	"include": ["M:/Music/Some Artist/Radio Drama"],
	"exclude": ["M:/Music/Some Artist/Two Hour Live Set"],
	"podcastArtists": ["12345"]
}
```

- `works` is keyed by the id `/book library` shows (`author/title`). `partOrder` lists file names
  in play order; files you leave out keep their order after the listed ones. `title`, `series`,
  `sequence`, `narrator` and `edition` override what was detected, `exclude: true` drops the work,
  and `pinId` gives it an id that survives a folder rename.
- `include` and `exclude` take a folder exactly as `/book rescan` prints it (slash direction and
  case do not matter), or a Plex album ratingKey. For a box set spread over sibling folders, use
  the parent folder.
- `podcastArtists` adds artists (by Plex ratingKey) to keep out of music entirely, for podcast
  artists the detector missed. A detected podcast's artist is already kept out, so a new episode
  album stays out of music before the next rescan sees it.
- `authors` sets a series for every book by that author, with `order` giving each title its
  number.

Run `/book rescan` after editing it. A typo in the JSON is logged and reported by `/book rescan`,
and the file is ignored until it parses.

**Files.** `data/book_catalog.json` is the catalog (rebuilt from Plex if you delete it).
`data/book_bookmarks.json` holds everyone's places, keyed by Discord user ID, with an hourly backup
beside it in `book_bookmarks.json.bak` that the bot loads automatically if the main file is ever
found damaged. Both, and the overrides file, are gitignored. If a bookmark write fails, the card
shows a warning and the command log gets a `book-save-failed` line (`npm run logs -- --raw`).

### 📜 Reading along: the book's text in your DMs

While you listen, the bot can send you the book's text a page at a time, turning with the
narration. It needs an ebook of the same book, either in Calibre or as an `.epub` next to the
audio files. It is on by default (`audiobookTextEnabled`, `/config` → Audiobooks). No ebook is downloaded or
parsed until someone uses it; a book starting only triggers a quick check (a Calibre search and a
folder listing) that decides whether the card shows 📖.

| Command | What it does |
| ------- | ------------ |
| `!book text on` | Turns the read-along on for you. With a book playing, a page arrives in your DMs at once; otherwise the next book you play opens one. Remembered for you across books and restarts until you turn it off. |
| `!book text off` | Turns it off; the DM page says so. |
| `!book text now` | Sends a fresh page at the bottom of your DMs. The old one becomes "📖 This page moved ↓". |
| `!book text` | Whether it is on for you, where your book's text comes from, its word count, and how closely it lines up. |
| `!book link <title> <ebook>` | Owner only: tie a book to its ebook by hand. Forms below. |

On `/`: `/book text mode:on` (or `off`, `now`, or no mode for the status) and
`/book link title:<book> ebook:<id, ISBN, path, off or auto>`.

**The page.** One DM message, edited in place. Each page is about 180 words, roughly a minute of
narration at 1x. Its buttons:

- ◀ Page and ▶ Page browse the book. The page stops following the narration until you press 📍.
- 📍 Now jumps to where the narration is and follows again.
- ↪ Play from here moves the audiobook to the start of the page you are reading, and resumes it if
  it was paused.
- ✖ Off turns the read-along off.

Following never skips a page, even at 3x; it turns at most once every 12 seconds. When the book
stops, the page says so and loses its buttons. The first time a book's text is used the bot reads
the ebook once; if that takes more than a moment the DM says "⏳ Preparing the text of The Way
of Kings (first time only)…" and turns into the page when it is done. After that the text is kept in `data/book_text/`
(gitignored), so it works with Calibre closed.

**📖 on the book card.** Shows the current page as a private reply only the person who pressed it
can see. The button appears only on a book whose ebook was found. **The listener can use it from
anywhere; anyone else only while they are in the book's voice channel**, since they hear the same
words. The listener's page has ◀ ▶ 📍 ↪ and 📩 Follow in DMs in place of ✖ Off. Anyone else gets
◀ ▶ 📍 only: they cannot move the listener's book, and DM follow-along stays the listener's. Every
click checks the voice channel again, so someone who leaves it gets "🔊 Join `<channel>` to read
along." in place of their page, and anyone outside it gets that line and no text from the start.

**If your DMs are closed** to the server, `!book text on` says so; use 📖 instead. When a page
would open by itself (the read-along is on and you start a book), the bot posts one short line in
the card's channel instead, at most once per book session, with no book text and no ping.

**How close it follows.** There is no speech recognition. A track named after a chapter pins that
chapter's text to it, and between those the bot goes by reading pace. Measured on The Way of Kings:
70 of its 83 tracks are named after chapters, and inside one the page is within about ±9% of the
voice (about 3 minutes in a 30-minute chapter). A book split into hour-long files has only pace to
go on: about 12 minutes off on average, 20 at worst. Every page footer says "≈ Approximate" and
"chapter-level" or "estimated from pace". **Dramatized editions (GraphicAudio, full cast) are
followed the same way and also say "dramatized edition"**, because their script is adapted and the
words you hear are not always the words on the page. Intro, credits and music tracks show "No text
for this part of the audio".

**Where the text comes from.** First match wins:

1. A link the owner set with `!book link`.
2. Calibre's content server, at `calibreUrl` (default `http://127.0.0.1:8080`; `/config` →
   Integrations). The bot only reads from it. It finds a book by its title, or by its series number
   and author, so The Final Empire finds the Calibre book titled "Mistborn" (series Mistborn, book
   1). The content server runs only while the Calibre app is open with its server started.
3. `.epub` files in the folders that hold the book's audio files (`audiobookTextSidecars`, on by
   default). The file name has to match the title; a companion book or another title in the same
   folder is skipped.

DRM-free EPUBs only. If two ebooks fit equally well, none is picked, and `!book link` settles it.
Podcasts have no text.

**Linking by hand** (owner only; `ownerId` must be set, because a link can point at any EPUB on
this PC):

| Command | Links |
| ------- | ----- |
| `!book link "The Final Empire" 299` | Calibre book 299. Quote the title when it ends in a number. A bare number also works when the rest names exactly one book. |
| `!book link The Final Empire id:299` | The same, with no guessing. |
| `!book link The Final Empire isbn:9780765350381` | The Calibre book with that ISBN. The 10-digit form works too: `isbn:0765350386`. |
| `!book link Words of Radiance D:\Books\Words of Radiance.epub` | A file on this PC. A typed network path (`\\server\share\…`) is refused; a mapped network drive letter is not detected and is read like a local one. |
| `!book link The Final Empire off` | No read-along for this book. |
| `!book link The Final Empire auto` | Forget the link and search again. |
| `!book link The Final Empire` | What it uses now, and the Calibre books and files it considered. Typed in a server channel, the reply names Calibre ids and file names only, and the full paths go to you by DM. |

Every link echoes what it linked, such as "Linked The Final Empire to Calibre #299 “Mistborn”
(EPUB).", so a wrong id shows at once. An ebook that could not be read (DRM, damaged) is not tried
again until the file changes or you link it again.

**Calibre's content server and your network.** By default Calibre's content server listens on
every network interface and asks for no login, so anyone who can reach this PC on port 8080 can
browse and download your whole library. Fix it in Calibre under **Preferences → Sharing over the
net**, either or both:

- **Keep it to this PC.** On the Advanced tab, set the interface it listens on to `127.0.0.1`. The
  bot runs on the same PC, so it keeps working with no other change.
- **Add a login.** On the Main tab, tick "Require username and password to access the Content
  server". On the User accounts tab, add a user for the bot and leave its write access off. Put
  that username and password in `/config` → Integrations (`calibreUsername`, `calibrePassword`).
  The password is masked there and never logged, and over plain http the bot only sends it as a
  Digest login (Calibre's default), never in clear text. Never put it in the URL as
  `http://user:pass@...`: the bot refuses that, because error messages can repeat a URL.

Restart the content server after either change. If Windows Firewall has an allow rule for
`calibre.exe` on the Public profile, it is open on every network the PC joins; check that too.

## 🧾 Logs

The bot keeps two logs under `data/logs/`, both plain text, and **both kept indefinitely**:

- `bot-YYYY-MM-DD.log` — every line the logger produces, minus the colours. Written **before**
  anything reaches the console, so a stuck console costs the console line and nothing else. A
  health-check line lands every 15 minutes even when nothing is wrong, so a log that stops tells
  you roughly when the bot stopped rather than leaving it open-ended.
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
npm run logs -- --days=60        # widen the read window (default: 14 day-files)
npm run logs -- --all            # every day-file there is
```

Reading is windowed even though keeping is not. A read looks at the **14 most recent day-files** unless told otherwise, because walking every day since install would only get slower as the pile grows. `--days` and `--all` widen it, a `--since` reaching further back widens it on its own, and `--stats` says which it is rather than presenting a window as a lifetime total.

Set `PLEXBOT_LOG_RETENTION_DAYS` to a positive number to start deleting day-files older than that; unset, 0 or unparseable keeps everything, which is the default. One variable covers both logs, and the voice-health log below when it is on.

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

Pages of a book are the exception: a read-along DM or private page is logged as
`[book text not logged]`, and the read-along's bot-log lines carry only ids, error codes, counts
and timings.

## 🔊 If voice audio stutters

Choppy or rushed voice audio has several causes that sound the same from the listener's side. A
stutter investigation on this bot's own host ranked them, with these measurements:

- **Wi-Fi on the PC running the bot** was the most frequent cause of multi-second drops: 154
  link-security renegotiations of about 4 seconds each and 31 driver disconnects in 49 days, in
  clusters. **Plug the PC into the router with Ethernet** if you can; it removes all of them.
- **Other programs on the same PC** (a game, VR streaming, a Plex transcode) delayed the bot's
  20 ms send timer by up to 359 ms at normal priority, against 34 ms at above-normal. The bot now
  raises its own priority to above normal by default (`processPriority`; ffmpeg stays at normal).
  If a game running beside it suffers, set it back to `normal` in `/config` → Voice.
- **The first seconds of a very long track** can stutter while the bot downloads the whole file
  (packets up to 1.8 s late on a 7-hour file). Not fixed yet.
- **Two copies of the bot running at once** fight over the voice session. The bot now refuses to
  start a second copy, but a copy started before that change has to be restarted once.

**To find out which one you are hearing**, turn on the voice-health log: `/config` → Voice →
**Voice health log**. It takes effect at once and costs about 0.06% of one CPU core. Then:

- Right after a stutter, run **`!voicehealth mark choppy for 2 s`** (or `/voicehealth mark`). It
  stamps the moment and replies with the last 2 minutes.
- `!voicehealth [minutes]` (1–120, default 15) shows one row per minute: packets sent, send gaps
  over 40 and 100 ms, the longest gap, how long the audio source ran dry, Discord's ping,
  event-loop delay, CPU and memory, and flags (`G` gap, `U` source starved, `N` voice dropped,
  `L` bot busy, `C` machine CPU at 90% or more).

Reading it: gaps with high CPU (`C`) point at other programs; gaps with a high event-loop delay
(`L`) at the bot itself; `U` at Plex or the network between Plex and the bot; `N` or a reconnect
event at the network between the bot and Discord. A minute with a mark and no flags at all points
at the network beyond the bot, or at the listener's side. The log is written to
`data/logs/voice-YYYY-MM-DD.jsonl` (gitignored with the rest of `data/logs/`).

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
| `/book goto` | `time:`, `1:23:45` from the start of the book, or `+5m` / `-90` from where you are |
| `/book speed` | `rate:`, picked from the list (0.75x to 3x) |
| `/book sleep` | `after:`, minutes from the list, `End of this chapter`, or `Off` |
| `/book forget` | `title:`, then a confirm button |

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
- `!voicehealth [minutes]` / `!voicehealth mark [note]`: the voice stutter log, once enabled in `/config` → Voice. See **If voice audio stutters**.

While an audiobook is playing in the server, `!pause`, `!resume`, `!skip` and `!stop` (and the old
now-playing card's buttons) act on the book for anyone allowed to control it. `!skip` moves one
chapter forward and ignores a count, and `!stop` ends the book and also clears the music queue.

### 📖 Audiobooks and podcasts

Off until the owner enables it in `!config` (or `/config`) → Audiobooks; until then every `/book`
subcommand answers "📚 Audiobooks are turned off…", naming `!config` with the bot's own prefix. `!book ?` (or a bare `!book`) shows the sub-help;
`!books` works as well as `!book`. **Every `/book` reply is private to you except
`leaderboard`.** The book card that `play` posts is public, so others in the channel can see what
is playing.

| Command | What it does |
| ------- | ------------ |
| `/book play [title] [from-start]` | Start or resume a book or podcast in your voice channel. No title resumes your latest. Prefix: `!book play <title> --restart`, also `!book start` / `!book listen`. |
| `/book pause` / `resume` / `stop` | Stop saves your place and leaves voice, and starts any music queued during the book. |
| `/book back [seconds]` / `forward [seconds]` | Jump 10 s to 10 min from the list (default 30 s), across part boundaries. Prefix takes any length, such as `90`, `1:30` or `2m`, and `!book rewind` / `!book fwd`. |
| `/book goto <time>` | `1:23:45` from the start, or `+5m` / `-90` from here. |
| `/book chapter [number]` | Jump to a chapter; no number lists the chapters around the current one. Prefix also has `!book next` / `!book prev`. |
| `/book speed <rate>` | 0.75x to 3x, pitch kept. Saved per book; a new book starts at your last speed. |
| `/book sleep <after>` | Stop after 5–90 minutes of listening (prefix: any whole number of minutes up to 1440), or at the end of the chapter, or `off`. Paused time does not count. |
| `/book now` | Post the book card again at the bottom of the channel. |
| `/book shelf` | Your books in progress and finished, with Resume buttons; podcasts say "caught up" or "new episodes". |
| `/book library [filter]` | Every book and podcast the bot found, by series, with your progress. |
| `/book stats [user]` | Hours listened, book hours covered, books finished, top three. |
| `/book leaderboard` | Hours listened in this server. Public. |
| `/book finish [title]` | Mark a book finished (default: the one you are listening to). |
| `/book forget <title>` | Drop your place in a book. Asks first: a button on `/`, `!book forget <id> confirm` on `!`. |
| `/book text [mode]` | The read-along: `on`, `off` or `now`; no mode shows its status. The text goes to your DMs. See **Reading along**. |
| `/book link <title> [ebook]` | Owner only, and `ownerId` must be set: tie a book to its ebook (a Calibre id, an ISBN, an EPUB path, `off` or `auto`); no ebook shows what it uses now. |
| `/book rescan` | Owner only (anyone while `ownerId` is blank, as with `/config`): re-read the library from Plex now and report what changed. |

The card has Previous chapter, −30 s, Pause/Resume, +30 s and Next chapter, a speed button that
cycles 1x–2x, a sleep button that cycles off, 15, 30, 60 minutes and end of chapter, 📖 Text (only
on a book whose ebook was found; the listener's private page), and Stop. A
card from an earlier session loses its buttons when clicked; `/book now` shows the current one.

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

`!ap` adds further rooms alongside it, each posting to the channel it was created in.

**The `[id]` is optional while only one room is being watched**, which is the usual case, so `!ap claim ZackWord` and `/ap claim slot: ZackWord` both work. Once a second room is added the ID is required again and the bot says so rather than guessing.

A leading number is **always** read as the ID, including one no watch holds: `!ap unwatch 999` answers "No watch with ID 999" rather than acting on whatever room happens to be the only one. The cost is that a slot literally named `12345` needs the explicit form, `!ap claim <id> 12345`. In the slash form `id` trails the required options, because Discord rejects a command where a required option follows an optional one.

- `!ap watch [room url or host:port] [slot name]`: Start relaying a room's log here. The slot name has to match a real slot in that multiworld; the bot attaches to it as an observer, receives no items, and cannot affect the person playing it.
- `!ap list` / `!ap status [id]`: Watches, their connection state, how many lines each has posted (live and caught up), and when its last catch-up ran.
- `!ap filter [id] [items|hints|chat|joins|goals|deaths|misc] [on|off]`: Pick which lines get posted.
- `!ap progression [id] on`: Item sends only when they are progression. The usual fix for a noisy async.
- `!ap skipgoaled [id] [on|off]`: Hide items sent to slots that already finished, meaning goaled, released, or with every location checked. On by default. Goal status is read from the server, so players who goaled before the bot connected count too; a release is only seen if the bot was connected when it was announced, because nothing stores it.
- `!ap infer [id] [on|off]`: Whether a 100%-checked slot counts as finished. On by default, and it does most of the work late in a game: on one live 29-player room, 15 slots were fully checked and 9 of those had never goaled. It reads the room's tracker page every 15 minutes, so it needs a room URL rather than a bare `host:port`. Turn it off if you would rather still see items going to someone who has checked everything but is waiting on an item to goal.
- `!ap color [id] [on|off]`: Colour item names by class: progression magenta, useful blue, trap red, filler cyan, matching Archipelago's own clients. On by default. Discord renders ANSI code blocks on **desktop and web only**, so this does nothing in the mobile apps.
- `!ap next [id] [slot]`: The unchecked locations your slots can reach **in logic right now**, by the seed's own rules and the items each slot has received. With no slot named it answers for **every slot you have claimed**, earliest sphere first; name one to narrow it. Only ever your own slots, and it never says what is in them. Each slot names the soonest sphere with anything in logic and lists locations from that sphere only; later spheres are counted. Across several slots each reads like `sphere 1: 56 in logic · +1,177 later · 1,696 locked` over three names, and slots with nothing in logic yet are named together at the end rather than given a block. Name one slot, or hold only one, and it lists up to 15 names from that sphere and closes with the rest, such as `Also in logic: sphere 2 (1,175), sphere 3 (2) · 1,696 still locked`. Slots that have already goaled or been released are skipped and counted off at the end, so a mostly-finished async still answers about the slots you are actually playing, and asking about finished slots alone answers at once without loading anything. Exact logic needs the seed to have been generated with the Archipelago install at `archipelagoInstallDir` (see **What `!ap next` needs** below). Any other seed gets **sphere 1 only**, which needs nothing and so is always in logic, and the reply says so with a short reason such as "this seed was not generated here". The install's paths and the helper's own errors stay out of the channel; when loading failed, the reply points at the bot log, which has them. Sphere 1 comes from sphere data for the seed: with the seed's multidata, run `python scripts/extract-spheres.py <Archipelago>/output/AP_<seed>.zip`, which covers every location; otherwise drop the seed's spoiler log at `data/archipelago/spoilers/<seed_name>.txt`, which only covers the placements the seed's completion depends on (about a tenth). An answer from the spoiler lists its sphere 1 locations with no count, and never says a slot has nothing left, because the spoiler cannot know either. The command names both paths when it has neither.
- `!ap hints [id] [slot]`: Outstanding hints nobody has collected yet, priority ones first. With a slot, both what that world owes and what it is waiting on.
- `!ap hintpings [id] [slot] [off|dm|channel]`: Be told when somebody hints an item out of **your** world. **Off by default** and separate from `!ap pings`, which is about items arriving for you. The first read of a room is absorbed silently, so opting in never replays a backlog at you.
- `!ap markers [id] [on|off]`: Prefix 🟪 progression, 🟦 useful, 🟥 trap to item names. Plain text, so unlike the colours it shows on every client including mobile. On by default, and it works alongside colour rather than replacing it. Filler is left unmarked because most sends are filler.
- `!ap password [id] [password]`: Set a room password. The prefix form deletes your message afterwards. Clearing has to be asked for in words, `!ap password [id] clear`, because a leading number is read as the watch ID: `!ap password 0` meaning "set it to 0" would otherwise have left nothing after the ID and silently cleared it, after deleting the only other copy.
- `!ap unwatch [id]` / `!ap retry [id]`: Stop a watch, or reconnect one the server refused. Unwatching also drops every slot claim on that watch.
- `!ap catchup [id]`: Post what the channel missed while the bot was down, rebuilt from the room tracker. It also runs by itself; the command runs one now. The reply says how many lines it is posting and how many the watch's filters hide, or that nothing was missed. Run in the first two minutes after a reconnect, it posts what the tracker already shows and says when the automatic check that picks up the rest is due.

**What `!ap next` needs.** The seed's logic is rebuilt from the same Archipelago install that generated it, by a Python helper the bot starts on its own (`scripts/ap-logic-worker.py`). Two settings control it, both in `/config` → Archipelago:

- `archipelagoInstallDir`: the install, `C:\ProgramData\Archipelago` by default. Blank turns exact logic off, and every seed gets sphere 1 only.
- `archipelagoPython`: the Python the helper runs on. It has to be the version the install was built with, **Python 3.13 for Archipelago 0.6.7**. Left blank, the Windows `py` launcher finds it, so installing Python 3.13 once is usually all this takes.

The one-off requirement is that **the seed was generated with that install**, and its output zip, `output/AP_<seed name>.zip`, is what tells the bot so. The helper reads the multidata from that zip and the seed number from the first line of the spoiler inside it. The install's `logs/Generate_*.txt` is a spare, for a seed generated without a spoiler; Archipelago deletes those logs after a week, so such a seed stops being rebuildable then. The helper then re-rolls the yamls in the install's `Players` folder and compares every slot's name and game with the multidata before building anything, so leave that folder as it was when the seed was generated. **If any slot no longer matches, the whole seed gets sphere 1 only**, and the bot log says how many slots differ. A seed from anyone else's machine, or generated in race mode, gets sphere 1 only.

**The first `!ap next` for a seed takes about a minute**, and its status message says the seed's logic is loading. The helper holds about 0.5 GB while it runs; on the 79-slot room this was built against, answering for all 79 slots took 303 ms after that. It holds one seed at a time, so asking about another seed replaces it. Nothing is written into the Archipelago install.

The helper is stopped, and its memory handed back, when the last watch on its seed is removed, when the configured room is pointed at a different one, when `archipelagoEnabled` is switched off, or when `archipelagoInstallDir` is blanked, each as it happens rather than at the next `!ap next`. It is also killed when it takes longer than 60 seconds to answer, and the next `!ap next` starts a fresh one. Otherwise it runs until the bot exits.

Every slot is checked against the seed's multidata before it is answered from the rebuild, and a slot that does not match gets sphere 1 only, with the bot log naming it. Items handed out with `/send` or `!getitem` count for what they are, the same as items somebody found. When the rebuild fails outright, the reply gives the short reason, the bot log has the details, and every slot answers from sphere 1. The bot does not try that seed again for ten minutes, but saving a different `archipelagoInstallDir` or `archipelagoPython` clears that at once, so a fix is tried by the next `!ap next`.

**Catching up after downtime.** The live relay only sees what happens while the bot is connected, and the server replays no history to a client that joins late. So after every reconnect and restart, about two minutes in, the bot reads the room's tracker and posts whatever the channel has not seen yet, under a `📜` header naming how many lines were missed and since when. It checks again every `archipelagoTrackerPollMinutes` (15 by default) and 30 seconds after a post Discord refused. While the channel keeps refusing, that wait doubles each time up to the poll interval, and `!ap list` shows the catch-up as failing. A line refused before is retried in a message of its own, and a line Discord refuses three times is skipped and named in the bot log. The two-minute wait is how long the web host can take to publish a change: it saves the room every 60 seconds and caches the tracker for another 60.

- **Recovered:** item sends (Release and Collect bursts included, as ordinary sends), goals, and hints that involve the watched slot. They post in the watch's usual format with a `[missed]` prefix and honour its filters, so a catch-up shows what the live feed would have shown. Hints show their status at the time of the catch-up. Claimants get one summary ping per slot, such as "12 missed item(s), 3 progression", in place of one ping per item.
- **Gone for good:** chat, joins and parts, DeathLink, countdowns, the Release and Collect notices themselves, "Team #1 has completed all of their games!", cheated items, start inventory, hints for items already found, and `!hint` replays of an existing hint.
- **Order is approximate.** The tracker keeps each slot's items in order but no timestamps, so sends to different slots are interleaved by best guess.
- **The first look at a room posts nothing.** It records everything already there, and only what happens after that counts as missed.
- **Room URL watches only.** A watch made from `host:port` has no web tracker, so it cannot catch up, and `!ap list` says so.
- **Nothing is capped.** A 1,000-location release missed while the bot was down posts as about 50 messages of 20 lines each, over about a minute. The live relay no longer trims a burst either: every line posts, in order, one message after another.

Setting `archipelagoCatchup: false` in `config/config.js` stops the automatic runs from posting. They still record what they find, so switching it back on later does not dump the backlog into the channel, and `!ap catchup` still posts when asked. Two automatic runs post anyway: the retry after a post Discord refused, since those lines were already on their way, and the run after a restart cut a `!ap catchup` short, which posts the rest of what was asked for. What has been posted is recorded per watch and per seed in `data/archipelago_catchup.json`.

**Slot claims** tell the bot which slot belongs to which Discord user, so a long async can ping the right person instead of everyone reading the whole log:

- `!ap claim [id] [slot name]`: Take a slot. **Anyone can claim their own**; hand-registering 29 players otherwise falls to the owner. Claiming, `unclaim`, `pings` and `hintpings` on your own slot, and the read-only `list`, `status`, `claims`, `goals`, `leaderboard`, `next` and `hints`, are open to everyone. Everything else in `!ap` is owner-only once `ownerId` is set. One person can hold as many slots as they play. A slot somebody else already holds is refused, naming them; only they or the owner can move it. Owners can claim on someone's behalf by adding a mention.
- `!ap unclaim [id] [slot name]` / `!ap claims [id]`: Give a slot back, or list who holds what. A claim can only be changed by the person holding it or by the owner.
- `!ap pings [id] [slot name] [all|progression|off]`: How much a claimed slot notifies you. `progression` by default, since filler is most of what arrives and pinging on it trains people to mute the channel. `off` keeps the claim and stops the notifications.

Claims are matched case-insensitively and stored under the spelling the room uses, so `!ap claim zackword` reads back as `ZackWord`. They key on the slot name the seed was rolled with rather than a display alias, which means setting an alias mid-game does not silently unclaim you. The ping posts as its own message after the log block, because a mention inside a code fence renders as text and notifies nobody. Only the claimants named in that message can be mentioned by it.

Pings inherit every filter above them. A line hidden by `progression`, `skipgoaled` or a category toggle never pings, so a slot that has already goaled goes quiet on its own.

**Roles** are created and maintained by the bot once anybody claims a slot, controlled by `archipelagoRolesEnabled` (on by default) and `archipelagoRoleName`:

- **The participant role**, named `Archipelago` unless you change it. Granted on the first claim and removed when someone releases their last slot, including when a whole watch is removed. Created mentionable so the room's players can be pinged as a group. Changing `archipelagoRoleName` later renames the existing role rather than leaving it on the old name.
- **A role per goal count**, `1 Game Goaled`, `2 Games Goaled` and so on. Each person holds exactly one, and the bot moves them up as they finish. A count role nobody is on any more is deleted, so the guild only ever carries as many as are actually held.

**Releases do not count.** A release hands out everything a slot was still holding without anyone finishing it, and a 100%-checked slot can still be waiting on an item to goal. Both make the relay treat a slot as finished, and neither adds to the tally. Only a real goal does. In a multi-team room only the team the bot is connected to is counted, because a claim carries no team and slot numbers repeat across them.

The tally is lifetime and spans rooms. It keys on the multiworld's seed name and the slot name, so it survives reconnects, a room restarting on a new port, a watch being removed, and a watch id being handed out again. Goals that happened before the bot connected are counted too, since goal status is read back from the server on every connect.

**A goal belongs to whoever earned it.** The record is keyed by the game rather than by the person, so a slot changing hands later does not re-credit a game the previous holder already finished.

The claim, goal, role and catch-up files (`archipelago_claims.json`, `archipelago_goals.json`, `archipelago_roles.json`, `archipelago_catchup.json`) are written to a temporary file and renamed over the target, so a crash mid-write cannot truncate one. If one is found unreadable at startup the bot logs an error naming it and leaves that store read-only for the run rather than overwriting what may still be salvageable by hand.

- `!ap goals [@user]`: How many multiworlds someone has goaled, and which slots.
- `!ap leaderboard`: Ranked by count.

The bot needs **Manage Roles**, and its own role has to sit above the ones it creates. Without the permission it logs once per guild and leaves that guild alone. Only roles the bot created are ever assigned or deleted; their ids are recorded in `data/archipelago_roles.json`, so a role you made by hand that happens to share a name is never touched.

Two things worth knowing before switching it on: the room sees a client join on the slot being watched, and a held connection stops a room hosted on archipelago.gg from idling to sleep. Watches survive a restart and reconnect on their own, including after a hosted room comes back on a new port.

### 🛠️ Owner / Admin commands

- `!config` *(best as `/config`)* — Owner-only settings wizard. Opens a panel (private under `/config`) to view and change most `config.js` settings from inside Discord (prefix, server name, integration toggles, broadcast settings, etc.). See **Editing settings from Discord** below.
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

!stop : stops playback and clears the queue, including tracks still waiting after a failed voice join.

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
