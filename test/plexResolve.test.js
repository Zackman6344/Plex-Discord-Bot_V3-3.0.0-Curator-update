// Re-resolving a Plex track when its stored key has gone dead.
//
// The failure this exists for: a 47-track playlist whose every key returned an HTML 404, which
// the player accepted as audio and skipped through in ten seconds without logging anything. The
// `ok` check is what makes that visible; the re-resolve is what makes it recoverable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');

const resolve = require('../helpers/plexResolve.js');

function track(title, artist, key, extra) {
    return Object.assign({
        title,
        grandparentTitle: artist,
        Media: [{ Part: [{ key: key || `/library/parts/1/2/${title}.flac` }] }]
    }, extra || {});
}

// --- picking the right track ----------------------------------------------------------------

test('a title and artist that both agree is the match', () => {
    const hit = resolve.bestMatch(
        [track('Delfino Plaza', 'Engelwood'), track('Good Evening', 'Engelwood')],
        { title: 'Good Evening', artist: 'Engelwood' }
    );
    assert.strictEqual(hit.title, 'Good Evening');
});

test('matching ignores case and punctuation', () => {
    const hit = resolve.bestMatch(
        [track("Don't Look Back", 'Engelwood')],
        { title: 'dont look back', artist: 'ENGELWOOD' }
    );
    assert.ok(hit, 'a stored title rarely matches a Plex title byte for byte');
});

test('a title match with the wrong artist is refused', () => {
    // A search for a common title returns every cover in the library. Queueing the first would
    // quietly play the wrong recording, which is worse than reporting the track as missing.
    const hit = resolve.bestMatch(
        [track('Daisy', 'Someone Else'), track('Daisy', 'A Third Artist')],
        { title: 'Daisy', artist: 'Engelwood' }
    );
    assert.strictEqual(hit, null);
});

test('the right artist is picked out of a pile of covers', () => {
    const hit = resolve.bestMatch(
        [track('Daisy', 'Someone Else'), track('Daisy', 'Engelwood'), track('Daisy', 'A Third')],
        { title: 'Daisy', artist: 'Engelwood' }
    );
    assert.strictEqual(resolve.artistOf(hit), 'Engelwood');
});

test('originalTitle wins over grandparentTitle, since Plex fills either', () => {
    const t = track('Miller Time', 'Engelwood', null, { originalTitle: 'Engelwood ft. Ian Ewing' });
    assert.strictEqual(resolve.artistOf(t), 'Engelwood ft. Ian Ewing');
    assert.ok(resolve.bestMatch([t], { title: 'Miller Time', artist: 'Engelwood ft. Ian Ewing' }));
});

test('with no artist recorded, one title match is accepted and two are not', () => {
    assert.ok(resolve.bestMatch([track('Hotel Rio', 'Engelwood')], { title: 'Hotel Rio' }));
    assert.strictEqual(
        resolve.bestMatch([track('Hotel Rio', 'A'), track('Hotel Rio', 'B')], { title: 'Hotel Rio' }),
        null
    );
});

test('a track carrying no part key is not a candidate', () => {
    const keyless = { title: 'Ghost', grandparentTitle: 'Engelwood', Media: [] };
    assert.strictEqual(resolve.bestMatch([keyless], { title: 'Ghost', artist: 'Engelwood' }), null);
});

test('empty and malformed searches answer null rather than throwing', () => {
    assert.strictEqual(resolve.bestMatch([], { title: 'x' }), null);
    assert.strictEqual(resolve.bestMatch(null, { title: 'x' }), null);
    assert.strictEqual(resolve.bestMatch([track('x', 'y')], {}), null);
});

// --- resolveKey against a stubbed Plex ------------------------------------------------------

test('resolveKey hands back the current key for a match', async () => {
    const bot = {
        async findTracksOnPlex() {
            return { MediaContainer: { Metadata: [track('Good Evening', 'Engelwood', '/library/parts/99/100/file.flac')] } };
        }
    };
    const hit = await resolve.resolveKey(bot, { title: 'Good Evening', artist: 'Engelwood' });
    assert.strictEqual(hit.key, '/library/parts/99/100/file.flac');
});

test('resolveKey survives a Plex that is down', async () => {
    const bot = { async findTracksOnPlex() { throw new Error('Plex Server denied request'); } };
    assert.strictEqual(await resolve.resolveKey(bot, { title: 'x', artist: 'y' }), null);
});

test('resolveKey copes with a single result arriving unwrapped', async () => {
    // xml2js hands back one object rather than a one-element array when there is a single hit.
    const bot = {
        async findTracksOnPlex() {
            return { MediaContainer: { Metadata: track('Dusk', 'Engelwood', '/library/parts/7/8/file.flac') } };
        }
    };
    const hit = await resolve.resolveKey(bot, { title: 'Dusk', artist: 'Engelwood' });
    assert.strictEqual(hit.key, '/library/parts/7/8/file.flac');
});

// --- writing the repair back ----------------------------------------------------------------

function tempPlaylistDir() {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plexbot-playlists-'));
    fs.writeFileSync(pathMod.join(dir, 'boardwalk.playlist'), JSON.stringify({
        nom: 'boardwalk',
        musiques: [
            { artiste: 'Engelwood', titre: 'Good Evening', cle: '/library/parts/1/OLD/file.flac' },
            { artiste: 'Engelwood', titre: 'Delfino Plaza', cle: '/library/parts/2/OLD/file.flac' },
            { artiste: 'Someone Else', titre: 'Good Evening', cle: '/library/parts/3/OLD/file.flac' }
        ]
    }), 'utf8');
    return dir;
}

test('persistKey rewrites only the entry that matches', async () => {
    const dir = tempPlaylistDir();
    try {
        const changed = await resolve.persistKey(dir, 'boardwalk',
            { title: 'Good Evening', artist: 'Engelwood' }, '/library/parts/1/NEW/file.flac');
        assert.strictEqual(changed, true);

        const after = JSON.parse(fs.readFileSync(pathMod.join(dir, 'boardwalk.playlist'), 'utf8'));
        assert.strictEqual(after.musiques[0].cle, '/library/parts/1/NEW/file.flac');
        assert.strictEqual(after.musiques[1].cle, '/library/parts/2/OLD/file.flac', 'a different track is untouched');
        // Same title, different artist. Leaving this alone is the whole reason artist is checked.
        assert.strictEqual(after.musiques[2].cle, '/library/parts/3/OLD/file.flac');
        assert.strictEqual(after.nom, 'boardwalk', 'the rest of the file survives');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('persistKey reports no change when the key is already current', async () => {
    const dir = tempPlaylistDir();
    try {
        const changed = await resolve.persistKey(dir, 'boardwalk',
            { title: 'Good Evening', artist: 'Engelwood' }, '/library/parts/1/OLD/file.flac');
        assert.strictEqual(changed, false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('persistKey never throws on a missing or unreadable playlist', async () => {
    const dir = tempPlaylistDir();
    try {
        assert.strictEqual(await resolve.persistKey(dir, 'no-such-list', { title: 'a' }, '/k'), false);
        fs.writeFileSync(pathMod.join(dir, 'broken.playlist'), 'not json at all', 'utf8');
        assert.strictEqual(await resolve.persistKey(dir, 'broken', { title: 'a' }, '/k'), false);
        // Playback has already succeeded by the time this runs; it must never be what fails.
        assert.strictEqual(await resolve.persistKey(dir, 'boardwalk', { title: 'a' }, null), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('persistKey leaves no temp file behind', async () => {
    const dir = tempPlaylistDir();
    try {
        await resolve.persistKey(dir, 'boardwalk',
            { title: 'Delfino Plaza', artist: 'Engelwood' }, '/library/parts/2/NEW/file.flac');
        assert.deepStrictEqual(
            fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [],
            'the write goes through a temp file and renames over the target'
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
