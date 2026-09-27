// helpers/archipelagoLogic.js
//
// Which of a slot's unchecked locations are in logic, by the seed's own rules.
//
// Sphere numbers cannot answer that. A sphere is what became reachable once EVERY item from the
// spheres before it was collected, across the whole multiworld, so a slot's sphere 3 can hang on an
// item still sitting in an idle player's sphere 1. The rules themselves live in each game's Python
// world, so the answer comes from scripts/ap-logic-worker.py: a Python process that loads the
// Archipelago install that generated the seed, rebuilds the seed's logic, checks the rebuild
// against the multidata, and then answers for any slot in milliseconds. This file finds what the
// worker needs, keeps one running, and talks to it.
//
// **Only a seed generated on this machine can be rebuilt.** It takes the Players yamls, the
// apworlds and the seed number. The multidata has only the seed NAME, which is derived from the
// number; the number itself is on the first line of the spoiler in the same output zip, and in
// the Generate log until Archipelago deletes it a week later.
//
// **One worker, started by the first `!ap next` that needs it and then kept.** Loading every world
// and rebuilding a big seed takes most of a minute and about half a gigabyte, so it is neither
// done per command nor at startup for a command that may never be run.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../config/config.js');
const logger = require('./logger.js');

const WORKER_SCRIPT = path.join(__dirname, '..', 'scripts', 'ap-logic-worker.py');
// The rebuild measured 38 s on the 79-slot seed this was built against, on an idle machine. The
// same machine has taken four times as long for a generation while other work ran beside it.
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 60 * 1000;
// A seed that failed to rebuild is not retried on every command: the cause is on disk and usually
// stays there. Long enough to stop a loop, short enough that fixing the cause is picked up soon.
const FAILURE_RETRY_MS = 10 * 60 * 1000;
const STDERR_LINES_KEPT = 40;
// A Generate log names the seed on one of its first lines, but after a line per player. Big
// enough for a few hundred players without reading whole logs.
const LOG_HEAD_BYTES = 128 * 1024;

function installDir() {
    return String(config.archipelagoInstallDir || '').trim();
}

/**
 * The Python version an install was frozen with, from the python3XX.dll cx_Freeze ships beside it.
 * Its compiled modules load into that minor version and no other.
 * @returns {Promise<string|null>} e.g. "3.13"
 */
async function frozenPythonVersion(apDir) {
    let names;
    try {
        names = await fs.promises.readdir(apDir);
    } catch (_) {
        return null;
    }
    for (const name of names) {
        const match = /^python3(\d+)\.dll$/i.exec(name);
        if (match) return `3.${Number(match[1])}`;
    }
    return null;
}

async function readHead(file, bytes) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keyed by the logs folder's modification time, which moves whenever a generation adds a log.
// A seed that is not there is then only searched for again once something new could be.
const seedSearches = new Map();

/**
 * The seed number behind a seed name, from the Generate log of the run that produced it.
 *
 * The line reads "Generating for 79 players, 51632394463281032748 Seed 31755677627148142336 with
 * plando: ...". A run that failed and was retried leaves a log for each attempt under a different
 * seed, so the match is on the name, and the newest log that has it wins.
 * @returns {Promise<string|null>}
 */
async function findSeedNumber(apDir, seedName) {
    const logs = path.join(apDir, 'logs');
    let stamp;
    try {
        stamp = (await fs.promises.stat(logs)).mtimeMs;
    } catch (_) {
        return null;
    }
    const cacheKey = `${logs}|${seedName}`;
    const cached = seedSearches.get(cacheKey);
    if (cached && (cached.seed || cached.stamp === stamp)) return cached.seed;

    const pattern = new RegExp(`\\b${escapeRegExp(seedName)} Seed (\\d+)\\b`);
    const entries = [];
    for (const name of await fs.promises.readdir(logs)) {
        if (!/^Generate_\d+_.*\.txt$/i.test(name)) continue;
        const file = path.join(logs, name);
        try {
            entries.push({ file, mtime: (await fs.promises.stat(file)).mtimeMs });
        } catch (_) { /* removed while listing */ }
    }
    entries.sort((a, b) => b.mtime - a.mtime);

    let seed = null;
    for (const { file } of entries) {
        let head;
        try {
            head = await readHead(file, LOG_HEAD_BYTES);
        } catch (_) {
            continue;
        }
        const match = pattern.exec(head);
        if (match) {
            seed = match[1];
            break;
        }
    }
    seedSearches.set(cacheKey, { seed, stamp });
    return seed;
}

/**
 * Everything the worker needs for one seed, or why it cannot have it.
 *
 * The output zip is what says the seed was generated here. The seed number is only looked up
 * from the Generate log as a spare: the worker reads it off the spoiler inside the zip, which
 * lasts as long as the zip does, while Archipelago deletes its logs after a week.
 * @returns {Promise<{ok: true, apDir: string, seed: string|null, seedName: string,
 *   multidata: string, pythonVersion: string}|{ok: false, reason: string, detail: string}>}
 */
async function locateSeed(apDir, seedName) {
    if (!apDir) return { ok: false, reason: 'disabled', detail: 'archipelagoInstallDir is blank' };
    if (!seedName) return { ok: false, reason: 'no-seed', detail: 'the room has not said which seed it is' };

    const pythonVersion = await frozenPythonVersion(apDir);
    if (!pythonVersion) {
        return { ok: false, reason: 'no-install', detail: `no Archipelago install at ${apDir}` };
    }
    const multidata = path.join(apDir, 'output', `AP_${seedName}.zip`);
    try {
        await fs.promises.access(multidata);
    } catch (_) {
        return { ok: false, reason: 'not-generated-here', detail: `no output/AP_${seedName}.zip in ${apDir}` };
    }
    const seed = await findSeedNumber(apDir, seedName);
    return { ok: true, apDir, seed, seedName, multidata, pythonVersion };
}

const pythons = new Map();

/**
 * The interpreter to run the worker with: archipelagoPython when set, otherwise the Windows
 * launcher's install of the version the Archipelago build needs.
 *
 * Resolved to python.exe itself rather than run through `py`: the launcher starts Python as a
 * child and waits on it, so killing the launcher would orphan the half-gigabyte process under it.
 * @returns {Promise<{ok: true, command: string}|{ok: false, reason: 'no-python', detail: string}>}
 */
async function resolvePython(version) {
    const configured = String(config.archipelagoPython || '').trim();
    if (configured) return { ok: true, command: configured };
    if (pythons.has(version)) return pythons.get(version);

    const launcher = process.platform === 'win32' ? 'py' : `python${version}`;
    const args = process.platform === 'win32'
        ? [`-${version}`, '-c', 'import sys; print(sys.executable)']
        : ['-c', 'import sys; print(sys.executable)'];
    const found = await new Promise((resolve) => {
        execFile(launcher, args, { timeout: 20000, windowsHide: true }, (err, stdout) => {
            const exe = String(stdout || '').trim();
            if (err || !exe) {
                resolve({
                    ok: false,
                    reason: 'no-python',
                    detail: `Python ${version} is needed (the version this Archipelago was built with) and ${launcher} could not find it`
                });
            } else {
                resolve({ ok: true, command: exe });
            }
        });
    });
    // A miss is not cached, so installing Python is picked up without a restart.
    if (found.ok) pythons.set(version, found);
    return found;
}

/**
 * One worker process and the JSON-lines conversation with it.
 *
 * Replies are matched to requests by id, so a slow answer can never be taken for the next one's.
 * Everything the worker's worlds print goes to stderr, and only the last few lines are kept, for
 * the log when it fails.
 */
class LogicWorker {
    constructor({ command, args, label }) {
        this.command = command;
        this.args = args;
        this.label = label || 'logic';
        this.state = 'idle';
        this.slots = null;
        this.info = null;
        this.stage = null;
        this.stderr = [];
        this.pending = new Map();
        this.nextId = 1;
        this.exitDetail = null;
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // Nobody may be waiting yet when startup fails; the rejection is still read later.
        this.readyPromise.catch(() => {});
    }

    start() {
        this.state = 'starting';
        this.startedAt = Date.now();
        try {
            this.child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            // Some spawn failures throw rather than arriving as an 'error' event, a .cmd given as
            // archipelagoPython among them. Left 'starting', every later `!ap next` would wait
            // five minutes on a process that never existed.
            this.onExit(null, err);
            return this;
        }

        readline.createInterface({ input: this.child.stdout }).on('line', line => this.onLine(line));
        readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
            this.stderr.push(line);
            if (this.stderr.length > STDERR_LINES_KEPT) this.stderr.shift();
        });
        this.child.on('error', err => this.onExit(null, err));
        this.child.on('exit', (code, signal) => this.onExit(code, signal ? new Error(`killed by ${signal}`) : null));
        // A write after the process died would otherwise throw out of an unrelated command.
        this.child.stdin.on('error', () => {});
        return this;
    }

    onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            logger.warn(`[AP:${this.label}] logic worker sent something that is not JSON: ${line.slice(0, 200)}`);
            return;
        }
        if (message.event === 'progress') {
            this.stage = message.stage;
        } else if (message.event === 'ready') {
            this.state = 'ready';
            this.info = message;
            this.slots = message.slots || {};
            this.resolveReady(this);
        } else if (message.event === 'fatal') {
            this.exitDetail = message.error;
            this.state = 'failed';
            this.rejectReady(new Error(message.error));
        } else if (message.id !== undefined && this.pending.has(message.id)) {
            const waiting = this.pending.get(message.id);
            this.pending.delete(message.id);
            clearTimeout(waiting.timer);
            if (message.ok) waiting.resolve(message);
            else waiting.reject(new Error(message.error || 'the logic worker refused the request'));
        }
    }

    onExit(code, err) {
        if (this.state === 'exited') return;
        const was = this.state;
        this.state = 'exited';
        const detail = this.exitDetail
            || (err && err.message)
            || `exited with code ${code}${this.stderr.length ? `: ${this.stderr[this.stderr.length - 1]}` : ''}`;
        this.exitDetail = detail;
        if (was !== 'ready') this.rejectReady(new Error(detail));
        for (const waiting of this.pending.values()) {
            clearTimeout(waiting.timer);
            waiting.reject(new Error(`logic worker stopped: ${detail}`));
        }
        this.pending.clear();
        if (was === 'ready' && !this.stopping) logger.warn(`[AP:${this.label}] logic worker stopped: ${detail}`);
    }

    get alive() {
        return this.state === 'starting' || this.state === 'ready';
    }

    whenReady(timeoutMs = READY_TIMEOUT_MS) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`not ready after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        });
        return Promise.race([this.readyPromise, timeout]).finally(() => clearTimeout(timer));
    }

    request(body, timeoutMs = QUERY_TIMEOUT_MS) {
        if (this.state !== 'ready') return Promise.reject(new Error('the logic worker is not ready'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // The worker answers one request at a time, so one that has stalled holds up every
                // question after it. Stopping it lets the next `!ap next` start a fresh one.
                logger.warn(`[AP:${this.label}] logic worker gave no answer in ${Math.round(timeoutMs / 1000)} s; stopping it`);
                this.stopping = true;
                this.kill();
                reject(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
        });
    }

    /**
     * @param {Array<{slot: number, received: Array<[number, number, number]>, checked: number[]}>} queries
     *   received is each NetworkItem as [item, location, flags]
     * @returns {Promise<Array>} one result per query, in order
     */
    async inLogic(queries) {
        const reply = await this.request({ op: 'inLogic', slots: queries });
        return reply.results || [];
    }

    stop() {
        if (!this.child || this.state === 'exited') return;
        this.stopping = true;
        // Closing stdin is the worker's signal to finish; the kill is for one still rebuilding,
        // which does not read stdin until it is ready.
        try { this.child.stdin.end(); } catch (_) { /* already closed */ }
        const child = this.child;
        setTimeout(() => { if (this.state !== 'exited') child.kill(); }, 2000).unref();
    }

    kill() {
        if (this.child && this.state !== 'exited') this.child.kill();
    }
}

// Swappable so the tests can stand a fake worker in for Python and a fake install in for disk.
// -O because the frozen build was compiled with optimize=1; -s -S so nothing installed into this
// Python can shadow what the install ships; -B so nothing is compiled into the install's folders.
const deps = { locateSeed, resolvePython, workerScript: WORKER_SCRIPT, pythonFlags: ['-O', '-s', '-S', '-B'] };

const current = { key: null, worker: null, seedName: null };
const failures = new Map();
let exitHookInstalled = false;

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => { if (current.worker) current.worker.kill(); });
}

/**
 * A ready worker for a seed, starting one if needed, or why there is none.
 *
 * Concurrent callers during a startup share it. A different seed replaces the running worker
 * rather than adding a second one, since each holds a whole multiworld.
 *
 * @param {string} seedName
 * @param {{label?: string, onWait?: Function}} [options] onWait is called once, before a wait for
 *   a worker that is still starting, so the caller can say the answer is on its way
 * @returns {Promise<{ok: true, worker: LogicWorker}|{ok: false, reason: string, detail: string}>}
 */
async function acquire(seedName, options = {}) {
    const turn = choosing.then(() => choose(seedName, options));
    choosing = turn.catch(() => {});
    let chosen;
    try {
        chosen = await turn;
    } catch (err) {
        logger.warn(`[AP:${options.label || '?'}] could not start the logic worker: ${err.message || err}`);
        return { ok: false, reason: 'failed', detail: err.message || String(err) };
    }
    if (!chosen.worker) return chosen;
    return waitFor(chosen.worker, chosen.key, options);
}

// Everything up to the spawn runs one caller at a time. Finding the seed and the interpreter both
// await, so two `!ap next` a moment apart on a cold start would otherwise both miss the worker the
// first was about to start, and the second would stop the first one's half-built process.
let choosing = Promise.resolve();

async function choose(seedName, options) {
    const apDir = installDir();
    const located = await deps.locateSeed(apDir, seedName);
    if (!located.ok) {
        // Blanking the install setting is how this is switched off, and that should hand back the
        // half gigabyte a running worker holds, not just stop the next one starting.
        if (located.reason === 'disabled') stopAll();
        else noteOnce(options, seedName, located);
        return located;
    }

    const key = `${located.apDir}|${located.seedName}`;
    // One being stopped (a timed-out question) is on its way out, not a worker to hand over.
    if (current.key === key && current.worker && current.worker.alive && !current.worker.stopping) {
        return { worker: current.worker, key };
    }

    const failed = failures.get(key);
    if (failed && Date.now() - failed.at < FAILURE_RETRY_MS) {
        return { ok: false, reason: 'failed', detail: failed.detail };
    }

    const python = await deps.resolvePython(located.pythonVersion);
    if (!python.ok) {
        noteOnce(options, seedName, python);
        return python;
    }

    if (current.worker) current.worker.stop();
    const worker = new LogicWorker({
        command: python.command,
        args: [...deps.pythonFlags, deps.workerScript,
            '--ap-dir', located.apDir,
            '--seed-name', located.seedName,
            '--multidata', located.multidata,
            ...(located.seed ? ['--seed', located.seed] : [])],
        label: options.label
    });
    current.key = key;
    current.worker = worker;
    installExitHook();
    current.seedName = located.seedName;
    logger.info(`[AP:${options.label || '?'}] starting the logic worker for seed ${located.seedName}`);
    worker.start();
    return { worker, key };
}

async function waitFor(worker, key, options) {
    if (worker.state !== 'ready' && typeof options.onWait === 'function') {
        try { await options.onWait(); } catch (_) { /* only a status message */ }
    }
    try {
        await worker.whenReady();
    } catch (err) {
        const detail = err.message || String(err);
        worker.kill();
        // A worker stopped on purpose (another seed took over, its watch went) did not fail, and
        // remembering it as failed would keep its seed on sphere 1 for ten minutes.
        if (worker.stopping) return { ok: false, reason: 'stopped', detail };
        failures.set(key, { at: Date.now(), detail });
        const tail = worker.stderr.slice(-5).join(' | ');
        logger.warn(`[AP:${options.label || '?'}] logic worker unavailable: ${detail}${tail ? ` (stderr: ${tail})` : ''}`);
        return { ok: false, reason: 'failed', detail };
    }
    if (worker.startedAt && !worker.announced) {
        worker.announced = true;
        const slots = Object.values(worker.slots || {});
        const verified = slots.filter(s => s.verified).length;
        logger.info(`[AP:${options.label || '?'}] logic worker ready in ${Math.round((Date.now() - worker.startedAt) / 1000)} s: `
            + `${verified}/${slots.length} slots verified against the multidata`);
        for (const [slot, s] of Object.entries(worker.slots || {})) {
            if (!s.verified) logger.warn(`[AP:${options.label || '?'}] slot ${slot} answers sphere 1 only: ${s.reason}`);
        }
    }
    return { ok: true, worker };
}

// The reply only says why in a few words, so the specifics go to the log: once per seed and
// reason, since every `!ap next` on a room generated elsewhere would otherwise repeat it.
const noted = new Set();
function noteOnce(options, seedName, why) {
    const key = `${seedName}|${why.reason}`;
    if (noted.has(key)) return;
    noted.add(key);
    logger.info(`[AP:${options.label || '?'}] exact logic unavailable for seed ${seedName}: ${why.detail}`);
}

function stopAll() {
    if (current.worker) current.worker.stop();
    current.worker = null;
    current.key = null;
    current.seedName = null;
}

/** Stop the worker if it is the one serving this seed, for when the last watch on it goes. */
function release(seedName) {
    if (seedName && current.seedName === seedName) stopAll();
}

let lastSettings = null;

/**
 * For the monitor to call whenever an archipelago* setting is saved. Blanking the install stops a
 * running worker there and then rather than at the next `!ap next`, and a changed install or
 * Python forgets earlier failures, so the fix is tried straight away instead of in ten minutes.
 */
function configChanged() {
    const settings = `${installDir()}|${String(config.archipelagoPython || '').trim()}`;
    if (lastSettings !== null && settings !== lastSettings) {
        failures.clear();
        pythons.clear();
    }
    lastSettings = settings;
    if (!installDir()) stopAll();
}

module.exports = {
    acquire,
    locateSeed,
    findSeedNumber,
    frozenPythonVersion,
    resolvePython,
    LogicWorker,
    release,
    configChanged,
    stopAll,
    // For the tests, which swap in a fake worker and a fake install, and reset between cases.
    _deps: deps,
    _reset() {
        stopAll();
        failures.clear();
        seedSearches.clear();
        pythons.clear();
        noted.clear();
        lastSettings = null;
    }
};
