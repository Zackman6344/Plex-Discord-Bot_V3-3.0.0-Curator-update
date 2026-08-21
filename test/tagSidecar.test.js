const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const sidecar = require('../helpers/tagSidecar.js');

// The sidecar persists to data/inferred_tags.json. These tests exercise the in-memory behaviour
// and restore whatever was on disk afterwards, so running them can't cost real approved tags.
const FILE = sidecar._file;
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;

test.afterEach(() => {
    if (backup === null) { try { fs.unlinkSync(FILE); } catch (_) {} }
    else fs.writeFileSync(FILE, backup);
    sidecar._reset();
});

test('missingDimensions reports only what Plex has nothing for', () => {
    const track = { Genre: [{ tag: 'Electronic' }] };
    assert.deepStrictEqual(sidecar.missingDimensions(track), ['moods', 'styles']);

    const fullyTagged = { Mood: [{ tag: 'Dark' }], Genre: [{ tag: 'Rock' }], Style: [{ tag: 'Indie' }] };
    assert.deepStrictEqual(sidecar.missingDimensions(fullyTagged), []);

    assert.deepStrictEqual(sidecar.missingDimensions({}), ['moods', 'genres', 'styles']);
});

test('Plex data always wins over an inferred entry, per dimension', () => {
    const id = sidecar.stage([{ ratingKey: '99', title: 'T', artist: 'A', moods: ['Dreamy'], genres: ['Jazz'], styles: [] }], 'user1');
    sidecar.approve(id, 'user1');

    // Plex knows the genre but not the mood: its genre wins, the inferred mood fills the gap.
    const track = { Genre: [{ tag: 'Electronic' }] };
    const merged = sidecar.effectiveTags('99', track);

    assert.deepStrictEqual(merged.genres, ['Electronic'], 'Plex genre must not be overridden');
    assert.deepStrictEqual(merged.moods, ['Dreamy'], 'inferred mood fills the gap');
    assert.deepStrictEqual(merged.inferredDimensions, ['moods']);
});

test('an inferred entry is ignored entirely once Plex covers the dimension', () => {
    const id = sidecar.stage([{ ratingKey: '100', title: 'T', artist: 'A', moods: ['Dreamy'], genres: [], styles: [] }], 'user1');
    sidecar.approve(id, 'user1');

    const merged = sidecar.effectiveTags('100', { Mood: [{ tag: 'Aggressive' }] });
    assert.deepStrictEqual(merged.moods, ['Aggressive']);
    assert.deepStrictEqual(merged.inferredDimensions, []);
});

test('nothing is written until a proposal is approved', () => {
    const id = sidecar.stage([{ ratingKey: '101', title: 'T', artist: 'A', moods: ['Dreamy'], genres: [], styles: [] }], 'user1');

    assert.strictEqual(sidecar.get('101'), null, 'staging must not persist');

    const { written } = sidecar.approve(id, 'user1');
    assert.strictEqual(written, 1);
    assert.ok(sidecar.get('101'), 'approval persists');
});

test('discarding a proposal leaves no trace', () => {
    const id = sidecar.stage([{ ratingKey: '102', title: 'T', artist: 'A', moods: ['Dreamy'], genres: [], styles: [] }], 'user1');
    sidecar.discard(id);

    assert.strictEqual(sidecar.getProposal(id), null);
    assert.strictEqual(sidecar.approve(id, 'user1').written, 0, 'a discarded proposal cannot be approved');
    assert.strictEqual(sidecar.get('102'), null);
});

test('findByTags matches approved entries and skips superseded ones', () => {
    const id = sidecar.stage([
        { ratingKey: '200', title: 'A', artist: 'X', moods: ['Gloomy', 'Eerie'], genres: [], styles: [] },
        { ratingKey: '201', title: 'B', artist: 'Y', moods: ['Upbeat'], genres: [], styles: [] }
    ], 'user1');
    sidecar.approve(id, 'user1');

    const hits = sidecar.findByTags({ moods: ['gloomy'] });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].ratingKey, '200');
    assert.deepStrictEqual(hits[0].matched.moods, ['Gloomy']);

    sidecar.supersede('200');
    assert.strictEqual(sidecar.findByTags({ moods: ['gloomy'] }).length, 0, 'superseded entries drop out of search');
});
