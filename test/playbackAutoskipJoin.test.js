// app/bot.js: a voice join still under way when locked songs (bot.autoskip) end playback.
//
// A newer run's openConnection destroys an older run's unfinished join. A run that skips every song
// left joins nothing, so the older run's join is left to land, holding the bot in voice with nothing
// to play unless that run lets it go: /book play would be refused, and !stop, with nothing playing,
// would never release it. What has to hold: that join leaves the channel as it lands; one that never
// lands times out without a word; and a !play in the meantime joins afresh and plays, the old join's
// timeout leaving its connection alone.
//
// Harness: test/voiceJoinRace.test.js's. The real openConnection runs against the real connection
// registry, joinVoiceChannel, entersState and VoiceConnection; on the voice side only Discord is
// faked: the guild's voice adapter, which never answers, and a Ready status set by hand. Timers are
// mocked so the 30 s join timeout can be run out. The player and the Plex download are faked as in
// test/playbackRace.test.js, the guild's voice cache is a Map of fake VoiceStates, and bot.autoskip is
// a stand-in that answers from a table by title.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-autoskip-join-' + process.pid);

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
const ROAD = Object.freeze({ slots: ['ZackPlex'], playlists: ['Road Trip'] });

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

async function until(cond, what) {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setImmediate(r));
	assert.ok(cond(), `timed out waiting for ${what}`);
}

// Getting to Ready for real takes Discord's voice servers. The status change is all openConnection
// waits for.
function ready(connection) {
	connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready };
}

/**
 * A Bot in guild g1 with `queue` loaded, whose one listener, u1 in channel c1, starts self-deafened.
 * The guild's adapter records in `sentTo` the channel each voice state update asked for, null for a
 * leave, and answers none. Plex downloads each wait for arrive(), and bot.autoskip answers from
 * `locked` by title.
 */
function setup(queue, locked) {
	const bot = new Bot({});
	bot.songQueue.push(...queue);
	bot.autoskip = (entry) => locked[entry.title] || null;

	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track };
		fetch.arrive = () => resolve({ ok: true, status: 200, body: new ReadableStream() });
		fetches.push(fetch);
	});

	const cache = new Map([['u1', { channelId: 'c1', selfDeaf: true }]]);
	const guild = {
		id: 'g1',
		sentTo: [],
		voiceStates: { cache },
		voiceAdapterCreator: () => ({
			sendPayload: (payload) => { guild.sentTo.push(payload.d.channel_id); return true; },
			destroy() {}
		})
	};
	const sent = [];
	const message = {
		member: { voice: { channel: { id: 'c1', name: 'Music', guild } } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const finished = [];
	bot.on('finish', () => finished.push(true));
	const text = () => sent.map((x) => (typeof x === 'string' ? x : x.content || JSON.stringify(x))).join('\n');
	return { bot, message, guild, cache, fetches, finished, text };
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

/**
 * X's run starts joining with nobody there to ask about it. Then u1 undeafens and queues Y: the run
 * that starts finds X and Y locked, skips both and ends playback, leaving X's join under way.
 */
async function endWhileJoining(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => getVoiceConnection('g1'), "X's join");
	const join = getVoiceConnection('g1');
	ctx.cache.set('u1', { channelId: 'c1' });
	play(ctx.bot, ctx.message, plex('Y'));
	await settle();
	assert.strictEqual(ctx.finished.length, 1, 'the skips ended playback');
	assert.match(ctx.text(), /Skipped 2 songs still locked in Road Trip/);
	return join;
}

test('a join under way when locked songs end playback leaves the channel as it lands', async () => {
	const ctx = setup([plex('X')], { X: ROAD, Y: ROAD });
	const { bot, message, guild, fetches } = ctx;
	const join = await endWhileJoining(ctx);

	ready(join);
	await settle();
	assert.strictEqual(join.state.status, VoiceConnectionStatus.Destroyed);
	assert.strictEqual(getVoiceConnection('g1'), undefined, 'nothing holds the bot in the channel');
	assert.deepStrictEqual(guild.sentTo, ['c1', null], 'joined, then left');
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(bot.musicBusy(), false, 'nothing keeps /book play out of voice');
	assert.deepStrictEqual(fetches, []);
	assert.strictEqual(ctx.finished.length, 1);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);

	play(bot, message, plex('Z'));
	await until(() => getVoiceConnection('g1'), "Z's join");
	ready(getVoiceConnection('g1'));
	await until(() => fetches.length === 1, 'the download of Z');
	assert.strictEqual(fetches[0].track.title, 'Z');
});

test('a join under way when locked songs end playback that never lands times out without a word', async () => {
	const ctx = setup([plex('X')], { X: ROAD, Y: ROAD });
	const join = await endWhileJoining(ctx);

	test.mock.timers.tick(30_000);
	await settle();
	assert.strictEqual(join.state.status, VoiceConnectionStatus.Destroyed);
	assert.strictEqual(getVoiceConnection('g1'), undefined);
	assert.strictEqual(ctx.bot.musicBusy(), false);
	assert.doesNotMatch(ctx.text(), /couldn't get into the voice channel/i, 'playback had already ended');
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
	assert.strictEqual(commandLog.readEventLog({ kind: 'voice-join-failed' }).length, 1);
});

test('a !play while that join is still under way joins afresh and plays, and the old join times out without touching it', async () => {
	const ctx = setup([plex('X')], { X: ROAD, Y: ROAD });
	const { bot, message, fetches } = ctx;
	const join = await endWhileJoining(ctx);

	play(bot, message, plex('Z'));
	await until(() => getVoiceConnection('g1') !== join, "Z's join");
	const second = getVoiceConnection('g1');
	assert.strictEqual(join.state.status, VoiceConnectionStatus.Destroyed, "Z's join clears the one it found unfinished");
	ready(second);
	await until(() => fetches.length === 1, 'the download of Z');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for Z');
	players[0].go(AudioPlayerStatus.Playing);

	test.mock.timers.tick(30_000);
	await settle();
	assert.strictEqual(bot.conn, second);
	assert.strictEqual(second.state.status, VoiceConnectionStatus.Ready, 'the playing connection is left alone');
	assert.strictEqual(second.state.subscription.player, players[0]);
	assert.strictEqual(bot.isPlaying, true);
	assert.doesNotMatch(ctx.text(), /couldn't get into the voice channel/i);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
});
