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
  // Drop item sends addressed to a slot that has already finished. Late in an async most of
  // the remaining traffic is items nobody will collect. Goal status is read from the server,
  // so players who finished before the bot connected count too.
  'archipelagoSkipGoaled' : true,
  // Colour item names by class in the relayed log: progression magenta, useful blue, trap red,
  // filler cyan. Matches Archipelago's own clients. Needs a Discord client that renders ANSI
  // code blocks; turn it off if the log arrives full of escape codes.
  'archipelagoColorLines' : true,

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
  'archipelagoShowDeaths' : false
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
