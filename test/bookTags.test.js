// helpers/bookTags.js: reading embedded tags of one sampled file per album, and of every file of
// a folder that may hold single-file books, for the catalog.
//
// The bug: the catalog only saw Plex's listing, where a GraphicAudio file's artist is the
// publisher and its author appears only in the copyright tag, and genres that tell a 3-hour mix
// from a book are often missing. Reading tags must not block the bot: a synchronous probe, or a
// pile of ffmpeg children at Normal priority, is a measured cause of voice stutter. A read that
// fails must not erase what an earlier read learned, and the cache must not grow forever or keep
// descriptions and lyrics. A file ffmpeg cannot open (two real paths are too long for it) was
// spawned for again on every build, and a timeout must not be remembered as such a file.
//
// Harness: createTags() with an injected execFile that answers with a synthetic ffmpeg banner
// (ffmpeg is never spawned), an injected stat, os and in-memory store. One case uses the real
// jsonStore on a pid-suffixed file set through PLEXBOT_BOOK_TAGS_FILE before the first require.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-tags-${process.pid}.json`);
process.env.PLEXBOT_BOOK_TAGS_FILE = FILE;

const logger = require('../helpers/logger.js');
const bookTags = require('../helpers/bookTags.js');
const { createTags, parseProbe } = bookTags;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function banner(file, extra = '') {
	return [
		`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${file}':`,
		'  Metadata:',
		'    major_brand     : M4A ',
		'    title           : Cold Iron',
		'    artist          : Graphic Audio LLC.',
		'    album           : The Rust Ledger 1: Cold Iron',
		'    genre           : Audiobook',
		'    copyright       : Copyright 2018 by Wren Halloway',
		'    comment         : Summary: a publisher blurb that is never stored',
		'                    : Written by Wren Halloway. Narrated by Kit Moss.',
		'    description     : A synopsis that is never stored',
		'                    : and its second line',
		'    lyrics          : la la la',
		extra,
		'  Duration: 02:30:00.00, start: 0.000000, bitrate: 64 kb/s',
		'    Chapter #0:0: start 0.000000, end 3000.000000',
		'      Metadata:',
		'        title           : Chapter 1',
		'    Chapter #0:1: start 3000.000000, end 6000.000000',
		'      Metadata:',
		'        title           : Chapter 2',
		'  Stream #0:0(eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 62 kb/s (default)',
		'    Metadata:',
		'      handler_name    : SoundHandler',
		'      title           : a stream title, not the book',
		'At least one output file must be specified',
	].filter((l) => l !== '').join('\r\n');
}

function fakeFfmpeg({ transcript = (file) => banner(file), hold = () => false, error = () => ({ code: 1, killed: false }) } = {}) {
	const state = { calls: [], active: 0, maxActive: 0, nextPid: 4000, held: new Map() };
	state.execFile = (bin, args, opts, cb) => {
		const file = args[args.length - 1];
		state.calls.push({ bin, args, opts });
		state.active++;
		state.maxActive = Math.max(state.maxActive, state.active);
		const finish = () => {
			state.active--;
			const err = Object.assign(new Error('Command failed'), error(file));
			cb(err, '', transcript(file));
		};
		if (hold(file)) state.held.set(file, finish);
		else setImmediate(finish);
		return { pid: state.nextPid++ };
	};
	return state;
}

function memStore(initial = {}) {
	const data = Object.assign(Object.create(null), initial);
	return { data, writes: 0, load() { return data; }, persist() { this.writes++; return true; } };
}

function fakeStat(files) {
	const state = { calls: 0 };
	state.stat = async (file) => {
		state.calls++;
		const f = files[file];
		if (!f) throw Object.assign(new Error(`ENOENT: no such file, stat '${file}'`), { code: 'ENOENT' });
		return { size: f.size, mtimeMs: f.mtimeMs };
	};
	return state;
}

function fakeOs(fail = false) {
	const calls = [];
	return {
		calls,
		constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
		setPriority(pid, priority) {
			calls.push([pid, priority]);
			if (fail) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
		},
	};
}

function setup({ files, ffmpeg = fakeFfmpeg(), store = memStore(), osMod = fakeOs(), clock = { now: T0 }, maxSpawns } = {}) {
	const stat = fakeStat(files || { 'N:/a.m4b': { size: 100, mtimeMs: 1000 }, 'N:/b.mp3': { size: 200, mtimeMs: 2000 } });
	const tags = createTags({ execFile: ffmpeg.execFile, stat: stat.stat, os: osMod, store, now: () => clock.now, ffmpegPath: 'ffmpeg-fake', maxSpawns });
	return { tags, ffmpeg, stat, store, osMod, clock };
}

const JOBS = [{ album: '1', track: '11', file: 'N:/a.m4b', sizeBytes: 100 }, { album: '2', track: '21', file: 'N:/b.mp3', sizeBytes: 200 }];

test.beforeEach((t) => {
	t.mock.method(logger, 'info', () => {});
	t.mock.method(logger, 'warn', () => {});
	t.mock.method(logger, 'error', () => {});
});

test.afterEach(() => {
	for (const p of [FILE, `${FILE}.tmp`]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
});

test('parseProbe keeps only whitelisted container tags, joins continuation lines and counts chapters', () => {
	const { tags, chapters } = parseProbe(banner('N:/a.m4b'));
	assert.deepStrictEqual(tags, {
		title: 'Cold Iron',
		artist: 'Graphic Audio LLC.',
		album: 'The Rust Ledger 1: Cold Iron',
		genre: 'Audiobook',
		copyright: 'Copyright 2018 by Wren Halloway',
		comment: 'Written by Wren Halloway. Narrated by Kit Moss.',
	});
	assert.strictEqual(chapters, 2);
	assert.deepStrictEqual(parseProbe('N:/x.mp3: No such file or directory'), { tags: {}, chapters: 0 });
	assert.deepStrictEqual(parseProbe(undefined), { tags: {}, chapters: 0 });
});

// The bug (review): the comment tag of a ripped audiobook is usually the publisher's summary, and
// its first 300 characters were cached although nothing reads more than a credit line.
test('a comment keeps only the credit and GraphicAudio lines the catalog reads, each cut short', () => {
	const blurb = 'In a city of salt and glass, one thief must choose. '.repeat(4).trim();
	const withLines = (lines) => banner('N:/a.m4b').replace(
		/ {4}comment {9}: .*\r\n {20}: .*\r\n/,
		lines.map((l, i) => `${i ? ' '.repeat(20) : '    comment         '}: ${l}\r\n`).join(''),
	);
	assert.strictEqual(parseProbe(withLines([blurb, 'By : Wren Halloway', 'Visit graphicaudio.net for more'])).tags.comment, 'By : Wren Halloway\ngraphicaudio.net for more');
	assert.strictEqual(parseProbe(withLines([blurb, 'more of it'])).tags.comment, undefined, 'a summary alone is not kept at all');
	const late = parseProbe(withLines([`${'x'.repeat(150)} written by Wren Halloway, read by Kit Moss. ${blurb}`])).tags.comment;
	assert.ok(late.startsWith('written by Wren Halloway, read by Kit Moss.') && late.length <= 120, late);
});

test('a tag value is capped at 300 characters, continuation lines included', () => {
	const long = 'x'.repeat(400);
	const { tags } = parseProbe(banner('N:/a.m4b', `    narrator        : ${long}\r\n    publisher       : short\r\n                    : ${long}`));
	assert.strictEqual(tags.narrator.length, 300);
	assert.strictEqual(tags.publisher.length, 300);
	assert.ok(tags.publisher.startsWith('short\n'));
});

test('a read spawns ffmpeg once per file and serves later reads from the cache by size and mtime', async () => {
	const files = { 'N:/a.m4b': { size: 100, mtimeMs: 1000 }, 'N:/b.mp3': { size: 200, mtimeMs: 2000 } };
	const { tags, ffmpeg, store } = setup({ files });
	const first = await tags.read(JOBS);
	assert.strictEqual(first.pending, 0);
	assert.strictEqual(first.failed, 0);
	assert.deepStrictEqual(Object.keys(first.byAlbum).sort(), ['1', '2']);
	assert.strictEqual(first.byAlbum['1'].tags.genre, 'Audiobook');
	assert.strictEqual(first.byAlbum['1'].chapters, 2);
	assert.strictEqual(first.byAlbum['1'].at, T0);
	assert.deepStrictEqual(await first.settled, { added: 2 });
	assert.strictEqual(ffmpeg.calls.length, 2);
	assert.deepStrictEqual(ffmpeg.calls[0].bin, 'ffmpeg-fake');
	assert.deepStrictEqual(ffmpeg.calls[0].args, ['-hide_banner', '-nostdin', '-i', 'N:/a.m4b']);
	assert.deepStrictEqual(ffmpeg.calls[0].opts, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
	assert.ok(store.data['n:/a.m4b|100|1000'], Object.keys(store.data).join());
	assert.strictEqual(store.writes, 1);

	const again = await tags.read(JOBS);
	assert.strictEqual(ffmpeg.calls.length, 2, 'nothing changed, nothing spawned');
	assert.deepStrictEqual(again.byAlbum, first.byAlbum);

	files['N:/b.mp3'].mtimeMs = 3000;
	await (await tags.read(JOBS)).settled;
	assert.deepStrictEqual(ffmpeg.calls.map((c) => c.args[3]), ['N:/a.m4b', 'N:/b.mp3', 'N:/b.mp3']);
});

test('a failed read keeps the last good entry for that file and is tried again when the file changes', async () => {
	const files = { 'N:/a.m4b': { size: 100, mtimeMs: 1000 } };
	let broken = false;
	const ffmpeg = fakeFfmpeg({ transcript: (file) => (broken ? `${file}: Invalid data found when processing input` : banner(file)) });
	const { tags, clock } = setup({ files, ffmpeg });
	await (await tags.read([JOBS[0]])).settled;

	broken = true;
	files['N:/a.m4b'].mtimeMs = 5000;
	clock.now += DAY;
	let r = await tags.read([JOBS[0]]);
	assert.strictEqual(r.failed, 1);
	assert.strictEqual(r.byAlbum['1'].tags.album, 'The Rust Ledger 1: Cold Iron', 'what the file said last time');
	assert.strictEqual(r.byAlbum['1'].at, T0);

	delete files['N:/a.m4b'];
	r = await tags.read([JOBS[0]]);
	assert.strictEqual(r.failed, 1);
	assert.strictEqual(r.byAlbum['1'].tags.genre, 'Audiobook', 'an unmounted drive keeps it too');

	files['N:/a.m4b'] = { size: 100, mtimeMs: 6000 };
	broken = false;
	const spawned = ffmpeg.calls.length;
	await (await tags.read([JOBS[0]])).settled;
	assert.strictEqual(ffmpeg.calls.length, spawned + 1, 'the changed file is read again');

	r = await tags.read([{ album: '9', file: 'N:/never.mp3' }]);
	assert.deepStrictEqual([r.failed, r.byAlbum], [1, {}]);
});

test('a file ffmpeg cannot open is not spawned for again until it changes or 30 days pass', async () => {
	const long = `N:/${'x'.repeat(280)}.mp3`;
	const files = { [long]: { size: 300, mtimeMs: 3000 } };
	const ffmpeg = fakeFfmpeg({ transcript: (file) => `${file}: No such file or directory` });
	const { tags, store, clock } = setup({ files, ffmpeg });
	const job = { album: '5', file: long, sizeBytes: 300 };
	let r = await tags.read([job]);
	assert.deepStrictEqual([r.failed, r.byAlbum], [1, {}]);
	assert.deepStrictEqual(await r.settled, { added: 0 }, 'a failure is no new entry, so no follow-up rebuild');
	assert.deepStrictEqual(store.data[`${long.toLowerCase()}|300|3000`], { failed: true, at: T0, seen: T0 });
	assert.strictEqual(store.writes, 1);

	clock.now += 29 * DAY;
	r = await tags.read([job]);
	await r.settled;
	assert.deepStrictEqual([ffmpeg.calls.length, r.failed, r.byAlbum], [1, 1, {}], 'remembered for 29 days');
	assert.deepStrictEqual(tags.cached([job]), { byAlbum: {}, byTrack: {} }, 'a failure is never served as tags');

	clock.now += 2 * DAY;
	await (await tags.read([job])).settled;
	assert.strictEqual(ffmpeg.calls.length, 2, 'tried again after 30 days');
	files[long].size = 301;
	await (await tags.read([job])).settled;
	assert.strictEqual(ffmpeg.calls.length, 3, 'and when the file changes');
});

test('a failure that may pass (timeout, spawn error) is not remembered, and a remembered one hides no good entry', async () => {
	const files = { 'N:/a.m4b': { size: 100, mtimeMs: 1000 } };
	let mode = 'timeout';
	const errors = { timeout: { killed: true, signal: 'SIGTERM', code: null }, spawn: { code: 'EAGAIN' } };
	const ffmpeg = fakeFfmpeg({
		transcript: (file) => (mode === 'good' ? banner(file) : `${file}: Invalid data found when processing input`),
		error: () => errors[mode] || { code: 1, killed: false },
	});
	const { tags, store } = setup({ files, ffmpeg });
	await (await tags.read([JOBS[0]])).settled;
	mode = 'spawn';
	await (await tags.read([JOBS[0]])).settled;
	assert.strictEqual(ffmpeg.calls.length, 2);
	assert.deepStrictEqual(Object.keys(store.data), []);

	mode = 'good';
	await (await tags.read([JOBS[0]])).settled;
	mode = 'broken';
	files['N:/a.m4b'].mtimeMs = 2000;
	await (await tags.read([JOBS[0]])).settled;
	assert.strictEqual(store.data['n:/a.m4b|100|2000'].failed, true);
	const r = await tags.read([JOBS[0]]);
	assert.strictEqual(ffmpeg.calls.length, 4);
	assert.strictEqual(r.byAlbum['1'].tags.genre, 'Audiobook', 'the last good read still answers');
	assert.strictEqual(tags.cached([JOBS[0]]).byAlbum['1'].tags.genre, 'Audiobook');
});

test('the budget resolves with what it has, and reads still running land in the cache', async () => {
	const ffmpeg = fakeFfmpeg({ hold: (file) => file === 'N:/b.mp3' });
	const { tags, store } = setup({ ffmpeg });
	const r = await tags.read(JOBS, { budgetMs: 30 });
	assert.strictEqual(r.pending, 1);
	assert.deepStrictEqual(Object.keys(r.byAlbum), ['1']);
	assert.strictEqual(store.writes, 0, 'written once, when everything is done');

	ffmpeg.held.get('N:/b.mp3')();
	assert.deepStrictEqual(await r.settled, { added: 2 });
	assert.deepStrictEqual(Object.keys(r.byAlbum), ['1'], 'the answer already given does not change under the caller');
	assert.strictEqual(store.writes, 1);
	const spawned = ffmpeg.calls.length;
	const next = await tags.read(JOBS, { budgetMs: 30 });
	assert.deepStrictEqual([next.pending, Object.keys(next.byAlbum).sort()], [0, ['1', '2']]);
	assert.strictEqual(ffmpeg.calls.length, spawned);
});

test('an abort signal ends the wait early', async () => {
	const ffmpeg = fakeFfmpeg({ hold: () => true });
	const { tags } = setup({ ffmpeg });
	const ac = new AbortController();
	const pending = tags.read(JOBS, { budgetMs: 60000, signal: ac.signal });
	setImmediate(() => ac.abort());
	const r = await pending;
	assert.strictEqual(r.pending, 2);
	for (const finish of ffmpeg.held.values()) finish();
	await r.settled;
});

test('never more ffmpeg children than allowed, within one read and across overlapping reads', async () => {
	const files = {};
	const jobs = [];
	for (let i = 0; i < 6; i++) {
		files[`N:/f${i}.mp3`] = { size: i + 1, mtimeMs: 1 };
		jobs.push({ album: String(i), file: `N:/f${i}.mp3` });
	}
	const one = setup({ files });
	await (await one.tags.read(jobs, { concurrency: 2 })).settled;
	assert.strictEqual(one.ffmpeg.calls.length, 6);
	assert.strictEqual(one.ffmpeg.maxActive, 2);

	const two = setup({ files });
	const [a, b] = await Promise.all([two.tags.read(jobs.slice(0, 3), { concurrency: 2 }), two.tags.read(jobs.slice(3), { concurrency: 2 })]);
	await Promise.all([a.settled, b.settled]);
	assert.strictEqual(two.ffmpeg.calls.length, 6);
	assert.strictEqual(two.ffmpeg.maxActive, 2, 'the cap is shared by every read');

	const single = setup({ files, maxSpawns: 1 });
	await (await single.tags.read(jobs, { concurrency: 4 })).settled;
	assert.strictEqual(single.ffmpeg.maxActive, 1);
});

test('one file asked for twice at once is read once', async () => {
	const ffmpeg = fakeFfmpeg({ hold: () => true });
	const { tags } = setup({ ffmpeg });
	const a = tags.read([JOBS[0]], { budgetMs: 20 });
	const b = tags.read([{ ...JOBS[0], album: '7' }], { budgetMs: 20 });
	const [ra, rb] = await Promise.all([a, b]);
	assert.strictEqual(ffmpeg.calls.length, 1);
	for (const finish of ffmpeg.held.values()) finish();
	await Promise.all([ra.settled, rb.settled]);
	const r = await tags.read([JOBS[0], { ...JOBS[0], album: '7' }]);
	assert.deepStrictEqual(Object.keys(r.byAlbum).sort(), ['1', '7']);
});

test('each child is lowered to Below Normal, and a failure to do so is logged once and ignored', async (t) => {
	const ok = setup();
	await (await ok.tags.read(JOBS)).settled;
	assert.deepStrictEqual(ok.osMod.calls, [[4000, 10], [4001, 10]]);

	const warn = t.mock.method(logger, 'warn', () => {});
	const bad = setup({ osMod: fakeOs(true) });
	const r = await bad.tags.read(JOBS);
	await r.settled;
	assert.deepStrictEqual(Object.keys(r.byAlbum).sort(), ['1', '2']);
	assert.strictEqual(warn.mock.callCount(), 1);
	assert.match(warn.mock.calls[0].arguments[0], /EACCES/);
});

test('a read never throws, whatever fails', async () => {
	const thrower = { execFile: () => { throw new Error('spawn EPERM'); }, calls: [] };
	const a = setup({ ffmpeg: thrower });
	const r = await a.tags.read(JOBS);
	assert.deepStrictEqual([r.failed, r.byAlbum], [2, {}]);

	const b = createTags({ execFile: fakeFfmpeg().execFile, stat: () => { throw new Error('sync stat'); }, os: fakeOs(), store: memStore(), ffmpegPath: 'ffmpeg-fake' });
	assert.strictEqual((await b.read(JOBS)).failed, 2);

	const c = setup();
	for (const bad of [null, undefined, 'x', [null, { album: '1' }, { file: '' }]]) {
		const out = await c.tags.read(bad);
		assert.deepStrictEqual([out.pending, out.failed, out.byAlbum], [0, 0, {}]);
		assert.deepStrictEqual(await out.settled, { added: 0 });
	}
	assert.strictEqual(c.ffmpeg.calls.length, 0);
});

test('entries not seen for 30 days are pruned when the cache is written', async () => {
	const store = memStore({
		'n:/old.mp3|1|1': { tags: { genre: 'Rock' }, chapters: 0, at: T0 - 40 * DAY, seen: T0 - 31 * DAY },
		'n:/recent.mp3|1|1': { tags: { genre: 'Jazz' }, chapters: 0, at: T0 - 40 * DAY, seen: T0 - 2 * DAY },
	});
	const { tags } = setup({ store });
	await (await tags.read([JOBS[0]])).settled;
	assert.deepStrictEqual(Object.keys(store.data).sort(), ['n:/a.m4b|100|1000', 'n:/recent.mp3|1|1']);
});

test('a cache hit refreshes its last-seen time at most once a day', async () => {
	const { tags, store, clock } = setup();
	await (await tags.read(JOBS)).settled;
	assert.strictEqual(store.writes, 1);
	clock.now += 60 * 60 * 1000;
	await (await tags.read(JOBS)).settled;
	assert.strictEqual(store.writes, 1, 'an hour later nothing is rewritten');
	clock.now += DAY;
	await (await tags.read(JOBS)).settled;
	assert.strictEqual(store.writes, 2);
	assert.strictEqual(store.data['n:/a.m4b|100|1000'].seen, clock.now);
});

test('cached answers from the cache alone, with no stat and no spawn', async () => {
	const { tags, ffmpeg, stat } = setup();
	assert.deepStrictEqual(tags.cached(JOBS), { byAlbum: {}, byTrack: {} });
	await (await tags.read(JOBS)).settled;
	const before = [ffmpeg.calls.length, stat.calls];
	const out = tags.cached([...JOBS, { album: '3', file: 'N:/a.m4b', sizeBytes: 999 }]);
	assert.deepStrictEqual(Object.keys(out.byAlbum).sort(), ['1', '2'], 'a different size is a different file');
	assert.strictEqual(out.byAlbum['2'].tags.title, 'Cold Iron');
	assert.deepStrictEqual([ffmpeg.calls.length, stat.calls], before);
	assert.deepStrictEqual(tags.cached(null), { byAlbum: {}, byTrack: {} });
});

test('the default store writes only to the file PLEXBOT_BOOK_TAGS_FILE names', async () => {
	const ffmpeg = fakeFfmpeg();
	const stat = fakeStat({ 'N:/a.m4b': { size: 100, mtimeMs: 1000 } });
	const tags = createTags({ execFile: ffmpeg.execFile, stat: stat.stat, os: fakeOs(), ffmpegPath: 'ffmpeg-fake' });
	await (await tags.read([JOBS[0]])).settled;
	const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	assert.deepStrictEqual(Object.keys(saved.tags), ['n:/a.m4b|100|1000']);
	assert.deepStrictEqual(Object.keys(saved.tags['n:/a.m4b|100|1000'].tags).sort(), ['album', 'artist', 'comment', 'copyright', 'genre', 'title']);
	assert.strictEqual(typeof bookTags.read, 'function');
	assert.strictEqual(typeof bookTags.cached, 'function');
});

// The bug (rules version 4): tags were read from one file per Plex album, and Plex had filed four
// loose single-file books as one album, so the four shared one file's tags and one title. Each
// such file is now read for itself, keyed by its track, and its track number is kept.

function numbered(file) {
	const n = (file.match(/#(\d)/) || [])[1] || '1';
	return banner(file, `    track           : ${n}/5`).replace(/album {11}: [^\r\n]*/, `album           : Book ${n}`);
}

test('a file read for itself lands under its track only, beside the album samples', async () => {
	const files = { 'N:/a.m4b': { size: 100, mtimeMs: 1000 }, 'N:/#2.m4b': { size: 2, mtimeMs: 2 }, 'N:/#3.m4b': { size: 3, mtimeMs: 3 } };
	const { tags, ffmpeg } = setup({ files, ffmpeg: fakeFfmpeg({ transcript: numbered }) });
	const jobs = [JOBS[0], { track: '12', file: 'N:/#2.m4b', sizeBytes: 2 }, { track: '13', file: 'N:/#3.m4b', sizeBytes: 3 }, { file: 'N:/nobody.m4b' }];
	const r = await tags.read(jobs);
	await r.settled;
	assert.deepStrictEqual(Object.keys(r.byAlbum), ['1'], 'a per-file read never stands in for an album sample');
	assert.deepStrictEqual(Object.keys(r.byTrack).sort(), ['11', '12', '13']);
	assert.deepStrictEqual(['11', '12', '13'].map((k) => [r.byTrack[k].tags.album, r.byTrack[k].tags.track]), [['Book 1', '1/5'], ['Book 2', '2/5'], ['Book 3', '3/5']]);
	assert.strictEqual(ffmpeg.calls.length, 3, 'a job naming neither an album nor a track is skipped');
	assert.deepStrictEqual(Object.keys(tags.cached(jobs).byTrack).sort(), ['11', '12', '13']);
	assert.deepStrictEqual(Object.keys(tags.cached(jobs).byAlbum), ['1']);
});
