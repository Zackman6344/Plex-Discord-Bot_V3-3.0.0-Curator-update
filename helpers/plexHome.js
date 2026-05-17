// helpers/plexHome.js
//
// Handles Plex Home managed-user switching for cross-account features (currently:
// !playlist plex-copy / plex-list / plex-play with an account parameter).
//
// Auth model (see config/plex.example.js for the full explanation):
//   - plexConfig.token          → the user the bot acts as by default
//   - plexConfig.homeOwnerToken → the Plex Home OWNER token, only used here
//
// Flow when switching to a managed user "X":
//   1. List home users via plex.tv (owner token) to find X's id
//   2. POST /api/v2/home/users/<id>/switch?pin=<pin> with owner token
//   3. Plex returns a temp authToken scoped to X
//   4. Build a PlexAPI client pointed at the LOCAL server using that token
//   5. Cache the client in memory by (discordUserId, plexUsername) for 30 minutes
//
// PINs are never persisted. Tokens live in process memory only and expire after
// 30 minutes of idle time.

const PlexAPI = require('plex-api');
const plexConfig = require('../config/plex.js');
const logger = require('./logger.js');

// plex.tv uses two API generations side by side. v2 is the modern listing endpoint
// (returns JSON cleanly); the legacy /api/home/users/<id>/switch is the canonical
// switch path used by every third-party Plex client. v2 doesn't have a switch
// endpoint (returns 404), which is the gotcha we hit in v1 of this helper.
const PLEX_TV_API_V2 = 'https://plex.tv/api/v2';
const PLEX_TV_API_LEGACY = 'https://plex.tv/api';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const HOME_USERS_TTL_MS = 5 * 60 * 1000;

// Map<discordUserId, Map<plexUsernameLower, { token, plex, expiresAt }>>
const _userCache = new Map();
let _homeUsersCache = null; // { users, expiresAt }

function getOwnerToken() {
    return plexConfig.homeOwnerToken || '';
}

// Headers for plex.tv API calls. Plex's web/mobile clients send a bag of X-Plex-*
// headers identifying the client; we mirror the bot's identity from plexConfig.options.
function plexTvHeaders(token) {
    const opts = plexConfig.options || {};
    return {
        'Accept': 'application/json',
        'X-Plex-Token': token,
        'X-Plex-Client-Identifier': opts.identifier || 'plex-discord-bot',
        'X-Plex-Product': opts.product || 'Plex Discord Bot',
        'X-Plex-Version': opts.version || '3.0.2',
        'X-Plex-Device': opts.device || 'Discord',
        'X-Plex-Device-Name': opts.deviceName || 'Discord Bot',
        'X-Plex-Platform': opts.platform || 'Discord'
    };
}

// Fetch the list of Plex Home managed users. Cached for 5 minutes to avoid hammering
// plex.tv on every interactive prompt.
async function listHomeUsers() {
    if (_homeUsersCache && _homeUsersCache.expiresAt > Date.now()) {
        return _homeUsersCache.users;
    }

    const token = getOwnerToken();
    if (!token) {
        throw new Error('homeOwnerToken is not set in config/plex.js — cross-account features are disabled.');
    }

    const res = await fetch(`${PLEX_TV_API_V2}/home/users`, { headers: plexTvHeaders(token) });
    if (!res.ok) {
        throw new Error(`Plex Home users API failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    // The exact shape can vary by Plex Pass version. Common keys: users / Users / MediaContainer.User.
    // Normalize defensively.
    const raw = data.users || data.Users || (data.MediaContainer && data.MediaContainer.User) || [];
    const users = raw.map(u => ({
        // Numeric id is what the legacy /api/home/users/<id>/switch endpoint wants.
        // uuid is captured in case we ever need v2-only behavior.
        id: u.id,
        uuid: u.uuid,
        title: u.title || u.username,
        username: u.username || u.title,
        hasPin: !!(u.protected || u.hasPin),
        admin: !!u.admin
    }));
    logger.debug('plexHome users:', JSON.stringify(users));

    _homeUsersCache = { users, expiresAt: Date.now() + HOME_USERS_TTL_MS };
    return users;
}

async function findUserByName(name) {
    const users = await listHomeUsers();
    const lower = String(name || '').toLowerCase();
    return users.find(u =>
        (u.username && u.username.toLowerCase() === lower) ||
        (u.title && u.title.toLowerCase() === lower)
    ) || null;
}

function getCachedClient(discordUserId, plexUsername) {
    const bucket = _userCache.get(discordUserId);
    if (!bucket) return null;
    const entry = bucket.get(plexUsername.toLowerCase());
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        bucket.delete(plexUsername.toLowerCase());
        return null;
    }
    return entry.plex;
}

function setCachedClient(discordUserId, plexUsername, token, plex) {
    let bucket = _userCache.get(discordUserId);
    if (!bucket) {
        bucket = new Map();
        _userCache.set(discordUserId, bucket);
    }
    bucket.set(plexUsername.toLowerCase(), {
        token,
        plex,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

/**
 * Switch to a managed user, returning a PlexAPI client scoped to them.
 *
 * @param {string} plexUsername - the managed user's Plex username
 * @param {string} pin          - the PIN for that user (ignored if user has no PIN)
 * @param {string} discordUserId - keys the in-memory cache so simultaneous users don't share tokens
 * @returns {Promise<PlexAPI>} a fresh client pointed at the local Plex server with the user's token
 * @throws Error on missing homeOwnerToken, unknown username, rejected PIN, or any HTTP failure
 */
async function switchAs(plexUsername, pin, discordUserId) {
    const cached = getCachedClient(discordUserId, plexUsername);
    if (cached) {
        logger.debug(`plexHome cache hit for ${discordUserId} → ${plexUsername}`);
        return cached;
    }

    const user = await findUserByName(plexUsername);
    if (!user) {
        throw new Error(`No Plex Home user named "${plexUsername}".`);
    }

    const ownerToken = getOwnerToken();
    // Legacy /api/home/users/<id>/switch is the canonical switch endpoint. The v2 API
    // doesn't expose a switch path — hitting /api/v2/home/users/<id>/switch returns 404.
    const url = `${PLEX_TV_API_LEGACY}/home/users/${user.id}/switch?pin=${encodeURIComponent(pin || '')}`;
    const res = await fetch(url, { method: 'POST', headers: plexTvHeaders(ownerToken) });

    if (res.status === 401 || res.status === 403) {
        throw new Error('Plex rejected that PIN.');
    }
    if (!res.ok) {
        // Pull the body for diagnostics — Plex usually returns either XML or JSON with
        // a useful error message even on 4xx/5xx responses.
        const body = await res.text().catch(() => '');
        logger.error(`plexHome switch failed: ${res.status} ${res.statusText} URL=${url} body="${body.slice(0, 300)}"`);
        throw new Error(`Plex Home switch failed: ${res.status} ${res.statusText}`);
    }

    // The legacy endpoint returns XML by default. We can ask for JSON via the Accept
    // header (set in plexTvHeaders) but the response shape may still come back as XML
    // for older Plex Pass versions. Try JSON first, fall back to text.
    let switchedToken = null;
    const responseText = await res.text();
    try {
        const data = JSON.parse(responseText);
        switchedToken = data.authToken || (data.user && data.user.authToken) || data.authentication_token;
    } catch (_) {
        // XML response — extract the token via a simple regex. plex-api parses XML
        // properly elsewhere, but for one field a regex is fine.
        const m = responseText.match(/authenticationToken="([^"]+)"|authToken="([^"]+)"/);
        switchedToken = m ? (m[1] || m[2]) : null;
    }

    if (!switchedToken) {
        logger.error(`plexHome switch returned no token. Response: "${responseText.slice(0, 300)}"`);
        throw new Error('Plex Home switch succeeded but returned no authToken.');
    }

    const switched = new PlexAPI({
        hostname: plexConfig.hostname,
        port: plexConfig.port,
        https: plexConfig.https,
        token: switchedToken,
        options: plexConfig.options
    });

    setCachedClient(discordUserId, plexUsername, switchedToken, switched);
    logger.info(`plexHome: switched to ${plexUsername} for Discord user ${discordUserId}`);
    return switched;
}

// Exposed for tests.
function _resetCaches() {
    _userCache.clear();
    _homeUsersCache = null;
}

module.exports = {
    listHomeUsers,
    findUserByName,
    switchAs,
    getCachedClient,
    _resetCaches
};
