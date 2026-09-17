const test = require('node:test');
const assert = require('node:assert');
const logger = require('../helpers/logger.js');

test('logger exposes debug/info/warn/error functions', () => {
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info,  'function');
    assert.strictEqual(typeof logger.warn,  'function');
    assert.strictEqual(typeof logger.error, 'function');
});

test('logger.info emits a line with timestamp and INFO label', () => {
    const captured = [];
    const original = console.log;
    console.log = (...args) => captured.push(args.join(' '));
    try {
        logger.info('hello');
    } finally {
        console.log = original;
    }
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'should contain an ISO timestamp');
    assert.match(captured[0], /INFO/, 'should contain INFO label');
    assert.match(captured[0], /hello/, 'should contain the message');
});

test('logger.error routes to console.error', () => {
    const captured = [];
    const original = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    try {
        logger.error('boom');
    } finally {
        console.error = original;
    }
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /ERROR/);
    assert.match(captured[0], /boom/);
});

// --- the console sink must never cost the file line ------------------------------------------
//
// A Windows console entering selection mode (one click inside the window) blocks the process
// that owns it on its next write, until the selection is cleared. The logger used to write the
// console first, so that froze it before it reached the file: the bot stopped relaying and the
// log stopped dead at the moment of the click, with nothing in it to explain why. A bot console
// found sitting in that state for a day is how this surfaced.
//
// The file sink is off under the test runner (deliberately — a test run exercises error paths
// and those lines must not land in the real log), so these run in a child process.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

/** Run a snippet against the real logger, with the file sink on, in its own log directory. */
function inChild(snippet, env) {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-logger-'));
    const script = `const logger = require(${JSON.stringify(pathMod.resolve('helpers/logger.js'))});\n${snippet}`;
    const stdout = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: '', PLEXBOT_LOG_DIR: dir, ...(env || {}) }
    });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    const contents = files.map(f => fs.readFileSync(pathMod.join(dir, f), 'utf8')).join('');
    fs.rmSync(dir, { recursive: true, force: true });
    return { stdout, file: contents };
}

test('a console sink that fails does not take the file line with it', () => {
    // Standing in for a blocked console, which cannot be simulated in-process: if the write is
    // reached before the file, the line is lost. This is the whole reason for the ordering.
    const { file } = inChild(`
        console.log = () => { throw new Error('console is wedged'); };
        try { logger.info('must still be recorded'); } catch (_) {}
    `);
    assert.match(file, /must still be recorded/, 'the file is written before the console is touched');
});

test('an error line survives a wedged console too', () => {
    const { file } = inChild(`
        console.error = () => { throw new Error('console is wedged'); };
        try { logger.error('error must still be recorded'); } catch (_) {}
    `);
    assert.match(file, /ERROR error must still be recorded/);
});

test('PLEXBOT_LOG_TO_CONSOLE=0 writes the file and nothing to stdout', () => {
    // What scripts/start-bot.cmd sets, so its window cannot freeze the bot by being clicked in.
    const { stdout, file } = inChild("logger.info('quiet line');", { PLEXBOT_LOG_TO_CONSOLE: '0' });
    assert.strictEqual(stdout, '', 'nothing reaches the console');
    assert.match(file, /quiet line/, 'but the real log still has it');
});

test('the console sink is on unless it is turned off', () => {
    // `node index.js` by hand should still show its work.
    const { stdout, file } = inChild("logger.info('loud line');");
    assert.match(stdout, /loud line/);
    assert.match(file, /loud line/);
});

test('the level filter still applies before either sink', () => {
    const { stdout, file } = inChild("logger.debug('below the default level');");
    assert.strictEqual(stdout, '');
    assert.strictEqual(file, '', 'a filtered line is not quietly filed either');
});
