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
const configStore = require('./configStore.js');
const tracker = require('./archipelagoTracker.js');
const { ArchipelagoClient, parseTarget, ITEM_FLAG_PROGRESSION, CATEGORY_GROUPS, DEFAULT_PORT } = require('./archipelagoClient.js');

// Overridable so a test run can point at its own file, and so the store can be relocated.
const WATCH_FILE = process.env.PLEXBOT_AP_WATCHES_FILE || path.join(__dirname, '..', 'data', 'archipelago_watches.json');
// Under the test runner that override is required rather than optional, the same gate
// commandLog.js and tagSidecar.js use. The real file holds a room password, and a test run has
// no business reading or rewriting it.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_WATCHES_FILE;
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
// The room described by config/config.js gets a reserved id. It is rebuilt from config rather
// than stored in the watch file, so `!ap watch` rooms number from 1 and never collide with it.
const CONFIG_WATCH_ID = 0;

let discord = null;
let savedWatchesLoaded = false;
const states = new Map();

function loadStore() {
    if (!usable) return { nextId: 1, watches: [] };
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
    if (!usable) return;
    try {
        fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
        fs.writeFileSync(WATCH_FILE, JSON.stringify(store, null, 4));
    } catch (err) {
        logger.error('Could not persist Archipelago watches:', err.message);
    }
}

// The configured room is derived from config/config.js on every boot, so writing it to the
// watch file would leave a stale duplicate behind the moment those settings changed.
function currentStore() {
    const watches = [...states.values()].map(s => s.watch).filter(w => !w.managed);
    return {
        nextId: Math.max(1, ...watches.map(w => w.id + 1)),
        watches
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
    // The bot narrating its own arrival. The room announces every client attaching to a slot,
    // so each reconnect produced another "tracking <game> has joined" line in the channel, which
    // is the bot talking about itself and never what the channel is for.
    if (line.self) return false;

    const filters = watch.filters || DEFAULT_FILTERS;
    if (filters[line.group] === false) return false;
    if (watch.progressionOnly && line.group === 'items' && !(line.flags & ITEM_FLAG_PROGRESSION)) return false;
    // Once a slot has goaled or released, items still arriving for it change nothing. In a long
    // async that is most of the late-game traffic.
    if (watch.skipGoaled && line.group === 'items' && line.recipientFinished) return false;
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

    // An ```ansi fence is what makes Discord honour the colour codes; a plain fence would show
    // them as literal escape text.
    const fence = state.watch.color ? 'ansi' : '';
    for (const chunk of chunks) {
        await post(state, `\`\`\`${fence}\n${chunk}\n\`\`\``);
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

// A hosted room sleeps on its own and comes back on the next connect, so the socket drops and
// re-opens as a matter of course. Announcing every cycle turned the channel into a status feed
// with the actual log buried in it. Only the first connect is announced; drops and retries stay
// in the bot log, where `!ap list` and `!diag` can still be asked about them. A refusal is still
// posted, because unlike a drop it needs a person.
//
// A deliberate restart (a changed room, `!ap retry`) builds a fresh state, so that one does
// announce again, which is the confirmation you want after changing something.
function connectionNotice(state, phase, detail) {
    if (phase !== 'connected' || state.announcedConnected) return null;
    return `🟢 **${state.watch.label}** — watching as \`${state.watch.slot}\` on \`${detail}\`. ` +
        `Reconnects stay quiet from here.`;
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
        if (phase === 'connected') state.connectedAt = Date.now();

        const notice = connectionNotice(state, phase, detail);
        if (phase === 'connected') state.announcedConnected = true;
        if (notice) post(state, notice);

        if (phase === 'connected') {
            logger.info(`[AP:${watch.label}] connected to ${detail} as ${watch.slot}`);
        } else if (phase === 'disconnected' || phase === 'error') {
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
        colorize: watch.color !== false,
        markers: watch.markers !== false,
        label: watch.label
    });
    const state = {
        watch,
        client,
        channel: null,
        buffer: [],
        timer: null,
        pollTimer: null,
        trackerUrl: null,
        status: 'idle',
        detail: null,
        connectedAt: null,
        lineCount: 0,
        droppedLines: 0,
        announcedConnected: false
    };
    attach(state);
    return state;
}

// A slot with every location checked is done in the way that matters here: nothing it receives
// can be used, and nothing more can come out of it. The socket cannot see that (the protocol
// exposes no other slot's locations), so it comes off the room's tracker page. Room-URL watches
// only; a bare host:port has no web host to ask.
function trackerPollMs() {
    return Math.max(1, Number(config.archipelagoTrackerPollMinutes) || 15) * 60 * 1000;
}

async function pollCompletion(state) {
    const watch = state.watch;
    if (!watch.inferFinished || !watch.target || watch.target.kind !== 'room') return;

    try {
        const result = await tracker.readCompletion(watch.target.roomUrl, {
            team: state.client.team,
            trackerUrl: state.trackerUrl
        });
        // The tracker id is stable for the life of the room, so it is resolved once.
        state.trackerUrl = result.trackerUrl;
        state.client.fullyChecked = result.fullyChecked;
        logger.debug(`[AP:${watch.label}] tracker: ${result.fullyChecked.size}/${result.rows.length} slots fully checked`);
    } catch (err) {
        // Never fatal: the relay keeps working, the filter just falls back to goals and releases.
        logger.debug(`[AP:${watch.label}] tracker read failed: ${err.message}`);
    }
}

function startCompletionPoll(state) {
    if (state.pollTimer) return;
    if (!state.watch.inferFinished || !state.watch.target || state.watch.target.kind !== 'room') return;
    // The tracker page is large, so this is deliberately slow. Completion changes over hours.
    pollCompletion(state);
    state.pollTimer = setInterval(() => pollCompletion(state), trackerPollMs());
}

function startWatch(watch) {
    const state = makeState(watch);
    states.set(watch.id, state);
    if (!watch.paused) {
        state.client.start();
        startCompletionPoll(state);
    }
    return state;
}

function stopWatch(id) {
    const state = states.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.timer = null;
    state.pollTimer = null;
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
    // Both survive the new socket: the tracker id is fixed for the room's life, and completion
    // read before the reconnect is still true after it.
    state.trackerUrl = existing.trackerUrl;
    state.client.fullyChecked = existing.client.fullyChecked;
    state.client.released = existing.client.released;
    states.set(id, state);
    existing.watch.paused = false;
    state.client.start();
    startCompletionPoll(state);
    persist();
    return state;
}

// Which room config/config.js is asking for. A room URL wins over host/port: on a hosted room
// the port moves every spin-up, and only the URL lets the client re-read the current one.
function configTarget() {
    const url = String(config.archipelagoRoomUrl || '').trim();
    if (url) return parseTarget(url);
    const host = String(config.archipelagoHost || '').trim();
    if (host) return parseTarget(`${host}:${Number(config.archipelagoPort) || DEFAULT_PORT}`);
    return null;
}

function configFilters() {
    return {
        items:  config.archipelagoShowItems !== false,
        hints:  config.archipelagoShowHints !== false,
        chat:   config.archipelagoShowChat !== false,
        joins:  config.archipelagoShowJoins !== false,
        goals:  config.archipelagoShowGoals !== false,
        misc:   config.archipelagoShowMisc !== false,
        deaths: config.archipelagoShowDeaths === true
    };
}

/** What the configured room still needs before it can connect. Empty means it is ready. */
function configGaps() {
    const gaps = [];
    if (!configTarget()) gaps.push('a room URL, or a host');
    if (!String(config.archipelagoSlot || '').trim()) gaps.push('a slot name');
    if (!String(config.archipelagoChannelId || '').trim()) gaps.push('a log channel');
    return gaps;
}

function syncConfigWatch() {
    const existing = states.get(CONFIG_WATCH_ID);

    if (configGaps().length > 0) {
        if (existing) {
            stopWatch(CONFIG_WATCH_ID);
            states.delete(CONFIG_WATCH_ID);
            logger.info('Archipelago configured room cleared — its settings are no longer complete');
        }
        return null;
    }

    const desired = {
        id: CONFIG_WATCH_ID,
        managed: true,
        label: 'Configured room',
        target: configTarget(),
        slot: String(config.archipelagoSlot).trim(),
        password: config.archipelagoPassword || null,
        channelId: String(config.archipelagoChannelId).trim(),
        filters: configFilters(),
        progressionOnly: !!config.archipelagoProgressionOnly,
        skipGoaled: config.archipelagoSkipGoaled !== false,
        inferFinished: config.archipelagoInferFinished !== false,
        color: config.archipelagoColorLines !== false,
        markers: config.archipelagoItemMarkers !== false,
        paused: false,
        addedBy: null,
        addedAt: new Date().toISOString()
    };

    if (!existing) {
        startWatch(desired);
        logger.info(`Archipelago configured room watching ${describeTarget(desired.target)} as ${desired.slot}`);
        return desired;
    }

    // Target, slot, password and the DeathLink tag are only read during the connect handshake,
    // so a change to any of them needs a fresh socket. The rest apply to the next batch.
    const needsReconnect =
        JSON.stringify(existing.watch.target) !== JSON.stringify(desired.target) ||
        existing.watch.slot !== desired.slot ||
        (existing.watch.password || null) !== desired.password ||
        !!existing.watch.filters.deaths !== !!desired.filters.deaths;
    const channelChanged = existing.watch.channelId !== desired.channelId;

    const inferChanged = !!existing.watch.inferFinished !== !!desired.inferFinished;
    Object.assign(existing.watch, desired);
    if (channelChanged) existing.channel = null;
    if (inferChanged) {
        if (existing.pollTimer) clearInterval(existing.pollTimer);
        existing.pollTimer = null;
        if (desired.inferFinished) startCompletionPoll(existing);
        else existing.client.fullyChecked = new Set();
    }
    // Both are read at render time, so they apply to the next line without a new socket.
    existing.client.colorize = desired.color;
    existing.client.markers = desired.markers;
    if (needsReconnect) restartWatch(CONFIG_WATCH_ID);
    return existing.watch;
}

// Runs at boot and again whenever an archipelago* setting is saved, so the wizard can point the
// bot at a different room without a restart.
function applyConfig({ boot = false } = {}) {
    if (!config.archipelagoEnabled) {
        if (states.size > 0) {
            for (const id of [...states.keys()]) stopWatch(id);
            states.clear();
            savedWatchesLoaded = false;
            logger.info('Archipelago monitor stopped — archipelagoEnabled is off');
        } else if (boot) {
            logger.debug('Archipelago monitor disabled (config.archipelagoEnabled is false)');
        }
        return;
    }

    if (!savedWatchesLoaded) {
        const store = loadStore();
        for (const watch of store.watches) {
            watch.filters = { ...DEFAULT_FILTERS, ...(watch.filters || {}) };
            // Watches saved before these existed default to on, matching a fresh watch.
            watch.skipGoaled = watch.skipGoaled !== false;
            watch.inferFinished = watch.inferFinished !== false;
            watch.color = watch.color !== false;
            watch.markers = watch.markers !== false;
            startWatch(watch);
        }
        savedWatchesLoaded = true;
        const active = store.watches.filter(w => !w.paused).length;
        logger.info(`Archipelago monitor started — ${active} saved room(s), ${store.watches.length - active} paused`);
    }

    syncConfigWatch();

    const gaps = configGaps();
    if (boot && gaps.length > 0 && states.size === 0) {
        logger.info(`Archipelago monitor idle — /config still needs ${gaps.join(', ')}`);
    }
}

function startArchipelagoMonitor(client) {
    discord = client;
    configStore.onChange((key) => {
        if (typeof key !== 'string' || !key.startsWith('archipelago')) return;
        try {
            applyConfig();
        } catch (err) {
            logger.error('Archipelago monitor could not apply a config change:', err.message || err);
        }
    });
    applyConfig({ boot: true });
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
        skipGoaled: config.archipelagoSkipGoaled !== false,
        inferFinished: config.archipelagoInferFinished !== false,
        color: config.archipelagoColorLines !== false,
        markers: config.archipelagoItemMarkers !== false,
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

// The configured room is rebuilt from config on every change, so editing it here would be
// undone without warning. Point at the place that actually owns it instead.
function refuseIfManaged(state, what) {
    if (state && state.watch.managed) {
        throw new Error(`Watch #${state.watch.id} comes from \`/config\` → Archipelago. Change ${what} there.`);
    }
}

function removeWatch(id) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the room URL or host');
    stopWatch(id);
    states.delete(id);
    persist();
    return state.watch;
}

function setPassword(id, password) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the room password');
    state.watch.password = password || null;
    return restartWatch(id);
}

function setFilter(id, group, enabled) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the category toggles');
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
    refuseIfManaged(state, 'the progression filter');
    state.watch.progressionOnly = !!enabled;
    persist();
    return state;
}

function setSkipGoaled(id, enabled) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the goaled-recipient filter');
    state.watch.skipGoaled = !!enabled;
    persist();
    return state;
}

function setInferFinished(id, enabled) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the tracker inference');
    state.watch.inferFinished = !!enabled;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (enabled) startCompletionPoll(state);
    else state.client.fullyChecked = new Set();
    persist();
    return state;
}

function setColor(id, enabled) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'colour highlighting');
    state.watch.color = !!enabled;
    // Read at render time, so this lands on the next line rather than the next connect.
    state.client.colorize = !!enabled;
    persist();
    return state;
}

function setMarkers(id, enabled) {
    const state = states.get(id);
    if (!state) return null;
    refuseIfManaged(state, 'the item markers');
    state.watch.markers = !!enabled;
    state.client.markers = !!enabled;
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
        players: state.client.players.size,
        finished: state.client.finishedCount
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
        paused: list.filter(entry => entry.watch.paused).length,
        // What the Archipelago page of /config still needs before its room can connect.
        gaps: config.archipelagoEnabled ? configGaps() : []
    };
}

module.exports = {
    startArchipelagoMonitor,
    applyConfig,
    syncConfigWatch,
    configTarget,
    configFilters,
    configGaps,
    CONFIG_WATCH_ID,
    addWatch,
    removeWatch,
    restartWatch,
    setPassword,
    setFilter,
    setProgressionOnly,
    setSkipGoaled,
    setInferFinished,
    setColor,
    setMarkers,
    pollCompletion,
    listWatches,
    getWatch,
    getStatus,
    describeTarget,
    chunkLines,
    formatLine,
    shouldRelay,
    connectionNotice,
    DEFAULT_FILTERS,
    FILTER_GROUPS,
    WATCH_FILE
};
