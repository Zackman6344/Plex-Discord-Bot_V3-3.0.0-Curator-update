// helpers/apMediaTraps.js: the Plex Media traps that act on what the bot plays (world 0.3.0 spec,
// "Voice and book traps").
//
// What is pinned: listening() counts music only for a person in the bot's voice channel, not
// deafened, while it plays, and a book only while that person's own session plays. apply() says
// off, absent or busy before it touches anything, and keeps one effect per guild, none during
// Hitster or a looping head. Each effect and its fallback: Commercial Break splices a secret clip
// after the current track (never in front of it), or pauses 30 s without a usable clip playlist;
// Shuffle Mode; Rewind; Intermission; Slow Motion as a 30 s pause on music and 0.75x on a book.
// A pause is lifted only on the player or session it paused and only while the pause is still the
// trap's: a resume or a !seek under it ends the trap at once, and a pause someone makes under it
// stays when the trap ends. A book speed goes back only while it is still 0.75, through the
// bookmark's speed alone when the session is gone (that book keeps its turn among the listener's
// newest), and after a restart through restore(). Each pause and clip has an id its end notice
// carries; a speed put back says so instead. end() and stop() undo what is still in force.
//
// Harness: the real app/bot.js with @discordjs/voice swapped in require.cache before bot.js
// destructures it, as in test/pauseState.test.js. This FakePlayer pauses like the real one: pause()
// refuses anything but Playing, unpause() anything but Paused, and an unforced stop of a paused
// player waits for unpause(). Its states carry the resource, so the Idle listener reads a
// playbackDuration the test sets. Books run on a fake director with the real one's control rules
// (canControl by the listener's id, state, pausedAt, the pause count, notify), plus three tests on
// a real director, cut down from test/apMediaBooks.test.js, to hold the fake to the engine's real
// behaviour, one of them with someone else in the room pausing the book, which only the real
// controls allow. A speed put back with no session goes to the real bookmarks once, in memory as
// every store is under the test runner. Timers are recorded and fired by hand; the clock does not
// move unless a test moves it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');
const EventEmitter = require('events');
const { Readable } = require('node:stream');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-aptraps-' + process.pid);

const voicePath = require.resolve('@discordjs/voice');
// The real exports: the real book director below plays through them.
const voice = require(voicePath);
const { AudioPlayerStatus, VoiceConnectionStatus } = voice;

const players = [];

class FakePlayer extends EventEmitter {
	constructor() {
		super();
		this.resource = null;
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
		this.state = { status, resource: this.resource };
		this.emit(status, old, this.state);
	}
}

require.cache[voicePath].exports = Object.assign({}, voice, {
	createAudioPlayer: () => new FakePlayer(),
	createAudioResource: (input) => ({ input, playbackDuration: 0, playStream: { readableEnded: false } })
});

const Bot = require('../app/bot.js');
const commandLog = require('../helpers/commandLog.js');
const contracts = require('../helpers/apMediaContracts.js');
const apMediaVoice = require('../helpers/apMediaVoice.js');
const realBookmarks = require('../helpers/bookmarks.js');
const pause = require('../commands/pause.js');
const resume = require('../commands/resume.js');
const seek = require('../commands/seek.js');
const skip = require('../commands/skip.js');
const stop = require('../commands/stop.js');
const loop = require('../commands/loop.js');
const { createBookDirector } = require('../helpers/bookEngine.js');
const { createTrapRunner, VOICE_TRAPS, CLIP_TITLE, CLIP_ARTIST } = require('../helpers/apMediaTraps.js');

const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const TV = String.fromCharCode(0xD83D, 0xDCFA);

test.beforeEach(() => { players.length = 0; });
test.afterEach(() => {
	try { fs.rmSync(commandLog._dir, { recursive: true, force: true }); } catch (_) {}
	commandLog._reset();
});
test.after(() => {
	try { fs.rmSync(process.env.PLEXBOT_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

const plex = (title) => ({ title, artist: 'Engelwood', key: `/library/parts/${title}/1/file.flac` });

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

async function until(cond, what) {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setImmediate(r));
	assert.ok(cond(), `timed out waiting for ${what}`);
}

function fakeTimers() {
	const handles = [];
	return {
		handles,
		setTimeout: (fn, ms) => {
			const h = { fn, ms, cleared: false, fired: false, unrefed: false, unref() { this.unrefed = true; return this; } };
			handles.push(h);
			return h;
		},
		clearTimeout: (h) => { if (h) h.cleared = true; },
		live(ms) {
			return handles.filter((h) => !h.cleared && !h.fired && (ms === undefined || h.ms === ms));
		},
		fire(ms) {
			const due = this.live(ms);
			for (const h of due) {
				h.fired = true;
				h.fn();
			}
			return due.length;
		}
	};
}

function quietLogger(warns) {
	return {
		warn: (...a) => warns.push(a.join(' ')),
		error: (...a) => warns.push(a.join(' ')),
		info() {},
		debug() {}
	};
}

function connection() {
	return {
		state: { status: VoiceConnectionStatus.Ready },
		subscribed: null,
		subscribe(player) { this.subscribed = player; },
		destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; }
	};
}

function hitsterClaims() {
	const claims = { on: false };
	claims.holder = (guildId, { ignore = [] } = {}) => (claims.on && !ignore.includes('hitster') ? { owner: 'hitster', label: 'a Hitster game' } : null);
	return claims;
}

/**
 * A real Bot with `queue` loaded in voice channel c1 of guild g1, where u1 and u2 listen and u3 is in
 * another channel. Plex downloads wait for the test's arrive(); a runner reads this bot.
 */
function musicSetup(queue, { cfg = {}, pms = null, claims = hitsterClaims(), random = () => 0, held = { bot: true } } = {}) {
	const voiceStates = new Map([['u1', { channelId: 'c1' }], ['u2', { channelId: 'c1' }], ['u3', { channelId: 'c2' }]]);
	const guild = { id: 'g1', voiceAdapterCreator: () => ({}), voiceStates: { cache: voiceStates } };
	const bot = new Bot({ user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) } });
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
	const voiceChannel = { id: 'c1', name: 'Music', guild };
	const message = {
		guild,
		member: { voice: { channel: voiceChannel } },
		channel: { async send(x) { sent.push(x); return {}; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const announced = () => sent
		.filter((x) => x && x.embeds && x.content === bot.language.BOT_PLAYSONG_SUCCES)
		.map((x) => x.embeds[0].fields[0].value);

	const timers = fakeTimers();
	const clock = { t: T0 };
	const ended = [];
	const warns = [];
	const settings = { apMediaTraps: true, apMediaVoiceTraps: true, apMediaTrapClips: '', ...cfg };
	const runner = createTrapRunner({
		getBot: () => (held.bot === true ? bot : held.bot),
		getBooks: () => null,
		pms,
		settings: () => settings,
		logger: quietLogger(warns),
		timers,
		now: () => clock.t,
		onEnd: (info) => ended.push(info),
		voiceClaims: claims,
		random
	});
	return { bot, message, fetches, sent, announced, voiceStates, timers, clock, ended, warns, settings, claims, runner };
}

/** Play the first queued track through to Playing. */
async function startPlaying(ctx) {
	ctx.bot.playSong(ctx.message);
	await until(() => ctx.fetches.length === 1, 'the download of the first track');
	ctx.fetches[0].arrive();
	await until(() => players.length === 1, 'its player');
	players[0].go(AudioPlayerStatus.Playing);
}

const titles = (bot) => bot.songQueue.map((t) => t.title);

/** apply()'s answer for an effect that stays in force, once its effect id is checked, without it. */
function inForce(r) {
	assert.ok(Number.isSafeInteger(r.id) && r.id > 0, `a positive integer effect id, not ${r.id}`);
	const rest = { ...r };
	delete rest.id;
	return rest;
}

// ---- the contract -------------------------------------------------------------------------------

test('the voice traps are the five agreed with the game, each a trap the world sends', () => {
	assert.deepStrictEqual(VOICE_TRAPS, ['commercial_break', 'shuffle_mode', 'rewind', 'intermission', 'slow_motion']);
	for (const kind of VOICE_TRAPS) assert.ok(contracts.TRAPS[kind], `${kind} is in contracts.TRAPS`);
	// The game holds checks for these two itself and arms every other trap for this runner.
	const holds = ['buffering', 'rights_expired'];
	assert.deepStrictEqual(VOICE_TRAPS, Object.keys(contracts.TRAPS).filter((kind) => !holds.includes(kind)), 'every other trap the world sends, in its order');
	assert.ok(Object.isFrozen(VOICE_TRAPS));
});

// ---- music: who is listening, and the refusals --------------------------------------------------

test('music counts as listening only in the bot\'s channel, not deafened, while it plays', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, voiceStates, bot, message } = ctx;
	assert.strictEqual(runner.listening('u1'), null, 'nothing plays yet');

	await startPlaying(ctx);
	assert.deepStrictEqual(runner.listening('u1'), { where: 'music', guildId: 'g1', channelId: 'c1' });
	assert.deepStrictEqual(runner.listening('u2'), { where: 'music', guildId: 'g1', channelId: 'c1' });
	assert.strictEqual(runner.listening('u3'), null, 'in another channel');
	assert.strictEqual(runner.listening('u9'), null, 'not in voice');
	assert.strictEqual(runner.listening(''), null);

	voiceStates.set('u2', { channelId: 'c1', selfDeaf: true });
	assert.strictEqual(runner.listening('u2'), null, 'deafened');

	pause.command.process(bot, null, message);
	assert.strictEqual(runner.listening('u1'), null, 'paused music is not playing');
});

test('apply says off, absent or busy before it touches anything', async () => {
	const ctx = musicSetup([plex('A'), plex('B'), plex('C')]);
	const { runner, settings, claims, bot, message } = ctx;
	await startPlaying(ctx);
	const who = { userId: 'u1', slot: 'Zack' };
	const untouched = () => {
		assert.strictEqual(players.length, 1);
		assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
		assert.deepStrictEqual(titles(bot), ['A', 'B', 'C']);
	};

	settings.apMediaTraps = false;
	assert.deepStrictEqual(await runner.apply('intermission', who), { applied: false, reason: 'off' });
	settings.apMediaTraps = true;
	settings.apMediaVoiceTraps = false;
	assert.deepStrictEqual(await runner.apply('rewind', who), { applied: false, reason: 'off' });
	settings.apMediaVoiceTraps = true;

	assert.deepStrictEqual(await runner.apply('shuffle_mode', { userId: 'u3', slot: 'Other' }), { applied: false, reason: 'absent' });

	claims.on = true;
	assert.deepStrictEqual(await runner.apply('intermission', who), { applied: false, reason: 'busy' }, 'Hitster holds the voice');
	claims.on = false;

	loop.command.process(bot, null, message, '');
	assert.deepStrictEqual(await runner.apply('shuffle_mode', who), { applied: false, reason: 'busy' }, 'the head loops');
	loop.command.process(bot, null, message, '');

	await assert.rejects(runner.apply('buffering', who), TypeError, 'Buffering is the game\'s own trap');
	untouched();
	assert.deepStrictEqual(ctx.ended, []);
});

// ---- music: Intermission and the pauses ---------------------------------------------------------

test('Intermission pauses the music for 60 s, then resumes the player it paused', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, timers } = ctx;
	await startPlaying(ctx);

	const r = await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	assert.deepStrictEqual(inForce(r), { applied: true, line: 'the music pauses for 60 seconds, or until someone resumes it', until: T0 + MIN });
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(bot.isPaused, true, 'the now-playing toggle offers Resume');
	assert.deepStrictEqual(await runner.apply('rewind', { userId: 'u2', slot: 'Pal' }), { applied: false, reason: 'absent' }, 'paused music is not playing');

	assert.strictEqual(timers.fire(MIN), 1);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(bot.isPaused, false);
	assert.strictEqual(players.length, 1, 'the same player, not a new one');
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind: 'intermission', where: 'music', line: 'the music plays again', how: 'done' }]);
	assert.ok(timers.handles.every((h) => h.unrefed), 'no trap timer keeps the process up');

	const again = await runner.apply('shuffle_mode', { userId: 'u2', slot: 'Pal' });
	assert.strictEqual(again.applied, true, 'the guild is free once the pause is over');
});

test('anyone may resume an Intermission early, and a pause made after that stays theirs', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, message, timers } = ctx;
	await startPlaying(ctx);
	await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.how, e.line]), [['early', 'someone resumed the music early']]);
	assert.deepStrictEqual(timers.live(), [], 'the 60 s timer is gone with it');

	pause.command.process(bot, null, message);
	timers.fire();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused, 'their own pause is left alone');
	assert.strictEqual(bot.isPaused, true);
});

test('a player replaced under the pause is never resumed, and nor is the new one touched', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, message, fetches, timers } = ctx;
	await startPlaying(ctx);
	await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	// What a Hitster turn does over music: unshift its clip and start it.
	bot.songQueue.unshift(plex('Secret'));
	bot.playSong(message);
	await until(() => fetches.length === 2, 'the download of the clip');
	fetches[1].arrive();
	await until(() => players.length === 2, 'the clip\'s player');
	players[1].go(AudioPlayerStatus.Playing);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);

	timers.fire(MIN);
	assert.strictEqual(players[1].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.strictEqual(bot.isPaused, false);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.how), ['gone']);
});

test('a track skipped or stopped during the pause ends the trap as stopped, without touching the next track', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, message, fetches, timers } = ctx;
	await startPlaying(ctx);
	await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	// Bot.stop() unpauses before it stops, so the trap sees Playing first.
	skip.command.process(bot, null, message, '');
	await until(() => fetches.length === 2, 'the download of B');
	fetches[1].arrive();
	await until(() => players.length === 2, 'B\'s player');
	players[1].go(AudioPlayerStatus.Playing);

	timers.fire();
	assert.strictEqual(players[1].state.status, AudioPlayerStatus.Playing);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.how, e.line]), [['gone', 'the paused track was stopped']], 'ended once');

	await runner.apply('intermission', { userId: 'u2', slot: 'Pal' });
	stop.command.process(bot, null, message);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.how), ['gone', 'gone']);
	assert.deepStrictEqual(timers.live(), []);
});

test('Slow Motion on music is a 30 s pause: the speed of music never changes', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, timers } = ctx;
	await startPlaying(ctx);

	const r = await runner.apply('slow_motion', { userId: 'u2', slot: 'Pal' });
	assert.deepStrictEqual(inForce(r), { applied: true, line: 'music never slows down, so it pauses for 30 seconds', until: T0 + 30 * SEC });
	assert.strictEqual(r.restore, undefined, 'nothing to put back');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	timers.fire(30 * SEC);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(players.length, 1, 'no new resource, so nothing could have been built at another speed');
	assert.deepStrictEqual(titles(bot), ['A', 'B']);
});

test('a !pause under the trap\'s pause is theirs: the trap ends without lifting it, and end() and stop() leave it too', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, message, timers } = ctx;
	await startPlaying(ctx);
	const r = await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	pause.command.process(bot, null, message);
	assert.strictEqual(timers.fire(MIN), 1);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(bot.isPaused, true, 'the toggle still offers Resume');
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind: 'intermission', where: 'music', line: 'someone paused the music, so it stays paused', how: 'paused' }]);
	resume.command.process(bot, null, message);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing, 'their !resume finds it paused');

	await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	pause.command.process(bot, null, message);
	assert.strictEqual(await runner.end('u1'), false, 'a Remote Control finds nothing of the trap\'s left to end');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	resume.command.process(bot, null, message);

	await runner.apply('slow_motion', { userId: 'u2', slot: 'Pal' });
	pause.command.process(bot, null, message);
	runner.stop();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	assert.strictEqual(bot.isPaused, true);
	assert.deepStrictEqual(timers.live(), []);
	await settle();
	assert.strictEqual(ctx.ended.length, 1, 'end() and stop() say nothing');
});

test('a !seek under the trap\'s pause ends it early while that track plays on from the seek; a track gone under it was stopped', async () => {
	const ctx = musicSetup([plex('A'), plex('B'), plex('C')]);
	const { runner, bot, message, fetches, timers } = ctx;
	bot.seekResource = (readstream, ms) => ({ input: readstream, seekMs: ms, playbackDuration: 0, playStream: { readableEnded: false } });
	await startPlaying(ctx);
	const r = await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	await seek.command.process(bot, null, message, '1:30');
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind: 'intermission', where: 'music', line: 'someone resumed the music early', how: 'early' }]);
	assert.deepStrictEqual(timers.live(), [], 'its 60 s timer went with it');
	await until(() => fetches.length === 2, 'A again');
	assert.strictEqual(fetches[1].track.title, 'A');
	fetches[1].arrive();
	await until(() => players.length === 2, 'A\'s new player');
	assert.strictEqual(players[1].resource.seekMs, 90 * SEC, 'from the seek point');
	players[1].go(AudioPlayerStatus.Playing);
	assert.deepStrictEqual(titles(bot), ['A', 'B', 'C']);

	// A loop turned on under the pause plays the same entry again as well, from the start.
	const looped = await runner.apply('intermission', { userId: 'u2', slot: 'Pal' });
	loop.command.process(bot, null, message, '');
	players[1].go(AudioPlayerStatus.Idle);
	await settle();
	assert.deepStrictEqual(ctx.ended.slice(1).map((e) => [e.id, e.how]), [[looped.id, 'early']]);
	loop.command.process(bot, null, message, '');
	await until(() => fetches.length === 3, 'A once more');
	fetches[2].arrive();
	await until(() => players.length === 3, 'A\'s third player');
	players[2].go(AudioPlayerStatus.Playing);

	// A paused track whose stream fails moves the queue on.
	const failed = await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	players[2].go(AudioPlayerStatus.Idle);
	await settle();
	assert.deepStrictEqual(ctx.ended.slice(2).map((e) => [e.id, e.how, e.line]), [[failed.id, 'gone', 'the paused track was stopped']]);
	assert.deepStrictEqual(titles(bot), ['B', 'C']);
});

test('each effect in force has an id of its own, which its end notice carries; one over when it hits has none', async () => {
	const ctx = musicSetup([plex('A'), plex('B'), plex('C')], { random: () => 0.999 });
	const { runner, timers } = ctx;
	await startPlaying(ctx);
	const first = await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	timers.fire(MIN);
	const second = await runner.apply('slow_motion', { userId: 'u2', slot: 'Pal' });
	timers.fire(30 * SEC);
	inForce(first);
	inForce(second);
	assert.notStrictEqual(first.id, second.id);
	assert.deepStrictEqual(await runner.apply('shuffle_mode', { userId: 'u1' }), { applied: true, line: 'the queue is shuffled' });
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.id, e.kind, e.how]), [[first.id, 'intermission', 'done'], [second.id, 'slow_motion', 'done']]);
	assert.ok(ctx.ended.every((e) => !('speed' in e)), 'only a speed put back says speed');
});

// ---- music: Commercial Break --------------------------------------------------------------------

test('Commercial Break without a clip playlist pauses the music for 30 s and says so', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, timers } = ctx;
	await startPlaying(ctx);

	const r = await runner.apply('commercial_break', { userId: 'u1', slot: 'Zack' });
	assert.deepStrictEqual(inForce(r), { applied: true, line: `${TV} Commercial break, the music pauses for 30 seconds`, until: T0 + 30 * SEC });
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
	timers.fire(30 * SEC);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.kind, e.how]), [['commercial_break', 'done']]);
});

/** A PMS whose playlists and items the test lists, counting the reads. */
function fakePms({ lists = [], items = {}, fail = null } = {}) {
	const reads = [];
	return {
		reads,
		async playlists() {
			reads.push('playlists');
			if (fail) throw fail;
			return lists;
		},
		async playlistItems(ratingKey, opts) {
			reads.push(['items', ratingKey, opts]);
			if (fail) throw fail;
			return items[ratingKey] || [];
		}
	};
}

const row = (type, title, seconds, key) => ({ type, title, duration: seconds * 1000, Media: [{ Part: [{ key }] }] });

const CLIPS = {
	901: [
		row('track', 'A whole song', 240, '/library/parts/70/1/song.flac'),
		row('movie', 'A TV spot', 30, '/library/parts/71/1/spot.mkv'),
		row('track', 'Jingle', 45, '/library/parts/72/1/jingle.mp3'),
		{ type: 'track', title: 'No part', duration: 20000, Media: [] }
	]
};

test('Commercial Break splices a clip after the current track, as a secret entry that earns nothing', async () => {
	const pms = fakePms({
		lists: [
			{ title: 'Trap Clips', ratingKey: '901', playlistType: 'audio' },
			{ title: 'trap clips', ratingKey: '902', playlistType: 'video' }
		],
		items: CLIPS
	});
	const ctx = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '  trap CLIPS ' }, pms });
	const { runner, bot, fetches, timers, announced } = ctx;
	const credited = [];
	const detachVoice = apMediaVoice.attach({
		bot,
		// Every track resolves, so only the secret mark can keep the clip from earning.
		resolve: () => ({ durationMs: 60 * SEC }),
		onEvent: (event) => { credited.push(event); },
		getConfig: () => ({}),
		defer: (fn) => fn()
	});
	try {
		await startPlaying(ctx);
		const r = await runner.apply('commercial_break', { userId: 'u1', slot: 'Zack' });
		assert.deepStrictEqual(inForce(r), { applied: true, line: 'a commercial plays after this track' });
		assert.deepStrictEqual(pms.reads, ['playlists', ['items', 901, { limit: 200 }]], 'the audio playlist of that name');

		assert.deepStrictEqual(titles(bot), ['A', CLIP_TITLE, 'B']);
		const clip = bot.songQueue[1];
		assert.deepStrictEqual(clip, { title: CLIP_TITLE, artist: CLIP_ARTIST, key: '/library/parts/72/1/jingle.mp3', secret: true },
			'the one audio track of 3 minutes or less, and nothing that names it');
		assert.strictEqual(players.length, 1, 'A is not interrupted');
		assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
		assert.strictEqual(fetches.length, 1, 'and not fetched again');

		assert.deepStrictEqual(await runner.apply('rewind', { userId: 'u2', slot: 'Pal' }), { applied: false, reason: 'busy' }, 'one effect per guild while the clip waits');
		timers.fire(15 * SEC);
		assert.deepStrictEqual(ctx.ended, [], 'still waiting for its turn');

		players[0].resource.playbackDuration = 60 * SEC;
		players[0].go(AudioPlayerStatus.Idle);
		await until(() => fetches.length === 2, 'the clip\'s download');
		assert.strictEqual(fetches[1].track, clip);
		fetches[1].arrive();
		await until(() => players.length === 2, 'the clip\'s player');
		players[1].go(AudioPlayerStatus.Playing);
		players[1].resource.playbackDuration = 45 * SEC;
		players[1].go(AudioPlayerStatus.Idle);
		await until(() => fetches.length === 3, 'B\'s download');
		assert.strictEqual(fetches[2].track.title, 'B');

		assert.deepStrictEqual(announced(), ['A', CLIP_TITLE]);
		assert.deepStrictEqual(credited.map((e) => [e.type, e.title, e.userIds]), [['complete', 'A', ['u1', 'u2']]], 'the clip earns nothing');

		timers.fire(15 * SEC);
		await settle();
		assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind: 'commercial_break', where: 'music', line: 'the commercial is over', how: 'done' }]);
	} finally {
		detachVoice();
	}
});

test('Commercial Break takes a playlist ratingKey too, and pauses instead when no clip can be had', async () => {
	const byKey = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '901' }, pms: fakePms({ items: CLIPS }) });
	await startPlaying(byKey);
	assert.strictEqual((await byKey.runner.apply('commercial_break', { userId: 'u1' })).line, 'a commercial plays after this track');
	assert.strictEqual(byKey.bot.songQueue[1].secret, true);

	// A setting that names nothing usable is said once; Plex failing is said each time it fails.
	const cases = [
		{ name: 'no such playlist', pms: fakePms({ lists: [{ title: 'Chill', ratingKey: '5' }] }), setting: 'Trap Clips', warn: /no Plex playlist is named "Trap Clips"/, warnings: 1 },
		{ name: 'no short audio track', pms: fakePms({ items: { 903: [CLIPS[901][0], CLIPS[901][1]] } }), setting: '903', warn: /has no audio tracks of 3 minutes or less/, warnings: 1 },
		{ name: 'Plex unreachable', pms: fakePms({ fail: new Error('Plex at host:32400 could not be reached') }), setting: 'Trap Clips', warn: /could not be read/, warnings: 2 }
	];
	for (const c of cases) {
		players.length = 0;
		const ctx = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: c.setting }, pms: c.pms });
		await startPlaying(ctx);
		const r = await ctx.runner.apply('commercial_break', { userId: 'u1' });
		assert.strictEqual(r.line, `${TV} Commercial break, the music pauses for 30 seconds`, c.name);
		assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused, c.name);
		assert.deepStrictEqual(titles(ctx.bot), ['A', 'B'], c.name);
		assert.match(ctx.warns.join('\n'), c.warn, c.name);

		ctx.timers.fire(30 * SEC);
		assert.strictEqual((await ctx.runner.apply('commercial_break', { userId: 'u1' })).applied, true, c.name);
		assert.strictEqual(ctx.warns.length, c.warnings, c.name);
	}
});

test('Commercial Break puts its clip after whatever plays once Plex answers, and gives up on a listener who left', async () => {
	let answer;
	const slow = {
		playlists: async () => [],
		playlistItems: () => new Promise((resolve) => { answer = () => resolve(CLIPS[901]); })
	};
	const ctx = musicSetup([plex('A'), plex('B'), plex('C')], { cfg: { apMediaTrapClips: '901' }, pms: slow });
	const { runner, bot, fetches } = ctx;
	await startPlaying(ctx);

	const pending = runner.apply('commercial_break', { userId: 'u1', slot: 'Zack' });
	assert.deepStrictEqual(await runner.apply('intermission', { userId: 'u2' }), { applied: false, reason: 'busy' }, 'the guild is held while Plex answers');

	players[0].go(AudioPlayerStatus.Idle);
	await until(() => fetches.length === 2, 'B\'s download');
	fetches[1].arrive();
	await until(() => players.length === 2, 'B\'s player');
	players[1].go(AudioPlayerStatus.Playing);

	answer();
	assert.strictEqual((await pending).applied, true);
	assert.deepStrictEqual(titles(bot), ['B', CLIP_TITLE, 'C'], 'after B, which is the current track by then');

	players.length = 0;
	const left = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '901' }, pms: slow });
	await startPlaying(left);
	const gone = left.runner.apply('commercial_break', { userId: 'u1' });
	left.voiceStates.set('u1', { channelId: 'c2' });
	answer();
	assert.deepStrictEqual(await gone, { applied: false, reason: 'absent' });
	assert.deepStrictEqual(titles(left.bot), ['A', 'B']);
	assert.strictEqual((await left.runner.apply('intermission', { userId: 'u2' })).applied, true, 'and the guild is free again');
});

// The game leaves a trap in flight to the runner's answer, so a switch turned off while Plex reads
// the playlist is the runner's to honour.
test('a trap switch turned off while Plex reads the clip playlist calls the Commercial Break off: nothing is queued and the guild is free', async () => {
	for (const name of ['apMediaVoiceTraps', 'apMediaTraps']) {
		players.length = 0;
		let answer;
		const slow = {
			playlists: async () => [],
			playlistItems: () => new Promise((resolve) => { answer = () => resolve(CLIPS[901]); })
		};
		const ctx = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '901' }, pms: slow });
		const { runner, bot, settings, timers } = ctx;
		await startPlaying(ctx);
		const pending = runner.apply('commercial_break', { userId: 'u1', slot: 'Zack' });
		settings[name] = false;
		answer();
		assert.deepStrictEqual(await pending, { applied: false, reason: 'off' }, name);
		assert.deepStrictEqual(titles(bot), ['A', 'B'], name);
		assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing, `${name}: A plays on`);
		assert.deepStrictEqual(timers.live(), [], `${name}: no clip to watch`);
		assert.strictEqual(await runner.end('u1'), false, `${name}: nothing in force`);
		settings[name] = true;
		assert.strictEqual((await runner.apply('intermission', { userId: 'u2', slot: 'Pal' })).applied, true, `${name}: the guild is free for the next trap`);
		await settle();
		assert.deepStrictEqual(ctx.ended, [], name);
	}
});

// ---- music: Shuffle Mode and Rewind -------------------------------------------------------------

test('Shuffle Mode shuffles everything after the current track and always changes the order', async () => {
	// 0.999 at every step is Fisher-Yates' identity, which the trap must not hand back.
	const ctx = musicSetup([plex('A'), plex('B'), plex('C'), plex('D'), plex('E')], { random: () => 0.999 });
	const { runner, bot } = ctx;
	await startPlaying(ctx);
	const queue = bot.songQueue;

	assert.deepStrictEqual(await runner.apply('shuffle_mode', { userId: 'u1', slot: 'Zack' }), { applied: true, line: 'the queue is shuffled' });
	assert.strictEqual(bot.songQueue, queue, 'shuffled in place, as commands/shuffle.js does');
	assert.deepStrictEqual(titles(bot), ['A', 'C', 'B', 'D', 'E']);
	assert.strictEqual(players.length, 1, 'the current track plays on');
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);

	const seq = [0.1, 0.7, 0.3];
	let i = 0;
	players.length = 0;
	const mixed = musicSetup([plex('A'), plex('B'), plex('C'), plex('D'), plex('E')], { random: () => seq[i++ % seq.length] });
	await startPlaying(mixed);
	await mixed.runner.apply('shuffle_mode', { userId: 'u1' });
	assert.strictEqual(mixed.bot.songQueue[0].title, 'A');
	assert.deepStrictEqual(titles(mixed.bot).slice(1).sort(), ['B', 'C', 'D', 'E']);
	assert.notDeepStrictEqual(titles(mixed.bot), ['A', 'B', 'C', 'D', 'E']);
});

test('Rewind starts the current track over from 0, announced once, its partial listen reported', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, fetches, announced } = ctx;
	const heard = [];
	bot.on('track-heard', (h) => heard.push(h));
	let seeked = 0;
	bot.seekResource = (readstream) => { seeked++; return { input: readstream }; };
	await startPlaying(ctx);
	players[0].resource.playbackDuration = 70 * SEC;

	assert.deepStrictEqual(await runner.apply('rewind', { userId: 'u1', slot: 'Zack' }), { applied: true, line: 'this track starts over' });
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Idle);
	assert.deepStrictEqual(heard.map((h) => [h.entry.title, h.heardMs, h.startMs, h.natural]), [['A', 70 * SEC, 0, false]]);

	await until(() => fetches.length === 2, 'A again');
	assert.strictEqual(fetches[1].track.title, 'A');
	fetches[1].arrive();
	await until(() => players.length === 2, 'a player for A');
	players[1].go(AudioPlayerStatus.Playing);
	assert.strictEqual(seeked, 0, 'from the start, not through a seek');
	assert.deepStrictEqual(titles(bot), ['A', 'B']);
	assert.strictEqual(bot.songQueue[0].isSeeking, undefined, 'the seek flag was taken');
	assert.deepStrictEqual(announced(), ['A'], 'not announced a second time');
});

test('a queue too short to shuffle starts the track over; a track that cannot start over pauses instead', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	await startPlaying(ctx);
	assert.deepStrictEqual(await ctx.runner.apply('shuffle_mode', { userId: 'u1' }), { applied: true, line: 'too few tracks to shuffle, so this track starts over' });
	await until(() => ctx.fetches.length === 2, 'A again');
	assert.strictEqual(ctx.fetches[1].track.title, 'A');

	players.length = 0;
	const yt = musicSetup([plex('A'), plex('B')]);
	await startPlaying(yt);
	// A YouTube entry: takeSeek never reads its flag, so a seek-style restart would loop it forever.
	delete yt.bot.songQueue[0].key;
	yt.bot.songQueue[0].url = 'https://www.youtube.com/watch?v=x';
	const r = await yt.runner.apply('rewind', { userId: 'u1' });
	assert.deepStrictEqual(inForce(r), { applied: true, line: 'this track cannot start over, so the music pauses for 30 seconds', until: T0 + 30 * SEC });
	assert.strictEqual(yt.bot.songQueue[0].isSeeking, undefined);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);
});

// ---- music: end() and stop() --------------------------------------------------------------------

test('end() lifts the trap\'s pause or takes its clip off the queue at once, quietly', async () => {
	const ctx = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '901' }, pms: fakePms({ items: CLIPS }) });
	const { runner, bot, timers } = ctx;
	await startPlaying(ctx);
	assert.strictEqual(await runner.end('u1'), false, 'nothing in force');

	await runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	assert.strictEqual(await runner.end('u2'), false, 'not theirs');
	assert.strictEqual(await runner.end('u1'), true);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(bot.isPaused, false);
	assert.deepStrictEqual(timers.live(), []);

	await runner.apply('commercial_break', { userId: 'u1', slot: 'Zack' });
	assert.deepStrictEqual(titles(bot), ['A', CLIP_TITLE, 'B']);
	assert.strictEqual(await runner.end('u1'), true);
	assert.deepStrictEqual(titles(bot), ['A', 'B']);
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing, 'A plays on');

	await settle();
	assert.deepStrictEqual(ctx.ended, [], 'the caller announces a Remote Control itself');
	assert.strictEqual((await runner.apply('rewind', { userId: 'u2' })).applied, true, 'the guild is free');
});

test('a resume early, then end(), finds nothing left in force', async () => {
	const ctx = musicSetup([plex('A'), plex('B')]);
	const { runner, bot, message } = ctx;
	await startPlaying(ctx);
	await runner.apply('intermission', { userId: 'u1' });
	resume.command.process(bot, null, message);
	assert.strictEqual(await runner.end('u1'), false);
});

test('stop() lifts a trap\'s pause, takes an unplayed clip off and drops every timer', async () => {
	const held = { bot: true };
	const ctx = musicSetup([plex('A'), plex('B')], { held });
	await startPlaying(ctx);
	await ctx.runner.apply('intermission', { userId: 'u1' });
	// The game may let go of the Bot before it stops the runner.
	held.bot = null;
	ctx.runner.stop();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Playing);
	assert.strictEqual(ctx.bot.isPaused, false);
	assert.deepStrictEqual(ctx.timers.live(), []);

	players.length = 0;
	const newer = { bot: true };
	const old = musicSetup([plex('A'), plex('B')], { held: newer });
	await startPlaying(old);
	await old.runner.apply('intermission', { userId: 'u1' });
	// !restart built another Bot: the old one's player is not the runner's to resume.
	newer.bot = new Bot({});
	old.runner.stop();
	assert.strictEqual(players[0].state.status, AudioPlayerStatus.Paused);

	players.length = 0;
	const clip = musicSetup([plex('A'), plex('B')], { cfg: { apMediaTrapClips: '901' }, pms: fakePms({ items: CLIPS }) });
	await startPlaying(clip);
	await clip.runner.apply('commercial_break', { userId: 'u1' });
	clip.runner.stop();
	assert.deepStrictEqual(titles(clip.bot), ['A', 'B']);
	assert.deepStrictEqual(clip.timers.live(), []);
	await settle();
	assert.deepStrictEqual([...ctx.ended, ...clip.ended], []);
});

// ---- books on a fake director -------------------------------------------------------------------

/**
 * A director with the real one's control rules: the listener's id passes canControl, a session
 * still joining refuses all but stop, pause and resume move state and pausedAt, every pause asked
 * for is counted (a paused book keeps its pausedAt), and every change notifies before the call
 * returns.
 */
function fakeDirector(clock) {
	const list = [];
	const listeners = new Set();
	const calls = [];
	const notify = (s, kind) => { for (const fn of [...listeners]) fn(s, kind); };
	return {
		list,
		calls,
		listeners,
		sessions: () => list.filter((s) => s.state !== 'ended'),
		sessionById: (id) => list.find((s) => s.id === id && s.state !== 'ended') || null,
		position: (s) => s.pos,
		onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		controlSession(s, member, action, arg) {
			const id = String((member && (member.id || (member.user && member.user.id))) || '');
			calls.push({ session: s.id, by: id, action, arg });
			if (!list.includes(s) || s.state === 'ended') return { ok: false, code: 'no-session' };
			if (id !== s.userId) return { ok: false, code: 'forbidden' };
			if (s.state === 'starting') return { ok: false, code: 'starting' };
			switch (action) {
				case 'pause':
					s.pauseCount = (s.pauseCount || 0) + 1;
					if (s.state === 'paused') return { ok: true, code: 'noop' };
					s.state = 'paused';
					s.pausedAt = clock.t;
					notify(s, 'paused');
					return { ok: true, code: 'ok' };
				case 'resume':
					if (s.state === 'playing') return { ok: true, code: 'noop' };
					s.state = 'playing';
					s.pausedAt = null;
					notify(s, 'moved');
					return { ok: true, code: 'ok' };
				case 'back':
					s.pos = Math.max(0, s.pos - arg * 1000);
					notify(s, 'moved');
					return { ok: true, code: 'ok' };
				case 'speed':
					s.speed = Number(arg);
					notify(s, 'moved');
					return { ok: true, code: 'ok' };
				default:
					return { ok: false, code: 'bad-action' };
			}
		},
		end(s) {
			s.state = 'ended';
			notify(s, 'ended');
		}
	};
}

function bookSetup({ cfg = {}, marks = {}, catalogWorks = { w1: { id: 'w1' }, w2: { id: 'w2' } }, claims = hitsterClaims() } = {}) {
	const clock = { t: T0 };
	const director = fakeDirector(clock);
	const timers = fakeTimers();
	const ended = [];
	const warns = [];
	const recorded = [];
	const settings = { apMediaTraps: true, apMediaVoiceTraps: true, ...cfg };
	// No record(): it would make the book the listener's newest, which a speed put back must not.
	const bookmarks = {
		get: (userId, work) => (marks[`${userId}::${work.id}`] ? { ...marks[`${userId}::${work.id}`] } : null),
		setSpeed(userId, work, speed) {
			recorded.push({ userId, workId: work.id, speed });
			const k = `${userId}::${work.id}`;
			if (!marks[k]) return { persisted: false, healthy: true };
			marks[k] = { ...marks[k], speed };
			return { persisted: true, healthy: true };
		}
	};
	const catalog = { work: (id) => catalogWorks[id] || null };
	const runner = createTrapRunner({
		getBot: () => null,
		getBooks: () => director,
		settings: () => settings,
		logger: quietLogger(warns),
		timers,
		now: () => clock.t,
		onEnd: (info) => ended.push(info),
		voiceClaims: claims,
		bookmarks,
		catalog
	});
	const voiceStates = new Map([['u1', { channelId: 'v1' }], ['u2', { channelId: 'v1' }]]);
	const guild = { id: 'g1', voiceStates: { cache: voiceStates } };
	const session = (extra = {}) => {
		const userId = extra.userId || 'u1';
		const s = {
			id: `s${director.list.length + 1}`,
			guildId: 'g1',
			guild,
			userId,
			member: { id: userId, displayName: 'Reader' },
			workId: 'w1',
			state: 'playing',
			speed: 1,
			pos: 20 * MIN,
			pausedAt: null,
			voiceChannelId: 'v1',
			...extra
		};
		director.list.push(s);
		return s;
	};
	return { clock, director, timers, ended, warns, recorded, marks, settings, runner, voiceStates, session, claims };
}

test('a book counts as listening only while that person\'s own session plays', () => {
	const ctx = bookSetup();
	const { runner, session, director } = ctx;
	assert.strictEqual(runner.listening('u1'), null);
	const s = session();
	assert.deepStrictEqual(runner.listening('u1'), { where: 'book', guildId: 'g1', channelId: 'v1' });
	assert.strictEqual(runner.listening('u2'), null, 'someone else in the room hears another person\'s book');
	s.state = 'paused';
	assert.strictEqual(runner.listening('u1'), null);
	s.state = 'starting';
	assert.strictEqual(runner.listening('u1'), null);
	s.state = 'playing';
	director.end(s);
	assert.strictEqual(runner.listening('u1'), null);
});

test('Commercial Break and Intermission pause the book, as its own listener, then resume it', async () => {
	for (const [kind, ms, line] of [['commercial_break', 30 * SEC, 'the book pauses for 30 seconds'], ['intermission', MIN, 'the book pauses for 60 seconds']]) {
		const ctx = bookSetup();
		const s = ctx.session();
		const r = await ctx.runner.apply(kind, { userId: 'u1', slot: 'Zack' });
		assert.deepStrictEqual(inForce(r), { applied: true, line, until: T0 + ms }, kind);
		assert.strictEqual(s.state, 'paused');
		assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: false, reason: 'absent' }, 'a paused book is not playing');

		assert.strictEqual(ctx.timers.fire(ms), 1);
		assert.strictEqual(s.state, 'playing');
		assert.deepStrictEqual(ctx.director.calls.map((c) => [c.action, c.by]), [['pause', 'u1'], ['resume', 'u1']], 'acting as the listener');
		await settle();
		assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind, where: 'book', line: 'the book plays again', how: 'done' }]);
		assert.strictEqual(ctx.director.listeners.size, 0, 'the change listener goes with the effect');
	}
});

test('a book resumed early ends the trap there and then, and the timer leaves a later pause alone', async () => {
	const ctx = bookSetup();
	const s = ctx.session();
	await ctx.runner.apply('intermission', { userId: 'u1', slot: 'Zack' });

	ctx.clock.t += 10 * SEC;
	ctx.director.controlSession(s, s.member, 'resume');
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.how, e.line]), [['early', 'the book was resumed early']]);
	assert.deepStrictEqual(ctx.timers.live(), []);

	ctx.director.controlSession(s, s.member, 'pause');
	ctx.timers.fire();
	assert.strictEqual(s.state, 'paused', 'their own pause');
	assert.strictEqual((await ctx.runner.apply('rewind', { userId: 'u1' })).reason, 'absent');
});

test('a book whose listener left during the pause stays paused for them, and one stopped is left stopped', async () => {
	const away = bookSetup();
	const s = away.session();
	await away.runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	away.voiceStates.set('u1', { channelId: 'elsewhere' });
	away.timers.fire(MIN);
	assert.strictEqual(s.state, 'paused');
	await settle();
	assert.deepStrictEqual(away.ended.map((e) => [e.how, e.line]), [['away', 'the book stays paused until its listener is back in voice']]);

	const stopped = bookSetup();
	const t = stopped.session();
	await stopped.runner.apply('commercial_break', { userId: 'u1' });
	stopped.director.end(t);
	await settle();
	assert.deepStrictEqual(stopped.ended.map((e) => e.how), ['gone']);
	assert.deepStrictEqual(stopped.timers.live(), []);
	assert.deepStrictEqual(stopped.director.calls.map((c) => c.action), ['pause']);
});

test('a pause asked for under the trap\'s book pause is theirs: the trap ends without resuming it, and end() and stop() leave it too', async () => {
	const ctx = bookSetup();
	const s = ctx.session();
	const r = await ctx.runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	ctx.clock.t += 10 * SEC;
	assert.strictEqual(ctx.director.controlSession(s, s.member, 'pause').code, 'noop', 'already paused, and pausedAt is the trap\'s');

	assert.strictEqual(ctx.timers.fire(MIN), 1);
	assert.strictEqual(s.state, 'paused');
	assert.deepStrictEqual(ctx.director.calls.map((c) => c.action), ['pause', 'pause'], 'never resumed');
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ id: r.id, userId: 'u1', slot: 'Zack', kind: 'intermission', where: 'book', line: 'someone paused the book, so it stays paused', how: 'paused' }]);

	ctx.director.controlSession(s, s.member, 'resume');
	await ctx.runner.apply('commercial_break', { userId: 'u1' });
	ctx.director.controlSession(s, s.member, 'pause');
	assert.strictEqual(await ctx.runner.end('u1'), false, 'a Remote Control finds nothing of the trap\'s left to end');
	assert.strictEqual(s.state, 'paused');

	ctx.director.controlSession(s, s.member, 'resume');
	await ctx.runner.apply('intermission', { userId: 'u1' });
	ctx.director.controlSession(s, s.member, 'pause');
	ctx.runner.stop();
	assert.strictEqual(s.state, 'paused');
	assert.deepStrictEqual(ctx.director.calls.map((c) => c.action).filter((a) => a === 'resume'), ['resume', 'resume'], 'only the listener\'s own resumes');
	await settle();
	assert.strictEqual(ctx.ended.length, 1, 'end() and stop() say nothing');
});

test('Rewind and Shuffle Mode take the book back 5 minutes, or to the start', async () => {
	const cases = [
		['rewind', 20 * MIN, 15 * MIN, 'back 5 minutes'],
		['rewind', 2 * MIN, 0, 'back to the start'],
		['shuffle_mode', 20 * MIN, 15 * MIN, 'a book has nothing to shuffle, so it goes back 5 minutes'],
		['shuffle_mode', 4 * MIN, 0, 'a book has nothing to shuffle, so it goes back to the start']
	];
	for (const [kind, from, to, line] of cases) {
		const ctx = bookSetup();
		const s = ctx.session({ pos: from });
		assert.deepStrictEqual(await ctx.runner.apply(kind, { userId: 'u1' }), { applied: true, line }, `${kind} from ${from}`);
		assert.strictEqual(s.pos, to);
		assert.strictEqual(s.state, 'playing');
		assert.deepStrictEqual(ctx.director.calls, [{ session: s.id, by: 'u1', action: 'back', arg: 300 }]);
		assert.deepStrictEqual(ctx.timers.live(), [], 'nothing left running');
		assert.strictEqual((await ctx.runner.apply('intermission', { userId: 'u1' })).applied, true, 'and the guild is free');
	}
});

test('Slow Motion plays the book at 0.75x for 10 minutes, then puts the speed back', async () => {
	const ctx = bookSetup();
	const s = ctx.session({ speed: 1.25 });
	const r = await ctx.runner.apply('slow_motion', { userId: 'u1', slot: 'Zack' });
	const restore = { kind: 'speed', userId: 'u1', slot: 'Zack', workId: 'w1', previous: 1.25, until: T0 + 10 * MIN };
	assert.deepStrictEqual(r, { applied: true, line: '0.75x for 10 minutes', until: T0 + 10 * MIN, restore });
	assert.strictEqual(s.speed, 0.75);
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: false, reason: 'busy' }, 'one effect per guild');

	ctx.clock.t += 10 * MIN;
	assert.strictEqual(ctx.timers.fire(10 * MIN), 1);
	assert.strictEqual(s.speed, 1.25);
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ userId: 'u1', slot: 'Zack', kind: 'slow_motion', where: 'book', line: 'back to 1.25x', how: 'done', speed: true }]);
	assert.strictEqual((await ctx.runner.apply('rewind', { userId: 'u1' })).applied, true);
	assert.deepStrictEqual(ctx.recorded, [], 'a live session saves its own bookmark');
});

test('Slow Motion leaves a speed the listener chose, and holds the guild only while its session lasts', async () => {
	const ctx = bookSetup();
	const s = ctx.session();
	await ctx.runner.apply('slow_motion', { userId: 'u1', slot: 'Zack' });
	ctx.director.controlSession(s, s.member, 'speed', 1.5);
	ctx.timers.fire(10 * MIN);
	assert.strictEqual(s.speed, 1.5);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.line), ['the speed was changed meanwhile, so it stays at 1.5x']);

	const free = bookSetup();
	const t = free.session();
	await free.runner.apply('slow_motion', { userId: 'u1' });
	free.director.end(t);
	free.session({ userId: 'u2' });
	assert.strictEqual((await free.runner.apply('intermission', { userId: 'u2' })).applied, true, 'u1 left; their restore no longer holds the guild');
	assert.strictEqual(free.timers.live(10 * MIN).length, 1, 'but it still runs');
});

test('Slow Motion whose session has ended puts the bookmark back, unless its speed was changed', async () => {
	const ctx = bookSetup({ marks: { 'u1::w1': { absoluteMs: 33 * MIN, speed: 0.75 } } });
	const s = ctx.session({ speed: 1.1 });
	await ctx.runner.apply('slow_motion', { userId: 'u1', slot: 'Zack' });
	ctx.director.end(s);
	ctx.timers.fire(10 * MIN);
	assert.deepStrictEqual(ctx.recorded, [{ userId: 'u1', workId: 'w1', speed: 1.1 }]);
	assert.deepStrictEqual(ctx.marks['u1::w1'], { absoluteMs: 33 * MIN, speed: 1.1 });
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.line), ['back to 1.1x']);

	const kept = bookSetup({ marks: { 'u1::w1': { absoluteMs: 33 * MIN, speed: 2 } } });
	const t = kept.session();
	await kept.runner.apply('slow_motion', { userId: 'u1' });
	kept.director.end(t);
	kept.timers.fire(10 * MIN);
	assert.deepStrictEqual(kept.recorded, []);
	await settle();
	assert.deepStrictEqual(kept.ended.map((e) => e.line), ['the speed was changed meanwhile, so it stays at 2x']);
});

test('a speed put back through the real bookmarks changes only the speed: the book heard since stays the one /book play resumes', async (t) => {
	// In memory: no PLEXBOT_BOOK_BOOKMARKS_FILE under the test runner.
	t.mock.timers.enable({ apis: ['Date'], now: T0 });
	const part = (n) => ({ ordinal: 1, albumRatingKey: `80${n}`, trackRatingKey: `81${n}`, title: 'Part 1', durationMs: 10 * 60 * MIN, partKey: `/library/parts/81${n}/1/part.mp3`, file: `book${n}.mp3`, sizeBytes: 1000 + n, container: 'mp3' });
	const slowed = { id: 'trap-author/slowed-book', kind: 'book', title: 'Slowed Book', aliases: [], parts: [part(1)] };
	const later = { id: 'trap-author/later-book', kind: 'book', title: 'Later Book', aliases: [], parts: [part(2)] };
	const user = 'u-bookmarks';
	t.after(() => {
		realBookmarks.forget(user, slowed.id);
		realBookmarks.forget(user, later.id);
	});
	realBookmarks.record(user, slowed, { absoluteMs: 60 * MIN, speed: 0.75, addListenedMs: MIN }, { force: true });
	const before = realBookmarks.get(user, slowed);
	t.mock.timers.tick(MIN);
	realBookmarks.record(user, later, { absoluteMs: 10 * MIN, speed: 1 }, { force: true });
	t.mock.timers.tick(MIN);

	const ended = [];
	const runner = createTrapRunner({
		getBot: () => null,
		getBooks: () => ({ sessions: () => [] }),
		settings: () => ({}),
		logger: quietLogger([]),
		timers: fakeTimers(),
		now: () => Date.now(),
		onEnd: (info) => ended.push(info),
		voiceClaims: { holder: () => null },
		bookmarks: realBookmarks,
		catalog: { work: (id) => [slowed, later].find((w) => w.id === id) || null }
	});
	await runner.restore({ userId: user, slot: 'Reader', workId: slowed.id, previous: 1.25, until: Date.now() - SEC });
	assert.deepStrictEqual(realBookmarks.get(user, slowed), { ...before, speed: 1.25 }, 'its place, hint and updatedAt as they were');
	assert.strictEqual(realBookmarks.lastInProgress(user).workId, later.id);
	assert.strictEqual(realBookmarks.lastSpeed(user), 1, 'the default of the next new book is the one heard last');
	await settle();
	assert.deepStrictEqual(ended.map((e) => [e.line, e.how, e.speed]), [['back to 1.25x', 'overdue', true]]);
});

test('Slow Motion on a book already at 0.75x pauses it for 30 s instead', async () => {
	const ctx = bookSetup();
	const s = ctx.session({ speed: 0.75 });
	const r = await ctx.runner.apply('slow_motion', { userId: 'u1' });
	assert.deepStrictEqual(inForce(r), { applied: true, line: 'already at 0.75x, so the book pauses for 30 seconds', until: T0 + 30 * SEC });
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(s.speed, 0.75);
	ctx.timers.fire(30 * SEC);
	assert.strictEqual(s.state, 'playing');
});

test('a Slow Motion speed put back says speed and carries no id, so it is never taken for a Slow Motion pause still in force', async () => {
	const ctx = bookSetup();
	const s1 = ctx.session({ speed: 1 });
	await ctx.runner.apply('slow_motion', { userId: 'u1', slot: 'Zack' });
	// At 9:00 the listener stops the book and plays it again, at the 0.75x its bookmark kept.
	ctx.clock.t = T0 + 9 * MIN;
	ctx.director.end(s1);
	const s2 = ctx.session({ speed: 0.75 });
	ctx.clock.t = T0 + 9 * MIN + 45 * SEC;
	const second = await ctx.runner.apply('slow_motion', { userId: 'u1', slot: 'Zack' });
	assert.deepStrictEqual(inForce(second), { applied: true, line: 'already at 0.75x, so the book pauses for 30 seconds', until: T0 + 10 * MIN + 15 * SEC });

	ctx.clock.t = T0 + 10 * MIN;
	assert.strictEqual(ctx.timers.fire(10 * MIN), 1);
	assert.strictEqual(s2.speed, 1);
	assert.strictEqual(s2.state, 'paused', 'the second one\'s pause goes on');
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ userId: 'u1', slot: 'Zack', kind: 'slow_motion', where: 'book', line: 'back to 1x', how: 'done', speed: true }]);

	ctx.clock.t = T0 + 10 * MIN + 15 * SEC;
	assert.strictEqual(ctx.timers.fire(30 * SEC), 1);
	assert.strictEqual(s2.state, 'playing');
	await settle();
	assert.deepStrictEqual(ctx.ended.slice(1), [{ id: second.id, userId: 'u1', slot: 'Zack', kind: 'slow_motion', where: 'book', line: 'the book plays again', how: 'done' }]);
});

test('restore() after a restart puts an overdue speed back now and arms one still running', async () => {
	const ctx = bookSetup({ marks: { 'u1::w1': { absoluteMs: 5 * MIN, speed: 0.75 }, 'u1::w2': { absoluteMs: 7 * MIN, speed: 0.75 } } });
	await ctx.runner.restore({ kind: 'speed', userId: 'u1', slot: 'Zack', workId: 'w1', previous: 1.5, until: T0 - SEC });
	assert.deepStrictEqual(ctx.recorded.map((r) => [r.workId, r.speed]), [['w1', 1.5]]);
	await settle();
	assert.deepStrictEqual(ctx.ended, [{ userId: 'u1', slot: 'Zack', kind: 'slow_motion', where: 'book', line: 'back to 1.5x', how: 'overdue', speed: true }]);

	// The persisted shape the spec names, with the user put back in by the game.
	await ctx.runner.restore({ userId: 'u1', workId: 'w2', previous: 1, until: T0 + 3 * MIN });
	assert.strictEqual(ctx.recorded.length, 1, 'not yet');
	const s = ctx.session({ workId: 'w2', speed: 0.75 });
	ctx.timers.fire(3 * MIN);
	assert.strictEqual(s.speed, 1, 'the listener came back to it: the live session is put back');
	assert.strictEqual(ctx.recorded.length, 1);

	await ctx.runner.restore({ workId: 'w1', previous: 1, until: T0 });
	assert.match(ctx.warns.join('\n'), /without a user/);
	await ctx.runner.restore({ kind: 'hold', userId: 'u1', workId: 'w1', until: T0 });
	await ctx.runner.restore(null);
	assert.strictEqual(ctx.recorded.length, 1);
});

test('a restore that lands while the book is still joining waits for it', async () => {
	const ctx = bookSetup();
	const s = ctx.session({ state: 'starting', speed: 0.75 });
	await ctx.runner.restore({ userId: 'u1', workId: 'w1', previous: 1.25, until: T0 - SEC });
	assert.strictEqual(s.speed, 0.75);
	assert.strictEqual(ctx.timers.live(5 * SEC).length, 1);
	s.state = 'playing';
	ctx.timers.fire(5 * SEC);
	assert.strictEqual(s.speed, 1.25);
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.line), ['back to 1.25x']);
});

test('end() lifts a book pause and puts a Slow Motion speed back, quietly', async () => {
	const ctx = bookSetup();
	const s = ctx.session({ speed: 1.5 });
	assert.strictEqual(await ctx.runner.end('u1'), false);
	await ctx.runner.apply('intermission', { userId: 'u1' });
	assert.strictEqual(await ctx.runner.end('u1'), true);
	assert.strictEqual(s.state, 'playing');

	await ctx.runner.apply('slow_motion', { userId: 'u1' });
	assert.strictEqual(s.speed, 0.75);
	assert.strictEqual(await ctx.runner.end('u1'), true);
	assert.strictEqual(s.speed, 1.5);
	assert.deepStrictEqual(ctx.timers.live(), []);
	await settle();
	assert.deepStrictEqual(ctx.ended, []);
	assert.strictEqual(await ctx.runner.end('u1'), false);
});

test('stop() lifts a book pause and drops a restore without putting the speed back early', async () => {
	const ctx = bookSetup();
	const s = ctx.session();
	await ctx.runner.apply('commercial_break', { userId: 'u1' });
	ctx.runner.stop();
	assert.strictEqual(s.state, 'playing');

	const slow = bookSetup();
	const t = slow.session();
	await slow.runner.apply('slow_motion', { userId: 'u1' });
	slow.runner.stop();
	assert.strictEqual(t.speed, 0.75, 'the game\'s persisted record brings it back through restore()');
	assert.deepStrictEqual(slow.timers.live(), []);
	assert.strictEqual(slow.director.listeners.size, 0);
});

test('books refuse the same way: off, absent, and busy while a claim or another effect holds the guild', async () => {
	const ctx = bookSetup();
	ctx.session();
	ctx.settings.apMediaTraps = false;
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: false, reason: 'off' });
	ctx.settings.apMediaTraps = true;
	ctx.settings.apMediaVoiceTraps = false;
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: false, reason: 'off' });
	ctx.settings.apMediaVoiceTraps = true;
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u2' }), { applied: false, reason: 'absent' });
	ctx.claims.on = true;
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: false, reason: 'busy' });
	ctx.claims.on = false;
	assert.deepStrictEqual(ctx.director.calls, [], 'nothing was touched');

	await ctx.runner.apply('slow_motion', { userId: 'u1' });
	assert.deepStrictEqual(await ctx.runner.apply('intermission', { userId: 'u1' }), { applied: false, reason: 'busy' });
	assert.deepStrictEqual(ctx.director.calls.map((c) => c.action), ['speed']);
});

test('a book pause lifted where the runner could not hear it frees the guild at the next look', async () => {
	const ctx = bookSetup();
	const s = ctx.session();
	await ctx.runner.apply('intermission', { userId: 'u1', slot: 'Zack' });
	// A resume that sent no change notice, as from a director without onChange.
	s.state = 'playing';
	s.pausedAt = null;
	assert.deepStrictEqual(await ctx.runner.apply('rewind', { userId: 'u1' }), { applied: true, line: 'back 5 minutes' });
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => [e.kind, e.how]), [['intermission', 'early']]);
	ctx.timers.fire(MIN);
	assert.strictEqual(s.state, 'playing');
	assert.deepStrictEqual(ctx.director.calls.map((c) => c.action), ['pause', 'back']);
});

test('without change notices, a pause the listener made after resuming is still told apart by its time', async () => {
	const ctx = bookSetup();
	delete ctx.director.onChange;
	const s = ctx.session();
	await ctx.runner.apply('intermission', { userId: 'u1' });
	ctx.clock.t += 5 * SEC;
	ctx.director.controlSession(s, s.member, 'resume');
	ctx.clock.t += 5 * SEC;
	ctx.director.controlSession(s, s.member, 'pause');
	ctx.timers.fire(MIN);
	assert.strictEqual(s.state, 'paused', 'paused at another time, so not the trap\'s pause');
	await settle();
	assert.deepStrictEqual(ctx.ended.map((e) => e.how), ['early']);
});

// ---- against a real book director ---------------------------------------------------------------

const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function untilReal(cond, what, ms = 5000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

class FakeConn extends EventEmitter {
	constructor() {
		super();
		this._state = { status: 'ready' };
	}
	get state() { return this._state; }
	set state(next) {
		const old = this._state;
		this._state = next;
		if (old.subscription && old.subscription !== next.subscription) old.subscription.unsubscribe();
		this.emit('stateChange', old, next);
	}
	subscribe(player) {
		if (this._state.status === 'destroyed') return undefined;
		const sub = player['subscribe'](this);
		this.state = { ...this._state, subscription: sub };
		return sub;
	}
	onSubscriptionRemoved(sub) {
		if (this._state.status !== 'destroyed' && this._state.subscription === sub) this._state = { ...this._state, subscription: undefined };
	}
	destroy() { this.state = { status: 'destroyed' }; }
	setSpeaking() {}
	prepareAudioPacket() {}
	dispatchAudio() {}
}

/** test/apMediaBooks.test.js's director: two 10-minute parts, its own timers on a clock that never moves. */
function realDirector(t, config = {}) {
	const parts = [1, 2].map((n) => ({
		ordinal: n,
		albumRatingKey: '720',
		trackRatingKey: `72${n}`,
		title: `Part ${n}`,
		durationMs: 10 * MIN,
		partKey: `/library/parts/72${n}/1700000000/part${n}.mp3`,
		file: `part${n}.mp3`,
		sizeBytes: 1000 + n,
		container: 'mp3'
	}));
	const work = { id: 'test-author/long-book', kind: 'book', title: 'Long Book', author: 'Test Author', narrator: null, edition: null, series: null, sequence: null, aliases: [], parts };
	const guild = { id: 'g1', voiceStates: { cache: new Map([['u1', { channelId: 'v1' }]]) }, voiceAdapterCreator: () => ({}) };
	const channel = { id: 'v1', name: 'Reading Room', guild };
	const listener = { id: 'u1', displayName: 'Reader', user: { id: 'u1', username: 'Reader' }, guild, voice: { channel, channelId: 'v1' } };
	const textChannel = {
		id: 't1',
		async send() {
			const msg = { async edit() { return msg; } };
			return msg;
		}
	};
	const conns = [];
	const deps = {
		timers: { setTimeout: (fn, ms) => ({ fn, ms, unref() {} }), clearTimeout() {}, now: () => T0 },
		config: { audiobooksEnabled: true, audiobookSaveSeconds: 15, audiobookIdleLeaveMinutes: 10, audiobookResumeRewindSeconds: 10, ownerId: 'owner', ...config },
		catalog: { works: () => [work], work: (id) => (id === work.id ? work : null), findWorks: () => [work], partKeyFor: (w, p) => p.partKey },
		library: { start: () => null, stop() {}, ensureFresh: async () => ({ action: 'fresh' }), status: () => 'ready', lastError: () => null },
		repairPartKey: async () => null,
		ensureFresh: async () => ({ action: 'fresh' }),
		proxy: { stop: async () => {} },
		probe: async () => ({ ok: true, status: 206 }),
		urlFor: (key) => `fake:${key}`,
		createPlayer: () => voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause, maxMissedFrames: 750 } }),
		createResource: ({ url, startMs, speed }) => {
			const p = parts.find((x) => `fake:${x.partKey}` === url);
			const frames = Math.max(1, Math.round((p.durationMs - startMs) / speed / 20));
			let n = 0;
			const stream = new Readable({ objectMode: true, read() { if (n++ < frames) this.push(SILENCE); else this.push(null); } });
			const resource = voice.createAudioResource(stream, { inputType: voice.StreamType.Opus });
			const kill = () => { if (!stream.destroyed) stream.destroy(); };
			resource.playStream.once('close', kill);
			return { resource, kill };
		},
		card: { buildCard: (v) => ({ view: v }), endedCard: (v) => ({ view: v }), movedCard: () => ({}) },
		commandLog: { recordEvent() {} },
		getVoiceConnection: () => conns[conns.length - 1]
	};
	const bot = {
		songQueue: [],
		musicBusy: () => false,
		openConnection() {
			const c = new FakeConn();
			conns.push(c);
			return Promise.resolve(c);
		},
		playSong: () => Promise.resolve()
	};
	const client = new EventEmitter();
	client.user = { id: 'bot' };
	const director = createBookDirector({ client, bot, deps });
	t.after(async () => {
		director.shutdown();
		await settle();
	});
	return {
		director,
		work,
		control: (action, arg) => director.control(guild.id, listener, action, arg),
		controlAs: (member, action, arg) => director.control(guild.id, member, action, arg),
		joinRoom(id, name) {
			guild.voiceStates.cache.set(id, { channelId: channel.id });
			return { id, displayName: name, user: { id, username: name }, guild, voice: { channel, channelId: channel.id } };
		},
		play: () => director.play({ guild, member: listener, textChannel, workId: work.id }),
		session: () => director.session(guild.id)
	};
}

test('against a real book director, Rewind, Intermission and Slow Motion act on the listener\'s own session', async (t) => {
	const real = realDirector(t);
	const r = await real.play();
	assert.strictEqual(r.ok, true, r.text);
	const s = real.session();
	await untilReal(() => s.audible, 'audio');

	const timers = fakeTimers();
	const ended = [];
	const warns = [];
	const runner = createTrapRunner({
		getBot: () => null,
		getBooks: () => real.director,
		settings: () => ({}),
		logger: quietLogger(warns),
		timers,
		now: () => T0,
		onEnd: (info) => ended.push(info),
		voiceClaims: { holder: () => null },
		bookmarks: { get: () => null, setSpeed() { throw new Error('a live session saves its own bookmark'); } },
		catalog: { work: (id) => (id === real.work.id ? real.work : null) }
	});
	t.after(() => runner.stop());
	assert.deepStrictEqual(runner.listening('u1'), { where: 'book', guildId: 'g1', channelId: 'v1' });

	assert.strictEqual(real.control('fwd', 600).ok, true);
	await untilReal(() => s.audible, 'audio after the jump');
	assert.deepStrictEqual(await runner.apply('rewind', { userId: 'u1', slot: 'Reader' }), { applied: true, line: 'back 5 minutes' });
	assert.ok(s.anchorAbsMs >= 5 * MIN && s.anchorAbsMs < 5 * MIN + 5 * SEC, `back to about 5:00, at ${s.anchorAbsMs}`);
	await untilReal(() => s.audible, 'audio after the rewind');

	const im = await runner.apply('intermission', { userId: 'u1', slot: 'Reader' });
	assert.strictEqual(im.applied, true);
	assert.strictEqual(s.state, 'paused');
	assert.strictEqual(runner.listening('u1'), null);
	timers.fire(MIN);
	assert.strictEqual(s.state, 'playing');
	await untilReal(() => s.audible, 'audio after the pause');
	await settle();
	assert.deepStrictEqual(ended.map((e) => [e.kind, e.how]), [['intermission', 'done']]);

	const sm = await runner.apply('slow_motion', { userId: 'u1', slot: 'Reader' });
	assert.deepStrictEqual(sm.restore, { kind: 'speed', userId: 'u1', slot: 'Reader', workId: real.work.id, previous: 1, until: T0 + 10 * MIN });
	assert.strictEqual(s.speed, 0.75);
	await untilReal(() => s.audible && s.resSpeed === 0.75, 'audio at 0.75x');
	timers.fire(10 * MIN);
	assert.strictEqual(s.speed, 1);
	await untilReal(() => s.audible && s.resSpeed === 1, 'audio at 1x again');
	assert.deepStrictEqual(warns, []);
});

test('against a real book director, a /book pause under the trap\'s pause keeps the book paused when the trap ends', async (t) => {
	const real = realDirector(t);
	const r = await real.play();
	assert.strictEqual(r.ok, true, r.text);
	const s = real.session();
	await untilReal(() => s.audible, 'audio');

	const timers = fakeTimers();
	const ended = [];
	const warns = [];
	const runner = createTrapRunner({
		getBot: () => null,
		getBooks: () => real.director,
		settings: () => ({}),
		logger: quietLogger(warns),
		timers,
		now: () => T0,
		onEnd: (info) => ended.push(info),
		voiceClaims: { holder: () => null }
	});
	t.after(() => runner.stop());

	const im = await runner.apply('intermission', { userId: 'u1', slot: 'Reader' });
	assert.strictEqual(s.state, 'paused');
	const again = real.control('pause');
	assert.deepStrictEqual([again.ok, again.code, again.text], [true, 'noop', 'Already paused.']);
	timers.fire(MIN);
	assert.strictEqual(s.state, 'paused', 'the listener\'s own pause is left in place');
	await settle();
	assert.deepStrictEqual(ended.map((e) => [e.id, e.how, e.line]), [[im.id, 'paused', 'someone paused the book, so it stays paused']]);
	assert.strictEqual(real.control('resume').ok, true);
	await untilReal(() => s.audible, 'audio once they resume it');
	assert.deepStrictEqual(warns, []);
});

test('against a real book director, a pause someone else in the room asks for under the trap\'s pause stays too, and the end line does not say the listener made it', async (t) => {
	const real = realDirector(t, { audiobookControls: 'voice' });
	const r = await real.play();
	assert.strictEqual(r.ok, true, r.text);
	const s = real.session();
	await untilReal(() => s.audible, 'audio');

	const timers = fakeTimers();
	const ended = [];
	const warns = [];
	const runner = createTrapRunner({
		getBot: () => null,
		getBooks: () => real.director,
		settings: () => ({}),
		logger: quietLogger(warns),
		timers,
		now: () => T0,
		onEnd: (info) => ended.push(info),
		voiceClaims: { holder: () => null }
	});
	t.after(() => runner.stop());

	const bob = real.joinRoom('u2', 'Bob');
	const im = await runner.apply('intermission', { userId: 'u1', slot: 'Reader' });
	assert.strictEqual(s.state, 'paused');
	const again = real.controlAs(bob, 'pause');
	assert.deepStrictEqual([again.ok, again.code, again.text], [true, 'noop', 'Already paused.'], 'under audiobookControls voice, the room may pause the book');
	timers.fire(MIN);
	assert.strictEqual(s.state, 'paused', 'Bob\'s pause is left in place');
	await settle();
	assert.deepStrictEqual(ended.map((e) => [e.id, e.how, e.line]), [[im.id, 'paused', 'someone paused the book, so it stays paused']]);
	assert.strictEqual(real.controlAs(bob, 'resume').ok, true);
	await untilReal(() => s.audible, 'audio once Bob resumes it');
	assert.deepStrictEqual(warns, []);
});
