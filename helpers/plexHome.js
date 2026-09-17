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
//   2. POST /api/home/users/<id>/switch?pin=<pin> with owner token
//   3. Plex returns a temp account authToken scoped to X
//   4. Exchange that for THIS server's access token (see below)
//   5. Build a PlexAPI client pointed at the LOCAL server using the access token
//   6. Prove the client works, and only then cache it by (discordUserId, plexUsername)
//
// PINs are never persisted. Tokens live in process memory only and expire after
// 30 minutes of idle time.
//
// **The account authToken from the switch does NOT work against the server, and that cost a
// working feature for a while.** It is a real token — plex.tv answers `/api/v2/user` with it and
// names the managed user — but every library call to the local server came back 401, which
// plex-api reports as "you must provide a way to authenticate", reading like the bot had no
// token at all. Measured for a managed user with no PIN and full access to the server:
//
//   plex.tv /api/v2/user      with the switch authToken -> 200 ("Bard Account", restricted)
//   plex.tv /api/v2/resources with the switch authToken -> 200, and lists this very server
//   server  /library/sections with the switch authToken -> 401
//   server  /playlists        with the switch authToken -> 401
//
// Plex issues a **separate per-server access token** for anyone who is not the owner, and that is
// the one a server accepts. It comes off `/api/v2/resources`, on the entry whose
// `clientIdentifier` matches the server's own `machineIdentifier`. Same user, same moment:
//
//   server  /playlists        with that resource accessToken -> 200
//
// So the switch is step one of two. Skipping the exchange fails identically for every managed
// user, PIN or no PIN, which is why the first report of this looked like a rejected PIN.

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

/**
 * This server's own machine identifier, which is what picks its entry out of plex.tv's resource
 * list. `/identity` needs no auth and the value is fixed for the life of the install, so it is
 * read once.
 */
let _machineId = null;

async function getMachineIdentifier() {
    if (_machineId) return _machineId;

    const base = `${plexConfig.https ? 'https' : 'http'}://${plexConfig.hostname}:${plexConfig.port}`;
    const res = await fetch(`${base}/identity`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Could not read the Plex server's identity: ${res.status} ${res.statusText}`);

    const data = await res.json();
    const id = data && data.MediaContainer && data.MediaContainer.machineIdentifier;
    if (!id) throw new Error("The Plex server did not report a machineIdentifier, so the managed user's access token cannot be matched to it.");

    _machineId = id;
    return id;
}

/**
 * Exchange a managed user's account token for the token this server will actually accept.
 *
 * The owner's token works against the server directly; nobody else's does. Plex mints a
 * per-server access token instead, handed out on the resource list, and that is the only one a
 * library call gets past. See the note at the top of this file for the measurements.
 *
 * @param {string} accountToken  the authToken the switch returned
 * @returns {Promise<string>} the token to talk to the local server with
 */
async function accessTokenForServer(accountToken) {
    const machineId = await getMachineIdentifier();

    const res = await fetch(`${PLEX_TV_API_V2}/resources?includeHttps=1`, { headers: plexTvHeaders(accountToken) });
    if (!res.ok) throw new Error(`Plex resource list failed: ${res.status} ${res.statusText}`);

    const list = await res.json();
    const mine = (Array.isArray(list) ? list : []).find(r => r && r.clientIdentifier === machineId);
    if (!mine) {
        // The user exists and the switch worked, but this server is not shared with them. Worth
        // saying plainly: it is fixed in Plex's own sharing settings, not here.
        throw new Error('That Plex Home user has no access to this Plex server. Share the libraries with them in Plex first.');
    }
    // The owner's own resource entry can come back without an accessToken, because their account
    // token already is the server token.
    return mine.accessToken || accountToken;
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
        // Logged, because a rejected PIN used to leave no trace at all: the first report of this
        // feature failing looked like a PIN problem and the log had nothing either way.
        logger.warn(`plexHome: switch to ${plexUsername} refused (${res.status}) for Discord user ${discordUserId}`);
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

    // The switch token talks to plex.tv; this is the one the server accepts.
    const serverToken = await accessTokenForServer(switchedToken);

    const switched = new PlexAPI({
        hostname: plexConfig.hostname,
        port: plexConfig.port,
        https: plexConfig.https,
        token: serverToken,
        options: plexConfig.options
    });

    // Proven before it is cached, and this is not belt-and-braces. The cache previously held
    // whatever the switch produced for thirty minutes, so the first run failed on the server call
    // and every run after it hit the cache, skipped the PIN prompt entirely and failed the same
    // way in seconds. One bad token became a half-hour dead end with no way to retry.
    try {
        await switched.query('/library/sections');
    } catch (err) {
        logger.error(`plexHome: ${plexUsername}'s token was refused by the server: ${err.message || err}`);
        throw new Error(`Plex accepted the switch to ${plexUsername} but the server refused the token. ` +
            'Check that the libraries are shared with that user.');
    }

    setCachedClient(discordUserId, plexUsername, serverToken, switched);
    logger.info(`plexHome: switched to ${plexUsername} for Discord user ${discordUserId}`);
    return switched;
}

/**
 * Drop a cached client, so the next attempt switches again rather than reusing a dead token.
 *
 * A token can expire inside the cache window, and without this the rest of that window answers
 * from the dead entry: no PIN prompt, no switch, the same failure every time.
 */
function forgetClient(discordUserId, plexUsername) {
    const bucket = _userCache.get(discordUserId);
    if (!bucket) return false;
    return bucket.delete(String(plexUsername || '').toLowerCase());
}

/**
 * Turn a plex-api failure into something that says what actually went wrong.
 *
 * plex-api reports a 401 from the server as "you must provide a way to authenticate", which
 * describes its own missing authenticator rather than the response, and reads like the bot was
 * never configured. What it means here is that the token was refused.
 */
function explainError(err) {
    const message = (err && err.message) || String(err || 'unknown error');
    if (/must provide a way to authenticate/i.test(message)) {
        return 'the Plex server refused that account\'s token (HTTP 401)';
    }
    if (/lack of managed user permissions/i.test(message)) {
        return 'that account does not have permission for this on the Plex server (HTTP 403)';
    }
    return message;
}

// Exposed for tests.
function _resetCaches() {
    _userCache.clear();
    _homeUsersCache = null;
    _machineId = null;
}

module.exports = {
    listHomeUsers,
    findUserByName,
    switchAs,
    getCachedClient,
    forgetClient,
    accessTokenForServer,
    explainError,
    _resetCaches
};
