// helpers/eventServer.js + helpers/broadcast.js after !restart.
//
// The bugs (2026-10-25 log): !restart built a new client but left the old event server holding
// port 8799, so the new one failed with EADDRINUSE ("inbound broadcasts disabled") while the old
// one went on handing Kometa and Playnite pushes to the destroyed client. And the broadcast
// channel cache handed out channels of the destroyed client, so the startup card and every
// broadcast after a restart failed with "Expected token to be set for this request".

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');

const config = require('../config/config.js');
const eventServer = require('../helpers/eventServer.js');
const broadcast = require('../helpers/broadcast.js');

const KEYS = ['eventServerEnabled', 'eventServerPort', 'eventServerToken', 'broadcastGameLaunch', 'gameLaunchChannelId', 'broadcastChannelId'];
let saved;
// Closed here as well as by the code under test: a stopEventServer that regresses would leave a
// socket holding the process open, and the run would hang after reporting the failure.
const servers = [];
test.beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, config[k]])); });
test.afterEach(() => {
	eventServer.stopEventServer();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
	Object.assign(config, saved);
});

async function freePort() {
	const probe = net.createServer().listen(0, '127.0.0.1');
	await once(probe, 'listening');
	const { port } = probe.address();
	probe.close();
	await once(probe, 'close');
	return port;
}

function listening(server) {
	return new Promise((resolve, reject) => {
		server.once('listening', resolve);
		server.once('error', reject);
	});
}

function fakeClient(name, onFetch) {
	return { name, channels: { fetch: async (id) => { onFetch(name, id); return null; } } };
}

test('after !restart the new event server gets the port and the pushes', async () => {
	config.eventServerEnabled = true;
	config.eventServerPort = await freePort();
	config.eventServerToken = '';
	config.broadcastGameLaunch = true;
	config.gameLaunchChannelId = 'GAME-PUSH';

	eventServer.stopEventServer();

	// A throw inside fetch would only be logged by resolveChannelById, so the clients record.
	const asked = [];
	let fetchedBy;
	const fetched = new Promise((resolve) => { fetchedBy = resolve; });
	const onFetch = (name, id) => { asked.push(name); fetchedBy({ name, id }); };
	const first = eventServer.startEventServer(fakeClient('old', onFetch));
	servers.push(first);
	await listening(first);

	eventServer.stopEventServer();
	assert.strictEqual(eventServer.getStatus().listening, false);
	assert.strictEqual(first.listening, false, 'the old server let go of the port');

	const second = eventServer.startEventServer(fakeClient('new', onFetch));
	servers.push(second);
	await listening(second);
	assert.strictEqual(eventServer.getStatus().listening, true);

	const res = await fetch(`http://127.0.0.1:${config.eventServerPort}/playnite/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Hades' })
	});
	assert.strictEqual(res.status, 200);
	assert.deepStrictEqual(await fetched, { name: 'new', id: 'GAME-PUSH' });
	assert.deepStrictEqual(asked, ['new']);
});

test('a broadcast after !restart fetches the channel again through the new client', async () => {
	config.gameLaunchChannelId = 'GAME-CACHE';
	const fetches = [];
	const sent = [];
	function client(name) {
		const self = {
			name,
			channels: {
				fetch: async (id) => {
					fetches.push(name);
					return { id, client: self, send: async () => { sent.push(name); } };
				}
			}
		};
		return self;
	}
	const oldClient = client('old');
	const newClient = client('new');

	await broadcast.broadcastGameLaunch(oldClient, { name: 'Hades' });
	await broadcast.broadcastGameLaunch(oldClient, { name: 'Hades' });
	await broadcast.broadcastGameLaunch(newClient, { name: 'Hades' });
	await broadcast.broadcastGameLaunch(newClient, { name: 'Hades' });

	assert.deepStrictEqual(fetches, ['old', 'new'], 'cached per client, fetched once by each');
	assert.deepStrictEqual(sent, ['old', 'old', 'new', 'new']);
});
