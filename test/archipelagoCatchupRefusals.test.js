// Posts Discord refuses, channels the bot cannot reach, claim pings and the archipelagoCatchup
// switch: what gets retried, how often, and who is pinged when. The harness is
// test/helpers/catchupRelay.js.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('catchuprefusals');   // must run before any helper is required

const {
    config, claims, catchup, monitor, ITEM_FLAG_PROGRESSION, waitFor, USER, sleep, text, blocks,
    headers, timesPosted, pingsFor, setup, baselined, restarted
} = require('./helpers/catchupRelay.js');

test.after(() => stores.cleanup());

// Short enough that a test waiting on a retry does not wait long.
const QUICK_RETRY = { timing: { retryMs: 150 } };

/** Refuse the first message containing Location#<loc>, once. */
function refuseOnce(ctx, loc) {
    const state = { refused: false };
    ctx.discord.control.fail = (payload) => {
        if (!state.refused && text(payload).includes(`Location#${loc})`)) {
            state.refused = true;
            return true;
        }
        return false;
    };
    return state;
}

const blockWith = (posted, loc) => blocks(posted).find(p => text(p).includes(`Location#${loc})`));

test('a live line is recorded only once it posts, and a failed post is recovered by the retry', async (t) => {
    const ctx = await setup(t, QUICK_RETRY);
    await baselined(ctx);

    const refusal = refuseOnce(ctx, 7001);
    ctx.server.sendItemSend({ receiving: 1, location: 7001 });
    ctx.add(1, [1, 7001, 2, 0]);
    await waitFor(() => refusal.refused, 'the failed send');
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:7001'), false, 'not recorded after a failed send');

    await waitFor(() => timesPosted(ctx.posted, 7001) === 1, 'the retry catch-up');
    assert.match(text(blockWith(ctx.posted, 7001)), /\[missed\]/);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:7001'), true);

    ctx.server.sendItemSend({ receiving: 1, location: 7002 });
    await waitFor(() => timesPosted(ctx.posted, 7002) === 1, 'a live line');
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:7002'), 'the live key recorded');
    assert.ok(ctx.entry().lineCount >= 2, 'lineCount counts posted lines');
    assert.strictEqual(ctx.entry().droppedLines, undefined);
});

test('a line still in the buffer is not also posted by a catch-up', async (t) => {
    const ctx = await setup(t, { batchSeconds: 0.6 });
    await baselined(ctx);

    ctx.server.sendItemSend({ receiving: 1, location: 7101 });
    ctx.add(1, [1, 7101, 2, 0]);
    // Long enough for the frame to reach the client; the catch-up then awaits its queue.
    await sleep(100);
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.missed, 0);

    await waitFor(() => timesPosted(ctx.posted, 7101) === 1, 'the buffered line');
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:7101'), 'its key recorded');
    assert.strictEqual(timesPosted(ctx.posted, 7101), 1);
});

test('catch-up pings are one summary line per claimant and slot, and live pings are untouched', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
    claims.setPings(ctx.watch.id, 'SlotA', 'all');

    ctx.add(1,
        [1, 8001, 2, ITEM_FLAG_PROGRESSION], [1, 8002, 2, ITEM_FLAG_PROGRESSION],
        [1, 8003, 2, 0], [1, 8004, 2, 0], [1, 8005, 2, 0]);
    let plan = null;
    const result = await monitor.catchUp(ctx.watch.id, { manual: true, onPlan: (p) => { plan = p; } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.posted, 5);
    assert.deepStrictEqual(plan, { missed: 5, hidden: 0 });

    const pings = pingsFor(ctx.posted, USER);
    assert.strictEqual(pings.length, 1);
    assert.strictEqual(text(pings[0]), `<@${USER}> \`SlotA\` — 5 missed item(s), 2 progression, see the catch-up above.`);
    assert.deepStrictEqual(pings[0].allowedMentions, { parse: [], users: [USER] });
    const pingAt = ctx.posted.indexOf(pings[0]);
    const blockAt = ctx.posted.indexOf(blockWith(ctx.posted, 8005));
    assert.ok(blockAt >= 0 && blockAt < pingAt, 'the ping follows its lines');

    ctx.server.sendItemSend({ receiving: 1, location: 8100, flags: ITEM_FLAG_PROGRESSION });
    await waitFor(() => pingsFor(ctx.posted, USER).length === 2, 'the live ping');
    assert.match(text(pingsFor(ctx.posted, USER)[1]), /`SlotA` — Watcher sent .*Item#1.* to SlotA \(Location#8100\)/);
});

test('a live ping waits for its line: a refused block pings nobody until the catch-up posts it', async (t) => {
    const ctx = await setup(t, QUICK_RETRY);
    await baselined(ctx);
    claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
    claims.setPings(ctx.watch.id, 'SlotA', 'all');

    refuseOnce(ctx, 7301);
    ctx.server.sendItemSend({ receiving: 1, location: 7301 });
    ctx.add(1, [1, 7301, 2, 0]);
    await waitFor(() => pingsFor(ctx.posted, USER).length >= 1, 'a ping');
    await waitFor(() => timesPosted(ctx.posted, 7301) === 1, 'the line, from the retry');

    const pings = pingsFor(ctx.posted, USER);
    assert.strictEqual(pings.length, 1);
    assert.strictEqual(text(pings[0]), `<@${USER}> \`SlotA\` — 1 missed item(s), see the catch-up above.`);
    assert.ok(ctx.posted.indexOf(blockWith(ctx.posted, 7301)) < ctx.posted.indexOf(pings[0]), 'the ping follows its line');
});

test('a channel that cannot be fetched still gets a retry, and the watch shows the catch-up failing until then', async (t) => {
    const ctx = await setup(t, { channelDown: true, ...QUICK_RETRY });
    await baselined(ctx);

    ctx.server.sendItemSend({ receiving: 1, location: 7401 });
    ctx.add(1, [1, 7401, 2, 0]);
    await waitFor(() => ctx.entry().catchup.failingSince, 'the failure noted');
    assert.strictEqual(ctx.entry().catchup.lastError, 'could not post to the channel');

    ctx.discord.control.fetchFails = false;
    await waitFor(() => timesPosted(ctx.posted, 7401) === 1, 'the retry', 5000);
    assert.match(text(blockWith(ctx.posted, 7401)), /\[missed\]/);
    await waitFor(() => ctx.entry().catchup.failingSince === null, 'the recovery noted');
});

test('a channel that refuses every post is retried less and less often', async (t) => {
    const ctx = await setup(t, { timing: { retryMs: 100 } });
    await baselined(ctx);

    ctx.discord.control.fail = () => true;
    ctx.server.sendItemSend({ receiving: 1, location: 7501 });
    ctx.add(1, [1, 7501, 2, 0]);
    // Set as soon as the live block is refused.
    await waitFor(() => ctx.entry().catchup.failingSince, 'the failure noted');
    assert.strictEqual(ctx.entry().catchup.lastError, 'could not post to the channel');
    const from = ctx.room.calls.length;
    await sleep(1000);
    // Retries 0.2, 0.4 and 0.8 s apart from here; at a flat 100 ms it would be about nine.
    const reads = ctx.room.calls.length - from;
    assert.ok(reads >= 1 && reads <= 3, `${reads} tracker reads in 1 s`);

    ctx.discord.control.fail = () => false;
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(result.posted, 1);
    assert.strictEqual(ctx.entry().catchup.failingSince, null);
});

// AutoMod matching an item name refuses the one message carrying it and accepts everything else,
// including each retry's header, so a backoff reset by any accepted send never backed off.
test('a line Discord keeps refusing is split from its neighbours, backed off, and skipped after three tries', async (t) => {
    const ctx = await setup(t, { timing: { retryMs: 100 } });
    await baselined(ctx);

    ctx.discord.control.fail = (payload) => text(payload).includes('Location#7601)');
    ctx.add(1, [1, 7601, 2, 0], [1, 7602, 2, 0]);
    const first = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual([first.missed, first.posted], [2, 0]);
    assert.ok(ctx.entry().catchup.failingSince, 'a run with a refused block is not a success');

    // Retried on its own, the good line posts; the bad one is refused twice more and then skipped.
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:7601'), 'the refused line skipped', 5000);
    assert.strictEqual(timesPosted(ctx.posted, 7602), 1);
    assert.strictEqual(timesPosted(ctx.posted, 7601), 0);

    const headerCount = headers(ctx.posted).length;
    assert.strictEqual(headerCount, 3, 'one header per attempt');
    await sleep(1000);
    assert.strictEqual(headers(ctx.posted).length, headerCount, 'nothing left to retry');
    assert.strictEqual(ctx.entry().catchup.failingSince, null);
});

test('with archipelagoCatchup off, a catch-up asked for inside the settle window still posts what the settled run finds', async (t) => {
    const ctx = await setup(t, { timing: { settleMs: 1500 } });
    await baselined(ctx);
    config.archipelagoCatchup = false;

    await restarted(ctx);
    const early = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(early.missed, 0);
    assert.ok(early.settlingUntil, 'answered from inside the settle window');

    // The tracker catches up after the command answered.
    ctx.add(1, [1, 9301, 2, 0]);
    await waitFor(() => timesPosted(ctx.posted, 9301) === 1, 'the settled run posting it', 5000);
});

// The tracker can take two minutes to show a send, and the first retry comes 30 seconds after the
// refusal. That retry found nothing, and the line then waited for the poll, or with the switch off
// was recorded by it without ever posting.
test('a refused line the tracker only shows after the first retry is still posted, with archipelagoCatchup off', async (t) => {
    const ctx = await setup(t, QUICK_RETRY);
    await baselined(ctx);
    config.archipelagoCatchup = false;

    const refusal = refuseOnce(ctx, 9401);
    ctx.server.sendItemSend({ receiving: 1, location: 9401 });
    await waitFor(() => refusal.refused, 'the refused live block');
    const reads = ctx.room.calls.length;
    await waitFor(() => ctx.room.calls.length > reads, 'the first retry reading a tracker without the line');
    await sleep(100);

    ctx.add(1, [1, 9401, 2, 0]);
    await waitFor(() => timesPosted(ctx.posted, 9401) === 1, 'the line, from a later retry', 5000);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:9401'), true);
});

test('with archipelagoCatchup off an automatic run records what it finds and posts nothing', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);

    config.archipelagoCatchup = false;
    ctx.add(1, [1, 9001, 2, 0], [1, 9002, 2, 0]);
    const restartedAt = Date.now();
    monitor.restartWatch(ctx.watch.id);
    await waitFor(() => (ctx.entry().catchup.lastRunAt || 0) > restartedAt, 'the automatic run');

    assert.deepStrictEqual(headers(ctx.posted), []);
    assert.strictEqual(timesPosted(ctx.posted, 9001), 0);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:9001'), true);

    config.archipelagoCatchup = true;
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.strictEqual(result.missed, 0, 'switching it back on dumps nothing');
});

test('with archipelagoCatchup off, lines Discord refused are still posted by their retry', async (t) => {
    const ctx = await setup(t, QUICK_RETRY);
    await baselined(ctx);
    config.archipelagoCatchup = false;

    // A live block.
    refuseOnce(ctx, 9101);
    ctx.server.sendItemSend({ receiving: 1, location: 9101 });
    ctx.add(1, [1, 9101, 2, 0]);
    await waitFor(() => timesPosted(ctx.posted, 9101) === 1, 'the refused live line, from the retry', 5000);
    assert.match(text(blockWith(ctx.posted, 9101)), /\[missed\]/);

    // A block of a catch-up somebody asked for.
    refuseOnce(ctx, 9102);
    ctx.add(1, [1, 9102, 2, 0]);
    const result = await monitor.catchUp(ctx.watch.id, { manual: true });
    assert.deepStrictEqual([result.missed, result.posted], [1, 0]);
    await waitFor(() => timesPosted(ctx.posted, 9102) === 1, 'the refused catch-up line, from the retry', 5000);
    assert.strictEqual(catchup.has(ctx.watch.id, ctx.seed, 'i:2:9102'), true);
});
