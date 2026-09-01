const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;

const client = require('../helpers/archipelagoClient.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const dataCache = require('../helpers/archipelagoData.js');

// --- target parsing -------------------------------------------------------------------

test('parseTarget accepts room URLs with or without a scheme', () => {
    const expected = { kind: 'room', roomUrl: 'https://archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA' };
    assert.deepStrictEqual(client.parseTarget('https://archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA'), expected);
    assert.deepStrictEqual(client.parseTarget('archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA'), expected);
    assert.deepStrictEqual(client.parseTarget('  <https://archipelago.gg/room/JZH8N_QpTZm4a9jNBcYtOA>  '), expected);
});

test('parseTarget accepts host:port and bare hosts', () => {
    assert.deepStrictEqual(client.parseTarget('archipelago.gg:38281'), { kind: 'direct', host: 'archipelago.gg', port: 38281 });
    assert.deepStrictEqual(client.parseTarget('ws://192.168.1.10:12345'), { kind: 'direct', host: '192.168.1.10', port: 12345 });
    assert.deepStrictEqual(client.parseTarget('localhost'), { kind: 'direct', host: 'localhost', port: client.DEFAULT_PORT });
});

test('parseTarget rejects nonsense and out-of-range ports', () => {
    assert.strictEqual(client.parseTarget(''), null);
    assert.strictEqual(client.parseTarget('   '), null);
    assert.strictEqual(client.parseTarget('archipelago.gg:99999'), null);
    assert.strictEqual(client.parseTarget('not a host at all'), null);
});

test('extractConnectAddress reads the address off a room page', () => {
    const html = `<p>You can connect to this room by using <span class="interactive"
        data-tooltip="...">'/connect archipelago.gg:49128'</span></p>`;
    assert.deepStrictEqual(client.extractConnectAddress(html), { host: 'archipelago.gg', port: 49128 });
    assert.strictEqual(client.extractConnectAddress('<p>The server is paused.</p>'), null);
    assert.strictEqual(client.extractConnectAddress(null), null);
});

// --- PrintJSON rendering --------------------------------------------------------------

const tables = {
    playerName: (slot) => ({ 1: 'Zack', 2: 'Alice' })[slot],
    gameForSlot: (slot) => ({ 1: 'Ocarina of Time', 2: 'A Link to the Past' })[slot],
    itemName: (game, id) => (game === 'A Link to the Past' && id === 5 ? 'Progressive Sword' : undefined),
    locationName: (game, id) => (game === 'Ocarina of Time' && id === 9 ? 'Kokiri Sword Chest' : undefined)
};

test('renderPrintJSON resolves player, item and location ids', () => {
    const packet = {
        cmd: 'PrintJSON',
        type: 'ItemSend',
        item: { item: 5, location: 9, player: 1, flags: 0b001 },
        data: [
            { type: 'player_id', text: '1' },
            { text: ' sent ' },
            { type: 'item_id', text: '5', player: 2 },
            { text: ' to ' },
            { type: 'player_id', text: '2' },
            { text: ' (' },
            { type: 'location_id', text: '9', player: 1 },
            { text: ')' }
        ]
    };

    const line = client.renderPrintJSON(packet, tables);
    assert.strictEqual(line.text, 'Zack sent Progressive Sword to Alice (Kokiri Sword Chest)');
    assert.strictEqual(line.group, 'items');
    assert.strictEqual(line.flags, client.ITEM_FLAG_PROGRESSION);
});

test('renderPrintJSON falls back to ids when a name is unknown', () => {
    const line = client.renderPrintJSON({
        type: 'Hint',
        data: [
            { type: 'player_id', text: '7' },
            { text: ' has ' },
            { type: 'item_id', text: '404', player: 7 }
        ]
    }, tables);
    assert.strictEqual(line.text, 'Player#7 has Item#404');
    assert.strictEqual(line.group, 'hints');
});

test('renderPrintJSON tolerates missing lookup tables and empty packets', () => {
    assert.strictEqual(client.renderPrintJSON({ data: [{ text: 'hello' }] }).text, 'hello');
    assert.strictEqual(client.renderPrintJSON({}).text, '');
    assert.strictEqual(client.renderPrintJSON({}).group, 'misc');
});

test('groupOf maps known types and buckets unknown ones as misc', () => {
    assert.strictEqual(client.groupOf('Goal'), 'goals');
    assert.strictEqual(client.groupOf('ServerChat'), 'chat');
    assert.strictEqual(client.groupOf('SomethingAddedIn2027'), 'misc');
});

// --- relay formatting -----------------------------------------------------------------

test('formatLine timestamps the line and defuses code fences', () => {
    const line = monitor.formatLine('player said ```rm -rf```', new Date(2026, 0, 2, 9, 5));
    assert.strictEqual(line, "[09:05] player said '''rm -rf'''");
});

test('chunkLines packs lines up to the limit without splitting them', () => {
    const chunks = monitor.chunkLines(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], 100);
    assert.strictEqual(chunks.length, 2);
    assert.ok(chunks.every(c => c.length <= 100));
    assert.strictEqual(chunks[0], `${'a'.repeat(40)}\n${'b'.repeat(40)}`);
});

test('chunkLines truncates a single line that cannot fit', () => {
    const chunks = monitor.chunkLines(['x'.repeat(50)], 20);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].length, 20);
    assert.ok(chunks[0].endsWith('…'));
});

test('shouldRelay honours category filters', () => {
    const watch = { filters: { ...monitor.DEFAULT_FILTERS, chat: false } };
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'items', flags: 0 }), true);
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'chat', flags: 0 }), false);
    // deaths default off — the DeathLink tag has to be requested explicitly
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'deaths', flags: 0 }), false);
});

test('progressionOnly drops filler item sends but keeps other categories', () => {
    const watch = { filters: { ...monitor.DEFAULT_FILTERS }, progressionOnly: true };
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'items', flags: 0b000 }), false);
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'items', flags: 0b100 }), false);
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'items', flags: 0b001 }), true);
    assert.strictEqual(monitor.shouldRelay(watch, { group: 'goals', flags: 0 }), true);
});

// --- data package cache ---------------------------------------------------------------

test('safeName strips path-significant characters', () => {
    assert.strictEqual(dataCache.safeName('A Link to the Past'), 'A_Link_to_the_Past');
    assert.strictEqual(dataCache.safeName('../../etc/passwd'), 'etc_passwd');
    assert.strictEqual(dataCache.safeName(''), 'unknown');
});

test('invert flips the name → id table the protocol sends', () => {
    const map = dataCache.invert({ Sword: 1, Shield: 2 });
    assert.strictEqual(map.get(1), 'Sword');
    assert.strictEqual(map.get(2), 'Shield');
    assert.strictEqual(dataCache.invert(null).size, 0);
});

test('data package cache round-trips and misses on a changed checksum', async () => {
    const game = `__ap_test_${Date.now()}`;
    const checksum = 'abc123';
    try {
        await dataCache.save(game, checksum, {
            item_name_to_id: { 'Test Item': 77 },
            location_name_to_id: { 'Test Location': 88 }
        });

        const hit = await dataCache.load(game, checksum);
        assert.ok(hit, 'expected a cache hit');
        assert.strictEqual(hit.items.get(77), 'Test Item');
        assert.strictEqual(hit.locations.get(88), 'Test Location');

        assert.strictEqual(await dataCache.load(game, 'different-checksum'), null);
    } finally {
        try { await fs.unlink(dataCache.cacheFilePath(game, checksum)); } catch (_) {}
    }
});

// --- item classification and colour ------------------------------------------------------

test('classifyItem reads the NetworkItem flag bits', () => {
    assert.strictEqual(client.classifyItem(0b000), 'filler');
    assert.strictEqual(client.classifyItem(0b001), 'progression');
    assert.strictEqual(client.classifyItem(0b010), 'useful');
    assert.strictEqual(client.classifyItem(0b100), 'trap');
    assert.strictEqual(client.classifyItem(undefined), 'filler');
    // A trap flagged progression as well reads as a trap: the warning matters more.
    assert.strictEqual(client.classifyItem(0b101), 'trap');
});

test('renderPrintJSON colours item parts by their own flags, not the packet headline', () => {
    const packet = {
        type: 'ItemSend',
        item: { item: 5, location: 9, player: 1, flags: 0b001 },
        data: [
            { type: 'item_id', text: '5', player: 2, flags: 0b001 },
            { text: ' and ' },
            { type: 'item_id', text: '6', player: 2, flags: 0b100 }
        ]
    };
    const tables = {
        gameForSlot: () => 'A Link to the Past',
        itemName: (game, id) => ({ 5: 'Progressive Sword', 6: 'Ice Trap' })[id]
    };

    const plain = client.renderPrintJSON(packet, tables);
    assert.strictEqual(plain.text, 'Progressive Sword and Ice Trap');
    assert.ok(!plain.text.includes(client.ANSI.reset), 'no escape codes unless asked for');

    const colored = client.renderPrintJSON(packet, tables, { ansi: true });
    assert.ok(colored.text.includes(client.ANSI.progression + 'Progressive Sword' + client.ANSI.reset));
    assert.ok(colored.text.includes(client.ANSI.trap + 'Ice Trap' + client.ANSI.reset));
    assert.strictEqual(colored.itemClass, 'progression');
});

test('renderPrintJSON leaves parts with no flags uncoloured', () => {
    const line = client.renderPrintJSON({
        type: 'Chat',
        data: [{ text: 'Alice: found it' }]
    }, {}, { ansi: true });
    assert.strictEqual(line.text, 'Alice: found it');
});

test('shouldRelay drops item sends to a finished slot only when asked', () => {
    const base = { filters: { ...monitor.DEFAULT_FILTERS } };
    const toGoaled = { group: 'items', flags: 1, recipientFinished: true };
    const toPlaying = { group: 'items', flags: 1, recipientFinished: false };

    assert.strictEqual(monitor.shouldRelay({ ...base, skipGoaled: true }, toGoaled), false);
    assert.strictEqual(monitor.shouldRelay({ ...base, skipGoaled: true }, toPlaying), true);
    assert.strictEqual(monitor.shouldRelay({ ...base, skipGoaled: false }, toGoaled), true);
    // Only item traffic is suppressed; a goal or a chat line from that slot still comes through.
    assert.strictEqual(monitor.shouldRelay({ ...base, skipGoaled: true }, { group: 'goals', flags: 0, recipientFinished: true }), true);
});

test('a null answer for the unused key spelling does not erase a real status', () => {
    // The live server answers "_read_client_status_0_1" with 30 and "client_status_0_1" with
    // null. Both arrive in one Retrieved, and treating the null as "not goaled" wiped the
    // status read one key earlier, which silently disabled the whole filter.
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 's' });
    c._absorbStatuses({
        '_read_client_status_0_1': 30,
        'client_status_0_1': null,
        '_read_client_status_0_2': 0,
        'client_status_0_2': null
    });
    assert.strictEqual(c.hasGoaled(1), true, 'a goal survives the null for the other spelling');
    assert.strictEqual(c.hasGoaled(2), false, 'and a real 0 still means not goaled');
    c.stop();
});

test('a released slot counts as finished, and survives a reconnect', () => {
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 's' });
    c.released.add('0:4');
    assert.strictEqual(c.hasFinished(4), true);
    assert.strictEqual(c.hasGoaled(4), false, 'released is tracked separately from goaled');

    // Reconnecting re-reads goals from the server but cannot re-read releases, so the set it
    // built by listening has to persist.
    c.goaled.add('0:5');
    c.goaled.clear();
    assert.strictEqual(c.hasFinished(4), true, 'release outlives the goal refresh');
    assert.strictEqual(c.finishedCount, 1);
    c.stop();
});

test('only the first connect is announced; reconnect churn stays out of the channel', () => {
    const state = { watch: { label: 'Configured room', slot: 'ZackWord' }, announcedConnected: false };

    const first = monitor.connectionNotice(state, 'connected', 'archipelago.gg:35217');
    assert.ok(first, 'the first connect is worth saying');
    assert.match(first, /ZackWord/);
    assert.match(first, /archipelago\.gg:35217/);

    state.announcedConnected = true;

    // A hosted room sleeps and returns on its own; none of that belongs in the channel.
    assert.strictEqual(monitor.connectionNotice(state, 'disconnected', 'closed (1006)'), null);
    assert.strictEqual(monitor.connectionNotice(state, 'error', 'cannot reach archipelago.gg:35217'), null);
    assert.strictEqual(monitor.connectionNotice(state, 'connecting', 'archipelago.gg:35217'), null);
    assert.strictEqual(monitor.connectionNotice(state, 'connected', 'archipelago.gg:35217'), null);
});

test('a drop before the first connect is still not announced', () => {
    // Nothing has been said yet, so a failing first attempt must not post either.
    const state = { watch: { label: 'x', slot: 's' }, announcedConnected: false };
    assert.strictEqual(monitor.connectionNotice(state, 'error', 'cannot reach host'), null);
    assert.strictEqual(monitor.connectionNotice(state, 'disconnected', 'closed'), null);
});

test('markers ride outside ANSI so they survive a client that ignores colour', () => {
    const packet = {
        type: 'ItemSend',
        data: [
            { type: 'item_id', text: '5', player: 2, flags: 0b001 },
            { text: ' and ' },
            { type: 'item_id', text: '6', player: 2, flags: 0b100 },
            { text: ' and ' },
            { type: 'item_id', text: '7', player: 2, flags: 0b000 }
        ]
    };
    const tables = {
        gameForSlot: () => 'g',
        itemName: (g, id) => ({ 5: 'Progressive Sword', 6: 'Ice Trap', 7: 'Rupee' })[id]
    };

    // Mobile: no ANSI honoured, so the marker is the only signal left.
    const plain = client.renderPrintJSON(packet, tables, { ansi: false, markers: true });
    assert.strictEqual(plain.text, '🟪 Progressive Sword and 🟥 Ice Trap and Rupee');
    assert.ok(!plain.text.includes(client.ANSI.reset));

    // Desktop: both, and the marker sits inside the colour span so it is coloured too.
    const both = client.renderPrintJSON(packet, tables, { ansi: true, markers: true });
    assert.ok(both.text.includes(client.ANSI.progression + '🟪 Progressive Sword' + client.ANSI.reset));
    assert.ok(both.text.includes(client.ANSI.trap + '🟥 Ice Trap' + client.ANSI.reset));

    // Filler is never marked: most sends are filler and marking them all is noise.
    assert.ok(!plain.text.includes('Rupee') || !/[🟪🟦🟥]\s*Rupee/.test(plain.text));
});

test('markers can be turned off independently of colour', () => {
    const packet = { type: 'ItemSend', data: [{ type: 'item_id', text: '5', player: 2, flags: 0b010 }] };
    const tables = { gameForSlot: () => 'g', itemName: () => 'Magic Cape' };

    assert.strictEqual(client.renderPrintJSON(packet, tables, { markers: false }).text, 'Magic Cape');
    assert.strictEqual(client.renderPrintJSON(packet, tables, { markers: true }).text, '🟦 Magic Cape');
    assert.strictEqual(client.MARKERS.filler, '', 'filler has no marker at all');
});

test('the bot does not relay its own join', () => {
    // Verbatim shape from the live room when the tracker attaches to slot 28.
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 'ZackWord' });
    c.slotId = 28;

    const ownJoin = {
        cmd: 'PrintJSON', type: 'Join', team: 0, slot: 28, tags: ['Tracker'],
        data: [{ text: "ZackWord (Team #1) tracking Wordipelago has joined. Client(0.6.1), ['Tracker']." }]
    };
    assert.strictEqual(c.isSelfPresence(ownJoin), true);
    assert.strictEqual(monitor.shouldRelay({ filters: { ...monitor.DEFAULT_FILTERS } }, { group: 'joins', self: true }), false);

    // The real player shares the slot but not the tags, and must still come through.
    const playerJoin = {
        cmd: 'PrintJSON', type: 'Join', team: 0, slot: 28, tags: ['AP'],
        data: [{ text: "ZackWord (Team #1) playing Wordipelago has joined. Client(0.6.1), ['AP']." }]
    };
    assert.strictEqual(c.isSelfPresence(playerJoin), false);
    assert.strictEqual(monitor.shouldRelay({ filters: { ...monitor.DEFAULT_FILTERS } }, { group: 'joins', self: false }), true);

    // Another slot's tracker is somebody else's business, but not ours to hide.
    assert.strictEqual(c.isSelfPresence({ type: 'Join', slot: 7, tags: ['Tracker'] }), false);
    c.stop();
});

test('isSelfPresence only ever matches presence packets', () => {
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 'ZackWord' });
    c.slotId = 28;
    // An item send addressed to our own slot is real traffic, not the bot talking about itself.
    assert.strictEqual(c.isSelfPresence({ type: 'ItemSend', slot: 28, tags: ['Tracker'] }), false);
    assert.strictEqual(c.isSelfPresence({ type: 'Chat', slot: 28, tags: ['Tracker'] }), false);
    assert.strictEqual(c.isSelfPresence({ type: 'Join', slot: 28 }), false, 'no tags means it cannot be identified as ours');
    assert.strictEqual(c.isSelfPresence(null), false);
    c.stop();
});

test('a deathlink tracker still recognises its own join', () => {
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 'ZackWord', deathlink: true });
    c.slotId = 28;
    assert.strictEqual(c.isSelfPresence({ type: 'Join', slot: 28, tags: ['Tracker', 'DeathLink'] }), true);
    // A plain tracker's join is not this connection's, so it is left alone.
    assert.strictEqual(c.isSelfPresence({ type: 'Join', slot: 28, tags: ['Tracker'] }), false);
    c.stop();
});

test('the connect welcome text is never relayed', () => {
    // Verbatim from the live room, sent to the connecting client alone. A hosted room cycles
    // every couple of hours, so this arrived on that cadence until it was suppressed.
    const c = new client.ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 'ZackWord' });
    c.slotId = 28;

    const tutorial = {
        cmd: 'PrintJSON',
        type: 'Tutorial',
        data: [{ text: 'Now that you are connected, you can use !help to list commands to run via the server. If your client supports it, you may have additional local commands you can list with /help.' }]
    };

    assert.strictEqual(c.isSelfDirected(tutorial), true);
    assert.strictEqual(c.isSelfPresence(tutorial), false, 'it is not a presence packet, just self-directed');
    assert.strictEqual(monitor.shouldRelay({ filters: { ...monitor.DEFAULT_FILTERS } }, { group: 'misc', self: true }), false);

    // The rest of the misc group is real room activity and still comes through.
    assert.strictEqual(c.isSelfDirected({ type: 'Countdown', data: [{ text: '3' }] }), false);
    assert.strictEqual(monitor.shouldRelay({ filters: { ...monitor.DEFAULT_FILTERS } }, { group: 'misc', self: false }), true);

    // And the join case still routes through the same flag.
    assert.strictEqual(c.isSelfDirected({ type: 'Join', slot: 28, tags: ['Tracker'] }), true);
    c.stop();
});

test('the first failure against a room URL is treated as the room waking up', () => {
    const c = new client.ArchipelagoClient({
        target: { kind: 'room', roomUrl: 'https://archipelago.gg/room/abcdefghijklmnop' },
        slot: 'ZackWord'
    });

    // Requesting the room page starts a paused room, and the port is not up yet.
    assert.strictEqual(c.isWakingRoom(), true);

    // A second failure in the same sequence is a real problem and still warns.
    c.attempt = 1;
    assert.strictEqual(c.isWakingRoom(), false);
    c.attempt = 5;
    assert.strictEqual(c.isWakingRoom(), false);
    c.stop();
});

test('a host:port target has no wake-up step, so its first failure is not excused', () => {
    const c = new client.ArchipelagoClient({
        target: { kind: 'direct', host: 'localhost', port: 38281 },
        slot: 'ZackWord'
    });
    assert.strictEqual(c.attempt, 0);
    assert.strictEqual(c.isWakingRoom(), false, 'a wrong host or port should say so the first time');
    c.stop();
});

test('a room that reconnects after a successful connect is excused again', () => {
    // attempt resets on a successful connect, so each two-hourly cycle gets one quiet attempt
    // rather than the allowance being spent once at boot.
    const c = new client.ArchipelagoClient({
        target: { kind: 'room', roomUrl: 'https://archipelago.gg/room/abcdefghijklmnop' },
        slot: 'ZackWord'
    });
    c.attempt = 3;
    assert.strictEqual(c.isWakingRoom(), false);
    c._handleConnected({ team: 0, slot: 28, players: [], slot_info: {} });
    assert.strictEqual(c.attempt, 0, 'a successful connect resets the counter');
    assert.strictEqual(c.isWakingRoom(), true);
    c.stop();
});
