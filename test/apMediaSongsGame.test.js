// The Plex Media game with a playlist at songs per unlock (world 0.4.0): all of a playlist's parts
// share one unlock, and each copy of it opens the next part.
//
// What has to hold: /apmedia list names a part's songs, the unlock that opens a locked part and which
// copy of it (the 2nd for part 2); a song heard in a locked part waits in the bank for the copy that opens its own
// part, so the first copy sends part 1's song and keeps part 2's; a Wild Ticket opens only the part it
// names, and the copies still open the parts from part 1; and the autoskip (bot.autoskip) skips a song
// only while the copies have not reached its part. test/apMediaGame.test.js covers the rest of the
// game on slot_data_mixed.json, where each part is an unlock of its own.
//
// Harness: test/apMediaGame.test.js's, cut down: the real orchestrator (createGame) with the real
// ApMediaClient against test/helpers/apMediaServer.js on a loopback port, serving
// test/fixtures/apmedia/songsSlotData.js (slot_data_mixed.json as the world writes it at
// songs_per_unlock 3; generated_at 1731300000, so every event here is dated after it); the real
// apMediaStore in memory; a fake PMS, bot, monitor and Discord client; and timers fired by hand, so
// no poll or batch runs on its own.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const contracts = require('../helpers/apMediaContracts.js');
const { createGame } = require('../helpers/apMediaGame.js');
const { createApMediaStore } = require('../helpers/apMediaStore.js');
const { rowLine } = require('../commands/apmedia.js/list.js');
const { startApMediaServer } = require('./helpers/apMediaServer.js');
const { waitFor } = require('./helpers/apServer.js');
const { songsSlotData } = require('./fixtures/apmedia/songsSlotData.js');

const SD = songsSlotData();
const SLOT = 'ZackPlex';
const OWNER = '100000000000000009';
const CHANNEL = '200000000000000001';
const AFTER = (SD.generated_at + 86400) * 1000;
const ALL_LOCATIONS = Array.from({ length: 86 }, (_, i) => contracts.checkId(i + 1));
const WILD = contracts.IDS.wildTicket;
const ROAD_TRIP = SD.units.find((u) => u.name === 'Road Trip: Next 3 Songs').id;
const START = SD.units.flatMap((u) => Array.from({ length: u.start }, () => ({ item: u.id, flags: 1 })));
const ROOM = { known: true, slots: { [SLOT]: 'Plex Media', Watcher: 'ChecksFinder' } };
// Part 1's first song and part 2's only one, each with its track location, and as a voice queue entry.
const SONG_A = { rk: 25006, id: contracts.checkId(43) };
const SONG_D = { rk: 25011, id: contracts.checkId(46) };
const SONG_A_VOICE = Object.freeze({ title: 'Song A', artist: 'Artist A', key: '/library/parts/250011/1600000000/file.flac', ratingKey: 25006, duration: 200000 });
const SONG_D_VOICE = Object.freeze({ title: 'Song D', artist: 'Artist D', key: '/library/parts/250021/1600000000/file.flac', ratingKey: 25011, duration: 240000 });

function quietLogger() {
	const lines = [];
	const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
	return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function handTimers() {
	let next = 1;
	const pending = new Map();
	const add = (fn, ms, every) => {
		const id = next++;
		pending.set(id, { fn, ms, every });
		return { id, unref() {} };
	};
	return {
		pending,
		setTimeout: (fn, ms) => add(fn, ms, false),
		setInterval: (fn, ms) => add(fn, ms, true),
		clearTimeout: (h) => { if (h) pending.delete(h.id); },
		clearInterval: (h) => { if (h) pending.delete(h.id); },
	};
}

function fakeMonitor(target) {
	const watch = { id: 0, channelId: CHANNEL, password: null, target };
	return {
		room: ROOM,
		getWatch: (id) => (Number(id) === 0 ? watch : null),
		describeSlot(watchId, name) {
			if (Number(watchId) !== 0) return null;
			const names = Object.keys(ROOM.slots);
			const canonical = names.find((n) => n.toLowerCase() === String(name).trim().toLowerCase()) || null;
			return { known: true, canonical, slotId: canonical ? names.indexOf(canonical) + 1 : null, game: canonical ? ROOM.slots[canonical] : null };
		},
		onWatchChange: () => () => {},
		listHints: (id) => (Number(id) === 0 ? [] : null),
		listClaims: () => [],
	};
}

function fakeDiscord() {
	const posts = [];
	return {
		posts,
		channels: { fetch: async (id) => ({ id, send: async (payload) => { posts.push({ channelId: id, ...payload }); return {}; } }) },
	};
}

function fakePms() {
	return {
		playlists: async () => [],
		history: async () => ({ rows: [], total: 0 }),
		sessions: async () => [],
		accounts: async () => [{ id: 1, name: 'Owner' }],
		metadata: async () => null,
	};
}

function fakeBot() {
	const bot = new EventEmitter();
	bot.client = { guilds: { cache: new Map([['g1', { id: 'g1' }]]) } };
	bot.voiceListeners = () => [];
	return bot;
}

async function setup(t, { start = START } = {}) {
	const server = await startApMediaServer({
		slotData: { 1: SD },
		locations: { 1: ALL_LOCATIONS },
		startInventory: { 1: start },
	});
	t.after(() => server.close());
	const h = {
		server,
		store: createApMediaStore(),
		discord: fakeDiscord(),
		timers: handTimers(),
		bot: fakeBot(),
	};
	h.game = createGame({
		store: h.store,
		monitor: fakeMonitor(server.target),
		config: {
			apMediaEnabled: true,
			archipelagoEnabled: true,
			apMediaChannelId: '',
			apMediaAnnounce: 'completions',
			apMediaHistorySeconds: 120,
			apMediaSessionSeconds: 15,
			apMediaVoiceCredit: true,
			archipelagoBatchSeconds: 5,
			ownerId: OWNER,
			commandPrefix: '!',
		},
		configStore: { onChange: () => () => {} },
		pms: fakePms(),
		timers: h.timers,
		watcherTimers: handTimers(),
		booksTimers: handTimers(),
		logger: quietLogger(),
		bookmarks: { forUser: () => [] },
		catalogStore: { works: {}, work: () => null },
		commandLog: { recordEvent() {} },
		voiceDefer: (fn) => fn(),
		now: () => AFTER + 3600000,
	});
	t.after(() => h.game.stop());
	h.game.start({ discord: h.discord, bot: h.bot });
	return h;
}

const runtime = (h, key) => h.game._internal.runtime(key);
const row = (h, key) => h.game.status(key).bindings[0];
const historyEvent = (rk, extra = {}) => ({ type: 'complete', source: 'history', accountId: 1, ratingKey: rk, at: AFTER, ...extra });

async function linkSlot(h) {
	const res = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER, by: OWNER });
	assert.ok(res.ok, res.message);
	const key = res.binding.key;
	await waitFor(() => row(h, key).inventoryKnown, 'the slot inventory');
	await h.game._internal.idle();
	return key;
}

async function settledPosts(h) {
	await h.game._internal.idle();
	await h.game._internal.flushAll();
	const all = h.discord.posts.map((p) => p.content);
	h.discord.posts.length = 0;
	return all;
}

// The playlist's nth copy: a count that only grows, so waiting for 'more than 0' would pass on the
// first copy before the second one is in.
async function receiveCopy(h, key, nth) {
	h.server.pushItems(1, [{ item: ROAD_TRIP, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => {
		const counts = runtime(h, key) && runtime(h, key).counts;
		return counts && counts.units.get(ROAD_TRIP) === nth;
	}, `copy ${nth} of the playlist's unlock`);
	await h.game._internal.idle();
}

// The playlist's heading and its rows as /apmedia list writes them, or [] when it has none in that view.
function playlistLines(h, key, which) {
	const res = h.game.list(key, which);
	assert.ok(res.ok, res.message);
	const group = res.groups.find((g) => g.kind === 'mix');
	return group ? [group.name, ...group.rows.map((r) => rowLine(r, group, which))] : [];
}

test('the songs fixture is one unlock of 2 steps for the playlist\'s 2 parts, locked at the start', () => {
	const parts = SD.entries.filter((e) => e.k === 'mix');
	assert.deepStrictEqual(parts.map((e) => [e.t, e.u, e.s, e.tr.length]), [['Road Trip Part 1', ROAD_TRIP, 1, 3], ['Road Trip Part 2', ROAD_TRIP, 2, 1]]);
	assert.deepStrictEqual(SD.units.filter((u) => u.kind === 'mix'), [{ id: ROAD_TRIP, name: 'Road Trip: Next 3 Songs', kind: 'mix', steps: 2, start: 0 }]);
	assert.strictEqual(SD.songs_per_unlock, 3);
	assert.ok(!START.some((s) => s.item === ROAD_TRIP));
});

test('/apmedia list names each part\'s songs and the playlist\'s one unlock for each locked part, the 2nd copy for part 2, and the first copy readies part 1 only', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	assert.deepStrictEqual(playlistLines(h, key, 'locked'), [
		'Road Trip',
		'\u2022 Road Trip Part 1 (Song A, \u6771\u4eac and Short One) \u00B7 7m \u00B7 opened by Road Trip: Next 3 Songs',
		'\u2022 Road Trip Part 2 (Song D) \u00B7 4m \u00B7 opened by Road Trip: Next 3 Songs (the 2nd)',
	]);
	assert.deepStrictEqual(playlistLines(h, key, 'ready'), []);

	await receiveCopy(h, key, 1);
	assert.deepStrictEqual(playlistLines(h, key, 'ready'), ['Road Trip', '\u2022 Road Trip Part 1 (Song A, \u6771\u4eac and Short One) \u00B7 7m']);
	assert.deepStrictEqual(playlistLines(h, key, 'locked'), ['Road Trip', '\u2022 Road Trip Part 2 (Song D) \u00B7 4m \u00B7 opened by Road Trip: Next 3 Songs (the 2nd)']);

	await receiveCopy(h, key, 2);
	assert.deepStrictEqual(playlistLines(h, key, 'locked'), []);
	assert.deepStrictEqual(playlistLines(h, key, 'ready'), ['Road Trip', '\u2022 Road Trip Part 1 (Song A, \u6771\u4eac and Short One) \u00B7 7m', '\u2022 Road Trip Part 2 (Song D) \u00B7 4m']);
});

test('a song heard in a locked part waits in the bank for the copy that opens its part: the first copy sends part 1\'s, the second part 2\'s', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(historyEvent(SONG_D.rk));
	await h.game._internal.handleEvent(historyEvent(SONG_A.rk, { at: AFTER + 60000 }));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, 2);
	assert.ok(![SONG_A.id, SONG_D.id].some((id) => h.server.checkedOf(1).has(id)), 'nothing sent while both parts are locked');
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F512} `ZackPlex` listened to **Road Trip Part 2**, 1 check waiting for its unlock']);

	await receiveCopy(h, key, 1);
	await waitFor(() => h.server.checkedOf(1).has(SONG_A.id) && row(h, key).pending === 0, 'part 1\'s song');
	assert.strictEqual(row(h, key).banked, 1, 'part 2\'s song waits for the second copy');
	assert.ok(!h.server.checkedOf(1).has(SONG_D.id));
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F513} `ZackPlex` **Road Trip Part 1** unlocked, 1 check sent']);

	await receiveCopy(h, key, 2);
	await waitFor(() => h.server.checkedOf(1).has(SONG_D.id) && row(h, key).pending === 0, 'part 2\'s song');
	assert.strictEqual(row(h, key).banked, 0);
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F513} `ZackPlex` **Road Trip Part 2** unlocked, 1 check sent']);
});

test('a Wild Ticket opens only the part it names, and the first copy still opens part 1', async (t) => {
	const h = await setup(t, { start: [...START, { item: WILD, flags: 1 }] });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(SONG_D.rk));
	await h.game._internal.idle();
	await settledPosts(h);
	const spent = await h.game.redeem(key, 'Road Trip Part 2');
	assert.ok(spent.ok, spent.message);
	assert.deepStrictEqual(spent.opened, ['Road Trip Part 2']);
	assert.strictEqual(spent.message, '\u{1F39F}\uFE0F Spent a Wild Ticket on **Road Trip Part 2**. 1 banked check went out. 0 tickets left.');
	await waitFor(() => h.server.checkedOf(1).has(SONG_D.id), 'part 2\'s banked song');
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F513} `ZackPlex` **Road Trip Part 2** unlocked, 1 check sent']);
	assert.deepStrictEqual(playlistLines(h, key, 'locked'), ['Road Trip', '\u2022 Road Trip Part 1 (Song A, \u6771\u4eac and Short One) \u00B7 7m \u00B7 opened by Road Trip: Next 3 Songs']);

	await receiveCopy(h, key, 1);
	assert.deepStrictEqual(playlistLines(h, key, 'locked'), []);
});

test('the autoskip skips a song while the copies have not reached its part, and plays it once they have', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	const check = h.bot.autoskip;
	assert.strictEqual(typeof check, 'function');
	assert.ok(check(SONG_A_VOICE, [OWNER]), 'part 1 before any copy');
	assert.ok(check(SONG_D_VOICE, [OWNER]), 'part 2 before any copy');

	await receiveCopy(h, key, 1);
	assert.strictEqual(check(SONG_A_VOICE, [OWNER]), null, 'the first copy opened part 1');
	assert.ok(check(SONG_D_VOICE, [OWNER]), 'part 2 waits for the second copy');

	await receiveCopy(h, key, 2);
	assert.strictEqual(check(SONG_D_VOICE, [OWNER]), null, 'the second copy opened part 2');
});
