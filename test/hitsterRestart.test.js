// commands/hitster.js across !restart, through helpers/restartHandoff.js.
//
// The bug: utils.stop() destroyed the client and the Bot a Hitster game was built on, and nothing
// ended the game. It stayed in the channel, which kept the channel and the guild's voice claimed
// and refused a new lobby there. Its turn collector listened on the destroyed client, so no guess
// reached it again. Whatever ran later went out through the old client and failed with "Expected
// token to be set": the turn's reveal, the next turn 3 s after a guess, the first turn or the Plex
// error of a game whose Plex query was still running, and the 10-minute timeout. A clip still
// joining voice at the restart went on to open its turn on the old client. A game whose next turn
// failed that way sat in 'playing' with no turn for good, and only !hitster stop from an admin
// cleared it. Apart from the restart, a !hitster stop while start waited on Plex still dealt the
// first turn when Plex answered.
//
// Harness: the real command run as test/voiceClaims.test.js runs it, with the shared Plex client's
// query answered as in test/pickerExclusion.test.js and Math.random pinned to 0, so the cards and
// every turn's track are known. Each client is an EventEmitter that a real discord.js
// MessageCollector listens on, so a test can see which client a turn hears; its channel records
// what is posted and edited. The Bot is a stub. A Plex query, a turn message and a clip's playSong
// can each be held open, so a restart can land while one is pending. The restart is
// restartHandoff.endAll() followed by deliver() to the new client, as utils.stop() and music.js's
// clientReady run them. data/hitster_stats.json is a fixed path in hitster.js, so it is kept in
// memory. Every test uses its own channel and guild: games are module state.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.PLEXBOT_LOG_DIR = path.join(os.tmpdir(), 'plexbot-test-hitster-restart-' + process.pid);

const { MessageCollector } = require('discord.js');

const ROOT = path.join(__dirname, '..');
const STATS_FILE = path.join(ROOT, 'data', 'hitster_stats.json');
const stats = { text: null, writes: 0 };
const isStats = (p) => typeof p === 'string' && path.resolve(p) === STATS_FILE;
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p, ...rest) => (isStats(p) ? stats.text !== null : realFs.existsSync(p, ...rest));
fs.readFileSync = (p, ...rest) => (isStats(p) ? stats.text : realFs.readFileSync(p, ...rest));
fs.writeFileSync = (p, data, ...rest) => {
	if (!isStats(p)) return realFs.writeFileSync(p, data, ...rest);
	stats.writes++;
	stats.text = String(data);
};
test.after(() => Object.assign(fs, realFs));

const TRACKS = Array.from({ length: 12 }, (_, i) => ({
	title: `Song ${i}`, year: 2000 + i, grandparentTitle: `Artist ${i}`, parentTitle: `Album ${i}`,
	duration: 200000, Media: [{ Part: [{ key: `/p/${i}` }] }]
}));
// The gate is read when a query is made, so a game started after the gate is cleared is not held
// with the one still waiting on it.
const plex = { gate: null };
const { getPlex } = require('../helpers/plexClient.js');
getPlex().query = async (url) => {
	const gate = plex.gate;
	if (gate) await gate.promise;
	if (url === '/library/sections') return { MediaContainer: { Directory: [{ type: 'artist', key: '1' }] } };
	if (url === '/library/sections/1/all?type=10') return { MediaContainer: { Metadata: TRACKS.map((t) => ({ ...t })) } };
	throw new Error('unexpected Plex query ' + url);
};

const logger = require('../helpers/logger.js');
const restartHandoff = require('../helpers/restartHandoff.js');
const channelClaims = require('../helpers/channelClaims.js');
const voiceClaims = require('../helpers/voiceClaims.js');
const hitster = require('../commands/hitster.js');

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HITSTER = { owner: 'hitster', label: 'a Hitster game' };
const TOKEN_ERROR = 'Expected token to be set for this request, but none was present';

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const text = (x) => (typeof x === 'string' ? x : x.content);

function fakeClient(channelId, guild) {
	const client = new EventEmitter();
	// The two Client methods MessageCollector calls besides on/removeListener.
	client.incrementMaxListeners = () => {};
	client.decrementMaxListeners = () => {};
	client.users = { cache: new Map([['host', { username: 'Host' }], ['p2', { username: 'P2' }]]) };
	const channel = {
		id: channelId, client, guild, sent: [], edits: [], collectors: [], holdTurnMessage: null,
		async send(payload) {
			channel.sent.push(payload);
			if (channel.holdTurnMessage && /'s turn!/.test(text(payload))) await channel.holdTurnMessage.promise;
			return { edit: async (x) => void channel.edits.push(x), react: async () => {} };
		},
		createMessageCollector(options) {
			const { time, ...rest } = options;
			const collector = new MessageCollector(channel, rest);
			// discord.js arms `time` on the node:timers functions it captured at load, out of reach
			// of mocked timers, so the harness arms it on the test's clock the same way.
			const timer = setTimeout(() => collector.stop('time'), time);
			if (timer && timer.unref) timer.unref();
			collector.once('end', () => clearTimeout(timer));
			channel.collectors.push({ collector, time });
			return collector;
		}
	};
	client.channel = channel;
	client.channels = {
		async fetch(id) {
			if (id !== channelId) throw new Error('Unknown Channel');
			return channel;
		}
	};
	return client;
}

function world(tag) {
	const guild = { id: `g-${tag}` };
	const channelId = `tc-${tag}`;
	return {
		channelId,
		guildId: guild.id,
		guild,
		voiceChannel: { id: `vc-${tag}`, name: 'Lounge', guild, members: new Map([['host', {}], ['p2', {}]]) },
		old: fakeClient(channelId, guild),
		fresh: fakeClient(channelId, guild)
	};
}

function fakeBot() {
	const bot = {
		songQueue: [], isPlaying: false, plays: 0, hold: null,
		async playSong() {
			bot.plays++;
			if (bot.hold) await bot.hold.promise;
			bot.isPlaying = true;
		},
		stop() {
			bot.isPlaying = false;
		}
	};
	return bot;
}

function play(w, client, bot, userId, query) {
	const message = {
		author: { id: userId },
		guild: w.guild,
		member: { voice: { channel: w.voiceChannel }, permissions: { has: () => false } },
		channel: client.channel,
		async reply(x) {
			client.channel.sent.push(x);
			return {};
		}
	};
	return hitster.command.process(bot, client, message, query);
}

let seq = 0;
function say(w, client, userId, content) {
	client.emit('messageCreate', {
		id: `m${++seq}`, channelId: w.channelId, author: { id: userId }, content,
		react: async () => {},
		async reply(x) {
			client.channel.sent.push(x);
			return {};
		}
	});
}

async function openLobby(w, client, bot, { players = ['p2'], locals = [], goal } = {}) {
	await play(w, client, bot, 'host', '');
	for (const id of players) await play(w, client, bot, id, 'join');
	for (const name of locals) await play(w, client, bot, 'host', `add ${name}`);
	if (goal) await play(w, client, bot, 'host', `set goal ${goal}`);
}

async function startGame(w, client, bot, options) {
	await openLobby(w, client, bot, options);
	await play(w, client, bot, 'host', 'start');
	await settle();
}

function restart(w, bot) {
	const before = {
		sent: w.old.channel.sent.length,
		edits: w.old.channel.edits.length,
		collectors: w.old.channel.collectors.length,
		queued: bot.songQueue.length,
		plays: bot.plays,
		writes: stats.writes
	};
	restartHandoff.endAll();
	assert.strictEqual(channelClaims.isClaimed(w.channelId), false, 'the channel is released at the restart');
	assert.strictEqual(voiceClaims.holder(w.guildId), null, 'the guild\'s voice is released at the restart');
	return before;
}

async function runOutTheClock(t) {
	for (let i = 0; i < 3; i++) {
		t.mock.timers.tick(TURN_TIMEOUT_MS + 60000);
		await settle();
	}
}

function assertOldClientQuiet(w, bot, before) {
	assert.deepStrictEqual(w.old.channel.sent.slice(before.sent).map(text), [], 'nothing more went out through the old client');
	assert.strictEqual(w.old.channel.edits.length, before.edits, 'no turn message was edited through the old client');
	assert.strictEqual(w.old.channel.collectors.length, before.collectors, 'no turn opened on the old client');
	assert.strictEqual(w.old.listenerCount('messageCreate'), 0, 'nothing listens on the old client');
	assert.strictEqual(bot.songQueue.length, before.queued, 'no clip was queued on the old Bot');
	assert.strictEqual(bot.plays, before.plays, 'the old Bot played nothing more');
	assert.strictEqual(stats.writes, before.writes, 'the restart wrote no stats');
}

async function deliverOneNotice(w) {
	await restartHandoff.deliver(w.fresh);
	assert.strictEqual(w.fresh.channel.sent.length, 1, 'one notice for the channel, through the new client');
	const notice = w.fresh.channel.sent[0];
	assert.deepStrictEqual(notice.allowedMentions, { parse: [] }, 'the notice pings nobody');

	restartHandoff.endAll();
	await restartHandoff.deliver(w.fresh);
	assert.strictEqual(w.fresh.channel.sent.length, 1, 'a second restart posts nothing more');
	return notice.content;
}

async function assertNothingTracked(w) {
	restartHandoff.endAll();
	await restartHandoff.deliver(w.fresh);
	assert.deepStrictEqual(w.fresh.channel.sent, [], 'a later restart has nothing of this game to end');
}

// So a test that fails part-way leaves no game or notice to the next one.
const drain = { channels: { fetch: async () => ({ send: async () => {} }) } };
test.afterEach(async () => {
	plex.gate = null;
	stats.text = null;
	restartHandoff.endAll();
	await restartHandoff.deliver(drain);
});

test('a lobby open at a restart closes, and the new client says the lobby closed', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const w = world('lobby');
	const bot = fakeBot();
	await openLobby(w, w.old, bot);
	assert.strictEqual(channelClaims.isClaimed(w.channelId), true);

	const before = restart(w, bot);
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster lobby closed/);
	assert.doesNotMatch(notice, /game ended/);
});

test('a turn open at a restart ends, and the new client reveals its track and the standings with the bonus', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('turn');
	const bot = fakeBot();
	await startGame(w, w.old, bot, { locals: ['Lisa'] });
	assert.deepStrictEqual(voiceClaims.holder(w.guildId), HITSTER);
	assert.strictEqual(w.old.channel.collectors.length, 1, 'the first turn is open');
	assert.strictEqual(bot.songQueue[0].key, '/p/3');

	say(w, w.old, 'p2', '!bonus artist Artist 3');
	await settle();
	assert.strictEqual(w.old.channel.edits.length, 1, 'the bonus revealed the artist');

	const before = restart(w, bot);
	assert.strictEqual(bot.isPlaying, false, 'the turn stopped its clip');
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster game ended/);
	assert.ok(notice.includes('The track was 📅 **2003** - *Song 3* by Artist 3.'), notice);
	assert.ok(notice.includes('<@host>: 1 on the timeline, 0 bonus pts'), notice);
	assert.ok(notice.includes('<@p2>: 1 on the timeline, 1 bonus pts'), notice);
	assert.ok(notice.includes('**Lisa**: 1 on the timeline, 0 bonus pts'), notice);
});

test('a restart in the 3 s before the next turn keeps that turn from starting', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('gap');
	const bot = fakeBot();
	await startGame(w, w.old, bot);
	say(w, w.old, 'host', '2');
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /Turn Over!/);

	const before = restart(w, bot);
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster game ended/);
	assert.doesNotMatch(notice, /The track was/, 'no turn was open');
	assert.ok(notice.includes('<@host>: 2 on the timeline, 0 bonus pts'), notice);
	assert.ok(notice.includes('<@p2>: 1 on the timeline, 0 bonus pts'), notice);
});

test('a restart while the game waits on Plex ends it before a card is dealt', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const w = world('plex');
	const bot = fakeBot();
	await openLobby(w, w.old, bot);
	plex.gate = deferred();
	const starting = play(w, w.old, bot, 'host', 'start');
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /Starting!/);
	assert.deepStrictEqual(voiceClaims.holder(w.guildId), HITSTER);

	const before = restart(w, bot);
	plex.gate.resolve();
	await starting;
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster game ended/);
	assert.doesNotMatch(notice, /The track was/);
	assert.doesNotMatch(notice, /Where it stood/, 'no card was dealt');
});

test('a Plex error that arrives after a restart posts nothing through the old client', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const w = world('plex-error');
	const bot = fakeBot();
	await openLobby(w, w.old, bot);
	plex.gate = deferred();
	const starting = play(w, w.old, bot, 'host', 'start');
	await settle();

	const before = restart(w, bot);
	plex.gate.reject(new Error('Plex is unreachable'));
	await starting;
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);
	assert.match(await deliverOneNotice(w), /restarted, so this Hitster game ended/);
});

test('a restart while the turn message is still posting queues no clip', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('posting');
	const bot = fakeBot();
	await openLobby(w, w.old, bot);
	w.old.channel.holdTurnMessage = deferred();
	await play(w, w.old, bot, 'host', 'start');
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /It is <@host>'s turn!/);
	assert.deepStrictEqual(bot.songQueue, []);

	const before = restart(w, bot);
	w.old.channel.holdTurnMessage.resolve();
	await settle();
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster game ended/);
	assert.ok(notice.includes('<@host>: 1 on the timeline, 0 bonus pts'), notice);
});

test('a restart while the clip is still joining voice opens no turn and stops the clip once it starts', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('joining');
	const bot = fakeBot();
	bot.hold = deferred();
	await startGame(w, w.old, bot);
	assert.match(text(w.old.channel.sent.at(-1)), /It is <@host>'s turn!/);
	assert.strictEqual(bot.songQueue[0].key, '/p/2');
	assert.strictEqual(bot.plays, 1);
	assert.deepStrictEqual(voiceClaims.holder(w.guildId), HITSTER);

	const before = restart(w, bot);
	bot.hold.resolve();
	await settle();
	assert.strictEqual(bot.isPlaying, false, 'the clip that landed after the restart was stopped');
	await runOutTheClock(t);
	assertOldClientQuiet(w, bot, before);

	const notice = await deliverOneNotice(w);
	assert.match(notice, /restarted, so this Hitster game ended/);
	assert.doesNotMatch(notice, /The track was/);
	assert.ok(notice.includes('<@p2>: 1 on the timeline, 0 bonus pts'), notice);
});

const PENDING = [
	['mid-turn', async (t, w, bot) => {
		await startGame(w, w.old, bot);
		// So the old turn's timeout comes due before the new game's would.
		t.mock.timers.tick(60000);
		return async () => {};
	}],
	['in the 3 s before its next turn', async (t, w, bot) => {
		await startGame(w, w.old, bot);
		say(w, w.old, 'host', '2');
		await settle();
		return async () => {};
	}],
	['while Plex answers its start', async (t, w, bot) => {
		await openLobby(w, w.old, bot);
		const gate = plex.gate = deferred();
		const starting = play(w, w.old, bot, 'host', 'start');
		await settle();
		plex.gate = null;
		return async () => {
			gate.resolve();
			await starting;
		};
	}],
	['while Plex fails its start', async (t, w, bot) => {
		await openLobby(w, w.old, bot);
		const gate = plex.gate = deferred();
		const starting = play(w, w.old, bot, 'host', 'start');
		await settle();
		plex.gate = null;
		return async () => {
			gate.reject(new Error('Plex is unreachable'));
			await starting;
		};
	}],
	['while its turn message posts', async (t, w, bot) => {
		await openLobby(w, w.old, bot);
		const hold = w.old.channel.holdTurnMessage = deferred();
		await play(w, w.old, bot, 'host', 'start');
		await settle();
		return async () => hold.resolve();
	}],
	['while the old client refuses its turn message', async (t, w, bot) => {
		// A rejection left unhandled fails the test: this pins the catch on start's first turn.
		t.mock.method(logger, 'error', () => {});
		await openLobby(w, w.old, bot);
		const hold = w.old.channel.holdTurnMessage = deferred();
		await play(w, w.old, bot, 'host', 'start');
		await settle();
		return async () => hold.reject(new Error(TOKEN_ERROR));
	}],
	['while its clip joins voice', async (t, w, bot) => {
		bot.hold = deferred();
		await startGame(w, w.old, bot);
		return async () => bot.hold.resolve();
	}]
];

PENDING.forEach(([when, leave], i) => {
	test(`a new game in the same channel is untouched when an old game restarted ${when} catches up`, async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		t.mock.method(Math, 'random', () => 0);
		const w = world(`same-${i}`);
		const oldBot = fakeBot();
		const land = await leave(t, w, oldBot);
		const before = restart(w, oldBot);
		await restartHandoff.deliver(w.fresh);

		const newBot = fakeBot();
		await startGame(w, w.fresh, newBot);
		assert.match(text(w.fresh.channel.sent.at(-1)), /It is <@host>'s turn!/, 'the new game opened its first turn');

		await land();
		await settle();
		// Past every timer the old game armed, short of the new turn's own 10-minute timeout.
		for (let ms = 0; ms < TURN_TIMEOUT_MS - 30000; ms += 30000) {
			t.mock.timers.tick(30000);
			await settle();
		}
		assertOldClientQuiet(w, oldBot, before);
		assert.strictEqual(channelClaims.isClaimed(w.channelId), true, 'the new game still holds the channel');
		assert.deepStrictEqual(voiceClaims.holder(w.guildId), HITSTER, 'the new game still holds voice');

		say(w, w.fresh, 'host', '2');
		await settle();
		assert.match(text(w.fresh.channel.sent.at(-1)), /Turn Over!/);
		t.mock.timers.tick(3000);
		await settle();
		assert.match(text(w.fresh.channel.sent.at(-1)), /It is <@p2>'s turn!/, 'the new game dealt its next turn');
		assert.strictEqual(w.fresh.channel.sent.filter((x) => /restarted/.test(text(x))).length, 1);
	});
});

test('!hitster stop mid-turn ends the game and leaves nothing for a later restart', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('stop');
	const bot = fakeBot();
	await startGame(w, w.old, bot);
	await play(w, w.old, bot, 'host', 'stop');
	assert.match(text(w.old.channel.sent.at(-1)), /Hitster terminated/);
	assert.strictEqual(channelClaims.isClaimed(w.channelId), false);
	assert.strictEqual(voiceClaims.holder(w.guildId), null);
	assert.strictEqual(w.old.listenerCount('messageCreate'), 0, 'the turn stopped listening');
	assert.strictEqual(bot.isPlaying, false);

	const sent = w.old.channel.sent.length;
	await assertNothingTracked(w);
	await runOutTheClock(t);
	assert.strictEqual(w.old.channel.sent.length, sent, 'no next turn and no timeout');
});

test('!hitster stop while the game waits on Plex deals nothing once Plex answers', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const w = world('stop-plex');
	const bot = fakeBot();
	await openLobby(w, w.old, bot);
	plex.gate = deferred();
	const starting = play(w, w.old, bot, 'host', 'start');
	await settle();
	await play(w, w.old, bot, 'host', 'stop');
	assert.match(text(w.old.channel.sent.at(-1)), /Hitster terminated/);
	const sent = w.old.channel.sent.length;

	plex.gate.resolve();
	await starting;
	await settle();
	assert.strictEqual(w.old.channel.sent.length, sent, 'no turn was posted');
	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(channelClaims.isClaimed(w.channelId), false);
	await assertNothingTracked(w);
});

test('a winning guess ends the game, saves the win, and leaves nothing for a later restart', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('win');
	const bot = fakeBot();
	await startGame(w, w.old, bot, { players: [], goal: 2 });
	say(w, w.old, 'host', '2');
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /WE HAVE A WINNER!/);
	assert.strictEqual(JSON.parse(stats.text).host.wins, 1);
	assert.strictEqual(channelClaims.isClaimed(w.channelId), false);
	assert.strictEqual(voiceClaims.holder(w.guildId), null);

	const sent = w.old.channel.sent.length;
	await assertNothingTracked(w);
	await runOutTheClock(t);
	assert.strictEqual(w.old.channel.sent.length, sent, 'no turn after the win');
});

test('a turn nobody answers for 10 minutes ends the game and leaves nothing for a later restart', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('timeout');
	const bot = fakeBot();
	await startGame(w, w.old, bot, { players: [] });
	assert.strictEqual(w.old.channel.collectors[0].time, TURN_TIMEOUT_MS);

	t.mock.timers.tick(TURN_TIMEOUT_MS);
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /Hitster turn timed out/);
	assert.strictEqual(channelClaims.isClaimed(w.channelId), false);
	assert.strictEqual(voiceClaims.holder(w.guildId), null);
	assert.strictEqual(bot.isPlaying, false);

	const sent = w.old.channel.sent.length;
	await assertNothingTracked(w);
	await runOutTheClock(t);
	assert.strictEqual(w.old.channel.sent.length, sent);
});

test('a correct guess reveals the track and deals the next turn 3 s later', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('next');
	const bot = fakeBot();
	await startGame(w, w.old, bot);
	const writes = stats.writes;
	say(w, w.old, 'host', '2');
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /Turn Over![\s\S]*Correct!/);
	assert.strictEqual(stats.writes, writes + 1, 'the streak was saved');

	t.mock.timers.tick(2999);
	await settle();
	assert.strictEqual(w.old.channel.collectors.length, 1, 'the next turn waits the full 3 s');
	t.mock.timers.tick(1);
	await settle();
	assert.match(text(w.old.channel.sent.at(-1)), /It is <@p2>'s turn!/);
	assert.strictEqual(w.old.channel.collectors.length, 2);
	assert.strictEqual(bot.songQueue[0].key, '/p/3');
	assert.strictEqual(channelClaims.isClaimed(w.channelId), true);
});

test('!hitster stop while the clip joins over music leaves the music that resumed alone', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	t.mock.method(Math, 'random', () => 0);
	const w = world('over-music');
	// Like the real Bot: a stop skips the head, and the queue under it plays on.
	const bot = fakeBot();
	bot.stopped = [];
	bot.stop = () => {
		bot.stopped.push(bot.songQueue.shift());
		bot.isPlaying = bot.songQueue.length > 0;
	};
	const music = [{ key: '/m/a', title: 'A' }, { key: '/m/b', title: 'B' }];
	bot.songQueue.push(...music);
	bot.isPlaying = true;
	bot.hold = deferred();
	await startGame(w, w.old, bot);
	const clip = bot.songQueue[0];
	assert.strictEqual(clip.title, 'Secret Track');

	await play(w, w.old, bot, 'host', 'stop');
	bot.hold.resolve();
	await settle();

	assert.deepStrictEqual(bot.stopped, [clip], 'only the clip was stopped');
	assert.deepStrictEqual(bot.songQueue, music);
	assert.strictEqual(w.old.channel.collectors.length, 0, 'no turn opened');
});

test('a lobby opened on a client the restart already stopped is closed at once', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const w = world('late-lobby');
	const bot = fakeBot();
	restartHandoff.endAll(w.old);
	await play(w, w.old, bot, 'host', '');
	await settle();

	assert.strictEqual(channelClaims.isClaimed(w.channelId), false, 'the late lobby is gone');
	const notice = await deliverOneNotice(w);
	assert.match(notice, /lobby closed/);
});
