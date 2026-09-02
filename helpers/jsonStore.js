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
//   A file that cannot be read is MOVED ASIDE to `<file>.corrupt-<timestamp>` and the store
//   starts empty but fully writable.
//
// That second rule has now been wrong twice in opposite directions. Overwriting the bad file
// turned one interrupted write into permanent loss. Freezing the store read-only instead was
// worse: writes were still accepted and reported as successful, so a run's goals were announced
// and role-synced against a tally that never reached disk, and `sweepCounts` then deleted the
// count roles the real tally would have kept. Quarantining gives both halves — the damaged file
// survives for salvage, and the bot keeps working with an empty store rather than a lying one.

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
    // Cleared on a successful write, set when one fails. Read by consumers that take an action in
    // the world (creating a Discord role) which is only safe if it can be written down.
    let writeFailed = false;

    const empty = () => (shape === 'array' ? [] : (nullPrototype ? Object.create(null) : {}));

    function valid(value) {
        if (shape === 'array') return Array.isArray(value);
        // typeof [] is 'object', so an array reaching an object store would be Object.assigned
        // index by index into {0: …, 1: …} rather than rejected.
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * Move a file that cannot be used out of the way so the store can start clean.
     * @returns {string|null} where it went
     */
    function quarantine(why) {
        const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
            fs.renameSync(file, aside);
            logger.error(`Archipelago ${label} file unusable (${why}) — moved to ${aside} and ` +
                `starting fresh. The old contents are intact there if they are worth salvaging.`);
            return aside;
        } catch (err) {
            logger.error(`Archipelago ${label} file unusable (${why}) and could not be moved aside ` +
                `(${err.message}). Refusing to overwrite ${file}; fix it by hand.`);
            // Could not preserve it, so do not clobber it either.
            writeFailed = true;
            return null;
        }
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
            cache = empty();

            // The RAW value is shape-checked before migrate() sees it. A migrate hook normalises
            // as it goes, so checking only its output hid the problem: handing the goal store an
            // array made migrate return an empty object, which looks perfectly valid.
            const present = raw !== null && raw !== undefined;
            if (present && !valid(raw)) {
                quarantine(`"${key}" is not ${shape === 'array' ? 'an array' : 'an object'}`);
            } else if (present) {
                const shaped = migrate ? migrate(raw) : raw;
                if (valid(shaped)) {
                    cache = shape === 'array' ? shaped : Object.assign(empty(), shaped);
                } else {
                    quarantine(`"${key}" could not be read into the expected shape`);
                }
            }
        } catch (err) {
            cache = empty();
            if (err.code !== 'ENOENT') quarantine(err.message);
        }
        return cache;
    }

    /** @returns {boolean} whether the store is now safely on disk */
    function persist() {
        if (!usable) return true;
        // Loaded first, so a persist that is the very first call on the store cannot write an
        // empty collection over a file nothing has looked at yet.
        const data = load();
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ [key]: data }, null, 4));
            fs.renameSync(tmp, file);
            writeFailed = false;
            return true;
        } catch (err) {
            writeFailed = true;
            logger.error(`Could not persist Archipelago ${label}s:`, err.message);
            return false;
        }
    }

    /** Test seam: drop the in-memory copy so the next read comes off disk. */
    function reset() {
        cache = null;
        writeFailed = false;
    }

    return { file, usable, load, persist, reset, healthy: () => !writeFailed };
}

module.exports = { createStore };
