// helpers/configStore.js
// Backing store + schema for the in-Discord `/config` wizard (commands/config.js).
//
// Persistence model: config/config.js merges data/config.overrides.json over its defaults at
// load. This module writes that overrides file and — because bot.config is the same object as
// require('../config/config.js') — also mutates the live config object so most settings take
// effect immediately, no restart. The schema + the pure formatValue/validate helpers are kept
// here (no discord.js) so they can be unit-tested without a running bot.
const fs = require('fs');
const path = require('path');

const OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'config.overrides.json');

// Group render order for the wizard panel.
const GROUPS = ['General', 'Access', 'Integrations', 'Broadcasts'];

// Editable settings. `type`: bool | string | int | choice.
//   secret          — never display the value; modal input starts blank.
//   restartRequired — only takes effect on next boot (e.g. the already-bound event listener).
//   snowflake       — when non-empty, must be a 17-20 digit Discord ID.
//   allowEmpty      — blank is a valid value (default true for strings unless set false).
//   warn            — extra caution note shown in the modal.
const SETTINGS = [
    { key: 'commandPrefix', label: 'Command prefix', group: 'General', type: 'string', allowEmpty: false, maxLen: 5, placeholder: '!' },
    { key: 'serverName', label: 'Server display name', group: 'General', type: 'string', allowEmpty: false, placeholder: 'My Plex Server' },
    { key: 'listenChannel', label: 'Listen channel (name, blank = all)', group: 'General', type: 'string', placeholder: 'bot-commands' },
    {
        key: 'youtube_quality', label: 'YouTube audio quality', group: 'General', type: 'choice',
        choices: [
            { label: 'Lowest (less bandwidth)', value: 'lowestaudio' },
            { label: 'Highest (best quality)', value: 'highestaudio' },
        ],
    },

    { key: 'ownerId', label: 'Owner Discord ID', group: 'Access', type: 'string', snowflake: true, warn: 'Changing this can lock you out of owner-only commands.' },
    { key: 'launchRoleId', label: 'Launch role ID (optional)', group: 'Access', type: 'string', snowflake: true },
    { key: 'testGuildId', label: 'Test guild ID (dev slash reg)', group: 'Access', type: 'string', snowflake: true },

    { key: 'playniteEnabled', label: 'Playnite integration', group: 'Integrations', type: 'bool' },
    { key: 'tautulliEnabled', label: 'Tautulli integration', group: 'Integrations', type: 'bool' },
    { key: 'tautulliUrl', label: 'Tautulli URL', group: 'Integrations', type: 'string', placeholder: 'http://localhost:8181' },
    { key: 'tautulliApiKey', label: 'Tautulli API key', group: 'Integrations', type: 'string', secret: true },

    { key: 'broadcastChannelId', label: 'Broadcast channel (fallback)', group: 'Broadcasts', type: 'string', snowflake: true },
    { key: 'kometaChannelId', label: 'Kometa channel', group: 'Broadcasts', type: 'string', snowflake: true },
    { key: 'gameLaunchChannelId', label: 'Game-launch channel', group: 'Broadcasts', type: 'string', snowflake: true },
    { key: 'eventServerEnabled', label: 'Event server (Kometa/Playnite)', group: 'Broadcasts', type: 'bool', restartRequired: true },
    { key: 'eventServerPort', label: 'Event server port', group: 'Broadcasts', type: 'int', min: 1, max: 65535, restartRequired: true },
    { key: 'eventServerToken', label: 'Event server token', group: 'Broadcasts', type: 'string', secret: true },
    { key: 'broadcastKometa', label: 'Broadcast Kometa run summaries', group: 'Broadcasts', type: 'bool' },
    { key: 'broadcastKometaChanges', label: 'Broadcast live Kometa changes', group: 'Broadcasts', type: 'bool' },
    { key: 'kometaChangesMinAdds', label: 'Min additions to report a change', group: 'Broadcasts', type: 'int', min: 1, max: 1000 },
    { key: 'broadcastGameLaunch', label: 'Broadcast game launches (Playnite)', group: 'Broadcasts', type: 'bool' },
    { key: 'gamePresenceEnabled', label: 'Detect games via Discord activity', group: 'Broadcasts', type: 'bool', restartRequired: true },
    { key: 'broadcastStartup', label: 'Broadcast "system started" on boot', group: 'Broadcasts', type: 'bool' },
    { key: 'kometaTheaterEnabled', label: 'Kometa Theater (in-character narration)', group: 'Broadcasts', type: 'bool', restartRequired: true },
];

function getSetting(key) {
    return SETTINGS.find((s) => s.key === key) || null;
}

// --- display -------------------------------------------------------------------------------

function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Human-readable current value for the panel. Never reveals secret values.
function formatValue(setting, value) {
    if (setting.type === 'bool') return value ? '✅ enabled' : '🚫 disabled';
    if (setting.secret) return value ? '••• set' : '— not set';
    if (setting.type === 'choice') {
        const match = (setting.choices || []).find((c) => c.value === value);
        return match ? match.label : String(value);
    }
    if (value === '' || value === undefined || value === null) return '— (empty)';
    return truncate(String(value), 60);
}

// --- validation ----------------------------------------------------------------------------

// Coerce/validate raw string (or boolean) input for a setting. Returns { value } or { error }.
function validate(setting, raw) {
    if (setting.type === 'bool') {
        if (typeof raw === 'boolean') return { value: raw };
        if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
        return { error: 'Expected a true/false value.' };
    }

    if (setting.type === 'int') {
        const s = String(raw).trim();
        if (!/^-?\d+$/.test(s)) return { error: 'Enter a whole number.' };
        const n = parseInt(s, 10);
        if (setting.min !== undefined && n < setting.min) return { error: `Must be ≥ ${setting.min}.` };
        if (setting.max !== undefined && n > setting.max) return { error: `Must be ≤ ${setting.max}.` };
        return { value: n };
    }

    if (setting.type === 'choice') {
        const ok = (setting.choices || []).some((c) => c.value === raw);
        return ok ? { value: raw } : { error: 'Pick one of the listed options.' };
    }

    // string
    const value = String(raw).trim();
    if (value === '') {
        if (setting.allowEmpty === false) return { error: 'This value cannot be empty.' };
        return { value: '' };
    }
    if (setting.maxLen && value.length > setting.maxLen) {
        return { error: `Keep it to ${setting.maxLen} characters or fewer.` };
    }
    if (setting.snowflake && !/^\d{17,20}$/.test(value)) {
        return { error: 'That does not look like a Discord ID (17-20 digits).' };
    }
    if (setting.key === 'tautulliUrl' && !/^https?:\/\//i.test(value)) {
        return { error: 'Must start with http:// or https://' };
    }
    return { value };
}

// --- persistence ---------------------------------------------------------------------------

function readOverrides(overridesPath = OVERRIDES_PATH) {
    try {
        if (!fs.existsSync(overridesPath)) return {};
        const parsed = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

// Persist one override and (by default) apply it to the live config object immediately.
function writeOverride(key, value, opts = {}) {
    const overridesPath = opts.path || OVERRIDES_PATH;
    const applyLive = opts.applyLive !== false;

    const obj = readOverrides(overridesPath);
    obj[key] = value;
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    fs.writeFileSync(overridesPath, JSON.stringify(obj, null, 2) + '\n');

    if (applyLive) require('../config/config.js')[key] = value;
    return obj;
}

// Drop an override from the file (reverts to the config.js default on next boot). Does not
// change the live value — restart to pick the default back up.
function removeOverride(key, opts = {}) {
    const overridesPath = opts.path || OVERRIDES_PATH;
    const obj = readOverrides(overridesPath);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
        fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
        fs.writeFileSync(overridesPath, JSON.stringify(obj, null, 2) + '\n');
    }
    return obj;
}

module.exports = {
    OVERRIDES_PATH,
    GROUPS,
    SETTINGS,
    getSetting,
    formatValue,
    validate,
    readOverrides,
    writeOverride,
    removeOverride,
};
