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
const claims = require('./archipelagoClaims.js');
const goals = require('./archipelagoGoals.js');
const roles = require('./archipelagoRoles.js');
const { ArchipelagoClient, parseTarget, stripAnsi, ITEM_FLAG_PROGRESSION, CATEGORY_GROUPS, DEFAULT_PORT } = require('./archipelagoClient.js');

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
// Pings go in one message per flush. Past a handful the mention is doing the work and the detail
// is not, so the rest collapse into a count.
const MAX_PING_LINES = 8;
const MAX_PENDING_PINGS = 100;
// A ping quotes a line the room composed, outside a code fence, so a player free to name
// themselves `**` can otherwise reformat the message. discord.js owns the escaping rules and
// covers cases a local regex did not, notably code blocks and headers.
const { escapeMarkdown } = require('discord.js');

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
    // The server talking to this connection rather than reporting room activity: the bot's own
    // join broadcast, and the welcome text every client is handed on connect. Both repeat on
    // every reconnect, and a hosted room reconnects every couple of hours.
    if (line.self) return false;

    const filters = watch.filters || DEFAULT_FILTERS;
    if (filters[line.group] === false) return false;
    if (watch.progressionOnly && line.group === 'items' && !(line.flags & ITEM_FLAG_PROGRESSION)) return false;
    // Once a slot has goaled or released, items still arriving for it change nothing. In a long
    // async that is most of the late-game traffic.
    if (watch.skipGoaled && line.group === 'items' && line.recipientFinished) return false;
    return true;
}

/**
 * Is this line worth pinging the slot's claimant about?
 * Runs after shouldRelay, so a line already filtered out of the channel never pings — which is
 * what keeps the skip-goaled and progression-only filters honoured here for free.
 */
function shouldPing(claim, line) {
    if (!claim || claim.pings === 'off') return false;
    // Items only, for now. A Hint packet also names a receiving slot, so hint pings are nearly
    // free — but they want their own toggle rather than riding on this one.
    if (!line || line.group !== 'items') return false;
    if (claim.pings === 'progression') return !!(line.flags & ITEM_FLAG_PROGRESSION);
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

/**
 * @param {string[]} [mentionUsers] user ids allowed to be pinged by this message. Everything
 *   else stays suppressed: `parse: []` blocks every category, and an explicit users list is the
 *   only thing that gets through it.
 */
async function post(state, content, mentionUsers = null) {
    const channel = await resolveChannel(state);
    if (!channel || typeof channel.send !== 'function') return;
    try {
        const allowedMentions = mentionUsers && mentionUsers.length
            ? { parse: [], users: mentionUsers }
            : { parse: [] };
        await channel.send({ content, allowedMentions });
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] post failed:`, err.message);
        state.channel = null;
    }
}

// One message per flush, mentions deduped. Posted after the log block rather than inside it:
// a mention inside a code fence renders as literal text and notifies nobody.
//
// Grouped by claimant rather than by item. The cap used to be applied to events, so a flush
// carrying items for more than MAX_PING_LINES slots rendered only the first few and silently
// dropped the rest — their ids were still in the mention whitelist, but with no `<@id>` in the
// content Discord notified nobody, which is the one thing a claim exists to do. Whoever is past
// the detail cap now still gets a mention on the trailing line.
async function flushPings(state) {
    const pending = state.pings.splice(0, state.pings.length);
    if (pending.length === 0) return;

    const byUser = new Map();
    for (const ping of pending) {
        if (!byUser.has(ping.userId)) byUser.set(ping.userId, []);
        byUser.get(ping.userId).push(ping);
    }

    const lines = [];
    const overflow = [];
    for (const [userId, entries] of byUser) {
        if (lines.length < MAX_PING_LINES) {
            const first = entries[0];
            const more = entries.length > 1 ? ` (+${entries.length - 1} more)` : '';
            lines.push(`<@${userId}> \`${escapeMarkdown(first.slot)}\` — ${first.text}${more}`);
        } else {
            overflow.push(`<@${userId}>`);
        }
    }
    if (overflow.length > 0) lines.push(`…and items for ${overflow.join(' ')}`);

    await post(state, lines.join('\n'), [...byUser.keys()]);
}

async function flush(state) {
    state.timer = null;
    if (state.buffer.length === 0) {
        await flushPings(state);
        return;
    }

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

    await flushPings(state);
}

/**
 * Queue a ping for whoever claimed the slot this line is addressed to.
 * Called after enqueue(), so the flush timer it relies on is already running.
 */
function notePing(state, line) {
    if (typeof line.receiving !== 'number') return;
    const slot = state.client.slotNameFor(line.receiving);
    if (!slot) return;

    const claim = claims.find(state.watch.id, slot);
    if (!shouldPing(claim, line)) return;

    if (state.pings.length >= MAX_PENDING_PINGS) return;
    state.pings.push({
        userId: claim.userId,
        slot,
        text: escapeMarkdown(stripAnsi(line.text)).substring(0, 200)
    });
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
        // Ahead of the relay filter on purpose: a goal still counts towards the tally when the
        // goals category is switched off for this channel.
        if (line.type === 'Goal') syncGoalsAndRoles(state);
        if (!shouldRelay(watch, line)) return;
        enqueue(state, line.text);
        notePing(state, line);
    });

    // Goals that happened before the bot connected arrive here, not on 'connected' — the goal
    // set is empty until the server answers the status Get.
    client.on('statuses', () => syncGoalsAndRoles(state));

    client.on('status', ({ state: phase, detail, expected }) => {
        state.status = phase;
        state.detail = detail;
        if (phase === 'connected') state.connectedAt = Date.now();

        const notice = connectionNotice(state, phase, detail);
        if (phase === 'connected') state.announcedConnected = true;
        if (notice) post(state, notice);

        if (phase === 'connected') {
            logger.info(`[AP:${watch.label}] connected to ${detail} as ${watch.slot}`);
        } else if (phase === 'disconnected' || phase === 'error') {
            // `expected` marks the first attempt against a room URL, which fails while the web
            // host is still starting the room. Routine, so it goes to debug rather than warn.
            const line = `[AP:${watch.label}] ${phase}: ${detail}`;
            if (expected) logger.debug(line);
            else logger.warn(line);
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
        pings: [],
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
    // All of these survive the new socket: the tracker id is fixed for the room's life, and
    // completion read before the reconnect is still true after it.
    state.trackerUrl = existing.trackerUrl;
    state.client.fullyChecked = existing.client.fullyChecked;
    state.client.released = existing.client.released;
    // Slot names too, or a restart silently disables the claim-name check that knowsRoom() gates:
    // until the fresh handshake lands, `!ap claim ZackWordd` would be stored as typed. A restart
    // is exactly when the room may be unreachable, so that window is not short.
    state.client.slotNames = existing.client.slotNames;
    state.client.seedName = existing.client.seedName;
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
            // With no state for id 0, listClaims(0) answers null and `!ap claims` / `!ap unclaim`
            // report "No watch with ID 0", so claims left here would be unreachable from the
            // command surface and would attach to whatever room /config names next.
            const dropped = claims.releaseWatch(CONFIG_WATCH_ID);
            logger.info('Archipelago configured room cleared — its settings are no longer complete' +
                (dropped > 0 ? `, ${dropped} slot claim(s) released with it` : ''));
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
    const roomChanged = JSON.stringify(existing.watch.target) !== JSON.stringify(desired.target);
    const needsReconnect =
        roomChanged ||
        existing.watch.slot !== desired.slot ||
        (existing.watch.password || null) !== desired.password ||
        !!existing.watch.filters.deaths !== !!desired.filters.deaths;
    const channelChanged = existing.watch.channelId !== desired.channelId;

    // The configured room keeps id 0 across a re-point, so its claims would otherwise be
    // inherited by whatever multiworld /config now names: a slot present in both rooms would ping
    // the person who claimed it in the old one, and credit them the new seed's goal for it.
    // removeWatch cannot cover this, because refuseIfManaged rejects the managed watch.
    // A slot or password change is the same room, so only the target is grounds for dropping.
    if (roomChanged) {
        const dropped = claims.releaseWatch(CONFIG_WATCH_ID);
        if (dropped > 0) {
            logger.info(`Archipelago configured room re-pointed — ${dropped} slot claim(s) released with the old room`);
        }
    }

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
    // Captured before the claims go, so the participant role can be taken off anyone this leaves
    // holding nothing. Without it their role outlived every claim they had.
    const affected = new Set(claims.forWatch(id).map(c => c.userId));
    stopWatch(id);
    states.delete(id);
    // Claims are keyed by watch id, and ids are handed out from a counter that can reach this
    // one again. Dropping them here stops a future watch inheriting the last one's pings.
    const releasedClaims = claims.releaseWatch(id);
    if (affected.size > 0) {
        // The state is gone, so the role sync borrows this one purely for its channel and guild.
        syncRoles(state, affected).catch(err =>
            logger.warn(`[AP:${state.watch.label}] role sync after unwatch failed: ${err.message || err}`));
    }
    persist();
    return { ...state.watch, releasedClaims };
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

// --- goals and roles ----------------------------------------------------------------------

/**
 * Record every goal the room reports for a slot somebody has claimed.
 *
 * Reads `client.goaled` and nothing else. A release hands out the slot's remaining items without
 * anyone finishing it, and a fully-checked slot can still be waiting on an item to goal, so
 * neither belongs in a tally of games completed — even though hasFinished() folds all three
 * together for the relay filter, which is a different question.
 *
 * @returns {Set<string>} the users whose tally actually changed
 */
function goalIdentity(state) {
    // RoomInfo.seed_name, which every server sends and which is fixed for the multiworld's life.
    if (state.client.seedName) return state.client.seedName;
    // Without it, a room URL is still fixed for the room's life and safe to key on.
    const target = state.watch.target;
    if (target && target.kind === 'room') return target.roomUrl;
    // A bare host:port is not safe: a hosted room takes a new port on every spin-up, so the same
    // goal would be filed under a new key after a restart and counted a second time. Recording
    // nothing beats recording it twice.
    return null;
}

function recordGoals(state) {
    const client = state.client;
    const changed = new Set();

    const identity = goalIdentity(state);
    if (!identity) {
        if (!state.warnedNoSeed) {
            state.warnedNoSeed = true;
            logger.warn(`[AP:${state.watch.label}] no seed name and no room URL — goals are not being counted ` +
                `for this watch, because a moving host:port cannot be told apart from a new game.`);
        }
        return changed;
    }

    for (const id of client.goaled) {
        const [team, slotId] = String(id).split(':').map(Number);
        // The goal set carries every team the server reports, and a slot number means a different
        // player on each of them. A claim has no team, so only this connection's team can be
        // attributed with any confidence; crediting another team's goal to the claimant who
        // happens to share a slot number is worse than not counting it.
        if (team !== client.team) continue;

        const slotName = client.slotNameFor(slotId, team);
        if (!slotName) continue;

        const claim = claims.find(state.watch.id, slotName);
        if (!claim) continue;

        const key = goals.goalKey(identity, slotName);
        if (goals.record(claim.userId, key, { slot: slotName, watchId: state.watch.id })) {
            changed.add(claim.userId);
            logger.info(`[AP:${state.watch.label}] ${slotName} goaled — that is ${goals.countFor(claim.userId)} for ${claim.userId}`);
        }
    }
    return changed;
}

/** Bring Discord roles in line for a set of users. Never throws into the relay. */
async function syncRoles(state, userIds) {
    if (!config.archipelagoRolesEnabled) return;
    if (!userIds || userIds.size === 0) return;

    const channel = await resolveChannel(state);
    const guild = channel && channel.guild;
    if (!guild) return;

    const memberRoleName = String(config.archipelagoRoleName || '').trim() || 'Archipelago';
    for (const userId of userIds) {
        try {
            await roles.syncMember(guild, userId, {
                // Any claim anywhere keeps the participant role: a watch is not guild-scoped and
                // the configured room has no guild id of its own to compare against.
                claimed: claims.all().some(c => c.userId === userId),
                goals: goals.countFor(userId),
                memberRoleName
            });
        } catch (err) {
            logger.warn(`[AP:${state.watch.label}] role sync failed for ${userId}: ${err.message}`);
        }
    }

    try {
        await roles.sweepCounts(guild, goals.leaderboard().map(row => row.count));
    } catch (err) {
        logger.debug(`[AP:${state.watch.label}] role sweep failed: ${err.message}`);
    }
}

/** Record goals, then update whoever that moved. Fire and forget; role work is never blocking. */
function syncGoalsAndRoles(state, alsoSync = null) {
    const changed = recordGoals(state);
    if (alsoSync) changed.add(alsoSync);
    if (changed.size === 0) return;
    syncRoles(state, changed).catch(err =>
        logger.error(`[AP:${state.watch.label}] role sync threw:`, err.message || err));
}

// --- slot claims ------------------------------------------------------------------------
//
// Claims are not part of the /config-managed settings, so the configured room accepts them like
// any other watch — refuseIfManaged deliberately does not apply here.

/** Has this watch ever read the room? Slot names survive a disconnect, so this is not "connected". */
function knowsRoom(state) {
    return !!state && state.client.slotNames.size > 0;
}

/**
 * Claim a slot for a Discord user.
 * @returns {{claim: Object, verified: boolean}|null} null if there is no such watch. `verified`
 *   is false when the room has not been read yet and the name had to be taken on trust.
 */
function claimSlot(id, slot, userId) {
    const state = states.get(id);
    if (!state) return null;

    const canonical = state.client.canonicalSlotName(slot);
    if (!canonical && knowsRoom(state)) {
        throw new Error(`\`${String(slot).trim()}\` isn't a slot in this multiworld.`);
    }

    const claim = claims.claim({ watchId: id, slot: canonical || String(slot).trim(), userId });
    // Picks up any goal the room already reports for the slot just claimed, then grants the
    // participant role and whatever count role that leaves them on.
    syncGoalsAndRoles(state, userId);
    return { claim, verified: !!canonical };
}

function releaseSlot(id, slot) {
    const state = states.get(id);
    if (!state) return null;
    const removed = claims.release(id, slot);
    // The participant role follows the last claim out. The count role is a lifetime tally and
    // deliberately stays.
    if (removed) syncRoles(state, new Set([removed.userId])).catch(() => {});
    return removed;
}

function setClaimPings(id, slot, mode) {
    if (!states.has(id)) return null;
    return claims.setPings(id, slot, mode);
}

function listClaims(id) {
    if (!states.has(id)) return null;
    return claims.forWatch(id);
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
    claimSlot,
    releaseSlot,
    setClaimPings,
    listClaims,
    recordGoals,
    goalIdentity,
    syncRoles,
    syncGoalsAndRoles,
    pollCompletion,
    listWatches,
    getWatch,
    getStatus,
    describeTarget,
    chunkLines,
    formatLine,
    shouldRelay,
    shouldPing,
    connectionNotice,
    DEFAULT_FILTERS,
    FILTER_GROUPS,
    WATCH_FILE
};
