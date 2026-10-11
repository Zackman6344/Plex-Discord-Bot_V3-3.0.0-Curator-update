const fs = require('fs');
const path = require('path');

// Baseline defaults. The in-Discord `/config` wizard can override any of these at runtime;
// its changes are persisted to data/config.overrides.json and merged back over these defaults
// on the next load (see the merge block below). Edit values here for the checked-in defaults.
const defaults = {
  // Restrict the bot to only listen for commands in a channel with this name. Empty = listen everywhere.
  'listenChannel'     : '',
  // Command prefix character(s). Defaults to '!' so commands look like !play, !trivia, etc.
  'commandPrefix'     : '!',
  // Directory (relative to project root) where custom user-created playlists are stored on disk.
  'playlistsDir'      : 'playlists/',
  'language'          : 'lang/en.js',
  'youtube_quality'   : 'lowestaudio',

  // Server display name — used in help text, stats, requests, and AI messages.
  // Set this to your Plex server's name so the bot doesn't refer to itself as someone else's server.
  'serverName' : 'My Plex Server',

  // Bot owner — needed for owner-only features (Playnite host commands, master profile, /config).
  'ownerId' : '',
  // Guild ID for slash command registration during development/testing. If set,
  // slash commands register in this guild only (instant) instead of globally
  // (1-hour propagation). Leave blank once you're ready for global registration.
  'testGuildId' : '',
  // Optional Discord role ID that can also use !launch. Leave blank to restrict to owner.
  'launchRoleId' : '',

  // Playnite integration (game library on the host PC). Requires the Playnite HTTP server on :8787.
  'playniteEnabled' : false,

  // Tautulli integration (Plex stats). Requires a running Tautulli instance.
  'tautulliEnabled' : false,
  'tautulliApiKey'  : '',
  'tautulliUrl'     : '',

  // Calibre content server, read by the audiobook read-along (`!book text`) to find a book's
  // ebook. GET requests only; the bot never writes to the Calibre library. The server runs only
  // while the Calibre app is open; once a book's text has been read it is kept in data/book_text/,
  // so it keeps working with Calibre closed. Blank turns Calibre off.
  // Never put a login in the URL (http://user:pass@...): it would be refused, because a URL ends
  // up in error messages. Use calibreUsername and calibrePassword, only if you turn on Calibre's
  // "Require username and password".
  'calibreUrl'       : 'http://127.0.0.1:8080',
  'calibreLibraryId' : '',   // blank = the server's default library
  'calibreUsername'  : '',
  'calibrePassword'  : '',

  // --- Automated broadcasts (Kometa runs + Playnite game launches) ---
  // Discord channel IDs the bot posts to. Kometa runs and game launches each have their own
  // channel; broadcastChannelId is the fallback used for whichever you leave blank. All blank =
  // that broadcast is disabled. (Right-click a channel with Developer Mode on → "Copy Channel ID".)
  'broadcastChannelId'  : '',   // fallback channel for any broadcast without a dedicated one
  'kometaChannelId'     : '',   // Kometa run announcements (falls back to broadcastChannelId)
  'gameLaunchChannelId' : '',   // Playnite game-launch announcements (falls back to broadcastChannelId)
  // Local HTTP listener that receives pushes from Kometa (webhooks) and Playnite (game-start
  // script). Bound to 127.0.0.1 only — it is never reachable from off this machine.
  'eventServerEnabled' : false,
  'eventServerPort'    : 8799,
  // Optional shared secret. When set, senders must append `?token=<this>` to the URL; requests
  // without it get a 401. A convenience second layer on top of the localhost-only binding.
  'eventServerToken'   : '',
  // Per-type toggles so either broadcast can be silenced without disabling the listener.
  'broadcastKometa'      : true,   // Kometa run summaries (run_start / run_end / error)
  'broadcastGameLaunch'  : true,
  // Live per-collection updates during a Kometa run (its `changes` webhook) — posts when a
  // collection is created, grows, or has items requested for the server. Can be noisy on a big
  // run; raise kometaChangesMinAdds to only hear about collections that grew by at least N.
  'broadcastKometaChanges' : true,
  'kometaChangesMinAdds'   : 1,
  // Post a "System has started" card on boot (to the general broadcast channel, or the first
  // configured channel) so you can confirm the bot came up and the event listener is live.
  'broadcastStartup'       : true,
  // Detect game launches via Discord activity ("Playing X") instead of / in addition to the
  // Playnite script — works for Steam and any launcher Discord detects. REQUIRES enabling the
  // privileged "Presence Intent" in the Discord Developer Portal, and a restart to take effect.
  'gamePresenceEnabled'    : false,

  // --- Kometa Theater (silly mode) ---
  // Narrate a Kometa run in-character: each collection speaks with a themed personality, paced on
  // Discord's side. Replaces the factual `changes` cards while on. Posts to kometaChannelId.
  // Reads Kometa's meta.log for per-collection coverage (incl. unchanged ones → "static").
  'kometaTheaterEnabled'   : false,
  'kometaLogPath'          : 'C:/Kometa/config/logs/meta.log',
  // Fast Gemini model for the dialogue. Blank = fall back to helpers/geminiAPI.js DEFAULT_MODEL.
  'kometaTheaterModel'     : '',
  // Milliseconds between "transmissions" — the deliberate slowdown on Discord's side. No cap on
  // how many post in a run; it's bounded by the number of collections Kometa actually processes.
  'kometaTheaterDelayMs'   : 5000,

  // --- Archipelago room monitor (!ap, or the Archipelago page of /config) ---
  // When on, the bot opens a read-only tracker connection to the multiworld and relays its log
  // into archipelagoChannelId. Rooms added with `!ap watch` run alongside this one and post to
  // whichever channel they were created in.
  'archipelagoEnabled' : false,
  // Channel the configured room's log goes to. Its own setting rather than the shared
  // broadcastChannelId, because a multiworld log is a firehose next to a Kometa summary.
  // Blank means the configured room below stays idle. (Right-click a channel with Developer
  // Mode on → "Copy Channel ID".)
  'archipelagoChannelId' : '',

  // The room to watch. Give EITHER a room URL, or a host and port.
  // A room URL is preferred for anything hosted on archipelago.gg: the port changes every time
  // the room spins up, and the URL lets the bot re-read the current one on each connect.
  'archipelagoRoomUrl' : '',           // e.g. https://archipelago.gg/room/<id>
  'archipelagoHost'    : '',           // e.g. localhost, for a server you host yourself
  'archipelagoPort'    : 38281,        // used with archipelagoHost; ignored when a room URL is set
  // An existing slot name in that multiworld. The bot attaches to it as a read-only observer,
  // receives no items, and cannot affect whoever is playing it.
  'archipelagoSlot'     : '',
  'archipelagoPassword' : '',          // only if the room has one

  // Seconds of room log collected before the batch is posted. Lower is snappier and noisier.
  'archipelagoBatchSeconds' : 5,
  // Relay an item send only when its flags mark it as progression. The usual fix for a big
  // async where filler sends drown everything else.
  'archipelagoProgressionOnly' : false,
  // Drop item sends addressed to a slot that has already goaled or released. Late in an async
  // most of the remaining traffic is items nobody will collect. Goal status is read from the
  // server, so players who goaled before the bot connected count too; a release is only seen
  // if the bot was connected when it happened, because nothing stores it.
  'archipelagoSkipGoaled' : true,
  // Also treat a slot with every location checked as finished. The network protocol cannot see
  // another slot's locations at all, so this reads the room's tracker page instead: room-URL
  // watches only, and it needs a web host (archipelago.gg or your own), not a bare MultiServer.
  // Caveat worth knowing: a player can have every location checked and still be waiting on an
  // item to actually goal. Turn this off if you would rather see those sends.
  'archipelagoInferFinished' : true,
  // How often to re-read the tracker page. Completion moves over hours and the page is large,
  // so this is deliberately slow.
  'archipelagoTrackerPollMinutes' : 15,
  // Post the item sends, goals and hints the relay missed while the bot was down, rebuilt from the
  // room's tracker about two minutes after each reconnect and again every poll above. Room-URL
  // watches only. Off still records what was missed without posting it, so switching it back on
  // later never dumps an old backlog into the channel; `!ap catchup` posts either way, and so does
  // the retry after a post Discord refused.
  'archipelagoCatchup' : true,
  // Colour item names by class in the relayed log: progression magenta, useful blue, trap red,
  // filler cyan. Matches Archipelago's own clients. Discord renders ANSI code blocks on desktop
  // and web only, so this does nothing in the mobile apps. Turn it off if a client of yours
  // shows the escape codes as text instead.
  'archipelagoColorLines' : true,
  // Prefix a coloured square to progression, useful and trap item names. Plain text, so unlike
  // the colours above it survives every client including mobile. Filler is left unmarked
  // because most sends are filler.
  'archipelagoItemMarkers' : true,
  // The Archipelago install `!ap next` rebuilds a seed's logic from, to list what each slot can
  // actually reach with the items it has received. Only seeds generated with this install can be
  // rebuilt; any other room gets sphere 1 only, which needs nothing. Blank turns it off. The first
  // `!ap next` for a seed takes about a minute, and the helper process then holds about 0.5 GB.
  'archipelagoInstallDir' : 'C:\\ProgramData\\Archipelago',
  // The Python that helper runs on. It has to be the version the install was built with (3.13
  // for Archipelago 0.6.7). Blank finds it with the Windows `py` launcher.
  'archipelagoPython' : '',

  // Give players a Discord role for taking part, and one per goal count.
  // The bot creates "Archipelago" the first time somebody claims a slot with `!ap claim`, and a
  // "3 Games Goaled" role the first time somebody reaches that count, moving them up as they
  // finish more. A count role nobody is on any more is deleted. Only roles the bot created
  // itself are ever touched; ids are recorded in data/archipelago_roles.json.
  // Needs the Manage Roles permission, and the bot's own role has to sit above the ones it
  // makes. Without the permission this logs once per guild and stays off there.
  // Releases do not count. A release hands out the slot's items without anybody finishing it,
  // and a 100%-checked slot can still be waiting on an item, so the tally is goals only.
  'archipelagoRolesEnabled' : true,
  // Name of the participant role. Created mentionable, so the room's players can be pinged as a
  // group. The per-count roles are named automatically and are not configurable.
  'archipelagoRoleName' : 'Archipelago',

  // Which categories of log line get relayed.
  'archipelagoShowItems'  : true,      // item sends, and cheated items
  'archipelagoShowHints'  : true,      // hints
  'archipelagoShowChat'   : true,      // player and server chat
  'archipelagoShowJoins'  : true,      // joins, parts, tag changes
  'archipelagoShowGoals'  : true,      // goals, releases, collects
  'archipelagoShowMisc'   : true,      // countdowns, tutorials, command output
  // DeathLink arrives on a different packet type, and the server only routes it to clients
  // advertising the tag. Turning this on reconnects so the tag is sent. The bot never sends a
  // death of its own.
  'archipelagoShowDeaths' : false,

  // --- Audiobooks and podcasts (/book, or the Audiobooks page of /config) ---
  // Plays long-form audio from the music library with a saved place per listener. Off by default
  // because it reads the whole music section to build its catalog and opens a loopback port.
  // Read each time it is used, so turning it on takes effect without a restart.
  'audiobooksEnabled' : false,
  // Keep catalogued books and podcast episodes out of music pickers, search and Hitster once a
  // catalog exists. Only turn it off if the catalog has swallowed music you want back; the
  // overrides file (data/book_overrides.json) is the finer fix.
  'audiobooksExcludeFromMusic' : true,
  // Seconds between bookmark saves while a book plays. This is the most a crash or hard kill can
  // lose; a save costs a few milliseconds.
  'audiobookSaveSeconds' : 15,
  // Playback speed for a listener's first book. After that each listener keeps their last speed.
  // A string because it is a menu choice; one of '0.75' '0.9' '1' '1.1' '1.25' '1.5' '1.75' '2'.
  'audiobookDefaultSpeed' : '1',
  // Minutes a paused or abandoned book keeps the voice channel before leaving. The place is saved
  // either way.
  'audiobookIdleLeaveMinutes' : 10,
  // Seconds to rewind when resuming after more than 5 minutes away (three times this after a
  // day), so the listener hears the end of the last sentence again. 0 resumes exactly.
  'audiobookResumeRewindSeconds' : 10,
  // Read-along: `!book text on` sends the listener the book's text in DMs, a page at a time,
  // turning with the narration, and a 📖 card button shows the page privately. Nothing is
  // downloaded or parsed until someone uses it; the only background work is a read-only check
  // when a book starts (a Calibre search and a folder listing) that decides whether 📖 shows.
  'audiobookTextEnabled' : true,
  // Also look for .epub files in the folders that hold a book's audio files.
  'audiobookTextSidecars' : true,

  // --- Voice (the Voice page of /config) ---
  // Priority of the bot process. Above normal stops a game, VR stream or Plex transcode on this PC
  // from delaying the 20 ms voice send timer: the worst send gap under load was 359 ms at normal
  // and 34 ms above normal. Pick 'normal' if a game running alongside the bot suffers. ffmpeg
  // stays at normal either way. One of 'above_normal' 'normal'; applied at once from /config.
  'processPriority' : 'above_normal',
  // Per-minute voice-health log for chasing stutters: send gaps, source underruns, reconnects,
  // event-loop delay and CPU, in data/logs/voice-*.jsonl and `!voicehealth`. Off by default;
  // about 0.06% of one core when on. Applied at once from /config.
  'voiceHealthEnabled' : false
};

// Layer persisted overrides (written by the /config wizard, helpers/configStore.js) on top of
// the defaults. Only keys that already exist in `defaults` are applied, so a stale or typo'd
// override key can't inject unknown config. A missing or malformed file is ignored so a bad
// override never stops the bot from booting. `defaults` is mutated in place and exported, so
// the wizard can also update the live object at runtime for settings read at call time.
const overridesPath = path.join(__dirname, '..', 'data', 'config.overrides.json');
try {
  if (fs.existsSync(overridesPath)) {
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    if (overrides && typeof overrides === 'object') {
      for (const key of Object.keys(defaults)) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) defaults[key] = overrides[key];
      }
    }
  }
} catch (err) {
  console.warn('[config] Ignoring malformed data/config.overrides.json:', err.message);
}

module.exports = defaults;
