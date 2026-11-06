// helpers/bookPicturesWorker.js: the queue that reads a scanned PDF for read-along pictures in a
// Below Normal child process, and that child's job.
//
// The bugs this pins: a PDF read on the bot's own thread stalls the 20 ms voice timer (parsing
// #384's word boxes alone takes a second, rendering it four minutes); two analyses at once on a PC
// that overheats; a new text waiting minutes behind a full analysis when it needs seconds; two
// works asking for one PDF reading it twice; a hung tool holding the queue forever, or a long book
// on a busy PC cut off by a cap made for a short one; an answer given
// while the child still holds a file in <key>.work, so the folder cannot be deleted; a half-written
// folder taken for a whole one because index.json was not written last; a tmp file left behind;
// book text or a path crossing back in a message; !restart leaving the queue dead; a refused
// priority change taking the job down with it; a scan that lost its renders or encodes, or a
// password-protected PDF, reaching the parent as anything but its code; a picture's fallback word,
// the folio offset or the count of lost pages and pictures dropped on the way to the files the
// parent loads.
//
// Harness: a fake fork (EventEmitter children the test answers, closes or leaves hanging) and a
// recording killTree for the queue; runJob in-process with a stub scan and align and a recording fs
// for the files; real forked children for the IPC protocol and for reads that fail, and one book
// end to end, through the real bookPicturesScan and bookPicturesAlign with
// test/helpers/fakePdfTools.js in place of poppler and ffmpeg, in a pid-suffixed temp folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const TMP = pathMod.join(os.tmpdir(), `plexbot-test-bookpicturesworker-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${TMP}-logs`;

const worker = require('../helpers/bookPicturesWorker.js');
const { writeFakePdf, fakeTools, textPage, artPage } = require('./helpers/fakePdfTools.js');

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;
const KEY = '9aa360b44c75c103';
const BASE = '157d62d84d19901d';
const NOW = 1793000000000;

fs.mkdirSync(TMP, { recursive: true });
// The queue's timers are unref'd, as the bot wants them; a fake child holds no handle, so this
// keeps the loop alive while a test waits on those timers.
const keepAlive = setInterval(() => {}, 60 * 1000);

test.after(() => {
	const restore = worker._setDeps({ killTree: () => {} });
	worker.shutdown();
	restore();
	clearInterval(keepAlive);
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(`${TMP}-logs`, { recursive: true, force: true });
});

let dirNo = 0;
function newDir(name) {
	const dir = pathMod.join(TMP, `${name}-${++dirNo}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

async function until(cond, what, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return;
		await sleep(5);
	}
	assert.fail(`timed out waiting for ${what}`);
}

function spyLogger() {
	const lines = [];
	const log = (level) => (...args) => lines.push([level, args.join(' ')]);
	return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

function recordingOs() {
	const calls = [];
	return { calls, constants: os.constants, setPriority: (pid, value) => { calls.push([pid, value]); } };
}

// Children as the queue sees them. Messages cross as JSON, as the real channel carries them.
function fakeFork({ onSend } = {}) {
	const children = [];
	const fork = (...args) => {
		const c = new EventEmitter();
		c.pid = 970000 + children.length;
		c.args = args;
		c.sent = [];
		c.holdOnKill = false;
		c.send = (msg) => {
			c.sent.push(JSON.parse(JSON.stringify(msg)));
			if (onSend) onSend(c, JSON.parse(JSON.stringify(msg)));
		};
		c.close = (code = 0, signal = null) => setImmediate(() => {
			c.emit('exit', code, signal);
			c.emit('close', code, signal);
		});
		// Like the real child: answer, then exit by itself once the answer is flushed.
		c.answer = (msg) => {
			c.emit('message', { type: 'result', ...msg });
			c.close(0);
		};
		c.progress = (stage, done, total, extra = {}) => c.emit('message', { type: 'progress', stage, done, total, ...extra });
		children.push(c);
		return c;
	};
	return { fork, children };
}

function harness(over = {}) {
	const { fork, children } = fakeFork(over.forkOpts);
	const kills = [];
	const killTree = (child, opts) => {
		kills.push([child.pid, opts || null]);
		if (!child.holdOnKill) child.close(null, 'SIGTERM');
	};
	const fakeOs = recordingOs();
	const logger = spyLogger();
	const { forkOpts, ...rest } = over;
	const restore = worker._setDeps({ fork, killTree, os: fakeOs, logger, ...rest });
	worker.shutdown();
	return {
		children,
		kills,
		os: fakeOs,
		logger,
		done: () => {
			worker.shutdown();
			restore();
		}
	};
}

const TOOLS = {
	dir: 'C:\\Program Files\\Calibre2\\app\\bin',
	pdftotext: 'C:\\Program Files\\Calibre2\\app\\bin\\pdftotext.exe',
	pdftoppm: 'C:\\Program Files\\Calibre2\\app\\bin\\pdftoppm.exe',
	ffmpeg: 'C:\\bot\\node_modules\\ffmpeg-static\\ffmpeg.exe',
	poppler: '25.11.0'
};
const LIMITS = { maxPages: 1000, maxPictures: 200, maxPictureBytes: 2 * 1024 * 1024, renderHeight: 1200 };

function textOf(base = BASE, dir = pathMod.join(TMP, 'cache')) {
	return { base, textPath: pathMod.join(dir, `${base}.txt`), indexPath: pathMod.join(dir, `${base}.json`) };
}

function fullJob(key = KEY, extra = {}) {
	const workDir = pathMod.join(TMP, `${key}.work`);
	return { kind: 'full', key, workDir, keyDir: pathMod.join(TMP, key), pdfPath: pathMod.join(workDir, 'book.pdf'), text: textOf(), tools: TOOLS, limits: LIMITS, ...extra };
}

function alignJob(key = KEY, base = BASE, extra = {}) {
	const keyDir = pathMod.join(TMP, key);
	return { kind: 'align', key, workDir: keyDir, keyDir, text: textOf(base), tools: null, limits: LIMITS, ...extra };
}

const okFull = (pid) => ({ ok: true, summary: { kind: 'full', pages: 264, pictures: 60, spreads: 3, textPages: 219, align: null, ms: 5, pid } });

// Words made of consonant-vowel syllables, from a seeded generator: no two runs of three alike in
// a few hundred, which the alignment's rare n-grams need, and none spelling a field name of six
// letters, which keeps the no-text checks exact.
function bookWords(n, seed = 7) {
	let s = seed >>> 0;
	const rnd = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const C = 'bdfgklmnprstvz';
	const V = 'aeiou';
	const out = [];
	for (let i = 0; i < n; i++) {
		let w = '';
		const syllables = 2 + Math.floor(rnd() * 2);
		for (let k = 0; k < syllables; k++) w += C[Math.floor(rnd() * C.length)] + V[Math.floor(rnd() * V.length)];
		out.push(w);
	}
	return out;
}

// The read-along's cache pair for a text: <base>.txt and its index, sections numbered as
// epubText numbers them.
function writeText(dir, base, chapters) {
	let text = '';
	let wordStart = 0;
	const sections = [];
	for (const [label, words] of chapters) {
		const body = words.join(' ');
		sections.push({ label, byteStart: Buffer.byteLength(text), byteLen: Buffer.byteLength(body), wordStart, words: words.length });
		text += `${body}\n`;
		wordStart += words.length;
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(pathMod.join(dir, `${base}.txt`), text);
	fs.writeFileSync(pathMod.join(dir, `${base}.json`), JSON.stringify({ version: 1, sections, totalWords: wordStart, textFile: `${base}.txt` }));
	return textOf(base, dir);
}

// Whole tokens only: a six-letter book word inside a longer token is not that word.
function leaks(value, words) {
	const tokens = new Set(JSON.stringify(value).toLowerCase().match(/[a-z]+/g) || []);
	return words.filter((w) => w.length >= 6 && tokens.has(w));
}

const b64 = (list) => {
	const buf = Buffer.alloc(list.length * 4);
	list.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4));
	return buf.toString('base64');
};

// --- the queue -----------------------------------------------------------------------------------

test('a full job is forked once at Below Normal, and only paths and numbers cross to the child', async () => {
	const h = harness();
	try {
		const p = worker.run({ ...fullJob(), title: 'The Secret Title', fingerprint: 'calibre:L:384:pdf:9:m', limits: { ...LIMITS, evil: 'x', nested: { a: 1 } }, versions: { pictures: 3, align: 2 } });
		assert.strictEqual(h.children.length, 1);
		const [file, args, opts] = h.children[0].args;
		assert.strictEqual(file, require.resolve('../helpers/bookPicturesWorker.js'));
		assert.deepStrictEqual(args, [worker.CHILD_FLAG]);
		assert.deepStrictEqual(opts, { execArgv: ['--max-old-space-size=512'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json', windowsHide: true });
		assert.deepStrictEqual(h.os.calls, [[970000, BELOW_NORMAL]]);
		const job = fullJob();
		assert.deepStrictEqual(h.children[0].sent, [{
			kind: 'full',
			key: KEY,
			workDir: job.workDir,
			keyDir: job.keyDir,
			pdfPath: job.pdfPath,
			text: job.text,
			tools: { pdftotext: TOOLS.pdftotext, pdftoppm: TOOLS.pdftoppm, ffmpeg: TOOLS.ffmpeg, poppler: '25.11.0' },
			limits: LIMITS,
			fingerprint: 'calibre:L:384:pdf:9:m',
			versions: { pictures: 3, align: 2 }
		}]);
		assert.ok(worker.busy());
		h.children[0].answer(okFull(970000));
		assert.deepStrictEqual(await p, okFull(970000));
		assert.strictEqual(worker.busy(), false);
	} finally {
		h.done();
	}
});

test('a refused priority change is tolerated and warned once, with its code only', async () => {
	const refusing = {
		constants: os.constants,
		setPriority: () => { throw Object.assign(new Error('A system error occurred: uv_os_setpriority returned EPERM'), { code: 'EPERM' }); }
	};
	const h = harness({ os: refusing });
	try {
		const p1 = worker.run(fullJob('aaaa'));
		h.children[0].answer(okFull(1));
		assert.strictEqual((await p1).ok, true);
		const p2 = worker.run(fullJob('bbbb'));
		h.children[1].answer(okFull(2));
		assert.strictEqual((await p2).ok, true);
		assert.deepStrictEqual(h.logger.lines, [['warn', 'Read-along pictures: could not lower the PDF reader\'s priority (EPERM); it runs at Normal.']]);
	} finally {
		h.done();
	}
});

test('progress reaches onProgress with its known fields only, and keeps a slow job alive', async () => {
	const h = harness();
	try {
		const got = [];
		const p = worker.run({ ...fullJob(), idleMs: 120 }, { onProgress: (x) => got.push(x) });
		const c = h.children[0];
		for (let i = 1; i <= 8; i++) {
			await sleep(40);
			c.progress('render', i, 264, i === 1 ? { line: 'Mr and Mrs Dursley', path: 'C:\\x' } : {});
		}
		c.progress('NOT A STAGE', 1, 1);
		c.progress('align', -3, 'two');
		assert.deepStrictEqual(h.kills, [], '320 ms of steady progress outlives a 120 ms idle limit');
		assert.deepStrictEqual(got[0], { stage: 'render', done: 1, total: 264 });
		assert.strictEqual(got.length, 9);
		assert.deepStrictEqual(got[8], { stage: 'align', done: 0, total: 0 });
		c.answer(okFull(c.pid));
		assert.strictEqual((await p).ok, true);
	} finally {
		h.done();
	}
});

test('no progress for the idle limit kills the child\'s tree, and the answer waits for it to close', async () => {
	assert.strictEqual(worker.IDLE_MS, 2 * 60 * 1000);
	assert.strictEqual(worker.TOTAL_MS, 30 * 60 * 1000);
	const h = harness();
	try {
		const p = worker.run({ ...fullJob(), idleMs: 40 });
		const c = h.children[0];
		c.holdOnKill = true;
		let settled = false;
		p.then(() => { settled = true; });
		await until(() => h.kills.length === 1, 'the idle kill');
		assert.deepStrictEqual(h.kills, [[c.pid, null]]);
		await sleep(30);
		assert.strictEqual(settled, false, 'no answer while the child may still hold a file');
		c.close(null, 'SIGTERM');
		assert.deepStrictEqual(await p, { ok: false, code: 'timeout', message: 'no progress in 40 ms' });
	} finally {
		h.done();
	}
});

test('the total cap kills a job however much progress it sends, and a cap the job names is not stretched', async () => {
	const h = harness();
	try {
		const p = worker.run({ ...fullJob(), idleMs: 1000, timeoutMs: 80 });
		const c = h.children[0];
		const beat = setInterval(() => c.progress('render', 1, 2), 10);
		try {
			assert.deepStrictEqual(await p, { ok: false, code: 'timeout', message: 'over 80 ms' });
		} finally {
			clearInterval(beat);
		}
		assert.deepStrictEqual(h.kills, [[c.pid, null]]);
	} finally {
		h.done();
	}
});

// Rendering measured 1.38 s a page on a busy PC: a 1000-page book there needed about 23 of the 30
// minutes, and a PC a little busier would have ended every read of it as a timeout strike.
test('a long book\'s first page count stretches the total cap to 5 minutes and 3 s a page from the start, at most 1000 pages; the idle limit stays', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
	const MIN = 60 * 1000;
	const advance = (ms) => t.mock.timers.tick(ms);
	// Progress every 100 s, inside the 120 s idle limit, until `to` ms after the job started at `from`.
	const alive = (c, from, to, total) => {
		let at = from;
		while (at + 100 * 1000 < to) {
			advance(100 * 1000);
			at += 100 * 1000;
			c.progress('render', 3, total);
		}
		advance(to - at);
	};
	const h = harness();
	try {
		const p1 = worker.run(fullJob('aaaa'));
		const c1 = h.children[0];
		c1.progress('text', 0, 1);
		advance(MIN);
		c1.progress('render', 1, 4000);
		alive(c1, MIN, 55 * MIN - 1, 4000);
		assert.deepStrictEqual(h.kills, [], 'past half an hour, as 1000 pages need on a busy PC');
		advance(1);
		assert.deepStrictEqual(h.kills, [[c1.pid, null]], '55 minutes from the start: 1000 pages at most');
		assert.deepStrictEqual(await p1, { ok: false, code: 'timeout', message: 'over 3300000 ms' });

		const p2 = worker.run(fullJob('bbbb'));
		const c2 = h.children[1];
		c2.progress('render', 1, 264);
		c2.progress('render', 2, 1000);
		alive(c2, 0, 30 * MIN - 1, 264);
		assert.strictEqual(h.kills.length, 1, 'a short book keeps half an hour, whatever a later message says');
		advance(1);
		assert.deepStrictEqual(h.kills[1], [c2.pid, null]);
		assert.deepStrictEqual(await p2, { ok: false, code: 'timeout', message: 'over 1800000 ms' });

		const p3 = worker.run(fullJob('cccc'));
		const c3 = h.children[2];
		c3.progress('render', 1, 1000);
		// A message arms the idle timer before it stretches the cap: only a later one arms it under
		// the stretched cap.
		c3.progress('render', 2, 1000);
		advance(2 * MIN - 1);
		assert.strictEqual(h.kills.length, 2);
		advance(1);
		assert.strictEqual(h.kills.length, 3, 'a stretched job that goes quiet is still killed in two minutes');
		assert.deepStrictEqual(await p3, { ok: false, code: 'timeout', message: 'no progress in 120000 ms' });
	} finally {
		h.done();
	}
});

test('an answer waits for the child to close, and a child that never exits is killed and still answers', async () => {
	const h = harness({ exitGraceMs: 40, killGraceMs: 40 });
	try {
		const p = worker.run(fullJob());
		const c = h.children[0];
		c.holdOnKill = true;
		let settled = false;
		p.then(() => { settled = true; });
		c.emit('message', { type: 'result', ...okFull(c.pid) });
		await sleep(20);
		assert.strictEqual(settled, false);
		await until(() => h.kills.length === 1, 'the kill of a child that answered and stayed');
		assert.deepStrictEqual(await p, okFull(c.pid), 'its answer still stands');
		assert.strictEqual(worker.busy(), false);
	} finally {
		h.done();
	}
});

test('jobs run one at a time, and an align job goes ahead of a waiting full job', async () => {
	const h = harness();
	try {
		const pA = worker.run(fullJob('aaaa'));
		const pB = worker.run(fullJob('bbbb'));
		const pC = worker.run(alignJob('cccc'));
		assert.strictEqual(h.children.length, 1);
		h.children[0].answer(okFull(1));
		await pA;
		assert.strictEqual(h.children.length, 2);
		assert.deepStrictEqual([h.children[1].sent[0].kind, h.children[1].sent[0].key], ['align', 'cccc']);
		h.children[1].emit('close', 3, null);
		assert.deepStrictEqual(await pC, { ok: false, code: 'crash', message: 'exit 3' });
		assert.strictEqual(h.children.length, 3);
		assert.strictEqual(h.children[2].sent[0].key, 'bbbb');
		h.children[2].answer({ ok: false, code: 'pdf-damaged' });
		assert.deepStrictEqual(await pB, { ok: false, code: 'pdf-damaged', message: '' });
	} finally {
		h.done();
	}
});

test('two works asking for the same key and text share one job and its progress', async () => {
	const h = harness();
	try {
		const a = [];
		const b = [];
		const p1 = worker.run(fullJob(), { onProgress: (x) => a.push(x) });
		const p2 = worker.run(fullJob(), { onProgress: (x) => b.push(x) });
		assert.strictEqual(p1, p2);
		const p3 = worker.run(fullJob(KEY, { text: textOf('aaaaaaaaaaaaaaaa') }));
		assert.notStrictEqual(p3, p1, 'another text of the same PDF is its own job');
		assert.strictEqual(h.children.length, 1);
		h.children[0].progress('render', 5, 264);
		assert.deepStrictEqual([a, b], [[{ stage: 'render', done: 5, total: 264 }], [{ stage: 'render', done: 5, total: 264 }]]);
		h.children[0].answer(okFull(1));
		await p1;
		await tick();
		assert.strictEqual(h.children.length, 2);
		h.children[1].answer(okFull(2));
		await p3;
		const p4 = worker.run(fullJob());
		assert.notStrictEqual(p4, p1, 'a finished job is not reused');
		h.children[2].answer(okFull(3));
		await p4;
	} finally {
		h.done();
	}
});

test('cancel drops a waiting job without forking and kills a running one, which answers once gone', async () => {
	const h = harness();
	try {
		const pA = worker.run(fullJob('aaaa'));
		const pB = worker.run(fullJob('bbbb'));
		const pB2 = worker.run(alignJob('bbbb', 'aaaaaaaaaaaaaaaa'));
		assert.notStrictEqual(pB2, pB);
		assert.strictEqual(worker.cancel('bbbb'), true);
		assert.deepStrictEqual(await pB, { ok: false, code: 'cancelled', message: 'cancelled' });
		assert.deepStrictEqual(await pB2, { ok: false, code: 'cancelled', message: 'cancelled' });
		assert.strictEqual(h.children.length, 1);

		const c = h.children[0];
		c.holdOnKill = true;
		let settled = false;
		pA.then(() => { settled = true; });
		assert.strictEqual(worker.cancel('aaaa'), true);
		assert.deepStrictEqual(h.kills, [[c.pid, null]]);
		const again = worker.run(fullJob('aaaa'));
		assert.notStrictEqual(again, pA, 'a run after cancel starts afresh');
		await sleep(20);
		assert.strictEqual(settled, false);
		c.close(null, 'SIGTERM');
		assert.deepStrictEqual(await pA, { ok: false, code: 'cancelled', message: 'cancelled' });
		await tick();
		assert.strictEqual(h.children.length, 2);
		h.children[1].answer(okFull(2));
		assert.strictEqual((await again).ok, true);
		assert.strictEqual(worker.cancel('nothing'), false);
	} finally {
		h.done();
	}
});

test('shutdown fails the running and waiting jobs, kills the tree at once, and the queue still works', async () => {
	const h = harness();
	try {
		const pA = worker.run(fullJob('aaaa'));
		const pB = worker.run(alignJob('bbbb'));
		worker.shutdown();
		assert.deepStrictEqual(await pA, { ok: false, code: 'shutdown', message: 'bot shutting down' });
		assert.deepStrictEqual(await pB, { ok: false, code: 'shutdown', message: 'bot shutting down' });
		assert.deepStrictEqual(h.kills, [[h.children[0].pid, { sync: true }]]);
		assert.strictEqual(h.children.length, 1, 'the waiting job never started');
		assert.strictEqual(worker.busy(), false);
		const pC = worker.run(fullJob('cccc'));
		assert.strictEqual(h.children.length, 2);
		h.children[1].answer(okFull(5));
		assert.strictEqual((await pC).ok, true);
	} finally {
		h.done();
	}
});

test('only known small fields cross back from the child', async () => {
	const h = harness();
	try {
		const p = worker.run(fullJob());
		h.children[0].answer({
			ok: true,
			summary: {
				kind: 'full', pages: 264, pictures: 60.7, spreads: -1, textPages: '219', ms: 5, pid: 9, title: 'Secret', words: ['alpha'],
				align: { code: 'ok', placed: 58, textPages: 219, aligned: 214, share: 0.977123, textWords: 78276, list: [{ id: 'p022', word: 5 }], line: 'Mr and Mrs' }
			}
		});
		assert.deepStrictEqual(await p, {
			ok: true,
			summary: { kind: 'full', pages: 264, pictures: 60, spreads: 0, textPages: 0, align: { code: 'ok', placed: 58, textPages: 219, aligned: 214, share: 0.977, textWords: 78276 }, ms: 5, pid: 9 }
		});
	} finally {
		h.done();
	}
	assert.deepStrictEqual(worker._resultOf({ type: 'result', ok: false, code: 'Not A Code!', message: 'x'.repeat(500) }), { ok: false, code: 'crash', message: 'x'.repeat(200) });
	assert.deepStrictEqual(worker._resultOf({ type: 'result', ok: false, code: 'align-failed' }), { ok: false, code: 'align-failed', message: '' });
	assert.deepStrictEqual(worker._resultOf({ type: 'result', what: 1 }), { ok: false, code: 'crash', message: 'unreadable answer' });
	assert.deepStrictEqual(worker._resultOf({ ok: true, summary: { kind: 'align', align: { code: 'Bad Code', share: 7 } } }).summary.align, { code: 'align-error', placed: 0, textPages: 0, aligned: 0, share: 1, textWords: 0 });
});

test('a job with no key, an unsafe name or a relative path is refused without forking', async () => {
	const h = harness();
	try {
		const bad = [
			null,
			{ ...fullJob(), kind: 'render' },
			{ ...fullJob(), key: '../escape' },
			{ ...fullJob(), key: '' },
			{ ...fullJob(), workDir: 'relative\\work' },
			{ ...fullJob(), pdfPath: undefined },
			{ ...fullJob(), text: { base: 'a/b', textPath: textOf().textPath, indexPath: textOf().indexPath } },
			{ ...fullJob(), text: { base: BASE, textPath: 'cache\\x.txt', indexPath: textOf().indexPath } },
			{ ...alignJob(), text: null },
			{ ...alignJob(), keyDir: '' }
		];
		for (const job of bad) assert.strictEqual((await worker.run(job)).code, 'bad-job', JSON.stringify(job));
		assert.strictEqual(h.children.length, 0);
		assert.strictEqual((await worker.runJob({ kind: 'full', key: 'x' })).code, 'bad-job', 'the child checks again');
	} finally {
		h.done();
	}
});

test('a child that cannot be forked, or errors before it starts, is a crash and the queue moves on', async () => {
	const restore = worker._setDeps({
		fork: () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); },
		os: recordingOs(),
		logger: spyLogger(),
		killTree: () => {}
	});
	try {
		assert.deepStrictEqual(await worker.run(fullJob()), { ok: false, code: 'crash', message: 'fork failed (EAGAIN)' });
		assert.strictEqual(worker.busy(), false);
	} finally {
		worker.shutdown();
		restore();
	}
	const h = harness();
	try {
		const p = worker.run(fullJob());
		const q = worker.run(fullJob('bbbb'));
		const c = h.children[0];
		delete c.pid;
		c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
		assert.deepStrictEqual(await p, { ok: false, code: 'crash', message: 'child error (ENOENT)' });
		assert.strictEqual(h.children.length, 2);
		h.children[1].answer(okFull(1));
		assert.strictEqual((await q).ok, true);
	} finally {
		h.done();
	}
});

// --- the child's job, in-process -----------------------------------------------------------------

const PAGES = () => [
	{ n: 1, keys: Uint32Array.from([11, 12, 13]), textWords: 3, art: false, full: false, boxes: [[0.1, 0.1, 0.2, 0.2]] },
	{ n: 2, keys: Uint32Array.from([0xdeadbeef, 0x80000000, 4294967295, 1]), textWords: 4, art: true, full: false, boxes: [[0.08, 0.5, 0.92, 0.85123456]] },
	{ n: 3, keys: new Uint32Array(0), textWords: 0, art: true, full: true, boxes: [[0, 0, 1, 1]] },
	{ n: 4, keys: new Uint32Array(0), textWords: 0, art: true, full: true, boxes: [[0, 0, 1, 1]] },
	{ n: 5, keys: Uint32Array.from([21, 22]), textWords: 2, art: false, full: false, boxes: [] }
];
const PICTURES = () => [
	{ id: 'p002', file: 'p002.jpg', pages: [2], kind: 'part', width: 900, height: 400, bytes: 120 },
	{ id: 'p003-004', file: 'p003-004.jpg', pages: [3, 4], kind: 'spread', width: 1956, height: 1200, bytes: 300 },
	{ id: 'p009', file: 'p009.jpg', pages: [9], kind: 'full', width: 1, height: 1, bytes: 1 },
	{ id: 'evil', file: '..\\evil.jpg', pages: [1], kind: 'part' }
];

// Writes the pictures it lists (bar the ones a scan could not have written) through the fs it is
// given, as bookPicturesScan does. `result` overrides fields of what it answers.
function stubScan({ throws = null, pages = PAGES(), pictures = PICTURES(), progress = null, result = {} } = {}) {
	const calls = [];
	const scanPdf = async (job, deps) => {
		calls.push({ job, deps });
		if (throws) throw throws;
		deps.onProgress({ stage: 'text', done: 0, total: 1 });
		if (progress) deps.onProgress(progress);
		for (const p of pictures) {
			if (p.id === 'p009' || p.id === 'evil') continue;
			deps.fs.writeFileSync(pathMod.join(job.outDir, p.file), Buffer.alloc(p.bytes, 7));
		}
		deps.onProgress({ stage: 'render', done: pages.length, total: pages.length });
		return { pageCount: pages.length, pages, pictures, spreads: 1, textPages: 2, folioOffset: 12, skipped: 1, encodeFailed: 1, ...result };
	};
	return { scanPdf, calls };
}

function stubAlign({ share = 0.977, words = null, throws = null } = {}) {
	const calls = { ebookKeys: [], alignPages: [], pictureWords: [] };
	return {
		calls,
		DEFAULTS: { minShare: 0.6 },
		ebookKeys(text, sections) {
			calls.ebookKeys.push({ text, sections });
			const totalWords = sections.reduce((n, s) => n + s.words, 0);
			return { keys: new Uint32Array(totalWords), totalWords, sectionStarts: sections.map((s) => s.wordStart) };
		},
		alignPages(pageKeys, ebook) {
			calls.alignPages.push({ pageKeys, ebook });
			if (throws) throw throws;
			return { starts: pageKeys.map(() => null), ends: pageKeys.map(() => null), quality: { textPages: 2, aligned: 2, share } };
		},
		pictureWords(pictures, aligned, opts) {
			calls.pictureWords.push({ pictures, aligned, opts });
			return words || [{ id: 'p003-004', word: 20, how: 'next-text', fallback: 15 }, { id: 'p002', word: 10, how: 'page-start' }];
		}
	};
}

function recordingFs(over = {}) {
	const ops = [];
	const rfs = {
		...fs,
		writeFileSync: (f, d) => {
			ops.push(['write', pathMod.basename(f)]);
			return (over.writeFileSync || fs.writeFileSync)(f, d);
		},
		renameSync: (a, b) => {
			ops.push(['rename', pathMod.basename(a), pathMod.basename(b)]);
			return fs.renameSync(a, b);
		},
		readFileSync: (f, o) => {
			ops.push(['read', pathMod.basename(f)]);
			return fs.readFileSync(f, o);
		}
	};
	return { fs: rfs, ops };
}

const writesOf = (ops) => ops.filter(([op]) => op === 'write' || op === 'rename');
const readJson = (...parts) => JSON.parse(fs.readFileSync(pathMod.join(...parts), 'utf8'));

function workJob(extra = {}) {
	const workDir = newDir(`${KEY}.work`);
	const text = writeText(newDir('cache'), BASE, [['c1', bookWords(40)], ['c2', bookWords(30, 9)]]);
	return { ...fullJob(KEY, { workDir, pdfPath: pathMod.join(workDir, 'book.pdf'), text, fingerprint: 'calibre:L:384:pdf:29224426:m' }), ...extra };
}

test('a full job writes its pictures, then pages.json, the alignment and index.json last, each through a tmp file', async () => {
	const job = workJob();
	const scan = stubScan();
	const align = stubAlign();
	const rec = recordingFs();
	const runTool = () => {};
	const r = await worker.runJob(job, { fs: rec.fs, now: () => NOW, pid: 77, scanPdf: scan.scanPdf, align, runTool });
	assert.strictEqual(r.ok, true, JSON.stringify(r));
	const out = pathMod.join(job.workDir, 'out');
	assert.deepStrictEqual(writesOf(rec.ops), [
		['write', 'p002.jpg'],
		['write', 'p003-004.jpg'],
		['write', 'pages.json.tmp'],
		['rename', 'pages.json.tmp', 'pages.json'],
		['write', `align-${BASE}.json.tmp`],
		['rename', `align-${BASE}.json.tmp`, `align-${BASE}.json`],
		['write', 'index.json.tmp'],
		['rename', 'index.json.tmp', 'index.json']
	]);
	assert.deepStrictEqual(fs.readdirSync(out).sort(), [`align-${BASE}.json`, 'index.json', 'p002.jpg', 'p003-004.jpg', 'pages.json']);

	const { job: given, deps } = scan.calls[0];
	assert.deepStrictEqual(given, { pdfPath: job.pdfPath, outDir: out, tools: { pdftotext: TOOLS.pdftotext, pdftoppm: TOOLS.pdftoppm, ffmpeg: TOOLS.ffmpeg, poppler: '25.11.0' }, limits: LIMITS });
	assert.strictEqual(deps.runTool, runTool);
	assert.strictEqual(deps.fs, rec.fs);

	const index = readJson(out, 'index.json');
	assert.deepStrictEqual(index, {
		version: 1,
		kind: 'plexbot-book-pictures',
		builtAt: NOW,
		pdf: { fingerprint: 'calibre:L:384:pdf:29224426:m', pages: 5 },
		folioOffset: 12,
		pictures: [
			{ id: 'p002', file: 'p002.jpg', pages: [2], kind: 'part', width: 900, height: 400, bytes: 120 },
			{ id: 'p003-004', file: 'p003-004.jpg', pages: [3, 4], kind: 'spread', width: 1956, height: 1200, bytes: 300 }
		],
		summary: { pages: 5, pictures: 2, spreads: 1, textPages: 2, skipped: 1, encodeFailed: 1, ms: index.summary.ms, tools: { poppler: '25.11.0' } }
	}, 'a picture the scan named but never wrote, or with a name the parent refuses, is left out');
	assert.deepStrictEqual(readJson(out, `align-${BASE}.json`), {
		version: 1,
		key: KEY,
		base: BASE,
		builtAt: NOW,
		textWords: 70,
		quality: { textPages: 2, aligned: 2, share: 0.977 },
		pictures: [{ id: 'p002', word: 10, how: 'page-start' }, { id: 'p003-004', word: 20, how: 'next-text', fallback: 15 }]
	});
	assert.deepStrictEqual(r.summary, { kind: 'full', pages: 5, pictures: 2, spreads: 1, textPages: 2, align: { code: 'ok', textPages: 2, aligned: 2, share: 0.977, textWords: 70, placed: 2 }, ms: r.summary.ms, pid: 77 });

	assert.ok(Buffer.isBuffer(align.calls.ebookKeys[0].text), 'the text reaches ebookKeys as bytes, since its sections are byte ranges');
	assert.deepStrictEqual(align.calls.ebookKeys[0].text, fs.readFileSync(job.text.textPath));
	assert.deepStrictEqual(align.calls.ebookKeys[0].sections, readJson(job.text.indexPath).sections);
	const pageKeys = align.calls.alignPages[0].pageKeys;
	assert.deepStrictEqual(pageKeys.map((k) => Array.from(k)), [[11, 12, 13], [0xdeadbeef, 0x80000000, 4294967295, 1], [], [], [21, 22]], 'page n is at n - 1');
	assert.deepStrictEqual(align.calls.pictureWords[0].pictures, [{ id: 'p002', pages: [2], kind: 'part' }, { id: 'p003-004', pages: [3, 4], kind: 'spread' }]);
	assert.deepStrictEqual(align.calls.pictureWords[0].opts, { totalWords: 70 });
});

test('index.json takes the scan\'s folio offset only as an integer, and its lost renders and encodes as counts', async () => {
	const cases = [
		[{ folioOffset: -3, skipped: 2.7, encodeFailed: 0 }, { folioOffset: -3, skipped: 2, encodeFailed: 0 }],
		[{ folioOffset: null, skipped: -1, encodeFailed: 'two' }, { folioOffset: null, skipped: 0, encodeFailed: 0 }],
		[{ folioOffset: '12', skipped: undefined, encodeFailed: Infinity }, { folioOffset: null, skipped: 0, encodeFailed: 0 }],
		[{ folioOffset: 12.5 }, { folioOffset: null, skipped: 1, encodeFailed: 1 }],
		[{ folioOffset: undefined }, { folioOffset: null, skipped: 1, encodeFailed: 1 }]
	];
	for (const [result, want] of cases) {
		const job = workJob();
		const r = await worker.runJob(job, { now: () => NOW, scanPdf: stubScan({ result }).scanPdf, align: stubAlign(), runTool: () => {} });
		assert.strictEqual(r.ok, true, JSON.stringify(r));
		const index = readJson(job.workDir, 'out', 'index.json');
		assert.deepStrictEqual({ folioOffset: index.folioOffset, skipped: index.summary.skipped, encodeFailed: index.summary.encodeFailed }, want, JSON.stringify(result));
		assert.ok('folioOffset' in index, 'the field is there even when the scan found no offset');
	}
});

test('pages.json keeps each page\'s token keys as little-endian uint32 in base64, art boxes, and no words', async () => {
	const job = workJob();
	await worker.runJob(job, { now: () => NOW, scanPdf: stubScan().scanPdf, align: stubAlign(), runTool: () => {} });
	const pages = readJson(job.workDir, 'out', 'pages.json');
	assert.deepStrictEqual(pages, {
		version: 1,
		norm: 1,
		pdf: { fingerprint: 'calibre:L:384:pdf:29224426:m', pages: 5 },
		pages: [
			{ n: 1, keys: Buffer.from([11, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0]).toString('base64'), art: [] },
			{ n: 2, keys: Buffer.from([0xef, 0xbe, 0xad, 0xde, 0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0]).toString('base64'), art: [[0.08, 0.5, 0.92, 0.8512]] },
			{ n: 3, keys: '', art: [[0, 0, 1, 1]] },
			{ n: 4, keys: '', art: [[0, 0, 1, 1]] },
			{ n: 5, keys: b64([21, 22]), art: [] }
		],
		pictures: [{ id: 'p002', pages: [2], kind: 'part' }, { id: 'p003-004', pages: [3, 4], kind: 'spread' }]
	});
});

test('a text that does not line up leaves align-<base>.fail.json beside a complete analysis', async () => {
	const job = workJob();
	const r = await worker.runJob(job, { now: () => NOW, scanPdf: stubScan().scanPdf, align: stubAlign({ share: 0.3 }), runTool: () => {} });
	assert.strictEqual(r.ok, true);
	assert.deepStrictEqual(r.summary.align, { code: 'align-failed', textPages: 2, aligned: 2, share: 0.3, textWords: 70, placed: 0 });
	const out = pathMod.join(job.workDir, 'out');
	assert.deepStrictEqual(fs.readdirSync(out).sort(), [`align-${BASE}.fail.json`, 'index.json', 'p002.jpg', 'p003-004.jpg', 'pages.json']);
	assert.deepStrictEqual(readJson(out, `align-${BASE}.fail.json`), { version: 1, base: BASE, code: 'align-failed', share: 0.3, at: NOW });
});

test('a text that cannot be read leaves no alignment, and the analysis stands for an align job later', async () => {
	const job = workJob({ text: textOf(BASE, pathMod.join(TMP, 'no-such-cache')) });
	const align = stubAlign();
	const r = await worker.runJob(job, { now: () => NOW, scanPdf: stubScan().scanPdf, align, runTool: () => {} });
	assert.strictEqual(r.ok, true);
	assert.deepStrictEqual(r.summary.align, { code: 'io-error' });
	assert.deepStrictEqual(fs.readdirSync(pathMod.join(job.workDir, 'out')).sort(), ['index.json', 'p002.jpg', 'p003-004.jpg', 'pages.json']);
	assert.strictEqual(align.calls.ebookKeys.length, 0);
});

test('an alignment that throws is recorded as align-error, and its message never leaves the child', async () => {
	const job = workJob();
	const words = bookWords(40);
	const r = await worker.runJob(job, { now: () => NOW, scanPdf: stubScan().scanPdf, align: stubAlign({ throws: new Error(`${words.join(' ')} in C:\\secret\\book.txt`) }), runTool: () => {} });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.summary.align.code, 'align-error');
	assert.deepStrictEqual(readJson(job.workDir, 'out', `align-${BASE}.fail.json`), { version: 1, base: BASE, code: 'align-error', share: null, at: NOW });
	assert.deepStrictEqual(leaks(r, words), []);
	assert.ok(!JSON.stringify(r).includes('secret'));
});

test('a scan failure answers with its code, a stray error with its kind only, and leaves no index or tmp', async () => {
	const cases = [
		[Object.assign(new Error('pdftotext said C:\\secret\\x.pdf'), { code: 'pdf-damaged' }), { ok: false, code: 'pdf-damaged' }],
		[Object.assign(new Error('book pictures scan failed: crash, 9 of 264 pages lost in C:\\secret'), { code: 'crash' }), { ok: false, code: 'crash' }],
		[Object.assign(new Error('book pictures scan failed: pdf-encrypted C:\\secret\\x.pdf'), { code: 'pdf-encrypted' }), { ok: false, code: 'pdf-encrypted' }],
		[{ code: 'no-text-layer' }, { ok: false, code: 'no-text-layer' }],
		[new TypeError('Cannot read alpha of C:\\secret'), { ok: false, code: 'crash', message: 'TypeError' }],
		[Object.assign(new Error('ENOENT: no such file, open \'C:\\secret\\words.html\''), { code: 'ENOENT', syscall: 'open', path: 'C:\\secret\\words.html' }), { ok: false, code: 'io-error', message: 'Error ENOENT' }]
	];
	for (const [thrown, want] of cases) {
		const job = workJob();
		const r = await worker.runJob(job, { scanPdf: stubScan({ throws: thrown }).scanPdf, align: stubAlign(), runTool: () => {} });
		assert.deepStrictEqual(r, want);
		assert.deepStrictEqual(fs.readdirSync(pathMod.join(job.workDir, 'out')), []);
	}
});

test('a write that fails half-way is an io-error that leaves no tmp file and no index', async () => {
	const job = workJob();
	const rec = recordingFs({
		writeFileSync: (file, data) => {
			fs.writeFileSync(file, data);
			if (file.endsWith('index.json.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
		}
	});
	const r = await worker.runJob(job, { fs: rec.fs, scanPdf: stubScan().scanPdf, align: stubAlign(), runTool: () => {} });
	assert.deepStrictEqual(r, { ok: false, code: 'io-error', message: 'Error ENOSPC' });
	const left = fs.readdirSync(pathMod.join(job.workDir, 'out'));
	assert.deepStrictEqual(left.filter((f) => f.endsWith('.tmp') || f === 'index.json'), []);
});

test('a full job without its tools never starts the scan', async () => {
	const scan = stubScan();
	const r = await worker.runJob(workJob({ tools: { pdftotext: TOOLS.pdftotext } }), { scanPdf: scan.scanPdf, align: stubAlign(), runTool: () => {} });
	assert.strictEqual(r.code, 'tools-missing');
	assert.strictEqual(scan.calls.length, 0);
});

function keyDirWith(pagesJson, extraFiles = []) {
	const keyDir = newDir(KEY);
	fs.writeFileSync(pathMod.join(keyDir, 'pages.json'), JSON.stringify(pagesJson));
	for (const f of extraFiles) fs.writeFileSync(pathMod.join(keyDir, f), '{}');
	return keyDir;
}

const PAGES_JSON = () => ({
	version: 1,
	norm: 1,
	pdf: { fingerprint: null, pages: 3 },
	pages: [{ n: 1, keys: b64([5, 6, 7]), art: [] }, { n: 3, keys: b64([8]), art: [[0, 0, 1, 1]] }],
	pictures: [{ id: 'p002', pages: [2], kind: 'full' }, { id: 'bad id', pages: [1], kind: 'part' }]
});

test('an align job reads pages.json and the text by path, and writes its answer into the key folder', async () => {
	const keyDir = keyDirWith(PAGES_JSON(), [`align-${BASE}.fail.json`]);
	const text = writeText(newDir('cache'), BASE, [['c1', bookWords(12)]]);
	const align = stubAlign({ share: 0.9, words: [{ id: 'p999', word: 1, how: 'page-start' }, { id: 'p002', word: 4, how: 'next-text' }, { id: 'p002', word: 9, how: 'page-start' }, { id: 'p002', word: 12 }] });
	const rec = recordingFs();
	const r = await worker.runJob(alignJob(KEY, BASE, { keyDir, workDir: keyDir, text }), { fs: rec.fs, now: () => NOW, pid: 78, align });
	assert.deepStrictEqual(r, {
		ok: true,
		summary: { kind: 'align', pages: 3, pictures: 1, spreads: 0, textPages: 2, align: { code: 'ok', textPages: 2, aligned: 2, share: 0.9, textWords: 12, placed: 1 }, ms: r.summary.ms, pid: 78 }
	});
	assert.deepStrictEqual(rec.ops.filter(([op]) => op === 'read'), [['read', 'pages.json'], ['read', `${BASE}.json`], ['read', `${BASE}.txt`]]);
	assert.deepStrictEqual(writesOf(rec.ops), [['write', `align-${BASE}.json.tmp`], ['rename', `align-${BASE}.json.tmp`, `align-${BASE}.json`]]);
	assert.deepStrictEqual(fs.readdirSync(keyDir).sort(), [`align-${BASE}.json`, 'pages.json'], 'the old fail record for this text is gone');
	assert.deepStrictEqual(align.calls.alignPages[0].pageKeys.map((k) => Array.from(k)), [[5, 6, 7], [], [8]]);
	assert.deepStrictEqual(align.calls.pictureWords[0].pictures, [{ id: 'p002', pages: [2], kind: 'full' }]);
	assert.deepStrictEqual(readJson(keyDir, `align-${BASE}.json`).pictures, [{ id: 'p002', word: 4, how: 'next-text' }], 'an unknown id, a repeat and a word past the text are dropped');
});

test('a picture\'s fallback word reaches align-<base>.json only as a word of that text', async () => {
	const ids = ['p002', 'p003', 'p004', 'p005', 'p006', 'p007'];
	const keyDir = keyDirWith({ ...PAGES_JSON(), pictures: ids.map((id, i) => ({ id, pages: [i + 2], kind: 'full' })) });
	const text = writeText(newDir('cache'), BASE, [['c1', bookWords(12)]]);
	const words = [
		{ id: 'p002', word: 4, how: 'next-text', fallback: 3 },
		{ id: 'p003', word: 5, how: 'prev-end', fallback: 0 },
		{ id: 'p004', word: 6, how: 'next-text', fallback: 12 },
		{ id: 'p005', word: 7, how: 'next-text', fallback: -1 },
		{ id: 'p006', word: 8, how: 'next-text', fallback: 2.5 },
		{ id: 'p007', word: 9, how: 'next-text', fallback: '3' }
	];
	const r = await worker.runJob(alignJob(KEY, BASE, { keyDir, workDir: keyDir, text }), { now: () => NOW, align: stubAlign({ share: 0.9, words }) });
	assert.strictEqual(r.ok, true, JSON.stringify(r));
	assert.deepStrictEqual(readJson(keyDir, `align-${BASE}.json`).pictures, [
		{ id: 'p002', word: 4, how: 'next-text', fallback: 3 },
		{ id: 'p003', word: 5, how: 'prev-end', fallback: 0 },
		{ id: 'p004', word: 6, how: 'next-text' },
		{ id: 'p005', word: 7, how: 'next-text' },
		{ id: 'p006', word: 8, how: 'next-text' },
		{ id: 'p007', word: 9, how: 'next-text' }
	], 'one past the text\'s 12 words, a negative, a fraction and a string are dropped, and the picture kept');
});

test('an align job under the share writes the fail record and drops an old alignment for that text', async () => {
	const keyDir = keyDirWith(PAGES_JSON(), [`align-${BASE}.json`]);
	const text = writeText(newDir('cache'), BASE, [['c1', bookWords(12)]]);
	const r = await worker.runJob(alignJob(KEY, BASE, { keyDir, workDir: keyDir, text }), { now: () => NOW, align: stubAlign({ share: 0.3 }) });
	assert.deepStrictEqual(r, { ok: false, code: 'align-failed', message: 'share 0.3' });
	assert.deepStrictEqual(fs.readdirSync(keyDir).sort(), [`align-${BASE}.fail.json`, 'pages.json']);
	assert.deepStrictEqual(readJson(keyDir, `align-${BASE}.fail.json`), { version: 1, base: BASE, code: 'align-failed', share: 0.3, at: NOW });
});

test('an align job refuses pages.json from another version or token rule, or none at all', async () => {
	const text = writeText(newDir('cache'), BASE, [['c1', bookWords(12)]]);
	for (const over of [{ version: 2 }, { norm: 2 }, { pages: [{ n: 0, keys: '' }] }, { pdf: { pages: 1e9 } }]) {
		const keyDir = keyDirWith({ ...PAGES_JSON(), ...over });
		const align = stubAlign();
		const r = await worker.runJob(alignJob(KEY, BASE, { keyDir, workDir: keyDir, text }), { align });
		assert.deepStrictEqual(r, { ok: false, code: 'io-error', message: 'pages.json is damaged or from another version' }, JSON.stringify(over));
		assert.deepStrictEqual(fs.readdirSync(keyDir), ['pages.json']);
		assert.strictEqual(align.calls.ebookKeys.length, 0);
	}
	const empty = newDir(KEY);
	assert.deepStrictEqual(await worker.runJob(alignJob(KEY, BASE, { keyDir: empty, workDir: empty, text }), { align: stubAlign() }), { ok: false, code: 'io-error', message: 'Error ENOENT' });
	assert.deepStrictEqual(await worker.runJob(alignJob(KEY, BASE, { keyDir: newDir(KEY), workDir: empty, text }), { align: stubAlign(), fs: { ...fs, readFileSync: () => '{not json' } }), { ok: false, code: 'io-error', message: 'SyntaxError' });
});

test('the child sends progress at each stage boundary, at a stage\'s last step, and at most every 500 ms', () => {
	const sent = [];
	let t = 0;
	const send = worker._progressSender((m) => sent.push(m), () => t);
	send({ stage: 'text', done: 0, total: 1 });
	t = 100;
	send({ stage: 'text', done: 1, total: 1 });
	t = 200;
	send({ stage: 'render', done: 1, total: 264 });
	t = 300;
	send({ stage: 'render', done: 2, total: 264 });
	t = 750;
	send({ stage: 'render', done: 3, total: 264, line: 'Mr and Mrs Dursley' });
	t = 800;
	send({ stage: 'render', done: 264, total: 264 });
	send(null);
	send({ stage: 5 });
	assert.deepStrictEqual(sent, [
		{ type: 'progress', stage: 'text', done: 0, total: 1 },
		{ type: 'progress', stage: 'text', done: 1, total: 1 },
		{ type: 'progress', stage: 'render', done: 1, total: 264 },
		{ type: 'progress', stage: 'render', done: 3, total: 264 },
		{ type: 'progress', stage: 'render', done: 264, total: 264 }
	]);
	const quiet = worker._progressSender(() => { throw new Error('channel closed'); });
	assert.doesNotThrow(() => quiet({ stage: 'text', done: 0, total: 1 }));
});

test('no message between the queue and the child carries a word of the book', async () => {
	const words = bookWords(400, 11);
	const text = writeText(newDir('cache'), BASE, [['c1', words.slice(0, 200)], ['c2', words.slice(200)]]);
	const workDir = newDir(`${KEY}.work`);
	const wire = [];
	// The child's side exactly as runChild builds it: runJob, the progress sender, the result.
	const onSend = (c, job) => {
		const send = (m) => {
			wire.push(m);
			c.emit('message', m);
		};
		const align = {
			...stubAlign(),
			pictureWords: (pictures) => pictures.map((p, i) => ({ id: p.id, word: i * 7, how: 'page-start' }))
		};
		worker.runJob(job, {
			now: () => NOW,
			scanPdf: stubScan({ progress: { stage: 'render', done: 1, total: 5, line: words.slice(0, 9).join(' '), words: words.slice(0, 20) } }).scanPdf,
			align,
			runTool: () => {},
			onProgress: worker._progressSender(send)
		}).then((res) => {
			send({ type: 'result', ...res });
			c.close(0);
		});
	};
	const h = harness({ forkOpts: { onSend } });
	try {
		const seen = [];
		const r = await worker.run(fullJob(KEY, { workDir, pdfPath: pathMod.join(workDir, 'book.pdf'), text }), { onProgress: (p) => seen.push(p) });
		assert.strictEqual(r.ok, true, JSON.stringify(r));
		assert.ok(wire.some((m) => m.type === 'progress') && wire.some((m) => m.type === 'result'));
		assert.deepStrictEqual(leaks(h.children[0].sent, words), [], 'the job');
		assert.deepStrictEqual(leaks(wire, words), [], 'the child\'s messages');
		assert.deepStrictEqual(leaks([seen, r], words), [], 'what the caller gets');
	} finally {
		h.done();
	}
});

// --- real children -------------------------------------------------------------------------------

function realDeps() {
	const fakeOs = recordingOs();
	const raw = [];
	const sentJobs = [];
	const restore = worker._setDeps({
		os: fakeOs,
		logger: spyLogger(),
		fork: (...args) => {
			const c = cp.fork(...args);
			const send = c.send.bind(c);
			c.send = (m, ...rest) => {
				sentJobs.push(m);
				return send(m, ...rest);
			};
			c.on('message', (m) => raw.push(m));
			return c;
		}
	});
	return {
		os: fakeOs,
		raw,
		sentJobs,
		done: () => {
			worker.shutdown();
			restore();
		}
	};
}

test('a real child answers over IPC and exits, after being set to Below Normal', async () => {
	const real = realDeps();
	try {
		const keyDir = newDir(KEY);
		const text = writeText(newDir('cache'), BASE, [['c1', bookWords(12)]]);
		const r = await worker.run(alignJob(KEY, BASE, { keyDir, workDir: keyDir, text }));
		assert.deepStrictEqual(r, { ok: false, code: 'io-error', message: 'Error ENOENT' });
		assert.strictEqual(real.os.calls.length, 1);
		const [[pid, prio]] = real.os.calls;
		assert.ok(pid > 0 && pid !== process.pid);
		assert.strictEqual(prio, BELOW_NORMAL);
		assert.deepStrictEqual(real.raw, [{ type: 'result', ok: false, code: 'io-error', message: 'Error ENOENT' }]);
		assert.strictEqual(worker.busy(), false);
	} finally {
		real.done();
	}
});

// A path as it appears inside serialised JSON, backslashes doubled.
const inJson = (value, text) => JSON.stringify(value).includes(JSON.stringify(text).slice(1, -1));

// A full job on a fake PDF, read by a real child with the real scan: run()'s answer and every
// message that crossed the channel.
async function realFull(spec, tools = fakeTools()) {
	const workDir = newDir(`${KEY} work & 'odd'`);
	const pdfPath = writeFakePdf(pathMod.join(workDir, 'book.pdf'), spec);
	const real = realDeps();
	try {
		const r = await worker.run({ kind: 'full', key: KEY, workDir, keyDir: pathMod.join(TMP, KEY), pdfPath, tools, limits: LIMITS, fingerprint: 'calibre:Fake:1:pdf:2:m' });
		return { r, raw: real.raw, workDir };
	} finally {
		real.done();
	}
}

function assertFailedWith(got, code) {
	assert.deepStrictEqual(got.r, { ok: false, code, message: '' });
	assert.deepStrictEqual(got.raw.filter((m) => m.type === 'result'), [{ type: 'result', ok: false, code }], 'the child answers with the code alone');
	assert.ok(!inJson(got.raw, got.workDir) && !JSON.stringify(got.raw).includes('book.pdf'), `a path crossed back: ${JSON.stringify(got.raw)}`);
	assert.deepStrictEqual(fs.readdirSync(pathMod.join(got.workDir, 'out')), [], 'no picture, no pages.json and no index.json to install');
	assert.deepStrictEqual(fs.readdirSync(got.workDir).sort(), ['book.pdf', 'out'], 'the word boxes are gone too');
}

test('an encrypted PDF comes back from a real child as its code alone', async () => {
	assertFailedWith(await realFull({ mode: 'encrypted', pages: [textPage(bookWords(150, 31))] }), 'pdf-encrypted');
});

// The scan fails a read that lost more renders and encodes than max(3, 2% of its pages), or that
// found art and wrote no picture of it: a strike for the parent, not an empty analysis installed
// as "no pictures".
test('a read that lost every render, or every picture\'s encode, comes back from a real child as a crash', async () => {
	const words = bookWords(750, 33);
	const pages = [0, 1, 2, 3, 4].map((i) => textPage(words.slice(i * 150, (i + 1) * 150)));
	assertFailedWith(await realFull({ pages, failPages: [1, 2, 3, 4, 5] }), 'crash');
	const ffmpegSpec = writeFakePdf(pathMod.join(newDir('ffmpeg'), 'ffmpeg.json'), { mode: 'damaged' });
	assertFailedWith(await realFull({ pages: [pages[0], artPage(), pages[1]] }, fakeTools({ ffmpegSpec })), 'crash');
});

// A folio at the foot of a page, where the scan reads printed page numbers.
const withFolio = (page, printed) => ({ ...page, lines: [...page.lines, { box: [270, 655, 290, 667], words: [String(printed)] }] });

test('a book end to end: a real child reads a fake PDF with the real scan and alignment, then lines it up with another text', async () => {
	const words = bookWords(600, 21);
	const cache = newDir('cache');
	const text = writeText(cache, BASE, [['c1', words.slice(0, 300)], ['c2', words.slice(300)]]);
	const workDir = newDir(`${KEY} work & 'odd' %PATH% ^x`);
	const argvFile = pathMod.join(cache, 'tool-calls.jsonl');
	// Printed page n - 1, with no folio on the chapter's opening page, as print books do.
	const pdfPath = writeFakePdf(pathMod.join(workDir, 'book.pdf'), {
		argvFile,
		pages: [
			textPage(words.slice(0, 150)),
			withFolio(textPage(words.slice(150, 300), { art: [{ box: [0.1, 0.6, 0.9, 0.85], rgb: [40, 90, 160] }] }), 1),
			artPage({ rgb: [150, 60, 40] }),
			artPage({ rgb: [150, 60, 40] }),
			withFolio(textPage(words.slice(300, 450)), 4),
			artPage({ rgb: [30, 120, 60] }),
			withFolio(textPage(words.slice(450, 600)), 6)
		]
	});
	const real = realDeps();
	try {
		const progress = [];
		const r = await worker.run({
			kind: 'full', key: KEY, workDir, keyDir: pathMod.join(workDir, '..', KEY), pdfPath, text, tools: fakeTools(), limits: LIMITS, fingerprint: 'calibre:Fake:1:pdf:2:m'
		}, { onProgress: (p) => progress.push(p) });
		assert.strictEqual(r.ok, true, JSON.stringify(r));
		assert.deepStrictEqual([r.summary.pages, r.summary.pictures, r.summary.spreads, r.summary.textPages], [7, 3, 1, 4]);
		assert.deepStrictEqual([r.summary.align.code, r.summary.align.placed, r.summary.align.share, r.summary.align.textWords], ['ok', 3, 1, 600]);
		const stages = new Set(progress.map((p) => p.stage));
		assert.ok(stages.has('text') && stages.has('render') && stages.has('align'), [...stages].join());

		const out = pathMod.join(workDir, 'out');
		assert.deepStrictEqual(fs.readdirSync(out).sort(), [`align-${BASE}.json`, 'index.json', 'p002.jpg', 'p003-004.jpg', 'p006.jpg', 'pages.json']);
		assert.deepStrictEqual(fs.readdirSync(workDir).sort(), ['book.pdf', 'out'], 'the word boxes were deleted once read');
		const index = readJson(out, 'index.json');
		assert.deepStrictEqual(index.pictures.map((p) => [p.id, p.kind, p.pages]), [['p002', 'part', [2]], ['p003-004', 'spread', [3, 4]], ['p006', 'full', [6]]]);
		assert.deepStrictEqual(index.pictures.find((p) => p.id === 'p003-004').width, 1956);
		assert.deepStrictEqual([index.folioOffset, index.summary.skipped, index.summary.encodeFailed], [1, 0, 0], 'the folio offset the scan read, and nothing lost');
		// A full page shows with the text after it, and falls back to the end of the page before it
		// for a narration that never reaches that text.
		assert.deepStrictEqual(readJson(out, `align-${BASE}.json`).pictures, [
			{ id: 'p002', word: 150, how: 'page-start' },
			{ id: 'p003-004', word: 300, how: 'next-text', fallback: 299 },
			{ id: 'p006', word: 450, how: 'next-text', fallback: 449 }
		]);
		assert.deepStrictEqual(leaks(real.raw, words), []);
		assert.deepStrictEqual(leaks(real.sentJobs, words), []);
		const calls = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
		assert.deepStrictEqual(calls.map((c) => c.tool), ['pdftotext', ...Array(7).fill('pdftoppm')]);
		for (const c of calls) {
			assert.ok(c.argv.includes(pdfPath), `the PDF path as one argument: ${JSON.stringify(c.argv)}`);
			assert.strictEqual(c.cwd.toLowerCase(), workDir.toLowerCase());
		}

		// Another edition of the text with a foreword: the pictures move with its numbering, and the
		// PDF is not read again.
		const front = bookWords(50, 99);
		const other = writeText(cache, 'aaaaaaaaaaaaaaaa', [['foreword', front], ['c1', words.slice(0, 300)], ['c2', words.slice(300)]]);
		const again = await worker.run({ kind: 'align', key: KEY, workDir: out, keyDir: out, text: other, tools: null, limits: LIMITS });
		assert.strictEqual(again.ok, true, JSON.stringify(again));
		assert.deepStrictEqual(readJson(out, 'align-aaaaaaaaaaaaaaaa.json').pictures.map((p) => ('fallback' in p ? [p.word, p.fallback] : [p.word])), [[200], [350, 349], [500, 499]]);
		const unrelated = writeText(cache, 'bbbbbbbbbbbbbbbb', [['c1', bookWords(600, 5)]]);
		assert.deepStrictEqual(await worker.run({ kind: 'align', key: KEY, workDir: out, keyDir: out, text: unrelated, tools: null, limits: LIMITS }), { ok: false, code: 'align-failed', message: 'share 0' });
		assert.strictEqual(readJson(out, 'align-bbbbbbbbbbbbbbbb.fail.json').code, 'align-failed');
		assert.deepStrictEqual(fs.readdirSync(out).filter((f) => f.endsWith('.tmp')), []);
		assert.strictEqual(real.os.calls.length, 3, 'each child at Below Normal');
	} finally {
		real.done();
	}
});
