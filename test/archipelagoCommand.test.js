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

// Enough of a Discord message for the command to run against. The whole payload is kept, not
// just its text, so the mention-suppression rule can be asserted.
function fakeMessage(author = ZACK) {
    const sent = [];
    return {
        sent,
        author: { id: author },
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

async function runAs(author, ...args) {
    const msg = fakeMessage(author);
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

// A leading integer is always the id, even one no watch holds. Deciding that on whether the id
// exists reads as friendlier and silently retargets the only watch when it does not: `!ap unwatch
// 999` deleted the one live room. Answering "no watch with ID 999" is the recoverable half of
// that trade, and the cost is that a slot literally named "12345" needs the explicit form.
test('an id no watch holds is rejected, not re-read as the next argument', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('claim', '999', 'ZackWord');
    assert.match(said(msg), /No watch with ID 999/);
    assert.strictEqual(claims.forWatch(watch.id).length, 0, 'nothing claimed on the wrong watch');
});

test('a stale id does not destroy the only watch', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('unwatch', '999');
    assert.match(said(msg), /No watch with ID 999/);
    assert.ok(monitor.getWatch(watch.id), 'the live watch must survive a command that named another');
});

test('a stale id is not folded into the password', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('password', '999', 'hunter2');
    assert.match(said(msg), /No watch with ID 999/);
    assert.strictEqual(monitor.getWatch(watch.id).password, null, 'the live watch keeps its own password');
});

test('a stale id is not re-read as the on/off word', async () => {
    const watch = await addWatch(['ZackWord']);
    const before = monitor.getWatch(watch.id).progressionOnly;

    // "0" would read as falsy and invert this if the id fell through to the toggle position.
    const msg = await run('progression', '0', 'on');
    assert.match(said(msg), /No watch with ID 0/);
    assert.strictEqual(monitor.getWatch(watch.id).progressionOnly, before, 'the live watch is untouched');
});

test('a numeric slot name still works through the explicit id form', async () => {
    const watch = await addWatch(['12345', 'ZackWord']);

    const msg = await run('claim', String(watch.id), '12345');
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

// --- claiming somebody else's slot ---------------------------------------------------------

const MALLORY = '333333333333333333';

test('a slot already claimed cannot be taken by another user', async (t) => {
    // isOwner() answers true for everybody when no ownerId is configured, so the guard needs a
    // real owner to be a third party here.
    const saved = config.ownerId;
    config.ownerId = '999999999999999999';
    t.after(() => { config.ownerId = saved; });

    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);

    const msg = await runAs(MALLORY, 'claim', 'ZackWord');
    assert.match(said(msg), /already claimed by/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK, 'the original holder keeps it');
});

test('the owner can still reassign a claimed slot', async (t) => {
    const saved = config.ownerId;
    config.ownerId = MALLORY;
    t.after(() => { config.ownerId = saved; });

    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');

    const msg = await runAs(MALLORY, 'claim', 'ZackWord');
    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, MALLORY);
});

test('re-claiming a slot you already hold is still fine', async () => {
    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');
    const msg = await run('claim', 'ZackWord');

    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);
});

// --- mentions -------------------------------------------------------------------------------

test('no reply can ping anybody, whatever the slot text contains', async () => {
    await addWatch(['ZackWord']);

    // A role mention survives slotArg, which only strips user mentions. Echoed with default
    // parsing it would let any user make the bot ping a role - and the bot's own participant
    // role is created mentionable.
    const msg = await run('unclaim', '<@&123456789012345678>');
    assert.match(said(msg), /Nobody has claimed/);

    for (const payload of msg.sent) {
        assert.strictEqual(typeof payload, 'object', 'every reply is sent as a payload, not a bare string');
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] },
            `a reply went out without mention suppression: ${JSON.stringify(payload).slice(0, 120)}`);
    }
});

test('the claim confirmation names a user without pinging them', async () => {
    await addWatch(['ZackWord']);
    const msg = await run('claim', 'ZackWord');

    assert.ok(msg.sent.length > 0);
    for (const payload of msg.sent) {
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    }
});
