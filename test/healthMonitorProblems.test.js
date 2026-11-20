// helpers/healthMonitor.js and the `problems` a check may return (I20).
//
// Harness of test/healthMonitorRestart.test.js: healthCheck.js and logger.js are swapped in
// require.cache and setInterval is mocked. Each test loads a fresh monitor, so its first check is
// the boot check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 15 * 60 * 1000;
const MARK = '\u{1FA7A}';
const DOT = '\u2022';
const ARROW = '\u2192';
const REPORT = '\n\n```\nreport\n```';

const checks = { queue: [] };
const logs = { info: [], warn: [], error: [] };
function stub(rel, exports) {
	const file = require.resolve(path.join(ROOT, rel));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('helpers/healthCheck.js', {
	runHealthCheck() {
		return Promise.resolve(checks.queue.shift() || { plex: { status: 'ok' } });
	},
	formatHealthCheck: () => 'report'
});
stub('helpers/logger.js', {
	info: (...a) => logs.info.push(a.join(' ')),
	warn: (...a) => logs.warn.push(a.join(' ')),
	error: (...a) => logs.error.push(a.join(' '))
});

const config = require('../config/config.js');
const MONITOR = require.resolve('../helpers/healthMonitor.js');
let monitor = null;

const REFUSED = { key: 'refused:0::zackplex:InvalidSlot', text: '`ZackPlex` refused by its room (`InvalidSlot`)' };
const ORPHANED = { key: 'orphaned:1::friend', text: '`Friend` lost watch #1' };

function withApMedia(apMedia) {
	return { plex: { status: 'ok' }, apMedia };
}

function failing(...problems) {
	return withApMedia({ status: 'error', detail: 'refused', problems });
}

function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

async function run(t, list) {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const client = { dms: [] };
	client.users = { fetch: async () => ({ send: async (msg) => { client.dms.push(msg); } }) };
	checks.queue.push(...list);
	delete require.cache[MONITOR];
	monitor = require(MONITOR);
	monitor.startHealthMonitor(client);
	await settle();
	for (let i = 1; i < list.length; i++) {
		t.mock.timers.tick(INTERVAL_MS);
		await settle();
		await settle();
	}
	return client;
}

const problemLogs = () => logs.warn.concat(logs.info).filter((line) => /new problem|cleared/.test(line));

let savedOwner;
test.beforeEach(() => {
	checks.queue.length = 0;
	for (const k of Object.keys(logs)) logs[k].length = 0;
	savedOwner = config.ownerId;
	config.ownerId = 'owner';
});
test.afterEach(() => {
	if (monitor) monitor.stopHealthMonitor();
	config.ownerId = savedOwner;
});

test('a new problem under a steady error is DMed once', async (t) => {
	const client = await run(t, [failing(REFUSED), failing(REFUSED, ORPHANED), failing(REFUSED, ORPHANED)]);
	assert.deepStrictEqual(client.dms, [
		`${MARK} **New health problem**\n${DOT} **apMedia**: \`Friend\` lost watch #1${REPORT}`
	]);
	assert.deepStrictEqual(problemLogs(), ['Health check: new problem: apMedia: `Friend` lost watch #1']);
});

test('the boot check sends nothing for problems already there', async (t) => {
	const client = await run(t, [failing(REFUSED, ORPHANED), failing(REFUSED, ORPHANED)]);
	assert.deepStrictEqual(client.dms, []);
	assert.deepStrictEqual(problemLogs(), []);
});

test('a cleared problem is logged, not DMed', async (t) => {
	const client = await run(t, [failing(REFUSED, ORPHANED), failing(REFUSED)]);
	assert.deepStrictEqual(client.dms, []);
	assert.deepStrictEqual(logs.info.filter((line) => /cleared/.test(line)), [
		'Health check: cleared: apMedia: `Friend` lost watch #1'
	]);
	assert.ok(!logs.warn.some((line) => /new problem/.test(line)));
});

test('a status change and a new problem make one DM listing both', async (t) => {
	const client = await run(t, [withApMedia({ status: 'ok', detail: '1 slot' }), failing(REFUSED)]);
	assert.deepStrictEqual(client.dms, [
		`${MARK} **Health change detected**\n` +
		`${DOT} **apMedia**: \`ok\` ${ARROW} \`error\`\n` +
		`${DOT} **apMedia**, new: \`ZackPlex\` refused by its room (\`InvalidSlot\`)${REPORT}`
	]);
	assert.deepStrictEqual(problemLogs(), ['Health check: new problem: apMedia: `ZackPlex` refused by its room (`InvalidSlot`)']);
});

test('a check without problems behaves as before', async (t) => {
	const client = await run(t, [{ plex: { status: 'ok' } }, { plex: { status: 'error' } }, { plex: { status: 'error' } }]);
	assert.deepStrictEqual(client.dms, [
		`${MARK} **Health change detected**\n${DOT} **plex**: \`ok\` ${ARROW} \`error\`${REPORT}`
	]);
	assert.deepStrictEqual(problemLogs(), []);
});

test('two new problems take the plural title, and a changed reason is a new key', async (t) => {
	const slotData = { key: 'refused:0::zackplex:slot_data', text: '`ZackPlex` refused by its room (`slot_data`)' };
	const client = await run(t, [failing(REFUSED), failing(slotData, ORPHANED)]);
	assert.deepStrictEqual(client.dms, [
		`${MARK} **New health problems**\n` +
		`${DOT} **apMedia**: \`ZackPlex\` refused by its room (\`slot_data\`)\n` +
		`${DOT} **apMedia**: \`Friend\` lost watch #1${REPORT}`
	]);
	assert.ok(logs.info.includes('Health check: cleared: apMedia: `ZackPlex` refused by its room (`InvalidSlot`)'));
});

test('without an ownerId a new problem is only logged', async (t) => {
	config.ownerId = '';
	const client = await run(t, [failing(REFUSED), failing(REFUSED, ORPHANED)]);
	assert.deepStrictEqual(client.dms, []);
	assert.deepStrictEqual(problemLogs(), ['Health check: new problem: apMedia: `Friend` lost watch #1']);
});

test('the disabled details name the /config group', () => {
	const source = fs.readFileSync(path.join(ROOT, 'helpers/healthCheck.js'), 'utf8');
	const details = [...source.matchAll(/status: 'disabled', detail: '([^']*)'/g)]
		.map((m) => JSON.parse('"' + m[1] + '"'));
	assert.deepStrictEqual(details, [
		`tautulliEnabled is off (/config ${ARROW} Integrations)`,
		`playniteEnabled is off (/config ${ARROW} Integrations)`,
		`eventServerEnabled is off (/config ${ARROW} Broadcasts, then a restart)`,
		`archipelagoEnabled is off (/config ${ARROW} Archipelago)`
	]);
});
