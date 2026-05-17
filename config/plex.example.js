// Copy this file to config/plex.js and fill in your Plex server details.
// config/plex.js is gitignored so your Plex token never ends up in version control.
//
// HOW TOKENS WORK HERE
// --------------------
// The bot supports two tokens:
//
//   1. `token` — the identity the bot acts as for everyday queries (library reads,
//      audio playback, queue ownership). RECOMMENDED: create a PIN-less Plex Home
//      managed user dedicated to the bot, sign in as them once, and grab their token.
//      That keeps the bot's activity tracked under a dedicated account and avoids
//      contaminating your owner watch history.
//
//   2. `homeOwnerToken` — your Plex Home OWNER token. Only used by !playlist
//      plex-copy / plex-list / plex-play when reaching into another managed user's
//      account (the bot calls /api/v2/home/users/<id>/switch with this token and
//      a PIN supplied via DM). Leave empty if you don't need cross-account features
//      — the bot will still work perfectly as the default user without it.
//
// Both tokens come from the same place:
// https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token
module.exports = {
  'hostname'       : 'PLEX_LOCAL_IP_OR_HOSTNAME',   // e.g. '192.168.1.10' or 'plex.local'
  'port'           : '32400',
  'https'          : false,
  'token'          : 'BOT_USER_PLEX_TOKEN',          // the user the bot acts as (see comment above)
  'homeOwnerToken' : '',                             // optional — required for cross-account !playlist plex-copy
  'managedUser'    : '',                             // optional metadata: the username corresponding to `token`
  'options'        : {
    'identifier': 'plex-discord-bot',
    'product'   : 'Plex Discord Bot',
    'version'   : '3.0.2',
    'deviceName': 'Discord Bot',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};
