const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const os = require('node:os');
const pathMod = require('node:path');

// Its own store, so parallel test files cannot race on one file and a run can never
// disturb the real one.
process.env.PLEXBOT_RECENT_PICKS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-recent-' + process.pid + '.json');

const recent = require('../helpers/recentPicks.js');

const FILE = recent._file;
test.afterEach(() => {
    try { fs.unlinkSync(FILE); } catch (_) {}
    try { fs.unlinkSync(FILE + '.tmp'); } catch (_) {}
    recent._reset();
});

test('a track just served ranks as more recent than an older one', () => {
    recent.record(['a', 'b', 'c'], 100);

    assert.ok(recent.recency('c') > recent.recency('a'), 'the newest pick carries the heavier handicap');
    assert.strictEqual(recent.recency('never-played'), 0);
    assert.ok(recent.wasRecentlyPicked('b'));
});

test('memory trims to the configured size, keeping the newest', () => {
    recent.record(['old1', 'old2'], 3);
    recent.record(['new1', 'new2'], 3);

    const kept = recent.keys();
    assert.strictEqual(kept.length, 3);
    assert.ok(kept.includes('new2') && kept.includes('new1'));
    assert.ok(!kept.includes('old1'), 'the oldest pick falls out of memory first');
});

test('memory 0 disables rotation and forgets everything', () => {
    recent.record(['a', 'b'], 100);
    recent.record(['c'], 0);

    assert.deepStrictEqual(recent.keys(), []);
    assert.strictEqual(recent.recency('a'), 0);
    assert.strictEqual(recent.wasRecentlyPicked('c'), false);
});

test('rotation state survives a restart', () => {
    recent.record(['persisted'], 100);
    recent._reset();

    assert.ok(recent.wasRecentlyPicked('persisted'), 'a restart must not reset the anti-repeat memory');
});

test('an unwritable store degrades quietly instead of breaking playback', (t) => {
    t.mock.method(fs, 'writeFileSync', () => { throw new Error('EACCES'); });

    assert.doesNotThrow(() => recent.record(['x'], 10), 'rotation is a nicety, never a hard failure');
    t.mock.restoreAll();
});

test('a corrupt file is replaced in memory without throwing', () => {
    fs.writeFileSync(FILE, 'not json at all');
    recent._reset();

    assert.doesNotThrow(() => recent.keys());
    assert.deepStrictEqual(recent.keys(), []);
});
