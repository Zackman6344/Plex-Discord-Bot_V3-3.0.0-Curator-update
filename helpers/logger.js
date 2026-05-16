// helpers/logger.js
// Tiny no-deps leveled logger. ISO timestamp + level prefix on every line.
// Set LOG_LEVEL=debug|info|warn|error to change the minimum level (default: info).
//
// Usage:
//   const logger = require('../helpers/logger.js');
//   logger.info('Bot ready');
//   logger.error('Plex query failed:', err);

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
    debug: '\x1b[36m', // cyan
    info:  '\x1b[32m', // green
    warn:  '\x1b[33m', // yellow
    error: '\x1b[31m'  // red
};
const RESET = '\x1b[0m';

const minLevel = LEVELS[(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;

function log(level, args) {
    if (LEVELS[level] < minLevel) return;
    const tag = `${COLORS[level]}[${new Date().toISOString()}] ${level.toUpperCase()}${RESET}`;
    const sink = level === 'error' ? console.error
              : level === 'warn'  ? console.warn
              : console.log;
    sink(tag, ...args);
}

module.exports = {
    debug: (...args) => log('debug', args),
    info:  (...args) => log('info',  args),
    warn:  (...args) => log('warn',  args),
    error: (...args) => log('error', args)
};
