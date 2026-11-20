// The Plex Media game-test harness, a module copy of test/apMediaGame.test.js's (that file keeps its
// own): the real orchestrator against test/helpers/apMediaServer.js, the real store in memory, fake
// PMS, bot, monitor and Discord, and timers fired by hand. See that file's header for the whole setup.

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const contracts = require('../../helpers/apMediaContracts.js');
const { createGame, commandCode } = require('../../helpers/apMediaGame.js');
const { ApMediaClient } = require('../../helpers/apMediaClient.js');
const { createApMediaStore } = require('../../helpers/apMediaStore.js');
const voiceClaims = require('../../helpers/voiceClaims.js');
const { startApMediaServer } = require('./apMediaServer.js');
const { waitFor } = require('./apServer.js');
const FIXTURE = require('../fixtures/apmedia/slot_data_mixed.json');

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
		describers: [],
		setGameDescriber(game, describer) {
			const entry = { game, describer };
			mon.describers.push(entry);
			return () => { mon.describers = mon.describers.filter((e) => e !== entry); };
		},
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
		markerRows: {},
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
		async markers(rk) { return pms.markerRows[rk] ?? []; },
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
		store: createApMediaStore({ now: () => h.clock }),
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

const MIN_MS = 60000;
// Race-free: a credited id sits in pending from creditIds until the room has registered it.
const earned = (h, key, id, server = h.server) => {
	const b = h.store.bindings.get(key);
	return b.pending.includes(id) || b.banked.includes(id) || server.checkedOf(1).has(id);
};
const sessionSpan = (rk, fromMs, toMs, at = AFTER) => ({ type: 'span', source: 'session', accountId: 1, ratingKey: rk, fromMs, toMs, at });

module.exports = {
	contracts, createGame, commandCode, ApMediaClient, createApMediaStore, voiceClaims, startApMediaServer, waitFor, FIXTURE,
	SLOT, SEED, OWNER, FRIEND, CHANNEL, AFTER, ALL_LOCATIONS, loc, unit, WILD, MATRIX, HALLOWEEN, N1917, START, ROOM,
	slotData, quietLogger, handTimers, fakeMonitor, fakeConfigStore, fakeDiscord, fakePms, fakeBot, baseConfig, setup,
	runtime, row, sentChecks, linkSlot, posts, settledPosts, receive, historyEvent, hasAll, reconnectNow,
	sessionSpan, MIN_MS, earned,
};
