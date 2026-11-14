// helpers/apMediaGame.js: the Plex Media orchestrator, from something watched or heard to a check the
// room registers, and the lifecycle around it.
//
// What has to hold: every source (Plex history and sessions, the bot's voice, its audiobooks, a
// manual credit) earns exactly the slot's own location ids; a repeat writes and says nothing; credit
// from before the seed counts for nothing; a locked title banks (or, under 'ignore', earns nothing),
// and nothing is decided locked before the slot's inventory is known; the goal goes out at the
// threshold and again on every Connected; a new seed, a refusal and a lost watch each stop the slot
// with one notice that names the fix; announcements are batched, escaped and never ping; and start,
// stop, the /config switch and the health check behave across a !restart. For world 0.3.0's items:
// each acts once, never as a backlog or again after a reconnect; a burst hits with two traps at most;
// a Remote Control ends or blocks a trap; Buffering and Rights Expired hold checks, never drop them,
// and let them go on time, after a restart too; a voice or book trap waits for a listen, then fizzles
// after 12 hours or with its switch off; a Fast Forward and the Snack Bar spend only what is there.
//
// Harness: the real orchestrator (createGame) with the real ApMediaClient against
// test/helpers/apMediaServer.js on a loopback port, serving test/fixtures/apmedia/slot_data_mixed.json
// (generated_at 1731300000, so every event here is dated after it); the real apMediaStore in memory
// (createApMediaStore under the test runner with no env var); the real apMediaWatch, apMediaVoice and
// apMediaBooks over a fake PMS, a fake bot (an EventEmitter with a book engine stand-in) and fake
// bookmarks and catalog; a fake monitor with the archipelagoMonitor accessors the game reads; a fake
// Discord client that records every post; and injected timers fired by hand, so no poll or batch
// runs on its own. Reconnects run the client's own reconnect at once (reconnectNow), never its 5 s
// backoff. The trap tests hand the game a recording stand-in for helpers/apMediaTraps.js's runner,
// except those that let the game build the real one over the fake bot's book engine.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const contracts = require('../helpers/apMediaContracts.js');
const { createGame, commandCode } = require('../helpers/apMediaGame.js');
const { createApMediaStore } = require('../helpers/apMediaStore.js');
const voiceClaims = require('../helpers/voiceClaims.js');
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
		game: gameOptions = {},
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
	h.make = (more = {}) => createGame({
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
		...gameOptions,
		...more,
	});
	h.game = h.make();
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
	assert.ok(welcome.split('\n')[2].endsWith('``!ap claim Zack`Plex``, then ``!ap hintpings Zack`Plex dm``.'), 'the commands keep the exact name');
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

test('the first Connected posts one welcome naming the open titles, the Plex account, the commands and the pool', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h, { user: FRIEND });
	const [welcome] = await settledPosts(h);
	const lines = welcome.split('\n');
	assert.strictEqual(lines.length, 4);
	assert.match(lines[0], /^\u{1F3AC} `ZackPlex` is in the game with 3 of 19 titles open: The Matrix \(1999\) \(2h16m\), Halloween \(2018\) \(1h46m\), Halloween \(2018\) \(1h45m\)\. Goal: finish 15\.$/u);
	assert.match(lines[1], /none, so only Discord listening counts for now, and its 13 video titles need one/);
	assert.match(lines[2], /`\/apmedia list`/);
	assert.match(lines[2], /`!ap hintpings ZackPlex dm`/);
	assert.strictEqual(lines[3], 'In its pool: 2 Wild Tickets, 2 Fast Forwards, 1 Remote Control, 69 snacks and no traps. '
		+ 'The Snack Bar trades 10 snacks for a Fast Forward or a Remote Control, 3 times (`/apmedia snackbar`).', 'slot_data\'s pool, a seed without traps');
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
	assert.strictEqual(h.bot.listenerCount('will play'), 1, 'a voice track start, for an armed trap');
	assert.strictEqual(h.bot.books.listeners.size, 2, 'audiobook credit and the armed traps');
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
	assert.strictEqual(h.bot.listenerCount('will play'), 0);
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
// --- timesanity_strict: everything before a checkpoint heard -------------------------------------

const MIN_MS = 60000;
// Race-free: a credited id sits in pending from creditIds until the room has registered it.
const earned = (h, key, id, server = h.server) => {
	const b = h.store.bindings.get(key);
	return b.pending.includes(id) || b.banked.includes(id) || server.checkedOf(1).has(id);
};
const sessionSpan = (rk, fromMs, toMs, at = AFTER) => ({ type: 'span', source: 'session', accountId: 1, ratingKey: rk, fromMs, toMs, at });

// The first rehearsal's audiobook earned its 30-minute checkpoint after 8 skipped minutes. Under
// strict the owner wants all of it heard, over any number of sittings.
test('under strict a checkpoint needs everything before it heard, and what was heard is kept on the binding', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await settledPosts(h);
	const [watch, m15, m30] = MATRIX.ids;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 21.5 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(m15), 'the 15-minute checkpoint');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 21.5 * MIN_MS]]], 'written with the credit');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 29.9 * MIN_MS, 30.1 * MIN_MS, AFTER + 1000));
	await h.game._internal.idle();
	assert.ok(!earned(h, key, m30), 'crossing 30:00 after a skip is not enough');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 21.5 * MIN_MS]]], 'a stretch that earns nothing waits in memory');
	h.timers.fire(60000);
	const stored = h.store.bindings.get(key).heard;
	assert.deepStrictEqual(Object.values(stored), [[[0, 21.5 * MIN_MS], [29.9 * MIN_MS, 30.1 * MIN_MS]]], 'and is written a minute later');
	assert.match(Object.keys(stored)[0], /^movie\|/);

	await h.game._internal.handleEvent(historyEvent(MATRIX.rk, { at: AFTER + 2000 }));
	await waitFor(() => h.server.checkedOf(1).has(watch), 'the watch');
	assert.ok(!earned(h, key, m30), 'a Plex history row proves no listening');

	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 21.5 * MIN_MS, 29.9 * MIN_MS, AFTER + 3000));
	await waitFor(() => h.server.checkedOf(1).has(m30), 'the 30-minute checkpoint once the skipped stretch is heard');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 30.1 * MIN_MS]]]);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 30.1 * MIN_MS, 136 * MIN_MS, AFTER + 4000));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'every checkpoint');
	assert.deepStrictEqual(h.store.bindings.get(key).heard, {}, 'nothing kept once every checkpoint is reached');
});

test('without strict a stretch across a mark still earns it, and nothing is kept', async (t) => {
	const h = await setup(t);
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 29.9 * MIN_MS, 30.1 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[2]), 'the 30-minute checkpoint');
	assert.deepStrictEqual(h.store.bindings.get(key).heard, {});
});

test('under strict with locked_watches ignore, a locked title heard counts for nothing, then or after its unlock', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 20 * MIN_MS));
	await h.game._internal.idle();
	assert.deepStrictEqual(h.store.bindings.get(key).heard, {}, 'nothing recorded while it is locked');
	assert.strictEqual(row(h, key).banked, 0);
	await receive(h, key, N1917.unit);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 20 * MIN_MS, 21 * MIN_MS, AFTER + 1000));
	await h.game._internal.idle();
	assert.ok(!earned(h, key, N1917.ids[1]), 'the stretch heard while locked does not count after the unlock');
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 20 * MIN_MS, AFTER + 2000));
	await waitFor(() => h.server.checkedOf(1).has(N1917.ids[1]), 'heard again once open');
});

test('under strict with locked_watches bank, a locked title heard banks its checkpoints for the unlock', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(sessionSpan(N1917.rk, 0, 16 * MIN_MS));
	await waitFor(() => row(h, key).banked === 1, 'the 15-minute checkpoint in the bank');
	assert.strictEqual(Object.keys(h.store.bindings.get(key).heard).length, 1);
});
test('under strict a time credited by hand counts as heard, so playing on from it earns the next checkpoint', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	const [, m15, m30] = MATRIX.ids;
	const byHand = await h.game.creditManual(key, 'movie|plex://movie/5d7768b2', { atMs: '20m' });
	assert.ok(byHand.ok, byHand.message);
	await waitFor(() => h.server.checkedOf(1).has(m15), 'the 15-minute checkpoint, by hand');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 20 * MIN_MS]]]);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 20 * MIN_MS, 31 * MIN_MS, AFTER + 1000));
	await waitFor(() => h.server.checkedOf(1).has(m30), 'the 30-minute checkpoint, played on from 20:00');
});
// A durable write on every 10 to 15 s step, beside voice playback, is the synchronous disk work that
// makes this PC's voice stutter.
test('under strict what was heard is written with the next credit, else a minute later, and at stop, never on every step', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	let writes = 0;
	const patch = h.store.bindings.patch;
	h.store.bindings.patch = (...args) => {
		if (args[1] && Object.prototype.hasOwnProperty.call(args[1], 'heard')) writes += 1;
		return patch(...args);
	};
	const flushes = () => h.timers.delays().filter((ms) => ms === 60000).length;
	for (let m = 1; m <= 10; m++) await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, (m - 1) * MIN_MS, m * MIN_MS, AFTER + m * 1000));
	await h.game._internal.idle();
	assert.strictEqual(writes, 0, 'ten steps that earn nothing write nothing');
	assert.strictEqual(flushes(), 1, 'one flush timer for all of them');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 10 * MIN_MS, 16 * MIN_MS, AFTER + 11000));
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[1]), 'the 15-minute checkpoint');
	assert.strictEqual(writes, 1, 'the credit writes what was heard in its own patch');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 16 * MIN_MS]]]);
	assert.strictEqual(flushes(), 0, 'and the flush timer goes');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 16 * MIN_MS, 17 * MIN_MS, AFTER + 12000));
	await h.game._internal.idle();
	h.timers.fire(60000);
	assert.strictEqual(writes, 2, 'the timer writes what no credit did');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 17 * MIN_MS, 18 * MIN_MS, AFTER + 13000));
	await h.game._internal.idle();
	h.game.stop();
	assert.strictEqual(writes, 3, 'stop writes what is left');
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 18 * MIN_MS]]]);
	assert.strictEqual(flushes(), 0);
});

test('under strict a checkpoint the room already holds counts as everything before it heard: a live seed carries on', async (t) => {
	const [, m15, m30, m45] = MATRIX.ids;
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }), server: { checked: { 1: [m15] } } });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 15 * MIN_MS, 31 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(m30), 'the 30-minute checkpoint from 15:00 on');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 32 * MIN_MS, 46 * MIN_MS, AFTER + 1000));
	await h.game._internal.idle();
	assert.ok(!earned(h, key, m45), 'a minute unheard after 31:00 still blocks 45:00');
	h.game.stop();
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[0, 31 * MIN_MS], [32 * MIN_MS, 46 * MIN_MS]]]);
});

test('under strict a retry onto a new seed clears what was heard, so nothing from before it counts', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 10 * MIN_MS));
	await h.game._internal.idle();
	h.timers.fire(60000);
	assert.strictEqual(Object.keys(h.store.bindings.get(key).heard).length, 1);

	const fresh = await startApMediaServer({ seedName: 'Seed_NEW', slotData: { 1: slotData({ timesanity_strict: true }) }, locations: { 1: ALL_LOCATIONS }, startInventory: { 1: START } });
	t.after(() => fresh.close());
	h.monitor.put(0, { target: fresh.target }, 'repointed');
	await waitFor(() => row(h, key).state === 'stale', 'the stale state');
	const res = await h.game.retry(key);
	assert.ok(res.ok, res.message);
	await waitFor(() => row(h, key).seedName === 'Seed_NEW' && row(h, key).inventoryKnown, 'the new seed');
	assert.deepStrictEqual(h.store.bindings.get(key).heard, {});
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 10 * MIN_MS, 16 * MIN_MS, AFTER + 1000));
	await h.game._internal.idle();
	assert.ok(!earned(h, key, MATRIX.ids[1], fresh), 'the old seed\'s first ten minutes do not count for the new one');
	h.game.stop();
	assert.deepStrictEqual(Object.values(h.store.bindings.get(key).heard), [[[10 * MIN_MS, 16 * MIN_MS]]]);
});

test('under strict with locked_watches ignore, nothing is recorded while the inventory is not known', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const key = await linkSlot(h);
	const counts = runtime(h, key).counts;
	runtime(h, key).counts = null;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 10 * MIN_MS));
	await h.game._internal.idle();
	runtime(h, key).counts = counts;
	h.game.stop();
	assert.deepStrictEqual(h.store.bindings.get(key).heard, {}, 'any title might be locked');
});
test('under strict a binding holding 4,096 ranges judges a title not started yet on each stretch alone, and keeps nothing of it', async (t) => {
	const h = await setup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	const full = {};
	for (let i = 0; i < 64; i++) full[`movie|filler-${i}`] = Array.from({ length: 64 }, (_, j) => [j * 100000, j * 100000 + 50000]);
	h.store.bindings.patch(key, { heard: full });
	const [, m15, m30] = MATRIX.ids;
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 10 * MIN_MS));
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 10 * MIN_MS, 16 * MIN_MS, AFTER + 1000));
	await h.game._internal.idle();
	assert.ok(!earned(h, key, m15), 'two sittings do not add up: the first was not kept');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 0, 16 * MIN_MS, AFTER + 2000));
	await waitFor(() => h.server.checkedOf(1).has(m15), 'one sitting from 0:00 still earns 15:00');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 15 * MIN_MS, 31 * MIN_MS, AFTER + 3000));
	await waitFor(() => h.server.checkedOf(1).has(m30), 'and the earned 15:00 carries on');
	h.game.stop();
	const heard = h.store.bindings.get(key).heard;
	assert.ok(!Object.keys(heard).some((k) => k.startsWith('movie|plex')), 'The Matrix keeps nothing');
	assert.strictEqual(Object.keys(heard).length, 64);
});

// --- traps and useful items (world 0.3.0) ----------------------------------------------------------
//
// The voice and book effects belong to helpers/apMediaTraps.js; here a recording stand-in plays the
// runner the game is handed (trapRunner), the trap timers are fired by hand (trapTimers), and a book
// engine change runs its follow-up at once (trapDefer). Items reach the slot from the AP stand-in as
// another world would send them. The emoji are built with String.fromCharCode, so the file stays ASCII.

const TRAP = (key) => contracts.TRAPS[key].id;
const FF = contracts.IDS.fastForward;
const RC = contracts.IDS.remoteControl;
const SNACK = contracts.SNACKS;
const E = Object.freeze({
	done: String.fromCharCode(0x2705),
	buffering: String.fromCharCode(0x23f3),
	expired: String.fromCharCode(0x26d4),
	trap: String.fromCodePoint(0x1f3ac),
	remote: String.fromCodePoint(0x1f4fa),
	forward: String.fromCharCode(0x23e9),
	snack: String.fromCodePoint(0x1f37f),
	dodged: String.fromCodePoint(0x1f340),
	slow: String.fromCodePoint(0x1f422),
	unlocked: String.fromCodePoint(0x1f513),
});
const HOUR_MS = 60 * MIN_MS;
const stampOf = (ms) => `<t:${Math.floor(ms / 1000)}:t>`;
const MUSIC = Object.freeze({ where: 'music', guildId: 'g1', channelId: 'c1' });
const BOOK = Object.freeze({ where: 'book', guildId: 'g1', channelId: 'c1' });
const MATRIX_KEY = 'movie|plex://movie/5d7768b2';
const ALBUM_KEY = 'album|plex://album/2300';
const WAITS = (name) => `${E.trap} \`ZackPlex\` got ${name} from \`Watcher\`: it hits during their next listen through the bot, within 12 hours.`;
const BUSY = (name) => `${E.trap} \`ZackPlex\` got ${name} from \`Watcher\`: it hits as soon as the bot can, within 12 hours.`;

// The other track of the agreed interface (helpers/apMediaTraps.js createTrapRunner), recording calls.
// The game makes it through trapRunner(opts), so ended() can send the end notice the runner's onEnd does.
function fakeRunner() {
	const r = {
		calls: [],
		listeners: new Map(),
		results: [],
		endResult: true,
		onEnd: null,
		async ended(kind, line, how = 'done', userId = OWNER, slot = SLOT, more = {}) {
			await r.onEnd({ userId, slot, kind, where: 'music', line, how, ...more });
		},
		listening(userId) {
			r.calls.push(['listening', String(userId)]);
			return r.listeners.get(String(userId)) || null;
		},
		async apply(kind, ctx) {
			r.calls.push(['apply', kind, ctx.userId, ctx.slot]);
			return r.results.length ? r.results.shift() : { applied: true, line: `${kind} line` };
		},
		async end(userId) {
			r.calls.push(['end', String(userId)]);
			return r.endResult;
		},
		async restore(record) {
			r.calls.push(['restore', record]);
		},
		stop() {
			r.calls.push(['stop']);
		},
		applied: () => r.calls.filter((c) => c[0] === 'apply').map((c) => c[1]),
		of: (name) => r.calls.filter((c) => c[0] === name),
	};
	return r;
}

async function trapSetup(t, options = {}) {
	const runner = fakeRunner();
	const trapTimers = handTimers();
	const make = (opts) => {
		runner.onEnd = opts.onEnd;
		return runner;
	};
	const h = await setup(t, { ...options, game: { trapRunner: make, trapTimers, trapDefer: (fn) => fn(), ...(options.game || {}) } });
	h.runner = runner;
	h.trapTimers = trapTimers;
	return h;
}

const binding = (h, key) => h.store.bindings.get(key);

/** Items as another world sends them, in one ReceivedItems, and everything the game does with them. */
async function sendItems(h, key, ids, player = 2) {
	const before = binding(h, key).itemsSeen;
	h.server.pushItems(1, ids.map((item) => ({ item, location: 999, player, flags: 0 })));
	await waitFor(() => binding(h, key).itemsSeen === before + ids.length, `${ids.length} items`);
	await h.game._internal.trapsIdle();
}

/** Every line posted since the last call, one per line, once the trap work has settled. */
async function trapPosts(h) {
	await h.game._internal.trapsIdle();
	await h.game._internal.flushAll();
	const lines = h.discord.posts.flatMap((p) => p.content.split('\n'));
	h.discord.posts.length = 0;
	return lines;
}

async function tick(h, ms = 60000) {
	h.trapTimers.fire(ms);
	await h.game._internal.trapsIdle();
}

/** A new process over the same store: memory and timers gone, the binding as it was saved. */
async function restartGame(h, meanwhile = null) {
	h.game.stop();
	if (meanwhile) meanwhile();
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	await waitFor(() => h.game.status().bindings.every((r) => r.inventoryKnown), 'the slot back after the restart');
	await h.game._internal.trapsIdle();
}

/** As sendItems while the runner holds a trap in flight: waits for the queue, not for the runner's answer. */
async function pushItems(h, key, ids) {
	const before = binding(h, key).itemsSeen;
	h.server.pushItems(1, ids.map((item) => ({ item, location: 999, player: 2, flags: 0 })));
	await waitFor(() => binding(h, key).itemsSeen === before + ids.length, `${ids.length} items`);
	await h.game._internal.idle();
}

/** A runner whose apply() answers only when the test says, so a trap stays in flight meanwhile. */
function holdApply(h) {
	const gate = { answer: null };
	h.runner.apply = (kind, ctx) => {
		h.runner.calls.push(['apply', kind, ctx.userId, ctx.slot]);
		return new Promise((resolve) => { gate.answer = resolve; });
	};
	return gate;
}

/** The room out of reach (its watch re-pointed at a closed port), then back: the inventory is unknown in between. */
async function roomAway(h, key) {
	h.monitor.put(0, { target: { kind: 'direct', host: '127.0.0.1', port: 9 } }, 'repointed');
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).inventoryKnown, false);
}

async function roomBack(h, key) {
	h.monitor.put(0, { target: h.server.target }, 'repointed');
	await waitFor(() => row(h, key).inventoryKnown, 'the room back');
	await h.game._internal.trapsIdle();
}

test('the item cursor: a late link fires no backlog, and a reconnect, which sends every item again, fires nothing twice', async (t) => {
	const backlog = [TRAP('rewind'), TRAP('buffering'), RC].map((item) => ({ item, location: 5, player: 2, flags: 0 }));
	const h = await trapSetup(t, { server: { received: { 1: backlog } } });
	const key = await linkSlot(h);
	await h.game._internal.trapsIdle();
	const b = binding(h, key);
	assert.strictEqual(b.itemsSeen, START.length + backlog.length, 'the start inventory and the backlog, seen');
	assert.deepStrictEqual([b.armed, b.holdMs, b.rcUsed], [[], 0, 0], 'and none of it fired');
	assert.deepStrictEqual(h.runner.applied(), []);
	assert.strictEqual((await trapPosts(h)).length, 4, 'the welcome alone');
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 1, bought: 0, used: 0, available: 1 }, 'the backlog\'s Remote Control is on hand');

	h.store.bindings.patch(key, { rcUsed: 1 });
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => [x.kind, x.from, x.told]), [['rewind', 'Watcher', true]]);
	assert.deepStrictEqual(await trapPosts(h), [WAITS('Rewind')]);

	const client = runtime(h, key).client;
	for (const socket of h.server.clientsOn(1)) socket.socket.terminate();
	await waitFor(() => !client.connected, 'the drop');
	reconnectNow(client);
	await waitFor(() => client.connected && client.inventoryKnown, 'the reconnect');
	await h.game._internal.trapsIdle();
	assert.strictEqual(binding(h, key).itemsSeen, START.length + backlog.length + 1);
	assert.strictEqual(binding(h, key).armed.length, 1, 'the whole list again, and nothing armed twice');
	assert.deepStrictEqual(await trapPosts(h), []);
});

test('a burst hits with two traps at most, and the rest are announced as dodged', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [TRAP('buffering'), TRAP('rights_expired'), TRAP('rewind'), TRAP('intermission'), TRAP('shuffle_mode')]);
	const b = binding(h, key);
	assert.strictEqual(b.holdMs, 15 * MIN_MS);
	assert.deepStrictEqual(b.expired, { [MATRIX_KEY]: h.clock + 45 * MIN_MS }, 'nothing plays, so the first ready title');
	assert.deepStrictEqual(b.armed, []);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.buffering} \`ZackPlex\` got Buffering from \`Watcher\`: the checks of its next credit wait 15 minutes.`,
		`${E.expired} \`ZackPlex\` got Rights Expired from \`Watcher\`: the checks of **The Matrix (1999)** wait until ${stampOf(h.clock + 45 * MIN_MS)}.`,
		`${E.dodged} \`ZackPlex\` dodged Rewind from \`Watcher\`, Intermission from \`Watcher\` and Shuffle Mode from \`Watcher\`: at most 2 traps hit at once.`,
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => e.outcome), ['hit', 'hit', 'dodged', 'dodged', 'dodged']);
});

test('a voice trap with apMediaVoiceTraps off fizzles before the burst count and a kept Remote Control, which go to the traps that act', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [RC]);
	await trapPosts(h);
	h.config.apMediaVoiceTraps = false;
	await sendItems(h, key, [TRAP('rewind'), TRAP('intermission'), TRAP('buffering'), TRAP('rights_expired')]);
	const b = binding(h, key);
	assert.deepStrictEqual([b.armed, b.holdMs, b.rcUsed], [[], 0, 1], 'the Remote Control blocked the Buffering');
	assert.deepStrictEqual(b.expired, { [MATRIX_KEY]: h.clock + 45 * MIN_MS }, 'and the Rights Expired, second in the burst, hit');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.remote} \`ZackPlex\`: Remote Control blocked Buffering from \`Watcher\`.`,
		`${E.expired} \`ZackPlex\` got Rights Expired from \`Watcher\`: the checks of **The Matrix (1999)** wait until ${stampOf(h.clock + 45 * MIN_MS)}.`,
		`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` and Intermission from \`Watcher\` fizzled: voice traps are off on this server.`,
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [
		['buffering', 'blocked'], ['rights_expired', 'hit'], ['rewind', 'fizzled'], ['intermission', 'fizzled'],
	]);
});

test('a Rights Expired with no title open to lose says so and takes no burst place and no Remote Control', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	h.server.checkFromElsewhere(1, ALL_LOCATIONS);
	await waitFor(() => row(h, key).ready === 0, 'nothing open');
	await sendItems(h, key, [RC]);
	await trapPosts(h);
	await sendItems(h, key, [TRAP('rights_expired'), TRAP('rewind'), TRAP('intermission')]);
	const b = binding(h, key);
	assert.deepStrictEqual([b.expired, b.rcUsed, b.armed.map((x) => x.kind)], [{}, 1, ['intermission']], 'the Remote Control blocked the Rewind');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.expired} \`ZackPlex\` got Rights Expired from \`Watcher\`, but none of its titles is open to lose.`,
		`${E.remote} \`ZackPlex\`: Remote Control blocked Rewind from \`Watcher\`.`,
		WAITS('Intermission'),
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [
		['rights_expired', 'fizzled'], ['rewind', 'blocked'], ['intermission', 'armed'],
	]);
});

test('a voice trap with 20 traps waiting already fizzles before the burst count and a kept Remote Control, and its batch makes and takes room as it goes', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [RC]);
	await trapPosts(h);
	h.store.bindings.patch(key, { armed: Array.from({ length: 20 }, () => ({ kind: 'intermission', at: h.clock, from: 'Watcher', told: true })) });
	await sendItems(h, key, [TRAP('rewind'), TRAP('buffering')]);
	const b = binding(h, key);
	assert.deepStrictEqual([b.armed.length, b.holdMs, b.rcUsed], [20, 0, 1], 'the Remote Control blocked the Buffering');
	assert.ok(!b.armed.some((x) => x.kind === 'rewind'));
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.remote} \`ZackPlex\`: Remote Control blocked Buffering from \`Watcher\`.`,
		`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` fizzled: 20 traps already wait to hit.`,
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [['buffering', 'blocked'], ['rewind', 'fizzled']]);

	// The Remote Control blocks the oldest trap waiting, the Rewind arms in its place, and the Shuffle Mode finds no room.
	h.events.length = 0;
	await sendItems(h, key, [RC, TRAP('rewind'), TRAP('shuffle_mode')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), [...Array(19).fill('intermission'), 'rewind']);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.remote} \`ZackPlex\`: Remote Control blocked Intermission from \`Watcher\`.`,
		`${E.trap} \`ZackPlex\`: Shuffle Mode from \`Watcher\` fizzled: 20 traps already wait to hit.`,
		WAITS('Rewind'),
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [
		['rewind', 'armed'], ['shuffle_mode', 'fizzled'], ['intermission', 'blocked'],
	]);

	// With no Remote Control left, the two traps after the one with no room both hit.
	h.events.length = 0;
	await sendItems(h, key, [TRAP('intermission'), TRAP('buffering'), TRAP('rights_expired')]);
	assert.deepStrictEqual([binding(h, key).armed.length, binding(h, key).holdMs, binding(h, key).expired], [20, 15 * MIN_MS, { [MATRIX_KEY]: h.clock + 45 * MIN_MS }]);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.buffering} \`ZackPlex\` got Buffering from \`Watcher\`: the checks of its next credit wait 15 minutes.`,
		`${E.expired} \`ZackPlex\` got Rights Expired from \`Watcher\`: the checks of **The Matrix (1999)** wait until ${stampOf(h.clock + 45 * MIN_MS)}.`,
		`${E.trap} \`ZackPlex\`: Intermission from \`Watcher\` fizzled: 20 traps already wait to hit.`,
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [
		['buffering', 'hit'], ['rights_expired', 'hit'], ['intermission', 'fizzled'],
	]);
});

test('a Remote Control kept on hand blocks the next trap, and one arriving during Buffering ends it and sends what it held', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 1, bought: 0, used: 0, available: 1 });
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 1, bought: 0, used: 1, available: 0 });
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.remote} \`ZackPlex\` got a Remote Control from \`Watcher\`: it blocks the next trap.`,
		`${E.remote} \`ZackPlex\`: Remote Control blocked Rewind from \`Watcher\`.`,
	]);

	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).held.length, MATRIX.ids.length);
	assert.ok(!MATRIX.ids.some((id) => h.server.checkedOf(1).has(id)), 'nothing sent while Buffering runs');
	await trapPosts(h);
	await sendItems(h, key, [RC]);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the held checks');
	const b = binding(h, key);
	assert.deepStrictEqual([b.held, b.holdUntil, b.rcUsed], [[], null, 2]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.remote} \`ZackPlex\`: Remote Control ended Buffering, 9 checks sent.`]);
});

test('a Remote Control ends the pause playing for the player through the runner, puts a Slow Motion speed back, and blocks a trap still waiting', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: true, line: 'the music pauses for 60 s', until: h.clock + 60000 });
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(h.runner.of('apply'), [['apply', 'intermission', OWNER, SLOT]]);
	assert.deepStrictEqual(row(h, key).effect, { kind: 'intermission', name: 'Intermission', until: h.clock + 60000 });
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(h.runner.of('end'), [['end', OWNER]]);
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the music pauses for 60 s`,
		`${E.remote} \`ZackPlex\`: Remote Control ended Intermission.`,
	]);
	await h.runner.ended('intermission', 'the music plays again');
	assert.deepStrictEqual(await trapPosts(h), [], 'no end line for a pause the Remote Control ended');

	// A pause the runner had ended already, its end notice still on the way: the Remote Control is
	// not spent on it, and says so.
	h.runner.results.push({ applied: true, line: 'commercial_break line', until: h.clock + 30000 });
	await sendItems(h, key, [TRAP('commercial_break')]);
	h.runner.endResult = false;
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 2, bought: 0, used: 1, available: 1 });
	assert.strictEqual(row(h, key).effect, null);
	await h.runner.ended('commercial_break', 'someone resumed the music early', 'early');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Commercial Break from \`Watcher\`: commercial\\_break line`,
		`${E.remote} \`ZackPlex\` got a Remote Control from \`Watcher\`: Commercial Break was over already, so it blocks the next trap.`,
	]);
	h.store.bindings.patch(key, { rcUsed: 2 });

	h.runner.listeners.set(OWNER, BOOK);
	const record = { kind: 'speed', workId: 'jane-austen/pride-and-prejudice', previous: 1.25, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: record });
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.deepStrictEqual(binding(h, key).speedRestore, record);
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r), [{ ...record, until: h.clock, userId: OWNER, slot: SLOT }], 'at once');
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Slow Motion from \`Watcher\`: 0.75x for 10 minutes`,
		`${E.remote} \`ZackPlex\`: Remote Control ended Slow Motion.`,
	]);

	h.runner.listeners.clear();
	await sendItems(h, key, [TRAP('rewind'), TRAP('intermission')]);
	await trapPosts(h);
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['intermission'], 'the oldest one waiting');
	assert.deepStrictEqual(await trapPosts(h), [`${E.remote} \`ZackPlex\`: Remote Control blocked Rewind from \`Watcher\`.`]);

	// A pause the runner had ended already, with a trap waiting behind it: the Remote Control blocks that one.
	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: true, line: 'the music pauses', until: h.clock + 60000 }, { applied: false, reason: 'busy' });
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind'], 'busy behind the Intermission');
	h.runner.endResult = false;
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.strictEqual(row(h, key).remoteControls.available, 0, 'spent on the Rewind');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the music pauses`,
		BUSY('Rewind'),
		`${E.remote} \`ZackPlex\`: Remote Control blocked Rewind from \`Watcher\`.`,
	]);
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').slice(-1).map((e) => [e.trap, e.outcome]), [['rewind', 'blocked']]);
});

test('Buffering holds the checks of the next credit for 15 minutes, 15 more a time up to 60, counts them for dedupe, and lets them go on time', async (t) => {
	const h = await trapSetup(t, { config: { apMediaAnnounce: 'all' } });
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [TRAP('buffering')]);
	await sendItems(h, key, [TRAP('buffering')]);
	assert.deepStrictEqual([binding(h, key).holdMs, binding(h, key).holdUntil], [30 * MIN_MS, null], 'waiting for the next credit');
	assert.deepStrictEqual(row(h, key).holds, { held: 0, buffering: null, bufferingNextMs: 30 * MIN_MS, expired: [] });
	await trapPosts(h);
	const sent = sentChecks(h).length;
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	const until = h.clock + 30 * MIN_MS;
	const b = binding(h, key);
	assert.deepStrictEqual([b.holdUntil, b.holdMs, b.held.length, b.pending.length], [until, 0, 9, 0]);
	assert.strictEqual(sentChecks(h).length, sent, 'nothing sent');
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`]);

	let writes = 0;
	const patch = h.store.bindings.patch;
	h.store.bindings.patch = (...args) => {
		writes += 1;
		return patch(...args);
	};
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk, { at: AFTER + 1000 }));
	await h.game._internal.idle();
	h.store.bindings.patch = patch;
	assert.strictEqual(writes, 0, 'a held check counts as earned for a repeat');

	const manual = await h.game.creditManual(key, HALLOWEEN.key, { atMs: '31m' });
	assert.strictEqual(manual.message, `${E.buffering} **Halloween (2018)**: 2 checks held by a trap until ${stampOf(until)}.`);
	h.server.checkFromElsewhere(1, [MATRIX.ids[0]]);
	await waitFor(() => !binding(h, key).held.includes(MATRIX.ids[0]), 'a hold to let go of what the room has checked');

	for (let i = 0; i < 3; i++) await sendItems(h, key, [TRAP('buffering')]);
	assert.strictEqual(binding(h, key).holdUntil, h.clock + HOUR_MS, '30 minutes, and 15 more three times, held to 60');
	await trapPosts(h);
	assert.deepStrictEqual(row(h, key).holds.buffering, { until: h.clock + HOUR_MS, held: 10 });

	h.clock += HOUR_MS;
	await tick(h, HOUR_MS);
	await waitFor(() => hasAll(h.server.checkedOf(1), [...MATRIX.ids, loc(57), loc(58)]), 'every held check');
	assert.deepStrictEqual([binding(h, key).held, binding(h, key).holdUntil], [[], null]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\`: Buffering is over, 10 checks sent.`]);
});

test('a hold outlasts a restart: one still running keeps its time, one that ran out meanwhile ends at the start, and an unlink counts it', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	const until = h.clock + 15 * MIN_MS;
	assert.strictEqual(binding(h, key).holdUntil, until);
	await trapPosts(h);

	await restartGame(h, () => { h.clock += 5 * MIN_MS; });
	assert.deepStrictEqual([binding(h, key).holdUntil, binding(h, key).held.length], [until, 9], 'still running');
	assert.ok(h.trapTimers.delays().includes(10 * MIN_MS), 'its timer, for the time left');
	assert.ok(!MATRIX.ids.some((id) => h.server.checkedOf(1).has(id)));

	await restartGame(h, () => { h.clock += 20 * MIN_MS; });
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'released at the start');
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\`: Buffering is over, 9 checks sent.`]);

	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(2002));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).held.length, HALLOWEEN.ids.length);
	const gone = await h.game.unlink(key);
	assert.match(gone.message, /Its 7 unsent checks went with it\./);
});

test('a hold that cannot end yet sets no timer that fires again at once', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.ok(h.trapTimers.delays().includes(15 * MIN_MS));
	h.store.bindings.patch(key, { state: 'stale' });
	h.clock += 16 * MIN_MS;
	await tick(h, 15 * MIN_MS);
	assert.deepStrictEqual(h.trapTimers.delays(), [60000], 'the minute check alone');
	assert.strictEqual(binding(h, key).held.length, MATRIX.ids.length, 'a stale slot has no room to send them to');
});

test('Rights Expired takes the title playing now, else the first ready one, holds its credit 45 minutes, shows in the list and status, and outlasts a restart', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.pms.sessionRows = [{ ratingKey: '2002', viewOffset: 600000, duration: 6360000, User: { id: '1', title: 'Owner' }, Player: { state: 'playing' }, Session: { id: 's1' } }];
	await h.game._internal.watcher().pollSessions();
	await sendItems(h, key, [TRAP('rights_expired')]);
	const until = h.clock + 45 * MIN_MS;
	assert.deepStrictEqual(binding(h, key).expired, { [HALLOWEEN.key]: until }, 'the Plex session of the consented account');
	await h.game._internal.handleEvent(historyEvent(2002));
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'another title, not held');
	assert.strictEqual(binding(h, key).held.length, HALLOWEEN.ids.length);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.expired} \`ZackPlex\` got Rights Expired from \`Watcher\`: the checks of **Halloween (2018)** wait until ${stampOf(until)}.`,
		`${E.buffering} \`ZackPlex\` watched **Halloween (2018)**, 7 checks held until ${stampOf(until)}`,
		`${E.done} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks sent`,
	]);

	const ready = h.game.list(key, 'ready');
	const rows = ready.groups[0].rows;
	const marked = rows.find((r) => r.entryKey === HALLOWEEN.key);
	assert.strictEqual(marked.expiredUntil, until);
	assert.ok(!rows.find((r) => r.entryKey === 'movie|rk:2003').expiredUntil, 'its twin keeps its rights');
	const listCommand = require('../commands/apmedia.js/list.js');
	assert.ok(listCommand.rowLine(marked, ready.groups[0], 'ready').endsWith(` ${E.expired} Rights expired until ${stampOf(until)}`));
	const status = row(h, key);
	assert.deepStrictEqual(status.holds.expired, [{ entryKey: HALLOWEEN.key, title: 'Halloween (2018)', until, held: 7 }]);
	const statusCommand = require('../commands/apmedia.js/status.js');
	assert.ok(statusCommand.itemLines(status).includes(`> ${E.expired} Rights expired until ${stampOf(until)}: **Halloween (2018)**, 7 checks held.`));

	await restartGame(h, () => { h.clock += 46 * MIN_MS; });
	await waitFor(() => hasAll(h.server.checkedOf(1), HALLOWEEN.ids), 'released at the start');
	assert.deepStrictEqual(binding(h, key).expired, {});
	assert.deepStrictEqual(await trapPosts(h), [`${E.expired} \`ZackPlex\`: the rights to **Halloween (2018)** are back, 7 checks sent.`]);

	// A list track playing in voice for the player, and a book session of theirs, are playing now too.
	await sendItems(h, key, [unit(1), unit(4)]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.bot.songQueue = [{ ratingKey: 23002, title: 'Aerodynamic', artist: 'Daft Punk', key: '/library/parts/230002/file.mp3' }];
	await sendItems(h, key, [TRAP('rights_expired')]);
	assert.deepStrictEqual(Object.keys(binding(h, key).expired), [ALBUM_KEY]);
	h.runner.listeners.clear();
	h.bot.books.list = [{ id: 'b1', userId: OWNER, workId: 'jane-austen/pride-and-prejudice', state: 'playing' }];
	await sendItems(h, key, [TRAP('rights_expired')]);
	assert.deepStrictEqual(Object.keys(binding(h, key).expired), [ALBUM_KEY, 'book|book:jane-austen/pride-and-prejudice']);
});

// Credit that comes while the slot's inventory is not known (at a boot, with the room out of reach,
// or while the slot is refused) waits in the bank until the next items say what is open.
test('credit banked while the inventory was unknown is held by its title\'s Rights Expired once the items come', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('rights_expired')]);
	const until = h.clock + 45 * MIN_MS;
	assert.deepStrictEqual(binding(h, key).expired, { [MATRIX_KEY]: until });
	await trapPosts(h);
	await roomAway(h, key);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).banked.length, MATRIX.ids.length);
	await roomBack(h, key);
	const b = binding(h, key);
	assert.deepStrictEqual([b.banked.length, b.held.length, b.pending.length], [0, MATRIX.ids.length, 0], 'held, not sent');
	assert.deepStrictEqual(row(h, key).holds.expired, [{ entryKey: MATRIX_KEY, title: 'The Matrix (1999)', until, held: 9 }]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`]);
	h.clock = until;
	await tick(h, 45 * MIN_MS);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'sent when the rights are back');
	assert.deepStrictEqual(await trapPosts(h), [`${E.expired} \`ZackPlex\`: the rights to **The Matrix (1999)** are back, 9 checks sent.`]);
});

test('credit banked while the inventory was unknown is held by its title\'s Rights Expired after a restart too, and said so, when nothing is left in memory of how it was banked', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('rights_expired')]);
	const until = h.clock + 45 * MIN_MS;
	await trapPosts(h);
	await roomAway(h, key);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).banked.length, MATRIX.ids.length);
	h.game.stop();
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	await h.game._internal.idle();
	await roomBack(h, key);
	const b = binding(h, key);
	assert.deepStrictEqual([b.banked.length, b.held.length, b.pending.length], [0, MATRIX.ids.length, 0], 'a title whose rights are out holds every check of its own');
	assert.ok(!MATRIX.ids.some((id) => h.server.checkedOf(1).has(id)));
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`], 'as it would have been without the restart');
	h.clock = until;
	await tick(h, 45 * MIN_MS);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'sent when the rights are back');
	assert.deepStrictEqual(await trapPosts(h), [`${E.expired} \`ZackPlex\`: the rights to **The Matrix (1999)** are back, 9 checks sent.`]);
});

test('credit banked for two titles under their own Rights Expired is held after a restart, and each title\'s line names its own end, whichever was banked first', async (t) => {
	// Either order alone misses a wrong end: a title given the latest end held so far looks right
	// when the earlier end is banked first, and one given the earliest so far when the later one is.
	for (const laterFirst of [true, false]) {
		const h = await trapSetup(t);
		const key = await linkSlot(h);
		await sendItems(h, key, [TRAP('rights_expired')]);
		const matrixUntil = h.clock + 45 * MIN_MS;
		h.clock += 5 * MIN_MS;
		await sendItems(h, key, [TRAP('rights_expired')]);
		const halloweenUntil = h.clock + 45 * MIN_MS;
		assert.deepStrictEqual(binding(h, key).expired, { [MATRIX_KEY]: matrixUntil, [HALLOWEEN.key]: halloweenUntil }, 'the second takes the next ready title');
		await trapPosts(h);
		const matrix = [MATRIX.rk, `${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(matrixUntil)}`];
		const halloween = [2002, `${E.buffering} \`ZackPlex\` watched **Halloween (2018)**, 7 checks held until ${stampOf(halloweenUntil)}`];
		const bankOrder = laterFirst ? [halloween, matrix] : [matrix, halloween];
		await roomAway(h, key);
		for (const [rk] of bankOrder) await h.game._internal.handleEvent(historyEvent(rk));
		await h.game._internal.idle();
		assert.strictEqual(binding(h, key).banked.length, MATRIX.ids.length + HALLOWEEN.ids.length);
		h.game.stop();
		h.game = h.make();
		h.game.start({ discord: h.discord, bot: h.bot });
		await h.game._internal.idle();
		await roomBack(h, key);
		const b = binding(h, key);
		assert.deepStrictEqual([b.banked.length, b.held.length, b.pending.length], [0, MATRIX.ids.length + HALLOWEEN.ids.length, 0]);
		assert.deepStrictEqual(await trapPosts(h), bankOrder.map(([, line]) => line), laterFirst ? 'Halloween, the later end, banked first' : 'The Matrix, the earlier end, banked first');
		h.clock = matrixUntil;
		await tick(h, 40 * MIN_MS);
		await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'The Matrix sent at its own end');
		assert.ok(!HALLOWEEN.ids.some((id) => h.server.checkedOf(1).has(id)), 'Halloween waits for its own');
		assert.deepStrictEqual(await trapPosts(h), [`${E.expired} \`ZackPlex\`: the rights to **The Matrix (1999)** are back, 9 checks sent.`]);
	}
});

test('the tracks a Rights Expired already holds count toward their album, so the track that finishes it is announced as held', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [unit(1)]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.bot.songQueue = [{ ratingKey: 23001, title: 'One More Time', artist: 'Daft Punk', key: '/library/parts/230001/file.mp3' }];
	await sendItems(h, key, [TRAP('rights_expired')]);
	h.runner.listeners.clear();
	const until = h.clock + 45 * MIN_MS;
	await trapPosts(h);
	await h.game._internal.handleEvent(historyEvent(23001));
	await h.game._internal.idle();
	assert.deepStrictEqual(await trapPosts(h), [], 'one track does not finish the album');
	await h.game._internal.handleEvent(historyEvent(23002));
	await h.game._internal.handleEvent(historyEvent(23004));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).held.length, 5);
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` listened to **Daft Punk - Discovery**, 2 checks held until ${stampOf(until)}`]);
});

test('the tracks a Rights Expired held before a restart count toward their album, so the banked rest held after it is announced as finishing the album', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [unit(1)]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.bot.songQueue = [{ ratingKey: 23001, title: 'One More Time', artist: 'Daft Punk', key: '/library/parts/230001/file.mp3' }];
	await sendItems(h, key, [TRAP('rights_expired')]);
	h.runner.listeners.clear();
	const until = h.clock + 45 * MIN_MS;
	assert.deepStrictEqual(binding(h, key).expired, { [ALBUM_KEY]: until });
	await trapPosts(h);
	// A movie is finished by its one watch location alone, so only a title of several tracks shows
	// whether the ones held before the restart count.
	await h.game._internal.handleEvent(historyEvent(23001));
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).held, [loc(1), loc(4)], 'the first track and the 5-minute checkpoint it passed');
	assert.deepStrictEqual(await trapPosts(h), [], 'one track does not finish the album');
	await roomAway(h, key);
	await h.game._internal.handleEvent(historyEvent(23002));
	await h.game._internal.handleEvent(historyEvent(23004));
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).banked, [loc(2), loc(3), loc(5)]);
	h.game.stop();
	h.game = h.make();
	h.game.start({ discord: h.discord, bot: h.bot });
	await h.game._internal.idle();
	await roomBack(h, key);
	const b = binding(h, key);
	assert.deepStrictEqual([b.banked.length, b.held.length, b.pending.length], [0, 5, 0]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` listened to **Daft Punk - Discovery**, 3 checks held until ${stampOf(until)}`]);
});

test('credit banked while the inventory was unknown waits out a running Buffering, and checks that waited for an unlock still go out', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(2002));
	await h.game._internal.idle();
	const until = h.clock + 15 * MIN_MS;
	assert.deepStrictEqual([binding(h, key).holdUntil, binding(h, key).held.length, binding(h, key).banked.length], [until, 7, 8]);
	await trapPosts(h);
	await roomAway(h, key);
	h.clock += 2 * MIN_MS;
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	await roomBack(h, key);
	const b = binding(h, key);
	assert.deepStrictEqual([b.held.length, b.banked.length, b.pending.length, b.holdUntil], [16, 8, 0, until], 'The Matrix waits with Halloween; 1917 is still locked');
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`]);

	await receive(h, key, N1917.unit);
	await waitFor(() => hasAll(h.server.checkedOf(1), N1917.ids), 'the checks that waited for the unlock');
	assert.strictEqual(binding(h, key).held.length, 16, 'Buffering still holds the rest');
	assert.ok(![...MATRIX.ids, ...HALLOWEEN.ids].some((id) => h.server.checkedOf(1).has(id)));
	assert.deepStrictEqual(await trapPosts(h), [`${E.unlocked} \`ZackPlex\` **1917** unlocked, 8 checks sent`]);
});

test('credit banked while the inventory was unknown starts a Buffering that waits for the next credit', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('buffering')]);
	await trapPosts(h);
	await roomAway(h, key);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	await roomBack(h, key);
	const until = h.clock + 15 * MIN_MS;
	const b = binding(h, key);
	assert.deepStrictEqual([b.holdUntil, b.holdMs, b.held.length, b.pending.length], [until, 0, 9, 0]);
	assert.ok(h.trapTimers.delays().includes(15 * MIN_MS), 'its end is timed');
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`]);
	h.clock = until;
	await tick(h, 15 * MIN_MS);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'sent when Buffering is over');
});

test('checks that waited in the bank for a real unlock go out past a waiting Buffering, which still waits for the next credit', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await h.game._internal.handleEvent(historyEvent(N1917.rk));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).banked.length, N1917.ids.length);
	await sendItems(h, key, [TRAP('buffering')]);
	await trapPosts(h);
	await receive(h, key, N1917.unit);
	await waitFor(() => hasAll(h.server.checkedOf(1), N1917.ids), 'the checks that waited for the unlock');
	const b = binding(h, key);
	assert.deepStrictEqual([b.holdMs, b.holdUntil, b.held], [15 * MIN_MS, null, []], 'not new credit, so Buffering has not started');
	assert.deepStrictEqual(await trapPosts(h), [`${E.unlocked} \`ZackPlex\` **1917** unlocked, 8 checks sent`]);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	const until = h.clock + 15 * MIN_MS;
	const after = binding(h, key);
	assert.deepStrictEqual([after.holdUntil, after.holdMs, after.held.length], [until, 0, MATRIX.ids.length]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.buffering} \`ZackPlex\` watched **The Matrix (1999)**, 9 checks held until ${stampOf(until)}`]);
});

test('a voice trap waits armed for a listen, and hits through the runner on the next tick, a track start, a book change or a credit heard', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(await trapPosts(h), [WAITS('Rewind')]);
	assert.deepStrictEqual(row(h, key).armed, [{ kind: 'rewind', name: 'Rewind', from: 'Watcher', at: h.clock, until: h.clock + 12 * HOUR_MS }]);
	await tick(h);
	assert.deepStrictEqual(h.runner.applied(), [], 'nobody listening');
	assert.deepStrictEqual(await trapPosts(h), [], 'said once');

	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: true, line: 'back to the start of *this* track' });
	await tick(h);
	assert.deepStrictEqual(h.runner.of('apply'), [['apply', 'rewind', OWNER, SLOT]]);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: back to the start of \\*this\\* track`], 'the runner\'s words, escaped');

	h.runner.listeners.clear();
	await sendItems(h, key, [TRAP('shuffle_mode')]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.bot.emit('will play', {});
	assert.ok(h.trapTimers.delays().includes(3000), 'tried once the track is playing');
	await tick(h, 3000);
	assert.deepStrictEqual(h.runner.applied(), ['rewind', 'shuffle_mode']);

	h.runner.listeners.clear();
	await sendItems(h, key, [TRAP('commercial_break')]);
	h.runner.listeners.set(OWNER, BOOK);
	h.runner.results.push({ applied: true, line: 'the book pauses for 30 seconds', until: h.clock + 30000 });
	for (const fn of [...h.bot.books.listeners]) fn({ id: 'b1', userId: OWNER, state: 'playing' }, 'started');
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(h.runner.applied(), ['rewind', 'shuffle_mode', 'commercial_break']);
	await h.runner.ended('commercial_break', 'the book plays again');

	h.runner.listeners.clear();
	await sendItems(h, key, [TRAP('intermission')]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: true, line: 'the music pauses for 60 seconds', until: h.clock + 60000 });
	await h.game._internal.handleEvent({ type: 'complete', source: 'voice', userIds: [OWNER], ratingKey: 999999, title: 'x', artist: 'y', at: AFTER });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(h.runner.applied(), ['rewind', 'shuffle_mode', 'commercial_break', 'intermission']);
	for (const kind of ['rewind', 'shuffle_mode']) await h.runner.ended(kind, 'the music plays again');
	await h.runner.ended('intermission', 'the music plays again');
	const lines = await trapPosts(h);
	assert.ok(lines.includes(`${E.trap} \`ZackPlex\`: Commercial Break is over, the book plays again.`), lines.join('\n'));
	assert.ok(lines.includes(`${E.trap} \`ZackPlex\`: Intermission is over, the music plays again.`), lines.join('\n'));
	assert.ok(!lines.some((line) => /Shuffle Mode is over|Rewind is over/.test(line)), 'those are over when they hit');
});

test('a pause or a commercial clip is in force until the runner says it ended, with its words, and a Remote Control takes a clip off', async (t) => {
	const h = await trapSetup(t, { config: { apMediaTrapClips: 'Commercials' } });
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: true, line: 'the music pauses', until: h.clock + 45000 });
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(row(h, key).effect, { kind: 'intermission', name: 'Intermission', until: h.clock + 45000 });
	assert.deepStrictEqual(h.trapTimers.delays(), [60000], 'the minute check alone: the runner times the pause');
	await h.runner.ended('intermission', 'someone resumed the music early', 'early', OWNER, 'Someone Else');
	await h.runner.ended('commercial_break', 'the music plays again');
	assert.notStrictEqual(row(h, key).effect, null, 'another slot\'s notice, or another trap\'s, ends nothing here');
	await h.runner.ended('intermission', 'someone resumed the music *early*', 'early');
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the music pauses`,
		`${E.trap} \`ZackPlex\`: Intermission is over, someone resumed the music \\*early\\*.`,
	]);
	await h.runner.ended('intermission', 'the music plays again');
	assert.deepStrictEqual(await trapPosts(h), [], 'once');

	h.runner.results.push({ applied: true, line: 'a commercial plays after this track' });
	await sendItems(h, key, [TRAP('commercial_break')]);
	assert.deepStrictEqual(row(h, key).effect, { kind: 'commercial_break', name: 'Commercial Break', until: null }, 'a clip, until it has played');
	h.clock += 2 * HOUR_MS;
	assert.notStrictEqual(row(h, key).effect, null, 'however long the track before it runs');
	assert.ok(require('../commands/apmedia.js/status.js').itemLines(row(h, key)).includes(`> ${E.trap} Commercial Break until its commercial has played.`));
	await h.runner.ended('commercial_break', 'the commercial is over');
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Commercial Break from \`Watcher\`: a commercial plays after this track`,
		`${E.trap} \`ZackPlex\`: Commercial Break is over.`,
	]);

	h.runner.results.push({ applied: true, line: 'a commercial plays after this track' });
	await sendItems(h, key, [TRAP('commercial_break')]);
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(h.runner.of('end'), [['end', OWNER]]);
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual((await trapPosts(h)).slice(-1), [`${E.remote} \`ZackPlex\`: Remote Control ended Commercial Break.`]);
});

test('an end notice with the runner\'s effect id ends only that effect, and a speed put back never ends a Slow Motion pause', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	h.runner.results.push({ applied: true, line: 'already at 0.75x, so the book pauses for 30 seconds', until: h.clock + 30000, id: 7 });
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.deepStrictEqual(row(h, key).effect, { kind: 'slow_motion', name: 'Slow Motion', until: h.clock + 30000 });
	await h.runner.ended('slow_motion', 'back to 1x', 'done', OWNER, SLOT, { where: 'book', speed: true });
	await h.runner.ended('slow_motion', 'the book plays again', 'done', OWNER, SLOT, { where: 'book', id: 6 });
	await h.game._internal.idle();
	assert.notStrictEqual(row(h, key).effect, null, 'an earlier Slow Motion\'s speed, or another effect, leaves the pause in force');
	await h.runner.ended('slow_motion', 'the book plays again', 'done', OWNER, SLOT, { where: 'book', id: 7 });
	await h.game._internal.idle();
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Slow Motion from \`Watcher\`: already at 0.75x, so the book pauses for 30 seconds`,
		`${E.trap} \`ZackPlex\`: Slow Motion is over, the book plays again.`,
	]);
});

test('a trap the runner cannot play now waits again, one it calls off fizzles, and a runner that throws is busy', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	h.runner.results.push({ applied: false, reason: 'busy' });
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => [x.kind, x.told]), [['rewind', true]]);
	assert.deepStrictEqual(await trapPosts(h), [BUSY('Rewind')], 'the player is listening, so it waits for the bot, not for a listen');
	h.runner.results.push({ applied: false, reason: 'absent' });
	await tick(h);
	assert.strictEqual(binding(h, key).armed.length, 1);
	assert.deepStrictEqual(await trapPosts(h), [], 'said once');
	h.runner.results.push({ applied: false, reason: 'off' });
	await tick(h);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` fizzled: voice traps are off on this server.`]);
	h.runner.apply = async () => { throw new Error('voice is gone'); };
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['intermission']);
	assert.ok(h.logger.lines.some((l) => l.level === 'warn' && l.text.includes('voice is gone')));
});

test('a trap the runner keeps calling busy stays on the binding, and each try writes nothing', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	h.runner.apply = async (kind, ctx) => {
		h.runner.calls.push(['apply', kind, ctx.userId, ctx.slot]);
		return { applied: false, reason: 'busy' };
	};
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => [x.kind, x.told]), [['intermission', true]]);
	assert.deepStrictEqual(await trapPosts(h), [BUSY('Intermission')]);
	let writes = 0;
	const patch = h.store.bindings.patch;
	h.store.bindings.patch = (...args) => {
		writes += 1;
		return patch(...args);
	};
	for (let i = 0; i < 3; i++) {
		// A book span every 10 s, and the minute check.
		await h.game._internal.handleEvent({ type: 'span', source: 'book', userIds: [OWNER], workId: 'nobody/nothing', fromMs: 0, toMs: 10000, at: AFTER });
		await h.game._internal.trapsIdle();
		await tick(h);
	}
	h.store.bindings.patch = patch;
	assert.strictEqual(h.runner.applied().length, 7, 'tried again at each');
	assert.strictEqual(writes, 0);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => [x.kind, x.told]), [['intermission', true]]);
	assert.deepStrictEqual(await trapPosts(h), [], 'its line once');
});

test('a trap in flight stays on the binding: a Remote Control meanwhile blocks the one behind it, and a trap taken off meanwhile that plays is still announced', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	const gate = holdApply(h);
	await pushItems(h, key, [TRAP('rewind'), TRAP('intermission')]);
	await waitFor(() => h.runner.applied().length === 1, 'the Rewind in flight');
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind', 'intermission']);
	await pushItems(h, key, [RC]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind'], 'the Remote Control took the one the runner is not playing');
	gate.answer({ applied: true, line: 'this track starts over' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.remote} \`ZackPlex\`: Remote Control blocked Intermission from \`Watcher\`.`,
		`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: this track starts over`,
	]);

	// A new seed's reset takes the armed traps off: a busy answer after it puts nothing back.
	await pushItems(h, key, [TRAP('shuffle_mode')]);
	await waitFor(() => h.runner.applied().length === 2, 'the Shuffle Mode in flight');
	h.store.bindings.patch(key, { armed: [] });
	gate.answer({ applied: false, reason: 'busy' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), []);

	await pushItems(h, key, [TRAP('commercial_break')]);
	await waitFor(() => h.runner.applied().length === 3, 'the Commercial Break in flight');
	await h.game.unlink(key);
	gate.answer({ applied: true, line: 'the music pauses for 30 seconds', until: h.clock + 30000 });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Commercial Break from \`Watcher\`: the music pauses for 30 seconds`], 'it played, so it is said');
	assert.strictEqual(h.game._internal.runtime(key), null, 'and nothing is kept for the slot');
});

test('a trap in flight is left to the runner\'s answer: voice traps turned off fizzle only the ones behind it, and a Remote Control that finds the effect over passes it by', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	const gate = holdApply(h);
	await pushItems(h, key, [TRAP('rewind'), TRAP('intermission')]);
	await waitFor(() => h.runner.applied().length === 1, 'the Rewind in flight');
	h.config.apMediaVoiceTraps = false;
	h.configStore.fire('apMediaVoiceTraps', false);
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind'], 'the Intermission fizzled, and the Rewind waits for its answer');
	gate.answer({ applied: true, line: 'this track starts over' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\`: Intermission from \`Watcher\` fizzled: voice traps are off on this server.`,
		`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: this track starts over`,
	], 'the Rewind played, so it never fizzled');
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [
		['rewind', 'armed'], ['intermission', 'armed'], ['intermission', 'fizzled'], ['rewind', 'hit'],
	]);
	h.config.apMediaVoiceTraps = true;

	// A Remote Control on a pause the runner finds over already blocks the trap behind the one in
	// flight, and with none behind it goes back on hand.
	await pushItems(h, key, [TRAP('intermission')]);
	await waitFor(() => h.runner.applied().length === 2, 'the Intermission in flight');
	gate.answer({ applied: true, line: 'the music pauses', until: h.clock + 60000 });
	await h.game._internal.trapsIdle();
	assert.strictEqual(row(h, key).effect.kind, 'intermission');
	h.runner.endResult = false;
	await pushItems(h, key, [TRAP('rewind'), TRAP('shuffle_mode')]);
	await waitFor(() => h.runner.applied().length === 3, 'the Rewind in flight');
	await pushItems(h, key, [RC]);
	await waitFor(() => h.runner.of('end').length === 1, 'the Remote Control at the runner');
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind']);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 1, bought: 0, used: 1, available: 0 });
	gate.answer({ applied: true, line: 'this track starts over' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the music pauses`,
		`${E.remote} \`ZackPlex\`: Remote Control blocked Shuffle Mode from \`Watcher\`.`,
		`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: this track starts over`,
	]);

	await pushItems(h, key, [TRAP('intermission')]);
	await waitFor(() => h.runner.applied().length === 4, 'the Intermission in flight');
	gate.answer({ applied: true, line: 'the music pauses', until: h.clock + 60000 });
	await h.game._internal.trapsIdle();
	await pushItems(h, key, [TRAP('rewind')]);
	await waitFor(() => h.runner.applied().length === 5, 'the Rewind in flight');
	await pushItems(h, key, [RC]);
	await waitFor(() => h.runner.of('end').length === 2, 'the Remote Control at the runner');
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind']);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 2, bought: 0, used: 1, available: 1 });
	gate.answer({ applied: true, line: 'this track starts over' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the music pauses`,
		`${E.remote} \`ZackPlex\` got a Remote Control from \`Watcher\`: Intermission was over already, so it blocks the next trap.`,
		`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: this track starts over`,
	]);
});

test('an armed trap fizzles after 12 hours or with apMediaVoiceTraps off; with apMediaTraps off every trap fizzles and the holds end', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [TRAP('rewind')]);
	await trapPosts(h);
	h.clock += 12 * HOUR_MS;
	await tick(h);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` fizzled: no listen through the bot in 12 hours.`]);

	h.config.apMediaVoiceTraps = false;
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(binding(h, key).armed, [], 'never armed');
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Intermission from \`Watcher\` fizzled: voice traps are off on this server.`]);
	h.config.apMediaVoiceTraps = true;
	await sendItems(h, key, [TRAP('slow_motion')]);
	await trapPosts(h);
	h.config.apMediaVoiceTraps = false;
	h.configStore.fire('apMediaVoiceTraps', false);
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Slow Motion from \`Watcher\` fizzled: voice traps are off on this server.`]);
	h.config.apMediaVoiceTraps = true;

	await sendItems(h, key, [TRAP('buffering')]);
	await h.game._internal.handleEvent(historyEvent(MATRIX.rk));
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).held.length, 9);
	await trapPosts(h);
	h.config.apMediaTraps = false;
	await sendItems(h, key, [TRAP('rewind'), TRAP('buffering')]);
	assert.deepStrictEqual([binding(h, key).armed, binding(h, key).holdMs], [[], 0]);
	h.configStore.fire('apMediaTraps', false);
	await waitFor(() => hasAll(h.server.checkedOf(1), MATRIX.ids), 'the held checks');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` and Buffering from \`Watcher\` fizzled: traps are off on this server.`,
		`${E.buffering} \`ZackPlex\`: traps are off on this server, so its holds ended, 9 checks sent.`,
	]);
	await h.game._internal.handleEvent(historyEvent(2002));
	await waitFor(() => hasAll(h.server.checkedOf(1), HALLOWEEN.ids), 'new credit goes out at once');
});

test('a line that says a switch is off names the one that is: a Slow Motion speed put back, and a trap the runner calls off', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	const record = { kind: 'speed', workId: 'jane-austen/pride-and-prejudice', previous: 1.25, until: h.clock + 10 * MIN_MS };
	for (const [name, words] of [['apMediaTraps', 'traps are off on this server'], ['apMediaVoiceTraps', 'voice traps are off on this server']]) {
		h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: record });
		await sendItems(h, key, [TRAP('slow_motion')]);
		await trapPosts(h);
		h.config[name] = false;
		h.configStore.fire(name, false);
		await h.game._internal.trapsIdle();
		assert.strictEqual(binding(h, key).speedRestore, null, name);
		assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion ended: ${words}.`], name);
		h.config[name] = true;
	}

	// apMediaTraps off while the runner plays a trap: the runner's answer is off, and the line names that switch.
	h.runner.listeners.set(OWNER, MUSIC);
	const gate = holdApply(h);
	const tried = h.runner.applied().length;
	await pushItems(h, key, [TRAP('rewind')]);
	await waitFor(() => h.runner.applied().length === tried + 1, 'the Rewind in flight');
	h.config.apMediaTraps = false;
	h.configStore.fire('apMediaTraps', false);
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind'], 'left to the runner\'s answer');
	gate.answer({ applied: false, reason: 'off' });
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Rewind from \`Watcher\` fizzled: traps are off on this server.`]);
	h.config.apMediaTraps = true;
});

test('a Slow Motion speed put back because apMediaTraps went off says so, even when the switch is on again before the runner answers', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	const record = { kind: 'speed', workId: 'jane-austen/pride-and-prejudice', previous: 1.25, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: record });
	await sendItems(h, key, [TRAP('slow_motion')]);
	await trapPosts(h);
	let answer = null;
	h.runner.restore = (r) => {
		h.runner.calls.push(['restore', r]);
		return new Promise((resolve) => { answer = resolve; });
	};
	h.config.apMediaTraps = false;
	h.configStore.fire('apMediaTraps', false);
	await h.game._internal.idle();
	await waitFor(() => answer !== null, 'the speed being put back');
	h.config.apMediaTraps = true;
	h.configStore.fire('apMediaTraps', true);
	await h.game._internal.idle();
	assert.strictEqual(h.runner.of('restore').length, 1, 'the sweep with the switch on again asks for nothing more');
	assert.deepStrictEqual(binding(h, key).speedRestore, record, 'kept until the runner answers');
	answer();
	await h.game._internal.trapsIdle();
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion ended: traps are off on this server.`]);
});

test('Slow Motion on a book saves its speed restore, puts the speed back when due, and after a restart before or after the time', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	const record = (until) => ({ kind: 'speed', workId: 'jane-austen/pride-and-prejudice', previous: 1.25, until });
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', until: h.clock + 10 * MIN_MS, restore: record(h.clock + 10 * MIN_MS) });
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.deepStrictEqual(binding(h, key).speedRestore, record(h.clock + 10 * MIN_MS));
	assert.deepStrictEqual(row(h, key).slowMotion, { until: h.clock + 10 * MIN_MS });
	assert.strictEqual(row(h, key).effect, null, 'a speed is the binding\'s own record, not an effect in force');
	assert.ok(h.trapTimers.delays().includes(10 * MIN_MS));
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Slow Motion from \`Watcher\`: 0.75x for 10 minutes`]);
	h.clock += 10 * MIN_MS;
	await h.runner.ended('slow_motion', 'back to 1.25x');
	await tick(h, 10 * MIN_MS);
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r), [{ ...record(h.clock), userId: OWNER, slot: SLOT }]);
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion is over.`]);

	const until = h.clock + 10 * MIN_MS;
	h.runner.results.push({ applied: true, line: 'slower', restore: record(until) });
	await sendItems(h, key, [TRAP('slow_motion')]);
	await trapPosts(h);
	h.runner.calls.length = 0;
	await restartGame(h, () => { h.clock += 4 * MIN_MS; });
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r), [{ ...record(until), userId: OWNER, slot: SLOT }], 'handed to the runner again');
	assert.deepStrictEqual(binding(h, key).speedRestore, record(until), 'and still waiting for its time');
	assert.ok(h.trapTimers.delays().includes(6 * MIN_MS));
	h.runner.calls.length = 0;
	await restartGame(h, () => { h.clock += 7 * MIN_MS; });
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r), [{ ...record(until), userId: OWNER, slot: SLOT }], 'overdue: put back at the start');
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion is over.`]);

	h.runner.results.push({ applied: true, line: 'slower', restore: record(h.clock + 10 * MIN_MS) });
	await sendItems(h, key, [TRAP('slow_motion')]);
	h.runner.calls.length = 0;
	await h.game.unlink(key);
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r.until), [h.clock], 'an unlink puts the speed back first');
});

test('turning apMediaEnabled off puts a Slow Motion speed back before the runner stops, and its record goes once the runner says the speed is back', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	// As the runner's finishRestore: a speed put back is told a turn later with `speed: true`, and a
	// restore put off while the book's new session is still starting is not told at all.
	let starting = false;
	h.runner.restore = async (record) => {
		h.runner.calls.push(['restore', record]);
		if (starting) return;
		Promise.resolve().then(() => h.runner.onEnd({ userId: record.userId, slot: record.slot, kind: 'slow_motion', where: 'book', line: `back to ${record.previous}x`, how: 'overdue', speed: true }));
	};
	const record = { kind: 'speed', workId: 'jane-austen/pride-and-prejudice', previous: 1.25, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: record });
	await sendItems(h, key, [TRAP('slow_motion')]);
	await trapPosts(h);
	h.runner.calls.length = 0;
	h.clock += 2 * MIN_MS;
	h.config.apMediaEnabled = false;
	h.configStore.fire('apMediaEnabled', false);
	assert.deepStrictEqual(h.runner.calls.filter(([name]) => name === 'restore' || name === 'stop'), [
		['restore', { ...record, until: h.clock, userId: OWNER, slot: SLOT }],
		['stop'],
	]);
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [], 'no line: none goes out while Plex Media is off');

	h.config.apMediaEnabled = true;
	h.configStore.fire('apMediaEnabled', true);
	await waitFor(() => row(h, key).inventoryKnown, 'on again');
	await h.game._internal.trapsIdle();
	assert.strictEqual(h.runner.of('restore').length, 1, 'nothing left to hand back');

	const next = { ...record, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: next });
	await sendItems(h, key, [TRAP('slow_motion')]);
	await trapPosts(h);
	h.runner.calls.length = 0;
	starting = true;
	const offAt = h.clock;
	h.config.apMediaEnabled = false;
	h.configStore.fire('apMediaEnabled', false);
	await h.game._internal.idle();
	assert.deepStrictEqual(binding(h, key).speedRestore, next, 'the restore the runner put off went with its stop(), so the record stays');
	starting = false;
	h.clock += HOUR_MS;
	h.config.apMediaEnabled = true;
	h.configStore.fire('apMediaEnabled', true);
	await waitFor(() => row(h, key).inventoryKnown, 'on again');
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r.until), [offAt, next.until], 'handed over again at the start');
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion is over.`]);
});

test('a Slow Motion on another book puts the first book\'s speed back at once, since the binding keeps one to put back', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, BOOK);
	const a = { kind: 'speed', workId: 'author/book-a', previous: 1.25, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: a });
	await sendItems(h, key, [TRAP('slow_motion')]);
	h.clock += 3 * MIN_MS;
	const b = { kind: 'speed', workId: 'author/book-b', previous: 1.5, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: b });
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.deepStrictEqual(h.runner.of('restore').map(([, r]) => r), [{ ...a, until: h.clock, userId: OWNER, slot: SLOT }]);
	assert.deepStrictEqual(binding(h, key).speedRestore, b);
	assert.ok(h.trapTimers.delays().includes(10 * MIN_MS), 'book B\'s own time');
	assert.deepStrictEqual(await trapPosts(h), Array(2).fill(`${E.trap} \`ZackPlex\` got Slow Motion from \`Watcher\`: 0.75x for 10 minutes`));

	h.runner.calls.length = 0;
	const again = { ...b, previous: 1.25, until: h.clock + 10 * MIN_MS };
	h.runner.results.push({ applied: true, line: '0.75x for 10 minutes', restore: again });
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.deepStrictEqual(h.runner.of('restore'), [], 'the same book only takes the newer record');
	assert.deepStrictEqual(binding(h, key).speedRestore, again);
});

test('an armed trap outlasts a restart and hits at the first listen after it', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('intermission')]);
	await trapPosts(h);
	h.runner.listeners.set(OWNER, MUSIC);
	await restartGame(h);
	assert.deepStrictEqual(h.runner.applied(), ['intermission'], 'tried at the start');
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: intermission line`]);
});

// --- the game with the real trap runner ------------------------------------------------------------
//
// No trapRunner here: the game builds helpers/apMediaTraps.js's runner itself, on the bot it was
// started with, as app/music.js starts it. The fake bot's book engine gets the two calls the runner
// adds to what the game reads, with the real director's rules (test/apMediaTraps.test.js holds its
// own fake to a real director): the listener's own id passes, pause and resume move state and
// pausedAt, back moves the place, speed sets the speed, and every change notifies before the call
// returns.

async function realRunnerSetup(t) {
	const trapTimers = handTimers();
	const h = await setup(t, { game: { trapTimers, trapDefer: (fn) => fn() } });
	h.trapTimers = trapTimers;
	const engine = h.bot.books;
	engine.calls = [];
	engine.sessionById = (id) => engine.list.find((s) => s.id === id && s.state !== 'ended') || null;
	engine.controlSession = (s, member, action, arg) => {
		const by = String((member && member.id) || '');
		engine.calls.push([action, by, arg]);
		if (!engine.list.includes(s) || s.state === 'ended') return { ok: false, code: 'no-session' };
		if (by !== s.userId) return { ok: false, code: 'forbidden' };
		let kind = 'moved';
		if (action === 'pause') {
			s.state = 'paused';
			s.pausedAt = h.clock;
			kind = 'paused';
		} else if (action === 'resume') {
			s.state = 'playing';
			s.pausedAt = null;
		} else if (action === 'back') {
			engine.positions.set(s.id, Math.max(0, engine.position(s) - arg * 1000));
		} else if (action === 'speed') {
			s.speed = arg;
			kind = 'speed';
		} else {
			return { ok: false, code: 'bad-action' };
		}
		for (const fn of [...engine.listeners]) fn(s, kind);
		return { ok: true, code: 'ok' };
	};
	h.book = { id: 'b1', guildId: 'g1', userId: OWNER, member: { id: OWNER }, workId: 'jane-austen/pride-and-prejudice', state: 'playing', speed: 1, pausedAt: null, voiceChannelId: 'v1' };
	return h;
}

test('a Rewind from another world goes through the real trap runner to the listener\'s own book, and the game says what it did', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const engine = h.bot.books;

	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['rewind'], 'nobody listening yet');
	assert.deepStrictEqual(await trapPosts(h), [WAITS('Rewind')]);

	engine.list.push(h.book);
	engine.positions.set(h.book.id, 20 * MIN_MS);
	for (const fn of [...engine.listeners]) fn(h.book, 'started');
	await h.game._internal.trapsIdle();
	assert.deepStrictEqual(engine.calls, [['back', OWNER, 300]], '5 minutes, as the listener');
	assert.strictEqual(engine.position(h.book), 15 * MIN_MS);
	assert.strictEqual(h.book.state, 'playing');
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.strictEqual(row(h, key).effect, null, 'over when it hits');
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: back 5 minutes`]);
	assert.ok(h.logger.lines.some((l) => l.level === 'info' && l.text === 'Plex Media: Rewind for ZackPlex on the book: back 5 minutes.'), 'the runner\'s own log line');
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => [e.trap, e.outcome]), [['rewind', 'armed'], ['rewind', 'hit']]);
});

test('a Remote Control ends an Intermission the real trap runner put on the book, and one arriving after an early resume is kept', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const engine = h.bot.books;
	engine.list.push(h.book);
	engine.positions.set(h.book.id, 20 * MIN_MS);

	await sendItems(h, key, [TRAP('intermission')]);
	assert.strictEqual(h.book.state, 'paused');
	assert.deepStrictEqual(row(h, key).effect, { kind: 'intermission', name: 'Intermission', until: h.clock + 60000 });
	await sendItems(h, key, [RC]);
	assert.strictEqual(h.book.state, 'playing', 'at once, not at the minute');
	assert.deepStrictEqual(engine.calls.map(([action, by]) => [action, by]), [['pause', OWNER], ['resume', OWNER]]);
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 1, bought: 0, used: 1, available: 0 });
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the book pauses for 60 seconds`,
		`${E.remote} \`ZackPlex\`: Remote Control ended Intermission.`,
	]);
	h.clock += MIN_MS;
	await tick(h, MIN_MS);
	assert.strictEqual(engine.calls.length, 2, 'the runner\'s timer went with the pause');
	assert.deepStrictEqual(await trapPosts(h), [], 'and the game has no end line left');

	await sendItems(h, key, [TRAP('intermission')]);
	assert.strictEqual(h.book.state, 'paused');
	engine.controlSession(h.book, h.book.member, 'resume');
	await sendItems(h, key, [RC]);
	assert.deepStrictEqual(row(h, key).remoteControls, { received: 2, bought: 0, used: 1, available: 1 });
	h.clock += MIN_MS;
	await tick(h, MIN_MS);
	assert.strictEqual(h.book.state, 'playing');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the book pauses for 60 seconds`,
		`${E.trap} \`ZackPlex\`: Intermission is over, the book was resumed early.`,
		`${E.remote} \`ZackPlex\` got a Remote Control from \`Watcher\`: it blocks the next trap.`,
	]);
});

test('an Intermission the real trap runner put on the book ends with the runner\'s own words, and leaves the book paused while its listener is out of voice', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const engine = h.bot.books;
	const voice = new Map([[OWNER, { channelId: 'v1' }]]);
	h.book.guild = { voiceStates: { cache: voice } };
	engine.list.push(h.book);
	engine.positions.set(h.book.id, 20 * MIN_MS);

	await sendItems(h, key, [TRAP('intermission')]);
	assert.strictEqual(h.book.state, 'paused');
	h.clock += MIN_MS;
	await tick(h, MIN_MS);
	assert.strictEqual(h.book.state, 'playing', 'resumed at the minute');
	assert.strictEqual(row(h, key).effect, null);
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the book pauses for 60 seconds`,
		`${E.trap} \`ZackPlex\`: Intermission is over, the book plays again.`,
	]);

	await sendItems(h, key, [TRAP('intermission')]);
	voice.delete(OWNER);
	h.clock += MIN_MS;
	await tick(h, MIN_MS);
	assert.strictEqual(h.book.state, 'paused', 'nobody left in the channel to hear it');
	assert.deepStrictEqual(await trapPosts(h), [
		`${E.trap} \`ZackPlex\` got Intermission from \`Watcher\`: the book pauses for 60 seconds`,
		`${E.trap} \`ZackPlex\`: Intermission is over, the book stays paused until its listener is back in voice.`,
	]);
});

test('a book the real trap runner slowed plays at its own speed again the moment apMediaEnabled goes off', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	h.book.speed = 1.25;
	h.bot.books.list.push(h.book);
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.strictEqual(h.book.speed, 0.75);
	assert.strictEqual(binding(h, key).speedRestore.previous, 1.25);
	h.clock += 2 * MIN_MS;
	h.config.apMediaEnabled = false;
	h.configStore.fire('apMediaEnabled', false);
	assert.strictEqual(h.book.speed, 1.25);
	assert.deepStrictEqual(h.trapTimers.delays(), [], 'and nothing is left to fire');
	await h.game._internal.idle();
	assert.strictEqual(binding(h, key).speedRestore, null, 'the runner said the speed is back');
});

test('a slowed book whose new session is still starting when apMediaEnabled goes off keeps its speed record, and the next start puts the speed back', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const engine = h.bot.books;
	h.book.speed = 1.25;
	engine.list.push(h.book);
	await sendItems(h, key, [TRAP('slow_motion')]);
	assert.strictEqual(h.book.speed, 0.75);
	await trapPosts(h);
	// The listener stops the book and plays it again: the new session is joining at the switch.
	h.clock += 2 * MIN_MS;
	h.book.state = 'ended';
	for (const fn of [...engine.listeners]) fn(h.book, 'ended');
	const again = { ...h.book, id: 'b2', state: 'starting', speed: 0.75 };
	engine.list.push(again);
	h.config.apMediaEnabled = false;
	h.configStore.fire('apMediaEnabled', false);
	await h.game._internal.idle();
	assert.deepStrictEqual(h.trapTimers.delays(), [], 'the runner\'s retry went with its stop()');
	assert.strictEqual(binding(h, key).speedRestore.previous, 1.25, 'so the record stays');
	again.state = 'playing';
	h.clock += HOUR_MS;
	h.config.apMediaEnabled = true;
	h.configStore.fire('apMediaEnabled', true);
	await waitFor(() => row(h, key).inventoryKnown, 'on again');
	await h.game._internal.trapsIdle();
	assert.strictEqual(again.speed, 1.25);
	assert.strictEqual(binding(h, key).speedRestore, null);
	assert.deepStrictEqual(await trapPosts(h), [`${E.slow} \`ZackPlex\`: Slow Motion is over.`]);
});

test('a trap the real runner cannot play while a Hitster game holds the voice waits with a line that names no trap at work, and hits once the game is over', async (t) => {
	const h = await realRunnerSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	let hitster = true;
	voiceClaims.register('hitster', (guildId) => (hitster && guildId === 'g1' ? 'Hitster' : null));
	t.after(() => { hitster = false; });
	const engine = h.bot.books;
	engine.list.push(h.book);
	engine.positions.set(h.book.id, 20 * MIN_MS);
	await sendItems(h, key, [TRAP('rewind')]);
	assert.deepStrictEqual(engine.calls, [], 'the book is left alone');
	assert.deepStrictEqual(binding(h, key).armed.map((x) => [x.kind, x.told]), [['rewind', true]]);
	assert.deepStrictEqual(await trapPosts(h), [BUSY('Rewind')]);
	hitster = false;
	await tick(h);
	assert.deepStrictEqual(engine.calls, [['back', OWNER, 300]]);
	assert.deepStrictEqual(binding(h, key).armed, []);
	assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\` got Rewind from \`Watcher\`: back 5 minutes`]);
});

test('a Commercial Break whose clip playlist Plex is still reading when a trap switch goes off fizzles with that switch named, and queues no clip', async (t) => {
	const h = await realRunnerSetup(t);
	h.config.apMediaTrapClips = 'Clips';
	let answer = null;
	h.pms.playlists = async () => [{ ratingKey: '901', title: 'Clips', playlistType: 'audio' }];
	h.pms.playlistItems = () => new Promise((resolve) => { answer = resolve; });
	const key = await linkSlot(h);
	await trapPosts(h);
	const bot = h.bot;
	Object.assign(bot, { isPlaying: true, isPaused: false, voiceChannel: { id: 'c1', guild: { id: 'g1' } }, dispatcher: { state: { status: 'playing' } } });
	bot.inVoice.add(OWNER);
	bot.songQueue = [{ title: 'A', key: '/library/parts/1/a.mp3' }, { title: 'B', key: '/library/parts/2/b.mp3' }];
	const clips = [{ type: 'track', title: 'Jingle', duration: 30000, Media: [{ Part: [{ key: '/library/parts/9/jingle.mp3' }] }] }];
	for (const [name, words] of [['apMediaVoiceTraps', 'voice traps are off on this server'], ['apMediaTraps', 'traps are off on this server']]) {
		answer = null;
		await pushItems(h, key, [TRAP('commercial_break')]);
		await waitFor(() => answer !== null, `${name}: the clip playlist being read`);
		h.config[name] = false;
		h.configStore.fire(name, false);
		await h.game._internal.idle();
		assert.deepStrictEqual(binding(h, key).armed.map((x) => x.kind), ['commercial_break'], `${name}: left to the runner's answer`);
		answer(clips);
		await h.game._internal.trapsIdle();
		assert.deepStrictEqual(bot.songQueue.map((e) => e.title), ['A', 'B'], name);
		assert.deepStrictEqual(binding(h, key).armed, [], name);
		assert.deepStrictEqual(await trapPosts(h), [`${E.trap} \`ZackPlex\`: Commercial Break from \`Watcher\` fizzled: ${words}.`], name);
		h.config[name] = true;
	}
	assert.deepStrictEqual(h.events.filter((e) => e.kind === 'apmedia-trap').map((e) => e.outcome), ['armed', 'fizzled', 'armed', 'fizzled']);
});

test('a Fast Forward without strict earns the title\'s next checkpoint however far off it is, never a main location, and spends nothing when it cannot', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const none = await h.game.fastForward(key, 'The Matrix');
	assert.strictEqual(none.message, '`ZackPlex` has no Fast Forward to spend (0 received, 0 bought, 0 used).');
	await sendItems(h, key, [FF, FF, FF, FF, FF, unit(1)]);
	assert.deepStrictEqual(row(h, key).fastForwards, { received: 5, bought: 0, used: 0, available: 5 });
	assert.deepStrictEqual((await trapPosts(h)).filter((l) => l.includes('Fast Forward')), Array(5).fill(`${E.forward} \`ZackPlex\` got a Fast Forward from \`Watcher\`: \`/apmedia ff\` earns a title's next checkpoint.`));
	const movie = await h.game.fastForward(key, 'The Matrix');
	assert.strictEqual(movie.message, `${E.forward} \`ZackPlex\` spent a Fast Forward on **The Matrix (1999)**: 1 check sent. 4 Fast Forwards left.`);
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[1]), 'the 15-minute checkpoint');
	await h.game._internal.handleEvent(sessionSpan(MATRIX.rk, 40 * MIN_MS, 46 * MIN_MS));
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[3]), 'the 45-minute checkpoint, by watching');
	const gap = await h.game.fastForward(key, 'The Matrix');
	assert.ok(gap.ok, gap.message);
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[2]), 'the earliest one not earned: 30 minutes, not 60');
	assert.ok(!h.server.checkedOf(1).has(MATRIX.ids[4]));
	assert.ok(!h.server.checkedOf(1).has(MATRIX.ids[0]), 'never the watch');
	const first = await h.game.fastForward(key, ALBUM_KEY);
	assert.strictEqual(first.message, `${E.forward} \`ZackPlex\` spent a Fast Forward on **Daft Punk - Discovery**: 1 check sent. 2 Fast Forwards left.`);
	await waitFor(() => h.server.checkedOf(1).has(loc(4)), 'the 5-minute checkpoint');
	const second = await h.game.fastForward(key, ALBUM_KEY);
	assert.ok(second.ok, second.message);
	await waitFor(() => h.server.checkedOf(1).has(loc(5)), 'the 10-minute checkpoint');
	assert.ok(![1, 2, 3].some((j) => h.server.checkedOf(1).has(loc(j))), 'no track: finishing the album still takes listening');
	const done = await h.game.fastForward(key, ALBUM_KEY);
	assert.deepStrictEqual([done.ok, done.message], [false, '**Daft Punk - Discovery** has no checkpoint left to skip to.']);
	assert.strictEqual(binding(h, key).ffUsed, 4);
	const locked = await h.game.fastForward(key, 'episode|rk:2101');
	assert.strictEqual(locked.message, `${E.forward} \`ZackPlex\` spent a Fast Forward on **Breaking Point S01E01**: 1 check banked until it unlocks. 0 Fast Forwards left.`);
	assert.ok(binding(h, key).banked.includes(loc(17)), 'banked under locked_watches bank');
	assert.deepStrictEqual(row(h, key).fastForwards, { received: 5, bought: 0, used: 5, available: 0 });

	const sd = slotData();
	delete sd.items.useful;
	const old = await trapSetup(t, { sd });
	const oldKey = await linkSlot(old);
	assert.strictEqual((await old.game.fastForward(oldKey, 'The Matrix')).message, '`ZackPlex`\'s seed has no Fast Forwards: it was made with a Plex Media world before 0.3.0.');
});

test('a Fast Forward under strict counts 10 more minutes heard from the furthest point heard, and a locked title under ignore refuses it', async (t) => {
	const h = await trapSetup(t, { sd: slotData({ timesanity_strict: true }) });
	const key = await linkSlot(h);
	await trapPosts(h);
	await sendItems(h, key, [FF, FF]);
	assert.deepStrictEqual(await trapPosts(h), Array(2).fill(`${E.forward} \`ZackPlex\` got a Fast Forward from \`Watcher\`: \`/apmedia ff\` counts 10 minutes of a title as heard.`));
	const first = await h.game.fastForward(key, 'The Matrix');
	assert.strictEqual(first.message, `${E.forward} \`ZackPlex\` spent a Fast Forward on **The Matrix (1999)**: The first 10m count as heard. That reaches no checkpoint yet. 1 Fast Forward left.`);
	assert.deepStrictEqual(Object.values(binding(h, key).heard), [[[0, 10 * MIN_MS]]], 'written at once');
	const second = await h.game.fastForward(key, 'The Matrix');
	assert.strictEqual(second.message, `${E.forward} \`ZackPlex\` spent a Fast Forward on **The Matrix (1999)**: From 10m to 20m counts as heard. 1 check sent. 0 Fast Forwards left.`);
	await waitFor(() => h.server.checkedOf(1).has(MATRIX.ids[1]), 'the 15-minute checkpoint');
	assert.ok(!h.server.checkedOf(1).has(MATRIX.ids[0]), 'never the watch');
	assert.deepStrictEqual(Object.values(binding(h, key).heard), [[[0, 20 * MIN_MS]]]);

	const ignoring = await trapSetup(t, { sd: slotData({ timesanity_strict: true, locked_watches: 'ignore' }) });
	const other = await linkSlot(ignoring);
	await sendItems(ignoring, other, [FF]);
	const refused = await ignoring.game.fastForward(other, '1917');
	assert.strictEqual(refused.message, '**1917** is locked, and this slot ignores locked titles, so a Fast Forward on it would count for nothing.');
	assert.strictEqual(binding(ignoring, other).ffUsed, 0);
});

test('the Snack Bar shows the snacks held, trades them for a Fast Forward or a Remote Control, and runs out; a seed without one has none', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [...Array(12).fill(SNACK.Popcorn), ...Array(13).fill(SNACK.Nachos)]);
	const menu = await h.game.snackBar(key);
	assert.strictEqual(menu.message, `${E.snack} \`ZackPlex\` has 25 snacks. The Snack Bar: 10 snacks a trade, 3 trades left; one trade buys a Fast Forward or a Remote Control.`);
	const ff = await h.game.snackBar(key, { buy: 'fastForward' });
	assert.strictEqual(ff.message, `${E.snack} \`ZackPlex\` bought a Fast Forward for 10 snacks: 15 snacks and 2 trades left. \`/apmedia ff <title>\` spends it.`);
	assert.deepStrictEqual(row(h, key).fastForwards, { received: 0, bought: 1, used: 0, available: 1 });

	await sendItems(h, key, [TRAP('buffering')]);
	await trapPosts(h);
	const rc = await h.game.snackBar(key, { buy: 'remoteControl' });
	assert.strictEqual(rc.message, `${E.snack} \`ZackPlex\` bought a Remote Control for 10 snacks: 5 snacks and 1 trade left. It went straight to the trap on this slot.`);
	assert.deepStrictEqual([binding(h, key).holdMs, row(h, key).remoteControls], [0, { received: 0, bought: 1, used: 1, available: 0 }]);
	assert.deepStrictEqual(await trapPosts(h), [`${E.remote} \`ZackPlex\`: Remote Control ended Buffering.`]);

	const poor = await h.game.snackBar(key, { buy: 'fastForward' });
	assert.deepStrictEqual([poor.ok, poor.message], [false, 'A trade costs 10 snacks, and `ZackPlex` has 5 snacks.']);
	await sendItems(h, key, Array(20).fill(SNACK['Hot Dog']));
	assert.ok((await h.game.snackBar(key, { buy: 'fastForward' })).ok);
	const out = await h.game.snackBar(key, { buy: 'remoteControl' });
	assert.deepStrictEqual([out.ok, out.message], [false, '`ZackPlex`\'s Snack Bar has no trades left (3 trades in all).']);
	const b = binding(h, key);
	assert.deepStrictEqual([b.snackSpent, b.trades, b.bought], [30, 3, { fastForward: 2, remoteControl: 1 }]);
	assert.deepStrictEqual([row(h, key).snacks, row(h, key).snackBar], [{ received: 45, spent: 30, held: 15 }, { price: 10, trades: 3, tradesLeft: 0 }]);
	assert.strictEqual((await h.game.snackBar(key, { buy: 'popcorn' })).message, 'Buy a Fast Forward or a Remote Control.');
	assert.strictEqual((await h.game.snackBar(key, { buy: 'constructor' })).message, 'Buy a Fast Forward or a Remote Control.');

	const sd = slotData();
	delete sd.snack_bar;
	const old = await trapSetup(t, { sd });
	const oldKey = await linkSlot(old);
	assert.strictEqual((await old.game.snackBar(oldKey)).message, '`ZackPlex`\'s seed has no Snack Bar: it was made with a Plex Media world before 0.3.0.');
	assert.strictEqual(row(old, oldKey).snackBar, null);
});

test('the status row and the status reply show the useful items on hand, the snacks, the holds and the armed traps', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('buffering'), TRAP('rights_expired')]);
	await sendItems(h, key, [TRAP('rewind'), FF, SNACK.Popcorn, SNACK.Nachos]);
	await h.game._internal.handleEvent(historyEvent(2002));
	await h.game._internal.idle();
	const s = row(h, key);
	const until = h.clock + 15 * MIN_MS;
	const expires = h.clock + 45 * MIN_MS;
	assert.deepStrictEqual(s.fastForwards, { received: 1, bought: 0, used: 0, available: 1 });
	assert.deepStrictEqual(s.remoteControls, { received: 0, bought: 0, used: 0, available: 0 });
	assert.deepStrictEqual([s.snacks, s.snackBar], [{ received: 2, spent: 0, held: 2 }, { price: 10, trades: 3, tradesLeft: 3 }]);
	assert.deepStrictEqual(s.holds, {
		held: 7, buffering: { until, held: 7 }, bufferingNextMs: 0,
		expired: [{ entryKey: MATRIX_KEY, title: 'The Matrix (1999)', until: expires, held: 0 }],
	});
	assert.deepStrictEqual(s.armed, [{ kind: 'rewind', name: 'Rewind', from: 'Watcher', at: h.clock, until: h.clock + 12 * HOUR_MS }]);
	assert.deepStrictEqual([s.effect, s.slowMotion, s.armedListening], [null, null, false]);
	const lines = require('../commands/apmedia.js/status.js').block(s, { showUser: false }).rows;
	for (const line of [
		'> Fast Forwards: 1 to spend with `/apmedia ff`.',
		'> Snacks: 2. The Snack Bar takes 10 snacks a trade, 3 trades left (`/apmedia snackbar`).',
		`> ${E.buffering} Buffering: 7 checks held until ${stampOf(until)}.`,
		`> ${E.expired} Rights expired until ${stampOf(expires)}: **The Matrix (1999)**.`,
		`> ${E.trap} Waiting for a listen through the bot: Rewind from \`Watcher\`.`,
	]) assert.ok(lines.includes(line), `${line}\n${lines.join('\n')}`);
	const [page] = require('../commands/apmedia.js/list.js').listPages(h.game.list(key, 'ready'));
	assert.strictEqual(page.split('\n')[1], `${E.buffering} Buffering: 7 checks held until ${stampOf(until)}.`, 'the list heads every page with it');
});

test('the status words a waiting trap as its own line did: it waits for the bot while its player listens, else for a listen', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await trapPosts(h);
	const status = require('../commands/apmedia.js/status.js');
	const waiting = () => status.block(row(h, key), { showUser: false }).rows.filter((line) => line.startsWith(`> ${E.trap} Waiting`));
	h.runner.listeners.set(OWNER, MUSIC);
	assert.strictEqual(row(h, key).armedListening, false, 'no trap waits');
	h.runner.results.push({ applied: false, reason: 'busy' });
	await sendItems(h, key, [TRAP('intermission')]);
	assert.deepStrictEqual(await trapPosts(h), [BUSY('Intermission')]);
	assert.strictEqual(row(h, key).armedListening, true);
	assert.deepStrictEqual(waiting(), [`> ${E.trap} Waiting to hit as soon as the bot can: Intermission from \`Watcher\`.`]);
	h.runner.listeners.clear();
	assert.strictEqual(row(h, key).armedListening, false);
	assert.deepStrictEqual(waiting(), [`> ${E.trap} Waiting for a listen through the bot: Intermission from \`Watcher\`.`]);
	h.runner.listeners.set(OWNER, MUSIC);
	h.game.stop();
	assert.strictEqual(row(h, key).armedListening, false, 'nothing hits while the game is stopped');

	const broken = await trapSetup(t, { game: { trapRunner: () => { throw new Error('the voice library is missing'); } } });
	const other = await linkSlot(broken);
	await trapPosts(broken);
	await sendItems(broken, other, [TRAP('rewind')]);
	assert.deepStrictEqual(await trapPosts(broken), [WAITS('Rewind')]);
	assert.strictEqual(row(broken, other).armedListening, false, 'no runner to ask');
});

test('a retry onto a new seed resets the item cursor, the holds, the armed traps and every item spent', async (t) => {
	const h = await trapSetup(t);
	const key = await linkSlot(h);
	await sendItems(h, key, [TRAP('buffering'), TRAP('rewind'), FF]);
	h.store.bindings.patch(key, {
		ffUsed: 1, rcUsed: 1, snackSpent: 10, trades: 1, bought: { fastForward: 1, remoteControl: 0 },
		held: [loc(48)], expired: { [HALLOWEEN.key]: h.clock + MIN_MS },
	});
	const fresh = await startApMediaServer({ seedName: 'Seed_NEW', slotData: { 1: slotData() }, locations: { 1: ALL_LOCATIONS }, startInventory: { 1: START } });
	t.after(() => fresh.close());
	h.monitor.put(0, { target: fresh.target }, 'repointed');
	await waitFor(() => row(h, key).state === 'stale', 'the stale state');
	await h.game.retry(key);
	await waitFor(() => row(h, key).seedName === 'Seed_NEW' && row(h, key).inventoryKnown, 'the new seed');
	await h.game._internal.trapsIdle();
	const b = binding(h, key);
	assert.deepStrictEqual(
		[b.itemsSeen, b.held, b.holdUntil, b.holdMs, b.expired, b.armed, b.speedRestore, b.ffUsed, b.rcUsed, b.snackSpent, b.bought, b.trades],
		[START.length, [], null, 0, {}, [], null, 0, 0, 0, { fastForward: 0, remoteControl: 0 }, 0],
		'the new seed\'s first inventory starts the cursor again',
	);
});
