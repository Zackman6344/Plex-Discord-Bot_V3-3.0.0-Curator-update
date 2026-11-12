// helpers/apMediaClient.js: the Plex Media game client, against a stand-in Archipelago server.
//
// What it has to get right, each a thing the observer client it is built on does differently or
// not at all: a Connect the server accepts from a game client (the game, items_handling 7, no
// Tracker tag, slot_data only when it is not already held); the item list kept by index, with a
// Sync when a frame was missed; checks and the goal going out only on a live connection, and
// saying so; InvalidPacket surfaced instead of dropped; a refused connection stopping for good;
// the room read again before every connection attempt; and a listener that throws, the base's
// 'status' listeners included, breaking nothing.
//
// Harness: the real client against test/helpers/apMediaServer.js on a loopback port, and, with no
// socket at all, frames fed through the client's own packet queue the way its socket feeds them
// (feed() below). A reconnect is stop() then start(), or the backoff timer's own callback run at
// once (backoffNow() below): nothing here waits out the 5 s backoff.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { ApMediaClient } = require('../helpers/apMediaClient.js');
const { ArchipelagoClient, CLIENT_VERSION } = require('../helpers/archipelagoClient.js');
const dataCache = require('../helpers/archipelagoData.js');
const contracts = require('../helpers/apMediaContracts.js');
const { startApMediaServer } = require('./helpers/apMediaServer.js');
const { waitFor } = require('./helpers/apServer.js');

const PLEX = 1;
const SLOT = 'ZackPlex';
const loc = (j) => contracts.checkId(j);
const unlock = (i) => contracts.unlockId(i);
const item = (id, location = -2, player = 0, flags = 1) => ({ item: id, location, player, flags, class: 'NetworkItem' });

// Every event the client can raise, in the order it raised them.
function record(client) {
	const events = [];
	for (const name of ['connected', 'items', 'checked', 'invalid', 'fatal', 'orphaned']) {
		client.on(name, (payload) => events.push({ name, payload }));
	}
	return events;
}

const named = (events, name) => events.filter(event => event.name === name).map(event => event.payload);

async function serve(t, options = {}) {
	const server = await startApMediaServer(options);
	t.after(() => server.close());
	return server;
}

function connect(t, server, options = {}) {
	const client = new ApMediaClient({ target: server.target, slot: SLOT, label: 'test', ...options });
	t.after(() => client.stop());
	const events = record(client);
	client.start();
	return { client, events };
}

// The socket's message handler queues a whole frame before any of it runs. This does the same, then
// waits until the queue stops growing, since a Connected adds its inventory settle to it.
async function feed(client, packets) {
	for (const packet of packets) {
		client.queue = client.queue.then(() => client._handlePacket(packet));
	}
	let tail;
	do {
		tail = client.queue;
		await tail;
	} while (tail !== client.queue);
}

// A client with no socket: what it sends is captured instead of dropped.
function offline(options = {}) {
	const client = new ApMediaClient({ target: { kind: 'direct', host: '127.0.0.1', port: 9 }, slot: SLOT, label: 'offline', ...options });
	const sent = [];
	client._send = (packet) => sent.push(packet);
	return { client, sent, events: record(client) };
}

// What the backoff timer does when it fires, done now instead of seconds from now.
function backoffNow(client) {
	clearTimeout(client.reconnectTimer);
	return client._open();
}

const connectedPacket = (extra = {}) => ({
	cmd: 'Connected', team: 0, slot: PLEX,
	players: [{ team: 0, slot: PLEX, name: SLOT, alias: SLOT }],
	slot_info: { [PLEX]: { name: SLOT, game: contracts.GAME, type: 1 } },
	missing_locations: [loc(1)], checked_locations: [], hint_points: 0,
	...extra,
});

// --- the connection ---------------------------------------------------------------------

test('connects as a Plex Media game client, not as an observer', async (t) => {
	const slotData = { schema: 1, game: contracts.GAME, entries: [] };
	const server = await serve(t, {
		slotData: { [PLEX]: slotData },
		locations: { [PLEX]: [loc(1), loc(2), loc(3)] },
		checked: { [PLEX]: [loc(1)] },
	});
	const asked = [];
	const { client, events } = connect(t, server, { hasSlotData: (seed, slot) => { asked.push([seed, slot]); return false; } });
	await waitFor(() => named(events, 'items').length === 1, 'the inventory');

	const hello = server.received.find(packet => packet.cmd === 'Connect');
	assert.strictEqual(hello.game, 'Plex Media');
	assert.strictEqual(hello.name, SLOT);
	assert.strictEqual(hello.items_handling, 7, 'own-world items and the start inventory need bits 1 and 2');
	assert.deepStrictEqual(hello.tags, ['AP', 'PlexMediaBot', 'NoText']);
	assert.ok(!hello.tags.includes('Tracker'), 'the server refuses checks from a Tracker');
	assert.strictEqual(hello.slot_data, true);
	assert.strictEqual(hello.password, null);
	assert.deepStrictEqual(hello.version, CLIENT_VERSION);
	assert.deepStrictEqual(asked, [['Seed_PLEX', SLOT]], 'asked about the seed RoomInfo named');

	// No data package and no room-wide goal and hint read: this client never shows a name.
	assert.deepStrictEqual(server.received.map(packet => packet.cmd), ['Connect']);

	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items']);
	const [hello2] = named(events, 'connected');
	assert.strictEqual(hello2.seedName, 'Seed_PLEX');
	assert.strictEqual(hello2.team, 0);
	assert.strictEqual(hello2.slot, SLOT);
	assert.strictEqual(hello2.slotId, PLEX);
	assert.deepStrictEqual(hello2.slotData, slotData);
	assert.deepStrictEqual(hello2.checked, new Set([loc(1)]));
	assert.deepStrictEqual(hello2.missing, new Set([loc(2), loc(3)]));
	assert.deepStrictEqual(named(events, 'items')[0], { items: [], added: [] }, 'an empty slot still says so');
	assert.strictEqual(client.isReady, true);
	assert.strictEqual(client.inventoryKnown, true);
});

test('slot_data already held for the seed is not asked for again', async (t) => {
	const server = await serve(t, { slotData: { [PLEX]: { schema: 1 } } });
	const { client, events } = connect(t, server, { hasSlotData: (seed, slot) => seed === 'Seed_PLEX' && slot === SLOT });
	await waitFor(() => named(events, 'connected').length === 1, 'the connection');

	assert.strictEqual(server.received.find(packet => packet.cmd === 'Connect').slot_data, false);
	assert.strictEqual(named(events, 'connected')[0].slotData, null);
	assert.strictEqual(client.slotData, null);
});

test('RoomInfo loads no data package and asks for none, while the observer still does', async (t) => {
	const loads = [];
	const realLoad = dataCache.load;
	dataCache.load = async (...args) => { loads.push(args); return null; };
	t.after(() => { dataCache.load = realLoad; });
	const roomInfo = {
		cmd: 'RoomInfo', games: ['Plex Media', 'ChecksFinder'],
		datapackage_checksums: { 'Plex Media': 'sum-a', ChecksFinder: 'sum-b' }, password: false, seed_name: 'Seed_DP',
	};

	const { client, sent } = offline({ hasSlotData: (seed) => seed === 'Seed_DP' });
	await feed(client, [roomInfo]);
	assert.deepStrictEqual(loads, []);
	assert.deepStrictEqual(sent.map(packet => packet.cmd), ['Connect']);
	assert.strictEqual(sent[0].slot_data, false, 'held for this seed');

	// No seed name, nothing to key a held copy on: ask.
	const unnamed = offline({ hasSlotData: () => true });
	await feed(unnamed.client, [{ ...roomInfo, seed_name: undefined }]);
	assert.strictEqual(unnamed.sent.at(-1).slot_data, true);

	const observer = new ArchipelagoClient({ target: { kind: 'direct', host: '127.0.0.1', port: 9 }, slot: 'Watcher' });
	const observerSent = [];
	observer._send = (packet) => observerSent.push(packet);
	await observer._handlePacket(roomInfo);
	assert.strictEqual(loads.length, 2);
	assert.deepStrictEqual(observerSent.map(packet => packet.cmd), ['GetDataPackage', 'Connect']);
	assert.deepStrictEqual(observerSent[1].tags, ['Tracker']);
});

// --- items --------------------------------------------------------------------------------

test('the start inventory shares the Connected frame, and later items append', async (t) => {
	const server = await serve(t, { startInventory: { [PLEX]: [{ item: unlock(1), flags: 1 }, { item: unlock(2), flags: 1 }] } });
	const { client, events } = connect(t, server);
	await waitFor(() => named(events, 'items').length === 1, 'the start inventory');

	const frame = server.frames.find(sent => sent.packets.some(packet => packet.cmd === 'Connected'));
	assert.deepStrictEqual(frame.packets.map(packet => packet.cmd), ['Connected', 'ReceivedItems']);
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items'], 'one items event, not two');
	const [first] = named(events, 'items');
	assert.deepStrictEqual(first.items.map(got => [got.item, got.location, got.player]), [[unlock(1), -2, 0], [unlock(2), -2, 0]]);
	assert.deepStrictEqual(first.added, first.items);

	server.pushItems(PLEX, [{ item: unlock(3), location: 55, player: 2, flags: 1 }]);
	await waitFor(() => named(events, 'items').length === 2, 'the next item');
	assert.deepStrictEqual(named(events, 'items')[1].added.map(got => got.item), [unlock(3)]);
	assert.deepStrictEqual(client.items.map(got => got.item), [unlock(1), unlock(2), unlock(3)]);
});

test('a lost items frame is noticed at the next one and repaired with a Sync', async (t) => {
	const server = await serve(t, { startInventory: { [PLEX]: [{ item: unlock(1), flags: 1 }] } });
	const { client, events } = connect(t, server);
	await waitFor(() => client.inventoryKnown, 'the start inventory');

	server.loseItems(PLEX, [{ item: unlock(2), location: 70, player: 2, flags: 1 }]);
	server.pushItems(PLEX, [{ item: unlock(3), location: 71, player: 2, flags: 1 }]);
	await waitFor(() => client.items.length === 3, 'the repaired list');

	assert.strictEqual(server.received.filter(packet => packet.cmd === 'Sync').length, 1);
	assert.deepStrictEqual(client.items.map(got => got.item), [unlock(1), unlock(2), unlock(3)]);
	assert.strictEqual(named(events, 'items').length, 2, 'the out-of-step frame raised nothing');
	assert.deepStrictEqual(named(events, 'items')[1].added.map(got => got.item), [unlock(2), unlock(3)]);
});

test('one items event follows every Connected, whether or not items came with it', async () => {
	const { client, events } = offline();
	await feed(client, [connectedPacket()]);
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items']);
	assert.deepStrictEqual(named(events, 'items')[0], { items: [], added: [] });

	// A reconnect: the list starts again from the frame's own index 0.
	const start = [item(unlock(1)), item(unlock(2))];
	await feed(client, [connectedPacket(), { cmd: 'ReceivedItems', index: 0, items: start }]);
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items', 'connected', 'items']);
	assert.deepStrictEqual(named(events, 'items')[1], { items: start, added: start });
	assert.strictEqual(client.inventoryKnown, true);
});

test('a reconnect to a slot that now holds nothing empties the list, and says so', async () => {
	const { client, events } = offline();
	const atConnected = [];
	client.on('connected', () => atConnected.push({ known: client.inventoryKnown, held: client.items.length }));
	const a = item(unlock(1));
	await feed(client, [{ cmd: 'RoomInfo', games: [contracts.GAME], seed_name: 'Seed_OLD' }]);
	await feed(client, [connectedPacket(), { cmd: 'ReceivedItems', index: 0, items: [a] }]);
	assert.deepStrictEqual(client.items, [a]);

	// Say the watch was re-pointed at a new seed whose slot starts empty. The server sends that
	// slot no ReceivedItems at all, so only the reset at Connected keeps the old seed's items out.
	await feed(client, [{ cmd: 'RoomInfo', games: [contracts.GAME], seed_name: 'Seed_NEW' }]);
	await feed(client, [connectedPacket()]);
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items', 'connected', 'items']);
	assert.strictEqual(named(events, 'connected')[1].seedName, 'Seed_NEW');
	assert.deepStrictEqual(named(events, 'items')[1], { items: [], added: [] });
	assert.deepStrictEqual(client.items, []);
	assert.strictEqual(client.inventoryKnown, true);
	assert.deepStrictEqual(atConnected, [{ known: false, held: 0 }, { known: false, held: 0 }],
		'unknown from each Connected until its frame has been handled');
});

test('items append by index; a gap asks for a Sync and changes nothing', async () => {
	const { client, sent, events } = offline();
	const a = item(unlock(1));
	const b = item(unlock(2), loc(5), 2);
	const c = item(unlock(3), loc(6), 2);
	await feed(client, [connectedPacket(), { cmd: 'ReceivedItems', index: 0, items: [a] }]);
	await feed(client, [{ cmd: 'ReceivedItems', index: 1, items: [b] }]);
	assert.deepStrictEqual(client.items, [a, b]);
	assert.deepStrictEqual(named(events, 'items').at(-1).added, [b]);

	const before = events.length;
	await feed(client, [{ cmd: 'ReceivedItems', index: 3, items: [c] }]);
	assert.deepStrictEqual(sent.map(packet => packet.cmd), ['Sync']);
	assert.strictEqual(events.length, before);
	assert.deepStrictEqual(client.items, [a, b]);

	// The server answers a Sync with everything at index 0; only what was missing is news.
	await feed(client, [{ cmd: 'ReceivedItems', index: 0, items: [a, b, c] }]);
	assert.deepStrictEqual(named(events, 'items').at(-1), { items: [a, b, c], added: [c] });
});

test('a listener that throws cannot stall the client', async () => {
	const { client, events } = offline();
	client.on('connected', () => { throw new Error('a listener bug'); });
	// The base emits 'status' inside its own Connected handling, before this class's runs.
	client.on('status', () => { throw new Error('a status listener bug'); });
	await feed(client, [connectedPacket(), { cmd: 'ReceivedItems', index: 0, items: [item(unlock(1))] }]);
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items']);
	assert.strictEqual(client.connected, true);
	assert.strictEqual(client.inventoryKnown, true);
	assert.strictEqual(client.items.length, 1);
});

test('a status listener that throws cannot keep the client from connecting or reconnecting', async (t) => {
	const server = await serve(t);
	const client = new ApMediaClient({ target: server.target, slot: SLOT, label: 'test' });
	t.after(() => client.stop());
	const events = record(client);
	const statuses = [];
	client.on('status', (status) => {
		statuses.push(status.state);
		throw new Error('a status listener bug');
	});
	client.start();
	await waitFor(() => client.isReady && client.inventoryKnown, 'the connection');
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items']);

	server.clientsOn(PLEX)[0].socket.terminate();
	await waitFor(() => client.reconnectTimer !== null, 'the backoff timer');
	await backoffNow(client);
	await waitFor(() => named(events, 'connected').length === 2, 'the reconnect');
	assert.deepStrictEqual(statuses, ['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
});

test('a status listener that stops the client during Connected leaves no connection behind', async () => {
	const { client, events } = offline();
	client.on('status', (status) => { if (status.state === 'connected') client.stop(); });
	await feed(client, [connectedPacket(), { cmd: 'ReceivedItems', index: 0, items: [item(unlock(1))] }]);
	assert.deepStrictEqual(events, []);
	assert.strictEqual(client.connected, false);
	assert.strictEqual(client.inventoryKnown, false);
	assert.deepStrictEqual(client.items, []);
});

test('a status listener that restarts the client during Connected leaves it to the next connection', async (t) => {
	const server = await serve(t);
	const client = new ApMediaClient({ target: server.target, slot: SLOT, label: 'test' });
	t.after(() => client.stop());
	const events = record(client);
	let restarted = false;
	client.on('status', (status) => {
		if (status.state !== 'connected' || restarted) return;
		restarted = true;
		client.stop();
		client.start();
	});
	client.start();
	await waitFor(() => server.connectionsOpened === 2 && client.isReady && client.inventoryKnown, 'the second connection');
	assert.deepStrictEqual(events.map(event => event.name), ['connected', 'items'], 'nothing for the connection given up');
});

// --- checks and the goal ------------------------------------------------------------------

test('checks go out once, as whole numbers, and come back as checked', async (t) => {
	const server = await serve(t, {
		locations: { [PLEX]: [loc(1), loc(2), loc(3), loc(4)] },
		placements: { [loc(2)]: { item: unlock(9), player: PLEX, flags: 1 } },
	});
	const { client, events } = connect(t, server);
	await waitFor(() => client.isReady && client.inventoryKnown, 'the connection');

	assert.strictEqual(client.sendChecks([String(loc(2)), loc(2), loc(3), 'nonsense', null, loc(99)]), true);
	await waitFor(() => named(events, 'checked').length === 1, 'the RoomUpdate');

	assert.deepStrictEqual(server.received.filter(packet => packet.cmd === 'LocationChecks').map(packet => packet.locations), [[loc(2), loc(3), loc(99)]]);
	assert.deepStrictEqual(named(events, 'checked')[0].ids, [loc(2), loc(3)], 'only the slot\'s own register');
	assert.ok(client.checkedLocations.has(loc(2)) && client.checkedLocations.has(loc(3)));
	assert.ok(!client.missingLocations.has(loc(2)) && client.missingLocations.has(loc(4)));

	// loc(2) held the slot's own unlock, which the server sends before its RoomUpdate.
	const order = events.map(event => event.name);
	assert.ok(order.lastIndexOf('items') < order.indexOf('checked'));
	assert.deepStrictEqual(named(events, 'items').at(-1).added.map(got => [got.item, got.location, got.player]), [[unlock(9), loc(2), PLEX]]);
});

test('the goal goes out as StatusUpdate 30', async (t) => {
	const server = await serve(t);
	const { client } = connect(t, server);
	await waitFor(() => client.isReady, 'the connection');

	assert.strictEqual(client.sendGoal(), true);
	await waitFor(() => server.statuses.get(PLEX) === contracts.CLIENT_GOAL, 'the goal on the server');
	assert.deepStrictEqual(server.received.filter(packet => packet.cmd === 'StatusUpdate'), [{ cmd: 'StatusUpdate', status: 30 }]);
});

test('nothing goes out while not connected, and the caller is told', async (t) => {
	const server = await serve(t, { locations: { [PLEX]: [loc(1)] } });
	const client = new ApMediaClient({ target: server.target, slot: SLOT, label: 'test' });
	t.after(() => client.stop());
	assert.strictEqual(client.isReady, false);
	assert.strictEqual(client.sendChecks([loc(1)]), false);
	assert.strictEqual(client.sendGoal(), false);

	client.start();
	await waitFor(() => client.isReady, 'the connection');
	client.stop();
	assert.strictEqual(client.sendChecks([loc(1)]), false);
	assert.strictEqual(client.sendGoal(), false);
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.deepStrictEqual(server.received.map(packet => packet.cmd), ['Connect']);
});

test('a socket that is already closing counts as down', () => {
	// `connected` stays true until the socket's 'close' event, and ws drops a frame sent on a
	// closing socket without throwing.
	const { client } = offline();
	const frames = [];
	client.connected = true;
	client.socket = { readyState: WebSocket.CLOSING, send: (data) => frames.push(JSON.parse(data)) };
	assert.strictEqual(client.isReady, false);
	assert.strictEqual(client.sendChecks([loc(1)]), false);
	assert.strictEqual(client.sendGoal(), false);
	assert.deepStrictEqual(frames, []);

	client.socket.readyState = WebSocket.OPEN;
	assert.strictEqual(client.isReady, true);
	assert.strictEqual(client.sendChecks([loc(1)]), true);
	assert.strictEqual(client.sendGoal(), true);
	assert.deepStrictEqual(frames, [[{ cmd: 'LocationChecks', locations: [loc(1)] }], [{ cmd: 'StatusUpdate', status: 30 }]]);
	client.socket = null;
});

test('checks sent from a connected listener go out on the new connection', async (t) => {
	const pending = [loc(1), loc(2), loc(3)];
	const server = await serve(t, { locations: { [PLEX]: pending } });
	const { client, events } = connect(t, server);
	await waitFor(() => client.isReady, 'the first connection');
	client.stop();
	await waitFor(() => server.clientsOn(PLEX).length === 0, 'the first socket to close');
	assert.strictEqual(client.sendChecks(pending), false, 'while down they stay the caller\'s to keep');

	const results = [];
	client.on('connected', () => results.push(client.sendChecks(pending)));
	client.start();
	await waitFor(() => named(events, 'checked').length === 1, 'the checks to register');

	assert.deepStrictEqual(results, [true], 'connected is already true when the event fires');
	assert.strictEqual(server.connectionsOpened, 2);
	assert.deepStrictEqual(server.received.filter(packet => packet.cmd === 'LocationChecks').map(packet => packet.locations), [pending]);
	assert.deepStrictEqual(named(events, 'checked')[0].ids, pending);
});

test('checks registered by the slot\'s other client are reported too', async (t) => {
	const server = await serve(t, { locations: { [PLEX]: [loc(1), loc(4)] } });
	const { client, events } = connect(t, server);
	await waitFor(() => client.isReady, 'the connection');

	server.checkFromElsewhere(PLEX, [loc(4)]);
	await waitFor(() => named(events, 'checked').length === 1, 'the RoomUpdate');
	assert.deepStrictEqual(named(events, 'checked')[0].ids, [loc(4)]);
	assert.ok(client.checkedLocations.has(loc(4)));
});

test('RoomUpdate: nothing checked raises nothing, and the base still reads the players', async () => {
	const { client, events } = offline();
	await feed(client, [connectedPacket({ missing_locations: [loc(1), loc(2)] })]);
	await feed(client, [{ cmd: 'RoomUpdate', checked_locations: [] }]);
	assert.deepStrictEqual(named(events, 'checked'), []);

	await feed(client, [{
		cmd: 'RoomUpdate', checked_locations: [loc(2), String(loc(2))],
		players: [{ team: 0, slot: PLEX, name: SLOT, alias: 'Zack (afk)' }],
	}]);
	assert.deepStrictEqual(named(events, 'checked'), [{ ids: [loc(2)] }]);
	assert.ok(client.checkedLocations.has(loc(2)) && !client.missingLocations.has(loc(2)));
	assert.strictEqual(client.lookupTables().playerName(PLEX), 'Zack (afk)');
});

// --- what the server refuses --------------------------------------------------------------

test('a client the server takes for a tracker hears why its checks and goal were refused', async (t) => {
	class Misconfigured extends ApMediaClient {
		get tags() { return ['Tracker']; }
	}
	const server = await serve(t, { locations: { [PLEX]: [loc(1)] } });
	const client = new Misconfigured({ target: server.target, slot: SLOT, label: 'test' });
	t.after(() => client.stop());
	const events = record(client);
	client.start();
	await waitFor(() => client.isReady && client.inventoryKnown, 'the connection');

	assert.strictEqual(client.sendChecks([loc(1)]), true, 'the packet itself went out');
	assert.strictEqual(client.sendGoal(), true);
	await waitFor(() => named(events, 'invalid').length === 2, 'both refusals');

	const refusals = named(events, 'invalid').map(event => event.packet);
	assert.deepStrictEqual(refusals.map(packet => packet.original_cmd), ['LocationChecks', 'StatusUpdate']);
	assert.match(refusals[0].text, /Trackers can't register new Location Checks/);
	assert.match(refusals[1].text, /Trackers can't register Goal Complete/);
	assert.strictEqual(server.checkedOf(PLEX).size, 0);
	assert.strictEqual(server.statuses.get(PLEX), undefined);
});

test('an InvalidPacket is reported with the room password kept out of it', async () => {
	const { client, events } = offline({ password: 's3cret-pw' });
	await feed(client, [{ cmd: 'InvalidPacket', type: 'cmd', original_cmd: 'LocationChecks', text: 'echoed s3cret-pw back' }]);
	const [{ packet }] = named(events, 'invalid');
	assert.strictEqual(packet.original_cmd, 'LocationChecks');
	assert.strictEqual(packet.text, 'echoed *** back');
});

async function refusal(t, serverOptions, clientOptions = {}) {
	const server = await serve(t, serverOptions);
	const { client, events } = connect(t, server, clientOptions);
	await waitFor(() => named(events, 'fatal').length === 1, 'the refusal');
	// One more turn of the loop: anything that was going to retry at once would have by now.
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.strictEqual(client.stopped, true);
	assert.strictEqual(client.reconnectTimer, null, 'no retry is scheduled');
	assert.strictEqual(server.connectionsOpened, 1);
	assert.strictEqual(client.isReady, false);
	assert.strictEqual(client.sendChecks([loc(1)]), false);
	assert.deepStrictEqual(named(events, 'connected'), []);
	return named(events, 'fatal')[0];
}

test('a mis-cased slot name is refused for good (InvalidSlot)', async (t) => {
	const fatal = await refusal(t, {}, { slot: 'zackplex' });
	assert.deepStrictEqual(fatal, { reason: 'InvalidSlot', errors: ['InvalidSlot'] });
});

test('a slot playing another game is refused for good (InvalidGame)', async (t) => {
	const fatal = await refusal(t, {}, { slot: 'Watcher' });
	assert.deepStrictEqual(fatal, { reason: 'InvalidGame', errors: ['InvalidGame'] });
});

test('a wrong room password is refused for good (InvalidPassword)', async (t) => {
	const fatal = await refusal(t, { password: 'room-pw' }, { password: 'old-pw' });
	assert.deepStrictEqual(fatal, { reason: 'InvalidPassword', errors: ['InvalidPassword'] });
});

// --- the target ---------------------------------------------------------------------------

test('the room and its password are read again before every connection attempt', async (t) => {
	const first = await serve(t, { seedName: 'Seed_A' });
	const second = await serve(t, { seedName: 'Seed_B', password: 'pw-b' });
	let watch = { target: first.target, password: null };
	const client = new ApMediaClient({ slot: SLOT, label: 'test', resolveWatch: () => watch });
	t.after(() => client.stop());
	const events = record(client);

	client.start();
	await waitFor(() => named(events, 'connected').length === 1, 'the first room');
	assert.strictEqual(named(events, 'connected')[0].seedName, 'Seed_A');

	watch = { target: second.target, password: 'pw-b' };
	client.stop();
	client.start();
	await waitFor(() => named(events, 'connected').length === 2, 'the second room');
	assert.strictEqual(named(events, 'connected')[1].seedName, 'Seed_B');
	assert.strictEqual(second.received.find(packet => packet.cmd === 'Connect').password, 'pw-b');
	assert.deepStrictEqual(client.target, second.target);
	assert.deepStrictEqual(named(events, 'fatal'), []);
});

test('a reconnect after a dropped connection reads the room again too', async (t) => {
	const first = await serve(t, { seedName: 'Seed_A' });
	const second = await serve(t, { seedName: 'Seed_B', password: 'pw-b' });
	let watch = { target: first.target, password: null };
	const client = new ApMediaClient({ slot: SLOT, label: 'test', resolveWatch: () => watch });
	t.after(() => client.stop());
	const events = record(client);
	client.start();
	await waitFor(() => named(events, 'connected').length === 1, 'the first room');

	watch = { target: second.target, password: 'pw-b' };
	first.clientsOn(PLEX)[0].socket.terminate();
	await waitFor(() => client.reconnectTimer !== null, 'the backoff timer');
	await backoffNow(client);
	await waitFor(() => named(events, 'connected').length === 2, 'the second room');
	assert.strictEqual(named(events, 'connected')[1].seedName, 'Seed_B');
	assert.strictEqual(second.received.find(packet => packet.cmd === 'Connect').password, 'pw-b');
	assert.strictEqual(first.connectionsOpened, 1, 'the old room is not dialled again');
	assert.deepStrictEqual(named(events, 'fatal'), []);
});

test('a watch removed while the client is down stops it at the next attempt', async (t) => {
	const server = await serve(t);
	let watch = { target: server.target, password: null };
	const client = new ApMediaClient({ slot: SLOT, label: 'test', resolveWatch: () => watch });
	t.after(() => client.stop());
	const events = record(client);
	const statuses = [];
	client.on('status', (status) => statuses.push(status.state));
	client.start();
	await waitFor(() => client.isReady, 'the connection');

	watch = null;
	server.clientsOn(PLEX)[0].socket.terminate();
	await waitFor(() => client.reconnectTimer !== null, 'the backoff timer');
	await backoffNow(client);
	assert.deepStrictEqual(named(events, 'orphaned'), [{ reason: 'orphaned' }]);
	assert.strictEqual(client.stopped, true);
	assert.strictEqual(client.socket, null);
	assert.strictEqual(client.reconnectTimer, null, 'and no retry is scheduled');
	assert.strictEqual(server.connectionsOpened, 1);
	assert.deepStrictEqual(statuses, ['connecting', 'connected', 'disconnected'], 'no attempt was made');
});

test('a watch that is gone stops the client before it dials anything', async (t) => {
	const client = new ApMediaClient({ slot: SLOT, label: 'test', resolveWatch: () => null });
	t.after(() => client.stop());
	const events = record(client);
	const statuses = [];
	client.on('status', (status) => statuses.push(status));

	client.start();
	await waitFor(() => named(events, 'orphaned').length === 1, 'the orphaned event');
	assert.deepStrictEqual(named(events, 'orphaned'), [{ reason: 'orphaned' }]);
	assert.strictEqual(client.stopped, true);
	assert.strictEqual(client.socket, null);
	assert.strictEqual(client.reconnectTimer, null);
	assert.deepStrictEqual(statuses, [], 'not even a connecting status');
});
