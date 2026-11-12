// helpers/apMediaGame.js: the Plex Media orchestrator, from something watched or heard to a check the
// room registers, and the lifecycle around it.
//
// What has to hold: every source (Plex history and sessions, the bot's voice, its audiobooks, a
// manual credit) earns exactly the slot's own location ids; a repeat writes and says nothing; credit
// from before the seed counts for nothing; a locked title banks (or, under 'ignore', earns nothing),
// and nothing is decided locked before the slot's inventory is known; the goal goes out at the
// threshold and again on every Connected; a new seed, a refusal and a lost watch each stop the slot
// with one notice that names the fix; announcements are batched, escaped and never ping; and start,
// stop, the /config switch and the health check behave across a !restart.
//
// Harness: the real orchestrator (createGame) with the real ApMediaClient against
// test/helpers/apMediaServer.js on a loopback port, serving test/fixtures/apmedia/slot_data_mixed.json
// (generated_at 1731300000, so every event here is dated after it); the real apMediaStore in memory
// (createApMediaStore under the test runner with no env var); the real apMediaWatch, apMediaVoice and
// apMediaBooks over a fake PMS, a fake bot (an EventEmitter with a book engine stand-in) and fake
// bookmarks and catalog; a fake monitor with the archipelagoMonitor accessors the game reads; a fake
// Discord client that records every post; and injected timers fired by hand, so no poll or batch
// runs on its own. Reconnects run the client's own reconnect at once (reconnectNow), never its 5 s
// backoff.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const contracts = require('../helpers/apMediaContracts.js');
const { createGame, commandCode } = require('../helpers/apMediaGame.js');
const { createApMediaStore } = require('../helpers/apMediaStore.js');
const { startApMediaServer } = require('./helpers/apMediaServer.js');
const { waitFor } = require('./helpers/apServer.js');
const FIXTURE = require('./fixtures/apmedia/slot_data_mixed.json');

const SLOT = 'ZackPlex';
const SEED = 'Seed_PLEX';
const OWNER = '100000000000000009';
const FRIEND = '100000000000000001';
const CHANNEL = '200000000000000001';
const AFTER = (FIXTURE.generated_at + 86400) * 1000;
const ALL_LOCATIONS = Array.from({ length: 86 }, (_, i) => contracts.checkId(i + 1));
const loc = (j) => contracts.checkId(j);
const unit = (i) => contracts.unlockId(i);
const WILD = contracts.IDS.wildTicket;
const MATRIX = { rk: 2001, ids: [47, 48, 49, 50, 51, 52, 53, 54, 55].map(loc) };
const HALLOWEEN = { key: 'movie|rk:2002', ids: [56, 57, 58, 59, 60, 61, 62].map(loc) };
const N1917 = { rk: 2004, unit: unit(10), ids: [70, 71, 72, 73, 74, 75, 76, 77].map(loc) };
const START = [unit(7), unit(8), unit(9)].map((item) => ({ item, flags: 1 }));
const ROOM = { known: true, slots: { [SLOT]: 'Plex Media', Watcher: 'ChecksFinder' } };

function slotData(changes = {}) {
	return { ...JSON.parse(JSON.stringify(FIXTURE)), ...changes };
}

function quietLogger() {
	const lines = [];
	const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
	return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

// Timers that run only when a test fires them.
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
		delays: () => [...pending.values()].map((p) => p.ms),
		fire(ms) {
			for (const [id, p] of [...pending]) {
				if (ms !== undefined && p.ms !== ms) continue;
				if (!p.every) pending.delete(id);
				p.fn();
			}
		},
	};
}

function fakeMonitor(watches, room) {
	const map = new Map();
	const listeners = new Set();
	let hints = [];
	const mon = {
		room,
		getWatch: (id) => map.get(Number(id)) || null,
		describeSlot(watchId, name) {
			if (!map.has(Number(watchId))) return null;
			if (!mon.room || !mon.room.known) return { known: false, canonical: null, slotId: null, game: null };
			const names = Object.keys(mon.room.slots);
			const canonical = names.find((n) => n.toLowerCase() === String(name).trim().toLowerCase()) || null;
			return { known: true, canonical, slotId: canonical ? names.indexOf(canonical) + 1 : null, game: canonical ? mon.room.slots[canonical] : null };
		},
		onWatchChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		listHints: (id) => (map.has(Number(id)) ? hints : null),
		listClaims: () => [],
		setHints(list) { hints = list; },
		set(id, watch) { map.set(id, { id, channelId: CHANNEL, password: null, ...watch }); },
		put(id, watch, change) {
			mon.set(id, watch);
			emit(id, change);
		},
		drop(id, change = 'removed') {
			map.delete(id);
			emit(id, change);
		},
		listenerCount: () => listeners.size,
	};
	function emit(id, change) {
		for (const fn of [...listeners]) fn({ watchId: id, change, watch: map.get(id) || null });
	}
	for (const [id, watch] of Object.entries(watches)) mon.set(Number(id), watch);
	return mon;
}

function fakeConfigStore() {
	const listeners = new Set();
	return {
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		fire(key, value) { for (const fn of [...listeners]) fn(key, value); },
		count: () => listeners.size,
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
	const pms = {
		rows: [],
		meta: {},
		sessionRows: [],
		fail: null,
		metadataCalls: [],
		playlistReads: 0,
		async playlists() {
			pms.playlistReads += 1;
			if (pms.fail) throw new Error(pms.fail);
			return [{ ratingKey: '501', title: 'Road Trip', playlistType: 'audio', leafCount: 30 }];
		},
		async history({ accountId, since, start = 0, size = 300 }) {
			if (pms.fail) throw new Error(pms.fail);
			const all = pms.rows.filter((r) => Number(r.accountID) === Number(accountId) && Number(r.viewedAt) >= Number(since));
			return { rows: all.slice(start, start + size), total: all.length };
		},
		async sessions() { return pms.sessionRows; },
		async accounts() { return [{ id: 1, name: 'Owner' }, { id: 7, name: 'Friend' }]; },
		async metadata(rk) {
			pms.metadataCalls.push(Number(rk));
			return pms.meta[rk] ?? null;
		},
	};
	return pms;
}

function fakeBot() {
	const bot = new EventEmitter();
	bot.inVoice = new Set();
	bot.client = { guilds: { cache: new Map([['g1', { id: 'g1' }]]) } };
	bot.voiceListeners = () => [...bot.inVoice];
	const engine = {
		listeners: new Set(),
		list: [],
		positions: new Map(),
		sessions: () => engine.list,
		position: (s) => engine.positions.get(s.id) ?? 0,
		onChange(fn) {
			engine.listeners.add(fn);
			return () => engine.listeners.delete(fn);
		},
	};
	bot.books = engine;
	return bot;
}

function baseConfig(changes = {}) {
	return {
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
		...changes,
	};
}

async function setup(t, options = {}) {
	const {
		sd = slotData(),
		start = START,
		server: serverOptions = {},
		config: configChanges = {},
		watch = {},
		room = ROOM,
		startGame = true,
	} = options;
	const server = await startApMediaServer({
		slotData: { 1: sd },
		locations: { 1: ALL_LOCATIONS },
		startInventory: { 1: start },
		...serverOptions,
	});
	t.after(() => server.close());
	const h = {
		server,
		config: baseConfig(configChanges),
		monitor: fakeMonitor({ 0: { target: server.target, ...watch } }, room),
		store: createApMediaStore(),
		discord: fakeDiscord(),
		timers: handTimers(),
		watcherTimers: handTimers(),
		booksTimers: handTimers(),
		configStore: fakeConfigStore(),
		pms: fakePms(),
		logger: quietLogger(),
		bot: fakeBot(),
		bookmarks: null,
		catalog: { works: {}, work: (id) => h.catalog.works[id] || null },
		events: [],
		clock: AFTER + 3600000,
	};
	h.bookmarks = { marks: new Map(), forUser: (id) => h.bookmarks.marks.get(String(id)) || [] };
	h.game = createGame({
		store: h.store,
		monitor: h.monitor,
		config: h.config,
		configStore: h.configStore,
		pms: h.pms,
		timers: h.timers,
		watcherTimers: h.watcherTimers,
		booksTimers: h.booksTimers,
		logger: h.logger,
		bookmarks: h.bookmarks,
		catalogStore: h.catalog,
		commandLog: { recordEvent: (kind, detail) => h.events.push({ kind, ...detail }) },
		voiceDefer: (fn) => fn(),
		now: () => h.clock,
	});
	t.after(() => h.game.stop());
	if (startGame) h.game.start({ discord: h.discord, bot: h.bot });
	return h;
}

const runtime = (h, key) => h.game._internal.runtime(key);
const row = (h, key) => h.game.status(key).bindings[0];
const sentChecks = (h) => h.server.received.filter((p) => p.cmd === 'LocationChecks');

async function linkSlot(h, { user = OWNER, slot = SLOT } = {}) {
	const res = await h.game.link({ watchId: 0, slot, userId: user, by: OWNER });
	assert.ok(res.ok, res.message);
	const key = res.binding.key;
	await waitFor(() => row(h, key).inventoryKnown, 'the slot inventory');
	await h.game._internal.idle();
	return key;
}

async function posts(h) {
	await h.game._internal.idle();
	await h.game._internal.flushAll();
	return h.discord.posts.map((p) => p.content);
}

async function settledPosts(h) {
	const all = await posts(h);
	h.discord.posts.length = 0;
	return all;
}

async function receive(h, key, item) {
	h.server.pushItems(1, [{ item, location: 999, player: 2, flags: 1 }]);
	await waitFor(() => {
		const counts = runtime(h, key) && runtime(h, key).counts;
		return counts && (item === WILD ? counts.wild > 0 : counts.units.get(item) > 0);
	}, `item ${item}`);
	await h.game._internal.idle();
}

const historyEvent = (rk, extra = {}) => ({ type: 'complete', source: 'history', accountId: 1, ratingKey: rk, at: AFTER, ...extra });

function hasAll(set, ids) {
	return ids.every((id) => set.has(id));
}

// The backoff timer's own callback, run now rather than seconds from now.
function reconnectNow(client) {
	clearTimeout(client.reconnectTimer);
	return client._open();
}

// --- the credit pipeline ----------------------------------------------------------------

test('a Plex history row credits the title\'s own ids and the room registers them', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	h.pms.rows.push({ historyKey: '/status/sessions/history/1', ratingKey: '2001', viewedAt: AFTER / 1000, accountID: 1, librarySectionID: '3' });

	await h.game._internal.watcher().pollHistory();
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the Matrix checks');
	await waitFor(() => row(h, key).pending === 0, 'the pending list to empty');

	assert.deepStrictEqual([...h.server.checkedOf(1)].sort(), [...MATRIX.ids].sort(), 'its watch and every checkpoint, nothing else');
	assert.strictEqual(h.server.statuses.get(1), undefined, 'one title of the 15 the goal needs sends no goal');
	assert.strictEqual(row(h, key).goalSent, false);
	assert.deepStrictEqual(h.timers.delays(), [5000], 'one batch for archipelagoBatchSeconds');
	const [message] = await posts(h);
	assert.strictEqual(message, '\u2705 `ZackPlex` watched **The Matrix (1999)**, 9 checks sent');
	assert.deepStrictEqual(h.discord.posts[0].allowedMentions, { parse: [] });
	assert.strictEqual(h.discord.posts[0].channelId, CHANNEL, 'the watch\'s own channel');
	assert.deepStrictEqual(row(h, key).lastCredit, { at: AFTER, title: 'The Matrix (1999)' });
	assert.ok(h.events.some((e) => e.kind === 'apmedia-credit' && e.sent === 9));
});

test('a repeat writes nothing, sends nothing and says nothing, for a title sent and for one waiting in the bank', async (t) => {
	// 'all' also announces banked and checkpoint-only credit, so a repeat that got through would post.
	const h = await setup(t, { config: { apMediaAnnounce: 'all' } });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids) && row(h, key).pending === 0, 'the first credit');
	assert.strictEqual(row(h, key).banked, N1917.ids.length, '1917 is locked, so its checks wait in the bank');
	await settledPosts(h);
	const before = sentChecks(h).length;
	let writes = 0;
	const patch = h.store.bindings.patch;
	h.store.bindings.patch = (...args) => {
		writes += 1;
		return patch(...args);
	};

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk, { at: AFTER + 60000 }));
	await h.game._internal.handleEvent({ type: 'span', source: 'session', accountId: 1, ratingKey: MATRIX.rk, fromMs: 0, toMs: 8000000, at: AFTER });
	await h.game._internal.handleEvent(historyEvent(N1917.rk, { at: AFTER + 60000 }));
	await h.game._internal.handleEvent(historyEvent(N1917.rk, { at: AFTER + 120000 }));
	await h.game._internal.handleEvent({ type: 'span', source: 'session', accountId: 1, ratingKey: N1917.rk, fromMs: 0, toMs: 7000000, at: AFTER });
	await h.game._internal.idle();

	assert.strictEqual(writes, 0, 'no store write');
	assert.strictEqual(sentChecks(h).length, before, 'no LocationChecks');
	assert.strictEqual(row(h, key).banked, N1917.ids.length);
	assert.strictEqual(h.timers.pending.size, 0, 'no announcement batch');
	assert.deepStrictEqual(await posts(h), []);
});

test('an event from before the seed was generated counts for nothing, and one at that very moment counts', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	const before = sentChecks(h).length;
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk, { at: FIXTURE.generated_at * 1000 - 1 }));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).pending, 0);
	assert.strictEqual(row(h, key).banked, 0);
	assert.strictEqual(sentChecks(h).length, before);

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk, { at: FIXTURE.generated_at * 1000 }));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the credit dated generated_at itself');
});

test('a locked title banks its checks, and they go out when its unlock arrives', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, N1917.ids.length);
	assert.strictEqual(row(h, key).pending, 0);
	assert.ok(!N1917.ids.some((id) => h.server.checkedOf(1).has(id)), 'nothing sent while locked');
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F512} `ZackPlex` watched **1917**, 8 checks waiting for its unlock']);

	await receive(h, key, N1917.unit);
	await waitFor(() => hasAll(h.server.checkedOf(1), N1917.ids), 'the released checks');
	await waitFor(() => row(h, key).banked === 0 && row(h, key).pending === 0, 'the bank to empty');
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F513} `ZackPlex` **1917** unlocked, 8 checks sent']);
});

test('under locked_watches ignore a locked title earns nothing, however often it is seen', async (t) => {
	const h = await setup(t, { sd: slotData({ locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const before = sentChecks(h).length;
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.handleEvent(historyEvent(N1917.rk, { at: AFTER + 1000 }));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, 0);
	assert.strictEqual(row(h, key).pending, 0);
	assert.strictEqual(sentChecks(h).length, before);
	assert.deepStrictEqual(await posts(h), []);
});

test('credit before the slot\'s inventory is known is held, then sorted out by its first items', async (t) => {
	const h = await setup(t, { startGame: false, watch: { target: { kind: 'direct', host: '127.0.0.1', port: 9 } } });
	const sd = slotData();
	h.store.cache.write(SEED, SLOT, sd);
	const key = h.store.bindings.put({ watchId: 0, slot: SLOT, userId: OWNER, seedName: SEED }).key;
	h.game.start({ discord: h.discord, bot: h.bot });
	await h.game._internal.idle();
	const unreachable = runtime(h, key).client;
	assert.ok(unreachable, 'a client for the unreachable room');

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).inventoryKnown, false);
	assert.strictEqual(row(h, key).banked, MATRIX.ids.length + N1917.ids.length, 'everything held, nothing dropped');
	assert.deepStrictEqual(await posts(h), [], 'nothing announced before the room says what is done');

	h.monitor.put(0, { target: h.server.target }, 'repointed');
	await waitFor(() => row(h, key).inventoryKnown, 'the inventory from the re-pointed room');
	assert.notStrictEqual(runtime(h, key).client, unreachable, 'a fresh client for the new address');
	assert.strictEqual(unreachable.stopped, true);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the open title\'s checks');
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, N1917.ids.length, 'the locked title stays banked');
	const said = await posts(h);
	assert.ok(said[0].includes('\u2705 `ZackPlex` watched **The Matrix (1999)**, 9 checks sent'), said[0]);
	assert.ok(said[0].includes('\u{1F512} `ZackPlex` watched **1917**, 8 checks waiting for its unlock'), said[0]);
	assert.ok(!said.join('\n').includes('unlocked'), 'the open title was never locked');
});

test('under ignore, credit held while the inventory was unknown keeps the open title and drops the locked one', async (t) => {
	const h = await setup(t, { startGame: false, sd: slotData({ locked_watches: 'ignore' }), watch: { target: { kind: 'direct', host: '127.0.0.1', port: 9 } } });
	h.store.cache.write(SEED, SLOT, slotData({ locked_watches: 'ignore' }));
	const key = h.store.bindings.put({ watchId: 0, slot: SLOT, userId: OWNER, seedName: SEED }).key;
	h.game.start({ discord: h.discord, bot: h.bot });
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, MATRIX.ids.length + N1917.ids.length, 'nothing decided before the inventory is known');

	h.monitor.put(0, { target: h.server.target }, 'repointed');
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the open title\'s checks');
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, 0, 'the locked title\'s credit is dropped, not kept');
	assert.ok(!N1917.ids.some((id) => h.server.checkedOf(1).has(id)));
	assert.ok(!(await posts(h)).join('\n').includes('1917'));
});

test('voice listening credits the track heard and the album checkpoint it passed', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	h.bot.inVoice.add(OWNER);
	const heard = (entry, heardMs) => h.bot.emit('track-heard', {
		entry, heardMs, natural: true, guildId: 'g1', channelId: 'vc1', startListeners: [OWNER, FRIEND],
	});

	heard({ ratingKey: 23001, duration: 320000, artist: 'Daft Punk', title: 'One More Time', key: '/library/parts/230001/1/file.mp3' }, 300000);
	await waitFor(() => hasAll(h.server.checkedOf(1), [loc(1), loc(4)]), 'the track and the 5-minute checkpoint');
	await h.game._internal.idle();
	assert.ok(!h.server.checkedOf(1).has(loc(2)), 'one song is not the album');

	const before = sentChecks(h).length;
	heard({ ratingKey: 999999, duration: 200000, artist: 'Nobody', title: 'Not On The List', key: '/library/parts/1/1/x.mp3' }, 200000);
	heard({ ratingKey: 23002, duration: 212000, artist: 'Daft Punk', title: 'Aerodynamic', key: '/library/parts/230002/1/file.mp3' }, 20000);
	await h.game._internal.idle();
	assert.strictEqual(sentChecks(h).length, before, 'a track off the list, and one cut short before any checkpoint, earn nothing');
});

// The bug: voice credit was a whole track or nothing, so a track skipped after it played past an album
// checkpoint earned nothing, while the same stretch played through Plexamp earned it.
test('a voice listen cut short earns the album checkpoints it played past, from where it started', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(1));
	h.bot.inVoice.add(OWNER);
	// Discovery's 10-minute checkpoint lies 53 s into its fourth track.
	const digitalLove = { ratingKey: 23004, duration: 301000, artist: 'Daft Punk', title: 'Digital Love', key: '/library/parts/230004/1/file.mp3' };
	const heard = (heardMs, startMs) => h.bot.emit('track-heard', {
		entry: digitalLove, heardMs, startMs, natural: false, guildId: 'g1', channelId: 'vc1', startListeners: [OWNER],
	});

	const before = sentChecks(h).length;
	heard(30000, 60000);
	await h.game._internal.idle();
	assert.strictEqual(sentChecks(h).length, before, 'after a !seek to 1:00, 30 s plays past no checkpoint');
	heard(90000, 0);
	await waitFor(() => h.server.checkedOf(1).has(loc(5)), 'the 10-minute checkpoint');
	assert.ok(!h.server.checkedOf(1).has(loc(3)), 'a track cut short is not heard');
	assert.ok(!h.server.checkedOf(1).has(loc(4)), 'nor the checkpoint before the track');
});

test('a finished audiobook credits its finish and checkpoints through an old work id, and a book span its checkpoint', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await receive(h, key, unit(4));
	const BOOK = [12, 13, 14, 15].map(loc);
	h.catalog.works['austen-v2'] = { id: 'austen-v2', aliases: ['jane-austen/pride-and-prejudice'] };
	h.bookmarks.marks.set(OWNER, [{ workId: 'austen-v2', finished: true, finishedAt: AFTER }]);

	h.booksTimers.fire(60000);
	await waitFor(() => hasAll(h.server.checkedOf(1), BOOK), 'the finish and its checkpoints');
	await waitFor(() => row(h, key).pending === 0, 'the pending list to empty');
	let writes = 0;
	let reads = 0;
	const patch = h.store.bindings.patch;
	h.store.bindings.patch = (...args) => {
		writes += 1;
		return patch(...args);
	};
	const forUser = h.bookmarks.forUser;
	h.bookmarks.forUser = (id) => {
		reads += 1;
		return forUser(id);
	};
	h.booksTimers.fire(60000);
	await waitFor(() => reads === 1, 'the next finish poll');
	await new Promise((resolve) => setTimeout(resolve, 30));
	await h.game._internal.idle();
	assert.strictEqual(writes, 0, 'the minutely repeat of a finished bookmark is free');
	h.store.bindings.patch = patch;
	h.bookmarks.forUser = forUser;

	await receive(h, key, unit(3));
	h.bot.books.list = [{ id: 's1', userId: OWNER, workId: 'j-r-r-tolkien/the-hobbit', state: 'playing', speed: 1 }];
	h.bot.books.positions.set('s1', 29 * 60000 + 55000);
	h.bookmarks.marks.set(OWNER, []);
	h.booksTimers.fire(60000);
	h.clock += 10000;
	h.bot.books.positions.set('s1', 30 * 60000 + 5000);
	h.booksTimers.fire(10000);
	await waitFor(() => h.server.checkedOf(1).has(loc(8)), 'the Hobbit\'s 30-minute checkpoint');
	assert.ok(!h.server.checkedOf(1).has(loc(9)), 'only the checkpoint the span passed');
	assert.ok(!h.server.checkedOf(1).has(loc(7)), 'and not the finish');
});

test('a ratingKey the list does not hold is placed through its Plex metadata, and a miss is read and logged once', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	h.pms.meta[9001] = { type: 'movie', guid: 'plex://movie/5d7768b2', title: 'The Matrix' };
	await h.game._internal.handleEvent(historyEvent(9001));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the Matrix through its guid');
	assert.strictEqual(row(h, key).lastCredit.title, 'The Matrix (1999)');

	await h.game._internal.handleEvent(historyEvent(9002));
	await h.game._internal.handleEvent(historyEvent(9002, { at: AFTER + 5000 }));
	assert.deepStrictEqual(h.pms.metadataCalls.filter((rk) => rk === 9002), [9002], 'one metadata read per unmatched ratingKey');
	assert.strictEqual(h.logger.lines.filter((l) => l.text.includes('ratingKey 9002')).length, 1, 'logged once');

	h.pms.meta[9003] = { type: 'track', parentGuid: 'plex://album/2300', index: 2, title: 'Aerodynamic' };
	await receive(h, key, unit(1));
	await h.game._internal.handleEvent({ type: 'complete', source: 'history', accountId: 1, ratingKey: 9003, at: AFTER });
	await waitFor(() => h.server.checkedOf(1).has(loc(2)), 'the twin copy\'s track 2');
});

test('the goal goes out at the threshold and again on every Connected, and is never announced', async (t) => {
	const h = await setup(t, { sd: slotData({ goal_count: 1 }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await waitFor(() => h.server.statuses.get(1) === contracts.CLIENT_GOAL, 'the goal');
	await waitFor(() => row(h, key).goalSent, 'goalSent');
	const goals = () => h.server.received.filter((p) => p.cmd === 'StatusUpdate' && p.status === contracts.CLIENT_GOAL).length;
	assert.strictEqual(goals(), 1);

	const client = runtime(h, key).client;
	for (const socket of h.server.clientsOn(1)) socket.socket.terminate();
	await waitFor(() => !client.connected, 'the drop');
	reconnectNow(client);
	await waitFor(() => goals() === 2, 'the goal again on the next Connected');
	await waitFor(() => client.inventoryKnown, 'the reconnect settled');
	assert.deepStrictEqual(await posts(h), ['\u2705 `ZackPlex` watched **The Matrix (1999)**, 9 checks sent'],
		'no goal line: the relay posts the room\'s own Goal line');
	assert.ok(h.events.filter((e) => e.kind === 'apmedia-goal').length === 1);
});

test('manual credit: with a time the checkpoints up to it, without one the whole title', async (t) => {
	const h = await setup(t, { config: { apMediaAnnounce: 'all' } });
	const key = await linkSlot(h);
	await settledPosts(h);

	const ambiguous = await h.game.creditManual(key, 'Halloween (2018)');
	assert.strictEqual(ambiguous.ok, false);
	assert.strictEqual(ambiguous.candidates.length, 2);

	const badTime = await h.game.creditManual(key, HALLOWEEN.key, { atMs: 'soon' });
	assert.strictEqual(badTime.ok, false);
	const partial = await h.game.creditManual(key, HALLOWEEN.key, { atMs: '31m' });
	assert.ok(partial.ok, partial.message);
	assert.strictEqual(partial.sent, 2);
	await waitFor(() => hasAll(h.server.checkedOf(1), [loc(57), loc(58)]), 'the 15 and 30 minute checkpoints');
	assert.ok(!h.server.checkedOf(1).has(loc(56)), 'not the watch');
	assert.deepStrictEqual(await settledPosts(h), ['\u23F1\uFE0F `ZackPlex` **Halloween (2018)**: 2 checks sent']);

	const whole = await h.game.creditManual(key, HALLOWEEN.key);
	assert.strictEqual(whole.sent, 5, 'the watch and the four checkpoints left');
	await waitFor(() => hasAll(h.server.checkedOf(1), HALLOWEEN.ids), 'the rest');
	assert.deepStrictEqual(await settledPosts(h), ['\u2705 `ZackPlex` watched **Halloween (2018)**, 5 checks sent']);

	const again = await h.game.creditManual(key, HALLOWEEN.key);
	assert.ok(again.ok);
	assert.strictEqual(again.sent, 0);
	assert.match(again.message, /counted already/);
});

test('a Wild Ticket opens a locked title and sends its banked checks; without one, nothing is spent', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	const none = await h.game.redeem(key, '1917');
	assert.strictEqual(none.ok, false);
	assert.match(none.message, /no Wild Ticket/);

	await receive(h, key, WILD);
	assert.deepStrictEqual(row(h, key).wildTickets, { received: 1, used: 0, available: 1 });
	await settledPosts(h);
	const spent = await h.game.redeem(key, '1917');
	assert.ok(spent.ok, spent.message);
	assert.strictEqual(spent.released, N1917.ids.length);
	assert.strictEqual(spent.ticketsLeft, 0);
	await waitFor(() => hasAll(h.server.checkedOf(1), N1917.ids), 'the banked checks');
	assert.deepStrictEqual(row(h, key).wildTickets, { received: 1, used: 1, available: 0 });
	assert.deepStrictEqual(await settledPosts(h), ['\u{1F513} `ZackPlex` **1917** unlocked, 8 checks sent']);

	const open = await h.game.redeem(key, '1917');
	assert.strictEqual(open.ok, false, 'done already');
	const broke = await h.game.redeem(key, 'Popcorn');
	assert.strictEqual(broke.ok, false);
	assert.match(broke.message, /no Wild Ticket/);
});

test('announcements batch per channel for archipelagoBatchSeconds, escape titles and never ping', async (t) => {
	const sd = slotData();
	sd.entries[0].t = 'M*A*S*H @everyone';
	const h = await setup(t, {
		sd,
		server: { slots: [{ name: 'Zack`Plex', game: 'Plex Media' }, { name: 'Watcher', game: 'ChecksFinder' }] },
		room: { known: true, slots: { 'Zack`Plex': 'Plex Media', Watcher: 'ChecksFinder' } },
	});
	const key = await linkSlot(h, { slot: 'Zack`Plex' });
	const [welcome] = await settledPosts(h);
	assert.ok(welcome.startsWith('\u{1F3AC} `Zack\'Plex` is in the game'), welcome);
	assert.ok(welcome.endsWith('``!ap claim Zack`Plex``, then ``!ap hintpings Zack`Plex dm``.'), 'the commands keep the exact name');
	h.config.archipelagoBatchSeconds = 2;

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.handleEvent(historyEvent(2002));
	await h.game._internal.idle();
	assert.deepStrictEqual(h.timers.delays(), [2000], 'one batch, its length read when it started');
	assert.strictEqual(h.discord.posts.length, 0);
	h.timers.fire(2000);
	await h.game._internal.flushAll();
	assert.strictEqual(h.discord.posts.length, 1, 'one message for both');
	const [message] = h.discord.posts;
	assert.deepStrictEqual(message.allowedMentions, { parse: [] });
	assert.deepStrictEqual(message.content.split('\n'), [
		'\u2705 `Zack\'Plex` watched **M\\*A\\*S\\*H @everyone (1999)**, 9 checks sent',
		'\u2705 `Zack\'Plex` watched **Halloween (2018)**, 7 checks sent',
	]);
	assert.strictEqual(row(h, key).slot, 'Zack`Plex');

	h.discord.posts.length = 0;
	h.config.apMediaChannelId = '200000000000000002';
	await h.game._internal.handleEvent(historyEvent(2003));
	assert.strictEqual((await posts(h)).length, 1);
	assert.strictEqual(h.discord.posts[0].channelId, '200000000000000002', 'apMediaChannelId, read at post time');
	h.discord.posts.length = 0;

	await h.game.setAnnounce(key, false);
	await h.game.creditManual(key, '#5');
	h.config.apMediaAnnounce = 'off';
	await h.game.setAnnounce(key, true);
	await h.game.creditManual(key, '#6');
	assert.deepStrictEqual(await posts(h), [], 'the binding\'s own switch and apMediaAnnounce off');
});

// The bug: escapeMarkdown leaves a masked link working, and a player can write any title into the
// YAML they hand in: the welcome and the credit lines posted a clickable [text](url) as the bot.
test('a title written as a masked link is posted as plain text, every link of it', async (t) => {
	const sd = slotData();
	sd.entries[0].t = '[Free Nitro](https://evil.example/claim) [again](https://evil.example/2)';
	const h = await setup(t, { sd });
	const key = await linkSlot(h);
	const [welcome] = await settledPosts(h);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	const [credit] = await settledPosts(h);
	for (const text of [welcome, credit]) {
		assert.ok(text.includes('\\[Free Nitro](https://evil.example/claim) \\[again](https://evil.example/2) (1999)'), text);
		assert.doesNotMatch(text, /(^|[^\\])\[(Free Nitro|again)\]\(/, 'no bracket left that opens a link');
	}
	assert.strictEqual(row(h, key).lastCredit.title, '[Free Nitro](https://evil.example/claim) [again](https://evil.example/2) (1999)', 'stored as it is');
});

function bigSlotData(n) {
	const unitId = unit(7);
	const entries = Array.from({ length: n }, (_, i) => ({
		k: 'movie', id: `plex://movie/big${i + 1}`, rk: 30001 + i, t: `Big Movie ${i + 1}`, y: 2000, d: 6000000, u: unitId, s: 1, w: contracts.checkId(101 + i), cp: [],
	}));
	return slotData({ entries, entry_count: n, goal_count: n + 10, units: [{ id: unitId, name: 'Big', kind: 'movie', steps: 1, start: 1 }] });
}

async function bigSetup(t, n, options = {}) {
	return setup(t, {
		sd: bigSlotData(n),
		start: [{ item: unit(7), flags: 1 }],
		server: { locations: { 1: Array.from({ length: n }, (_, i) => contracts.checkId(101 + i)) } },
		...options,
	});
}

// The bug: the 200-line cap meant for lines held without a Discord client trimmed every batch, so a
// backfill or a first history pass bringing 200 lines into one batch dropped the oldest unannounced.
test('a running batch posts every line, and only lines held without a Discord client are capped, with a warning', async (t) => {
	const N = 205;
	const live = await bigSetup(t, N);
	await linkSlot(live);
	await settledPosts(live);
	for (let i = 0; i < N; i++) await live.game._internal.handleEvent(historyEvent(30001 + i));
	const lines = (await posts(live)).join('\n').split('\n').filter((l) => l.includes('Big Movie'));
	assert.strictEqual(lines.length, N, 'every credit line of the batch');
	assert.match(lines[0], /\*\*Big Movie 1 \(2000\)\*\*/);
	assert.ok(!live.logger.lines.some((l) => /dropped/.test(l.text)));

	const held = await bigSetup(t, N, { startGame: false });
	held.game.start({ discord: null, bot: held.bot });
	await linkSlot(held);
	for (let i = 0; i < N; i++) await held.game._internal.handleEvent(historyEvent(30001 + i));
	assert.strictEqual(held.discord.posts.length, 0);
	held.game.start({ discord: held.discord, bot: held.bot });
	const kept = (await posts(held)).join('\n').split('\n').filter((l) => l.startsWith('\u2705'));
	assert.strictEqual(kept.length, 200, 'at most 200 lines wait for a client');
	assert.match(kept[0], /Big Movie 6 \(2000\)/, 'the welcome and the 5 oldest credits went');
	assert.ok(held.logger.lines.some((l) => l.level === 'warn' && /dropped the oldest 6 lines for channel/.test(l.text)), 'and the log says so');
});

test('a batch a stop holds before it went out is capped at 200 lines too', async (t) => {
	const N = 205;
	const h = await bigSetup(t, N);
	await linkSlot(h);
	await settledPosts(h);
	for (let i = 0; i < N; i++) await h.game._internal.handleEvent(historyEvent(30001 + i));
	h.game.stop();
	assert.strictEqual(h.discord.posts.length, 0, 'the batch had not gone out');
	h.game.start({ discord: h.discord, bot: h.bot });
	const kept = (await posts(h)).join('\n').split('\n').filter((l) => l.startsWith('\u2705'));
	assert.strictEqual(kept.length, 200);
	assert.match(kept[0], /Big Movie 6 \(2000\)/);
	assert.ok(h.logger.lines.some((l) => l.level === 'warn' && /dropped the oldest 5 lines for channel/.test(l.text)));
});

// The bug: a send cut short by a stop put its unsent chunks back whole, each up to 1,900 characters
// of lines, so the 200-line cap and the dropped count counted chunks.
test('lines a stop cuts off mid-send go back a line at a time, under the same cap', async (t) => {
	const N = 300;
	const h = await bigSetup(t, N);
	await linkSlot(h);
	await settledPosts(h);
	const first = [];
	const cut = {
		channels: {
			fetch: async (id) => ({
				id,
				send: async (payload) => {
					if (first.length) throw new Error('the client was destroyed');
					first.push(payload.content);
					h.game.stop();
					return {};
				},
			}),
		},
	};
	h.game.start({ discord: cut, bot: h.bot });
	for (let i = 0; i < N; i++) await h.game._internal.handleEvent(historyEvent(30001 + i));
	await h.game._internal.flushAll();

	const sent = first.join('\n').split('\n').filter((l) => l.startsWith('\u2705')).length;
	assert.ok(sent > 0 && sent < 100, `one chunk went out: ${sent} lines`);
	h.game.start({ discord: h.discord, bot: h.bot });
	const rest = (await posts(h)).join('\n').split('\n').filter((l) => l.startsWith('\u2705'));
	const dropped = N - sent - 200;
	assert.strictEqual(rest.length, 200, 'the cap counts lines');
	assert.match(rest[0], new RegExp(`Big Movie ${sent + dropped + 1} \\(2000\\)`));
	assert.ok(h.logger.lines.some((l) => l.level === 'warn' && new RegExp(`dropped the oldest ${dropped} lines for channel`).test(l.text)));
});

test('setAnnounce takes on or off in the usual words, and refuses anything else without a change', async (t) => {
	const h = await setup(t, { startGame: false });
	const key = h.store.bindings.put({ watchId: 0, slot: SLOT, userId: OWNER }).key;
	const set = async (value) => {
		const res = await h.game.setAnnounce(key, value);
		assert.ok(res.ok, `${JSON.stringify(value)}: ${res.message}`);
		return h.store.bindings.get(key).announce;
	};
	assert.strictEqual(await set('off'), false);
	assert.strictEqual(await set('ON'), true);
	assert.strictEqual(await set(' no '), false);
	assert.strictEqual(await set('yes'), true);
	assert.strictEqual(await set('false'), false);
	assert.strictEqual(await set('1'), true);
	assert.strictEqual(await set(0), false);
	assert.strictEqual(await set(true), true);
	for (const value of ['maybe', '', '2', null, undefined, 2, {}]) {
		const res = await h.game.setAnnounce(key, value);
		assert.strictEqual(res.ok, false, `${JSON.stringify(value)} is refused`);
		assert.strictEqual(res.message, 'Say `on` or `off`.');
	}
	assert.strictEqual(h.store.bindings.get(key).announce, true, 'a refused value changes nothing');
	assert.strictEqual((await h.game.setAnnounce('0::nobody', 'on')).ok, false);
});

test('a command shown in inline code keeps a slot name\'s backticks', () => {
	assert.strictEqual(commandCode('!ap claim ZackPlex'), '`!ap claim ZackPlex`');
	assert.strictEqual(commandCode('!ap claim Zack`Plex'), '``!ap claim Zack`Plex``');
	assert.strictEqual(commandCode('!ap claim Zack``Plex'), '```!ap claim Zack``Plex```');
	assert.strictEqual(commandCode('!ap claim Plex`'), '``!ap claim Plex` ``', 'Discord drops the space that keeps the closing fence apart');
	assert.strictEqual(commandCode('`Plex'), '`` `Plex``');
});

test('the first Connected posts one welcome naming the open titles, the Plex account and the commands', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	const [welcome] = await settledPosts(h);
	const lines = welcome.split('\n');
	assert.strictEqual(lines.length, 3);
	assert.match(lines[0], /^\u{1F3AC} `ZackPlex` is in the game with 3 of 19 titles open: The Matrix \(1999\) \(2h16m\), Halloween \(2018\) \(1h46m\), Halloween \(2018\) \(1h45m\)\. Goal: finish 15\.$/u);
	assert.match(lines[1], /none, so only Discord listening counts for now, and its 13 video titles need one/);
	assert.match(lines[2], /`\/apmedia list`/);
	assert.match(lines[2], /`!ap hintpings ZackPlex dm`/);
	assert.ok(row(h, key).wildTickets && h.store.bindings.get(key).welcomed);

	const client = runtime(h, key).client;
	for (const socket of h.server.clientsOn(1)) socket.socket.terminate();
	await waitFor(() => !client.connected, 'the drop');
	reconnectNow(client);
	await waitFor(() => client.connected && client.inventoryKnown, 'the reconnect');
	await h.game._internal.idle();
	assert.deepStrictEqual(await posts(h), [], 'once per binding');
});

// The bug: the welcome named a friend's Plex account in the game's channel, while the account list
// itself goes to the owner alone.
test('the welcome says a friend\'s Plex account is linked without naming it', async (t) => {
	const h = await setup(t);
	await h.game.linkAccount(FRIEND, { accountId: 7, name: 'alice.smith', by: OWNER });
	await h.game.grantConsent(FRIEND);
	await linkSlot(h, { user: FRIEND });
	const [welcome] = await settledPosts(h);
	assert.strictEqual(welcome.split('\n')[1], 'Plex account: linked.');
	assert.ok(!welcome.includes('alice.smith') && !welcome.includes('account 7'), welcome);

	const own = await setup(t);
	await linkSlot(own);
	const [ownerWelcome] = await settledPosts(own);
	assert.strictEqual(ownerWelcome.split('\n')[1], 'Plex account: the server owner (account 1).');
});

// --- connection outcomes ---------------------------------------------------------------

test('a room on a new seed marks the slot stale, and retry takes the new seed from scratch', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).banked, 8);
	await settledPosts(h);

	const fresh = await startApMediaServer({ seedName: 'Seed_NEW', slotData: { 1: slotData() }, locations: { 1: ALL_LOCATIONS }, startInventory: { 1: START } });
	t.after(() => fresh.close());
	h.monitor.put(0, { target: fresh.target }, 'repointed');
	await waitFor(() => row(h, key).state === 'stale', 'the stale state');
	const [notice] = await settledPosts(h);
	assert.match(notice, /^\u{1F7E1} `ZackPlex`: the room is on another seed now/u);
	assert.match(notice, /does not carry over/);
	assert.strictEqual(row(h, key).connection, 'stale');
	assert.strictEqual(runtime(h, key).client, null);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	assert.strictEqual(row(h, key).pending, 0, 'a stale slot earns nothing');

	const res = await h.game.retry(key);
	assert.ok(res.ok, res.message);
	assert.match(res.message, /does not carry over/);
	await waitFor(() => row(h, key).seedName === 'Seed_NEW' && row(h, key).inventoryKnown, 'the new seed');
	assert.strictEqual(row(h, key).banked, 0, 'the old seed\'s bank is gone');
	assert.strictEqual(row(h, key).state, 'active');
	await h.game._internal.idle();
	assert.match((await posts(h))[0], /is in the game/, 'welcomed again on the new seed');
});

test('slot_data the bot cannot index refuses the slot with one notice and keeps no copy, and a retry says so again', async (t) => {
	const sd = slotData();
	delete sd.generated_at;
	const h = await setup(t, { sd });
	const res = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER, by: OWNER });
	assert.ok(res.ok, res.message);
	const key = res.binding.key;
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');
	await h.game._internal.idle();
	const refused = row(h, key);
	assert.strictEqual(refused.stateDetail.reason, 'slot_data');
	assert.deepStrictEqual(refused.stateDetail.errors, ['slot_data has no generated_at.']);
	assert.strictEqual(refused.seedName, null, 'no seed taken from a list it cannot read');
	assert.strictEqual(refused.connection, 'refused');
	assert.strictEqual(runtime(h, key).client, null, 'its client stopped');
	assert.strictEqual(h.store.cache.has(SEED, SLOT), false, 'the unreadable copy is not cached');
	const notices = await settledPosts(h);
	assert.strictEqual(notices.length, 1);
	assert.match(notices[0], /^\u{1F534} `ZackPlex`: the room refused its Plex Media client \(`slot_data`\)\. Its slot_data is not Plex Media data this bot can read \(`slot_data has no generated_at\.`\): the seed may come from another version of the apworld\.$/u);
	assert.deepStrictEqual(h.game.health(), { status: 'error', detail: '1 slot refused (ZackPlex: slot_data)' });
	assert.ok(h.events.some((e) => e.kind === 'apmedia-refused' && e.reason === 'slot_data'));
	assert.ok(!h.logger.lines.some((l) => l.level === 'error'), 'handled, not thrown');

	const connects = () => h.server.received.filter((p) => p.cmd === 'Connect');
	const before = connects().length;
	const again = await h.game.retry(key);
	assert.ok(again.ok, again.message);
	await waitFor(() => connects().length > before && row(h, key).state === 'refused', 'the retry refused again');
	assert.strictEqual(connects().at(-1).slot_data, true, 'the retry asks the room for slot_data again');
	assert.strictEqual(runtime(h, key).client, null);
	const repeated = await settledPosts(h);
	assert.strictEqual(repeated.length, 1, 'a retry reports the refusal again');
	assert.match(repeated[0], /\(`slot_data`\)/);
});

// The bug: the refusal quoted the room's own slot_data value whole and as Markdown, in the public
// notice and in the saved fix /apmedia status shows: a room server could post any link or heading.
test('a slot_data refusal quotes the room\'s value short and in code', async (t) => {
	const sd = slotData();
	sd.game = `[Claim your Nitro](https://evil.example/claim) **@everyone** ${'x'.repeat(50)}`;
	const h = await setup(t, { sd });
	const res = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER, by: OWNER });
	await waitFor(() => row(h, res.binding.key).state === 'refused', 'the refusal');
	const quoted = '(`slot_data is for "[Claim your Nitro](https://evil.example/", not Plex Media.`)';
	const [notice] = await settledPosts(h);
	assert.ok(notice.includes(quoted), notice);
	assert.ok(row(h, res.binding.key).stateDetail.fix.includes(quoted));
	assert.ok(!notice.includes('@everyone') && !notice.includes('xxxxxxxxxx'));
});

// The bug: a binding was unique per watch, and two watches can point at one room: one slot bound
// through both credited one list with two people's watching and spent each Wild Ticket twice.
test('the same slot of a seed bound again through a second watch of the room is refused', async (t) => {
	const BOB = '100000000000000002';
	const h = await setup(t);
	h.monitor.set(1, { target: h.server.target });
	const first = await linkSlot(h, { user: FRIEND });
	await settledPosts(h);
	const second = await h.game.link({ watchId: 1, slot: 'zackplex', userId: BOB, by: OWNER });
	assert.ok(second.ok, second.message);
	await waitFor(() => row(h, second.binding.key).state === 'refused', 'the refusal');
	const twin = row(h, second.binding.key);
	assert.strictEqual(twin.stateDetail.reason, 'duplicate');
	assert.strictEqual(twin.seedName, null, 'it never takes the seed, so nothing counts for it');
	assert.strictEqual(runtime(h, second.binding.key).client, null);
	const [notice] = await settledPosts(h);
	assert.strictEqual(notice, '\u{1F534} `ZackPlex`: the room refused its Plex Media client (`duplicate`). This seed\'s `ZackPlex` is linked on watch #0 already, and only that link counts: `/apmedia unlink` this one.');
	assert.strictEqual(row(h, first).state, 'active');

	await receive(h, first, WILD);
	assert.strictEqual((await h.game.redeem(second.binding.key, '1917')).ok, false);
	assert.ok((await h.game.redeem(first, '1917')).ok, 'the first binding spends the slot\'s ticket');
	const retried = await h.game.retry(second.binding.key);
	assert.ok(retried.ok);
	await waitFor(() => row(h, second.binding.key).state === 'refused' && !runtime(h, second.binding.key).client, 'refused again');
	assert.match((await settledPosts(h))[0], /\(`duplicate`\)/, 'a retry reports it again');
	assert.strictEqual(row(h, first).state, 'active', 'and leaves the first binding alone');
});

test('a cached slot_data copy the bot cannot index is dropped before its slot connects, so the room sends its own', async (t) => {
	const h = await setup(t, { startGame: false });
	const bad = slotData();
	delete bad.generated_at;
	h.store.cache.write(SEED, SLOT, bad);
	const key = h.store.bindings.put({ watchId: 0, slot: SLOT, userId: OWNER, seedName: SEED }).key;
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => row(h, key).inventoryKnown, 'the connection with the room\'s copy');
	assert.strictEqual(row(h, key).state, 'active', 'no refusal');
	assert.deepStrictEqual(h.server.received.filter((p) => p.cmd === 'Connect').map((p) => p.slot_data), [true], 'the first Connect asked for slot_data');
	assert.strictEqual(h.store.cache.read(SEED, SLOT).generated_at, FIXTURE.generated_at, 'the room\'s copy replaced it');
	assert.ok(h.logger.lines.some((l) => l.level === 'warn' && l.text.includes('unusable, so the next connect fetches it again')));
});

test('a cached copy found unusable only on Connected is dropped too, so a retry fetches the room\'s own', async (t) => {
	// A binding with no seed yet never reads the cache before it connects, so the copy is first read there.
	const h = await setup(t, { startGame: false });
	const bad = slotData();
	delete bad.generated_at;
	h.store.cache.write(SEED, SLOT, bad);
	const key = h.store.bindings.put({ watchId: 0, slot: SLOT, userId: OWNER }).key;
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');
	assert.strictEqual(row(h, key).stateDetail.reason, 'slot_data');
	const connects = () => h.server.received.filter((p) => p.cmd === 'Connect');
	assert.strictEqual(connects()[0].slot_data, false, 'the cache said it held a copy, so the room sent none');
	assert.strictEqual(h.store.cache.has(SEED, SLOT), false, 'the copy it could not use is dropped');

	const res = await h.game.retry(key);
	assert.ok(res.ok, res.message);
	await waitFor(() => row(h, key).inventoryKnown, 'the connection with the room\'s copy');
	assert.strictEqual(row(h, key).state, 'active');
	assert.strictEqual(connects().at(-1).slot_data, true);
	assert.strictEqual(h.store.cache.read(SEED, SLOT).generated_at, FIXTURE.generated_at, 'the room\'s copy is cached');
});

test('InvalidSlot names the room\'s spelling, and retry connects with it', async (t) => {
	const h = await setup(t, { room: { known: false, slots: ROOM.slots } });
	const res = await h.game.link({ watchId: 0, slot: 'zackplex', userId: OWNER, by: OWNER });
	assert.ok(res.ok);
	assert.match(res.warnings[0], /taken as typed/);
	h.monitor.room = ROOM;
	const key = res.binding.key;
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');
	const [notice] = await settledPosts(h);
	assert.match(notice, /^\u{1F534} `zackplex`: the room refused its Plex Media client \(`InvalidSlot`\)\. The room spells it `ZackPlex`/u);
	assert.strictEqual(h.game.health().status, 'error');

	const retried = await h.game.retry(key);
	assert.match(retried.message, /`ZackPlex`/);
	await waitFor(() => row(h, key).inventoryKnown, 'the connection with the room\'s spelling');
	assert.strictEqual(row(h, key).slot, 'ZackPlex');
	assert.strictEqual(row(h, key).state, 'active');
});

test('a name linked before the room was read takes the room\'s spelling at the next connect, without a refusal', async (t) => {
	const h = await setup(t, { room: { known: false, slots: ROOM.slots } });
	h.monitor.set(0, { target: { kind: 'direct', host: '127.0.0.1', port: 9 } });
	const res = await h.game.link({ watchId: 0, slot: 'zackplex', userId: OWNER });
	h.monitor.room = ROOM;
	h.monitor.put(0, { target: h.server.target }, 'restarted');
	await waitFor(() => row(h, res.binding.key).inventoryKnown, 'the connection');
	assert.strictEqual(row(h, res.binding.key).slot, 'ZackPlex');
	assert.ok(!h.server.received.some((p) => p.cmd === 'Connect' && p.name === 'zackplex'), 'never refused');
});

test('InvalidGame says the slot plays another game', async (t) => {
	const h = await setup(t, { room: { known: false, slots: ROOM.slots } });
	const res = await h.game.link({ watchId: 0, slot: 'Watcher', userId: OWNER });
	await waitFor(() => row(h, res.binding.key).state === 'refused', 'the refusal');
	const [notice] = await settledPosts(h);
	assert.match(notice, /\(`InvalidGame`\)\. That slot plays another game in this room, not Plex Media/);
});

test('InvalidPassword points at !ap password, never shows it, says it once, and a fixed watch reconnects', async (t) => {
	const h = await setup(t, { server: { password: 'hunter2' }, watch: { password: 'old-secret' } });
	const res = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER });
	const key = res.binding.key;
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');
	const [notice] = await settledPosts(h);
	assert.match(notice, /`!ap password 0 <password>`, then `\/apmedia retry`/);
	assert.ok(!JSON.stringify(h.store.bindings.list()).includes('old-secret'), 'no password in the store');
	assert.ok(!notice.includes('old-secret'));

	const opened = h.server.connectionsOpened;
	h.game.stop();
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => h.server.connectionsOpened > opened && !runtime(h, key).client, 'start() retrying and the room refusing again');
	await h.game._internal.idle();
	assert.deepStrictEqual(await settledPosts(h), [], 'the same refusal is not announced twice');

	h.monitor.put(0, { target: h.server.target, password: 'hunter2' }, 'restarted');
	await waitFor(() => row(h, key).inventoryKnown, 'the connection with the new password');
	assert.strictEqual(row(h, key).state, 'active');
	assert.ok(!JSON.stringify(h.store.bindings.list()).includes('hunter2'));
});

test('IncompatibleVersion names the exact-version setting and the client\'s version, and start() retries the slot', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	await runtime(h, key).client._handlePacket({ cmd: 'ConnectionRefused', errors: ['IncompatibleVersion'] });
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');
	const [notice] = await settledPosts(h);
	assert.match(notice, /\(`IncompatibleVersion`\)\. The room was hosted with an exact-version compatibility setting, and the bot's client reports 0\.6\.1/);
	assert.strictEqual(row(h, key).stateDetail.reason, 'IncompatibleVersion');

	h.game.stop();
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => row(h, key).state === 'active' && row(h, key).inventoryKnown, 'start() retrying the refused slot');
	assert.strictEqual(row(h, key).stateDetail, null);
});

// The room's own words are saved with the binding and posted, and a room server can send any number
// of them at any length.
test('a room refusal is saved and posted short, however much the room sends', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	const errors = Array.from({ length: 20 }, (_, i) => `\`\`\`Error${i}${'x'.repeat(500)}`);
	await runtime(h, key).client._handlePacket({ cmd: 'ConnectionRefused', errors });
	await waitFor(() => row(h, key).state === 'refused', 'the refusal');

	const detail = row(h, key).stateDetail;
	assert.strictEqual(detail.errors.length, 10);
	for (const e of detail.errors) assert.ok([...e].length <= 100, e);
	assert.ok([...detail.reason].length <= 100, detail.reason);
	const [notice] = await settledPosts(h);
	assert.ok(notice.length < 400, notice);
	assert.ok(!notice.includes('```'), notice);
});

test('a removed watch orphans its slot, and so does a watch the client cannot find on reconnect', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await settledPosts(h);
	h.monitor.drop(0);
	await waitFor(() => row(h, key).state === 'orphaned', 'the orphaned state');
	const [notice] = await settledPosts(h);
	assert.match(notice, /^\u26A0\uFE0F `ZackPlex`: watch #0 is gone/u);
	assert.strictEqual(h.game.health().status, 'error');

	const h2 = await setup(t);
	const key2 = await linkSlot(h2);
	const client = runtime(h2, key2).client;
	h2.monitor.getWatch = () => null;
	for (const socket of h2.server.clientsOn(1)) socket.socket.terminate();
	await waitFor(() => !client.connected, 'the drop');
	reconnectNow(client);
	await waitFor(() => row(h2, key2).state === 'orphaned', 'the client finding no watch');
});

// --- the command's data ----------------------------------------------------------------

test('link refuses an unknown slot and another game once the room is known, and keeps the room\'s spelling', async (t) => {
	const h = await setup(t);
	const missing = await h.game.link({ watchId: 0, slot: 'Nobody', userId: OWNER });
	assert.strictEqual(missing.ok, false);
	const game = await h.game.link({ watchId: 0, slot: 'watcher', userId: OWNER });
	assert.strictEqual(game.ok, false);
	assert.match(game.message, /plays ChecksFinder/);
	const noWatch = await h.game.link({ watchId: 4, slot: SLOT, userId: OWNER });
	assert.strictEqual(noWatch.ok, false);

	const linked = await h.game.link({ watchId: 0, slot: 'zackplex', userId: FRIEND, by: OWNER });
	assert.ok(linked.ok);
	assert.strictEqual(linked.binding.slot, 'ZackPlex');
	assert.match(linked.warnings.join(' '), /only Discord listening counts/);
	const taken = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER });
	assert.strictEqual(taken.ok, false, 'someone else holds it');
	assert.match(taken.message, /someone else/);

	assert.deepStrictEqual(h.game.slotNames('zack'), [{ name: 'ZackPlex', value: linked.binding.key }]);
	assert.deepStrictEqual(h.game.slotNames('', FRIEND), [{ name: 'ZackPlex', value: linked.binding.key }]);
	assert.deepStrictEqual(h.game.slotNames('', OWNER), [], 'only the asker\'s own');
	assert.deepStrictEqual(h.game.slotNames('', 'not-a-user'), []);
	assert.deepStrictEqual(h.game.resolveBinding('ZACKPLEX', { userId: FRIEND }).key, linked.binding.key);
	assert.strictEqual(h.game.resolveBinding('', { userId: OWNER }).ok, false);
	// Autocomplete hands out binding keys, and a typed key is scoped like a typed name.
	assert.strictEqual(h.game.resolveBinding(linked.binding.key, { userId: FRIEND }).key, linked.binding.key);
	const theirs = h.game.resolveBinding(linked.binding.key, { userId: OWNER });
	assert.deepStrictEqual([theirs.ok, theirs.key, theirs.message], [false, undefined, 'No linked Plex Media slot is called `0::zackplex`.']);
	assert.strictEqual(h.game.resolveBinding(linked.binding.key, { userId: OWNER, all: 'yes' }).ok, false, 'only all: true widens the scope');
	assert.strictEqual(h.game.resolveBinding(linked.binding.key, { userId: OWNER, all: true }).key, linked.binding.key);
	assert.strictEqual(h.game.resolveBinding(linked.binding.key, { all: true }).key, linked.binding.key);
	assert.strictEqual(h.game.resolveBinding('zackplex', { userId: OWNER, all: true }).key, linked.binding.key);
	assert.strictEqual(h.game.resolveBinding(linked.binding.key, {}).ok, false, 'no user, no binding');
	const gone = await h.game.unlink(linked.binding.key, OWNER);
	assert.ok(gone.ok);
	assert.deepStrictEqual(h.game.bindingsFor(FRIEND), []);
});

test('link takes a slot whose game the room has not named yet, in the room\'s spelling, with a warning', async (t) => {
	const h = await setup(t, { room: { known: true, slots: { [SLOT]: null, Watcher: 'ChecksFinder' } } });
	const res = await h.game.link({ watchId: 0, slot: 'zackplex', userId: OWNER, by: OWNER });
	assert.ok(res.ok, res.message);
	assert.strictEqual(res.binding.slot, SLOT);
	assert.strictEqual(h.store.bindings.get(res.binding.key).slot, SLOT, 'the room\'s spelling is stored');
	assert.deepStrictEqual(res.warnings, ['The slot\'s game is not known yet; a slot of another game is refused when it connects.']);
	await waitFor(() => row(h, res.binding.key).inventoryKnown, 'the connection');
	assert.strictEqual(row(h, res.binding.key).state, 'active');
});

test('a friend\'s Plex history counts only after consent, with a backfill for an account already read', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	h.pms.rows.push({ historyKey: '/status/sessions/history/5', ratingKey: '2001', viewedAt: AFTER / 1000, accountID: 7 });
	await h.game._internal.watcher().pollHistory();
	assert.strictEqual(h.pms.rows.length, 1);
	assert.strictEqual(row(h, key).pending, 0, 'no account linked: nothing read');

	assert.deepStrictEqual((await h.game.plexAccounts()).map((a) => a.id), [1, 7]);
	const linked = await h.game.linkAccount(FRIEND, { accountId: 7, name: 'Friend', by: OWNER });
	assert.ok(linked.ok);
	assert.strictEqual(linked.needsConsent, true);
	assert.deepStrictEqual(h.game.accountOf(FRIEND).consent, 'pending');
	await h.game._internal.watcher().pollHistory();
	assert.strictEqual(row(h, key).pending, 0, 'waiting for consent: still nothing');
	assert.strictEqual(h.game.health().detail.includes('no linked accounts'), true);

	h.store.marks.set(7, { newestViewedAt: AFTER / 1000 + 100, seen: ['/status/sessions/history/5'] });
	const shown = h.game.accountOf(FRIEND).linkedAt;
	const stale = await h.game.grantConsent(FRIEND, { linkedAt: shown - 1 });
	assert.strictEqual(stale.ok, false);
	assert.match(stale.message, /linked your Plex account again/);
	assert.strictEqual(h.game.accountOf(FRIEND).consent, 'pending', 'a click on an older request grants nothing');
	const consent = await h.game.grantConsent(FRIEND, { linkedAt: shown });
	assert.ok(consent.ok, consent.message);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the backfilled watch');
	await waitFor(() => h.store.bindings.get(key).backfillSeed === SEED, 'the backfill recorded');
	assert.strictEqual(row(h, key).account.accountId, 7);
});

// The bug: one Plex account could be linked to two Discord users, and consent was asked only of the
// one linked: the second user's slots were credited, announced and filtered by the first one's
// watching. The owner, read as account 1 while unlinked, holds that account the same way.
test('a Plex account somebody else holds is refused, unless the owner links it as shared', async (t) => {
	const BOB = '100000000000000002';
	const h = await setup(t, { startGame: false });
	assert.ok((await h.game.linkAccount(FRIEND, { accountId: 7, name: 'alice', by: OWNER })).ok);

	const taken = await h.game.linkAccount(BOB, { accountId: 7, name: 'alice', by: OWNER });
	assert.strictEqual(taken.ok, false);
	assert.strictEqual(taken.message, 'Plex account `alice` (id 7) is already linked to <@100000000000000001>. Unlink it there first, or link it as shared if they use that account together.');
	assert.deepStrictEqual(taken.heldBy, [FRIEND]);
	assert.strictEqual(h.game.accountOf(BOB), null, 'nothing linked');
	const ownersOwn = await h.game.linkAccount(BOB, { accountId: 1, name: 'Owner', by: OWNER });
	assert.strictEqual(ownersOwn.ok, false);
	assert.match(ownersOwn.message, /already linked to <@100000000000000009> \(as the server owner\)\./);
	const self = await h.game.linkAccount(OWNER, { accountId: 7, name: 'alice', by: OWNER });
	assert.strictEqual(self.ok, false, 'the owner linking themselves is held to it too');
	assert.strictEqual(h.game.accountOf(OWNER).implicit, true);

	const shared = await h.game.linkAccount(BOB, { accountId: 7, name: 'alice', by: OWNER, shared: true });
	assert.ok(shared.ok, shared.message);
	assert.strictEqual(shared.needsConsent, true);
	assert.deepStrictEqual(shared.sharedWith, [FRIEND]);
	assert.match(shared.message, /^Linked to Plex account `alice` \(account 7\), shared with <@100000000000000001>, waiting for their consent/);
	assert.ok((await h.game.linkAccount(FRIEND, { accountId: 7, name: 'alice', by: OWNER, shared: true })).ok, 'a re-link of one\'s own account is no conflict');
});

// The bug: unlinking an account stopped the reads but kept what had been read: its history mark
// stayed in apmedia_marks.json for good, and the watcher's last session sample of it came back in
// /apmedia status at the next link. A pass still reading it wrote its mark back afterwards.
test('the last link of a Plex account takes its history mark and its session sample with it', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	await h.game.linkAccount(FRIEND, { accountId: 7, name: 'Friend', by: OWNER });
	await h.game.grantConsent(FRIEND);
	const watcher = h.game._internal.watcher();
	h.pms.rows.push({ historyKey: '/status/sessions/history/9', ratingKey: '2001', viewedAt: AFTER / 1000, accountID: 7 });
	await watcher.pollHistory();
	h.pms.sessionRows = [{ ratingKey: '2001', viewOffset: 600000, duration: 8160000, User: { id: '7', title: 'Friend' }, Player: { state: 'playing' }, Session: { id: 's7' } }];
	await watcher.pollSessions();
	assert.ok(h.store.marks.get(7));
	assert.ok(row(h, key).lastSession);

	assert.ok((await h.game.unlinkAccount(FRIEND)).ok);
	assert.ok(!h.store.marks.get(7), 'the mark went');
	assert.strictEqual(watcher.lastSession(7), null);
	assert.strictEqual(watcher.lastSeen(7, 2001), null);
	await h.game.linkAccount(FRIEND, { accountId: 7, name: 'Friend', by: OWNER });
	await h.game.grantConsent(FRIEND);
	assert.strictEqual(row(h, key).lastSession, null, 'a new link starts with nothing of the old one');

	let release;
	const history = h.pms.history;
	h.pms.history = async (args) => {
		await new Promise((resolve) => { release = resolve; });
		return history(args);
	};
	const pass = watcher.pollHistory();
	await waitFor(() => release, 'the pass reading Plex');
	assert.ok((await h.game.unlinkAccount(FRIEND)).ok);
	release();
	await pass;
	assert.ok(!h.store.marks.get(7), 'a pass that was reading the account writes no mark back');
});

test('an account still read for somebody keeps its history mark when one link goes', async (t) => {
	const BOB = '100000000000000002';
	const h = await setup(t, { startGame: false });
	h.store.marks.set(7, { newestViewedAt: AFTER / 1000, seen: ['/status/sessions/history/9'] });
	h.store.marks.set(1, { newestViewedAt: AFTER / 1000, seen: ['/status/sessions/history/8'] });
	await h.game.linkAccount(FRIEND, { accountId: 7, name: 'Friend', by: OWNER });
	await h.game.linkAccount(BOB, { accountId: 7, name: 'Friend', by: OWNER, shared: true });
	await h.game.unlinkAccount(FRIEND);
	assert.ok(h.store.marks.get(7), 'Bob still holds it');
	await h.game.unlinkAccount(BOB);
	assert.ok(!h.store.marks.get(7));

	await h.game.linkAccount(OWNER, { accountId: 1, name: 'Owner', by: OWNER });
	await h.game.unlinkAccount(OWNER);
	assert.ok(h.store.marks.get(1), 'the owner is read as account 1 again');
	await h.game.linkAccount(OWNER, { accountId: 7, name: 'Friend', by: OWNER });
	assert.ok(!h.store.marks.get(1), 'linked to another account, the owner no longer holds account 1');
});

// Linked elsewhere, the owner leaves account 1 free to link to somebody without `shared`; taking
// their own link back makes them read it again, and it then counts for both of them.
test('the owner taking their link back names whoever else holds account 1', async (t) => {
	const h = await setup(t, { startGame: false });
	await h.game.linkAccount(OWNER, { accountId: 7, name: 'Friend', by: OWNER });
	assert.ok((await h.game.linkAccount(FRIEND, { accountId: 1, name: 'Owner', by: OWNER })).ok);
	const res = await h.game.unlinkAccount(OWNER);
	assert.ok(res.ok);
	assert.ok(res.message.endsWith(`The owner is read as the server owner (account 1) again, which is also linked to <@${FRIEND}>.`), res.message);
	assert.deepStrictEqual(res.sharedWith, [FRIEND]);

	const alone = await setup(t, { startGame: false });
	await alone.game.linkAccount(OWNER, { accountId: 7, name: 'Friend', by: OWNER });
	const plain = await alone.game.unlinkAccount(OWNER);
	assert.ok(plain.message.endsWith('The owner is read as the server owner (account 1) again.'));
	assert.deepStrictEqual(plain.sharedWith, []);
});

test('list groups the titles, marks outstanding hints, and status reports the last session\'s reach', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	h.monitor.setHints([
		{ finder: SLOT, receiver: 'Watcher', item: 'Sword', where: 'Watch 1917', priority: false },
		{ finder: 'zackplex', receiver: 'Bob', item: 'Shield', where: 'The Matrix (1999) @ 1h30m', priority: true },
		{ finder: SLOT, receiver: 'Ann', item: 'Key', location: loc(16) },
		{ finder: 'Watcher', receiver: SLOT, item: 'Map', where: 'Watch 1917' },
	]);
	const ready = h.game.list(key, 'ready');
	assert.ok(ready.ok, ready.message);
	assert.deepStrictEqual(ready.totals, { ready: 3, locked: 16, done: 0, total: 19 });
	assert.deepStrictEqual(ready.groups.map((g) => g.name), ['Movies']);
	const matrix = ready.groups[0].rows.find((r) => r.title === 'The Matrix (1999)');
	assert.deepStrictEqual([matrix.hinted, matrix.hintedFor, matrix.runtime], [true, ['Bob'], '2h16m']);

	const locked = h.game.list(key, 'locked');
	const show = locked.groups.find((g) => g.name === 'Breaking Point');
	assert.strictEqual(show.kind, 'show');
	assert.strictEqual(show.total, 5);
	assert.ok(locked.groups.find((g) => g.name === 'Movies').rows.find((r) => r.title === '1917').hinted);
	assert.ok(show.rows.find((r) => r.title === 'Breaking Point S01E01').hinted, 'a hint row carrying the location id');
	assert.deepStrictEqual(locked.groups.find((g) => g.name === 'Road Trip').rows.map((r) => r.tracks), [{ done: 0, total: 2 }, { done: 0, total: 1 }]);
	assert.strictEqual(h.game.list(key, 'nope').ok, false);

	h.pms.sessionRows = [{ ratingKey: '2001', viewOffset: 7100000, duration: 8160000, User: { id: '1', title: 'Owner' }, Player: { state: 'playing' }, Session: { id: 'x1' } }];
	await h.game._internal.watcher().pollSessions();
	const status = row(h, key);
	assert.deepStrictEqual(
		[status.lastSession.title, status.lastSession.percent, status.lastSession.note],
		['The Matrix (1999)', 87, '87%: Plex counts a watch at 90%'],
	);
	assert.deepStrictEqual([status.done, status.total, status.goalCount, status.ready, status.locked], [0, 19, 15, 3, 16]);
	assert.strictEqual(status.connection, 'connected');
	assert.deepStrictEqual(status.account, { accountId: 1, name: null, consent: 'granted', implicit: true });

	// 89.6% has not counted, so it must not read as 90%.
	h.pms.sessionRows[0].viewOffset = 7311360;
	await h.game._internal.watcher().pollSessions();
	assert.deepStrictEqual([row(h, key).lastSession.percent, row(h, key).lastSession.note], [89, '89%: Plex counts a watch at 90%']);
	h.pms.sessionRows = [{ ratingKey: '2002', viewOffset: 29, duration: 100, User: { id: '1', title: 'Owner' }, Player: { state: 'paused' }, Session: { id: 'x2' } }];
	await h.game._internal.watcher().pollSessions();
	assert.strictEqual(row(h, key).lastSession.percent, 29, '0.29 * 100 is 28.999... in floating point');

	assert.deepStrictEqual(h.game.titles(key, 'hallo').map((c) => c.value), ['movie|rk:2002', 'movie|rk:2003']);
	assert.strictEqual(h.game.findEntry(key, '#4').title, '1917');
});

// --- lifecycle -------------------------------------------------------------------------

test('stop and start are idempotent, leave nothing behind, and a !restart hands held lines to the new client', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	h.game.start({ discord: h.discord, bot: h.bot });
	assert.strictEqual(h.monitor.listenerCount(), 1);
	assert.strictEqual(h.bot.listenerCount('track-heard'), 1);
	assert.strictEqual(h.bot.books.listeners.size, 1);
	assert.strictEqual(h.configStore.count(), 1);
	await settledPosts(h);

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'a credit');
	await h.game._internal.idle();
	assert.strictEqual(h.timers.pending.size, 1, 'its line waits for the batch');

	h.game.stop();
	h.game.stop();
	assert.strictEqual(h.monitor.listenerCount(), 0);
	assert.strictEqual(h.bot.listenerCount('track-heard'), 0);
	assert.strictEqual(h.bot.books.listeners.size, 0);
	assert.strictEqual(h.configStore.count(), 1, 'bound once per process');
	assert.strictEqual(h.timers.pending.size, 0);
	assert.strictEqual(h.booksTimers.pending.size, 0);
	assert.strictEqual(h.watcherTimers.pending.size, 0);
	assert.strictEqual(h.game._internal.watcher().running, false);
	assert.strictEqual(runtime(h, key).client, null);
	await waitFor(() => h.server.clientsOn(1).length === 0, 'the socket closed');
	assert.strictEqual(h.discord.posts.length, 0);
	assert.strictEqual(row(h, key).connection, 'off');
	assert.strictEqual(h.game.status(key).reason, 'Plex Media is not running yet: it starts once the bot is connected to Discord.');

	const discord2 = fakeDiscord();
	const bot2 = fakeBot();
	h.game.start({ discord: discord2, bot: bot2 });
	h.game.start({ discord: discord2, bot: bot2 });
	assert.strictEqual(h.monitor.listenerCount(), 1);
	assert.strictEqual(bot2.listenerCount('track-heard'), 1);
	await waitFor(() => row(h, key).inventoryKnown, 'the reconnect');
	await h.game._internal.idle();
	await h.game._internal.flushAll();
	assert.deepStrictEqual(discord2.posts.map((p) => p.content), ['\u2705 `ZackPlex` watched **The Matrix (1999)**, 9 checks sent'], 'the held line, and no second welcome');
	assert.strictEqual(h.discord.posts.length, 0);
});

test('/config: apMediaEnabled starts and stops it live, an interval change rearms the poll, archipelagoEnabled parks the clients', async (t) => {
	const h = await setup(t, { config: { apMediaEnabled: false } });
	assert.strictEqual(h.game._internal.running, false);
	assert.deepStrictEqual(h.game.health(), { status: 'disabled', detail: 'apMediaEnabled is false in config/config.js' });
	const linked = await h.game.link({ watchId: 0, slot: SLOT, userId: OWNER });
	const key = linked.binding.key;
	assert.strictEqual(runtime(h, key) && runtime(h, key).client, null, 'nothing connects while it is off');
	const off = h.game.status(key);
	assert.strictEqual(off.bindings[0].connection, 'off');
	assert.strictEqual(off.reason, 'Plex Media is off (`apMediaEnabled`), so no slot connects and nothing counts.');
	assert.strictEqual(off.message, `1 Plex Media slot. ${off.reason}`);

	h.config.apMediaEnabled = true;
	h.configStore.fire('apMediaEnabled', true);
	await waitFor(() => row(h, key).inventoryKnown, 'the start from /config');
	assert.strictEqual(h.bot.listenerCount('track-heard'), 1, 'with the bot kept from start()');
	assert.deepStrictEqual([h.game.status(key).reason, h.game.status(key).message], [null, '1 Plex Media slot']);

	h.config.apMediaHistorySeconds = 300;
	h.configStore.fire('apMediaHistorySeconds', 300);
	assert.strictEqual(h.game._internal.watcher().health().historySeconds, 300);

	// A /config password change rebuilds the watch; any archipelago* save re-checks the address.
	const first = runtime(h, key).client;
	h.monitor.set(0, { target: h.server.target, password: 'changed' });
	h.configStore.fire('archipelagoShowChat', false);
	await h.game._internal.idle();
	assert.notStrictEqual(runtime(h, key).client, first, 'a fresh client for the changed room password');
	assert.strictEqual(first.stopped, true);
	await waitFor(() => row(h, key).inventoryKnown, 'the reconnect');
	const second = runtime(h, key).client;
	h.configStore.fire('archipelagoShowChat', true);
	await h.game._internal.idle();
	assert.strictEqual(runtime(h, key).client, second, 'an unrelated setting leaves the client alone');

	// What the monitor does when archipelagoEnabled goes off: every watch cleared as 'disabled'.
	h.config.archipelagoEnabled = false;
	h.monitor.drop(0, 'disabled');
	h.configStore.fire('archipelagoEnabled', false);
	await h.game._internal.idle();
	assert.strictEqual(runtime(h, key).client, null);
	assert.strictEqual(row(h, key).connection, 'waiting');
	assert.strictEqual(h.game.status(key).reason, 'The Archipelago monitor is off (`archipelagoEnabled`), and Plex Media slots connect through its watches.');
	assert.strictEqual(row(h, key).state, 'active', 'the slot waits for its watch, it is not orphaned');
	assert.strictEqual(h.game.health().status, 'missing');

	h.config.archipelagoEnabled = true;
	h.monitor.put(0, { target: h.server.target }, 'added');
	h.configStore.fire('archipelagoEnabled', true);
	await waitFor(() => row(h, key).inventoryKnown, 'the clients back');

	h.config.apMediaEnabled = false;
	h.configStore.fire('apMediaEnabled', false);
	assert.strictEqual(h.game._internal.running, false);
	assert.strictEqual(runtime(h, key).client, null);
	assert.strictEqual(h.bot.listenerCount('track-heard'), 0);
});

test('health: ok with the read age or no linked accounts, and an error after three failed history reads', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	assert.deepStrictEqual(h.game.health(), { status: 'ok', detail: '1 slot, 1 connected, no linked accounts' });

	await h.game.unlink(key);
	const own = await linkSlot(h);
	await h.game._internal.watcher().pollHistory();
	h.clock += 4 * 60000;
	assert.deepStrictEqual(h.game.health(), { status: 'ok', detail: '1 slot, 1 connected, Plex history read 4m ago' });

	h.pms.fail = 'Plex is down';
	for (let i = 0; i < 3; i++) await h.game._internal.watcher().pollHistory();
	const sick = h.game.health();
	assert.strictEqual(sick.status, 'error');
	assert.match(sick.detail, /failed 3 times in a row \(Plex is down\)/);

	// The last binding goes, so the next pass reads no account and the old failures stop counting.
	await h.game.unlink(own);
	await h.game._internal.watcher().pollHistory();
	assert.strictEqual(h.game._internal.watcher().health().historyFailures, 3);
	const idle = h.game.health();
	assert.strictEqual(idle.status, 'ok');
	assert.match(idle.detail, /no linked accounts$/);
});

// The bug: slot names are the players' and refusal reasons the room's, and !diag posts the health
// detail to anyone inside one code block: a ``` in either ended the block early, so @everyone or a
// role mention after it was live Markdown, and a long list pushed the reply past 2,000 characters.
test('health keeps player and room text inside !diag\'s code block, and names five slots at most', async (t) => {
	const healthCheck = require('../helpers/healthCheck.js');
	const h = await setup(t, { startGame: false });
	h.store.bindings.put({ watchId: 0, slot: 'Fine', userId: OWNER, state: 'refused', stateDetail: { reason: '```<@&300000000000000003>', errors: [] } });
	h.store.bindings.put({ watchId: 0, slot: '```@everyone', userId: FRIEND, state: 'orphaned' });
	const diag = () => `Bot v0 boot diagnostic\n\`\`\`\n${healthCheck.formatHealthCheck({ apMedia: h.game.health() })}\n\`\`\``;
	assert.strictEqual(h.game.health().detail, '1 slot refused (Fine: \'\'\'<@&300000000000000003>); 1 slot lost its watch (\'\'\'@everyone)');
	assert.strictEqual(diag().split('```').length - 1, 2, 'one code block, as commands/test.js builds the reply');

	for (let i = 1; i <= 7; i++) h.store.bindings.put({ watchId: 1, slot: `Gone${i}`, userId: FRIEND, state: 'orphaned' });
	h.store.bindings.put({ watchId: 1, slot: 'Long', userId: FRIEND, state: 'refused', stateDetail: { reason: 'x'.repeat(5000), errors: [] } });
	const detail = h.game.health().detail;
	assert.match(detail, /^2 slots refused \(Fine: '''<@&300000000000000003>, Long: x{59}\u2026\); 8 slots lost their watch \('''@everyone, Gone1, Gone2, Gone3, Gone4 and 3 more\)$/u);
	assert.ok(diag().length < 1000);
});

test('a start failure and a Plex history error stay inside !diag\'s code block too', async (t) => {
	const hostile = `\`\`\`@everyone ${'e'.repeat(500)}`;
	const broken = await setup(t, { startGame: false });
	broken.monitor.onWatchChange = () => { throw new Error(hostile); };
	assert.strictEqual(broken.game.start({ discord: broken.discord, bot: broken.bot }).running, false);
	const failed = broken.game.health().detail;
	assert.match(failed, /^failed to start: '''@everyone e+\u2026$/u);
	assert.ok([...failed].length <= 220, failed);

	const h = await setup(t);
	await linkSlot(h);
	h.pms.fail = hostile;
	for (let i = 0; i < 3; i++) await h.game._internal.watcher().pollHistory();
	const sick = h.game.health().detail;
	assert.match(sick, /^the Plex history read failed 3 times in a row \('''@everyone e+\u2026\)$/u);
	assert.ok([...sick].length <= 260, sick);
});

test('starting reads the Plex playlists once, so the /apmedia autocomplete has them from memory', async (t) => {
	const h = await setup(t);
	// Before anything asks: a cold cachedPlaylists() would start the read itself.
	await waitFor(() => h.pms.playlistReads === 1, 'the warm-up read');
	await waitFor(() => h.game.builder().cachedPlaylists('road').length === 1, 'the warmed playlist cache');
	assert.strictEqual(h.pms.playlistReads, 1);
	assert.strictEqual(h.game.builder(), h.game.builder(), 'one builder per game');

	const down = await setup(t, { startGame: false });
	down.pms.playlists = async () => {
		down.pms.playlistReads += 1;
		throw new Error('Plex is down');
	};
	assert.deepStrictEqual(down.game.start({ discord: down.discord, bot: down.bot }), { running: true, reason: null });
	await waitFor(() => down.pms.playlistReads === 1, 'the failed warm-up');
	await down.game._internal.idle();
	assert.ok(!down.logger.lines.some((l) => l.level === 'error' || l.level === 'warn'), 'a failed warm-up stays quiet');
});

test('the health check reports Plex Media through the shared instance', () => {
	const healthCheck = require('../helpers/healthCheck.js');
	const config = require('../config/config.js');
	const result = healthCheck.checkApMedia();
	if (!config.apMediaEnabled) assert.deepStrictEqual(result, { status: 'disabled', detail: 'apMediaEnabled is false in config/config.js' });
	assert.ok(['ok', 'error', 'missing', 'disabled'].includes(result.status));
});
