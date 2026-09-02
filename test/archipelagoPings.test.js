// The ping path end to end: a real client against a stand-in server, a claimed slot, and what
// actually lands in the channel. The unit tests cover the policy in isolation; this covers the
// wiring between them — that the mention escapes the code fence, carries a real allowedMentions
// whitelist, and has had the ANSI taken back out of it.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('ping');   // must run before any helper is required

const config = require('../config/config.js');
const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const { ITEM_FLAG_PROGRESSION } = require('../helpers/archipelagoClient.js');

const ZACK = '111111111111111111';

// The bot watches from slot 2; the claimed slot the items are addressed to is 1. The alias on
// slot 1 deliberately differs from its name, so a claim matched against the wrong one fails this
// test rather than passing by luck.
const startFakeServer = () => ap.startFakeServer({
    slots: ['ZackWord', 'Watcher'],
    watchSlot: 2,
    seedName: 'Seed_PING'
});
const { closeServer, waitFor } = ap;

const discord = ap.fakeDiscord();
const posted = discord.posted;
const fakeDiscord = discord.client;

const pingMessage = () => posted.find(p => String(p.content).includes(`<@${ZACK}>`));

// addWatch persists a watch file on every test, and PIDs get reused, so a leftover could be
// picked up by a later run against the same tmp path.
test.after(() => {
    stores.cleanup();
});

test('a claimed slot gets a ping outside the fence, with a real mention whitelist', async (t) => {
    const savedEnabled = config.archipelagoEnabled;
    const savedBatch = config.archipelagoBatchSeconds;
    // Off, so wiring up the fake Discord client cannot make applyConfig dial a real room.
    config.archipelagoEnabled = false;
    config.archipelagoBatchSeconds = 1;

    const server = await startFakeServer();
    let watchId = null;

    t.after(async () => {
        if (watchId !== null) monitor.removeWatch(watchId);
        await closeServer(server.wss);
        config.archipelagoEnabled = savedEnabled;
        config.archipelagoBatchSeconds = savedBatch;
        
        claims.reset();
    });

    monitor.startArchipelagoMonitor(fakeDiscord);

    const { watch, outcome } = await monitor.addWatch({
        target: `localhost:${server.port}`,
        slot: 'Watcher',
        channelId: 'chan-1'
    }, 15000);
    watchId = watch.id;
    assert.strictEqual(outcome, 'connected');

    claims.claim({ watchId: watch.id, slot: 'zackword', userId: ZACK });   // deliberately mis-cased
    posted.length = 0;

    server.sendItem(1, ITEM_FLAG_PROGRESSION);
    const ping = await waitFor(pingMessage, 'the ping message');

    // The log block and the ping are separate messages: a mention inside a fence notifies nobody.
    const block = posted.find(p => String(p.content).startsWith('```'));
    assert.ok(block, 'expected the log block as its own message');
    assert.ok(!String(block.content).includes(`<@${ZACK}>`), 'the mention must not be inside the fence');

    assert.match(ping.content, /Progressive Sword/);
    assert.match(ping.content, /`ZackWord`/, 'the room spelling, not what was typed');
    assert.ok(!/\u001b/.test(ping.content), 'ANSI must be stripped outside a fence');

    assert.deepStrictEqual(ping.allowedMentions, { parse: [], users: [ZACK] });
});

test('a filler item does not ping a slot set to progression only', async (t) => {
    const savedEnabled = config.archipelagoEnabled;
    const savedBatch = config.archipelagoBatchSeconds;
    config.archipelagoEnabled = false;
    config.archipelagoBatchSeconds = 1;

    const server = await startFakeServer();
    let watchId = null;

    t.after(async () => {
        if (watchId !== null) monitor.removeWatch(watchId);
        await closeServer(server.wss);
        config.archipelagoEnabled = savedEnabled;
        config.archipelagoBatchSeconds = savedBatch;
        
        claims.reset();
    });

    monitor.startArchipelagoMonitor(fakeDiscord);

    const { watch } = await monitor.addWatch({
        target: `localhost:${server.port}`,
        slot: 'Watcher',
        channelId: 'chan-2'
    }, 15000);
    watchId = watch.id;

    claims.claim({ watchId: watch.id, slot: 'ZackWord', userId: ZACK });
    posted.length = 0;

    server.sendItem(1, 0, 'Blue Rupee');
    // The log block still arrives — this is about the ping, not the relay.
    await waitFor(() => posted.find(p => String(p.content).includes('Blue Rupee')), 'the log block');

    assert.strictEqual(pingMessage(), undefined, 'filler must not ping a progression-only claim');
});
