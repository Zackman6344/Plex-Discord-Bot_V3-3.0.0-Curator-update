const test = require('node:test');
const assert = require('node:assert');

const {
    parseFinishedCollection, parseProcessed, parseMissing, describeCompleteness,
    parseLibraryHeader, collectionKey, extractJsonObject, normalizeName,
    classifyKind, buildStaticText,
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
test('parseFinishedCollection ignores every wording of the run-end separator', () => {
    assert.strictEqual(parseFinishedCollection('|   Finished Run   |'), null);
    assert.strictEqual(parseFinishedCollection('|   Finished Playlists Run   |'), null);
});

test('parseLibraryHeader reads the library section header', () => {
    assert.strictEqual(parseLibraryHeader('[t] [kometa.py:644] [INFO] |      Movies Library      |'), 'Movies');
    assert.strictEqual(parseLibraryHeader('[t] [kometa.py:644] [INFO] |     TV Shows Library     |'), 'TV Shows');
});

test('parseLibraryHeader rejects the other separators that end in "Library"', () => {
    const info = (text) => `[t] [x] [INFO] |   ${text}   |`;
    assert.strictEqual(parseLibraryHeader(info('Applying Overlays for the Movies Library')), null);
    assert.strictEqual(parseLibraryHeader(info('No Overlays to Remove for the Movies Library')), null);
    assert.strictEqual(parseLibraryHeader(info('Skipping Anime Library')), null);
    // Added by Kometa 2.4.8 (kometa.py:1129) — reads as a library named "Mapping Movies".
    assert.strictEqual(parseLibraryHeader(info('Mapping Movies Library')), null);
    assert.strictEqual(parseLibraryHeader(info('Removing Old Overlays for the Movies Library')), null);
    assert.strictEqual(parseLibraryHeader(info('Unconfigured Collections in Movies Library')), null);
    assert.strictEqual(parseLibraryHeader(info('Finished Nicolas Cage Collection')), null);
    // Kometa's own error text ends in "Library" too, and arrives at ERROR or as a bare traceback line.
    const err = 'Config Error: token attribute must be set under radarr globally or under this specific Library';
    assert.strictEqual(parseLibraryHeader(`[t] [config.py:1272] [ERROR] |   ${err}   |`), null);
    assert.strictEqual(parseLibraryHeader(`                     | modules.util.Failed: ${err} |`), null);
});

test('collectionKey separates same-named collections in different libraries', () => {
    assert.strictEqual(collectionKey('Movies', 'IMDb Top 250'), 'movies::imdb top 250');
    assert.strictEqual(collectionKey('TV Shows', 'The IMDb Top 250 Collection'), 'tv shows::imdb top 250');
    assert.notStrictEqual(collectionKey('Movies', 'IMDb Top 250'), collectionKey('TV Shows', 'IMDb Top 250'));
    // No library seen yet (a collection logged before its header) still keys cleanly.
    assert.strictEqual(collectionKey(null, 'IMDb Top 250'), 'imdb top 250');
});
test('parseMissing reads the per-collection missing count', () => {
    assert.strictEqual(parseMissing('[t] [x] [INFO] |   3 Movies Missing   |'), 3);
    assert.strictEqual(parseMissing('[t] [x] [INFO] |   1 Movie Missing   |'), 1);
    assert.strictEqual(parseMissing('[t] [x] [INFO] |   12 Shows Missing   |'), 12);
    // Kometa's lowercase progress line must not be mistaken for a count.
    assert.strictEqual(parseMissing('| Processing missing items: 1 movies and/or 0 missing shows |'), null);
    assert.strictEqual(parseMissing('| 3 Movies Processed 0 Movies Added |'), null);
});

test('describeCompleteness grades a collection by what it actually holds', () => {
    assert.strictEqual(describeCompleteness(3, 0).tier, 'complete');
    assert.strictEqual(describeCompleteness(3, null).tier, 'complete'); // no missing line logged = nothing missing
    assert.strictEqual(describeCompleteness(9, 1).tier, 'nearly');
    assert.strictEqual(describeCompleteness(4, 2).tier, 'patchy');
    assert.strictEqual(describeCompleteness(1, 9).tier, 'threadbare');
    const c = describeCompleteness(4, 2);
    assert.strictEqual(c.have, 4);
    assert.strictEqual(c.wanted, 6);
});

test('describeCompleteness gives no mood when the collection never built', () => {
    assert.strictEqual(describeCompleteness(null, 1), null); // minimum not met — held count unknown
    assert.strictEqual(describeCompleteness(null, null), null);
    assert.strictEqual(describeCompleteness(0, 0), null);
});

test('extractJsonObject takes the first balanced object, not the greediest match', () => {
    const persona = '{"callsign":"A","vibe":"B"}';
    assert.strictEqual(extractJsonObject(persona), persona);
    // What actually broke in production: prose around it, or a second object after it.
    assert.strictEqual(extractJsonObject('Here you go: ' + persona + ' Hope that helps!'), persona);
    assert.strictEqual(extractJsonObject(persona + ' and also {"other":1}'), persona);
    assert.strictEqual(JSON.parse(extractJsonObject('noise ' + persona + ' tail')).callsign, 'A');
});

test('extractJsonObject respects nesting and braces inside strings', () => {
    assert.strictEqual(extractJsonObject('x {"a":{"b":2},"c":"}"} y'), '{"a":{"b":2},"c":"}"}');
    assert.strictEqual(extractJsonObject('{"vibe":"uses { and } a lot"}'), '{"vibe":"uses { and } a lot"}');
});

test('extractJsonObject returns null when there is nothing parseable', () => {
    assert.strictEqual(extractJsonObject('no json here'), null);
    assert.strictEqual(extractJsonObject('{"callsign":"A"'), null); // never closed
    assert.strictEqual(extractJsonObject(''), null);
    assert.strictEqual(extractJsonObject(null), null);
});
