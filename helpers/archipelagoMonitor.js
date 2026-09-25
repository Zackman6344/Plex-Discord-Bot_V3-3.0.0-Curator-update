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
const hintStore = require('./archipelagoHints.js');
const spheres = require('./archipelagoSpheres.js');
// HintStatus 30. Anything else is either unremarkable or already found.
const HINT_PRIORITY = 30;
const claims = require('./archipelagoClaims.js');
const goals = require('./archipelagoGoals.js');
const roles = require('./archipelagoRoles.js');
const catchup = require('./archipelagoCatchup.js');
const { ArchipelagoClient, parseTarget, stripAnsi, ITEM_FLAG_PROGRESSION, CATEGORY_GROUPS, DEFAULT_PORT } = require('./archipelagoClient.js');

// Overridable so a test run can point at its own file, and so the store can be relocated.
const WATCH_FILE = process.env.PLEXBOT_AP_WATCHES_FILE || path.join(__dirname, '..', 'data', 'archipelago_watches.json');
// Under the test runner that override is required rather than optional, the same gate
// commandLog.js and tagSidecar.js use. The real file holds a room password, and a test run has
// no business reading or rewriting it.
const usable = !process.env.NODE_TEST_CONTEXT || !!process.env.PLEXBOT_AP_WATCHES_FILE;
// Overridable so the tests can use a flush window shorter than the one second a user can set.
const relayTiming = { minFlushMs: 1000 };
// Read per flush rather than captured at load, so the /config wizard's change to
// archipelagoBatchSeconds applies to the next batch instead of the next boot.
function flushDelayMs() {
    return Math.max(relayTiming.minFlushMs, (Number(config.archipelagoBatchSeconds) || 5) * 1000);
}
// 1900 leaves room for the ``` fences inside Discord's 2000-character message limit.
const MAX_CHUNK = 1900;
// Pings are chunked to the message limit, like the log relay. 1900 leaves room for nothing in
// particular here, but keeps the two paths using the same budget.
const MAX_PING_CHARS = 1900;
const MAX_PING_MESSAGES = 2;
// A ping quotes a line the room composed, outside a code fence, so a player free to name
// themselves `**` can otherwise reformat the message. discord.js owns the escaping rules and
// covers cases a local regex did not, notably code blocks and headers.
const { escapeMarkdown } = require('discord.js');

const DEFAULT_FILTERS = { items: true, hints: true, chat: true, joins: true, goals: true, misc: true, deaths: false };
const FILTER_GROUPS = Object.keys(CATEGORY_GROUPS);
// The room described by config/config.js gets a reserved id. It is rebuilt from config rather
// than stored in the watch file, so `!ap watch` rooms number from 1 and never collide with it.
const CONFIG_WATCH_ID = 0;

// Overridable so the tests can run a catch-up without waiting minutes. settleMs is the room
// tracker's worst-case lag behind the socket: the room saves at most once a minute and the API
// caches each answer for another minute, plus 10 s of margin.
const catchupTiming = { settleMs: 130000, retryMs: 30000, loadingRetryMs: 10000 };
// Six tries ten seconds apart give a slow room a minute to answer the goal and hint read that
// follows each connect. Past that the periodic run picks it up.
const MAX_LOADING_RETRIES = 6;
// discord.js already retries rate limits and server errors itself, so a send that still fails is
// a refusal, and one that repeats for the same line (AutoMod matching an item name) repeats
// forever. Past this many, the line is recorded as reported and the log says it was skipped.
const MAX_REFUSALS = 3;

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
        if (err.code !== 'ENOENT') quarantineWatchFile(err.message);
        return { nextId: 1, watches: [] };
    }
}

// This file holds a room password and is the only copy of every `!ap watch` room, but it is the
// one Archipelago store that never moved onto jsonStore.js, so it had neither of that module's
// two rules. It gets both here rather than a migration, because its `{nextId, watches}` envelope
// does not fit createStore's single-key shape and a format change is not worth the risk.
//
// Rule one: a file that cannot be read is moved aside instead of being silently replaced. A kill
// during the old bare writeFileSync truncated it, the next boot read zero watches, and the first
// persist() after that wrote the empty store straight over it.
let watchWritesBlocked = false;

function quarantineWatchFile(why) {
    const aside = `${WATCH_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        fs.renameSync(WATCH_FILE, aside);
        logger.error(`Archipelago watch file unusable (${why}) — moved to ${aside} and starting ` +
            `with no saved rooms. Any room password is still in that file.`);
    } catch (renameErr) {
        logger.error(`Archipelago watch file unusable (${why}) and could not be moved aside ` +
            `(${renameErr.message}). Refusing to overwrite ${WATCH_FILE}; fix it by hand.`);
        watchWritesBlocked = true;
    }
}

// Rule two: writes go to a sibling `.tmp` and rename over the target, so a kill between the
// truncate and the write cannot leave a half-file behind.
function saveStore(store) {
    if (!usable) return;
    if (watchWritesBlocked) {
        logger.error(`Not writing Archipelago watches: ${WATCH_FILE} is damaged and could not be ` +
            `moved aside, so overwriting it would destroy the only copy.`);
        return;
    }
    try {
        fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
        const tmp = `${WATCH_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(store, null, 4));
        fs.renameSync(tmp, WATCH_FILE);
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

/**
 * Pack entries into messages of at most `max` characters, keeping each message's entries with it
 * so a successful send can record exactly the lines it carried.
 * @param {Array<{text: string}>} entries
 * @returns {Array<{text: string, entries: Array}>}
 */
function chunkEntries(entries, max = MAX_CHUNK) {
    const chunks = [];
    let current = null;
    for (const entry of entries) {
        const raw = String(entry.text);
        const line = raw.length > max ? `${raw.substring(0, max - 1)}…` : raw;
        if (!current || !current.text) {
            current = { text: line, entries: current ? [...current.entries, entry] : [entry] };
        } else if (current.text.length + 1 + line.length > max) {
            chunks.push(current);
            current = { text: line, entries: [entry] };
        } else {
            current.text += `\n${line}`;
            current.entries.push(entry);
        }
    }
    if (current && current.text) chunks.push(current);
    return chunks;
}

/**
 * chunkEntries, except that an entry Discord has refused before goes in a message of its own.
 * A refusal aimed at one line (AutoMod matching an item name) takes down every line packed with
 * it, and a retry that packed them the same way would fail them all again.
 * @param {Array<{text: string, key?: string, seed?: string}>} entries
 * @param {Map<string, number>} refusals keyed by owedTag
 */
function chunkForRetry(entries, refusals, max = MAX_CHUNK) {
    const chunks = [];
    let run = [];
    for (const entry of entries) {
        if (entry.key && refusals.has(owedTag(entry.seed, entry.key))) {
            chunks.push(...chunkEntries(run, max), ...chunkEntries([entry], max));
            run = [];
        } else {
            run.push(entry);
        }
    }
    chunks.push(...chunkEntries(run, max));
    return chunks;
}

function chunkLines(lines, max = MAX_CHUNK) {
    return chunkEntries(lines.map(text => ({ text })), max).map(chunk => chunk.text);
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
 * Send one message to the watch's channel.
 * Only ever called from inside a serial task (see runSerial), so nothing a watch posts can land
 * between the blocks of another burst.
 * @param {string[]} [mentionUsers] user ids allowed to be pinged by this message. Everything
 *   else stays suppressed: `parse: []` blocks every category, and an explicit users list is the
 *   only thing that gets through it.
 * @returns {Promise<boolean>} whether Discord accepted it. Lines are recorded as reported only
 *   on true, which is what lets a catch-up repost whatever a failed send lost.
 */
async function send(state, content, mentionUsers = null) {
    const channel = await resolveChannel(state);
    if (!channel || typeof channel.send !== 'function') return false;
    try {
        const allowedMentions = mentionUsers && mentionUsers.length
            ? { parse: [], users: mentionUsers }
            : { parse: [] };
        await channel.send({ content, allowedMentions });
        return true;
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] post failed:`, err.message);
        state.channel = null;
        return false;
    }
}

// --- the per-watch pipeline ---------------------------------------------------------------
//
// One promise chain per watch id, and every post for that watch runs on it as a task: a flush,
// a catch-up, the connection and refusal notices, hint pings. Two flushes used to interleave
// (reproduced: a second burst's block landed between the first burst's blocks once one flush
// took longer than the batch window), and a relay with no message cap makes long flushes routine.
//
// Keyed by watch id rather than held on the state, because restartWatch replaces the state. Old
// and new states each had their own chain, so a flush still sending on the old one ran alongside
// the new state's catch-up and both posted the same lines. The buffer lives here for the same
// reason, which also stops a restart throwing away chat and joins that were waiting to post.
const pipelines = new Map();

function pipelineFor(id) {
    let pipeline = pipelines.get(id);
    if (!pipeline) {
        pipeline = { chain: Promise.resolve(), buffer: [], timer: null, flight: null, refusals: new Map(), owed: new Set() };
        pipelines.set(id, pipeline);
    }
    return pipeline;
}

// Only when the user asked for the watch to stop. Every task compares its pipeline with the map
// before each send, so a flood already under way ends at its next message.
function dropPipeline(id) {
    const pipeline = pipelines.get(id);
    if (!pipeline) return;
    if (pipeline.timer) clearTimeout(pipeline.timer);
    pipeline.timer = null;
    pipeline.buffer.length = 0;
    pipelines.delete(id);
}

/**
 * Queue a task behind everything already on this watch's chain.
 * @returns {Promise<*>} the task's result, or undefined if it threw (the error is logged)
 */
function runSerial(pipeline, fn, label = '?', what = 'task') {
    pipeline.chain = pipeline.chain.then(fn).catch((err) => {
        logger.error(`[AP:${label}] ${what} threw:`, (err && err.message) || err);
        return undefined;
    });
    return pipeline.chain;
}

function isCurrent(state) {
    const id = state.watch.id;
    return pipelines.get(id) === state.pipeline && states.get(id) === state;
}

/** A send for a task tied to one state: a notice or a hint ping from a replaced state is stale. */
async function sendIfCurrent(state, content, mentionUsers = null) {
    if (!isCurrent(state)) return false;
    return send(state, content, mentionUsers);
}

/** Slots finished on this connection's team, for the record's skip-goaled snapshot. */
function finishedSlots(client) {
    const prefix = `${client.team}:`;
    const out = new Set();
    for (const id of [...client.goaled, ...client.released, ...client.fullyChecked]) {
        if (String(id).startsWith(prefix)) out.add(Number(String(id).slice(prefix.length)));
    }
    return out;
}

/**
 * Add whatever has finished since to the record's skip-goaled snapshot. Committed only: the next
 * persist or the exit hook writes it, so a goal or a status read costs no write of its own.
 */
function noteFinished(state) {
    const seed = state.client.seedName;
    // Only while connected. A tracker poll during a socket outage would otherwise add a slot that
    // finished inside the outage, and that outage's catch-up would then hide the items it was sent
    // before it finished.
    if (!seed || state.status !== 'connected' || !isCurrent(state)) return;
    catchup.commit(state.watch.id, seed, [], { finished: finishedSlots(state.client) });
}

/**
 * The catch-up identity of a live line, or null for a line the tracker cannot rebuild (chat,
 * joins, deaths, cheats, the bot's own presence).
 */
function lineKey(client, line) {
    const packet = line && line.packet;
    if (!packet || line.self) return null;
    if (line.type === 'ItemSend' && packet.item) {
        const location = Number(packet.item.location);
        return location > 0 ? catchup.itemKey(packet.item.player, location) : null;
    }
    if (line.type === 'Goal' && typeof packet.slot === 'number') {
        return (packet.team || 0) === client.team ? catchup.goalKey(packet.slot) : null;
    }
    if (line.type === 'Hint' && packet.item && typeof packet.item.location === 'number') {
        return catchup.hintKey(packet.item.player, packet.item.location);
    }
    return null;
}

/** Record the keys of entries Discord accepted, each against the room it arrived from. */
function commitPosted(id, client, entries) {
    const postedAt = new Date().toISOString();
    const bySeed = new Map();
    for (const entry of entries) {
        if (!entry.seed) continue;
        if (!bySeed.has(entry.seed)) bySeed.set(entry.seed, []);
        if (entry.key) bySeed.get(entry.seed).push(entry.key);
    }
    for (const [seed, keys] of bySeed) {
        catchup.commit(id, seed, keys, {
            postedAt,
            finished: seed === client.seedName ? finishedSlots(client) : undefined
        });
    }
}

// Mentions deduped and posted after the log block rather than inside it: a mention inside a code
// fence renders as literal text and notifies nobody.
//
// Packed to the message limit and sent as however many messages that takes, using the same
// chunker the log relay uses. A single message assembled without a length bound is rejected
// outright once it passes 2000 characters, and on a busy flush NOBODY was notified.
async function sendPingLines(state, pipeline, pings) {
    if (pings.length === 0) return;
    const id = state.watch.id;
    const chunks = chunkLines(pings.map(p => p.line), MAX_PING_CHARS);
    const sendNow = chunks.slice(0, MAX_PING_MESSAGES);
    const everyone = [...new Set(pings.map(p => p.userId))];

    for (const chunk of sendNow) {
        if (pipelines.get(id) !== pipeline) return;
        await send(state, chunk, everyone.filter(uid => chunk.includes(`<@${uid}>`)));
    }

    // Anyone whose line did not make the cut still needs a mention, or their claim did nothing
    // at all. Their ids being in allowedMentions is not enough: with no `<@id>` in the content
    // Discord notifies nobody.
    const missed = everyone.filter(uid => !sendNow.some(chunk => chunk.includes(`<@${uid}>`)));
    if (missed.length > 0 && pipelines.get(id) === pipeline) {
        await send(state, `…and more items for ${missed.map(uid => `<@${uid}>`).join(' ')}`, missed);
    }
}

/**
 * Post everything buffered for a watch, as one task.
 *
 * The buffer is taken when the task STARTS, not when its timer fired, so lines that arrived while
 * an earlier task was sending go out in this one instead of in a task of their own. There is no
 * message cap: the user wants every line, and discord.js paces the sends to the channel limit.
 */
async function flushTask(id, pipeline) {
    if (pipelines.get(id) !== pipeline) return;
    const state = states.get(id);
    if (!state || pipeline.buffer.length === 0) return;

    // Checked again here as well as on arrival: a catch-up that ran while these waited may have
    // posted the same send from the tracker.
    const entries = pipeline.buffer.splice(0, pipeline.buffer.length)
        .filter(e => !(e.dedupe && e.key && e.seed && catchup.has(id, e.seed, e.key)));
    if (entries.length === 0) return;

    if (!(await resolveChannel(state))) {
        noteOwed(pipeline, entries);
        noteCatchupFailure(state, 'could not post to the channel');
        retryRefusedPost(id);
        return;
    }

    // An ```ansi fence is what makes Discord honour the colour codes; a plain fence would show
    // them as literal escape text.
    const fence = state.watch.color ? 'ansi' : '';
    const sent = [];
    let failed = false;
    for (const chunk of chunkEntries(entries)) {
        if (pipelines.get(id) !== pipeline) return;
        const ok = await send(state, `\`\`\`${fence}\n${chunk.text}\n\`\`\``);
        // Removed while that send was in flight. Its records are already forgotten, and writing
        // this chunk's keys would bring them back under a watch id that can be handed out again.
        if (pipelines.get(id) !== pipeline) return;
        if (!ok) {
            // Carry on with the rest: the chat and joins in later chunks cannot be rebuilt by a
            // catch-up, and the keyed lines in this one can.
            failed = true;
            noteRefused(pipeline, chunk.entries);
            continue;
        }
        const owner = states.get(id) || state;
        owner.lineCount += chunk.entries.length;
        commitPosted(id, owner.client, chunk.entries);
        catchup.persist();
        noteAccepted(pipeline, chunk.entries);
        sent.push(...chunk.entries);
    }
    const current = states.get(id) || state;
    if (failed) {
        noteCatchupFailure(current, 'could not post to the channel');
        retryRefusedPost(id);
    } else if (pipeline.owed.size === 0) {
        current.postFailures = 0;
    }

    // Only for lines that actually posted, so a ping never arrives before its own line.
    await sendPingLines(state, pipeline, sent.filter(e => e.ping).map(e => e.ping));
    catchup.persist();
}

/**
 * The ping this line earns its slot's claimant, or null.
 * One line per item, so somebody holding several slots still sees which of them moved.
 */
function pingFor(state, line) {
    if (typeof line.receiving !== 'number') return null;
    const slot = state.client.slotNameFor(line.receiving);
    if (!slot) return null;

    const claim = claims.find(state.watch.id, slot);
    if (!shouldPing(claim, line)) return null;
    const text = escapeMarkdown(stripAnsi(line.text)).substring(0, 200);
    return { userId: claim.userId, line: `<@${claim.userId}> \`${slot.replace(/`/g, "'")}\` — ${text}` };
}

function enqueue(state, entry) {
    const pipeline = state.pipeline;
    const id = state.watch.id;
    const label = state.watch.label;
    pipeline.buffer.push(entry);
    if (!pipeline.timer) {
        pipeline.timer = setTimeout(() => {
            pipeline.timer = null;
            runSerial(pipeline, () => flushTask(id, pipeline), label, 'flush');
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

/**
 * Tell a claimant when somebody hints an item out of their world.
 *
 * The finder is pinged, not the receiver. A hint says "this item is in your world and I want
 * it", so the person who can act on it is whoever has to go and check that location. The
 * receiver already knows: they placed the hint.
 *
 * Off for everyone until they say otherwise. Opting in is per claim, `off`/`dm`/`channel`.
 */
async function announceHints(state) {
    // Queued behind whatever was sending, so a restart can land first. Recording the hint now would
    // leave the replacement state, whose own 'hints' event replays it, nothing fresh to announce.
    if (!isCurrent(state)) return;
    const client = state.client;
    const seed = client.seedName || describeTarget(state.watch.target);
    const outstanding = client.outstandingHints();
    const keyOf = h => hintStore.hintKey(seed, h.team, h.finding_player, h.location);

    // First sight of this multiworld: record the lot without telling anyone. The room this was
    // built against had 45 outstanding hints, 20 of them against one slot, and announcing on
    // discovery would have opened with twenty pings of backlog.
    if (!hintStore.isSeeded(seed)) {
        const ok = hintStore.seedBaseline(seed, outstanding.map(keyOf));
        logger.info(`[AP:${state.watch.label}] hint baseline ${ok ? 'seeded' : 'FAILED to seed'} ` +
            `with ${outstanding.length} outstanding hint(s); announcements start from here`);
        return;
    }

    // Every connect replays the whole list, so only keys never recorded before are news. A
    // failed write returns nothing rather than risk announcing a hint twice.
    const fresh = hintStore.recordAll(outstanding.map(keyOf));
    if (fresh.length === 0) return;

    const byKey = new Map(outstanding.map(h => [keyOf(h), h]));
    for (const key of fresh) {
        const hint = byKey.get(key);
        if (!hint) continue;

        const slot = client.slotNameFor(hint.finding_player, hint.team);
        if (!slot) continue;
        const claim = claims.find(state.watch.id, slot);
        const mode = claims.hintPingMode(claim);
        if (!claim || mode === 'off') continue;

        const tables = client.lookupTables();
        const item = tables.itemName(tables.gameForSlot(hint.receiving_player), hint.item) || `Item#${hint.item}`;
        const where = tables.locationName(tables.gameForSlot(hint.finding_player), hint.location) || `Location#${hint.location}`;
        const asker = tables.playerName(hint.receiving_player) || `Player#${hint.receiving_player}`;
        const priority = hint.status === HINT_PRIORITY ? ' **(priority)**' : '';

        const body = `🔎 \`${escapeMarkdown(String(asker))}\` is waiting on ` +
            `**${escapeMarkdown(item)}** from your world \`${slot.replace(/`/g, "'")}\` ` +
            `— it is at ${escapeMarkdown(where)}${priority}.`;

        if (mode === 'dm') await dmClaimant(state, claim.userId, body);
        else await sendIfCurrent(state, `<@${claim.userId}> ${body}`, [claim.userId]);
    }
}

/**
 * A hint ping the claimant asked to receive privately.
 * Falls back to nothing rather than to the channel: someone who chose `dm` chose it to keep this
 * out of the channel, and a closed-DM fallback would defeat the setting they picked.
 */
async function dmClaimant(state, userId, body) {
    if (!discord) return;
    try {
        const user = await discord.users.fetch(userId);
        await user.send({ content: body, allowedMentions: { parse: [] } });
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] could not DM ${userId} about a hint:`, err.message);
    }
}

function attach(state) {
    const { client, watch } = state;

    client.on('line', (line) => {
        // Ahead of the relay filter on purpose: a goal still counts towards the tally when the
        // goals category is switched off for this channel.
        if (line.type === 'Goal') syncGoalsAndRoles(state);
        if (line.type === 'Goal' || line.type === 'Release') noteFinished(state);

        const seed = client.seedName || null;
        const key = seed ? lineKey(client, line) : null;
        // A send or goal a catch-up already posted from the tracker. Hint lines are exempt: the
        // server re-sends a hint whenever somebody asks for it again, and live relays each one.
        const dedupe = line.type === 'ItemSend' || line.type === 'Goal';
        if (key && dedupe && catchup.has(watch.id, seed, key)) return;

        if (!shouldRelay(watch, line)) {
            // Recorded now, so switching the filter off later does not make a catch-up dump every
            // line it hid.
            if (key) {
                catchup.commit(watch.id, seed, [key]);
                noteFinished(state);
            }
            return;
        }
        enqueue(state, { text: formatLine(line.text), key, seed, dedupe, ping: pingFor(state, line) });
    });

    // Goals that happened before the bot connected arrive here, not on 'connected' — the goal
    // set is empty until the server answers the status Get.
    client.on('statuses', () => {
        syncGoalsAndRoles(state);
        noteFinished(state);
    });

    client.on('hints', () => {
        runSerial(state.pipeline, () => announceHints(state), watch.label, 'hint announce');
    });

    client.on('status', ({ state: phase, detail, expected }) => {
        state.status = phase;
        state.detail = detail;
        if (phase === 'connected') {
            state.connectedAt = Date.now();
            snapshotGap(state);
            state.loadingRetries = 0;
            scheduleSettledCatchUp(state, catchupTiming.settleMs);
        }

        const notice = connectionNotice(state, phase, detail);
        if (phase === 'connected') state.announcedConnected = true;
        if (notice) runSerial(state.pipeline, () => sendIfCurrent(state, notice), watch.label, 'notice');

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
        // A refusal stops the socket but nothing here called stopWatch, so the completion poll
        // kept running for the life of the process — and with trackerUrl still null it re-fetched
        // the room page each time, which is the request that wakes a sleeping hosted room.
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
        // The catch-up poll has the same failure mode: it re-reads the room page until trackerUrl
        // is known.
        clearCatchupTimers(state);
        persist();
        logger.error(`[AP:${watch.label}] connection refused: ${reason}`);
        const notice = `🔴 **${watch.label}** — the server refused the connection (\`${reason}\`). ` +
            `Watch paused; fix it and run \`${config.commandPrefix}ap retry ${watch.id}\`.`;
        runSerial(state.pipeline, () => sendIfCurrent(state, notice), watch.label, 'refusal notice');
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
        pipeline: pipelineFor(watch.id),
        pollTimer: null,
        trackerUrl: null,
        status: 'idle',
        detail: null,
        connectedAt: null,
        // Lines Discord accepted, live and caught up.
        lineCount: 0,
        announcedConnected: false,
        connectTimer: null,
        retryTimer: null,
        catchupPoll: null,
        loadingRetries: 0,
        gapSince: null,
        gapFinished: new Set(),
        gapHeaderUsed: false,
        // Refused posts since the last one Discord accepted, for the retry's backoff.
        postFailures: 0,
        // The next automatic run posts even with archipelagoCatchup off: it is retrying lines a
        // refused send already tried to post.
        forceNext: false,
        // Epoch ms throughout, for `!ap list`.
        catchupStatus: { lastRunAt: null, lastPosted: 0, lastError: null, failingSince: null }
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
        noteFinished(state);
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

// --- room log catch-up --------------------------------------------------------------------
//
// After a reconnect, a restart, or a failed send, the lines the channel missed are rebuilt from
// the room's tracker and posted (see helpers/archipelagoCatchup.js for what can be rebuilt).

// Unref'd so a watch left running by a test, or by a shutdown that skips stopWatch, cannot hold
// the process open for the two minutes a settle timer waits.
function later(fn, ms) {
    const timer = setTimeout(fn, Math.max(0, ms));
    if (timer.unref) timer.unref();
    return timer;
}

function isRoomWatch(watch) {
    return !!(watch && watch.target && watch.target.kind === 'room');
}

function clearCatchupTimers(state) {
    if (state.connectTimer) clearTimeout(state.connectTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    if (state.catchupPoll) clearInterval(state.catchupPoll);
    state.connectTimer = null;
    state.retryTimer = null;
    state.catchupPoll = null;
}

/**
 * Run an automatic catch-up for this state, if it is still the watch's current one, and act on a
 * "not yet" answer.
 */
function autoCatchUp(state, { settled = false } = {}) {
    const id = state.watch.id;
    if (states.get(id) !== state) return;
    // A tracker read this soon after connecting can predate lines the room already has, and the
    // run scheduled for the end of the settle window follows anyway.
    if (!settled && state.connectedAt && Date.now() < state.connectedAt + catchupTiming.settleMs) return;
    const force = state.forceNext;
    state.forceNext = false;
    catchUp(id, { force }).then((result) => {
        if (force && !(result && result.ok)) {
            const current = states.get(id);
            if (current) current.forceNext = true;
        }
        if (states.get(id) !== state || !result) return;
        if (result.ok) {
            // A timer can fire a millisecond early, and this run was the settled one.
            if (result.settlingUntil) scheduleSettledCatchUp(state, result.settlingUntil - Date.now());
            return;
        }
        if (result.reason === 'loading' && state.loadingRetries < MAX_LOADING_RETRIES) {
            state.loadingRetries++;
            scheduleCatchupRetry(id, catchupTiming.loadingRetryMs, { force });
        } else if (result.reason === 'settling') {
            scheduleSettledCatchUp(state, result.at - Date.now());
        }
    }).catch(err => logger.error(`[AP:${state.watch.label}] catch-up threw:`, err.message || err));
}

function scheduleSettledCatchUp(state, delayMs) {
    if (state.connectTimer) clearTimeout(state.connectTimer);
    state.connectTimer = null;
    if (!isRoomWatch(state.watch)) return;
    state.connectTimer = later(() => {
        state.connectTimer = null;
        autoCatchUp(state, { settled: true });
    }, delayMs);
}

/**
 * One catch-up soon, coalesced with any already pending. For failed sends and slow room reads.
 * @param {Object} [options]
 * @param {boolean} [options.force] post even with archipelagoCatchup off; also upgrades a retry
 *   that is already pending
 */
function scheduleCatchupRetry(id, delayMs = catchupTiming.retryMs, { force = false } = {}) {
    const state = states.get(id);
    if (!state || state.watch.paused || !isRoomWatch(state.watch)) return;
    if (force) state.forceNext = true;
    if (state.retryTimer) return;
    state.retryTimer = later(() => {
        state.retryTimer = null;
        autoCatchUp(state);
    }, delayMs);
}

// Keys carry no seed, and a pipeline outlives a /config re-point, so the room is part of the tag:
// another seed of the same game reuses the same location ids.
function owedTag(seed, key) {
    return `${seed}\u0000${key}`;
}

// Lines that were due in the channel and did not get there. The tracker can take two minutes to
// show one, so a retry 30 seconds after the refusal can find nothing; the line stays owed and is
// retried again rather than waiting for the poll, and with archipelagoCatchup off an unforced run
// posts it instead of recording it silently.
function noteOwed(pipeline, entries) {
    for (const entry of entries) {
        if (entry.key && entry.seed) pipeline.owed.add(owedTag(entry.seed, entry.key));
    }
}

// Counted per line rather than per message, because a retry repacks the lines into new messages.
function noteRefused(pipeline, entries) {
    noteOwed(pipeline, entries);
    for (const entry of entries) {
        if (!entry.key || !entry.seed) continue;
        const tag = owedTag(entry.seed, entry.key);
        pipeline.refusals.set(tag, (pipeline.refusals.get(tag) || 0) + 1);
    }
}

function noteAccepted(pipeline, entries) {
    for (const entry of entries) {
        if (!entry.key || !entry.seed) continue;
        const tag = owedTag(entry.seed, entry.key);
        pipeline.refusals.delete(tag);
        pipeline.owed.delete(tag);
    }
}

/**
 * Drop owed lines that have since been recorded, however that happened, and retry if any of this
 * room's are still outstanding.
 * @returns {boolean} whether a retry was scheduled
 */
function settleOwed(id, pipeline, seed) {
    let outstanding = false;
    const prefix = `${seed}\u0000`;
    for (const tag of pipeline.owed) {
        // Owed to a room this watch no longer follows. Its tracker is not the one being read.
        if (!tag.startsWith(prefix)) pipeline.owed.delete(tag);
        else if (catchup.has(id, seed, tag.slice(prefix.length))) pipeline.owed.delete(tag);
        else outstanding = true;
    }
    if (outstanding) retryRefusedPost(id);
    return outstanding;
}

// Doubles with each attempt that ends with something refused, up to the tracker poll interval.
// A channel the bot has lost refuses every retry, and each retry downloads the whole tracker; at a
// flat 30 seconds that was about 2,880 downloads a day per watch. Only an attempt that posts
// everything resets it: a channel that accepts the header but refuses one block (AutoMod matching
// an item name) otherwise stayed at 30 seconds and posted a fresh header every time.
function retryRefusedPost(id) {
    const state = states.get(id);
    if (!state) return;
    const arming = !state.retryTimer;
    const delay = Math.min(catchupTiming.retryMs * 2 ** state.postFailures, trackerPollMs());
    scheduleCatchupRetry(id, delay, { force: true });
    if (arming && state.retryTimer) state.postFailures++;
}

// The safety net for anything the post-connect run could not see yet: the tracker's snapshot can
// lag the room by up to two minutes, and a send can fail with nobody reconnecting afterwards.
function startCatchupPoll(state) {
    if (state.catchupPoll || state.watch.paused || !isRoomWatch(state.watch)) return;
    state.catchupPoll = setInterval(() => autoCatchUp(state), trackerPollMs());
    if (state.catchupPoll.unref) state.catchupPoll.unref();
}

// Taken before anything of the new connection posts. A live flush a few seconds after connecting
// moves lastPostedAt to "now", and the header would then say the room was missed since a moment
// ago on nearly every restart of an active room.
function snapshotGap(state) {
    const seed = state.client.seedName;
    const rec = seed ? catchup.record(state.watch.id, seed) : null;
    state.gapSince = rec ? rec.lastPostedAt : null;
    state.gapFinished = rec ? new Set(rec.finished) : new Set();
    state.gapHeaderUsed = false;
}

function noteCatchupSuccess(state, posted) {
    const status = state.catchupStatus;
    if (status.failingSince) {
        logger.info(`[AP:${state.watch.label}] catch-up is working again`);
    }
    status.lastRunAt = Date.now();
    status.lastPosted = posted;
    status.lastError = null;
    status.failingSince = null;
}

// Warn once when it starts failing and say so when it recovers. The periodic run would otherwise
// repeat the same warning every poll for as long as a room stays expired.
function noteCatchupFailure(state, detail) {
    const status = state.catchupStatus;
    if (!status.failingSince) {
        status.failingSince = Date.now();
        logger.warn(`[AP:${state.watch.label}] catch-up failing: ${detail}`);
    }
    status.lastError = detail;
}

/** Why a catch-up cannot run right now, without fetching anything. */
function catchupGate(id) {
    const state = states.get(id);
    if (!state) return { ok: false, reason: 'no-watch' };
    if (!isRoomWatch(state.watch)) return { ok: false, reason: 'not-a-room' };
    if (state.watch.paused || state.status !== 'connected') return { ok: false, reason: 'not-connected' };
    if (!state.client.seedName) return { ok: false, reason: 'no-seed' };
    if (!state.client.roomStateReadAt) return { ok: false, reason: 'loading' };
    return { ok: true, state };
}

function newRun(manual, force) {
    const run = { manual: !!manual, force: !!force, onPlans: [], plan: null, fetchStartedAt: null };
    run.promise = new Promise((resolve) => { run.resolve = resolve; });
    return run;
}

function joinRun(run, manual, force, onPlan) {
    if (manual) run.manual = true;
    if (force) run.force = true;
    if (typeof onPlan !== 'function') return;
    if (run.plan) callPlan(onPlan, run.plan);
    else run.onPlans.push(onPlan);
}

function callPlan(onPlan, plan) {
    try {
        onPlan(plan);
    } catch (err) {
        logger.warn('[AP] catch-up plan callback threw:', err.message || err);
    }
}

function startRun(id, pipeline, flight, run) {
    flight.running = run;
    executeRun(id, pipeline, run)
        .catch(err => ({ ok: false, reason: 'failed', detail: (err && err.message) || String(err) }))
        .then((result) => {
            // Somebody asked for these lines to be posted, so the replacement state's first run
            // posts the rest even with archipelagoCatchup off.
            if (result && result.reason === 'restarted' && (run.manual || run.force) && pipelines.get(id) === pipeline) {
                const current = states.get(id);
                if (current) current.forceNext = true;
            }
            run.resolve(result);
            if (flight.running === run) flight.running = null;
            const next = flight.rerun;
            flight.rerun = null;
            if (!next) return;
            if (pipelines.get(id) === pipeline) startRun(id, pipeline, flight, next);
            else next.resolve({ ok: false, reason: 'no-watch' });
        });
}

/**
 * Post the lines this watch's channel missed, rebuilt from the room tracker.
 *
 * One run per watch at a time. A request made while a run is going joins it only if that run's
 * tracker read started after the request; otherwise one more run follows the current one, since
 * a read taken earlier cannot contain what the caller is asking about.
 *
 * Automatic runs (manual false) post nothing when config.archipelagoCatchup is false: they
 * record what they find as reported instead, so turning it back on does not dump a backlog. A
 * run that retries a refused send is the exception, since those lines were already being posted.
 *
 * @param {number} id
 * @param {Object} [options]
 * @param {boolean} [options.manual] the `!ap catchup` command; posts whatever the setting says
 * @param {boolean} [options.force] an automatic run that posts whatever the setting says
 * @param {(plan: {missed: number, hidden: number}) => void} [options.onPlan] called once the diff
 *   is known and before anything is posted, so a command can reply while a long catch-up is still
 *   sending. Not called for a baseline, a silent run or any not-ok result.
 * @returns {Promise<Object>} one of:
 *   {ok: false, reason: 'no-watch'|'not-a-room'|'not-connected'|'no-seed'|'loading'}
 *   {ok: false, reason: 'settling', at}   first sight, room read too soon after connecting; `at`
 *     is epoch ms when a baseline becomes possible
 *   {ok: false, reason: 'failed', detail}
 *   {ok: false, reason: 'restarted', posted}   the watch was restarted or removed mid-run
 *   {ok: true, baseline: true}   first sight: recorded silently, nothing posted
 *   {ok: true, silent: true, missed, posted: 0, hidden, channelId}
 *   {ok: true, missed, posted, hidden, channelId, gapSince, seededAt, settlingUntil?}   hidden is a
 *     count; gapSince is the ISO time of the last post before this connection, only on the first
 *     run of a connection (null after that or when nothing had ever posted); settlingUntil, epoch
 *     ms, is set when the tracker was read inside the settle window and may not show everything
 *     yet, with another run due then
 */
function catchUp(id, { manual = false, force = false, onPlan = null } = {}) {
    const requestedAt = Date.now();
    const gate = catchupGate(id);
    if (!gate.ok) return Promise.resolve(gate);

    const pipeline = gate.state.pipeline;
    const flight = pipeline.flight || (pipeline.flight = { running: null, rerun: null });
    const running = flight.running;
    if (running && (running.fetchStartedAt === null || running.fetchStartedAt >= requestedAt)) {
        joinRun(running, manual, force, onPlan);
        return running.promise;
    }
    if (running) {
        if (!flight.rerun) flight.rerun = newRun(false, false);
        joinRun(flight.rerun, manual, force, onPlan);
        return flight.rerun.promise;
    }
    const run = newRun(manual, force);
    joinRun(run, false, false, onPlan);
    startRun(id, pipeline, flight, run);
    return run.promise;
}

async function executeRun(id, pipeline, run) {
    const gate = catchupGate(id);
    if (!gate.ok) return gate;
    const state = gate.state;
    if (state.pipeline !== pipeline) return { ok: false, reason: 'no-watch' };

    // Read outside the chain: a tracker that takes its full 30 s timeout must not hold up the
    // live feed behind it.
    let data;
    try {
        const trackerId = await resolveTrackerId(state);
        if (!trackerId) throw new Error('no tracker linked from the room page');
        run.fetchStartedAt = Date.now();
        data = await tracker.readTrackerData(trackerId, { origin: new URL(state.watch.target.roomUrl).origin });
    } catch (err) {
        const detail = (err && err.message) || String(err);
        noteCatchupFailure(state, detail);
        return { ok: false, reason: 'failed', detail };
    }

    const result = await runSerial(pipeline, () => catchUpTask(id, pipeline, state, run, data),
        state.watch.label, 'catch-up');
    return result || { ok: false, reason: 'failed', detail: 'the catch-up threw; see the bot log' };
}

function stillCurrent(id, pipeline, state) {
    return pipelines.get(id) === pipeline && states.get(id) === state;
}

async function catchUpTask(id, pipeline, state, run, data) {
    if (!stillCurrent(id, pipeline, state)) return { ok: false, reason: 'restarted', posted: 0 };
    let gate = catchupGate(id);
    if (!gate.ok) return gate;

    // Every frame the socket has already delivered is relayed, buffered or filtered once this
    // settles, so nothing the live feed holds can also be counted as missed. Read fresh: the
    // chain it names moves on with every packet.
    await state.client.queue;
    if (!stillCurrent(id, pipeline, state)) return { ok: false, reason: 'restarted', posted: 0 };
    gate = catchupGate(id);
    if (!gate.ok) return gate;

    const client = state.client;
    const seed = client.seedName;
    const label = state.watch.label;

    // The tracker lags the room by up to 60 s of save interval plus 60 s of cache, so a read taken
    // sooner than this after connecting can be missing what happened just before the connect.
    const settledAt = (state.connectedAt || 0) + catchupTiming.settleMs;
    const early = run.fetchStartedAt < settledAt;
    const inflight = new Set(pipeline.buffer.map(e => e.key).filter(Boolean));

    if (!catchup.isSeeded(id, seed)) {
        // The next run would post whatever an early baseline missed as missed.
        if (early) return { ok: false, reason: 'settling', at: settledAt };

        // A line still in the buffer is left for its flush to post and record. Recorded here, the
        // flush would drop it as already posted.
        const keys = catchup.collectKeys({ tracker: data, client });
        const unsent = keys.all.filter(k => !inflight.has(k));
        if (!catchup.baseline(id, seed, unsent, { team: client.team, finished: finishedSlots(client) })) {
            const detail = 'the catch-up file could not be written';
            logger.warn(`[AP:${label}] catch-up baseline not saved (${detail}); nothing is posted until it can be`);
            return { ok: false, reason: 'failed', detail };
        }
        logger.info(`[AP:${label}] catch-up baseline recorded (${keys.counts.items} items, ` +
            `${keys.counts.goals} goals, ${keys.counts.hints} hints); missed lines are posted from here on`);
        noteCatchupSuccess(state, 0);
        return { ok: true, baseline: true };
    }

    const plan = catchup.buildCatchup({
        tracker: data,
        client,
        watch: state.watch,
        reportedHas: key => catchup.has(id, seed, key),
        inflight,
        finishedBefore: state.gapFinished || new Set(),
        shouldRelay
    });
    if (plan.hidden.length > 0) catchup.commit(id, seed, plan.hidden);

    const refusedOut = plan.lines.filter(l => (pipeline.refusals.get(owedTag(seed, l.key)) || 0) >= MAX_REFUSALS);
    if (refusedOut.length > 0) {
        catchup.commit(id, seed, refusedOut.map(l => l.key));
        for (const l of refusedOut) {
            pipeline.refusals.delete(owedTag(seed, l.key));
            pipeline.owed.delete(owedTag(seed, l.key));
        }
        logger.warn(`[AP:${label}] skipped ${refusedOut.length} line(s) Discord refused ${MAX_REFUSALS} times: ` +
            refusedOut.slice(0, 3).map(l => stripAnsi(l.text)).join(' | '));
    }
    let lines = refusedOut.length > 0 ? plan.lines.filter(l => !refusedOut.includes(l)) : plan.lines;
    const skipped = refusedOut.length > 0 ? { skipped: refusedOut.length } : {};

    const channelId = state.watch.channelId;
    const hidden = plan.hidden.length;

    // Taken over by the run rather than just cleared, so the hand-offs below (an early read, a
    // restart cutting the run short) still know this run was owed a post.
    if (!run.manual && !run.force && state.forceNext) {
        run.force = true;
        state.forceNext = false;
    }
    if (!run.manual && !run.force && config.archipelagoCatchup === false) {
        // Lines that were already due in the channel and were refused still post: recording them
        // here would lose them for good.
        const owed = (l) => pipeline.owed.has(owedTag(seed, l.key));
        const quiet = lines.filter(l => !owed(l));
        catchup.commit(id, seed, quiet.map(l => l.key));
        catchup.persist();
        if (quiet.length > 0) {
            logger.info(`[AP:${label}] catch-up is off: recorded ${quiet.length} missed line(s) without posting them`);
        }
        lines = lines.filter(owed);
        if (lines.length === 0) {
            settleOwed(id, pipeline, seed);
            noteCatchupSuccess(state, 0);
            return { ok: true, silent: true, missed: quiet.length, posted: 0, hidden, channelId, ...skipped };
        }
    }
    const missed = lines.length;

    const gapSince = state.gapHeaderUsed ? null : state.gapSince;
    const rec = catchup.record(id, seed);
    const seededAt = rec ? rec.seededAt : null;
    run.plan = { missed, hidden };
    for (const onPlan of run.onPlans.splice(0)) callPlan(onPlan, run.plan);
    // An early read leaves the dated header for the settled run, which can still find more.
    const settling = early ? { settlingUntil: settledAt } : {};
    // Somebody asked for these lines, and with archipelagoCatchup off the settled run would
    // otherwise record whatever it finds without posting it.
    if (early && (run.manual || run.force)) state.forceNext = true;

    if (missed === 0) {
        // A later run of this connection can only be recovering what the live feed dropped, so
        // "missed since" would date it wrongly.
        if (!early) state.gapHeaderUsed = true;
        catchup.persist();
        settleOwed(id, pipeline, seed);
        noteCatchupSuccess(state, 0);
        return { ok: true, missed: 0, posted: 0, hidden, channelId, gapSince, seededAt, ...settling, ...skipped };
    }

    if (!stillCurrent(id, pipeline, state)) {
        catchup.persist();
        return { ok: false, reason: 'restarted', posted: 0 };
    }
    if (!(await send(state, catchupHeader(state, missed, gapSince, seededAt)))) {
        catchup.persist();
        const detail = 'could not post to the channel';
        noteCatchupFailure(state, detail);
        retryRefusedPost(id);
        return { ok: false, reason: 'failed', detail };
    }
    if (!early) state.gapHeaderUsed = true;

    const fence = state.watch.color ? 'ansi' : '';
    const entries = lines.map(l => ({
        text: `[missed] ${String(l.text).replace(/```/g, "'''")}`,
        key: l.key,
        seed,
        planned: l
    }));
    let posted = 0;
    let failed = 0;
    const postedLines = [];
    for (const chunk of chunkForRetry(entries, pipeline.refusals)) {
        if (!stillCurrent(id, pipeline, state)) {
            catchup.persist();
            // Restarted rather than removed: the replacement's run skips these committed lines, so
            // their claimants hear about them here or not at all.
            if (pipelines.get(id) === pipeline) await sendPingLines(state, pipeline, catchupPings(state, postedLines));
            return { ok: false, reason: 'restarted', posted };
        }
        const ok = await send(state, `\`\`\`${fence}\n${chunk.text}\n\`\`\``);
        // A restart mid-send still records what posted; a removal has already forgotten the watch.
        if (pipelines.get(id) !== pipeline) return { ok: false, reason: 'restarted', posted };
        if (!ok) {
            failed += chunk.entries.length;
            noteRefused(pipeline, chunk.entries);
            continue;
        }
        noteAccepted(pipeline, chunk.entries);
        catchup.commit(id, seed, chunk.entries.map(e => e.key), {
            postedAt: new Date().toISOString(),
            finished: seed === client.seedName ? finishedSlots(client) : undefined
        });
        // Every chunk, not once per run: stopping the bot is the natural reaction to a long
        // catch-up, and a run saved only at its end would repost everything on the next boot.
        catchup.persist();
        posted += chunk.entries.length;
        state.lineCount += chunk.entries.length;
        postedLines.push(...chunk.entries.map(e => e.planned));
    }
    // A failed chunk leaves its lines owed, so this schedules the retry for them too.
    const outstanding = settleOwed(id, pipeline, seed);

    await sendPingLines(state, pipeline, catchupPings(state, postedLines));
    catchup.persist();
    logger.info(`[AP:${label}] catch-up posted ${posted} of ${missed} missed line(s)` +
        (hidden ? `, ${hidden} hidden by filters` : '') + (failed ? `, ${failed} failed and will be retried` : ''));
    if (failed > 0) {
        noteCatchupFailure(state, 'could not post to the channel');
    } else {
        // Not while a line is still owed: one the tracker never shows would otherwise be retried
        // every 30 seconds for good.
        if (!outstanding) state.postFailures = 0;
        noteCatchupSuccess(state, posted);
    }
    return { ok: true, missed, posted, hidden, channelId, gapSince, seededAt, ...settling, ...skipped };
}

function catchupHeader(state, count, gapSince, seededAt) {
    const label = escapeMarkdown(String(state.watch.label));
    const tail = 'rebuilt from the room tracker (order approximate).';
    const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
    if (gapSince && Number.isFinite(epoch(gapSince))) {
        return `📜 **${label}** — ${count} line(s) missed since <t:${epoch(gapSince)}:f>, ${tail}`;
    }
    if (!state.gapHeaderUsed && seededAt && Number.isFinite(epoch(seededAt))) {
        return `📜 **${label}** — ${count} line(s) missed since tracking began <t:${epoch(seededAt)}:f>, ${tail}`;
    }
    return `📜 **${label}** — ${count} line(s) the live feed missed, ${tail}`;
}

// One line per claimant and slot rather than one per item. These items arrived hours ago in
// game, and a line each would push the live pings past the two-message cap.
function catchupPings(state, lines) {
    const counts = new Map();
    for (const planned of lines) {
        if (!planned || planned.line.type !== 'ItemSend' || typeof planned.receiving !== 'number') continue;
        const slot = state.client.slotNameFor(planned.receiving);
        if (!slot) continue;
        const claim = claims.find(state.watch.id, slot);
        if (!shouldPing(claim, planned.line)) continue;
        const key = `${claim.userId}\u0000${slot}`;
        if (!counts.has(key)) counts.set(key, { userId: claim.userId, slot, total: 0, progression: 0 });
        const entry = counts.get(key);
        entry.total++;
        if (planned.line.flags & ITEM_FLAG_PROGRESSION) entry.progression++;
    }
    return [...counts.values()].map(c => ({
        userId: c.userId,
        line: `<@${c.userId}> \`${c.slot.replace(/`/g, "'")}\` — ${c.total} missed item(s)` +
            (c.progression ? `, ${c.progression} progression` : '') + ', see the catch-up above.'
    }));
}

function startWatch(watch) {
    const state = makeState(watch);
    states.set(watch.id, state);
    if (!watch.paused) {
        state.client.start();
        startCompletionPoll(state);
        startCatchupPoll(state);
    }
    return state;
}

// Leaves the watch's pipeline alone: a restart wants its buffered lines and any flush under way to
// carry on. The callers that end a watch drop the pipeline themselves.
function stopWatch(id) {
    const state = states.get(id);
    if (!state) return;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    clearCatchupTimers(state);
    state.client.stop();
}

// Rebuilds the client so a changed password, slot, or DeathLink tag takes effect — all
// three are only read during the connect handshake.
/**
 * Rebuild the client so a changed password, slot or DeathLink tag takes effect.
 * @param {number} id
 * @param {{sameRoom?: boolean}} [options] sameRoom false when the watch has been re-pointed at a
 *   different multiworld, so nothing identifying the old one is carried over.
 */
function restartWatch(id, { sameRoom = true } = {}) {
    const existing = states.get(id);
    if (!existing) return null;
    stopWatch(id);
    const state = makeState(existing.watch);
    state.channel = existing.channel;
    // Carried across only when the new socket is going to the SAME room. A /config re-point
    // reuses this path with a different multiworld, where every one of these is a lie: the goal
    // key would keep the old seed, so a slot name shared by both rooms is deduped against the old
    // room's goal and never credited, and canonicalSlotName would "verify" claims against slots
    // that no longer exist.
    if (sameRoom) {
        // The tracker id is fixed for the room's life, and completion read before the reconnect
        // is still true after it.
        state.trackerUrl = existing.trackerUrl;
        state.client.fullyChecked = existing.client.fullyChecked;
        state.client.released = existing.client.released;
        // Slot names too, or a restart silently disables the claim-name check that knowsRoom()
        // gates: until the fresh handshake lands, `!ap claim ZackWordd` would be stored as typed.
        // A restart is exactly when the room may be unreachable, so that window is not short.
        state.client.slotNames = existing.client.slotNames;
        state.client.slotGroups = existing.client.slotGroups;
        state.client.seedName = existing.client.seedName;
        // And the team those names are keyed under. Without it a fresh client defaults to team 0
        // while holding a team-1 map, so knowsRoom() is true and every lookup misses.
        state.client.team = existing.client.team;
        state.catchupStatus = existing.catchupStatus;
        state.forceNext = existing.forceNext;
    }
    states.set(id, state);
    existing.watch.paused = false;
    state.client.start();
    startCompletionPoll(state);
    startCatchupPoll(state);
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
            dropPipeline(CONFIG_WATCH_ID);
            catchup.forgetWatch(CONFIG_WATCH_ID);
            // With no state for id 0, listClaims(0) answers null and `!ap claims` / `!ap unclaim`
            // report "No watch with ID 0", so claims left here would be unreachable from the
            // command surface and would attach to whatever room /config names next.
            const dropped = releaseClaimsFor(existing, CONFIG_WATCH_ID);
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
        const dropped = releaseClaimsFor(existing, CONFIG_WATCH_ID);
        if (dropped > 0) {
            logger.info(`Archipelago configured room re-pointed — ${dropped} slot claim(s) released with the old room`);
        }
    }

    const inferChanged = !!existing.watch.inferFinished !== !!desired.inferFinished;
    // `desired` always carries paused:false, so assigning it cleared the pause a refused
    // connection had set — without reconnecting anything. getStatus() then reported 0 paused and
    // !diag went from "1 of 1 watch(es) paused after a refused connection" to a green
    // "0/1 room(s) connected" for a room that was never coming back. Only a reconnect clears it,
    // and restartWatch does that itself.
    const wasPaused = existing.watch.paused;
    Object.assign(existing.watch, desired);
    if (!needsReconnect) existing.watch.paused = wasPaused;
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
    if (needsReconnect) restartWatch(CONFIG_WATCH_ID, { sameRoom: !roomChanged });
    return existing.watch;
}

// Runs at boot and again whenever an archipelago* setting is saved, so the wizard can point the
// bot at a different room without a restart.
function applyConfig({ boot = false } = {}) {
    if (!config.archipelagoEnabled) {
        if (states.size > 0) {
            for (const id of [...states.keys()]) {
                stopWatch(id);
                dropPipeline(id);
            }
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
    // `!restart` runs stop and start in the same process, so the sockets survive and no
    // 'connected' fires to schedule a catch-up. The cached channels belong to the Discord client
    // that was just destroyed, and whatever failed to post while it logged back in needs a run.
    for (const state of states.values()) {
        state.channel = null;
        if (state.status === 'connected') scheduleCatchupRetry(state.watch.id);
    }
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
    dropPipeline(id);
    catchup.forgetWatch(id);
    // Claims are keyed by watch id, and ids are handed out from a counter that can reach this
    // one again. Dropping them here stops a future watch inheriting the last one's pings. The
    // state is already gone, so the role sync borrows this one purely for its channel and guild.
    const releasedClaims = releaseClaimsFor(state, id);
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

    // Collected first and written once. Recording them one at a time rewrote the whole tally file
    // synchronously per goal, on the socket's own message handler, and a first connect to a room
    // where several claimed slots had already finished did that back to back.
    const pending = [];
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

        pending.push({
            userId: claim.userId,
            key: goals.goalKey(identity, slotName),
            meta: { slot: slotName, watchId: state.watch.id }
        });
    }

    for (const { userId, key } of goals.recordAll(pending)) {
        changed.add(userId);
        const slot = key.split('::').pop();
        logger.info(`[AP:${state.watch.label}] ${slot} goaled — that is ${goals.countFor(userId)} for ${userId}`);
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
    // Built once. This was a full copy of the claim array plus a scan per user in the loop, for
    // an answer that cannot change while the loop runs.
    // Any claim anywhere keeps the participant role: a watch is not guild-scoped, and the
    // configured room has no guild id of its own to compare against.
    const claimants = new Set(claims.all().map(c => c.userId));

    let countsMoved = false;
    for (const userId of userIds) {
        try {
            const applied = await roles.syncMember(guild, userId, {
                claimed: claimants.has(userId),
                goals: goals.countFor(userId),
                memberRoleName
            });
            if (applied && [...applied.added, ...applied.removed].some(name => /Goaled$/.test(name))) {
                countsMoved = true;
            }
        } catch (err) {
            logger.warn(`[AP:${state.watch.label}] role sync failed for ${userId}: ${err.message}`);
        }
    }

    // Only worth a pass when a count role actually moved. It used to run on every path in here,
    // including a plain unclaim, and each run walked the whole tally to build a ranking whose
    // order and user ids were thrown away one line later.
    if (!countsMoved) return;
    try {
        await roles.sweepCounts(guild, goals.leaderboard().map(row => row.count));
    } catch (err) {
        // Warn rather than debug: debug is dropped below the default level and never reaches the
        // log file, so a sweep failing every time left nothing to find.
        logger.warn(`[AP:${state.watch.label}] role sweep failed: ${err.message}`);
    }
}

/**
 * Drop every claim on a watch and take the participant role off anyone that leaves holding
 * nothing. Three paths reach this: `!ap unwatch`, a /config re-point, and /config losing a
 * required setting. Only the first had the role sync, so the other two left the role stuck on
 * people with no claims and nothing to re-evaluate it later.
 * @returns {number} how many claims went
 */
function releaseClaimsFor(state, id) {
    const affected = new Set(claims.forWatch(id).map(c => c.userId));
    const dropped = claims.releaseWatch(id);
    if (dropped > 0 && state) {
        syncRoles(state, affected).catch(err =>
            logger.warn(`[AP] role sync after releasing watch ${id} failed: ${err.message || err}`));
    }
    return dropped;
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
    if (removed) {
        syncRoles(state, new Set([removed.userId])).catch(err =>
            logger.warn(`[AP:${state.watch.label}] role sync after unclaim failed: ${err.message || err}`));
    }
    return removed;
}

function setClaimPings(id, slot, mode) {
    if (!states.has(id)) return null;
    return claims.setPings(id, slot, mode);
}

function setClaimHintPings(id, slot, mode) {
    if (!states.has(id)) return null;
    return claims.setHintPings(id, slot, mode);
}

/**
 * How much sphere data arrived, for the log.
 *
 * The two sources carry different shapes -- the multidata a `slots` object keyed by slot, the
 * spoiler a flat `rows` array -- and this reaches only for the one that is actually there.
 * Assuming `rows` here is what turned the first multidata-backed `!ap next` into
 * "I could not work that out (Cannot read properties of undefined (reading 'length'))": the
 * suggestion itself was fine and a log line took the command down with it.
 */
function describeSpheres(loaded) {
    if (!loaded) return 'nothing';
    if (loaded.source === 'multidata') {
        const slots = loaded.slots ? Object.keys(loaded.slots).length : 0;
        return `multidata, ${slots} slot${slots === 1 ? '' : 's'}`;
    }
    const rows = Array.isArray(loaded.rows) ? loaded.rows.length : 0;
    return `${loaded.source || 'unknown'}, ${rows} row${rows === 1 ? '' : 's'}`;
}

const SPHERE_DIRS = {
    sphereDir: path.join(__dirname, '..', 'data', 'archipelago', 'spheres'),
    spoilerDir: path.join(__dirname, '..', 'data', 'archipelago', 'spoilers')
};

/**
 * Make sure a watch holds the best sphere data on disk for its seed, reloading when that changed.
 *
 * It used to load once per seed and keep the result for the life of the watch, which made the
 * order files arrived in matter. Drop a spoiler, let somebody run `!ap next`, then extract the
 * multidata table, and the watch went on answering from the spoiler's tenth of the locations until
 * a restart, with nothing to say a far better source was sitting right beside it. Re-extracting a
 * table had the same problem, and so did deleting a bad one.
 *
 * Each call now compares a fingerprint of both candidate files — two stats, no reads — and reloads
 * only when it moved, so the priority between sources (see loadSpheres) holds whatever order the
 * files turned up in. The fingerprint is taken BEFORE the load: a file that changes mid-load then
 * leaves a fingerprint already out of date, and the next call catches it, rather than one that
 * matches content that was never read.
 *
 * @returns {Promise<{ok: true, reloaded: boolean, stale?: boolean, spheres: Object}|
 *   {ok: false, reason: 'need-spheres', want: string, fallback: string}>} `spheres` is the record
 *   to answer from; a caller that awaits anything afterwards must use it, not state.spheres
 */
async function ensureSpheres(state, seed, { sphereDir, spoilerDir }) {
    const fingerprint = await spheres.sourceFingerprint({ seed, sphereDir, spoilerDir });
    const held = state.spheres;
    const sameSeed = Boolean(held && held.seed === seed);
    if (sameSeed && held.fingerprint === fingerprint) return { ok: true, reloaded: false, spheres: held };

    const loaded = await spheres.loadSpheres({ seed, spoilerDir, sphereDir });
    const label = (state.watch && state.watch.label) || '?';

    // **The held record's own file is still there but did not come back.** The ordinary cause is
    // a copy in progress: Windows copy tools hold the destination open exclusively, so every read
    // fails with EBUSY until the copy ends. Two ways that showed up, both reproduced in review:
    //   - nothing loaded, and dropping the record told the user there was no sphere data while
    //     the file sat right there;
    //   - the table failed and loadSpheres fell back to a spoiler beside it, so a copy over the
    //     table silently swapped every answer to a tenth of the locations for its duration.
    // Either way the record already held is still this seed's and still good. It keeps answering,
    // and its fingerprint is left as it was so the next call tries the load again.
    //
    // It turns on the held record's OWN file, not on whether anything is present. A table deleted
    // on purpose beside an unusable spoiler is still deleted, and is not answered from memory.
    const ownStillThere = sameSeed && spheres.sourcePresent(fingerprint, held.source);
    const fellBack = !loaded || spheres.sourceRank(loaded.source) < spheres.sourceRank(held && held.source);
    if (ownStillThere && fellBack) {
        // Once per distinct state of the disk, so a file left broken does not repeat this on
        // every command.
        if (state.sphereStaleWarned !== fingerprint) {
            state.sphereStaleWarned = fingerprint;
            logger.warn(`[AP:${label}] ${held.path} changed but would not load; still answering from what was held`);
        }
        return { ok: true, reloaded: false, stale: true, spheres: held };
    }

    if (!loaded) {
        // Every usable source is gone. Dropped rather than kept, so a deleted file is not quietly
        // answered from memory. A call already under way is unaffected: it carries the record it
        // chose (see prepareSuggest).
        state.spheres = null;
        return {
            ok: false,
            reason: 'need-spheres',
            want: spheres.spherePath(sphereDir, seed),
            fallback: spheres.spoilerPath(spoilerDir, seed)
        };
    }

    // Seed and fingerprint go last, so nothing a loader returns can overwrite them.
    const record = { ...loaded, seed, fingerprint };
    state.spheres = record;
    state.sphereStaleWarned = null;
    const verb = sameSeed ? `reloaded (was ${held.source})` : 'loaded';
    logger.info(`[AP:${label}] sphere data ${verb} from ${loaded.path} (${describeSpheres(loaded)})`);
    return { ok: true, reloaded: true, spheres: record };
}

/**
 * The room's tracker id, read off its room page the first time and kept on the state after that.
 * @returns {Promise<string|null>} null when the room page links no tracker
 */
async function resolveTrackerId(state) {
    const roomUrl = state.watch.target.roomUrl;
    if (!state.trackerUrl) {
        const html = await (await fetch(roomUrl, { signal: AbortSignal.timeout(30000) })).text();
        const trackerId = tracker.extractTrackerId(html);
        if (!trackerId) return null;
        state.trackerUrl = `${new URL(roomUrl).origin}/tracker/${trackerId}`;
    }
    return state.trackerUrl.split('/').pop();
}

/**
 * The one-off work behind a suggestion: the tracker's address, the seed's spheres, and every
 * slot's checked locations.
 *
 * Separated from the per-slot arithmetic because somebody holding eight slots in a big async
 * would otherwise re-fetch the tracker's 400 KB of check data eight times to answer one command.
 */
async function prepareSuggest(id) {
    const state = states.get(id);
    if (!state) return { ok: false, reason: 'no-watch' };

    const target = state.watch.target;
    if (!target || target.kind !== 'room') return { ok: false, reason: 'not-a-room' };

    try {
        const trackerId = await resolveTrackerId(state);
        if (!trackerId) return { ok: false, reason: 'no-tracker' };

        const client = state.client;
        const seed = client.seedName || describeTarget(target);
        const held = await ensureSpheres(state, seed, SPHERE_DIRS);
        if (!held.ok) return held;

        // held.spheres, not state.spheres: the record is fixed here, before the await below gives
        // any other call a chance to replace it.
        return { ok: true, state, client, spheres: held.spheres, checkedIds: await tracker.readCheckedIds(trackerId) };
    } catch (err) {
        logger.warn(`[AP:${state.watch.label}] could not read what is next:`, err.message || err);
        return { ok: false, reason: 'failed', detail: err.message };
    }
}

/**
 * Slot answers in the order worth visiting: the earliest sphere still within reach first.
 *
 * Three bands, so a slot with something to do is never listed under one without:
 *   1. an answer with a sphere, lowest sphere first
 *   2. nothing reachable yet — every open location sits past what the slot has proven it can enter
 *   3. no answer at all: nothing left, not a slot in this multiworld, no sphere data
 * Ties go by slot name, ignoring case, so the same state of the room always lists the same way.
 *
 * This also decides what survives Discord's message limit. A player holding twenty slots sees
 * only as many as fit, and in this order the ones cut are the ones furthest from reach.
 *
 * @returns {Array} a new array; the one passed in is left in its original order
 */
function orderBySoonest(results) {
    const band = (r) => (r && r.ok ? (r.sphere === null || r.sphere === undefined ? 1 : 0) : 2);
    const name = (r) => String((r && r.slot) || '');
    return [...(results || [])].sort((a, b) =>
        band(a) - band(b)
        || (band(a) === 0 ? a.sphere - b.sphere : 0)
        || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }));
}

/** One slot's answer, off an already-prepared read. No I/O. */
function suggestFor(prep, slotName) {
    const { state, client, checkedIds } = prep;
    // The snapshot this call's prepareSuggest took, not the live field. prepareSuggest awaits a
    // multi-second tracker fetch after choosing the data, and another `!ap next` on the same watch
    // can reload or drop state.spheres in that gap; reading the live field then threw on null.
    // The fallback serves callers that build a prep by hand.
    const data = prep.spheres || (state && state.spheres);
    if (!data) return { ok: false, reason: 'no-spheres', slot: slotName };

    const slot = client.canonicalSlotName ? client.canonicalSlotName(slotName) : slotName;
    if (!slot) return { ok: false, reason: 'unknown-slot', slot: slotName };
    const slotId = client.slotIdFor ? client.slotIdFor(slot) : null;
    if (slotId === null || slotId === undefined) return { ok: false, reason: 'unknown-slot', slot: slotName };

    // A slot that is done has nothing worth pointing at. Checked before the sphere arithmetic
    // rather than left to fall out of it: a finished slot does reach "nothing left", but only
    // once every one of its playthrough rows is checked, and a release ends a slot without
    // touching the spoiler's view of it at all.
    //
    // `how` is what is actually known, which is not always the outcome. Goal status is read
    // back from data storage, so it survives a restart. A release is only ever seen live, in a
    // PrintJSON that arrives once, and there is no key to re-read it from — so a slot released
    // while the bot was down is indistinguishable from one that goaled without its client ever
    // saying so. Both land as 'complete', and the reply says finished rather than guessing.
    if (client.hasFinished && client.hasFinished(slotId)) {
        const how = client.hasGoaled(slotId) ? 'goaled'
            : client.hasReleased(slotId) ? 'released'
            : 'complete';
        return { ok: false, reason: 'finished', slot, how };
    }

    const ids = checkedIds.get(`${client.team}:${slotId}`) || [];
    const names = client.locationNames.get(client.slotGames.get(slotId));

    let next;
    if (data.source === 'multidata') {
        // Both sides already speak location ids, so nothing is matched by name and a slot whose
        // data package has not loaded yet still gets a correct answer.
        next = spheres.soonestFromTable(data.slots[String(slotId)], new Set(ids));
        if (next) {
            // Resolved only for the handful about to be shown. An id with no name is kept as an
            // id rather than dropped: the location is real and worth naming badly.
            next = { ...next, locations: next.locations.map(id => (names && names.get(id)) || `Location#${id}`) };
        }
    } else {
        // The spoiler talks in names, and the game's data package is what joins the two.
        const checked = new Set(ids.map(i => names && names.get(i)).filter(Boolean));
        next = spheres.soonestInLogic(data.rows, checked, slot);
    }

    if (!next) return { ok: false, reason: 'nothing-left', slot };
    return { ok: true, slot, source: data.source, ...next };
}

/**
 * What is soonest reachable across every slot asked about.
 *
 * Sphere only. Nothing here reads which item is at a location, or prefers one location over
 * another for any reason but the sphere number, because the moment it did the answer would be
 * telling somebody what is there.
 *
 * @returns {Promise<{ok: boolean, reason?: string, want?: string, results?: Array}>} one entry
 *   per slot asked about, in the order asked, each carrying its own `ok`; a false `ok` on the
 *   outer object means the read itself failed and there are no entries at all
 */
async function suggestNextAll(id, slotNames) {
    const prep = await prepareSuggest(id);
    if (!prep.ok) return prep;
    return { ok: true, results: (slotNames || []).map(name => suggestFor(prep, name)) };
}

async function suggestNext(id, slotName) {
    const all = await suggestNextAll(id, [slotName]);
    return all.ok ? all.results[0] : all;
}

/**
 * Outstanding hints on a watch, resolved to names for display.
 * Null when there is no such watch, an empty array when the room simply has none, so the caller
 * can tell "wrong id" from "nothing to show".
 */
function listHints(id) {
    const state = states.get(id);
    if (!state) return null;

    const client = state.client;
    const tables = client.lookupTables();
    return client.outstandingHints().map(hint => ({
        finder: client.slotNameFor(hint.finding_player, hint.team) || `Player#${hint.finding_player}`,
        receiver: tables.playerName(hint.receiving_player) || `Player#${hint.receiving_player}`,
        // The item belongs to the receiver's game and the location to the finder's. Getting
        // that pair the wrong way round resolves to nothing, or worse to a name from another
        // game: one id in this room's packages exists in five of them.
        item: tables.itemName(tables.gameForSlot(hint.receiving_player), hint.item) || `Item#${hint.item}`,
        where: tables.locationName(tables.gameForSlot(hint.finding_player), hint.location) || `Location#${hint.location}`,
        priority: hint.status === HINT_PRIORITY,
        entrance: hint.entrance || ''
    }));
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
        connectedAt: state.connectedAt,
        // available is false for a host:port watch, which has no web tracker to rebuild from.
        catchup: { available: isRoomWatch(state.watch), ...state.catchupStatus },
        players: state.client.slotsOnTeam().length,
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
    listHints,
    suggestNext,
    suggestNextAll,
    // Exported for the tests: the id-to-name join is the part of a suggestion that can be
    // wrong without anything throwing, and reaching it through suggestNextAll would mean
    // faking a room page, a tracker endpoint and a data package to test arithmetic.
    suggestFor,
    orderBySoonest,
    describeSpheres,
    ensureSpheres,
    setClaimHintPings,
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
    chunkEntries,
    shouldRelay,
    shouldPing,
    catchUp,
    catchupTiming,
    relayTiming,
    connectionNotice,
    DEFAULT_FILTERS,
    FILTER_GROUPS,
    WATCH_FILE
};
