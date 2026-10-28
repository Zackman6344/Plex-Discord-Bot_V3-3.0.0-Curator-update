// helpers/calibreClient.js: the GET-only Calibre content server client.
//
// The bug: a calibreUrl with a login in it (http://user:pass@...) puts the password into fetch's
// own error message and from there into the log; a redirect replays the Authorization header to
// another host; a Calibre with its login turned on (Digest by default) answers every request
// with 401; a 300 MB download, a hung server or a closed app either fills the disk, hangs the
// read-along, or surfaces as an unexplained crash.
//
// Harness: a local http.createServer fake on 127.0.0.1:0 that speaks the endpoints the live
// server was confirmed to have (read-only GETs to the user's Calibre 9.16 on 2026-10-10):
// /ajax/library-info, /ajax/search/<lib>, /ajax/books/<lib>, /ajax/book/<id>/<lib> with
// format_metadata, /get/EPUB/<id>/<lib>, plus Basic and Digest challenges. It records every
// request's method and path. The "EPUB" bytes are filler; the client never looks inside them.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const { createCalibreClient, CalibreError, checkUrl, hasEpub } = require('../helpers/calibreClient.js');

const LIB = 'Test_Library';
const TMP = fs.mkdtempSync(pathMod.join(os.tmpdir(), `plexbot-test-calibre-client-${process.pid}-`));
const EPUB_BYTES = Buffer.alloc(64 * 1024, 7);

const BOOKS = {
	1: {
		title: 'The Lantern Road', authors: ['Avery Quill'], series: 'Ashfall', series_index: 1,
		identifiers: { isbn: '9780000000002' }, formats: ['epub', 'original_epub'],
		last_modified: '2026-01-01T00:00:00+00:00',
		format_metadata: { epub: { size: 65536, mtime: '2026-01-01T00:00:01.5+00:00', path: 'X:/never/used.epub' } }
	},
	2: { title: 'A Comic', authors: ['Nobody'], formats: ['cbz'], last_modified: '2026-01-02T00:00:00+00:00' }
};

const sha = (alg, s) => crypto.createHash(alg).update(s).digest('hex');

function parseAuth(header) {
	const out = {};
	const re = /([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi;
	let m;
	while ((m = re.exec(header))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
	return out;
}

async function server({ auth = null, user = 'reader', pass = 'open sesame', prefix = '' } = {}) {
	const requests = [];
	const held = [];
	const nonce = crypto.randomBytes(8).toString('hex');
	const srv = http.createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
		const u = new URL(req.url, 'http://x');
		if (auth) {
			const header = req.headers.authorization || '';
			let ok = false;
			if (auth === 'basic') ok = header === `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
			if (auth === 'digest' && header.startsWith('Digest ')) {
				const a = parseAuth(header.slice(7));
				const ha1 = sha('md5', `${a.username}:${a.realm}:${pass}`);
				const ha2 = sha('md5', `GET:${a.uri}`);
				ok = a.username === user && a.uri === req.url && a.nonce === nonce && a.qop === 'auth'
					&& a.response === sha('md5', `${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:auth:${ha2}`);
			}
			if (!ok) {
				res.writeHead(401, {
					'WWW-Authenticate': auth === 'basic'
						? 'Basic realm="calibre"'
						: `Digest realm="calibre", nonce="${nonce}", qop="auth", algorithm="MD5", opaque="op1"`
				});
				res.end();
				return;
			}
		}
		if (prefix && !u.pathname.startsWith(prefix)) {
			res.writeHead(404);
			res.end('no prefix');
			return;
		}
		const p = u.pathname.slice(prefix.length);
		const json = (code, body) => {
			res.writeHead(code, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (p === '/ajax/library-info') return json(200, { library_map: { [LIB]: 'Test Library' }, default_library: LIB });
		if (p === `/ajax/search/${LIB}`) {
			const q = u.searchParams.get('query');
			const ids = q === 'authors:"Quill"' ? [2, 1] : q.includes('9780000000002') ? [1] : [];
			return json(200, { total_num: ids.length, query: q, num: Number(u.searchParams.get('num')), library_id: LIB, book_ids: ids });
		}
		if (p === `/ajax/books/${LIB}`) {
			const out = {};
			for (const id of u.searchParams.get('ids').split(',')) out[id] = BOOKS[id] || null;
			return json(200, out);
		}
		const book = p.match(/^\/ajax\/book\/(\d+)\/(.+)$/);
		if (book) {
			if (book[1] === '5') {
				res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
				res.end();
				return;
			}
			if (book[1] === '6') {
				held.push(res);
				return;
			}
			if (!BOOKS[book[1]] || book[2] !== LIB) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end(`No book with id: ${book[1]} in library: ${book[2]}`);
				return;
			}
			return json(200, BOOKS[book[1]]);
		}
		const get = p.match(/^\/get\/EPUB\/(\d+)\/(.+)$/);
		if (get) {
			if (get[1] === '1') {
				res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': EPUB_BYTES.length });
				res.end(EPUB_BYTES);
				return;
			}
			if (get[1] === '7') {
				res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': String(500 * 1024 * 1024) });
				res.write(EPUB_BYTES);
				held.push(res);
				return;
			}
			if (get[1] === '8') {
				res.writeHead(200, { 'Content-Type': 'application/epub+zip' });
				for (let i = 0; i < 4; i++) res.write(EPUB_BYTES);
				res.end();
				return;
			}
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('not found');
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	return {
		url: `http://127.0.0.1:${port}${prefix}`,
		host: `127.0.0.1:${port}`,
		requests,
		async close() {
			for (const r of held) r.destroy();
			srv.closeAllConnections();
			await new Promise((resolve) => srv.close(resolve));
		}
	};
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function rejects(promise, code) {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof CalibreError, `expected a CalibreError, got ${err && err.name}: ${err && err.message}`);
		assert.strictEqual(err.code, code, err.message);
		return err;
	}
	assert.fail(`expected a ${code} rejection`);
}

test('the library id comes from library-info once, and a configured one skips it', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url });
		assert.strictEqual(await c.libraryId(), LIB);
		assert.strictEqual(await c.libraryId(), LIB);
		assert.strictEqual(s.requests.filter((r) => r.url === '/ajax/library-info').length, 1);
		const fixed = createCalibreClient({ url: s.url, libraryId: 'Other' });
		assert.strictEqual(await fixed.libraryId(), 'Other');
		assert.strictEqual(s.requests.length, 1);
	} finally {
		await s.close();
	}
});

test('search sends the query and the page size and returns book ids', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url });
		assert.deepStrictEqual(await c.search('authors:"Quill"', { num: 25 }), [2, 1]);
		const last = s.requests[s.requests.length - 1].url;
		assert.ok(last.startsWith(`/ajax/search/${LIB}?`), last);
		const q = new URL(last, 'http://x').searchParams;
		assert.strictEqual(q.get('query'), 'authors:"Quill"');
		assert.strictEqual(q.get('num'), '25');
		assert.deepStrictEqual(await c.search('authors:"Nobody At All"'), []);
	} finally {
		await s.close();
	}
});

test('searchPage sends the sort and gives the total beside the page of ids', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url });
		assert.deepStrictEqual(await c.searchPage('authors:"Quill"', { num: 1, sort: 'last_modified', order: 'desc' }), { ids: [2, 1], total: 2 });
		const q = new URL(s.requests[s.requests.length - 1].url, 'http://x').searchParams;
		assert.deepStrictEqual([q.get('num'), q.get('sort'), q.get('sort_order')], ['1', 'last_modified', 'desc']);
		await c.searchPage('x');
		const plain = new URL(s.requests[s.requests.length - 1].url, 'http://x').searchParams;
		assert.deepStrictEqual([plain.has('sort'), plain.has('sort_order')], [false, false]);
	} finally {
		await s.close();
	}
});

test('books answers every id asked for, null for one Calibre does not have, and asks nothing for none', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url, libraryId: LIB });
		const got = await c.books([1, 2, 99, 1]);
		assert.deepStrictEqual([...got.keys()], [1, 2, 99]);
		assert.strictEqual(got.get(1).title, 'The Lantern Road');
		assert.strictEqual(got.get(99), null);
		const before = s.requests.length;
		assert.strictEqual((await c.books([])).size, 0);
		assert.strictEqual(s.requests.length, before);
	} finally {
		await s.close();
	}
});

test('book returns the format metadata the fingerprint is built from, and null for a 404', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url });
		const b = await c.book(1);
		assert.deepStrictEqual(b.format_metadata.epub.size, 65536);
		assert.strictEqual(b.format_metadata.epub.mtime, '2026-01-01T00:00:01.5+00:00');
		assert.ok(hasEpub(b));
		assert.ok(!hasEpub(await c.book(2)));
		assert.strictEqual(await c.book(404), null);
		assert.strictEqual(await c.book('nonsense'), null);
	} finally {
		await s.close();
	}
});

test('an EPUB download streams to the file and reports its size', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url });
		const dest = pathMod.join(TMP, 'one.download.tmp');
		assert.deepStrictEqual(await c.downloadEpub(1, dest), { bytes: EPUB_BYTES.length });
		assert.ok(fs.readFileSync(dest).equals(EPUB_BYTES));
		await rejects(c.downloadEpub(404, pathMod.join(TMP, 'none.tmp')), 'no-epub');
		assert.ok(!fs.existsSync(pathMod.join(TMP, 'none.tmp')));
	} finally {
		await s.close();
	}
});

test('an EPUB over the size cap is refused by its declared length and by its streamed length', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url, maxBytes: 100 * 1024 });
		const declared = pathMod.join(TMP, 'declared.tmp');
		await rejects(c.downloadEpub(7, declared), 'too-large');
		assert.ok(!fs.existsSync(declared), 'nothing is written for a refused length');
		const streamed = pathMod.join(TMP, 'streamed.tmp');
		await rejects(c.downloadEpub(8, streamed), 'too-large');
		assert.ok(!fs.existsSync(streamed), 'a partial download is removed');
	} finally {
		await s.close();
	}
});

test('a server that never answers times out, naming host and port only', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url, metaTimeoutMs: 150 });
		const err = await rejects(c.book(6), 'timeout');
		assert.ok(err.message.includes(s.host), err.message);
		assert.ok(!err.message.includes('http://'), err.message);
	} finally {
		await s.close();
	}
});

test('a closed Calibre is unreachable', async () => {
	const s = await server();
	const { url } = s;
	await s.close();
	const c = createCalibreClient({ url, libraryId: LIB });
	const err = await rejects(c.search('x'), 'unreachable');
	assert.strictEqual(err.cause, 'ECONNREFUSED');
	assert.ok(!err.message.includes('http://'), err.message);
});

test('a redirect is refused and never followed', async () => {
	const s = await server();
	try {
		const c = createCalibreClient({ url: s.url, libraryId: LIB });
		await rejects(c.book(5), 'bad-response');
		assert.deepStrictEqual(s.requests.map((r) => r.url), [`/ajax/book/5/${LIB}`]);
	} finally {
		await s.close();
	}
});

// The bug: whatever answered on the configured http address (another program on a free port
// 8080 while Calibre is closed) got the password in clear text by asking for Basic.
test('a Basic challenge over plain http is refused and no login is sent', async () => {
	const s = await server({ auth: 'basic' });
	try {
		const c = createCalibreClient({ url: s.url, username: 'reader', password: 'open sesame' });
		const err = await rejects(c.libraryId(), 'auth');
		assert.strictEqual(err.reason, 'basic-over-http');
		assert.match(err.message, /plain-text login over http/);
		assert.ok(!err.message.includes('open sesame'));
		assert.deepStrictEqual(s.requests.map((r) => r.authorization), [null]);
	} finally {
		await s.close();
	}
});

test('a Basic challenge over https is answered with the configured login, and refused without one', async (t) => {
	const seen = [];
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		seen.push({ url: String(url), authorization: opts.headers.Authorization || null });
		const ok = opts.headers.Authorization === `Basic ${Buffer.from('reader:open sesame').toString('base64')}`;
		if (!ok) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="calibre"' } });
		return new Response(JSON.stringify({ default_library: LIB }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	});
	const url = 'https://calibre.test:8443';
	assert.strictEqual(await createCalibreClient({ url, username: 'reader', password: 'open sesame' }).libraryId(), LIB);
	assert.deepStrictEqual(seen.map((r) => !!r.authorization), [false, true]);
	await rejects(createCalibreClient({ url }).libraryId(), 'auth');
	const wrong = await rejects(createCalibreClient({ url, username: 'reader', password: 'nope-wrong' }).libraryId(), 'auth');
	assert.ok(!wrong.message.includes('nope-wrong'));
});

test('a Digest challenge (calibre\'s default over plain HTTP) is answered per RFC 7616', async () => {
	const s = await server({ auth: 'digest' });
	try {
		const c = createCalibreClient({ url: s.url, username: 'reader', password: 'open sesame' });
		assert.deepStrictEqual(await c.search('authors:"Quill"'), [2, 1]);
		const dest = pathMod.join(TMP, 'digest.tmp');
		assert.deepStrictEqual(await c.downloadEpub(1, dest), { bytes: EPUB_BYTES.length });
		const sent = s.requests.filter((r) => r.authorization).map((r) => r.authorization);
		assert.ok(sent.length >= 3 && sent.every((a) => a.startsWith('Digest ') && !a.includes('open sesame')));
		const wrong = await rejects(createCalibreClient({ url: s.url, username: 'reader', password: 'not it at all' }).libraryId(), 'auth');
		assert.ok(!wrong.message.includes('not it at all'));
	} finally {
		await s.close();
	}
});

test('every request the client makes is a GET', async () => {
	const s = await server({ auth: 'digest' });
	try {
		const c = createCalibreClient({ url: s.url, username: 'reader', password: 'open sesame' });
		await c.search('authors:"Quill"');
		await c.books([1, 2]);
		await c.book(1);
		await c.book(404);
		await c.downloadEpub(1, pathMod.join(TMP, 'get-only.tmp'));
		assert.ok(s.requests.length >= 10);
		assert.deepStrictEqual([...new Set(s.requests.map((r) => r.method))], ['GET']);
	} finally {
		await s.close();
	}
});

test('a URL with a login in it is refused before any request, without echoing the login', async () => {
	const s = await server();
	try {
		const url = s.url.replace('http://', 'http://reader:hunter2-secret@');
		const c = createCalibreClient({ url });
		for (const call of [() => c.libraryId(), () => c.search('x'), () => c.books([1]), () => c.book(1), () => c.downloadEpub(1, pathMod.join(TMP, 'never.tmp'))]) {
			const err = await rejects(call(), 'bad-url');
			assert.strictEqual(err.reason, 'login-in-url');
			assert.ok(!err.message.includes('hunter2-secret') && !err.message.includes('reader:'), err.message);
		}
		assert.strictEqual(s.requests.length, 0);
		assert.ok(!fs.existsSync(pathMod.join(TMP, 'never.tmp')));
		assert.deepStrictEqual(checkUrl(url).ok, false);
		assert.strictEqual(checkUrl('ftp://127.0.0.1').reason, 'protocol');
		assert.strictEqual(checkUrl('not a url').reason, 'invalid');
		assert.strictEqual(checkUrl('http://127.0.0.1:8080').ok, true);
	} finally {
		await s.close();
	}
});

test('a URL prefix is kept on every request', async () => {
	const s = await server({ prefix: '/calibre' });
	try {
		const c = createCalibreClient({ url: `${s.url}/` });
		assert.deepStrictEqual(await c.search('authors:"Quill"'), [2, 1]);
		assert.ok(s.requests.every((r) => r.url.startsWith('/calibre/ajax/')), JSON.stringify(s.requests));
	} finally {
		await s.close();
	}
});
