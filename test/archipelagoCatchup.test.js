// The catch-up store and the pure half of the catch-up: which lines the tracker says the channel
// missed, and whether they read exactly as the live relay would have written them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('catchup');   // must run before any helper is required

const catchup = require('../helpers/archipelagoCatchup.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const { ArchipelagoClient, ITEM_FLAG_PROGRESSION } = require('../helpers/archipelagoClient.js');

test.after(() => stores.cleanup());

function fresh() {
    catchup.reset();
    try { fs.unlinkSync(catchup.CATCHUP_FILE); } catch (_) {}
}

function onDisk() {
    return JSON.parse(fs.readFileSync(catchup.CATCHUP_FILE, 'utf8')).reported;
}

// --- store ---------------------------------------------------------------------------------

test('committed keys survive a reset and reload, and the file holds arrays, never {}', () => {
    fresh();
    assert.strictEqual(catchup.baseline(1, 'SeedA', ['i:3:100', 'g:2', 'h:1:500'], { team: 0, finished: [4] }), true);
    catchup.commit(1, 'SeedA', ['i:3:101', 'i:5:7'], { postedAt: '2026-09-24T10:00:00.000Z', finished: [2, 4] });
    assert.strictEqual(catchup.persist(), true);

    const raw = onDisk()['1::SeedA'];
    assert.deepStrictEqual(raw.items, { 3: [100, 101], 5: [7] });
    assert.deepStrictEqual(raw.goals, [2]);
    assert.deepStrictEqual(raw.hints, ['1:500']);
    assert.deepStrictEqual(raw.finished, [2, 4]);
    assert.strictEqual(raw.lastPostedAt, '2026-09-24T10:00:00.000Z');
    assert.ok(raw.seededAt);

    catchup.reset();
    for (const key of ['i:3:100', 'i:3:101', 'i:5:7', 'g:2', 'h:1:500']) {
        assert.strictEqual(catchup.has(1, 'SeedA', key), true, key);
    }
    assert.strictEqual(catchup.has(1, 'SeedA', 'i:3:102'), false);
    assert.strictEqual(catchup.isSeeded(1, 'SeedA'), true);
    const rec = catchup.record(1, 'SeedA');
    assert.deepStrictEqual([...rec.finished], [2, 4]);
    assert.strictEqual(rec.lastPostedAt, '2026-09-24T10:00:00.000Z');
});

// With nothing committed after it, the baseline's own write is the only thing that can carry its
// keys to disk. A record written seeded but empty replays the whole room on the next boot.
test('a baseline with nothing after it reaches disk with every key and its finished slots', () => {
    fresh();
    assert.strictEqual(catchup.baseline(3, 'SeedOnly', ['i:2:5', 'g:3', 'h:1:9'], { team: 0, finished: [3] }), true);
    catchup.reset();
    for (const key of ['i:2:5', 'g:3', 'h:1:9']) {
        assert.strictEqual(catchup.has(3, 'SeedOnly', key), true, key);
    }
    assert.strictEqual(catchup.isSeeded(3, 'SeedOnly'), true);
    assert.deepStrictEqual([...catchup.record(3, 'SeedOnly').finished], [3]);
});

test('commit alone does not write, and an unseeded record is not seeded', () => {
    fresh();
    catchup.commit(2, 'SeedB', ['i:1:1']);
    assert.strictEqual(fs.existsSync(catchup.CATCHUP_FILE), false);
    assert.strictEqual(catchup.has(2, 'SeedB', 'i:1:1'), true);
    assert.strictEqual(catchup.isSeeded(2, 'SeedB'), false);
    assert.strictEqual(catchup.persist(), true);
    assert.ok(onDisk()['2::SeedB']);
});

test('the finished snapshot only grows, the file is compact, and a commit that changes nothing writes nothing', () => {
    fresh();
    catchup.baseline(1, 'Grow', ['g:1'], { team: 0, finished: [4] });
    catchup.commit(1, 'Grow', [], { finished: [2] });
    // A post made before the tracker poll or the status read knows of fewer finished slots.
    catchup.commit(1, 'Grow', ['i:3:1'], { postedAt: '2026-09-24T10:00:00.000Z', finished: [] });
    assert.strictEqual(catchup.persist(), true);
    assert.deepStrictEqual(onDisk()['1::Grow'].finished, [2, 4]);
    assert.ok(!fs.readFileSync(catchup.CATCHUP_FILE, 'utf8').includes('\n'), 'written without indentation');

    fs.unlinkSync(catchup.CATCHUP_FILE);
    catchup.commit(1, 'Grow', ['g:1', 'i:3:1'], { postedAt: '2026-09-24T10:00:00.000Z', finished: [2, 4] });
    assert.strictEqual(catchup.persist(), true);
    assert.strictEqual(fs.existsSync(catchup.CATCHUP_FILE), false, 'nothing new, so nothing written');
});

test('records are per watch: one channel posting a line says nothing about another', () => {
    fresh();
    catchup.baseline(1, 'Shared', ['i:1:1']);
    catchup.baseline(2, 'Shared', []);
    assert.strictEqual(catchup.has(1, 'Shared', 'i:1:1'), true);
    assert.strictEqual(catchup.has(2, 'Shared', 'i:1:1'), false);
});

test('forgetWatch drops only that watch, on disk too', () => {
    fresh();
    catchup.baseline(1, 'S1', ['g:1']);
    catchup.baseline(2, 'S1', ['g:1']);
    assert.strictEqual(catchup.forgetWatch(1), 1);
    catchup.reset();
    assert.strictEqual(catchup.isSeeded(1, 'S1'), false);
    assert.strictEqual(catchup.isSeeded(2, 'S1'), true);
});

test('a baseline for a new seed prunes that watch\'s old seeds and nobody else\'s', () => {
    fresh();
    catchup.baseline(1, 'Old', ['g:1']);
    catchup.baseline(2, 'Old', ['g:1']);
    catchup.baseline(1, 'New', ['g:2']);
    catchup.reset();
    assert.strictEqual(catchup.record(1, 'Old'), null);
    assert.strictEqual(catchup.isSeeded(1, 'New'), true);
    assert.strictEqual(catchup.isSeeded(2, 'Old'), true);
});

test('the exit hook is registered once and writes what was only committed', () => {
    fresh();
    const hooks = process[Symbol.for('plexbot.archipelagoCatchup.exitHooks')];
    assert.ok(hooks instanceof Set);
    const listeners = process.listeners('exit').length;

    // Loading the module a second time must not add a second 'exit' listener.
    const file = require.resolve('../helpers/archipelagoCatchup.js');
    const cached = require.cache[file];
    delete require.cache[file];
    try {
        require('../helpers/archipelagoCatchup.js');
    } finally {
        require.cache[file] = cached;
    }
    assert.strictEqual(process.listeners('exit').length, listeners);

    catchup.commit(3, 'Exit', ['g:9'], { postedAt: new Date().toISOString() });
    assert.strictEqual(fs.existsSync(catchup.CATCHUP_FILE), false);
    for (const hook of hooks) hook();
    assert.deepStrictEqual(onDisk()['3::Exit'].goals, [9]);
});

// --- buildCatchup ------------------------------------------------------------------------

const GAME = 'Test Game';
const NAMES = { 1: 'Alice', 2: 'Bob', 3: 'Carol', 4: 'Link', 5: 'Dave' };

/** A real client with its room tables filled in by hand, as a Connected would leave them. */
function makeClient({ watched = 2, aliases = {}, groups = {}, colorize = true } = {}) {
    const client = new ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: NAMES[watched], colorize });
    client.team = 0;
    client.slotId = watched;
    for (const [slot, name] of Object.entries(NAMES)) {
        client.players.set(`0:${slot}`, aliases[name] || name);
        client.slotNames.set(`0:${slot}`, name);
        client.slotGames.set(Number(slot), GAME);
    }
    for (const [group, members] of Object.entries(groups)) client.slotGroups.set(Number(group), new Set(members));
    client.itemNames.set(GAME, new Map([[10, 'Sword'], [11, 'Rupee'], [12, 'Bomb']]));
    client.locationNames.set(GAME, new Map([[100, 'Chest'], [101, 'Cave'], [102, 'Tower'], [500, 'Shop']]));
    return client;
}

const WATCH = { filters: { ...monitor.DEFAULT_FILTERS }, progressionOnly: false, skipGoaled: true };

function trackerOf(byReceiver, activity = []) {
    return {
        player_items_received: Object.entries(byReceiver).map(([player, items]) => ({ team: 0, player: Number(player), items })),
        activity_timers: activity
    };
}

function build(client, trackerData, over = {}) {
    return catchup.buildCatchup({
        tracker: trackerData,
        client,
        watch: over.watch || WATCH,
        reportedHas: over.reportedHas || (() => false),
        inflight: over.inflight || new Set(),
        finishedBefore: over.finishedBefore || new Set(),
        shouldRelay: monitor.shouldRelay
    });
}

/** What the live relay renders for a packet, through the client's own PrintJSON handler. */
async function liveText(client, packet) {
    let text = null;
    const listener = (line) => { text = line.text; };
    client.on('line', listener);
    await client._handlePacket(packet);
    client.off('line', listener);
    return text;
}

test('an item send renders byte for byte as the live line of the same packet', async () => {
    const client = makeClient();
    const plan = build(client, trackerOf({ 1: [[10, 100, 3, ITEM_FLAG_PROGRESSION]] }));
    assert.strictEqual(plan.lines.length, 1);
    const live = await liveText(client, {
        cmd: 'PrintJSON', type: 'ItemSend', receiving: 1,
        item: { item: 10, location: 100, player: 3, flags: ITEM_FLAG_PROGRESSION },
        data: [{ type: 'player_id', text: '3' }, { text: ' sent ' },
            { type: 'item_id', text: '10', player: 1, flags: ITEM_FLAG_PROGRESSION }, { text: ' to ' },
            { type: 'player_id', text: '1' }, { text: ' (' },
            { type: 'location_id', text: '100', player: 3 }, { text: ')' }]
    });
    assert.strictEqual(plan.lines[0].text, live);
    assert.match(live, /Carol sent .*Sword.* to Alice \(Chest\)/);
    assert.match(live, /\u001b\[0;35m/, 'the colour came through');
    assert.strictEqual(plan.lines[0].key, 'i:3:100');
});

test('a self-find reads "found their", as live does', async () => {
    const client = makeClient();
    const plan = build(client, trackerOf({ 3: [[11, 101, 3, 0]] }));
    const live = await liveText(client, {
        cmd: 'PrintJSON', type: 'ItemSend', receiving: 3,
        item: { item: 11, location: 101, player: 3, flags: 0 },
        data: [{ type: 'player_id', text: '3' }, { text: ' found their ' },
            { type: 'item_id', text: '11', player: 3, flags: 0 }, { text: ' (' },
            { type: 'location_id', text: '101', player: 3 }, { text: ')' }]
    });
    assert.strictEqual(plan.lines[0].text, live);
    assert.match(live, /Carol found their .*Rupee.* \(Cave\)/);
});

test('cheated and starting items (location <= 0) are skipped', () => {
    const client = makeClient();
    const plan = build(client, trackerOf({ 1: [[10, -1, 1, 0], [10, -1, 0, 0], [11, 100, 3, 0]] }));
    assert.deepStrictEqual(plan.lines.map(l => l.key), ['i:3:100']);
    assert.deepStrictEqual(plan.hidden, []);
});

test('an item-link item listed under every member renders once, to the group', () => {
    const client = makeClient({ groups: { 4: [1, 2] } });
    const trackerData = trackerOf({ 1: [[10, 100, 3, 0]], 2: [[10, 100, 3, 0]] });

    const shown = build(client, trackerData, { watch: { ...WATCH, skipGoaled: false } });
    assert.strictEqual(shown.lines.length, 1);
    assert.strictEqual(shown.lines[0].receiving, 4);
    assert.match(shown.lines[0].text, /Carol sent .*Sword.* to Link \(Chest\)/);

    // A group counts as finished from the start, exactly as live treats it.
    const skipped = build(client, trackerData);
    assert.deepStrictEqual(skipped.lines, []);
    assert.deepStrictEqual(skipped.hidden, ['i:3:100']);
});

test('filters: category off and progression-only hide lines as live would', () => {
    const client = makeClient();
    const trackerData = trackerOf({ 1: [[10, 100, 3, ITEM_FLAG_PROGRESSION], [11, 101, 3, 0]] });

    const off = build(client, trackerData, { watch: { ...WATCH, filters: { ...WATCH.filters, items: false } } });
    assert.deepStrictEqual(off.lines, []);
    assert.deepStrictEqual(off.hidden.sort(), ['i:3:100', 'i:3:101']);

    const prog = build(client, trackerData, { watch: { ...WATCH, progressionOnly: true } });
    assert.deepStrictEqual(prog.lines.map(l => l.key), ['i:3:100']);
    assert.deepStrictEqual(prog.hidden, ['i:3:101']);
});

test('skip-goaled uses the slots finished BEFORE the gap, not the ones finished now', () => {
    const client = makeClient();
    // Alice goaled during the gap: live showed her items right up to the goal, so they post.
    client.goaled.add('0:1');
    // Bob had finished before the bot went down: live would have hidden these.
    const trackerData = trackerOf({ 1: [[10, 100, 3, 0]], 2: [[11, 101, 3, 0]] });
    const plan = build(client, trackerData, { finishedBefore: new Set([2]) });
    // g:1 is Alice's goal line itself, which live also posted.
    assert.deepStrictEqual(plan.lines.map(l => l.key), ['i:3:100', 'g:1']);
    assert.deepStrictEqual(plan.hidden, ['i:3:101']);
});

test('reported and in-flight keys are neither posted nor hidden', () => {
    const client = makeClient();
    const trackerData = trackerOf({ 1: [[10, 100, 3, 0], [11, 101, 3, 0], [12, 102, 3, 0]] });
    const plan = build(client, trackerData, {
        reportedHas: key => key === 'i:3:100',
        inflight: new Set(['i:3:101'])
    });
    assert.deepStrictEqual(plan.lines.map(l => l.key), ['i:3:102']);
    assert.deepStrictEqual(plan.hidden, []);
});

test('a goal line uses the aliased display name and skips item-link groups', () => {
    const client = makeClient({ aliases: { Carol: 'Zed (Carol)' }, groups: { 4: [1, 2] } });
    client.goaled.add('0:3');
    client.goaled.add('0:4');
    client.goaled.add('1:3');   // another team's slot 3
    const plan = build(client, trackerOf({}));
    assert.deepStrictEqual(plan.lines.map(l => l.key), ['g:3']);
    assert.strictEqual(plan.lines[0].text, 'Zed (Carol) (Team #1) has completed their goal.');
    assert.strictEqual(plan.lines[0].line.group, 'goals');
});

test('hints: only those the live feed would have received, with their current status', () => {
    const client = makeClient({ watched: 2, groups: { 4: [1, 2] } });
    const hint = (over) => Object.assign({
        team: 0, receiving_player: 3, finding_player: 1, location: 100, item: 10,
        found: false, entrance: '', item_flags: 0, status: 0
    }, over);
    client.hints.set('0:2:100', hint({ finding_player: 2, location: 100, status: 30 }));      // W finds
    client.hints.set('0:1:101', hint({ receiving_player: 2, location: 101, found: true, status: 40 })); // W receives
    client.hints.set('0:1:102', hint({ receiving_player: 4, location: 102, status: 99, entrance: 'Back Door' })); // W's group
    client.hints.set('0:1:500', hint({ receiving_player: 3, location: 500 }));                // unrelated

    const plan = build(client, trackerOf({}));
    assert.deepStrictEqual(plan.lines.map(l => l.key), ['h:1:101', 'h:1:102', 'h:2:100']);
    const text = Object.fromEntries(plan.lines.map(l => [l.key, l.text]));
    assert.match(text['h:2:100'], /^\[Hint\]: Carol's .*Sword.* is at Chest in Bob's World\. \(priority\)$/);
    assert.match(text['h:1:101'], /\(found\)$/);
    assert.match(text['h:1:102'], /^\[Hint\]: Link's .* is at Tower in Alice's World at Back Door\. \(unknown\)$/);
});

test('item order respects every receiver\'s own order', () => {
    const client = makeClient();
    // Alice received a (Carol), then b (Dave), then c (Carol). Bob received d (Dave), then b.
    // b is an item-link style duplicate across both lists only for ordering; no group matches,
    // so it renders to the lowest receiver.
    const trackerData = trackerOf({
        1: [[10, 1, 3, 0], [11, 2, 5, 0], [12, 3, 3, 0]],
        2: [[10, 4, 5, 0], [11, 2, 5, 0]]
    }, [
        { team: 0, player: 3, time: 'Thu, 24 Sep 2026 20:00:00 GMT' },
        { team: 0, player: 5, time: 'Thu, 24 Sep 2026 21:00:00 GMT' }
    ]);
    const keys = build(client, trackerData, { watch: { ...WATCH, skipGoaled: false } }).lines.map(l => l.key);
    const at = (k) => keys.indexOf(k);
    assert.strictEqual(keys.length, 4);
    assert.ok(at('i:3:1') < at('i:5:2') && at('i:5:2') < at('i:3:3'), `Alice's order kept: ${keys}`);
    assert.ok(at('i:5:4') < at('i:5:2'), `Bob's order kept: ${keys}`);
    // Carol's last check is older than Dave's, so her run comes first.
    assert.strictEqual(keys[0], 'i:3:1');
});

test('collectKeys covers items, goals and hints whatever the filters say', () => {
    const client = makeClient({ watched: 2 });
    client.goaled.add('0:1');
    client.hints.set('0:2:5', { team: 0, receiving_player: 1, finding_player: 2, location: 5, item: 1, found: false, status: 0 });
    const keys = catchup.collectKeys({ tracker: trackerOf({ 1: [[10, 100, 3, 0], [10, -1, 1, 0]] }), client });
    assert.deepStrictEqual(keys.all, ['i:3:100', 'g:1', 'h:2:5']);
    assert.deepStrictEqual(keys.counts, { items: 1, goals: 1, hints: 1 });
});

test('chunkLines still packs exactly as before on top of the entry chunker', () => {
    const lines = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), '', 'x'.repeat(150)];
    assert.deepStrictEqual(monitor.chunkLines(lines, 100),
        [`${'a'.repeat(40)}\n${'b'.repeat(40)}`, `${'c'.repeat(40)}\n`, `${'x'.repeat(99)}…`]);
    const chunks = monitor.chunkEntries(lines.map((text, i) => ({ text, i })), 100);
    assert.deepStrictEqual(chunks.map(c => c.entries.map(e => e.i)), [[0, 1], [2, 3], [4]]);
});
