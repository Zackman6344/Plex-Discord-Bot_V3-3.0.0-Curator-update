// helpers/bookPicturesWorker.js
//
// Two roles in one file, like helpers/epubTextWorker.js. Required by the bot, it is the queue that
// reads scanned PDFs for read-along pictures in a forked child process. Forked with
// --book-pictures-child, it is that child: it runs one job and answers with counts.
//
// A child process, not a worker thread, for epubTextWorker's reason: Process Lasso demotes the busy
// PROCESS, and a busy thread in the bot's own node.exe would drag the 20 ms voice timer down with
// it. The child is set to Below Normal at once, and the poppler tools and ffmpeg it starts inherit
// that, since Windows passes Idle and Below Normal on to children.
//
// One job at a time for the whole bot. An align job (seconds: a new text for a PDF already read)
// goes ahead of a waiting full job (minutes: read and render a whole PDF), and two works asking for
// the same key and text base share one job.
//   full   reads <pdfPath> and writes into <workDir>/out: the JPGs (bookPicturesScan), pages.json
//          (token keys and art boxes per printed page, no readable text), align-<base>.json when a
//          text is given, and index.json last, which marks the folder complete.
//   align  reads <keyDir>/pages.json and the cached text by path, and writes align-<base>.json, or
//          align-<base>.fail.json when too few printed pages line up, into keyDir.
// The parent never holds book text: the job carries paths, the answer counts and codes. The answer
// waits for the child's 'close', because Windows will not delete <key>.work while a process still
// holds a file in it. No progress for two minutes, or half an hour in all (more for a long book),
// kills the child's tree.

const pathMod = require('path');

const CHILD_FLAG = '--book-pictures-child';
const IDLE_MS = 2 * 60 * 1000;
const TOTAL_MS = 30 * 60 * 1000;
// Rendering measured 0.84 s a page on an idle PC and 1.38 s on a busy one, so half an hour is not
// enough for a long book on a busy PC, and each such read would end as a timeout strike. Once the
// child names its page count, the cap becomes 5 minutes (the text layer, the encodes) plus 3 s a
// page, never under TOTAL_MS: 55 minutes for 1000 pages, bookPictures' LIMITS.maxPages.
const RENDER_SLACK_MS = 5 * 60 * 1000;
const RENDER_PAGE_MS = 3000;
const RENDER_MAX_PAGES = 1000;
const PROGRESS_EVERY_MS = 500;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PICTURE_FILE = /^p\d{3,4}(-\d{3,4})?\.jpg$/;
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const STAGE = /^[a-z][a-z-]{0,19}$/;
const LIMIT_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const KINDS = new Set(['part', 'full', 'spread']);
// The token normalisation pages.json's keys were made with; an align job refuses other keys.
const KEYS_NORM = 1;
const DEFAULT_MIN_SHARE = 0.6;
const MAX_PAGES = 100000;

function defaultDeps() {
	return {
		fork: (...args) => require('child_process').fork(...args),
		os: require('os'),
		killTree: (...args) => require('./ebookConvert.js').killTree(...args),
		logger: null,
		// A child that answered but does not exit, and one that ignores the kill, must not hold the
		// queue forever; 'exit' without 'close' answers after the fallback.
		exitGraceMs: 5000,
		killGraceMs: 10000,
		closeFallbackMs: 1000
	};
}

let deps = defaultDeps();
let priorityWarned = false;
let aligns = [];
let fulls = [];
let running = null;
let flights = new Map();

function loggerOf() {
	return deps.logger || require('./logger.js');
}

const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const absolute = (p) => typeof p === 'string' && p.length > 0 && pathMod.isAbsolute(p);
const share = (v) => (Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000 : 0);
const codeOr = (v, fallback) => (typeof v === 'string' && CODE.test(v) ? v : fallback);

// --- the job -------------------------------------------------------------------------------------

function problemOf(job) {
	if (!job || typeof job !== 'object') return 'no job';
	if (job.kind !== 'full' && job.kind !== 'align') return 'kind must be full or align';
	if (!SAFE_NAME.test(String(job.key || ''))) return 'unsafe key';
	const t = job.text;
	if (t != null) {
		if (typeof t !== 'object' || !SAFE_NAME.test(String(t.base || ''))) return 'unsafe text base';
		if (!absolute(t.textPath) || !absolute(t.indexPath)) return 'a text needs textPath and indexPath';
	}
	if (job.kind === 'full' && (!absolute(job.workDir) || !absolute(job.pdfPath))) return 'a full job needs workDir and pdfPath';
	if (job.kind === 'align' && (!absolute(job.keyDir) || !t)) return 'an align job needs keyDir and a text';
	return null;
}

function toolOf(t) {
	if (typeof t === 'string' && t) return t;
	if (t && typeof t === 'object' && typeof t.exe === 'string' && t.exe) return { exe: t.exe, args: Array.isArray(t.args) ? t.args.map(String) : [] };
	return null;
}

function numbersOf(o) {
	const out = {};
	if (!o || typeof o !== 'object') return out;
	for (const [k, v] of Object.entries(o)) if (LIMIT_NAME.test(k) && Number.isFinite(v)) out[k] = v;
	return out;
}

// The job as it crosses to the child: known fields only, plain JSON, paths and numbers.
function wireJob(job) {
	const t = job.text;
	const tools = job.tools && typeof job.tools === 'object' ? job.tools : {};
	const v = job.versions && typeof job.versions === 'object' ? job.versions : {};
	return {
		kind: job.kind,
		key: job.key,
		workDir: typeof job.workDir === 'string' ? job.workDir : null,
		keyDir: typeof job.keyDir === 'string' ? job.keyDir : null,
		pdfPath: typeof job.pdfPath === 'string' ? job.pdfPath : null,
		text: t ? { base: t.base, textPath: t.textPath, indexPath: t.indexPath } : null,
		tools: {
			pdftotext: toolOf(tools.pdftotext),
			pdftoppm: toolOf(tools.pdftoppm),
			ffmpeg: toolOf(tools.ffmpeg),
			poppler: typeof tools.poppler === 'string' ? tools.poppler.slice(0, 40) : null
		},
		limits: numbersOf(job.limits),
		fingerprint: typeof job.fingerprint === 'string' ? job.fingerprint.slice(0, 300) : null,
		versions: { pictures: Number.isInteger(v.pictures) && v.pictures > 0 ? v.pictures : 1, align: Number.isInteger(v.align) && v.align > 0 ? v.align : 1 }
	};
}

// --- the queue -----------------------------------------------------------------------------------

/**
 * Queues one job. Never rejects.
 * @param {{ kind: 'full'|'align', key: string, workDir?: string, keyDir?: string, pdfPath?: string,
 *   text?: { base: string, textPath: string, indexPath: string },
 *   tools?: { pdftotext, pdftoppm, ffmpeg, poppler? }, limits?: object, fingerprint?: string,
 *   versions?: { pictures: number, align: number }, idleMs?: number, timeoutMs?: number }} job
 *   paths only; a tool is a path or { exe, args }; versions are what the parent loads
 *   (bookPictures' PICTURES_VERSION and ALIGN_VERSION), 1 and 1 when left out; timeoutMs, when
 *   given, is the whole cap, which a long book does not stretch
 * @param {{ onProgress?: (p: { stage: string, done: number, total: number }) => void }} [opts]
 * @returns {Promise<{ ok: true, summary: object } | { ok: false, code: string, message?: string }>}
 */
function run(job, opts) {
	const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
	const bad = problemOf(job);
	if (bad) return Promise.resolve({ ok: false, code: 'bad-job', message: bad });
	const flight = `${job.key}|${job.text ? job.text.base : ''}`;
	const same = flights.get(flight);
	if (same) {
		if (onProgress) same.listeners.push(onProgress);
		return same.promise;
	}
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	const timeoutMs = positive(job.timeoutMs);
	const entry = {
		job: wireJob(job),
		flight,
		listeners: onProgress ? [onProgress] : [],
		idleMs: positive(job.idleMs) || IDLE_MS,
		totalMs: timeoutMs || TOTAL_MS,
		stretches: !timeoutMs,
		promise,
		settled: false
	};
	entry.settle = (result) => {
		if (entry.settled) return;
		entry.settled = true;
		detach(entry);
		resolve(result);
	};
	flights.set(flight, entry);
	(entry.job.kind === 'align' ? aligns : fulls).push(entry);
	pump();
	return promise;
}

// A job on its way out no longer takes new callers: a run() after cancel() starts afresh.
function detach(entry) {
	if (flights.get(entry.flight) === entry) flights.delete(entry.flight);
}

function pump() {
	if (running) return;
	const entry = aligns.shift() || fulls.shift();
	if (entry) start(entry);
}

function clearTimers(run) {
	for (const t of Object.values(run.timers)) clearTimeout(t);
}

function timer(fn, ms) {
	const t = setTimeout(fn, ms);
	if (t.unref) t.unref();
	return t;
}

function release(run) {
	if (run.released) return;
	run.released = true;
	clearTimers(run);
	if (running === run) {
		running = null;
		pump();
	}
}

function finish(run, code, signal) {
	if (run.released) return;
	let result;
	if (run.ending) result = { ok: false, code: run.ending.code, message: run.ending.message };
	else if (run.result) result = run.result;
	else result = { ok: false, code: 'crash', message: signal ? `signal ${signal}` : `exit ${code}` };
	run.entry.settle(result);
	release(run);
}

// Kills the tree; the answer still waits for 'close' (or the kill grace).
function end(run, code, message) {
	if (run.released || run.ending) return;
	run.ending = { code, message };
	detach(run.entry);
	clearTimeout(run.timers.idle);
	clearTimeout(run.timers.total);
	clearTimeout(run.timers.exit);
	try {
		deps.killTree(run.child);
	} catch (_) { /* the grace below still answers */ }
	run.timers.kill = timer(() => finish(run, null, null), deps.killGraceMs);
}

function armIdle(run) {
	clearTimeout(run.timers.idle);
	run.timers.idle = timer(() => end(run, 'timeout', `no progress in ${run.entry.idleMs} ms`), run.entry.idleMs);
}

function armTotal(run) {
	clearTimeout(run.timers.total);
	const total = run.totalMs;
	run.timers.total = timer(() => end(run, 'timeout', `over ${total} ms`), Math.max(0, run.startedAt + total - Date.now()));
}

// The first page count a render reports sets the deadline for the whole job, still counted from
// its start; a later one, true or not, moves nothing.
function stretch(run, pages) {
	if (run.stretched || !run.entry.stretches) return;
	run.stretched = true;
	const total = Math.max(run.totalMs, RENDER_SLACK_MS + Math.min(pages, RENDER_MAX_PAGES) * RENDER_PAGE_MS);
	if (total === run.totalMs) return;
	run.totalMs = total;
	armTotal(run);
}

function progressOf(msg) {
	if (typeof msg.stage !== 'string' || !STAGE.test(msg.stage)) return null;
	return { stage: msg.stage, done: count(msg.done), total: count(msg.total) };
}

function onMessage(run, msg) {
	if (run.released || run.ending || run.result || !msg || typeof msg !== 'object') return;
	if (msg.type === 'progress') {
		armIdle(run);
		const p = progressOf(msg);
		if (!p) return;
		if (p.stage === 'render' && p.total > 0) stretch(run, p.total);
		for (const fn of run.entry.listeners.slice()) {
			try {
				fn(p);
			} catch (_) { /* a listener's bug must not stop the job */ }
		}
		return;
	}
	if (msg.type !== 'result') return;
	run.result = resultOf(msg);
	clearTimeout(run.timers.idle);
	clearTimeout(run.timers.total);
	// It exits by itself once its answer is flushed; one that does not is killed, and still answers.
	run.timers.exit = timer(() => {
		try {
			deps.killTree(run.child);
		} catch (_) { /* the grace below still answers */ }
		run.timers.kill = timer(() => finish(run, null, null), deps.killGraceMs);
	}, deps.exitGraceMs);
}

function start(entry) {
	const run = { entry, child: null, result: null, ending: null, timers: {}, released: false, startedAt: Date.now(), totalMs: entry.totalMs, stretched: false };
	running = run;
	let child;
	try {
		child = deps.fork(__filename, [CHILD_FLAG], {
			// Explicit, so a child forked under `node --test` does not inherit test-runner flags.
			execArgv: ['--max-old-space-size=512'],
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			serialization: 'json',
			windowsHide: true
		});
	} catch (err) {
		entry.settle({ ok: false, code: 'crash', message: `fork failed (${(err && err.code) || 'error'})` });
		release(run);
		return;
	}
	run.child = child;

	try {
		deps.os.setPriority(child.pid, deps.os.constants.priority.PRIORITY_BELOW_NORMAL);
	} catch (err) {
		if (!priorityWarned) {
			priorityWarned = true;
			loggerOf().warn(`Read-along pictures: could not lower the PDF reader's priority (${(err && err.code) || 'error'}); it runs at Normal.`);
		}
	}

	// No child.disconnect() here: the child exits by itself once its answer is flushed, and a
	// parent-side disconnect stops 'close' from ever being emitted (measured on Node 24).
	child.on('message', (msg) => onMessage(run, msg));
	// 'close' is the real end: 'exit' can arrive before the child's last IPC message has been read.
	child.on('close', (code, signal) => finish(run, code, signal));
	child.on('exit', (code, signal) => {
		if (run.released) return;
		clearTimeout(run.timers.fallback);
		run.timers.fallback = timer(() => finish(run, code, signal), deps.closeFallbackMs);
	});
	child.on('error', (err) => {
		if (run.released) return;
		const message = `child error (${(err && err.code) || 'error'})`;
		if (!child.pid) {
			entry.settle({ ok: false, code: 'crash', message });
			release(run);
			return;
		}
		end(run, 'crash', message);
	});

	armIdle(run);
	armTotal(run);
	try {
		child.send(entry.job);
	} catch (err) {
		end(run, 'crash', `send failed (${(err && err.code) || 'error'})`);
	}
}

function alignOf(a) {
	if (!a || typeof a !== 'object') return null;
	return {
		code: codeOr(a.code, 'align-error'),
		placed: count(a.placed),
		textPages: count(a.textPages),
		aligned: count(a.aligned),
		share: share(a.share),
		textWords: count(a.textWords)
	};
}

// Only known small fields cross back, so nothing the child got wrong can reach the caller.
function resultOf(msg) {
	if (msg && msg.ok === true && msg.summary && typeof msg.summary === 'object') {
		const s = msg.summary;
		return {
			ok: true,
			summary: {
				kind: s.kind === 'align' ? 'align' : 'full',
				pages: count(s.pages),
				pictures: count(s.pictures),
				spreads: count(s.spreads),
				textPages: count(s.textPages),
				align: alignOf(s.align),
				ms: count(s.ms),
				pid: count(s.pid)
			}
		};
	}
	if (msg && msg.ok === false) {
		return { ok: false, code: codeOr(msg.code, 'crash'), message: typeof msg.message === 'string' ? msg.message.slice(0, 200) : '' };
	}
	return { ok: false, code: 'crash', message: 'unreadable answer' };
}

/** Kills that key's running job (its tree) and drops its queued ones: each answers 'cancelled'. */
function cancel(key) {
	let hit = false;
	const keep = (list) => list.filter((entry) => {
		if (entry.job.key !== key) return true;
		entry.settle({ ok: false, code: 'cancelled', message: 'cancelled' });
		hit = true;
		return false;
	});
	aligns = keep(aligns);
	fulls = keep(fulls);
	if (running && !running.released && !running.ending && running.entry.job.key === key) {
		end(running, 'cancelled', 'cancelled');
		hit = true;
	}
	return hit;
}

// Leaves the queue usable: !restart builds a new bookPictures in this same process.
function shutdown() {
	const pending = aligns.concat(fulls);
	aligns = [];
	fulls = [];
	flights = new Map();
	const run = running;
	running = null;
	if (run) {
		run.released = true;
		clearTimers(run);
		run.entry.settle({ ok: false, code: 'shutdown', message: 'bot shutting down' });
		if (run.child) {
			try {
				deps.killTree(run.child, { sync: true });
			} catch (_) { /* exiting anyway */ }
		}
	}
	for (const entry of pending) entry.settle({ ok: false, code: 'shutdown', message: 'bot shutting down' });
}

function busy() {
	return !!running;
}

// --- the child's job -----------------------------------------------------------------------------

function writeAtomic(fs, file, data, tmps) {
	const tmp = `${file}.tmp`;
	tmps.push(tmp);
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function removeQuietly(fs, file) {
	try {
		fs.unlinkSync(file);
	} catch (_) { /* gone already */ }
}

function keysToBase64(keys) {
	const buf = Buffer.alloc(keys.length * 4);
	for (let i = 0; i < keys.length; i++) buf.writeUInt32LE(keys[i] >>> 0, i * 4);
	return buf.toString('base64');
}

function keysFromBase64(s) {
	const buf = Buffer.from(typeof s === 'string' ? s : '', 'base64');
	const keys = new Uint32Array(buf.length >> 2);
	for (let i = 0; i < keys.length; i++) keys[i] = buf.readUInt32LE(i * 4);
	return keys;
}

function u32Of(keys) {
	if (keys instanceof Uint32Array) return keys;
	return Uint32Array.from(Array.isArray(keys) ? keys.filter((k) => Number.isFinite(k)) : [], (k) => k >>> 0);
}

function boxesOf(boxes) {
	const out = [];
	for (const b of Array.isArray(boxes) ? boxes : []) {
		if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) continue;
		out.push(b.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000));
	}
	return out;
}

function pagesOf(scan) {
	const pages = new Map();
	for (const p of Array.isArray(scan && scan.pages) ? scan.pages : []) {
		if (!p || !Number.isInteger(p.n) || p.n < 1 || p.n > MAX_PAGES || pages.has(p.n)) continue;
		pages.set(p.n, { n: p.n, keys: u32Of(p.keys), art: p.art === false ? [] : boxesOf(p.boxes) });
	}
	return [...pages.values()].sort((a, b) => a.n - b.n);
}

// Every picture the scan says it wrote, as it is on disk: the name the parent will accept and the
// file's own size.
function picturesOf(scan, dir, fs) {
	const out = [];
	const seen = new Set();
	for (const p of Array.isArray(scan && scan.pictures) ? scan.pictures : []) {
		if (!p || typeof p.file !== 'string' || !PICTURE_FILE.test(p.file)) continue;
		const id = p.file.slice(0, -4);
		const pages = Array.isArray(p.pages) ? p.pages.filter((n) => Number.isInteger(n) && n >= 1).slice(0, 2) : [];
		if (seen.has(id) || !pages.length) continue;
		let bytes;
		try {
			const st = fs.statSync(pathMod.join(dir, p.file));
			if (!st.isFile()) continue;
			bytes = st.size;
		} catch (_) {
			continue;
		}
		seen.add(id);
		out.push({
			id,
			file: p.file,
			pages,
			kind: KINDS.has(p.kind) ? p.kind : pages.length > 1 ? 'spread' : 'part',
			width: count(p.width),
			height: count(p.height),
			bytes
		});
	}
	return out.sort((a, b) => a.pages[0] - b.pages[0]);
}

// Page n's keys at index n - 1, an empty list for a page the scan left out.
function pageKeysOf(pages, pageCount) {
	const list = [];
	for (let i = 0; i < pageCount; i++) list.push(new Uint32Array(0));
	for (const p of pages) if (p.n <= pageCount) list[p.n - 1] = p.keys;
	return list;
}

function readPages(data, version) {
	if (!data || data.version !== version || data.norm !== KEYS_NORM || !Array.isArray(data.pages)) return null;
	const pages = [];
	for (const p of data.pages) {
		if (!p || !Number.isInteger(p.n) || p.n < 1 || p.n > MAX_PAGES) return null;
		pages.push({ n: p.n, keys: keysFromBase64(p.keys) });
	}
	const last = pages.reduce((m, p) => Math.max(m, p.n), 0);
	const pageCount = Math.max(count(data.pdf && data.pdf.pages), last);
	if (pageCount > MAX_PAGES) return null;
	const pictures = [];
	for (const p of Array.isArray(data.pictures) ? data.pictures : []) {
		if (!p || typeof p.id !== 'string' || !PICTURE_FILE.test(`${p.id}.jpg`) || !Array.isArray(p.pages)) continue;
		const ns = p.pages.filter((n) => Number.isInteger(n) && n >= 1).slice(0, 2);
		if (ns.length) pictures.push({ id: p.id, pages: ns, kind: KINDS.has(p.kind) ? p.kind : 'part' });
	}
	return { pageCount, pageKeys: pageKeysOf(pages, pageCount), pictures };
}

const inText = (v, textWords) => Number.isInteger(v) && v >= 0 && v < textWords;

// The words pictureWords gave, kept only where they name a picture of this PDF and a word of this
// text, in reading order. A fallback (the last word of the page before a picture placed on a later
// page, for a narration that stops before that later page) is kept only as a word of this text.
function wordsOf(list, pictures, textWords) {
	const first = new Map(pictures.map((p) => [p.id, p.pages[0]]));
	const out = [];
	const seen = new Set();
	for (const w of Array.isArray(list) ? list : []) {
		if (!w || !first.has(w.id) || seen.has(w.id) || !inText(w.word, textWords)) continue;
		seen.add(w.id);
		const entry = { id: w.id, word: w.word, how: typeof w.how === 'string' && CODE.test(w.how) ? w.how : null };
		if (inText(w.fallback, textWords)) entry.fallback = w.fallback;
		out.push(entry);
	}
	return out.sort((a, b) => a.word - b.word || first.get(a.id) - first.get(b.id));
}

function qualityOf(q) {
	const v = q && typeof q === 'object' ? q : {};
	return { textPages: count(v.textPages), aligned: count(v.aligned), share: share(v.share) };
}

function isIo(err) {
	return !!err && typeof err.syscall === 'string';
}

function errName(err) {
	return `${(err && err.name) || 'Error'}${err && typeof err.code === 'string' ? ` ${err.code}` : ''}`;
}

// Lines the scanned pages up with one text and writes the answer into dir: align-<base>.json, or
// align-<base>.fail.json when the share of text pages placed is under minShare (or the alignment
// itself threw, which would throw again on the same files). A text that cannot be read writes
// nothing: that may pass, and the parent asks again.
function alignInto(dir, job, data, ctx) {
	const { fs, now, tmps } = ctx;
	const base = job.text.base;
	const okFile = pathMod.join(dir, `align-${base}.json`);
	const failFile = pathMod.join(dir, `align-${base}.fail.json`);
	ctx.onProgress({ stage: 'align', done: 0, total: 1 });
	let index;
	let text;
	try {
		index = JSON.parse(fs.readFileSync(job.text.indexPath, 'utf8'));
		// Bytes, not a string: the index's sections are byte ranges of this file.
		text = fs.readFileSync(job.text.textPath);
	} catch (err) {
		return { code: 'io-error' };
	}
	if (!index || !Array.isArray(index.sections)) return { code: 'io-error' };
	const align = ctx.align || require('./bookPicturesAlign.js');
	let outcome;
	try {
		const ebook = align.ebookKeys(text, index.sections);
		const aligned = align.alignPages(data.pageKeys, ebook);
		const quality = qualityOf(aligned && aligned.quality);
		const textWords = count(ebook && ebook.totalWords);
		const minShare = align.DEFAULTS && Number.isFinite(align.DEFAULTS.minShare) ? align.DEFAULTS.minShare : DEFAULT_MIN_SHARE;
		if (!(quality.share >= minShare) || !textWords) {
			outcome = { code: 'align-failed', ...quality, textWords, placed: 0 };
		} else {
			const refs = data.pictures.map(({ id, pages, kind }) => ({ id, pages, kind }));
			const placed = wordsOf(align.pictureWords(refs, aligned, { totalWords: textWords }), data.pictures, textWords);
			outcome = { code: 'ok', ...quality, textWords, placed: placed.length, list: placed };
		}
	} catch (err) {
		if (isIo(err)) return { code: 'io-error' };
		outcome = { code: 'align-error', textPages: 0, aligned: 0, share: 0, textWords: 0, placed: 0 };
	}
	if (outcome.code === 'ok') {
		writeAtomic(fs, okFile, JSON.stringify({
			version: job.versions.align,
			key: job.key,
			base,
			builtAt: now(),
			textWords: outcome.textWords,
			quality: { textPages: outcome.textPages, aligned: outcome.aligned, share: outcome.share },
			pictures: outcome.list
		}), tmps);
		removeQuietly(fs, failFile);
	} else {
		writeAtomic(fs, failFile, JSON.stringify({
			version: job.versions.align,
			base,
			code: outcome.code,
			share: outcome.code === 'align-failed' ? outcome.share : null,
			at: now()
		}), tmps);
		removeQuietly(fs, okFile);
	}
	ctx.onProgress({ stage: 'align', done: 1, total: 1 });
	const { list, ...summary } = outcome;
	return summary;
}

async function fullJob(job, ctx) {
	const { fs, now, tmps } = ctx;
	const tools = job.tools;
	if (!tools.pdftotext || !tools.pdftoppm || !tools.ffmpeg) return { ok: false, code: 'tools-missing', message: 'a PDF tool is missing from the job' };
	const out = pathMod.join(job.workDir, 'out');
	fs.mkdirSync(out, { recursive: true });
	const scanPdf = ctx.scanPdf || require('./bookPicturesScan.js').scanPdf;
	const runTool = ctx.runTool || require('./pdfTools.js').runTool;
	const scan = await scanPdf({ pdfPath: job.pdfPath, outDir: out, tools, limits: job.limits }, { onProgress: ctx.onProgress, runTool, fs });
	const pages = pagesOf(scan);
	const pageCount = Math.min(MAX_PAGES, Math.max(count(scan && scan.pageCount), pages.length ? pages[pages.length - 1].n : 0));
	const pictures = picturesOf(scan, out, fs);
	const pdf = { fingerprint: job.fingerprint, pages: pageCount };
	writeAtomic(fs, pathMod.join(out, 'pages.json'), JSON.stringify({
		version: job.versions.pictures,
		norm: KEYS_NORM,
		pdf,
		pages: pages.map((p) => ({ n: p.n, keys: keysToBase64(p.keys), art: p.art })),
		pictures: pictures.map(({ id, pages: ns, kind }) => ({ id, pages: ns, kind }))
	}), tmps);
	const align = job.text ? alignInto(out, job, { pageKeys: pageKeysOf(pages, pageCount), pictures }, ctx) : null;
	const spreads = pictures.filter((p) => p.kind === 'spread').length;
	const textPages = count(scan && scan.textPages);
	const ms = Date.now() - ctx.started;
	// The PDF's page n is printed page n - folioOffset: the parent's alt text names printed pages.
	const folioOffset = Number.isInteger(scan && scan.folioOffset) ? scan.folioOffset : null;
	// A read that lost a few renders or encodes, under the limit past which the scan fails it, is
	// still installed as whole; these keep the loss on record.
	const skipped = count(scan && scan.skipped);
	const encodeFailed = count(scan && scan.encodeFailed);
	writeAtomic(fs, pathMod.join(out, 'index.json'), JSON.stringify({
		version: job.versions.pictures,
		kind: 'plexbot-book-pictures',
		builtAt: now(),
		pdf,
		folioOffset,
		pictures,
		summary: { pages: pageCount, pictures: pictures.length, spreads, textPages, skipped, encodeFailed, ms, tools: { poppler: tools.poppler } }
	}), tmps);
	return { ok: true, summary: { kind: 'full', pages: pageCount, pictures: pictures.length, spreads, textPages, align, ms, pid: ctx.pid } };
}

function alignJob(job, ctx) {
	let data;
	try {
		data = readPages(JSON.parse(ctx.fs.readFileSync(pathMod.join(job.keyDir, 'pages.json'), 'utf8')), job.versions.pictures);
	} catch (err) {
		return { ok: false, code: 'io-error', message: errName(err) };
	}
	if (!data) return { ok: false, code: 'io-error', message: 'pages.json is damaged or from another version' };
	const align = alignInto(job.keyDir, job, data, ctx);
	if (align.code !== 'ok') return { ok: false, code: align.code, message: align.code === 'align-failed' ? `share ${align.share}` : align.code };
	return {
		ok: true,
		summary: {
			kind: 'align',
			pages: data.pageCount,
			pictures: data.pictures.length,
			spreads: data.pictures.filter((p) => p.kind === 'spread').length,
			textPages: align.textPages,
			align,
			ms: Date.now() - ctx.started,
			pid: ctx.pid
		}
	};
}

// A code the scan threw on purpose passes; anything else says only its kind, never its message,
// which is the one way book text or a path could leave the child.
function failureOf(err) {
	if (err && typeof err.code === 'string' && CODE.test(err.code) && !isIo(err)) return { ok: false, code: err.code };
	if (isIo(err)) return { ok: false, code: 'io-error', message: errName(err) };
	return { ok: false, code: 'crash', message: (err && err.name) || 'Error' };
}

/**
 * The child's whole job, exported so a test runs it in-process. Never rejects.
 * @param {object} job as run() takes it
 * @param {{ fs?: object, now?: () => number, pid?: number, onProgress?: Function, runTool?: Function,
 *   scanPdf?: Function, align?: object }} [seams] scanPdf and align default to
 *   bookPicturesScan.scanPdf and bookPicturesAlign, runTool to pdfTools.runTool
 */
async function runJob(job, { fs = require('fs'), now = Date.now, pid = process.pid, onProgress = null, runTool = null, scanPdf = null, align = null } = {}) {
	const bad = problemOf(job);
	if (bad) return { ok: false, code: 'bad-job', message: bad };
	const ctx = {
		fs,
		now,
		pid,
		started: Date.now(),
		tmps: [],
		runTool,
		scanPdf,
		align,
		onProgress: (p) => {
			if (typeof onProgress !== 'function') return;
			try {
				onProgress(p);
			} catch (_) { /* progress is a courtesy */ }
		}
	};
	const w = wireJob(job);
	try {
		return w.kind === 'align' ? alignJob(w, ctx) : await fullJob(w, ctx);
	} catch (err) {
		return failureOf(err);
	} finally {
		for (const tmp of ctx.tmps) removeQuietly(fs, tmp);
	}
}

// At each stage boundary, at a stage's last step, and otherwise at most every PROGRESS_EVERY_MS.
function progressSender(send, now = Date.now) {
	let stage = null;
	let at = 0;
	return (p) => {
		if (!p || typeof p.stage !== 'string') return;
		const t = now();
		const last = count(p.total) > 0 && count(p.done) >= count(p.total);
		if (p.stage === stage && !last && t - at < PROGRESS_EVERY_MS) return;
		stage = p.stage;
		at = t;
		try {
			send({ type: 'progress', stage: p.stage, done: count(p.done), total: count(p.total) });
		} catch (_) { /* the parent is gone; 'disconnect' ends this process */ }
	};
}

function runChild() {
	process.on('disconnect', () => process.exit(0));
	process.once('message', async (job) => {
		let result;
		try {
			result = await runJob(job || {}, { onProgress: progressSender((m) => process.send(m)) });
		} catch (err) {
			result = { ok: false, code: 'crash', message: (err && err.name) || 'Error' };
		}
		try {
			process.send({ type: 'result', ...result }, () => process.exit(0));
		} catch (_) {
			process.exit(0);
		}
	});
}

// Test seam: swap fork, os, killTree, logger or the grace timings. Returns a function that puts the
// previous ones back.
function _setDeps(over) {
	const prev = deps;
	deps = { ...deps, ...over };
	priorityWarned = false;
	return () => { deps = prev; };
}

module.exports = {
	run,
	cancel,
	shutdown,
	busy,
	runJob,
	CHILD_FLAG,
	IDLE_MS,
	TOTAL_MS,
	_setDeps,
	_resultOf: resultOf,
	_progressSender: progressSender
};

if (require.main === module && process.argv[2] === CHILD_FLAG) runChild();
