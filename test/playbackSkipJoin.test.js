// A !skip while the bot is still making its first voice join.
//
// Nothing counts as playing until the first Plex download is in, so the skip lands with no player
// to stop and only records the stopped entry. The !play that follows starts a second run, which
// used to take the skipped track as its own, destroy the first run's join and play it anyway.
//
// The harness is test/voiceJoinRace.test.js's: the real openConnection, joinVoiceChannel,
// entersState and VoiceConnection, a guild adapter that never answers, Ready set by hand, and
// setTimeout mocked so the 30 s join timeout can be run out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-skipjoin-' + process.pid);

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

	subscribe(connection) {
		return { connection, player: this, unsubscribe() {} };
	}

	play() {
		this.go(AudioPlayerStatus.Buffering);
	}

	// A real player goes Idle in its own time after an unforced stop, so the test sends Idle by hand.
	stop() {
		this.stopCalls = (this.stopCalls || 0) + 1;
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

function guild(id) {
	return {
		id,
		voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} })
	};
}

function ready(connection) {
	connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready };
}

/** A Bot with `queue` loaded, whose Plex downloads each wait for the test to call `arrive()`. */
function setup(queue) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);
	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track };
		const body = new ReadableStream({ cancel() {} });
		fetch.arrive = () => resolve({ ok: true, status: 200, body });
		fetches.push(fetch);
	});
	let finishes = 0;
	bot.on('finish', () => { finishes++; });
	const sent = [];
	const voiceChannel = { id: 'c1', name: 'Music', guild: guild('g1') };
	const message = {
		member: { voice: { channel: voiceChannel } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const text = () => sent.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
	const announced = () => sent
		.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
		.map(x => x.embeds[0].fields[0].value);
	return { bot, message, fetches, text, announced, finishes: () => finishes };
}

function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

/** Start A's run and wait for its join, then skip A while that join is still waiting. */
async function skipDuringJoin(s) {
	s.bot.playSong(s.message);
	await until(() => getVoiceConnection('g1'), 'the first join');
	const first = getVoiceConnection('g1');
	s.bot.stop();
	return first;
}

async function playThrough(s, first) {
	await until(() => getVoiceConnection('g1') && getVoiceConnection('g1') !== first, 'the second join');
	ready(getVoiceConnection('g1'));
	await until(() => s.fetches.length === 1, 'a download');
	s.fetches[0].arrive();
	await until(() => players.length === 1, 'a player');
	players[0].go(AudioPlayerStatus.Playing);
	test.mock.timers.tick(30_000);
	await settle();
}

test('a !skip during the first join, then !play X, plays X and never the skipped track', async () => {
	const s = setup([plex('A')]);
	const first = await skipDuringJoin(s);
	play(s.bot, s.message, plex('X'));
	await playThrough(s, first);

	assert.deepStrictEqual(s.fetches.map(f => f.track.title), ['X']);
	assert.deepStrictEqual(s.announced(), ['X']);
	assert.deepStrictEqual(s.bot.songQueue.map(t => t.title), ['X']);
	assert.doesNotMatch(s.text(), /couldn't get into the voice channel/i);
});

test('a !skip during the first join, then a bare !play, plays the next track', async () => {
	const s = setup([plex('A'), plex('B')]);
	const first = await skipDuringJoin(s);
	s.bot.playSong(s.message);
	await playThrough(s, first);

	assert.deepStrictEqual(s.fetches.map(f => f.track.title), ['B']);
	assert.deepStrictEqual(s.announced(), ['B']);
	assert.doesNotMatch(s.text(), /couldn't get into the voice channel/i);
});

test('a !skip of the only track during the join, then !play, ends playback once', async () => {
	const s = setup([plex('A')]);
	const first = await skipDuringJoin(s);
	s.bot.playSong(s.message);
	await settle();
	assert.strictEqual(s.finishes(), 1);
	assert.strictEqual(s.bot.isPlaying, false);
	assert.deepStrictEqual(s.bot.songQueue, []);

	ready(first);
	await settle();
	assert.strictEqual(first.state.status, VoiceConnectionStatus.Destroyed, 'the old join leaves when it lands');
	assert.strictEqual(s.finishes(), 1);
	assert.strictEqual(s.fetches.length, 0);
});

test('a !skip during a join that fails reports only the tracks after it', async () => {
	const s = setup([plex('A'), plex('B')]);
	await skipDuringJoin(s);
	test.mock.timers.tick(30_000);
	await until(() => /couldn't get into the voice channel/i.test(s.text()), 'the failure message');
	assert.deepStrictEqual(s.bot.songQueue.map(t => t.title), ['B']);
	const failed = commandLog.readEventLog({ kind: 'playback-failed' });
	assert.strictEqual(failed.length, 1);
	assert.match(s.text(), / 1 track are still queued/);
	assert.strictEqual(failed[0].queueDepth, 1);
});

test('a !skip of the only track during a join that fails ends playback quietly', async () => {
	const s = setup([plex('A')]);
	await skipDuringJoin(s);
	test.mock.timers.tick(30_000);
	await settle();
	assert.doesNotMatch(s.text(), /couldn't get into the voice channel/i);
	assert.strictEqual(s.finishes(), 1);
	assert.deepStrictEqual(s.bot.songQueue, []);
});

test('a looped track skipped and then seeked replays from the seek', async () => {
	const s = setup([{ ...plex('A'), replay: true }, plex('B')]);
	const a = s.bot.songQueue[0];
	s.bot.playSong(s.message);
	await until(() => getVoiceConnection('g1'), 'the join');
	ready(getVoiceConnection('g1'));
	await until(() => s.fetches.length === 1, 'the download of A');
	s.fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].go(AudioPlayerStatus.Playing);

	s.bot.stop();
	a.isSeeking = true;
	a.seekOffset = 30000;
	players[0].go(AudioPlayerStatus.Idle);
	await settle();

	assert.strictEqual(s.bot.songQueue[0], a, 'a looped track is replayed after a skip');
	assert.strictEqual(a.isSeeking, true, 'the seek waits for the replay to read it');
	assert.strictEqual(a.seekOffset, 30000);
});

test('a skip of A during the join, then a Hitster clip in front of it, plays the clip and never A', async () => {
	const s = setup([plex('A'), plex('B')]);
	const first = await skipDuringJoin(s);
	s.bot.songQueue.unshift(plex('Clip'));
	s.bot.playSong(s.message);
	await playThrough(s, first);

	assert.deepStrictEqual(s.fetches.map(f => f.track.title), ['Clip']);
	players[0].go(AudioPlayerStatus.Idle);
	await until(() => s.fetches.length === 2, 'the next download');
	assert.strictEqual(s.fetches[1].track.title, 'B', 'the owed skip of A is taken once A reaches the head');
});

const CLIP_MS = 12000;

/**
 * A Hitster turn over A's owed skip, as commands/hitster.js executeTurn plays it: the clip goes in
 * front of the queue, the turn waits for it to load and arms its clip timer, and `endClip(timer)`
 * ends it the way the turn does, through bot.stop(). Then the clip's player goes Idle, and the
 * next track's fresh join lands and its download plays.
 */
async function hitsterTurnOverOwedSkip(s, first, endClip) {
	const clip = { key: '/library/parts/Clip/1/file.flac', title: 'Secret Track', artist: '???', secret: true };
	s.bot.songQueue.unshift(clip);
	const loaded = s.bot.playSong(s.message, 60000);
	await until(() => getVoiceConnection('g1') && getVoiceConnection('g1') !== first, 'the join of the clip');
	const clipJoin = getVoiceConnection('g1');
	ready(clipJoin);
	await until(() => s.fetches.length === 1, 'the download of the clip');
	s.fetches[0].arrive();
	await loaded;
	const clipTimer = setTimeout(() => { if (s.bot.isPlaying) s.bot.stop(); }, CLIP_MS);
	players[0].go(AudioPlayerStatus.Playing);
	endClip(clipTimer);
	players[0].go(AudioPlayerStatus.Idle);
	await until(() => getVoiceConnection('g1') && getVoiceConnection('g1') !== clipJoin, 'the join after the clip');
	ready(getVoiceConnection('g1'));
	await until(() => s.fetches.length === 2, 'the download after the clip');
	s.fetches[1].arrive();
	await until(() => players.length === 2, 'a player after the clip');
	players[1].go(AudioPlayerStatus.Playing);
	test.mock.timers.tick(30_000);
	await settle();
}

test('a skip of A during the join, then a Hitster clip that its clip timer stops, plays B after the clip and never A', async () => {
	const s = setup([plex('A'), plex('B')]);
	const first = await skipDuringJoin(s);
	await hitsterTurnOverOwedSkip(s, first, () => {
		test.mock.timers.tick(CLIP_MS);
		assert.strictEqual(players[0].stopCalls, 1, 'the clip timer stops the clip');
	});

	assert.deepStrictEqual(s.fetches.map(f => f.track.title), ['Secret Track', 'B'], 'A is never downloaded');
	assert.deepStrictEqual(s.announced(), ['Secret Track', 'B']);
	assert.deepStrictEqual(s.bot.songQueue.map(t => t.title), ['B']);
	assert.doesNotMatch(s.text(), /couldn't get into the voice channel/i);
});

test('a skip of A during the join, then a Hitster clip that !hitster stop ends with two stops in one tick, plays B', async () => {
	const s = setup([plex('A'), plex('B')]);
	const first = await skipDuringJoin(s);
	await hitsterTurnOverOwedSkip(s, first, (clipTimer) => {
		// resolveTurn('stopped') through the collector's 'end', then the stop handler's own stop.
		clearTimeout(clipTimer);
		if (s.bot.isPlaying) s.bot.stop();
		if (s.bot.isPlaying) s.bot.stop();
		assert.strictEqual(players[0].stopCalls, 2);
	});

	assert.deepStrictEqual(s.fetches.map(f => f.track.title), ['Secret Track', 'B'], 'A is never downloaded, and B is not skipped');
	assert.deepStrictEqual(s.announced(), ['Secret Track', 'B']);
	assert.deepStrictEqual(s.bot.songQueue.map(t => t.title), ['B']);
});
