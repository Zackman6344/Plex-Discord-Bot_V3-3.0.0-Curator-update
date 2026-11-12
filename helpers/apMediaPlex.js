// helpers/apMediaPlex.js
// Read-only Plex server access for the Plex Media world: history, sessions, accounts, sections,
// listings and item metadata.
//
// The owner token (config/plex.js homeOwnerToken) is preferred over `token`: only the server owner
// can read every account's history and sessions, and the example config recommends a managed user
// for `token`. The token travels only in the X-Plex-Token header. It never goes into a URL, and no
// error built here carries it, because these errors reach logs and Discord replies.
//
// Listings are read in pages (X-Plex-Container-Start/Size). One JSON parse of a whole section on
// the main thread stalls voice playback for 200-400 ms; the episode listing alone is 21.9 MB.
//
// Plex filters put the operator in the query key: `viewedAt>=1700000000` is the key `viewedAt>`
// with the value 1700000000, so params are keyed the way Plex spells them.
//
// config/plex.js is read per request through loadConfig, never at require time.

const contracts = require('./apMediaContracts.js');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PAGE_SIZE = 300;
const MAX_PAGE_SIZE = 1000;
// A server that answers full pages forever would otherwise never let a read finish.
const MAX_PAGES = 1000;
const METADATA_CACHE_MAX = 2000;
const OWNER_TOKEN_HINT = "it needs the server owner's token (config/plex.js homeOwnerToken)";

class PmsError extends Error {
	constructor(message, { status = null, code = null } = {}) {
		super(message);
		this.name = 'PmsError';
		this.status = status;
		this.code = code;
	}
}

function defaultLoadConfig() {
	return require('../config/plex.js');
}

function pathOnly(path) {
	return String(path).split('?')[0];
}

// The operator characters stay readable in the key; fetch percent-encodes `<` and `>` on the wire
// anyway, and Plex decodes them (the history filters were verified that way).
function encodeKey(key) {
	return encodeURIComponent(key).replace(/%3E/gi, '>').replace(/%3C/gi, '<').replace(/%21/g, '!');
}

function queryOf(params) {
	if (!params || typeof params !== 'object') return '';
	const parts = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		parts.push(`${encodeKey(key)}=${encodeURIComponent(String(value))}`);
	}
	return parts.join('&');
}

function withQuery(path, params) {
	const query = queryOf(params);
	if (!query) return String(path);
	return `${path}${String(path).includes('?') ? '&' : '?'}${query}`;
}

function rowsOf(mc) {
	for (const key of ['Metadata', 'Directory', 'Account']) {
		if (Array.isArray(mc && mc[key])) return mc[key];
	}
	return [];
}

function reasonOf(err, timeoutMs) {
	if (err && err.name === 'TimeoutError') return `no answer within ${Math.round(timeoutMs / 1000)} s`;
	if (err && err.name === 'AbortError') return 'the request was cancelled';
	const code = (err && err.cause && err.cause.code) || (err && err.code);
	return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'a network error';
}

/**
 * @param {object} [deps]
 * @param {() => object} [deps.loadConfig] returns config/plex.js's shape: hostname, port, https,
 *   token, homeOwnerToken
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {number} [deps.timeoutMs] per request, body included
 */
function createPms({ loadConfig = defaultLoadConfig, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const metadataCache = new Map();

	function settings() {
		const c = loadConfig() || {};
		const token = String(c.homeOwnerToken || c.token || '');
		if (!token) throw new PmsError('Plex is not set up: config/plex.js has no token.', { code: 'NO_TOKEN' });
		const host = String(c.hostname || '').trim();
		if (!host) throw new PmsError('Plex is not set up: config/plex.js has no hostname.', { code: 'NO_HOST' });
		const port = String(c.port === undefined || c.port === null || c.port === '' ? 32400 : c.port).trim();
		const https = c.https === true || /^true$/i.test(String(c.https)) || ((c.https === undefined || c.https === null) && port === '443');
		const where = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
		return { token, where, base: `${https ? 'https' : 'http'}://${where}` };
	}

	// The message is cleaned before the error exists: V8 copies it into err.stack at construction.
	function failure(message, token, meta) {
		const text = token && token.length >= 4 ? String(message).split(token).join('[token]') : String(message);
		return new PmsError(text, meta);
	}

	/** One GET; resolves to the reply's MediaContainer. */
	async function get(path, params) {
		const s = settings();
		const target = s.base + withQuery(path, params);
		const where = pathOnly(path);
		let res;
		try {
			res = await fetchImpl(target, {
				method: 'GET',
				headers: { Accept: 'application/json', 'X-Plex-Token': s.token },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			const code = err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE';
			throw failure(`Plex at ${s.where} could not be reached for ${where}: ${reasonOf(err, timeoutMs)}.`, s.token, { code });
		}
		if (!res.ok) {
			try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch (_) { /* nothing to free */ }
			const message = res.status === 401 || res.status === 403
				? `Plex refused ${where} (HTTP ${res.status}): ${OWNER_TOKEN_HINT}.`
				: `Plex answered HTTP ${res.status} for ${where}.`;
			throw failure(message, s.token, { status: res.status, code: `HTTP_${res.status}` });
		}
		let body;
		try {
			body = await res.json();
		} catch (err) {
			const code = err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'BAD_REPLY';
			const why = code === 'TIMEOUT' ? reasonOf(err, timeoutMs) : 'the reply is not JSON';
			throw failure(`Plex at ${s.where} sent an unusable reply for ${where}: ${why}.`, s.token, { status: res.status, code });
		}
		return (body && typeof body === 'object' && body.MediaContainer) || {};
	}

	/**
	 * Every row of a listing, read page by page.
	 * @param {string} path may already carry a query (longForm.withExclusion adds one)
	 * @param {object} [params]
	 * @param {number} [pageSize]
	 * @param {{limit?: number}} [opts] stop once this many rows are in
	 * @returns {Promise<object[]>}
	 */
	async function pages(path, params = {}, pageSize = DEFAULT_PAGE_SIZE, { limit = Infinity } = {}) {
		const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(pageSize)) || DEFAULT_PAGE_SIZE));
		const rows = [];
		let start = 0;
		for (let page = 0; page < MAX_PAGES; page++) {
			const mc = await get(path, { ...params, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
			const got = rowsOf(mc);
			rows.push(...got);
			start += got.length;
			if (!got.length || rows.length >= limit) break;
			const total = Number(mc.totalSize);
			if (Number.isFinite(total) ? start >= total : got.length < size) break;
		}
		return rows.length > limit ? rows.slice(0, limit) : rows;
	}

	/**
	 * One page of /status/sessions/history/all, oldest first. Rows come back as Plex sends them:
	 * ratingKey and librarySectionID are strings, viewedAt (unix s) and accountID numbers.
	 * @returns {Promise<{rows: object[], total: number}>}
	 */
	async function history({ accountId, since, sectionId, start = 0, size = DEFAULT_PAGE_SIZE } = {}) {
		const params = { sort: 'viewedAt:asc' };
		if (accountId !== undefined && accountId !== null) params.accountID = Number(accountId);
		if (sectionId !== undefined && sectionId !== null) params.librarySectionID = Number(sectionId);
		if (since !== undefined && since !== null) params['viewedAt>'] = Math.floor(Number(since));
		params['X-Plex-Container-Start'] = Math.max(0, Math.floor(Number(start)) || 0);
		params['X-Plex-Container-Size'] = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(size)) || DEFAULT_PAGE_SIZE));
		const mc = await get('/status/sessions/history/all', params);
		const rows = Array.isArray(mc.Metadata) ? mc.Metadata : [];
		const total = Number(mc.totalSize);
		return { rows, total: Number.isFinite(total) ? total : params['X-Plex-Container-Start'] + rows.length };
	}

	/** What is playing right now, on every account (raw rows: User, Player, Session, viewOffset). */
	async function sessions() {
		const mc = await get('/status/sessions');
		return Array.isArray(mc.Metadata) ? mc.Metadata : [];
	}

	/** The server's accounts without the nameless id 0, as {id: number, name: string}. */
	async function accounts() {
		const mc = await get('/accounts');
		const out = [];
		for (const a of Array.isArray(mc.Account) ? mc.Account : []) {
			const id = Number(a && a.id);
			if (!Number.isInteger(id) || id <= 0) continue;
			out.push({ id, name: contracts.sanitizeText(a.name) });
		}
		return out;
	}

	/** Library sections as {key: number, type: 'movie'|'show'|'artist'|..., title}. */
	async function sections() {
		const mc = await get('/library/sections');
		const out = [];
		for (const d of Array.isArray(mc.Directory) ? mc.Directory : []) {
			const key = Number(d && d.key);
			if (!Number.isInteger(key) || key < 0) continue;
			out.push({ key, type: String(d.type || ''), title: contracts.sanitizeText(d.title) });
		}
		return out;
	}

	/**
	 * One item's metadata, or null when Plex no longer has it. Kept in memory: the game asks once per
	 * unknown ratingKey and ratingKeys do not change meaning.
	 */
	function metadata(ratingKey) {
		const rk = Number(ratingKey);
		if (!Number.isInteger(rk) || rk <= 0) return Promise.resolve(null);
		if (metadataCache.has(rk)) {
			const hit = metadataCache.get(rk);
			metadataCache.delete(rk);
			metadataCache.set(rk, hit);
			return hit;
		}
		const pending = get(`/library/metadata/${rk}`).then(
			(mc) => (Array.isArray(mc.Metadata) && mc.Metadata[0]) || null,
			(err) => {
				if (err && err.status === 404) return null;
				if (metadataCache.get(rk) === pending) metadataCache.delete(rk);
				throw err;
			}
		);
		metadataCache.set(rk, pending);
		while (metadataCache.size > METADATA_CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value);
		return pending;
	}

	function clearMetadata() {
		metadataCache.clear();
	}

	/** The server's machineIdentifier and version. */
	async function identity() {
		const mc = await get('/identity');
		return { machineIdentifier: String(mc.machineIdentifier || ''), version: String(mc.version || '') };
	}

	/** An album's tracks, in album order. */
	function children(ratingKey) {
		return pages(`/library/metadata/${Number(ratingKey)}/children`);
	}

	/** Every episode of a show, specials included. */
	function leaves(ratingKey) {
		return pages(`/library/metadata/${Number(ratingKey)}/allLeaves`);
	}

	/** A section's genres as {key, title} (Plex filters by the key). */
	async function genres(sectionKey, type) {
		const mc = await get(`/library/sections/${Number(sectionKey)}/genre`, type ? { type } : undefined);
		const out = [];
		for (const d of Array.isArray(mc.Directory) ? mc.Directory : []) {
			if (d && d.key !== undefined && d.key !== null) out.push({ key: String(d.key), title: contracts.sanitizeText(d.title) });
		}
		return out;
	}

	/** The token's playlists as Plex lists them (playlistType, smart, leafCount, ratingKey, title). */
	async function playlists() {
		const mc = await get('/playlists');
		return Array.isArray(mc.Metadata) ? mc.Metadata : [];
	}

	/**
	 * A playlist's items in playlist order. A smart playlist can be the whole library (All Music:
	 * 14,174 tracks here), so a caller that keeps only the start passes `limit`.
	 * @param {{limit?: number}} [opts]
	 */
	function playlistItems(ratingKey, { limit } = {}) {
		return pages(`/playlists/${Number(ratingKey)}/items`, {}, DEFAULT_PAGE_SIZE, { limit });
	}

	function collections(sectionKey) {
		return pages(`/library/sections/${Number(sectionKey)}/collections`);
	}

	/** @param {{limit?: number}} [opts] as playlistItems */
	function collectionItems(ratingKey, { limit } = {}) {
		return pages(`/library/collections/${Number(ratingKey)}/children`, {}, DEFAULT_PAGE_SIZE, { limit });
	}

	return {
		get,
		pages,
		history,
		sessions,
		accounts,
		sections,
		metadata,
		clearMetadata,
		identity,
		children,
		leaves,
		genres,
		playlists,
		playlistItems,
		collections,
		collectionItems,
	};
}

module.exports = {
	createPms,
	PmsError,
	DEFAULT_PAGE_SIZE,
	_internal: { queryOf, withQuery, rowsOf },
};
