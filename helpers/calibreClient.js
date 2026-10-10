// helpers/calibreClient.js
//
// A GET-only client for the Calibre content server (the one the Calibre app runs while it is
// open, http://127.0.0.1:8080 by default). The read-along uses it to find a book's EPUB and
// download it once; it never calls anything that writes to the library.
//
// Credentials are the part worth care. fetch puts a URL's userinfo, password included, into its
// own error message ("Request cannot be constructed from a URL that includes credentials:
// http://user:pw@..."), so a URL carrying a login is refused before any request, and no error
// built here ever includes the URL: they name host:port only. A login, when the user turns one
// on in Calibre, goes in the Authorization header after a 401 challenge, and redirects are
// refused so that header is never replayed to another host. Calibre's default over plain HTTP
// is Digest; Basic is answered only over https, where the password is not sent in clear text.

const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

class CalibreError extends Error {
	constructor(code, message, extra = {}) {
		super(message);
		this.name = 'CalibreError';
		this.code = code;
		Object.assign(this, extra);
	}
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** @returns {{ ok: true, url: URL } | { ok: false, reason: 'invalid'|'protocol'|'login-in-url' }} */
function checkUrl(raw) {
	let url;
	try {
		url = new URL(String(raw || '').trim());
	} catch (_) {
		return { ok: false, reason: 'invalid' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'protocol' };
	if (url.username || url.password) return { ok: false, reason: 'login-in-url' };
	return { ok: true, url };
}

function hasEpub(book) {
	return !!book && Array.isArray(book.formats) && book.formats.some((f) => String(f).toLowerCase() === 'epub');
}

function parseChallenge(header) {
	const text = String(header || '');
	const digest = text.match(/Digest\s+(.*)$/i);
	if (digest) {
		const params = {};
		const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
		let m;
		while ((m = re.exec(digest[1]))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
		return { scheme: 'digest', params };
	}
	if (/\bBasic\b/i.test(text)) return { scheme: 'basic' };
	return null;
}

function digestHeader({ params, username, password, method, uri }) {
	const algorithm = String(params.algorithm || 'MD5');
	const hashName = /^sha-256/i.test(algorithm) ? 'sha256' : 'md5';
	const h = (s) => crypto.createHash(hashName).update(s).digest('hex');
	const sess = /-sess$/i.test(algorithm);
	const cnonce = crypto.randomBytes(8).toString('hex');
	const nc = '00000001';
	let ha1 = h(`${username}:${params.realm || ''}:${password}`);
	if (sess) ha1 = h(`${ha1}:${params.nonce || ''}:${cnonce}`);
	const ha2 = h(`${method}:${uri}`);
	const qops = String(params.qop || '').split(',').map((q) => q.trim().toLowerCase()).filter(Boolean);
	const quote = (s) => String(s).replace(/(["\\])/g, '\\$1');
	const parts = [
		`username="${quote(username)}"`,
		`realm="${quote(params.realm || '')}"`,
		`nonce="${quote(params.nonce || '')}"`,
		`uri="${quote(uri)}"`,
		`algorithm=${algorithm}`
	];
	if (qops.includes('auth')) {
		parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
		parts.push(`response="${h(`${ha1}:${params.nonce || ''}:${nc}:${cnonce}:auth:${ha2}`)}"`);
	} else {
		parts.push(`response="${h(`${ha1}:${params.nonce || ''}:${ha2}`)}"`);
	}
	if (params.opaque !== undefined) parts.push(`opaque="${quote(params.opaque)}"`);
	return `Digest ${parts.join(', ')}`;
}

/**
 * @param {object} options
 * @param {string} options.url the content server's base URL, without a login
 * @param {string} [options.libraryId] blank asks the server for its default library
 * @param {string} [options.username] only when Calibre requires a login
 * @param {string} [options.password]
 */
function createCalibreClient({
	url, libraryId = '', username = '', password = '',
	metaTimeoutMs = 5000, downloadTimeoutMs = 120000, maxBytes = 300 * 1024 * 1024
} = {}) {
	const checked = checkUrl(url);
	const base = checked.ok ? checked.url : null;
	const host = base ? base.host : 'the configured address';
	let library = String(libraryId || '').trim() || null;
	let libraryPromise = null;

	function badUrl() {
		const reason = checked.ok ? 'invalid' : checked.reason;
		const message = reason === 'login-in-url'
			? 'The Calibre URL contains a login; put it in calibreUsername and calibrePassword instead.'
			: 'The Calibre URL is not a valid http(s) address.';
		return new CalibreError('bad-url', message, { reason });
	}

	function toError(err, what) {
		if (err instanceof CalibreError) return err;
		if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			return new CalibreError('timeout', `Calibre at ${host} did not answer ${what} in time.`, { host });
		}
		const cause = err && err.cause;
		const code = (cause && cause.code) || (err && err.code);
		if (code && NETWORK_CODES.has(code)) {
			return new CalibreError('unreachable', `Calibre at ${host} is not answering (${code}).`, { host, cause: code });
		}
		if (cause && /redirect/i.test(String(cause.message || ''))) {
			return new CalibreError('bad-response', `Calibre at ${host} answered ${what} with a redirect, which is refused.`, { host });
		}
		// Node's own messages are kept out: some of them quote the URL.
		return new CalibreError('unreachable', `Calibre at ${host} could not be reached (${code || (err && err.name) || 'error'}).`, { host, cause: code || null });
	}

	// Calibre can be served under a prefix (its --url-prefix, or a reverse proxy), which
	// new URL('/ajax/...', base) would drop.
	function urlFor(pathAndQuery) {
		return new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}${pathAndQuery}`);
	}

	async function request(pathAndQuery, { timeoutMs, what }) {
		if (!base) throw badUrl();
		const target = urlFor(pathAndQuery);
		const uri = `${target.pathname}${target.search}`;
		const signal = AbortSignal.timeout(timeoutMs);
		const send = (headers) => fetch(target, { method: 'GET', headers, redirect: 'error', signal });
		let res;
		try {
			res = await send({ Accept: '*/*' });
			if (res.status === 401) {
				const challenge = parseChallenge(res.headers.get('www-authenticate'));
				await res.body?.cancel().catch(() => {});
				if (!username || !challenge) {
					throw new CalibreError('auth', `Calibre at ${host} asked for a login.`, { host });
				}
				// Calibre itself asks for Digest over http and Basic only over https, so a Basic
				// challenge over http is most likely something else on the port asking for the
				// password in clear text.
				if (challenge.scheme === 'basic' && target.protocol !== 'https:') {
					throw new CalibreError('auth', `Calibre at ${host} asked for a plain-text login over http, which is refused; use Calibre's default Digest login or an https address.`, { host, reason: 'basic-over-http' });
				}
				const authorization = challenge.scheme === 'basic'
					? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
					: digestHeader({ params: challenge.params, username, password, method: 'GET', uri });
				res = await send({ Accept: '*/*', Authorization: authorization });
				if (res.status === 401) {
					await res.body?.cancel().catch(() => {});
					throw new CalibreError('auth', `Calibre at ${host} refused the login.`, { host });
				}
			}
		} catch (err) {
			throw toError(err, what);
		}
		return res;
	}

	async function getJson(pathAndQuery, what) {
		const res = await request(pathAndQuery, { timeoutMs: metaTimeoutMs, what });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			throw new CalibreError('not-found', `Calibre at ${host} has no ${what}.`, { host });
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new CalibreError('bad-response', `Calibre at ${host} answered ${what} with HTTP ${res.status}.`, { host, status: res.status });
		}
		try {
			return await res.json();
		} catch (err) {
			if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw toError(err, what);
			throw new CalibreError('bad-response', `Calibre at ${host} sent ${what} that is not JSON.`, { host });
		}
	}

	const seg = (v) => encodeURIComponent(String(v));

	async function getLibraryId() {
		if (library) return library;
		if (!libraryPromise) {
			libraryPromise = getJson('/ajax/library-info', 'its library list').then((info) => {
				const id = info && typeof info.default_library === 'string' ? info.default_library : null;
				if (!id) throw new CalibreError('bad-response', `Calibre at ${host} named no default library.`, { host });
				library = id;
				return id;
			}).finally(() => { libraryPromise = null; });
		}
		return libraryPromise;
	}

	async function search(query, { num = 50 } = {}) {
		const lib = await getLibraryId();
		const q = new URLSearchParams({ query: String(query || ''), num: String(num) });
		const body = await getJson(`/ajax/search/${seg(lib)}?${q}`, 'a search');
		const ids = body && Array.isArray(body.book_ids) ? body.book_ids : null;
		if (!ids) throw new CalibreError('bad-response', `Calibre at ${host} sent a search result without book ids.`, { host });
		return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
	}

	async function books(ids) {
		const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
		const out = new Map();
		if (!list.length) return out;
		const lib = await getLibraryId();
		const body = await getJson(`/ajax/books/${seg(lib)}?${new URLSearchParams({ ids: list.join(',') })}`, 'book details');
		for (const id of list) {
			const b = body && Object.prototype.hasOwnProperty.call(body, String(id)) ? body[String(id)] : null;
			out.set(id, b && typeof b === 'object' ? b : null);
		}
		return out;
	}

	async function book(id) {
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0) return null;
		const lib = await getLibraryId();
		try {
			const b = await getJson(`/ajax/book/${seg(n)}/${seg(lib)}`, `book #${n}`);
			return b && typeof b === 'object' ? b : null;
		} catch (err) {
			if (err.code === 'not-found') return null;
			throw err;
		}
	}

	async function downloadEpub(id, destPath) {
		const n = Number(id);
		const lib = await getLibraryId();
		const what = `the EPUB of book #${n}`;
		const res = await request(`/get/EPUB/${seg(n)}/${seg(lib)}`, { timeoutMs: downloadTimeoutMs, what });
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			throw new CalibreError('no-epub', `Calibre at ${host} has no EPUB for book #${n}.`, { host });
		}
		if (!res.ok || !res.body) {
			await res.body?.cancel().catch(() => {});
			throw new CalibreError('bad-response', `Calibre at ${host} answered ${what} with HTTP ${res.status}.`, { host, status: res.status });
		}
		const declared = Number(res.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > maxBytes) {
			await res.body.cancel().catch(() => {});
			throw new CalibreError('too-large', `The EPUB of book #${n} is larger than ${Math.round(maxBytes / 1048576)} MB.`, { host, bytes: declared });
		}
		let bytes = 0;
		const counter = new Transform({
			transform(chunk, _enc, done) {
				bytes += chunk.length;
				if (bytes > maxBytes) {
					done(new CalibreError('too-large', `The EPUB of book #${n} is larger than ${Math.round(maxBytes / 1048576)} MB.`, { host }));
					return;
				}
				done(null, chunk);
			}
		});
		try {
			await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
		} catch (err) {
			await fs.promises.rm(destPath, { force: true }).catch(() => {});
			if (err && err.syscall && !(err.cause && err.cause.code)) {
				throw new CalibreError('io', `The EPUB of book #${n} could not be saved (${err.code || 'error'}).`, { host, cause: err.code || null });
			}
			throw toError(err, what);
		}
		return { bytes };
	}

	return {
		host,
		libraryId: getLibraryId,
		search,
		books,
		book,
		downloadEpub
	};
}

module.exports = { createCalibreClient, CalibreError, checkUrl, hasEpub };
