// helpers/logPrune.js
//
// Day-file housekeeping for the two sinks under data/logs/: the console mirror written by
// logger.js and the structured command log written by commandLog.js.
//
// Both had their own copy of the same retention parse, the same hourly throttle, the same
// UTC-midnight cutoff and the same swallow-everything catch, differing only in the filename
// pattern. `test/logRetention.test.js` had to spawn a child process to assert the two agreed,
// which is a test proving a duplication rather than a behaviour.
//
// No dependencies, deliberately: logger.js is the one module in the repo that must be safe to
// require from anywhere, including from code that runs before config is readable.

const fs = require('fs');
const path = require('path');

const THROTTLE_MS = 60 * 60 * 1000;
// Keyed by whatever the caller passes, so the two sinks throttle independently.
const lastRun = new Map();

/**
 * How many days of day-files to keep.
 * Unset, 0, negative or unparseable all mean keep everything, which is the default.
 */
function retentionDays() {
    return Math.max(0, Math.floor(Number(process.env.PLEXBOT_LOG_RETENTION_DAYS)) || 0);
}

/**
 * Delete day-files older than the retention window. Cheap, and only once an hour per key.
 * @param {string} dir
 * @param {RegExp} pattern must capture the YYYY-MM-DD in group 1, and must not carry /g
 * @param {string} key throttle bucket, one per sink
 * @returns {number} how many files were removed
 */
function pruneDayFiles(dir, pattern, key) {
    const days = retentionDays();
    if (days <= 0) return 0;

    const now = Date.now();
    if (now - (lastRun.get(key) || 0) < THROTTLE_MS) return 0;
    lastRun.set(key, now);

    let removed = 0;
    try {
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        for (const name of fs.readdirSync(dir)) {
            const match = pattern.exec(name);
            if (!match) continue;
            if (new Date(`${match[1]}T00:00:00Z`).getTime() >= cutoff) continue;
            fs.unlinkSync(path.join(dir, name));
            removed++;
        }
    } catch (_) {
        // Housekeeping is never worth an error: a locked or missing directory just means the
        // next hour tries again.
    }
    return removed;
}

/** Test seam: forget the throttle so a second prune in the same hour actually runs. */
function resetThrottle() {
    lastRun.clear();
}

module.exports = { retentionDays, pruneDayFiles, resetThrottle, THROTTLE_MS };
