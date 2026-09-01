// The `!ap` argument parser, specifically the optional watch id.
//
// Leaving the id out means "the only watch", which makes the first word after the sub-command
// ambiguous in the prefix form: `!ap claim 0 ZackWord` gives one and `!ap claim ZackWord` does
// not. A number is only read as an id when a watch actually has it, so a slot named "0" still
// reaches the right place.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { WebSocketServer } = require('ws');

const tmp = (name) => pathMod.join(os.tmpdir(), `plexbot-test-cmd-${name}-${process.pid}.json`);
process.env.PLEXBOT_AP_CLAIMS_FILE = tmp('claims');
process.env.PLEXBOT_AP_WATCHES_FILE = tmp('watches');
process.env.PLEXBOT_AP_GOALS_FILE = tmp('goals');
process.env.PLEXBOT_AP_ROLES_FILE = tmp('roles');

const config = require('../config/config.js');
const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const ap = require('../commands/archipelago.js');

const ZACK = '111111111111111111';

function startFakeServer(slotNames) {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (socket) => {
        const send = (packets) => socket.send(JSON.stringify(packets));
        send([{ cmd: 'RoomInfo', games: [], datapackage_checksums: {}, password: false, seed_name: 'Seed_CMD' }]);
        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                if (packet.cmd !== 'Connect') continue;
                send([{
                    cmd: 'Connected', team: 0, slot: 1,
                    players: slotNames.map((name, i) => ({ team: 0, slot: i + 1, name, alias: name })),
                    slot_info: {}, missing_locations: [], checked_locations: []
                }]);
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

// Enough of a Discord message for the command to run against.
function fakeMessage() {
    const sent = [];
    return {
        sent,
        author: { id: ZACK },
        guild: null,
        channel: { id: 'chan-1', send: async (payload) => { sent.push(payload); return { edit: async () => {} }; } },
        mentions: { users: { first: () => null } },
        interaction: null,
        deletable: false
    };
}

const said = (msg) => msg.sent.map(p => (typeof p === 'string' ? p : p.content || '')).join('\n');

async function run(...args) {
    const msg = fakeMessage();
    await ap.command.process(msg, ...args);
    return msg;
}

let servers = [];
let watchIds = [];

async function addWatch(slotNames) {
    const server = await startFakeServer(slotNames);
    servers.push(server);
    const { watch } = await monitor.addWatch({
        target: `localhost:${server.port}`,
        slot: slotNames[0],
        channelId: 'chan-1'
    }, 15000);
    watchIds.push(watch.id);
    return watch;
}

test.beforeEach(() => {
    config.archipelagoEnabled = true;
    config.ownerId = '';           // claiming is self-service either way; this keeps it simple
    try { fs.unlinkSync(claims.CLAIM_FILE); } catch (_) {}
    claims.reset();
});

test.afterEach(async () => {
    for (const id of watchIds) monitor.removeWatch(id);
    for (const server of servers) await closeServer(server.wss);
    watchIds = [];
    servers = [];
});

test.after(() => {
    for (const file of [claims.CLAIM_FILE]) {
        try { fs.unlinkSync(file); } catch (_) {}
    }
});

test('with one watch, the id can be left out', async () => {
    const watch = await addWatch(['ZackWord', 'ZackREPO']);

    const msg = await run('claim', 'ZackWord');
    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);
});

test('an explicit id still works, and picks the same watch', async () => {
    const watch = await addWatch(['ZackWord', 'ZackREPO']);

    const msg = await run('claim', String(watch.id), 'ZackREPO');
    assert.match(said(msg), /You are now on `ZackREPO`/);
    assert.strictEqual(claims.find(watch.id, 'ZackREPO').userId, ZACK);
});

test('a slot name that looks like a number is not mistaken for an id', async () => {
    // No watch has id 12345, so the number has to be read as the slot name.
    const watch = await addWatch(['12345', 'ZackWord']);

    const msg = await run('claim', '12345');
    assert.match(said(msg), /You are now on `12345`/);
    assert.strictEqual(claims.find(watch.id, '12345').userId, ZACK);
});

test('pings and unclaim take the id optionally too', async () => {
    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');

    const set = await run('pings', 'ZackWord', 'all');
    assert.match(said(set), /pinging for every item/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').pings, 'all');

    const gone = await run('unclaim', 'ZackWord');
    assert.match(said(gone), /released/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord'), null);
});

test('a slot name with spaces survives the optional id', async () => {
    const watch = await addWatch(['Zack Word Two']);

    const msg = await run('claim', 'Zack Word Two');
    assert.match(said(msg), /You are now on `Zack Word Two`/);
    assert.strictEqual(claims.find(watch.id, 'Zack Word Two').userId, ZACK);
});

test('with two watches the id is required again, and says so', async () => {
    await addWatch(['ZackWord']);
    await addWatch(['OtherSlot']);

    const msg = await run('claim', 'ZackWord');
    assert.match(said(msg), /More than one room is being watched/);
    assert.strictEqual(claims.all().length, 0, 'nothing claimed on a guess');
});

test('with no watches at all it says that rather than asking for an ID', async () => {
    const msg = await run('claims');
    assert.match(said(msg), /No rooms are being watched yet/);
});
