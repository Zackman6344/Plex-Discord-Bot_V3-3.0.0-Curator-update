// The room described by /config, end to end: settings in, a connected watch out, and the
// reconnect rules that decide whether a change costs a new socket.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');
const { WebSocketServer } = require('ws');

// Its own watch file, so a run can never read or rewrite the real one (which holds a password).
process.env.PLEXBOT_AP_WATCHES_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-ap-watches-' + process.pid + '.json');

const config = require('../config/config.js');
const monitor = require('../helpers/archipelagoMonitor.js');

const AP_KEYS = Object.keys(config).filter((k) => k.startsWith('archipelago'));

function snapshot() {
    return Object.fromEntries(AP_KEYS.map((k) => [k, config[k]]));
}

function restore(saved) {
    for (const [k, v] of Object.entries(saved)) config[k] = v;
}

function clearRoom() {
    config.archipelagoRoomUrl = '';
    config.archipelagoHost = '';
    config.archipelagoSlot = '';
    config.archipelagoChannelId = '';
    config.archipelagoPassword = '';
}

// --- reading the settings ---------------------------------------------------------------

test('a room URL wins over host and port', (t) => {
    const saved = snapshot();
    t.after(() => restore(saved));

    config.archipelagoRoomUrl = 'https://archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA';
    config.archipelagoHost = 'localhost';
    config.archipelagoPort = 12345;

    // The port moves on every spin-up of a hosted room, so the URL has to take precedence.
    assert.deepStrictEqual(monitor.configTarget(), {
        kind: 'room',
        roomUrl: 'https://archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA'
    });
});

test('host and port are used when no room URL is set', (t) => {
    const saved = snapshot();
    t.after(() => restore(saved));

    config.archipelagoRoomUrl = '';
    config.archipelagoHost = 'localhost';
    config.archipelagoPort = 12345;
    assert.deepStrictEqual(monitor.configTarget(), { kind: 'direct', host: 'localhost', port: 12345 });

    config.archipelagoPort = '';
    assert.deepStrictEqual(monitor.configTarget(), { kind: 'direct', host: 'localhost', port: 38281 });

    config.archipelagoHost = '';
    assert.strictEqual(monitor.configTarget(), null);
});

test('configGaps names exactly what is still missing', (t) => {
    const saved = snapshot();
    t.after(() => restore(saved));

    clearRoom();
    assert.deepStrictEqual(monitor.configGaps(), ['a room URL, or a host', 'a slot name', 'a log channel']);

    config.archipelagoHost = 'localhost';
    assert.deepStrictEqual(monitor.configGaps(), ['a slot name', 'a log channel']);

    config.archipelagoSlot = 'Zack';
    config.archipelagoChannelId = '123456789012345678';
    assert.deepStrictEqual(monitor.configGaps(), []);
});

test('configFilters maps the show toggles, with deaths off unless asked for', (t) => {
    const saved = snapshot();
    t.after(() => restore(saved));

    config.archipelagoShowItems = true;
    config.archipelagoShowChat = false;
    config.archipelagoShowDeaths = false;
    let filters = monitor.configFilters();
    assert.strictEqual(filters.items, true);
    assert.strictEqual(filters.chat, false);
    assert.strictEqual(filters.deaths, false);

    config.archipelagoShowDeaths = true;
    assert.strictEqual(monitor.configFilters().deaths, true);
});

// --- the watch it produces --------------------------------------------------------------

function startFakeServer() {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (socket) => {
        const send = (packets) => socket.send(JSON.stringify(packets));
        send([{ cmd: 'RoomInfo', games: [], datapackage_checksums: {}, password: false }]);
        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                if (packet.cmd === 'Connect') {
                    send([{
                        cmd: 'Connected', team: 0, slot: 1,
                        players: [{ team: 0, slot: 1, alias: packet.name, name: packet.name }],
                        slot_info: {}, missing_locations: [], checked_locations: []
                    }]);
                }
            }
        });
    });
    return new Promise((resolve) => wss.on('listening', () => resolve({ wss, port: wss.address().port })));
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
        fetch: async (id) => ({ id, send: async ({ content }) => { posted.push({ id, content }); return {}; } })
    }
};

function waitForConnected(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const entry = monitor.listWatches().find((e) => e.watch.id === monitor.CONFIG_WATCH_ID);
            if (entry && entry.status === 'connected') return resolve(entry);
            if (Date.now() - started > timeoutMs) return reject(new Error('configured room never connected'));
            setTimeout(tick, 25);
        };
        tick();
    });
}

test('the configured room becomes a live watch, and edits apply without a restart', async (t) => {
    const saved = snapshot();
    const { wss, port } = await startFakeServer();

    t.after(async () => {
        config.archipelagoEnabled = false;
        monitor.applyConfig();
        restore(saved);
        await closeServer(wss);
    });

    config.archipelagoEnabled = true;
    config.archipelagoRoomUrl = '';
    config.archipelagoHost = '127.0.0.1';
    config.archipelagoPort = port;
    config.archipelagoSlot = 'Zack';
    config.archipelagoChannelId = '123456789012345678';
    config.archipelagoShowChat = true;
    config.archipelagoShowDeaths = false;
    config.archipelagoProgressionOnly = false;

    monitor.startArchipelagoMonitor(fakeDiscord);
    const entry = await waitForConnected();

    assert.strictEqual(entry.watch.managed, true, 'the configured room is managed, not user-added');
    assert.strictEqual(entry.watch.slot, 'Zack');
    assert.strictEqual(entry.watch.channelId, '123456789012345678');
    assert.strictEqual(entry.address, `127.0.0.1:${port}`);

    // A filter change applies to the next batch; it must not drop the connection.
    const before = monitor.listWatches().find((e) => e.watch.id === monitor.CONFIG_WATCH_ID).connectedAt;
    config.archipelagoShowChat = false;
    config.archipelagoProgressionOnly = true;
    monitor.applyConfig();

    const after = monitor.listWatches().find((e) => e.watch.id === monitor.CONFIG_WATCH_ID);
    assert.strictEqual(after.watch.filters.chat, false, 'the filter change landed');
    assert.strictEqual(after.watch.progressionOnly, true);
    assert.strictEqual(after.connectedAt, before, 'and it did not cost a reconnect');

    // Clearing a required setting retires the watch rather than leaving a stale one running.
    config.archipelagoSlot = '';
    monitor.applyConfig();
    assert.strictEqual(monitor.listWatches().find((e) => e.watch.id === monitor.CONFIG_WATCH_ID), undefined);
});

test('the configured room refuses edits that /config owns', async (t) => {
    const saved = snapshot();
    const { wss, port } = await startFakeServer();

    t.after(async () => {
        config.archipelagoEnabled = false;
        monitor.applyConfig();
        restore(saved);
        await closeServer(wss);
    });

    config.archipelagoEnabled = true;
    config.archipelagoRoomUrl = '';
    config.archipelagoHost = '127.0.0.1';
    config.archipelagoPort = port;
    config.archipelagoSlot = 'Zack';
    config.archipelagoChannelId = '123456789012345678';

    monitor.startArchipelagoMonitor(fakeDiscord);
    await waitForConnected();

    // Editing it through !ap would be silently undone the next time config changed.
    for (const attempt of [
        () => monitor.removeWatch(monitor.CONFIG_WATCH_ID),
        () => monitor.setFilter(monitor.CONFIG_WATCH_ID, 'items', false),
        () => monitor.setPassword(monitor.CONFIG_WATCH_ID, 'x'),
        () => monitor.setProgressionOnly(monitor.CONFIG_WATCH_ID, true)
    ]) {
        assert.throws(attempt, /\/config/, 'should point the user at /config');
    }
});
