// helpers/archipelagoMonitor.js: a watch id is handed out once.
//
// Plex Media slot links outlive their watch and key on its id. The counter used to be rebuilt from
// the watches still listed, so removing the last one saved `nextId: 1` and the next room watched
// took #1 again, and the old room's links with it. Seen live: on 2026-11-14 the last watch went and
// the file read {"nextId": 1, "watches": []}; on 2026-11-17 a new room was watched as #1, and the
// old room's Plex Media link ZackPlex connected to it and was refused InvalidSlot. What has to hold:
// the counter only rises, it is saved with an empty list too, and a load takes it from the file and
// past every saved whole-number id.
//
// Harness: the real monitor over its own temp watch file (test/helpers/apServer.js useTempStores),
// watches added against that file's fake server. restart() is a bot restart: it turns the monitor
// off, which saves nothing, then requires the monitor afresh and loads the file the way a boot does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const harness = require('./helpers/apServer.js');
const stores = harness.useTempStores('watchids');   // must run before any helper is required

const config = require('../config/config.js');
const { parseTarget } = require('../helpers/archipelagoClient.js');

const MONITOR = require.resolve('../helpers/archipelagoMonitor.js');
const CONFIG_KEYS = ['archipelagoEnabled', 'archipelagoRoomUrl', 'archipelagoHost', 'archipelagoSlot', 'archipelagoChannelId', 'archipelagoPassword'];
const savedConfig = {};
let monitor = null;
let server = null;

function turnOff() {
	config.archipelagoEnabled = false;
	monitor.applyConfig();
	config.archipelagoEnabled = true;
}

function restart() {
	if (monitor) turnOff();
	delete require.cache[MONITOR];
	monitor = require(MONITOR);
	monitor.applyConfig({ boot: true });
}

function writeFile(text) {
	fs.writeFileSync(stores.paths.watches, typeof text === 'string' ? text : JSON.stringify(text));
}

function readFile() {
	return JSON.parse(fs.readFileSync(stores.paths.watches, 'utf8'));
}

async function watch() {
	const { watch: added, outcome } = await monitor.addWatch({ target: `localhost:${server.port}`, slot: 'Watcher', channelId: 'chan-ids' }, 15000);
	assert.strictEqual(outcome, 'connected');
	return added;
}

// What addWatch would have saved, paused so that loading it opens no socket.
function savedWatch(id) {
	return {
		id,
		label: `Room ${id}`,
		target: parseTarget(`localhost:${server.port}`),
		slot: 'Watcher',
		password: null,
		channelId: 'chan-ids',
		guildId: null,
		filters: { ...monitor.DEFAULT_FILTERS },
		progressionOnly: false,
		paused: true,
		addedBy: null,
		addedAt: '2026-11-14T17:00:00.000Z',
	};
}

const ids = () => monitor.listWatches().map((entry) => entry.watch.id);
const savedIds = () => readFile().watches.map((w) => w.id);

test.before(async () => {
	for (const key of CONFIG_KEYS) savedConfig[key] = config[key];
	config.archipelagoRoomUrl = '';
	config.archipelagoHost = '';
	config.archipelagoSlot = '';
	config.archipelagoChannelId = '';
	config.archipelagoPassword = '';
	config.archipelagoEnabled = true;
	server = await harness.startFakeServer({ slots: ['Watcher'], seedName: 'Seed_IDS' });
});

test.beforeEach(() => {
	stores.cleanup();
	restart();
});

test.afterEach(() => {
	for (const id of ids()) monitor.removeWatch(id);
});

test.after(async () => {
	config.archipelagoEnabled = false;
	if (monitor) monitor.applyConfig();
	await harness.closeServer(server.wss);
	for (const key of CONFIG_KEYS) config[key] = savedConfig[key];
	stores.cleanup();
});

test('removing the last watch keeps the counter, and the next room watched takes a new number', async () => {
	const first = await watch();
	assert.strictEqual(first.id, 1);
	monitor.removeWatch(first.id);
	assert.deepStrictEqual(readFile(), { nextId: 2, watches: [] }, 'an empty list keeps its counter');

	const second = await watch();
	assert.strictEqual(second.id, 2, 'the removed room\'s number is not handed out again');
	assert.strictEqual(readFile().nextId, 3);
});

test('after a restart the next room watched takes the next number, not the removed one', async () => {
	const first = await watch();
	const second = await watch();
	assert.deepStrictEqual([first.id, second.id], [1, 2]);
	monitor.removeWatch(second.id);
	monitor.removeWatch(first.id);

	restart();
	assert.deepStrictEqual(ids(), [], 'nothing saved to start');
	const next = await watch();
	assert.strictEqual(next.id, 3);
	assert.strictEqual(readFile().nextId, 4);
});

test('a load takes the saved counter when it is ahead of every saved id', async () => {
	writeFile({ nextId: 9, watches: [savedWatch(4)] });
	restart();
	assert.deepStrictEqual(ids(), [4]);
	assert.strictEqual((await watch()).id, 9);
});

// The saved counter can only be behind a saved id when the file was edited by hand, and then the
// count would climb back to that id once its watch was gone.
test('a load goes past every saved id when the saved counter is behind them', async () => {
	writeFile({ nextId: 2, watches: [savedWatch(5)] });
	restart();
	monitor.removeWatch(5);
	assert.strictEqual(readFile().nextId, 6);
	assert.strictEqual((await watch()).id, 6);
});

test('a saved counter that is not a whole number is ignored rather than handed out', async () => {
	for (const text of ['{"nextId": 2.5, "watches": []}', '{"nextId": 1e999, "watches": []}']) {
		writeFile(text);
		restart();
		const added = await watch();
		assert.strictEqual(added.id, 1, text);
		assert.strictEqual(readFile().nextId, 2, text);
		monitor.removeWatch(added.id);
		stores.cleanup();
	}
});

// A hand-edited id as text: "5" plus one is "51", and "abc" plus one is NaN, which no later load
// could raise the counter past.
test('a saved id that is not a whole number moves the counter only by its value, and never as text', async () => {
	writeFile({ nextId: 2, watches: [savedWatch('5'), savedWatch('abc')] });
	restart();
	const added = await watch();
	assert.strictEqual(added.id, 6);
	assert.strictEqual(readFile().nextId, 7);
});

test('turning the monitor off and on keeps the counter and the saved watches', async () => {
	const first = await watch();
	const second = await watch();
	monitor.removeWatch(second.id);

	turnOff();
	assert.deepStrictEqual(ids(), [], 'off stops every watch');
	assert.deepStrictEqual(savedIds(), [first.id], 'and saves nothing over the file');
	assert.strictEqual(readFile().nextId, 3);

	monitor.applyConfig();
	assert.deepStrictEqual(ids(), [first.id], 'on loads the saved watch again');
	assert.strictEqual((await watch()).id, 3);
});
