// helpers/discordRetry.js
// Holds a Discord REST request while discord.com cannot be reached, and sends it once it can.
//
// The PC is on Wi-Fi only and regularly cannot open a connection to discord.com:443 for seconds
// to minutes. undici then throws ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT, after its 10 s
// connect timeout), and @discordjs/rest 2.6.1 retries only AbortError and ECONNRESET, so every
// message, edit and follow-up sent in that window was lost at once: now-playing messages, book
// cards, command replies, AP relay posts.
//
// Only failures that prove nothing reached Discord are retried here: the connection was never
// opened (connect timeout, refused, no route, DNS). Anything that may have been sent (a socket
// error mid-request, a header or body timeout, any HTTP status) goes back to discord.js unchanged,
// because a second try of a POST that did arrive posts it twice.
//
// discord.js aborts each network attempt after rest.timeout. When that fires while a request is
// held here, an AbortError goes back, which discord.js answers with a fresh attempt (and window)
// up to rest.retries times. The last attempt gives up with the connect error itself.
//
// A held try never starts in the last START_MARGIN_MS (15 s) of a window. A try that connected and
// sent its body just before the abort would get the AbortError too, and discord.js would send the
// message again. undici's connect timeout (10 s) covers DNS, TCP and the TLS handshake, so a try
// that starts at the margin may connect only after 10 s, and then has at least 5 s for Discord's
// answer. That is the cushion stock discord.js gives its own first try (its 15 s timeout minus the
// same 10 s connect), so a late held try is never more likely than stock to be cut off after its
// body went out. The cost: after the connection comes back, a held send can wait up to 15 s for
// its next window. The last attempt has no margin: discord.js does not retry it, so a try cut off
// there cannot be sent twice.
//
// Order: @discordjs/rest runs the requests of one route bucket (one channel's message posts, say)
// strictly one at a time, and a request's retries all happen inside its turn, so a held message
// delays the ones behind it rather than letting them overtake it.
//
// Usage: new Client({ rest: discordRetry.restOptions(), ... })

const logger = require('./logger.js');

// Per attempt. With rest.retries left at 3 a request gets 4 attempts, so 4 x 30 s = 2 minutes of
// holding, which covers the outages seen in the logs (seconds to about 2 minutes). Raising the
// timeout instead of the retries: every AbortError retry of a POST whose response was only slow
// can post it twice, and a longer timeout means fewer of those aborts.
const REST_TIMEOUT_MS = 30000;
const DELAYS_MS = [1000, 2000, 4000, 8000];
const START_MARGIN_MS = 15000;
// A timer fires a little after its time, so the try a wait was cut short for would otherwise miss
// its start. Only for that: a try that fails at or after the margin ends the window's tries.
const TIMER_SLACK_MS = 100;
// After the first success, how long the held requests get to drain before the recovery line is
// logged anyway.
const SETTLE_MS = 15000;

const LOOKUP_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
// These also come from an established socket (a 'read ETIMEDOUT', a 'write EHOSTUNREACH'), when
// the request may already be out, so they count only from the connect call.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ETIMEDOUT']);

/** Did this error happen before a connection to Discord was open? */
function isConnectFailure(err, depth = 0) {
	if (!err || typeof err !== 'object' || depth > 4) return false;
	const code = err.code;
	if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
	// UND_ERR_SOCKET, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, ...: the request was on an open
	// socket. Their cause can carry a connect-looking code from that socket, so it is not followed.
	if (typeof code === 'string' && code.startsWith('UND_ERR_')) return false;
	if (LOOKUP_CODES.has(code)) return true;
	if (code === 'ECONNREFUSED') return true;
	if (CONNECT_CODES.has(code) && err.syscall === 'connect') return true;
	// Node's happy-eyeballs connect fails with an AggregateError of one error per address.
	if (Array.isArray(err.errors) && err.errors.length > 0) return err.errors.every(e => isConnectFailure(e, depth + 1));
	return isConnectFailure(err.cause, depth + 1);
}

function pathOf(url) {
	try { return new URL(String(url)).pathname; } catch (_) { return String(url).split('?')[0]; }
}

// Its token died 3 s after the click, well before a connect timeout comes back.
function isInteractionCallback(url) {
	return /\/interactions\/[^/]+\/[^/]+\/callback$/.test(pathOf(url));
}

/** The route for a log line: no ids, no webhook token. */
function describeRoute(method, url) {
	const route = pathOf(url)
		.replace(/^(\/api)?(\/v\d+)?(?=\/)/, '')
		.replace(/\/webhooks\/([^/]+)\/[^/]+/, '/webhooks/$1/:token')
		.replace(/\d{15,21}/g, ':id');
	return `${String(method || 'GET').toUpperCase()} ${route}`;
}

// A stream body is used up by the try that read it, so a second try would send it empty.
function isReplayable(body) {
	if (body == null || typeof body === 'string') return true;
	if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof DataView) return true;
	if (body instanceof URLSearchParams || body instanceof Blob || body instanceof FormData) return true;
	return false;
}

function abortError() {
	const err = new Error('Discord was unreachable for this whole attempt');
	err.name = 'AbortError';
	return err;
}

function messageOf(err) {
	return (err && (err.message || err.code)) || String(err);
}

/**
 * A makeRequest for @discordjs/rest that holds requests through a connect outage.
 * @param {Object} [options]
 * @param {Function} [options.base] the strategy to wrap; @discordjs/rest's default (undici) if absent
 * @param {number} [options.retries] the REST instance's `retries`, to know its last attempt
 * @param {number[]} [options.delaysMs] waits between tries; the last one repeats
 * @param {number} [options.windowMs] the REST instance's `timeout`, the length of one attempt
 * @param {number} [options.startMarginMs] no held try starts with less than this left of a window, except the last attempt's
 * @param {number} [options.settleMs]
 * @param {Object} [options.logger]
 * @param {Function} [options.now]
 */
function createMakeRequest(options = {}) {
	const delays = options.delaysMs || DELAYS_MS;
	const windowMs = options.windowMs ?? REST_TIMEOUT_MS;
	const startMargin = options.startMarginMs ?? START_MARGIN_MS;
	const settleMs = options.settleMs ?? SETTLE_MS;
	const log = options.logger || logger;
	// Monotonic, like discord.js's abort timer: a wall-clock step back while a request is held would
	// let a try start next to the abort, where a sent body gets cut off and posted again.
	const now = options.now || (() => performance.now());
	const restDefaults = () => require('discord.js').DefaultRestOptions;
	const base = () => options.base || restDefaults().makeRequest;
	const retries = () => options.retries ?? restDefaults().retries ?? 3;

	// discord.js passes the same headers object to every attempt of one request, so it keys the
	// state that has to outlive an attempt.
	const requests = new WeakMap();
	const sleepers = new Set();
	let outage = null;

	function startOutage() {
		if (outage) {
			// Failing again before the recovery line was written: the same outage, still going.
			if (outage.recoveredAt !== null) {
				outage.recoveredAt = null;
				clearTimeout(outage.timer);
				outage.timer = null;
			}
			return;
		}
		outage = { since: now(), recoveredAt: null, late: 0, gaveUp: 0, held: new Set(), timer: null };
		log.warn('Discord is unreachable; holding sends and retrying');
	}

	function finishOutage() {
		if (!outage || outage.recoveredAt === null) return;
		const o = outage;
		outage = null;
		clearTimeout(o.timer);
		const secs = Math.round((o.recoveredAt - o.since) / 1000);
		const late = `${o.late} send${o.late === 1 ? '' : 's'} went through late`;
		const lost = o.gaveUp > 0 ? `, ${o.gaveUp} gave up` : '';
		log.info(`Discord reachable again after ${secs} s; ${late}${lost}`);
	}

	function release(req) {
		if (!outage) return;
		outage.held.delete(req);
		if (outage.recoveredAt !== null && outage.held.size === 0) finishOutage();
	}

	function reachable(req) {
		if (!outage) return;
		if (req.held) outage.late++;
		req.held = false;
		if (outage.recoveredAt === null) {
			outage.recoveredAt = now();
			outage.timer = setTimeout(finishOutage, settleMs);
			if (outage.timer.unref) outage.timer.unref();
			// The rest of the held requests try again now rather than at the end of their wait.
			for (const wake of [...sleepers]) wake();
		}
		release(req);
	}

	function sleep(ms, signal) {
		if (signal && signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			let timer = null;
			const done = (value) => {
				clearTimeout(timer);
				sleepers.delete(wake);
				if (signal) signal.removeEventListener('abort', onAbort);
				resolve(value);
			};
			const wake = () => done(true);
			const onAbort = () => done(false);
			timer = setTimeout(wake, ms);
			sleepers.add(wake);
			if (signal) signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	// Kept out of `sleepers`: a wake from another request's success would start a try too late.
	function untilAborted(signal) {
		if (signal.aborted) return Promise.resolve();
		return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
	}

	// The attempt's window closed during a try of a held request. The connection may have been open
	// and the body sent, so it fails as a timeout, outside the give-up count.
	function cutOff(req, isLast, err) {
		if (!isLast) return err;
		req.held = false;
		const secs = Math.round((now() - req.firstFailedAt) / 1000);
		log.warn(`Discord send timed out after ${secs} s and may have gone through: ${req.route}`);
		release(req);
		return err;
	}

	// The attempt's window closed while the request was held and not trying, so nothing was sent.
	function windowClosed(req, isLast) {
		if (!isLast) return abortError();
		req.held = false;
		if (outage) outage.gaveUp++;
		const secs = Math.round((now() - req.firstFailedAt) / 1000);
		log.warn(`Discord send gave up after ${secs} s: ${req.route} (${messageOf(req.lastError)})`);
		release(req);
		return req.lastError;
	}

	return async function makeRequest(url, init = {}) {
		const signal = init.signal;
		// makeNetworkRequest arms its abort timer right before calling this, so the window ends
		// windowMs from now.
		const windowEnd = signal ? now() + windowMs : Infinity;
		const key = init.headers && typeof init.headers === 'object' ? init.headers : null;
		let req = key && requests.get(key);
		if (!req) {
			req = { attempts: 0, step: 0, held: false, firstFailedAt: null, lastError: null, route: describeRoute(init.method, url) };
			if (key) requests.set(key, req);
		}
		req.attempts++;
		const isLast = req.attempts > retries();
		// discord.js does not retry an AbortError on its last attempt, so a try cut off there is never
		// sent twice and the margin would only drop a connection that comes back late in the window.
		const lastStart = isLast ? windowEnd : windowEnd - startMargin;
		const holdable = !isInteractionCallback(url) && isReplayable(init.body);

		for (let tries = 0; ; tries++) {
			if (signal && signal.aborted) {
				if (req.held) throw windowClosed(req, isLast);
				throw abortError();
			}
			if (tries > 0 && now() > lastStart + TIMER_SLACK_MS) {
				await untilAborted(signal);
				throw windowClosed(req, isLast);
			}
			try {
				const res = await base()(url, init);
				reachable(req);
				// discord.js re-runs a request after a 429 without counting a retry, so this call must
				// not count either, or the request would reach its last attempt (and give up) one
				// window early in a later outage.
				if (res && res.status === 429) req.attempts--;
				return res;
			} catch (err) {
				if (!isConnectFailure(err)) {
					if (req.held && signal && signal.aborted) throw cutOff(req, isLast, err);
					req.held = false;
					release(req);
					throw err;
				}
				startOutage();
				if (!holdable) throw err;
				if (req.firstFailedAt === null) req.firstFailedAt = now();
				req.held = true;
				req.lastError = err;
				outage.held.add(req);
				// A fast failure (refused, DNS, Wi-Fi off) at the margin would otherwise leave a wait of 0
				// and retry back to back until the slack ran out.
				if (now() >= lastStart) {
					await untilAborted(signal);
					throw windowClosed(req, isLast);
				}
				// Cut short so the window's last try is not lost to a wait that runs past its start.
				const wait = Math.min(delays[Math.min(req.step, delays.length - 1)], Math.max(0, lastStart - now()));
				req.step++;
				if (!(await sleep(wait, signal))) throw windowClosed(req, isLast);
			}
		}
	};
}

let shared = null;

/** The Client's `rest` options. One makeRequest for every client, so a !restart mid-outage logs it once. */
function restOptions() {
	if (!shared) shared = createMakeRequest({ windowMs: REST_TIMEOUT_MS });
	return { makeRequest: shared, timeout: REST_TIMEOUT_MS };
}

module.exports = {
	createMakeRequest,
	restOptions,
	isConnectFailure,
	isInteractionCallback,
	describeRoute,
	REST_TIMEOUT_MS,
	START_MARGIN_MS,
	DELAYS_MS
};
