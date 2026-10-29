// helpers/discordRetry.js: Discord REST requests held through a connect outage.
//
// The bug: the PC's Wi-Fi regularly cannot open a connection to discord.com for seconds to
// minutes. undici throws ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT) and @discordjs/rest
// retries only AbortError and ECONNRESET, so the send failed at once. On 2026-10-27 12 of about
// 24 music now-playing messages in one hour were lost that way, along with book card updates,
// command replies and AP relay posts (2026-10-29 report: "some messages don't retry if the
// sending is missed").
//
// Harness: createMakeRequest with a fake base strategy and millisecond delays. Nothing here opens
// a socket; test/discordRetryRest.test.js runs a real REST instance against a local server.

const test = require('node:test');
const assert = require('node:assert');
const discordRetry = require('../helpers/discordRetry.js');

const CHANNEL_URL = 'https://discord.test/api/v10/channels/100000000000000001/messages';
const CALLBACK_URL = 'https://discord.test/api/v10/interactions/100000000000000002/not-a-token/callback';
const WEBHOOK_URL = 'https://discord.test/api/v10/webhooks/100000000000000003/not-a-token/messages/@original';

function connectTimeout() {
	return Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' });
}

function lookupFailure() {
	return Object.assign(new Error('getaddrinfo ENOTFOUND discord.test'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' });
}

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

// Fails with each of `errors` in turn, then answers 200.
function fakeBase(errors) {
	const calls = [];
	const queue = [...errors];
	const base = async (url, init) => {
		calls.push({ url, init, at: Date.now() });
		if (queue.length) throw queue.shift();
		return { status: 200, ok: true, headers: new Map() };
	};
	return { base, calls };
}

function make(base, extra = {}) {
	const log = fakeLogger();
	const makeRequest = discordRetry.createMakeRequest({ base, delaysMs: [5, 10, 20], settleMs: 200, retries: 3, logger: log, ...extra });
	return { makeRequest, log };
}

test('a connect timeout is retried until the request goes through', async () => {
	const { base, calls } = fakeBase([connectTimeout(), connectTimeout()]);
	const { makeRequest, log } = make(base);

	const res = await makeRequest(CHANNEL_URL, { method: 'POST', body: '{"content":"x"}', headers: {} });

	assert.strictEqual(res.status, 200);
	assert.strictEqual(calls.length, 3);
	assert.ok(calls[1].at - calls[0].at >= 4, 'it waits between tries');
	assert.deepStrictEqual(log.lines.map(l => l[0]), ['warn', 'info']);
	assert.match(log.lines[0][1], /^Discord is unreachable; holding sends and retrying$/);
	assert.match(log.lines[1][1], /^Discord reachable again after \d+ s; 1 send went through late$/);
});

test('a dns failure is retried until the request goes through', async () => {
	const { base, calls } = fakeBase([lookupFailure()]);
	const { makeRequest } = make(base);

	const res = await makeRequest(WEBHOOK_URL, { method: 'PATCH', body: '{}', headers: {} });

	assert.strictEqual(res.status, 200);
	assert.strictEqual(calls.length, 2, 'a webhook follow-up is held like any other send');
});

test('an abort during the wait ends the attempt with an AbortError', async () => {
	const { base, calls } = fakeBase([connectTimeout(), connectTimeout(), connectTimeout()]);
	const { makeRequest } = make(base, { delaysMs: [60000] });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);

	const started = Date.now();
	await assert.rejects(
		makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {}, signal: controller.signal }),
		(err) => err.name === 'AbortError'
	);
	assert.ok(Date.now() - started < 5000, 'the abort ends the wait at once');
	assert.strictEqual(calls.length, 1);
});

test('an error that may have reached discord is rethrown without a retry', async () => {
	const midRequest = [
		Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', cause: { code: 'ETIMEDOUT', syscall: 'read' } }),
		Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
		Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
		Object.assign(new Error('write EHOSTUNREACH'), { code: 'EHOSTUNREACH', syscall: 'write' })
	];
	for (const err of midRequest) {
		const { base, calls } = fakeBase([err]);
		const { makeRequest, log } = make(base);
		await assert.rejects(makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {} }), (got) => got === err);
		assert.strictEqual(calls.length, 1, `${err.code} is not retried`);
		assert.deepStrictEqual(log.lines, [], `${err.code} starts no outage`);
	}
});

test('an http error status comes back as it is', async () => {
	let calls = 0;
	const base = async () => { calls++; return { status: 500, ok: false, headers: new Map() }; };
	const { makeRequest } = make(base);

	const res = await makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {} });

	assert.strictEqual(res.status, 500);
	assert.strictEqual(calls, 1);
});

test('an interaction callback is never retried', async () => {
	const err = connectTimeout();
	const { base, calls } = fakeBase([err]);
	const { makeRequest, log } = make(base);

	await assert.rejects(makeRequest(CALLBACK_URL, { method: 'POST', body: '{"type":5}', headers: {} }), (got) => got === err);

	assert.strictEqual(calls.length, 1);
	assert.match(log.lines[0][1], /^Discord is unreachable/, 'it still counts as the start of an outage');
});

test('a stream body is not retried, since the first try used it up', async () => {
	const err = connectTimeout();
	const { base, calls } = fakeBase([err]);
	const { makeRequest } = make(base);
	async function* chunks() { yield Buffer.from('x'); }

	await assert.rejects(makeRequest(CHANNEL_URL, { method: 'POST', body: chunks(), headers: {} }), (got) => got === err);
	assert.strictEqual(calls.length, 1);
});

test('one outage logs one line when it starts and one when it ends', async () => {
	const { base, calls } = fakeBase([connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout()]);
	const { makeRequest, log } = make(base, { delaysMs: [15] });

	const results = await Promise.all([1, 2, 3].map(() => makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {} })));

	assert.ok(results.every(r => r.status === 200));
	assert.ok(calls.length >= 9);
	assert.deepStrictEqual(log.lines.map(l => l[0]), ['warn', 'info']);
	assert.match(log.lines[1][1], /; 3 sends went through late$/);
});

test('the last attempt gives up with the connect error and says so once', async () => {
	const err = connectTimeout();
	const base = async () => { throw err; };
	const { makeRequest, log } = make(base, { retries: 1 });
	// One headers object for every attempt of a request, the way @discordjs/rest passes it.
	const init = { method: 'POST', body: '{}', headers: {} };
	const attempt = () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 40);
		return makeRequest(CHANNEL_URL, { ...init, signal: controller.signal });
	};

	await assert.rejects(attempt(), (got) => got.name === 'AbortError', 'not the last attempt: discord.js gets to try again');
	await assert.rejects(attempt(), (got) => got === err);

	const gaveUp = log.lines.filter(l => /gave up/.test(l[1]));
	assert.strictEqual(gaveUp.length, 1);
	assert.match(gaveUp[0][1], /^Discord send gave up after \d+ s: POST \/channels\/:id\/messages \(Connect Timeout Error\)$/);
	assert.strictEqual(log.lines.filter(l => /unreachable/.test(l[1])).length, 1);
});

// The bug: when the window's last allowed try failed fast (refused, DNS, Wi-Fi off) right at the
// margin, the wait left was 0 and the loop retried back to back until the timer slack ran out,
// about 5 extra connects per held request in 100 ms.
//
// Harness: a fake clock that each try moves to its scripted time, frozen in between, so the old
// code would burst until the abort.

test('after the last allowed try in a window fails fast, nothing else is tried in that window', async () => {
	let clock = 0;
	const script = [0, 250, 400];
	const tries = [];
	const base = async () => {
		if (tries.length < script.length) clock = script[tries.length];
		tries.push(clock);
		throw Object.assign(new Error('connect ECONNREFUSED 162.159.135.232:443'), { code: 'ECONNREFUSED', syscall: 'connect' });
	};
	// The window's last start is 1000 - 600 = 400 on the fake clock.
	const { makeRequest } = make(base, { delaysMs: [5], windowMs: 1000, startMarginMs: 600, now: () => clock });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);

	await assert.rejects(
		makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {}, signal: controller.signal }),
		(err) => err.name === 'AbortError'
	);

	assert.deepStrictEqual(tries, [0, 250, 400]);
	assert.strictEqual(tries.filter((t) => t >= 400).length, 1, 'exactly one try at or after the last start');
});

// The bug: the start margin also applied to the last attempt, which discord.js never retries, so
// it bought no duplicate protection there. A connection that came back in the last 15 s of the
// last window was never used and the message was lost while Discord was reachable.

test('on the last attempt a connection that comes back inside the margin is still used', async () => {
	let clock = 0;
	const script = [0, 450, 500];
	const tries = [];
	const base = async () => {
		clock = script[Math.min(tries.length, script.length - 1)];
		tries.push(clock);
		if (tries.length < script.length) throw connectTimeout();
		return { status: 200, ok: true, headers: new Map() };
	};
	// With the margin the last start would be 1000 - 600 = 400 on the fake clock.
	const { makeRequest, log } = make(base, { retries: 0, delaysMs: [5], windowMs: 1000, startMarginMs: 600, now: () => clock });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);

	const res = await makeRequest(CHANNEL_URL, { method: 'POST', body: '{}', headers: {}, signal: controller.signal });
	clearTimeout(timer);

	assert.strictEqual(res.status, 200);
	assert.deepStrictEqual(tries, [0, 450, 500]);
	assert.strictEqual(log.lines.filter((l) => /gave up/.test(l[1])).length, 0);
});

// The bug: @discordjs/rest re-runs a request after a 429 without counting a retry, but every call
// here counted as an attempt, so a request that met a 429 before an outage gave up a window early.

test('a 429 before an outage does not cost the request one of its windows', async () => {
	const err = connectTimeout();
	let calls = 0;
	const base = async () => {
		calls++;
		if (calls === 1) return { status: 429, ok: false, headers: new Map() };
		throw err;
	};
	const { makeRequest, log } = make(base, { retries: 1 });
	const init = { method: 'POST', body: '{}', headers: {} };
	const attempt = () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 40);
		return makeRequest(CHANNEL_URL, { ...init, signal: controller.signal });
	};

	const limited = await makeRequest(CHANNEL_URL, { ...init, signal: new AbortController().signal });
	assert.strictEqual(limited.status, 429);
	await assert.rejects(attempt(), (got) => got.name === 'AbortError', 'retries 1 still leaves a second window');
	await assert.rejects(attempt(), (got) => got === err);

	assert.strictEqual(log.lines.filter((l) => /gave up/.test(l[1])).length, 1);
});

test('the margin is 15 s of a 30 s window', () => {
	assert.strictEqual(discordRetry.START_MARGIN_MS, 15000, '10 s connect timeout plus the 5 s stock discord.js leaves for the answer');
	assert.strictEqual(discordRetry.REST_TIMEOUT_MS, 30000);
	assert.strictEqual(discordRetry.restOptions().timeout, 30000);
});

test('connect failures are told apart from errors on an open connection', () => {
	const is = discordRetry.isConnectFailure;
	assert.strictEqual(is(connectTimeout()), true);
	assert.strictEqual(is(lookupFailure()), true);
	assert.strictEqual(is({ code: 'EAI_AGAIN', syscall: 'getaddrinfo' }), true);
	assert.strictEqual(is({ code: 'ECONNREFUSED', syscall: 'connect' }), true);
	assert.strictEqual(is({ code: 'ETIMEDOUT', syscall: 'connect' }), true);
	assert.strictEqual(is({ code: 'ENETUNREACH', syscall: 'connect' }), true);
	assert.strictEqual(is(new TypeError('fetch failed', { cause: connectTimeout() })), true);
	assert.strictEqual(is(Object.assign(new AggregateError([
		{ code: 'ECONNREFUSED', syscall: 'connect' },
		{ code: 'ENETUNREACH', syscall: 'connect' }
	]), { code: 'ECONNREFUSED' })), true);

	assert.strictEqual(is({ code: 'ETIMEDOUT', syscall: 'read' }), false);
	assert.strictEqual(is({ code: 'ECONNRESET', syscall: 'read' }), false);
	assert.strictEqual(is({ code: 'UND_ERR_BODY_TIMEOUT' }), false);
	assert.strictEqual(is(Object.assign(new Error('aborted'), { name: 'AbortError', code: 20 })), false);
	assert.strictEqual(is(null), false);
});

test('a log line names the route without ids or tokens', () => {
	assert.strictEqual(discordRetry.describeRoute('patch', WEBHOOK_URL), 'PATCH /webhooks/:id/:token/messages/@original');
	assert.strictEqual(discordRetry.isInteractionCallback(CALLBACK_URL), true);
	assert.strictEqual(discordRetry.isInteractionCallback(CALLBACK_URL + '?with_response=true'), true);
	assert.strictEqual(discordRetry.isInteractionCallback(WEBHOOK_URL), false);
});

test('the client options keep discord.js retries and give 2 minutes of holding', () => {
	const opts = discordRetry.restOptions();
	assert.strictEqual(typeof opts.makeRequest, 'function');
	assert.strictEqual(opts.retries, undefined, 'more AbortError retries would mean more duplicate posts');
	assert.strictEqual(opts.timeout * 4, 120000);
	assert.strictEqual(discordRetry.restOptions().makeRequest, opts.makeRequest, 'one outage state across !restart');
});
