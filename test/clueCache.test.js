const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');

const clueCache = require('../helpers/clueCache.js');

// Each test seeds + cleans its own file so the suite is parallel-safe.
function uniqueTitle(label) {
    return `__cluecache_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(media) {
    try {
        await fs.unlink(clueCache.cacheFilePath(media));
    } catch (_) {
        // ignore missing
    }
}

test('slugify lowercases, replaces non-alphanumeric, trims hyphens', () => {
    assert.strictEqual(clueCache.slugify('The Matrix'), 'the-matrix');
    assert.strictEqual(clueCache.slugify('  Star Wars: Episode IV — A New Hope  '), 'star-wars-episode-iv-a-new-hope');
    assert.strictEqual(clueCache.slugify('!!!'), 'untitled');
    assert.strictEqual(clueCache.slugify(''), 'untitled');
});

test('cacheFilePath includes the slug + year and lives under data/clues/', () => {
    const p = clueCache.cacheFilePath({ title: 'The Matrix', year: 1999 });
    assert.match(p, /the-matrix-1999\.xml$/);
    assert.ok(p.includes(path.join('data', 'clues')));
});

test('getCachedClues returns null when no file exists', async () => {
    const media = { title: uniqueTitle('nope'), year: 2000 };
    const result = await clueCache.getCachedClues(media, 'trivia');
    assert.strictEqual(result, null);
});

test('save then get round-trips clue data', async () => {
    const media = { title: uniqueTitle('roundtrip'), year: 2021, type: 'movie' };
    try {
        const clues = { clue1: 'vague hint', clue2: 'medium hint', clue3: 'big hint' };
        await clueCache.saveClues(media, 'trivia', clues, 'test-model');

        const cached = await clueCache.getCachedClues(media, 'trivia');
        assert.ok(cached, 'cached value should not be null');
        assert.strictEqual(cached.data.clue1, 'vague hint');
        assert.strictEqual(cached.data.clue2, 'medium hint');
        assert.strictEqual(cached.data.clue3, 'big hint');
        assert.strictEqual(cached.model, 'test-model');
        assert.strictEqual(cached.variantCount, 1);
    } finally {
        await cleanup(media);
    }
});

test('multiple variants accumulate, getCachedClues picks one', async () => {
    const media = { title: uniqueTitle('variants'), year: 2022 };
    try {
        await clueCache.saveClues(media, 'badplot', { line: 'first' }, 'm1');
        await clueCache.saveClues(media, 'badplot', { line: 'second' }, 'm1');
        await clueCache.saveClues(media, 'badplot', { line: 'third' }, 'm1');

        const cached = await clueCache.getCachedClues(media, 'badplot');
        assert.strictEqual(cached.variantCount, 3);
        assert.ok(['first', 'second', 'third'].includes(cached.data.line));
    } finally {
        await cleanup(media);
    }
});

test('different minigames coexist in the same file', async () => {
    const media = { title: uniqueTitle('crossref'), year: 2023 };
    try {
        await clueCache.saveClues(media, 'trivia', { clue1: 'T' }, 'm');
        await clueCache.saveClues(media, 'badplot', { line: 'B' }, 'm');
        await clueCache.saveClues(media, 'rumor', { hook: 'R' }, 'm');

        const t = await clueCache.getCachedClues(media, 'trivia');
        const b = await clueCache.getCachedClues(media, 'badplot');
        const r = await clueCache.getCachedClues(media, 'rumor');

        assert.strictEqual(t.data.clue1, 'T');
        assert.strictEqual(b.data.line, 'B');
        assert.strictEqual(r.data.hook, 'R');
    } finally {
        await cleanup(media);
    }
});

test('getOrGenerate calls generator on miss and skips it on hit', async () => {
    const media = { title: uniqueTitle('getorgen'), year: 2024 };
    try {
        let calls = 0;
        const gen = async () => {
            calls++;
            return { value: `generated-${calls}` };
        };

        const first = await clueCache.getOrGenerate(media, 'reviewbomb', gen, 'm');
        assert.strictEqual(first.value, 'generated-1');
        assert.strictEqual(calls, 1);

        const second = await clueCache.getOrGenerate(media, 'reviewbomb', gen, 'm');
        assert.strictEqual(second.value, 'generated-1', 'should reuse cached variant');
        assert.strictEqual(calls, 1, 'generator should NOT have been called again');
    } finally {
        await cleanup(media);
    }
});

test('getCachedClues returns null for an existing file with no matching minigame', async () => {
    const media = { title: uniqueTitle('partial'), year: 2025 };
    try {
        await clueCache.saveClues(media, 'trivia', { clue1: 'x' }, 'm');
        const other = await clueCache.getCachedClues(media, 'castingcouch');
        assert.strictEqual(other, null);
    } finally {
        await cleanup(media);
    }
});

test('handles media with no title gracefully (returns null on lookup, no-op on save)', async () => {
    const result = await clueCache.getCachedClues({}, 'trivia');
    assert.strictEqual(result, null);
    // Should not throw
    await clueCache.saveClues({}, 'trivia', { c: 'x' }, 'm');
});
