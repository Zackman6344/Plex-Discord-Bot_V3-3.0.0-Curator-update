// helpers/apMediaPlex.js: read-only Plex access for the Plex Media world: URL and header building,
// the owner token, paging, history and the other reads, metadata caching, and error text.
//
// The token this module sends is the server owner's. A token in a URL, a log line or an error
// message reaches log files and Discord replies, so every failure path here is checked for the
// token string, including a fetch whose own error message carries it.
//
// Harness: createPms with an injected loadConfig and a recording fake fetch answering with real
// Response objects. Nothing touches the network.

const test = require('node:test');
const assert = require('node:assert');
const { createPms, PmsError, _internal } = require('../helpers/apMediaPlex.js');

const OWNER = 'OWNER-TOKEN-abcdef123456';
const BOT = 'BOT-TOKEN-zyxwvu987654';

function config(over = {}) {
	return () => ({ hostname: 'localhost', port: '32400', https: false, token: BOT, homeOwnerToken: OWNER, ...over });
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url: String(url), init });
		return handler(new URL(String(url)), init, calls.length);
	};
	fn.calls = calls;
	return fn;
}

function noToken(err) {
	for (const text of [err.message, String(err.stack), JSON.stringify(err)]) {
		assert.ok(!text.includes(OWNER) && !text.includes(BOT), `a token leaked into: ${text}`);
	}
}

test('get builds the URL from config, sends the owner token only as a header and asks for JSON', async () => {
	const fetch = fakeFetch(() => json({ MediaContainer: { size: 0, friendlyName: 'pms' } }));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const mc = await pms.get('/library/sections', { type: 1 });
	assert.deepStrictEqual(mc, { size: 0, friendlyName: 'pms' });
	const { url, init } = fetch.calls[0];
	assert.strictEqual(url, 'http://localhost:32400/library/sections?type=1');
	assert.ok(!url.includes(OWNER) && !url.includes('X-Plex-Token'));
	assert.strictEqual(init.method, 'GET');
	assert.strictEqual(init.headers['X-Plex-Token'], OWNER);
	assert.strictEqual(init.headers.Accept, 'application/json');
	assert.ok(init.signal instanceof AbortSignal);
});

test('without homeOwnerToken the plain token is used; https and the port come from config', async () => {
	const fetch = fakeFetch(() => json({ MediaContainer: {} }));
	const pms = createPms({ loadConfig: config({ homeOwnerToken: '', https: true, port: 443, hostname: 'plex.lan' }), fetchImpl: fetch });
	await pms.get('/identity');
	assert.strictEqual(fetch.calls[0].url, 'https://plex.lan:443/identity');
	assert.strictEqual(fetch.calls[0].init.headers['X-Plex-Token'], BOT);
});

test('config is read on every request, never at require time', async () => {
	let reads = 0;
	const fetch = fakeFetch(() => json({ MediaContainer: {} }));
	const pms = createPms({ loadConfig: () => { reads += 1; return config()(); }, fetchImpl: fetch });
	assert.strictEqual(reads, 0);
	await pms.get('/identity');
	await pms.get('/identity');
	assert.strictEqual(reads, 2);
});

test('no token in config fails before any request, without a token in the text', async () => {
	const fetch = fakeFetch(() => json({}));
	const pms = createPms({ loadConfig: config({ token: '', homeOwnerToken: '' }), fetchImpl: fetch });
	await assert.rejects(pms.get('/identity'), (err) => err instanceof PmsError && err.code === 'NO_TOKEN' && /config\/plex\.js/.test(err.message));
	assert.strictEqual(fetch.calls.length, 0);
});

test('401 and 403 say the owner token is needed and never carry the token', async () => {
	for (const status of [401, 403]) {
		const pms = createPms({ loadConfig: config(), fetchImpl: fakeFetch(() => new Response('denied', { status })) });
		const err = await pms.get('/status/sessions/history/all', { accountID: 5 }).then(() => null, (e) => e);
		assert.ok(err instanceof PmsError);
		assert.strictEqual(err.status, status);
		assert.match(err.message, /homeOwnerToken/);
		assert.match(err.message, /\/status\/sessions\/history\/all/);
		assert.ok(!err.message.includes('accountID'), 'the query is left out of the message');
		noToken(err);
	}
});

test('other statuses name the status and path only', async () => {
	const pms = createPms({ loadConfig: config(), fetchImpl: fakeFetch(() => new Response('boom', { status: 500 })) });
	const err = await pms.get('/library/sections').then(() => null, (e) => e);
	assert.strictEqual(err.status, 500);
	assert.strictEqual(err.message, 'Plex answered HTTP 500 for /library/sections.');
	noToken(err);
});

test('a failing fetch whose own message carries the token never leaks it', async () => {
	const fetch = fakeFetch(() => {
		const err = new Error(`connect ECONNREFUSED 127.0.0.1:32400 while sending X-Plex-Token: ${OWNER}`);
		err.cause = { code: 'ECONNREFUSED', message: OWNER };
		throw err;
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const err = await pms.sessions().then(() => null, (e) => e);
	assert.ok(err instanceof PmsError);
	assert.strictEqual(err.code, 'UNREACHABLE');
	assert.match(err.message, /ECONNREFUSED/);
	assert.match(err.message, /localhost:32400/);
	noToken(err);
	assert.strictEqual(err.cause, undefined, 'the raw error is not attached');
});

test('a server that never answers times out with a clear message', async () => {
	const fetch = fakeFetch((url, init) => new Promise((resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(init.signal.reason));
	}));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch, timeoutMs: 40 });
	const err = await pms.get('/status/sessions').then(() => null, (e) => e);
	assert.strictEqual(err.code, 'TIMEOUT');
	assert.match(err.message, /no answer within/);
	noToken(err);
});

test('a reply that is not JSON is an error, not a silent empty result', async () => {
	const fetch = fakeFetch(() => new Response('<MediaContainer/>', { status: 200, headers: { 'content-type': 'text/xml' } }));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	await assert.rejects(pms.get('/library/sections'), /not JSON/);
});

test('pages reads X-Plex-Container-Start/Size windows until totalSize, keeping a query already on the path', async () => {
	const rows = Array.from({ length: 7 }, (_, i) => ({ ratingKey: String(100 + i) }));
	const fetch = fakeFetch((url) => {
		const start = Number(url.searchParams.get('X-Plex-Container-Start'));
		const size = Number(url.searchParams.get('X-Plex-Container-Size'));
		return json({ MediaContainer: { totalSize: rows.length, Metadata: rows.slice(start, start + size) } });
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const got = await pms.pages('/library/sections/1/all?type=9&album.id!=5,6', { genre: 'x' }, 3);
	assert.deepStrictEqual(got.map((r) => r.ratingKey), rows.map((r) => r.ratingKey));
	assert.strictEqual(fetch.calls.length, 3);
	const first = new URL(fetch.calls[0].url);
	assert.strictEqual(first.searchParams.get('type'), '9');
	assert.strictEqual(first.searchParams.get('album.id!'), '5,6');
	assert.strictEqual(first.searchParams.get('genre'), 'x');
	assert.deepStrictEqual(fetch.calls.map((c) => new URL(c.url).searchParams.get('X-Plex-Container-Start')), ['0', '3', '6']);

	const limited = await pms.pages('/library/sections/1/all', {}, 3, { limit: 4 });
	assert.strictEqual(limited.length, 4);
});

test('pages without totalSize stops at a short page, and on an empty one', async () => {
	let n = 0;
	const fetch = fakeFetch(() => {
		n += 1;
		return json({ MediaContainer: { Directory: n === 1 ? [{ key: 'a' }, { key: 'b' }] : [{ key: 'c' }] } });
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	assert.deepStrictEqual((await pms.pages('/x', {}, 2)).map((r) => r.key), ['a', 'b', 'c']);
	const empty = createPms({ loadConfig: config(), fetchImpl: fakeFetch(() => json({ MediaContainer: { totalSize: 10 } })) });
	assert.deepStrictEqual(await empty.pages('/x'), []);
});

test('history asks oldest first with the Plex filter keys and returns the raw rows with the total', async () => {
	const row = { historyKey: '/status/sessions/history/9', ratingKey: '1234', viewedAt: 1762000000, accountID: 5, librarySectionID: '3' };
	const fetch = fakeFetch(() => json({ MediaContainer: { totalSize: 41, Metadata: [row] } }));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const out = await pms.history({ accountId: '5', since: 1761000000.7, start: 40, size: 20 });
	assert.deepStrictEqual(out, { rows: [row], total: 41 });
	const url = fetch.calls[0].url;
	assert.match(url, /^http:\/\/localhost:32400\/status\/sessions\/history\/all\?/);
	assert.match(url, /viewedAt>=1761000000(&|$)/, 'the operator stays in the key');
	const q = new URL(url).searchParams;
	assert.strictEqual(q.get('sort'), 'viewedAt:asc');
	assert.strictEqual(q.get('accountID'), '5');
	assert.strictEqual(q.get('viewedAt>'), '1761000000');
	assert.strictEqual(q.get('X-Plex-Container-Start'), '40');
	assert.strictEqual(q.get('X-Plex-Container-Size'), '20');
});

test('accounts drops the nameless id 0 and returns numbers; sections key by number', async () => {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/accounts') {
			return json({ MediaContainer: { Account: [{ id: 0, name: '' }, { id: 1, name: 'Owner\u0007Name' }, { id: '775071947', name: 'Friend' }] } });
		}
		return json({ MediaContainer: { Directory: [{ key: '3', type: 'movie', title: 'Movies' }, { key: '1', type: 'artist', title: 'Music' }] } });
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	assert.deepStrictEqual(await pms.accounts(), [{ id: 1, name: 'OwnerName' }, { id: 775071947, name: 'Friend' }]);
	assert.deepStrictEqual(await pms.sections(), [{ key: 3, type: 'movie', title: 'Movies' }, { key: 1, type: 'artist', title: 'Music' }]);
});

test('sessions and identity read their containers', async () => {
	const fetch = fakeFetch((url) => (url.pathname === '/identity'
		? json({ MediaContainer: { machineIdentifier: 'abc', version: '1.43.5' } })
		: json({ MediaContainer: { size: 1, Metadata: [{ ratingKey: '9', viewOffset: 1000 }] } })));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	assert.deepStrictEqual(await pms.sessions(), [{ ratingKey: '9', viewOffset: 1000 }]);
	assert.deepStrictEqual(await pms.identity(), { machineIdentifier: 'abc', version: '1.43.5' });
});

test('metadata is cached per ratingKey, shared while in flight, and a 404 is a cached null', async () => {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/library/metadata/404') return new Response('', { status: 404 });
		if (url.pathname === '/library/metadata/500') return new Response('', { status: 500 });
		return json({ MediaContainer: { Metadata: [{ ratingKey: url.pathname.split('/').pop(), guid: 'plex://movie/x' }] } });
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const [a, b] = await Promise.all([pms.metadata('123'), pms.metadata(123)]);
	assert.strictEqual(a, b);
	assert.strictEqual(a.guid, 'plex://movie/x');
	await pms.metadata(123);
	assert.strictEqual(fetch.calls.length, 1);

	assert.strictEqual(await pms.metadata(404), null);
	assert.strictEqual(await pms.metadata(404), null);
	assert.strictEqual(fetch.calls.length, 2);

	await assert.rejects(pms.metadata(500), /HTTP 500/);
	await assert.rejects(pms.metadata(500), /HTTP 500/);
	assert.strictEqual(fetch.calls.length, 4, 'a failure is not cached');

	assert.strictEqual(await pms.metadata('abc'), null);
	assert.strictEqual(fetch.calls.length, 4);
	pms.clearMetadata();
	await pms.metadata(123);
	assert.strictEqual(fetch.calls.length, 5);
});

test('the listing helpers hit the documented paths', async () => {
	const fetch = fakeFetch((url) => json({ MediaContainer: { totalSize: 1, Metadata: [{ path: url.pathname }], Directory: [{ key: 7, title: 'Horror' }] } }));
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	assert.strictEqual((await pms.children('11'))[0].path, '/library/metadata/11/children');
	assert.strictEqual((await pms.leaves(12))[0].path, '/library/metadata/12/allLeaves');
	assert.strictEqual((await pms.playlistItems(13))[0].path, '/playlists/13/items');
	assert.strictEqual((await pms.collections(3))[0].path, '/library/sections/3/collections');
	assert.strictEqual((await pms.collectionItems(14))[0].path, '/library/collections/14/children');
	assert.strictEqual((await pms.playlists())[0].path, '/playlists');
	assert.deepStrictEqual(await pms.genres(3), [{ key: '7', title: 'Horror' }]);
});

test('playlistItems and collectionItems stop reading at a limit', async () => {
	const rows = Array.from({ length: 1000 }, (_, i) => ({ ratingKey: String(i + 1) }));
	const fetch = fakeFetch((url) => {
		const start = Number(url.searchParams.get('X-Plex-Container-Start'));
		const size = Number(url.searchParams.get('X-Plex-Container-Size'));
		return json({ MediaContainer: { totalSize: rows.length, Metadata: rows.slice(start, start + size) } });
	});
	const pms = createPms({ loadConfig: config(), fetchImpl: fetch });
	const some = await pms.playlistItems(13, { limit: 450 });
	assert.deepStrictEqual([some.length, some[449].ratingKey, fetch.calls.length], [450, '450', 2]);
	assert.strictEqual((await pms.collectionItems(14, { limit: 10 })).length, 10);
	assert.strictEqual(fetch.calls.length, 3);
	assert.strictEqual((await pms.playlistItems(13)).length, 1000, 'no limit reads it all');
	assert.strictEqual(fetch.calls.length, 7);
});

test('query keys keep Plex operators readable and values are encoded', () => {
	assert.strictEqual(_internal.queryOf({ 'viewedAt>': 5, 'album.id!': '1,2', title: 'a b&c', skip: undefined }), 'viewedAt>=5&album.id!=1%2C2&title=a%20b%26c');
	assert.strictEqual(_internal.withQuery('/a?x=1', { y: 2 }), '/a?x=1&y=2');
	assert.strictEqual(_internal.withQuery('/a', {}), '/a');
});
