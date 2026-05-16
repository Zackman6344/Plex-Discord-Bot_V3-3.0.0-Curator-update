// helpers/healthCheck.js
// Runs all the connectivity checks the bot depends on and returns a structured
// report. Used both at boot (logged) and by !plextest (replied in chat).

const keys = require('../config/keys.js');
const config = require('../config/config.js');
const { getPlex } = require('./plexClient.js');
const tautulli = require('./tautulliAPI.js');
const playnite = require('./playniteAPI.js');

// status values: 'ok' | 'error' | 'missing' | 'disabled'

// Validates the keys that the bot reads silently — i.e. ones where a missing/empty
// value doesn't crash the bot but causes commands to silently no-op. The classic
// failure mode this catches: a stale config/config.js after a rename pass means
// `commandPrefix` is undefined, so `msg.startsWith(undefined)` is always false and
// every command is ignored with zero log output.
function checkConfig() {
    const issues = [];

    if (!config.commandPrefix || typeof config.commandPrefix !== 'string') {
        issues.push('`commandPrefix` is missing or not a string — NO COMMANDS WILL MATCH');
    }
    if (!config.language) {
        issues.push('`language` is missing — language strings will not load');
    }
    if (!config.serverName) {
        issues.push('`serverName` is missing — user-facing strings will look broken');
    }
    if (!config.playlistsDir) {
        issues.push('`playlistsDir` is missing — playlist commands will fail');
    }

    if (issues.length === 0) {
        return { status: 'ok', detail: 'all required keys present' };
    }
    return { status: 'error', detail: issues.join(' | ') };
}

async function checkPlex() {
    if (!require('../config/plex.js').hostname) {
        return { status: 'error', detail: 'hostname is empty in config/plex.js' };
    }
    try {
        const res = await getPlex().query('/');
        const c = res && res.MediaContainer;
        return {
            status: 'ok',
            detail: c ? `${c.friendlyName} v${c.version}` : 'connected'
        };
    } catch (err) {
        return { status: 'error', detail: err && err.message ? err.message : String(err) };
    }
}

function checkGemini() {
    const key = keys.geminiApiKey;
    if (!key || key === 'YOUR_GEMINI_API_KEY_HERE') {
        return { status: 'missing', detail: 'geminiApiKey not set in config/keys.js — AI commands will fail' };
    }
    return { status: 'ok', detail: 'API key present (not test-called to preserve quota)' };
}

async function checkTautulli() {
    if (!config.tautulliEnabled) {
        return { status: 'disabled', detail: 'tautulliEnabled is false in config/config.js' };
    }
    if (!config.tautulliApiKey || !config.tautulliUrl) {
        return { status: 'error', detail: 'tautulliEnabled is true but tautulliApiKey or tautulliUrl is empty' };
    }
    const stats = await tautulli.getLibraryStats();
    if (stats) {
        return { status: 'ok', detail: `${stats.movies} movies, ${stats.shows} shows, ${stats.streams} lifetime streams` };
    }
    return { status: 'error', detail: 'Tautulli unreachable — check tautulliUrl/tautulliApiKey' };
}

async function checkPlaynite() {
    if (!config.playniteEnabled) {
        return { status: 'disabled', detail: 'playniteEnabled is false in config/config.js' };
    }
    const lib = await playnite.getLibrary();
    if (lib && lib.error === 'OFFLINE') {
        return { status: 'error', detail: 'Playnite HTTP server unreachable on :8787 (is Playnite running?)' };
    }
    if (Array.isArray(lib)) {
        return { status: 'ok', detail: `${lib.length} games in library` };
    }
    return { status: 'error', detail: 'Unexpected response from Playnite' };
}

async function runHealthCheck() {
    const [plex, tautulliRes, playniteRes] = await Promise.all([
        checkPlex(),
        checkTautulli(),
        checkPlaynite()
    ]);
    return {
        // Config first — if this fails everything else is moot.
        config: checkConfig(),
        plex,
        gemini: checkGemini(),
        tautulli: tautulliRes,
        playnite: playniteRes
    };
}

const STATUS_ICONS = {
    ok: '✓',
    error: '✗',
    missing: '⚠',
    disabled: '−'
};

function formatHealthCheck(results) {
    const lines = [];
    for (const [name, val] of Object.entries(results)) {
        const icon = STATUS_ICONS[val.status] || '?';
        const label = name.charAt(0).toUpperCase() + name.slice(1);
        lines.push(`  ${icon} ${label}: ${val.detail}`);
    }
    return lines.join('\n');
}

module.exports = { runHealthCheck, formatHealthCheck };
