// helpers/discordRetry.js inside a real @discordjs/rest REST instance.
//
// The bug: a send made while discord.com could not be reached failed at once, because
// @discordjs/rest retries only AbortError and ECONNRESET (see test/discordRetry.test.js).
//
// Harness: the REST instance discord.js itself uses, with its api pointed at a port on 127.0.0.1
// that first refuses connections and then gets a server. Short REST timeouts and waits stand in
// for the bot's 30 s and 1-8 s, so the attempt boundaries (discord.js's own AbortError retries)
// are crossed in a few seconds. Nothing here contacts Discord.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { REST } = require('discord.js');
const discordRetry = require('../helpers/discordRetry.js');

const CHANNEL_ID = '100000000000000001';

function fakeLogger() {
	const lines = [];
	return {
		lines,
		info: (...a) => lines.push(['info', a.join(' ')]),
		warn: (...a) => lines.push(['warn', a.join(' ')]),
		error: (...a) => lines.push(['error', a.join(' ')]),
		debug: () => {}
	};
}

// A port nothing listens on, so connecting to it is refused.
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function fakeDiscord(port, { answerMs = 0 } = {}) {
	const posts = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => { body += c; });
		req.on('end', () => {
			if (req.method === 'POST') posts.push({ url: req.url, body: JSON.parse(body), at: Date.now() });
			const answer = () => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ id: '100000000000000009', channel_id: CHANNEL_ID, content: 'ok' }));
			};
			if (answerMs > 0) setTimeout(answer, answerMs);
			else answer();
		});
	});
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, posts })));
}

// Closes the server and any response it is still holding back.
function closeFake(fake) {
	return new Promise((resolve) => {
		if (!fake) return resolve();
		fake.server.close(resolve);
		fake.server.closeAllConnections();
	});
}

function restFor(port, log, { timeout }) {
	// The margin keeps the bot's 15 of 30 s. Without it, a try late in a window on a cold process
	// (undici's first request is slow) is cut off after its POST and posts twice.
	const makeRequest = discordRetry.createMakeRequest({ delaysMs: [100, 200, 400], windowMs: timeout, startMarginMs: timeout * 0.5, settleMs: 500, logger: log });
	const rest = new REST({
		api: `http://127.0.0.1:${port}`,
		timeout,
		makeRequest,
		hashSweepInterval: 0,
		handlerSweepInterval: 0
	});
	rest.setToken('not-a-real-token');
	return rest;
}

test('a message sent while the port refuses arrives once when the server comes up', async (t) => {
	const port = await freePort();
	const log = fakeLogger();
	// 4 attempts of 1 s: the server comes up during the second, after one AbortError retry.
	const rest = restFor(port, log, { timeout: 1000 });
	let fake = null;
	const upAt = Date.now() + 1500;
	const starting = new Promise((resolve) => setTimeout(() => fakeDiscord(port).then((f) => { fake = f; resolve(); }), 1500));
	t.after(() => new Promise((resolve) => (fake ? fake.server.close(resolve) : resolve())));

	const started = Date.now();
	const sent = await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'The Red Planet' } });
	await starting;

	assert.strictEqual(sent.content, 'ok');
	assert.ok(Date.now() >= upAt, 'it resolved only once the server was up');
	assert.ok(Date.now() - started < 4000, `it went through soon after (${Date.now() - started} ms)`);
	assert.strictEqual(fake.posts.length, 1, 'posted exactly once');
	assert.deepStrictEqual(fake.posts[0].body, { content: 'The Red Planet' });
	assert.strictEqual(fake.posts[0].url, `/v10/channels/${CHANNEL_ID}/messages`);
	assert.deepStrictEqual(log.lines.map((l) => l[0]), ['warn', 'info']);
	assert.match(log.lines[1][1], /^Discord reachable again after \d+ s; 1 send went through late$/);
});

test('a later message in the same channel waits behind the held one', async (t) => {
	const port = await freePort();
	const log = fakeLogger();
	const rest = restFor(port, log, { timeout: 1000 });
	let fake = null;
	const starting = new Promise((resolve) => setTimeout(() => fakeDiscord(port).then((f) => { fake = f; resolve(); }), 800));
	t.after(() => new Promise((resolve) => (fake ? fake.server.close(resolve) : resolve())));

	const route = `/channels/${CHANNEL_ID}/messages`;
	const first = rest.post(route, { body: { content: 'first' } });
	await new Promise((r) => setTimeout(r, 50));
	const second = rest.post(route, { body: { content: 'second' } });
	await Promise.all([first, second, starting]);

	assert.deepStrictEqual(fake.posts.map((p) => p.body.content), ['first', 'second']);
});

test('a window that closes while still connecting moves on to the next attempt', async (t) => {
	const port = await freePort();
	const fake = await fakeDiscord(port);
	t.after(() => new Promise((resolve) => fake.server.close(resolve)));
	const log = fakeLogger();
	// Stands in for undici's 10 s connect timeout against a 30 s window: each try hangs 150 ms and
	// then fails, so the 400 ms windows mostly close in the middle of a try.
	const upAt = Date.now() + 1000;
	const { DefaultRestOptions } = require('discord.js');
	let hung = 0;
	// Each discord.js attempt has its own AbortController, so its signal names the window.
	const hungWindows = new Set();
	const base = (url, init) => {
		if (Date.now() >= upAt) return DefaultRestOptions.makeRequest(url, init);
		hung++;
		hungWindows.add(init.signal);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), 150);
			init.signal.addEventListener('abort', () => {
				clearTimeout(timer);
				reject(new DOMException('This operation was aborted', 'AbortError'));
			}, { once: true });
		});
	};
	const rest = new REST({
		api: `http://127.0.0.1:${port}`,
		timeout: 400,
		makeRequest: discordRetry.createMakeRequest({ base, delaysMs: [100], settleMs: 500, logger: log }),
		hashSweepInterval: 0,
		handlerSweepInterval: 0
	});
	rest.setToken('not-a-real-token');

	const sent = await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'Dust Season' } });

	assert.strictEqual(sent.content, 'ok');
	assert.ok(Date.now() >= upAt);
	assert.ok(hung >= 2, `it kept trying while connects hung (${hung} tries)`);
	assert.ok(hungWindows.size >= 2, `it moved on to a new window before getting through (${hungWindows.size} windows)`);
	assert.strictEqual(fake.posts.length, 1, 'posted exactly once');
	assert.deepStrictEqual(log.lines.map((l) => l[0]), ['warn', 'info']);
});

test('a send that never gets through fails with the connect error after its attempts', async () => {
	const port = await freePort();
	const log = fakeLogger();
	const rest = restFor(port, log, { timeout: 400 });

	const started = Date.now();
	await assert.rejects(
		rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'lost' } }),
		(err) => err.code === 'ECONNREFUSED'
	);
	const took = Date.now() - started;

	assert.ok(took >= 1500 && took < 4000, `4 attempts of 400 ms (${took} ms)`);
	const gaveUp = log.lines.filter((l) => /gave up/.test(l[1]));
	assert.strictEqual(gaveUp.length, 1);
	assert.match(gaveUp[0][1], /^Discord send gave up after \d+ s: POST \/channels\/:id\/messages \(.*ECONNREFUSED.*\)$/);
});

// The bug: a held try could start in the last moments of a 30 s window, after the backoff wait or
// woken by another send going through. When it connected and sent the POST just before the window
// closed, the abort came back as an AbortError and discord.js sent the message a second time.
//
// Below, a 1 s window stands in for the 30 s one and a 600 ms margin for the 15 s one.

test('a held try does not start so late in its window that the abort would post it twice', async (t) => {
	const port = await freePort();
	const log = fakeLogger();
	let fake = null;
	const starting = new Promise((resolve) => setTimeout(() => fakeDiscord(port, { answerMs: 400 }).then((f) => { fake = f; resolve(); }), 300));
	t.after(() => starting.then(() => closeFake(fake)));
	// Without the margin the second try starts at 750 ms and its answer lands after the 1 s abort.
	const rest = new REST({
		api: `http://127.0.0.1:${port}`,
		timeout: 1000,
		makeRequest: discordRetry.createMakeRequest({ delaysMs: [750], windowMs: 1000, startMarginMs: 600, settleMs: 500, logger: log }),
		hashSweepInterval: 0,
		handlerSweepInterval: 0
	});
	rest.setToken('not-a-real-token');

	const sent = await rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'The Red Planet' } });
	await starting;

	assert.strictEqual(sent.content, 'ok');
	assert.strictEqual(fake.posts.length, 1, 'posted exactly once');
	assert.deepStrictEqual(log.lines.map((l) => l[0]), ['warn', 'info']);
	assert.match(log.lines[1][1], /; 1 send went through late$/);
});

test('another send going through does not wake a held request inside its margin', async (t) => {
	const port = await freePort();
	const fake = await fakeDiscord(port);
	t.after(() => closeFake(fake));
	const log = fakeLogger();
	const { DefaultRestOptions } = require('discord.js');
	const heldRoute = `/channels/${CHANNEL_ID}/messages`;
	const heldTries = [];
	let started = 0;
	// The held request's first connect fails only after 600 ms, already inside its margin.
	const base = (url, init) => {
		if (!String(url).includes(heldRoute)) return DefaultRestOptions.makeRequest(url, init);
		heldTries.push(Date.now() - started);
		if (heldTries.length > 1) return DefaultRestOptions.makeRequest(url, init);
		return new Promise((resolve, reject) => setTimeout(() => reject(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), 600));
	};
	const rest = new REST({
		api: `http://127.0.0.1:${port}`,
		timeout: 1000,
		makeRequest: discordRetry.createMakeRequest({ base, delaysMs: [5000], windowMs: 1000, startMarginMs: 600, settleMs: 500, logger: log }),
		hashSweepInterval: 0,
		handlerSweepInterval: 0
	});
	rest.setToken('not-a-real-token');

	started = Date.now();
	const held = rest.post(heldRoute, { body: { content: 'The Red Planet' } });
	await new Promise((r) => setTimeout(r, 750));
	await rest.post('/channels/100000000000000002/messages', { body: { content: 'Dust Season' } });
	const sent = await held;

	assert.strictEqual(sent.content, 'ok');
	assert.strictEqual(heldTries.length, 2);
	assert.ok(heldTries[1] >= 950, `the second try waited for the next window (${heldTries[1]} ms)`);
	assert.strictEqual(fake.posts.filter((p) => p.url.includes(CHANNEL_ID)).length, 1);
});

// The bug: on the last attempt, a held try cut off by the window after its body went out was
// reported as an old connect error with "Discord send gave up", though the message had arrived.

test('a last try cut off after it was sent ends as a timeout and not as a give-up', async (t) => {
	const port = await freePort();
	const log = fakeLogger();
	let fake = null;
	const starting = new Promise((resolve) => setTimeout(() => fakeDiscord(port, { answerMs: 900 }).then((f) => { fake = f; resolve(); }), 300));
	t.after(() => starting.then(() => closeFake(fake)));
	const rest = new REST({
		api: `http://127.0.0.1:${port}`,
		retries: 0,
		timeout: 1000,
		makeRequest: discordRetry.createMakeRequest({ retries: 0, delaysMs: [750], windowMs: 1000, startMarginMs: 600, settleMs: 500, logger: log }),
		hashSweepInterval: 0,
		handlerSweepInterval: 0
	});
	rest.setToken('not-a-real-token');

	await assert.rejects(
		rest.post(`/channels/${CHANNEL_ID}/messages`, { body: { content: 'The Red Planet' } }),
		(err) => err.name === 'AbortError'
	);
	await starting;

	assert.strictEqual(fake.posts.length, 1);
	assert.strictEqual(log.lines.filter((l) => /gave up/.test(l[1])).length, 0);
	const timedOut = log.lines.filter((l) => /may have gone through/.test(l[1]));
	assert.strictEqual(timedOut.length, 1);
	assert.match(timedOut[0][1], /^Discord send timed out after \d+ s and may have gone through: POST \/channels\/:id\/messages$/);
});
