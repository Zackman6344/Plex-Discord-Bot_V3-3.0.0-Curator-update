// app/bot.js: the 'track-heard' event, one per music player from its Idle, which
// helpers/apMediaVoice.js turns into Plex Media credit, and the ratingKey and duration trackToMusic
// now puts on queue entries.
//
// What a listen was has to be read at the top of the Idle listener. By its end dispatcherFunc has
// shifted the queue, so songQueue[0] is the next track, and after the last track playbackCompletion
// has nulled voiceChannel: read there, a queue's final track (and every single-track !play) would
// credit nobody, or the wrong title. The emit comes after the queue has moved on, and a listener
// that throws must not reach voice's audio cycle or stop the next track.
//
// Harness: test/playbackRace.test.js's FakePlayer, swapped into require.cache before app/bot.js
// destructures @discordjs/voice, except that its states carry the resource as the real player's
// do, and the stub resource has the two fields the Idle listener reads (playbackDuration and
// playStream.readableEnded), which a test sets with hear() before moving the player on. Downloads
// wait for arrive(); the guild's voice cache is a Map of fake VoiceStates.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-track-heard-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus } = voice;

const players = [];

const resourceOf = (input) => ({ input, playbackDuration: 0, playStream: { readableEnded: false } });

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

	// What the real resource has counted by the time the player moves on: playbackDuration grows by
	// 20 ms per Opus packet sent, and readableEnded turns true once the stream gave its last packet.
	hear(ms, { ended = false } = {}) {
		this.resource.playbackDuration = ms;
		this.resource.playStream.readableEnded = ended;
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
		this.state = status === AudioPlayerStatus.Idle ? { status } : { status, resource: this.resource };
		this.emit(status, old, this.state);
	}
}

require.cache[voicePath].exports = Object.assign({}, voice, {
	createAudioPlayer: () => new FakePlayer(),
	createAudioResource: resourceOf
});

const Bot = require('../app/bot.js');
const apMediaVoice = require('../helpers/apMediaVoice.js');
const commandLog = require('../helpers/commandLog.js');
const skip = require('../commands/skip.js');
const seekCmd = require('../commands/seek.js');
const loop = require('../commands/loop.js');

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
 * A Bot with `queue` loaded in guild g1, channel c1, whose voice cache holds `voiceStates`, and
 * whose Plex downloads each wait for the test to call `arrive()`. Every 'track-heard' is recorded
 * with the queue as it stood when the event fired.
 */
function setup(queue, { voiceStates = [['u1', { channelId: 'c1' }]], botId = 'bot' } = {}) {
	const client = { user: { id: botId }, guilds: { cache: new Map() } };
	const bot = new Bot(client);
	bot.songQueue.push(...queue);
	bot.seekResource = (readstream) => resourceOf(readstream);

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
	const cache = new Map(voiceStates);
	const guild = { id: 'g1', voiceAdapterCreator: () => ({}), voiceStates: { cache } };
	client.guilds.cache.set(guild.id, guild);
	const voiceChannel = { id: 'c1', name: 'Music', guild };
	const message = {
		member: { voice: { channel: voiceChannel } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const finished = [];
	bot.on('finish', () => finished.push(true));
	const heard = [];
	bot.on('track-heard', (h) => heard.push({ ...h, queueThen: bot.songQueue.map(t => t.title) }));
	return { bot, message, sent, fetches, finished, heard, cache };
}

/** Play the head of the queue as far as Playing. */
async function playNext(ctx) {
	const n = players.length;
	if (n === 0) ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === n + 1, `download ${n + 1}`);
	ctx.fetches[n].arrive();
	await until(() => players.length === n + 1, `player ${n + 1}`);
	players[n].go(AudioPlayerStatus.Playing);
	return players[n];
}

test('the last track of a queue reports its own entry, guild and channel', async () => {
	const a = plex('A');
	const b = plex('B');
	const ctx = setup([a, b]);
	const { bot, heard, finished } = ctx;

	const first = await playNext(ctx);
	first.hear(200000, { ended: true });
	first.go(AudioPlayerStatus.Idle);
	const last = await playNext(ctx);
	last.hear(180000, { ended: true });
	last.go(AudioPlayerStatus.Idle);
	await settle();

	assert.strictEqual(finished.length, 1, 'the queue ran out');
	assert.strictEqual(bot.voiceChannel, null, 'playbackCompletion cleared the channel before the event fired');
	assert.strictEqual(heard.length, 2);
	assert.strictEqual(heard[0].entry, a);
	assert.strictEqual(heard[1].entry, b, 'the queue entry that played, not whatever is at the head now');
	assert.deepStrictEqual(heard.map(h => h.queueThen), [['B'], []], 'each event fires after the queue moved on');
	const { entry, queueThen, ...rest } = heard[1];
	assert.deepStrictEqual(rest, { heardMs: 180000, startMs: 0, natural: true, guildId: 'g1', channelId: 'c1', startListeners: ['u1'] });
});

test('a skipped track reports natural false and the audio heard before the skip', async () => {
	const a = plex('A');
	const ctx = setup([a, plex('B')]);
	const { bot, message, fetches, heard } = ctx;

	const player = await playNext(ctx);
	player.hear(42000);
	skip.command.process(bot, null, message, '');
	await until(() => fetches.length === 2, 'the download of B');
	await settle();

	assert.strictEqual(heard.length, 1);
	assert.strictEqual(heard[0].entry, a);
	assert.strictEqual(heard[0].heardMs, 42000);
	assert.strictEqual(heard[0].natural, false);
	assert.strictEqual(fetches[1].track.title, 'B', 'the skip still moves on, once');
	assert.deepStrictEqual(bot.songQueue.map(t => t.title), ['B']);
});

test('the listeners are the humans in the channel when the track first played', async () => {
	const ctx = setup([plex('A')], {
		voiceStates: [
			['u1', { channelId: 'c1', member: { user: { bot: false } } }],
			['deaf', { channelId: 'c1', selfDeaf: true }],
			['muted', { channelId: 'c1', serverDeaf: false, selfDeaf: false, selfMute: true }],
			['server-deaf', { channelId: 'c1', deaf: true, serverDeaf: true }],
			['elsewhere', { channelId: 'c2' }],
			['other-bot', { channelId: 'c1', member: { user: { bot: true } } }],
			['bot', { channelId: 'c1' }],
			['u2', { channelId: 'c1' }]
		]
	});
	const { heard, cache } = ctx;

	const player = await playNext(ctx);
	// Joining later, leaving later and an unpause (Playing again) leave the start snapshot alone;
	// the end of the track is apMediaVoice's own snapshot.
	cache.set('late', { channelId: 'c1' });
	cache.delete('u2');
	player.go(AudioPlayerStatus.Paused);
	player.go(AudioPlayerStatus.Playing);
	player.hear(100000, { ended: true });
	player.go(AudioPlayerStatus.Idle);
	await settle();

	assert.deepStrictEqual(heard[0].startListeners, ['u1', 'muted', 'u2']);
});

test('voiceListeners reads the guild voice cache: humans in that channel, not deafened', () => {
	const bot = new Bot({ user: { id: 'bot' } });
	const cache = new Map([
		['u1', { channelId: 'c1' }],
		['bot', { channelId: 'c1' }],
		['b', { channelId: 'c1', member: { user: { bot: true } } }],
		['d', { channelId: 'c1', deaf: true }],
		['x', { channelId: 'c2' }]
	]);
	assert.deepStrictEqual(bot.voiceListeners({ voiceStates: { cache } }, 'c1'), ['u1']);
	assert.deepStrictEqual(bot.voiceListeners({ voiceStates: { cache } }, 'c2'), ['x']);
	assert.deepStrictEqual(bot.voiceListeners({}, 'c1'), [], 'a guild without a voice cache has nobody to name');
	assert.deepStrictEqual(bot.voiceListeners(null, 'c1'), []);
});

test('a track that never reached Playing reports no listeners', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, fetches, heard } = ctx;
	bot.playSong(ctx.message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	players[0].emit('error', new Error('read ECONNRESET'));
	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the download of B');

	assert.strictEqual(heard.length, 1);
	assert.deepStrictEqual(heard[0].startListeners, []);
	assert.strictEqual(heard[0].heardMs, 0);
});

test('a stream error reports once, from the Idle that follows it, and the queue moves on once', async () => {
	const a = plex('A');
	const ctx = setup([a, plex('B'), plex('C')]);
	const { fetches, heard } = ctx;

	const player = await playNext(ctx);
	player.hear(5000);
	player.emit('error', new Error('read ECONNRESET'));
	player.go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the download of B');
	await settle();

	assert.strictEqual(heard.length, 1);
	assert.strictEqual(heard[0].entry, a);
	assert.strictEqual(heard[0].natural, false);
	assert.strictEqual(heard[0].heardMs, 5000);
	assert.strictEqual(fetches.length, 2, 'C is not skipped as well');
	assert.strictEqual(fetches[1].track.title, 'B');
});

test('a track-heard listener that throws changes nothing about what plays next', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, fetches, finished } = ctx;
	bot.on('track-heard', () => { throw new Error('listener bug'); });

	const first = await playNext(ctx);
	first.hear(1000, { ended: true });
	assert.doesNotThrow(() => first.go(AudioPlayerStatus.Idle));
	const second = await playNext(ctx);
	assert.strictEqual(fetches[1].track.title, 'B');
	second.hear(1000, { ended: true });
	assert.doesNotThrow(() => second.go(AudioPlayerStatus.Idle));
	await settle();

	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.conn, null);
});

// The bug: the event said how much audio went out but not where in the track it began, so a part
// cut short could not be placed: a replay after a !seek starts at the seek, not at 0.
test('a seek reports the audio before it, then the replay reports the rest from the seek point, both for the same entry', async () => {
	const a = plex('A');
	const ctx = setup([a]);
	const { bot, message, heard } = ctx;

	const first = await playNext(ctx);
	first.hear(30000);
	await seekCmd.command.process(bot, null, message, '1:00');
	const replay = await playNext(ctx);
	replay.hear(150000, { ended: true });
	replay.go(AudioPlayerStatus.Idle);
	await settle();

	assert.deepStrictEqual(heard.map(h => [h.entry === a, h.startMs, h.heardMs, h.natural]), [[true, 0, 30000, false], [true, 60000, 150000, true]]);
});

test('a looped track reports every time it plays out', async () => {
	const a = plex('A');
	const ctx = setup([a]);
	const { bot, message, heard } = ctx;
	loop.command.process(bot, null, message, '');

	const first = await playNext(ctx);
	first.hear(90000, { ended: true });
	first.go(AudioPlayerStatus.Idle);
	const second = await playNext(ctx);
	second.hear(90000, { ended: true });
	second.go(AudioPlayerStatus.Idle);
	await until(() => ctx.fetches.length === 3, 'the third play of A');

	assert.deepStrictEqual(heard.map(h => [h.entry === a, h.natural]), [[true, true], [true, true]]);
});

test('apMediaVoice credits the last track of a queue to the people who heard all of it', async () => {
	const last = { title: 'Midnight City', artist: 'M83', key: '/library/parts/5901/1600000000/file.flac', ratingKey: 901, duration: 240000 };
	const ctx = setup([plex('A'), last], { voiceStates: [['u1', { channelId: 'c1' }], ['u2', { channelId: 'c1' }]] });
	const events = [];
	const detach = apMediaVoice.attach({
		bot: ctx.bot,
		resolve: (entry, ident) => (ident.ratingKey === 901 ? { durationMs: 240000 } : null),
		onEvent: (e) => { events.push(e); },
		getConfig: () => ({ apMediaVoiceCredit: true }),
		now: () => 1234
	});

	const first = await playNext(ctx);
	first.hear(200000, { ended: true });
	first.go(AudioPlayerStatus.Idle);
	const second = await playNext(ctx);
	ctx.cache.delete('u2');
	second.hear(240000, { ended: true });
	second.go(AudioPlayerStatus.Idle);
	await settle();
	detach();

	assert.strictEqual(ctx.bot.voiceChannel, null);
	assert.deepStrictEqual(events, [{
		type: 'complete', source: 'voice', userIds: ['u1'], ratingKey: 901, partId: 5901, artist: 'M83', title: 'Midnight City', at: 1234
	}], 'A is on no list, and u2 left before the end');
});

test('trackToMusic puts the ratingKey as a number and the duration in ms on the queue entry', () => {
	const bot = new Bot({});
	const track = (extra) => ({
		title: 'One More Time', grandparentTitle: 'Daft Punk', parentTitle: 'Discovery',
		Media: [{ Part: [{ key: '/library/parts/9876/1600000000/file.flac' }] }],
		...extra
	});

	assert.deepStrictEqual(bot.trackToMusic(track({ ratingKey: '346', duration: 320000 })), {
		artist: 'Daft Punk', title: 'One More Time', key: '/library/parts/9876/1600000000/file.flac', album: 'Discovery',
		ratingKey: 346, duration: 320000
	});
	const bare = bot.trackToMusic(track({}));
	assert.strictEqual(bare.ratingKey, null);
	assert.strictEqual(bare.duration, null);
	assert.strictEqual(bot.trackToMusic(track({ ratingKey: 'abc', duration: -5 })).ratingKey, null);
	assert.strictEqual(bot.trackToMusic(track({ originalTitle: 'Guest' })).artist, 'Guest', 'the artist rule is unchanged');
});
