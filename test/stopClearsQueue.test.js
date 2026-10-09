// Stop clearing the queue whenever there is one, not only while something is audibly playing.
//
// The bug: commands/stop.js cleared the queue only when bot.isPlaying was true. A failed voice
// join keeps its queue with isPlaying false on purpose, and so does a !play from someone outside
// voice, and a first track is not "playing" until its join and its Plex download are both in. In
// each of those Stop answered "Nothing currently playing", kept every track, and the next !play
// appended behind them and started from the old head. The Stop button runs the same stop.js
// through helpers/playbackButtons.js, so it is driven through that path here.
//
// Same harness as test/playbackRace.test.js: a FakePlayer in place of @discordjs/voice's, and
// openConnection and openPlexStream stubbed so nothing needs Discord or Plex.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-stop-clears-' + process.pid);

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
const playbackButtons = require('../helpers/playbackButtons.js');
const stop = require('../commands/stop.js');
const utils = require('../app/utils.js');

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

function setup(queue, { inVoice = true } = {}) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);

	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track, cancelled: false };
		const body = new ReadableStream({ cancel() { fetch.cancelled = true; } });
		fetch.arrive = () => resolve({ ok: true, status: 200, body });
		fetches.push(fetch);
	});
	const join = async () => (bot.conn && bot.conn.state.status === VoiceConnectionStatus.Ready
		? bot.conn
		: connection());
	bot.openConnection = join;

	const sent = [];
	const voiceChannel = { id: 'c1', name: 'Music', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } };
	const member = { voice: { channel: inVoice ? voiceChannel : null } };
	const channel = { id: 't1', name: 'bot-commands', async send(x) { sent.push(x); return {}; } };
	const message = {
		member,
		channel,
		async reply(x) { sent.push(x); return {}; }
	};
	const finished = [];
	bot.on('finish', () => finished.push(true));

	// A click on the Stop button of a now-playing card, answered through the interaction.
	const pressStop = () => playbackButtons.handle({
		customId: 'playback:stop',
		member,
		channel,
		channelId: channel.id,
		user: { id: 'u1', username: 'listener' },
		async deferReply() {},
		async editReply(x) { sent.push(x); return {}; },
		async followUp(x) { sent.push(x); return {}; },
		async reply(x) { sent.push(x); return {}; }
	}, bot, null, { stop: stop.command });

	const text = () => sent.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
	return { bot, message, fetches, finished, sent, text, pressStop, join };
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

test('Stop clears what a failed voice join left queued, so the next !play plays what was asked', async () => {
	const ctx = setup([plex('Old-1'), plex('Old-2'), plex('Old-3')]);
	const { bot, message, fetches, text } = ctx;
	bot.openConnection = async () => { throw new Error('The operation was aborted'); };
	bot.playSong(message);
	await until(() => /couldn't get into the voice channel/.test(text()), 'the failed join');
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.songQueue.length, 3, 'a failed join keeps its queue on purpose');

	bot.openConnection = ctx.join;
	await ctx.pressStop();

	assert.deepStrictEqual(bot.songQueue, []);
	assert.doesNotMatch(text(), /Nothing currently playing/);
	assert.match(text(), /cleared 3 queued songs that had not started playing/);

	play(bot, message, plex('New'));
	await until(() => fetches.length === 1, 'a download');
	assert.strictEqual(fetches[0].track.title, 'New', 'not the old head');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['New']);
});

test('Stop clears a queue kept for a requester outside voice', async () => {
	const { bot, message, fetches, text } = setup([plex('A'), plex('B')], { inVoice: false });
	bot.playSong(message);
	await until(() => /Join a voice channel first/.test(text()), 'the no-channel reply');
	assert.strictEqual(bot.songQueue.length, 2);

	stop.command.process(bot, null, message);

	assert.deepStrictEqual(bot.songQueue, []);
	assert.match(text(), /cleared 2 queued songs/);
	assert.strictEqual(fetches.length, 0);
});

test('Stop while the first track is still joining voice ends it there', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, finished, text } = ctx;
	let joined, late;
	bot.openConnection = () => new Promise((resolve) => { joined = () => resolve(late = connection()); });
	bot.playSong(message);
	await until(() => joined, 'the join to start');
	assert.strictEqual(bot.isPlaying, false, 'nothing counts as playing before the download is in');

	await ctx.pressStop();
	joined();
	await settle();

	assert.doesNotMatch(text(), /Nothing currently playing/);
	assert.doesNotMatch(text(), /couldn't get into the voice channel/i);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(fetches.length, 0, 'A is never downloaded');
	assert.strictEqual(players.length, 0, 'and never gets a player');
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(late.state.status, VoiceConnectionStatus.Destroyed, 'the join that finished after the Stop leaves voice again');
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(finished.length, 1);
});

test('Stop while the first join hangs is not followed by a join failure when it times out', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, finished, text } = ctx;
	let timedOut;
	bot.openConnection = () => new Promise((resolve, reject) => {
		timedOut = () => reject(new Error('The operation was aborted'));
	});
	bot.playSong(message);
	await until(() => timedOut, 'the join to start');

	await ctx.pressStop();
	timedOut();
	await settle();

	assert.match(text(), /cleared 2 queued songs/);
	assert.doesNotMatch(text(), /couldn't get into the voice channel/i, 'Stop already said playback stopped');
	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(fetches.length, 0);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(finished.length, 1);
});

test('a skip while the first join hangs still reports the failed join, with tracks still queued', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, text } = ctx;
	let timedOut;
	bot.openConnection = () => new Promise((resolve, reject) => {
		timedOut = () => reject(new Error('The operation was aborted'));
	});
	bot.playSong(message);
	await until(() => timedOut, 'the join to start');

	require('../commands/skip.js').command.process(bot, null, message, '');
	timedOut();
	await settle();

	assert.match(text(), /couldn't get into the voice channel/i, 'only an emptied queue silences the failure');
	assert.ok(bot.songQueue.length > 0);
	assert.strictEqual(bot.isPlaying, false);
});

test('Stop while the first track downloads drops the download', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches } = ctx;
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');

	await ctx.pressStop();
	fetches[0].arrive();
	await settle();

	assert.strictEqual(fetches[0].cancelled, true);
	assert.strictEqual(players.length, 0);
	assert.strictEqual(fetches.length, 1, 'B is not fetched either');
	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(bot.isPlaying, false);
});

test('Stop while a track plays clears the rest, with the heading shown above the embed', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')]);
	const { bot, message, fetches, sent } = ctx;
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);

	await ctx.pressStop();
	await settle();

	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.strictEqual(fetches.length, 1, 'nothing after A is fetched');
	const reply = sent.find(x => x && x.embeds && x.embeds[0].description === bot.language.STOP_INFO);
	assert.ok(reply, 'a stop of a playing track still says playback stopped');
	assert.strictEqual(reply.content, bot.language.STOP_SUCCES);
});

test('Stop with nothing queued says so and touches nothing', async () => {
	const ctx = setup([]);
	const { bot, text } = ctx;

	await ctx.pressStop();

	assert.match(text(), /Nothing currently playing/);
	assert.strictEqual(bot.stopGeneration, 0, 'no stop for a run that never existed');
});

test('a restart stops the old bot instead of leaving its track playing', async () => {
	const { bot, message, fetches } = setup([plex('A'), plex('B')]);
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);
	const conn = bot.conn;
	let clientDestroyed = false;

	utils.stop(bot, { destroy() { clientDestroyed = true; } });
	await settle();

	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed, 'the old connection leaves voice');
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(fetches.length, 1, 'B is not started by the old bot');
	assert.strictEqual(clientDestroyed, true);
});
