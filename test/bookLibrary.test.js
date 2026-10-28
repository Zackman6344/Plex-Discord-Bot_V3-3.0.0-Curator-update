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
// The bug (rules version 3): the catalog never learned the music sections' folders, so a stray
// disc folder could fold into a library root, and it built without embedded tags, so a book whose
// author is only in its tags came out "untitled" and was renamed on the next build.
//
// The bug (metadata layer): a build stored what detection found and left the owner's edits,
// Calibre's and the online lookup's fills to a later refresh, so every rescan showed raw folder
// titles until then. An edit written while a build listed Plex was lost when that build replaced
// the catalog, and an exclude written mid-build was ignored until the next day's build. Waiting
// for the online lookup inside the build would hold every rescan and hourly build for half a
// minute.
//
// The bug (rules version 4): four loose single-file books that Plex filed as one album beside a
// fifth were one work, since tags were read once per album; split apart, none of them held half
// the old work, so its id, and the bookmark saved under it, matched nothing.
//
// Harness: createLibrary() with an injected fake plex.query that serves the synthetic
// test/fixtures/books/library.json and records every path, an injected tag reader (ffmpeg is never
// spawned), an injected online lookup (no network), injected timers and clock, and the real
// catalog store on a pid-suffixed file set before the first require (the store pattern of
// test/archipelagoHints.test.js). The lookup, tag and read-along stores the metadata layer
// requires point at pid-suffixed temp files too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-${process.pid}.json`);
const OVERRIDES_FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-overrides-${process.pid}.json`);
const AUX = pathMod.join(os.tmpdir(), `plexbot-test-book-library-aux-${process.pid}`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
process.env.PLEXBOT_BOOK_LOOKUP_FILE = `${AUX}-lookup.json`;
process.env.PLEXBOT_BOOK_TAGS_FILE = `${AUX}-tags.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${AUX}-text-works.json`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${AUX}-text-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${AUX}-text-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_MARKS_FILE = `${AUX}-text-marks.json`;
process.env.PLEXBOT_BOOK_TEXT_DIR = `${AUX}-text`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${AUX}-bookmarks.json`;
delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;

const logger = require('../helpers/logger.js');
const store = require('../helpers/bookCatalogStore.js');
const bookmarks = require('../helpers/bookmarks.js');
const bookModel = require('../helpers/bookModel.js');
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
		sections: [{ key: '1', type: 'artist', title: 'Music', scannedAt: 100, updatedAt: 100, Location: [{ id: 1, path: 'M:\\Music' }] }],
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

// Answers every tag read at once with whatever byAlbum holds, and records what it was asked.
function fakeTags(byAlbum = {}) {
	const state = { calls: [], byAlbum, next: [] };
	state.read = async (samples, opts) => {
		state.calls.push({ samples, opts });
		if (state.next.length) return state.next.shift()(samples, opts);
		return { byAlbum: clone(state.byAlbum), pending: 0, failed: 0, settled: Promise.resolve({ added: 0 }) };
	};
	return state;
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

async function settle() {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// Records every batch and answers with `answer(works, opts)`, or waits on `gate` first.
function fakeLookup(answer = () => ({ enabled: true, counts: {}, changed: [], results: {}, stopped: false })) {
	const state = { calls: [], gate: null, running: false, answer };
	state.refresh = async (works, opts) => {
		state.calls.push({ works, opts });
		state.running = true;
		try {
			if (state.gate) await state.gate;
			return state.answer(works, opts);
		} finally {
			state.running = false;
		}
	};
	state.isRunning = () => state.running;
	return state;
}

function setup({ enabled = true, tags = fakeTags(), online = false, lookup = fakeLookup(), query = null, calibreIndex = undefined } = {}) {
	const plex = fakePlex();
	const cfg = { audiobooksEnabled: enabled, audiobookOnlineLookup: online };
	const clock = { now: T0 };
	const timers = [];
	const timeouts = [];
	const lib = createLibrary({
		query: query ? query(plex) : plex.query,
		store,
		getConfig: () => cfg,
		tags,
		lookup,
		now: () => clock.now,
		setInterval: (fn, ms) => {
			const handle = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
			timers.push(handle);
			return handle;
		},
		clearInterval: (h) => { h.cleared = true; },
		setTimeout: (fn, ms) => {
			const handle = { fn, ms, cleared: false, unref() {} };
			timeouts.push(handle);
			return handle;
		},
		clearTimeout: (h) => { h.cleared = true; },
		...(calibreIndex ? { calibreIndex } : {}),
	});
	return { plex, cfg, clock, timers, timeouts, tags, lookup, lib };
}

function useOverrides(obj) {
	process.env.PLEXBOT_BOOK_OVERRIDES_FILE = OVERRIDES_FILE;
	fs.writeFileSync(OVERRIDES_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj));
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
	for (const p of [FILE, OVERRIDES_FILE, `${OVERRIDES_FILE}.bak`]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	delete process.env.PLEXBOT_BOOK_OVERRIDES_FILE;
	store.reset();
});

test.after(() => {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(AUX))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
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
		roots: ['M:\\Music'],
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
		tags: fakeTags(),
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

test('the section folders and the embedded tags reach both catalog builds', async (t) => {
	const tags = fakeTags({ 1040: { tags: { genre: 'Audiobook' }, chapters: 0, at: 1 } });
	const { lib } = setup({ tags });
	const build = t.mock.method(bookCatalog, 'buildCatalog');
	const report = await lib.rebuild();

	assert.strictEqual(tags.calls.length, 1);
	assert.deepStrictEqual(tags.calls[0].opts, { budgetMs: 45000, concurrency: 2 });
	assert.ok(tags.calls[0].samples.some((s) => s.album === '1040'));
	assert.ok(tags.calls[0].samples.every((s) => typeof s.file === 'string' && s.file.startsWith('M:/Music/')));
	assert.strictEqual(build.mock.callCount(), 2);
	for (const call of build.mock.calls) {
		assert.deepStrictEqual(call.arguments[0].roots, ['M:\\Music']);
		assert.strictEqual(call.arguments[0].tags['1040'].tags.genre, 'Audiobook');
	}
	assert.strictEqual(store.work('r-j-ashdown/the-hollow-king').detectedBy, 'genre');
	assert.deepStrictEqual(report.tags, { sampled: tags.calls[0].samples.length, pending: 0, failed: 0 });
	assert.deepStrictEqual(report.splits, []);
	assert.deepStrictEqual(report.doubtful, []);
});

test('a build waits for the tag read before it builds', async () => {
	const tags = fakeTags();
	const gate = deferred();
	tags.next.push(async () => {
		await gate.promise;
		return { byAlbum: { 1040: { tags: { genre: 'Audiobook' } } }, pending: 0, failed: 0, settled: Promise.resolve({ added: 1 }) };
	});
	const { lib } = setup({ tags });
	const run = lib.rebuild();
	await settle();
	assert.strictEqual(lib.status(), 'building');
	assert.strictEqual(store.works().length, 0);
	gate.resolve();
	assert.strictEqual((await run).ok, true);
	assert.strictEqual(store.work('r-j-ashdown/the-hollow-king').detectedBy, 'genre');
});

test('reads still running after the budget rebuild once when they add something', async () => {
	const tags = fakeTags();
	const late = deferred();
	tags.next.push(async () => ({ byAlbum: {}, pending: 3, failed: 0, settled: late.promise }));
	const { plex, lib } = setup({ tags });
	const report = await lib.rebuild();
	assert.deepStrictEqual(report.tags, { sampled: tags.calls[0].samples.length, pending: 3, failed: 0 });
	assert.strictEqual(listings(plex), 1);

	tags.byAlbum = { 1040: { tags: { genre: 'Audiobook' } } };
	late.resolve({ added: 3 });
	await settle();
	assert.strictEqual(listings(plex), 2, 'one more build, with the new tags');
	assert.strictEqual(store.work('r-j-ashdown/the-hollow-king').detectedBy, 'genre');
	await settle();
	assert.strictEqual(listings(plex), 2, 'and only one');

	const nothing = deferred();
	tags.next.push(async () => ({ byAlbum: {}, pending: 1, failed: 0, settled: nothing.promise }));
	await lib.rebuild();
	nothing.resolve({ added: 0 });
	await settle();
	assert.strictEqual(listings(plex), 3, 'reads that all failed are not worth another listing');
});

test('a second late tag rebuild within 10 minutes waits out the gap instead of being dropped', async () => {
	const tags = fakeTags();
	const first = deferred();
	const second = deferred();
	tags.next.push(async () => ({ byAlbum: {}, pending: 1, failed: 0, settled: first.promise }));
	const { plex, lib, clock, timeouts } = setup({ tags });
	await lib.rebuild();
	first.resolve({ added: 1 });
	await settle();
	assert.strictEqual(listings(plex), 2);

	tags.next.push(async () => ({ byAlbum: {}, pending: 1, failed: 0, settled: second.promise }));
	clock.now += 60 * 1000;
	await lib.rebuild();
	assert.strictEqual(listings(plex), 3);
	second.resolve({ added: 1 });
	await settle();
	assert.strictEqual(listings(plex), 3, 'not yet');
	assert.strictEqual(timeouts.length, 1);
	assert.strictEqual(timeouts[0].ms, 9 * MIN);
	timeouts[0].fn();
	await settle();
	assert.strictEqual(listings(plex), 4);
});

test('a late tag rebuild waits for a build that is already running', async () => {
	const tags = fakeTags();
	const late = deferred();
	tags.next.push(async () => ({ byAlbum: {}, pending: 1, failed: 0, settled: late.promise }));
	const { plex, lib } = setup({ tags });
	await lib.rebuild();
	let release;
	plex.gate = new Promise((resolve) => { release = resolve; });
	const running = lib.rebuild();
	late.resolve({ added: 1 });
	await settle();
	release();
	plex.gate = null;
	await running;
	await settle();
	assert.strictEqual(listings(plex), 3, 'the running build read the old cache, so one more follows it');
});

test('a build shows the owner\'s edits through the metadata layer before it replaces the catalog', async () => {
	useOverrides({
		works: { 'avery-quill/the-salt-crown': { title: 'The Salt Crown, Revised', narrator: 'Rhea Stone' } },
		authors: { 'Corin Vale': { series: 'The Tide Cantos', order: { 'The Long Tide': 1 } } },
	});
	const { lib } = setup();
	const report = await lib.rebuild();
	assert.strictEqual(report.ok, true);
	assert.deepStrictEqual(report.added.length, 16);

	const check = () => {
		const salt = store.work('avery-quill/the-salt-crown');
		assert.strictEqual(salt.id, 'avery-quill/the-salt-crown', 'an edited title never moves the id');
		assert.deepStrictEqual([salt.title, salt.narrator, salt.sources.title, salt.sources.narrator], ['The Salt Crown, Revised', 'Rhea Stone', 'override', 'override']);
		assert.strictEqual(salt.detected.title, 'The Salt Crown');
		const tide = store.work('corin-vale/the-long-tide');
		assert.deepStrictEqual([tide.series, tide.sequence, tide.sources.series], ['The Tide Cantos', 1, 'override'], 'an author key the build itself does not read');
		assert.ok(store.works().every((w) => w.sources && typeof w.sources === 'object'));
	};
	check();
	store.reset();
	check();
	assert.deepStrictEqual(store.refreshMetadata(), { ok: true, changed: [], error: null }, 'a refresh right after a build has nothing left to do');
});

test('an edit written while the build lists Plex is in the catalog that build stores', async () => {
	let wrote = false;
	const { lib } = setup({
		query: (plex) => async (p) => {
			// The chapter probes run after the build read the overrides file.
			if (!wrote && p.includes('includeChapters=1')) {
				wrote = true;
				useOverrides({ works: { 'avery-quill/the-salt-crown': { title: 'Edited Mid Build' } } });
			}
			return plex.query(p);
		},
	});
	await lib.rebuild();
	assert.strictEqual(wrote, true);
	assert.deepStrictEqual([store.work('avery-quill/the-salt-crown').title, store.work('avery-quill/the-salt-crown').sources.title], ['Edited Mid Build', 'override']);
});

test('a broken overrides file keeps what the build applied rather than resolving without the owner\'s edits', async () => {
	useOverrides('{"works": {');
	const { lib } = setup();
	const report = await lib.rebuild();
	assert.strictEqual(report.ok, true);
	assert.strictEqual(typeof report.overridesError, 'string');
	assert.strictEqual(store.works().length, 16);
	assert.ok(store.works().every((w) => w.sources === undefined), 'the metadata layer did not run');
	assert.strictEqual(store.work('avery-quill/the-salt-crown').title, 'The Salt Crown');
});

// The bug: a Calibre check run inside the build would hold every rebuild for as long as a closed
// Calibre GUI takes to time out.
test('each build hands the Calibre index the new catalog without waiting for it, and start and stop reach it', async () => {
	const calls = [];
	const calibreIndex = {
		start() { calls.push('start'); return new Promise(() => {}); },
		stop() { calls.push('stop'); },
		afterRebuild() { calls.push('afterRebuild'); return new Promise(() => {}); },
	};
	const { lib, timers } = setup({ calibreIndex });
	const first = await lib.start();
	assert.strictEqual(first.action, 'rebuilt', 'the build finished with the index still pending');
	assert.deepStrictEqual(calls, ['start', 'afterRebuild']);
	await lib.rebuild();
	assert.deepStrictEqual(calls.filter((c) => c === 'afterRebuild').length, 2);
	lib.stop();
	assert.strictEqual(calls[calls.length - 1], 'stop');
	assert.strictEqual(timers[0].cleared, true);
});

test('an index that throws never fails a build', async () => {
	const calibreIndex = { start() { throw new Error('boom'); }, stop() { throw new Error('boom'); }, afterRebuild() { throw new Error('boom'); } };
	const { lib } = setup({ calibreIndex });
	assert.strictEqual((await lib.start()).action, 'rebuilt');
	assert.strictEqual((await lib.rebuild()).ok, true);
	lib.stop();
});

test('with the online lookup off a build queues no batch', async () => {
	const { lib, lookup } = setup({ online: false });
	const report = await lib.rebuild();
	await settle();
	assert.strictEqual(lookup.calls.length, 0);
	assert.strictEqual(lib.onlineBatch(report), null);
	assert.strictEqual(lib.onlineBatch(null), null);
});

test('with the online lookup on, a build queues one batch it does not wait for, and applies what the batch changed', async (t) => {
	useOverrides({ works: { 'avery-quill/the-salt-crown': { narrator: 'Rhea Stone' } } });
	const gate = deferred();
	const lookup = fakeLookup(() => ({ enabled: true, region: 'us', counts: { edition: 1 }, changed: ['avery-quill/the-salt-crown'], results: {}, stopped: false }));
	lookup.gate = gate.promise;
	const refreshed = t.mock.method(store, 'refreshMetadata');
	const { lib } = setup({ online: true, lookup });

	const report = await lib.rebuild();
	assert.strictEqual(report.ok, true, 'the build finished while the batch is still waiting');
	const batch = lib.onlineBatch(report);
	assert.ok(batch && typeof batch.then === 'function');
	await settle();
	assert.strictEqual(lookup.calls.length, 1);
	const { works, opts } = lookup.calls[0];
	assert.deepStrictEqual(works.map((w) => w.id).sort(), store.works().map((w) => w.id).sort());
	assert.ok(works.every((w) => w.sources && typeof w.sources === 'object'), 'the batch is handed the resolved works');
	assert.deepStrictEqual(opts.overrideOf(store.work('avery-quill/the-salt-crown')), { narrator: 'Rhea Stone' });
	assert.strictEqual(opts.overrideOf(store.work('avery-quill/the-glass-road')), null);
	assert.strictEqual(refreshed.mock.callCount(), 0);

	gate.resolve();
	const summary = await batch;
	assert.deepStrictEqual(summary.changed, ['avery-quill/the-salt-crown']);
	assert.strictEqual(refreshed.mock.callCount(), 1, 'the fills reach the catalog');
});

test('a batch that changed nothing applies nothing, and a failing one resolves null', async (t) => {
	const lookup = fakeLookup();
	const refreshed = t.mock.method(store, 'refreshMetadata');
	const { lib } = setup({ online: true, lookup });
	const quiet = await lib.onlineBatch(await lib.rebuild());
	assert.deepStrictEqual(quiet.changed, []);
	assert.strictEqual(refreshed.mock.callCount(), 0);

	lookup.answer = () => { throw new Error('store went away'); };
	assert.strictEqual(await lib.onlineBatch(await lib.rebuild()), null);
	assert.strictEqual(logger.warn.mock.calls.some((c) => /online lookup failed/.test(c.arguments.join(' '))), true);
	assert.strictEqual(refreshed.mock.callCount(), 0);
});

test('one lookup batch runs at a time, and the builds made meanwhile share one more', async () => {
	const gate = deferred();
	const lookup = fakeLookup();
	lookup.gate = gate.promise;
	const { lib } = setup({ online: true, lookup });
	const first = lib.onlineBatch(await lib.rebuild());
	await settle();
	const second = lib.onlineBatch(await lib.rebuild());
	const third = lib.onlineBatch(await lib.rebuild());
	assert.notStrictEqual(first, second);
	assert.strictEqual(second, third);
	assert.strictEqual(lookup.calls.length, 1);
	gate.resolve();
	await Promise.all([first, second]);
	assert.strictEqual(lookup.calls.length, 2);
});

test('a batch started elsewhere is waited out before this catalog is looked up', async () => {
	const lookup = fakeLookup();
	lookup.running = true;
	const { lib } = setup({ online: true, lookup });
	await lib.onlineBatch(await lib.rebuild());
	assert.deepStrictEqual(lookup.calls.map((c) => c.works.length), [0, 16]);
});

test('after: current queues exactly one more build behind a running one, which reads an exclude written meanwhile', async () => {
	let queuedBuild = null;
	let queuedAgain = null;
	const { plex, lib } = setup({
		query: (fake) => async (p) => {
			if (!queuedBuild && p.includes('includeChapters=1')) {
				useOverrides({ works: { 'avery-quill/shadows-of-glass': { exclude: true } } });
				queuedBuild = lib.rebuild({ after: 'current' });
				queuedAgain = lib.rebuild({ after: 'current', force: true });
			}
			return fake.query(p);
		},
	});
	const running = lib.rebuild();
	const first = await running;
	assert.strictEqual(first.works, 16, 'the running build read the overrides before the exclude');
	assert.notStrictEqual(queuedBuild, running);
	assert.strictEqual(queuedAgain, queuedBuild, 'every call made meanwhile shares one queued build');
	const second = await queuedBuild;
	assert.strictEqual(second.works, 15);
	assert.strictEqual(store.work('avery-quill/shadows-of-glass'), null);
	assert.strictEqual(listings(plex), 2);

	const idle = lib.rebuild({ after: 'current' });
	assert.strictEqual(lib.status(), 'building', 'with nothing running it starts at once');
	await idle;
	assert.strictEqual(listings(plex), 3);
});

// The bug (review): applyOverrides finds an exclude, partOrder or pinId by the id detection gives
// alone, so a folder rename or a rule change that moved the id dropped a pinned id without a word
// outside a manual rescan's reply.
test('a pinned id survives a folder rename that moves the detected id, and the move is logged', async () => {
	useOverrides({ works: { 'avery-quill/the-ember-throne': { pinId: 'ember-pin' } } });
	const { plex, lib } = setup();
	await lib.rebuild();
	assert.strictEqual(store.work('ember-pin').id, 'ember-pin');
	for (const t of plex.lib.tracks) {
		const p = t.Media[0].Part[0];
		p.file = p.file.replace('/1.The Ember Throne/The Ember Throne ', '/1.Ember Throne/Ember Throne ');
	}
	const report = await lib.rebuild();
	assert.strictEqual(store.work('ember-pin').id, 'ember-pin');
	assert.strictEqual(store.work('avery-quill/ember-throne').id, 'ember-pin');
	assert.deepStrictEqual(report.moved, {});
	assert.ok(report.notes.some((n) => /avery-quill\/the-ember-throne \(pinId\) now apply to avery-quill\/ember-throne/.test(n)), report.notes.join('; '));
	const warned = () => logger.warn.mock.calls.map((c) => c.arguments.join(' '));
	assert.ok(warned().some((w) => /not detected: avery-quill\/the-ember-throne/.test(w)), 'every build logs what no longer matches');

	await lib.rebuild();
	assert.strictEqual(store.work('ember-pin').id, 'ember-pin', 'and on the build after that');
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')), { works: { 'avery-quill/the-ember-throne': { pinId: 'ember-pin' } } }, 'the file is left as written');
});

function looseTrack(rk, album, file, min, extra = {}) {
	const ms = Math.round(min * MIN);
	const name = file.split('/').pop();
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, parentRatingKey: album.ratingKey, grandparentRatingKey: album.parentRatingKey,
		type: 'track', title: name.replace(/\.[^.]+$/, ''), grandparentTitle: album.parentTitle, parentTitle: album.title,
		parentIndex: 1, duration: ms, addedAt: 1700000000,
		Media: [{ id: rk, duration: ms, bitrate: 64, audioChannels: 2, container: 'mp4', Part: [{ id: rk, key: `/library/parts/${rk}/1700000000/file.m4b`, duration: ms, file, size: 1000 + rk, container: 'mp4' }] }],
		...extra,
	};
}

test('a work split into loose books hands its id, its aliases and their bookmarks to the first book', async (t) => {
	t.after(() => bookmarks.reset());
	const first = { ratingKey: '4001', parentRatingKey: '94001', type: 'album', title: 'The Rust Ledger 1: Cold Iron', parentTitle: 'Graphic Audio LLC.', Genre: [{ tag: 'Audiobook' }] };
	const lumped = { ratingKey: '4002', parentRatingKey: '94002', type: 'album', title: 'The Rust Ledger 1: Cold Iron', parentTitle: 'Various Artists', Genre: [{ tag: 'Audiobook' }] };
	const loose = [looseTrack(40010, first, 'M:/Music/Cold_Iron_GraphicAudio.m4b', 150)];
	const byTrack = {};
	for (const [n, title] of [[2, 'Grey Tides'], [3, 'Low Sun'], [4, 'Salt Road'], [5, 'Iron Sea']]) {
		loose.push(looseTrack(40020 + n, lumped, `M:/Music/Wren Halloway - #${n} ${title} (Graphic Audio LLC.).m4b`, 160, { title, index: n }));
		byTrack[40020 + n] = { tags: { album: title, artist: 'Wren Halloway', composer: 'Graphic Audio LLC.', track: String(n) } };
	}
	const firstTags = { tags: { album: first.title, artist: 'Graphic Audio LLC.', copyright: 'Copyright (c) 2017, Wren Halloway' } };
	const tags = fakeTags();
	const answer = (a, b) => async () => ({ byAlbum: a, byTrack: b, pending: 0, failed: 0, settled: Promise.resolve({ added: 0 }) });
	tags.next.push(answer({}, {}), answer({ 4001: firstTags }, { ...byTrack, 40010: firstTags }));
	const { plex, lib } = setup({ tags });
	plex.lib.albums.push(first, lumped);
	plex.lib.tracks.push(...loose);

	await lib.rebuild();
	const before = clone(store.load());
	const merged = before.works['wren-halloway/cold-iron'];
	assert.strictEqual(merged.parts.length, 5, 'with no tags the #1 file names no book, so this build keeps them together');
	delete before.works['wren-halloway/cold-iron'];
	before.works['various-artists/cold-iron'] = { ...merged, id: 'various-artists/cold-iron', aliases: ['kid-ferro/music'] };
	store.replace(before);
	const old = store.work('various-artists/cold-iron');
	const at = 100 * MIN;
	bookmarks.record('listener-a', old, { absoluteMs: at }, { force: true });
	bookmarks.record('listener-b', { ...old, id: 'kid-ferro/music' }, { absoluteMs: at }, { force: true });

	const report = await lib.rebuild();
	assert.ok(tags.calls[1].samples.some((s) => s.album === undefined && s.track === '40023'), 'each loose file is read for itself');
	assert.deepStrictEqual(report.moved, { 'various-artists/cold-iron': 'wren-halloway/cold-iron' });
	assert.deepStrictEqual(report.added.filter((id) => id.startsWith('wren-halloway/')).sort(), ['wren-halloway/grey-tides', 'wren-halloway/iron-sea', 'wren-halloway/low-sun', 'wren-halloway/salt-road']);
	assert.deepStrictEqual(report.removed, []);
	for (const id of ['various-artists/cold-iron', 'kid-ferro/music', 'wren-halloway/cold-iron']) {
		const w = store.work(id);
		assert.deepStrictEqual([w.id, w.parts.map((p) => p.trackRatingKey)], ['wren-halloway/cold-iron', ['40010']], id);
	}
	for (const who of ['listener-a', 'listener-b']) {
		const w = store.work('wren-halloway/cold-iron');
		const mark = bookmarks.get(who, w);
		assert.strictEqual(mark && mark.workId, 'wren-halloway/cold-iron', who);
		const r = bookModel.resumeStart(w, mark);
		assert.deepStrictEqual([r.partIndex, r.partMs], [0, at], `${who} resumes where it stopped`);
	}
});

// The bug (catalog rules version 5): interleaved volumes are now placed by each file's album tag,
// so their files are read one by one; a 396-song upload bucket also shares track numbers, and only
// the album genres the build hands to tagSamples keep it from 396 ffmpeg reads.
test('interleaved volumes are read file by file, and a song bucket sharing track numbers is not', async () => {
	const tags = fakeTags();
	const { plex, lib } = setup({ tags });
	const rock = { ratingKey: '4101', parentRatingKey: '94101', type: 'album', title: 'Loud Hits', parentTitle: 'Kid Ferro', Genre: [{ tag: 'Rock' }] };
	plex.lib.albums.push(rock);
	for (let i = 1; i <= 40; i++) {
		for (const side of ['A', 'B']) plex.lib.tracks.push({ ...looseTrack(41000 + i * 2 + (side === 'B' ? 1 : 0), rock, `M:/Music/Kid Ferro/Loud Hits/${String(i).padStart(2, '0')} Song ${side}.mp3`, 4), index: i });
	}
	await lib.rebuild();
	const perFile = tags.calls[0].samples.filter((s) => s.album === undefined).map((s) => s.file);
	assert.ok(perFile.includes('M:/Music/Avery Quill/04 The Glass Road (Grahpic Audio) - Chapter 1.mp3'), 'a file of the interleaved volumes');
	assert.ok(!perFile.some((f) => f.includes('Loud Hits')), 'no song of the bucket');
	assert.ok(store.work('avery-quill/the-glass-road'), 'and the build goes on as before');
});

test('no request ever went to a Plex search endpoint', () => {
	assert.ok(everyPath.length > 50, 'the other tests ran first');
	assert.deepStrictEqual(everyPath.filter((p) => /search/i.test(p)), []);
});
