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
//
// The rename alone does not survive a power cut or a BSOD: NTFS can journal the rename before the
// data blocks reach the disk, and the store then wakes up to a zero-length file, quarantines it
// and starts empty. That is acceptable for a catch-up cursor and not for audiobook bookmarks, so a
// `durable` store also fsyncs before the rename and keeps an hourly `.bak` that load() falls back
// to before starting empty. It is opt-in because the fsync costs a few ms per write and the
// Archipelago stores are rewritten in bursts.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {Object} options
 * @param {string} options.envVar        environment variable that overrides the path
 * @param {string} options.defaultPath   where the file lives when it is not overridden
 * @param {string} options.key           the wrapper key inside the file, e.g. "claims"
 * @param {'array'|'object'} options.shape what an empty store looks like
 * @param {string} options.label         used in log lines, e.g. "claim"
 * @param {string} [options.feature]     names the owning feature in log lines; "Archipelago"
 *   when omitted, so the stores written before this option log exactly what they always did
 * @param {(raw: any) => any} [options.migrate] shape fix applied on read; must be idempotent
 * @param {boolean} [options.nullPrototype] build objects with no prototype, for stores keyed by
 *   user-supplied ids, so a key like `__proto__` cannot reach the prototype chain
 * @param {boolean} [options.pretty] false writes compact JSON, for a store large and busy enough
 *   that indentation costs real time on every write. Indented otherwise.
 * @param {boolean} [options.durable] fsync each write before the rename, keep `<file>.bak` at
 *   most an hour old, and restore from it instead of starting empty when the file is unusable
 * @param {() => number} [options.now] clock for the `.bak` interval; a test seam
 */
function createStore(options) {
    const {
        envVar, defaultPath, key, shape, label, migrate, nullPrototype, pretty = true,
        feature = 'Archipelago', durable = false, now = Date.now
    } = options;

    const file = process.env[envVar] || defaultPath;
    const backupFile = `${file}.bak`;
    // Under the test runner the override is required rather than optional: these files hold real
    // people's ids and, for watches, a room password, and a test run has no business touching them.
    const usable = !process.env.NODE_TEST_CONTEXT || !!process.env[envVar];

    let cache = null;
    // Cleared on a successful write, set when one fails. Read by consumers that take an action in
    // the world (creating a Discord role) which is only safe if it can be written down.
    let writeFailed = false;
    // Set only when a damaged file could not be moved aside. Unlike writeFailed this never clears
    // on its own: the file stays unsafe to write until a person deals with it.
    let blocked = false;
    // -Infinity so the first write after a boot refreshes the backup from the file that boot
    // loaded, rather than leaving a `.bak` up to an hour older than it needs to be.
    let lastBackupAt = -Infinity;

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
    function quarantine(why, restoring = false) {
        const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
            fs.renameSync(file, aside);
            logger.error(`${feature} ${label} file unusable (${why}) — moved to ${aside} and ` +
                (restoring ? `restoring from the hourly backup.` : `starting fresh.`) +
                ` The old contents are intact there if they are worth salvaging.`);
            return aside;
        } catch (err) {
            logger.error(`${feature} ${label} file unusable (${why}) and could not be moved aside ` +
                `(${err.message}). Refusing to overwrite ${file}; fix it by hand.`);
            // Could not preserve it, so do not clobber it either. `blocked` is what makes that
            // stick: writeFailed alone only stops role creation, and persist() went on to write
            // over the very file this branch just promised to leave for salvage.
            writeFailed = true;
            blocked = true;
            return null;
        }
    }

    /**
     * @returns {{ data: any } | { why: string }} the collection, or why it is unusable
     * @throws on unreadable or unparseable text
     */
    function decode(text) {
        const parsed = JSON.parse(text);
        const raw = parsed ? parsed[key] : null;
        const present = raw !== null && raw !== undefined;
        if (!present) return { data: empty() };

        // The RAW value is shape-checked before migrate() sees it. A migrate hook normalises
        // as it goes, so checking only its output hid the problem: handing the goal store an
        // array made migrate return an empty object, which looks perfectly valid.
        if (!valid(raw)) return { why: `"${key}" is not ${shape === 'array' ? 'an array' : 'an object'}` };
        const shaped = migrate ? migrate(raw) : raw;
        if (!valid(shaped)) return { why: `"${key}" could not be read into the expected shape` };
        return { data: shape === 'array' ? shaped : Object.assign(empty(), shaped) };
    }

    function readBackup() {
        try {
            const result = decode(fs.readFileSync(backupFile, 'utf8'));
            return result.data || null;
        } catch (_) {
            return null;
        }
    }

    function load() {
        if (cache) return cache;
        if (!usable) {
            cache = empty();
            return cache;
        }
        let why;
        try {
            const result = decode(fs.readFileSync(file, 'utf8'));
            if (result.data) {
                cache = result.data;
                return cache;
            }
            why = result.why;
        } catch (err) {
            if (err.code === 'ENOENT') {
                cache = empty();
                return cache;
            }
            why = err.message;
        }

        cache = empty();
        const restored = durable ? readBackup() : null;
        quarantine(why, !!restored);
        if (restored) {
            cache = restored;
            logger.warn(`Restored ${feature} ${label}s from the hourly backup ${backupFile}; ` +
                `changes made since it was taken are lost.`);
            // Written straight back so the next boot does not depend on the `.bak` a second time.
            // persist() refuses on its own when the quarantine above failed.
            persist();
        }
        return cache;
    }

    /** @returns {boolean} whether the store is now safely on disk */
    function persist() {
        if (!usable) return true;
        // Loaded first, so a persist that is the very first call on the store cannot write an
        // empty collection over a file nothing has looked at yet.
        const data = load();
        // A file that could not be quarantined is the only copy of data nobody has salvaged yet.
        // Writing over it is worse than losing this one write, so this refuses until a restart.
        if (blocked) {
            logger.error(`Not writing ${feature} ${label}s: ${file} is damaged and could not be ` +
                `moved aside, so overwriting it would destroy the only copy. Fix it by hand.`);
            return false;
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            const text = JSON.stringify({ [key]: data }, null, pretty ? 4 : undefined);
            if (durable) {
                backupIfDue();
                writeSynced(tmp, text);
            } else {
                fs.writeFileSync(tmp, text);
            }
            fs.renameSync(tmp, file);
            writeFailed = false;
            return true;
        } catch (err) {
            writeFailed = true;
            logger.error(`Could not persist ${feature} ${label}s:`, err.message);
            return false;
        }
    }

    function writeSynced(target, text) {
        const fd = fs.openSync(target, 'w');
        try {
            // writeFileSync on an fd loops until every byte is written; a bare writeSync may not.
            fs.writeFileSync(fd, text);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    // Copies the file as it stands BEFORE this write replaces it, so the backup is always one an
    // earlier persist already fsynced and renamed, never the write that might be the torn one.
    function backupIfDue() {
        const at = now();
        if (at - lastBackupAt < BACKUP_INTERVAL_MS) return;
        lastBackupAt = at;
        let current;
        try {
            current = fs.readFileSync(file, 'utf8');
        } catch (_) {
            return;
        }
        try {
            // Never replace a good backup with a file load() itself would refuse.
            if (!decode(current).data) return;
        } catch (_) {
            return;
        }
        const tmp = `${backupFile}.tmp`;
        try {
            writeSynced(tmp, current);
            fs.renameSync(tmp, backupFile);
        } catch (err) {
            // The main write is still worth making without a fresh backup; the next try is an
            // hour away, which keeps a persistent failure from logging on every save.
            logger.warn(`Could not refresh the ${feature} ${label} backup ${backupFile}:`, err.message);
        }
    }

    /** Test seam: drop the in-memory copy so the next read comes off disk. */
    function reset() {
        cache = null;
        writeFailed = false;
        blocked = false;
        lastBackupAt = -Infinity;
    }

    return {
        file, backupFile: durable ? backupFile : null, usable, load, persist, reset,
        healthy: () => !writeFailed
    };
}

module.exports = { createStore, BACKUP_INTERVAL_MS };
