// !skip, !stop and Hitster stops that land while the player is still buffering.
//
// The bug: Bot.stop() stops the player unforced, and a real @discordjs/voice AudioPlayer that is
// still Buffering does not go Idle on that. It waits for ffmpeg's output to turn readable, goes
// Buffering -> Playing, and only goes Idle on the next audio cycle, because the stop destroyed the
// connection. The Playing listener then announced the stopped track with live controls. After
// !stop, isPlaying stayed true until that late Idle, so a !play in between only queued its track,
// the late Playing announced it, and the late Idle ended it as if it had played: announced, never
// downloaded, dropped. The window is longest behind a seek, while ffmpeg decodes up to the offset.
//
// The FakePlayers in test/playbackRace.test.js and test/playbackPause.test.js go straight from
// Buffering to Idle on an unforced stop. This one stays Buffering until the test calls readable(),
// as the real one waits for ffmpeg, and then goes Playing and Idle in that order.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-buffering-stop-' + process.pid);

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

	// ffmpeg's first output. The real player leaves Buffering on the stream's 'readable', stopped
	// or not, and a stopped one goes Idle on the next audio cycle.
	readable() {
		if (this.state.status !== AudioPlayerStatus.Buffering) return;
		this.go(AudioPlayerStatus.Playing);
		if (this.stopping) this.nextCycle();
	}

	// A download that fails first. The real player emits 'error', then goes Idle in the same call,
	// straight from Buffering.
	fail() {
		if (this.state.status === AudioPlayerStatus.Idle) return;
		this.emit('error', new Error('read ECONNRESET'));
		this.go(AudioPlayerStatus.Idle);
	}

	pause() {
		if (this.state.status !== AudioPlayerStatus.Playing) return false;
		this.go(AudioPlayerStatus.Paused);
		return true;
	}

	unpause() {
		if (this.state.status !== AudioPlayerStatus.Paused) return false;
		this.go(AudioPlayerStatus.Playing);
		if (this.stopping) this.nextCycle();
		return true;
	}

	// Unforced, the real player only arms the resource's trailing silence, which it reads none of
	// while Buffering or Paused.
	stop(force) {
		if (this.state.status === AudioPlayerStatus.Idle) return false;
		if (force) {
			this.go(AudioPlayerStatus.Idle);
			return true;
		}
		this.stopping = true;
		if (this.state.status === AudioPlayerStatus.Playing) this.nextCycle();
		return true;
	}

	nextCycle() {
		setImmediate(() => {
			if (this.state.status === AudioPlayerStatus.Playing) this.go(AudioPlayerStatus.Idle);
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
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');
const seekCmd = require('../commands/seek.js');
const playCmd = require('../commands/play.js');

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
	// A seeked track gets its own ffmpeg, which these tests have no use for.
	bot.seekResource = (readstream) => ({ input: readstream });

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

	const announced = () => sent
		.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
		.map(x => x.embeds[0].fields[0].value);
	const text = () => sent.filter(x => typeof x === 'string');
	return { bot, message, sent, fetches, finished, announced, text };
}

/** A Plex search result, as findSong and findArtist get them. */
const plexTrack = (title) => ({
	title, grandparentTitle: 'Engelwood', parentTitle: 'Album',
	Media: [{ Part: [{ key: `/library/parts/${title}/1/file.flac` }] }]
});

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

/** Load the head of the queue as far as a player that is still Buffering. */
async function loadFirst(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === 1, 'the first download');
	ctx.fetches[0].arrive();
	await until(() => players.length === 1, 'a player for the first track');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering);
}

test('a skip while the track buffers announces only the track after it', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, announced } = ctx;
	await loadFirst(ctx);

	skip.command.process(bot, null, message, '');
	players[0].readable();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	await until(() => fetches.length === 2, 'the download of B');

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.deepStrictEqual(announced(), [], 'the skipped track is not announced on its way out');
	assert.strictEqual(fetches[1].track.title, 'B');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].readable();
	assert.deepStrictEqual(announced(), ['B']);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);
});

test('a stop while the track buffers ends playback once, when nothing is played after it', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, finished, announced } = ctx;
	await loadFirst(ctx);

	stop.command.process(bot, null, message);
	assert.strictEqual(bot.isPlaying, false, 'playback is over at the stop, not at the late Idle');
	players[0].readable();
	await settle();

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.deepStrictEqual(announced(), []);
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.conn, null);
});

// The stopped player reaches Playing and Idle either before the next track's download is in, or
// after its player has replaced it.
for (const lateFirst of [true, false]) {
	test(`a !play after a stop while the track buffers plays its track (old player ends ${lateFirst ? 'first' : 'last'})`, async () => {
		const ctx = setup([plex('A')]);
		const { bot, message, fetches, finished, announced } = ctx;
		await loadFirst(ctx);

		stop.command.process(bot, null, message);
		play(bot, message, plex('X'));
		await until(() => fetches.length === 2, 'the download of X');
		assert.strictEqual(fetches[1].track.title, 'X', 'X starts at once instead of waiting behind the stopped player');

		if (lateFirst) {
			players[0].readable();
			await settle();
			assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
			assert.deepStrictEqual(announced(), [], 'the late Playing announces nothing');
			assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['X'], 'the late Idle leaves X queued');
		}
		fetches[1].arrive();
		await until(() => players.length === 2, 'a player for X');
		if (!lateFirst) {
			players[0].readable();
			await settle();
		}
		players[1].readable();
		await settle();

		assert.deepStrictEqual(announced(), ['X']);
		assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['X']);
		assert.strictEqual(bot.conn.subscribed, players[1]);
		assert.strictEqual(bot.isPlaying, true);
		assert.strictEqual(finished.length, 0, 'playback carried on, so it never finished');
		assert.strictEqual(fetches.length, 2, 'X is downloaded once');
	});
}

test('a !play after a stop while a seek replay buffers plays its track', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, fetches, announced } = ctx;
	await loadFirst(ctx);
	players[0].readable();
	await seekCmd.command.process(bot, null, message, '1:00');
	await until(() => fetches.length === 2, 'the download for the replay of A');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for the replay');
	assert.strictEqual(players[1].state.status, AudioPlayerStatus.Buffering, 'ffmpeg is still decoding up to the offset');

	stop.command.process(bot, null, message);
	play(bot, message, plex('X'));
	await until(() => fetches.length === 3, 'the download of X');
	players[1].readable();
	await settle();
	fetches[2].arrive();
	await until(() => players.length === 3, 'a player for X');
	players[2].readable();

	assert.deepStrictEqual(announced(), ['A', 'X'], 'the seek is not announced again, and X is announced once');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['X']);
	assert.strictEqual(bot.isPlaying, true);
});

test('a track queued after a stop by someone outside voice waits for the next !play', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, sent, fetches, finished, announced } = ctx;
	await loadFirst(ctx);

	stop.command.process(bot, null, message);
	const outside = { ...message, member: { voice: { channel: null } } };
	bot.addToQueue(0, [plexTrack('X')], outside);
	await settle();
	assert.ok(sent.some(x => typeof x === 'string' && /Join a voice channel first/.test(x)));
	players[0].readable();
	await settle();

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['X'], 'the late Idle leaves X queued');
	assert.strictEqual(finished.length, 0);

	playCmd.command.process(bot, null, message, '');
	await until(() => fetches.length === 2, 'the download of X');
	assert.strictEqual(fetches[1].track.title, 'X');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for X');
	players[1].readable();
	assert.deepStrictEqual(announced(), ['X']);
});

test("!artist after a stop while the track buffers keeps the artist's first track", async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, fetches, announced } = ctx;
	await loadFirst(ctx);

	// findArtist queues each album's tracks as its lookup comes back, and starts playback after the
	// last one.
	let secondAlbum;
	bot.findTracksOnPlex = async () => ({ MediaContainer: { Metadata: [{ key: '/artist' }] } });
	bot.plex = {
		query: (key) => {
			if (key === '/artist') return Promise.resolve({ MediaContainer: { Metadata: [{ key: '/album1' }, { key: '/album2' }] } });
			if (key === '/album1') return Promise.resolve({ MediaContainer: { Metadata: [plexTrack('T1'), plexTrack('T2')] } });
			return new Promise((resolve) => {
				secondAlbum = () => resolve({ MediaContainer: { Metadata: [plexTrack('T3')] } });
			});
		}
	};

	stop.command.process(bot, null, message);
	const lookup = bot.findArtist('Engelwood', message);
	await until(() => secondAlbum, 'the second album lookup');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['T1', 'T2']);
	players[0].readable();
	await settle();
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['T1', 'T2'], 'the late Idle leaves T1 queued');

	secondAlbum();
	await lookup;
	await until(() => fetches.length === 2, 'the first download for the artist');
	assert.strictEqual(fetches[1].track.title, 'T1');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for T1');
	players[1].readable();
	assert.deepStrictEqual(announced(), ['T1']);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['T1', 'T2', 'T3']);
});

test("a stopped track whose download fails says nothing about the track queued after it", async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, fetches, announced, text } = ctx;
	await loadFirst(ctx);

	stop.command.process(bot, null, message);
	play(bot, message, plex('X'));
	await until(() => fetches.length === 2, 'the download of X');
	players[0].fail();
	await settle();

	assert.deepStrictEqual(text().filter(t => /Playback failed/.test(t)), [], 'X is not reported as failed');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for X');
	players[1].readable();
	assert.deepStrictEqual(announced(), ['X']);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['X']);
});

test('a skip of a buffering track whose download then fails moves on once, without a failure notice', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')]);
	const { bot, message, fetches, announced, text } = ctx;
	await loadFirst(ctx);

	skip.command.process(bot, null, message, '');
	players[0].fail();
	await until(() => fetches.length === 2, 'the download of B');
	await settle();

	assert.strictEqual(fetches[1].track.title, 'B');
	assert.strictEqual(fetches.length, 2, 'C is not skipped as well');
	assert.deepStrictEqual(text().filter(t => /Playback failed/.test(t)), []);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B', 'C']);
	assert.deepStrictEqual(announced(), []);
});

for (const lateFirst of [true, false]) {
	test(`a skip of a track queued after a stop, while the old player buffers, finishes once (old player ends ${lateFirst ? 'first' : 'last'})`, async () => {
		const ctx = setup([plex('A')]);
		const { bot, message, fetches, finished, announced } = ctx;
		await loadFirst(ctx);

		stop.command.process(bot, null, message);
		play(bot, message, plex('X'));
		await until(() => fetches.length === 2, 'the download of X');
		skip.command.process(bot, null, message, '');
		if (lateFirst) {
			players[0].readable();
			await settle();
		}
		fetches[1].arrive();
		await settle();
		if (!lateFirst) {
			players[0].readable();
			await settle();
		}

		assert.strictEqual(fetches[1].cancelled, true, 'the skipped track is not played');
		assert.strictEqual(players.length, 1);
		assert.deepStrictEqual(announced(), []);
		assert.deepStrictEqual(bot.songQueue, []);
		assert.strictEqual(bot.isPlaying, false);
		assert.strictEqual(finished.length, 1);
	});
}

test('two stops in a row on a buffering Hitster clip skip only the clip, and announce nothing for it', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, announced } = ctx;
	await loadFirst(ctx);
	players[0].readable();
	bot.songQueue.unshift(plex('Secret'));
	bot.playSong(message);
	await until(() => fetches.length === 2, 'the download of the clip');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for the clip');

	// What !hitster stop does mid-turn: resolveTurn stops the clip from the collector's
	// synchronous 'end', then the stop handler stops it again.
	bot.stop();
	bot.stop();
	players[1].readable();
	await until(() => fetches.length === 3, 'the next download');
	await settle();

	assert.strictEqual(fetches[2].track.title, 'A', 'the music the clip interrupted plays next');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B']);
	assert.strictEqual(fetches.length, 3, 'A is not skipped as well');
	assert.deepStrictEqual(announced(), ['A'], 'the clip is not announced on its way out');
});

for (const lateFirst of [true, false]) {
	test(`a skip while a Hitster clip loads over buffering music skips only the clip (music ends ${lateFirst ? 'first' : 'last'})`, async () => {
		const ctx = setup([plex('A'), plex('B')]);
		const { bot, message, fetches, announced } = ctx;
		await loadFirst(ctx);
		bot.songQueue.unshift(plex('Secret'));
		bot.playSong(message);
		await until(() => fetches.length === 2, 'the download of the clip');

		skip.command.process(bot, null, message, '');
		if (lateFirst) {
			players[0].readable();
			await settle();
			assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['Secret', 'A', 'B'], "the music's late Idle leaves the queue to the clip's run");
		}
		fetches[1].arrive();
		await until(() => fetches.length === 3, 'the next download');
		if (!lateFirst) players[0].readable();
		await settle();

		assert.strictEqual(fetches[1].cancelled, true);
		assert.strictEqual(fetches[2].track.title, 'A');
		assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B'], 'A is not advanced past as well');
		assert.strictEqual(fetches.length, 3);
		assert.deepStrictEqual(announced(), [], 'neither the clip nor the stopped music is announced');

		fetches[2].arrive();
		await until(() => players.length === 2, 'a player for A');
		players[1].readable();
		assert.deepStrictEqual(announced(), ['A']);
	});
}
