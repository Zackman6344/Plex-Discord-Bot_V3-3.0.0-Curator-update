// A track whose stream fails moves the queue on once.
//
// The bug: when a resource's stream errors, @discordjs/voice emits 'error' and then sets the player
// Idle for that same resource, in one synchronous call. runPlayback advanced the queue from both
// listeners. With A, B, C and D queued and A's download dying mid-track, the channel was told
// "Playback failed for **A**. Skipping." and C played: B was dropped without a word.
//
// @discordjs/voice is swapped in require.cache before app/bot.js destructures it, as in
// test/playbackRace.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-error-' + process.pid);

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

	pause() {
		if (this.state.status !== AudioPlayerStatus.Playing) return false;
		this.go(AudioPlayerStatus.Paused);
		return true;
	}

	stop(force) {
		if (this.state.status === AudioPlayerStatus.Idle) return false;
		if (force) this.go(AudioPlayerStatus.Idle);
		else setImmediate(() => this.go(AudioPlayerStatus.Idle));
		return true;
	}

	// @discordjs/voice 0.19.0 onStreamError: 'error', then Idle for the same resource, in one
	// synchronous call.
	fail(error) {
		const resource = this.resource;
		if (this.state.status !== AudioPlayerStatus.Idle) {
			this.emit('error', Object.assign(error, { resource: this.state.resource }));
		}
		if (this.state.status !== AudioPlayerStatus.Idle && this.state.resource === resource) {
			this.go(AudioPlayerStatus.Idle);
		}
	}

	go(status) {
		const old = this.state;
		if (old.status === status) return;
		this.state = status === AudioPlayerStatus.Idle ? { status } : { status, resource: this.resource };
		this.emit(status, old, this.state);
	}
}

require.cache[voicePath].exports = Object.assign({}, voice, {
	createAudioPlayer: () => new FakePlayer(),
	createAudioResource: (input) => ({ input })
});

const Bot = require('../app/bot.js');
const commandLog = require('../helpers/commandLog.js');
const seekCmd = require('../commands/seek.js');
const pauseCmd = require('../commands/pause.js');

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

/** A Bot with `queue` loaded, whose Plex downloads each wait for the test to call `arrive()`. */
function setup(queue) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);

	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track };
		fetch.arrive = () => resolve({ ok: true, status: 200, body: new ReadableStream() });
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
	let runs = 0;
	bot.on('will play', () => runs++);

	const failures = () => sent.filter(x => typeof x === 'string' && /Playback failed/.test(x));
	const announced = () => sent
		.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
		.map(x => x.embeds[0].fields[0].value);
	return { bot, message, fetches, finished, failures, announced, runs: () => runs };
}

/** Play A through to Playing, so the queue is mid-playlist. */
async function playFirst(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === 1, 'the download of A');
	ctx.fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);
}

function assertOneFailureFor(failures, title) {
	assert.strictEqual(failures().length, 1, 'the failure is reported once');
	assert.match(failures()[0], new RegExp(`\\*\\*${title}\\*\\*`));
}

test('a track whose download dies mid-track is skipped once, not twice', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C'), plex('D')]);
	const { bot, fetches, failures, announced, runs } = ctx;
	await playFirst(ctx);
	const before = runs();

	players[0].fail(new Error('premature close'));
	await until(() => fetches.length === 2, 'the next download');
	await settle();

	assert.strictEqual(runs() - before, 1, 'the queue moves on once');
	assert.strictEqual(fetches[1].track.title, 'B', 'B plays next instead of being dropped');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B', 'C', 'D']);
	assertOneFailureFor(failures, 'A');

	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(announced(), ['A', 'B']);
});

test('a track whose download dies before it plays is skipped once, unannounced', async () => {
	const { bot, message, fetches, failures, announced, runs } = setup([plex('A'), plex('B'), plex('C')]);
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering);
	const before = runs();

	players[0].fail(new Error('premature close'));
	await until(() => fetches.length === 2, 'the next download');
	await settle();

	assert.strictEqual(runs() - before, 1, 'the queue moves on once');
	assert.strictEqual(fetches[1].track.title, 'B');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B', 'C']);
	assertOneFailureFor(failures, 'A');
	assert.deepStrictEqual(announced(), []);
});

test('a paused track whose download times out is skipped once', async () => {
	// A long pause can outlast Plex's patience with an idle socket.
	const ctx = setup([plex('A'), plex('B'), plex('C')]);
	const { bot, message, fetches, failures, runs } = ctx;
	await playFirst(ctx);
	pauseCmd.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	const before = runs();

	players[0].fail(new Error('terminated'));
	await until(() => fetches.length === 2, 'the next download');
	await settle();

	assert.strictEqual(runs() - before, 1, 'the queue moves on once');
	assert.strictEqual(fetches[1].track.title, 'B');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B', 'C']);
	assertOneFailureFor(failures, 'A');
});

test('the last track failing ends playback once', async () => {
	const ctx = setup([plex('A')]);
	const { bot, fetches, finished, failures } = ctx;
	await playFirst(ctx);
	const conn = bot.conn;

	players[0].fail(new Error('premature close'));
	await settle();

	assert.strictEqual(fetches.length, 1);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(finished.length, 1, 'finish fires once, as it does when the track runs out');
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
	assertOneFailureFor(failures, 'A');
});

test('a seek still replays the track, and the replay failing moves on once', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')]);
	const { bot, message, fetches, failures, announced, runs } = ctx;
	const seeks = [];
	bot.seekResource = (readstream, ms) => { seeks.push(ms); return { input: readstream }; };
	await playFirst(ctx);

	await seekCmd.command.process(bot, null, message, '1:00');
	await until(() => fetches.length === 2, 'the replay of A');
	assert.strictEqual(fetches[1].track.title, 'A');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for the replay');
	assert.deepStrictEqual(seeks, [60000]);
	players[1].go(AudioPlayerStatus.Playing);
	const before = runs();

	players[1].fail(new Error('premature close'));
	await until(() => fetches.length === 3, 'the next download');
	await settle();

	assert.strictEqual(runs() - before, 1, 'the queue moves on once');
	assert.strictEqual(fetches[2].track.title, 'B');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B', 'C']);
	assertOneFailureFor(failures, 'A');
	assert.deepStrictEqual(announced(), ['A'], 'the replay is not announced again');
});
