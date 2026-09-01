// Log retention. Day-files are kept indefinitely by default, and PLEXBOT_LOG_RETENTION_DAYS is
// the way back to pruning.
//
// Retention is read from the environment once at module load, so the "pruning still works when
// asked for" half runs in a child process with the variable set. Setting it here would be read
// too late to matter.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-retention-' + process.pid);

const commandLog = require('../helpers/commandLog.js');
const DIR = commandLog._dir;

const REPO = pathMod.join(__dirname, '..');
const dayFile = (name, daysAgo) => {
    const when = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    return pathMod.join(DIR, `${name}-${when}.jsonl`);
};

function seedOldFiles() {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(dayFile('commands', 400), '{"type":"event","kind":"ancient"}\n');
    fs.writeFileSync(dayFile('commands', 30), '{"type":"event","kind":"old"}\n');
}

test.afterEach(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
});

test('nothing is pruned by default, however old it is', () => {
    assert.strictEqual(commandLog.RETENTION_DAYS, 0, 'unset means keep everything');
    seedOldFiles();

    // Writing is what triggers a prune pass.
    commandLog.recordEvent('test-write', {});

    assert.ok(fs.existsSync(dayFile('commands', 400)), 'a file from over a year ago survives');
    assert.ok(fs.existsSync(dayFile('commands', 30)), 'a file from last month survives');
});

test('the read window counts day-files, and days: 0 reads the lot', () => {
    // `days` is a count of day-files, not a date cutoff: readEvents takes the most recent N that
    // exist. A bot that was off for a week has no files for it, so N files reach back further
    // than N days. That errs towards reading more than asked, never less.
    fs.mkdirSync(DIR, { recursive: true });
    for (let daysAgo = 0; daysAgo < 20; daysAgo++) {
        fs.writeFileSync(dayFile('commands', daysAgo), `{"type":"event","kind":"day${daysAgo}"}\n`);
    }
    commandLog._reset();

    assert.strictEqual(commandLog.DEFAULT_READ_DAYS, 14);
    assert.strictEqual(commandLog.readEvents().length, 14, 'the default stops at the window');
    assert.strictEqual(commandLog.readEvents({ days: 0 }).length, 20, 'days: 0 reads every file');
    assert.strictEqual(commandLog.readEvents({ days: 5 }).length, 5);

    // The oldest file is outside the default window and inside the full read.
    const oldest = (events) => events.some(e => e.kind === 'day19');
    assert.strictEqual(oldest(commandLog.readEvents()), false);
    assert.strictEqual(oldest(commandLog.readEvents({ days: 0 })), true);
});

test('a since longer than the window widens it on its own', () => {
    fs.mkdirSync(DIR, { recursive: true });
    for (let daysAgo = 0; daysAgo < 20; daysAgo++) {
        const stamp = new Date(Date.now() - daysAgo * 86400000).toISOString();
        fs.writeFileSync(dayFile('commands', daysAgo),
            JSON.stringify({ type: 'invoke', id: `i${daysAgo}`, t: stamp, command: 'ping' }) + '\n');
    }
    commandLog._reset();

    // 18 days back is outside the 14-file default, so the window has to grow to answer it.
    const { invocations } = commandLog.readInvocations({ limit: 100, sinceMs: 18 * 86400000 });
    assert.ok(invocations.length > 14, `expected more than the default window, got ${invocations.length}`);
});

// Both sinks under data/logs/ read the same variable. The logger's file sink is off under the
// test runner, so both halves of this run in a child either way.
function runChild(dir, retentionDays) {
    const env = { ...process.env, PLEXBOT_LOG_DIR: dir, NODE_TEST_CONTEXT: '' };
    if (retentionDays === null) delete env.PLEXBOT_LOG_RETENTION_DAYS;
    else env.PLEXBOT_LOG_RETENTION_DAYS = String(retentionDays);

    execFileSync(process.execPath, ['-e', `
        const commandLog = require(${JSON.stringify(pathMod.join(REPO, 'helpers', 'commandLog.js'))});
        const logger = require(${JSON.stringify(pathMod.join(REPO, 'helpers', 'logger.js'))});
        const want = ${retentionDays === null ? 0 : retentionDays};
        if (commandLog.RETENTION_DAYS !== want) {
            console.error('retention not read:', commandLog.RETENTION_DAYS);
            process.exit(3);
        }
        commandLog.recordEvent('test-write', {});
        logger.error('test-write');
    `], { env, stdio: 'pipe' });
}

function seedBothSinks(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const files = {
        oldCommands: pathMod.join(dir, `commands-${stamp(400)}.jsonl`),
        oldBotLog: pathMod.join(dir, `bot-${stamp(400)}.log`),
        recentBotLog: pathMod.join(dir, `bot-${stamp(2)}.log`)
    };
    fs.writeFileSync(files.oldCommands, '{"type":"event","kind":"ancient"}\n');
    fs.writeFileSync(files.oldBotLog, 'ancient\n');
    fs.writeFileSync(files.recentBotLog, 'recent\n');
    return files;
}

test('both sinks keep a year-old file when retention is unset', () => {
    const dir = pathMod.join(os.tmpdir(), 'plexbot-test-keep-' + process.pid);
    const files = seedBothSinks(dir);

    runChild(dir, null);

    assert.ok(fs.existsSync(files.oldCommands), 'the command log keeps it');
    assert.ok(fs.existsSync(files.oldBotLog), 'the bot log keeps it');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('PLEXBOT_LOG_RETENTION_DAYS prunes both sinks when it is set', () => {
    const dir = pathMod.join(os.tmpdir(), 'plexbot-test-prune-' + process.pid);
    const files = seedBothSinks(dir);

    runChild(dir, 14);

    assert.strictEqual(fs.existsSync(files.oldCommands), false, 'the year-old command log is pruned');
    assert.strictEqual(fs.existsSync(files.oldBotLog), false, 'the year-old bot log is pruned');
    assert.ok(fs.existsSync(files.recentBotLog), 'the recent one is kept');

    fs.rmSync(dir, { recursive: true, force: true });
});
