// bot.isPaused, which labels the now-playing Pause/Resume toggle and decides what a click on it runs.
//
// The bugs: !resume unpaused the player but left isPaused true, so every later now-playing post
// offered Resume, and a click on it ran !resume on a playing track. That did nothing, yet still said
// "Here we go again", and the toggle could not pause again until a !seek. runPlayback built each
// track's player without clearing it either, so a Hitster clip started over paused music offered
// Resume as well, and so did a paused track whose stream failed: the player went Idle with the flag
// still set. !pause set it even when pause() refused, which it does for a player still buffering
// and for the previous track's Idle player while the next one loads. It threw when bot.dispatcher
// was null, as it is until the first player is built, while a first run waits for endWorking with
// isPlaying already set.
//
// Same harness as test/playbackRace.test.js: @discordjs/voice is swapped in require.cache before
// app/bot.js destructures it. This FakePlayer also pauses. Like the real one, pause() refuses
// anything but Playing, unpause() anything but Paused, and an unforced stop of a paused player
// waits for unpause() before it goes Idle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-pausestate-' + process.pid);

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
const playbackButtons = require('../helpers/playbackButtons.js');
const pause = require('../commands/pause.js');
const resume = require('../commands/resume.js');

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

	const nowPlaying = () => sent.filter(x => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES);
	const toggleLabel = (post) => post.components[0].components
		.find(b => b.data.custom_id === 'playback:pausetoggle').data.label;
	const labels = () => nowPlaying().map(toggleLabel);
	const posted = (key) => sent.filter(x => x && x.embeds && x.embeds[0].description === bot.language[key]).length;
	const refused = (key) => sent.filter(x => x === bot.language[key] || (x && x.content === bot.language[key])).length;

	// The click goes through the real router, which picks pause or resume from bot.isPaused.
	const click = () => playbackButtons.handle({
		customId: 'playback:pausetoggle',
		async deferReply() {},
		async editReply(x) { sent.push(x); return {}; },
		async followUp(x) { sent.push(x); return {}; },
		channel: message.channel
	}, bot, null, { pause: pause.command, resume: resume.command });

	return { bot, message, fetches, labels, posted, refused, click };
}

/** Play the head of the queue through to Playing. */
async function playFirst(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === 1, 'the first download');
	ctx.fetches[0].arrive();
	await until(() => players.length === 1, 'a player for the first track');
	players[0].go(AudioPlayerStatus.Playing);
}

/** Let the playing track run out and the next one reach Playing. */
async function playNext(ctx) {
	const n = players.length;
	players[n - 1].go(AudioPlayerStatus.Idle);
	await until(() => ctx.fetches.length === n + 1, 'the next download');
	ctx.fetches[n].arrive();
	await until(() => players.length === n + 1, 'a player for the next track');
	players[n].go(AudioPlayerStatus.Playing);
}

test('after a pause and a resume, the toggle pauses again', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, posted, click } = ctx;
	await playFirst(ctx);

	pause.command.process(bot, null, message);
	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(bot.isPaused, false);

	await click();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused, 'the click pauses the playing track');
	assert.strictEqual(bot.isPaused, true);
	assert.strictEqual(posted('RESUME_INFO'), 1, 'only the !resume said it resumed anything');

	await click();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing, 'and the next click resumes it');
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(posted('RESUME_INFO'), 2);
});

test('a second !resume says there is nothing to resume', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, posted, refused } = ctx;
	await playFirst(ctx);

	pause.command.process(bot, null, message);
	resume.command.process(bot, null, message);
	resume.command.process(bot, null, message);

	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(posted('RESUME_INFO'), 1);
	assert.strictEqual(refused('RESUME_FAIL'), 1);
});

test('the track after a pause and a resume offers Pause', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, labels, click } = ctx;
	await playFirst(ctx);

	pause.command.process(bot, null, message);
	resume.command.process(bot, null, message);
	await playNext(ctx);

	assert.strictEqual(labels()[labels().length - 1], 'Pause', "B's controls offer Pause");
	assert.deepStrictEqual(labels().filter(l => l !== 'Pause'), [], 'nothing posted while playing offers Resume');

	await click();
	assert.strictEqual(players[1].state.status, AudioPlayerStatus.Paused, "B's toggle pauses B");
});

test('a Hitster clip started over paused music offers Pause, and its toggle pauses it', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, labels, click } = ctx;
	await playFirst(ctx);
	pause.command.process(bot, null, message);

	// What executeTurn does: no bot.stop(), just a clip at the head and a new run.
	bot.songQueue.unshift(plex('Secret'));
	bot.playSong(message);
	await until(() => fetches.length === 2, 'the download of the clip');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for the clip');
	assert.strictEqual(bot.isPaused, false, "the clip's player starts unpaused");

	players[1].go(AudioPlayerStatus.Playing);
	assert.strictEqual(labels()[labels().length - 1], 'Pause');

	await click();
	assert.strictEqual(players[1].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(bot.isPaused, true);
});

test('a paused track whose stream fails leaves nothing paused', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, labels, refused, click } = ctx;
	await playFirst(ctx);
	pause.command.process(bot, null, message);

	// The real player checks a paused resource every 20 ms, and goes Idle once it is unreadable.
	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the download of B');
	assert.strictEqual(bot.isPaused, false);

	await click();
	assert.strictEqual(refused('RESUME_FAIL'), 0, 'the toggle no longer runs !resume');
	assert.strictEqual(refused('PAUSE_FAIL'), 1, 'and nothing plays yet to pause');

	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].go(AudioPlayerStatus.Playing);
	assert.strictEqual(labels()[labels().length - 1], 'Pause');
});

test('a !resume before anything has played is refused instead of throwing', async () => {
	const { bot, message, posted, refused } = setup([plex('A')]);
	assert.strictEqual(bot.dispatcher, null);

	assert.doesNotThrow(() => resume.command.process(bot, null, message));
	assert.strictEqual(posted('RESUME_INFO'), 0);
	assert.strictEqual(refused('RESUME_FAIL'), 1);
});

test('a pause while the track is still buffering is refused, not recorded', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, fetches, labels, posted, refused } = ctx;
	bot.playSong(message);
	await until(() => fetches.length === 1, 'the download of A');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player for A');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Buffering);

	pause.command.process(bot, null, message);
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(posted('PAUSE_INFO'), 0, 'nothing claims the track is paused');
	assert.strictEqual(refused('PAUSE_FAIL'), 1);

	players[0].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(labels(), ['Pause'], 'the audio that then plays offers Pause');
});

test('a pause between tracks is refused, and the next track offers Pause', async () => {
	const ctx = setup([plex('A'), plex('B')]);
	const { bot, message, fetches, labels, posted, refused } = ctx;
	await playFirst(ctx);
	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the download of B');
	assert.strictEqual(bot.isPlaying, true, 'still playing as far as the commands can tell');

	pause.command.process(bot, null, message);
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(posted('PAUSE_INFO'), 0);
	assert.strictEqual(refused('PAUSE_FAIL'), 1);

	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for B');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(labels(), ['Pause', 'Pause']);
});

test('a pause before any player exists is refused instead of throwing', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, refused } = ctx;
	// A run started during another command's work waits for endWorking, already counted as playing.
	bot.beginWorking();
	bot.playSong(message);
	await settle();
	assert.strictEqual(bot.isPlaying, true);
	assert.strictEqual(bot.dispatcher, null);

	assert.doesNotThrow(() => pause.command.process(bot, null, message));
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(refused('PAUSE_FAIL'), 1);
});

test('a second !pause leaves the track paused and resumable', async () => {
	const ctx = setup([plex('A')]);
	const { bot, message, posted, refused } = ctx;
	await playFirst(ctx);

	pause.command.process(bot, null, message);
	pause.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(bot.isPaused, true, 'the refused second pause() does not mark it unpaused');
	assert.strictEqual(posted('PAUSE_INFO'), 2, 'it is paused, so both say so');
	assert.strictEqual(refused('PAUSE_FAIL'), 0);

	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(posted('RESUME_INFO'), 1);
});
