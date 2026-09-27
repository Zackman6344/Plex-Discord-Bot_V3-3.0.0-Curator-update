// Finding what the logic worker needs, talking to it, and keeping exactly one of it running.
//
// None of this fails loudly. A seed zip that is not found or a worker that dies ends in
// `!ap next` quietly answering from sphere 1; a reply taken for another request's ends in it
// quietly answering wrong; a second startup costs another half gigabyte and another minute of
// Python. So each step is pinned down on its own: the disk lookups against temp folders laid out
// like an Archipelago install, LogicWorker against test/helpers/fakeLogicWorker.js (which speaks
// the real worker's JSON-lines protocol), and acquire() with its _deps pointed at that fake.
//
// Every fake appends its pid to a file, and afterEach waits for all of them to be gone, so a test
// that leaves a process behind fails there rather than slowing down the rest of the suite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../config/config.js');
const logger = require('../helpers/logger.js');
const logic = require('../helpers/archipelagoLogic.js');

const FAKE = path.join(__dirname, 'helpers', 'fakeLogicWorker.js');
const SPAWNS = path.join(os.tmpdir(), `plexbot-test-logic-spawns-${process.pid}.txt`);
process.env.FAKE_LOGIC_WORKER_SPAWNS = SPAWNS;

const REAL_DEPS = { ...logic._deps };
const REAL_INSTALL_DIR = config.archipelagoInstallDir;
const REAL_PYTHON = config.archipelagoPython;

// Real names and numbers are twenty digits; these have the same shape.
const SEED_NAME = '51632394463281032748';
const SEED = '31755677627148142336';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Captured rather than printed: several cases fail on purpose, and for a startup the log is the
// only place some of what happened shows.
const logged = [];
const realLog = { info: logger.info, warn: logger.warn };
logger.info = (...parts) => logged.push(parts.join(' '));
logger.warn = (...parts) => logged.push(parts.join(' '));

const tempDirs = [];
function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexbot-test-logic-'));
    tempDirs.push(dir);
    return dir;
}

function generateLog(seedName, seed, players = 3) {
    return [
        'Archipelago (0.6.7) logging initialized on Windows-11-10.0.26200-SP0 with Python 3.13.1',
        ...Array.from({ length: players }, (_, i) => `Player${i + 1}.yaml read`),
        `Generating for ${players} players, ${seedName} Seed ${seed} with plando: bosses, items, texts, connections`,
        'Creating World.',
        ''
    ].join('\r\n');
}

/** A folder laid out like an Archipelago install, with only the parts asked for. */
function fakeInstall({ dll = 'python313.dll', logs = null, multidataFor = null } = {}) {
    const dir = tempDir();
    if (dll) fs.writeFileSync(path.join(dir, dll), '');
    if (logs) {
        fs.mkdirSync(path.join(dir, 'logs'));
        for (const [name, text] of Object.entries(logs)) fs.writeFileSync(path.join(dir, 'logs', name), text);
    }
    if (multidataFor) {
        fs.mkdirSync(path.join(dir, 'output'));
        fs.writeFileSync(path.join(dir, 'output', `AP_${multidataFor}.zip`), '');
    }
    return dir;
}

function spawnedPids() {
    try {
        return fs.readFileSync(SPAWNS, 'utf8').split('\n').filter(Boolean).map(Number);
    } catch (_) {
        return [];
    }
}

function running(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

async function waitUntil(check, what, ms = 4000) {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(15);
    }
}

const direct = [];
function startFake(mode, extra = []) {
    const worker = new logic.LogicWorker({ command: process.execPath, args: [FAKE, '--mode', mode, ...extra], label: 'test' });
    direct.push(worker);
    return worker.start();
}

function located(apDir, seedName) {
    return {
        ok: true,
        apDir,
        seed: SEED,
        seedName,
        multidata: path.join(apDir, 'output', `AP_${seedName}.zip`),
        pythonVersion: '3.13'
    };
}

/**
 * Points acquire() at the fake in the given mode, with a stub install that always has the seed.
 * @returns {{locate: Array, python: Array}} every call the stubs saw
 */
function useFake(mode, { locate = located, python = () => ({ ok: true, command: process.execPath }) } = {}) {
    process.env.FAKE_LOGIC_WORKER_MODE = mode;
    const calls = { locate: [], python: [] };
    logic._deps.workerScript = FAKE;
    logic._deps.pythonFlags = [];
    logic._deps.locateSeed = async (apDir, seedName) => {
        calls.locate.push([apDir, seedName]);
        return locate(apDir, seedName);
    };
    logic._deps.resolvePython = async (version) => {
        calls.python.push(version);
        return python(version);
    };
    return calls;
}

test.beforeEach(() => {
    logged.length = 0;
    config.archipelagoInstallDir = 'C:\\ProgramData\\Archipelago';
    config.archipelagoPython = '';
});

test.afterEach(async () => {
    for (const worker of direct.splice(0)) worker.kill();
    logic._reset();
    Object.assign(logic._deps, REAL_DEPS);
    config.archipelagoInstallDir = REAL_INSTALL_DIR;
    config.archipelagoPython = REAL_PYTHON;
    delete process.env.FAKE_LOGIC_WORKER_MODE;
    // _reset() only asks a worker to finish, and one still starting is not killed for two
    // seconds; waiting here keeps each test's processes inside that test.
    const pids = spawnedPids();
    await waitUntil(() => pids.every(pid => !running(pid)), 'every fake worker to exit');
    fs.rmSync(SPAWNS, { force: true });
});

test.after(() => {
    Object.assign(logger, realLog);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --- frozenPythonVersion ---------------------------------------------------------------------

test('frozenPythonVersion reads the minor version off the python3XX.dll beside the install', async () => {
    const dir = tempDir();
    for (const name of ['python3.dll', 'python313.dll', 'vcruntime140.dll', 'ArchipelagoGenerate.exe']) {
        fs.writeFileSync(path.join(dir, name), '');
    }
    assert.strictEqual(await logic.frozenPythonVersion(dir), '3.13');
});

test('frozenPythonVersion ignores python3.dll, which names no minor version', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'python3.dll'), '');
    assert.strictEqual(await logic.frozenPythonVersion(dir), null);
});

test('a two-digit minor version stays two digits, whatever the case of the file name', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'Python310.DLL'), '');
    assert.strictEqual(await logic.frozenPythonVersion(dir), '3.10');
});

test('frozenPythonVersion answers null for a folder that is not there', async () => {
    assert.strictEqual(await logic.frozenPythonVersion(path.join(tempDir(), 'missing')), null);
});

// --- findSeedNumber --------------------------------------------------------------------------

test('findSeedNumber reads the seed number off the "Generating for N players" line', async () => {
    const dir = fakeInstall({ logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog(SEED_NAME, SEED, 79) } });
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), SEED);
});

test('a Generate log whose first line starts with a UTF-8 BOM is still read', async () => {
    const text = `\uFEFFGenerating for 2 players, ${SEED_NAME} Seed ${SEED} with plando: bosses\r\nCreating World.\r\n`;
    const dir = fakeInstall({ logs: { 'Generate_2026_09_25_10_00_00.txt': text } });
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), SEED);
});

test('when several logs name the seed, the newest one wins', async () => {
    const dir = fakeInstall({
        logs: {
            // The newest by mtime is the middle one by name, so reading in either name order, or
            // in whatever order the folder lists, gives a different answer.
            'Generate_2026_09_25_08_00_00.txt': generateLog(SEED_NAME, '11111111111111111111'),
            'Generate_2026_09_25_09_00_00.txt': generateLog(SEED_NAME, '22222222222222222222'),
            'Generate_2026_09_25_10_00_00.txt': generateLog(SEED_NAME, '33333333333333333333'),
            // Newer than all of them, but for another seed.
            'Generate_2026_09_25_11_00_00.txt': generateLog('99999999999999999999', '55555555555555555555'),
            // The newest file there, and not a Generate log: it must not be read at all.
            'MultiServer_2026_09_25_12_00_00.txt': `${SEED_NAME} Seed 44444444444444444444\r\n`
        }
    });
    const age = (name, minutes) => {
        const when = new Date(Date.now() - minutes * 60000);
        fs.utimesSync(path.join(dir, 'logs', name), when, when);
    };
    age('Generate_2026_09_25_08_00_00.txt', 120);
    age('Generate_2026_09_25_09_00_00.txt', 30);
    age('Generate_2026_09_25_10_00_00.txt', 60);
    age('Generate_2026_09_25_11_00_00.txt', 10);
    age('MultiServer_2026_09_25_12_00_00.txt', 0);
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), '22222222222222222222');
});

test('a seed name that is only the tail of another seed name does not match it', async () => {
    const dir = fakeInstall({ logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog(`9${SEED_NAME}`, SEED) } });
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), null);
});

test('a miss is remembered until the logs folder changes', async () => {
    const dir = fakeInstall({ logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog('99999999999999999999', SEED) } });
    const logs = path.join(dir, 'logs');
    const pinned = new Date(Date.now() - 3600000);
    fs.utimesSync(logs, pinned, pinned);
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), null);

    // The log turns up, but the folder's time is put back, so nothing says to look again.
    fs.writeFileSync(path.join(logs, 'Generate_2026_09_25_11_00_00.txt'), generateLog(SEED_NAME, SEED));
    fs.utimesSync(logs, pinned, pinned);
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), null);

    const now = new Date();
    fs.utimesSync(logs, now, now);
    assert.strictEqual(await logic.findSeedNumber(dir, SEED_NAME), SEED);
});

test('an install with no logs folder is a miss, not a throw', async () => {
    assert.strictEqual(await logic.findSeedNumber(fakeInstall(), SEED_NAME), null);
});

// --- locateSeed ------------------------------------------------------------------------------

test('locateSeed says disabled for a blank install folder', async () => {
    const result = await logic.locateSeed('', SEED_NAME);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'disabled');
});

test('locateSeed says no-seed when the room has not named its seed', async () => {
    const result = await logic.locateSeed(fakeInstall(), '');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no-seed');
});

test('locateSeed says no-install for a folder without a frozen Python in it', async () => {
    const dir = fakeInstall({
        dll: null,
        logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog(SEED_NAME, SEED) },
        multidataFor: SEED_NAME
    });
    const result = await logic.locateSeed(dir, SEED_NAME);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no-install');
    assert.ok(result.detail.includes(dir), result.detail);
});

test('locateSeed still finds a seed whose Generate log is gone, and leaves its number to the worker', async () => {
    // Archipelago deletes its logs after a week, well inside a long async, while the zip whose
    // spoiler the worker reads the number from stays.
    const dir = fakeInstall({
        logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog('99999999999999999999', SEED) },
        multidataFor: SEED_NAME
    });
    assert.deepStrictEqual(await logic.locateSeed(dir, SEED_NAME), {
        ok: true,
        apDir: dir,
        seed: null,
        seedName: SEED_NAME,
        multidata: path.join(dir, 'output', `AP_${SEED_NAME}.zip`),
        pythonVersion: '3.13'
    });
});

test('locateSeed says not-generated-here when the output zip is missing, even with a Generate log naming the seed', async () => {
    // The rebuild is checked against the multidata in that zip, so a log alone cannot stand in.
    const dir = fakeInstall({ logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog(SEED_NAME, SEED) } });
    const result = await logic.locateSeed(dir, SEED_NAME);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'not-generated-here');
    assert.ok(result.detail.includes(`AP_${SEED_NAME}.zip`), result.detail);
    assert.ok(result.detail.includes(dir), result.detail);
});

test('locateSeed hands back every field the worker is started with', async () => {
    const dir = fakeInstall({
        logs: { 'Generate_2026_09_25_10_00_00.txt': generateLog(SEED_NAME, SEED) },
        multidataFor: SEED_NAME
    });
    assert.deepStrictEqual(await logic.locateSeed(dir, SEED_NAME), {
        ok: true,
        apDir: dir,
        seed: SEED,
        seedName: SEED_NAME,
        multidata: path.join(dir, 'output', `AP_${SEED_NAME}.zip`),
        pythonVersion: '3.13'
    });
});

// --- LogicWorker -----------------------------------------------------------------------------

test('a ready worker carries the slots it verified, and the last stage it reported', async () => {
    const worker = startFake('normal');
    assert.strictEqual(await worker.whenReady(5000), worker);
    assert.strictEqual(worker.state, 'ready');
    assert.strictEqual(worker.alive, true);
    assert.strictEqual(worker.stage, 'checking');
    assert.deepStrictEqual(worker.slots, {
        1: { verified: true },
        2: { verified: false, reason: 'sphere 3 did not replay' }
    });
});

test('two inLogic requests in flight each get their own answer, matched by id and not by order', async () => {
    const worker = startFake('normal');
    await worker.whenReady(5000);
    const finished = [];
    const slowQuery = { slot: 1, received: [[77001, 1], [77002, 0]], checked: [5, 6, 7], delayMs: 150 };
    const slow = worker.inLogic([slowQuery]).then((r) => { finished.push('slow'); return r; });
    const quick = worker.inLogic([{ slot: 2, received: [], checked: [] }]).then((r) => { finished.push('quick'); return r; });
    const [slowResults, quickResults] = await Promise.all([slow, quick]);

    assert.deepStrictEqual(finished, ['quick', 'slow'], 'the fake answered out of order, or the test proves nothing');
    assert.deepStrictEqual(slowResults, [{ slot: 1, verified: true, locations: [[1002, 1]], open: 3, echo: slowQuery }]);
    assert.strictEqual(quickResults.length, 1);
    assert.strictEqual(quickResults[0].slot, 2);
    assert.strictEqual(worker.pending.size, 0);
});

test('a request the worker refuses rejects with the worker\'s own error', async () => {
    const worker = startFake('normal');
    await worker.whenReady(5000);
    await assert.rejects(worker.request({ op: 'teleport' }), { message: "unknown op 'teleport'" });
});

test('a request before the worker is ready is refused rather than queued', async () => {
    const worker = startFake('slow');
    await assert.rejects(worker.inLogic([{ slot: 1, received: [], checked: [] }]), /not ready/);
    assert.strictEqual(worker.pending.size, 0);
});

test('a fatal startup rejects whenReady with the worker\'s message, and keeps it past the exit', async () => {
    const message = 'C:\\AP does not look like a frozen Archipelago install (no python3XX.dll)';
    const worker = startFake('fatal', ['--ap-dir', 'C:\\AP']);
    await assert.rejects(worker.whenReady(5000), { message });
    await waitUntil(() => worker.state === 'exited', 'the fatal worker to exit');
    // "exited with code 1" in its place would leave the log saying nothing useful.
    assert.strictEqual(worker.exitDetail, message);
    assert.strictEqual(worker.alive, false);
});

test('the worker exiting mid-request rejects the request that was waiting on it', async () => {
    const worker = startFake('exit-on-request');
    await worker.whenReady(5000);
    await assert.rejects(worker.inLogic([{ slot: 1, received: [], checked: [] }]),
        /logic worker stopped: exited with code 3/);
    assert.strictEqual(worker.pending.size, 0);
    assert.strictEqual(worker.alive, false);
});

test('a request with no answer times out, and stops the worker along with every request behind it', { timeout: 10000 }, async () => {
    const worker = startFake('ignore-requests');
    await worker.whenReady(5000);
    const stalled = worker.request({ op: 'inLogic', slots: [{ slot: 1 }] }, 100);
    // Left on the default minute: it must be let go when the worker is stopped, not when its own
    // timer runs out.
    const behind = worker.request({ op: 'inLogic', slots: [{ slot: 2 }] });
    await Promise.all([
        assert.rejects(stalled, /no answer after/),
        assert.rejects(behind, /logic worker stopped/)
    ]);
    assert.strictEqual(worker.pending.size, 0);
    await waitUntil(() => worker.state === 'exited', 'the stalled worker to be killed');
    assert.ok(logged.some(line => line.includes('gave no answer') && line.includes('stopping it')), logged.join('\n'));
    // Stopped on purpose, so the timeout's line is the only one about it.
    assert.ok(!logged.some(line => line.includes('logic worker stopped')), logged.join('\n'));
});

test('a worker that never gets ready is given up on after the timeout it was given', async () => {
    const worker = startFake('never-ready');
    await waitUntil(() => worker.stage === 'importing', 'the never-ready worker to report progress');
    await assert.rejects(worker.whenReady(100), /not ready after/);
    assert.strictEqual(worker.state, 'starting');
});

// Node on Windows refuses to run a .bat or .cmd without a shell, and says so by throwing out of
// spawn() itself rather than with a later 'error' event.
const cannotSpawnCmd = process.platform !== 'win32' && 'only Windows throws out of spawn() for a .cmd';

function cmdShim() {
    const shim = path.join(tempDir(), 'python.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    return shim;
}

test('a command that spawn() throws on leaves the worker exited, and whenReady rejects at once', { skip: cannotSpawnCmd }, async () => {
    const worker = new logic.LogicWorker({ command: cmdShim(), args: [FAKE], label: 'test' });
    direct.push(worker);
    assert.strictEqual(worker.start(), worker);
    assert.strictEqual(worker.state, 'exited');
    assert.strictEqual(worker.alive, false);
    // Given far longer than the throw takes, so a worker left 'starting' shows up as the timeout.
    await assert.rejects(worker.whenReady(3000), /EINVAL/);
    assert.match(worker.exitDetail, /EINVAL/);
});

test('a non-JSON line on stdout is logged and skipped, and later replies still arrive', async () => {
    const worker = startFake('garbage');
    await worker.whenReady(5000);
    const first = await worker.inLogic([{ slot: 1, received: [], checked: [] }]);
    const second = await worker.inLogic([{ slot: 2, received: [], checked: [4] }]);
    assert.strictEqual(first[0].slot, 1);
    assert.strictEqual(second[0].slot, 2);
    assert.strictEqual(second[0].open, 1);
    assert.ok(logged.some(line => line.includes('not JSON') && line.includes('not a protocol line')), logged.join('\n'));
    assert.ok(logged.some(line => line.includes('a world printed this into the protocol')), logged.join('\n'));
});

test('stderr is kept for the log, but only its last 40 lines', async () => {
    const worker = startFake('noisy');
    await worker.whenReady(5000);
    // 'close' rather than 'exit': only then is every stderr line known to have been read.
    const closed = new Promise(resolve => worker.child.once('close', resolve));
    worker.stop();
    await closed;
    assert.deepStrictEqual(worker.stderr, Array.from({ length: 40 }, (_, i) => `noise ${61 + i}`));
});

// --- acquire ---------------------------------------------------------------------------------

test('acquire starts the worker with the install folder from config, trimmed, and what locateSeed found', async () => {
    config.archipelagoInstallDir = '  D:\\Games\\Archipelago  ';
    const calls = useFake('normal');
    const result = await logic.acquire(SEED_NAME, { label: 'room' });
    assert.strictEqual(result.ok, true, result.detail);
    assert.deepStrictEqual(calls.locate, [['D:\\Games\\Archipelago', SEED_NAME]]);
    assert.deepStrictEqual(calls.python, ['3.13']);
    const multidata = path.join('D:\\Games\\Archipelago', 'output', `AP_${SEED_NAME}.zip`);
    assert.deepStrictEqual(result.worker.args, [FAKE,
        '--ap-dir', 'D:\\Games\\Archipelago',
        '--seed-name', SEED_NAME,
        '--multidata', multidata,
        '--seed', SEED]);
    assert.deepStrictEqual(result.worker.info.args, {
        apDir: 'D:\\Games\\Archipelago',
        seed: SEED,
        seedName: SEED_NAME,
        multidata
    });
});

test('a seed with no number found is started without --seed at all', async () => {
    // The worker only needs --seed when the zip has no spoiler to read the number from, while an
    // empty or "null" one would fail its integer parse and the whole startup with it.
    useFake('normal', { locate: (apDir, seedName) => ({ ...located(apDir, seedName), seed: null }) });
    const result = await logic.acquire(SEED_NAME);
    assert.strictEqual(result.ok, true, result.detail);
    assert.deepStrictEqual(result.worker.args, [FAKE,
        '--ap-dir', 'C:\\ProgramData\\Archipelago',
        '--seed-name', SEED_NAME,
        '--multidata', path.join('C:\\ProgramData\\Archipelago', 'output', `AP_${SEED_NAME}.zip`)]);
    assert.strictEqual(result.worker.info.args.seed, undefined);
});

test('the seed number turning up or going away does not restart the worker already serving that seed', async () => {
    // The Generate log is deleted a week in, so the same seed can be located with its number on
    // one `!ap next` and without it on the next; that is no reason for another minute of Python.
    let seed = SEED;
    useFake('normal', { locate: (apDir, seedName) => ({ ...located(apDir, seedName), seed }) });
    const first = await logic.acquire(SEED_NAME);
    assert.strictEqual(first.ok, true, first.detail);
    seed = null;
    const second = await logic.acquire(SEED_NAME);
    assert.strictEqual(second.worker, first.worker);
    assert.strictEqual(spawnedPids().length, 1);
});

test('two callers that ask at the same moment share one startup and one process', async () => {
    // The window is everything before the spawn, which on a first use includes running `py` to
    // find Python and reading the Generate logs: two `!ap next` a moment apart both land in it.
    useFake('slow');
    const [a, b] = await Promise.all([logic.acquire(SEED_NAME), logic.acquire(SEED_NAME)]);
    assert.strictEqual(a.ok, true, a.detail);
    assert.strictEqual(b.ok, true, b.detail);
    assert.strictEqual(a.worker, b.worker);
    assert.strictEqual(spawnedPids().length, 1);
});

test('a caller that arrives while the worker is starting waits for that same worker', async () => {
    useFake('slow');
    let first;
    await new Promise((resolve) => { first = logic.acquire(SEED_NAME, { onWait: resolve }); });
    let secondWaited = 0;
    const second = await logic.acquire(SEED_NAME, { onWait: () => { secondWaited++; } });
    const firstResult = await first;
    assert.strictEqual(firstResult.ok, true, firstResult.detail);
    assert.strictEqual(second.ok, true, second.detail);
    assert.strictEqual(second.worker, firstResult.worker);
    assert.strictEqual(secondWaited, 1, 'the second caller also waited, so it should also be told');
    assert.strictEqual(spawnedPids().length, 1);
});

test('onWait is called while the worker starts, and not once it is ready', async () => {
    useFake('slow');
    let settled = false;
    let settledAtWait = null;
    let waits = 0;
    const onWait = () => { waits++; settledAtWait = settled; };
    const started = await logic.acquire(SEED_NAME, { onWait }).then((r) => { settled = true; return r; });
    assert.strictEqual(started.ok, true, started.detail);
    assert.strictEqual(waits, 1);
    assert.strictEqual(settledAtWait, false);

    const again = await logic.acquire(SEED_NAME, { onWait });
    assert.strictEqual(again.worker, started.worker);
    assert.strictEqual(waits, 1, 'nothing to wait for, so nothing to say');
});

test('an onWait that fails does not cost the caller its worker', async () => {
    useFake('slow');
    const result = await logic.acquire(SEED_NAME, { onWait: async () => { throw new Error('Unknown Message'); } });
    assert.strictEqual(result.ok, true, result.detail);
});

test('a startup that fails is remembered, and the next acquire answers failed without starting another', async () => {
    const calls = useFake('fatal');
    const first = await logic.acquire(SEED_NAME);
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.reason, 'failed');
    assert.match(first.detail, /does not look like a frozen Archipelago install/);

    const second = await logic.acquire(SEED_NAME);
    assert.deepStrictEqual(second, { ok: false, reason: 'failed', detail: first.detail });
    assert.strictEqual(spawnedPids().length, 1);
    assert.strictEqual(calls.python.length, 1);
});

test('a worker that exits after it was ready is started again, not remembered as failed', async () => {
    useFake('exit-after-ready');
    const first = await logic.acquire(SEED_NAME);
    assert.strictEqual(first.ok, true, first.detail);
    await waitUntil(() => first.worker.state === 'exited', 'the worker to exit after ready');

    process.env.FAKE_LOGIC_WORKER_MODE = 'normal';
    const second = await logic.acquire(SEED_NAME);
    assert.strictEqual(second.ok, true, second.detail);
    assert.notStrictEqual(second.worker, first.worker);
    assert.strictEqual(spawnedPids().length, 2);
});

test('a worker stopped on purpose while it starts is not remembered as failed', async () => {
    // Stopped mid-rebuild it is killed, and its startup rejects just as a crash's would. Taken for
    // a failure, the next watch on the seed would get sphere 1 answers for ten minutes.
    useFake('never-ready');
    let first;
    await new Promise((resolve) => { first = logic.acquire(SEED_NAME, { onWait: resolve }); });
    logic.release(SEED_NAME);
    const stopped = await first;
    assert.strictEqual(stopped.ok, false);
    // Its caller is told it was stopped, not that loading failed, and the log says nothing of a
    // failure that did not happen.
    assert.strictEqual(stopped.reason, 'stopped');
    assert.ok(!logged.some(line => /logic worker unavailable/.test(line)), 'no failure logged');

    process.env.FAKE_LOGIC_WORKER_MODE = 'normal';
    const again = await logic.acquire(SEED_NAME);
    assert.strictEqual(again.ok, true, again.detail);
    assert.strictEqual(spawnedPids().length, 2);
});

test('a request that times out stops its worker, and the next acquire starts a fresh one', async () => {
    useFake('normal');
    const first = await logic.acquire(SEED_NAME);
    assert.strictEqual(first.ok, true, first.detail);
    await assert.rejects(first.worker.request({ op: 'inLogic', slots: [{ slot: 1, delayMs: 300 }] }, 100), /no answer after/);
    // Killed rather than left to finish, so the late answer is never written for anyone to take.
    await waitUntil(() => first.worker.state === 'exited', 'the stalled worker to be killed');
    assert.match(first.worker.exitDetail, /killed/);
    assert.strictEqual(first.worker.pending.size, 0);
    await assert.rejects(first.worker.inLogic([{ slot: 1, received: [], checked: [] }]), /not ready/);

    // Not a startup failure either: nothing stands in the way of the next one.
    const second = await logic.acquire(SEED_NAME);
    assert.strictEqual(second.ok, true, second.detail);
    assert.notStrictEqual(second.worker, first.worker);
    const answered = await second.worker.inLogic([{ slot: 2, received: [], checked: [] }]);
    assert.strictEqual(answered[0].slot, 2);
    assert.strictEqual(spawnedPids().length, 2);
});

test('a different seed stops the old worker and starts one for the new seed', async () => {
    useFake('normal');
    const one = await logic.acquire('11111111111111111111');
    const two = await logic.acquire('22222222222222222222');
    assert.strictEqual(one.ok, true, one.detail);
    assert.strictEqual(two.ok, true, two.detail);
    assert.notStrictEqual(two.worker, one.worker);
    assert.strictEqual(two.worker.info.seedName, '22222222222222222222');
    // Asked to finish by closing its stdin, and did, rather than being killed two seconds later.
    await waitUntil(() => one.worker.state === 'exited', 'the old worker to exit');
    assert.match(one.worker.exitDetail, /^exited with code 0/);
    assert.strictEqual(two.worker.alive, true);
    assert.strictEqual(spawnedPids().length, 2);
});

test('locateSeed failures pass straight through, with nothing started', async () => {
    for (const reason of ['disabled', 'no-seed', 'no-install', 'not-generated-here']) {
        const why = { ok: false, reason, detail: `because ${reason}` };
        const calls = useFake('normal', { locate: () => why });
        assert.deepStrictEqual(await logic.acquire(SEED_NAME), why);
        assert.deepStrictEqual(calls.python, [], reason);
    }
    assert.deepStrictEqual(spawnedPids(), []);
});

test('a blank archipelagoInstallDir turns exact logic off before anything is looked for', async () => {
    config.archipelagoInstallDir = '   ';
    const result = await logic.acquire(SEED_NAME);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'disabled');
});

test('blanking archipelagoInstallDir also stops a worker that is already running', async () => {
    // Otherwise switching the feature off would stop the next rebuild but leave the half gigabyte
    // the running one holds until the bot restarts.
    useFake('normal');
    const running = await logic.acquire(SEED_NAME);
    assert.strictEqual(running.ok, true, running.detail);

    logic._deps.locateSeed = REAL_DEPS.locateSeed;
    config.archipelagoInstallDir = '';
    assert.strictEqual((await logic.acquire(SEED_NAME)).reason, 'disabled');
    await waitUntil(() => running.worker.state === 'exited', 'the running worker to exit');
});

test('release stops the worker serving that seed and leaves any other seed\'s alone', async () => {
    useFake('normal');
    const acquired = await logic.acquire(SEED_NAME);
    assert.strictEqual(acquired.ok, true, acquired.detail);

    logic.release('99999999999999999999');
    await sleep(200);
    assert.strictEqual(acquired.worker.alive, true, 'a different seed is not this worker');

    logic.release(SEED_NAME);
    await waitUntil(() => acquired.worker.state === 'exited', 'the released worker to exit');

    // Released, not failed: asking again starts a fresh one.
    const again = await logic.acquire(SEED_NAME);
    assert.strictEqual(again.ok, true, again.detail);
    assert.notStrictEqual(again.worker, acquired.worker);
});

test('a missing Python passes through, and is looked for again next time', async () => {
    const missing = { ok: false, reason: 'no-python', detail: 'Python 3.13 is needed' };
    const calls = useFake('normal', { python: () => missing });
    assert.deepStrictEqual(await logic.acquire(SEED_NAME), missing);
    assert.deepStrictEqual(await logic.acquire(SEED_NAME), missing);
    assert.strictEqual(calls.python.length, 2, 'installing Python should not need a restart');
    assert.deepStrictEqual(spawnedPids(), []);
});

test('an exception while finding the seed or its Python answers failed, and holds up none of the callers behind it', async () => {
    // Every acquire waits its turn behind the one before, so one that threw and left that queue
    // rejected would take every later `!ap next` down with it.
    let locates = 0;
    let pythons = 0;
    useFake('normal', {
        locate: (apDir, seedName) => {
            if (++locates === 1) throw new Error('EPERM: operation not permitted, scandir');
            return located(apDir, seedName);
        },
        python: () => {
            if (++pythons === 1) throw new Error('spawn py ENOENT');
            return { ok: true, command: process.execPath };
        }
    });
    const [lost, noPython, started] = await Promise.all([
        logic.acquire(SEED_NAME, { label: 'room' }),
        logic.acquire(SEED_NAME, { label: 'room' }),
        logic.acquire(SEED_NAME, { label: 'room' })
    ]);
    assert.deepStrictEqual(lost, { ok: false, reason: 'failed', detail: 'EPERM: operation not permitted, scandir' });
    assert.deepStrictEqual(noPython, { ok: false, reason: 'failed', detail: 'spawn py ENOENT' });
    assert.strictEqual(started.ok, true, started.detail);
    assert.strictEqual(spawnedPids().length, 1);
    // The reply only says the bot log has the reason, so the log has to.
    assert.ok(logged.some(line => line.includes('could not start the logic worker: EPERM')), logged.join('\n'));
    assert.ok(logged.some(line => line.includes('could not start the logic worker: spawn py ENOENT')), logged.join('\n'));
});

test('a Python that spawn() throws on answers failed straight away, then and on the next acquire', { skip: cannotSpawnCmd, timeout: 10000 }, async () => {
    const shim = cmdShim();
    const calls = useFake('normal', { python: () => ({ ok: true, command: shim }) });
    const result = await logic.acquire(SEED_NAME);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'failed');
    assert.match(result.detail, /EINVAL/);
    // A worker left behind as 'starting' would be the one the next caller waits five minutes on.
    assert.deepStrictEqual(await logic.acquire(SEED_NAME), result);
    assert.strictEqual(calls.python.length, 1);
});

test('a ready worker is announced once, naming the slots that will answer sphere 1 only', async () => {
    useFake('normal');
    await logic.acquire(SEED_NAME, { label: 'room' });
    await logic.acquire(SEED_NAME, { label: 'room' });
    assert.strictEqual(logged.filter(line => line.includes('logic worker ready')).length, 1, logged.join('\n'));
    assert.ok(logged.some(line => line.includes('1/2 slots verified')), logged.join('\n'));
    assert.ok(logged.some(line => line.includes('slot 2 answers sphere 1 only: sphere 3 did not replay')), logged.join('\n'));
});

// --- configChanged ---------------------------------------------------------------------------

test('configChanged stops a running worker when the install folder is blanked, and not on any other save', async () => {
    useFake('normal');
    const acquired = await logic.acquire(SEED_NAME);
    assert.strictEqual(acquired.ok, true, acquired.detail);

    // Every archipelago* save lands here, and most have nothing to do with the worker.
    logic.configChanged();
    logic.configChanged();
    await sleep(200);
    assert.strictEqual(acquired.worker.alive, true);

    config.archipelagoInstallDir = '   ';
    logic.configChanged();
    await waitUntil(() => acquired.worker.state === 'exited', 'the worker to exit');
});

test('a changed archipelagoPython forgets a failed startup, but the first settings seen are only noted', async () => {
    useFake('fatal');
    assert.strictEqual((await logic.acquire(SEED_NAME)).reason, 'failed');

    // The first call has nothing to compare with, so it cannot tell a fix from the settings the
    // bot started with.
    config.archipelagoPython = 'C:\\Python313\\python.exe';
    logic.configChanged();
    assert.strictEqual((await logic.acquire(SEED_NAME)).reason, 'failed');
    logic.configChanged();
    assert.strictEqual((await logic.acquire(SEED_NAME)).reason, 'failed');
    assert.strictEqual(spawnedPids().length, 1);

    process.env.FAKE_LOGIC_WORKER_MODE = 'normal';
    config.archipelagoPython = 'D:\\Python313\\python.exe';
    logic.configChanged();
    const fixed = await logic.acquire(SEED_NAME);
    assert.strictEqual(fixed.ok, true, fixed.detail);
    assert.strictEqual(spawnedPids().length, 2);
});
