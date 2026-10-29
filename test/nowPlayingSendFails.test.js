// A now-playing message that cannot be sent logs one warning and leaves playback alone.
//
// The bug: runPlayback's Playing listener sent the '**Playing :**' message with no catch. On
// 2026-10-27 discord.com was unreachable for most of an hour, and 17 'Unhandled promise
// rejection: ConnectTimeoutError' lines in the bot log lined up exactly with music track starts.
//
// Harness: the FakePlayer of test/playbackError.test.js, swapped in require.cache before
// app/bot.js destructures @discordjs/voice.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-nowplaying-' + process.pid);

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

	stop() {
		if (this.state.status === AudioPlayerStatus.Idle) return false;
		setImmediate(() => this.go(AudioPlayerStatus.Idle));
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
	createAudioResource: (input) => ({ input })
});

const Bot = require('../app/bot.js');
const logger = require('../helpers/logger.js');
const commandLog = require('../helpers/commandLog.js');

test.afterEach(() => {
	try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
	commandLog._reset();
});

async function until(cond, what) {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setImmediate(r));
	assert.ok(cond(), `timed out waiting for ${what}`);
}

test('a now-playing send that fails is caught and logged once', async (t) => {
	const warnings = [];
	t.mock.method(logger, 'warn', (...args) => warnings.push(args.join(' ')));
	const rejections = [];
	const onRejection = (reason) => rejections.push(reason);
	process.on('unhandledRejection', onRejection);
	t.after(() => process.off('unhandledRejection', onRejection));

	const bot = new Bot({});
	bot.songQueue.push(
		{ title: 'The Red Planet', artist: 'Vale, Jo', key: '/library/parts/1/1/file.flac' },
		{ title: 'Dust Season', artist: 'Vale, Jo', key: '/library/parts/2/1/file.flac' }
	);
	const fetches = [];
	bot.openPlexStream = (track) => new Promise((resolve) => {
		fetches.push({ track, arrive: () => resolve({ ok: true, status: 200, body: new ReadableStream() }) });
	});
	const conn = {
		state: { status: VoiceConnectionStatus.Ready },
		subscribe() {},
		destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; }
	};
	bot.openConnection = async () => conn;
	let attempts = 0;
	const message = {
		member: { voice: { channel: { id: 'c1', name: 'Music', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } } } },
		channel: {
			async send() {
				attempts++;
				throw Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
			}
		},
		async reply() { return {}; }
	};

	bot.playSong(message);
	await until(() => fetches.length === 1, 'the first download');
	fetches[0].arrive();
	await until(() => players.length === 1, 'a player');
	players[0].go(AudioPlayerStatus.Playing);
	await until(() => warnings.length > 0, 'the warning');
	await new Promise(r => setTimeout(r, 20));

	assert.strictEqual(attempts, 1);
	assert.deepStrictEqual(rejections, []);
	assert.deepStrictEqual(warnings, ['Now-playing message failed: Connect Timeout Error']);

	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'the next track');
	assert.strictEqual(fetches[1].track.title, 'Dust Season', 'the queue moves on as usual');
});
