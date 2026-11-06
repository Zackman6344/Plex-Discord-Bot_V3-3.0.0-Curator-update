// helpers/pdfTools.js: where the read-along pictures' PDF tools are, and running one of them.
//
// The bugs this pins: Git for Windows puts Xpdf 4.00's pdftotext on PATH, which has no
// -bbox-layout, and taking it would fail every analysis; a portable Calibre named by
// calibreConvertPath keeps its tools in app\bin, not beside ebook-convert; a \\host\share PATH
// entry that Windows opens with the bot account's NTLM hash; a -v probe blocking the bot's thread
// on every locate; one -v that timed out or crashed printing nothing (Defender scanning a fresh
// install) kept as a refusal, so pictures stay 'tools-missing' until the bot process exits, since
// neither !restart nor a Calibre reinstall gives the file a new id; a path with spaces, quotes, &
// or % split by a shell; a hung or spewing tool
// holding the job forever, or a hung one outliving its kill with what it started; a tool that
// exits before reading its stdin taking the process down with an unhandled EPIPE.
//
// Harness: a fake fs (statSync answers from a list and records every path it is asked) with a fake
// probe or a counting spawnSync for finding the tools; test/helpers/fakePdfTools.js run under this
// Node in place of poppler and ffmpeg for runTool, in folders whose names need quoting. No real
// poppler or ffmpeg runs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const cp = require('node:child_process');

const pdfTools = require('../helpers/pdfTools.js');
const { FAKE, POPPLER_VERSION, writeFakePdf, fakeTools, textPage, artPage, parsePpms } = require('./helpers/fakePdfTools.js');

const ROOT = pathMod.join(os.tmpdir(), `plexbot-test-pdf-tools-${process.pid}`);
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;
const FFMPEG = 'C:\\bot\\node_modules\\ffmpeg-static\\ffmpeg.exe';
const CALIBRE_BANNER = 'pdftotext version 25.11.0\r\nCopyright 2005-2025 The Poppler Developers - http://poppler.freedesktop.org\r\nCopyright 1996-2011, 2022 Glyph & Cog, LLC\r\n';
const GIT_BANNER = 'pdftotext version 4.00\r\nCopyright 1996-2017 Glyph & Cog, LLC\r\n';
const FFMPEG_ARGS = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'ppm_pipe', '-i', 'pipe:0'];
const FFMPEG_OUT = ['-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];

let count = 0;
function tmpDir() {
	const dir = pathMod.join(ROOT, `run ${++count} & 'odd' %PATH% ^y ünï`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fakeFs(files, stat = {}) {
	const asked = [];
	return {
		asked,
		statSync(p) {
			asked.push(p);
			if (files.includes(p)) return { isFile: () => true, size: 100, mtimeMs: 1, ...stat };
			throw Object.assign(new Error('nope'), { code: 'ENOENT' });
		}
	};
}

// Poppler everywhere but in Git's folder, as on the owner's PC.
function probeLog() {
	const asked = [];
	const probe = (file) => {
		asked.push(file);
		return /\\git\\/i.test(file) ? { ok: false, reason: 'not-poppler' } : { ok: true, version: POPPLER_VERSION };
	};
	return { asked, probe };
}

function toolsIn(dir, sep = '\\') {
	const exe = sep === '\\' ? '.exe' : '';
	return [`${dir}${sep}pdftotext${exe}`, `${dir}${sep}pdftoppm${exe}`];
}

function recordingOs() {
	const calls = [];
	return { calls, constants: os.constants, setPriority: (pid, prio) => calls.push([pid, prio]) };
}

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

function sofSize(jpeg) {
	const i = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
	return i < 0 ? null : { width: jpeg.readUInt16BE(i + 7), height: jpeg.readUInt16BE(i + 5) };
}

function book(dir, spec, name = 'book.pdf') {
	return writeFakePdf(pathMod.join(dir, name), spec);
}

// --- finding the tools -----------------------------------------------------------------------------

test('the tools are found in app\\bin beside a configured portable Calibre, else in the installed one', () => {
	const env = { ProgramFiles: 'C:\\Program Files', PATH: '' };
	const files = [
		'D:\\Calibre Portable\\Calibre\\ebook-convert.exe',
		...toolsIn('D:\\Calibre Portable\\Calibre\\app\\bin'),
		...toolsIn('C:\\Program Files\\Calibre2\\app\\bin'),
		FFMPEG
	];
	const { probe } = probeLog();
	const portable = pdfTools.locate({ calibreConvertPath: 'D:\\Calibre Portable\\Calibre\\ebook-convert.exe' }, { fs: fakeFs(files), env, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.deepStrictEqual(portable, {
		ok: true,
		dir: 'D:\\Calibre Portable\\Calibre\\app\\bin',
		pdftotext: 'D:\\Calibre Portable\\Calibre\\app\\bin\\pdftotext.exe',
		pdftoppm: 'D:\\Calibre Portable\\Calibre\\app\\bin\\pdftoppm.exe',
		ffmpeg: FFMPEG,
		poppler: POPPLER_VERSION
	});
	const installed = pdfTools.locate({}, { fs: fakeFs(files), env, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.strictEqual(installed.dir, 'C:\\Program Files\\Calibre2\\app\\bin');
	const legacy = pdfTools.locate({}, { fs: fakeFs([...toolsIn('C:\\Program Files (x86)\\Calibre\\app\\bin'), FFMPEG]), env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.strictEqual(legacy.dir, 'C:\\Program Files (x86)\\Calibre\\app\\bin');
});

test('Git for Windows\' Xpdf pdftotext is refused wherever it is, and Calibre\'s tools win over PATH', () => {
	const git = 'C:\\Program Files\\Git\\mingw64\\bin';
	const other = 'E:\\poppler\\bin';
	const { asked, probe } = probeLog();
	const both = [...toolsIn(git), ...toolsIn(other), ...toolsIn('C:\\Program Files\\Calibre2\\app\\bin'), FFMPEG];
	const bothFs = fakeFs(both);
	const withCalibre = pdfTools.locate({}, { fs: bothFs, env: { ProgramFiles: 'C:\\Program Files', PATH: `${git};${other}` }, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.strictEqual(withCalibre.dir, 'C:\\Program Files\\Calibre2\\app\\bin');
	assert.ok(!asked.some((f) => f.startsWith(git)), 'PATH is not even probed once Calibre\'s own tools answer');
	assert.ok(!bothFs.asked.some((f) => /pdfto(text|ppm)\.exe$/.test(f) && (f.startsWith(git) || f.startsWith(other))), 'nor its tools looked at');

	const onPath = pdfTools.locate({}, { fs: fakeFs([...toolsIn(git), ...toolsIn(other), FFMPEG]), env: { PATH: `${git};${other}` }, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.strictEqual(onPath.dir, other, 'a Poppler folder later on PATH is taken over Git\'s');
	assert.deepStrictEqual(
		pdfTools.locate({}, { fs: fakeFs([...toolsIn(git), FFMPEG]), env: { PATH: git }, platform: 'win32', probe, ffmpeg: FFMPEG }),
		{ ok: false, code: 'tools-missing', reason: 'not-poppler' }
	);
});

test('a PATH entry on a share or a relative one is never touched, nor a share in calibreConvertPath', () => {
	const files = [...toolsIn('\\\\host\\tools'), ...toolsIn('bin'), FFMPEG];
	const f = fakeFs(files);
	const { asked, probe } = probeLog();
	const r = pdfTools.locate({ calibreConvertPath: '\\\\host\\share\\ebook-convert.exe' }, { fs: f, env: { PATH: '\\\\host\\tools;//host/share/bin;bin;"C:\\Tools"' }, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.deepStrictEqual(r, { ok: false, code: 'tools-missing', reason: 'not-found' });
	assert.ok(!f.asked.some((p) => /^(\\\\|\/\/)/.test(p)), `asked about a share: ${f.asked.join(', ')}`);
	assert.ok(!f.asked.some((p) => p.startsWith('bin')), 'a relative PATH entry is skipped');
	assert.ok(f.asked.includes('C:\\Tools\\pdftotext.exe'), 'a quoted entry is read without its quotes');
	assert.deepStrictEqual(asked, []);
});

test('missing tools say why, and a missing ffmpeg stops before any probe', () => {
	const { asked, probe } = probeLog();
	const env = { ProgramFiles: 'C:\\Program Files', PATH: '' };
	const tools = toolsIn('C:\\Program Files\\Calibre2\\app\\bin');
	assert.deepStrictEqual(pdfTools.locate({}, { fs: fakeFs(tools), env, platform: 'win32', probe, ffmpeg: FFMPEG }), { ok: false, code: 'tools-missing', reason: 'no-ffmpeg' });
	assert.deepStrictEqual(pdfTools.locate({}, { fs: fakeFs(tools), env, platform: 'win32', probe, ffmpeg: null }), { ok: false, code: 'tools-missing', reason: 'no-ffmpeg' });
	assert.deepStrictEqual(asked, []);
	assert.deepStrictEqual(pdfTools.locate({}, { fs: fakeFs([FFMPEG]), env, platform: 'win32', probe, ffmpeg: FFMPEG }), { ok: false, code: 'tools-missing', reason: 'not-found' });
	const half = pdfTools.locate({}, { fs: fakeFs([tools[0], FFMPEG]), env, platform: 'win32', probe, ffmpeg: FFMPEG });
	assert.strictEqual(half.reason, 'not-found', 'a folder with pdftotext alone does not count');
	assert.deepStrictEqual(asked, [], 'nothing is probed without both tools in one folder');
});

test('Linux and macOS: Calibre\'s bin beside its ebook-convert, then the install folder, then PATH', () => {
	const { probe } = probeLog();
	const linux = (files, PATH) => pdfTools.locate({}, { fs: fakeFs([...files, '/ff']), env: { PATH }, platform: 'linux', probe, ffmpeg: '/ff' });
	assert.strictEqual(linux(['/home/z/calibre/ebook-convert', ...toolsIn('/home/z/calibre/bin', '/'), ...toolsIn('/usr/bin', '/')], '/usr/bin:/home/z/calibre').dir, '/home/z/calibre/bin');
	assert.strictEqual(linux([...toolsIn('/opt/calibre/bin', '/'), ...toolsIn('/usr/bin', '/')], '/usr/bin').dir, '/opt/calibre/bin');
	const plain = linux(toolsIn('/usr/bin', '/'), '/usr/local/bin:/usr/bin');
	assert.deepStrictEqual([plain.dir, plain.pdftotext, plain.pdftoppm], ['/usr/bin', '/usr/bin/pdftotext', '/usr/bin/pdftoppm']);
	const mac = pdfTools.locate({}, { fs: fakeFs([...toolsIn('/Applications/calibre.app/Contents/MacOS', '/'), '/ff']), env: { PATH: '/usr/bin' }, platform: 'darwin', probe, ffmpeg: '/ff' });
	assert.strictEqual(mac.dir, '/Applications/calibre.app/Contents/MacOS');
});

test('a tool\'s -v answer is kept per file, so the bot\'s thread asks each tool once', (t) => {
	const spawns = [];
	const restore = pdfTools._setDeps({
		spawnSync: (file, args) => {
			spawns.push([file, args]);
			return { status: /\\git\\/i.test(file) ? 99 : 0, stdout: '', stderr: /\\git\\/i.test(file) ? GIT_BANNER : CALIBRE_BANNER };
		}
	});
	t.after(restore);
	const calibre = 'C:\\Program Files\\Calibre2\\app\\bin';
	const git = 'C:\\Program Files\\Git\\mingw64\\bin';
	const stat = { mtimeMs: 1 };
	const files = [...toolsIn(git), ...toolsIn(calibre), FFMPEG];
	const fsNow = { statSync: (p) => fakeFs(files, stat).statSync(p) };
	const opts = { fs: fsNow, env: { PATH: `${git};${calibre}` }, platform: 'win32', ffmpeg: FFMPEG };
	assert.strictEqual(pdfTools.locate({}, opts).dir, calibre);
	assert.deepStrictEqual(spawns, [[`${git}\\pdftotext.exe`, ['-v']], [`${calibre}\\pdftotext.exe`, ['-v']], [`${calibre}\\pdftoppm.exe`, ['-v']]]);
	assert.strictEqual(pdfTools.locate({}, opts).dir, calibre);
	assert.strictEqual(spawns.length, 3, 'the answers and the refusal are kept');
	stat.mtimeMs = 2;
	pdfTools.locate({}, opts);
	assert.strictEqual(spawns.length, 6, 'a file of another size or mtime at that path is asked again');
});

test('warm() asks the tools off the calling thread, and the locate after it spawns nothing', async (t) => {
	let syncSpawns = 0;
	const asked = [];
	const restore = pdfTools._setDeps({
		spawnSync: () => {
			syncSpawns++;
			return { status: 0, stdout: '', stderr: CALIBRE_BANNER };
		},
		execFile: (file, args, opts, cb) => {
			asked.push(file);
			setImmediate(() => cb(null, '', CALIBRE_BANNER));
		}
	});
	t.after(restore);
	const calibre = 'C:\\Program Files\\Calibre2\\app\\bin';
	const seams = { fs: fakeFs([...toolsIn(calibre), FFMPEG]), env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', ffmpeg: FFMPEG };
	let t0 = 0;
	const loc = pdfTools.createLocator({ now: () => t0, locate: (cfg) => pdfTools.locate(cfg, seams), warmProbes: (cfg) => pdfTools.warmProbes(cfg, seams) });
	const warmed = await loc.warm({});
	assert.strictEqual(warmed.dir, calibre);
	assert.deepStrictEqual(asked, toolsIn(calibre));
	assert.strictEqual(syncSpawns, 0);
	assert.strictEqual(loc.locate({}), warmed, 'the warm answer is the remembered one');
	t0 = pdfTools.LOCATE_TTL_MS + 1;
	assert.strictEqual(loc.locate({}).dir, calibre);
	assert.strictEqual(syncSpawns, 0, 'a minute later locate still finds every -v answer kept');
});

// How execFile reports a -v that gave no answer on Windows (measured with real children): its own
// timeout's kill, and a tool that could not load its DLLs (STATUS_DLL_NOT_FOUND) printing nothing.
const TIMED_OUT = () => Object.assign(new Error('Command failed: pdftotext.exe -v'), { code: null, killed: true, signal: 'SIGTERM' });
const NO_DLL = () => Object.assign(new Error('Command failed: pdftotext.exe -v'), { code: 3221225781, killed: false, signal: null });

// A locator driven as bookPictures drives it, through warm(), on a clock the test moves.
function warmLocator(seams, clock) {
	return pdfTools.createLocator({ now: () => clock.t, locate: (cfg) => pdfTools.locate(cfg, seams), warmProbes: (cfg) => pdfTools.warmProbes(cfg, seams) });
}

test('a -v that timed out or printed nothing is asked again by warm() a minute later, never on the bot\'s thread', async () => {
	const calibre = 'C:\\Program Files\\Calibre2\\app\\bin';
	for (const failure of [TIMED_OUT, NO_DLL]) {
		const clock = { t: 0 };
		let syncSpawns = 0;
		const asked = [];
		const restore = pdfTools._setDeps({
			now: () => clock.t,
			spawnSync: () => {
				syncSpawns++;
				return { status: 0, stdout: '', stderr: CALIBRE_BANNER };
			},
			execFile: (file, args, opts, cb) => {
				asked.push([file, opts.timeout]);
				const first = asked.length === 1;
				setImmediate(() => (first ? cb(failure(), '', '') : cb(null, '', CALIBRE_BANNER)));
			}
		});
		try {
			const seams = { fs: fakeFs([...toolsIn(calibre), FFMPEG]), env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', ffmpeg: FFMPEG };
			const loc = warmLocator(seams, clock);
			assert.deepStrictEqual(await loc.warm({}), { ok: false, code: 'tools-missing', reason: 'no-answer' }, 'not called not-poppler');
			assert.deepStrictEqual(asked, [[`${calibre}\\pdftotext.exe`, 10000]], 'asked with the 10 s the tools were measured against');
			clock.t = pdfTools.LOCATE_TTL_MS - 1;
			await pdfTools.warmProbes({}, seams);
			assert.strictEqual(asked.length, 1, 'not asked again within the minute');
			clock.t = pdfTools.LOCATE_TTL_MS;
			const warmed = await loc.warm({});
			assert.strictEqual(warmed.ok, true, JSON.stringify(warmed));
			assert.strictEqual(warmed.dir, calibre);
			assert.deepStrictEqual(asked.map(([f]) => f), [`${calibre}\\pdftotext.exe`, `${calibre}\\pdftotext.exe`, `${calibre}\\pdftoppm.exe`]);
			assert.strictEqual(syncSpawns, 0);
		} finally {
			restore();
		}
	}
});

test('Git\'s Xpdf refusal is kept for good: a later warm() does not ask it again', async () => {
	const git = 'C:\\Program Files\\Git\\mingw64\\bin';
	const clock = { t: 0 };
	let syncSpawns = 0;
	const asked = [];
	const restore = pdfTools._setDeps({
		now: () => clock.t,
		spawnSync: () => {
			syncSpawns++;
			return { status: 99, stdout: '', stderr: GIT_BANNER };
		},
		execFile: (file, args, opts, cb) => {
			asked.push(file);
			setImmediate(() => cb(Object.assign(new Error('Command failed: pdftotext.exe -v'), { code: 99, killed: false, signal: null }), '', GIT_BANNER));
		}
	});
	try {
		const loc = warmLocator({ fs: fakeFs([...toolsIn(git), FFMPEG]), env: { PATH: git }, platform: 'win32', ffmpeg: FFMPEG }, clock);
		assert.deepStrictEqual(await loc.warm({}), { ok: false, code: 'tools-missing', reason: 'not-poppler' });
		clock.t = 3 * pdfTools.LOCATE_TTL_MS;
		assert.deepStrictEqual(await loc.warm({}), { ok: false, code: 'tools-missing', reason: 'not-poppler' });
		assert.deepStrictEqual(asked, [`${git}\\pdftotext.exe`]);
		assert.strictEqual(syncSpawns, 0);
	} finally {
		restore();
	}
});

test('on the bot\'s thread a tool is asked once even when it gave no answer, and locate names the first refusal', () => {
	const calibre = 'C:\\Program Files\\Calibre2\\app\\bin';
	const git = 'C:\\Program Files\\Git\\mingw64\\bin';
	const clock = { t: 0 };
	const spawns = [];
	const restore = pdfTools._setDeps({
		now: () => clock.t,
		spawnSync: (file, args, opts) => {
			spawns.push([file, opts.timeout]);
			return { error: Object.assign(new Error('spawnSync pdftotext.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
		}
	});
	try {
		const opts = { fs: fakeFs([...toolsIn(calibre), FFMPEG]), env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', ffmpeg: FFMPEG };
		assert.deepStrictEqual(pdfTools.locate({}, opts), { ok: false, code: 'tools-missing', reason: 'no-answer' });
		clock.t = 5 * pdfTools.LOCATE_TTL_MS;
		assert.deepStrictEqual(pdfTools.locate({}, opts), { ok: false, code: 'tools-missing', reason: 'no-answer' });
		assert.deepStrictEqual(spawns, [[`${calibre}\\pdftotext.exe`, 10000]], 'a sync -v blocks the voice timer, so it never runs twice');
	} finally {
		restore();
	}
	const probe = (file) => (file.startsWith(git) ? { ok: false, reason: 'not-poppler' } : { ok: false, reason: 'no-answer' });
	const both = { fs: fakeFs([...toolsIn(calibre), ...toolsIn(git), FFMPEG]), env: { ProgramFiles: 'C:\\Program Files', PATH: git }, platform: 'win32', probe, ffmpeg: FFMPEG };
	assert.strictEqual(pdfTools.locate({}, both).reason, 'no-answer', 'Calibre\'s own tools not answering is the news, not Git\'s Xpdf further down PATH');
});

test('the answer is remembered for a minute, per setting', () => {
	let calls = 0;
	let t = 0;
	const loc = pdfTools.createLocator({ now: () => t, locate: () => { calls++; return { ok: true, dir: 'x' }; } });
	loc.locate({});
	loc.locate({ calibreConvertPath: '' });
	assert.strictEqual(calls, 1);
	loc.locate({ calibreConvertPath: 'E:\\Calibre\\ebook-convert.exe' });
	assert.strictEqual(calls, 2);
	t = pdfTools.LOCATE_TTL_MS + 1;
	loc.locate({});
	assert.strictEqual(calls, 3);
	const broken = pdfTools.createLocator({ locate: () => { throw new Error('boom'); } });
	assert.deepStrictEqual(broken.locate({}), { ok: false, code: 'tools-missing', reason: 'error' });
	assert.strictEqual(typeof pdfTools.instance().locate, 'function');
	assert.strictEqual(pdfTools.instance(), pdfTools.instance());
});

test('only a -v banner naming Poppler passes: Calibre\'s 25.11 does, Git\'s Xpdf 4.00 does not', async () => {
	assert.strictEqual(pdfTools.popplerVersion(CALIBRE_BANNER), '25.11.0');
	assert.strictEqual(pdfTools.popplerVersion(GIT_BANNER), null);
	assert.strictEqual(pdfTools.popplerVersion(''), null);
	assert.strictEqual(pdfTools.popplerVersion('Poppler, no version'), null);

	// Real processes: the fake answers -v as each tool does (banner on stderr, Xpdf exiting 99).
	const viaFake = (tool) => (file, args, opts) => cp.spawnSync(process.execPath, [FAKE, tool, ...args], opts);
	assert.deepStrictEqual(pdfTools.probeTool('pdftotext.exe', { spawnSync: viaFake('pdftotext') }), { ok: true, version: POPPLER_VERSION });
	assert.deepStrictEqual(pdfTools.probeTool('pdftotext.exe', { spawnSync: viaFake('xpdf') }), { ok: false, reason: 'not-poppler' });
	assert.deepStrictEqual(pdfTools.probeTool(pathMod.join(tmpDir(), 'no-such-pdftotext.exe')), { ok: false, reason: 'no-answer' });
	const viaFakeAsync = (tool) => (file, args, opts, cb) => cp.execFile(process.execPath, [FAKE, tool, ...args], opts, cb);
	assert.deepStrictEqual(await pdfTools.probeToolAsync('pdftoppm.exe', { execFile: viaFakeAsync('pdftoppm') }), { ok: true, version: POPPLER_VERSION });
	assert.deepStrictEqual(await pdfTools.probeToolAsync('pdftotext.exe', { execFile: viaFakeAsync('xpdf') }), { ok: false, reason: 'not-poppler' });
	assert.deepStrictEqual(await pdfTools.probeToolAsync(pathMod.join(tmpDir(), 'no-such-pdftoppm.exe')), { ok: false, reason: 'no-answer' });

	// Printing nothing is no answer, not a refusal: a real exit with STATUS_DLL_NOT_FOUND, as while
	// an install replaces poppler's DLLs.
	const DLL_EXIT = ['-e', 'process.exit(-1073741515)'];
	const codes = [];
	const noDll = (file, args, opts, cb) => cp.execFile(process.execPath, DLL_EXIT, opts, (err, stdout, stderr) => {
		codes.push(err && err.code);
		cb(err, stdout, stderr);
	});
	assert.deepStrictEqual(await pdfTools.probeToolAsync('pdftotext.exe', { execFile: noDll }), { ok: false, reason: 'no-answer' });
	if (process.platform === 'win32') assert.deepStrictEqual(codes, [3221225781]);
	assert.deepStrictEqual(pdfTools.probeTool('pdftotext.exe', { spawnSync: (file, args, opts) => cp.spawnSync(process.execPath, DLL_EXIT, opts) }), { ok: false, reason: 'no-answer' });
	assert.deepStrictEqual(pdfTools.probeTool('pdftotext.exe', { spawnSync: () => ({ status: 0, stdout: '\r\n', stderr: ' ' }) }), { ok: false, reason: 'no-answer' });
});

// --- running one ---------------------------------------------------------------------------------

test('a call passes each argument as itself, with no shell, hidden, in its folder, at Below Normal', async (t) => {
	const dir = tmpDir();
	const argvFile = pathMod.join(dir, 'argv.jsonl');
	const pdf = book(dir, { argvFile, pages: [textPage(['won\'t', 'A&B', '<said>', 'alpha', 'bravo'])] }, 'b o\'ok & %PATH% ^.pdf');
	const out = pathMod.join(dir, 'words & more.html');
	const spawned = [];
	const fakeOs = recordingOs();
	const restore = pdfTools._setDeps({ spawn: (...a) => { const c = cp.spawn(...a); spawned.push({ a, c }); return c; }, os: fakeOs });
	t.after(restore);
	const args = ['-enc', 'UTF-8', '-bbox-layout', pdf, out];
	const r = await pdfTools.runTool(fakeTools().pdftotext, args, { cwd: dir });
	assert.deepStrictEqual([r.ok, r.code, r.exit], [true, 'ok', 0]);
	assert.ok(Buffer.isBuffer(r.stdout) && r.stdout.length === 0);
	const call = JSON.parse(fs.readFileSync(argvFile, 'utf8').trim());
	assert.deepStrictEqual(call.argv, args);
	assert.strictEqual(call.cwd.toLowerCase(), dir.toLowerCase());
	const opts = spawned[0].a[2];
	assert.deepStrictEqual([opts.shell, opts.windowsHide, opts.cwd, opts.stdio], [false, true, dir, ['ignore', 'pipe', 'ignore']]);
	assert.deepStrictEqual(spawned[0].a[1], [FAKE, 'pdftotext', ...args]);
	assert.deepStrictEqual(fakeOs.calls, [[spawned[0].c.pid, BELOW_NORMAL]]);
	const xhtml = fs.readFileSync(out, 'utf8');
	assert.strictEqual((xhtml.match(/<page /g) || []).length, 1);
	assert.match(xhtml, /<flow>\n\s+<block [^>]+>\n\s+<line [^>]+>\n\s+<word xMin="[\d.]+" yMin="[\d.]+" xMax="[\d.]+" yMax="[\d.]+">won&apos;t<\/word>/);
	assert.match(xhtml, />A&amp;B<\/word>/);
	assert.match(xhtml, />&lt;said&gt;<\/word>/);
});

test('a rendered page comes back whole on stdout, and pictures go in on stdin and come back as JPEGs', async () => {
	const dir = tmpDir();
	const pdf = book(dir, { pages: [textPage(['alpha', 'bravo']), artPage()] });
	const tools = fakeTools();
	const page = await pdfTools.runTool(tools.pdftoppm, ['-f', '2', '-l', '2', '-singlefile', '-scale-to-x', '-1', '-scale-to-y', '1200', pdf], { cwd: dir });
	assert.strictEqual(page.ok, true);
	const frames = parsePpms(page.stdout);
	assert.deepStrictEqual(frames.map((f) => [f.width, f.height]), [[978, 1200]], 'the 562x690 pt page at 1200 tall, as the real pdftoppm makes it');
	assert.strictEqual(page.stdout.length, 16 + 978 * 1200 * 3);

	const spread = await pdfTools.runTool(tools.ffmpeg, [...FFMPEG_ARGS, '-vf', 'tile=2x1', ...FFMPEG_OUT], { input: [page.stdout, page.stdout] });
	assert.strictEqual(spread.ok, true);
	assert.deepStrictEqual([spread.stdout[0], spread.stdout[1], spread.stdout[spread.stdout.length - 2], spread.stdout[spread.stdout.length - 1]], [0xff, 0xd8, 0xff, 0xd9]);
	assert.deepStrictEqual(sofSize(spread.stdout), { width: 1956, height: 1200 });
	const crop = await pdfTools.runTool(tools.ffmpeg, [...FFMPEG_ARGS, '-vf', 'crop=400:300:10:20', ...FFMPEG_OUT], { input: page.stdout });
	assert.deepStrictEqual(sofSize(crop.stdout), { width: 400, height: 300 });
	const half = await pdfTools.runTool(tools.ffmpeg, [...FFMPEG_ARGS, '-vf', 'crop=400:300:10:20,scale=iw/2:-2', ...FFMPEG_OUT], { input: page.stdout });
	assert.deepStrictEqual(sofSize(half.stdout), { width: 200, height: 150 });
});

test('a damaged PDF and a page past the end are exit codes with no output', async () => {
	const dir = tmpDir();
	const tools = fakeTools();
	const damaged = book(dir, { mode: 'damaged' }, 'cut.pdf');
	const out = pathMod.join(dir, 'words.html');
	assert.deepStrictEqual(await pdfTools.runTool(tools.pdftotext, ['-enc', 'UTF-8', '-bbox-layout', damaged, out], { cwd: dir }), { ok: false, code: 'exit', exit: 1, stdout: null });
	assert.strictEqual(fs.existsSync(out), false);
	// A password: the same exit 1, so the scan looks in the file for its /Encrypt entry.
	const locked = book(dir, { mode: 'encrypted', pages: [textPage(['alpha'])] }, 'locked.pdf');
	assert.deepStrictEqual(await pdfTools.runTool(tools.pdftotext, ['-enc', 'UTF-8', '-bbox-layout', locked, out], { cwd: dir }), { ok: false, code: 'exit', exit: 1, stdout: null });
	assert.strictEqual(fs.existsSync(out), false);
	assert.match(fs.readFileSync(locked, 'latin1'), /\/Encrypt\s*\d+\s+\d+\s+R/);
	const two = book(dir, { pages: [textPage(['a']), textPage(['b'])] }, 'two.pdf');
	assert.deepStrictEqual(await pdfTools.runTool(tools.pdftoppm, ['-f', '9', '-l', '9', '-singlefile', two], { cwd: dir }), { ok: false, code: 'exit', exit: 99, stdout: null });
	const noText = book(dir, { mode: 'no-text', pages: [textPage(['alpha', 'bravo', 'charlie'])] }, 'scan.pdf');
	assert.strictEqual((await pdfTools.runTool(tools.pdftotext, ['-enc', 'UTF-8', '-bbox-layout', noText, out])).ok, true);
	const xhtml = fs.readFileSync(out, 'utf8');
	assert.strictEqual((xhtml.match(/<page /g) || []).length, 1);
	assert.strictEqual((xhtml.match(/<word /g) || []).length, 0);
});

test('a tool that exits before reading its stdin answers with its exit code, not an EPIPE crash', async () => {
	const dir = tmpDir();
	const spec = writeFakePdf(pathMod.join(dir, 'ffmpeg.json'), { mode: 'damaged' });
	// More than a pipe holds, so the writes meet the closed pipe.
	const big = Buffer.alloc(8 * 1024 * 1024, 0x41);
	const r = await pdfTools.runTool(fakeTools({ ffmpegSpec: spec }).ffmpeg, [...FFMPEG_ARGS, ...FFMPEG_OUT], { input: [big, big] });
	assert.deepStrictEqual(r, { ok: false, code: 'exit', exit: 1, stdout: null });
});

test('an answer over the cap is too-big, and the tool is gone', async (t) => {
	const dir = tmpDir();
	const pdf = book(dir, { pages: [artPage()] });
	const spawned = [];
	const restore = pdfTools._setDeps({ spawn: (...a) => { const c = cp.spawn(...a); spawned.push(c); return c; } });
	t.after(restore);
	const r = await pdfTools.runTool(fakeTools().pdftoppm, ['-f', '1', '-l', '1', '-singlefile', '-scale-to-x', '-1', '-scale-to-y', '1200', pdf], { maxStdoutBytes: 64 * 1024 });
	assert.deepStrictEqual(r, { ok: false, code: 'too-big', exit: null, stdout: null });
	await until(() => !alive(spawned[0].pid), 'the tool to be gone');
});

test('a hung tool is killed at the timeout with the process it started, and only then answers', async (t) => {
	const dir = tmpDir();
	const pidFile = pathMod.join(dir, 'pids.json');
	const pdf = book(dir, { mode: 'hang-tree', hang: 'pdftotext', pidFile });
	t.after(() => {
		try {
			const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
			for (const p of [pids.self, pids.kid]) { try { process.kill(p); } catch (_) {} }
		} catch (_) { /* never started */ }
	});
	const started = Date.now();
	const r = await pdfTools.runTool(fakeTools().pdftotext, ['-bbox-layout', pdf, pathMod.join(dir, 'w.html')], { timeoutMs: 1500 });
	assert.deepStrictEqual(r, { ok: false, code: 'timeout', exit: null, stdout: null });
	assert.ok(Date.now() - started >= 1500);
	const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
	assert.strictEqual(alive(pids.self), false, 'the answer came after the tool was gone');
	if (process.platform === 'win32') await until(() => !alive(pids.kid), 'what it started to be gone too');
});

test('a tool that is not there is missing, and no input makes a call throw', async () => {
	const dir = tmpDir();
	assert.deepStrictEqual(await pdfTools.runTool(pathMod.join(dir, 'no-such-pdftoppm.exe'), ['-v']), { ok: false, code: 'missing', exit: null, stdout: null });
	assert.deepStrictEqual(await pdfTools.runTool(null, []), { ok: false, code: 'missing', exit: null, stdout: null });
	assert.deepStrictEqual(await pdfTools.runTool({ exe: '' }, []), { ok: false, code: 'missing', exit: null, stdout: null });
	const odd = await pdfTools.runTool(fakeTools().pdftotext, 'not an array', { timeoutMs: 'soon', maxStdoutBytes: -1, input: 'not a buffer' });
	assert.deepStrictEqual([odd.ok, odd.code, odd.exit], [false, 'exit', 1]);
});
