// helpers/plexClient.js
// Single shared Plex client used by all command files. Lazy-initialized on first use.
const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');

let _plex = null;

function getPlex() {
    if (!_plex) {
        _plex = new PlexAPI({
            hostname: plexConfig.hostname,
            port: plexConfig.port,
            https: plexConfig.https,
            token: plexConfig.token,
            options: plexConfig.options
        });
    }
    return _plex;
}

module.exports = { getPlex };
