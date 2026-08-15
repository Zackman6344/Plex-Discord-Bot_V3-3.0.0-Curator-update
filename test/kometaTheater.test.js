const test = require('node:test');
const assert = require('node:assert');

const {
    parseFinishedCollection, parseProcessed, normalizeName, classifyKind, buildStaticText,
} = require('../helpers/kometaTheater.js');

test('parseFinishedCollection extracts the collection name from a log line', () => {
    assert.strictEqual(
        parseFinishedCollection('[t] [collection.py:9] [INFO] |     Finished Nicolas Cage Collection     |'),
        'Nicolas Cage',
    );
    assert.strictEqual(
        parseFinishedCollection('[t] [x] [INFO] | Finished Peak Anime Collection |'),
        'Peak Anime',
    );
});

test('parseFinishedCollection ignores the run-end line and non-collection lines', () => {
    assert.strictEqual(parseFinishedCollection('|   Finished Collections Run   |'), null);
    assert.strictEqual(parseFinishedCollection('| Loading All Movies from Library: Movies |'), null);
    assert.strictEqual(parseFinishedCollection(''), null);
});

test('normalizeName aligns log and webhook spellings of the same collection', () => {
    assert.strictEqual(normalizeName('The Nicolas Cage Collection'), 'nicolas cage');
    assert.strictEqual(normalizeName('Nicolas Cage'), 'nicolas cage');
    assert.strictEqual(normalizeName('  PG-13  '), 'pg-13');
});

test('parseProcessed reads the per-collection item count', () => {
    assert.deepStrictEqual(parseProcessed('[t] [x] [INFO] | 250 Movies Processed 0 Movies Added |'), { total: 250, added: 0 });
    assert.deepStrictEqual(parseProcessed('| 16 Shows Processed 3 Shows Added |'), { total: 16, added: 3 });
    assert.strictEqual(parseProcessed('| Finished IMDb Popular Collection |'), null);
});

test('classifyKind: static ONLY when a collection is unseen AND empty (no content)', () => {
    assert.strictEqual(classifyKind(false, false), 'static'); // unseen + empty → static
    assert.strictEqual(classifyKind(false, true), 'report');  // unseen but holds items → comes alive
    assert.strictEqual(classifyKind(true, false), 'report');  // established → reports in
    assert.strictEqual(classifyKind(true, true), 'report');
});

test('buildStaticText is deterministic and carries no plain dialogue', () => {
    const a = buildStaticText('Peak Anime');
    const b = buildStaticText('Peak Anime');
    assert.strictEqual(a, b);
    assert.ok(a.includes('▓') && a.includes('unidentified signal'));
});
