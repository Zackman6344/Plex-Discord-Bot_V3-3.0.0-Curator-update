// Floods, ordering and restarts on the per-watch pipeline: long flushes and catch-ups that a
// restart, a removal or a second burst lands in the middle of. The harness is
// test/helpers/catchupRelay.js.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('catchupflood');   // must run before any helper is required

const {
    claims, catchup, monitor, waitFor, USER, sleep, text, blocks, headers, timesPosted, pingsFor,
    hint, setup, baselined
} = require('./helpers/catchupRelay.js');
const hintStore = require('../helpers/archipelagoHints.js');

test.after(() => stores.cleanup());

const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const missedBlocks = (posted) => blocks(posted).filter(p => text(p).includes('[missed]'));

test('restartWatch during a slow multi-chunk flush posts each line once, in one unbroken run', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.discord.control.delayMs = 60;

    const locations = range(20000, 120);
    for (const location of locations) {
        ctx.server.sendItemSend({ receiving: 1, location });
        ctx.add(1, [1, location, 2, 0]);
    }
    await waitFor(() => blocks(ctx.posted).length >= 1, 'the first block');
    const restartedAt = Date.now();
    monitor.restartWatch(ctx.watch.id);

    await waitFor(() => locations.every(loc => timesPosted(ctx.posted, loc) >= 1), 'every line', 20000);
    await waitFor(() => (ctx.entry().catchup.lastRunAt || 0) > restartedAt, 'the new connection\'s catch-up', 20000);

    for (const loc of locations) assert.strictEqual(timesPosted(ctx.posted, loc), 1, `Location#${loc}`);
    const indexes = ctx.posted.map((p, i) => (/Location#20\d\d\d\)/.test(text(p)) ? i : -1)).filter(i => i >= 0);
    assert.ok(indexes.length >= 4, `expected several chunks, got ${indexes.length}`);
    assert.strictEqual(indexes[indexes.length - 1] - indexes[0], indexes.length - 1, 'nothing landed between the blocks');
    assert.deepStrictEqual(headers(ctx.posted), []);
});

test('a 300-line burst posts every line and no trim note', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);

    const locations = range(30000, 300);
    for (const location of locations) ctx.server.sendItemSend({ receiving: 1, location });
    await waitFor(() => locations.every(loc => timesPosted(ctx.posted, loc) === 1), 'all 300 lines', 20000);

    assert.ok(!ctx.posted.some(p => /trimmed/.test(text(p))), 'no trim note');
    for (const payload of ctx.posted) {
        assert.ok(text(payload).length <= 2000, `a message ran to ${text(payload).length} characters`);
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    }
    await waitFor(() => catchup.has(ctx.watch.id, ctx.seed, 'i:2:30299'), 'the last key recorded');
});

test('a second flush waits for a slow first one instead of landing between its blocks', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.discord.control.delayMs = 80;

    const first = range(40000, 120);
    for (const location of first) ctx.server.sendItemSend({ receiving: 1, location });
    await waitFor(() => blocks(ctx.posted).length >= 1, 'the first block of burst one');
    const second = range(49000, 10);
    for (const location of second) ctx.server.sendItemSend({ receiving: 1, location });

    await waitFor(() => [...first, ...second].every(loc => timesPosted(ctx.posted, loc) === 1), 'both bursts', 20000);
    const at = (re) => ctx.posted.map((p, i) => (re.test(text(p)) ? i : -1)).filter(i => i >= 0);
    const one = at(/Location#40\d\d\d\)/);
    const two = at(/Location#49\d\d\d\)/);
    assert.ok(one.length >= 3, `burst one should span several blocks, got ${one.length}`);
    assert.ok(Math.max(...one) < Math.min(...two), `burst two landed inside burst one: ${one} vs ${two}`);
});

test('removeWatch in the middle of a flood stops the posting', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.discord.control.delayMs = 50;

    for (const location of range(50000, 200)) ctx.server.sendItemSend({ receiving: 1, location });
    await waitFor(() => blocks(ctx.posted).length >= 1, 'the first block');
    monitor.removeWatch(ctx.watch.id);
    const after = blocks(ctx.posted).length;
    // Long enough for six more sends at 50 ms each had the flood kept going.
    await sleep(300);
    // At most the one send already under way when it was removed.
    assert.ok(blocks(ctx.posted).length <= after + 1, `kept posting: ${after} -> ${blocks(ctx.posted).length}`);
    assert.strictEqual(catchup.record(ctx.watch.id, ctx.seed), null, 'the record goes with the watch');
});

test('a live send that arrives while a catch-up is posting it is not posted a second time', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.discord.control.delayMs = 60;

    const locations = range(26000, 100);
    ctx.add(1, ...locations.map(location => [1, location, 2, 0]));
    const run = monitor.catchUp(ctx.watch.id, { manual: true });
    await waitFor(() => missedBlocks(ctx.posted).length >= 1, 'the first catch-up block');
    const last = locations[locations.length - 1];
    assert.strictEqual(timesPosted(ctx.posted, last), 0, 'still to come in the catch-up');
    // Not recorded yet when it arrives, so it is buffered; the catch-up then posts it first.
    ctx.server.sendItemSend({ receiving: 1, location: last });

    const result = await run;
    assert.strictEqual(result.posted, 100);
    ctx.server.sendItemSend({ receiving: 1, location: 26999 });
    await waitFor(() => timesPosted(ctx.posted, 26999) === 1, 'a later live line');
    assert.strictEqual(timesPosted(ctx.posted, last), 1);
});

test('a catch-up cut short by a restart still pings for the lines it posted', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
    claims.setPings(ctx.watch.id, 'SlotA', 'all');
    ctx.discord.control.delayMs = 60;

    const locations = range(27000, 100);
    ctx.add(1, ...locations.map(location => [1, location, 2, 0]));
    const run = monitor.catchUp(ctx.watch.id, { manual: true });
    await waitFor(() => missedBlocks(ctx.posted).length >= 1, 'the first catch-up block');
    monitor.restartWatch(ctx.watch.id);

    const result = await run;
    assert.strictEqual(result.reason, 'restarted');
    assert.ok(result.posted > 0 && result.posted < 100, `posted ${result.posted}`);

    // The replacement connection's own run posts the rest, with its own summary.
    await waitFor(() => locations.every(loc => timesPosted(ctx.posted, loc) === 1), 'the rest, after the reconnect', 10000);
    await waitFor(() => pingsFor(ctx.posted, USER).length === 2, 'a summary ping from each run', 5000);
    const counts = pingsFor(ctx.posted, USER).map(p => Number(/— (\d+) missed item\(s\)/.exec(text(p))[1]));
    assert.deepStrictEqual(counts, [result.posted, 100 - result.posted]);
});

test('a hint ping queued behind a slow flush is still sent when a restart lands first', async (t) => {
    const hints = { 1: [hint({ location: 1 })] };
    const ctx = await setup(t, { hints });
    await baselined(ctx);
    await waitFor(() => hintStore.isSeeded(ctx.seed), 'the hint baseline');
    claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
    claims.setHintPings(ctx.watch.id, 'SlotA', 'channel');

    ctx.discord.control.delayMs = 200;
    for (const location of range(28000, 60)) ctx.server.sendItemSend({ receiving: 1, location });
    await waitFor(() => blocks(ctx.posted).length >= 1, 'the first block of the flood');
    // The room stores the new hint, so the reconnect reads it back as well.
    hints[1] = [hint({ location: 1 }), hint({ location: 2 })];
    ctx.server.sendPacket({ cmd: 'SetReply', key: '_read_hints_0_1', value: hints[1] });
    await waitFor(() => monitor.listHints(ctx.watch.id).length === 2, 'the new hint, queued behind the flush');
    monitor.restartWatch(ctx.watch.id);

    await waitFor(() => pingsFor(ctx.posted, USER).length === 1, 'the hint ping', 8000);
    assert.match(text(pingsFor(ctx.posted, USER)[0]), /is waiting on \*\*Item#77\*\* from your world `SlotA` — it is at Location#2\./);
    await waitFor(() => range(28000, 60).every(loc => timesPosted(ctx.posted, loc) === 1), 'the flood');
    assert.strictEqual(pingsFor(ctx.posted, USER).length, 1);
});

test('a refused reconnect stops the catch-up timers', async (t) => {
    const ctx = await setup(t);
    await baselined(ctx);
    ctx.server.setRefuse(true);

    const state = monitor.restartWatch(ctx.watch.id);
    assert.ok(state.catchupPoll, 'a restart arms the periodic run');
    await waitFor(() => state.status === 'stopped', 'the refusal');
    assert.strictEqual(state.catchupPoll, null);
    assert.strictEqual(state.retryTimer, null);
    assert.strictEqual(state.connectTimer, null);
});
