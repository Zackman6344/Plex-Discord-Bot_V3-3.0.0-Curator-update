// test/helpers/catchupRelay.js
//
// The harness the archipelagoCatchup*.test.js files share: a real client against the stand-in
// server, a room-URL watch whose room page and tracker API are stubbed, and a channel whose sends
// can be slowed down or refused.
//
// Split across files so the runner can run them in parallel: one file of these ran to 28 seconds
// on its own and set the wall time of the whole Archipelago suite. Each file calls
// useTempStores() with its own prefix BEFORE requiring this, since every store reads its path at
// module load.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const assert = require('node:assert');

const ap = require('./apServer.js');
const config = require('../../config/config.js');
const claims = require('../../helpers/archipelagoClaims.js');
const catchup = require('../../helpers/archipelagoCatchup.js');
const tracker = require('../../helpers/archipelagoTracker.js');
const monitor = require('../../helpers/archipelagoMonitor.js');
const { ITEM_FLAG_PROGRESSION } = require('../../helpers/archipelagoClient.js');
const { closeServer, waitFor } = ap;

const ORIGIN = 'https://ap.example.test';
const USER = '222222222222222222';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A channel whose sends can be slowed down or made to fail, and whose fetch can be made to fail
 * (a deleted channel, or one the bot lost access to).
 */
function testDiscord() {
    const posted = [];
    const control = { delayMs: 0, fail: () => false, fetchFails: false };
    const channel = (id) => ({
        id,
        send: async (payload) => {
            if (control.delayMs) await sleep(control.delayMs);
            if (control.fail(payload)) throw new Error('Discord said no');
            posted.push(payload);
            return {};
        }
    });
    return {
        posted,
        control,
        client: {
            channels: {
                fetch: async (id) => {
                    if (control.fetchFails) throw new Error('Unknown Channel');
                    return channel(id);
                }
            },
            users: { fetch: async (id) => ({ id, send: async () => ({}) }) }
        }
    };
}

function trackerOf(byReceiver) {
    return {
        player_items_received: Object.entries(byReceiver).map(([player, items]) => ({ team: 0, player: Number(player), items })),
        activity_timers: [],
        player_status: []
    };
}

const text = (p) => String(p.content);
const blocks = (posted) => posted.filter(p => text(p).startsWith('```'));
const headers = (posted) => posted.filter(p => text(p).startsWith('📜'));
const timesPosted = (posted, loc) => posted.filter(p => text(p).includes(`Location#${loc})`)).length;
const pingsFor = (posted, userId) => posted.filter(p => text(p).includes(`<@${userId}>`));

function hint(over) {
    return Object.assign({
        receiving_player: 2, finding_player: 1, location: 5000,
        item: 77, found: false, entrance: '', item_flags: 0, status: 0
    }, over || {});
}

let roomCounter = 0;

/**
 * A connected room-URL watch on slot 2 ("Watcher") of a two-slot room, with the tracker stubbed.
 * Items default to sender 2 and receiver 1, keyed by location.
 * @param {Object} [options]
 * @param {number} [options.batchSeconds] the flush window, 0.25 by default
 * @param {Object} [options.hints]   slot -> Hint[], held by reference like the server's
 * @param {Object} [options.statuses] slot -> client status, held by reference like the server's
 * @param {boolean} [options.channelDown] the channel cannot be fetched from the start
 */
async function setup(t, options = {}) {
    const seed = options.seed || `Seed_CU_${++roomCounter}`;
    const saved = {
        enabled: config.archipelagoEnabled,
        batch: config.archipelagoBatchSeconds,
        catchupOn: config.archipelagoCatchup,
        timing: { ...monitor.catchupTiming },
        relay: { ...monitor.relayTiming }
    };
    config.archipelagoEnabled = false;
    monitor.relayTiming.minFlushMs = 100;
    config.archipelagoBatchSeconds = options.batchSeconds || 0.25;
    config.archipelagoCatchup = true;
    Object.assign(monitor.catchupTiming, { settleMs: 150, retryMs: 500, loadingRetryMs: 50 }, options.timing || {});

    const server = await ap.startFakeServer({
        slots: ['SlotA', 'Watcher'],
        watchSlot: 2,
        seedName: seed,
        answerGet: options.answerGet !== false,
        statuses: options.statuses || {},
        hints: options.hints || null
    });
    const roomUrl = `${ORIGIN}/room/ROOM${String(roomCounter).padStart(6, '0')}`;
    const trackerPath = `/tracker/TRACKER${roomCounter}AB`;
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url) === roomUrl) {
            return {
                ok: true, status: 200,
                text: async () => `<a href="${trackerPath}">Tracker</a> /connect 127.0.0.1:${server.port}`
            };
        }
        return { ok: false, status: 404, text: async () => '' };
    });

    const room = { data: trackerOf(options.tracker || {}), calls: [] };
    t.mock.method(tracker, 'readTrackerData', async (id, opts) => {
        room.calls.push({ id, opts, at: Date.now() });
        return JSON.parse(JSON.stringify(room.data));
    });

    const discord = testDiscord();
    discord.control.fetchFails = !!options.channelDown;
    monitor.startArchipelagoMonitor(discord.client);
    const { watch, outcome } = await monitor.addWatch({ target: roomUrl, slot: 'Watcher', channelId: 'chan-cu' }, 15000);
    assert.strictEqual(outcome, 'connected');

    t.after(async () => {
        monitor.removeWatch(watch.id);
        await closeServer(server.wss);
        config.archipelagoEnabled = saved.enabled;
        config.archipelagoBatchSeconds = saved.batch;
        config.archipelagoCatchup = saved.catchupOn;
        Object.assign(monitor.catchupTiming, saved.timing);
        Object.assign(monitor.relayTiming, saved.relay);
        claims.reset();
    });

    const add = (receiver, ...tuples) => {
        const entry = room.data.player_items_received.find(e => e.player === receiver);
        if (entry) entry.items.push(...tuples);
        else room.data.player_items_received.push({ team: 0, player: receiver, items: tuples });
    };
    const entry = () => monitor.listWatches().find(e => e.watch.id === watch.id);
    return { server, discord, posted: discord.posted, watch, seed, room, add, entry };
}

async function baselined(ctx) {
    await waitFor(() => catchup.isSeeded(ctx.watch.id, ctx.seed), 'the catch-up baseline');
}

/** Restart the watch and wait until the new socket has read the room's goals and hints. */
async function restarted(ctx) {
    const state = monitor.restartWatch(ctx.watch.id);
    await waitFor(() => ctx.entry().status === 'connected' && state.client.roomStateReadAt, 'the reconnect');
    return state;
}

module.exports = {
    ap, config, claims, catchup, tracker, monitor, ITEM_FLAG_PROGRESSION, closeServer, waitFor,
    ORIGIN, USER, sleep, testDiscord, trackerOf, text, blocks, headers, timesPosted, pingsFor, hint,
    setup, baselined, restarted
};
