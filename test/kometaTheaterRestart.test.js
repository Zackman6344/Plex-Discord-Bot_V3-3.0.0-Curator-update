// helpers/kometaTheater.js after !restart.
//
// The bugs: !restart started a second theater and nothing stopped the first. The old tailer kept
// polling meta.log from the same offset as the new one, so both read every new line and each
// collection was queued twice. The channel cached before the restart belonged to the destroyed
// client, so every post through it failed with "Expected token to be set". And work still in
// flight at the restart (a Gemini call, a Discord post, a log read) carried on as part of the old
// run: a finished report went into a discarded queue, a second worker loop started, and the
// sign-off could go out before the last report.
//
// Harness: the real theater against temporary meta.log files and a temporary data directory,
// with fake clients that record what they post and Gemini stubbed in require.cache so a test can
// hold a generation open. A collection that is unseen and empty is narrated as static, without
// Gemini. Real timers: the tailer polls every second and a collection waits GRACE_MS (3 s) for
// its webhook before it is generated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plexbot-theater-restart-'));
process.env.PLEXBOT_KOMETA_THEATER_DIR = DIR;

// Each generateContent call is named after the collection its prompt is about. With `hold` set,
// a call waits until the test releases it.
const NAMES = ['Gen One', 'Gen Two', 'Gen Three', 'Last One', 'Last Two'];
const gemini = { hold: false, calls: [] };
const geminiFile = require.resolve('../helpers/geminiAPI.js');
require.cache[geminiFile] = {
	id: geminiFile, filename: geminiFile, loaded: true,
	exports: {
		getModel: () => ({
			generateContent(prompt) {
				const name = NAMES.find((n) => prompt.includes(n)) || '?';
				const persona = /Invent a VIVID voice/.test(prompt);
				const text = persona ? JSON.stringify({ callsign: `Unit ${name}`, vibe: 'a test voice' }) : `report from ${name}`;
				const reply = { response: { text: () => text } };
				if (!gemini.hold) return Promise.resolve(reply);
				return new Promise((resolve) => {
					gemini.calls.push({ name, persona, released: false, release() { this.released = true; resolve(reply); } });
				});
			}
		})
	}
};

const config = require('../config/config.js');
const theater = require('../helpers/kometaTheater.js');

const KEYS = ['kometaTheaterEnabled', 'kometaLogPath', 'kometaChannelId', 'kometaTheaterDelayMs'];
let saved;
test.before(() => {
	saved = Object.fromEntries(KEYS.map((k) => [k, config[k]]));
	Object.assign(config, { kometaTheaterEnabled: true, kometaChannelId: 'THEATER', kometaTheaterDelayMs: 10 });
});
test.afterEach(() => {
	theater.stopKometaTheater();
	gemini.hold = false;
	for (const call of gemini.calls) if (!call.released) call.release();
	gemini.calls.length = 0;
});
test.after(() => {
	Object.assign(config, saved);
	fs.rmSync(DIR, { recursive: true, force: true });
	// A stop function that regresses leaves a timer or a tailer holding the process open, and the
	// run would hang after reporting the failure. Unref'd, this only fires in that case.
	setTimeout(() => process.exit(), 2000).unref();
});

// A log per test: a test that stops the theater leaves lines behind for the next start to resume.
function freshLog(name) {
	config.kometaLogPath = path.join(DIR, name);
	fs.writeFileSync(config.kometaLogPath, '');
	return config.kometaLogPath;
}

const posts = [];
function fakeClient(name, send) {
	const client = {
		channels: {
			fetch: async (id) => ({
				id,
				client,
				send: send || (async (payload) => { posts.push({ by: name, payload }); })
			})
		}
	};
	return client;
}

function collectionLines(name, total) {
	return `[INFO] | ${total} Movies Processed 0 Movies Added |\n[INFO] | Finished ${name} Collection |\n`;
}

function reportName(post) {
	const embed = post.payload.embeds && post.payload.embeds[0];
	return embed ? embed.data.footer.text : null;
}

function isStatic(post) {
	return /unidentified signal/.test(post.payload.content || '');
}

function isSignOff(post) {
	return /Signing off/.test(post.payload.content || '');
}

function pending(name) {
	return gemini.calls.filter((c) => !c.released && c.name === name);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, ms) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

function timeouts() {
	return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

test('after !restart each new collection is narrated once, through the new client', async () => {
	const log = freshLog('meta-restart.log');
	const start = posts.length;
	theater.startKometaTheater(fakeClient('old'));
	// A run before the restart, so the old client's channel is the one cached.
	theater.onRunStart();
	theater.onRunEnd();
	assert.ok(await waitFor(() => posts.length - start >= 2, 3000), 'the opener and closer went out');
	assert.deepStrictEqual(posts.slice(start).map((p) => p.by), ['old', 'old']);

	// No stop first: starting again has to replace the running theater by itself.
	theater.startKometaTheater(fakeClient('new'));
	await sleep(200);

	fs.appendFileSync(log, collectionLines('Restart Probe', 0));
	assert.ok(await waitFor(() => posts.length - start >= 4, 8000), 'the opener and the static report went out');
	// Long enough for a second tailer's copy of the collection to be generated and posted too.
	await sleep(1500);

	const after = posts.slice(start + 2);
	assert.deepStrictEqual(after.map((p) => p.by), ['new', 'new']);
	assert.match(after[0].payload.content, /Incoming transmission/);
	assert.strictEqual(after.filter(isStatic).length, 1, 'one report for one collection');
});

test('stopped, the theater reads no more of the log and leaves no timer behind', async () => {
	const log = freshLog('meta-stopped.log');
	const baseline = timeouts();
	theater.startKometaTheater(fakeClient('again'));
	await sleep(200);
	assert.ok(timeouts() > baseline, 'running, it has its tailer and worker timers');

	theater.stopKometaTheater();
	assert.strictEqual(timeouts(), baseline);

	const before = posts.length;
	fs.appendFileSync(log, collectionLines('Second Probe', 0));
	await sleep(1500);
	assert.strictEqual(posts.length, before);
});

test('a post still in flight when the theater stops does not start its loop again', async () => {
	freshLog('meta-in-flight.log');
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let closing = false;
	// The closer is the post the worker loop itself makes; it waits until released.
	theater.startKometaTheater(fakeClient('gated', async (payload) => {
		if (!/Signing off/.test(payload.content || '')) return;
		closing = true;
		await gate;
	}));
	theater.onRunStart();
	theater.onRunEnd();
	assert.ok(await waitFor(() => closing, 3000), 'the worker loop is posting the closer');

	theater.stopKometaTheater();
	const baseline = timeouts();
	release();
	await sleep(50);

	assert.strictEqual(timeouts(), baseline);
});

test('a collection still generating at !restart is posted, and the old run takes no other', async () => {
	const log = freshLog('meta-generation.log');
	const start = posts.length;
	gemini.hold = true;
	theater.startKometaTheater(fakeClient('old'));
	await sleep(200);
	fs.appendFileSync(log, collectionLines('Gen One', 5) + collectionLines('Gen Two', 5) + collectionLines('Gen Three', 5) + '[INFO] | Finished Run |\n');
	assert.ok(await waitFor(() => pending('Gen One').length === 1, 6000), 'the old run is generating Gen One');

	theater.stopKometaTheater();
	theater.startKometaTheater(fakeClient('new'));
	assert.ok(await waitFor(() => pending('Gen Two').length === 1, 3000), 'the new run took Gen Two');

	pending('Gen One')[0].release();
	assert.ok(await waitFor(() => pending('Gen One').length === 1, 1000), 'Gen One went on to its report');
	pending('Gen One')[0].release();
	// Gen Two is still held, so only a second loop could pick up Gen Three now.
	await sleep(1500);
	assert.strictEqual(gemini.calls.filter((c) => c.name === 'Gen Three').length, 0, 'the old run stopped after its collection');

	gemini.hold = false;
	for (const call of gemini.calls) if (!call.released) call.release();
	assert.ok(await waitFor(() => posts.slice(start).some(isSignOff), 8000), 'the run signed off');
	await sleep(300);

	const after = posts.slice(start);
	const reports = after.map(reportName).filter(Boolean);
	assert.deepStrictEqual([...reports].sort(), ['Gen One', 'Gen Three', 'Gen Two'], 'each collection reported once');
	assert.ok(isSignOff(after[after.length - 1]), 'the sign-off came last');
	assert.ok(after.filter((p) => reportName(p) || isSignOff(p)).every((p) => p.by === 'new'));
});

test('the run is not signed off while the new run still generates its last collection', async () => {
	const log = freshLog('meta-last.log');
	const start = posts.length;
	gemini.hold = true;
	theater.startKometaTheater(fakeClient('old'));
	await sleep(200);
	fs.appendFileSync(log, collectionLines('Last One', 5) + collectionLines('Last Two', 5) + '[INFO] | Finished Run |\n');
	assert.ok(await waitFor(() => pending('Last One').length === 1, 6000), 'the old run is generating Last One');

	theater.stopKometaTheater();
	theater.startKometaTheater(fakeClient('new'));
	assert.ok(await waitFor(() => pending('Last Two').length === 1, 3000), 'the new run took Last Two');

	// The old run finishes Last One while Last Two is still generating, with nothing left queued.
	pending('Last One')[0].release();
	assert.ok(await waitFor(() => pending('Last One').length === 1, 1000));
	pending('Last One')[0].release();
	assert.ok(await waitFor(() => posts.slice(start).some((p) => reportName(p) === 'Last One'), 3000), 'Last One was posted');
	await sleep(1500);
	assert.strictEqual(posts.slice(start).filter(isSignOff).length, 0, 'no sign-off with Last Two still generating');

	gemini.hold = false;
	for (const call of gemini.calls) if (!call.released) call.release();
	assert.ok(await waitFor(() => posts.slice(start).some(isSignOff), 5000), 'the run signed off');
	const after = posts.slice(start);
	assert.deepStrictEqual(after.map(reportName).filter(Boolean), ['Last One', 'Last Two']);
	assert.ok(isSignOff(after[after.length - 1]), 'the sign-off came last');
});

test('a log read that finishes after the stop is left to the next tailer', async (t) => {
	const log = freshLog('meta-read.log');
	const tailFile = path.join(DIR, 'kometa_theater_tail.json');
	const realOpen = fs.promises.open;
	t.after(() => { fs.promises.open = realOpen; });
	let release;
	const gate = { armed: false, held: false, promise: new Promise((resolve) => { release = resolve; }) };
	fs.promises.open = async function (file, ...rest) {
		const fh = await realOpen.call(this, file, ...rest);
		if (!gate.armed || file !== log) return fh;
		gate.armed = false;
		return {
			read: async (...args) => { gate.held = true; await gate.promise; return fh.read(...args); },
			close: () => fh.close()
		};
	};

	const start = posts.length;
	theater.startKometaTheater(fakeClient('old'));
	assert.ok(await waitFor(() => {
		try { return JSON.parse(fs.readFileSync(tailFile, 'utf8')).path === log; } catch (_) { return false; }
	}, 3000), 'the tailer saved where it started');

	gate.armed = true;
	fs.appendFileSync(log, collectionLines('Read Probe', 0));
	assert.ok(await waitFor(() => gate.held, 3000), 'the old tailer is reading the new lines');

	theater.stopKometaTheater();
	theater.startKometaTheater(fakeClient('new'));
	release();
	assert.ok(await waitFor(() => posts.slice(start).some(isStatic), 8000), 'the collection was narrated');
	await sleep(1500);

	// A second copy would not be static: by then the collection is seen, so it reports in.
	assert.strictEqual(posts.slice(start).filter((p) => isStatic(p) || reportName(p)).length, 1);
});
