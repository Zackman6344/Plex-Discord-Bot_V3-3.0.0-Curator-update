// The live relay and the catch-up together, end to end: the first-sight baseline, a gap caught up
// after a restart, the settle window, the skip-goaled snapshot and what the store records for
// lines a filter hid. Floods and ordering are in archipelagoCatchupFlood.test.js, refused posts
// and pings in archipelagoCatchupRefusals.test.js; the harness is test/helpers/catchupRelay.js.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('catchuprelay');   // must run before any helper is required

const {
    config, catchup, monitor, ITEM_FLAG_PROGRESSION, closeServer, waitFor, ORIGIN, sleep, testDiscord,
    text, blocks, headers, timesPosted, setup, baselined, restarted
} = require('./helpers/catchupRelay.js');

test.after(() => stores.cleanup());

test('first sight records a silent baseline and posts nothing but the connect notice', async (t) => {
    const ctx = await setup(t, { tracker: { 1: [[1, 5001, 2, 0], [1, 5002, 2, 0]] }, statuses: { 1: 30 } });
    await baselined(ctx);
    // Nothing would post before the next flush window.
    await waitFor(() => ctx.entry().catchup.lastRunAt, 'the baseline run to finish');
    assert.deepStrictEqual(headers(ctx.posted), []);
    assert.deepStrictEqual(blocks(ctx.posted), []);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:5001'), true);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'g:1'), true);
    assert.strictEqual(ctx.room.calls[0].opts.origin, ORIGIN, 'the room\'s own web host, not archipelago.gg');
    assert.strictEqual(ctx.entry().catchup.available, true);
});

test('a live line still buffered when the first-sight baseline runs is posted once, not recorded as seen', async (t) => {
    // The tracker already shows the send while its live line waits out the batch window.
    const ctx = await setup(t, { batchSeconds: 1, timing: { settleMs: 400 } });
    ctx.server.sendItemSend({ receiving: 1, location: 5101 });
    ctx.add(1, [1, 5101, 2, 0]);
    await baselined(ctx);
    assert.strictEqual(timesPosted(ctx.posted, 5101), 0, 'the baseline ran while the line was buffered');

    await waitFor(() => timesPosted(ctx.posted, 5101) === 1, 'the buffered line', 5000);
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:5101'), 'its key recorded by the flush');
    const again = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(again.missed, 0);
    assert.strictEqual(timesPosted(ctx.posted, 5101), 1);
});

test('a gap is caught up under one header dated from the last post before it; a second run posts nothing', async (t) => {
    // Settle longer than the batch window, so a live line posts on the new connection BEFORE the
    // catch-up runs: the header must still date from the post before the gap.
    const ctx = await setup(t, { tracker: { 1: [[1, 6001, 2, 0]] }, timing: { settleMs: 700 } });
    await baselined(ctx);

    ctx.server.sendItemSend({ receiving: 1, location: 6002 });
    await waitFor(() => timesPosted(ctx.posted, 6002) === 1, 'the live line');
    ctx.add(1, [1, 6002, 2, 0]);
    await waitFor(() => catchup.record(ctx.watch.id, ctx.seed).lastPostedAt, 'the live line recorded');
    const before = catchup.record(ctx.watch.id, ctx.seed).lastPostedAt;

    // Down: two sends happen that the socket never saw.
    ctx.add(1, [1, 6003, 2, 0], [1, 6004, 2, ITEM_FLAG_PROGRESSION]);
    monitor.restartWatch(ctx.watch.id);
    await waitFor(() => ctx.entry().status === 'connected', 'the reconnect');
    ctx.server.sendItemSend({ receiving: 1, location: 6005 });
    ctx.add(1, [1, 6005, 2, 0]);

    await waitFor(() => headers(ctx.posted).length === 1 && timesPosted(ctx.posted, 6004) === 1, 'the catch-up');
    await waitFor(() => timesPosted(ctx.posted, 6005) === 1, 'the live line on the new connection');
    const header = text(headers(ctx.posted)[0]);
    assert.match(header, /2 line\(s\) missed since <t:(\d+):f>, rebuilt from the room tracker/);
    assert.strictEqual(Number(/<t:(\d+):f>/.exec(header)[1]), Math.floor(Date.parse(before) / 1000));
    assert.deepStrictEqual(headers(ctx.posted)[0].allowedMentions, { parse: [] });

    const missedBlock = blocks(ctx.posted).find(p => text(p).includes('[missed]'));
    assert.match(text(missedBlock), /\[missed\] .*Location#6003\)[\s\S]*\[missed\] .*Location#6004\)/);
    for (const loc of [6002, 6003, 6004, 6005]) {
        assert.strictEqual(timesPosted(ctx.posted, loc), 1, `Location#${loc}`);
    }
    assert.strictEqual(timesPosted(ctx.posted, 6001), 0, 'the baseline is never posted');

    const count = ctx.posted.length;
    const again = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.missed, 0);
    assert.strictEqual(ctx.posted.length, count);
});

test('a run inside the settle window posts what it finds and leaves the dated header and the retries to the settled run', async (t) => {
    const ctx = await setup(t, { tracker: { 1: [[1, 5501, 2, 0]] } });
    await baselined(ctx);
    monitor.catchupTiming.settleMs = 1500;

    // Down: one send the tracker already shows. Two more reach it only after the reconnect.
    ctx.add(1, [1, 5502, 2, 0]);
    const state = await restarted(ctx);
    const settledAt = state.connectedAt + 1500;

    const early = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(early.ok, true);
    assert.strictEqual(early.posted, 1);
    assert.strictEqual(early.settlingUntil, settledAt);
    assert.match(text(headers(ctx.posted)[0]), /1 line\(s\) missed since tracking began <t:\d+:f>/);
    const earlyReads = ctx.room.calls.length;

    // A live post Discord refuses inside the window. Its retry is due long before the settled run
    // and must not read the tracker ahead of it.
    let refused = false;
    ctx.discord.control.fail = (p) => {
        if (!refused && text(p).includes('Location#5510)')) {
            refused = true;
            return true;
        }
        return false;
    };
    ctx.server.sendItemSend({ receiving: 1, location: 5510 });
    ctx.add(1, [1, 5503, 2, 0], [1, 5510, 2, 0]);
    await waitFor(() => refused, 'the refused live post');

    await waitFor(() => headers(ctx.posted).length === 2, 'the settled run', 8000);
    assert.ok(ctx.room.calls.slice(earlyReads).every(c => c.at >= settledAt),
        `a tracker read ran inside the settle window: ${ctx.room.calls.map(c => c.at - settledAt)}`);
    assert.match(text(headers(ctx.posted)[1]), /2 line\(s\) missed since tracking began <t:\d+:f>/);
    for (const loc of [5502, 5503, 5510]) assert.strictEqual(timesPosted(ctx.posted, loc), 1, `Location#${loc}`);
});

test('a slot that finishes while nothing posts still counts as finished before the next gap', async (t) => {
    const statuses = {};
    const ctx = await setup(t, { statuses });
    monitor.setFilter(ctx.watch.id, 'goals', false);
    monitor.setSkipGoaled(ctx.watch.id, true);
    await baselined(ctx);

    // SlotA goals with the goals category off, so the channel stays quiet.
    ctx.server.sendGoal(1, 'SlotA (Team #1) has completed their goal.');
    statuses[1] = 30;
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'g:1'), 'the hidden goal recorded');
    assert.deepStrictEqual(blocks(ctx.posted), []);

    // The bot stops (the exit hook writes what was committed) and comes back. While it was down,
    // Watcher sent two items to the finished slot, which live would have hidden.
    catchup.persist();
    catchup.reset();
    ctx.add(1, [1, 5201, 2, 0], [1, 5202, 2, 0]);
    const restartAt = Date.now();
    await restarted(ctx);
    await waitFor(() => (ctx.entry().catchup.lastRunAt || 0) > restartAt, 'the settled run');

    assert.strictEqual(timesPosted(ctx.posted, 5201) + timesPosted(ctx.posted, 5202), 0);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:5201'), true, 'hidden keys are recorded');
    const again = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual([again.missed, again.hidden], [0, 0]);
});

test('lines a filter hid, live or caught up, are recorded so switching it back on dumps nothing', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    monitor.setFilter(ctx.watch.id, 'items', false);

    ctx.server.sendItemSend({ receiving: 1, location: 5301 });
    ctx.add(1, [1, 5301, 2, 0]);
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:5301'), 'the hidden live line recorded', 3000);

    ctx.add(1, [1, 5302, 2, 0]);
    const first = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual([first.missed, first.hidden], [0, 1], 'only the send the socket never saw');

    monitor.setFilter(ctx.watch.id, 'items', true);
    const again = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual([again.missed, again.hidden], [0, 0]);
    assert.strictEqual(timesPosted(ctx.posted, 5301) + timesPosted(ctx.posted, 5302), 0);
});

test('a send a catch-up already posted is not posted again when the socket delivers it', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.add(1, [1, 5401, 2, 0]);
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(result.posted, 1);

    ctx.server.sendItemSend({ receiving: 1, location: 5401 });
    ctx.server.sendItemSend({ receiving: 1, location: 5402 });
    await waitFor(() => timesPosted(ctx.posted, 5402) === 1, 'the next live line');
    assert.strictEqual(timesPosted(ctx.posted, 5401), 1);
});

test('a goal from another team is not recorded as this team\'s goal of the same slot number', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);

    ctx.server.sendPacket({ cmd: 'PrintJSON', type: 'Goal', team: 1, slot: 1, data: [{ text: 'Rival (Team #2) has completed their goal.' }] });
    await waitFor(() => ctx.posted.some(p => text(p).includes('Rival (Team #2)')), 'the other team\'s goal');
    // Recorded, it would hide this team's slot 1 goal from both the live feed and the catch-up.
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'g:1'), false);
});

test('first sight read too soon after connecting is settling; an unknown id is no-watch', async (t) => {
    const settling = await setup(t, { timing: { settleMs: 60000 } });
    // The goal and hint read lands a frame or two after 'connected'.
    let early = await monitor.catchUp(settling.watch.id, { manual: true });
    for (let i = 0; i < 40 && early.reason === 'loading'; i++) {
        await sleep(50);
        early = await monitor.catchUp(settling.watch.id, { manual: true });
    }
    assert.strictEqual(early.ok, false);
    assert.strictEqual(early.reason, 'settling');
    assert.ok(early.at > Date.now() + 50000);

    assert.deepStrictEqual(await monitor.catchUp(987654), { ok: false, reason: 'no-watch' });
});

test('a room whose goal and hint read never answers is still loading', async (t) => {
    const ctx = await setup(t, { answerGet: false });
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual(result, { ok: false, reason: 'loading' });
});

test('a host:port watch cannot catch up', async (t) => {
    const saved = config.archipelagoEnabled;
    config.archipelagoEnabled = false;
    const server = await ap.startFakeServer({ slots: ['SlotA', 'Watcher'], watchSlot: 2, seedName: 'Seed_DIRECT' });
    const discord = testDiscord();
    monitor.startArchipelagoMonitor(discord.client);
    const { watch } = await monitor.addWatch({ target: `localhost:${server.port}`, slot: 'Watcher', channelId: 'chan-d' }, 15000);
    t.after(async () => {
        monitor.removeWatch(watch.id);
        await closeServer(server.wss);
        config.archipelagoEnabled = saved;
    });
    assert.deepStrictEqual(await monitor.catchUp(watch.id, { manual: true }), { ok: false, reason: 'not-a-room' });
    const entry = monitor.listWatches().find(e => e.watch.id === watch.id);
    assert.strictEqual(entry.catchup.available, false);
});
