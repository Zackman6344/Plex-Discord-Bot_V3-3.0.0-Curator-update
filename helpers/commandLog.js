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
// Day-files are kept indefinitely. Set PLEXBOT_LOG_RETENTION_DAYS to a positive number to delete
// anything older than that; unset, 0 or unparseable keeps everything. The parse and the prune
// itself live in logPrune.js, shared with logger.js, so one setting really does cover both sinks
// rather than two copies that happen to agree.
const logPrune = require('./logPrune.js');
const RETENTION_DAYS = logPrune.retentionDays();
const COMMAND_LOG = /^commands-(\d{4}-\d{2}-\d{2})\.jsonl$/;
// How far back a read goes when the caller does not say. Kept separate from retention: files are
// now kept forever, and `npm run logs` reading every day since install would only get slower.
// Pass `{ days: 0 }` to read the lot.
const DEFAULT_READ_DAYS = 14;
const MAX_CONTENT = 400;
const MAX_EMBED_TEXT = 200;
const MAX_ARGS = 300;

let counter = 0;
let redactions = null;

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
    logPrune.pruneDayFiles(DIR, COMMAND_LOG, 'command-log');
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

/**
 * @param {boolean} awaited - whether the handler's own promise was waited on. Many commands
 *   start async work and return immediately; recording that distinction stops the log claiming
 *   a 1ms success for a command that is still running (or about to fail).
 */
function finishInvocation(id, { ok = true, ms = null, error = null, awaited = true } = {}) {
    write({
        type: 'outcome',
        id,
        ok: !!ok,
        awaited: !!awaited,
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

/**
 * Record something that happened without anyone typing a command — a track starting, a voice
 * join failing, the process catching a crash. The command log could previously only describe
 * work a user asked for, so anything that broke while the bot ran itself (a queue advancing, a
 * timer firing) left no trace at all.
 */
function recordEvent(kind, detail = {}) {
    const clean = {};
    for (const [key, value] of Object.entries(detail || {})) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
        else if (typeof value === 'string') clean[key] = scrub(value, 300);
        else clean[key] = scrub(JSON.stringify(value), 300);
    }
    write({ type: 'event', kind: String(kind || 'event').slice(0, 60), ...clean });
}

/** Non-command events, newest last. */
function readEventLog({ limit = 40, kind = null, days = DEFAULT_READ_DAYS } = {}) {
    let events = readEvents({ days }).filter((e) => e.type === 'event');
    if (kind) events = events.filter((e) => e.kind === kind);
    // slice(-0) is slice(0), which returns everything rather than nothing, so a limit of 0 or a
    // typo has to be caught before it gets here.
    const take = countOr(limit, 40);
    return take > 0 ? events.slice(-take) : [];
}

/**
 * Normalise a caller-supplied window or limit.
 * A typo used to do the opposite of what was asked: `--days=abc` gave NaN, `NaN > 0` is false,
 * and the reader fell through to "every file there is" instead of narrowing.
 * @returns {number} a non-negative integer, or `fallback` when the value is not usable
 */
function countOr(value, fallback) {
    // Number('') and Number('   ') are 0, so an empty --days read as "every file there is" and
    // slipped past the guard that exists to stop exactly that. Absent and blank are not a count.
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Every event from the most recent `days` day-files, oldest first. Malformed lines are skipped.
 * @param {{days?: number}} [options] days: 0 reads every file there is; anything unusable falls
 *   back to the default window rather than widening.
 */
function readEvents({ days = DEFAULT_READ_DAYS } = {}) {
    days = countOr(days, DEFAULT_READ_DAYS);
    const events = [];
    let files = [];
    try {
        files = fs.readdirSync(DIR).filter((f) => /^commands-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    } catch (_) {
        return events;
    }
    const window = days > 0 ? files.slice(-days) : files;
    for (const name of window) {
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
function readInvocations({ limit = 25, command = null, userId = null, errorsOnly = false, sinceMs = null, days = null } = {}) {
    const byId = new Map();
    const loose = [];

    const wanted = windowFor({ days, sinceMs });

    for (const event of readEvents({ days: wanted })) {
        if (event.type === 'invoke') {
            byId.set(event.id, { ...event, outputs: [], ok: null, ms: null, error: null, awaited: true });
        } else if (event.type === 'outcome' && byId.has(event.id)) {
            Object.assign(byId.get(event.id), {
                ok: event.ok,
                ms: event.ms,
                error: event.error,
                awaited: event.awaited !== false
            });
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

/**
 * How many day-files a read should cover. One copy, because readInvocations decides this and
 * windowInfo has to report the same answer — two copies would drift and the report would then
 * describe a window nobody read.
 * Day-files are kept forever, so a `sinceMs` reaching further back than the default window has to
 * widen it or the answer is quietly truncated at DEFAULT_READ_DAYS files.
 * @returns {number} 0 meaning every file there is
 */
function windowFor({ days = null, sinceMs = null } = {}) {
    if (days !== null && days !== undefined) return countOr(days, DEFAULT_READ_DAYS);
    if (sinceMs) return Math.max(DEFAULT_READ_DAYS, Math.ceil(sinceMs / 86400000) + 1);
    return DEFAULT_READ_DAYS;
}

/**
 * How the read window compares to what is actually on disk, without reading any of it.
 * Retention is unlimited but reads still default to DEFAULT_READ_DAYS, so every reader needs to
 * be able to say "there is more than this" — previously only `--stats` could, and a search whose
 * match fell outside the window answered "nothing logged yet" with a year of files sitting there.
 * @param {{days?: number}} [options] days 0 means the whole store, so nothing is hidden
 * @returns {{windowDays: number, filesOnDisk: number, windowed: boolean}}
 */
function windowInfo({ days = null, sinceMs = null } = {}) {
    const window = windowFor({ days, sinceMs });
    let onDisk = 0;
    try {
        onDisk = fs.readdirSync(DIR).filter((f) => COMMAND_LOG.test(f)).length;
    } catch (_) { /* the directory may not exist yet */ }
    return { windowDays: window, filesOnDisk: onDisk, windowed: window > 0 && onDisk > window };
}

/**
 * Totals over a window of day-files, never over the whole store unless asked.
 * `windowDays` and `filesRead` come back so a caller can say which it is: retention is unlimited
 * now, so presenting a 14-file slice as a lifetime total under-reports without saying so.
 */
function stats({ days = DEFAULT_READ_DAYS } = {}) {
    const window = countOr(days, DEFAULT_READ_DAYS);
    const events = readEvents({ days: window });
    let onDisk = 0;
    try {
        onDisk = fs.readdirSync(DIR).filter((f) => COMMAND_LOG.test(f)).length;
    } catch (_) { /* the directory may not exist yet */ }
    const invokes = events.filter((e) => e.type === 'invoke');
    const outcomes = events.filter((e) => e.type === 'outcome');
    const byCommand = {};
    for (const i of invokes) byCommand[i.command] = (byCommand[i.command] || 0) + 1;
    return {
        dir: DIR,
        // 0 means every file was read, so the totals really are lifetime.
        windowDays: window,
        filesOnDisk: onDisk,
        windowed: window > 0 && onDisk > window,
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
    // The prune throttle lives in logPrune now, so zeroing a local was resetting nothing: seven
    // test files call this expecting a clean module and silently kept an hour-old throttle.
    logPrune.resetThrottle();
    counter = 0;
}

module.exports = {
    startInvocation, finishInvocation, recordOutput, recordEvent, readEventLog, readEvents, readInvocations, stats,
    summarise, _reset, _dir: DIR, countOr, windowInfo, RETENTION_DAYS, DEFAULT_READ_DAYS
};
