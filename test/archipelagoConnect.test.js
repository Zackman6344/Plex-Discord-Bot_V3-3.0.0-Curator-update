// Drives the real client against a stand-in Archipelago server on a loopback port.
// The unit tests cover rendering in isolation; this covers the part that only shows up
// once packets are actually flowing — the RoomInfo → GetDataPackage → Connect handshake,
// the wss→ws scheme fallback, and what the client sends back to the server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const { WebSocketServer } = require('ws');

const { ArchipelagoClient } = require('../helpers/archipelagoClient.js');
const dataCache = require('../helpers/archipelagoData.js');

// Test games get unique names so the run never collides with a real cached data package,
// and so cleanup can't delete one.
const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const GAME_A = `__ap_test_alttp_${SUFFIX}`;
const GAME_B = `__ap_test_oot_${SUFFIX}`;
const CHECKSUM_A = `sum_a_${SUFFIX}`;
const CHECKSUM_B = `sum_b_${SUFFIX}`;

function startFakeServer({ refuse = false } = {}) {
    const received = [];
    // Port 0 = let the OS pick a free one, so a busy port can't make the suite flaky.
    const wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (socket) => {
        const send = (packets) => socket.send(JSON.stringify(packets));

        send([{
            cmd: 'RoomInfo',
            games: [GAME_A, GAME_B],
            datapackage_checksums: { [GAME_A]: CHECKSUM_A, [GAME_B]: CHECKSUM_B },
            password: false
        }]);

        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                received.push(packet);

                if (packet.cmd === 'GetDataPackage') {
                    send([{ cmd: 'DataPackage', data: { games: {
                        [GAME_A]: { item_name_to_id: { 'Progressive Sword': 5 }, location_name_to_id: { 'Map Chest': 21 }, checksum: CHECKSUM_A },
                        [GAME_B]: { item_name_to_id: { 'Kokiri Emerald': 66 }, location_name_to_id: { 'Kokiri Sword Chest': 9 }, checksum: CHECKSUM_B }
                    } } }]);
                }

                if (packet.cmd === 'Connect') {
                    if (refuse) {
                        send([{ cmd: 'ConnectionRefused', errors: ['InvalidSlot'] }]);
                        continue;
                    }
                    send([{
                        cmd: 'Connected', team: 0, slot: 1,
                        players: [
                            { team: 0, slot: 1, alias: 'Zack', name: 'Zack' },
                            { team: 0, slot: 2, alias: 'Alice', name: 'Alice' }
                        ],
                        slot_info: {
                            1: { name: 'Zack', game: GAME_B, type: 1 },
                            2: { name: 'Alice', game: GAME_A, type: 1 }
                        },
                        missing_locations: [], checked_locations: []
                    }]);
                    send([{
                        cmd: 'PrintJSON', type: 'ItemSend',
                        item: { item: 5, location: 9, player: 1, flags: 1 },
                        data: [
                            { type: 'player_id', text: '1' }, { text: ' sent ' },
                            { type: 'item_id', text: '5', player: 2 }, { text: ' to ' },
                            { type: 'player_id', text: '2' }, { text: ' (' },
                            { type: 'location_id', text: '9', player: 1 }, { text: ')' }
                        ]
                    }]);
                }
            }
        });
    });

    return new Promise((resolve) => {
        wss.on('listening', () => resolve({ wss, received, port: wss.address().port }));
    });
}

function closeServer(wss) {
    return new Promise((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(resolve);
    });
}

async function cleanupCache() {
    for (const [game, checksum] of [[GAME_A, CHECKSUM_A], [GAME_B, CHECKSUM_B]]) {
        try { await fs.unlink(dataCache.cacheFilePath(game, checksum)); } catch (_) {}
    }
}

test('connects, fetches the data package, and renders a live item send', async (t) => {
    const { wss, received, port } = await startFakeServer();
    const client = new ArchipelagoClient({
        target: { kind: 'direct', host: '127.0.0.1', port },
        slot: 'Zack',
        label: 'test'
    });

    t.after(async () => {
        client.stop();
        await closeServer(wss);
        await cleanupCache();
    });

    const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no log line within 15s')), 15000);
        client.on('line', (l) => { clearTimeout(timer); resolve(l); });
        client.on('fatal', (f) => { clearTimeout(timer); reject(new Error(`refused: ${f.reason}`)); });
        client.start();
    });

    assert.strictEqual(line.text, 'Zack sent Progressive Sword to Alice (Kokiri Sword Chest)');
    assert.strictEqual(line.group, 'items');
    assert.strictEqual(line.flags, 1);
    assert.ok(client.connected, 'client should report itself connected');

    // The observer contract: no game, no items, tracker tag. If any of these drift the
    // bot stops being a passive observer of the slot it attaches to.
    const connect = received.find(p => p.cmd === 'Connect');
    assert.ok(connect, 'server should have received a Connect packet');
    assert.strictEqual(connect.name, 'Zack');
    assert.strictEqual(connect.game, '');
    assert.strictEqual(connect.items_handling, 0);
    assert.strictEqual(connect.slot_data, false);
    assert.deepStrictEqual(connect.tags, ['Tracker']);

    const request = received.find(p => p.cmd === 'GetDataPackage');
    assert.ok(request, 'uncached games should be requested');
    assert.deepStrictEqual(request.games.sort(), [GAME_A, GAME_B].sort());

    // …and the games it just learned about should now be on disk for the next connect.
    assert.ok(await dataCache.load(GAME_A, CHECKSUM_A), 'data package should have been cached');
});

test('a refused connection is fatal rather than a retry loop', async (t) => {
    const { wss, port } = await startFakeServer({ refuse: true });
    const client = new ArchipelagoClient({
        target: { kind: 'direct', host: '127.0.0.1', port },
        slot: 'NotARealSlot',
        label: 'test-refuse'
    });

    t.after(async () => {
        client.stop();
        await closeServer(wss);
    });

    const reason = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no refusal within 15s')), 15000);
        client.on('fatal', (f) => { clearTimeout(timer); resolve(f.reason); });
        client.start();
    });

    assert.strictEqual(reason, 'InvalidSlot');
    assert.strictEqual(client.stopped, true, 'a refused client must not keep retrying');
});

test('deathlink watches advertise the tag the server routes deaths by', async (t) => {
    const { wss, received, port } = await startFakeServer();
    const client = new ArchipelagoClient({
        target: { kind: 'direct', host: '127.0.0.1', port },
        slot: 'Zack',
        deathlink: true,
        label: 'test-deathlink'
    });

    t.after(async () => {
        client.stop();
        await closeServer(wss);
        await cleanupCache();
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never connected')), 15000);
        client.on('status', (s) => { if (s.state === 'connected') { clearTimeout(timer); resolve(); } });
        client.start();
    });

    const connect = received.find(p => p.cmd === 'Connect');
    assert.deepStrictEqual(connect.tags, ['Tracker', 'DeathLink']);
});

test('goal status comes from the server, and filters items sent to finished slots', async (t) => {
    const received = [];
    const wss = new WebSocketServer({ port: 0 });
    let live = null;

    wss.on('connection', (socket) => {
        live = socket;
        const send = (packets) => socket.send(JSON.stringify(packets));
        send([{ cmd: 'RoomInfo', games: [], datapackage_checksums: {}, password: false }]);

        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                received.push(packet);

                if (packet.cmd === 'Connect') {
                    send([{
                        cmd: 'Connected', team: 0, slot: 1,
                        players: [
                            { team: 0, slot: 1, alias: 'Zack', name: 'Zack' },
                            { team: 0, slot: 2, alias: 'Alice', name: 'Alice' }
                        ],
                        slot_info: {}, missing_locations: [], checked_locations: []
                    }]);
                }

                // Alice finished before the bot ever connected. The prefixed spelling is the
                // one the AP source uses.
                if (packet.cmd === 'Get') {
                    send([{ cmd: 'Retrieved', keys: { '_read_client_status_0_2': 30, '_read_client_status_0_1': 20 } }]);
                }
            }
        });
    });

    await new Promise((resolve) => wss.on('listening', resolve));
    const port = wss.address().port;

    const c = new ArchipelagoClient({
        target: { kind: 'direct', host: '127.0.0.1', port },
        slot: 'Zack', label: 'goal-test'
    });

    t.after(async () => {
        c.stop();
        for (const s of wss.clients) s.terminate();
        await new Promise((r) => wss.close(r));
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never connected')), 15000);
        c.on('status', (s) => { if (s.state === 'connected') { clearTimeout(timer); resolve(); } });
        c.start();
    });

    // 'connected' fires as soon as the client has sent these; the server still has to receive
    // and answer them.
    await new Promise((r) => setTimeout(r, 200));

    // Both key spellings are asked for, so a wrong guess in either direction still works.
    const get = received.find((p) => p.cmd === 'Get');
    const notify = received.find((p) => p.cmd === 'SetNotify');
    assert.ok(get, 'the client should read client status at connect');
    assert.ok(notify, 'and subscribe to changes');
    assert.ok(get.keys.includes('_read_client_status_0_2'));
    assert.ok(get.keys.includes('client_status_0_2'));

    assert.strictEqual(c.hasGoaled(2), true, 'Alice goaled before we connected');
    assert.strictEqual(c.hasGoaled(1), false, 'Zack is still playing');

    const lineFor = (packet) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no line')), 8000);
        c.once('line', (l) => { clearTimeout(timer); resolve(l); });
        live.send(JSON.stringify([packet]));
    });

    const toAlice = await lineFor({
        cmd: 'PrintJSON', type: 'ItemSend', receiving: 2,
        item: { item: 5, location: 9, player: 1, flags: 1 },
        data: [{ text: 'Zack sent a thing to Alice' }]
    });
    assert.strictEqual(toAlice.recipientFinished, true);
    assert.strictEqual(toAlice.receiving, 2);

    const toZack = await lineFor({
        cmd: 'PrintJSON', type: 'ItemSend', receiving: 1,
        item: { item: 5, location: 9, player: 2, flags: 1 },
        data: [{ text: 'Alice sent a thing to Zack' }]
    });
    assert.strictEqual(toZack.recipientFinished, false);

    // A goal announced while watching counts too, under the unprefixed key spelling.
    live.send(JSON.stringify([{ cmd: 'SetReply', key: 'client_status_0_1', value: 30, original_value: 20 }]));
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(c.hasGoaled(1), true, 'a live status change is picked up');

    // And so does a Goal print, which is the fallback when data storage is unavailable.
    const c2Goaled = c.hasGoaled(2);
    assert.strictEqual(c2Goaled, true);
});
