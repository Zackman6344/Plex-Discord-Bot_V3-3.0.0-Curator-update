// helpers/pdfTools.js
//
// Finds the tools the read-along pictures need, Calibre's own poppler (pdftotext, pdftoppm) and
// ffmpeg-static, and runs one tool call. The bot's thread only locates them; the calls run in
// helpers/bookPicturesWorker.js's Below Normal child.
//
// Where: beside the ebook-convert findConverter picks (Calibre keeps them in <root>\app\bin on
// Windows, while ebook-convert.exe sits in <root>, so a calibreConvertPath naming a portable Calibre
// finds that copy's tools), then Calibre's default install folders, then PATH. PATH is last on
// purpose: Git for Windows puts Xpdf 4.00's pdftotext on PATH, and it has no -bbox-layout. So a
// folder counts only when both tools answer -v naming Poppler. In locate that probe is a
// synchronous spawn, 70-130 ms a tool, so its answer is kept per file (path, size and mtime): the
// bot's thread pays it once per tool, not on every locate, and instance().warm() pays it off the
// thread instead. A banner, Xpdf's included, is kept for the life of the process; no answer at all
// (a timeout, a failed start, nothing printed) is asked again by the next warm() a minute later.
// instance() remembers the whole answer for a minute per calibreConvertPath, as the converter does.
//
// runTool: an argument array, no shell, windowsHide, so a path with spaces, quotes, & or % reaches
// the tool as one argument. stdout is captured up to a cap; stderr is dropped, since poppler's I/O
// errors quote full paths and must never reach a log. A timeout or an oversized answer kills the
// tree (ebookConvert.killTree), and the answer waits for the process to be gone, because Windows
// will not delete a job folder a running tool still holds.

const fs = require('fs');
const path = require('path');

const TOOLS = ['pdftotext', 'pdftoppm'];
const LOCATE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_STDOUT = 32 * 1024 * 1024;
const KILL_GRACE_MS = 10 * 1000;
const MISSING = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

function defaultDeps() {
	return {
		spawn: (...args) => require('child_process').spawn(...args),
		spawnSync: (...args) => require('child_process').spawnSync(...args),
		execFile: (...args) => require('child_process').execFile(...args),
		os: require('os'),
		killTree: (...args) => require('./ebookConvert.js').killTree(...args),
		now: Date.now
	};
}

let deps = defaultDeps();
const probes = new Map();

function isFile(fsMod, file) {
	try {
		return fsMod.statSync(file).isFile();
	} catch (_) {
		return false;
	}
}

function pathProblem(raw, platform) {
	return require('./bookTextSource.js').localPathProblem(raw, platform);
}

function ffmpegStatic() {
	try {
		return require('ffmpeg-static') || null;
	} catch (_) {
		return null;
	}
}

/** The version a -v banner names when it is Poppler's, else null (Xpdf's names only Glyph & Cog). */
function popplerVersion(banner) {
	const text = String(banner || '');
	if (!/\bpoppler\b/i.test(text)) return null;
	const m = /\bversion\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text);
	return m ? m[1] : null;
}

// Nothing on either stream is no answer, not a refusal: a tool that could not load its DLLs (exit
// 0xC0000135 while an install replaces them) prints nothing and may answer the next time. Xpdf
// prints its banner, so it is still refused.
function answerOf(stdout, stderr) {
	const banner = `${stdout || ''}\n${stderr || ''}`;
	if (!banner.trim()) return { ok: false, reason: 'no-answer' };
	const version = popplerVersion(banner);
	return version ? { ok: true, version } : { ok: false, reason: 'not-poppler' };
}

/**
 * Asks a tool for its version. Both tools print the banner on stderr; Xpdf's exits 99, so only the
 * banner decides.
 * @returns {{ ok: true, version: string } | { ok: false, reason: 'not-poppler'|'no-answer' }}
 */
function probeTool(file, { spawnSync = deps.spawnSync, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	let r;
	try {
		r = spawnSync(file, ['-v'], {
			windowsHide: true,
			shell: false,
			timeout: timeoutMs,
			encoding: 'latin1',
			maxBuffer: 64 * 1024,
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (_) {
		return { ok: false, reason: 'no-answer' };
	}
	if (!r || r.error) return { ok: false, reason: 'no-answer' };
	return answerOf(r.stdout, r.stderr);
}

/** probeTool without blocking the calling thread; warm() fills the same cache with it. */
function probeToolAsync(file, { execFile = deps.execFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		try {
			execFile(file, ['-v'], { windowsHide: true, shell: false, timeout: timeoutMs, encoding: 'latin1', maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
				if (err && typeof err.code !== 'number') return resolve({ ok: false, reason: 'no-answer' });
				resolve(answerOf(stdout, stderr));
			});
		} catch (_) {
			resolve({ ok: false, reason: 'no-answer' });
		}
	});
}

function probeId(file, fsMod) {
	try {
		const st = fsMod.statSync(file);
		return `${file}\0${st.size}\0${st.mtimeMs}`;
	} catch (_) {
		return null;
	}
}

// Answers are kept as { r, at }. An answer with a banner is kept for good, Poppler's or a refusal
// such as Xpdf's, so a foreign exe is asked once, not on every locate. No answer is asked again
// once it is LOCATE_TTL_MS old, and only off the thread. A new id cannot be counted on to clear
// it: Calibre's installer keeps each poppler file's build mtime (pdftotext.exe here is ten months
// older than the ebook-convert.exe installed with it), and an update may ship the same poppler
// build.
const staleNoAnswer = (hit) => !hit.r.ok && hit.r.reason === 'no-answer' && deps.now() - hit.at >= LOCATE_TTL_MS;

// The bot's thread never asks a file twice, whatever it answered; warm() asks again first.
function cachedProbe(file, fsMod) {
	const id = probeId(file, fsMod);
	if (!id) return { ok: false, reason: 'no-answer' };
	if (!probes.has(id)) probes.set(id, { r: probeTool(file), at: deps.now() });
	return probes.get(id).r;
}

async function cachedProbeAsync(file, fsMod) {
	const id = probeId(file, fsMod);
	if (!id) return { ok: false, reason: 'no-answer' };
	const hit = probes.get(id);
	if (hit && !staleNoAnswer(hit)) return hit.r;
	const r = await probeToolAsync(file);
	// Two warms that asked at once: the answer stored first stands.
	const stored = probes.get(id);
	if (stored !== hit) return stored ? stored.r : r;
	probes.set(id, { r, at: deps.now() });
	return r;
}

function candidateDirs(cfg, { fsMod, env, platform, findConverter }) {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const dirs = [];
	let conv = null;
	try {
		conv = findConverter(cfg, { fs: fsMod, env, platform });
	} catch (_) {
		conv = null;
	}
	if (conv && conv.ok && typeof conv.path === 'string') {
		const d = p.dirname(conv.path);
		dirs.push(platform === 'win32' ? p.join(d, 'app', 'bin') : p.join(d, 'bin'), d);
	}
	if (platform === 'win32') {
		for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
			if (root) dirs.push(p.join(root, 'Calibre2', 'app', 'bin'), p.join(root, 'Calibre', 'app', 'bin'));
		}
	} else if (platform === 'darwin') {
		dirs.push('/Applications/calibre.app/Contents/MacOS');
	} else {
		dirs.push('/opt/calibre/bin');
	}
	for (const raw of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
		const d = raw.trim().replace(/^"(.*)"$/, '$1');
		if (d) dirs.push(d);
	}
	const seen = new Set();
	const out = [];
	for (const d of dirs) {
		const key = (platform === 'win32' ? d.toLowerCase() : d).replace(/[\\/]+$/, '');
		if (seen.has(key)) continue;
		seen.add(key);
		// Decided on the string alone: a stat of \\host\share would send the bot account's NTLM
		// hash to that host.
		if (pathProblem(d.endsWith(p.sep) ? d : `${d}${p.sep}`, platform)) continue;
		out.push(d);
	}
	return out;
}

function seamsOf(opts) {
	const o = opts && typeof opts === 'object' ? opts : {};
	return {
		fsMod: o.fs || fs,
		env: o.env || process.env,
		platform: o.platform || process.platform,
		findConverter: o.findConverter || ((c, x) => require('./ebookConvert.js').findConverter(c, x))
	};
}

function* folders(cfg, seams) {
	const p = seams.platform === 'win32' ? path.win32 : path.posix;
	const name = (tool) => (seams.platform === 'win32' ? `${tool}.exe` : tool);
	for (const dir of candidateDirs(cfg, seams)) {
		const files = TOOLS.map((tool) => p.join(dir, name(tool)));
		if (files.every((f) => isFile(seams.fsMod, f))) yield { dir, files };
	}
}

/**
 * Where the tools are. The first folder holding both pdftotext and pdftoppm that answer -v as
 * Poppler wins; ffmpeg is ffmpeg-static.
 * @param {object} cfg the bot config (calibreConvertPath)
 * @param {object} [opts] test seams: fs, env, platform, findConverter (ebookConvert's),
 *   probe ((file) => probeTool's answer; the per-file cache otherwise), ffmpeg (its path)
 * @returns {{ ok: true, dir: string, pdftotext: string, pdftoppm: string, ffmpeg: string, poppler: string }
 *   | { ok: false, code: 'tools-missing', reason: 'no-ffmpeg'|'not-poppler'|'no-answer'|'not-found' }}
 *   the reason of a refusal is the first refused folder's: Calibre's own tools that did not answer
 *   are not reported as Git's Xpdf further down PATH
 */
function locate(cfg, opts = {}) {
	const seams = seamsOf(opts);
	const probe = (opts && opts.probe) || ((file) => cachedProbe(file, seams.fsMod));
	const ffmpeg = opts && 'ffmpeg' in opts ? opts.ffmpeg : ffmpegStatic();
	if (!ffmpeg || !isFile(seams.fsMod, ffmpeg)) return { ok: false, code: 'tools-missing', reason: 'no-ffmpeg' };
	let refused = null;
	for (const { dir, files } of folders(cfg, seams)) {
		let version = null;
		for (const f of files) {
			let r = null;
			try {
				r = probe(f);
			} catch (_) {
				r = null;
			}
			if (!r || !r.ok) {
				refused = refused || (r && r.reason === 'no-answer' ? 'no-answer' : 'not-poppler');
				version = null;
				break;
			}
			version = version || String(r.version);
		}
		if (!version) continue;
		return { ok: true, dir, pdftotext: files[0], pdftoppm: files[1], ffmpeg, poppler: version };
	}
	return { ok: false, code: 'tools-missing', reason: refused || 'not-found' };
}

// Asks the same folders' tools for -v without blocking, so the next locate finds every answer in
// the cache and spawns nothing.
async function warmProbes(cfg, opts) {
	const seams = seamsOf(opts);
	for (const { files } of folders(cfg, seams)) {
		let ok = true;
		for (const f of files) {
			if (!(await cachedProbeAsync(f, seams.fsMod)).ok) {
				ok = false;
				break;
			}
		}
		if (ok) return;
	}
}

/**
 * locate, remembered for a minute per setting, like the converter's. warm(cfg) answers the same
 * after asking the tools for their version off the calling thread: the bot's first locate in a
 * process otherwise blocks for the two -v probes (130-270 ms measured on the owner's PC).
 */
function createLocator({ now = Date.now, locate: locateRaw = locate, warmProbes: warmRaw = warmProbes } = {}) {
	const located = new Map();
	const keyOf = (cfg) => String((cfg && cfg.calibreConvertPath) || '');
	const fresh = (cfg) => {
		let result;
		try {
			result = locateRaw(cfg);
		} catch (_) {
			result = { ok: false, code: 'tools-missing', reason: 'error' };
		}
		located.set(keyOf(cfg), { at: now(), result });
		return result;
	};
	const locateCached = (cfg) => {
		const hit = located.get(keyOf(cfg));
		if (hit && now() - hit.at < LOCATE_TTL_MS) return hit.result;
		return fresh(cfg);
	};
	const warm = async (cfg) => {
		const hit = located.get(keyOf(cfg));
		if (hit && now() - hit.at < LOCATE_TTL_MS) return hit.result;
		try {
			await warmRaw(cfg);
		} catch (_) { /* locate below probes for itself */ }
		return fresh(cfg);
	};
	return { locate: locateCached, warm };
}

let shared = null;

function instance() {
	if (!shared) shared = createLocator();
	return shared;
}

function toolOf(tool) {
	if (typeof tool === 'string' && tool) return { exe: tool, pre: [] };
	if (tool && typeof tool === 'object' && typeof tool.exe === 'string' && tool.exe) {
		return { exe: tool.exe, pre: Array.isArray(tool.args) ? tool.args.map(String) : [] };
	}
	return null;
}

function positive(v, fallback) {
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * One tool call. Never throws.
 * @param {string|{ exe: string, args?: string[] }} tool a path as locate gives it, or an exe with
 *   leading arguments (tests run node with test/helpers/fakePdfTools.js)
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, maxStdoutBytes?: number, input?: Buffer|Buffer[] }} [opts]
 *   input goes to stdin, which is closed after it; without input stdin is not opened at all
 * @returns {Promise<{ ok: boolean, code: 'ok'|'exit'|'timeout'|'missing'|'too-big'|'spawn', exit: number|null, stdout: Buffer|null }>}
 */
function runTool(tool, args, opts = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let timer = null;
		let grace = null;
		const done = (r) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			resolve(r);
		};
		const fail = (code, exit = null) => done({ ok: false, code, exit, stdout: null });
		const t = toolOf(tool);
		if (!t) return fail('missing');
		const o = opts && typeof opts === 'object' ? opts : {};
		const list = Array.isArray(args) ? args.map(String) : [];
		const withInput = o.input != null;
		const inputs = (Array.isArray(o.input) ? o.input : [o.input]).filter((b) => b instanceof Uint8Array);
		const timeoutMs = positive(o.timeoutMs, DEFAULT_TIMEOUT_MS);
		const maxBytes = positive(o.maxStdoutBytes, DEFAULT_MAX_STDOUT);
		let child;
		try {
			child = deps.spawn(t.exe, [...t.pre, ...list], {
				cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined,
				windowsHide: true,
				shell: false,
				stdio: [withInput ? 'pipe' : 'ignore', 'pipe', 'ignore']
			});
		} catch (err) {
			return fail(MISSING.has(err && err.code) ? 'missing' : 'spawn');
		}
		// The child that calls this is Below Normal already and Windows passes that on; this covers
		// a call from a Normal process, so a refusal is not worth a warning here.
		if (child.pid) {
			try {
				deps.os.setPriority(child.pid, deps.os.constants.priority.PRIORITY_BELOW_NORMAL);
			} catch (_) { /* inherits its parent's */ }
		}

		let chunks = [];
		let bytes = 0;
		let ending = null;
		const kill = (why) => {
			if (ending || settled) return;
			ending = why;
			chunks = [];
			try {
				deps.killTree(child);
			} catch (_) { /* the grace below still answers */ }
			grace = setTimeout(() => fail(why), KILL_GRACE_MS);
		};
		if (child.stdout) {
			child.stdout.on('data', (c) => {
				if (ending) return;
				bytes += c.length;
				if (bytes > maxBytes) {
					kill('too-big');
					return;
				}
				chunks.push(c);
			});
		}
		if (withInput && child.stdin) {
			// EPIPE when the tool exits before reading everything; its exit code says why.
			child.stdin.on('error', () => {});
			try {
				for (const b of inputs) child.stdin.write(b);
				child.stdin.end();
			} catch (_) { /* the same: the exit code answers */ }
		}
		child.on('error', (err) => {
			if (!child.pid) fail(MISSING.has(err && err.code) ? 'missing' : 'spawn');
		});
		child.on('close', (code) => {
			if (!child.pid) return fail('missing');
			if (ending) return fail(ending);
			if (code === 0) return done({ ok: true, code: 'ok', exit: 0, stdout: Buffer.concat(chunks) });
			fail('exit', typeof code === 'number' ? code : null);
		});
		timer = setTimeout(() => kill('timeout'), timeoutMs);
	});
}

// Test seam: swap spawn, spawnSync, execFile, os, killTree or the clock the -v answers are dated
// by, and forget those answers. Returns a function that puts them back.
function _setDeps(over) {
	const prev = deps;
	deps = { ...deps, ...over };
	probes.clear();
	return () => {
		deps = prev;
		probes.clear();
	};
}

module.exports = {
	locate,
	instance,
	createLocator,
	runTool,
	probeTool,
	probeToolAsync,
	warmProbes,
	popplerVersion,
	TOOLS,
	LOCATE_TTL_MS,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_MAX_STDOUT,
	_setDeps
};
