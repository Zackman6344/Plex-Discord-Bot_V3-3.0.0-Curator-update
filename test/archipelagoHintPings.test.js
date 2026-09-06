// The hint ping, driven end to end: a real client against the stand-in server, a real claim
// store, and assertions on what actually reaches a channel or a DM.
//
// The unit tests next door cover the store's arithmetic. What this file is for is the ordering
// that arithmetic depends on — that the backlog present at first connect is absorbed silently,
// and that a hint arriving afterwards is the only thing anyone hears about.

const test = require('node:test');
const assert = require('node:assert');

const { useTempStores, startFakeServer, closeServer, fakeDiscord, waitFor } = require('./helpers/apServer.js');
const stores = useTempStores('hintpings');

const claims = require('../helpers/archipelagoClaims.js');
const hintStore = require('../helpers/archipelagoHints.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const config = require('../config/config.js');

const SEED = 'Seed_HINTS';

function hint(over) {
    return Object.assign({
        receiving_player: 2, finding_player: 1, location: 5000,
        item: 77, found: false, entrance: '', item_flags: 0, status: 0
    }, over || {});
}

function resetStores() {
    claims.reset();
    hintStore.reset();
    stores.cleanup();
}

/** Bring a watch up against a stand-in room and wait for the first hint read to land. */
async function connect(t, { hints, apSlot = 'SlotA' }) {
    const server = await startFakeServer({ slots: ['SlotA', 'SlotB'], seedName: SEED, watchSlot: 1, hints });
    const discord = fakeDiscord();

    const saved = {};
    for (const k of Object.keys(config)) if (k.startsWith('archipelago')) saved[k] = config[k];

    config.archipelagoEnabled = true;
    config.archipelagoRoomUrl = '';
    config.archipelagoHost = '127.0.0.1';
    config.archipelagoPort = server.port;
    config.archipelagoSlot = apSlot;
    config.archipelagoChannelId = 'chan-1';

    monitor.startArchipelagoMonitor(discord.client);

    t.after(async () => {
        config.archipelagoEnabled = false;
        monitor.applyConfig();
        Object.assign(config, saved);
        await closeServer(server.wss);
        resetStores();
    });

    // The hint read is answered after Connected, so wait for the store rather than the socket.
    await waitFor(() => hintStore.isSeeded(SEED), 'the hint baseline to be seeded');
    return { server, discord };
}

test('the backlog present at first connect pings nobody', async (t) => {
    resetStores();
    // Twenty outstanding hints against slot 1, which is the shape the live room actually had.
    const backlog = Array.from({ length: 20 }, (_, i) => hint({ location: 6000 + i }));
    const { discord } = await connect(t, { hints: { 1: backlog } });

    claims.claim({ watchId: 0, slot: 'SlotA', userId: 'u1' });
    claims.setHintPings(0, 'SlotA', 'channel');

    // Nothing announced: the claim was made after the baseline, and the baseline is silent
    // regardless. Twenty pings of pure backlog is the failure this guards.
    const pings = discord.posted.filter(p => String(p.content || '').includes('waiting on'));
    assert.strictEqual(pings.length, 0);
    assert.strictEqual(discord.dms.length, 0);
});

test('a hint placed after the baseline reaches the finder in the channel', async (t) => {
    resetStores();
    const { server, discord } = await connect(t, { hints: { 1: [hint({ location: 1 })] } });

    claims.claim({ watchId: 0, slot: 'SlotA', userId: 'u1' });
    claims.setHintPings(0, 'SlotA', 'channel');

    // SlotA is the finder: somebody wants an item out of their world.
    server.sendPacket({
        cmd: 'SetReply',
        key: '_read_hints_0_1',
        value: [hint({ location: 1 }), hint({ location: 2, status: 30 })]
    });

    const ping = await waitFor(
        () => discord.posted.find(p => String(p.content || '').includes('waiting on')),
        'the hint ping'
    );

    assert.match(ping.content, /<@u1>/, 'the claimant is mentioned');
    assert.match(ping.content, /priority/, 'status 30 is called out');
    // Same mention discipline as every other send: an explicit whitelist, nothing parsed.
    assert.deepStrictEqual(ping.allowedMentions, { parse: [], users: ['u1'] });

    // Replayed on the next connect, it must not fire again.
    const before = discord.posted.length;
    server.sendPacket({ cmd: 'SetReply', key: '_read_hints_0_1', value: [hint({ location: 2, status: 30 })] });
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(discord.posted.length, before, 'a hint is announced once, ever');
});

test('off is the default, so an unopted claim hears nothing', async (t) => {
    resetStores();
    const { server, discord } = await connect(t, { hints: { 1: [hint({ location: 1 })] } });

    // Claimed, but never opted in.
    claims.claim({ watchId: 0, slot: 'SlotA', userId: 'u1' });

    server.sendPacket({ cmd: 'SetReply', key: '_read_hints_0_1', value: [hint({ location: 42 })] });
    await new Promise(r => setTimeout(r, 250));

    assert.strictEqual(discord.posted.filter(p => String(p.content || '').includes('waiting on')).length, 0);
    assert.strictEqual(discord.dms.length, 0);
});

test('dm keeps it out of the channel entirely', async (t) => {
    resetStores();
    const { server, discord } = await connect(t, { hints: { 1: [hint({ location: 1 })] } });

    claims.claim({ watchId: 0, slot: 'SlotA', userId: 'u1' });
    claims.setHintPings(0, 'SlotA', 'dm');

    server.sendPacket({ cmd: 'SetReply', key: '_read_hints_0_1', value: [hint({ location: 99 })] });

    const dm = await waitFor(() => discord.dms[0], 'the direct message');
    assert.strictEqual(dm.userId, 'u1');
    assert.match(dm.payload.content, /waiting on/);
    // Choosing dm was a choice to keep this out of the channel; falling back there would undo it.
    assert.strictEqual(discord.posted.filter(p => String(p.content || '').includes('waiting on')).length, 0);
});

test('the finder is pinged, not the receiver', async (t) => {
    resetStores();
    const { server, discord } = await connect(t, { hints: { 1: [hint({ location: 1 })] } });

    // SlotB is the one waiting; SlotA is the one who has to go and dig it out.
    claims.claim({ watchId: 0, slot: 'SlotB', userId: 'receiver' });
    claims.setHintPings(0, 'SlotB', 'channel');
    claims.claim({ watchId: 0, slot: 'SlotA', userId: 'finder' });
    claims.setHintPings(0, 'SlotA', 'channel');

    server.sendPacket({
        cmd: 'SetReply',
        key: '_read_hints_0_1',
        value: [hint({ location: 777, finding_player: 1, receiving_player: 2 })]
    });

    const ping = await waitFor(
        () => discord.posted.find(p => String(p.content || '').includes('waiting on')),
        'the hint ping'
    );
    // The receiver placed the hint and already knows. Only the finder can act on it.
    assert.match(ping.content, /<@finder>/);
    assert.ok(!ping.content.includes('<@receiver>'), 'the person who asked is not notified');
});
