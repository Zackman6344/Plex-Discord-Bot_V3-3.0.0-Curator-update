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
  'calibreConvertPath' : '',               // Calibre's ebook-convert(.exe); blank = find it in Calibre's install folder or on PATH

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
  'archipelagoPython'     : '',            // Python for that (3.13 for AP 0.6.7 and 0.6.8); blank = py launcher
  'archipelagoShowItems'  : true,          // which categories of log line get relayed
  'archipelagoShowHints'  : true,
  'archipelagoShowChat'   : true,
  'archipelagoShowJoins'  : true,
  'archipelagoShowGoals'  : true,
  'archipelagoShowMisc'   : true,
  'archipelagoShowDeaths' : false,         // DeathLink; reconnects the room to add the tag

  // Plex Media world (see below). All editable from /config → AP Media, all live.
  'apMediaEnabled'        : false,         // /apmedia and the world; needs archipelagoEnabled too
  'apMediaChannelId'      : '',            // where its lines post; blank = each watch's own channel
  'apMediaHistorySeconds' : 120,           // how often the linked accounts' Plex history is read (30-86400)
  'apMediaSessionSeconds' : 15,            // how often live Plex sessions are read, for checkpoints (5-86400)
  'apMediaVoiceCredit'    : true,          // count music the bot plays in voice (its audiobooks count either way)
  'apMediaAnnounce'       : 'completions', // or 'all' (checkpoints and tracks too) or 'off' (problems only)
  'apMediaTraps'          : true,          // traps a world 0.3.0 seed sends; off = each one only fizzles
  'apMediaVoiceTraps'     : true,          // the five that pause, rewind or shuffle what the bot plays
  'apMediaTrapClips'      : '',            // Plex playlist (name or ratingKey) of Commercial Break clips; blank = a 30 s pause

  // Audiobooks and podcasts (see below). All editable from /config → Audiobooks, all live.
  'audiobooksEnabled'            : false,  // turn /book on; off = no library reads, no proxy port
  'audiobooksExcludeFromMusic'   : true,   // keep catalogued books out of music pickers and search
  'audiobookSaveSeconds'         : 15,     // bookmark save interval (5-300); the most a crash can lose
  'audiobookDefaultSpeed'        : '1',    // a listener's first speed: '0.75' '0.9' '1' '1.1' '1.25' '1.5' '1.75' '2'
  'audiobookIdleLeaveMinutes'    : 10,     // a paused book leaves voice after this (1-180)
  'audiobookResumeRewindSeconds' : 10,     // rewind after 5+ min away, 3x after a day (0-120)
  'audiobookTextEnabled'         : true,   // !book text and the card's 📖 (see "Reading along")
  'audiobookTextSidecars'        : true,   // also look for .epub files next to a book's audio
  'audiobookTextConvert'         : true,   // convert a MOBI/AZW3-only Calibre ebook to EPUB on its first open
  'audiobookTextPictures'        : false,  // a Calibre PDF's illustrations on the read-along page (see "Pictures from a scanned PDF")
  'audiobookControls'            : 'started', // who may use a book card's buttons: 'started' 'voice' 'listener' 'everyone' (see "Who controls a book")
  'audiobookOnlineLookup'        : false,  // fill blank series, narrators and publishers from Audible (see "Looking books up online")
  'audiobookLookupRegion'        : 'us',   // which Audible store: 'us' 'ca' 'uk' 'au' 'fr' 'de' 'jp' 'it' 'in' 'es'
  'audiobookCalibreSort'         : false,  // match books to Calibre records for sections and blank details (see "Sorting with Calibre")

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
- The sections are General, Access, Integrations, Broadcasts, Archipelago, AP Media, Audiobooks
  and Voice. Every AP Media, Audiobooks and Voice setting applies at once, with no restart:
  turning `apMediaEnabled` on starts the Plex Media world, turning `audiobooksEnabled` on makes
  `/book` work on its next use, and `processPriority` and `voiceHealthEnabled` switch over as soon
  as they are saved.
- Integrations holds the four Calibre settings for the read-along and the Calibre index, which
  Audiobooks turns on with `audiobookCalibreSort`. `calibrePassword` is masked in
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
is still reading. The first read also opens one file of every long album to read its tags (every
file, in a folder of long files or of several volumes mixed together), which can add up to 45
seconds once; later reads take them from a cache. After that it checks Plex for changes once an
hour, so a book you add shows up within the hour, and `/book rescan` (owner only) re-reads it on
demand.

**What counts as a book.** The bot looks at folders on disk rather than Plex albums, because a
hand-ripped library rarely lines up album-for-book. A folder of at least 2 hours becomes a book
when its tracks are long (a median of 15 minutes or more), when at least half its tracks are on
albums with an audiobook genre, when its name says so ("unabridged", "audiobook", "read by", GraphicAudio), or
when it is a long run of low-bitrate mono files. A folder whose tracks are mostly numbered episodes
of 20 minutes or more is a podcast. Hour-long music mixes stay music: nothing is decided by track
length alone. `/book library` shows what it found, and `/book rescan` also names up to five of the
long folders it left as music, so you can pull one in, and the books whose part order it is unsure
of.

- **Short works.** A folder under 2 hours becomes a book when it holds at least 40 minutes and its
  median track is 15 minutes or more (a single play such as Lysistrata or Medea on long tracks). A
  folder of at least 40 minutes with a median track of 5 minutes or more, and no music genre, is
  taken when the folder above it holds 3 or more books (one LP of Antigone among other Greek
  plays). Both still lose to the music rule below.
- **One folder, several plays.** A folder of mp3s splits into one book per album tag when every
  file has an album tag that its own file name repeats, and at least one of those books holds 2 or
  more files. The Aristophanes "The Birds" folder becomes The Birds, The Clouds and The Frogs. A
  lecture course or a podcast whose file names do not repeat the album tag stays one book.

- **Genres.** An album counts as a book album when its Plex genre or the genre tag in its files
  says audiobook, podcast, audio drama, radio play or full cast. It counts as music when it names
  a music genre (rock, rap, soundtrack, lo-fi and so on) and no book genre. A music genre has to
  be the whole entry ("Alternative Rock", "Pop/Rock"), so "Space Opera", "Folk Tales" and
  "Haunted House" are not music. "Fantasy", "Comedy" and "Spoken Word" decide nothing. **A folder with at least half its tracks on music albums, and
  none on a book album, stays music however long its tracks are.**
- **A music album inside a book's folder is split off** and stays in the music library, and
  `/book rescan` names it.
- **`Disc 2` folders.** A `Disc 2`, `Part 2` or `[01]` folder joins the folder above it only when
  that folder is the book's own: it holds no loose files, or its loose files are the same Plex
  album. A stray `Disc 2` of a rap album under the top of the music library once joined the whole
  library folder, picked up a loose audiobook file lying there, and showed up as a book called
  "Music"; that can no longer happen.
- **Loose single-file books.** Several `.m4b` or `.m4a` books lying in one folder become one book
  each when their album tags, or failing that file names like `Author - #2 Title`, name different
  books. Names that differ only by a part marker (`Part 2`, `(2 of 6)`, `[01]`, `Disc 2`) or an
  edition marker (`(Unabridged)`, `(Dramatized Adaptation)`) count as one book, and edition
  markers are left off the title shown.

**Where a book's details come from.** Each title, author, narrator, publisher and series is taken
from the first of these that has it:

1. Your own edits (`!book edit` below, or `data/book_overrides.json` by hand), for one book or,
   with numbers, for all of an author's books.
2. The tags inside the files, then Plex's album and artist, then the folder names.
3. Calibre (a book you tied with `!book edit <book> calibre <id>`, else the read-along's Calibre
   book, else an exact match from the Calibre index while `audiobookCalibreSort` is on), then the
   optional online lookup. **These two only fill a detail every source above left blank.**

An author-wide series with no numbers sits between 2 and 3: it names that author's books that
have no series of their own. A few rules decide what detection reads:

- A GraphicAudio file names the publisher as its artist. A publisher is never shown as the
  author: the author then comes from a "Written by" comment or the copyright tag.
- A title taken from a folder gets proper capitals ("Words Of Radiance" shows as "Words of
  Radiance"), and an apostrophe the folder name lost comes back when a track or file name spells
  it ("The Children's Adventure"). Only capitals and apostrophes change, so the book's id does not.
- **A cast list is not a narrator.** A bracket that is cut short with "..." (the GraphicAudio
  Mistborn albums), or a tag that lists several names, "full cast" or "various", gives no
  narrator, and a cut-short cast is not shown as the edition either. "Various" in a folder
  bracket shows as the edition and never as the narrator.
- **A bracket has to look like a person to be the narrator.** Years ("(1942)"), "Various", casts,
  translator credits, publishers and words of the title are refused, and "Abr", "Vinyl" and "LP"
  in front of a name are dropped. The narrator then comes from the narrator tag, the comment,
  "read by X" in a folder or album name, the second name of an "Author/Narrator" artist, or a
  composer tag naming one person. A year or a format word is never the edition.
- **Authors are cleaned up.** An artist such as "BBC/Sophocles/John Lynch" or "Madeline Miller,
  Frazer Douglas, ©2012 by HarperCollins" shows as Sophocles or Madeline Miller: houses, a bare
  "BBC", copyright fragments and role credits are dropped, and an all-capitals name gets proper
  capitals. A shelf folder holding three or more authors ("Mythology") is never the author. A work
  with no author at all shows its publisher's name, such as BBC Radio 4.
- **Titles lose their tails.** "- A Novel", ": Penguin Classics", "read by ...", "(1855)", a
  "BBC " prefix, "by <author>" and a series tail such as "Book One of the Wheel of Time" are
  removed. A trailing "Vol 1" or "Book 2" is kept.
- **Series in the name.** "Series, Book N", "- X Series, Book N" and "Book One of Series" are
  read, and a folder such as "Murderbot Diaries 03 Rogue Protocol" joins the series that a
  sibling by the same author names.
- Calibre and the online lookup may fix a title's capitals, and only when their title is the same
  once case and punctuation are ignored, is itself properly capitalised and has a lower-case
  letter. An online "Words Of Radiance" never replaces "Words of Radiance", and a Calibre record
  titled "The once and future king", or one titled "Mistborn" that holds The Final Empire, changes
  nothing.

None of these sources ever changes a book's id, so bookmarks, read-along links and sync marks stay
where they are.

**The one-time id move (rules version 5).** The author and title clean-up above changes what
detection reads, so the first start after this update rebuilds the catalog once and about 19 books
on the reference library get a new id (`ovid/metamorphoses-penguin-classics` becomes
`ovid/metamorphoses`). Each old id stays as an alias of the new one, so bookmarks, read-along
links, sync marks, your overrides and Calibre pins follow. If two books would come out with the
same id, the later one by folder order gets its folder's name as its id and the rebuild says so.

**Looking books up online (optional).** Off by default. With `audiobookOnlineLookup` on (`/config`
→ Audiobooks), each catalog rebuild is followed by a lookup on Audible's catalog search of every
book not asked about recently, to fill a blank series, series number, narrator or publisher.

- **What leaves this PC:** the book's title (with edition brackets and a leading series name
  removed) and the author's name, in an HTTPS request to `api.audible.com`, or the store
  `audiobookLookupRegion` picks. Never a file path, a Plex or Discord id, the narrator or anything
  about who listens.
- The endpoint is the unofficial one the Audible app, Audiobookshelf and the Plex Audnexus agent
  use. It needs no account or key and publishes no terms or limits, so the bot asks politely: one
  request at a time, at least a second apart, a 10 s timeout, a "slow down" answer honoured once,
  and it stops after 3 failures in a row.
- Answers are cached in `data/book_lookup.json`: a match for 180 days, "not found" for 30, a
  failure for 1. A book is asked again sooner when its title or author changes, or with
  `!book edit <book> lookup`.
- **Never looked up:** podcasts, books `/book rescan` lists as doubtful, books with no author, and
  books whose author is a publisher's name.
- A match is either this recording (an Audible edition whose running time agrees to within 3% or
  10 minutes, whichever is more) or only the book (every candidate agrees on the series and
  number). Only an edition match can supply a narrator or publisher, and more than three narrators
  is a full cast, which fills no narrator.
- **Online details only fill blanks.** Edgedancer stays "The Stormlight Archive #0.5" although
  Audible says 2.5, and "The Murderbot Diaries" is not shortened to Audible's "Murderbot Diaries".
- `/book rescan` waits up to a minute for the lookups and reports them. A rebuild started any
  other way (the hourly check, a new book) runs them in the background.

**What `/book rescan` reports.** It starts with "about 20 s, up to a minute the first time after an
update" (plus a minute for the online lookup when that is on), then lists works, parts, hours,
additions, removals and renames ("bookmarks follow"), and:

- `⚠️ Doubtful groups, catalogued anyway`: books whose grouping looks wrong, each with the reason
  (tracks by several artists, a music genre on one of its albums, a generic folder name such as
  "Music" spread over several albums, a title that looks like a folder name, no author found, a
  title or author that still reads like a credit, an author taken from a shelf folder, a narrator
  that does not look like a person) and
  the fix, `!book edit <id> exclude` or a title or author edit. A doubtful book is still
  catalogued and playable, and is not looked up online. **Once you set its title or author by
  hand it is not warned about again, and the online lookup takes it too.**
- `✂️ Music split off a book folder`: music albums taken out of a book's folder, with their track
  counts and the book they came from.
- `🌐 Online lookup`, when it is on: how many books matched an edition or a book, were not found,
  were already looked up, were skipped or failed, then the blanks this rescan filled. "Online
  lookups are still running" means the minute ran out; they finish in the background.
- `🗂 Long groups not taken as books`: folders of 2 hours or more, and shorter ones whose median
  track is 10 minutes or more ("X (1.2 h, tracks of 10 min)"), likeliest books first (music genres,
  upload folders, generic folders and single files last), five at most and then "N more". Each
  folder is shown from below its music section's own folder, so the drive and the folders above
  it stay out of the channel.

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

**Who controls a book.** The person who started it (the listener) controls everything, from
anywhere. Who else may use the card's buttons and the same commands (`!book pause`, `resume`,
`stop`, `back`, `forward`, `goto`, `chapter`, `next`, `prev`, `speed`, `sleep`, and `!pause`,
`!resume`, `!skip`, `!stop` during a book) is the owner's choice, `audiobookControls` in `/config`
→ Audiobooks, read on every click:

| `audiobookControls` | Besides the listener |
| ------------------- | -------------------- |
| `started` (default) | Anyone who was in the book's voice channel when it started, while they are still in it. Someone who joins later, or who leaves and comes back, is checked against that list. |
| `voice` | Anyone in the book's voice channel. |
| `listener` | Nobody. |
| `everyone` | Anyone who can see the card. |

In every mode the bot owner may pause or stop the book, and so may anyone in the book's voice
channel once the listener has left it. **While the listener is out of the channel, nobody else may
do more than pause or stop**: a book parked because they left waits for them to come back and
resume it. A refusal is a private reply that names the rule in force. `!book play` and `!book now`
are open to everyone as before. Everyone has their own shelf and stats, and a place is always saved
to the listener, never to whoever pressed a button.

**Your place.** It is saved every 15 seconds while playing and on every pause, jump, stop and
shutdown, so a crash loses at most 15 seconds, and resuming after more than 5 minutes rewinds 10
seconds (30 after a day) so you hear the end of the last sentence again. A book is only marked
finished when its last part plays out, when you run `/book finish`, or when you press **Mark
finished** on the card (offered when you stop within 2 minutes of the end); stopping near the end
never finishes it for you. Playing a finished book starts it again; playing a podcast you had
caught up on starts at its first new episode. A podcast plays in episode order, and a new season
added to the same folder that numbers its episodes from 1 again plays after the season before it.

**Finding a book by name.** `/book play <words>` tries these in order and stops at the first that
finds something:

1. The exact title, ignoring a leading "the", "a" or "an" on either side: `the mythos` starts
   Mythos, and `odyssey` asks between Fry's Odyssey and Homer's The Odyssey.
2. A series and number: `mistborn 3`, `murderbot #2`, `stormlight book three`. A number the
   library lacks lists the numbers it has ("The Murderbot Diaries has no #2 in the library. It has
   #1, #6, #7. Pick one:").
3. **A whole series or author** (`mistborn`, `murderbot`, `sanderson`, `stephen fry`) when every
   hit belongs to it: your newest book in progress there resumes, else the lowest unfinished
   number of a single series starts (finishing one narration of a number counts for all of
   them), else you get a list to pick from.
4. A title that starts with the words, ignoring articles.
5. Titles whose words start with the words, then every hit.

When several books are left and you have exactly one of them in progress, that one plays. Accents
do not matter.

**Typos ask first.** When nothing matches, the bot looks for a near miss (one wrong letter in a
word of 4 to 7 letters, two in a longer one, a swapped pair counting as one, spaces ignored) and
answers "Nothing in the audiobook library matches "rouge protocol". Did you mean **Rogue
Protocol**?" with a play button, or a list of up to 5 with a button each. **It never starts a book
on a guess.** A single word only matches an author by their whole surname, so `auto` does not
find Autumn Bardot. The same near misses fill the `/book play` autocomplete, and `finish`,
`forget`, `link`, `marks` and `unmark` name them as text with the id to copy, with no button. A
misspelt
subcommand gets "Did you mean `!book pause`?", and `!book read Artifical Condition` gets
"Unknown book command "read". Did you mean `!book play Artificial Condition`?" with a button. A
title typed with no verb (`!book whale fall`, `!book mistborn`) is tried whole first, the same
way, and offered with play buttons; nothing starts until you press one. `!book exit strategy`
offers both the book and `!book edit strategy`.

**Browsing the library: `/book library`.** With no filter it shows one line per section (name,
number of books, hours), Podcasts last, an **Open a section** menu, and a **▶ Play a book in
progress…** menu of your unfinished books, newest first. A section or a filter lists books 25 to a
page: books outside a series by title, then each series under a "*Series* · Author" heading in
series order, with your progress beside each one. Each page has a **▶ Play one of these…** menu,
◀ and ▶ page buttons and **📚 All sections**. Picking from a Play menu plays the book for whoever
picked it, answers privately and redraws the list with the new mark.

| Filter | Lists |
| ------ | ----- |
| `fantasy` | A section by its exact name. A section at either end of other words narrows by it: `fantasy sanderson`. |
| `author:sanderson`, `series:mistborn`, `section:myth` | By author, series or section (`genre:` is the same as `section:`). A value runs to the next keyword, so quote one that contains a keyword: `series:"the long earth"`. |
| `unread`, `listening`, `finished` | Your own progress. |
| `short`, `long` | Under 5 hours, or 20 hours or more. |
| `podcasts` | Podcasts only. |
| any other words | A title, author or series search. |

Filters combine (`fantasy unread`, `author:sanderson listening`). A filter that finds nothing gets
the same "Did you mean" buttons as `play`, or the list of sections and keywords. A list's buttons
work for an hour after the last click and until the bot process restarts (lists survive `/restart`,
which runs in the same process); after that a click says "This list has expired. Run
`/book library` again." privately.

**Sections.** Each book is listed under the first of these that names a section: Podcasts for a
podcast; your `!book edit <book> genre` for the title; your `author-genre` for the author; your
own folder (a folder holding books by 3 or more authors, such as "Mythology" or "Myth
Retellings"); the tags of the Calibre record it matches; the genres in its files or in Plex; the
tags of a likely Calibre match; the section most of its series has; the section all of its
author's other books agree on; else "More books". Tags and genres count only when a whole part of
the tag names one of Fantasy, Science Fiction, Mythology, Horror, Mystery & Thriller, Classics or
Nonfiction ("Fiction", "Audiobook" and "Epic" count for nothing).

**Fixing a book's details from Discord: `!book edit`.** Owner only, and `ownerId` must be set:
unlike `/book rescan` there is no bootstrap mode while it is blank. Edits are written to
`data/book_overrides.json` and show at once, with no rescan, except `exclude` and `include`, which
rebuild the catalog. `!book edit` on its own lists the forms.

| Command | What it does |
| ------- | ------------ |
| `!book edit Hyperion` | Each detail and where it came from (your edit, your author-wide edit, file tags, Plex, folder name, Calibre, online), its section and what decided it, its Calibre match, and any doubts. |
| `!book edit <book> title <text>` | Sets the title. `author`, `narrator` and `publisher` work the same way. |
| `!book edit dan-simmons/hyperion narrator none` | Explicitly no narrator, where the folder name says "Various". `publisher none` works too. |
| `!book edit The Fall of Hyperion series Hyperion Cantos 2` | This title's series and number. The number can be `2`, `0.5` or `#2`; a range such as `1-5` is kept as no number, and leaving the number out keeps the detected one. `series none` means no series. Quote a name that ends in a number: `series "Area 51"`. |
| `!book edit Hyperion author-series Hyperion Cantos 1` | One series for all of the author's books, numbered one book per command (below). |
| `!book edit Hyperion genre Science Fiction` | The library section for every recording of this title. Any name works; one that matches an existing section apart from case joins it. |
| `!book edit Hyperion author-genre Science Fiction` | The section for all of the author's books that have no `genre` of their own. |
| `!book edit dan-simmons/hyperion calibre 42` | Ties this recording to Calibre book 42 (the number in Calibre's Id column), for its details, its section and `!book calibre`. `calibre none` stops any match. A title with two recordings needs the id. |
| `!book edit <book> clear series` | Drops your edit, so the detail shows what the next source gives. Also `title`, `author`, `narrator`, `publisher`, `author-series`, `genre`, `author-genre`, `calibre`, or `all`, which keeps an exclude, a part order, a pinned id, the sections and the Calibre pin. |
| `!book edit <book> exclude` | Takes the book out of the catalog and gives its tracks back to music. Rebuilds the catalog (about 20 s). Saved places are kept, and the reply counts the listeners in this server who have one. |
| `!book edit <id> include` | Brings an excluded book back, by the id the exclude reply gave. Rebuilds too. |
| `!book edit <book> lookup` | Asks the online lookup about this book again now. Needs `audiobookOnlineLookup` on. While a batch of lookups runs it waits for that batch, up to a minute. |

- `<book>` is a title, part of one, or an id from `/book library`. Unquoted, the book's name ends at
  the first detail word (`title`, `series`, `clear`, `exclude` and the rest) whose text before it
  names a book, preferring an exact title. Quote a title to be certain: `!book edit "The
  Narrator" narrator Sam Reader`.
- **Title, series and genre edits reach every recording of a title** (both narrations of The Fall
  of Hyperion), and the reply names them. `author`, `narrator`, `publisher`, `calibre`,
  `clear all`, `exclude` and `include` change one recording, so for a title with two they ask for
  the id.
- `calibre <id>` works with the Calibre index off or Calibre closed: the pin is saved, and the
  reply says it applies once the index is on. A pin keeps the record's Calibre uuid and library,
  so if that id later holds another book, or the book is deleted, or you switch libraries,
  `!book calibre` lists the pin as one to check and nothing replaces it.
- **A whole series (`author-series`).** Run it once per book, each with its number:

  ```
  !book edit Hyperion author-series Hyperion Cantos 1
  !book edit The Fall of Hyperion author-series Hyperion Cantos 2
  !book edit Endymion author-series Hyperion Cantos 3
  !book edit The Rise of Endymion author-series Hyperion Cantos 4
  ```

  Each command adds its book to one entry for the author, `authors["dan-simmons"]` in the
  overrides file, and keeps the numbers already there, so after the fourth all seven Dan Simmons
  recordings show Hyperion Cantos #1–4. Without a number it renames the series and keeps the
  numbers. A book's own `series` edit still wins over it. `clear author-series` removes the whole
  entry.
- An edit is never replaced by tags, Plex, folders, Calibre or the online lookup, and never
  changes a book's id. An edit made before a book was renamed still applies after.
- A broken overrides file is refused, never overwritten: "book_overrides.json: the file is not
  valid JSON (line N column M), so nothing was changed."
- On `/`: `/book edit title:<book> field:<detail> value:<value> position:<number>`. `value` is
  taken whole, so `field:series value:Area 51` needs no quotes and the number goes in `position`.
  With no `field` it shows the details.

**Sorting with Calibre: `!book calibre`.** Off by default. With `calibreUrl` set and
`audiobookCalibreSort` on (`/config` → Audiobooks, "Sort and fill details from Calibre"), the bot
keeps a copy of your Calibre library's titles, authors, series, tags, ISBNs and formats in
`data/book_calibre.json` and matches each audiobook to a record. It only reads from Calibre: a
full read is 3 requests plus 1 per 100 books (7 for a 335-book library), and an unchanged library
costs 2. It reads after every
catalog rebuild and checks every 15 minutes. With Calibre closed it keeps using the saved copy and
tries again after 15, 30 and 60 minutes, then every 2 hours at most, with one log line per outage.

- **A match is exact** by your pin, a `!book link`, the read-along's own Calibre book, the ISBN,
  the title and the author's surname, or the series, number and author. A title that is only a
  series name ("Mistborn") is never matched to a book in that series by title alone, and two
  translations of one book each take the record that names their translator. **Two records that
  fit equally well match neither**; `!book edit <book> calibre <id>` settles it. A record that only
  shares most of the title words is a likely match.
- Calibre's own way of writing authors, surname first ("Weir, Andy"), matches a book by Andy
  Weir, and a blank author it fills reads "Andy Weir".
- An exact or pinned match fills blank details (never the publisher) and gives the book its
  section from the record's tags. A likely match only gives the section, and only when nothing
  better does.
- `!book calibre` (owner only, `ownerId` set) answers from the saved copy, so it never waits on
  Calibre: counts of exact, pinned, likely, ambiguous and unmatched books, how many records the
  copy holds and when it was read, whether Calibre answered at the last check, then pins to check,
  ambiguous books with the candidate ids, and **the audiobooks with no Calibre match**. `!book
  calibre all` adds the matched books, and `!book calibre refresh` reads Calibre again in the
  background and replies at once. Long reports run to 5 messages at most.
- With the setting off or `calibreUrl` blank, `!book calibre` says how to turn it on.

**Fixing the catalog by hand.** `!book edit` writes `data/book_overrides.json` for you, and you can
also edit it yourself to correct series, order, titles or what counts as a book. Every key is
optional:

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
  in play order; files you leave out keep their order after the listed ones. `title`, `author`,
  `series`, `sequence`, `narrator`, `edition` and `publisher` override every other source (`null`
  means none, except for `title` and `author`), `exclude: true` drops the work, and `pinId` gives
  it an id that survives a folder rename. A detail set under a book's old id still applies after
  a rename. `partOrder`, `exclude` and `pinId` are read under the id detection gives now; one
  written under an id the catalog still knows as the book's alias is carried to the new id at
  every rebuild, and the file is left as you wrote it. `!book edit <book> exclude` also writes the
  book's `folderKey`, so that exclude holds whatever id the book gets. A hand-written exclude
  under an id the catalog no longer knows stops applying, and every rebuild logs "overrides name a
  work that was not detected" for it.
- `include` and `exclude` take a folder exactly as `/book rescan` prints it (slash direction and
  case do not matter), or a Plex album ratingKey. For a box set spread over sibling folders, use
  the parent folder.
- `podcastArtists` adds artists (by Plex ratingKey) to keep out of music entirely, for podcast
  artists the detector missed. A detected podcast's artist is already kept out, so a new episode
  album stays out of music before the next rescan sees it.
- `authors` sets a series for every book by that author, with `order` giving each title its
  number. The key is the author as detected, in id form (`dan-simmons`). Without `order`, the
  series only names that author's books that have none.
- `!book edit` also writes `works[id].genre`, `authors[slug].genre`, and for a Calibre pin
  `works[id].calibreId` (a number, or `null` for none) with `calibreUuid` and `calibreLibrary`.
  All of them are found under a book's old ids too.

Run `/book rescan` after editing it. A typo in the JSON is logged and reported by `/book rescan`,
and the file is ignored until it parses; `!book edit` refuses to touch it meanwhile, so a hand edit
is never lost. A file saved with a byte order mark (Notepad's UTF-8) reads fine. Every `!book edit`
write keeps the previous text in `book_overrides.json.bak` and replaces the file in one step, so a
crash mid-write leaves the old file whole.

**Files.** `data/book_catalog.json` is the catalog (rebuilt from Plex if you delete it).
`data/book_bookmarks.json` holds everyone's places, keyed by Discord user ID, with an hourly backup
beside it in `book_bookmarks.json.bak` that the bot loads automatically if the main file is ever
found damaged. Both, and the overrides file, are gitignored. If a bookmark write fails, the card
shows a warning and the command log gets a `book-save-failed` line (`npm run logs -- --raw`).
`data/book_tags.json` caches the tags read from the files, keyed by each file's path, size and
date, so only new or changed files are opened again; a file that cannot be opened is remembered
too and tried again after 30 days or when it changes. `data/book_lookup.json` holds the online
answers, and `data/book_calibre.json` the Calibre index's copy and matches. All three are gitignored, as are `book_overrides.json.bak` and the `.tmp` an edit writes
through; the tag cache is keyed by file paths on this PC.

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
| `!book marks [title]` | The sync marks set on a book with 📌 (default: the one playing). |
| `!book unmark [n]` | Removes your latest mark on the book you are playing, or mark `n` of the list if it is yours. |
| `!book unmark all [title] confirm` | Owner only: clears every mark of a book. Without `confirm` it says how many marks, from how many listeners, it would clear. |

On `/`: `/book text mode:on` (or `off`, `now`, or no mode for the status),
`/book link title:<book> ebook:<id, ISBN, path, off, auto or pictures:redo/off/on>`, `/book marks [title]` and
`/book unmark [which:<n or all confirm>] [title]`.

**The page.** One DM message, edited in place. Each page is about 180 words, roughly a minute of
narration at 1x. Its buttons:

- ◀ Page and ▶ Page browse the book. The page stops following the narration until you press 📍.
- 📍 Now jumps to where the narration is and follows again.
- ↪ Play from here moves the audiobook to the start of the page you are reading, and resumes it if
  it was paused.
- ✖ Off turns the read-along off.
- 📌 Narrator is here, in a row of its own, sets a sync mark (below).

Following never skips a page, even at 3x; it turns at most once every 12 seconds. When the book
stops, the page says so and loses its buttons. The first time a book's text is used the bot reads
the ebook once; if that takes more than a moment the DM says "⏳ Preparing the text of The Way
of Kings (first time only)…" and turns into the page when it is done. After that the text is kept in `data/book_text/`
(gitignored), so it works with Calibre closed.

**📖 on the book card.** Shows the current page as a private reply only the person who pressed it
can see. The button appears only on a book whose ebook was found. **The listener can use it from
anywhere; anyone else only while they are in the book's voice channel**, since they hear the same
words. The listener's page has ◀ ▶ 📍 ↪ and 📩 Follow in DMs in place of ✖ Off. Anyone else gets
◀ ▶ 📍 only: ↪ and DM follow-along stay the listener's whatever `audiobookControls` says, and
someone allowed to move the book does it with the card's buttons. Every
click checks the voice channel again, so someone who leaves it gets "🔊 Join `<channel>` to read
along." in place of their page, and anyone outside it gets that line and no text from the start.

**If your DMs are closed** to the server, `!book text on` says so; use 📖 instead. When a page
would open by itself (the read-along is on and you start a book), the bot posts one short line in
the card's channel instead, at most once per book session, with no book text and no ping.

**How close it follows.** There is no speech recognition. A track named after a chapter pins that
chapter's text to it, and between those the bot goes by reading pace. A single-file book's own
chapter markers count the same way when their lengths match the ebook's chapters: on The Martian
the page is within a minute of the voice at every log entry, where reading pace alone ran up to
27 minutes behind. Markers numbered by the publisher in other places are left out, and such a book
goes by pace. Measured on The Way of Kings:
70 of its 83 tracks are named after chapters, and inside one the page is within about ±9% of the
voice (about 3 minutes in a 30-minute chapter). A book split into hour-long files has only pace to
go on: about 12 minutes off on average, 20 at worst. Every page footer says "≈ Approximate" and
"chapter-level" or "estimated from pace". **Dramatized editions (GraphicAudio, full cast) are
followed the same way and also say "dramatized edition"**, because their script is adapted and the
words you hear are not always the words on the page. Intro, credits and music tracks show "No text
for this part of the audio". In an omnibus whose tracks name the book ("Book 2 Title - Chapter
01"), each chapter is matched inside its own book, and a recorded book the ebook leaves out says it
is not in the ebook.

**Sync marks.** When the page drifts from the voice, page to the words the narrator is reading and
press 📌 as the voice reaches the first words of the page on screen. That moment is pinned to that
page's first word, and the page snaps there. The footer says "📌 Marked at 1:23:45" once, and the
stretches on either side of the mark say "marked" instead of "chapter-level" or "estimated from
pace".

- The bot takes 0.7 s off the moment you clicked, for the time it takes to hear the word, click
  and reach Discord.
- **A mark helps everyone who plays that recording**: their open pages move to it at once. Two
  narrations of one book keep separate marks, and so does a narration that replaces another in the
  same folder: the old one's marks are kept but not used.
- While a track named after a chapter plays, a mark is refused on any page outside that chapter,
  however near. On hour splits and other tracks that name no chapter, it is refused when the page
  is outside the ebook chapter the bot estimates and more than 10 pages from that estimate. The
  note asks you to page to where the narrator is first. A paused book refuses marks too, and so
  does a track with no ebook text (an intro, the credits, or a book of an omnibus that the ebook
  leaves out).
- A second mark within 20 seconds of audio of another, or on the same page, replaces it.
- A mark beats the bot's own chapter matching where the two disagree. Where two marks disagree,
  the newer one is used.
- Marks belong to one copy of the ebook's text. When the ebook changes (a new EPUB, a relink),
  the old marks are kept but not used, and they apply again if that text comes back.
- `!book marks` lists them with audio time, chapter, who and when, and never any book text.
  Everyone can remove their own; the owner can remove any one and clear a whole book, which asks
  for `confirm` first. A book whose title starts with "All" or is a number (`!book unmark 1984`)
  is read as that title.

Marks are kept in `data/book_text/marks.json` (gitignored).

**Where the text comes from.** First match wins:

1. A link the owner set with `!book link`.
2. Calibre's content server, at `calibreUrl` (default `http://127.0.0.1:8080`; `/config` →
   Integrations). The bot only reads from it. It finds a book by its title, or by its series number
   and author, so The Final Empire finds a Calibre book titled "Mistborn" (series Mistborn, book
   1). A volume number written as a word ("Book Two") counts as the number. While the Calibre
   index is on, a book with no ebook yet takes the index's exact match. The content server runs
   only while the Calibre app is open with its server started.
3. `.epub` files in the folders that hold the book's audio files (`audiobookTextSidecars`, on by
   default). The file name has to match the title; a companion book or another title in the same
   folder is skipped.

DRM-free ebooks only. If two ebooks fit equally well, none is picked, and `!book link` settles it.
Podcasts have no text.

**MOBI and AZW3 books in Calibre.** A Calibre record with no EPUB but a MOBI, AZW3 or another
format Calibre's `ebook-convert` reads (KEPUB, AZW, PRC, FB2, FBZ, DOCX, HTMLZ, ODT, LIT, PDB) counts
too, while `audiobookTextConvert` is on (the default) and `ebook-convert` is found (in Calibre's
install folder, on PATH, or at `calibreConvertPath`). The card shows 📖 for it. **The first open
downloads that file with a GET, converts it to EPUB in the bot's own cache at Below Normal
priority, and reads it**: about 3 s for a 0.9 MB MOBI and 6 s for a 2.7 MB AZW3 on this PC, 5
minutes at most. The DM page says "⏳ Preparing the text" meanwhile, and `!book text` says
beforehand that the book will be converted. One book converts at a time for the whole bot, once
per copy: the text is kept like any other, so it opens again with the converter gone or the
setting off, and only a replaced file in Calibre converts again (a tag or title edit does not).
**The Calibre library is never changed**: no format is added to the record. An EPUB in the same
record, or an EPUB record of the same book, is read first. PDF, AZW4, KFX, comics, TXT and RTF
are not converted. A DRM-locked or damaged file fails once with the reason and is not tried again
until the file changes. A conversion that runs out of time is tried again when someone runs
`!book text on` or `!book text now`, and on its own after 10 minutes; `!book text` alone only
reports it. With the setting off or `ebook-convert` missing, such a book shows no 📖,
and `!book text`, `!book link <title>` and `!book calibre` say why.

**Pictures from a scanned PDF.** Off by default (`audiobookTextPictures`, `/config` →
Audiobooks). When a book's Calibre record holds a scanned PDF of the printed edition beside the
text the read-along reads (its EPUB, or the MOBI or AZW3 it converts), the PDF's illustrations show
on your DM page and on the 📖 page when the narration reaches the start of the printed page they
are on. A picture printed among the text is cropped to its art, a full-page picture is shown whole
with the page of text that follows it, and two facing pages that make one picture are joined side
by side. When the page of text that follows is never narrated, as for a last illustration facing
the back matter, the picture shows with the page before it instead. Each picture's alt text names
its printed page ("Picture from the printed book, page 10") when the scan's page numbers can be
read, and no page otherwise. **Pictures never go to a channel.** Nothing is downloaded until
someone reads along: the first open of the text downloads the PDF once (a GET) and reads it at
Below Normal priority with Calibre's own PDF tools and ffmpeg, which takes about 4 to 6 minutes for
the 264 pages of Harry Potter and the Sorcerer's Stone on this PC (3:44 in one run, 6:12 in another
while other apps kept the PC busy), and `!book text` shows how far it is. The PDF is then deleted.
The pictures are kept as JPGs in `data/book_text/pictures/` (gitignored; 16 MB for that book;
past 1 GB in all, the books read along least recently lose theirs first), so they show with
Calibre closed, and a new copy of the ebook is only lined up with them again, in seconds.
One PDF is read at a time for the whole bot. On that book 119 pictures were found and 114
placed (the other 5 come before the first printed page that lines up with the text, and are dropped
as front matter), and each chapter's opening picture landed on the chapter's first word.

- It needs Calibre installed on this PC, whose PDF tools are in `Calibre2\app\bin`. The
  `pdftotext` that Git for Windows puts on PATH is an older program without the output needed, and
  is skipped. Installing or updating Calibre while the bot runs needs no restart: the tools are
  looked for again a minute later.
- The PDF needs a text layer (OCR), because printed pages are lined up with the ebook by their
  words. A scan without one gives no pictures, and so does one where under 60% of the printed text
  pages match the ebook.
- The PDF can be at most 300 MB and 1,000 pages; a bigger one gives no pictures ("it is too
  large").
- When a reading fails, the 🖼 line of `!book text` says why, and when it tries again if it will.
  A PDF that is password-protected, damaged, without a text layer or too large is not read again
  until it changes, `pictures:redo`, or the first restart after 30 days. Calibre not answering is
  retried after 2 minutes (a book not yet seen with a PDF gets no 🖼 line meanwhile), and a PDF
  Calibre lists but has no file for after 10; a reading that hangs, stops partway or cannot write
  its files is tried again after 30 minutes, three tries in all.
- A page shows at most 10 pictures; the footer says "🖼 10 of 12 pictures" when more are printed there.
- A record with only a PDF has no text to read along, so no pictures either: add an EPUB, MOBI or
  AZW3 to it. `!book link <title>` and `!book calibre` say so.
- The Calibre library is never changed.

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
| `!book link The Final Empire` | What it uses now, and the Calibre books and files it considered. Typed in a server channel, the reply names Calibre ids and file names only, and the full paths go to you by DM. With `audiobookTextPictures` on, its 🖼 line says whether the record has a PDF and, for one that does, the PDF's size, pages and date, how many pictures it gave, and how much of the text they line up with; with Calibre closed, a book the bot has not yet seen with a PDF gets "not checked (Calibre isn't answering)". With the setting off, the line only says pictures are off (and how many are kept), and the 📚 line marks a record that holds a PDF with "+ PDF". |
| `!book link The Final Empire pictures:redo` | Deletes this book's pictures and reads its PDF again from the start (a few minutes); its pages show no pictures until that ends. Another narration of the same book that shows the same pictures keeps them until the new ones are ready, and if this reading fails for a reason that passes (Calibre closed, say), this book shows them again too while the reading waits to be tried again. A restart does not lose the reading: it runs on the book's next open. |
| `!book link The Final Empire pictures:off` | Hides that book's pictures from open DM pages at once (a 📖 page drops them on its next click). They stay on disk, and the switch outlives a new PDF and a `pictures:redo`. |
| `!book link The Final Empire pictures:on` | Shows them again, with no new reading. |
| `!book link auto` | With no title, `auto`, `off`, `id:N`, `isbn:N`, a path or `pictures:redo`/`off`/`on` applies to the book playing in this server, else your most recent book, and the reply starts "📖 For **Title**, the book playing here:" or "…, your most recent book:". A book whose title is exactly "Off" is still described, not linked. |

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

**When the PC loses Discord for a while**, the bot holds its messages, card updates and replies
for up to about 2 minutes and sends each one within about 15 seconds of the connection coming
back, so they arrive late.
The bot log says `Discord is unreachable; holding sends and retrying` when it starts and
`Discord reachable again after N s; K sends went through late` when it ends. A send that never got
through logs `Discord send gave up`. A slash command or button used during the drop can still
fail, because Discord gives the bot only 3 seconds to acknowledge it.

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
| `/book edit` | `title:`, the book; with no `field:` it shows where each detail came from |
| `/apmedia yaml` | none, but it needs `name:`, the slot name the list is for, or `file:`, a YAML that names one |
| `/apmedia link` / `unlink` | `slot:`, the slot name in the room |
| `/apmedia check` / `redeem` / `ff` | `title:`, a title on your list, from the autocomplete |
| `/apmedia announce` | `mode:`, `on` or `off` |

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
| `/book play [title] [from-start]` | Start or resume a book or podcast in your voice channel. No title resumes your latest. A series or author name resumes your book in progress there; a typo asks "Did you mean …?" with a button and never starts anything. See **Finding a book by name**. Prefix: `!book play <title> --restart`, also `!book start` / `!book listen`. |
| `/book pause` / `resume` / `stop` | Stop saves your place and leaves voice, and starts any music queued during the book. |
| `/book back [seconds]` / `forward [seconds]` | Jump 10 s to 10 min from the list (default 30 s), across part boundaries. Prefix takes any length, such as `90`, `1:30` or `2m`, and `!book rewind` / `!book fwd`. |
| `/book goto <time>` | `1:23:45` from the start, or `+5m` / `-90` from here. |
| `/book chapter [number]` | Jump to a chapter; no number lists the chapters around the current one, each named the way the card names it ("240 · Book 4 · Chapter 7 · The Candle in the Wind"), with the number to type first. Prefix also has `!book next` / `!book prev`. |
| `/book speed <rate>` | 0.75x to 3x, pitch kept. Saved per book; a new book starts at your last speed. |
| `/book sleep <after>` | Stop after 5–90 minutes of listening (prefix: any whole number of minutes up to 1440), or at the end of the chapter, or `off`. Paused time does not count. |
| `/book now` | Post the book card again at the bottom of the channel. |
| `/book shelf` | Your books in progress and finished, with Resume buttons; podcasts say "caught up" or "new episodes". |
| `/book library [filter]` | The sections, with menus to open one or to play a book you are partway through. A section name or a filter (`author:x`, `series:x`, `section:x`, `unread`, `listening`, `finished`, `short`, `long`, `podcasts`, or words) lists books by series with your progress, 25 to a page, with a Play menu. See **Browsing the library**. |
| `/book stats [user]` | Hours listened, book hours covered, books finished, top three. |
| `/book leaderboard` | Hours listened in this server. Public. |
| `/book finish [title]` | Mark a book finished (default: the one you are listening to). |
| `/book forget <title>` | Drop your place in a book. Asks first: a button on `/`, `!book forget <id> confirm` on `!`. |
| `/book text [mode]` | The read-along: `on`, `off` or `now`; no mode shows its status. The text goes to your DMs. See **Reading along**. |
| `/book link <title> [ebook]` | Owner only, and `ownerId` must be set: tie a book to its ebook (a Calibre id, an ISBN, an EPUB path, `off` or `auto`), or `pictures:redo`, `pictures:off` or `pictures:on` for its PDF's pictures; no ebook shows what it uses now. |
| `/book marks [title]` | The read-along's sync marks on a book (default: the one playing): audio time, chapter, who and when. See **Sync marks**. |
| `/book unmark [which] [title]` | Remove your latest sync mark, or `which:3` for a listed one of yours. `which:all` is the owner's and says what it would clear; `which:all confirm` clears the book. |
| `/book rescan` | Owner only (anyone while `ownerId` is blank, as with `/config`): re-read the library from Plex now and report what changed, doubtful groups, music split off book folders and the online lookup. See **What `/book rescan` reports**. |
| `/book edit <title> [field] [value] [position]` | Owner only, and `ownerId` must be set: fix a book's title, author, narrator, publisher or series, name a whole series, set its library section (`genre`, `author-genre`), tie it to a Calibre record (`calibre <id\|none>`), take a book out of the catalog or bring it back, or look it up online again. No field shows where each detail came from. See **Fixing a book's details from Discord**. |
| `/book calibre [show]` | Owner only, and `ownerId` must be set: the audiobooks with no Calibre match, ambiguous ones and pins to check. `show:all` adds the matched books, `show:refresh` reads Calibre again. Needs `audiobookCalibreSort`. See **Sorting with Calibre**. |

The card has Previous chapter, −30 s, Pause/Resume, +30 s and Next chapter, a speed button that
cycles 1x–2x, a sleep button that cycles off, 15, 30, 60 minutes and end of chapter, 📖 Text (only
on a book whose ebook was found; the listener's private page), and Stop. A
card from an earlier session loses its buttons when clicked; `/book now` shows the current one.

The card's chapter line says what the track itself names: "Book 4 · Chapter 7 · The Candle in the
Wind" in an omnibus, "Chapter 21" or "Prologue" where a track is a chapter, "Part 13 of 31 ·
Section 1 of 6" for GraphicAudio's coded chapters, "Episode 3 of 8" in a podcast, and "Part 7 of
19" with the track's title after it when that adds anything. It used to count files ("Chapter 240
of 319"). The shelf, the jump and resume replies and the "can't find the file" message use the
same words, and `/book chapter <n>` still jumps by the same numbers.

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
- `!ap next [id] [slot]`: The unchecked locations your slots can reach **in logic right now**, by the seed's own rules and the items every slot in the room has received. With no slot named it answers for **every slot you have claimed**, earliest sphere first; name one to narrow it. Only ever your own slots, and it never says what is in them. Across several slots each block reads like `sphere 1: 56 in logic · +1,177 later · 1,696 locked` over three names from its soonest sphere, and slots with nothing in logic yet are named together at the end rather than given a block. **Name one slot, or hold only one, and it lists everything that slot has in logic, 15 to a page**, with ◀ ▶ buttons under the reply: the soonest sphere first, then each later sphere under an italic `Sphere 2` line of its own. Every page repeats the slot's line and the counts it closes with, such as `Also in logic: sphere 2 (21) · 665 still locked`, and says `Page 1 of 17`. Only the person who asked can turn the pages. A list is kept for 30 minutes after its last use, and not across a stop and start of the bot; a click after that says to ask again. **⭐ marks a location somebody has hinted** and is still waiting on. Hinted locations in logic are listed first, from any sphere (`⭐ <name> · sphere 3` when that is not the soonest), and, in an answer from the seed's own logic, hinted locations not in logic yet are counted, as `⭐ 1 hinted locked` on a slot's line and `⭐ 1 hinted still locked` in the closing counts. A hint the waiting player has marked avoid gets no star. (`!ap hints` stars only priority hints.) Slots that have already goaled or been released are skipped and counted off at the end, so a mostly-finished async still answers about the slots you are actually playing, and asking about finished slots alone answers at once without loading anything. Exact logic needs the seed to have been generated with the Archipelago install at `archipelagoInstallDir`, and such a seed needs nothing run by hand (see **What `!ap next` needs** below). Any other seed gets **sphere 1 only**, which needs nothing and so is always in logic, and the reply says so with a short reason such as "this seed was not generated here". The install's paths and the helper's own errors stay out of the channel; when loading failed, the reply points at the bot log, which has them.
- `!ap hints [id] [slot]`: Outstanding hints nobody has collected yet, priority ones first. With a slot, both what that world owes and what it is waiting on.
- `!ap hintpings [id] [slot] [off|dm|channel]`: Be told when somebody hints an item out of **your** world. **Off by default** and separate from `!ap pings`, which is about items arriving for you. The first read of a room is absorbed silently, so opting in never replays a backlog at you.
- `!ap markers [id] [on|off]`: Prefix 🟪 progression, 🟦 useful, 🟥 trap to item names. Plain text, so unlike the colours it shows on every client including mobile. On by default, and it works alongside colour rather than replacing it. Filler is left unmarked because most sends are filler.
- `!ap password [id] [password]`: Set a room password. The prefix form deletes your message afterwards. Clearing has to be asked for in words, `!ap password [id] clear`, because a leading number is read as the watch ID: `!ap password 0` meaning "set it to 0" would otherwise have left nothing after the ID and silently cleared it, after deleting the only other copy.
- `!ap unwatch [id]` / `!ap retry [id]`: Stop a watch, or reconnect one the server refused. Unwatching also drops every slot claim on that watch.
- `!ap catchup [id]`: Post what the channel missed while the bot was down, rebuilt from the room tracker. It also runs by itself; the command runs one now. The reply says how many lines it is posting and how many the watch's filters hide, or that nothing was missed. Run in the first two minutes after a reconnect, it posts what the tracker already shows and says when the automatic check that picks up the rest is due.

**What `!ap next` needs.** A seed generated on this machine needs nothing run by hand. Its logic is rebuilt from the Archipelago install that generated it, by a Python helper the bot starts on its own (`scripts/ap-logic-worker.py`). Two settings control it, both in `/config` → Archipelago:

- `archipelagoInstallDir`: the install, `C:\ProgramData\Archipelago` by default. Blank turns exact logic off, and every seed gets sphere 1 only.
- `archipelagoPython`: the Python the helper runs on. It has to be the version the install was built with, **Python 3.13 for Archipelago 0.6.7 and 0.6.8**. Left blank, the Windows `py` launcher finds it, so installing Python 3.13 once is usually all this takes.

The one-off requirement is that **the seed was generated with that install**, and its output zip, `output/AP_<seed name>.zip`, is what tells the bot so. The helper reads the multidata from that zip and the seed number from the first line of the spoiler inside it, with the install's `logs/Generate_*.txt` as a spare for a seed generated without a spoiler. It re-rolls the seed's yamls with the plando options the run used, read from that same log, and compares every slot's name and game with the multidata before building anything. A seed from anyone else's machine, or generated in race mode, gets sphere 1 only.

**The bot keeps its own copy of the seed the first time it sees the room**, in `data/archipelago/seeds/<seed name>/`: the yamls the seed's Generate log names, the output zip, the seed number and the run's plando options. The helper rolls that copy from then on, so **the install's `Players` folder is free to move on to the next async**, and a seed generated without a spoiler keeps its number after Archipelago deletes the Generate log a week later. Before the copy, five yamls for the next game, added to `Players` the morning after the 35-slot seed of 2026-11-09 was generated, stopped that seed rebuilding at all. A copy is only made while the Generate log still exists, every yaml it names is still in `Players`, and none has been saved since the run started. When one cannot be made, the bot log names the file that stopped it, and the helper rolls only the yamls in `Players` whose players are the seed's slots, by name, which works while the seed's own yamls are still there unedited. The 35-slot seed's copy takes 2.4 MB. Nothing deletes a copy, so remove a seed's folder once its game is over.

**The helper loads when the room connects**, in the background, so `!ap next` is ready before anybody asks: on the 35-slot room it was ready in 28 seconds, and one answer for 24 slots then took 184 ms. It holds about 0.5 GB while it runs. A `!ap next` asked while it is still loading says the seed's logic is loading and waits for it. It holds one seed at a time: a room on another seed that connects later leaves it alone, though that seed's yamls are still copied, and asking `!ap next` about that other seed replaces it. `!restart` leaves it running. Nothing is written into the Archipelago install.

The helper is stopped, and its memory handed back, when the last watch on its seed is removed, when the configured room is pointed at a different one, when `archipelagoEnabled` is switched off, or when `archipelagoInstallDir` is blanked, each as it happens rather than at the next `!ap next`. It is also killed when it takes longer than 60 seconds to answer, and the next `!ap next` starts a fresh one. Otherwise it runs until the bot exits.

Every slot is checked against the seed's multidata before it is answered from the rebuild, and a slot that does not match gets sphere 1 only, with the bot log naming it. Items handed out with `/send` or `!getitem` count for what they are, the same as items somebody found. Each answer counts every slot's received items, and the rebuild has the seed's real items put back where generation placed them, because one game's rules can depend on both: the Dungeon Defenders apworld keeps any location in the room that holds one of its actions out of logic until the Dungeon Defenders player has that action's hero. Before this, 8 of the 35-slot seed's slots failed the check; now all 35 pass.

**When the rebuild cannot be made**, because the yamls no longer match the seed, no seed number can be found, or the seed was generated in race mode, the helper still loads and answers every slot from the seed's own sphere 1, the reply says the seed could not be rebuilt, and the bot log has one line saying why. The next `!ap next` after ten minutes tries the rebuild again, and so does the first one after a copy of the seed's yamls appears that the helper was not started with. When the helper cannot start at all, the reply gives the short reason, the bot log has the details, and the bot does not try that seed again for ten minutes, but saving a different `archipelagoInstallDir` or `archipelagoPython` clears that at once, so a fix is tried by the next `!ap next`.

**Sphere 1 without the helper** comes from sphere data files. A seed generated here needs one only when the helper cannot start, and the reply then gives the one command to run from the bot's folder, with the paths filled in and quoted so it pastes into PowerShell as it stands, such as `python scripts\extract-spheres.py "C:\ProgramData\Archipelago\output\AP_<seed name>.zip"`. That covers every location. The command names the zip in the install's `output` folder, or the bot's copy when that one is gone, and the reply gives the spoiler instructions below when neither is there. For a seed from elsewhere, save its spoiler log as `data\archipelago\spoilers\<seed name>.txt` in the bot's folder; it only covers the placements the seed's completion depends on (about a tenth). An answer from the spoiler lists its sphere 1 locations with no count, and never says a slot has nothing left, because the spoiler cannot know either.

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

### 🎬 Plex Media world (Archipelago)

Off unless `apMediaEnabled` is set. The Plex Media world is an Archipelago game made from your
Plex library: each slot is one person's list of titles, items from the multiworld unlock them, and
watching or listening sends the checks. It needs the room monitor above (`archipelagoEnabled`):
each slot's game client connects through a watched room. The player's side lives with the world
itself. Its [game page](apworld/plex_media/docs/en_Plex%20Media.md) lists the items, locations and
YAML options, and its [setup guide](apworld/plex_media/docs/setup_en.md) walks a player through
joining.

**What a list holds.** Movies, TV episodes, music and audiobooks. Music comes as whole albums, or
as a Plex audio playlist cut into parts of up to 15 tracks, and audiobooks come from `/book`'s
catalog. A list mixes random picks (narrowed by genre, years, and what that person has not watched
yet), hand-picked titles, and a Plex playlist or collection. A few titles start open
(`starting_unlocks`: 3 unlock copies by default, more on a long list), and the multiworld sends the
rest: one unlock per movie, album, playlist part or book, and one per 3 episodes of a show
(`episodes_per_unlock`, or a season at a time with `tv_unlock: season`). A Wild Ticket (2 by
default, fewer on a short list) opens a locked title of the player's choosing. The goal is to
finish 80% of the list (`goal_percent`), and the bot sends it once that many titles are done.

**Timesanity.** Every title also has checkpoints at fixed times into it: every 15 minutes of a
movie, every 10 of an episode and every 30 of an audiobook by default, and none in albums and
playlist parts unless the YAML sets `timesanity_albums`. A 102-minute movie has checkpoints at 15m,
30m, 45m, 1h, 1h15m and 1h30m, and none in its last 10%. A checkpoint counts when playback passes
it while playing. Finishing a title also sends all of its checkpoints, so a watch the bot could not
follow live still pays out; `timesanity_strict: true` turns that off. Strict also wants everything
before a checkpoint played where the bot can see it, in voice or in a Plex app while the bot runs,
over any number of sittings, and a checkpoint already earned counts as everything before it heard.
A gap under 30 seconds is forgiven. In a Plex app, which the bot looks at every 15 seconds, so is a
seam of up to about 50 seconds between two stretches, such as a stop and resume or a Plexamp track
change. A longer skip, Plex's Skip Intro included, has to be played before the checkpoints after it
count. Checkpoints hold only filler by default (`checkpoint_items: filler_only`).

**How a play is counted.** Only plays after the seed was generated count. The bot sees them in
five places:

- **Plex history** of each linked account, read every `apMediaHistorySeconds` (120). A movie or an
  episode counts once Plex marks it watched, at 90%, and an album or playlist track once Plex logs
  the play. Each read covers the last 7 days, so a Plexamp play made offline and synced up to 54
  hours later still counts.
- **Live Plex sessions**, read every `apMediaSessionSeconds` (15), send checkpoints while a title
  plays, the stretch played just before a pause included. A seek forward earns nothing: a step
  counts only while it fits the time that passed, and a move made while paused is a seek.
- **Music the bot plays in voice** counts a track once 85% of it has played, for each person who
  was in the channel both when it started and when it ended, minus the deafened. A track cut
  short by `!skip` still sends the album or playlist checkpoints it played past.
  Hitster clips count for nothing, since a credit line would give the song away mid-round.
  `apMediaVoiceCredit` turns this off. The bot's own playback never reaches Plex history.
- **The bot's audiobook player** sends a book's checkpoints as they are listened through, and its
  finish once the book is marked finished (its last part plays out, or `/book finish`). Both count
  only for the person playing the book.
- **By hand**, with `/apmedia check`, for anything the bot could not see.

A title played before its unlock arrives keeps its checks banked (`locked_watches: bank`, the
default), and they go out with a 🔓 line when the unlock comes. With `ignore`, it counts for
nothing.

**Items and traps.** A seed made with world 0.3.0 or later deals each list more than its unlocks
and Wild Tickets. The [game page's Items table](apworld/plex_media/docs/en_Plex%20Media.md#items)
says what each item does, and its "Items and traps" options say how many come. `/apmedia yaml`
says what a list's pool will hold, and the slot's welcome what it holds.

- **Snacks** are the filler: Popcorn, Nachos, Large Soda, Candy Bar, Hot Dog, Soft Pretzel and
  Ice Cream Sandwich, dealt in turn (Popcorn alone with `snack_variety: false`). The Snack Bar,
  `/apmedia snackbar`, trades 10 of them (`snack_bar_price`) for a Fast Forward or a Remote
  Control, 3 times a slot (`snack_bar_trades`). Every snack counts the same.
- **Fast Forward** (2 by default, `fast_forwards`): `/apmedia ff <title>` spends one. It sends the
  title's first checkpoint not earned yet, however far into the title it lies, a movie's and an
  audiobook's included. Under `timesanity_strict` it counts the 10 minutes after the furthest point
  heard as heard instead, and sends what that reaches; one that reaches no checkpoint yet is spent
  all the same. It never sends a watch, a track or a finish, and on a locked title its checkpoint
  is banked (refused under `locked_watches: ignore`).
- **Remote Control** (1 by default, `remote_controls`) works by itself: one that arrives while a
  trap is at work on the slot ends it, and otherwise it is kept and blocks the next trap. With more
  than one at work, it takes Buffering first, then the Rights Expired that ends last, then the trap
  acting on what the bot plays, then the oldest one waiting to hit.
- Wild Tickets, Fast Forwards and Remote Controls, in that order, fit only where the unlocks leave
  room among the list's own watches, tracks and finishes, so a short list gets fewer: 15 movies
  with 3 starting unlocks have room for 3, two Wild Tickets and a Fast Forward.
- **Traps** are `trap_percentage` of the filler, rounded down (0 by default, so a list has none
  unless its YAML asks), shared among the seven by their weights (`buffering_weight` and so on).

| Trap | What it does |
| ---- | ------------ |
| Buffering | From the slot's next check, every check it earns for 15 minutes is held, then sent together. Another one adds 15 minutes, up to an hour. |
| Rights Expired | For 45 minutes, the checks of the title its player has playing (in Plex, in voice or as their audiobook), or else of the first open title on the list, are held, then sent. |
| Commercial Break | The bot's music plays a clip from the `apMediaTrapClips` playlist after the current track, or pauses for 30 seconds without one. An audiobook pauses for 30 seconds. |
| Shuffle Mode | The bot's music queue is shuffled after the current track (with fewer than two tracks after it, the current one starts over). An audiobook goes back 5 minutes. |
| Rewind | The bot's music starts the current track over. An audiobook goes back 5 minutes. |
| Intermission | The music or the audiobook pauses for 60 seconds, then plays on. Resumed sooner, the trap is over. Paused by someone meanwhile (`!pause`, `/book pause`), it stays paused. |
| Slow Motion | An audiobook plays at 0.75x for 10 minutes. Music never changes speed: it pauses for 30 seconds. |

The last five act only on what the bot plays for the slot's player: its music while they are in
its voice channel, not deafened, or an audiobook of their own. Until then the trap waits, for up
to 12 hours, with "🎬 `ZackPlex` got Rewind from `Watcher`: it hits during their next listen
through the bot, within 12 hours.", and then fizzles with a line. A track or book on pause counts
as no listen, a trap's own pause included. **Everyone in the voice channel hears a music trap.**
One trap acts at a time in a server, and none during Hitster, a looping track or a seek: a trap
whose player is listening then says "🎬 `ZackPlex` got Rewind from `Watcher`: it hits as soon as
the bot can, within 12 hours." instead. A pause someone makes during a trap's pause stays when the
trap ends ("🎬 `ZackPlex`: Intermission is over, someone paused the music, so it stays paused."),
and a Remote Control leaves it in place. **No trap takes away an item or a check**: what Buffering
and Rights Expired hold is sent when they end, by their timer, at the bot's next start when they
ran out while it was down, or when a Remote Control ends them.

A trap that can do nothing fizzles at once, takes no place among the two that may hit, and leaves a
kept Remote Control for the next trap: every trap while `apMediaTraps` is off, the last five while
`apMediaVoiceTraps` is off or while 20 traps already wait on the slot ("🎬 `ZackPlex`: Rewind from
`Watcher` fizzled: 20 traps already wait to hit."), and a Rights Expired with no open title
("⛔ `ZackPlex` got Rights Expired from `Watcher`, but none of its titles is open to lose."). Of
the rest, at most two hit from one batch of items, such as a release or a `!collect`, and the
others are dodged, several to a line: "🍀 `ZackPlex` dodged Rewind from `Watcher` and Intermission
from `Watcher`: at most 2 traps hit at once." The first time the bot sees a slot's items it only
counts them, so a trap that came before the link never acts, while a Remote Control or Fast
Forward that came with it is on hand. A seed made before world 0.3.0 has none of these items and
no Snack Bar.

The owner has three switches in `/config` → AP Media. `apMediaTraps` (on by default) off makes
every trap, arriving or waiting, only fizzle, with a line that names the switch ("🎬 `ZackPlex`:
Rewind from `Watcher` fizzled: traps are off on this server."). It also ends the holds running,
with their checks sent, and puts a Slow Motion speed back ("🐢 `ZackPlex`: Slow Motion ended:
traps are off on this server."). `apMediaVoiceTraps` (on) off does the same for the five that act
on the bot's playback, and its lines end "voice traps are off on this server." A trap the switch
catches as it starts fizzles the same way, a Commercial Break still reading its clip playlist from
Plex included. `apMediaTrapClips` (blank) names a Plex playlist, by name or rating key, whose audio
tracks of 3 minutes or less are Commercial Break's clips. A clip plays as "Commercial Break" by
"Plex Media" and earns nothing.

A book started during Slow Motion's 10 minutes starts at 0.75x too, and stays there: the trap puts
back only the book it slowed. A slot keeps one slowed book to put back, so a second Slow Motion on
another book puts the first one's speed back at once, with no line. Turning Plex Media off
(`apMediaEnabled`) puts every Slow Motion speed back at once, with no line.

**Friends.** A slot linked to their Discord account is all a friend needs for the music they hear
through the bot, and the audiobooks they play on it, to count. For their Plex watching to count,
the owner links them to their Plex account on this server with `/apmedia account`, and they accept:
the bot sends them an Accept button by DM, with the account's name. When their DMs are closed, it
asks them in the channel, naming them without a ping, to open them, and the owner links them
again. Only they can press the button, it expires after 7 days, and linking them again makes an
older button stale. **The bot reads nobody's Plex history before they accept**, and anyone can
take their own link back with `/apmedia account plex:none` (`!apmedia account none`). The owner
counts as Plex account 1, the server owner, with consent, unless they link themselves to another
account. History is read with the server owner's token: `homeOwnerToken` in `config/plex.js`, or
`token` while `homeOwnerToken` is blank. A managed user's token cannot read other accounts.

The account has to be named in full, or by its id: part of a name gets "Did you mean `alice`
(id 5)?" and links nobody. Case, spaces and punctuation do not count, so `movienightcrew` names
Movie Night Crew. **An account already linked to someone is refused, naming them**, and
account 1 counts as the owner's while they have linked no other. For two people who really watch on
one account, the owner adds `shared` (`shared:True`, or `shared=yes` on `!`); whatever either of
them plays on it then counts for both, and the consent request says so. When the last link to an
account goes, the history rows already read for it go too.

**Setting it up.** The owner's side, start to finish:

1. In `/config`, turn on `archipelagoEnabled` (Archipelago) and `apMediaEnabled` (AP Media).
   Neither needs a restart.
2. Run `/apmedia apworld`. It attaches `plex_media.apworld` and says whether this PC's Archipelago
   already has it, has another version, or holds a broken copy. Install it on the PC that
   generates seeds: in the Archipelago Launcher choose **Install APWorld**, pick the file, and
   restart the Launcher. **Keep it installed for as long as any Plex Media seed's room is in
   use**: `!ap next` rebuilds the seed with it, and without it answers every slot in that room
   from sphere 1. Every YAML the bot writes requires the world version it ships with
   (`requires:` names Plex Media 0.3.0), and Archipelago refuses those files while an older
   version is installed, so install the file again whenever `/apmedia apworld` says the PC has
   another version. A YAML written for 0.2.0 still generates under 0.3.0, with the new item
   options at their defaults: 2 Fast Forwards and 1 Remote Control where the list has room,
   snacks for the rest of the filler, and no traps.
3. Link your friends' Plex accounts with `/apmedia account user:@them plex:<their Plex name>`, and
   let them accept. Their lists can then leave out what they have already watched.
4. Each player builds a list with `/apmedia yaml`, from its options or from a YAML they made in the
   Archipelago Options Creator (below), and sends you the file the bot returns; `for:@user` builds
   one for someone else. Put every file, yours included, in Archipelago's `Players` folder.
5. Generate the seed and host it as usual, on archipelago.gg or on this PC.
6. Watch its room, from `/config` → Archipelago or with `!ap watch <room url> <slot>`.
7. Each player claims their slot with `!ap claim <slot>`, then links it with
   `/apmedia link <slot>`. You can link one for someone with `/apmedia link slot:<slot> user:@them`.
   With more than one room watched, `!ap claim` needs the room's id (`!ap claim <id> <slot>`), and
   its reply lists the ids. `/apmedia link` then takes the room from the claim, and asks instead
   when another watched room has a slot of the same name. A link with no claim behind it (the
   owner's) asks for `watch:<id>` while more than one room is watched.
8. The slot's game client connects, and a welcome line names the titles open so far. Its lines
   then post in the watch's channel, or in `apMediaChannelId`.

**A list from the Options Creator.** Archipelago 0.6.8 ships a visual Options Creator, and a
player can make their YAML there and have the bot fill in the titles:

1. Get `plex_media.apworld`: only the owner can run `/apmedia apworld`, and its reply is public,
   so anyone in that channel can save the file from it.
2. On the player's own PC, with Archipelago 0.6.8 or later, open the Archipelago Launcher, choose
   **Install APWorld**, pick the file, and restart the Launcher.
3. Open **Options Creator** from the Launcher, pick **Plex Media** in the game list, and type the
   slot name under Player Name (1 to 16 characters, no `{`, `}` or `%`).
4. Set the options. The group **Your list (the bot picks the titles)** tells the bot what to pick:
   a preset, a count per kind, titles, a playlist or a collection, a genre and years for the
   random picks, whether to leave out what the player has watched, episodes per show, and the
   list's name. The other groups hold the game options, which the bot copies into the finished
   file as they are.
5. Choose **Export Options** and save the file.
6. Attach it to `/apmedia yaml` (`file:`), or to a `!apmedia yaml` message. The bot picks the
   titles from the library and replies with the finished YAML.
7. Send that file to the owner. The Creator's own file holds no titles: generated as it is, it
   stops with "Plex Media list of <name>: this YAML has no titles yet. Attach it to /apmedia yaml
   in Discord, and the bot picks them from the Plex library."

**Filling in a YAML**, under the commands below, covers what the bot keeps, replaces and refuses.

**Privacy.** **Every title on a list is visible to the whole room and to the public tracker**:
hints, the spoiler and the room's log name the real titles. The slot data the tracker also serves
names no Discord user or Plex account; only the YAML file carries them. The bot reads a friend's
Plex history only after they accept, and only ever posts titles from their own list. Its welcome
line says a friend's Plex account is linked without naming it. A title is posted as text: a
masked link written into a YAML (`[text](url)`) shows as typed, so its words cannot stand in for
the address. Discord still makes the address itself a link. `/apmedia`
replies are private except `apworld`'s, while the `!apmedia` forms answer in the channel, as
`!book` does, so `!apmedia status` there shows which Plex account is linked to you. The account
list, and the "Did you mean" answer to part of an account name, are the prefix replies that go by
DM.

**Limits.**

- Item links are ignored: generation logs a warning and the link stays empty. `!ap next` still
  works for such a seed.
- A new seed starts fresh. When a watched room moves to another seed, each bound slot says so and
  stops counting, and `/apmedia retry` takes the new seed on without the old seed's progress.
- Universal Tracker cannot follow this game. `/apmedia status` and `/apmedia list` stand in for it.
- A `!seek` splits a listen in two, and each part has to reach 85% on its own for the track to
  count; the checkpoints each part played past count either way.
- One slot of a seed counts through one link: linked again through a second watch of the same
  room, it is refused (`duplicate`) and earns nothing.
- An unlink and a new link of the same slot on the same seed start its counts over: the Wild
  Tickets, Fast Forwards and Remote Controls it used count as unused again, the snacks it spent
  come back and the Snack Bar's trades start over, while what it bought there is forgotten. The
  traps it received do not act again.
- The bot keeps in memory which banked credit waited only for the room to report the slot's items
  (see **What it posts**). Across a restart such credit looks like checks that waited for an
  unlock, so a Buffering running when the items come lets it out with the 🔓 "unlocked" line.
- A pause someone makes during a trap's pause is noticed only when the trap's own pause would have
  ended, up to 60 seconds later. Until then `/apmedia status` still shows the trap, and a Remote
  Control that comes meanwhile leaves the pause alone and goes on to the next trap, as in
  "📺 `ZackPlex` got a Remote Control from `Watcher`: Intermission was over already, so it blocks
  the next trap."
- A slowed book whose session is still starting when Plex Media is turned off stays at 0.75x until
  Plex Media is on again and the trap's 10 minutes are over.
- The Options Creator's Item & Location Options (`local_items`, `exclude_locations` and the rest)
  offer only the world's fixed names: `Unlock 1` to `Unlock 20000`, `Check 1` to `Check 60000`,
  the items Popcorn, Nachos, Large Soda, Candy Bar, Hot Dog, Soft Pretzel, Ice Cream Sandwich,
  Wild Ticket, Fast Forward, Remote Control, Buffering, Rights Expired, Commercial Break, Shuffle
  Mode, Rewind, Intermission and Slow Motion, the item groups Snacks, Useful, Traps and
  Everything, and Everywhere. A title gets its item and its locations only when the seed is
  generated. Everything and Everywhere mean the player's own list; Snacks, Useful (Wild Ticket,
  Fast Forward and Remote Control) and Traps mean those items.
- The first-seed rehearsal (Phase 17A of [BUGTESTING.md](BUGTESTING.md)) ran world 0.2.0 on
  2026-11-13 with the owner and one friend, on a seed hosted on archipelago.gg. Of its 27 checks,
  21 were marked passed, 1 was marked failed and 5 were not run. The Options Creator's own window,
  a YAML attached in Discord, the upload, the owner's live Plex session, Plex history, music in
  voice and an audiobook all worked, and the friend's Plex sessions were matched to their account,
  with their album counted through Plex history. Not tried yet: a room hosted on this PC with
  `ArchipelagoServer.exe`, a locked title's checks banked and then sent by its unlock (its check
  was marked passed, but the log shows it never ran), and a friend's own checkpoints from a Plex
  movie or in voice. The failed check, installing the world with every Archipelago program closed,
  has no note, though its expected lines all came.
- None of world 0.3.0's items and traps has met a live room, the bot's voice playback, a Plex
  clip playlist or an audiobook session yet. Phase 18 of [BUGTESTING.md](BUGTESTING.md) is their
  checklist.

**What it posts.** `apMediaAnnounce` decides: `completions` (the default) posts a title finished,
banked or unlocked, `all` adds a line for every credit that finishes nothing (a checkpoint, an
album track), and `off` posts none of those and no welcome. A refusal, a lost watch and a new seed
are posted whatever it says. Lines go out at most once per `archipelagoBatchSeconds` in each
channel, every line of the batch however many, and never ping anyone. While no Discord client can
post them (a `!restart`), up to 200 lines per channel wait for 5 minutes, and the log says how many
older ones it dropped. A player can silence their own slot with `/apmedia announce off`. The
item and trap lines (a Fast Forward or a Remote Control received, a trap hitting, waiting,
ending, dodged or fizzled, a hold ending) follow the same rules: `completions` and `all` post
them, and `off` or a slot's own `announce off` silences them. A credit a trap holds back reads
"⏳ `ZackPlex` watched **The Matrix (1999)**, 9 checks held until 21:40", the time in each
reader's own zone, and with `all` a checkpoint held gets a ⏳ line too. Credit counted before the
room has reported the slot's items, as just after a start, while the room is out of reach or while
the slot is refused, waits for them and then counts as new: a Buffering, running or waiting for the
slot's next check, holds it with that ⏳ line, and so does a Rights Expired on its title. Checks
that waited for an unlock or a Wild Ticket go out past a Buffering, with the 🔓 line. A Rights
Expired holds every check of its title, and its ⏳ line comes even when the bot restarted before
the items did.

**Health, logs and files.** `!diag` and the 15-minute health check carry an `ApMedia:` line. It
warns while `archipelagoEnabled` is off, shows an error for a refused slot, a slot whose watch is
gone (naming 5 slots at most), or 3 failed Plex history reads in a row, and otherwise reads like
`2 slots, 2 connected, Plex history read 1m ago`. The command log (`npm run logs -- --raw`) gains
`apmedia-credit`, `apmedia-refused`, `apmedia-stale`, `apmedia-orphaned`, `apmedia-goal`,
`apmedia-fastforward` and `apmedia-snackbar` lines, and an `apmedia-trap` line for each trap with
its `outcome`: `hit`, `armed` (waiting to hit), `blocked` (by a Remote Control), `dodged` or
`fizzled`. Slot links are kept in `data/apmedia_slots.json`, with their unsent and held checks,
the item cursor, the holds and traps at work, and the items spent and bought. Plex account
links and consent are in `data/apmedia_accounts.json`, the Plex history rows already read in
`data/apmedia_marks.json`, and each slot's slot_data under `data/archipelago/apmedia/`. All of
them are gitignored.

**Building and testing the world.** `npm run build:apworld` writes `dist/plex_media.apworld`
(gitignored), the same file `/apmedia apworld` attaches. `npm run test:apworld` runs
`py -3.13 -O -s -S -B apworld/tests/run.py`: the pure tests always, then real seed generations
with the frozen Archipelago at `C:\ProgramData\Archipelago` when it is installed, writing nothing
into it, and one run of the bot's side against a real MultiServer room. `--pure` stops after the
pure tests, and `--only A0,F` runs scenarios by the class name's part before its first underscore:
`A0` the built file, `A1` the Options Creator's rules, `A` both solo lists, `F` the item-link seed
with the `!ap next` worker's checks, `G` that run against MultiServer, and `H` the list settings
and three Options Creator exports, two of which the bot fills in and Archipelago generates
together. `--update-golden` rewrites the golden files: builder 1's ids and names, one seed's
slot_data for the bot's tests, and the three Options Creator exports. Use it only for a deliberate
change. A change of ids or names also needs `BUILDER_VERSION` raised in
`helpers/apMediaContracts.js` and `apworld/plex_media/constants.py`: a seed that is already
running keeps the names and ids it was generated with. Scenario H and the bot's tests of a
player's own file need the `yaml` package in `node_modules`.

### 🎬 Plex Media world commands

Off until the owner enables it in `!config` (or `/config`) → AP Media; until then every
`/apmedia` subcommand answers "🎬 Plex Media is turned off…". `!apmedia ?` (or a bare `!apmedia`)
shows the sub-help, even while it is off. **Every `/apmedia` reply is private to you except
`apworld`.** The owner's subcommands need `ownerId` set: while it is blank nobody can use them,
unlike `/config`'s first-run bootstrap.

| Command | Who | What it does |
| ------- | --- | ------------ |
| `/apmedia yaml [name] [file] [options]` | Anyone; with `for:`, the owner | Builds a list from the library and attaches it as a YAML for the next seed, with its counts, how many titles start open, what the goal needs, and the Fast Forwards, Remote Controls, traps and snacks its pool holds. With `file:`, it fills in a YAML made in the Archipelago Options Creator, or one it wrote before, and keeps the file's settings. It needs a name or a file. See **Building a list** and **Filling in a YAML** below. |
| `/apmedia apworld` | Owner | Attaches `plex_media.apworld`, built in memory, with the install steps, and compares it with `<archipelagoInstallDir>\custom_worlds\plex_media.apworld`, which it only reads. The reply is public. |
| `/apmedia account [user] [plex] [shared]` | Owner; anyone, for `plex:none` on themselves | No user: the server's Plex accounts. A user alone: who they are linked to. A user and a Plex name (in full) or id: links them, and they get an Accept button. An account already linked to someone else needs `shared:True`. `plex:none` unlinks them, and on its own takes back your own link. |
| `/apmedia link <slot> [user] [watch]` | The player holding the `!ap claim` on that slot; the owner, for anyone | Ties a Plex Media slot of a watched room to a Discord user. Without `watch:` the room is the one where they claimed the slot, unless another watched room has a slot of that name too, or the only room watched; anything else is asked back with the watches' ids. |
| `/apmedia unlink <slot>` | The bound player, or the owner | Drops the link. Its unsent checks go with it, and the reply says how many. |
| `/apmedia retry [slot]` | The bound player, or the owner | Reconnects a refused, stale or orphaned slot. A stale one takes on the room's new seed and starts over. |
| `/apmedia status [slot] [user]` | Anyone, for their own slots; the owner, for anyone's, and for every slot when nothing is named | Per slot: titles done, the goal, ready and locked counts, checks waiting or banked, Wild Tickets, Fast Forwards and Remote Controls on hand, the snacks and the Snack Bar's trades left, a Buffering or Rights Expired hold with the checks it holds, a trap at work, traps waiting to hit, the connection, the Plex account, how far the last Plex session got, and the last credit. |
| `/apmedia list [show] [slot]` | The bound player, or the owner | `ready` (the default), `locked` or `done` titles, grouped by show, album, playlist and kind, each with its runtime. A locked title names the item that opens it, 💡 marks one somebody hinted, and ⛔ one whose rights Rights Expired took, until when. While Buffering runs, every page has a ⏳ line under the counts with the checks it holds. A long list gets ◀ ▶ buttons that only the asker can use, for 30 minutes after their last use. |
| `/apmedia check <title> [at] [slot]` | The bound player, or the owner | Counts a title by hand: finished, or with `at:` (`45m`, `1h30m`, `1:30:00`) its checkpoints up to that time. |
| `/apmedia redeem <title> [slot]` | The bound player | Spends a Wild Ticket on a locked title. On a show it opens the episodes of that title's step. |
| `/apmedia ff <title> [slot]` | The bound player | Spends a Fast Forward on a title: its first checkpoint not earned yet, at any distance, or under `timesanity_strict` the next 10 minutes counted as heard. Never a watch, a track or a finish. |
| `/apmedia snackbar [buy] [slot]` | The bound player | The slot's snacks, the Snack Bar's price and the trades left; with `buy:`, one trade for a Fast Forward or a Remote Control. A Remote Control bought while a trap is at work goes straight to it. |
| `/apmedia announce <on\|off> [slot]` | The bound player | Turns the slot's lines in the channel on or off. Refusals and other problems are posted either way. |

Where the slot is optional, leaving it out picks your only linked slot; `status` then shows all of
yours.

**What `status` adds for items and traps**, each line only where it applies: "Fast Forwards: 2 to
spend with `/apmedia ff`.", "Remote Controls: 1 on hand, each one blocking the next trap or ending
the one on you.", "Snacks: 12. The Snack Bar takes 10 snacks a trade, 3 trades left
(`/apmedia snackbar`)." (never for a seed made with `snack_bar_trades: 0`),
"⏳ Buffering: 7 checks held until 21:40." (before the slot's next check, "⏳ Buffering starts with
the slot's next check and holds its checks for 15 minutes."), "⛔ Rights expired until 21:40:
**The Matrix (1999)**, 2 checks held.", "🎬 Intermission until 21:40." (for a clip, "🎬 Commercial
Break until its commercial has played."), "🐢 Slow Motion until 21:40.", and for traps still to
hit, "🎬 Waiting to hit as soon as the bot can: Rewind from `Watcher`." while their player listens
through the bot, or "🎬 Waiting for a listen through the bot: Rewind from `Watcher`." while they do
not (a trap's own pause counts as not listening).

**On `!`.** The same subcommands take their options as text:

```
!apmedia yaml name=Zack movies=10 titles="Alien; Aliens" unwatched=false
!apmedia yaml [key=value ...]          (with a YAML attached to the message)
!apmedia link <slot> [@user] [watch=n]
!apmedia list [ready|locked|done] [slot]
!apmedia check <title> [at 1h30m | @1h30m | at=45:00] [slot=x]
!apmedia redeem <title> [slot=x]
!apmedia ff <title> [slot=x]
!apmedia snackbar [buy fast-forward | buy remote-control] [slot]
!apmedia announce on|off [slot]
!apmedia account [@user <name|id|none>] [shared=yes]
!apmedia account none
```

`!apmedia accounts` works as well as `!apmedia account`, and `!apmedia reconnect` as well as
`!apmedia retry`. Prefix replies are public in the channel, as `!book`'s are, apart from the
account list and the "Did you mean" answer to part of an account name, which go by DM.

**Fast Forwards and the Snack Bar.** Only the slot's own player spends its Fast Forwards and
trades its snacks: for anyone else's slot the owner gets "No linked Plex Media slot is called
`FriendPlex`." A refusal spends nothing: "`ZackPlex` has no Fast Forward to spend (1 received, 0
bought, 1 used).", "**The Matrix (1999)** has no checkpoint left to skip to.", "A trade costs 10
snacks, and `ZackPlex` has 5 snacks." and "`ZackPlex`'s Snack Bar has no trades left (3 trades in
all)." A seed made before world 0.3.0 answers "`ZackPlex`'s seed has no Fast Forwards: it was made
with a Plex Media world before 0.3.0." and "`ZackPlex`'s seed has no Snack Bar: it was made with a
Plex Media world before 0.3.0." On `!`, `fast forward`, `ff`, `remote control`, `remote` and `rc`
name the items too, in any case, with or without dashes, and with or without `buy`
(`!apmedia snackbar rc`). Without `buy`, such a name is the item only when `slot=` is given or the
text names none of your slots, so `!apmedia snackbar RC` shows the Snack Bar of a slot called
`RC`. With slots `Control Freak` and `Freak`, `!apmedia snackbar buy remote Control Freak` buys a
Remote Control for `Control Freak`. `buy` before any other word, as in
`!apmedia snackbar buy popcorn`, gets "`popcorn` is not on the menu. The Snack Bar sells
`fast-forward` and `remote-control`: `!apmedia snackbar buy fast-forward`."

**`slot=` on `!`.** `ff`, `snackbar`, `redeem` and `check` take `slot=` first or last:
`!apmedia ff slot=Zack The Matrix` and `!apmedia ff The Matrix slot=Zack` do the same, and
`!apmedia check slot=Zack Toy Story at 1h30m` counts for `Zack`. A slot name with a space needs
double quotes, which work anywhere: `slot="Zack 2"`. An unquoted `slot=` with words after it is
refused when anything but the command's other `key=value` pairs stands before it, when `slot=` is
typed twice, or when the words after it are more than the command reads (`snackbar` reads only a
leading `buy` and the item name). `!apmedia ff The Matrix slot=Zack 2` gets "Is the slot `Zack 2`?
Then put it in quotes: `slot="Zack 2"`. If it is `Zack`, put `slot=Zack` last. Nothing was
spent.", and `check`'s answer ends "Nothing was counted." instead. A single-quoted
`slot='Zack 2'` gets the same answer, and so does `slot=‘Zack 2’`, in the curly quotes a phone
types. A single-quoted `slot=` placed first gets it too when a later word closes the quote:
`!apmedia ff slot='Zack 2' The Matrix`.

**Naming a title for `check`, `redeem` and `ff`.** A title counts only when it is named in full
or by its code, which is what the slash autocomplete fills in (`#n`, its place in the list, works
too). The year, a leading The, A or An, an album's artist and a book's author may be left out, so
`the matrix` names The Matrix (1999). A part of a title, or a typo, gets "Did you mean **Aliens
(1986)**?" and **nothing is credited or spent on a guess**. A text over 200 characters is matched
exactly or not at all, with no suggestions. In `!apmedia check <title> at <time>`
a bare number is minutes (`The Matrix at 90`), and a text that is a whole list title is that title:
`Murder at 1600` is the film.

**Building a list: `/apmedia yaml`.** The slot name is 1 to 16 characters, with no `{`, `}` or
`%`. With nothing else given it picks 15 random movies; `preset:` also takes `tv` (3 shows),
`music` (10 albums), `books` (3 audiobooks), `mixed` (6 movies, 1 show, 4 albums and 1 book) and
`none`, which takes only what is counted or named. `movies`, `shows`, `albums` and `books` set
totals, hand-picks included. `titles:` takes hand-picks split by `;`, each with an optional
`movie:`, `show:` (with a season range such as `S1-2`), `album:` or `book:` in front.
`playlist:` and `collection:` add a Plex playlist or collection in
its own order, and `genre:` and `years:` (`1990` or `1990-1999`) narrow the random picks. A name
that matches only the start of a title takes the nearest one, and the reply says what it took:
"Nearest matches taken: "Alie" as Alien (1979)." A name that is just `random`, or starts with
`random-`, takes only a title of that name. A list that comes out empty says so, with the
warnings that name the filter that emptied it, such as "Movies has no Polka genre.", and the first
ten titles not found. `unwatched` (on by default) leaves out what the list's player has watched,
read from their own linked Plex account. A show named without seasons starts at their first
unwatched episode, and one they have watched to the end is left out, with a warning that says to
name its seasons or turn `unwatched` off to keep it. Without a linked account, random movies or
shows, a collection and a video playlist need `unwatched:false` or a link from the owner; named
titles do not. A link still waiting for their consent gets a reply asking them to accept it in the
bot's DM, and a list built meanwhile says that nothing they watched is known yet. The timers are
`time-movies`, `time-episodes`, `time-albums` and `time-books`, in minutes, 0 for off.
`goal-percent`, `tv-unlock`, `episodes-per-unlock` and `max-episodes` (the most episodes from one
show: random shows, a collection's shows and shows named without seasons; 24 by default) are
options of their own, and the rarer settings go in `more:` as key=value, the way
the prefix form writes them: `label`, `starting_unlocks`, `wild_tickets`, `strict`,
`locked_watches`, `checkpoint_items`, `snack_variety`, `fast_forwards`, `remote_controls`,
`snack_bar_trades`, `snack_bar_price`, `trap_percentage` and the seven trap weights
(`buffering_weight`, `rights_expired_weight`, `commercial_break_weight`, `shuffle_mode_weight`,
`rewind_weight`, `intermission_weight`, `slow_motion_weight`), as in
`more:wild_tickets=3 strict=true trap_percentage=20`. A `trap_percentage` above 0 with every
weight at 0 is refused: "trap_percentage 50 makes 34 of the list's 69 filler items traps, but
every trap weight is 0 (a trap weight above 0, or trap_percentage 0, would help)". The file is
named after the slot, accents and other scripts included, and gains a short hash when a character
had to change: `Zack M.` becomes `Zack_M-cd58afdb.yaml`. A list is refused above 2,000 titles, 2,000
unlock copies or 10,000 locations, and warned about above 600 copies, 1,500 locations or 50 hours
to the goal; a finished YAML over 8 MB, the most the bot sends through Discord, is refused too.
A person builds one list at a time, an attached file's download included, and the bot two at once
in all; another ask meanwhile is told to wait. Every file records, after the game options, the
list settings it was built with (`list_preset`, `list_movies` and the rest). Attached again, it
gets a fresh pick with them.

**Filling in a YAML: `/apmedia yaml file:`.** The file is a YAML from the Archipelago Options
Creator, or one the bot wrote. On `!` it is the message's first attachment named `.yaml` or
`.yml`, else its first `.txt` or other text attachment, such as the `message.txt` Discord makes of
a long paste; a screenshot or a note beside it is left alone. A YAML pasted into the message text
is not read, and the reply asks for the file.

- **One player per file.** At the top it may hold only `name`, `description`, `game`, `requires`
  and `Plex Media`, and `game` has to be `Plex Media`. `triggers` at the top are refused with a
  pointer to move them under `Plex Media`, and `linked_options` are refused. A weighted `game` or
  `name` that can roll only one value is that value; one that can roll more is refused. The name
  passes the same checks as `name:`.
- **Read the way Archipelago reads it**, with YAML 1.1's rules: an unquoted `off` is false, `010`
  is 8, `1:30` is 90, `50.0` is a decimal number, and a lone CR ends a line. A key given twice is
  refused the way Archipelago's loader counts keys (`true` and `1` are one key, two `.nan` are one,
  an alias used as a key is the key it names), and so is a key beside its `+` twin (`local_items`
  and `+local_items`, or `"+1.0"` and `1.0`). A `<<` merge, a bare `=`, a bare `!` tag, `!!omap`
  and `!!pairs`, an anchor named twice, a list or a mapping used as a key, a key left empty
  without `?`, and a raw control character, NEL, U+2028 or U+2029 are refused, naming the line.
  A quote or a bracket left open is named at the line it opens. A number or a weight written as
  text reads as Python's `int()` reads it: with `_` between digits, the spaces `int()` takes around
  it, and digits of any script (`"５０"` is 50).
- **The list settings say what to pick.** A count at `preset` takes the preset's number, and a
  kind the preset leaves out gets 0. A list setting left random is refused, naming each one as the
  Options Creator shows it: "List: Movies (`list_movies`) is random: set a number, the bot needs
  it to pick titles." A trigger that sets one is refused too. A text setting is read as written,
  as Archipelago reads it, so a playlist named Random is that playlist, and one written as a number
  is that number as Python writes it (`0.00001` is `1e-05`). An empty `list_preset` is `none`, as
  Archipelago reads it, and an empty text is no text; an empty count, `list_max_episodes` or
  `list_unwatched` is refused. A file whose settings count nothing and name nothing gets "Your
  list settings pick nothing: choose a preset, set a count, or name titles, a playlist or a
  collection."
- **Weights are read as Archipelago rolls them.** A weighted setting with one choice above 0, as
  every one in the Launcher's Generate Template Options file, is that choice. Every choice a
  weighted or listed game option can roll has to be a value Archipelago reads, and a mapping whose
  weights are all 0 is refused, as Archipelago refuses it. A weight below 0 is refused too.
- **The game options plan the list.** One that stays random is copied as it is, so Archipelago
  rolls it at generation; the reply names it with its default, which the summary uses, and so
  does a comment at the top of the finished file. A timer left random, or set by a trigger in the
  file, is refused when its lowest value would take the list past 10,000 locations, and the reply
  names the lowest that fits. A value Archipelago would refuse is refused, by name: an empty one,
  a number with a decimal point (`50.0`), a toggle's `Random` (it takes only a lowercase
  `random`, and its words as written, without spaces around them), and a `random-range-…` that
  reaches past the option's own range. A Trap Percentage left random, or set by a trigger, is
  refused while no Trap Weight can roll above 0 and a roll would make a trap due: "Trap
  Percentage (`trap_percentage`) is random in your file while every Trap Weight is 0: a roll of 15
  or more makes a trap due among the list's 7 filler items with no trap to pick, and that stops
  the whole multiworld from generating. Set a Trap Weight above 0, or Trap Percentage to 0." A
  weight that can roll above 0 is enough to pass, so a file whose random Trap Weights could all
  roll 0 together is taken, and so is a fixed Trap Percentage above 0 with every weight random.
  Such a seed stops generating only when every weight does roll 0 while a trap is due. A Trap
  Weight a trigger may set above 0 counts as one that can roll above 0, for a fixed Trap
  Percentage as for a random one, and while every Trap Weight in the file is 0 the reply's Items
  line counts the traps as if the trigger set the highest weight it can. That holds even for a
  trigger whose condition can roll otherwise, so that it may not fire: such a file is taken, and
  its seed stops the whole multiworld from generating only when the trigger does not fire while a
  trap is due.
- **A setting a trigger checks keeps the file's spelling.** Archipelago compares the value as the
  file writes it with the trigger's `option_result`, so a game option or list setting that a
  trigger under `Plex Media` names is written as the file wrote it (`'off'` stays `"off"`). The
  same option typed with the command replaces it, unless it reads the same (`time_albums=off`
  beside the file's `'off'`), and then the file's spelling stays. A trigger on a setting the file
  leaves out is refused.
- **A trigger is refused, by its number,** when Archipelago would refuse it on every roll (triggers
  that are not a list of mappings, an `option_category` other than `Plex Media` or `requires`, an
  `option_name` that cannot roll), when it checks `description` or `requires` at the top, which the
  bot writes, when it sets a list setting, `entries` or `list_info`, and when a value it sets is one
  Archipelago refuses: "Trigger 1 in your file: Goal Percent (`goal_percent`) must be a whole
  number from 1 to 100."
- **Everything else is copied as it is**, in the file's order: `progression_balancing`,
  `accessibility`, `local_items`, `triggers` and the rest, up to 32 KB of them in the new file. A
  setting whose name starts with `+` or `-` is refused outside `triggers`. The file's `entries`
  and `list_info` are replaced by the new pick, and an `account`
  or `discord` key is refused: the bot fills in the account from the linked Plex account and the
  Discord id from the person the list is for. The bot writes `requires` itself and keeps the file's
  `plando` there (`none`, `items`, `connections`, `texts` or `bosses`); a `requires` that Python
  reads as false, such as `0`, is no requires. `plando_items` takes this list's items and
  locations by the names a seed gives them, such as `Watch Alien (1979)`: the numbered names the
  Options Creator offers find nothing there.
- **Options typed with the command replace the file's**, the name included, and a typed `preset`
  sets the counts the file left at preset. A count equal to what its preset gives is saved as
  `preset`, also when it was given as a number, so it follows a preset given later.
- **A list the bot wrote for someone else** is refused under the slot name it was built under,
  which its `list_info` records (a list from before world 0.2.0 names it in its first line,
  `# … for <name>`): "This list was built for @Ana." The owner adds `for:` to pick it
  again for them, and anyone may give it a new name, with `name:` or in the file's `name:` line,
  to make it a list of their own. The owner's own list given to someone with `for:` needs a new
  name too.
- **The reply** says the settings came from the file, how many of the file's titles a fresh pick
  replaced, and which options stay random, by the Creator's name and the file's key: six by name,
  and the rest counted ("; and 19 more"). Past
  Discord's 2,000 characters it counts the warnings and misses it leaves out; the next step and
  the tracker line stay. Text from the file or the library is escaped or in a code span, and a
  mention, a channel, a command, a timestamp or a custom emoji in it reads as typed.
- **A list the bot wrote before world 0.2.0** saved no list settings, and is refused with "This
  list comes from an older version of the bot, which did not save what to pick: give a preset, a
  count, or titles, a playlist or a collection with the command." With one of those typed, the
  typed options decide what to pick, and the list keeps the label its `list_info` held.
- **The file** has to come from Discord's own file server, be 8 MB at most (the most the bot
  sends a list in), and 64 KB at most without a list's `entries`, arrive within 15 s and be UTF-8;
  a byte order mark is fine. The entries of up to 2,000 titles are counted, not read, also
  indented as another YAML tool writes them, with comments among them, or with settings after them.
- **A Launcher template** (Generate Template Options) reads as an untouched Creator form once its
  `Player{number}` has a name of its own, in the file or as `name:`.

The bot reads files with the `yaml` package, 2.9.1, from `package.json`. Without it in
`node_modules`, an attached file gets "The bot cannot read YAML files yet: the owner has to install
its yaml package (2.9.1).", and lists built from the command's options still work.

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
