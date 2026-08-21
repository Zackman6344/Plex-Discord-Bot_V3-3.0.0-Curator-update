const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const os = require('node:os');
const pathMod = require('node:path');

// Its own store, so parallel test files cannot race on one file and a run can never
// disturb the real one.
process.env.PLEXBOT_TAGS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-sidecar-' + process.pid + '.json');

const sidecar = require('../helpers/tagSidecar.js');

// The sidecar persists to data/inferred_tags.json. These tests exercise real load/save paths and
// restore whatever was on disk afterwards, so running them can never cost real approved tags.
const FILE = sidecar._file;
test.afterEach(() => {
    try { fs.unlinkSync(FILE); } catch (_) {}
    try { fs.unlinkSync(FILE + '.tmp'); } catch (_) {}
    sidecar._reset();
});

const proposal = (over = {}) => ({
    ratingKey: '99', title: 'T', artist: 'A', moods: ['Dreamy'], genres: [], styles: [], ...over
});

test('missingDimensions reports only what Plex has nothing for', () => {
    assert.deepStrictEqual(sidecar.missingDimensions({ Genre: [{ tag: 'Electronic' }] }), ['moods', 'styles']);
    assert.deepStrictEqual(sidecar.missingDimensions({ Mood: [{ tag: 'Dark' }], Genre: [{ tag: 'Rock' }], Style: [{ tag: 'Indie' }] }), []);
    assert.deepStrictEqual(sidecar.missingDimensions({}), ['moods', 'genres', 'styles']);
});

test('Plex data always wins over an inferred entry, per dimension', () => {
    const id = sidecar.stage([proposal({ genres: ['Jazz'] })], 'user1');
    sidecar.approve(id, 'user1');

    const merged = sidecar.effectiveTags('99', { Genre: [{ tag: 'Electronic' }] });
    assert.deepStrictEqual(merged.genres, ['Electronic'], 'Plex genre must not be overridden');
    assert.deepStrictEqual(merged.moods, ['Dreamy'], 'inferred mood fills the gap');
    assert.deepStrictEqual(merged.inferredDimensions, ['moods']);
});

test('a superseded entry stops being consulted entirely', () => {
    const id = sidecar.stage([proposal({ ratingKey: '100' })], 'user1');
    sidecar.approve(id, 'user1');
    sidecar.supersede('100');

    const merged = sidecar.effectiveTags('100', {});
    assert.deepStrictEqual(merged.moods, [], 'retired guesses must not resurface');
    assert.deepStrictEqual(merged.inferredDimensions, []);
});

test('nothing is written until a proposal is approved', () => {
    const id = sidecar.stage([proposal({ ratingKey: '101' })], 'user1');
    assert.strictEqual(sidecar.get('101'), null, 'staging must not persist to entries');

    const { written, saved } = sidecar.approve(id, 'user1');
    assert.strictEqual(written, 1);
    assert.ok(saved);
    assert.ok(sidecar.get('101'));
});

test('discarding leaves no trace and cannot be approved afterwards', () => {
    const id = sidecar.stage([proposal({ ratingKey: '102' })], 'user1');
    sidecar.discard(id);

    assert.strictEqual(sidecar.getProposal(id), null);
    assert.strictEqual(sidecar.approve(id, 'user1').written, 0);
    assert.strictEqual(sidecar.get('102'), null);
});

test('a pending proposal survives a restart', () => {
    const id = sidecar.stage([proposal({ ratingKey: '103' })], 'user1');

    sidecar._reset(); // simulate the bot restarting between proposal and approval

    const recovered = sidecar.getProposal(id);
    assert.ok(recovered, 'the review card must still mean something after a restart');
    assert.strictEqual(recovered.entries[0].ratingKey, '103');
    assert.strictEqual(sidecar.approve(id, 'user1').written, 1);
});

test('a failed write keeps the proposal live so the button can be retried', (t) => {
    const id = sidecar.stage([proposal({ ratingKey: '104' })], 'user1');
    t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: disk full'); });

    const result = sidecar.approve(id, 'user1');
    assert.strictEqual(result.saved, false);
    assert.strictEqual(result.written, 0);
    assert.strictEqual(result.reason, 'write-failed');

    t.mock.restoreAll();
    assert.ok(sidecar.getProposal(id), 'the proposal must not be consumed by a failed save');
    assert.strictEqual(sidecar.approve(id, 'user1').written, 1, 'retry succeeds once the disk is writable');
});

test('junk proposals are rejected rather than stored', () => {
    assert.strictEqual(sidecar.sanitizeEntry(null), null);
    assert.strictEqual(sidecar.sanitizeEntry({ ratingKey: '1' }), null, 'no tags means nothing to store');
    assert.strictEqual(sidecar.sanitizeEntry({ moods: ['Dark'] }), null, 'no rating key means unattributable');
    assert.strictEqual(sidecar.sanitizeEntry({ ratingKey: '../../etc/passwd', moods: ['Dark'] }), null, 'rating key is validated');

    const cleaned = sidecar.sanitizeEntry({ ratingKey: '7', moods: ['Dark', 'dark', '', 42, ' Eerie '] });
    assert.deepStrictEqual(cleaned.moods, ['Dark', 'Eerie'], 'dupes, blanks and non-strings are dropped');

    assert.strictEqual(sidecar.stage([{ nonsense: true }], 'user1'), null, 'an all-junk batch stages nothing');
});

test('settings clamp to their bounds and reject nonsense', () => {
    assert.deepStrictEqual(sidecar.getSettings(), sidecar.SETTING_DEFAULTS);

    assert.strictEqual(sidecar.setSetting('discoveryPercent', 40).ok, true);
    assert.strictEqual(sidecar.getSettings().discoveryPercent, 40);

    assert.strictEqual(sidecar.setSetting('discoveryPercent', 500).ok, false);
    assert.strictEqual(sidecar.setSetting('discoveryPercent', 'lots').ok, false);
    assert.strictEqual(sidecar.setSetting('nonsense', 1).ok, false);
    assert.strictEqual(sidecar.getSettings().discoveryPercent, 40, 'a rejected write must not change the value');
});

test('findByTags matches approved entries and skips superseded ones', () => {
    const id = sidecar.stage([
        { ratingKey: '200', title: 'A', artist: 'X', moods: ['Gloomy', 'Eerie'] },
        { ratingKey: '201', title: 'B', artist: 'Y', moods: ['Upbeat'] }
    ], 'user1');
    sidecar.approve(id, 'user1');

    const hits = sidecar.findByTags({ moods: ['gloomy'] });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].ratingKey, '200');
    assert.deepStrictEqual(hits[0].matched.moods, ['Gloomy']);

    sidecar.supersede('200');
    assert.strictEqual(sidecar.findByTags({ moods: ['gloomy'] }).length, 0);
});

test('a corrupt sidecar file is left alone rather than overwritten', () => {
    fs.writeFileSync(FILE, '{ this is not json');
    sidecar._reset();

    assert.deepStrictEqual(sidecar.stats().active, 0, 'bot keeps working on a fresh in-memory store');
    assert.strictEqual(fs.readFileSync(FILE, 'utf8'), '{ this is not json', 'the damaged file is preserved for salvage');
});
