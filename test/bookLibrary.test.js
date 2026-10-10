// helpers/bookLibrary.js: building the catalog from Plex, the freshness check, chapter probes and
// part key repair.
//
// The bug: a full listing costs about 17 s and 25 MB, so running it on every /book play or two at
// once (a play during a rescan) stalls the bot, while never re-checking lets a book added to Plex
// play in Hitster for days. A listing taken while Plex is mid-scan, or from an unmounted drive,
// would replace a good catalog with a partial one and leak books into music. A repair that
// accepted whatever key a ratingKey now points at, or searched by title, would play another
// narration or another book entirely.
//
// Harness: createLibrary() with an injected fake plex.query that serves the synthetic
// test/fixtures/books/library.json and records every path, injected interval timers and clock,
// and the real catalog store on a pid-suffixed file set before the first require (the store
// pattern of test/archipelagoHints.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-${process.pid}.json`);
const OVERRIDES_FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-overrides-${process.pid}.json`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;

const logger = require('../helpers/logger.js');
const store = require('../helpers/bookCatalogStore.js');
const bookCatalog = require('../helpers/bookCatalog.js');
const { createLibrary } = require('../helpers/bookLibrary.js');
const LIBRARY = require('./fixtures/books/library.json');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const NOT_FOUND = 'Plex Server didnt respond with a valid 2xx status code, response code: 404';
const everyPath = [];

function clone(x) {
	return JSON.parse(JSON.stringify(x));
}

function fakePlex() {
	const state = {
		lib: clone(LIBRARY),
		sections: [{ key: '1', type: 'artist', title: 'Music', scannedAt: 100, updatedAt: 100 }],
		metadata: {},
		failListing: null,
		gate: null,
		calls: [],
	};
	const trackByKey = () => new Map(state.lib.tracks.map((t) => [String(t.ratingKey), t]));
	state.query = async (p) => {
		state.calls.push(p);
		everyPath.push(p);
		if (state.gate) await state.gate;
		if (p === '/library/sections') {
			return { MediaContainer: { Directory: [...clone(state.sections), { key: '7', type: 'movie', title: 'Films', scannedAt: 1, updatedAt: 1 }] } };
		}
		let m = p.match(/^\/library\/sections\/1\/all\?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=0$/);
		if (m) return { MediaContainer: { size: 0, totalSize: state.lib.tracks.length } };
		if (p === '/library/sections/1/all?type=10&includeGuids=1') {
			if (state.failListing) throw state.failListing;
			return { MediaContainer: { size: state.lib.tracks.length, Metadata: clone(state.lib.tracks) } };
		}
		if (p === '/library/sections/1/all?type=9&includeGuids=1') {
			return { MediaContainer: { size: state.lib.albums.length, Metadata: clone(state.lib.albums) } };
		}
		m = p.match(/^\/library\/metadata\/(\d+)\?includeChapters=1$/);
		if (m) {
			const t = trackByKey().get(m[1]);
			if (!t) throw new Error(NOT_FOUND);
			const chapters = state.lib.chapters[m[1]];
			return { MediaContainer: { Metadata: [{ ...clone(t), ...(chapters ? { Chapter: clone(chapters) } : {}) }] } };
		}
		m = p.match(/^\/library\/metadata\/(\d+)$/);
		if (m) {
			const override = state.metadata[m[1]];
			if (override instanceof Error) throw override;
			const t = override || trackByKey().get(m[1]);
			if (!t) throw new Error(NOT_FOUND);
			return { MediaContainer: { Metadata: [clone(t)] } };
		}
		throw new Error(`unexpected Plex path ${p}`);
	};
	return state;
}

function setup({ enabled = true } = {}) {
	const plex = fakePlex();
	const cfg = { audiobooksEnabled: enabled };
	const clock = { now: T0 };
	const timers = [];
	const lib = createLibrary({
		query: plex.query,
		store,
		getConfig: () => cfg,
		now: () => clock.now,
		setInterval: (fn, ms) => {
			const handle = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
			timers.push(handle);
			return handle;
		},
		clearInterval: (h) => { h.cleared = true; },
	});
	return { plex, cfg, clock, timers, lib };
}

function listings(plex) {
	return plex.calls.filter((p) => /all\?type=10&includeGuids=1$/.test(p)).length;
}

function trackOf(plex, title) {
	return plex.lib.tracks.find((t) => t.title === title);
}

test.beforeEach((t) => {
	t.mock.method(logger, 'info', () => {});
	t.mock.method(logger, 'warn', () => {});
	t.mock.method(logger, 'error', () => {});
});

test.afterEach(() => {
	for (const p of [FILE, OVERRIDES_FILE]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;
	store.reset();
});

test('a first build lists every music section and fills the store', async () => {
	const { plex, lib } = setup();
	assert.strictEqual(lib.status(), 'empty');
	const report = await lib.rebuild();

	assert.strictEqual(report.ok, true);
	assert.strictEqual(report.works, 16);
	assert.strictEqual(report.podcasts, 1);
	assert.strictEqual(report.added.length, 16);
	assert.deepStrictEqual(report.removed, []);
	assert.strictEqual(report.persisted, true);
	assert.strictEqual(lib.status(), 'ready');
	assert.strictEqual(store.works().length, 16);
	assert.deepStrictEqual(store.meta(), {
		builtAt: T0,
		rulesVersion: bookCatalog.RULES_VERSION,
		sections: { '1': { scannedAt: 100, updatedAt: 100, totalSize: plex.lib.tracks.length } },
		overridesError: null,
	});
	assert.ok(store.index().trackKeys.has(String(trackOf(plex, 'Sample').ratingKey)));
	assert.ok(!plex.calls.some((p) => p.startsWith('/library/sections/7/')), 'a movie section is never listed');
	assert.ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).catalog.works['avery-quill/the-glass-road']);
});

test('chapters are probed only for mp4 parts and parts over two hours, and markers are dropped', async () => {
	const { plex, lib } = setup();
	const gate20 = plex.lib.tracks.filter((t) => t.title === 'Night Gate 21');
	plex.lib.chapters[gate20[0].ratingKey] = [1, 2].map((i) => ({ index: i, tag: `Marker ${i}`, startTimeOffset: i * 300000, endTimeOffset: i * 300000 }));
	await lib.rebuild();

	const probed = plex.calls.filter((p) => p.includes('includeChapters=1')).map((p) => p.match(/metadata\/(\d+)/)[1]).sort();
	const m4b = trackOf(plex, 'The Long Tide [03]');
	assert.deepStrictEqual(probed, [m4b.ratingKey, ...gate20.map((t) => t.ratingKey)].map(String).sort());

	const tide = store.work('corin-vale/the-long-tide');
	assert.strictEqual(tide.parts[0].chapters, undefined, 'a 61-minute mp3 is not probed even though Plex has marker points for it');
	assert.strictEqual(tide.parts[4].chapters.length, 3);
	assert.strictEqual(store.work('ilse-moreau/the-night-gate~penrose').parts[1].chapters, undefined);

	const cache = store.load().chapterCache;
	const size = (t) => t.Media[0].Part[0].size;
	assert.strictEqual(cache[`${gate20[0].ratingKey}:${size(gate20[0])}`], 'markers');
	assert.strictEqual(cache[`${gate20[1].ratingKey}:${size(gate20[1])}`], 'none');
	assert.strictEqual(cache[`${m4b.ratingKey}:${size(m4b)}`].length, 3);
});

test('a second build reuses the chapter cache instead of asking Plex again', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	plex.calls.length = 0;
	await lib.rebuild();
	assert.deepStrictEqual(plex.calls.filter((p) => p.includes('includeChapters')), []);
	assert.strictEqual(store.work('corin-vale/the-long-tide').parts[4].chapters.length, 3);
});

test('a chapter probe that fails leaves the part playable and is asked again next time', async () => {
	const { plex, lib } = setup();
	const m4b = trackOf(plex, 'The Long Tide [03]');
	const realQuery = plex.query;
	let fail = true;
	const lib2 = createLibrary({
		query: async (p) => {
			if (fail && p === `/library/metadata/${m4b.ratingKey}?includeChapters=1`) throw new Error('socket hang up');
			return realQuery(p);
		},
		store,
		getConfig: () => ({ audiobooksEnabled: true }),
	});
	assert.strictEqual((await lib2.rebuild()).ok, true);
	assert.strictEqual(store.work('corin-vale/the-long-tide').parts[4].chapters, undefined);
	assert.ok(!Object.keys(store.load().chapterCache).some((k) => k.startsWith(`${m4b.ratingKey}:`)));
	fail = false;
	await lib.rebuild();
	assert.strictEqual(store.work('corin-vale/the-long-tide').parts[4].chapters.length, 3);
});

test('concurrent rebuilds share one listing', async () => {
	const { plex, lib } = setup();
	let release;
	plex.gate = new Promise((resolve) => { release = resolve; });
	const a = lib.rebuild();
	const b = lib.rebuild({ force: true });
	assert.strictEqual(a, b);
	assert.strictEqual(lib.status(), 'building');
	assert.deepStrictEqual(await lib.ensureFresh({ reason: 'play' }), { action: 'building', reason: 'play' });
	release();
	plex.gate = null;
	const [ra, rb] = await Promise.all([a, b]);
	assert.strictEqual(ra, rb);
	assert.strictEqual(listings(plex), 1);
	assert.strictEqual(lib.status(), 'ready');
});

test('an unchanged library costs one sections call and one count, and builds nothing', async () => {
	const { plex, lib, clock } = setup();
	await lib.rebuild();
	plex.calls.length = 0;
	clock.now += 3 * HOUR;
	const r = await lib.ensureFresh({ reason: 'hourly' });
	assert.strictEqual(r.action, 'fresh');
	assert.deepStrictEqual(plex.calls, ['/library/sections', '/library/sections/1/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=0']);
	assert.strictEqual(store.meta().builtAt, T0);
});

test('a changed scan time, update time or track count rebuilds', async () => {
	const { plex, lib, clock } = setup();
	await lib.rebuild();

	plex.sections[0].scannedAt = 200;
	clock.now += MIN;
	let r = await lib.ensureFresh({ reason: 'hourly' });
	assert.strictEqual(r.action, 'rebuilt');
	assert.strictEqual(r.why, 'library changed');
	assert.strictEqual(store.meta().sections['1'].scannedAt, 200);

	plex.sections[0].updatedAt = 300;
	r = await lib.ensureFresh({ reason: 'hourly' });
	assert.strictEqual(r.why, 'library changed');

	const extra = clone(trackOf(plex, 'Lighthouse 1'));
	extra.ratingKey = '99999';
	plex.lib.tracks.push(extra);
	r = await lib.ensureFresh({ reason: 'hourly' });
	assert.strictEqual(r.why, 'library changed');
	assert.strictEqual(store.meta().sections['1'].totalSize, plex.lib.tracks.length);

	assert.strictEqual((await lib.ensureFresh({ reason: 'hourly' })).action, 'fresh');
	assert.strictEqual(listings(plex), 4);
});

test('a section Plex is still scanning skips both the check and the rebuild', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	plex.sections[0].refreshing = true;
	plex.sections[0].scannedAt = 999;
	plex.calls.length = 0;

	assert.deepStrictEqual(await lib.ensureFresh({ reason: 'hourly' }), { action: 'skipped', reason: 'refreshing' });
	assert.deepStrictEqual(await lib.rebuild({ force: true }), { ok: false, skipped: 'refreshing' });
	assert.strictEqual(listings(plex), 0);
	assert.strictEqual(store.meta().sections['1'].scannedAt, 100);
});

test('no catalog, a rules change or a day-old build each rebuild', async () => {
	const { plex, lib, clock } = setup();
	let r = await lib.ensureFresh({ reason: 'start' });
	assert.deepStrictEqual([r.action, r.why], ['rebuilt', 'no catalog']);

	store.load().meta.rulesVersion = bookCatalog.RULES_VERSION - 1;
	r = await lib.ensureFresh({ reason: 'hourly' });
	assert.deepStrictEqual([r.action, r.why], ['rebuilt', 'rules changed']);

	clock.now += 23 * HOUR;
	assert.strictEqual((await lib.ensureFresh({ reason: 'hourly' })).action, 'fresh');
	clock.now += HOUR;
	r = await lib.ensureFresh({ reason: 'hourly' });
	assert.deepStrictEqual([r.action, r.why], ['rebuilt', 'older than a day']);
	assert.strictEqual(listings(plex), 3);
});

test('a check from /book play runs at most once an hour', async () => {
	const { plex, lib, clock } = setup();
	await lib.rebuild();
	plex.calls.length = 0;

	assert.strictEqual((await lib.ensureFresh({ reason: 'play' })).action, 'fresh');
	assert.deepStrictEqual(await lib.ensureFresh({ reason: 'play' }), { action: 'skipped', reason: 'rate-limited' });
	clock.now += 59 * MIN;
	assert.strictEqual((await lib.ensureFresh({ reason: 'play' })).action, 'skipped');
	assert.strictEqual(plex.calls.filter((p) => p === '/library/sections').length, 1);
	clock.now += 2 * MIN;
	assert.strictEqual((await lib.ensureFresh({ reason: 'play' })).action, 'fresh');
	assert.strictEqual((await lib.ensureFresh({ reason: 'hourly' })).action, 'fresh', 'the hourly timer is not rate-limited');
	assert.strictEqual(plex.calls.filter((p) => p === '/library/sections').length, 3);
});

test('the hourly check exists and runs only while audiobooks are enabled', async () => {
	const { plex, cfg, timers, lib } = setup({ enabled: false });
	assert.strictEqual(lib.start(), null);
	assert.strictEqual(timers.length, 0);
	assert.deepStrictEqual(plex.calls, []);

	cfg.audiobooksEnabled = true;
	const first = await lib.start();
	assert.strictEqual(first.action, 'rebuilt');
	assert.strictEqual(timers.length, 1);
	assert.strictEqual(timers[0].ms, HOUR);
	assert.strictEqual(timers[0].unrefed, true, 'the timer never keeps the process alive');
	await lib.start();
	assert.strictEqual(timers.length, 1, 'a second start arms nothing new');

	plex.calls.length = 0;
	cfg.audiobooksEnabled = false;
	assert.strictEqual(timers[0].fn(), null);
	assert.deepStrictEqual(plex.calls, []);

	cfg.audiobooksEnabled = true;
	assert.strictEqual((await timers[0].fn()).action, 'fresh');
	assert.strictEqual(plex.calls[0], '/library/sections');

	lib.stop();
	assert.strictEqual(timers[0].cleared, true);
	assert.strictEqual(lib.armed(), false);
});

test('repair accepts a new key only when the file basename still matches', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	const work = store.work('ilse-moreau/the-glass-sea');
	const part = work.parts[2];
	const t = clone(plex.lib.tracks.find((x) => String(x.ratingKey) === part.trackRatingKey));
	t.Media[0].Part[0].key = '/library/parts/123456/1900000000/Glass Sea 02.mp3';
	t.Media[0].Part[0].file = 'N:/Moved/Ilse Moreau/Glass Sea/Glass Sea 02.mp3';
	plex.metadata[part.trackRatingKey] = t;
	plex.calls.length = 0;

	assert.strictEqual(await lib.repairPartKey(work, part), '/library/parts/123456/1900000000/Glass Sea 02.mp3');
	assert.deepStrictEqual(plex.calls, [`/library/metadata/${part.trackRatingKey}`]);
	assert.strictEqual(store.partKeyFor(work.id, part), '/library/parts/123456/1900000000/Glass Sea 02.mp3');
});

test('repair refuses a key that now points at another file and schedules one rebuild per 10 minutes', async () => {
	const { plex, lib, clock } = setup();
	await lib.rebuild();
	const work = store.work('ilse-moreau/the-far-shore~penrose');
	const part = work.parts[0];
	const before = part.partKey;
	const t = clone(plex.lib.tracks.find((x) => String(x.ratingKey) === part.trackRatingKey));
	t.Media[0].Part[0].key = '/library/parts/654321/1900000000/Far Shore 05.mp3';
	t.Media[0].Part[0].file = 'M:/Music/Ilse Moreau/1990 - The Far Shore (Penrose) 540mb/Far Shore 05.mp3';
	plex.metadata[part.trackRatingKey] = t;
	plex.calls.length = 0;

	assert.strictEqual(await lib.repairPartKey(work, part), null);
	assert.strictEqual(store.partKeyFor(work.id, part), before);
	await lib.rebuild();
	assert.strictEqual(listings(plex), 1, 'the repair started a rebuild');

	clock.now += 9 * MIN;
	assert.strictEqual(await lib.repairPartKey(work, part), null);
	await lib.rebuild();
	assert.strictEqual(listings(plex), 2, 'only the explicit rebuild above listed again');

	clock.now += 2 * MIN;
	assert.strictEqual(await lib.repairPartKey(work, part), null);
	await lib.rebuild();
	assert.strictEqual(listings(plex), 3);
});

test('repair of a track Plex no longer has gives null and schedules a rebuild', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	const work = store.work('avery-quill/the-salt-crown');
	const part = work.parts[1];
	plex.metadata[part.trackRatingKey] = new Error(NOT_FOUND);
	plex.calls.length = 0;
	assert.strictEqual(await lib.repairPartKey(work, part), null);
	await lib.rebuild();
	assert.strictEqual(listings(plex), 1);
});

test('a network error during repair gives null without a rebuild', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	const work = store.work('avery-quill/the-salt-crown');
	const part = work.parts[1];
	plex.metadata[part.trackRatingKey] = new Error('connect ECONNREFUSED 127.0.0.1:32400');
	plex.calls.length = 0;
	assert.strictEqual(await lib.repairPartKey(work, part), null);
	assert.deepStrictEqual(plex.calls, [`/library/metadata/${part.trackRatingKey}`]);
	assert.strictEqual(await lib.repairPartKey(work, null), null);
});

test('an empty listing never replaces a catalog, and a failed one keeps it and says why', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	const tracks = plex.lib.tracks;
	plex.lib.tracks = [];
	plex.lib.albums = [];
	assert.deepStrictEqual(await lib.rebuild(), { ok: false, skipped: 'empty-listing' });
	assert.strictEqual(store.works().length, 16);

	plex.lib.tracks = tracks;
	plex.failListing = new Error('Plex Server didnt respond with a valid 2xx status code, response code: 500 X-Plex-Token=abc123secret');
	const r = await lib.rebuild();
	assert.strictEqual(r.ok, false);
	assert.doesNotMatch(r.error, /abc123secret/);
	assert.strictEqual(lib.status(), 'ready', 'the last catalog stays in use');
	assert.match(lib.lastError(), /response code: 500/);
	assert.strictEqual(store.works().length, 16);
});

test('a failed first build reports an error status', async () => {
	const { plex, lib } = setup();
	plex.failListing = new Error('connect ETIMEDOUT');
	assert.strictEqual((await lib.rebuild()).ok, false);
	assert.strictEqual(lib.status(), 'error');
	const r = await lib.ensureFresh({ reason: 'start' });
	assert.strictEqual(r.action, 'rebuilt');
	assert.strictEqual(r.report.ok, false);
});

test('a rebuild after a folder rename keeps the old id reachable as an alias', async () => {
	const { plex, lib } = setup();
	await lib.rebuild();
	for (const t of plex.lib.tracks) {
		const p = t.Media[0].Part[0];
		p.file = p.file.replace('/1.The Ember Throne/The Ember Throne ', '/1.Ember Throne/Ember Throne ');
	}
	const report = await lib.rebuild();
	assert.deepStrictEqual(report.moved, { 'avery-quill/the-ember-throne': 'avery-quill/ember-throne' });
	assert.deepStrictEqual(report.added, []);
	assert.deepStrictEqual(report.removed, []);
	assert.strictEqual(store.work('avery-quill/the-ember-throne').id, 'avery-quill/ember-throne');

	await lib.rebuild();
	assert.strictEqual(store.work('avery-quill/the-ember-throne').id, 'avery-quill/ember-throne', 'the alias survives later rebuilds');
});

test('overrides are read at each rebuild, and a broken file is recorded and the build goes on', async () => {
	const { lib } = setup();
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ works: { 'avery-quill/shadows-of-glass': { exclude: true } } }));
	let r = await lib.rebuild();
	assert.strictEqual(r.works, 15);
	assert.strictEqual(store.work('avery-quill/shadows-of-glass'), null);

	fs.writeFileSync(OVERRIDES_FILE, '{"works": {');
	r = await lib.rebuild();
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.works, 16);
	assert.strictEqual(typeof r.overridesError, 'string');
	assert.strictEqual(store.meta().overridesError, r.overridesError);
});

test('no request ever went to a Plex search endpoint', () => {
	assert.ok(everyPath.length > 50, 'the other tests ran first');
	assert.deepStrictEqual(everyPath.filter((p) => /search/i.test(p)), []);
});
