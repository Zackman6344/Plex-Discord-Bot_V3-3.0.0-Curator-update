// The music side of sharing a guild's voice with an audiobook: the gate at the top of runPlayback,
// Bot.musicBusy(), the loadingRuns count in playSong and openConnection(channel).
//
// The bug: without the gate, a !play during a book joined the voice channel and subscribed a
// music player over the book's. A gate that only returned would leave isPlaying (and waitForStart)
// true, so every later !play queued in silence and the deferred start restarted a run the gate had
// just refused. On the other side, a /book play landing while music was still joining saw
// isPlaying false (it is set only once the stream is open) and took the connection from the first
// track. Counting the stopped music player instead would refuse /book play for up to a minute after
// !stop, while a Buffering player waits on ffmpeg with its connection already destroyed.
//
// Harness: test/playbackRace.test.js (FakePlayer swapped into require.cache before app/bot.js
// destructures @discordjs/voice, Plex downloads and voice joins the test releases by hand). The
// FakePlayer's unforced stop of a Buffering player waits for readable(), as in
// test/playbackBufferingStop.test.js. The openConnection test uses the real connection registry
// with a voice adapter that never answers, as test/voiceJoinRace.test.js does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-bookgate-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection } = voice;

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

	readable() {
		if (this.state.status !== AudioPlayerStatus.Buffering) return;
		this.go(AudioPlayerStatus.Playing);
		if (this.stopping) this.nextCycle();
	}

	// Unforced, the real player only arms the trailing silence, which it reads none of while Buffering.
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
 * A Bot with `queue` loaded and a fake book director whose gate answers `book.blocking`. Plex
 * downloads each wait for `arrive()`; openConnection reuses a live connection as joinVoiceChannel
 * does, and counts its calls in `joins`.
 */
function setup(queue) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);

	const book = { blocking: false, gated: [] };
	bot.books = {
		// !stop and !skip ask routeGeneric first; false is the real director's answer with no book here.
		routeGeneric() { return false; },
		blocksMusic(message) {
			if (!book.blocking) return false;
			book.gated.push(message);
			return true;
		}
	};

	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track, cancelled: false };
		const body = new ReadableStream({ cancel() { fetch.cancelled = true; } });
		fetch.arrive = () => resolve({ ok: true, status: 200, body });
		fetches.push(fetch);
	});
	const joins = [];
	bot.openConnection = async () => {
		joins.push(true);
		return bot.conn && bot.conn.state.status === VoiceConnectionStatus.Ready ? bot.conn : connection();
	};

	const sent = [];
	const voiceChannel = { id: 'c1', name: 'Music', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } };
	const message = {
		member: { voice: { channel: voiceChannel } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const text = () => sent.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
	return { bot, book, message, fetches, joins, text };
}

/** Make the next voice join wait for the returned function, as a fresh join to Discord does. */
function holdNextJoin(bot) {
	const reuse = bot.openConnection;
	const hold = { joined: null, fail: null };
	bot.openConnection = () => new Promise((resolve, reject) => {
		hold.joined = () => { bot.openConnection = reuse; resolve(connection()); };
		hold.fail = (err) => { bot.openConnection = reuse; reject(err); };
	});
	return hold;
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

test('a book holding the guild refuses music before any join, and every later request reaches the gate', async () => {
	const { bot, book, message, fetches, joins, text } = setup([]);
	book.blocking = true;

	play(bot, message, plex('A'));
	await settle();

	assert.deepStrictEqual(book.gated, [message], 'the gate sees the request, so it can answer it');
	assert.strictEqual(joins.length, 0, 'music never joins over the book');
	assert.strictEqual(fetches.length, 0);
	assert.strictEqual(players.length, 0);
	assert.strictEqual(bot.isPlaying, false, 'left true, the next !play would queue without a word');
	assert.strictEqual(bot.waitForStart, false);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A'], 'the queue waits for the book to end');
	assert.doesNotMatch(text(), /Join a voice channel first|couldn't get into the voice channel/i, 'the gate answers, not music');

	play(bot, message, plex('B'));
	await settle();
	assert.strictEqual(book.gated.length, 2, 'the second request is gated too, not silently queued');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A', 'B']);
	assert.strictEqual(bot.musicBusy(), false, 'a gated queue holds no voice');
	assert.strictEqual(bot.loadingRuns, 0);
});

test('a start deferred behind a working task is refused cleanly once a book has begun', async () => {
	const { bot, book, message, fetches, joins } = setup([]);
	bot.beginWorking();
	play(bot, message, plex('A'));
	await settle();
	assert.strictEqual(bot.waitForStart, true, 'the start waits for the task');
	assert.strictEqual(bot.musicBusy(), true, 'a waiting start counts as music');

	book.blocking = true;
	bot.endWorking();
	await settle();

	assert.strictEqual(book.gated.length, 1);
	assert.strictEqual(joins.length, 0);
	assert.strictEqual(fetches.length, 0);
	assert.strictEqual(players.length, 0);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.waitForStart, false);
	assert.strictEqual(bot.waitForStartMessage, null);
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['A']);

	// Nothing is left to restart the refused run behind the book's back.
	bot.beginWorking();
	bot.endWorking();
	await settle();
	assert.strictEqual(book.gated.length, 1);
	assert.strictEqual(joins.length, 0);
});

test('music plays as before while the gate is open', async () => {
	const { bot, message, fetches, joins } = setup([plex('A')]);
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');

	assert.strictEqual(joins.length, 1);
	assert.strictEqual(bot.conn.subscribed, players[0]);
	assert.strictEqual(bot.isPlaying, true);
});

test('loadingRuns is back to 0 after a failed join', async () => {
	const { bot, message, text } = setup([plex('A')]);
	const hold = holdNextJoin(bot);
	bot.playSong(message);
	await until(() => hold.fail, 'the join to start');
	assert.strictEqual(bot.loadingRuns, 1);

	hold.fail(new Error('The operation was aborted'));
	await settle();

	assert.match(text(), /couldn't get into the voice channel/i);
	assert.strictEqual(bot.loadingRuns, 0, 'a stuck count would refuse /book play until a restart');
	assert.strictEqual(bot.musicBusy(), false);
});

test('musicBusy is true while the first track joins and false after a natural finish', async () => {
	const { bot, message, fetches } = setup([plex('A')]);
	const hold = holdNextJoin(bot);
	assert.strictEqual(bot.musicBusy(), false);

	bot.playSong(message);
	await until(() => hold.joined, 'the join to start');
	assert.strictEqual(bot.isPlaying, false, 'isPlaying alone would let a book in here');
	assert.strictEqual(bot.musicBusy(), true);

	hold.joined();
	await until(() => fetches.length === 1, 'the download of A');
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.musicBusy(), true, 'the stream is still opening');

	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].readable();
	assert.strictEqual(bot.musicBusy(), true);

	players[0].go(AudioPlayerStatus.Idle);
	await settle();
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(bot.musicBusy(), false);
	assert.strictEqual(bot.loadingRuns, 0);
});

test('musicBusy is false straight after a stop, though the stopped player is still buffering', async () => {
	const { bot, message, fetches } = setup([plex('A')]);
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	const conn = bot.conn;

	stop.command.process(bot, null, message);
	await settle();

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering, 'ffmpeg has not produced output yet');
	assert.strictEqual(bot.dispatcher, players[0]);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
	assert.strictEqual(bot.songQueue.length, 0);
	assert.strictEqual(bot.musicBusy(), false, 'the player holds no voice, so /book play may start');

	players[0].readable();
	await settle();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.strictEqual(bot.musicBusy(), false);
});

test('musicBusy stays true across a skip with tracks left', async () => {
	const { bot, message, fetches } = setup([plex('A'), plex('B')]);
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].readable();

	// The skip destroys the connection, so B's run joins again.
	const hold = holdNextJoin(bot);
	skip.command.process(bot, null, message, '');
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(bot.musicBusy(), true, 'B is about to take the voice back');

	await until(() => hold.joined, "B's join");
	assert.strictEqual(bot.musicBusy(), true);
	hold.joined();
	await until(() => fetches.length === 2, 'the download of B');
	assert.strictEqual(fetches[1].track.title, 'B');
	assert.strictEqual(bot.musicBusy(), true);
});

test('openConnection joins the channel it is given, not the music channel', async () => {
	const bot = new Bot({});
	const sentTo = [];
	const guild = {
		id: 'g-open',
		voiceAdapterCreator: () => ({
			sendPayload: (payload) => { sentTo.push(payload.d.channel_id); return true; },
			destroy() {}
		})
	};
	bot.voiceChannel = { id: 'music-vc', name: 'Music', guild };
	const bookChannel = { id: 'book-vc', name: 'Reading Room', guild };

	const joining = bot.openConnection(bookChannel);
	const connection = getVoiceConnection('g-open');
	try {
		assert.ok(connection, 'the join was made');
		assert.strictEqual(connection.joinConfig.channelId, 'book-vc');
		connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready };
		assert.strictEqual(await joining, connection);
		assert.deepStrictEqual(sentTo, ['book-vc']);
		assert.strictEqual(bot.voiceChannel.id, 'music-vc', 'music\'s channel is left alone');
	} finally {
		try { connection.destroy(); } catch (_) {}
	}
});
