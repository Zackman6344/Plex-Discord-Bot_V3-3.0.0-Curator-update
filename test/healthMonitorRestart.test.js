// helpers/healthMonitor.js after !restart.
//
// The bug (2026-10-17 log): !restart started a second monitor and nothing stopped the first, so
// from then on every check ran and logged twice, 17 seconds apart, and the old one would have
// DMed a status change through the destroyed client.
//
// Harness: healthCheck.js is swapped in require.cache for one whose results the test hands out,
// and setInterval is mocked so the 15-minute interval can be stepped.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 15 * 60 * 1000;

// Each check takes the next queued result, or a fresh pending one the test settles itself.
const checks = { calls: 0, queue: [] };
function stub(rel, exports) {
	const file = require.resolve(path.join(ROOT, rel));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('helpers/healthCheck.js', {
	runHealthCheck() {
		checks.calls++;
		const next = checks.queue.shift();
		return next ? next.promise : Promise.resolve(statuses('ok'));
	},
	formatHealthCheck: () => 'report'
});
stub('helpers/logger.js', { info() {}, warn() {}, error() {} });

const config = require('../config/config.js');
const { startHealthMonitor, stopHealthMonitor } = require('../helpers/healthMonitor.js');

function statuses(plex) {
	return { plex: { status: plex }, eventServer: { status: 'ok' } };
}

function pendingCheck() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	const check = { promise, resolve };
	checks.queue.push(check);
	return check;
}

function fakeClient(gate) {
	const client = {
		dms: [],
		users: {
			fetch: async () => ({ send: async (msg) => { if (gate) await gate; client.dms.push(msg); } })
		}
	};
	return client;
}

function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

let savedOwner;
test.beforeEach(() => {
	checks.calls = 0;
	checks.queue.length = 0;
	savedOwner = config.ownerId;
	config.ownerId = 'owner';
});
test.afterEach(() => {
	stopHealthMonitor();
	config.ownerId = savedOwner;
});

test('after !restart the checks run once per interval, not once per monitor started', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });

	startHealthMonitor(fakeClient());
	await settle();
	stopHealthMonitor();
	startHealthMonitor(fakeClient());
	await settle();
	assert.strictEqual(checks.calls, 2, 'one boot check each');

	t.mock.timers.tick(INTERVAL_MS);
	await settle();
	assert.strictEqual(checks.calls, 3);

	t.mock.timers.tick(INTERVAL_MS);
	await settle();
	assert.strictEqual(checks.calls, 4);
});

test('starting again without a stop still leaves one monitor', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });

	startHealthMonitor(fakeClient());
	startHealthMonitor(fakeClient());
	await settle();
	checks.calls = 0;

	t.mock.timers.tick(INTERVAL_MS);
	await settle();
	assert.strictEqual(checks.calls, 1);
});

test('a check still running when its monitor stops neither reports nor DMs', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const oldClient = fakeClient();
	const newClient = fakeClient();

	const stale = pendingCheck();
	startHealthMonitor(oldClient);
	stopHealthMonitor();
	startHealthMonitor(newClient);
	await settle();

	// Different from what the new monitor saw: reported, it would DM the old client, and as the
	// new baseline it would make the new monitor's next check DM a change that never happened.
	stale.resolve(statuses('error'));
	await settle();
	t.mock.timers.tick(INTERVAL_MS);
	await settle();
	await settle();

	assert.deepStrictEqual(oldClient.dms, []);
	assert.deepStrictEqual(newClient.dms, []);
});

test('a change whose DM was still being sent at the stop is reported again by the new monitor', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	let release;
	const oldClient = fakeClient(new Promise((resolve) => { release = resolve; }));
	const newClient = fakeClient();

	startHealthMonitor(oldClient);
	await settle();
	checks.queue.push({ promise: Promise.resolve(statuses('error')) });
	t.mock.timers.tick(INTERVAL_MS);
	await settle();

	// The old monitor is DMing plex ok → error through the client !restart is about to destroy,
	// where the DM may never arrive.
	stopHealthMonitor();
	const boot = pendingCheck();
	startHealthMonitor(newClient);
	release();
	await settle();
	boot.resolve(statuses('error'));
	await settle();
	await settle();

	assert.strictEqual(newClient.dms.length, 1, 'the baseline was still ok, so the change is reported');
	assert.match(newClient.dms[0], /plex\*\*: `ok` → `error`/);
});
