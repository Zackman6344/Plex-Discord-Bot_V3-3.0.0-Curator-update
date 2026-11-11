// test/helpers/fakeLogicWorker.js
//
// A stand-in for scripts/ap-logic-worker.py that speaks its JSON-lines protocol, so
// archipelagoLogic.test.js can drive the real LogicWorker and acquire() through every way the real
// worker can behave without Python, an Archipelago install or the minute a rebuild takes.
//
// The behaviour comes from `--mode <name>`, or from FAKE_LOGIC_WORKER_MODE when acquire() builds
// the command line and leaves no room for one:
//   normal            progress, ready, then answers until stdin closes
//   slow              as normal, with ready held back FAKE_LOGIC_WORKER_READY_MS (default 300)
//   fatal             a progress event, then fatal and exit 1, like an install that is not there
//   exit-after-ready  ready, then exit 3 straight away
//   exit-on-request   ready, then exit 3 on the first request, without answering it
//   never-ready       a progress event and then nothing, ignoring stdin, like a rebuild that hangs
//   garbage           as normal, with a non-JSON line before ready and before every reply
//   noisy             as normal, after 100 numbered lines on stderr
//   ignore-requests   ready, then reads every request and answers none
//   rebuild-failed    ready with rebuildError set and no slot verified, then answers every slot
//                     unverified with that error as its reason, as the real worker does once the
//                     seed cannot be rebuilt and only the multidata's sphere 1 is left to go on
//
// An inLogic answer is built from its query and its own slot's entry in the request's received
// map. It carries the query back as `echo` and the whole map as `echoReceived`, so a test can tell
// whose answer it got and see exactly what the worker was sent. A query may carry delayMs to hold
// its reply back, which is how a test gets two requests in flight and answered out of order.
//
// FAKE_LOGIC_WORKER_SPAWNS names a file each start appends its pid to: the only way to count the
// processes acquire() started, and to make sure every one of them is gone before the next test.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const fs = require('node:fs');
const readline = require('node:readline');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag.startsWith('--')) args[flag.slice(2)] = process.argv[++i];
}
const mode = args.mode || process.env.FAKE_LOGIC_WORKER_MODE || 'normal';

// A test that dies before it can kill this must not leave it running for good.
setTimeout(() => process.exit(9), 20000);

if (process.env.FAKE_LOGIC_WORKER_SPAWNS) {
    fs.appendFileSync(process.env.FAKE_LOGIC_WORKER_SPAWNS, `${process.pid}\n`);
}

function send(message, then) {
    process.stdout.write(`${JSON.stringify(message)}\n`, then);
}

// The exit waits for the write: a pipe write can still be queued when process.exit() runs, and
// the line it drops would be the one the test is about.
function sendAndExit(message, code) {
    send(message, () => process.exit(code));
}

const SLOTS = { 1: { verified: true }, 2: { verified: false, reason: 'sphere 3 did not replay' } };
const rebuildFailed = mode === 'rebuild-failed';
const seedName = args['seed-name'] || 'FAKE';
// Worded as the real worker words a Players folder that has moved on to the next async.
const REBUILD_ERROR = `could not rebuild seed ${seedName}: RuntimeError('the yamls no longer match seed ${seedName} (5 slot(s) differ, first slot 12)')`;

function ready() {
    if (mode === 'garbage') process.stdout.write('Archipelago worlds loaded, not a protocol line\n');
    const message = {
        event: 'ready',
        seedName,
        // The real worker gives no per-slot reason when the rebuild failed: rebuildError is it.
        slots: rebuildFailed
            ? Object.fromEntries(Object.keys(SLOTS).map(slot => [slot, { verified: false }]))
            : SLOTS,
        rebuildError: rebuildFailed ? REBUILD_ERROR : null,
        pid: process.pid,
        args: {
            apDir: args['ap-dir'],
            seed: args.seed,
            seedName: args['seed-name'],
            multidata: args.multidata,
            playersDir: args['players-dir']
        },
        elapsedMs: 0
    };
    if (mode === 'exit-after-ready') {
        send(message, () => {
            process.stderr.write('worker going away after ready\n', () => process.exit(3));
        });
        return;
    }
    send(message);
    serve();
}

function answer(query, received) {
    const own = received[String(query.slot)] || [];
    const checked = query.checked || [];
    const id = query.slot * 1000 + own.length;
    return {
        slot: query.slot,
        verified: !rebuildFailed,
        locations: [[id, 1, `Location ${id}`]],
        open: checked.length,
        ...(rebuildFailed ? { reason: REBUILD_ERROR } : {}),
        echo: query,
        echoReceived: received
    };
}

function serve() {
    const input = readline.createInterface({ input: process.stdin });
    input.on('close', () => process.exit(0));
    input.on('line', (line) => {
        if (!line.trim()) return;
        let request;
        try {
            request = JSON.parse(line);
        } catch (err) {
            send({ id: null, ok: false, error: `bad request: ${err.message}` });
            return;
        }
        if (mode === 'exit-on-request') {
            process.stderr.write('dying with a request unanswered\n', () => process.exit(3));
            return;
        }
        if (mode === 'ignore-requests') return;
        if (mode === 'garbage') process.stdout.write('a world printed this into the protocol\n');
        if (request.op === 'ping') {
            send({ id: request.id, ok: true });
        } else if (request.op === 'inLogic') {
            const queries = request.slots || [];
            const received = request.received || {};
            const delay = Math.max(0, ...queries.map(q => Number(q.delayMs) || 0));
            setTimeout(() => send({ id: request.id, ok: true, results: queries.map(q => answer(q, received)) }), delay);
        } else {
            send({ id: request.id, ok: false, error: `unknown op '${request.op}'` });
        }
    });
}

send({ event: 'progress', stage: 'importing', elapsedMs: 0 });

if (mode === 'fatal') {
    sendAndExit({ event: 'fatal', error: `${args['ap-dir'] || 'C:\\nowhere'} does not look like a frozen Archipelago install (no python3XX.dll)` }, 1);
} else if (mode === 'never-ready') {
    // Nothing: the lifetime timer above is all that keeps this alive, as a hung rebuild would be.
} else {
    if (mode === 'noisy') {
        for (let i = 1; i <= 100; i++) process.stderr.write(`noise ${i}\n`);
    }
    send({ event: 'progress', stage: 'building', elapsedMs: 0 });
    send({ event: 'progress', stage: 'checking', elapsedMs: 0 });
    const delay = mode === 'slow' ? Number(process.env.FAKE_LOGIC_WORKER_READY_MS || 300) : 0;
    setTimeout(ready, delay);
}
