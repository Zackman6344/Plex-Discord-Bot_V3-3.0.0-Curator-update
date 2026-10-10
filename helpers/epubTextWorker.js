// helpers/epubTextWorker.js
//
// Two roles in one file. Required by the bot, it is a queue that parses EPUBs in a forked child
// process. Forked with --epub-text-child, it is that child: it parses one job with epubText.js,
// writes the cache files and sends back a small summary.
//
// Why a child process and not a worker_thread: Process Lasso's ProBalance demotes whichever
// PROCESS is busy. A worker thread at full CPU would make the bot's own node.exe the busy one and
// drag its 20 ms voice timer down to Below Normal with it. A child is demoted on its own, and the
// bot sets it to Below Normal itself so the voice timer wins on a contended CPU anyway.
//
// The main thread never reads, parses or holds the book text during a parse: the job carries
// paths and a small source object, and the reply carries counts.

const pathMod = require('path');
const { EXTRACTOR_VERSION, EpubError, parseEpubToCache } = require('./epubText.js');

const CHILD_FLAG = '--epub-text-child';
const DEFAULT_TIMEOUT_MS = 120000;
// A child that answered but somehow does not exit must not hold the queue forever.
const EXIT_GRACE_MS = 5000;
const EXIT_CLOSE_FALLBACK_MS = 1000;
const SAFE_BASE = /^[A-Za-z0-9_-]{1,64}$/;

function defaultDeps() {
	return {
		fork: (...args) => require('child_process').fork(...args),
		os: require('os'),
		logger: null
	};
}

let deps = defaultDeps();
let priorityWarned = false;
let queue = [];
let running = null;
let inflight = new Map();

function loggerOf() {
	return deps.logger || require('./logger.js');
}

function parseEpub(job) {
	const base = job && job.base;
	if (inflight.has(base)) return inflight.get(base);
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	const entry = { job, resolve, settled: false };
	const settle = result => {
		if (entry.settled) return;
		entry.settled = true;
		if (inflight.get(base) === promise) inflight.delete(base);
		resolve(result);
	};
	entry.settle = settle;
	if (!job || !job.input || typeof job.input.path !== 'string' || !job.outDir || !SAFE_BASE.test(String(base || ''))) {
		settle({ ok: false, code: 'bad-job', message: 'parseEpub needs input.path, outDir and a safe base' });
		return promise;
	}
	inflight.set(base, promise);
	queue.push(entry);
	pump();
	return promise;
}
parseEpub.VERSION = EXTRACTOR_VERSION;

function pump() {
	if (running || !queue.length) return;
	start(queue.shift());
}

function clearTimers(run) {
	clearTimeout(run.timer);
	clearTimeout(run.graceTimer);
	clearTimeout(run.fallbackTimer);
}

function start(entry) {
	const run = { entry, child: null, timer: null, graceTimer: null, fallbackTimer: null, released: false };
	running = run;
	const release = () => {
		if (run.released) return;
		run.released = true;
		clearTimers(run);
		if (running === run) {
			running = null;
			pump();
		}
	};
	run.release = release;

	let child;
	try {
		child = deps.fork(__filename, [CHILD_FLAG], {
			// Explicit, so a child forked under `node --test` does not inherit test-runner flags.
			execArgv: ['--max-old-space-size=768'],
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			serialization: 'json',
			windowsHide: true
		});
	} catch (err) {
		entry.settle({ ok: false, code: 'crash', message: `fork failed (${(err && err.code) || 'error'})` });
		release();
		return;
	}
	run.child = child;

	try {
		deps.os.setPriority(child.pid, deps.os.constants.priority.PRIORITY_BELOW_NORMAL);
	} catch (err) {
		if (!priorityWarned) {
			priorityWarned = true;
			loggerOf().warn(`Could not lower the ebook parser's priority (${(err && err.code) || 'error'}); it runs at Normal.`);
		}
	}

	const killThenRelease = () => {
		if (run.graceTimer) return;
		run.graceTimer = setTimeout(() => {
			try { child.kill(); } catch (_) {}
			release();
		}, EXIT_GRACE_MS);
		if (run.graceTimer.unref) run.graceTimer.unref();
	};
	// No child.disconnect() here: the child exits by itself once its answer is flushed, and a
	// parent-side disconnect stops 'close' from ever being emitted (measured on Node 24).
	child.on('message', msg => {
		clearTimeout(run.timer);
		entry.settle(resultOf(msg));
		killThenRelease();
	});
	const exited = (code, signal) => {
		entry.settle({ ok: false, code: 'crash', message: signal ? `signal ${signal}` : `exit ${code}` });
		release();
	};
	// 'close' is the real end: 'exit' can arrive before the child's last IPC message has been
	// read. 'exit' only arms a fallback in case 'close' never comes.
	child.on('close', exited);
	child.on('exit', (code, signal) => {
		if (run.released) return;
		run.fallbackTimer = setTimeout(() => exited(code, signal), EXIT_CLOSE_FALLBACK_MS);
		if (run.fallbackTimer.unref) run.fallbackTimer.unref();
	});
	child.on('error', err => {
		entry.settle({ ok: false, code: 'crash', message: `child error (${(err && err.code) || 'error'})` });
		try { child.kill(); } catch (_) {}
		release();
	});

	const timeoutMs = Number.isFinite(entry.job.timeoutMs) && entry.job.timeoutMs > 0 ? entry.job.timeoutMs : DEFAULT_TIMEOUT_MS;
	run.timer = setTimeout(() => {
		entry.settle({ ok: false, code: 'timeout', message: `no answer in ${timeoutMs} ms` });
		try { child.kill(); } catch (_) {}
		killThenRelease();
	}, timeoutMs);
	if (run.timer.unref) run.timer.unref();

	const { input, outDir, base, source } = entry.job;
	try {
		child.send({ input: { path: input.path }, outDir, base, source: source || null });
	} catch (err) {
		entry.settle({ ok: false, code: 'crash', message: `send failed (${(err && err.code) || 'error'})` });
		try { child.kill(); } catch (_) {}
		release();
	}
}

// Only known small fields cross back, so nothing the child got wrong can reach the caller.
function resultOf(msg) {
	if (msg && msg.ok === true && msg.summary) {
		const s = msg.summary;
		return {
			ok: true,
			summary: {
				sections: Number(s.sections) || 0,
				totalWords: Number(s.totalWords) || 0,
				textBytes: Number(s.textBytes) || 0,
				title: typeof s.title === 'string' ? s.title.slice(0, 300) : null,
				tocSource: typeof s.tocSource === 'string' ? s.tocSource : null,
				ms: Number(s.ms) || 0,
				pid: Number(s.pid) || 0
			}
		};
	}
	if (msg && msg.ok === false) {
		return { ok: false, code: typeof msg.code === 'string' ? msg.code : 'crash', message: typeof msg.message === 'string' ? msg.message.slice(0, 200) : '' };
	}
	return { ok: false, code: 'crash', message: 'unreadable answer' };
}

// Leaves the queue usable: !restart re-runs start() in this same process and parses again.
function shutdown() {
	const pending = queue;
	queue = [];
	const run = running;
	running = null;
	inflight = new Map();
	if (run) {
		run.released = true;
		clearTimers(run);
		run.entry.settle({ ok: false, code: 'shutdown', message: 'bot shutting down' });
		if (run.child) {
			try { run.child.kill(); } catch (_) {}
		}
	}
	for (const entry of pending) entry.settle({ ok: false, code: 'shutdown', message: 'bot shutting down' });
}

function writeAtomic(fs, file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function removeQuietly(fs, file) {
	try { fs.unlinkSync(file); } catch (_) {}
}

// The child's whole job, exported so a test can run it in-process with a recording fs.
// .txt is committed before .json: the index is the marker that says the text is complete.
function runJob(job, { fs = require('fs'), now = Date.now, pid = process.pid } = {}) {
	const started = Date.now();
	const { input, outDir, base } = job;
	const source = job.source || null;
	if (!SAFE_BASE.test(String(base || ''))) return { ok: false, code: 'bad-job', message: 'unsafe base' };
	const txt = pathMod.join(outDir, `${base}.txt`);
	const json = pathMod.join(outDir, `${base}.json`);
	const fail = pathMod.join(outDir, `${base}.fail.json`);
	try {
		fs.mkdirSync(outDir, { recursive: true });
		const { index, text } = parseEpubToCache({ path: input.path }, { source, now, fs });
		const ordered = { ...index, textFile: `${base}.txt` };
		writeAtomic(fs, txt, text);
		writeAtomic(fs, json, JSON.stringify(ordered));
		removeQuietly(fs, fail);
		return {
			ok: true,
			summary: {
				sections: index.sections.length,
				totalWords: index.totalWords,
				textBytes: index.textBytes,
				title: index.meta.title,
				tocSource: index.meta.tocSource,
				ms: Date.now() - started,
				pid
			}
		};
	} catch (err) {
		removeQuietly(fs, `${txt}.tmp`);
		removeQuietly(fs, `${json}.tmp`);
		removeQuietly(fs, `${fail}.tmp`);
		// A filesystem error (file missing, locked, disk full) may pass; a file we cannot parse
		// will not, so only the latter leaves a fail record that stops a re-parse on every start.
		const isIo = err && !(err instanceof EpubError) && typeof err.syscall === 'string';
		const code = err instanceof EpubError ? err.code : isIo ? 'io-error' : 'parse-error';
		// Never err.message from an unknown error: it is our only path for book text to leak.
		const message = err instanceof EpubError ? err.message : `${(err && err.name) || 'Error'}${err && err.code ? ` ${err.code}` : ''}`;
		if (!isIo) {
			try {
				writeAtomic(fs, fail, JSON.stringify({ version: EXTRACTOR_VERSION, fingerprint: source && source.fingerprint ? source.fingerprint : null, code, at: typeof now === 'function' ? now() : now }));
			} catch (_) {
				removeQuietly(fs, `${fail}.tmp`);
			}
		}
		return { ok: false, code, message };
	}
}

function runChild() {
	process.on('disconnect', () => process.exit(0));
	process.once('message', job => {
		let result;
		try {
			result = runJob(job || {});
		} catch (err) {
			result = { ok: false, code: 'crash', message: (err && err.name) || 'Error' };
		}
		process.send(result, () => process.exit(0));
	});
}

// Test seam: swap fork/os/logger. Returns a function that puts the previous ones back.
function _setDeps(over) {
	const prev = deps;
	deps = { ...deps, ...over };
	priorityWarned = false;
	return () => { deps = prev; };
}

module.exports = { parseEpub, shutdown, runJob, VERSION: EXTRACTOR_VERSION, CHILD_FLAG, _setDeps };

if (require.main === module && process.argv[2] === CHILD_FLAG) runChild();
