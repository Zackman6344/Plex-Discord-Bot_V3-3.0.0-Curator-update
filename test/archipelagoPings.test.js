// The ping path end to end: a real client against a stand-in server, a claimed slot, and what
// actually lands in the channel. The unit tests cover the policy in isolation; this covers the
// wiring between them — that the mention escapes the code fence, carries a real allowedMentions
// whitelist, and has had the ANSI taken back out of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { WebSocketServer } = require('ws');

process.env.PLEXBOT_AP_CLAIMS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-ping-claims-' + process.pid + '.json');
process.env.PLEXBOT_AP_WATCHES_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-ping-watches-' + process.pid + '.json');

const config = require('../config/config.js');
const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const { ITEM_FLAG_PROGRESSION } = require('../helpers/archipelagoClient.js');

const ZACK = '111111111111111111';

// The room the bot watches from is slot 2; the claimed slot the items are addressed to is 1.
function startFakeServer() {
    const wss = new WebSocketServer({ port: 0 });
    let live = null;

    wss.on('connection', (socket) => {
        live = socket;
        const send = (packets) => socket.send(JSON.stringify(packets));
        send([{ cmd: 'RoomInfo', games: [], datapackage_checksums: {}, password: false }]);

        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                if (packet.cmd !== 'Connect') continue;
                send([{
                    cmd: 'Connected', team: 0, slot: 2,
                    players: [
                        // An alias that differs from the name, so a claim matched against the
                        // wrong one would fail this test rather than pass it by luck.
                        { team: 0, slot: 1, name: 'ZackWord', alias: 'Zack (afk)' },
                        { team: 0, slot: 2, name: 'Watcher', alias: 'Watcher' }
                    ],
                    slot_info: {}, missing_locations: [], checked_locations: []
                }]);
            }
        });
    });

    return new Promise((resolve) => wss.on('listening', () => resolve({
        wss,
        port: wss.address().port,
        // No data package is loaded, so an item_name part renders its own text — which keeps
        // this test about the ping path rather than about name resolution.
        sendItem: (receiving, flags, name = 'Progressive Sword') => live.send(JSON.stringify([{
            cmd: 'PrintJSON', type: 'ItemSend', receiving,
            item: { item: 1, location: 2, player: 2, flags },
            data: [
                { text: 'Watcher sent ' },
                { type: 'item_name', text: name, flags },
                { text: ' to ZackWord' }
            ]
        }]))
    })));
}

function closeServer(wss) {
    return new Promise((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(resolve);
    });
}

const posted = [];
const fakeDiscord = {
    channels: {
        fetch: async (id) => ({
            id,
            send: async (payload) => { posted.push(payload); return {}; }
        })
    }
};

function waitFor(predicate, what, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const hit = predicate();
            if (hit) return resolve(hit);
            if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
            setTimeout(tick, 50);
        };
        tick();
    });
}

const pingMessage = () => posted.find(p => String(p.content).includes(`<@${ZACK}>`));

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
        try { fs.unlinkSync(claims.CLAIM_FILE); } catch (_) {}
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
        try { fs.unlinkSync(claims.CLAIM_FILE); } catch (_) {}
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
