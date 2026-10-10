// jsonStore's `durable` option: fsync before rename, the hourly `.bak`, and loading from it.
//
// The bug: a write followed by a power cut or a BSOD can leave NTFS with the rename journaled and
// the data never written, so the store boots to a zero-length file, quarantines it and starts
// empty. For audiobook bookmarks that is every listener's place in every book gone at once. The
// option has to stay opt-in and invisible when off, because the Archipelago stores share this
// write path and are rewritten in bursts.
//
// Copies the directory-at-.tmp write breaker and the failing-rename quarantine from
// test/writeFailures.test.js. fs calls are watched with t.mock.method passing through to the real
// fs, and the `.bak` clock is the store's injected `now`, so no timers are mocked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-jsonstore-durable-${process.pid}.json`);
process.env.PLEXBOT_TEST_JSONSTORE_DURABLE_FILE = FILE;

const logger = require('../helpers/logger.js');
const { createStore, BACKUP_INTERVAL_MS } = require('../helpers/jsonStore.js');

const BAK = `${FILE}.bak`;
const HOUR = 60 * 60 * 1000;

function make(extra = {}) {
	return createStore({
		envVar: 'PLEXBOT_TEST_JSONSTORE_DURABLE_FILE',
		defaultPath: pathMod.join(os.tmpdir(), 'never-used.json'),
		key: 'bookmarks',
		shape: 'object',
		label: 'bookmark',
		feature: 'Audiobook',
		nullPrototype: true,
		pretty: false,
		...extra
	});
}

function clock(start = 1_000_000) {
	const c = { t: start, now: () => c.t };
	return c;
}

function asideFiles() {
	const dir = pathMod.dirname(FILE);
	const base = pathMod.basename(FILE);
	return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`)).map((f) => pathMod.join(dir, f));
}

function fileOf(data) {
	return JSON.stringify({ bookmarks: data });
}

function quiet(t) {
	const lines = { error: [], warn: [] };
	t.mock.method(logger, 'error', (...args) => { lines.error.push(args); });
	t.mock.method(logger, 'warn', (...args) => { lines.warn.push(args); });
	return lines;
}

/** Records fs calls in order, passing every one through to the real fs. */
function watchFs(t) {
	const calls = [];
	const fdPath = new Map();
	const realOpen = fs.openSync;
	const realFsync = fs.fsyncSync;
	const realRename = fs.renameSync;
	const realWrite = fs.writeFileSync;
	t.mock.method(fs, 'openSync', function (p) {
		const fd = realOpen.apply(fs, arguments);
		fdPath.set(fd, String(p));
		return fd;
	});
	t.mock.method(fs, 'fsyncSync', function (fd) {
		calls.push(['fsync', fdPath.get(fd)]);
		return realFsync.apply(fs, arguments);
	});
	t.mock.method(fs, 'renameSync', function (from, to) {
		calls.push(['rename', String(from), String(to)]);
		return realRename.apply(fs, arguments);
	});
	t.mock.method(fs, 'writeFileSync', function (target, text) {
		calls.push(['write', typeof target === 'number' ? fdPath.get(target) : String(target), text]);
		return realWrite.apply(fs, arguments);
	});
	return calls;
}

test.afterEach(() => {
	for (const p of [FILE, `${FILE}.tmp`, BAK, `${BAK}.tmp`, ...asideFiles()]) {
		try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
	}
});

test('the backup interval is one hour', () => {
	assert.strictEqual(BACKUP_INTERVAL_MS, HOUR);
});

test('durable off writes exactly as before, with no fsync and no backup', (t) => {
	fs.writeFileSync(FILE, fileOf({ 'u1::w': { absoluteMs: 1 } }));
	const store = make();
	const data = store.load();
	data['u1::w'] = { absoluteMs: 2 };
	const calls = watchFs(t);

	assert.strictEqual(store.persist(), true);
	assert.deepStrictEqual(calls, [
		['write', `${FILE}.tmp`, fileOf({ 'u1::w': { absoluteMs: 2 } })],
		['rename', `${FILE}.tmp`, FILE]
	]);
	assert.strictEqual(fs.existsSync(BAK), false);
	assert.strictEqual(store.backupFile, null);
});

test('durable on fsyncs the tmp file before renaming it over the target', (t) => {
	quiet(t);
	const store = make({ durable: true, now: clock().now });
	store.load()['u1::w'] = { absoluteMs: 5 };
	const calls = watchFs(t);

	assert.strictEqual(store.persist(), true);
	const fsyncAt = calls.findIndex((c) => c[0] === 'fsync' && c[1] === `${FILE}.tmp`);
	const renameAt = calls.findIndex((c) => c[0] === 'rename' && c[1] === `${FILE}.tmp` && c[2] === FILE);
	assert.ok(fsyncAt >= 0, 'the tmp file is fsynced');
	assert.ok(renameAt > fsyncAt, 'and only then renamed');
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), fileOf({ 'u1::w': { absoluteMs: 5 } }));
});

test('durable on writes the backup at most once per hour, from the file before the write', (t) => {
	quiet(t);
	const c = clock();
	const first = fileOf({ 'u1::w': { absoluteMs: 1 } });
	fs.writeFileSync(FILE, first);
	const store = make({ durable: true, now: c.now });
	const data = store.load();
	const calls = watchFs(t);
	const backups = () => calls.filter((x) => x[0] === 'rename' && x[2] === BAK).length;

	data['u1::w'] = { absoluteMs: 2 };
	store.persist();
	assert.strictEqual(backups(), 1, 'the first write after boot refreshes the backup');
	assert.strictEqual(fs.readFileSync(BAK, 'utf8'), first, 'from the file as it was before the write');
	const bakFsync = calls.findIndex((x) => x[0] === 'fsync' && x[1] === `${BAK}.tmp`);
	const bakRename = calls.findIndex((x) => x[0] === 'rename' && x[2] === BAK);
	assert.ok(bakFsync >= 0 && bakRename > bakFsync, 'the backup goes through its own fsynced tmp');

	c.t += HOUR - 1;
	data['u1::w'] = { absoluteMs: 3 };
	store.persist();
	assert.strictEqual(backups(), 1, 'not again inside the hour');
	assert.strictEqual(fs.readFileSync(BAK, 'utf8'), first);

	c.t += 1;
	data['u1::w'] = { absoluteMs: 4 };
	store.persist();
	assert.strictEqual(backups(), 2, 'again once the hour is up');
	assert.strictEqual(fs.readFileSync(BAK, 'utf8'), fileOf({ 'u1::w': { absoluteMs: 3 } }));
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), fileOf({ 'u1::w': { absoluteMs: 4 } }));
});

test('a zero-length file loads from the backup instead of starting empty', (t) => {
	const lines = quiet(t);
	const saved = fileOf({ 'u1::w': { absoluteMs: 7_200_000 } });
	fs.writeFileSync(BAK, saved);
	fs.writeFileSync(FILE, '');
	const store = make({ durable: true, now: clock().now });

	const data = store.load();
	assert.deepStrictEqual({ ...data }, { 'u1::w': { absoluteMs: 7_200_000 } });
	assert.strictEqual(Object.getPrototypeOf(data), null, 'the restored copy keeps the null prototype');
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), saved, 'and is written straight back');
	assert.strictEqual(asideFiles().length, 1, 'the empty file is still moved aside');
	assert.strictEqual(fs.readFileSync(BAK, 'utf8'), saved, 'the backup is left as it was');
	assert.match(lines.error[0][0], /^Audiobook bookmark file unusable .* restoring from the hourly backup\./);
	assert.match(lines.warn[0][0], /^Restored Audiobook bookmarks from the hourly backup /);
	assert.strictEqual(store.healthy(), true);
});

test('without durable a zero-length file starts empty even when a backup exists', (t) => {
	quiet(t);
	fs.writeFileSync(BAK, fileOf({ 'u1::w': { absoluteMs: 1 } }));
	fs.writeFileSync(FILE, '');
	const store = make();

	assert.deepStrictEqual({ ...store.load() }, {});
	assert.strictEqual(asideFiles().length, 1);
});

test('a damaged backup does not stop an empty start', (t) => {
	const lines = quiet(t);
	fs.writeFileSync(BAK, '{"bookmarks": ');
	fs.writeFileSync(FILE, '');
	const store = make({ durable: true, now: clock().now });

	assert.deepStrictEqual({ ...store.load() }, {});
	assert.strictEqual(asideFiles().length, 1);
	assert.match(lines.error[0][0], /starting fresh\./);
	assert.strictEqual(lines.warn.length, 0);
	assert.strictEqual(store.persist(), true, 'and the store stays writable');
});

test('a backup in the wrong shape is not restored', (t) => {
	quiet(t);
	fs.writeFileSync(BAK, JSON.stringify({ bookmarks: ['not', 'an', 'object'] }));
	fs.writeFileSync(FILE, '');
	const store = make({ durable: true, now: clock().now });

	assert.deepStrictEqual({ ...store.load() }, {});
});

test('the backup is never refreshed from a file load would refuse', (t) => {
	quiet(t);
	const good = fileOf({ 'u1::w': { absoluteMs: 1 } });
	fs.writeFileSync(BAK, good);
	fs.writeFileSync(FILE, good);
	const store = make({ durable: true, now: clock().now });
	store.load();
	fs.writeFileSync(FILE, '');

	assert.strictEqual(store.persist(), true);
	assert.strictEqual(fs.readFileSync(BAK, 'utf8'), good);
});

test('a restored store whose damaged file cannot be moved aside still refuses to overwrite it', (t) => {
	quiet(t);
	fs.writeFileSync(BAK, fileOf({ 'u1::w': { absoluteMs: 1 } }));
	const PRECIOUS = '{"bookmarks": {"u9::w": {"absoluteMs"';
	fs.writeFileSync(FILE, PRECIOUS);
	const realRename = fs.renameSync;
	t.mock.method(fs, 'renameSync', function (from, to) {
		if (String(to).includes('.corrupt-')) {
			throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
		}
		return realRename.apply(fs, arguments);
	});
	const store = make({ durable: true, now: clock().now });

	assert.deepStrictEqual({ ...store.load() }, { 'u1::w': { absoluteMs: 1 } }, 'memory still gets the backup');
	assert.strictEqual(store.persist(), false);
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), PRECIOUS);
	assert.strictEqual(store.healthy(), false);
});

test('a durable write that fails reports it and keeps memory', (t) => {
	quiet(t);
	const store = make({ durable: true, now: clock().now });
	store.load()['u1::w'] = { absoluteMs: 9 };
	fs.mkdirSync(`${FILE}.tmp`, { recursive: true });

	assert.strictEqual(store.persist(), false);
	assert.strictEqual(store.healthy(), false);
	assert.deepStrictEqual({ ...store.load() }, { 'u1::w': { absoluteMs: 9 } });
});

test('a backup that cannot be written does not stop the main write', (t) => {
	const lines = quiet(t);
	fs.writeFileSync(FILE, fileOf({ 'u1::w': { absoluteMs: 1 } }));
	fs.mkdirSync(`${BAK}.tmp`, { recursive: true });
	const store = make({ durable: true, now: clock().now });
	store.load()['u1::w'] = { absoluteMs: 2 };

	assert.strictEqual(store.persist(), true);
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), fileOf({ 'u1::w': { absoluteMs: 2 } }));
	assert.match(lines.warn[0][0], /^Could not refresh the Audiobook bookmark backup /);
});
