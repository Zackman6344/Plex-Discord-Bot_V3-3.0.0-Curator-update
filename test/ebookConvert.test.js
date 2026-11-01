// helpers/ebookConvert.js: which Calibre format the read-along reads, where ebook-convert is, and
// running it.
//
// The bug: the read-along read only EPUB, so a book the owner had in Calibre as MOBI or AZW3 was
// matched (`!book calibre` listed it) and still never showed the card's 📖. Converting brings its
// own traps: a title with spaces, quotes or & on a shell command line; a conversion at Normal
// priority stuttering the voice timer; two conversions at once on a PC that overheats; a hung
// ebook-convert holding the queue forever, or its calibre-parallel worker outliving a kill; a
// calibreConvertPath that starts any program, or a \\host\share path that sends the bot
// account's NTLM hash to that host.
//
// Harness: the real converter spawning test/helpers/fakeEbookConvert.js under this Node in place
// of ebook-convert (its input file says what to do), a recording os.setPriority, and a fake fs
// for finding the converter. No real ebook-convert runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const cp = require('node:child_process');

const { createConverter, findConverter, killTree, pickFormat, unreadableKind, CONVERTIBLE } = require('../helpers/ebookConvert.js');
const { writeEpub, chapterBook, paragraphs } = require('./helpers/epubFixture.js');

const FAKE = pathMod.join(__dirname, 'helpers', 'fakeEbookConvert.js');
const ROOT = pathMod.join(os.tmpdir(), `plexbot-test-ebook-convert-${process.pid}`);

let count = 0;
function tmpDir() {
	const dir = pathMod.join(ROOT, `run ${++count} & 'odd' %x% ^y`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (_) {
		return false;
	}
}

async function until(cond, what, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.fail(`timed out waiting for ${what}`);
}

function recordingOs() {
	const calls = [];
	return { calls, constants: os.constants, setPriority: (pid, prio) => calls.push([pid, prio]) };
}

function harness(over = {}) {
	const spawned = [];
	let liveNow = 0;
	let maxLive = 0;
	const fakeOs = recordingOs();
	const converter = createConverter({
		os: fakeOs,
		logger: { info() {}, warn() {}, error() {} },
		spawn: (...args) => {
			const child = cp.spawn(...args);
			spawned.push({ args, child });
			liveNow++;
			maxLive = Math.max(maxLive, liveNow);
			child.on('close', () => { liveNow--; });
			return child;
		},
		...over
	});
	return { converter, spawned, os: fakeOs, maxLive: () => maxLive };
}

function job(dir, spec, name = 'in put.mobi') {
	const input = pathMod.join(dir, name);
	fs.writeFileSync(input, JSON.stringify(spec));
	return { exe: process.execPath, args: [FAKE], input, output: pathMod.join(dir, 'out put.epub'), cwd: dir };
}

function syntheticEpub(dir) {
	const file = pathMod.join(dir, 'synthetic.epub');
	writeEpub(file, chapterBook({ chapters: [{ label: 'Chapter 1', paragraphs: paragraphs(3, 20) }, { label: 'Chapter 2', paragraphs: paragraphs(3, 20, 60) }] }));
	return file;
}

// --- formats ---------------------------------------------------------------------------------------

test('an EPUB is always read as it is, and of the others the closest to EPUB is converted', () => {
	assert.strictEqual(pickFormat(['MOBI', 'EPUB', 'AZW3']), 'epub');
	assert.strictEqual(pickFormat(['mobi', 'azw3']), 'azw3');
	assert.strictEqual(pickFormat(['pdb', 'mobi']), 'mobi');
	assert.strictEqual(pickFormat(['docx']), 'docx');
	assert.strictEqual(pickFormat(['original_epub', 'pdf']), null, 'Calibre\'s ORIGINAL_EPUB backup is not an EPUB to read');
	for (const f of ['pdf', 'azw4', 'cbz', 'cbr', 'cb7', 'kfx', 'djvu', 'txt', 'rtf']) assert.strictEqual(pickFormat([f]), null, f);
	assert.strictEqual(pickFormat([]), null);
	assert.strictEqual(pickFormat(undefined), null);
	assert.deepStrictEqual(CONVERTIBLE.slice(0, 3), ['azw3', 'kepub', 'mobi']);
	assert.strictEqual(unreadableKind(['pdf']), 'layout');
	assert.strictEqual(unreadableKind(['cbz']), 'image');
	assert.strictEqual(unreadableKind(['kfx']), 'kfx');
	assert.strictEqual(unreadableKind([]), 'none');
});

// --- finding ebook-convert -------------------------------------------------------------------------

function fakeFs(files) {
	const asked = [];
	return {
		asked,
		statSync(p) {
			asked.push(p);
			if (files.includes(p)) return { isFile: () => true };
			throw Object.assign(new Error('nope'), { code: 'ENOENT' });
		}
	};
}

test('ebook-convert is found in Calibre\'s install folder first, then on PATH', () => {
	const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Tools;D:\\Calibre Portable\\Calibre' };
	const inst = fakeFs(['C:\\Program Files\\Calibre2\\ebook-convert.exe', 'D:\\Calibre Portable\\Calibre\\ebook-convert.exe']);
	assert.deepStrictEqual(findConverter({}, { fs: inst, env, platform: 'win32' }), { ok: true, path: 'C:\\Program Files\\Calibre2\\ebook-convert.exe', args: [] });
	const onPath = fakeFs(['D:\\Calibre Portable\\Calibre\\ebook-convert.exe']);
	assert.strictEqual(findConverter({}, { fs: onPath, env, platform: 'win32' }).path, 'D:\\Calibre Portable\\Calibre\\ebook-convert.exe');
	assert.deepStrictEqual(findConverter({}, { fs: fakeFs([]), env, platform: 'win32' }), { ok: false, code: 'convert-missing', reason: 'not-found' });
	assert.strictEqual(findConverter({}, { fs: fakeFs(['/usr/bin/ebook-convert']), env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux' }).path, '/usr/bin/ebook-convert');
});

test('a configured path must be a local file named ebook-convert, and a share is refused before any file access', () => {
	const env = { ProgramFiles: 'C:\\Program Files', PATH: '' };
	const ok = fakeFs(['E:\\Apps\\Calibre\\ebook-convert.exe']);
	assert.strictEqual(findConverter({ calibreConvertPath: '"E:\\Apps\\Calibre\\ebook-convert.exe"' }, { fs: ok, env, platform: 'win32' }).path, 'E:\\Apps\\Calibre\\ebook-convert.exe');
	const other = fakeFs(['C:\\Windows\\System32\\cmd.exe']);
	assert.deepStrictEqual(findConverter({ calibreConvertPath: 'C:\\Windows\\System32\\cmd.exe' }, { fs: other, env, platform: 'win32' }), { ok: false, code: 'convert-missing', reason: 'not-converter' });
	assert.deepStrictEqual(other.asked, []);
	for (const unc of ['\\\\host\\share\\ebook-convert.exe', '//host/share/ebook-convert.exe', 'ebook-convert.exe']) {
		const f = fakeFs([unc]);
		assert.strictEqual(findConverter({ calibreConvertPath: unc }, { fs: f, env, platform: 'win32' }).reason, 'bad-path', unc);
		assert.deepStrictEqual(f.asked, [], unc);
	}
	assert.strictEqual(findConverter({ calibreConvertPath: 'E:\\Gone\\ebook-convert.exe' }, { fs: fakeFs([]), env, platform: 'win32' }).reason, 'configured-missing');
	const share = fakeFs([]);
	findConverter({}, { fs: share, env: { PATH: '\\\\host\\tools;C:\\Tools' }, platform: 'win32' });
	assert.ok(!share.asked.some((p) => p.startsWith('\\\\')), 'a PATH entry on a share is never touched');
});

test('the answer is remembered for a minute, per setting', () => {
	let calls = 0;
	let t = 0;
	const c = createConverter({ now: () => t, locate: () => { calls++; return { ok: true, path: 'x', args: [] }; } });
	c.locate({});
	c.locate({});
	assert.strictEqual(calls, 1);
	c.locate({ calibreConvertPath: 'E:\\ebook-convert.exe' });
	assert.strictEqual(calls, 2);
	t = 61000;
	c.locate({});
	assert.strictEqual(calls, 3);
});

// --- running it ------------------------------------------------------------------------------------

test('a conversion passes its paths as separate arguments, with no shell, at Below Normal', async () => {
	const dir = tmpDir();
	const h = harness();
	const argvFile = pathMod.join(dir, 'argv.json');
	const j = job(dir, { mode: 'ok', epub: syntheticEpub(dir), argvFile });
	const r = await h.converter.convert(j);
	assert.strictEqual(r.ok, true);
	assert.ok(r.bytes > 0 && r.bytes === fs.statSync(j.output).size);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), [j.input, j.output]);
	const [, opts] = h.spawned[0].args.slice(1);
	assert.strictEqual(opts.shell, false);
	assert.strictEqual(opts.windowsHide, true);
	assert.deepStrictEqual(h.os.calls, [[h.spawned[0].child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
});

// The bug: ebook-convert kept its working copy of the book (Calibre's plumber HTML) in the bot's
// %TEMP%, and Calibre removes it only at a normal exit, so every conversion killed by the timeout
// or a shutdown left a full copy of the book behind for good.
test('Calibre\'s temp folder is the job\'s own, and the rest of the environment is passed through', async () => {
	const dir = tmpDir();
	const h = harness();
	const tempDir = pathMod.join(dir, 'tmp');
	fs.mkdirSync(tempDir);
	const r = await h.converter.convert({ ...job(dir, { mode: 'ok', epub: syntheticEpub(dir) }), tempDir });
	assert.strictEqual(r.ok, true);
	const [, opts] = h.spawned[0].args.slice(1);
	assert.strictEqual(opts.env.CALIBRE_TEMP_DIR, tempDir);
	assert.strictEqual(opts.env.PATH ?? opts.env.Path, process.env.PATH ?? process.env.Path);
	const plain = harness();
	await plain.converter.convert(job(dir, { mode: 'ok', epub: syntheticEpub(dir) }, 'plain.mobi'));
	assert.strictEqual(plain.spawned[0].args[2].env.CALIBRE_TEMP_DIR, process.env.CALIBRE_TEMP_DIR);
});

test('Calibre\'s DRM error is its own answer; a damaged file or a missing output is a conversion error', async () => {
	const dir = tmpDir();
	const h = harness();
	assert.strictEqual((await h.converter.convert(job(dir, { mode: 'drm' }, 'a.azw3'))).code, 'drm');
	const bad = await h.converter.convert(job(dir, { mode: 'corrupt' }, 'b.mobi'));
	assert.deepStrictEqual([bad.ok, bad.code, bad.exit], [false, 'convert-error', 1]);
	assert.strictEqual((await h.converter.convert(job(dir, { mode: 'empty' }, 'c.mobi'))).code, 'convert-error');
});

test('a converter that is not there answers convert-missing', async () => {
	const dir = tmpDir();
	const h = harness();
	const r = await h.converter.convert({ ...job(dir, { mode: 'ok' }), exe: pathMod.join(dir, 'no-such-ebook-convert.exe'), args: [] });
	assert.deepStrictEqual([r.ok, r.code], [false, 'convert-missing']);
});

test('conversions run one at a time across the bot', async () => {
	const dir = tmpDir();
	const h = harness();
	const epub = syntheticEpub(dir);
	const logFile = pathMod.join(dir, 'times.log');
	const jobs = [1, 2, 3].map((i) => job(dir, { mode: 'ok', epub, logFile, delayMs: 150 }, `in ${i}.mobi`));
	const results = await Promise.all(jobs.map((j, i) => h.converter.convert({ ...j, output: pathMod.join(dir, `out ${i}.epub`) })));
	assert.deepStrictEqual(results.map((r) => r.ok), [true, true, true]);
	assert.strictEqual(h.maxLive(), 1);
	const spans = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number));
	for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], 'the next starts after the last ends');
});

test('a conversion that runs too long is killed with the processes it started, and the queue moves on', async (t) => {
	const dir = tmpDir();
	const h = harness();
	const pidFile = pathMod.join(dir, 'pids.json');
	const slow = h.converter.convert({ ...job(dir, { mode: 'hang-tree', pidFile }, 'slow.mobi'), timeoutMs: 1500 });
	const next = h.converter.convert(job(dir, { mode: 'ok', epub: syntheticEpub(dir) }, 'next.mobi'));
	await until(() => fs.existsSync(pidFile), 'the fake to start its helper');
	const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
	t.after(() => { for (const p of [pids.self, pids.kid]) { try { process.kill(p); } catch (_) {} } });
	const r = await slow;
	assert.deepStrictEqual([r.ok, r.code], [false, 'timeout']);
	assert.strictEqual((await next).ok, true);
	await until(() => !alive(pids.self), 'the converter to be gone');
	if (process.platform === 'win32') await until(() => !alive(pids.kid), 'its helper to be gone too');
});

test('shutdown kills the running conversion, answers the queued ones, and leaves the converter usable', async () => {
	const dir = tmpDir();
	const h = harness();
	const running = h.converter.convert(job(dir, { mode: 'hang' }, 'hang.mobi'));
	const queued = h.converter.convert(job(dir, { mode: 'ok', epub: syntheticEpub(dir) }, 'queued.mobi'));
	await until(() => h.converter.busy() && h.spawned.length === 1 && h.spawned[0].child.pid, 'the conversion to start');
	const pid = h.converter.pid();
	h.converter.shutdown();
	assert.deepStrictEqual([(await running).code, (await queued).code], ['shutdown', 'shutdown']);
	await until(() => !alive(pid), 'the child to be killed');
	assert.strictEqual(h.converter.busy(), false);
	assert.strictEqual(h.spawned.length, 1, 'the queued one never started');
	assert.strictEqual((await h.converter.convert(job(dir, { mode: 'ok', epub: syntheticEpub(dir) }, 'after.mobi'))).ok, true);
});

// The bug: the launcher was killed straight after taskkill started, so taskkill found no tree
// and a detached worker lived on (the timeout test above caught it).
test('on Windows a kill takes the whole tree with taskkill first, synchronously at shutdown', () => {
	const calls = [];
	let exitTaskkill = null;
	const fakeCp = {
		spawn: (cmd, args) => {
			calls.push(['spawn', cmd, args]);
			return { on(ev, fn) { if (ev === 'exit') exitTaskkill = fn; return this; } };
		},
		spawnSync: (cmd, args) => { calls.push(['spawnSync', cmd, args]); return {}; }
	};
	const child = { pid: 4242, kill: (sig) => calls.push(['kill', sig]) };
	killTree(child, { platform: 'win32', cp: fakeCp });
	assert.deepStrictEqual(calls, [['spawn', 'taskkill', ['/PID', '4242', '/T', '/F']]], 'the launcher lives until taskkill has walked its tree');
	exitTaskkill(0);
	killTree(child, { platform: 'win32', cp: fakeCp, sync: true });
	killTree(child, { platform: 'linux', cp: fakeCp });
	assert.deepStrictEqual(calls.slice(1), [
		['kill', 'SIGKILL'],
		['spawnSync', 'taskkill', ['/PID', '4242', '/T', '/F']],
		['kill', 'SIGKILL'],
		['kill', 'SIGKILL']
	]);
});
