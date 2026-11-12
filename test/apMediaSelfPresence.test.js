// helpers/archipelagoClient.js (isSelfDirected) and helpers/archipelagoMonitor.js (describeSlot,
// onWatchChange): the watch's side of a room it shares with the bot's Plex Media game client.
//
// The bug guarded against: the game client joins and leaves its slot on every restart and
// reconnect, and a watch on the same room relayed each of those lines as room activity. A join line
// carries the client's tags, so the bot's tag marks it. AP 0.6.8's Part has no tags field at all,
// so the leave line is recognised by the Python tag list at the end of its text. A person playing
// the same slot is still relayed, joining and leaving.
//
// The monitor side: describeSlot gives a binding the room's own spelling of a slot (the server
// matches Connect names exactly) and its game, and onWatchChange tells the game clients when the
// room under a watch is added, rebuilt, re-pointed, removed or switched off.
//
// Harness: verbatim MultiServer 0.6.8 packet shapes against a bare observer client; then the real
// observer, the real game client and a raw protocol client standing in for a person, all on
// test/helpers/apMediaServer.js; then the real monitor (addWatch, restartWatch, setPassword,
// syncConfigWatch, applyConfig) against the same stand-in, with the temp stores and fake Discord
// client of test/helpers/apServer.js. Real sockets and timers; the relay flushes after a second.

const test = require('node:test');
const assert = require('node:assert');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('apmedia-self');   // must run before any helper is required

const config = require('../config/config.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const { ArchipelagoClient } = require('../helpers/archipelagoClient.js');
const { ApMediaClient } = require('../helpers/apMediaClient.js');
const { startApMediaServer, connectRaw } = require('./helpers/apMediaServer.js');

const { waitFor } = ap;
const PLEX = 1;
const WATCHER = 2;
const BOT_TAGS = ['AP', 'PlexMediaBot', 'NoText'];

// config is a shared singleton: whatever a test changes is put back.
const CONFIG_KEYS = [
	'archipelagoEnabled', 'archipelagoRoomUrl', 'archipelagoHost', 'archipelagoPort', 'archipelagoSlot',
	'archipelagoPassword', 'archipelagoChannelId', 'archipelagoBatchSeconds', 'archipelagoRolesEnabled',
];
const savedConfig = {};

test.before(() => {
	for (const key of CONFIG_KEYS) savedConfig[key] = config[key];
	// Nothing from /config may dial a room, and there is no guild to give roles in.
	config.archipelagoEnabled = false;
	config.archipelagoRolesEnabled = false;
	config.archipelagoBatchSeconds = 1;
});

test.after(() => {
	for (const key of CONFIG_KEYS) config[key] = savedConfig[key];
	stores.cleanup();
});

async function serve(t, options = {}) {
	const server = await startApMediaServer(options);
	t.after(() => server.close());
	return server;
}

async function watchRoom(t, server, channelId = 'chan-apmedia') {
	const added = await monitor.addWatch({ target: `localhost:${server.port}`, slot: 'Watcher', channelId }, 15000);
	t.after(() => monitor.removeWatch(added.watch.id));
	return added;
}

// --- the lines, as MultiServer 0.6.8 sends them ------------------------------------------

const botJoin = {
	cmd: 'PrintJSON', type: 'Join', team: 0, slot: PLEX, tags: BOT_TAGS,
	data: [{ text: "ZackPlex (Team #1) playing Plex Media has joined. Client(0.6.1), ['AP', 'PlexMediaBot', 'NoText']." }],
};
const botTagsChanged = {
	cmd: 'PrintJSON', type: 'TagsChanged', team: 0, slot: PLEX, tags: BOT_TAGS,
	data: [{ text: "ZackPlex (Team #1) has changed tags from ['AP'] to ['AP', 'PlexMediaBot', 'NoText']." }],
};
const botPart = {
	cmd: 'PrintJSON', type: 'Part', team: 0, slot: PLEX,
	data: [{ text: "ZackPlex (Team #1) has left the game. Client(0.6.1), ['AP', 'PlexMediaBot', 'NoText']." }],
};
const personJoin = {
	cmd: 'PrintJSON', type: 'Join', team: 0, slot: PLEX, tags: ['AP', 'DeathLink'],
	data: [{ text: "ZackPlex (Team #1) playing Plex Media has joined. Client(0.6.8), ['AP', 'DeathLink']." }],
};
const personPart = {
	cmd: 'PrintJSON', type: 'Part', team: 0, slot: PLEX,
	data: [{ text: "ZackPlex (Team #1) has left the game. Client(0.6.8), ['AP', 'DeathLink']." }],
};

function observer() {
	const client = new ArchipelagoClient({ target: { kind: 'direct', host: 'x', port: 1 }, slot: 'Watcher' });
	client.slotId = WATCHER;
	return client;
}

test('the bot game client\'s join, tag change and leave are self-directed, on a watch of another slot', () => {
	const client = observer();
	assert.ok(!('tags' in botPart), '0.6.8 sends Part with no tags field');
	assert.strictEqual(client.isSelfDirected(botJoin), true);
	assert.strictEqual(client.isSelfDirected(botTagsChanged), true);
	assert.strictEqual(client.isSelfDirected(botPart), true);
	// The observer's rule for its own lines is untouched: these are another client's.
	assert.strictEqual(client.isSelfPresence(botJoin), false);

	const split = { ...botPart, data: [{ text: 'ZackPlex (Team #1) has left the game. ' }, { text: "Client(0.6.1), ['AP', 'PlexMediaBot', 'NoText']." }] };
	assert.strictEqual(client.isSelfDirected(split), true, 'the text parts are read joined');
	client.stop();
});

test('a person on the same slot is still relayed, joining and leaving', () => {
	const client = observer();
	assert.strictEqual(client.isSelfDirected(personJoin), false);
	assert.strictEqual(client.isSelfDirected(personPart), false);

	// A name can say anything. Only the tag list the server writes last counts.
	const lookalike = { ...personPart, data: [{ text: "PlexMediaBot ['PlexMediaBot'] (Team #1) has left the game. Client(0.6.8), ['AP']." }] };
	assert.strictEqual(client.isSelfDirected(lookalike), false);
	const chat = { cmd: 'PrintJSON', type: 'Chat', team: 0, slot: PLEX, message: 'x', data: [{ text: "ZackPlex: see ['PlexMediaBot']." }] };
	assert.strictEqual(client.isSelfDirected(chat), false, 'only presence lines are ever the bot\'s');

	// Should a later server give Part a tags field, it decides, as it does for Join.
	assert.strictEqual(client.isSelfDirected({ ...botPart, tags: ['AP'] }), false);
	assert.strictEqual(client.isSelfDirected({ ...personPart, tags: BOT_TAGS }), true);
	client.stop();
});

// --- live, on a room the three of them share ---------------------------------------------

test('live: the watch sees the bot come and go as itself, and a person as a person', async (t) => {
	const server = await serve(t);
	const watch = new ArchipelagoClient({ target: server.target, slot: 'Watcher', label: 'watch' });
	t.after(() => watch.stop());
	const lines = [];
	watch.on('line', (line) => lines.push(line));
	watch.start();
	await waitFor(() => watch.connected, 'the watch');

	const game = new ApMediaClient({ target: server.target, slot: 'ZackPlex', label: 'game' });
	t.after(() => game.stop());
	game.start();
	await waitFor(() => game.isReady, 'the game client');
	const gameSocket = server.clientsOn(PLEX)[0].id;

	const person = await connectRaw(server.port, { name: 'ZackPlex', game: 'Plex Media', tags: ['AP'] });
	t.after(() => person.close());
	const leaves = () => lines.filter(line => line.type === 'Part').length;
	game.stop();
	await waitFor(() => leaves() === 1, 'the bot\'s leave line');
	await person.close();
	await waitFor(() => leaves() === 2, 'the person\'s leave line');

	const presence = lines.filter(line => (line.type === 'Join' || line.type === 'Part') && line.packet.slot === PLEX);
	assert.deepStrictEqual(presence.map(line => [line.type, line.self]), [['Join', true], ['Join', false], ['Part', true], ['Part', false]]);
	assert.ok(!('tags' in presence[2].packet), 'the bot\'s Part was recognised from its text alone');
	for (const line of presence) {
		assert.strictEqual(monitor.shouldRelay({ filters: { ...monitor.DEFAULT_FILTERS } }, line), !line.self);
	}
	const own = lines.find(line => line.type === 'Join' && line.packet.slot === WATCHER);
	assert.strictEqual(own.self, true, 'the watch\'s own join is still hidden');

	const toGame = server.frames.filter(frame => frame.to === gameSocket).flatMap(frame => frame.packets.map(packet => packet.cmd));
	assert.ok(!toGame.includes('PrintJSON'), 'NoText: the game client is sent no chat, joins or welcome text');
});

test('the watch\'s channel gets a person\'s join and leave but none of the bot\'s', async (t) => {
	const discord = ap.fakeDiscord();
	monitor.startArchipelagoMonitor(discord.client);
	const server = await serve(t);
	const { outcome } = await watchRoom(t, server, 'chan-relay');
	assert.strictEqual(outcome, 'connected');

	const game = new ApMediaClient({ target: server.target, slot: 'ZackPlex', label: 'game' });
	t.after(() => game.stop());
	game.start();
	await waitFor(() => game.isReady, 'the game client');
	const person = await connectRaw(server.port, { name: 'ZackPlex', game: 'Plex Media', tags: ['AP'] });
	game.stop();
	await person.close();

	const posted = () => discord.posted.map(payload => String(payload.content || '')).join('\n');
	await waitFor(() => posted().includes("has left the game. Client(0.6.1), ['AP']."), 'the person\'s leave line in the channel');
	assert.ok(posted().includes("playing Plex Media has joined. Client(0.6.1), ['AP']."), 'and their join');
	assert.ok(!posted().includes('PlexMediaBot'), 'nothing of the bot\'s own client reaches the channel');
	for (const payload of discord.posted) assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
});

// --- describeSlot -------------------------------------------------------------------------

test('describeSlot gives the room\'s spelling, the slot number and its game', async (t) => {
	const server = await serve(t);
	const { watch, outcome } = await watchRoom(t, server);
	assert.strictEqual(outcome, 'connected');

	assert.deepStrictEqual(monitor.describeSlot(watch.id, 'zackplex'), { known: true, canonical: 'ZackPlex', slotId: PLEX, game: 'Plex Media' });
	assert.deepStrictEqual(monitor.describeSlot(String(watch.id), ' WATCHER '), { known: true, canonical: 'Watcher', slotId: WATCHER, game: 'ChecksFinder' });
	assert.deepStrictEqual(monitor.describeSlot(watch.id, 'Nobody'), { known: true, canonical: null, slotId: null, game: null });
	assert.strictEqual(monitor.describeSlot(4242, 'ZackPlex'), null, 'no such watch');

	// A restart carries the slot names and their games over at once, so a binding made before the
	// fresh client's own Connected still gets the spelling and the game.
	const zack = { known: true, canonical: 'ZackPlex', slotId: PLEX, game: 'Plex Media' };
	monitor.restartWatch(watch.id);
	assert.deepStrictEqual(monitor.describeSlot(watch.id, 'ZackPlex'), zack);
	const status = () => monitor.listWatches().find(w => w.watch.id === watch.id).status;
	await waitFor(() => status() === 'connected', 'the restarted watch');
	assert.deepStrictEqual(monitor.describeSlot(watch.id, 'ZackPlex'), zack);
});

test('describeSlot knows nothing until the watch has read the room', async (t) => {
	const server = await serve(t, { password: 'room-pw' });
	const { watch, outcome } = await watchRoom(t, server, 'chan-unread');
	assert.strictEqual(outcome, 'refused', 'the watch has no password, so it never reads the room');
	assert.deepStrictEqual(monitor.describeSlot(watch.id, 'ZackPlex'), { known: false, canonical: null, slotId: null, game: null });
});

// --- onWatchChange ------------------------------------------------------------------------

test('onWatchChange hears a watch added, restarted and removed, until unsubscribed', async (t) => {
	const server = await serve(t);
	const seen = [];
	const unsubscribe = monitor.onWatchChange((event) => seen.push(event));
	t.after(unsubscribe);

	const { watch } = await monitor.addWatch({ target: `localhost:${server.port}`, slot: 'Watcher', channelId: 'chan-change' }, 15000);
	assert.deepStrictEqual(seen.map(event => [event.watchId, event.change]), [[watch.id, 'added']]);
	assert.strictEqual(seen[0].watch, monitor.getWatch(watch.id));

	monitor.setPassword(watch.id, 'new-pw');
	assert.strictEqual(seen.at(-1).change, 'restarted');
	assert.strictEqual(seen.at(-1).watch.password, 'new-pw', 'getWatch already answers with the change');

	monitor.removeWatch(watch.id);
	assert.deepStrictEqual(seen.at(-1), { watchId: watch.id, change: 'removed', watch: null });

	unsubscribe();
	await watchRoom(t, server, 'chan-change');
	assert.strictEqual(seen.length, 3);
});

test('a watch change listener that throws or rejects cannot break the monitor', async (t) => {
	const server = await serve(t);
	const seen = [];
	const unsubscribes = [
		monitor.onWatchChange(() => { throw new Error('a listener bug'); }),
		monitor.onWatchChange(async () => { throw new Error('an async listener bug'); }),
		monitor.onWatchChange((event) => seen.push(event.change)),
	];
	t.after(() => unsubscribes.forEach(unsubscribe => unsubscribe()));

	const { watch, outcome } = await monitor.addWatch({ target: `localhost:${server.port}`, slot: 'Watcher', channelId: 'chan-throw' }, 15000);
	assert.strictEqual(outcome, 'connected');
	assert.ok(monitor.removeWatch(watch.id));
	assert.strictEqual(monitor.getWatch(watch.id), null);
	assert.deepStrictEqual(seen, ['added', 'removed']);
	assert.throws(() => monitor.onWatchChange('not a function'), TypeError);
});

// Last: switching archipelagoEnabled off clears every watch the monitor holds.
test('onWatchChange hears the configured room re-pointed, cleared and switched off', async (t) => {
	const first = await serve(t, { seedName: 'Seed_ONE' });
	const second = await serve(t, { seedName: 'Seed_TWO' });
	const seen = [];
	t.after(monitor.onWatchChange((event) => seen.push([event.watchId, event.change, event.watch && event.watch.target.port])));

	Object.assign(config, {
		archipelagoRoomUrl: '', archipelagoHost: '127.0.0.1', archipelagoPort: first.port,
		archipelagoSlot: 'Watcher', archipelagoPassword: '', archipelagoChannelId: 'chan-config',
	});
	monitor.syncConfigWatch();
	monitor.syncConfigWatch();
	config.archipelagoPort = second.port;
	monitor.syncConfigWatch();
	config.archipelagoSlot = '';
	monitor.syncConfigWatch();
	config.archipelagoSlot = 'Watcher';
	monitor.syncConfigWatch();
	config.archipelagoEnabled = false;
	monitor.applyConfig();

	const id = monitor.CONFIG_WATCH_ID;
	assert.deepStrictEqual(seen, [
		[id, 'added', first.port],
		[id, 'repointed', second.port],
		[id, 'removed', null],
		[id, 'added', second.port],
		[id, 'disabled', null],
	], 'an unchanged sync is not a change');
	assert.strictEqual(monitor.getWatch(id), null);
});
