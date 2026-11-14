// helpers/apMediaVoice.js: music the bot plays in voice turned into Plex Media credit events
// (spec 5.6).
//
// The rules under test are the ones that keep voice credit honest: 85% of the track's own length
// actually heard for the track itself (so a !seek to the end or a skip early on is no listen of it,
// only a span of what played, which can earn an album checkpoint), the 30 s natural-end fallback
// only for a length nobody knows, credit only for the people in the channel at both ends, and all
// of the work deferred out of the AudioPlayer's state setter.
//
// Harness: a fake Bot (an EventEmitter with client.guilds.cache and a voiceListeners() that reads a
// test-controlled list per channel), injected resolve/onEvent/getConfig/now/defer, and a recording
// logger. createResolver runs against real apMediaCredit.indexSlot() indexes of a small slot_data.

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const voice = require('../helpers/apMediaVoice.js');
const credit = require('../helpers/apMediaCredit.js');

const NOW = Date.UTC(2026, 10, 11, 20, 0, 0);

const tick = () => new Promise((r) => setImmediate(r));

const ONE_MORE_TIME = Object.freeze({
	artist: 'Daft Punk', title: 'One More Time', album: 'Discovery',
	key: '/library/parts/9876/1600000000/file.flac', ratingKey: 346, duration: 320000
});

function fakeBot({ present = { c1: ['u1', 'u2'] } } = {}) {
	const bot = new EventEmitter();
	const guild = { id: 'g1', present };
	bot.client = { guilds: { cache: new Map([['g1', guild]]) } };
	bot.voiceListeners = (g, channelId) => (g.present[channelId] || []).slice();
	return { bot, guild };
}

function heard(extra = {}) {
	return {
		entry: { ...ONE_MORE_TIME },
		heardMs: 300000,
		natural: true,
		guildId: 'g1',
		channelId: 'c1',
		startListeners: ['u1', 'u2'],
		...extra
	};
}

function recordingLogger() {
	const warns = [];
	return { warns, warn: (...args) => warns.push(args.join(' ')), info() {}, error() {}, debug() {} };
}

function setup({ resolve = () => ({ durationMs: 999999 }), config = {}, present, onEvent, defer, now } = {}) {
	const { bot, guild } = fakeBot(present ? { present } : undefined);
	const events = [];
	const logger = recordingLogger();
	const detach = voice.attach({
		bot,
		resolve,
		onEvent: onEvent || ((e) => { events.push(e); }),
		getConfig: () => config,
		now: now || (() => NOW),
		defer,
		logger
	});
	return { bot, guild, events, logger, detach };
}

test('a list track heard to 85% credits the people there at both ends, once the state setter has returned', async () => {
	const queued = [];
	let clock = NOW;
	const ctx = setup({
		defer: (fn) => queued.push(fn),
		now: () => clock,
		present: { c1: ['u2', 'u1', 'u9'] }
	});

	ctx.bot.emit('track-heard', heard({ startListeners: ['u1', 'u2', 'u3', 'u1'] }));
	assert.deepStrictEqual(ctx.events, [], 'nothing runs inside the emit');
	assert.strictEqual(queued.length, 1);
	clock = NOW + 5000;
	queued.shift()();

	assert.deepStrictEqual(ctx.events, [{
		type: 'complete',
		source: 'voice',
		userIds: ['u1', 'u2'],
		ratingKey: 346,
		partId: 9876,
		artist: 'Daft Punk',
		title: 'One More Time',
		fromMs: 0,
		toMs: 300000,
		at: NOW
	}], 'a whole track carries the stretch that went out too, for timesanity_strict');
});

test("the 85% line uses the queue entry's own length first, then the slot's", async () => {
	const ctx = setup({ resolve: () => ({ durationMs: 200000 }) });
	const own = { ...ONE_MORE_TIME };
	const noLength = { ...ONE_MORE_TIME, duration: null };

	for (const [entry, heardMs, natural] of [
		[own, 271999, true],
		[own, 10000, true],
		[noLength, 169999, true]
	]) ctx.bot.emit('track-heard', heard({ entry, heardMs, natural }));
	await tick();
	assert.deepStrictEqual(ctx.events.map((e) => [e.type, e.fromMs, e.toMs]), [['span', 0, 271999], ['span', 0, 10000], ['span', 0, 169999]],
		'short of 85%, natural end or not (a seek to the end ends naturally): only what played');

	ctx.events.length = 0;
	for (const [entry, heardMs, natural] of [
		[own, 272000, true],
		[own, 300000, false],
		[noLength, 170000, true]
	]) ctx.bot.emit('track-heard', heard({ entry, heardMs, natural }));
	await tick();
	assert.deepStrictEqual(ctx.events.map((e) => e.type), ['complete', 'complete', 'complete'], 'a skip after 85% still counts: that much was heard');
});

test('a track nobody knows the length of needs a natural end and 30 s of audio', async () => {
	const ctx = setup({ resolve: () => ({}) });
	const entry = { ...ONE_MORE_TIME, duration: undefined };

	ctx.bot.emit('track-heard', heard({ entry, heardMs: 29999, natural: true }));
	ctx.bot.emit('track-heard', heard({ entry, heardMs: 600000, natural: false }));
	await tick();
	assert.deepStrictEqual(ctx.events.map((e) => e.type), ['span', 'span']);

	ctx.bot.emit('track-heard', heard({ entry, heardMs: 30000, natural: true }));
	await tick();
	assert.deepStrictEqual(ctx.events.map((e) => e.type), ['span', 'span', 'complete']);
});

// The bug: voice credit was a whole track or nothing, so a track skipped after it passed an album or
// mix checkpoint earned nothing, while the same stretch through Plexamp earned it.
test('a listen short of 85% is a span of what played, from where the resource started', async () => {
	const ctx = setup({ resolve: () => ({ durationMs: 320000 }) });

	ctx.bot.emit('track-heard', heard({ heardMs: 90000, natural: false }));
	ctx.bot.emit('track-heard', heard({ heardMs: 30000, startMs: 60000, natural: false }));
	ctx.bot.emit('track-heard', heard({ heardMs: 0, natural: false }));
	ctx.bot.emit('track-heard', heard({ heardMs: 12000, startMs: 'soon', natural: false }));
	await tick();

	assert.deepStrictEqual(ctx.events, [
		{ type: 'span', source: 'voice', userIds: ['u1', 'u2'], ratingKey: 346, partId: 9876, artist: 'Daft Punk', title: 'One More Time', at: NOW, fromMs: 0, toMs: 90000 },
		{ type: 'span', source: 'voice', userIds: ['u1', 'u2'], ratingKey: 346, partId: 9876, artist: 'Daft Punk', title: 'One More Time', at: NOW, fromMs: 60000, toMs: 90000 },
		{ type: 'span', source: 'voice', userIds: ['u1', 'u2'], ratingKey: 346, partId: 9876, artist: 'Daft Punk', title: 'One More Time', at: NOW, fromMs: 0, toMs: 12000 },
	], 'after a !seek to 1:00 it starts there; no audio is nothing; a start nobody can read is the beginning');
});

test('isHeard follows contracts.VOICE', () => {
	assert.strictEqual(voice.isHeard(85, 100, false), true);
	assert.strictEqual(voice.isHeard(84.9, 100, true), false);
	assert.strictEqual(voice.isHeard(30000, 0, true), true);
	assert.strictEqual(voice.isHeard(30000, null, false), false);
	assert.strictEqual(voice.isHeard(NaN, 100, true), false);
});

test('nothing is credited for a track no slot holds', async () => {
	const asked = [];
	const ctx = setup({ resolve: (entry, ident) => { asked.push([entry, ident]); return null; } });
	const track = { key: '/library/parts/9876/1600000000/file.flac', title: 'Elsewhere', artist: 'Someone' };

	ctx.bot.emit('track-heard', heard({ entry: track, heardMs: 12000 }));
	await tick();

	assert.deepStrictEqual(ctx.events, []);
	assert.strictEqual(asked.length, 1);
	assert.strictEqual(asked[0][0], track, 'resolve sees the queue entry itself');
	assert.deepStrictEqual(asked[0][1], { ratingKey: null, partId: 9876, artist: 'Someone', title: 'Elsewhere' });
});

// The bug: once a short listen became a span, a Hitster clip of a list track earned the album's
// checkpoints, and its credit line and the relay's send line named the album mid-round.
test('a Hitster clip earns nothing, even of a track a slot holds', async () => {
	const asked = [];
	const ctx = setup({ resolve: (entry) => { asked.push(entry); return { durationMs: 320000 }; } });
	const clip = { key: '/library/parts/9876/1600000000/file.flac', title: 'Secret Track', artist: '???', secret: true };

	ctx.bot.emit('track-heard', heard({ entry: clip, heardMs: 30000, natural: false }));
	ctx.bot.emit('track-heard', heard({ entry: { ...clip, duration: 20000 }, heardMs: 20000, natural: true }));
	await tick();

	assert.deepStrictEqual(ctx.events, []);
	assert.deepStrictEqual(asked, [], 'never looked up');
});

test('identify reads numbers from what the queue carries, and nothing from a YouTube entry', () => {
	assert.deepStrictEqual(voice.identify({ ...ONE_MORE_TIME, ratingKey: '346' }), {
		ratingKey: 346, partId: 9876, artist: 'Daft Punk', title: 'One More Time'
	});
	assert.deepStrictEqual(voice.identify({ title: 'One More Time', artist: 'Daft Punk', url: 'https://www.youtube.com/watch?v=x' }), {
		ratingKey: null, partId: null, artist: 'Daft Punk', title: 'One More Time'
	});
	assert.strictEqual(voice.identify({ ratingKey: 0 }).ratingKey, null);
	assert.strictEqual(voice.identify({ ratingKey: 'abc' }).ratingKey, null);
	assert.strictEqual(voice.identify({ key: '/library/metadata/5' }).partId, null);
	assert.strictEqual(voice.identify({ title: 'Line\nbreak\u0000 ' }).title, 'Line break');
	assert.deepStrictEqual(voice.identify(null), { ratingKey: null, partId: null, artist: '', title: '' });
});

test('only the people present at the start and at the end are credited', async () => {
	const ctx = setup({ present: { c1: ['u2'] } });

	ctx.bot.emit('track-heard', heard({ startListeners: ['u1'] }));
	ctx.bot.emit('track-heard', heard({ startListeners: [] }));
	ctx.bot.emit('track-heard', heard({ startListeners: undefined }));
	ctx.bot.emit('track-heard', heard({ guildId: 'gone' }));
	await tick();
	assert.deepStrictEqual(ctx.events, [], 'joined late, left early, nobody at the start, or a guild the bot is no longer in');

	ctx.bot.emit('track-heard', heard({ startListeners: ['u1', 'u2'] }));
	await tick();
	assert.deepStrictEqual(ctx.events.map((e) => e.userIds), [['u2']]);
});

test('apMediaVoiceCredit false turns voice credit off, read on every listen', async () => {
	const config = { apMediaVoiceCredit: false };
	const ctx = setup({ config });

	ctx.bot.emit('track-heard', heard());
	await tick();
	assert.deepStrictEqual(ctx.events, []);

	config.apMediaVoiceCredit = true;
	ctx.bot.emit('track-heard', heard());
	delete config.apMediaVoiceCredit;
	ctx.bot.emit('track-heard', heard());
	await tick();
	assert.strictEqual(ctx.events.length, 2, 'on, and on by default');
});

test('detach stops listening, and drops a listen still waiting for its turn', async () => {
	const ctx = setup();

	ctx.bot.emit('track-heard', heard());
	ctx.detach();
	ctx.detach();
	ctx.bot.emit('track-heard', heard());
	await tick();

	assert.deepStrictEqual(ctx.events, []);
	assert.strictEqual(ctx.bot.listenerCount('track-heard'), 0);
});

test('a failing onEvent is logged, and the next listen still goes through', async () => {
	let calls = 0;
	const delivered = [];
	const ctx = setup({
		onEvent: (e) => {
			calls++;
			if (calls === 1) throw new Error('store full');
			if (calls === 2) return Promise.reject(new Error('socket closed'));
			delivered.push(e);
			return Promise.resolve();
		}
	});

	for (let i = 0; i < 3; i++) ctx.bot.emit('track-heard', heard());
	await tick();
	await tick();

	assert.strictEqual(calls, 3);
	assert.strictEqual(delivered.length, 1);
	assert.strictEqual(ctx.logger.warns.length, 2);
	assert.match(ctx.logger.warns[0], /One More Time.*store full/);
	assert.match(ctx.logger.warns[1], /socket closed/);
});

test('a resolve that throws is logged and credits nothing', async () => {
	const ctx = setup({ resolve: () => { throw new Error('index not built'); } });
	ctx.bot.emit('track-heard', heard());
	await tick();
	assert.deepStrictEqual(ctx.events, []);
	assert.match(ctx.logger.warns[0], /index not built/);
});

test('attach refuses to run without the Bot or onEvent', () => {
	assert.throws(() => voice.attach({ onEvent() {} }), /needs the Bot/);
	assert.throws(() => voice.attach({ bot: new EventEmitter() }), /needs onEvent/);
});

// A slot with one album (two tracks, the second also as a twin copy) and one playlist mix.
function slotData() {
	return {
		schema: 1,
		game: 'Plex Media',
		generated_at: 1731300000,
		entries: [
			{
				k: 'album', id: 'plex://album/discovery', rk: 100, ar: 'Daft Punk', t: 'Discovery', y: 2001, d: 532000,
				tr: [[346, 1, 'One More Time', 320000, 9876, 1347000010], [347, 2, 'Aerodynamic', 212000, 9877, 1347000011]],
				alt: [[200, [[446, 19876], [447, 19877]]]],
				u: 1347001001, s: 1, cp: []
			},
			{
				k: 'mix', id: 'pl:5:1', pl: 5, part: 1, t: 'Road Trip Part 1', d: 180000,
				tr: [[901, 1, 'Midnight City', 180000, 5901, 'M83', 1347000012]],
				u: 1347001002, s: 1, cp: []
			}
		]
	};
}

test('createResolver finds a track by ratingKey, then part id, then artist and title, with its length', () => {
	const empty = credit.indexSlot({ schema: 1, generated_at: 1731300000, entries: [] });
	const full = credit.indexSlot(slotData());
	const resolve = voice.createResolver(() => [empty, full]);

	assert.deepStrictEqual(resolve({ ...ONE_MORE_TIME, ratingKey: 347 }), { durationMs: 212000 }, 'by ratingKey first');
	assert.deepStrictEqual(resolve({ ...ONE_MORE_TIME, ratingKey: 447 }), { durationMs: 212000 }, "a twin copy's ratingKey");
	assert.deepStrictEqual(resolve({ title: 'x', artist: 'y', key: '/library/parts/9876/1/a.flac' }), { durationMs: 320000 }, 'by part id');
	assert.deepStrictEqual(resolve({ title: 'Midnight City', artist: 'M83', url: 'https://www.youtube.com/watch?v=x' }), { durationMs: 180000 }, 'by artist and title');
	assert.deepStrictEqual(resolve({ title: 'aerodynamic!', artist: 'DAFT PUNK' }), { durationMs: 212000 }, 'titles compare normalised');
	assert.strictEqual(resolve({ title: 'Secret Track', artist: '???', key: '/library/parts/1/1/a.flac' }), null);
	assert.strictEqual(voice.createResolver(() => null)({ ...ONE_MORE_TIME }), null, 'no bindings, nothing to match');
	assert.throws(() => voice.createResolver(null), /needs indexes/);
});

test('with createResolver, a twin copy queued without a length is judged on the slot track length', async () => {
	const index = credit.indexSlot(slotData());
	const ctx = setup({ resolve: voice.createResolver(() => [index]) });
	const twin = { artist: 'Daft Punk', title: 'Aerodynamic', key: '/library/parts/19877/1/a.flac' };

	ctx.bot.emit('track-heard', heard({ entry: twin, heardMs: 180199 }));
	ctx.bot.emit('track-heard', heard({ entry: twin, heardMs: 180200 }));
	await tick();

	assert.deepStrictEqual(ctx.events.map((e) => [e.type, e.partId, e.title]), [['span', 19877, 'Aerodynamic'], ['complete', 19877, 'Aerodynamic']]);
});
