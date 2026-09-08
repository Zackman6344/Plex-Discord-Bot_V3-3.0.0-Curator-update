// The response.ok guard on the Plex stream fetch.
//
// The bug: fetch does not throw on 404, and Plex answers a dead part key with an 85-byte HTML
// error page. That page became the audio resource, ended immediately, the player went Idle and
// the queue advanced, so a 47-track playlist drained in ten seconds with nothing in the log.
//
// The methods are exercised off Bot.prototype with a stub `this`, because constructing a real
// Bot needs a Discord client and a live Plex connection, neither of which this is about.

const test = require('node:test');
const assert = require('node:assert');

const Bot = require('../app/bot.js');

function stubBot(over) {
    const sent = [];
    return Object.assign({
        sent,
        config: { playlistsDir: 'playlists/' },
        songQueue: [],
        unplayable: [],
        message: { channel: { send: async (text) => { sent.push(text); return {}; } } },
        // No search unless a test supplies one.
        async findTracksOnPlex() { return { MediaContainer: { Metadata: [] } }; },
        openPlexStream: Bot.prototype.openPlexStream,
        noteUnplayable: Bot.prototype.noteUnplayable,
        reportUnplayable: Bot.prototype.reportUnplayable
    }, over || {});
}

/** Swap global fetch for the duration of one test. */
function withFetch(t, impl) {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    t.after(() => { globalThis.fetch = real; });
}

test('a 200 is passed straight through', async (t) => {
    const bot = stubBot();
    withFetch(t, async () => ({ ok: true, status: 200, body: 'audio-bytes' }));

    const res = await bot.openPlexStream({ title: 'Good Evening', artist: 'Engelwood', key: '/k' }, bot.message);
    assert.ok(res, 'a working key needs no repair');
    assert.strictEqual(res.body, 'audio-bytes');
    assert.strictEqual(bot.sent.length, 0, 'and says nothing');
});

test('a 404 with no replacement is refused rather than played', async (t) => {
    const bot = stubBot();
    // Exactly what Plex returns for a dead part key: not an error, just the wrong bytes.
    withFetch(t, async () => ({ ok: false, status: 404, body: '<html>404 Not Found</html>' }));

    const res = await bot.openPlexStream({ title: 'Good Evening', artist: 'Engelwood', key: '/dead' }, bot.message);
    assert.strictEqual(res, null, 'the HTML error page must never reach the audio player');
    assert.strictEqual(bot.sent.length, 1);
    assert.match(bot.sent[0], /Good Evening/);
    assert.match(bot.sent[0], /404/);
});

test('a dead key is repaired and the track plays', async (t) => {
    const bot = stubBot({
        async findTracksOnPlex() {
            return { MediaContainer: { Metadata: [{
                title: 'Good Evening',
                grandparentTitle: 'Engelwood',
                Media: [{ Part: [{ key: '/library/parts/1/NEW/file.flac' }] }]
            }] } };
        }
    });
    withFetch(t, async (url) => (String(url).includes('NEW')
        ? { ok: true, status: 200, body: 'audio-bytes' }
        : { ok: false, status: 404, body: '<html>' }));

    const track = { title: 'Good Evening', artist: 'Engelwood', key: '/library/parts/1/OLD/file.flac' };
    const res = await bot.openPlexStream(track, bot.message);

    assert.ok(res, 'the second attempt succeeded');
    assert.strictEqual(res.body, 'audio-bytes');
    // Carried on the queue entry so a replay of this track uses the working key too.
    assert.strictEqual(track.key, '/library/parts/1/NEW/file.flac');
    assert.strictEqual(bot.sent.length, 0, 'a repair the user never had to know about');
});

test('a lookup returning the same dead key does not retry it', async (t) => {
    // What the live server actually does when the library itself points at a missing file: the
    // search answers happily with the very key that just 404d.
    let calls = 0;
    const bot = stubBot({
        async findTracksOnPlex() {
            return { MediaContainer: { Metadata: [{
                title: 'Good Evening',
                grandparentTitle: 'Engelwood',
                Media: [{ Part: [{ key: '/dead' }] }]
            }] } };
        }
    });
    withFetch(t, async () => { calls++; return { ok: false, status: 404, body: '<html>' }; });

    const res = await bot.openPlexStream({ title: 'Good Evening', artist: 'Engelwood', key: '/dead' }, bot.message);
    assert.strictEqual(res, null);
    assert.strictEqual(calls, 1, 'no point fetching a key that just failed');
});

test('a network failure is handled like a bad status', async (t) => {
    const bot = stubBot();
    withFetch(t, async () => { throw new Error('ECONNREFUSED'); });

    const res = await bot.openPlexStream({ title: 'Dusk', artist: 'Engelwood', key: '/k' }, bot.message);
    assert.strictEqual(res, null);
    assert.match(bot.sent[0], /ECONNREFUSED/);
});

// --- not drowning the channel ---------------------------------------------------------------

test('a wholly broken library reports three tracks and then a summary', async (t) => {
    const bot = stubBot();
    withFetch(t, async () => ({ ok: false, status: 404, body: '<html>' }));

    // The real case: every track in a 47-track playlist is dead.
    for (let i = 1; i <= 47; i++) {
        await bot.openPlexStream({ title: `Track ${i}`, artist: 'Engelwood', key: `/dead-${i}` }, bot.message);
    }
    assert.strictEqual(bot.sent.length, 3, '47 individual complaints would be worse than the silence it replaced');
    assert.strictEqual(bot.unplayable.length, 47, 'but all of them are counted');

    bot.reportUnplayable(bot.message);
    assert.strictEqual(bot.sent.length, 4);
    assert.match(bot.sent[3], /47 tracks/);
    assert.match(bot.sent[3], /re-scan/, 'and says what to actually do about it');
});

test('a summary is not posted when only a couple of tracks failed', async (t) => {
    const bot = stubBot();
    withFetch(t, async () => ({ ok: false, status: 404, body: '<html>' }));

    await bot.openPlexStream({ title: 'One', artist: 'A', key: '/x' }, bot.message);
    await bot.openPlexStream({ title: 'Two', artist: 'A', key: '/y' }, bot.message);
    bot.reportUnplayable(bot.message);

    assert.strictEqual(bot.sent.length, 2, 'both were already named individually');
});

test('the failure list is cleared, so the next playlist starts clean', async (t) => {
    const bot = stubBot();
    withFetch(t, async () => ({ ok: false, status: 404, body: '<html>' }));

    await bot.openPlexStream({ title: 'One', artist: 'A', key: '/x' }, bot.message);
    bot.reportUnplayable(bot.message);
    assert.strictEqual(bot.unplayable.length, 0);
});
