module.exports = {
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

  // Bot owner — needed for owner-only features (Playnite host commands, master profile).
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
  'tautulliUrl'     : ''
};