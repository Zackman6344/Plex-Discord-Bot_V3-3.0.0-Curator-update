// helpers/commandLog.js
//
// A structured record of what the bot was asked to do and what it said back.
//
// The console logger tells you what the bot was thinking; this tells you what actually happened:
// who ran what, with which arguments, by which route (prefix / slash / button), how long it took,
// whether it threw, and every message the bot posted in response. That is the difference between
// "a command failed yesterday" and being able to read the exact invocation back.
//
// Format is JSON Lines, one event per line, in daily files under data/logs/. Plain text so it can
// be grepped, and one-object-per-line so a half-written final line (bot killed mid-append) costs
// one event rather than the whole file.
//
// Events:
//   {t, type: 'invoke',  id, path, command, args, user, userId, channel, channelId, guildId}
//   {t, type: 'outcome', id, ok, ms, error}
//   {t, type: 'output',  id, kind, channelId, content, embeds, components}

const fs = require('fs');
const path = require('path');

const DIR = process.env.PLEXBOT_LOG_DIR || path.join(__dirname, '..', 'data', 'logs');
const RETENTION_DAYS = 14;
const MAX_CONTENT = 400;
const MAX_EMBED_TEXT = 200;
const MAX_ARGS = 300;

let counter = 0;
let redactions = null;
let lastPrune = 0;

/** Values that must never reach disk, discovered once from the local config. */
function secrets() {
    if (redactions) return redactions;
    redactions = [];
    const add = (value) => {
        if (typeof value === 'string' && value.length >= 8) redactions.push(value);
    };
    try {
        const keys = require('../config/keys.js');
        add(keys.botToken);
        add(keys.geminiApiKey);
    } catch (_) { /* not configured yet */ }
    try {
        add(require('../config/plex.js').token);
    } catch (_) { /* not configured yet */ }
    try {
        add(require('../config/config.js').tautulliApiKey);
    } catch (_) { /* not configured yet */ }
    return redactions;
}

function scrub(text, max, { keepLines = false } = {}) {
    if (text === null || text === undefined) return null;
    let out = String(text);
    for (const secret of secrets()) {
        if (secret && out.includes(secret)) out = out.split(secret).join('[redacted]');
    }
    // Stack traces stay line-shaped because that's how they're read; everything else collapses
    // to one line so a multi-line embed can't sprawl across the log.
    out = keepLines ? out.replace(/[ \t]+/g, ' ').trim() : out.replace(/\s+/g, ' ').trim();
    return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

function fileForToday() {
    return path.join(DIR, `commands-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

/** Drop day-files older than the retention window. Cheap, and only once an hour. */
function prune() {
    if (Date.now() - lastPrune < 60 * 60 * 1000) return;
    lastPrune = Date.now();
    try {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        for (const name of fs.readdirSync(DIR)) {
            const match = /^commands-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
            if (!match) continue;
            if (new Date(match[1] + 'T00:00:00Z').getTime() < cutoff) {
                fs.unlinkSync(path.join(DIR, name));
            }
        }
    } catch (_) { /* pruning is housekeeping, never worth an error */ }
}

// Under the test runner, only write when a test has pointed PLEXBOT_LOG_DIR somewhere of its own.
// That keeps this module's own tests working while making it impossible for some *other* test to
// scribble into the real log by accident.
const underTest = !!process.env.NODE_TEST_CONTEXT;
const enabled = process.env.PLEXBOT_COMMAND_LOG !== '0' && (!underTest || !!process.env.PLEXBOT_LOG_DIR);

function write(event) {
    if (!enabled) return;
    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(fileForToday(), JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
        prune();
    } catch (_) {
        // Logging must never take the bot down, and reporting a logging failure through the
        // logger risks a loop. Swallow it; `npm run logs` showing nothing is the symptom.
    }
}

/**
 * Record that a command was invoked. The returned id ties the outcome and any output back to it.
 *
 * @param {Object} info
 * @param {string} info.path - 'prefix' | 'slash' | 'button' | 'autocomplete'
 * @returns {string} invocation id
 */
function startInvocation(info = {}) {
    const id = `${Date.now().toString(36)}-${(counter++).toString(36)}`;
    write({
        type: 'invoke',
        id,
        path: info.path || 'unknown',
        command: info.command || null,
        args: scrub(info.args, MAX_ARGS),
        user: scrub(info.user, 80),
        userId: info.userId || null,
        channel: scrub(info.channel, 80),
        channelId: info.channelId || null,
        guildId: info.guildId || null
    });
    return id;
}

function finishInvocation(id, { ok = true, ms = null, error = null } = {}) {
    write({
        type: 'outcome',
        id,
        ok: !!ok,
        ms: typeof ms === 'number' ? Math.round(ms) : null,
        error: error ? scrub(error.stack || error.message || String(error), 900, { keepLines: true }) : null
    });
}

/** Summarise a Discord message payload down to what's worth keeping. */
function summarise(payload) {
    if (payload === null || payload === undefined) return { content: null, embeds: [], components: 0 };
    if (typeof payload === 'string') return { content: scrub(payload, MAX_CONTENT), embeds: [], components: 0 };

    const embeds = [];
    for (const embed of (payload.embeds || []).slice(0, 5)) {
        const data = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : (embed && embed.data) || embed || {};
        embeds.push({
            title: scrub(data.title, MAX_EMBED_TEXT),
            description: scrub(data.description, MAX_EMBED_TEXT),
            fields: (data.fields || []).length
        });
    }
    return {
        content: scrub(payload.content, MAX_CONTENT),
        embeds,
        components: (payload.components || []).length
    };
}

/**
 * Record something the bot said. `kind` distinguishes a channel post from an interaction reply,
 * since the two look identical after the fact but come from different code paths.
 */
function recordOutput({ id = null, kind = 'message', channelId = null, payload = null } = {}) {
    const { content, embeds, components } = summarise(payload);
    if (!content && embeds.length === 0 && !components) return;
    write({ type: 'output', id, kind, channelId, content, embeds, components });
}

/** Every event from the retained day-files, oldest first. Malformed lines are skipped. */
function readEvents({ days = RETENTION_DAYS } = {}) {
    const events = [];
    let files = [];
    try {
        files = fs.readdirSync(DIR).filter((f) => /^commands-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    } catch (_) {
        return events;
    }
    for (const name of files.slice(-days)) {
        let raw = '';
        try { raw = fs.readFileSync(path.join(DIR, name), 'utf8'); } catch (_) { continue; }
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch (_) { /* torn final line */ }
        }
    }
    return events;
}

/**
 * Events folded back into one record per invocation, newest first — the shape you actually want
 * when reading back "what happened".
 */
function readInvocations({ limit = 25, command = null, userId = null, errorsOnly = false, sinceMs = null } = {}) {
    const byId = new Map();
    const loose = [];

    for (const event of readEvents()) {
        if (event.type === 'invoke') {
            byId.set(event.id, { ...event, outputs: [], ok: null, ms: null, error: null });
        } else if (event.type === 'outcome' && byId.has(event.id)) {
            Object.assign(byId.get(event.id), { ok: event.ok, ms: event.ms, error: event.error });
        } else if (event.type === 'output') {
            if (event.id && byId.has(event.id)) byId.get(event.id).outputs.push(event);
            else loose.push(event);
        }
    }

    let list = [...byId.values()].reverse();
    if (command) list = list.filter((i) => i.command === command);
    if (userId) list = list.filter((i) => i.userId === userId);
    if (errorsOnly) list = list.filter((i) => i.ok === false || i.error);
    if (sinceMs) {
        const cutoff = Date.now() - sinceMs;
        list = list.filter((i) => new Date(i.t).getTime() >= cutoff);
    }
    return { invocations: list.slice(0, limit), unattached: loose.slice(-limit) };
}

function stats() {
    const events = readEvents();
    const invokes = events.filter((e) => e.type === 'invoke');
    const outcomes = events.filter((e) => e.type === 'outcome');
    const byCommand = {};
    for (const i of invokes) byCommand[i.command] = (byCommand[i.command] || 0) + 1;
    return {
        dir: DIR,
        events: events.length,
        invocations: invokes.length,
        failures: outcomes.filter((o) => !o.ok).length,
        outputs: events.filter((e) => e.type === 'output').length,
        topCommands: Object.entries(byCommand).sort((a, b) => b[1] - a[1]).slice(0, 10)
    };
}

// exported for tests
function _reset() {
    redactions = null;
    lastPrune = 0;
    counter = 0;
}

module.exports = {
    startInvocation, finishInvocation, recordOutput, readEvents, readInvocations, stats,
    summarise, _reset, _dir: DIR, RETENTION_DAYS
};
