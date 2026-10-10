// helpers/partProxy.js: the loopback proxy that lets ffmpeg read Plex parts without the token.
//
// The bug: without it the Plex token rides on ffmpeg's command line, readable by anything that
// lists processes. A proxy that forwarded any path, any method or any Host would hand that token
// to a DNS-rebinding web page; one that dropped Range would make every seek download from 0:00;
// and one with no header timeout leaves ffmpeg waiting forever on a Plex that accepted the
// connection and never answered.
//
// Harness: a fake Plex http server on 127.0.0.1 that answers 401 without the X-Plex-Token header
// (the injected-server pattern of test/helpers/apServer.js), with the proxy pointed at it through
// createPartProxy({ loadConfig }) so config/plex.js is never read.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createPartProxy } = require('../helpers/partProxy.js');

const TOKEN = 'synthetic-test-token-0000';
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const LIVE = '/library/parts/101/1700000000/file.mp3';
const DEAD = '/library/parts/404/1700000000/file.mp3';
const SILENT = '/library/parts/999/1700000000/file.mp3';
const TRICKLE = '/library/parts/555/1700000000/file.m4b';

const seen = [];
const upstreamClosed = [];
const silentSockets = [];

const fake = http.createServer((req, res) => {
	seen.push({ method: req.method, url: req.url, headers: req.headers });
	req.on('close', () => upstreamClosed.push(req.url));
	if (req.headers['x-plex-token'] !== TOKEN) {
		res.writeHead(401);
		res.end();
		return;
	}
	if (req.url === SILENT) {
		silentSockets.push(req.socket);
		return;
	}
	if (req.url === TRICKLE) {
		res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': '100000' });
		res.write(Buffer.alloc(10));
		return;
	}
	if (req.url !== LIVE) {
		res.writeHead(404);
		res.end();
		return;
	}
	const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
	if (m) {
		const start = Number(m[1]);
		const end = m[2] === '' ? BODY.length - 1 : Number(m[2]);
		res.writeHead(206, {
			'Content-Type': 'audio/mpeg',
			'Content-Length': String(end - start + 1),
			'Content-Range': `bytes ${start}-${end}/${BODY.length}`,
			'Accept-Ranges': 'bytes',
			'X-Plex-Internal': 'not-forwarded'
		});
		res.end(req.method === 'HEAD' ? undefined : BODY.subarray(start, end + 1));
		return;
	}
	res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(BODY.length), 'Accept-Ranges': 'bytes' });
	res.end(req.method === 'HEAD' ? undefined : BODY);
});

let fakePort = 0;
const fakeConfig = () => ({ hostname: '127.0.0.1', port: fakePort, https: false, token: TOKEN });

test.before(() => new Promise((resolve) => fake.listen(0, '127.0.0.1', () => {
	fakePort = fake.address().port;
	resolve();
})));

test.after(() => {
	for (const s of silentSockets) s.destroy();
	fake.closeAllConnections();
	return new Promise((resolve) => fake.close(() => resolve()));
});

function request(url, { method = 'GET', headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers, agent: false }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on('error', reject);
		req.end();
	});
}

async function withProxy(opts, fn) {
	const proxy = createPartProxy({ loadConfig: fakeConfig, ...opts });
	await proxy.start();
	try {
		return await fn(proxy);
	} finally {
		await proxy.stop();
	}
}

function captureWarnings() {
	const lines = [];
	const original = { warn: console.warn, log: console.log, error: console.error };
	console.warn = console.log = console.error = (...args) => lines.push(args.join(' '));
	return { lines, restore: () => Object.assign(console, original) };
}

test('start binds loopback once, concurrent callers share the bind, and port() reports it', async () => {
	const proxy = createPartProxy({ loadConfig: fakeConfig });
	assert.strictEqual(proxy.port(), 0);
	assert.throws(() => proxy.urlFor(LIVE), /not started/);
	const [a, b] = await Promise.all([proxy.start(), proxy.start()]);
	assert.strictEqual(a, b);
	assert.strictEqual(await proxy.start(), a);
	assert.strictEqual(proxy.port(), a);
	assert.match(proxy.urlFor(LIVE), new RegExp(`^http://127\\.0\\.0\\.1:${a}/[0-9a-f]{32}/library/parts/101/`));
	await proxy.stop();
	assert.strictEqual(proxy.port(), 0);
});

test('a stop during the first bind still leaves nothing listening', async () => {
	const proxy = createPartProxy({ loadConfig: fakeConfig });
	const binding = proxy.start();
	await proxy.stop();
	const port = await binding;
	assert.strictEqual(proxy.port(), 0);
	assert.throws(() => proxy.urlFor(LIVE), /not started/);
	await assert.rejects(request(`http://127.0.0.1:${port}/`), { code: 'ECONNREFUSED' });
});

test('two proxies get different 128-bit path secrets', async () => {
	await withProxy({}, async (p1) => withProxy({}, async (p2) => {
		const secretOf = (p) => new URL(p.urlFor(LIVE)).pathname.split('/')[1];
		assert.match(secretOf(p1), /^[0-9a-f]{32}$/);
		assert.notStrictEqual(secretOf(p1), secretOf(p2));
	}));
});

test('a Range request passes through with its status and range headers, token as a header only', async () => {
	await withProxy({}, async (proxy) => {
		const before = seen.length;
		const url = proxy.urlFor(LIVE);
		const res = await request(url, { headers: { Range: 'bytes=10-19', 'If-Range': '"etag-1"' } });
		assert.strictEqual(res.status, 206);
		assert.strictEqual(res.headers['content-range'], 'bytes 10-19/1000');
		assert.strictEqual(res.headers['content-length'], '10');
		assert.strictEqual(res.headers['accept-ranges'], 'bytes');
		assert.strictEqual(res.headers['content-type'], 'audio/mpeg');
		assert.strictEqual(res.headers['x-plex-internal'], undefined);
		assert.deepStrictEqual(res.body, BODY.subarray(10, 20));

		const up = seen.slice(before);
		assert.strictEqual(up.length, 1);
		assert.strictEqual(up[0].url, LIVE);
		assert.strictEqual(up[0].headers['x-plex-token'], TOKEN);
		assert.strictEqual(up[0].headers.range, 'bytes=10-19');
		assert.strictEqual(up[0].headers['if-range'], '"etag-1"');
		assert.ok(!url.includes(TOKEN));
		assert.ok(!up[0].url.includes(TOKEN));
	});
});

test('a plain GET and a HEAD pass through', async () => {
	await withProxy({}, async (proxy) => {
		const full = await request(proxy.urlFor(LIVE));
		assert.strictEqual(full.status, 200);
		assert.deepStrictEqual(full.body, BODY);
		const head = await request(proxy.urlFor(LIVE), { method: 'HEAD' });
		assert.strictEqual(head.status, 200);
		assert.strictEqual(head.headers['content-length'], '1000');
		assert.strictEqual(head.body.length, 0);
	});
});

test('a wrong secret, a non-part path, a foreign Host, a POST and a traversal segment get 404 without reaching Plex', async () => {
	await withProxy({}, async (proxy) => {
		const good = new URL(proxy.urlFor(LIVE));
		const secret = good.pathname.split('/')[1];
		const base = `http://127.0.0.1:${proxy.port()}`;
		const before = seen.length;
		const cases = [
			[`${base}/${'f'.repeat(32)}${LIVE}`, {}],
			[`${base}${LIVE}`, {}],
			[`${base}/${secret}/library/sections/1/all`, {}],
			[`${base}/${secret}/library/parts/101/1700000000/file.mp3?X-Plex-Token=x`, {}],
			[`${base}/${secret}/library/parts/101/1700000000/..%2F..%2Fsections`, {}],
			[`${base}/${secret}/library/parts/101/1700000000/%2e%2e`, {}],
			[good.href, { headers: { Host: `localhost:${proxy.port()}` } }],
			[good.href, { headers: { Host: `rebind.example:${proxy.port()}` } }],
			[good.href, { method: 'POST' }],
			[good.href, { method: 'PUT' }]
		];
		for (const [url, opts] of cases) {
			const res = await request(url, opts);
			assert.strictEqual(res.status, 404, `${opts.method || 'GET'} ${url} ${JSON.stringify(opts.headers || {})}`);
		}
		assert.strictEqual(seen.length, before);
	});
});

test('a client disconnect aborts the upstream request', async () => {
	await withProxy({}, async (proxy) => {
		const closedBefore = upstreamClosed.filter((u) => u === TRICKLE).length;
		await new Promise((resolve, reject) => {
			const req = http.get(proxy.urlFor(TRICKLE), { agent: false }, (res) => {
				res.once('data', () => {
					req.destroy();
					resolve();
				});
			});
			req.on('error', () => {});
			setTimeout(() => reject(new Error('no body from the trickling upstream')), 2000);
		});
		const deadline = Date.now() + 2000;
		while (upstreamClosed.filter((u) => u === TRICKLE).length === closedBefore) {
			assert.ok(Date.now() < deadline, 'upstream request still open after the client left');
			await new Promise((r) => setTimeout(r, 10));
		}
	});
});

test('an upstream that never answers gives 504 after the header timeout and logs neither token nor secret', async () => {
	await withProxy({ headerTimeoutMs: 150 }, async (proxy) => {
		const secret = new URL(proxy.urlFor(SILENT)).pathname.split('/')[1];
		const out = captureWarnings();
		let res;
		const started = Date.now();
		try {
			res = await request(proxy.urlFor(SILENT));
		} finally {
			out.restore();
		}
		assert.strictEqual(res.status, 504);
		assert.ok(Date.now() - started >= 140);
		const logged = out.lines.join('\n');
		assert.match(logged, /part 999/);
		assert.ok(!logged.includes(TOKEN));
		assert.ok(!logged.includes(secret));
	});
});

test('the header timeout does not cut a body that is slow after its headers', async () => {
	await withProxy({ headerTimeoutMs: 100 }, async (proxy) => {
		const res = await new Promise((resolve) => {
			const req = http.get(proxy.urlFor(TRICKLE), { agent: false }, resolve);
			req.on('error', () => {});
		});
		assert.strictEqual(res.statusCode, 200);
		let aborted = false;
		res.on('aborted', () => { aborted = true; });
		res.on('error', () => { aborted = true; });
		res.resume();
		await new Promise((r) => setTimeout(r, 300));
		assert.strictEqual(aborted, false);
		res.destroy();
	});
});

test('an unreachable Plex gives 502 without logging the token', async () => {
	const closed = http.createServer();
	await new Promise((r) => closed.listen(0, '127.0.0.1', r));
	const deadPort = closed.address().port;
	await new Promise((r) => closed.close(r));
	const proxy = createPartProxy({ loadConfig: () => ({ hostname: '127.0.0.1', port: deadPort, https: false, token: TOKEN }) });
	await proxy.start();
	const out = captureWarnings();
	try {
		const res = await request(proxy.urlFor(LIVE));
		assert.strictEqual(res.status, 502);
	} finally {
		out.restore();
		await proxy.stop();
	}
	assert.ok(!out.lines.join('\n').includes(TOKEN));
});

test('probe starts the proxy lazily and reports 206 for a live part and 404 for a dead one', async () => {
	const proxy = createPartProxy({ loadConfig: fakeConfig });
	try {
		const before = seen.length;
		assert.deepStrictEqual(await proxy.probe(LIVE), { ok: true, status: 206 });
		assert.ok(proxy.port() > 0);
		assert.strictEqual(seen[before].headers.range, 'bytes=0-0');
		assert.deepStrictEqual(await proxy.probe(DEAD), { ok: false, status: 404 });
	} finally {
		await proxy.stop();
	}
});

test('probe gives up with status timeout against a silent upstream', async () => {
	await withProxy({ probeTimeoutMs: 100, headerTimeoutMs: 5000 }, async (proxy) => {
		const closedBefore = upstreamClosed.filter((u) => u === SILENT).length;
		const started = Date.now();
		assert.deepStrictEqual(await proxy.probe(SILENT), { ok: false, status: 'timeout' });
		const took = Date.now() - started;
		assert.ok(took >= 90 && took < 2000, `took ${took} ms`);
		const deadline = Date.now() + 2000;
		while (upstreamClosed.filter((u) => u === SILENT).length === closedBefore) {
			assert.ok(Date.now() < deadline, 'probe left the upstream request open');
			await new Promise((r) => setTimeout(r, 10));
		}
	});
});

test('the fake Plex refuses a request without the token header', async () => {
	const res = await request(`http://127.0.0.1:${fakePort}${LIVE}`);
	assert.strictEqual(res.status, 401);
});
