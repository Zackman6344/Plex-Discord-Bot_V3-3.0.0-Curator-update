// !skip, !stop and !resume on a paused track.
//
// The bugs: Bot.stop() stopped the player unforced. On a paused @discordjs/voice AudioPlayer that
// only arms the resource's trailing silence, which the player reads no frames to play out while it
// is paused. It stayed Paused until !resume, so Idle never fired, the queue never moved on, and
// isPlaying stayed true, so a later !play only queued. isPaused stayed true as well. Separately,
// unpause() moves the player from Paused back to Playing, voice emits 'playing' for that, and the
// Playing listener posted the now-playing embed again on every !resume.
//
// Same harness as test/playbackRace.test.js: @discordjs/voice is swapped in require.cache before
// app/bot.js destructures it. This FakePlayer also pauses, and an unforced stop of a paused player
// waits for unpause() before it goes Idle, as the real one does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-pause-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus } = voice;

const players = [];

class FakePlayer extends EventEmitter {
	constructor() {
		super();
		this.state = { status: AudioPlayerStatus.Idle };
		this.stopping = false;
		players.push(this);
	}

	play(resource) {
		this.resource = resource;
		this.go(AudioPlayerStatus.Buffering);
	}

	pause() {
		if (this.state.status !== AudioPlayerStatus.Playing) return false;
		this.go(AudioPlayerStatus.Paused);
		return true;
	}

	unpause() {
		if (this.state.status !== AudioPlayerStatus.Paused) return false;
		this.go(AudioPlayerStatus.Playing);
		if (this.stopping) this.playOutSilence();
		return true;
	}

	// Unforced, the real player goes Idle once it has read a few frames of silence, and it reads
	// none while paused.
	stop(force) {
		if (this.state.status === AudioPlayerStatus.Idle) return false;
		if (force) {
			this.go(AudioPlayerStatus.Idle);
			return true;
		}
		this.stopping = true;
		if (this.state.status !== AudioPlayerStatus.Paused) this.playOutSilence();
		return true;
	}

	playOutSilence() {
		setImmediate(() => {
			if (this.state.status !== AudioPlayerStatus.Paused) this.go(AudioPlayerStatus.Idle);
		});
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
const pause = require('../commands/pause.js');
const resume = require('../commands/resume.js');
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');

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

	const nowPlaying = () => sent.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES);
	const announced = () => nowPlaying().map(x => x.embeds[0].fields[0].value);
	const toggleLabel = (post) => post.components[0].components
		.find(b => b.data.custom_id === 'playback:pausetoggle').data.label;
	return { bot, message, sent, fetches, finished, announced, nowPlaying, toggleLabel };
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

/** Play the head of the queue through to Playing, then pause it. */
async function playThenPause(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === 1, 'the first download');
	ctx.fetches[0].arrive();
	await until(() => players.length === 1, 'a player for the first track');
	players[0].go(AudioPlayerStatus.Playing);
	pause.command.process(ctx.bot, null, ctx.message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(ctx.bot.isPaused, true);
}

test('a skip while paused moves on to the next track without waiting for !resume', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, announced, nowPlaying, toggleLabel } = ctx;
	await playThenPause(ctx);

	skip.command.process(bot, null, message, '');
	await until(() => fetches.length === 2, 'the download of B');

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle, 'the paused player is stopped, not left paused');
	assert.strictEqual(fetches[1].track.title, 'B');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);
	assert.strictEqual(bot.isPaused, false, 'B starts unpaused, so nothing is paused any more');

	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'B']);
	assert.strictEqual(toggleLabel(nowPlaying()[1]), 'Pause', "B's controls offer Pause, not Resume");
});

test('a stop while paused ends playback, so the next !play starts it again', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, finished, announced } = ctx;
	await playThenPause(ctx);
	const conn = bot.conn;

	stop.command.process(bot, null, message);
	await settle();

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);

	play(bot, message, plex('X'));
	await until(() => fetches.length === 2, 'the download of X');
	assert.strictEqual(fetches[1].track.title, 'X', 'X plays, rather than waiting behind a stopped track');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for X');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'X']);
});

test('resuming does not post the now-playing embed again', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, sent, fetches, announced } = ctx;
	await playThenPause(ctx);

	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	pause.command.process(bot, null, message);
	resume.command.process(bot, null, message);
	const resumed = sent.filter(x => x && x.embeds && x.embeds[0].description === bot.language.RESUME_INFO);
	assert.strictEqual(resumed.length, 2);
	assert.deepStrictEqual(announced(), ['A'], 'A is announced once, however often it is resumed');

	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the download of B');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'B'], 'the next track is still announced');
});

test('a resume while a Hitster clip downloads announces nothing until the clip plays', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, announced } = ctx;
	await playThenPause(ctx);
	bot.songQueue.unshift(plex('Secret'));
	bot.playSong(message);
	await until(() => fetches.length === 2, 'the download of the clip');

	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing, 'A plays on while the clip loads');
	assert.deepStrictEqual(announced(), ['A'], 'the clip is not announced over A');

	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for the clip');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'Secret']);
});

for (const paused of [true, false]) {
	test(`two stops in a row on a ${paused ? 'paused' : 'playing'} Hitster clip skip only the clip`, async () => {
		const ctx = setup([plex('A'), plex('B')]);
		const { bot, message, fetches } = ctx;
		bot.playSong(message);
		await until(() => fetches.length === 1, 'the download of A');
		fetches[0].arrive();
		await until(() => players.length === 1, 'a player for A');
		players[0].go(AudioPlayerStatus.Playing);
		bot.songQueue.unshift(plex('Secret'));
		bot.playSong(message);
		await until(() => fetches.length === 2, 'the download of the clip');
		fetches[1].arrive();
		await until(() => players.length === 2, 'a player for the clip');
		players[1].go(AudioPlayerStatus.Playing);
		if (paused) pause.command.process(bot, null, message);

		// What !hitster stop does mid-turn: resolveTurn stops the clip from the collector's
		// synchronous 'end', then the stop handler stops it again.
		bot.stop();
		bot.stop();
		await until(() => fetches.length === 3, 'the next download');
		await settle();

		assert.strictEqual(fetches[2].track.title, 'A', 'the music the clip interrupted plays next');
		assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B']);
		assert.strictEqual(fetches.length, 3, 'A is not skipped as well');
	});
}

test('a skip while a Hitster clip downloads over paused music skips only the clip', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches } = ctx;
	await playThenPause(ctx);
	bot.songQueue.unshift(plex('Secret'));
	bot.playSong(message);
	await until(() => fetches.length === 2, 'the download of the clip');

	skip.command.process(bot, null, message, '');
	fetches[1].arrive();
	await until(() => fetches.length === 3, 'the next download');
	await settle();

	assert.strictEqual(fetches[1].cancelled, true);
	assert.strictEqual(fetches[2].track.title, 'A');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B'], 'A is not advanced past as well');
	assert.strictEqual(bot.isPaused, false);
});
