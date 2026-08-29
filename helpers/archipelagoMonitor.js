// helpers/archipelagoMonitor.js
//
// Keeps one ArchipelagoClient per watched room and relays its log lines into a Discord
// channel. Watches survive restarts — they're persisted to data/archipelago_watches.json
// and re-opened on boot, the same way the health monitor comes up with the bot.
//
// Lines are batched rather than posted individually. A busy multiworld can emit dozens of
// item sends a minute, which would blow straight through Discord's per-channel rate limit
// and bury the rest of the channel; collecting a few seconds of log into one fenced block
// reads better anyway. The fence also means a player named `@everyone` or a chat line full
// of markdown can't reformat the channel — belt and braces with allowedMentions.

const fs = require('fs');
const path = require('path');
const config = require('../config/config.js');
const logger = require('./logger.js');
const { ArchipelagoClient, parseTarget, ITEM_FLAG_PROGRESSION, CATEGORY_GROUPS } = require('./archipelagoClient.js');

const WATCH_FILE = path.join(__dirname, '..', 'data', 'archipelago_watches.json');
// Read per flush rather than captured at load, so the /config wizard's change to
// archipelagoBatchSeconds applies to the next batch instead of the next boot.
function flushDelayMs() {
    return Math.max(1, Number(config.archipelagoBatchSeconds) || 5) * 1000;
}
// 1900 leaves room for the ``` fences inside Discord's 2000-character message limit.
const MAX_CHUNK = 1900;
const MAX_MESSAGES_PER_FLUSH = 3;
const MAX_BUFFER_LINES = 500;

const DEFAULT_FILTERS = { items: true, hints: true, chat: true, joins: true, goals: true, misc: true, deaths: false };
const FILTER_GROUPS = Object.keys(CATEGORY_GROUPS);

let discord = null;
const states = new Map();

function loadStore() {
    try {
        const raw = fs.readFileSync(WATCH_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            nextId: Number(parsed.nextId) || 1,
            watches: Array.isArray(parsed.watches) ? parsed.watches : []
        };
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('Archipelago watch file unreadable:', err.message);
        return { nextId: 1, watches: [] };
    }
}

function saveStore(store) {
    try {
        fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
        fs.writeFileSync(WATCH_FILE, JSON.stringify(store, null, 4));
    } catch (err) {
        logger.error('Could not persist Archipelago watches:', err.message);
    }
}

function currentStore() {
    return {
        nextId: Math.max(1, ...[...states.values()].map(s => s.watch.id + 1)),
        watches: [...states.values()].map(s => s.watch)
    };
}

function persist() {
    saveStore(currentStore());
}

function formatLine(text, date = new Date()) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    // A log line containing a fence would end the code block early and let the rest of the
    // line render as markdown.
    return `[${hh}:${mm}] ${String(text).replace(/```/g, "'''")}`;
}

function chunkLines(lines, max = MAX_CHUNK) {
    const chunks = [];
    let current = '';
    for (const raw of lines) {
        const line = raw.length > max ? `${raw.substring(0, max - 1)}…` : raw;
        if (!current) {
            current = line;
        } else if (current.length + 1 + line.length > max) {
            chunks.push(current);
            current = line;
        } else {
            current += `\n${line}`;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function shouldRelay(watch, line) {
    const filters = watch.filters || DEFAULT_FILTERS;
    if (filters[line.group] === false) return false;
    if (watch.progressionOnly && line.group === 'items' && !(line.flags & ITEM_FLAG_PROGRESSION)) return false;
    return true;
}

function describeTarget(target) {
    if (!target) return 'unknown';
    return target.kind === 'room' ? target.roomUrl : `${target.host}:${target.port}`;
}

async function resolveChannel(state) {
    if (state.channel) return state.channel;
    if (!discord) return null;
    try {
        state.channel = await discord.channels.fetch(state.watch.channelId);
        return state.channel;
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] channel ${state.watch.channelId} unavailable:`, err.message);
        return null;
    }
}

async function post(state, content) {
    const channel = await resolveChannel(state);
    if (!channel || typeof channel.send !== 'function') return;
    try {
        await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] post failed:`, err.message);
        state.channel = null;
    }
}

async function flush(state) {
    state.timer = null;
    if (state.buffer.length === 0) return;

    const lines = state.buffer.splice(0, state.buffer.length);
    let chunks = chunkLines(lines);
    let trimmed = 0;
    if (chunks.length > MAX_MESSAGES_PER_FLUSH) {
        trimmed = chunks.length - MAX_MESSAGES_PER_FLUSH;
        chunks = chunks.slice(0, MAX_MESSAGES_PER_FLUSH);
    }

    for (const chunk of chunks) {
        await post(state, `\`\`\`\n${chunk}\n\`\`\``);
    }
    if (trimmed > 0) {
        await post(state, `…${trimmed} further block(s) of log trimmed to keep the channel readable.`);
    }
}

function enqueue(state, text) {
    state.buffer.push(formatLine(text));
    state.lineCount++;
    if (state.buffer.length > MAX_BUFFER_LINES) {
        const overflow = state.buffer.length - MAX_BUFFER_LINES;
        state.buffer.splice(0, overflow);
        state.droppedLines += overflow;
    }
    if (!state.timer) {
        state.timer = setTimeout(() => {
            flush(state).catch(err => logger.error(`[AP:${state.watch.label}] flush threw:`, err.message || err));
        }, flushDelayMs());
    }
}

function attach(state) {
    const { client, watch } = state;

    client.on('line', (line) => {
        if (!shouldRelay(watch, line)) return;
        enqueue(state, line.text);
    });

    client.on('status', ({ state: phase, detail }) => {
        state.status = phase;
        state.detail = detail;

        if (phase === 'connected') {
            state.connectedAt = Date.now();
            const first = !state.announcedConnected;
            state.announcedConnected = true;
            if (first || state.announcedProblem) {
                state.announcedProblem = false;
                post(state, `🟢 **${watch.label}** — watching as \`${watch.slot}\` on \`${detail}\`.`);
            }
            logger.info(`[AP:${watch.label}] connected to ${detail} as ${watch.slot}`);
            return;
        }

        if (phase === 'disconnected' || phase === 'error') {
            if (state.announcedConnected && !state.announcedProblem) {
                state.announcedProblem = true;
                post(state, `🟠 **${watch.label}** — lost the room (${detail}). Retrying in the background.`);
            }
            logger.warn(`[AP:${watch.label}] ${phase}: ${detail}`);
        }
    });

    client.on('fatal', ({ reason }) => {
        state.status = 'stopped';
        state.detail = reason;
        state.watch.paused = true;
        persist();
        logger.error(`[AP:${watch.label}] connection refused: ${reason}`);
        post(state, `🔴 **${watch.label}** — the server refused the connection (\`${reason}\`). ` +
            `Watch paused; fix it and run \`${config.commandPrefix}ap retry ${watch.id}\`.`);
    });
}

function makeState(watch) {
    const client = new ArchipelagoClient({
        target: watch.target,
        slot: watch.slot,
        password: watch.password,
        deathlink: !!(watch.filters && watch.filters.deaths),
        label: watch.label
    });
    const state = {
        watch,
        client,
        channel: null,
        buffer: [],
        timer: null,
        status: 'idle',
        detail: null,
        connectedAt: null,
        lineCount: 0,
        droppedLines: 0,
        announcedConnected: false,
        announcedProblem: false
    };
    attach(state);
    return state;
}

function startWatch(watch) {
    const state = makeState(watch);
    states.set(watch.id, state);
    if (!watch.paused) state.client.start();
    return state;
}

function stopWatch(id) {
    const state = states.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.client.stop();
}

// Rebuilds the client so a changed password, slot, or DeathLink tag takes effect — all
// three are only read during the connect handshake.
function restartWatch(id) {
    const existing = states.get(id);
    if (!existing) return null;
    stopWatch(id);
    const state = makeState(existing.watch);
    state.channel = existing.channel;
    states.set(id, state);
    existing.watch.paused = false;
    state.client.start();
    persist();
    return state;
}

function startArchipelagoMonitor(client) {
    if (!config.archipelagoEnabled) {
        logger.debug('Archipelago monitor disabled (config.archipelagoEnabled is false)');
        return;
    }
    discord = client;

    const store = loadStore();
    for (const watch of store.watches) {
        watch.filters = { ...DEFAULT_FILTERS, ...(watch.filters || {}) };
        startWatch(watch);
    }

    const active = store.watches.filter(w => !w.paused).length;
    logger.info(`Archipelago monitor started — ${active} room(s) watched, ${store.watches.length - active} paused`);
}

/**
 * Register a new watch and wait briefly for the first connection result, so the user gets
 * "connected" or "that slot doesn't exist" in the same reply instead of silence.
 * @returns {Promise<{watch: Object, outcome: string, detail: string}>}
 */
function addWatch(options, waitMs = 20000) {
    const target = parseTarget(options.target);
    if (!target) throw new Error('Unrecognised room — give me a room URL or a `host:port`.');
    if (!options.slot) throw new Error('I need the slot name to watch from.');

    const store = currentStore();
    const watch = {
        id: store.nextId,
        label: options.label || (target.kind === 'room' ? 'Archipelago room' : target.host),
        target,
        slot: options.slot,
        password: options.password || null,
        channelId: options.channelId,
        guildId: options.guildId || null,
        filters: { ...DEFAULT_FILTERS },
        progressionOnly: false,
        paused: false,
        addedBy: options.addedBy || null,
        addedAt: new Date().toISOString()
    };

    const state = startWatch(watch);
    persist();

    return new Promise((resolve) => {
        const finish = (outcome, detail) => {
            clearTimeout(timer);
            state.client.off('status', onStatus);
            state.client.off('fatal', onFatal);
            resolve({ watch, outcome, detail });
        };
        const onStatus = ({ state: phase, detail }) => {
            if (phase === 'connected') finish('connected', detail);
        };
        const onFatal = ({ reason }) => finish('refused', reason);
        const timer = setTimeout(() => finish('pending', state.detail), waitMs);

        state.client.on('status', onStatus);
        state.client.on('fatal', onFatal);
    });
}

function removeWatch(id) {
    const state = states.get(id);
    if (!state) return null;
    stopWatch(id);
    states.delete(id);
    persist();
    return state.watch;
}

function setPassword(id, password) {
    const state = states.get(id);
    if (!state) return null;
    state.watch.password = password || null;
    return restartWatch(id);
}

function setFilter(id, group, enabled) {
    const state = states.get(id);
    if (!state) return null;
    if (!FILTER_GROUPS.includes(group)) throw new Error(`Unknown category "${group}".`);
    state.watch.filters = { ...DEFAULT_FILTERS, ...state.watch.filters, [group]: enabled };
    // The DeathLink tag is negotiated at connect time, so that one needs a fresh socket.
    if (group === 'deaths') return restartWatch(id);
    persist();
    return state;
}

function setProgressionOnly(id, enabled) {
    const state = states.get(id);
    if (!state) return null;
    state.watch.progressionOnly = !!enabled;
    persist();
    return state;
}

function listWatches() {
    return [...states.values()].map(state => ({
        watch: state.watch,
        status: state.watch.paused ? 'paused' : state.status,
        detail: state.detail,
        address: state.client.address,
        lineCount: state.lineCount,
        droppedLines: state.droppedLines,
        connectedAt: state.connectedAt,
        players: state.client.players.size
    }));
}

function getWatch(id) {
    const state = states.get(id);
    return state ? state.watch : null;
}

// For !diag. A disconnect is normal (a hosted room sleeps, a server restarts) and the client
// retries on its own, so only a refusal, which needs a human, is worth reporting as broken.
function getStatus() {
    const list = listWatches();
    return {
        enabled: !!config.archipelagoEnabled,
        total: list.length,
        connected: list.filter(entry => entry.status === 'connected').length,
        paused: list.filter(entry => entry.watch.paused).length
    };
}

module.exports = {
    startArchipelagoMonitor,
    addWatch,
    removeWatch,
    restartWatch,
    setPassword,
    setFilter,
    setProgressionOnly,
    listWatches,
    getWatch,
    getStatus,
    describeTarget,
    chunkLines,
    formatLine,
    shouldRelay,
    DEFAULT_FILTERS,
    FILTER_GROUPS,
    WATCH_FILE
};
