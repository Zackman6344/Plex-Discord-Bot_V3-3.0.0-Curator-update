// helpers/bookmarks.js: each listener's place in each work, the save throttle, finishing, the
// shelf status of a finished podcast, and the stats and leaderboard read from the same records.
//
// The bug: a bookmark store that writes a NaN position (read back as 0, the start of the book),
// forgets a place on a write failure or a folder rename, lets one listener's save touch another's,
// rewrites the file on every 15 s tick when nothing moved, or counts a podcast as "new episodes"
// when nothing was added. Each of these is silent until someone resumes in the wrong place.
//
// Harness: the store pattern of test/archipelagoHints.test.js (pid-suffixed env file set before
// the first require, afterEach unlink and reset) and the directory-at-.tmp write breaker from
// test/writeFailures.test.js. Dates come from t.mock.timers with only 'Date' mocked. Fixtures are
// synthetic: a three-part book and a podcast that gains an episode, under M:/Music/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-bookmarks-${process.pid}.json`);
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = FILE;

const logger = require('../helpers/logger.js');
const commandLog = require('../helpers/commandLog.js');
const config = require('../config/config.js');
const bookModel = require('../helpers/bookModel.js');
const bookmarks = require('../helpers/bookmarks.js');

const S = 1000;
const MIN = 60 * S;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const ALICE = '100000000000000001';
const BOB = '100000000000000002';
const CAROL = '100000000000000003';
const GUILD_A = '200000000000000001';
const GUILD_B = '200000000000000002';

function part(ordinal, durationMs, dir, extra) {
	return Object.assign({
		ordinal,
		albumRatingKey: '900',
		trackRatingKey: String(5000 + ordinal),
		title: `Part ${ordinal}`,
		durationMs,
		partKey: `/library/parts/${7000 + ordinal}/1/file.mp3`,
		file: `M:/Music/${dir}/0${ordinal} - Part.mp3`,
		sizeBytes: 40000000 + ordinal,
		container: 'mp3'
	}, extra || {});
}

function book(extra) {
	const dir = 'Some Author/A Synthetic Book';
	const parts = [part(1, 20 * MIN, dir), part(2, 30 * MIN, dir), part(3, 40 * MIN, dir)];
	return Object.assign({
		id: 'some-author/a-synthetic-book', kind: 'book', title: 'A Synthetic Book',
		author: 'Some Author', aliases: [], parts, totalMs: 90 * MIN
	}, extra || {});
}

function podcast(episodes) {
	const dir = 'A Synthetic Network/A Synthetic Podcast';
	const parts = [];
	for (let i = 1; i <= episodes; i++) {
		parts.push(part(i, 50 * MIN, dir, { title: `Episode ${i}`, trackRatingKey: String(6000 + i) }));
	}
	return {
		id: 'a-synthetic-network/a-synthetic-podcast', kind: 'podcast', title: 'A Synthetic Podcast',
		author: 'A Synthetic Network', aliases: [], parts, totalMs: episodes * 50 * MIN
	};
}

function removeAll() {
	const dir = pathMod.dirname(FILE);
	const base = pathMod.basename(FILE);
	for (const f of [FILE, `${FILE}.tmp`, `${FILE}.bak`, `${FILE}.bak.tmp`]) {
		try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) {}
	}
	for (const f of fs.readdirSync(dir)) {
		if (f.startsWith(`${base}.corrupt-`)) {
			try { fs.rmSync(pathMod.join(dir, f), { force: true }); } catch (_) {}
		}
	}
}

function setup(t, now = T0) {
	t.mock.timers.enable({ apis: ['Date'], now });
	const lines = { error: [], warn: [], info: [] };
	t.mock.method(logger, 'error', (...a) => { lines.error.push(a.join(' ')); });
	t.mock.method(logger, 'warn', (...a) => { lines.warn.push(a.join(' ')); });
	t.mock.method(logger, 'info', (...a) => { lines.info.push(a.join(' ')); });
	const events = [];
	t.mock.method(commandLog, 'recordEvent', (kind, detail) => { events.push({ kind, detail }); });
	return { lines, events, tick: (ms) => t.mock.timers.tick(ms) };
}

// Counts the store's renames onto FILE, which is one per real write.
function countWrites(t) {
	const writes = { n: 0 };
	const real = fs.renameSync;
	t.mock.method(fs, 'renameSync', (from, to) => {
		if (to === FILE) writes.n++;
		return real(from, to);
	});
	return writes;
}

function onDisk() {
	return JSON.parse(fs.readFileSync(FILE, 'utf8')).bookmarks;
}

test.beforeEach(() => {
	removeAll();
	bookmarks.reset();
});

test.afterEach(() => {
	removeAll();
	bookmarks.reset();
});

test('the store is the durable compact Audiobook file the plan names', () => {
	assert.strictEqual(bookmarks.FILE, FILE);
	assert.strictEqual(bookmarks.BACKUP_FILE, `${FILE}.bak`);
});

test('a place survives a restart with its hint', (t) => {
	setup(t);
	const w = book();
	const r = bookmarks.record(ALICE, w, { absoluteMs: 25 * MIN, speed: 1.25, guildId: GUILD_A, addListenedMs: 4 * MIN, addCoveredMs: 5 * MIN });
	assert.deepStrictEqual(r, { persisted: true, healthy: true });
	assert.ok(!fs.readFileSync(FILE, 'utf8').includes('\n'), 'pretty: false writes one line');

	bookmarks.reset();
	const mark = bookmarks.get(ALICE, w);
	assert.strictEqual(mark.absoluteMs, 25 * MIN);
	assert.strictEqual(mark.speed, 1.25);
	assert.strictEqual(mark.guildId, GUILD_A);
	assert.strictEqual(mark.listenedMs, 4 * MIN);
	assert.strictEqual(mark.coveredMs, 5 * MIN);
	assert.strictEqual(mark.kind, 'book');
	assert.strictEqual(mark.title, 'A Synthetic Book');
	assert.strictEqual(mark.startedAt, T0);
	assert.strictEqual(mark.lastListenedAt, T0);
	assert.deepStrictEqual(mark.hint, bookModel.hintFor(w, 25 * MIN));
	assert.strictEqual(mark.hint.ordinal, 2);
	assert.strictEqual(mark.hint.partMs, 5 * MIN);
	assert.strictEqual(mark.hint.file, '02 - Part.mp3');
	assert.ok(!('partKey' in mark.hint), 'part keys change on a rescan and are never stored');
	assert.strictEqual(bookModel.resumeStart(w, mark).absMs, 25 * MIN);
});

test('get returns a copy, so a caller cannot change the store behind its back', (t) => {
	setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN });
	const mark = bookmarks.get(ALICE, w);
	mark.absoluteMs = 0;
	mark.hint.partMs = 0;
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 10 * MIN);
	assert.strictEqual(bookmarks.get(ALICE, w).hint.partMs, 10 * MIN);
});

test('one listener saving never moves another listener in the same work', (t) => {
	setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN });
	bookmarks.record(BOB, w, { absoluteMs: 70 * MIN });
	bookmarks.reset();
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 10 * MIN);
	assert.strictEqual(bookmarks.get(BOB, w).absoluteMs, 70 * MIN);
	assert.deepStrictEqual(bookmarks.forUser(ALICE).map(m => m.userId), [ALICE]);

	assert.strictEqual(bookmarks.forget(ALICE, w.id).removed, true);
	assert.strictEqual(bookmarks.get(ALICE, w), null);
	assert.strictEqual(bookmarks.get(BOB, w).absoluteMs, 70 * MIN);
	assert.strictEqual(bookmarks.forget(ALICE, w.id).removed, false, 'forgetting twice is a no-op');
	bookmarks.reset();
	assert.strictEqual(bookmarks.get(ALICE, w), null, 'the forget reached disk');
});

test('a __proto__ user or work id is an ordinary key', (t) => {
	setup(t);
	const w = book({ id: '__proto__' });
	bookmarks.record('__proto__', book({ id: 'x' }), { absoluteMs: 5 * MIN });
	bookmarks.record(ALICE, w, { absoluteMs: 6 * MIN });
	assert.strictEqual(({}).absoluteMs, undefined, 'Object.prototype untouched');
	assert.strictEqual(Object.prototype.userId, undefined);

	bookmarks.reset();
	assert.strictEqual(bookmarks.get('__proto__', 'x').absoluteMs, 5 * MIN);
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 6 * MIN);
	assert.deepStrictEqual(bookmarks.forUser('__proto__').map(m => m.workId), ['x']);
	assert.strictEqual(bookmarks.get(ALICE, 'constructor'), null, 'no inherited key reads as a bookmark');
	assert.strictEqual(Object.keys(onDisk()).length, 2);
});

test('a non-finite position writes nothing and leaves the file byte-identical', (t) => {
	const { lines } = setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN, addListenedMs: MIN });
	const before = fs.readFileSync(FILE);
	const writes = countWrites(t);

	for (const bad of [undefined, NaN, Infinity, '600000', null]) {
		const r = bookmarks.record(ALICE, w, { absoluteMs: bad, addListenedMs: MIN }, { force: true });
		assert.deepStrictEqual(r, { persisted: false, healthy: true }, `absoluteMs ${String(bad)}`);
	}
	assert.deepStrictEqual(bookmarks.record(ALICE, w, undefined, { force: true }), { persisted: false, healthy: true });
	assert.strictEqual(writes.n, 0);
	assert.ok(fs.readFileSync(FILE).equals(before));
	assert.strictEqual(bookmarks.get(ALICE, w).listenedMs, MIN, 'memory untouched as well');
	assert.strictEqual(bookmarks.flush().persisted, false, 'and nothing was left dirty');
	assert.strictEqual(lines.error.length, 6);
	assert.match(lines.error[1], /position NaN is not a number/);
});

test('a write failure keeps the place in memory, flips healthy, and the next save retries', (t) => {
	const { events } = setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN });
	fs.mkdirSync(`${FILE}.tmp`);

	const r1 = bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 300 }, { force: true });
	assert.deepStrictEqual(r1, { persisted: false, healthy: false });
	assert.strictEqual(bookmarks.healthy(), false);
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 10 * MIN + 300, 'no rollback');
	const r2 = bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 500 });
	assert.deepStrictEqual(r2, { persisted: false, healthy: false });
	assert.deepStrictEqual(events.map(e => e.kind), ['book-save-failed'], 'one event per failure streak');
	assert.strictEqual(onDisk()[`${ALICE}::${w.id}`].absoluteMs, 10 * MIN);

	// Under a second from the last good write: a healthy store would skip this, a failing one retries.
	fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true });
	const r3 = bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 600 });
	assert.deepStrictEqual(r3, { persisted: true, healthy: true });
	assert.strictEqual(onDisk()[`${ALICE}::${w.id}`].absoluteMs, 10 * MIN + 600);

	fs.mkdirSync(`${FILE}.tmp`);
	bookmarks.record(ALICE, w, { absoluteMs: 13 * MIN }, { force: true });
	assert.deepStrictEqual(events.map(e => e.kind), ['book-save-failed', 'book-save-failed'], 'a new streak reports again');
});

test('a save is written only when the place or listening time moved a second', (t) => {
	const { tick } = setup(t);
	const w = book();
	const writes = countWrites(t);
	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN }).persisted, true, 'a new bookmark is written');
	assert.strictEqual(writes.n, 1);

	tick(15 * S);
	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN }).persisted, false, 'parked: nothing moved');
	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 600, addListenedMs: 600 }).persisted, false);
	assert.strictEqual(writes.n, 0 + 1);
	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 1200, addListenedMs: 600 }).persisted, true,
		'the small moves add up to a second against the last write');
	assert.strictEqual(writes.n, 2);

	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 1200, speed: 1.5 }).persisted, true, 'a speed change is written');
	assert.strictEqual(bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 1200 }, { force: true }).persisted, true, 'force writes');
	assert.strictEqual(writes.n, 4);

	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN + 1500 });
	assert.strictEqual(writes.n, 4);
	assert.strictEqual(onDisk()[`${ALICE}::${w.id}`].absoluteMs, 10 * MIN + 1200);
	assert.deepStrictEqual(bookmarks.flush(), { persisted: true, healthy: true }, 'flush writes the pending move');
	assert.strictEqual(onDisk()[`${ALICE}::${w.id}`].absoluteMs, 10 * MIN + 1500);
	assert.strictEqual(bookmarks.flush().persisted, false, 'and then has nothing to write');
	assert.strictEqual(writes.n, 5);
});

test('listening time only adds, and only real listening moves lastListenedAt', (t) => {
	const { tick } = setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 0, addListenedMs: 2 * MIN, addCoveredMs: 3 * MIN });
	tick(DAY);
	bookmarks.record(ALICE, w, { absoluteMs: 30 * MIN, addListenedMs: -5 * MIN, addCoveredMs: NaN });
	const mark = bookmarks.get(ALICE, w);
	assert.strictEqual(mark.listenedMs, 2 * MIN);
	assert.strictEqual(mark.coveredMs, 3 * MIN);
	assert.strictEqual(mark.lastListenedAt, T0, 'a goto while parked is not listening');
	assert.strictEqual(mark.updatedAt, T0 + DAY);
	assert.strictEqual(mark.speed, 1);

	bookmarks.record(ALICE, w, { absoluteMs: 30 * MIN, speed: 1.15, addListenedMs: 500 });
	assert.strictEqual(bookmarks.get(ALICE, w).speed, 1, 'a speed that is not one of SPEEDS is ignored');
	assert.strictEqual(bookmarks.get(ALICE, w).lastListenedAt, T0 + DAY);
});

test('a position is clamped to the work', (t) => {
	setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: -5 * S });
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 0);
	bookmarks.record(ALICE, w, { absoluteMs: 500 * MIN });
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 90 * MIN);
	assert.strictEqual(bookmarks.get(ALICE, w).hint.ordinal, 3);
});

test('a bookmark under a renamed work id moves to the new id on first read', (t) => {
	setup(t);
	const old = book({ id: 'some-author/a-synthetic-book-old' });
	bookmarks.record(ALICE, old, { absoluteMs: 33 * MIN, guildId: GUILD_A, addListenedMs: 9 * MIN });
	bookmarks.reset();

	const renamed = book({ id: 'some-author/a-synthetic-book', title: 'A Synthetic Book (Renamed)', aliases: [old.id] });
	assert.strictEqual(bookmarks.get(ALICE, renamed.id), null, 'a bare id does no alias lookup');
	const mark = bookmarks.get(ALICE, renamed);
	assert.strictEqual(mark.workId, renamed.id);
	assert.strictEqual(mark.title, 'A Synthetic Book (Renamed)');
	assert.strictEqual(mark.absoluteMs, 33 * MIN);
	assert.strictEqual(mark.listenedMs, 9 * MIN);

	bookmarks.reset();
	const keys = Object.keys(onDisk());
	assert.deepStrictEqual(keys, [`${ALICE}::${renamed.id}`], 'the re-key reached disk and the old key is gone');
	assert.strictEqual(bookmarks.get(BOB, renamed), null, 'another listener has nothing to inherit');
});

test('markFinished puts the place and hint at the last part end and counts once', (t) => {
	const { tick } = setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 87 * MIN, guildId: GUILD_A });
	assert.deepStrictEqual(bookmarks.markFinished(ALICE, w), { persisted: true, healthy: true });

	bookmarks.reset();
	let mark = bookmarks.get(ALICE, w);
	assert.strictEqual(mark.finished, true);
	assert.strictEqual(mark.finishedCount, 1);
	assert.strictEqual(mark.finishedAt, T0);
	assert.strictEqual(mark.absoluteMs, 90 * MIN);
	assert.deepStrictEqual(mark.hint, bookModel.hintFor(w, bookModel.totalMs(w)));
	assert.strictEqual(mark.hint.ordinal, 3);
	assert.strictEqual(mark.hint.partMs, 40 * MIN);
	assert.strictEqual(mark.hint.durationMs, 40 * MIN);
	assert.strictEqual(bookModel.resumeStart(w, mark).mode, 'restart');

	tick(MIN);
	bookmarks.markFinished(ALICE, w);
	mark = bookmarks.get(ALICE, w);
	assert.strictEqual(mark.finishedCount, 1, 'a second click is the same finish');
	assert.strictEqual(mark.finishedAt, T0);

	tick(DAY);
	bookmarks.record(ALICE, w, { absoluteMs: 0, finished: false });
	assert.strictEqual(bookmarks.get(ALICE, w).finished, false);
	assert.strictEqual(bookmarks.get(ALICE, w).finishedCount, 1, 'clearing finished keeps the count');
	bookmarks.markFinished(ALICE, w);
	mark = bookmarks.get(ALICE, w);
	assert.strictEqual(mark.finishedCount, 2);
	assert.strictEqual(mark.finishedAt, T0 + MIN + DAY);
});

test('markFinished creates the bookmark when the work was never saved', (t) => {
	setup(t);
	const w = book();
	bookmarks.markFinished(BOB, w, { guildId: GUILD_B });
	const mark = bookmarks.get(BOB, w);
	assert.strictEqual(mark.finished, true);
	assert.strictEqual(mark.guildId, GUILD_B);
	assert.strictEqual(mark.absoluteMs, 90 * MIN);
});

test('a finished podcast is caught up until an episode is added, then lands on it', (t) => {
	setup(t);
	const two = podcast(2);
	bookmarks.record(ALICE, two, { absoluteMs: 99 * MIN, addListenedMs: 99 * MIN });
	bookmarks.markFinished(ALICE, two);
	let mark = bookmarks.get(ALICE, two);
	assert.strictEqual(bookmarks.statusOf(mark, two), 'caught-up');

	const three = podcast(3);
	assert.strictEqual(bookmarks.statusOf(mark, three), 'new-episodes');
	const start = bookModel.resumeStart(three, mark);
	assert.strictEqual(start.mode, 'new-material');
	assert.strictEqual(start.partIndex, 2, 'the first new episode, not episode 1');
	assert.strictEqual(start.absMs, 100 * MIN);

	// A goto back after catching up is a revisit, not new material.
	bookmarks.record(ALICE, two, { absoluteMs: 20 * MIN });
	mark = bookmarks.get(ALICE, two);
	assert.strictEqual(mark.finished, true);
	assert.strictEqual(bookmarks.statusOf(mark, two), 'caught-up');

	assert.strictEqual(bookmarks.statusOf(mark, null), 'missing');
	assert.strictEqual(bookmarks.statusOf(null, two), null);
});

test('a book reads finished, in progress from a minute in, and new before that', (t) => {
	setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 59 * S });
	assert.strictEqual(bookmarks.statusOf(bookmarks.get(ALICE, w), w), 'new');
	bookmarks.record(ALICE, w, { absoluteMs: 60 * S });
	assert.strictEqual(bookmarks.statusOf(bookmarks.get(ALICE, w), w), 'in-progress');
	bookmarks.markFinished(ALICE, w);
	assert.strictEqual(bookmarks.statusOf(bookmarks.get(ALICE, w), w), 'finished');
	assert.strictEqual(bookmarks.statusOf(bookmarks.get(ALICE, w), book({ parts: book().parts.concat(part(4, 10 * MIN, 'X')) })), 'finished',
		'only a podcast reports new episodes');
});

test('stats sum real and book time, split by kind, and count finishes two ways', (t) => {
	const { tick } = setup(t);
	const w = book();
	const p = podcast(2);
	const other = book({ id: 'another-author/another-book', title: 'Another Book' });
	bookmarks.record(ALICE, w, { absoluteMs: 0, addListenedMs: 60 * MIN, addCoveredMs: 75 * MIN });
	bookmarks.markFinished(ALICE, w);
	bookmarks.record(ALICE, w, { absoluteMs: 0, finished: false });
	bookmarks.markFinished(ALICE, w);
	tick(S);
	bookmarks.record(ALICE, p, { absoluteMs: 40 * MIN, addListenedMs: 40 * MIN, addCoveredMs: 40 * MIN });
	tick(S);
	bookmarks.record(ALICE, other, { absoluteMs: 30 * S, addListenedMs: 30 * S, addCoveredMs: 45 * S });
	bookmarks.record(BOB, w, { absoluteMs: 80 * MIN, addListenedMs: 500 * MIN });

	const s = bookmarks.statsFor(ALICE);
	assert.strictEqual(s.works, 3);
	assert.strictEqual(s.listenedMs, 100 * MIN + 30 * S);
	assert.strictEqual(s.coveredMs, 115 * MIN + 45 * S);
	assert.strictEqual(s.worksFinished, 1);
	assert.strictEqual(s.totalFinishes, 2);
	assert.strictEqual(s.inProgress, 1, 'the podcast; 30 s into another book is not in progress yet');
	assert.strictEqual(s.byKind.book.listenedMs, 60 * MIN + 30 * S);
	assert.strictEqual(s.byKind.podcast.listenedMs, 40 * MIN);
	assert.strictEqual(s.byKind.podcast.inProgress, 1);
	assert.deepStrictEqual(s.top.map(r => r.workId), [w.id, p.id, other.id]);
	assert.deepStrictEqual(s.top.map(r => r.status), ['finished', 'in-progress', 'new']);
	assert.strictEqual(s.newEpisodes, 0);

	const catalog = { work: (id) => ({ [p.id]: podcast(2), [w.id]: w })[id] || null };
	bookmarks.markFinished(ALICE, p);
	assert.strictEqual(bookmarks.statsFor(ALICE, { work: (id) => (id === p.id ? podcast(3) : catalog.work(id)) }).newEpisodes, 1);
	const withMissing = bookmarks.statsFor(ALICE, catalog);
	assert.strictEqual(withMissing.top.find(r => r.workId === other.id).status, 'missing');
	assert.strictEqual(withMissing.top.find(r => r.workId === p.id).status, 'caught-up');
	assert.strictEqual(bookmarks.statsFor(ALICE, { works: { [p.id]: podcast(3) } }).newEpisodes, 1, 'a { works } map works too');

	const empty = bookmarks.statsFor(CAROL);
	assert.strictEqual(empty.works, 0);
	assert.deepStrictEqual(empty.top, []);
});

test('leaderboard rows are listeners with a bookmark saved in this guild, by hours then finishes', (t) => {
	setup(t);
	const w = book();
	const p = podcast(1);
	bookmarks.record(ALICE, w, { absoluteMs: MIN, guildId: GUILD_A, addListenedMs: 10 * MIN });
	bookmarks.record(BOB, w, { absoluteMs: MIN, guildId: GUILD_B, addListenedMs: 900 * MIN });
	bookmarks.record(CAROL, w, { absoluteMs: MIN, guildId: GUILD_B, addListenedMs: 10 * MIN });
	bookmarks.markFinished(CAROL, w);
	bookmarks.record(CAROL, p, { absoluteMs: MIN, guildId: GUILD_A });
	bookmarks.record('100000000000000004', p, { absoluteMs: MIN });

	const rows = bookmarks.leaderboardRows(GUILD_A);
	assert.deepStrictEqual(rows.map(r => r.userId), [CAROL, ALICE], 'Bob never saved here; the tie on hours goes to finishes');
	assert.strictEqual(rows[0].listenedMs, 10 * MIN, 'totals cover the listener\'s other guild too');
	assert.strictEqual(rows[0].worksFinished, 1);
	assert.strictEqual(rows[0].works, 2);
	assert.deepStrictEqual(bookmarks.leaderboardRows(GUILD_B).map(r => r.userId), [BOB, CAROL]);
	assert.deepStrictEqual(bookmarks.leaderboardRows('200000000000000009'), []);
	assert.deepStrictEqual(bookmarks.leaderboardRows(undefined), []);
});

test('resume with no title picks the newest unfinished work, and speed follows the newest bookmark', (t) => {
	const { tick } = setup(t);
	const saved = config.audiobookDefaultSpeed;
	t.after(() => { config.audiobookDefaultSpeed = saved; });
	const w = book();
	const p = podcast(2);
	const other = book({ id: 'another-author/another-book' });

	config.audiobookDefaultSpeed = '1.5';
	assert.strictEqual(bookmarks.lastInProgress(ALICE), null);
	assert.strictEqual(bookmarks.lastSpeed(ALICE), 1.5, 'the configured default for a first book');
	config.audiobookDefaultSpeed = 'fast';
	assert.strictEqual(bookmarks.lastSpeed(ALICE), 1, 'an unusable default falls back to 1x');

	bookmarks.record(ALICE, w, { absoluteMs: 5 * MIN, speed: 1.25 });
	tick(S);
	bookmarks.record(ALICE, p, { absoluteMs: 5 * MIN, speed: 2 });
	tick(S);
	bookmarks.record(ALICE, other, { absoluteMs: 5 * MIN, speed: 1.75 });
	bookmarks.markFinished(ALICE, other);
	assert.strictEqual(bookmarks.lastInProgress(ALICE).workId, p.id);
	assert.strictEqual(bookmarks.lastSpeed(ALICE), 1.75, 'the newest bookmark, finished or not');
	assert.deepStrictEqual(bookmarks.forUser(ALICE).map(m => m.workId), [other.id, p.id, w.id]);
	assert.strictEqual(bookmarks.lastInProgress(BOB), null);
});

test('the hourly backup is refreshed on the first save after a restart and restores a torn file', (t) => {
	const { lines } = setup(t);
	const w = book();
	bookmarks.record(ALICE, w, { absoluteMs: 10 * MIN });
	assert.ok(!fs.existsSync(`${FILE}.bak`), 'nothing to back up before the first file exists');
	bookmarks.reset();
	bookmarks.record(ALICE, w, { absoluteMs: 20 * MIN });
	assert.ok(fs.existsSync(`${FILE}.bak`));

	fs.writeFileSync(FILE, '');
	bookmarks.reset();
	assert.strictEqual(bookmarks.get(ALICE, w).absoluteMs, 10 * MIN, 'the backup, not an empty store');
	assert.ok(lines.warn.some(l => l.includes('Restored Audiobook bookmarks from the hourly backup')));
});
