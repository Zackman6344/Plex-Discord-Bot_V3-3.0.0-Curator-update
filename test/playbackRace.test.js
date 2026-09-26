// A skip or stop that lands while runPlayback is still waiting on Plex or on the voice join.
//
// The bug: stop() destroys and nulls this.conn, but runPlayback carried on once the download came
// back, built a player, and called this.conn.subscribe on null. playSong's catch then posted "I
// couldn't get into the voice channel", and the player it had already built, with nothing
// subscribed, went Idle and moved the queue on by itself. After !stop that player reached Playing
// on the emptied queue and threw from its listener, which only the process-level handler caught.
//
// @discordjs/voice is swapped in require.cache before app/bot.js destructures it, so the real
// runPlayback and the real skip, stop and seek commands run against a player that needs no ffmpeg
// and a connection that needs no Discord. The tests move the player to Playing and Idle by hand,
// standing in for the audio arriving and running out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-race-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus } = voice;

const players = [];

class FakePlayer extends EventEmitter {
    constructor() {
        super();
        this.state = { status: AudioPlayerStatus.Idle };
        players.push(this);
    }

    play(resource) {
        this.resource = resource;
        this.go(AudioPlayerStatus.Buffering);
    }

    // Unforced, the real player plays out a few frames of silence before it goes Idle.
    stop(force) {
        if (this.state.status === AudioPlayerStatus.Idle) return false;
        if (force) this.go(AudioPlayerStatus.Idle);
        else setImmediate(() => this.go(AudioPlayerStatus.Idle));
        return true;
    }

    go(status) {
        const old = this.state;
        if (old.status === status) return;
        this.state = { status };
        this.emit(status, old, this.state);
    }
}

require.cache[voicePath].exports = Object.assign({}, voice, {
    createAudioPlayer: () => new FakePlayer(),
    createAudioResource: (input) => ({ input })
});

const Bot = require('../app/bot.js');
const commandLog = require('../helpers/commandLog.js');
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');
const seekCmd = require('../commands/seek.js');
const loop = require('../commands/loop.js');
const removesong = require('../commands/removesong.js');
const clearqueue = require('../commands/clearqueue.js');

test.beforeEach(() => { players.length = 0; });
test.afterEach(() => {
    try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
});

const plex = (title) => ({ title, artist: 'Engelwood', key: `/library/parts/${title}/1/file.flac` });

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

async function until(cond, what) {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setImmediate(r));
    assert.ok(cond(), `timed out waiting for ${what}`);
}

function connection() {
    return {
        state: { status: VoiceConnectionStatus.Ready },
        subscribed: null,
        subscribe(player) { this.subscribed = player; },
        destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; }
    };
}

/**
 * A Bot with `queue` loaded, whose Plex downloads each wait for the test to call `arrive()`.
 * openConnection reuses a live connection the way joinVoiceChannel does.
 */
function setup(queue) {
    const bot = new Bot({});
    bot.songQueue.push(...queue);

    const fetches = [];
    bot.openPlexStream = (track) => new Promise((resolve) => {
        const fetch = { track, cancelled: false };
        const body = new ReadableStream({ cancel() { fetch.cancelled = true; } });
        fetch.arrive = () => resolve({ ok: true, status: 200, body });
        fetches.push(fetch);
    });
    bot.openConnection = async () => (bot.conn && bot.conn.state.status === VoiceConnectionStatus.Ready
        ? bot.conn
        : connection());

    const sent = [];
    const voiceChannel = { id: 'c1', name: 'Music', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } };
    const message = {
        member: { voice: { channel: voiceChannel } },
        channel: { async send(x) { sent.push(x); return {}; } },
        async reply(x) { sent.push(x); return {}; }
    };
    const finished = [];
    bot.on('finish', () => finished.push(true));

    const text = () => sent.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    const announced = () => sent
        .filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
        .map(x => x.embeds[0].fields[0].value);
    return { bot, message, fetches, finished, text, announced };
}

/** Make the next voice join wait for the returned function, as a fresh join to Discord does. */
function holdNextJoin(bot) {
    const reuse = bot.openConnection;
    const hold = { joined: null };
    bot.openConnection = () => new Promise((resolve) => {
        hold.joined = () => { bot.openConnection = reuse; resolve(connection()); };
    });
    return hold;
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
    bot.songQueue.push(track);
    if (!bot.isPlaying) bot.playSong(message);
}

/** Play A through to Playing, so the queue is mid-playlist. */
async function playFirst(ctx) {
    ctx.bot.playSong(ctx.message);
    await until(() => ctx.fetches.length === 1, 'the download of A');
    ctx.fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
}

test('a skip while the track downloads moves on, without claiming the join failed', async () => {
    const { bot, message, fetches, text, announced } = setup([plex('A'), plex('B')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');

    skip.command.process(bot, null, message, '');
    fetches[0].arrive();
    await settle();

    assert.doesNotMatch(text(), /couldn't get into the voice channel/i, 'the join never failed');
    assert.strictEqual(fetches[0].cancelled, true, 'the download of the skipped track is dropped');
    assert.strictEqual(players.length, 0, 'no player is built for a track nobody will hear');
    assert.strictEqual(fetches.length, 2, 'the skip still moves on');
    assert.strictEqual(fetches[1].track.title, 'B');
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);

    fetches[1].arrive();
    await until(() => players.length === 1, 'a player for B');
    assert.strictEqual(bot.conn.subscribed, players[0], 'B plays through a live connection');
    players[0].go(AudioPlayerStatus.Playing);
    assert.deepStrictEqual(announced(), ['B'], 'the skipped track is never announced');
});

test('a stop while the next track downloads ends playback quietly', async () => {
    const { bot, message, fetches, finished, text } = setup([plex('A'), plex('B')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
    players[0].go(AudioPlayerStatus.Idle);
    await until(() => fetches.length === 2, 'the download of B');

    stop.command.process(bot, null, message);
    fetches[1].arrive();
    await settle();

    assert.doesNotMatch(text(), /couldn't get into the voice channel/i);
    assert.strictEqual(fetches[1].cancelled, true, 'the download of B is dropped');
    assert.strictEqual(players.length, 1, 'B never gets a player, so none can reach Playing on an empty queue');
    assert.strictEqual(bot.isPlaying, false, 'playback is over, so the next !play starts it again');
    assert.strictEqual(finished.length, 1, 'finish fires once, as it does for a stop mid-track');
    assert.strictEqual(bot.conn, null);
});

test('a stop before the player reaches Playing does not trip over the emptied queue', async () => {
    const { bot, message, fetches, finished } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering);

    stop.command.process(bot, null, message);
    // The unforced stop leaves the player to reach Playing, and only then play out its silence.
    assert.doesNotThrow(() => players[0].go(AudioPlayerStatus.Playing));
    await until(() => players[0].state.status === AudioPlayerStatus.Idle, 'the player to go Idle');

    assert.strictEqual(bot.isPlaying, false);
    assert.strictEqual(finished.length, 1);
});

test('a skip while the bot is still joining skips the track before it is downloaded', async () => {
    const { bot, message, fetches } = setup([plex('A'), plex('B')]);
    const hold = holdNextJoin(bot);
    bot.playSong(message);
    await until(() => hold.joined, 'the join to start');

    skip.command.process(bot, null, message, '');
    hold.joined();
    await until(() => fetches.length === 1, 'a download');

    assert.strictEqual(fetches[0].track.title, 'B', 'the skipped track is not fetched at all');
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);
});

test('a skip after a seek on the downloading track still skips it', async () => {
    const { bot, message, fetches, text } = setup([plex('A'), plex('B'), plex('C')]);
    // A seeked track gets its own ffmpeg, which this test has no use for.
    bot.seekResource = (readstream) => ({ input: readstream });
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
    players[0].go(AudioPlayerStatus.Idle);
    await until(() => fetches.length === 2, 'the download of B');

    // Flags B for a replay from 1:00, which would otherwise outrank the skip.
    await seekCmd.command.process(bot, null, message, '1:00');
    skip.command.process(bot, null, message, '');
    fetches[1].arrive();
    await until(() => fetches.length === 3, 'the next download');

    assert.strictEqual(fetches[2].track.title, 'C', 'B is skipped, not replayed from the seek');
    assert.doesNotMatch(text(), /couldn't get into the voice channel/i);
});

test('a track put at the head while another downloads is left to the run that put it there', async () => {
    // What a Hitster turn does: unshift its clip and start it, whatever the queue was doing.
    const { bot, message, fetches } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');

    bot.songQueue.unshift(plex('Secret'));
    bot.playSong(message);
    await until(() => fetches.length === 2, 'the download of the clip');
    fetches[1].arrive();
    await until(() => players.length === 1, 'a player for the clip');
    fetches[0].arrive();
    await settle();

    assert.strictEqual(fetches[0].cancelled, true, 'the download of A is dropped');
    assert.strictEqual(players.length, 1, 'A does not tear the clip down to play under its name');
    assert.strictEqual(bot.conn.subscribed, players[0]);
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['Secret', 'A'], 'A still plays after the clip');
});

test('a skip while a Hitster clip downloads over playing music skips only the clip', async () => {
    const ctx = setup([plex('A'), plex('B')]);
    const { bot, message, fetches } = ctx;
    await playFirst(ctx);
    bot.songQueue.unshift(plex('Secret'));
    bot.playSong(message);
    await until(() => fetches.length === 2, 'the download of the clip');

    skip.command.process(bot, null, message, '');
    // The clip arrives before the stopped music player has played out its silence.
    fetches[1].arrive();
    await until(() => fetches.length === 3, 'the next download');
    await settle();

    assert.strictEqual(fetches[1].cancelled, true);
    assert.strictEqual(fetches[2].track.title, 'A');
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B'], 'A is not advanced past as well');
});

test('a second run still joining keeps the first from starting the track it will restart', async () => {
    const { bot, message, fetches, announced } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the first download of A');
    // The first join is done, but the connection dropped, so the second run joins afresh.
    bot.conn.destroy();
    const hold = holdNextJoin(bot);
    play(bot, message, plex('X'));
    await until(() => hold.joined, 'the second join');

    fetches[0].arrive();
    await settle();
    assert.strictEqual(fetches[0].cancelled, true);
    assert.strictEqual(players.length, 0);

    hold.joined();
    await until(() => fetches.length === 2, 'the second download of A');
    fetches[1].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
    assert.deepStrictEqual(announced(), ['A'], 'announced once, not once per run');
});

test('a skip with two runs loading the first track advances the queue once', async () => {
    // Nothing plays until the first download is in, so a second !play then starts a second run.
    const { bot, message, fetches, announced } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the first download of A');
    play(bot, message, plex('X'));
    await until(() => fetches.length === 2, 'the second download of A');

    skip.command.process(bot, null, message, '');
    fetches[0].arrive();
    fetches[1].arrive();
    await until(() => fetches.length === 3, 'the download of X');
    assert.strictEqual(fetches[2].track.title, 'X', 'X is not skipped along with A');
    assert.strictEqual(fetches[0].cancelled && fetches[1].cancelled, true);

    fetches[2].arrive();
    await until(() => players.length === 1, 'a player for X');
    players[0].go(AudioPlayerStatus.Playing);
    assert.deepStrictEqual(announced(), ['X']);
    assert.strictEqual(bot.isPlaying, true);
});

test('a track queued after a !stop, while the next track is still joining, plays', async () => {
    const ctx = setup([plex('A'), plex('B')]);
    const { bot, message, fetches, announced } = ctx;
    await playFirst(ctx);
    // The skip destroys the connection, so B's run has to join again.
    const hold = holdNextJoin(bot);
    skip.command.process(bot, null, message, '');
    await until(() => hold.joined, "B's join");

    stop.command.process(bot, null, message);
    play(bot, message, plex('X'));
    hold.joined();
    await until(() => fetches.length === 2, 'a download after the join');

    assert.strictEqual(fetches[1].track.title, 'X', 'X was queued after the stop, so the stop was not for it');
    fetches[1].arrive();
    await until(() => players.length === 2, 'a player for X');
    players[1].go(AudioPlayerStatus.Playing);
    assert.deepStrictEqual(announced(), ['A', 'X']);
});

test('removing the loading track before anything plays moves on to the next one', async () => {
    const { bot, message, fetches } = setup([plex('A'), plex('B')]);
    const hold = holdNextJoin(bot);
    bot.playSong(message);
    await until(() => hold.joined, 'the join to start');

    // Allowed, because nothing counts as playing until the download is in.
    removesong.command.process(bot, null, message, '1');
    hold.joined();
    await until(() => fetches.length === 1, 'a download');

    assert.strictEqual(fetches[0].track.title, 'B');
});

test('clearing the queue before anything plays leaves the voice channel', async () => {
    const { bot, message, fetches, finished } = setup([plex('A'), plex('B')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');
    const conn = bot.conn;

    clearqueue.command.process(bot, null, message);
    fetches[0].arrive();
    await settle();

    assert.strictEqual(fetches[0].cancelled, true);
    assert.strictEqual(players.length, 0);
    assert.strictEqual(bot.isPlaying, false);
    assert.strictEqual(finished.length, 1);
    assert.strictEqual(bot.conn, null, 'nothing is left holding the bot in the channel');
    assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
});

test('a looped track skipped while it downloads is still announced when it replays', async () => {
    const ctx = setup([plex('A'), plex('B')]);
    const { bot, message, fetches, announced } = ctx;
    await playFirst(ctx);
    players[0].go(AudioPlayerStatus.Idle);
    await until(() => fetches.length === 2, 'the download of B');

    // A skip does not break a loop, so B replays.
    loop.command.process(bot, null, message, '');
    skip.command.process(bot, null, message, '');
    fetches[1].arrive();
    await until(() => fetches.length === 3, 'the replay of B');
    assert.strictEqual(fetches[2].track.title, 'B');

    fetches[2].arrive();
    await until(() => players.length === 2, 'a player for B');
    players[1].go(AudioPlayerStatus.Playing);
    assert.deepStrictEqual(announced(), ['A', 'B'], 'B never reached Playing before, so nobody was told');
});

test('ordinary playback announces each track and finishes once the queue runs out', async () => {
    const { bot, message, fetches, finished, text, announced } = setup([plex('A'), plex('B')]);
    bot.playSong(message);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    const conn = bot.conn;
    assert.strictEqual(conn.subscribed, players[0]);
    assert.strictEqual(bot.isPlaying, true);
    players[0].go(AudioPlayerStatus.Playing);
    players[0].go(AudioPlayerStatus.Idle);

    await until(() => fetches.length === 2, 'the download of B');
    fetches[1].arrive();
    await until(() => players.length === 2, 'a player for B');
    assert.strictEqual(conn.subscribed, players[1], 'the same connection carries on');
    players[1].go(AudioPlayerStatus.Playing);
    players[1].go(AudioPlayerStatus.Idle);
    await settle();

    assert.deepStrictEqual(announced(), ['A', 'B']);
    assert.strictEqual(bot.isPlaying, false);
    assert.strictEqual(finished.length, 1);
    assert.strictEqual(bot.conn, null, 'the channel is left once the queue is done');
    assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.doesNotMatch(text(), /⚠️/);
});
