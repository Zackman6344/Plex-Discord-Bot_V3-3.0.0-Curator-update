// app/utils.js: the SIGINT/SIGTERM quitter after !restart.
//
// The bug: every start() added its own quitter, closed over its own bot. After !restart the old
// bot's quitter ran first and its process.exit(0) ended the process before the new bot's quitter
// ran, so the live book session was never saved or ended.
//
// Harness: start() runs twice with every module it requires swapped in require.cache (no
// discord.js login, no keys, no real bot), and process.on/process.exit mocked so nothing is
// registered on the test process. The recorded listeners are then called the way an emit would,
// stopping at the first process.exit as the real one does.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const bots = [];

class FakeBot {
	constructor(client) {
		this.client = client;
		this.calls = [];
		this.songQueue = ['queued'];
		this.books = { shutdown: () => this.calls.push('books.shutdown') };
		bots.push(this);
	}
	stop() { this.calls.push(`stop:${this.songQueue.length}`); }
	destroy() { this.calls.push('destroy'); }
}

class FakeClient {
	constructor() { this.destroyed = false; }
	login() { return Promise.resolve(); }
	destroy() { this.destroyed = true; }
}

function stub(rel, exports) {
	const file = require.resolve(path.join(ROOT, rel));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

require.cache[require.resolve('discord.js')] = {
	id: 'discord.js', filename: 'discord.js', loaded: true,
	exports: { Client: FakeClient, GatewayIntentBits: {}, Partials: {} }
};
stub('app/bot.js', FakeBot);
stub('app/music.js', () => {});
stub('helpers/logger.js', { info() {}, warn() {}, error() {} });
stub('helpers/commandLog.js', { recordEvent() {} });
stub('helpers/processPriority.js', { bindToConfig() {} });
stub('helpers/voiceHealth.js', { bindToConfig() {} });
stub('helpers/eventServer.js', { stopEventServer() {} });
stub('helpers/healthMonitor.js', { stopHealthMonitor() {} });
stub('helpers/kometaTheater.js', { stopKometaTheater() {} });
stub('config/config.js', {});
stub('config/keys.js', { botToken: 'not-a-token' });

const utils = require('../app/utils.js');

test('a signal after !restart shuts down the bot that is running now', (t) => {
	const listeners = {};
	t.mock.method(process, 'on', (event, fn) => {
		(listeners[event] = listeners[event] || []).push(fn);
		return process;
	});
	let exits = 0;
	t.mock.method(process, 'exit', () => { exits++; });

	utils.start();
	const old = bots[0];
	utils.stop(old, old.client);
	utils.start();
	const current = bots[1];
	old.calls.length = 0;

	for (const fn of listeners.SIGINT || []) {
		fn('SIGINT');
		if (exits) break;
	}

	assert.strictEqual(exits, 1);
	assert.deepStrictEqual(current.calls, ['books.shutdown', 'stop:0', 'destroy'], 'book first, then the emptied queue, then the rest');
	assert.strictEqual(current.client.destroyed, true);
	assert.deepStrictEqual(old.calls, [], 'the old bot was already stopped by !restart');
	assert.strictEqual((listeners.SIGINT || []).length, 1);
	assert.strictEqual((listeners.SIGTERM || []).length, 1);
	assert.strictEqual(listeners.uncaughtException.length, 1, 'bound once, like the quitter');
});
