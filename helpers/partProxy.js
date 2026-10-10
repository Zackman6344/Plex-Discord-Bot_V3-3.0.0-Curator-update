// helpers/partProxy.js
//
// A loopback HTTP proxy between ffmpeg and Plex, so the Plex token never appears on ffmpeg's
// command line. A command line travels further than a file: Task Manager during a screen share,
// crash dumps, AV telemetry, diagnostic transcripts, and /proc/<pid>/cmdline on Linux. ffmpeg
// gets http://127.0.0.1:<port>/<secret>/library/parts/<id>/<ts>/<file>, and only this process
// adds the token, as a header.
//
// The secret is 128 random bits per boot and the proxy only forwards GET and HEAD of part files,
// so what could leak reads audio parts, from loopback, while this process runs.
//
// config/plex.js is read per request rather than at require time, so requiring this module in a
// test never needs the real config, and createPartProxy({ loadConfig }) points an instance at a
// fake Plex.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const logger = require('./logger.js');

const HEADER_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 5000;
const PASS_UP = ['range', 'if-range'];
const PASS_DOWN = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

function partIdOf(path) {
	const m = /^\/library\/parts\/(\d+)\//.exec(path || '');
	return m ? m[1] : '?';
}

// The upstream path is sent to Plex as is, so a last segment that decodes to a separator or a
// dot segment could walk out of /library/parts on a server that normalises after decoding.
function safeFileSegment(segment) {
	let decoded;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return false;
	}
	return decoded !== '.' && decoded !== '..' && !/[/\\]/.test(decoded);
}

function createPartProxy({
	loadConfig = () => require('../config/plex'),
	headerTimeoutMs = HEADER_TIMEOUT_MS,
	probeTimeoutMs = PROBE_TIMEOUT_MS
} = {}) {
	const secret = crypto.randomBytes(16).toString('hex');
	const pathRe = new RegExp(`^/${secret}(/library/parts/\\d+/\\d+/([^/?#]+))$`);
	let server = null;
	let starting = null;
	let boundPort = 0;

	function refuse(res) {
		res.writeHead(404);
		res.end();
	}

	function forward(req, res, path) {
		const cfg = loadConfig();
		const headers = { 'X-Plex-Token': cfg.token };
		for (const name of PASS_UP) {
			if (req.headers[name] !== undefined) headers[name] = req.headers[name];
		}
		const lib = cfg.https ? https : http;
		const up = lib.request({ hostname: cfg.hostname, port: cfg.port, path, method: req.method, headers });
		let settled = false;
		const fail = (status) => {
			if (settled) return;
			settled = true;
			clearTimeout(headerTimer);
			up.destroy();
			if (!res.headersSent) {
				res.writeHead(status);
				res.end();
			} else {
				res.destroy();
			}
		};

		// A timer rather than up.setTimeout(): the socket idle timeout keeps running after the
		// headers, and once ffmpeg's output backs up the body socket legitimately sits idle for
		// longer than this. A stall mid-body is the player's maxMissedFrames to catch.
		const headerTimer = setTimeout(() => {
			if (settled) return;
			logger.warn(`Audiobook proxy: Plex sent no headers for part ${partIdOf(path)} within ${headerTimeoutMs} ms`);
			fail(504);
		}, headerTimeoutMs);

		up.on('response', (upRes) => {
			clearTimeout(headerTimer);
			if (settled) {
				upRes.destroy();
				return;
			}
			const out = {};
			for (const name of PASS_DOWN) {
				if (upRes.headers[name] !== undefined) out[name] = upRes.headers[name];
			}
			res.writeHead(upRes.statusCode, out);
			upRes.on('error', () => fail(502));
			upRes.pipe(res);
		});
		up.on('error', (err) => {
			if (settled) return;
			logger.warn(`Audiobook proxy: Plex request for part ${partIdOf(path)} failed: ${err.code || err.message}`);
			fail(502);
		});
		res.on('close', () => {
			clearTimeout(headerTimer);
			if (!res.writableFinished) {
				settled = true;
				up.destroy();
			}
		});
		up.end();
	}

	function onRequest(req, res) {
		const m = pathRe.exec(req.url || '');
		// The Host check is the DNS-rebinding guard: a web page can make a browser on this
		// machine request a name that resolves to 127.0.0.1, but not send this Host.
		if ((req.method !== 'GET' && req.method !== 'HEAD')
			|| req.headers.host !== `127.0.0.1:${boundPort}`
			|| !m || !safeFileSegment(m[2])) {
			refuse(res);
			return;
		}
		try {
			forward(req, res, m[1]);
		} catch (err) {
			logger.warn(`Audiobook proxy: could not reach Plex for part ${partIdOf(m[1])}: ${err.message}`);
			if (!res.headersSent) {
				res.writeHead(502);
				res.end();
			} else {
				res.destroy();
			}
		}
	}

	/** Bind on first use. Resolves with the port; concurrent callers share one bind. */
	function start() {
		if (server) return Promise.resolve(boundPort);
		if (starting) return starting;
		const s = http.createServer(onRequest);
		starting = new Promise((resolve, reject) => {
			s.once('error', (err) => {
				starting = null;
				reject(err);
			});
			s.listen(0, '127.0.0.1', () => {
				s.unref();
				server = s;
				boundPort = s.address().port;
				starting = null;
				resolve(boundPort);
			});
		});
		return starting;
	}

	function stop() {
		const s = server;
		// A shutdown during the first play's bind would otherwise leave the server listening.
		if (!s && starting) return starting.then(() => stop(), () => {});
		server = null;
		boundPort = 0;
		if (!s) return Promise.resolve();
		return new Promise((resolve) => {
			s.close(() => resolve());
			s.closeAllConnections();
		});
	}

	function urlFor(partKey) {
		if (!server) throw new Error('part proxy is not started');
		return `http://127.0.0.1:${boundPort}/${secret}${partKey}`;
	}

	/**
	 * Whether Plex will serve `partKey`, through the proxy itself so the whole path is exercised.
	 * Resolves `{ ok, status }`: status is the HTTP status, `'timeout'` after probeTimeoutMs, or
	 * `'error'`. Never rejects.
	 */
	async function probe(partKey) {
		try {
			await start();
		} catch (err) {
			logger.warn(`Audiobook proxy could not start: ${err.message}`);
			return { ok: false, status: 'error' };
		}
		let url;
		try {
			url = urlFor(partKey);
		} catch {
			return { ok: false, status: 'error' };
		}
		return new Promise((resolve) => {
			let done = false;
			let req = null;
			const finish = (result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				if (req) req.destroy();
				resolve(result);
			};
			const timer = setTimeout(() => finish({ ok: false, status: 'timeout' }), probeTimeoutMs);
			req = http.get(url, { headers: { Range: 'bytes=0-0' } }, (res) => {
				res.resume();
				finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
			});
			req.on('error', () => finish({ ok: false, status: 'error' }));
		});
	}

	return { start, stop, urlFor, probe, port: () => boundPort };
}

const shared = createPartProxy();

module.exports = {
	start: shared.start,
	stop: shared.stop,
	urlFor: shared.urlFor,
	probe: shared.probe,
	port: shared.port,
	createPartProxy
};
