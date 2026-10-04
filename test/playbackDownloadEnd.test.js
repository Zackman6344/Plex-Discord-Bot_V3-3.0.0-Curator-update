// A YouTube track ends when its audio runs out, not when its download does.
//
// The bug: runPlayback also ended a track on its download's 'finish'. ytdl's stream is a
// PassThrough that emits 'finish' once the whole file has been written into it, while 0.9 to
// 1.15 MB of audio is still buffered ahead of the player. At youtube_quality 'lowestaudio' that is
// about 2.5 minutes: a 60 s track was torn down before it reached Playing and never announced, a
// 3:30 track played for 47.7 s, the last track stopped early and the bot emitted 'finish' twice,
// and a looped short track served at local-disk speed restarted every 20 to 30 ms without making a
// sound. A Plex download is a Readable.from, which never emits 'finish', so only YouTube was hit.
//
// @discordjs/voice and ytdl-core are swapped in require.cache before app/bot.js loads them, as in
// test/playbackRace.test.js. Both are resolved from app/bot.js, so each stub replaces the copy it
// actually gets. Every ytdl call returns a real PassThrough, which the test ends and reads out by
// hand, standing in for the download completing and the player's ffmpeg taking the last of it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-download-end-' + process.pid);

const botRequire = createRequire(require.resolve('../app/bot.js'));

const voicePath = botRequire.resolve('@discordjs/voice');
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

const downloads = [];

const ytdlPath = botRequire.resolve('@distube/ytdl-core');
const ytdl = require(ytdlPath);
require.cache[ytdlPath].exports = Object.assign((url) => {
	// ytdl-core's own createStream default.
	const stream = new PassThrough({ highWaterMark: 1024 * 512 });
	const download = { url, stream, finished: false };
	stream.on('finish', () => { download.finished = true; });
	downloads.push(download);
	return stream;
}, ytdl);

const Bot = require('../app/bot.js');
const commandLog = require('../helpers/commandLog.js');
const loop = require('../commands/loop.js');

test.beforeEach(() => {
	players.length = 0;
	downloads.length = 0;
});
test.afterEach(() => {
	try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
	commandLog._reset();
});

const yt = (title) => ({ title, artist: 'Engelwood', url: `https://www.youtube.com/watch?v=${title}` });

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

/** A Bot with `queue` loaded. openConnection reuses a live connection the way joinVoiceChannel does. */
function setup(queue) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);
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

	const announced = () => sent
		.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
		.map(x => x.embeds[0].fields[0].value);
	return { bot, message, finished, announced };
}

/**
 * The last of the file goes in, then out to the player's ffmpeg. Both come well before the audio
 * runs out: on a real player with a 120 s track, 'finish' at 0.2 s, 'end' at 89 s, Idle at 120 s.
 */
async function completeDownload(download) {
	download.stream.end(Buffer.alloc(64 * 1024));
	await until(() => download.finished, "the download's 'finish'");
	download.stream.resume();
	await until(() => download.stream.readableEnded || download.stream.destroyed, 'the download to be read out');
	await settle();
}

test('a download completing mid-track leaves the queue alone until the player goes Idle', async () => {
	const { bot, message, finished, announced } = setup([yt('A'), yt('B')]);
	bot.playSong(message);
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);
	const conn = bot.conn;

	await completeDownload(downloads[0]);

	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B'], 'A is still playing');
	assert.strictEqual(downloads.length, 1, 'B is not fetched yet');
	assert.strictEqual(players.length, 1, 'A keeps its player');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(conn.subscribed, players[0]);

	players[0].go(AudioPlayerStatus.Idle);
	await until(() => players.length === 2, 'a player for B');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);
	assert.strictEqual(downloads.length, 2);
	assert.strictEqual(downloads[1].url, yt('B').url);
	assert.strictEqual(conn.subscribed, players[1], 'the same connection carries on');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'B']);
	assert.strictEqual(finished.length, 0);
});

test('a short track whose download completes before it starts playing is still played and announced', async () => {
	const { bot, message, announced } = setup([yt('A'), yt('B')]);
	bot.playSong(message);
	await until(() => players.length === 1, 'a player for A');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering);

	await completeDownload(downloads[0]);

	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B']);
	assert.strictEqual(players.length, 1, 'A is not torn down before it plays');
	players[0].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A']);
});

test('the last track plays out, and playback finishes once', async () => {
	const { bot, message, finished } = setup([yt('A')]);
	bot.playSong(message);
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);
	const conn = bot.conn;

	await completeDownload(downloads[0]);

	assert.strictEqual(finished.length, 0, 'nothing has finished while A still plays');
	assert.strictEqual(bot.isPlaying, true);
	assert.strictEqual(bot.conn, conn, 'the bot stays in the channel');

	players[0].go(AudioPlayerStatus.Idle);
	await settle();
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
});

test('a looped track replays when it has played out, not when its download completes', async () => {
	const { bot, message, announced } = setup([yt('A')]);
	loop.command.process(bot, null, message, '');
	bot.playSong(message);
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);

	await completeDownload(downloads[0]);

	assert.strictEqual(downloads.length, 1, 'A is not fetched again while it plays');
	assert.strictEqual(players.length, 1);

	players[0].go(AudioPlayerStatus.Idle);
	await until(() => players.length === 2, 'a player for the replay');
	assert.strictEqual(downloads.length, 2);
	assert.strictEqual(downloads[1].url, yt('A').url);
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A'], 'the replay is not announced again');
});
