// helpers/ebookConvert.js
//
// Turns a Calibre ebook that is not an EPUB (MOBI, AZW3 and the like) into one, with Calibre's own
// ebook-convert, so the read-along's EPUB reader can use it. helpers/bookTextSource.js downloads
// the book into a temp folder in its cache and calls convert(); the Calibre library is never
// touched, and nothing here sends the result anywhere.
//
// Which formats, in order (pickFormat):
//   epub first: no conversion at all.
//   azw3 and kepub: AZW3 is KF8, HTML and CSS with the publisher's own chapter markup and TOC; a
//     KEPUB is an EPUB with Kobo's span markup. Both convert almost one to one.
//   mobi, azw, prc: the older Mobipocket format. Its TOC and chapter breaks usually survive; the
//     text always does. (Calibre stores a Kindle AZW that is really KF8 as azw, too.)
//   fb2, fbz, docx, htmlz, odt: structured text formats with headings.
//   lit, pdb: old Microsoft Reader and Palm books; text survives, chapters often don't.
// Never: PDF and AZW4 (a PDF in a Kindle wrapper), whose page layout comes out as running heads,
// page numbers and words broken across lines; comics (cbz, cbr, cb7, cbc), which are pictures;
// KFX, which ebook-convert reads only with a third-party plugin; djvu, which is scanned pages.
// TXT and RTF are left out too: with no headings the read-along could only place text by pace.
//
// How it runs: one conversion at a time for the whole bot, at Below Normal priority, spawned with
// an argument array and no shell (titles never reach the command line: the paths are the cache's
// own names). ebook-convert starts two helpers, conhost.exe and one calibre-parallel.exe worker.
// Calibre creates its workers with an explicit Normal priority class, so they do not inherit Below
// Normal; measured on a 2.7 MB AZW3 (2026-10-31) the worker used 0.2 s of CPU against 4.6 s for
// ebook-convert itself, so lowering it would need a process poller costing more than it saves. A
// timeout or shutdown kills the whole tree (taskkill /T), so no worker outlives its conversion.
//
// The timeout is 5 minutes. On this PC a 2.7 MB AZW3 converted in 6.0 s and a 0.9 MB MOBI in
// 3.0 s, at Below Normal; 5 minutes leaves room for a 100 MB book full of images on a CPU busy
// with a game or a transcode, and still ends well inside the 15 minutes a deferred Discord click
// may take to answer.

const fs = require('fs');
const path = require('path');

const CONVERTIBLE = ['azw3', 'kepub', 'mobi', 'azw', 'prc', 'fb2', 'fbz', 'docx', 'htmlz', 'odt', 'lit', 'pdb'];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const LOCATE_TTL_MS = 60 * 1000;
const OUTPUT_TAIL = 16 * 1024;
const EXE_NAME = /^ebook-convert(\.exe)?$/i;
const DRM = /DRMError|locked (?:by|with) DRM|DRM[- ]protected|has DRM|is DRMed/i;

/**
 * The format the read-along reads a Calibre record from: 'epub', a format to convert, or null.
 * @param {string[]} formats Calibre's format names, any case
 */
function pickFormat(formats) {
	const have = new Set((Array.isArray(formats) ? formats : []).map((f) => String(f).toLowerCase()));
	if (have.has('epub')) return 'epub';
	return CONVERTIBLE.find((f) => have.has(f)) || null;
}

/** Why a record has no readable format, for a message: 'image'|'layout'|'kfx'|'none'. */
function unreadableKind(formats) {
	const have = (Array.isArray(formats) ? formats : []).map((f) => String(f).toLowerCase());
	if (!have.length) return 'none';
	if (have.some((f) => f === 'kfx' || f === 'kfx-zip')) return 'kfx';
	if (have.some((f) => f === 'pdf' || f === 'azw4' || f === 'djvu' || f === 'djv')) return 'layout';
	if (have.some((f) => /^cb[zr7c]$/.test(f))) return 'image';
	return 'none';
}

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

/**
 * Where ebook-convert is: the configured calibreConvertPath, else Calibre's install folder, else
 * PATH. A configured path must be a local file named ebook-convert(.exe), so the setting can only
 * ever start Calibre's converter, and a \\host\share path never makes Windows send the bot
 * account's NTLM hash to that host.
 * @returns {{ ok: true, path: string, args: string[] } | { ok: false, code: 'convert-missing', reason: string }}
 */
function findConverter(cfg, { fs: fsMod = fs, env = process.env, platform = process.platform } = {}) {
	const configured = String((cfg && cfg.calibreConvertPath) || '').trim().replace(/^"(.*)"$/, '$1');
	const p = platform === 'win32' ? path.win32 : path.posix;
	if (configured) {
		if (pathProblem(configured, platform)) return { ok: false, code: 'convert-missing', reason: 'bad-path' };
		if (!EXE_NAME.test(p.basename(configured))) return { ok: false, code: 'convert-missing', reason: 'not-converter' };
		return isFile(fsMod, configured)
			? { ok: true, path: configured, args: [] }
			: { ok: false, code: 'convert-missing', reason: 'configured-missing' };
	}
	const name = platform === 'win32' ? 'ebook-convert.exe' : 'ebook-convert';
	const places = [];
	if (platform === 'win32') {
		for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
			if (root) places.push(p.join(root, 'Calibre2', name), p.join(root, 'Calibre', name));
		}
	} else if (platform === 'darwin') {
		places.push('/Applications/calibre.app/Contents/MacOS/ebook-convert');
	}
	for (const dir of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
		const d = dir.trim().replace(/^"(.*)"$/, '$1');
		if (!d || pathProblem(d.endsWith(p.sep) ? d : `${d}${p.sep}`, platform)) continue;
		places.push(p.join(d, name));
	}
	const seen = new Set();
	for (const file of places) {
		const key = platform === 'win32' ? file.toLowerCase() : file;
		if (seen.has(key)) continue;
		seen.add(key);
		if (isFile(fsMod, file)) return { ok: true, path: file, args: [] };
	}
	return { ok: false, code: 'convert-missing', reason: 'not-found' };
}

/** Kills a child and, on Windows, every process it started. sync for shutdown, which exits next. */
function killTree(child, { sync = false, platform = process.platform, cp = require('child_process') } = {}) {
	if (!child || !child.pid) return;
	const plain = () => {
		try { child.kill('SIGKILL'); } catch (_) {}
	};
	if (platform === 'win32') {
		const args = ['/PID', String(child.pid), '/T', '/F'];
		const opts = { windowsHide: true, stdio: 'ignore' };
		// The plain kill only after taskkill: with the launcher already gone, taskkill finds no
		// tree to walk and its worker lives on.
		try {
			if (sync) {
				cp.spawnSync('taskkill', args, { ...opts, timeout: 5000 });
			} else {
				const tk = cp.spawn('taskkill', args, opts);
				tk.on('error', plain);
				tk.on('exit', plain);
				return;
			}
		} catch (_) { /* the plain kill below still ends the launcher */ }
	}
	plain();
}

/**
 * @param {object} [deps] test seams
 * @param {Function} [deps.spawn] child_process.spawn
 * @param {object} [deps.os] for setPriority
 * @param {number} [deps.timeoutMs]
 * @param {Function} [deps.locate] (cfg) => findConverter's answer
 */
function createConverter(deps = {}) {
	const spawn = deps.spawn || ((...a) => require('child_process').spawn(...a));
	const osMod = deps.os || require('os');
	const fsMod = deps.fs || fs;
	const logger = deps.logger || null;
	const timeoutDefault = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
	const kill = deps.killTree || killTree;
	const now = deps.now || Date.now;
	const locateRaw = deps.locate || ((cfg) => findConverter(cfg));
	const located = new Map();
	let queue = [];
	let running = null;
	let priorityWarned = false;

	const log = () => logger || require('./logger.js');

	/** findConverter, remembered for a minute per setting: a card render asks on every redraw. */
	function locate(cfg) {
		const key = String((cfg && cfg.calibreConvertPath) || '');
		const hit = located.get(key);
		if (hit && now() - hit.at < LOCATE_TTL_MS) return hit.result;
		let result;
		try {
			result = locateRaw(cfg);
		} catch (_) {
			result = { ok: false, code: 'convert-missing', reason: 'error' };
		}
		located.set(key, { at: now(), result });
		return result;
	}

	/**
	 * Converts input to output (an .epub path). Never throws.
	 * @param {{ exe: string, args?: string[], input: string, output: string, cwd?: string, tempDir?: string, timeoutMs?: number }} job
	 * @returns {Promise<{ ok: true, ms: number, bytes: number } | { ok: false, code: 'drm'|'convert-error'|'timeout'|'convert-missing'|'shutdown', ms?: number, exit?: number|null }>}
	 */
	function convert(job) {
		return new Promise((resolve) => {
			const entry = { job, settled: false, resolve: null };
			entry.resolve = (r) => {
				if (entry.settled) return;
				entry.settled = true;
				resolve(r);
			};
			queue.push(entry);
			pump();
		});
	}

	function pump() {
		if (running || !queue.length) return;
		start(queue.shift());
	}

	function start(entry) {
		const { job } = entry;
		const run = { entry, child: null, timer: null, graceTimer: null, released: false, started: Date.now(), tail: '' };
		running = run;
		const release = () => {
			if (run.released) return;
			run.released = true;
			clearTimeout(run.timer);
			clearTimeout(run.graceTimer);
			if (running === run) {
				running = null;
				pump();
			}
		};
		run.release = release;
		const elapsed = () => Date.now() - run.started;

		let child;
		try {
			child = spawn(job.exe, [...(job.args || []), job.input, job.output], {
				cwd: job.cwd || path.dirname(job.output),
				// Calibre deletes its own temp folder (a full HTML copy of the book) only at a normal
				// exit, so a killed conversion would leave it in %TEMP% for good. Inside the job's
				// work folder it goes when that folder does.
				env: job.tempDir ? { ...process.env, CALIBRE_TEMP_DIR: job.tempDir } : process.env,
				windowsHide: true,
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (err) {
			entry.resolve({ ok: false, code: 'convert-missing', ms: elapsed(), exit: null });
			release();
			return;
		}
		run.child = child;
		if (child.pid) {
			try {
				osMod.setPriority(child.pid, osMod.constants.priority.PRIORITY_BELOW_NORMAL);
			} catch (err) {
				if (!priorityWarned) {
					priorityWarned = true;
					log().warn(`Could not lower the ebook converter's priority (${(err && err.code) || 'error'}); it runs at Normal.`);
				}
			}
		}
		// Only the tail is kept, and only to look for Calibre's DRM error; it is never logged, since
		// it names the book and the temp paths.
		const keep = (chunk) => {
			run.tail = (run.tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
		};
		if (child.stdout) child.stdout.on('data', keep);
		if (child.stderr) child.stderr.on('data', keep);

		child.on('error', (err) => {
			const missing = err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM');
			entry.resolve({ ok: false, code: missing ? 'convert-missing' : 'convert-error', ms: elapsed(), exit: null });
			release();
		});
		child.on('close', (code, signal) => {
			if (run.timedOut) entry.resolve({ ok: false, code: 'timeout', ms: elapsed(), exit: null });
			if (!entry.settled) {
				let bytes = 0;
				try {
					bytes = fsMod.statSync(job.output).size;
				} catch (_) {
					bytes = 0;
				}
				if (code === 0 && bytes > 0) entry.resolve({ ok: true, ms: elapsed(), bytes });
				else entry.resolve({ ok: false, code: DRM.test(run.tail) ? 'drm' : 'convert-error', ms: elapsed(), exit: signal ? null : code });
			}
			release();
		});

		const timeoutMs = Number.isFinite(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : timeoutDefault;
		// The answer waits for the process to end: Windows will not delete the temp folder while
		// it is a running process's working directory.
		run.timer = setTimeout(() => {
			run.timedOut = true;
			kill(child);
			// The slot frees on 'close'; a process that ignores the kill must not hold it forever.
			run.graceTimer = setTimeout(() => {
				entry.resolve({ ok: false, code: 'timeout', ms: elapsed(), exit: null });
				release();
			}, KILL_GRACE_MS);
			if (run.graceTimer.unref) run.graceTimer.unref();
		}, timeoutMs);
		if (run.timer.unref) run.timer.unref();
	}

	/** Kills a running conversion and answers every waiting one; the converter stays usable. */
	function shutdown() {
		const pending = queue;
		queue = [];
		const run = running;
		running = null;
		if (run) {
			run.released = true;
			clearTimeout(run.timer);
			clearTimeout(run.graceTimer);
			run.entry.resolve({ ok: false, code: 'shutdown', exit: null });
			if (run.child) kill(run.child, { sync: true });
		}
		for (const entry of pending) entry.resolve({ ok: false, code: 'shutdown', exit: null });
	}

	return {
		locate,
		convert,
		shutdown,
		busy: () => !!running,
		pid: () => (running && running.child ? running.child.pid : null)
	};
}

let shared = null;

/** The bot's one converter, so two sources (an old one during !restart) still convert one at a time. */
function instance() {
	if (!shared) shared = createConverter();
	return shared;
}

module.exports = {
	createConverter,
	instance,
	findConverter,
	killTree,
	pickFormat,
	unreadableKind,
	CONVERTIBLE,
	DEFAULT_TIMEOUT_MS
};
