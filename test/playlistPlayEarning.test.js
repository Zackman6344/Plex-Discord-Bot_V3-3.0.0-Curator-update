'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PLEXBOT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plexbot-earning-log-'));

const gamePath = require.resolve('../helpers/apMediaGame.js');
const fake = { answer: null, users: [], seen: [] };
require.cache[gamePath] = {
	id: gamePath,
	filename: gamePath,
	loaded: true,
	exports: {
		earningFilter(userId) {
			fake.users.push(userId);
			return fake.answer;
		},
	},
};

const play = require('../commands/playlist.js/play.js');
const { buildQueryString } = require('../helpers/slashRegistry.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexbot-earning-playlists-'));
const KEYS = [1, 2, 3, 4].map(id => '/library/parts/' + (100 + id) + '/1/file.mp3');
fs.writeFileSync(path.join(dir, 'mix.playlist'), JSON.stringify({
	musiques: KEYS.map((cle, i) => ({ artiste: 'Artist ' + (i + 1), titre: 'Song ' + (i + 1), cle })),
}));

const PLAY = String.fromCodePoint(0x25b6, 0xfe0f);
const FLAG_LINE = 'Use `-r` to shuffle and `-e` for only the songs that still earn on your Plex Media list.';

function earning(keep, slots) {
	fake.seen = [];
	fake.answer = {
		ok: true,
		slots,
		earns(entry) {
			fake.seen.push(entry.key);
			return keep.includes(entry.key);
		},
	};
}

async function run(args, { isPlaying = false, replyFails = false } = {}) {
	fake.users = [];
	const bot = {
		config: { playlistsDir: dir + path.sep },
		language: {
			ERROR_NOT_ENOUGHT_ARG: 'not enough',
			ERROR_TOO_MANY_ARGS: 'too many',
			PLAYLIST_UNKNOW: 'unknown playlist',
			OPEN_PLAYLIST_ERROR: 'open error',
			PLAYLIST_PLAY_SUCCES: 'playlist queued',
			PLAYLIST_PLAY_R_ERROR: 'r error',
		},
		songQueue: [],
		isPlaying,
		plays: 0,
		playSong() { bot.plays++; },
	};
	const message = { author: { id: 'user-1' }, replies: [] };
	message.reply = async text => {
		message.replies.push(text);
		if (replyFails) throw new Error('Unknown Message');
	};
	await play.command.process(bot, null, message, args);
	for (let i = 0; i < 400 && message.replies.length === 0 && bot.plays === 0; i++) {
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	await new Promise(resolve => setTimeout(resolve, 5));
	return { bot, message };
}

function withRandom(value, fn) {
	const real = Math.random;
	Math.random = () => value;
	return fn().finally(() => { Math.random = real; });
}

test('-e queues only the songs earns() passes, in file order, and plays once', async () => {
	earning([KEYS[0], KEYS[2]], ['Zack']);
	const { bot, message } = await run(['mix', '-e']);
	assert.deepStrictEqual(fake.users, ['user-1']);
	assert.deepStrictEqual(bot.songQueue.map(s => s.key), [KEYS[0], KEYS[2]]);
	assert.deepStrictEqual(bot.songQueue[0], { artist: 'Artist 1', title: 'Song 1', playlist: 'mix', key: KEYS[0] });
	assert.deepStrictEqual(message.replies, [PLAY + ' Queued 2 of 4 songs from `mix`: the ones that still earn on `Zack`\'s list.']);
	assert.strictEqual(bot.plays, 1);
});

test('-e while the bot plays appends and replies without a second playSong', async () => {
	earning([KEYS[1]], ['Zack']);
	const { bot, message } = await run(['mix', '-e'], { isPlaying: true });
	assert.deepStrictEqual(bot.songQueue.map(s => s.key), [KEYS[1]]);
	assert.strictEqual(message.replies.length, 1);
	assert.strictEqual(bot.plays, 0);
});

// The bug: playSong waited on the queued line, so a reply that failed (its message deleted, or the
// send given up) left the kept songs queued with nothing playing.
test('-e still starts playback when the queued line cannot be sent, and logs the failure', async () => {
	const logger = require('../helpers/logger.js');
	const real = logger.warn;
	const warned = [];
	logger.warn = (...args) => { warned.push(args.join(' ')); };
	try {
		earning([KEYS[0], KEYS[2]], ['Zack']);
		const { bot, message } = await run(['mix', '-e'], { replyFails: true });
		assert.deepStrictEqual(bot.songQueue.map(s => s.key), [KEYS[0], KEYS[2]]);
		assert.strictEqual(message.replies.length, 1);
		assert.strictEqual(bot.plays, 1);
		assert.deepStrictEqual(warned, ['/playlist play could not send the queued line: Unknown Message']);
		warned.length = 0;
		earning([KEYS[1]], ['Zack']);
		const playing = await run(['mix', '-e'], { isPlaying: true, replyFails: true });
		assert.deepStrictEqual(playing.bot.songQueue.map(s => s.key), [KEYS[1]]);
		assert.strictEqual(playing.bot.plays, 0);
		assert.strictEqual(warned.length, 1);
	} finally {
		logger.warn = real;
	}
});

test('two slots read "the lists of" and a backtick in a name turns into a quote', async () => {
	earning([KEYS[3]], ['Zack', 'Ka`te']);
	const { message } = await run(['mix', '-e']);
	assert.deepStrictEqual(message.replies, [PLAY + ' Queued 1 of 4 songs from `mix`: the ones that still earn on the lists of `Zack` and `Ka\'te`.']);
});

test('-r -e and -e -r shuffle the kept songs only, after the filter saw file order', async () => {
	for (const args of [['mix', '-r', '-e'], ['mix', '-e', '-r']]) {
		earning([KEYS[0], KEYS[2]], ['Zack']);
		const { bot } = await withRandom(0, () => run(args));
		assert.deepStrictEqual(fake.seen, KEYS);
		assert.deepStrictEqual(bot.songQueue.map(s => s.key), [KEYS[2], KEYS[0]], args.join(' '));
	}
});

test('the slash query for earning and shuffle is play mix -r -e', () => {
	const sub = {
		name: 'play',
		options: [
			{ name: 'name', type: 'STRING' },
			{ name: 'shuffle', type: 'BOOLEAN', flag: '-r' },
			{ name: 'earning', type: 'BOOLEAN', flag: '-e' },
		],
	};
	const values = { name: 'mix', shuffle: true, earning: true };
	const interaction = {
		options: {
			getSubcommand: () => 'play',
			get: name => (name in values ? { value: values[name] } : null),
		},
	};
	assert.strictEqual(buildQueryString(interaction, { subcommands: [sub] }), 'play mix -r -e');
});

test('the playlist command declares the earning option with the -e flag', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'playlist.js', 'index.js'), 'utf8');
	assert.match(source, /\{ name: 'earning', type: 'BOOLEAN', description: 'Only the songs that still earn on your Plex Media list', required: false, flag: '-e' \}/);
	assert.match(source, /playlist play \[name\] \[-r\] \[-e\]\\`: Play your custom playlist \(\\`-r\\` to shuffle, \\`-e\\` for only the songs that still earn on your Plex Media list\)\./);
});

test('an unknown or repeated flag replies the flag line and queues nothing', async () => {
	for (const args of [['mix', '-x'], ['mix', '-r', '-r'], ['mix', '-e', '-e']]) {
		earning(KEYS, ['Zack']);
		const { bot, message } = await run(args);
		assert.deepStrictEqual(message.replies, [FLAG_LINE], args.join(' '));
		assert.strictEqual(bot.songQueue.length, 0);
		assert.strictEqual(bot.plays, 0);
	}
	const { message } = await run(['mix', '-r', '-e', '-x']);
	assert.deepStrictEqual(message.replies, ['too many']);
});

test('nothing earning replies the nothing line and queues nothing', async () => {
	earning([], ['Zack']);
	const { bot, message } = await run(['mix', '-e']);
	assert.deepStrictEqual(message.replies, ['Nothing in `mix` still earns on `Zack`\'s list, so nothing was queued.']);
	assert.strictEqual(bot.songQueue.length, 0);
	assert.strictEqual(bot.plays, 0);
});

test('each refusal reason replies its line and queues nothing', async () => {
	const cases = [
		[{ ok: false, reason: 'off', slots: [] }, 'Plex Media is turned off, so nothing earns: play the playlist without `-e` (`earning`).'],
		[{ ok: false, reason: 'none', slots: [] }, 'No Plex Media slot is linked to you, so nothing in `mix` earns for you: play it without `-e` (`earning`).'],
		[{ ok: false, reason: 'unknown', slots: ['Zack'] }, '`Zack` has not reported its items yet, so what still earns is not known: try again once it is connected.'],
		[{ ok: false, reason: 'unknown', slots: ['Zack', 'Kate'] }, '`Zack` and `Kate` have not reported their items yet, so what still earns is not known: try again once one of them is connected.'],
		[{ ok: false, reason: 'unknown', slots: [] }, 'Your Plex Media slot has not reported its items yet, so what still earns is not known: try again once it is connected.'],
	];
	for (const [answer, line] of cases) {
		fake.answer = answer;
		const { bot, message } = await run(['mix', '-e']);
		assert.deepStrictEqual(message.replies, [line]);
		assert.strictEqual(bot.songQueue.length, 0);
		assert.strictEqual(bot.plays, 0);
	}
});

test('without -e every song queues as before and the game is never asked', async () => {
	fake.answer = null;
	const { bot, message } = await run(['mix']);
	assert.deepStrictEqual(fake.users, []);
	assert.deepStrictEqual(bot.songQueue.map(s => s.key), KEYS);
	assert.deepStrictEqual(message.replies, []);
	assert.strictEqual(bot.plays, 1);
	const playing = await run(['mix', '-r'], { isPlaying: true });
	assert.strictEqual(playing.bot.songQueue.length, 4);
	assert.deepStrictEqual(playing.message.replies, ['playlist queued']);
	assert.strictEqual(playing.bot.plays, 0);
});
