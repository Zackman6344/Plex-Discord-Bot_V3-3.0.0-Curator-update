const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-voice-' + process.pid);

const { VoiceConnectionStatus } = require('@discordjs/voice');
const Bot = require('../app/bot.js');
const commandLog = require('../helpers/commandLog.js');

test.afterEach(() => {
    try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
});

const channel = (id, name) => ({ id, name, guild: { id: 'g1', voiceAdapterCreator: () => ({}) } });

function messageIn(voiceChannel) {
    const sent = [];
    return {
        sent,
        member: { voice: { channel: voiceChannel } },
        channel: { async send(text) { sent.push(text); return {}; } },
        async reply(text) { sent.push(text); return {}; }
    };
}

test('a member who is not in a voice channel is told so, and nothing is queued as playing', async () => {
    const bot = new Bot({});
    bot.songQueue.push({ title: 'T', artist: 'A', key: '/k' });

    const message = messageIn(null);
    await bot.playSong(message);

    assert.match(message.sent.join(' '), /join a voice channel/i);
    assert.strictEqual(bot.isPlaying, false, 'playback must not be left marked as running');
    assert.strictEqual(bot.songQueue.length, 1, 'the queue is kept for when they join');
});

test('a stale channel is not reused once the connection is gone', () => {
    const bot = new Bot({});
    bot.voiceChannel = channel('old', 'Old Room');
    bot.conn = { state: { status: VoiceConnectionStatus.Destroyed } };

    // The requester is in a different channel now.
    const picked = bot.pickVoiceChannel(messageIn(channel('new', 'New Room')));
    assert.strictEqual(picked.id, 'new', 'follows the requester rather than a dead channel');

    // And with nobody in a channel at all, there is nowhere to play.
    assert.strictEqual(bot.pickVoiceChannel(messageIn(null)), null, 'no ghost channel to join');
});

test('an active connection keeps playback in the channel it is already in', () => {
    const bot = new Bot({});
    bot.voiceChannel = channel('current', 'Music');
    bot.conn = { state: { status: VoiceConnectionStatus.Ready } };

    const picked = bot.pickVoiceChannel(messageIn(channel('elsewhere', 'Other')));
    assert.strictEqual(picked.id, 'current', 'queueing from another channel must not drag the bot across');
});

test('a failed join resets state instead of wedging playback', () => {
    const bot = new Bot({});
    bot.isPlaying = true;
    bot.waitForStart = true;
    bot.waitForStartMessage = {};
    bot.voiceChannel = channel('c1', 'Music');
    bot.songQueue.push({ title: 'T', artist: 'A', key: '/k' });

    const message = messageIn(null);
    bot.failPlayback(message, new Error('AbortError: The operation was aborted'));

    assert.strictEqual(bot.isPlaying, false, 'isPlaying stuck true is what made the bot look dead');
    assert.strictEqual(bot.waitForStart, false);
    assert.strictEqual(bot.voiceChannel, null, 'so the next attempt re-reads where the user is');
    assert.strictEqual(bot.songQueue.length, 1, 'the queue survives the failure');
    assert.match(message.sent.join(' '), /couldn't get into the voice channel/i);
});

test('playSong never rejects, however badly the inner call fails', async () => {
    const bot = new Bot({});
    bot.runPlayback = async () => { throw new Error('boom'); };

    const message = messageIn(channel('c1', 'Music'));
    await assert.doesNotReject(() => bot.playSong(message), 'every caller is fire-and-forget');
    assert.strictEqual(bot.isPlaying, false);
    assert.match(message.sent.join(' '), /playback stopped/i);
});

test('a playback failure is recorded where it can be read back', () => {
    const bot = new Bot({});
    bot.voiceChannel = channel('c1', 'Music');
    bot.songQueue.push({ title: 'T', artist: 'A', key: '/k' });

    bot.failPlayback(messageIn(null), new Error('The operation was aborted'));

    const events = commandLog.readEventLog({ kind: 'playback-failed' });
    assert.strictEqual(events.length, 1, 'the queue-advance failure leaves a trace now');
    assert.strictEqual(events[0].channel, 'Music');
    assert.strictEqual(events[0].queueDepth, 1);
    assert.match(events[0].error, /aborted/);
});
