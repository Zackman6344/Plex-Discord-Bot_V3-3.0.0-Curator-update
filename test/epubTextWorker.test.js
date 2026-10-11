// helpers/epubTextWorker.js: the queue that parses EPUBs in a Below-Normal child process.
//
// The bug: parsing a 115 MB EPUB on the bot's own thread (or in a worker thread of the bot's own
// process) stalls or demotes the 20 ms voice timer and the audiobook stutters. Around the child
// itself: an index written before its text, so a crash leaves an index pointing at nothing; tmp
// files left behind; a DRM book re-parsed on every start because no fail record was kept; two
// 100 MB parses in memory at once; the same book parsed twice when two listeners ask together; a
// hung child holding the queue forever; a crash reported as success; !restart killing the queue
// for good; a host that refuses the priority change taking the parse down with it; and book text
// crossing back to the main thread in the reply.
//
// Harness: real forked children for the end-to-end cases (a real `node` process parses an EPUB
// built by test/helpers/epubFixture.js into a pid-suffixed temp dir). The queue cases swap in a
// fake fork through _setDeps, with EventEmitter children the test answers, exits or leaves
// hanging. runJob runs in-process with a recording fs to see the order of writes and renames.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const TMP = pathMod.join(os.tmpdir(), `plexbot-test-epubtextworker-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${TMP}-logs`;

const worker = require('../helpers/epubTextWorker.js');
const epubText = require('../helpers/epubText.js');
const fx = require('./helpers/epubFixture.js');

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;

fs.mkdirSync(TMP, { recursive: true });

test.after(() => {
	worker.shutdown();
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(`${TMP}-logs`, { recursive: true, force: true });
});

let fileNo = 0;
function bookFile(extra = []) {
	const file = pathMod.join(TMP, `book-${++fileNo}.epub`);
	fx.writeEpub(file, fx.chapterBook({
		tocFormat: 'ncx',
		chapters: [
			{ label: 'Prologue', paragraphs: fx.paragraphs(3, 12, 0) },
			{ label: 'Chapter 1', paragraphs: fx.paragraphs(4, 9, 3) }
		],
		extra
	}));
	return file;
}

function outDir(name) {
	const dir = pathMod.join(TMP, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function spyLogger() {
	const lines = [];
	const log = level => (...args) => lines.push([level, args.join(' ')]);
	return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

function recordingOs() {
	const calls = [];
	return { calls, constants: os.constants, setPriority: (pid, value) => { calls.push([pid, value]); } };
}

function fakeFork() {
	const children = [];
	const fork = (...args) => {
		const c = new EventEmitter();
		c.pid = 4000 + children.length;
		c.args = args;
		c.sent = [];
		c.killed = false;
		c.send = msg => { c.sent.push(msg); };
		c.kill = () => {
			c.killed = true;
			setImmediate(() => c.emit('close', null, 'SIGTERM'));
			return true;
		};
		// Like a real child: answer, then exit by itself once the answer is flushed.
		c.answer = msg => {
			c.emit('message', msg);
			setImmediate(() => {
				c.emit('exit', 0, null);
				c.emit('close', 0, null);
			});
		};
		children.push(c);
		return c;
	};
	return { fork, children };
}

// Every swap starts from an idle queue, so a real child still exiting from an earlier test
// cannot hold the slot a fake one is expected in.
function freshDeps(over) {
	worker.shutdown();
	return worker._setDeps(over);
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const okSummary = pid => ({ ok: true, summary: { sections: 2, totalWords: 75, textBytes: 400, title: 'T', tocSource: 'ncx', ms: 5, pid } });

test('a real parse child writes the text and its index and answers with counts only', async () => {
	const dir = outDir('real');
	const source = { type: 'file', path: 'X:/fake/book.epub', size: 1, mtimeMs: 2, fingerprint: 'file:X:/fake/book.epub:1:2' };
	const result = await worker.parseEpub({ input: { path: bookFile() }, outDir: dir, base: '0123456789abcdef', source });
	assert.strictEqual(result.ok, true, JSON.stringify(result));
	assert.ok(result.summary.pid > 0);
	assert.notStrictEqual(result.summary.pid, process.pid);
	assert.strictEqual(result.summary.sections, 2);
	assert.strictEqual(result.summary.totalWords, 1 + 36 + 2 + 36);
	assert.strictEqual(result.summary.tocSource, 'ncx');
	const reply = JSON.stringify(result).toLowerCase();
	for (const word of fx.WORDS) assert.ok(!reply.includes(word), `the reply carries "${word}"`);

	assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['0123456789abcdef.json', '0123456789abcdef.txt']);
	const index = JSON.parse(fs.readFileSync(pathMod.join(dir, '0123456789abcdef.json'), 'utf8'));
	assert.strictEqual(index.version, worker.VERSION);
	assert.strictEqual(index.textFile, '0123456789abcdef.txt');
	assert.deepStrictEqual(index.source, source);
	const text = fs.readFileSync(pathMod.join(dir, '0123456789abcdef.txt'));
	assert.strictEqual(text.length, index.textBytes);
	const s1 = index.sections[1];
	assert.strictEqual(text.subarray(s1.byteStart, s1.byteStart + s1.byteLen).toString('utf8'), ['Chapter 1', ...fx.paragraphs(4, 9, 3)].join('\n'));
});

test('the version the queue reports is the extractor version', () => {
	assert.strictEqual(worker.VERSION, epubText.EXTRACTOR_VERSION);
	assert.strictEqual(worker.parseEpub.VERSION, epubText.EXTRACTOR_VERSION);
});

test('a drm-locked book leaves a fail record and no text', async () => {
	const dir = outDir('drm');
	const source = { type: 'calibre', id: 7, fingerprint: 'calibre:L:7:10:m' };
	const result = await worker.parseEpub({ input: { path: bookFile([{ name: 'META-INF/rights.xml', data: '<r/>' }]) }, outDir: dir, base: 'drmbase', source });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 'drm');
	assert.deepStrictEqual(fs.readdirSync(dir), ['drmbase.fail.json']);
	const fail = JSON.parse(fs.readFileSync(pathMod.join(dir, 'drmbase.fail.json'), 'utf8'));
	assert.strictEqual(fail.version, epubText.EXTRACTOR_VERSION);
	assert.strictEqual(fail.fingerprint, 'calibre:L:7:10:m');
	assert.strictEqual(fail.code, 'drm');
	assert.strictEqual(typeof fail.at, 'number');
});

test('the child commits the text before the index', () => {
	const dir = outDir('order');
	const ops = [];
	const recording = {
		...fs,
		writeFileSync: (file, data) => { ops.push(['write', pathMod.basename(file)]); return fs.writeFileSync(file, data); },
		renameSync: (from, to) => { ops.push(['rename', pathMod.basename(from), pathMod.basename(to)]); return fs.renameSync(from, to); }
	};
	const result = worker.runJob({ input: { path: bookFile() }, outDir: dir, base: 'orderbase', source: null }, { fs: recording, now: () => 9 });
	assert.strictEqual(result.ok, true);
	assert.deepStrictEqual(ops, [
		['write', 'orderbase.txt.tmp'],
		['rename', 'orderbase.txt.tmp', 'orderbase.txt'],
		['write', 'orderbase.json.tmp'],
		['rename', 'orderbase.json.tmp', 'orderbase.json']
	]);
	assert.strictEqual(JSON.parse(fs.readFileSync(pathMod.join(dir, 'orderbase.json'), 'utf8')).builtAt, 9);
});

test('a write that fails half-way leaves no tmp file and no fail record', () => {
	const dir = outDir('enospc');
	const failing = {
		...fs,
		writeFileSync: (file, data) => {
			fs.writeFileSync(file, data);
			if (file.endsWith('.json.tmp')) {
				const err = new Error('ENOSPC: no space left on device, write');
				err.code = 'ENOSPC';
				err.syscall = 'write';
				throw err;
			}
		}
	};
	const result = worker.runJob({ input: { path: bookFile() }, outDir: dir, base: 'fullbase', source: null }, { fs: failing });
	assert.deepStrictEqual(result, { ok: false, code: 'io-error', message: 'Error ENOSPC' });
	const left = fs.readdirSync(dir);
	assert.deepStrictEqual(left.filter(f => f.endsWith('.tmp') || f.endsWith('.json')), []);
});

test('a missing file is an io-error whose message names no path', () => {
	const dir = outDir('missing');
	const gone = pathMod.join(TMP, 'secret-folder', 'not-here.epub');
	const result = worker.runJob({ input: { path: gone }, outDir: dir, base: 'gonebase', source: null });
	assert.strictEqual(result.code, 'io-error');
	assert.ok(!result.message.includes('secret-folder'), result.message);
	assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a file that is not an epub leaves a fail record with its code', () => {
	const dir = outDir('notzip');
	const file = pathMod.join(TMP, 'plain.epub');
	fs.writeFileSync(file, 'just some words in a text file');
	const result = worker.runJob({ input: { path: file }, outDir: dir, base: 'plainbase', source: { fingerprint: 'fp' } });
	assert.strictEqual(result.code, 'not-zip');
	assert.strictEqual(JSON.parse(fs.readFileSync(pathMod.join(dir, 'plainbase.fail.json'), 'utf8')).code, 'not-zip');
});

test('a job with an unsafe base or no path is refused without forking', async () => {
	const { fork, children } = fakeFork();
	const restore = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	try {
		const a = await worker.parseEpub({ input: { path: 'x.epub' }, outDir: TMP, base: '../escape', source: null });
		const b = await worker.parseEpub({ input: {}, outDir: TMP, base: 'fine', source: null });
		assert.strictEqual(a.code, 'bad-job');
		assert.strictEqual(b.code, 'bad-job');
		assert.strictEqual(children.length, 0);
	} finally {
		restore();
	}
});

test('jobs run one child at a time in arrival order', async () => {
	const { fork, children } = fakeFork();
	const restore = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	try {
		const job = base => worker.parseEpub({ input: { path: `${base}.epub` }, outDir: TMP, base, source: { fingerprint: base } });
		const pA = job('aaaa');
		const pB = job('bbbb');
		const pC = job('cccc');
		assert.strictEqual(children.length, 1);
		assert.deepStrictEqual(children[0].sent, [{ input: { path: 'aaaa.epub' }, outDir: TMP, base: 'aaaa', source: { fingerprint: 'aaaa' } }]);
		assert.deepStrictEqual(children[0].args[1], [worker.CHILD_FLAG]);
		assert.deepStrictEqual(children[0].args[2].execArgv, ['--max-old-space-size=768']);
		assert.deepStrictEqual(children[0].args[2].stdio, ['ignore', 'ignore', 'ignore', 'ipc']);

		children[0].answer(okSummary(4000));
		assert.deepStrictEqual(await pA, okSummary(4000));
		assert.strictEqual(children.length, 1, 'the next child waits for the first to be gone');
		await tick();
		assert.strictEqual(children.length, 2);
		assert.strictEqual(children[1].sent[0].base, 'bbbb');

		children[1].emit('close', 3, null);
		assert.deepStrictEqual(await pB, { ok: false, code: 'crash', message: 'exit 3' });
		assert.strictEqual(children.length, 3);
		assert.strictEqual(children[2].sent[0].base, 'cccc');
		children[2].answer({ ok: false, code: 'drm', message: 'drm: rights.xml' });
		assert.deepStrictEqual(await pC, { ok: false, code: 'drm', message: 'drm: rights.xml' });
	} finally {
		worker.shutdown();
		restore();
	}
});

test('a second job for the same base shares the first one\'s result', async () => {
	const { fork, children } = fakeFork();
	const restore = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	try {
		const p1 = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'samebase', source: null });
		const p2 = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'samebase', source: null });
		assert.strictEqual(p1, p2);
		children[0].answer(okSummary(4000));
		await p1;
		await tick();
		assert.strictEqual(children.length, 1);
		const p3 = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'samebase', source: null });
		assert.notStrictEqual(p3, p1, 'a finished job is not reused');
		assert.strictEqual(children.length, 2);
	} finally {
		worker.shutdown();
		restore();
	}
});

test('a child that never answers is killed at the timeout and the queue moves on', async () => {
	const { fork, children } = fakeFork();
	const restore = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	try {
		const pA = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'hang', source: null, timeoutMs: 30 });
		const pB = worker.parseEpub({ input: { path: 'b.epub' }, outDir: TMP, base: 'next', source: null });
		assert.deepStrictEqual(await pA, { ok: false, code: 'timeout', message: 'no answer in 30 ms' });
		assert.strictEqual(children[0].killed, true);
		await tick();
		assert.strictEqual(children.length, 2);
		children[1].answer(okSummary(4001));
		assert.strictEqual((await pB).ok, true);
	} finally {
		worker.shutdown();
		restore();
	}
});

test('a child that cannot be forked or errors out is a crash', async () => {
	const restore = freshDeps({
		fork: () => { const err = new Error('spawn EAGAIN'); err.code = 'EAGAIN'; throw err; },
		os: recordingOs(),
		logger: spyLogger()
	});
	try {
		const r = await worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'nofork', source: null });
		assert.deepStrictEqual(r, { ok: false, code: 'crash', message: 'fork failed (EAGAIN)' });
	} finally {
		restore();
	}
	const { fork, children } = fakeFork();
	const restore2 = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	try {
		const p = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'errs', source: null });
		children[0].emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
		assert.deepStrictEqual(await p, { ok: false, code: 'crash', message: 'child error (ENOENT)' });
	} finally {
		worker.shutdown();
		restore2();
	}
});

test('shutdown fails the running and queued jobs and a later parse still works', async () => {
	const { fork, children } = fakeFork();
	const restore = freshDeps({ fork, os: recordingOs(), logger: spyLogger() });
	let pA;
	let pB;
	try {
		pA = worker.parseEpub({ input: { path: 'a.epub' }, outDir: TMP, base: 'restartbase', source: null });
		pB = worker.parseEpub({ input: { path: 'b.epub' }, outDir: TMP, base: 'queued', source: null });
		worker.shutdown();
		assert.deepStrictEqual(await pA, { ok: false, code: 'shutdown', message: 'bot shutting down' });
		assert.deepStrictEqual(await pB, { ok: false, code: 'shutdown', message: 'bot shutting down' });
		assert.strictEqual(children[0].killed, true);
		assert.strictEqual(children.length, 1, 'the queued job never started');
	} finally {
		restore();
	}
	const dir = outDir('after-shutdown');
	const again = await worker.parseEpub({ input: { path: bookFile() }, outDir: dir, base: 'restartbase', source: null });
	assert.strictEqual(again.ok, true, JSON.stringify(again));
	assert.notStrictEqual(again.summary.pid, process.pid);
});

test('the child is set to below normal priority', async () => {
	const fakeOs = recordingOs();
	const restore = freshDeps({ os: fakeOs, logger: spyLogger() });
	try {
		const result = await worker.parseEpub({ input: { path: bookFile() }, outDir: outDir('priority'), base: 'prio', source: null });
		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(fakeOs.calls, [[result.summary.pid, BELOW_NORMAL]]);
	} finally {
		restore();
	}
});

test('a refused priority change is tolerated and warned once with its code only', async () => {
	const logger = spyLogger();
	const refusing = {
		constants: os.constants,
		setPriority: () => { const err = new Error('A system error occurred: uv_os_setpriority returned EPERM'); err.code = 'EPERM'; throw err; }
	};
	const restore = freshDeps({ os: refusing, logger });
	try {
		const dir = outDir('refused');
		const file = bookFile();
		const r1 = await worker.parseEpub({ input: { path: file }, outDir: dir, base: 'refused1', source: null });
		const r2 = await worker.parseEpub({ input: { path: file }, outDir: dir, base: 'refused2', source: null });
		assert.strictEqual(r1.ok, true);
		assert.strictEqual(r2.ok, true);
		assert.deepStrictEqual(logger.lines, [['warn', 'Could not lower the ebook parser\'s priority (EPERM); it runs at Normal.']]);
	} finally {
		restore();
	}
});
