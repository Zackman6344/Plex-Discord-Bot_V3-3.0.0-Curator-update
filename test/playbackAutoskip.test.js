// app/bot.js: songs the Plex Media game calls locked for everyone listening (bot.autoskip) leave the
// queue before the bot joins voice or opens a stream for them.
//
// What has to hold: a locked song is never fetched, played or announced, and the queue moves on past
// it as it does past an unplayable track; a queue left with only locked songs ends playback the way
// its last track would (one 'finish', the voice channel left, the unplayable tracks summed up), and
// one locked from its first song never joins at all; each stretch of skips is one line naming its
// songs and one 'track-locked' event, posted before the next song plays or as playback ends, and all
// the checks of a stretch get one object of their own, so the game reads its bindings once a stretch;
// a skip, a stop, a removal or a newer run set off during a check is what acts, and an older run
// still loading stands down, letting go of a join that lands after the skips ended playback, never
// of the connection the bot already holds; a replayed song (a !seek, or a !loop once the song has
// played), a secret clip and a song nobody is there to hear are never offered to the check, while a
// !loop set on a song waiting at the head of the queue does not get it past; and a check that throws
// lets the song play. A long locked stretch is one loop, not a run per song: a run each overflowed
// the stack at 1,700 in a row, and this test plays past 3,000.
//
// Harness: test/playbackRace.test.js's FakePlayer, swapped into require.cache before app/bot.js
// destructures @discordjs/voice. Downloads wait for arrive(), joins are counted, and the guild's voice
// cache is a Map of fake VoiceStates, as in test/apMediaTrackHeard.test.js. bot.autoskip is a
// stand-in that records what it was asked and answers from a table by title; during() runs a command
// inside it, the only way anything can land during a check, which is synchronous.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-autoskip-' + process.pid);

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
const logger = require('../helpers/logger.js');
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');
const seekCmd = require('../commands/seek.js');
const loop = require('../commands/loop.js');
const removesong = require('../commands/removesong.js');

test.beforeEach(() => { players.length = 0; });
test.afterEach(() => {
	try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
	commandLog._reset();
});

const plex = (title) => ({ title, artist: 'Engelwood', key: `/library/parts/${title}/1/file.flac` });
const ROAD = Object.freeze({ slots: ['ZackPlex'], playlists: ['Road Trip'] });
const PARTY = Object.freeze({ slots: ['Friend'], playlists: ['Party'] });
const ICON = '\u23ED\uFE0F';
const oneRoad = (title) => `${ICON} Skipped 1 song still locked in Road Trip on \`ZackPlex\`'s list: **${title}**.`;

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
 * A Bot with `queue` loaded in guild g1, channel c1, whose voice cache holds `voiceStates`, whose
 * Plex downloads each wait for arrive(), and whose bot.autoskip answers from `locked` by title.
 */
function setup(queue, { locked = {}, voiceStates = [['u1', { channelId: 'c1' }]] } = {}) {
	const client = { user: { id: 'bot' }, guilds: { cache: new Map() } };
	const bot = new Bot(client);
	bot.songQueue.push(...queue);
	bot.seekResource = (readstream) => ({ input: readstream });

	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		const fetch = { track, cancelled: false };
		const body = new ReadableStream({ cancel() { fetch.cancelled = true; } });
		fetch.arrive = () => resolve({ ok: true, status: 200, body });
		fetches.push(fetch);
	});
	let joins = 0;
	bot.openConnection = async () => {
		if (bot.conn && bot.conn.state.status === VoiceConnectionStatus.Ready) return bot.conn;
		joins += 1;
		return connection();
	};

	const sent = [];
	const guild = { id: 'g1', voiceAdapterCreator: () => ({}), voiceStates: { cache: new Map(voiceStates) } };
	client.guilds.cache.set(guild.id, guild);
	const voiceChannel = { id: 'c1', name: 'Music', guild };
	const message = {
		member: { voice: { channel: voiceChannel } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const finished = [];
	bot.on('finish', () => finished.push(true));
	const asked = [];
	bot.autoskip = (entry, listeners, stretch) => {
		asked.push({ title: entry.title, listeners, stretch });
		return locked[entry.title] || null;
	};
	// What reached the channel, in order: a now-playing card as "card: <title>", anything else as its text.
	const said = () => sent.map((x) => {
		if (x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES) return `card: ${x.embeds[0].fields[0].value}`;
		return typeof x === 'string' ? x : x.content;
	});
	const lines = () => sent.filter((x) => x && typeof x.content === 'string' && x.content.startsWith('\u23ED'));
	return { bot, message, locked, fetches, finished, sent, said, lines, asked, joins: () => joins, cache: guild.voiceStates.cache };
}

/** Play the head of the queue as far as Playing: its download is the newest one. */
async function playNext(ctx) {
	const n = players.length;
	if (n === 0 && ctx.fetches.length === 0) ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length > n, `download ${n + 1}`);
	ctx.fetches[ctx.fetches.length - 1].arrive();
	await until(() => players.length === n + 1, `player ${n + 1}`);
	players[n].go(AudioPlayerStatus.Playing);
	return players[n];
}

/** What every !play path does with a track it found: queue it, and start playback if none is under way. */
function play(bot, message, track) {
	bot.songQueue.push(track);
	if (!bot.isPlaying) bot.playSong(message);
}

/**
 * Make the next voice join wait for land(), as a fresh join to Discord does. land() resolves it with
 * `conn`, a new connection unless given, and returns that connection.
 */
function holdNextJoin(bot) {
	const reuse = bot.openConnection;
	const hold = { land: null };
	bot.openConnection = () => new Promise((resolve) => {
		hold.land = (conn = connection()) => {
			bot.openConnection = reuse;
			resolve(conn);
			return conn;
		};
	});
	return hold;
}

const titles = (ctx) => ctx.fetches.map((f) => f.track.title);

test('a locked song between two open ones is never fetched or announced, and one line says why before the next plays', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')], { locked: { B: ROAD } });
	const { bot } = ctx;

	const first = await playNext(ctx);
	first.go(AudioPlayerStatus.Idle);
	const next = await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['A', 'C'], 'B is never downloaded');
	assert.deepStrictEqual(ctx.said(), ['card: A', oneRoad('B'), 'card: C'], 'the line comes before the next song\'s card');
	assert.deepStrictEqual(ctx.lines()[0].allowedMentions, { parse: [] });
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['A', 'B', 'C'], 'each song is asked about once, as it comes up');
	assert.deepStrictEqual(ctx.asked[1].listeners, ['u1'], 'the people in the channel, as voice credit reads them');
	assert.strictEqual(bot.conn.subscribed, next, 'C plays through the same connection');
	assert.strictEqual(ctx.joins(), 1, 'the skip costs no second join');
	assert.deepStrictEqual(bot.songQueue.map((t) => t.title), ['C']);
	assert.strictEqual(bot.isPlaying, true);

	const events = commandLog.readEventLog({ kind: 'track-locked' });
	assert.strictEqual(events.length, 1);
	assert.deepStrictEqual(
		[events[0].count, events[0].songs, events[0].slots, events[0].playlists],
		[1, 'Engelwood - B', 'ZackPlex', 'Road Trip']
	);
});

test('a queue left with only locked songs ends playback the way its last track does', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')], { locked: { B: ROAD, C: ROAD } });
	const { bot, message, finished } = ctx;

	const first = await playNext(ctx);
	const conn = bot.conn;
	first.go(AudioPlayerStatus.Idle);
	await settle();

	assert.deepStrictEqual(titles(ctx), ['A']);
	assert.strictEqual(players.length, 1);
	assert.strictEqual(bot.isPlaying, false, 'the next !play starts playback again');
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.conn, null, 'the channel is left');
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Destroyed);
	assert.strictEqual(bot.voiceChannel, null);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.deepStrictEqual(ctx.said(), [
		'card: A',
		`${ICON} Skipped 2 songs still locked in Road Trip on \`ZackPlex\`'s list: **B** and **C**.`
	]);

	play(bot, message, plex('D'));
	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['A', 'D']);
	assert.strictEqual(bot.isPlaying, true);
});

test('a queue locked from its first song never joins voice, and names every slot and playlist once', async () => {
	const ctx = setup([plex('B1'), plex('B2'), plex('B3')], { locked: { B1: ROAD, B2: PARTY, B3: ROAD } });
	const { bot, finished } = ctx;

	bot.playSong(ctx.message);
	await settle();

	assert.strictEqual(ctx.joins(), 0);
	assert.strictEqual(ctx.fetches.length, 0);
	assert.strictEqual(players.length, 0);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.voiceChannel, null);
	assert.deepStrictEqual(ctx.said(), [
		`${ICON} Skipped 3 songs still locked in Road Trip and Party on the lists of \`ZackPlex\` and \`Friend\`: **B1**, **B2** and **B3**.`
	]);
	const events = commandLog.readEventLog({ kind: 'track-locked' });
	assert.deepStrictEqual(
		events.map((e) => [e.count, e.songs, e.slots, e.playlists]),
		[[3, 'Engelwood - B1; Engelwood - B2; Engelwood - B3', 'ZackPlex, Friend', 'Road Trip, Party']],
		'one event for the stretch'
	);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
});

test('each stretch of skips is its own line', async () => {
	const ctx = setup([plex('A'), plex('B1'), plex('C'), plex('B2'), plex('B3'), plex('D')], { locked: { B1: ROAD, B2: ROAD, B3: PARTY } });

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'C', 'D']);
	assert.deepStrictEqual(ctx.said(), [
		'card: A',
		oneRoad('B1'),
		'card: C',
		`${ICON} Skipped 2 songs still locked in Road Trip and Party on the lists of \`ZackPlex\` and \`Friend\`: **B2** and **B3**.`,
		'card: D'
	]);
	for (const line of ctx.lines()) assert.deepStrictEqual(line.allowedMentions, { parse: [] });
	assert.deepStrictEqual(commandLog.readEventLog({ kind: 'track-locked' }).map((e) => e.count), [1, 2], 'one event a stretch');

	// The game reads what a check needs once a stretch: every check of a stretch, the open song that
	// ends it included, gets one object, and each stretch a new one.
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['A', 'B1', 'C', 'B2', 'B3', 'D']);
	const [a, b1, c, b2, b3, d] = ctx.asked.map((x) => x.stretch);
	assert.strictEqual(typeof b2, 'object');
	assert.ok(b1 === c && b2 === b3 && b3 === d, 'one object a stretch');
	assert.ok(a !== b1 && c !== b2, 'a new one for each');
});

/** Run `act` inside the check, the first time the song called `title` is asked about. */
function during(ctx, title, act) {
	const ask = ctx.bot.autoskip;
	let done = false;
	ctx.bot.autoskip = (entry, ...rest) => {
		if (entry.title === title && !done) {
			done = true;
			act();
		}
		return ask(entry, ...rest);
	};
}

test('a !skip that lands during a check takes the song it was meant for, and the check goes on from there', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C'), plex('D')], { locked: { B: ROAD, C: ROAD } });
	const { bot, message } = ctx;
	during(ctx, 'B', () => skip.command.process(bot, null, message, ''));

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'D'], 'B went to the !skip and C to the check, each once');
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [oneRoad('C')], 'the line counts only the song the check took');
	assert.strictEqual(ctx.joins(), 2, 'the !skip left voice, so D joins again');
	assert.deepStrictEqual(bot.songQueue.map((t) => t.title), ['D']);
});

test('a !skip 2 during a check takes both songs it named, the second as its stopped track', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C'), plex('D')], { locked: { B: ROAD } });
	const { bot, message } = ctx;
	during(ctx, 'B', () => skip.command.process(bot, null, message, '2'));

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'D'], 'C, open but stopped, does not play');
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['A', 'B', 'D']);
	assert.deepStrictEqual(ctx.lines(), [], 'the !skip took both');
});

test('a !stop that lands during a check ends playback once, and nothing more is fetched', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C')], { locked: { B: ROAD } });
	const { bot, message, finished } = ctx;
	during(ctx, 'B', () => stop.command.process(bot, null, message));

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await settle();

	assert.deepStrictEqual(titles(ctx), ['A']);
	assert.strictEqual(finished.length, 1);
	assert.strictEqual(bot.isPlaying, false);
	assert.strictEqual(bot.conn, null);
	assert.deepStrictEqual(ctx.lines(), []);
	assert.doesNotMatch(ctx.said().join('\n'), /couldn't get into the voice channel/i);
});

test('a song removed from the queue during its check is not skipped in the next song\'s place', async () => {
	const ctx = setup([plex('B'), plex('C')], { locked: { B: ROAD } });
	const { bot, message } = ctx;
	during(ctx, 'B', () => removesong.command.process(bot, null, message, '1'));

	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['C'], 'C is checked in its own right, and plays');
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['B', 'C']);
	assert.deepStrictEqual(ctx.lines(), [], 'the !removesong took B');
});

test('a newer run started during a check plays on, and the run that asked stands down after saying what it skipped', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C'), plex('D')], { locked: { B: ROAD, C: ROAD } });
	const { bot, message } = ctx;
	during(ctx, 'C', () => bot.playSong(message));

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await playNext(ctx);
	await settle();

	assert.deepStrictEqual(titles(ctx), ['A', 'D'], 'D is fetched by one run only');
	// The newer run asks about C and D inside the first run's check of C, which is recorded last.
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['A', 'B', 'C', 'D', 'C'], 'the first run asks nothing more');
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [oneRoad('C'), oneRoad('B')], 'C by the newer run, then B by the one that stood down');
	assert.deepStrictEqual(commandLog.readEventLog({ kind: 'track-locked' }).map((e) => e.songs), ['Engelwood - C', 'Engelwood - B']);
});

test('a skip while the song after a stretch of skips joins moves on once', async () => {
	const ctx = setup([plex('A'), plex('B'), plex('C'), plex('D')], { locked: { B: ROAD } });
	const { bot, message } = ctx;
	await playNext(ctx);
	// The skip destroys the connection, so C's run has to join again; that join waits.
	const join = holdNextJoin(bot);
	skip.command.process(bot, null, message, '');
	await until(() => join.land, "C's join");

	skip.command.process(bot, null, message, '');
	join.land();
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'D']);
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [oneRoad('B')]);
	assert.deepStrictEqual(bot.songQueue.map((t) => t.title), ['D']);
});

test('an older run still loading its song stands down when the skips end playback', async () => {
	const ctx = setup([plex('X')]);
	const { bot, message, finished, locked } = ctx;
	bot.playSong(message);
	await until(() => ctx.fetches.length === 1, 'the download of X');
	// Nothing plays until that download is in, so a second !play starts a run of its own, and by
	// then X is locked: the one person it was open for left.
	locked.X = ROAD;
	locked.Y = ROAD;
	play(bot, message, plex('Y'));
	await settle();
	assert.strictEqual(finished.length, 1);

	ctx.fetches[0].arrive();
	await settle();
	assert.strictEqual(ctx.fetches[0].cancelled, true, 'the download of X is dropped');
	assert.strictEqual(players.length, 0);
	assert.strictEqual(finished.length, 1, 'playback ends once');
	assert.strictEqual(bot.isPlaying, false);
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [
		`${ICON} Skipped 2 songs still locked in Road Trip on \`ZackPlex\`'s list: **X** and **Y**.`
	]);
});

/**
 * X, open, starts joining; removed during the join, it leaves Y, locked, to a run of its own, which
 * ends playback without joining, so nothing cancels X's join as a newer run's join would.
 */
async function endWhileJoining(ctx) {
	const join = holdNextJoin(ctx.bot);
	ctx.bot.playSong(ctx.message);
	await until(() => join.land, "X's join");
	removesong.command.process(ctx.bot, null, ctx.message, '1');
	play(ctx.bot, ctx.message, plex('Y'));
	await settle();
	assert.strictEqual(ctx.finished.length, 1, 'the skip of Y ended playback');
	return join;
}

test('a join still under way when the skips end playback is let go as it lands', async () => {
	const ctx = setup([plex('X')], { locked: { Y: ROAD } });
	const { bot, message, finished } = ctx;
	const join = await endWhileJoining(ctx);

	const landed = join.land();
	await settle();
	assert.strictEqual(landed.state.status, VoiceConnectionStatus.Destroyed);
	assert.strictEqual(bot.conn, null);
	assert.strictEqual(bot.musicBusy(), false, 'nothing keeps /book play out of voice');
	assert.deepStrictEqual(ctx.fetches, []);
	assert.strictEqual(finished.length, 1);
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [oneRoad('Y')]);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);

	play(bot, message, plex('Z'));
	await until(() => ctx.fetches.length === 1, 'the download of Z');
	assert.deepStrictEqual(titles(ctx), ['Z']);
	assert.strictEqual(ctx.joins(), 1, 'Z joins afresh');
});

test('a join let go as it lands is no failed join, even when the voice library will not destroy it', async () => {
	const ctx = setup([plex('X')], { locked: { Y: ROAD } });
	const join = await endWhileJoining(ctx);

	const stubborn = connection();
	stubborn.destroy = () => { throw new Error('Cannot destroy VoiceConnection - it has already been destroyed'); };
	join.land(stubborn);
	await settle();
	assert.doesNotMatch(ctx.said().join('\n'), /couldn't get into the voice channel/i);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
	assert.strictEqual(ctx.bot.conn, null);
	assert.strictEqual(ctx.bot.isPlaying, false);
});

test('a run overtaken in the tick its join returns leaves the connection the bot holds to the newer run', async () => {
	// joinVoiceChannel hands every run the guild's live connection, so both runs here get the one A
	// plays through.
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message } = ctx;
	await playNext(ctx);
	const conn = bot.conn;
	bot.songQueue.unshift(plex('S1'));
	bot.playSong(message);
	bot.songQueue.unshift(plex('S2'));
	bot.playSong(message);
	await until(() => ctx.fetches.length === 2, "the newer run's download");

	assert.deepStrictEqual(titles(ctx), ['A', 'S2'], 'the overtaken run stands down');
	assert.strictEqual(bot.conn, conn);
	assert.strictEqual(conn.state.status, VoiceConnectionStatus.Ready, 'and leaves the connection alone');
	ctx.fetches[1].arrive();
	await until(() => players.length === 2, 'a player for S2');
	assert.strictEqual(conn.subscribed, players[1]);
});

test('a song replayed by a !seek or a !loop is never offered to the check', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, locked } = ctx;
	await playNext(ctx);
	locked.A = ROAD;

	await seekCmd.command.process(bot, null, message, '1:00');
	await playNext(ctx);
	loop.command.process(bot, null, message, '');
	players[1].go(AudioPlayerStatus.Idle);
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'A', 'A']);
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['A'], 'only before its first play');
	assert.deepStrictEqual(ctx.lines(), []);
});

test('a !loop set on a locked song waiting at the head of the queue does not get it past the check', async () => {
	// A queue waiting with nothing playing, as after a failed join, with L at its head.
	const ctx = setup([plex('L'), plex('C')], { locked: { L: ROAD } });
	const { bot, message } = ctx;
	loop.command.process(bot, null, message, '');
	assert.strictEqual(bot.songQueue[0].replay, true);

	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['C']);
	assert.deepStrictEqual(ctx.asked.map((a) => a.title), ['L', 'C']);
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [oneRoad('L')]);
});

test('a secret clip is never offered to the check, and plays', async () => {
	const clip = { title: 'Commercial Break', artist: 'Plex Media', key: '/library/parts/77/1/file.mp3', secret: true };
	const ctx = setup([clip], { locked: { 'Commercial Break': ROAD } });
	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['Commercial Break']);
	assert.deepStrictEqual(ctx.asked, []);
});

test('with nobody there to hear it, a deafened listener being nobody, nothing is asked and the song plays', async () => {
	const ctx = setup([plex('B')], { locked: { B: ROAD }, voiceStates: [['u1', { channelId: 'c1', selfDeaf: true }], ['u2', { channelId: 'c2' }]] });
	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['B']);
	assert.deepStrictEqual(ctx.asked, []);
});

test('a voice cache that cannot be read counts as nobody there, and the song plays', async () => {
	const ctx = setup([plex('B')], { locked: { B: ROAD } });
	const broken = { [Symbol.iterator]() { throw new Error('the cache broke'); } };
	ctx.bot.client.guilds.cache.get('g1').voiceStates.cache = broken;
	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['B']);
	assert.deepStrictEqual(ctx.asked, []);
	assert.doesNotMatch(ctx.said().join('\n'), /couldn't get into the voice channel/i);
});

/** Every logger.warn line while `fn` runs. */
async function warnings(fn) {
	const lines = [];
	const warn = logger.warn;
	logger.warn = (...args) => { lines.push(args.map(String).join(' ')); };
	try {
		await fn();
	} finally {
		logger.warn = warn;
	}
	return lines;
}

test('a check that throws lets the song play, with a warning', async () => {
	const ctx = setup([plex('A')]);
	ctx.bot.autoskip = () => { throw new Error('the check broke'); };
	const warned = await warnings(() => playNext(ctx));
	assert.deepStrictEqual(titles(ctx), ['A']);
	assert.deepStrictEqual(ctx.lines(), []);
	assert.strictEqual(warned.length, 1);
	assert.match(warned[0], /the check broke/);
});

test('without the game nothing is asked, and nothing is said about it', async () => {
	assert.strictEqual(new Bot({}).autoskip, null, 'a Bot starts with no check');
	const ctx = setup([plex('B')], { locked: { B: ROAD } });
	ctx.bot.autoskip = null;
	const warned = await warnings(() => playNext(ctx));
	assert.deepStrictEqual(titles(ctx), ['B']);
	assert.deepStrictEqual(warned, []);
});

test('a check that answers only yes still skips, and the line names no slot or playlist', async () => {
	const ctx = setup([plex('B'), plex('C')]);
	ctx.bot.autoskip = (entry) => entry.title === 'B';
	await playNext(ctx);
	assert.deepStrictEqual(titles(ctx), ['C']);
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [`${ICON} Skipped 1 locked song: **B**.`]);
	const events = commandLog.readEventLog({ kind: 'track-locked' });
	assert.deepStrictEqual(events.map((e) => [e.count, e.songs]), [[1, 'Engelwood - B']]);
});

test('a queue that ends in locked songs still sums up the songs Plex could not send', async () => {
	const ctx = setup([plex('U1'), plex('U2'), plex('U3'), plex('U4'), plex('L')], { locked: { L: ROAD } });
	const { bot, message, finished } = ctx;
	bot.openPlexStream = async (track) => {
		bot.noteUnplayable(track, 404, message);
		return null;
	};
	bot.playSong(message);
	await settle();

	assert.strictEqual(finished.length, 1);
	const text = ctx.said().join('\n');
	assert.ok(text.includes(oneRoad('L')), text);
	assert.match(text, /4 tracks could not be fetched from Plex \(404\)/);
});

test('a queue locked to its end ends cleanly when playback has no channel to talk in', async () => {
	const ctx = setup([plex('B')], { locked: { B: ROAD } });
	delete ctx.message.channel;
	ctx.bot.playSong(ctx.message);
	await settle();
	assert.strictEqual(ctx.finished.length, 1);
	assert.strictEqual(ctx.bot.isPlaying, false);
	assert.strictEqual(commandLog.readEventLog({ kind: 'playback-failed' }).length, 0);
});

test('3,000 locked songs in a row are one loop, not a run each', async () => {
	const queue = [plex('A')];
	const locked = {};
	for (let i = 0; i < 3000; i++) {
		queue.push(plex(`L${i}`));
		locked[`L${i}`] = ROAD;
	}
	queue.push(plex('Z'));
	const ctx = setup(queue, { locked });
	let runs = 0;
	ctx.bot.on('will play', () => { runs += 1; });

	(await playNext(ctx)).go(AudioPlayerStatus.Idle);
	await playNext(ctx);

	assert.deepStrictEqual(titles(ctx), ['A', 'Z']);
	assert.strictEqual(runs, 2, 'one run for A and one for Z');
	assert.deepStrictEqual(ctx.lines().map((x) => x.content), [
		`${ICON} Skipped 3000 songs still locked in Road Trip on \`ZackPlex\`'s list: **L0**, **L1**, **L2** and 2997 more.`
	]);
	// One write for the stretch: a write a song held the bot up for 0.5 to 1 s over 600 songs.
	const events = commandLog.readEventLog({ kind: 'track-locked' });
	assert.deepStrictEqual(events.map((e) => e.count), [3000]);
	assert.ok(events[0].songs.startsWith('Engelwood - L0; Engelwood - L1; Engelwood - L2;'), events[0].songs);
	const stretches = new Set(ctx.asked.slice(1).map((a) => a.stretch));
	assert.strictEqual(stretches.size, 1, 'and one object for the game to read once');
});
