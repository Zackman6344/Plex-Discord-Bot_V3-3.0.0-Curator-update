// helpers/seek.js
//
// The decisions behind `!seek`, kept out of app/bot.js so they can be tested without a voice
// connection.
//
// `!seek` flags the playing queue entry with `isSeeking` and `seekOffset`, then stops the player.
// The player going Idle is also what ends a track normally, so whether that stop means "advance"
// or "start this entry again, further in" has to be read off the queue.

/**
 * What the player does once the track at the head of the queue stops.
 *
 * A pending seek replays the entry the way loop does, and is checked ahead of the queue length:
 * checked after it, seeking the last track would end playback. Keyed on `isSeeking` rather than
 * the offset, because `!seek 0` is a valid seek.
 *
 * @returns {'replay'|'next'|'finish'}
 */
function afterTrack(queue) {
    const head = queue[0];
    if (!head) return 'finish';
    if (head.isSeeking || head.replay) return 'replay';
    return queue.length > 1 ? 'next' : 'finish';
}

/**
 * Consume a pending seek on `track`, returning where to start in milliseconds, 0 for none.
 *
 * Read once, where the stream is built, rather than in the Idle handler. A seek that lands while
 * the next track is still loading has no player to stop, and a flag nobody cleared would sit on
 * the entry until the track ended and then replay it.
 */
function takeSeek(track) {
    if (!track || !track.isSeeking) return 0;
    const ms = track.seekOffset;
    delete track.isSeeking;
    delete track.seekOffset;
    return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}

/**
 * ffmpeg arguments for a track started `ms` in: @discordjs/voice's own Ogg/Opus arguments plus
 * `-ss`.
 *
 * `-ss` goes after `-i -`. The input arrives down a pipe, which ffmpeg cannot seek, and as an
 * input option `-ss` started Ogg Opus late and ignored a deep seek in Ogg Vorbis. As an output
 * option ffmpeg decodes and discards up to the offset, which landed exactly in every format that
 * played.
 */
function seekArgs(ms) {
    return [
        '-i', '-',
        '-analyzeduration', '0', '-loglevel', '0',
        '-ss', (ms / 1000).toFixed(3),
        '-acodec', 'libopus', '-f', 'opus', '-ar', '48000', '-ac', '2'
    ];
}

module.exports = { afterTrack, takeSeek, seekArgs };
