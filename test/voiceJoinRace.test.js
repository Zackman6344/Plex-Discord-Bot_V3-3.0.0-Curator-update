// A second playSong while the bot is still making its first voice join.
//
// Nothing counts as playing until the first Plex download is in, so a second !play in that window
// starts a second run. Its openConnection destroyed the first run's connection, which was not Ready
// yet. destroy() never emits 'ready' or 'error', so the first run's entersState waited the full 30 s
// and threw, and playSong's catch then destroyed this.conn, by then the second run's live
// connection. Playback died mid-track under a "couldn't get into the voice channel" message.
// A !play from someone outside voice in the same window nulled this.voiceChannel, and the join
// then threw reading its name, leaving the connection it had made in the channel. With the join
// past that, the null still let the next track follow the requester into another channel.
//
// Unlike test/playbackRace.test.js this runs the real openConnection against the real connection
// registry, joinVoiceChannel, entersState and VoiceConnection. On the voice side only Discord is
// faked: the guild's voice adapter, which never answers, and a Ready status set by hand. Timers
// are mocked so the 30 s join timeout can be run out. The player and the Plex download are faked
// as in playbackRace.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-join-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection, getVoiceConnections } = voice;

const players = [];

class FakePlayer extends EventEmitter {
    constructor() {
        super();
        this.state = { status: AudioPlayerStatus.Idle };
        players.push(this);
    }

    // What VoiceConnection.subscribe calls on a real AudioPlayer.
    subscribe(connection) {
        return { connection, player: this, unsubscribe() {} };
    }

    play() {
        this.go(AudioPlayerStatus.Buffering);
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

test.beforeEach(() => {
    players.length = 0;
    test.mock.timers.enable({ apis: ['setTimeout'] });
});
test.afterEach(() => {
    test.mock.timers.reset();
    for (const connection of [...(getVoiceConnections() || new Map()).values()]) {
        try { connection.destroy(); } catch (_) {}
    }
    try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
});

const plex = (title) => ({ title, artist: 'Engelwood', key: `/library/parts/${title}/1/file.flac` });

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

async function until(cond, what) {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setImmediate(r));
    assert.ok(cond(), `timed out waiting for ${what}`);
}

/**
 * Stands in for the Discord gateway: answers no voice state update, and records in `sentTo` the
 * channel each one asked for, null for a leave.
 */
function guild(id) {
    const g = {
        id,
        sentTo: [],
        voiceAdapterCreator: () => ({
            sendPayload: (payload) => { g.sentTo.push(payload.d.channel_id); return true; },
            destroy() {}
        })
    };
    return g;
}

// Getting to Ready for real takes Discord's voice servers. The status change is all
// openConnection waits for.
function ready(connection) {
    connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready };
}

/** A Bot with `queue` loaded, whose Plex downloads each wait for the test to call `arrive()`. */
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

    const sent = [];
    const voiceChannel = { id: 'c1', name: 'Music', guild: guild('g1') };
    const messageFrom = (channel) => ({
        member: { voice: { channel } },
        channel: { async send(x) { sent.push(x); return {}; } },
        async reply(x) { sent.push(x); return {}; }
    });

    const text = () => sent.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    const announced = () => sent
        .filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
        .map(x => x.embeds[0].fields[0].value);
    const lounge = { id: 'c2', name: 'Lounge', guild: voiceChannel.guild };
    return {
        bot, voiceChannel, lounge, fetches, text, announced,
        message: messageFrom(voiceChannel), outsider: messageFrom(null), fromLounge: messageFrom(lounge)
    };
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
    bot.songQueue.push(track);
    if (!bot.isPlaying) bot.playSong(message);
}

test('a second !play during the first join does not end the playback it started', async () => {
    const { bot, message, fetches, text, announced } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => getVoiceConnection('g1'), 'the first join');
    const first = getVoiceConnection('g1');

    play(bot, message, plex('X'));
    await until(() => getVoiceConnection('g1') !== first, 'the second join');
    const second = getVoiceConnection('g1');
    assert.strictEqual(first.state.status, VoiceConnectionStatus.Destroyed,
        'the second run clears the join it found unfinished');

    ready(second);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);

    // The first run's entersState can only time out, since destroy() emits neither 'ready' nor 'error'.
    test.mock.timers.tick(30_000);
    await settle();

    assert.doesNotMatch(text(), /couldn't get into the voice channel/i, 'the bot is in the channel, playing');
    assert.strictEqual(second.state.status, VoiceConnectionStatus.Ready, 'the playing connection is left alone');
    assert.strictEqual(bot.conn, second);
    assert.strictEqual(second.state.subscription.player, players[0]);
    assert.strictEqual(bot.isPlaying, true);
    assert.deepStrictEqual(announced(), ['A']);
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'X']);
    assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
});

test('a !play from outside voice during the first join leaves that join to finish', async () => {
    const { bot, message, outsider, fetches, text, announced } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => getVoiceConnection('g1'), 'the first join');
    const connection = getVoiceConnection('g1');

    play(bot, outsider, plex('X'));
    await settle();
    assert.match(text(), /join a voice channel first/i, 'the outsider is told why nothing changed');

    ready(connection);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
    await settle();

    assert.doesNotMatch(text(), /couldn't get into the voice channel/i);
    assert.strictEqual(bot.conn, connection, 'the connection it made is the one it plays through');
    assert.strictEqual(connection.state.subscription.player, players[0]);
    assert.deepStrictEqual(announced(), ['A']);
    const joined = commandLog.readEventLog({ kind: 'voice-joined' });
    assert.deepStrictEqual(joined.map(e => e.channel), ['Music'], 'the join is logged against the channel it was for');
});

test('a !play from outside voice during the first join leaves the bot in its channel for the next track', async () => {
    const { bot, message, outsider, voiceChannel, lounge, fetches } = setup([plex('A'), plex('B')]);
    bot.playSong(message);
    await until(() => getVoiceConnection('g1'), 'the first join');
    const connection = getVoiceConnection('g1');
    play(bot, outsider, plex('X'));
    await settle();

    ready(connection);
    await until(() => fetches.length === 1, 'the download of A');
    fetches[0].arrive();
    await until(() => players.length === 1, 'a player for A');
    players[0].go(AudioPlayerStatus.Playing);
    // The requester moves on while the others keep listening.
    message.member.voice.channel = lounge;
    players[0].go(AudioPlayerStatus.Idle);
    await until(() => fetches.length === 2, 'the download of B');

    assert.deepStrictEqual(voiceChannel.guild.sentTo, ['c1', 'c1'], 'nothing asks to move the bot to the Lounge');
    assert.strictEqual(bot.conn, connection);
    const started = commandLog.readEventLog({ kind: 'track-start' });
    assert.deepStrictEqual(started.map(e => e.channel), ['Music']);
});

test('a join that times out with no newer run still says so', async () => {
    const { bot, message, text } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => getVoiceConnection('g1'), 'the join');
    const connection = getVoiceConnection('g1');

    test.mock.timers.tick(30_000);
    await until(() => /couldn't get into the voice channel/i.test(text()), 'the failure message');

    assert.strictEqual(connection.state.status, VoiceConnectionStatus.Destroyed);
    assert.strictEqual(getVoiceConnection('g1'), undefined, 'nothing is left holding the bot in the channel');
    assert.strictEqual(bot.isPlaying, false);
    assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A'], 'the queue waits for the next !play');
});

test('two runs whose joins both time out report it once, each logged against its own channel', async () => {
    const { bot, message, fromLounge, text } = setup([plex('A')]);
    bot.playSong(message);
    await until(() => getVoiceConnection('g1'), 'the first join');
    const first = getVoiceConnection('g1');
    // With nothing playing yet, the second run joins its own requester's channel.
    play(bot, fromLounge, plex('X'));
    await until(() => getVoiceConnection('g1') !== first, 'the second join');

    test.mock.timers.tick(30_000);
    await until(() => /couldn't get into the voice channel/i.test(text()), 'the failure message');
    await settle();

    assert.strictEqual(text().match(/couldn't get into the voice channel/gi).length, 1);
    assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 1);
    assert.strictEqual(getVoiceConnection('g1'), undefined);
    const failed = commandLog.readEventLog({ kind: 'voice-join-failed' });
    assert.deepStrictEqual(failed.map(e => e.channel), ['Music', 'Lounge']);
});
