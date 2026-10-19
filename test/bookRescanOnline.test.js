// commands/book.js/admin.js rescan: waiting for the online lookup batch the rescan's build queued.
//
// The bug: the online lookup runs after a build, in the background, so `!book rescan` answered
// before it finished and never said what it filled in; the owner had to rescan twice to see it.
// Holding the reply until a first batch of a large library finished could take minutes, and
// waiting on a batch an earlier build left behind would report that batch as this rescan's.
//
// Harness: the rescan subcommand against the real catalog store on a pid-suffixed temp file, with
// bookLibrary.rebuild and bookLibrary.onlineBatch stubbed on the module (no Plex, no network) and
// node:test's mock timers for the one-minute wait. Invented titles only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-rescan-online-${process.pid}`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const admin = require('../commands/book.js/admin.js');
const bookLibrary = require('../helpers/bookLibrary.js');
const store = require('../helpers/bookCatalogStore.js');

const HOUR = 3600000;
const saved = {
	ownerId: config.ownerId,
	online: config.audiobookOnlineLookup,
	rebuild: bookLibrary.rebuild,
	onlineBatch: bookLibrary.onlineBatch,
};

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	store.reset();
}

test.beforeEach(() => {
	cleanup();
	config.ownerId = '';
	store.replace({
		meta: { builtAt: 1, rulesVersion: 3, roots: [] },
		works: {
			'wren-halloway/grey-tides': {
				id: 'wren-halloway/grey-tides', title: 'Grey Tides', kind: 'book', author: 'Wren Halloway', narrator: null, edition: null,
				publisher: null, series: 'Tide Books', sequence: 2, confidence: 'high', folderKey: 'N:/Media/Music/Grey Tides', parts: [{}], doubts: [],
				sources: { title: 'folder', author: 'plex', narrator: null, edition: null, publisher: null, series: 'online', sequence: 'online' },
			},
		},
		rejected: [],
		index: {},
	});
});

test.after(() => {
	config.ownerId = saved.ownerId;
	config.audiobookOnlineLookup = saved.online;
	bookLibrary.rebuild = saved.rebuild;
	bookLibrary.onlineBatch = saved.onlineBatch;
	cleanup();
});

function report(extra = {}) {
	return {
		ok: true, works: 1, books: 1, podcasts: 0, parts: 1, totalMs: 3 * HOUR,
		added: [], removed: [], moved: {}, rejected: 0, splits: [], doubtful: [], notes: [], persisted: true,
		...extra,
	};
}

function summary() {
	return {
		enabled: true, region: 'us', counts: { edition: 1, book: 0, none: 0, error: 0, skipped: 0, cached: 0, deferred: 0 },
		changed: ['wren-halloway/grey-tides'], results: {}, stopped: false,
	};
}

async function settle() {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function rescan(said) {
	return admin.run({ sub: 'rescan', userId: '100000000000000001', say: async (m) => { said.push(m); } });
}

test('the rescan waits for the batch its own build queued and posts what it found', async () => {
	config.audiobookOnlineLookup = true;
	const mine = report();
	const asked = [];
	bookLibrary.rebuild = async () => mine;
	bookLibrary.onlineBatch = (r) => { asked.push(r); return r === mine ? Promise.resolve(summary()) : null; };
	const said = [];
	await rescan(said);
	assert.match(said[0], /Then it looks books up online, up to a minute more\./);
	assert.deepStrictEqual(asked, [mine]);
	assert.deepStrictEqual(mine.online, summary(), 'the summary goes on the report as it is');
	const posted = said.slice(1).join('\n');
	assert.match(posted, /Online lookup: 1 edition match\./);
	assert.match(posted, /Filled in online \(1\): \*\*Grey Tides\*\*: series Tide Books #2/);
});

test('a batch still running after a minute is reported as pending, and the reply waits no longer', async (t) => {
	config.audiobookOnlineLookup = true;
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const mine = report();
	bookLibrary.rebuild = async () => mine;
	bookLibrary.onlineBatch = () => new Promise(() => {});
	const said = [];
	const run = rescan(said);
	await settle();
	t.mock.timers.tick(59999);
	await settle();
	assert.strictEqual(said.length, 1, 'still waiting just under a minute');
	t.mock.timers.tick(1);
	await run;
	assert.deepStrictEqual(mine.online, { pending: true });
	assert.match(said.slice(1).join('\n'), /Online lookups are still running/);
});

test('with the setting off the rescan neither mentions nor waits for an online lookup', async () => {
	config.audiobookOnlineLookup = false;
	const mine = report();
	bookLibrary.rebuild = async () => mine;
	bookLibrary.onlineBatch = () => null;
	const said = [];
	await rescan(said);
	assert.doesNotMatch(said[0], /online/i);
	assert.strictEqual(Object.prototype.hasOwnProperty.call(mine, 'online'), false);
	assert.doesNotMatch(said.slice(1).join('\n'), /Online/);
});

test('a failed rebuild, or a batch that failed, adds nothing about the online lookup', async () => {
	config.audiobookOnlineLookup = true;
	let asked = 0;
	bookLibrary.rebuild = async () => ({ ok: false, error: 'connect ECONNREFUSED' });
	bookLibrary.onlineBatch = () => { asked++; return Promise.resolve(summary()); };
	const said = [];
	await rescan(said);
	assert.strictEqual(asked, 0);
	assert.match(said[1], /Rescan failed: ECONNREFUSED/);

	const mine = report();
	bookLibrary.rebuild = async () => mine;
	bookLibrary.onlineBatch = () => Promise.resolve(null);
	said.length = 0;
	await rescan(said);
	assert.strictEqual(Object.prototype.hasOwnProperty.call(mine, 'online'), false);
	assert.doesNotMatch(said.slice(1).join('\n'), /Online/);
});
