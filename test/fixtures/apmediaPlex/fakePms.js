// test/fixtures/apmediaPlex/fakePms.js
// A fetch stand-in for Plex Media Server that serves test/fixtures/apmediaPlex/library.js, for
// tests that run the real helpers/apMediaPlex.js client without a network.
//
// It honours what the real server was verified to honour: X-Plex-Container-Start/Size paging with
// totalSize; type= on section listings; genre=<key>; album.id!= and artist.id!= exclusions; and
// accountID, librarySectionID and viewedAt>= on history, sorted by viewedAt ascending. Unknown
// paths answer 404. Every request is recorded with its path and query; the token is recorded
// separately so a test can check it never reached a URL.

function strip(row) {
	const out = {};
	for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
	return out;
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function createFakePlex(lib) {
	const calls = [];

	function sectionRows(key, q) {
		const section = lib.sections.find((s) => s.key === key);
		if (!section) return null;
		const type = q.get('type');
		let rows;
		if (section.type === 'movie') rows = type === '1' || !type ? lib.movies : [];
		else if (section.type === 'show') rows = type === '2' || !type ? lib.shows : [];
		else rows = type === '9' ? lib.albums : [];
		const genre = q.get('genre');
		if (genre) rows = rows.filter((r) => (r._genres || []).includes(genre));
		const noAlbums = (q.get('album.id!') || '').split(',').filter(Boolean);
		const noArtists = (q.get('artist.id!') || '').split(',').filter(Boolean);
		return rows.filter((r) => !noAlbums.includes(r.ratingKey) && !noArtists.includes(r.parentRatingKey));
	}

	function historyRows(q) {
		let rows = lib.history;
		if (q.has('accountID')) rows = rows.filter((r) => String(r.accountID) === q.get('accountID'));
		if (q.has('librarySectionID')) rows = rows.filter((r) => String(r.librarySectionID) === q.get('librarySectionID'));
		if (q.has('viewedAt>')) rows = rows.filter((r) => r.viewedAt >= Number(q.get('viewedAt>')));
		return [...rows].sort((a, b) => a.viewedAt - b.viewedAt);
	}

	function route(path, q) {
		let m;
		if (path === '/library/sections') return { key: 'Directory', rows: lib.sections };
		if ((m = /^\/library\/sections\/(\d+)\/all$/.exec(path))) return { rows: sectionRows(m[1], q) };
		if ((m = /^\/library\/sections\/(\d+)\/genre$/.exec(path))) return { key: 'Directory', rows: lib.genres[m[1]] || [] };
		if ((m = /^\/library\/sections\/(\d+)\/collections$/.exec(path))) return { rows: lib.collections[m[1]] || [] };
		if ((m = /^\/library\/collections\/(\d+)\/children$/.exec(path))) return { rows: lib.collectionItems[m[1]] || null };
		if ((m = /^\/library\/metadata\/(\d+)\/children$/.exec(path))) return { rows: lib.children[m[1]] || null };
		if ((m = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(path))) return { rows: lib.leaves[m[1]] || null };
		if (path === '/playlists') return { rows: lib.playlists };
		if ((m = /^\/playlists\/(\d+)\/items$/.exec(path))) return { rows: lib.playlistItems[m[1]] || null };
		if (path === '/status/sessions/history/all') return { rows: historyRows(q) };
		if (path === '/status/sessions') return { rows: [] };
		if (path === '/accounts') return { key: 'Account', rows: lib.accounts };
		return { rows: null };
	}

	async function fetch(url, init = {}) {
		const u = new URL(String(url));
		const q = u.searchParams;
		calls.push({ path: u.pathname, query: Object.fromEntries(q), url: String(url), token: init.headers && init.headers['X-Plex-Token'] });
		const { key = 'Metadata', rows } = route(u.pathname, q);
		if (rows === null || rows === undefined) return new Response('', { status: 404 });
		const start = Number(q.get('X-Plex-Container-Start') || 0);
		const size = q.has('X-Plex-Container-Size') ? Number(q.get('X-Plex-Container-Size')) : rows.length;
		const page = rows.slice(start, start + size).map(strip);
		return json({ MediaContainer: { size: page.length, totalSize: rows.length, offset: start, [key]: page } });
	}

	return { fetch, calls };
}

module.exports = { createFakePlex };
