// app/utils.js + helpers/loginRetry.js: a Discord login that fails.
//
// The bug: client.login() had no catch. When discord.com timed out at boot, the rejection was
// logged as unhandled, nothing else held the process open, and node exited with code 0, so the
// bot stayed down until someone noticed (2026-10-25, reproduced by sending discord.com to an
// unroutable address).
//
// Harness: the one restartSignals.test.js uses. start() runs with every module it requires
// swapped in require.cache, process.on and process.exit are mocked, and setTimeout is mocked so
// the backoff can be stepped through.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const bots = [];
const clients = [];
const logins = [];
const logged = { warn: [], error: [] };
const events = [];
const stops = { server: 0, health: 0, theater: 0 };

class FakeBot {
	constructor(client) {
		this.client = client;
		this.calls = [];
		this.songQueue = [];
		this.books = { shutdown: () => this.calls.push('books.shutdown') };
		bots.push(this);
	}
	stop() { this.calls.push(`stop:${this.songQueue.length}`); }
	destroy() { this.calls.push('destroy'); }
}

// Each login takes the next queued outcome: an Error rejects, anything else resolves.
class FakeClient {
	constructor() {
		this.destroyed = false;
		this.loginCalls = 0;
		clients.push(this);
	}
	login(token) {
		this.loginCalls++;
		const next = logins.shift();
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(token);
	}
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
stub('helpers/logger.js', {
	info() {},
	warn(...a) { logged.warn.push(a.join(' ')); },
	error(...a) { logged.error.push(a.join(' ')); }
});
stub('helpers/commandLog.js', { recordEvent(kind, fields) { events.push({ kind, ...fields }); } });
stub('helpers/processPriority.js', { bindToConfig() {} });
stub('helpers/voiceHealth.js', { bindToConfig() {} });
stub('helpers/eventServer.js', { stopEventServer() { stops.server++; } });
stub('helpers/healthMonitor.js', { stopHealthMonitor() { stops.health++; } });
stub('helpers/kometaTheater.js', { stopKometaTheater() { stops.theater++; } });
stub('config/config.js', {});
stub('config/keys.js', { botToken: 'not-a-token' });

const utils = require('../app/utils.js');
const loginRetry = require('../helpers/loginRetry.js');

// Recorded across the whole file, since start() binds the process hooks only on its first run,
// and only while start() itself runs: node:test registers process listeners of its own.
const listeners = {};
function start() {
	const realOn = process.on;
	process.on = (event, fn) => {
		(listeners[event] = listeners[event] || []).push(fn);
		return process;
	};
	try {
		utils.start();
	} finally {
		process.on = realOn;
	}
}

function connectTimeout() {
	return Object.assign(new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)'), {
		name: 'ConnectTimeoutError',
		code: 'UND_ERR_CONNECT_TIMEOUT'
	});
}

function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => {
	bots.length = 0;
	clients.length = 0;
	logins.length = 0;
	logged.warn.length = 0;
	logged.error.length = 0;
	events.length = 0;
	stops.server = 0;
	stops.health = 0;
	stops.theater = 0;
});

test('a login that cannot reach Discord is tried again with a fresh client', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const exits = [];
	t.mock.method(process, 'exit', (code) => { exits.push(code); });
	logins.push(connectTimeout(), 'ok');

	start();
	await settle();

	assert.strictEqual(clients.length, 1);
	assert.match(logged.warn[0], /attempt 1\): Connect Timeout Error .* Trying again in 5 s/);
	assert.deepStrictEqual(events, [{
		kind: 'login-failed', attempt: 1, error: connectTimeout().message, retryInMs: 5000
	}]);

	t.mock.timers.tick(4999);
	assert.strictEqual(clients.length, 1, 'not before the delay is up');

	t.mock.timers.tick(1);
	await settle();

	assert.strictEqual(clients.length, 2);
	assert.notStrictEqual(clients[1], clients[0], 'never the client whose login failed');
	assert.deepStrictEqual(bots[0].calls, ['books.shutdown', 'stop:0', 'destroy'], 'the failed pair is stopped like !restart stops one');
	assert.strictEqual(clients[0].destroyed, true);
	assert.deepStrictEqual(stops, { server: 1, health: 1, theater: 1 }, 'everything started on ready is stopped with it');
	assert.strictEqual(clients[1].loginCalls, 1);

	t.mock.timers.tick(60 * 60 * 1000);
	await settle();
	assert.strictEqual(clients.length, 2, 'a login that worked is not retried');
	assert.strictEqual(logged.warn.length, 1);
	assert.deepStrictEqual(exits, []);
});

test('each retry waits longer, up to five minutes, and keeps going', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(process, 'exit', () => { assert.fail('a network failure must never end the process'); });
	const waits = [5, 15, 30, 60, 120, 300, 300, 300];
	for (let i = 0; i < waits.length; i++) logins.push(connectTimeout());
	logins.push('ok');

	start();
	await settle();

	for (const seconds of waits) {
		const before = clients.length;
		t.mock.timers.tick(seconds * 1000 - 1);
		await settle();
		assert.strictEqual(clients.length, before, `still waiting inside the ${seconds} s gap`);
		t.mock.timers.tick(1);
		await settle();
		assert.strictEqual(clients.length, before + 1, `tried again after ${seconds} s`);
	}

	assert.strictEqual(clients.length, waits.length + 1);
	assert.deepStrictEqual(events.map((e) => e.retryInMs / 1000), waits);
});

test('a rejected token ends the process with code 1 instead of retrying', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const exits = [];
	t.mock.method(process, 'exit', (code) => { exits.push(code); });
	const exitCodeBefore = process.exitCode;
	t.after(() => { process.exitCode = exitCodeBefore; });
	logins.push(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }));

	start();
	await settle();

	assert.strictEqual(process.exitCode, 1);
	assert.deepStrictEqual(exits, [], 'left to end by itself first');
	t.mock.timers.tick(5000);
	assert.deepStrictEqual(exits, [1], 'forced only if something still holds it open');
	t.mock.timers.tick(60 * 60 * 1000);
	await settle();

	assert.deepStrictEqual(exits, [1]);
	assert.match(logged.error[0], /will not be retried: An invalid token was provided/);
	assert.strictEqual(clients.length, 1);
	assert.deepStrictEqual(events, [{
		kind: 'login-failed', attempt: 1, error: 'An invalid token was provided.', retryInMs: null
	}]);
});

test('the error loggers and signal handlers are bound once however often start runs', async () => {
	logins.push('ok', 'ok', 'ok');
	start();
	start();
	start();
	await settle();

	for (const event of ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM']) {
		assert.strictEqual((listeners[event] || []).length, 1, event);
	}
});

test('only token and intent failures are final', () => {
	assert.strictEqual(loginRetry.isRetryable(connectTimeout()), true);
	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
	assert.strictEqual(loginRetry.isRetryable(new TypeError('fetch failed')), true);
	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('Bad Gateway'), { status: 502 })), true);
	assert.strictEqual(loginRetry.isRetryable(undefined), true);

	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('bad token'), { code: 'TokenInvalid' })), false);
	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('intents'), { code: 'DisallowedIntents' })), false);
	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('401: Unauthorized'), { status: 401 })), false);
	assert.strictEqual(loginRetry.isRetryable(Object.assign(new Error('403: Forbidden'), { status: 403 })), false);
});
