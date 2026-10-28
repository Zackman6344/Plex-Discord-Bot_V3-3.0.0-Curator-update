// helpers/calibreIndex.js: the cached copy of the Calibre library and each work's match.
//
// The bug: Calibre metadata reached the catalog only through a read-along pointer, so it was live
// for 1 of 73 books, and a record renamed in Calibre kept its old name until someone opened the
// read-along again. A naive index would hit a closed Calibre GUI on every check, block a catalog
// build on it, attach the wrong book after the library was rebuilt (ids are reused), keep a match
// to a deleted record, or lose a match when a rebuild moves a work's id.
//
// Harness: createCalibreIndex with a fake Calibre client (counted calls, a reachable switch, the
// /ajax/search and /ajax/books shapes), an in-memory store, a fake catalog and text store, and a
// manual clock and interval. No network, no files.

const test = require('node:test');
const assert = require('node:assert');
const { CalibreError } = require('../helpers/calibreClient.js');
const { createCalibreIndex, CHECK_INTERVAL_MS, BACKOFF_MAX_MS } = require('../helpers/calibreIndex.js');

const LIB = 'Test_Library';

function raw(id, over = {}) {
	return {
		uuid: `uuid-${id}`, title: `Book ${id}`, authors: ['Nobody Atall'], series: null, series_index: 1,
		tags: [], identifiers: {}, formats: ['epub'], last_modified: `2026-01-01T00:00:${String(id % 60).padStart(2, '0')}+00:00`,
		...over
	};
}

function fakeClient(data, lib = LIB) {
	const c = {
		data,
		lib,
		reachable: true,
		calls: { search: [], books: [] },
		check() {
			if (!c.reachable) throw new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).');
		},
		async libraryId() {
			c.check();
			return c.lib;
		},
		async searchPage(query, { num = 50, sort = '', order = '' } = {}) {
			c.check();
			c.calls.search.push({ query, num, sort, order });
			let ids = Object.keys(c.data).map(Number);
			if (sort === 'last_modified') ids.sort((a, b) => (c.data[b].last_modified > c.data[a].last_modified ? 1 : -1));
			return { ids: ids.slice(0, num), total: ids.length };
		},
		async books(ids) {
			c.check();
			c.calls.books.push(ids.length);
			return new Map(ids.map((id) => [id, c.data[id] ? JSON.parse(JSON.stringify(c.data[id])) : null]));
		}
	};
	return c;
}

function memoryStore() {
	const s = { data: {}, writes: 0, load: () => s.data, persist() { s.writes++; return true; } };
	return s;
}

function work(over = {}) {
	return { id: 'avery-quill/the-lantern-road', kind: 'book', title: 'The Lantern Road', author: 'Avery Quill', series: null, sequence: null, aliases: [], ...over };
}

function make({ works = [work()], books = {}, cfg = {}, overrides = {}, links = {}, pointers = {} } = {}) {
	const clock = { t: Date.UTC(2026, 9, 27, 12) };
	const client = fakeClient(books);
	const store = memoryStore();
	const refreshes = [];
	const timers = [];
	const logs = [];
	const catalog = {
		list: works,
		works: () => catalog.list,
		readOverrides: () => ({ overrides, error: null }),
		refreshMetadata: () => { refreshes.push(clock.t); return { ok: true, changed: [] }; }
	};
	const byIds = (map, w) => [w.id, ...(w.aliases || [])].map((id) => map[id]).find(Boolean) || null;
	const textStore = { links: { get: (w) => byIds(links, w) }, works: { peek: (w) => byIds(pointers, w) } };
	const config = { audiobooksEnabled: true, audiobookCalibreSort: true, calibreUrl: 'http://127.0.0.1:8080', ...cfg };
	const index = createCalibreIndex({
		getConfig: () => config,
		client: () => (config.calibreUrl ? client : null),
		catalog: () => catalog,
		textStore,
		store,
		now: () => clock.t,
		setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
		clearInterval: (t) => { t.cleared = true; },
		logger: { info: (...a) => logs.push(['info', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) }
	});
	return { index, client, store, clock, catalog, config, refreshes, timers, logs, overrides };
}

test('a full read is one search for every id and one details request per 100 books', async () => {
	const books = {};
	for (let i = 1; i <= 250; i++) books[i] = raw(i);
	books[7] = raw(7, { title: 'The Lantern Road', authors: ['Avery Quill'], tags: ['Fantasy', 'General'], identifiers: { isbn: '9780000000001' } });
	const h = make({ books });
	const r = await h.index.refresh();
	assert.deepStrictEqual([r.ok, r.fetched, r.books], [true, true, 250]);
	// The token (newest first, 1 id), then every id.
	assert.deepStrictEqual(h.client.calls.search.map((s) => [s.num, s.sort]), [[1, 'last_modified'], [5000, '']]);
	assert.deepStrictEqual(h.client.calls.books, [1, 100, 100, 50]);
	const saved = h.store.data;
	assert.strictEqual(saved.libraryId, LIB);
	assert.deepStrictEqual(saved.books['7'], {
		uuid: 'uuid-7', title: 'The Lantern Road', authors: ['Avery Quill'], series: null, index: null,
		tags: ['Fantasy', 'General'], isbn: '9780000000001', formats: ['epub'], last_modified: books[7].last_modified
	});
	assert.deepStrictEqual(saved.matches[work().id], { id: 7, uuid: 'uuid-7', libraryId: LIB, verdict: 'exact', method: 'title and author' });
	assert.strictEqual(h.refreshes.length, 1, 'the catalog shows the new details');
});

test('an unchanged token costs two requests and no full read; an edit or a deletion reads again', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }), 2: raw(2) } });
	await h.index.refresh();
	h.client.calls.search.length = 0;
	h.client.calls.books.length = 0;
	const again = await h.index.refresh();
	assert.deepStrictEqual([again.ok, again.fetched], [true, false]);
	assert.deepStrictEqual(h.client.calls.search.length, 1);
	assert.deepStrictEqual(h.client.calls.books, [1]);

	h.client.data[2].last_modified = '2026-02-01T00:00:00+00:00';
	assert.strictEqual((await h.index.refresh()).fetched, true);

	// The bug: a record deleted in Calibre kept its match until the next full rebuild.
	delete h.client.data[1];
	const gone = await h.index.refresh();
	assert.deepStrictEqual([gone.fetched, gone.changed], [true, true]);
	assert.strictEqual(h.index.matchFor(work()).verdict, 'none');
});

// The bug: a check against a Calibre GUI closed for the night failed every 15 minutes, logged
// every time, and a rebuild started another attempt at once.
test('a closed Calibre keeps the saved copy and backs off: 15 min, then 30, at most 2 h, one log line', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }) } });
	await h.index.refresh();
	h.client.reachable = false;
	const failed = await h.index.refresh({ force: true });
	assert.strictEqual(failed.ok, false);
	assert.match(failed.error, /not answering/);
	assert.strictEqual(h.index.matchFor(work()).id, 1, 'the saved copy stays in use');
	assert.strictEqual(h.index.status().answered, false);

	const calls = h.client.calls.search.length;
	assert.deepStrictEqual(await h.index.refresh(), { ok: false, skipped: 'backoff' });
	await h.index.afterRebuild();
	assert.strictEqual(h.client.calls.search.length, calls, 'no request while backing off');

	h.clock.t += CHECK_INTERVAL_MS;
	await h.index.refresh();
	assert.strictEqual(h.index.status().backoffUntil, h.clock.t + 2 * CHECK_INTERVAL_MS);
	for (let i = 0; i < 6; i++) await h.index.refresh({ force: true });
	assert.strictEqual(h.index.status().backoffUntil, h.clock.t + BACKOFF_MAX_MS);
	assert.strictEqual(h.logs.filter(([level]) => level === 'warn').length, 1);

	h.client.reachable = true;
	assert.strictEqual((await h.index.refresh({ force: true })).ok, true);
	assert.strictEqual(h.index.status().answered, true);
	assert.strictEqual(h.index.status().backoffUntil, null);
});

test('with the setting off, or no Calibre address, nothing is asked and nothing is matched', async () => {
	for (const cfg of [{ audiobookCalibreSort: false }, { calibreUrl: '' }, { audiobooksEnabled: false }]) {
		const h = make({ cfg, books: { 1: raw(1) } });
		assert.deepStrictEqual(await h.index.refresh({ force: true }), { ok: false, skipped: 'off' });
		assert.strictEqual(h.index.matchFor(work()), null);
		assert.strictEqual(h.index.metadataFor(work()), undefined);
		assert.strictEqual(h.client.calls.search.length, 0);
	}
});

// The bug: a rebuild that moved a work's id (a title cleanup) orphaned its match and its pin.
test('a work is found by its alias, and a rebuild re-keys its match from the saved copy with Calibre closed', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }) }, works: [work({ id: 'avery-quill/the-lantern-road-a-novel' })] });
	await h.index.refresh();
	const moved = work({ aliases: ['avery-quill/the-lantern-road-a-novel'] });
	assert.strictEqual(h.index.matchFor(moved).id, 1);
	h.client.reachable = false;
	h.catalog.list = [moved];
	await h.index.afterRebuild();
	assert.deepStrictEqual(Object.keys(h.index.matches()), [moved.id]);
	assert.strictEqual(h.index.matchFor(moved).id, 1);
});

test('a pin under an old id applies through the alias, and a pin whose uuid changed is flagged', async () => {
	const books = { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }), 2: raw(2, { title: 'Something Else' }) };
	const overrides = { works: { 'avery-quill/old-id': { calibreId: 2, calibreUuid: 'uuid-2', calibreLibrary: LIB } } };
	const h = make({ books, overrides, works: [work({ aliases: ['avery-quill/old-id'] })] });
	await h.index.refresh();
	assert.deepStrictEqual([h.index.matchFor(work()).id, h.index.matchFor(work()).method], [2, 'pin']);

	// The library was rebuilt and id 2 is now another book.
	h.client.data[2] = raw(2, { uuid: 'uuid-of-another-book', title: 'Another Book', last_modified: '2026-03-01T00:00:00+00:00' });
	await h.index.refresh();
	const m = h.index.matchFor(work());
	assert.deepStrictEqual([m.verdict, m.problem], ['none', 'uuid-changed']);
	assert.strictEqual(h.index.metadataFor(work()), null, 'no Calibre details from a broken pin');
});

test('switching to another library drops every match made in the old one', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }) } });
	await h.index.refresh();
	h.client.lib = 'Other_Library';
	h.client.data = { 1: raw(1, { title: 'A Different Book' }) };
	await h.index.refresh();
	assert.strictEqual(h.store.data.libraryId, 'Other_Library');
	assert.strictEqual(h.index.matchFor(work()).verdict, 'none');
});

test('metadata comes from a pin, then the read-along pointer\'s current record, then an exact match; never a likely one', async () => {
	const books = {
		1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'], series: 'Ashfall', series_index: 1 }),
		2: raw(2, { title: 'Road of Lanterns, Revised Text', authors: ['Avery Quill'] }),
		3: raw(3, { title: 'Pinned Record', authors: ['Avery Quill'] }),
		4: raw(4, { title: 'The Age of Lanterns', authors: ['Avery Quill'] })
	};
	const h = make({ books, works: [work(), work({ id: 'avery-quill/the-age-of-lanterns-vol-2', title: 'The Age of Lanterns Vol 2' })] });
	await h.index.refresh();
	assert.deepStrictEqual(h.index.metadataFor(work()), { title: 'The Lantern Road', authors: ['Avery Quill'], series: 'Ashfall', seriesIndex: 1 });
	assert.strictEqual(h.index.metadataFor(work(), 2).title, 'Road of Lanterns, Revised Text');
	const vol = work({ id: 'avery-quill/the-age-of-lanterns-vol-2', title: 'The Age of Lanterns Vol 2' });
	assert.strictEqual(h.index.matchFor(vol).verdict, 'likely');
	assert.strictEqual(h.index.metadataFor(vol), undefined);
	assert.deepStrictEqual(h.index.genreOf(vol), { verdict: 'likely', tags: [] });

	h.overrides.works = { [work().id]: { calibreId: 3 } };
	assert.strictEqual(h.index.rematch(), true);
	assert.strictEqual(h.index.metadataFor(work(), 2).title, 'Pinned Record');
	h.overrides.works = { [work().id]: { calibreId: null } };
	h.index.rematch();
	assert.strictEqual(h.index.metadataFor(work(), 2), null);
});

test('the read-along may take only an exact match that has an EPUB', async () => {
	const books = { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'], formats: ['pdf'] }), 2: raw(2, { title: 'The Salt Crown', authors: ['Avery Quill'] }) };
	const salt = work({ id: 'avery-quill/the-salt-crown', title: 'The Salt Crown' });
	const h = make({ books, works: [work(), salt] });
	await h.index.refresh();
	assert.strictEqual(h.index.readAlongPick(work()), null);
	assert.deepStrictEqual(h.index.readAlongPick(salt), { id: 2 });
});

test('start arms one unref\'d 15-minute check and stop disarms it; a tick while off asks nothing', async () => {
	const h = make({ books: { 1: raw(1) }, cfg: { audiobookCalibreSort: false } });
	h.index.start();
	h.index.start();
	assert.strictEqual(h.timers.length, 1);
	assert.strictEqual(h.timers[0].ms, CHECK_INTERVAL_MS);
	await h.timers[0].fn();
	assert.strictEqual(h.client.calls.search.length, 0);
	h.config.audiobookCalibreSort = true;
	await h.timers[0].fn();
	assert.ok(h.client.calls.search.length > 0);
	h.index.stop();
	assert.strictEqual(h.timers[0].cleared, true);
	assert.strictEqual(h.index.status().armed, false);
});

test('a broken overrides file leaves every match as it was', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }), 2: raw(2) }, overrides: { works: { [work().id]: { calibreId: 2 } } } });
	await h.index.refresh();
	assert.strictEqual(h.index.matchFor(work()).id, 2);
	h.catalog.readOverrides = () => ({ overrides: {}, error: 'the file is not valid JSON' });
	assert.strictEqual(h.index.rematch(), false);
	assert.strictEqual(h.index.matchFor(work()).id, 2);
});

// The bug: a read-along pointer was trusted by its Calibre id alone, so after a library switch, or
// a library rebuilt in the same folder, id 5 of the new library (a cookbook) filled the work's
// blank fields and filed it under the cookbook's tags.
test('a read-along pointer from another library, or to a reused id, attaches nothing', async () => {
	const books = { 5: raw(5, { title: 'A Cookbook of Soups', authors: ['Some Chef'], tags: ['Cooking', 'Horror'] }) };
	const pointer = (source) => ({ [work().id]: { base: 'b', via: 'auto', source: { type: 'calibre', id: 5, ...source }, meta: { title: 'The Lantern Road', authors: ['Avery Quill'] } } });
	for (const source of [{ libraryId: 'Lib_A' }, { libraryId: LIB, uuid: 'uuid-of-the-old-book' }]) {
		const h = make({ books, pointers: pointer(source) });
		await h.index.refresh();
		assert.notStrictEqual(h.index.matchFor(work()).method, 'read-along', JSON.stringify(source));
		assert.strictEqual(h.index.metadataFor(work(), 5, source), undefined, 'the pointer\'s own copy stands');
		assert.strictEqual(h.index.genreOf(work()), null);
	}
	const same = make({ books, pointers: pointer({ libraryId: LIB, uuid: 'uuid-5' }) });
	await same.index.refresh();
	assert.strictEqual(same.index.matchFor(work()).method, 'read-along', 'the same library and record still count');
});

// The bug: nothing listened for the setting, so fields an exact match filled stayed in the stored
// catalog after it was turned off, and were not put back when it was turned on again.
test('turning the setting off or on refreshes the stored catalog at the next check', async () => {
	const h = make({ books: { 1: raw(1, { title: 'The Lantern Road', authors: ['Avery Quill'] }) } });
	await h.index.refresh();
	await h.index.start();
	const n = h.refreshes.length;
	h.config.audiobookCalibreSort = false;
	await h.timers[0].fn();
	assert.strictEqual(h.refreshes.length, n + 1, 'off: once');
	await h.timers[0].fn();
	assert.strictEqual(h.refreshes.length, n + 1, 'still off: not again');
	h.config.audiobookCalibreSort = true;
	await h.timers[0].fn();
	assert.strictEqual(h.refreshes.length, n + 2, 'on again: once');
	h.index.stop();
});

// The bug: the back-off was timed from when the failed check ended, and the 15-minute timer fires
// a moment before that each time, so every boundary tick was skipped: tries at 30, 75, 150 min.
test('after a failure the timer tries again at 15, 45, 105 and 225 minutes', async () => {
	const h = make({ books: { 1: raw(1) } });
	const tries = [];
	h.client.libraryId = async () => {
		tries.push(h.clock.t);
		h.clock.t += 50;
		throw new CalibreError('unreachable', 'Calibre at 127.0.0.1:8080 is not answering (ECONNREFUSED).');
	};
	const g = h.clock.t;
	await h.index.start();
	for (let k = 1; k <= 16; k++) {
		h.clock.t = g + k * CHECK_INTERVAL_MS;
		await h.timers[0].fn();
	}
	h.index.stop();
	assert.deepStrictEqual(tries.map((t) => Math.round((t - g) / 60000)), [0, 15, 45, 105, 225]);
});

// The bug: a match was read by its id alone, so when rematch could not run over a fresh copy (a
// broken overrides file) and Calibre had reused the id, the work was filed under another book's
// tags and the read-along could open that book's EPUB.
test('a match whose record now holds another book is not read', async () => {
	const h = make({ books: { 12: raw(12, { title: 'The Lantern Road', authors: ['Avery Quill'], tags: ['Fantasy'] }) } });
	await h.index.refresh();
	assert.strictEqual(h.index.matchFor(work()).uuid, 'uuid-12');
	h.catalog.readOverrides = () => ({ overrides: {}, error: 'the file is not valid JSON' });
	h.client.data[12] = raw(12, { uuid: 'uuid-new', title: 'Another Book', tags: ['Cooking'], last_modified: '2026-03-01T00:00:00+00:00' });
	assert.strictEqual((await h.index.refresh()).fetched, true);
	assert.strictEqual(h.index.matchFor(work()).uuid, 'uuid-12', 'rematch did not run');
	assert.strictEqual(h.index.genreOf(work()), null);
	assert.strictEqual(h.index.readAlongPick(work()), null);
	assert.strictEqual(h.index.metadataFor(work()), undefined);
});

test('under the test runner the default instance is off and arms nothing', () => {
	const { instance } = require('../helpers/calibreIndex.js');
	const idx = instance();
	assert.strictEqual(idx.enabled(), false);
	assert.strictEqual(idx.start(), null);
	assert.strictEqual(idx.status().armed, false);
});
