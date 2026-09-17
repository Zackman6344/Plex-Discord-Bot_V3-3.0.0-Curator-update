// helpers/logger.js
// Tiny no-deps leveled logger. ISO timestamp + level prefix on every line.
// Set LOG_LEVEL=debug|info|warn|error to change the minimum level (default: info).
//
// Everything also lands in data/logs/bot-YYYY-MM-DD.log, without the ANSI colours. Console-only
// logging meant any failure nobody happened to be watching was unrecoverable — the run scrolled
// past and that was that. Set PLEXBOT_LOG_TO_FILE=0 to turn the file sink off.
//
// Those files are kept forever unless PLEXBOT_LOG_RETENTION_DAYS says otherwise.
//
// Usage:
//   const logger = require('../helpers/logger.js');
//   logger.info('Bot ready');
//   logger.error('Plex query failed:', err);

const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
    debug: '\x1b[36m', // cyan
    info:  '\x1b[32m', // green
    warn:  '\x1b[33m', // yellow
    error: '\x1b[31m'  // red
};
const RESET = '\x1b[0m';

const minLevel = LEVELS[(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;
const DIR = process.env.PLEXBOT_LOG_DIR || path.join(__dirname, '..', 'data', 'logs');
// Off under the test runner: a `npm test` run exercises error paths deliberately, and those
// lines landing in the real log would be noise pretending to be incidents.
const toFile = process.env.PLEXBOT_LOG_TO_FILE !== '0' && !process.env.NODE_TEST_CONTEXT;
// Set PLEXBOT_LOG_TO_CONSOLE=0 to stop mirroring to stdout. scripts/start-bot.cmd sets it, so
// its window cannot freeze the bot by being clicked in; the file sink is the real log either way,
// and scripts/status-bot.ps1 reads that. Left on by default, so `node index.js` still shows work.
const toConsole = process.env.PLEXBOT_LOG_TO_CONSOLE !== '0';
// Logs are kept indefinitely. A day of bot log is small next to what it is worth having when
// something went wrong a month ago and nobody noticed at the time.
// Set PLEXBOT_LOG_RETENTION_DAYS to a positive number to delete anything older than that many
// days; unset, 0 or unparseable keeps everything. The parse, the throttle and the cutoff live in
// logPrune.js so this sink and the command log cannot drift apart.
const logPrune = require('./logPrune.js');
const BOT_LOG = /^bot-(\d{4}-\d{2}-\d{2})\.log$/;

function prune() {
    logPrune.pruneDayFiles(DIR, BOT_LOG, 'bot-log');
}

function appendToFile(line) {
    if (!toFile) return;
    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(path.join(DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
        prune();
    } catch (_) {
        // A logger that throws is worse than a logger that loses a line.
    }
}

function log(level, args) {
    if (LEVELS[level] < minLevel) return;
    const stamp = new Date().toISOString();

    // **The file is written first, and the order is the point.**
    //
    // A Windows console entering selection mode — someone clicks or drags inside the window —
    // blocks whatever process owns it on its next write, indefinitely, until the selection is
    // cleared. With the console written first, that blocked the logger before it reached the
    // file: the bot froze and the log simply stopped mid-run with nothing to say why. Writing
    // the file first means a stuck console costs the console line and nothing else.
    const plain = args
        .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: Infinity })))
        .join(' ');
    appendToFile(`[${stamp}] ${level.toUpperCase()} ${plain}`);

    if (!toConsole) return;
    const tag = `${COLORS[level]}[${stamp}] ${level.toUpperCase()}${RESET}`;
    const sink = level === 'error' ? console.error
              : level === 'warn'  ? console.warn
              : console.log;
    sink(tag, ...args);
}

module.exports = {
    debug: (...args) => log('debug', args),
    info:  (...args) => log('info',  args),
    warn:  (...args) => log('warn',  args),
    error: (...args) => log('error', args),
    _dir: DIR
};
