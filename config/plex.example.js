// Copy this file to config/plex.js and fill in your Plex server details.
// config/plex.js is gitignored so your Plex token never ends up in version control.
//
// Token: https://support.plex.tv/hc/en-us/articles/204059436-Finding-an-authentication-token-X-Plex-Token
module.exports = {
  'hostname'    : 'PLEX_LOCAL_IP_OR_HOSTNAME',   // e.g. '192.168.1.10' or 'plex.local'
  'port'        : '32400',
  'https'       : false,
  'token'       : 'PLEX_TOKEN',
  'managedUser' : '',                            // reserved for a future user-switching feature
  'options'     : {
    'identifier': 'plex-discord-bot',
    'product'   : 'Plex Discord Bot',
    'version'   : '3.0.2',
    'deviceName': 'Discord Bot',
    'platform'  : 'Discord',
    'device'    : 'Discord'
  }
};
