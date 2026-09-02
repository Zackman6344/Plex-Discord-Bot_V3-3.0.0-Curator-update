// helpers/jsonStore.js
//
// One small JSON file holding one collection, with the durability rules the Archipelago stores
// need. Claims, goals and roles each carried their own copy of this: the same env-overridable
// path, the same NODE_TEST_CONTEXT gate, the same lazy module cache, the same read, the same
// write and the same test seam, differing only in the filename, the wrapper key and whether the
// empty value is an array or an object. Any change to how they behave had to be made three times,
// and a fix applied to two of the three is the kind of drift nobody notices.
//
// Two rules are the point of having this rather than fs.writeFileSync at each site:
//
//   Writes go to a sibling `.tmp` and rename over the target, so a kill between the truncate and
//   the write cannot leave a half-file.
//
//   A file that fails to parse puts the store READ-ONLY for the run and logs an error naming it,
//   rather than being replaced by whatever the process happens to hold. The previous shape
//   (parse-fail, reset the cache to empty, overwrite on the next write) turned one interrupted
//   write into permanent data loss.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

/**
 * @param {Object} options
 * @param {string} options.envVar        environment variable that overrides the path
 * @param {string} options.defaultPath   where the file lives when it is not overridden
 * @param {string} options.key           the wrapper key inside the file, e.g. "claims"
 * @param {'array'|'object'} options.shape what an empty store looks like
 * @param {string} options.label         used in log lines, e.g. "claim"
 * @param {(raw: any) => any} [options.migrate] shape fix applied on read; must be idempotent
 * @param {boolean} [options.nullPrototype] build objects with no prototype, for stores keyed by
 *   user-supplied ids, so a key like `__proto__` cannot reach the prototype chain
 */
function createStore(options) {
    const { envVar, defaultPath, key, shape, label, migrate, nullPrototype } = options;

    const file = process.env[envVar] || defaultPath;
    // Under the test runner the override is required rather than optional: these files hold real
    // people's ids and, for watches, a room password, and a test run has no business touching them.
    const usable = !process.env.NODE_TEST_CONTEXT || !!process.env[envVar];

    let cache = null;
    let readOnly = false;

    const empty = () => (shape === 'array' ? [] : (nullPrototype ? Object.create(null) : {}));

    function valid(value) {
        return shape === 'array' ? Array.isArray(value) : (value && typeof value === 'object');
    }

    function load() {
        if (cache) return cache;
        if (!usable) {
            cache = empty();
            return cache;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const raw = parsed ? parsed[key] : null;
            const shaped = migrate ? migrate(raw) : raw;
            cache = valid(shaped)
                ? (shape === 'array' ? shaped : Object.assign(empty(), shaped))
                : empty();
        } catch (err) {
            cache = empty();
            if (err.code !== 'ENOENT') {
                readOnly = true;
                logger.error(`Archipelago ${label} file unreadable (${err.message}) — it is frozen ` +
                    `for this run rather than overwritten. Move ${file} aside to start fresh.`);
            }
        }
        return cache;
    }

    /** @returns {boolean} whether the store is now safely on disk */
    function persist() {
        if (!usable) return true;
        if (readOnly) return false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ [key]: load() }, null, 4));
            fs.renameSync(tmp, file);
            return true;
        } catch (err) {
            logger.error(`Could not persist Archipelago ${label}s:`, err.message);
            return false;
        }
    }

    /** Test seam: drop the in-memory copy so the next read comes off disk. */
    function reset() {
        cache = null;
        readOnly = false;
    }

    return { file, usable, load, persist, reset, isReadOnly: () => readOnly };
}

module.exports = { createStore };
