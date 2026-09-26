// !seek: what the player does when a track stops, and how a pending seek is consumed.
//
// The bug: !seek flagged the playing entry with isSeeking and seekOffset and stopped the player,
// but nothing read either flag, so the Idle handler shifted the queue and a seek was a skip.

const test = require('node:test');
const assert = require('node:assert');

const { afterTrack, takeSeek, seekArgs } = require('../helpers/seek.js');

const track = (title, extra) => Object.assign({ title, key: `/library/parts/${title}/1/file.flac` }, extra || {});

test('a flagged seek replays the entry instead of advancing', () => {
    const queue = [track('a', { isSeeking: true, seekOffset: 90000 }), track('b')];
    assert.strictEqual(afterTrack(queue), 'replay');
});

test('seeking the last track replays it rather than ending playback', () => {
    assert.strictEqual(afterTrack([track('a', { isSeeking: true, seekOffset: 90000 })]), 'replay');
});

test('a seek to 0:00 still replays, because the flag decides and not the offset', () => {
    assert.strictEqual(afterTrack([track('a', { isSeeking: true, seekOffset: 0 }), track('b')]), 'replay');
});

test('a stray offset without the flag does not hold the queue', () => {
    assert.strictEqual(afterTrack([track('a', { seekOffset: 90000 }), track('b')]), 'next');
});

test('an ordinary track advances, the last one finishes, and an empty queue finishes', () => {
    assert.strictEqual(afterTrack([track('a'), track('b')]), 'next');
    assert.strictEqual(afterTrack([track('a')]), 'finish');
    assert.strictEqual(afterTrack([]), 'finish');
});

test('loop still replays the head', () => {
    assert.strictEqual(afterTrack([track('a', { replay: true }), track('b')]), 'replay');
});

test('a seek on a looped track is used once, and the loop carries on from the start', () => {
    const head = track('a', { replay: true, isSeeking: true, seekOffset: 30000 });
    const queue = [head, track('b')];

    assert.strictEqual(afterTrack(queue), 'replay');
    assert.strictEqual(takeSeek(head), 30000);
    assert.strictEqual(afterTrack(queue), 'replay');
    assert.strictEqual(takeSeek(head), 0);
});

test('takeSeek hands back the offset once and clears both flags', () => {
    const head = track('a', { isSeeking: true, seekOffset: 90500 });

    assert.strictEqual(takeSeek(head), 90500);
    assert.strictEqual('isSeeking' in head, false);
    assert.strictEqual('seekOffset' in head, false);
    assert.strictEqual(takeSeek(head), 0);
    assert.strictEqual(afterTrack([head, track('b')]), 'next');
});

test('takeSeek starts from the beginning for no seek, a zero, negative, oversized or unusable offset', () => {
    assert.strictEqual(takeSeek(track('a')), 0);
    assert.strictEqual(takeSeek(undefined), 0);
    assert.strictEqual(takeSeek(track('a', { seekOffset: 5000 })), 0);
    // 9999999999999000 is what `!seek 9999999999999` parses to. ffmpeg refuses it as -ss, and
    // the player's error and Idle handlers then both advanced the queue.
    for (const seekOffset of [0, -5000, NaN, Infinity, 9999999999999000, '90000', undefined]) {
        const head = track('a', { isSeeking: true, seekOffset });
        assert.strictEqual(takeSeek(head), 0, `seekOffset ${String(seekOffset)}`);
        assert.strictEqual('isSeeking' in head, false);
    }
});

test('seekArgs seeks as an output option, after the piped input', () => {
    const args = seekArgs(90500);
    const input = args.indexOf('-i');
    const ss = args.indexOf('-ss');

    assert.strictEqual(args[input + 1], '-');
    assert.ok(ss > input, 'ahead of the input, -ss starts Ogg Opus late and Ogg Vorbis from the top');
    assert.strictEqual(args[ss + 1], '90.500');
});

test('seekArgs asks for the Ogg/Opus that StreamType.OggOpus expects, quietly', () => {
    const args = seekArgs(1000).join(' ');

    assert.match(args, /-acodec libopus -f opus -ar 48000 -ac 2$/);
    assert.match(args, /-loglevel 0/);
});
