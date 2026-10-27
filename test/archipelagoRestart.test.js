// helpers/archipelagoMonitor.js across !restart.
//
// The bug: utils.stop() destroyed the Discord client and left the relay holding it. The AP sockets
// stayed up and kept relaying, but every post went through the dead client and failed with
// "Expected token to be set". A flush had already taken its lines out of the buffer, so chat,
// joins and every other line a catch-up cannot rebuild were lost for good, and on a host:port
// watch, which has no catch-up, the items too. A room-URL watch's items came back up to minutes
// later as a "📜 ... the live feed missed" catch-up, and a hint ping or DM due in the gap was
// recorded as announced and never sent. Each start also bound one more configStore listener, so
// one /config change ran applyConfig once for every restart since boot.
//
// Harness: the real monitor and client against the stand-in AP server (test/helpers/apServer.js),
// the room-URL watch of test/helpers/catchupRelay.js and a host:port watch, and fake Discord
// clients. utils.stop() is detachArchipelagoMonitor() plus turning the old client into one whose
// every call fails as a destroyed discord.js client's does, and is recorded; the new clientReady
// is startArchipelagoMonitor(newClient). Real timers: the sockets are real and the relay batches
// on setTimeout.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('aprestart');   // must run before any helper is required

const {
	config, claims, monitor, waitFor, USER, sleep, text, blocks, headers, pingsFor, hint, setup,
	baselined, testDiscord
} = require('./helpers/catchupRelay.js');
const hintStore = require('../helpers/archipelagoHints.js');
const logic = require('../helpers/archipelagoLogic.js');
const configStore = require('../helpers/configStore.js');

const TOKEN_ERROR = 'Expected token to be set for this request, but none was present';
const OVERRIDES = path.join(os.tmpdir(), `plexbot-test-aprestart-overrides-${process.pid}.json`);
const CONFIG_KEYS = ['archipelagoEnabled', 'archipelagoRoomUrl', 'archipelagoHost', 'archipelagoSlot', 'archipelagoChannelId'];
// Long enough for a flush (0.25 s window) to be under way, and for a refused post's retry
// (retryMs 500) to have fired, so a wrong path has shown itself before the new client arrives.
const GAP_MS = 700;

let savedConfig;
test.before(() => {
	stores.cleanup();
	savedConfig = Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key]]));
	// On, as it is whenever a watch exists, but with no configured room, so applyConfig leaves the
	// tests' own watches alone.
	Object.assign(config, {
		archipelagoEnabled: true, archipelagoRoomUrl: '', archipelagoHost: '', archipelagoSlot: '', archipelagoChannelId: ''
	});
	// The boot start, which loads the saved watches. A later start has to find them loaded, as in
	// the bot, or it would open a second socket for each watch a test adds.
	monitor.startArchipelagoMonitor(ap.fakeDiscord().client);
});
test.after(() => {
	Object.assign(config, savedConfig);
	stores.cleanup();
	try { fs.unlinkSync(OVERRIDES); } catch (_) {}
});

let hostRooms = 0;

/** A connected host:port watch on slot 2 ("Watcher"), posting through a testDiscord() client. */
async function hostWatch(t, { hints = null } = {}) {
	const seed = `Seed_RESTART_HP_${++hostRooms}`;
	const saved = { batch: config.archipelagoBatchSeconds, relay: { ...monitor.relayTiming } };
	config.archipelagoBatchSeconds = 0.25;
	monitor.relayTiming.minFlushMs = 100;
	const server = await ap.startFakeServer({ slots: ['SlotA', 'Watcher'], watchSlot: 2, seedName: seed, hints });
	const discord = testDiscord();
	monitor.startArchipelagoMonitor(discord.client);
	const { watch, outcome } = await monitor.addWatch({ target: `127.0.0.1:${server.port}`, slot: 'Watcher', channelId: 'chan-hp' }, 15000);
	assert.strictEqual(outcome, 'connected');
	t.after(async () => {
		monitor.removeWatch(watch.id);
		await ap.closeServer(server.wss);
		config.archipelagoBatchSeconds = saved.batch;
		Object.assign(monitor.relayTiming, saved.relay);
		claims.reset();
	});
	// addWatch answers on 'connected' with the connection notice still on its way, and a restart
	// landing under it would make the test about that notice instead.
	await waitFor(() => discord.posted.length > 0, 'the connection notice');
	return { server, discord, posted: discord.posted, watch, seed };
}

/**
 * utils.stop(): the monitor is detached and the client it held is destroyed.
 * @returns {string[]} every call made through the old client from here on
 */
function restart(old) {
	monitor.detachArchipelagoMonitor();
	const calls = [];
	old.control.fail = (payload) => {
		calls.push(`send ${text(payload)}`);
		throw new Error(TOKEN_ERROR);
	};
	old.client.channels.fetch = async (id) => {
		calls.push(`fetch ${id}`);
		throw new Error(TOKEN_ERROR);
	};
	old.client.users.fetch = async (id) => {
		calls.push(`user ${id}`);
		throw new Error(TOKEN_ERROR);
	};
	return calls;
}

/** The new client's clientReady. */
function reattach(next = ap.fakeDiscord()) {
	// setup() turns it off, and a start with it off stops every watch. In the bot it is on
	// whenever a watch exists.
	config.archipelagoEnabled = true;
	monitor.startArchipelagoMonitor(next.client);
	return next;
}

const chat = (server, words) => server.sendPacket({
	cmd: 'PrintJSON', type: 'Chat', team: 0, slot: 1, message: words, data: [{ text: `SlotA: ${words}` }]
});
const join = (server, words) => server.sendPacket({
	cmd: 'PrintJSON', type: 'Join', team: 0, slot: 1, tags: [], data: [{ text: words }]
});

const plain = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

/** Every line relayed in a block, in posting order. Pings and headers are not blocks. */
function relayed(posted) {
	return blocks(posted).flatMap((p) => plain(text(p)).split('\n').filter((line) => line && !line.startsWith('```')));
}

/** Each needle on exactly one relayed line, in this order, and none of them posted as missed. */
function assertRelayedInOrder(posted, needles) {
	const lines = relayed(posted);
	const at = needles.map((needle) => {
		const hits = lines.filter((line) => line.includes(needle));
		assert.strictEqual(hits.length, 1, `"${needle}" relayed once in ${JSON.stringify(lines)}`);
		return lines.indexOf(hits[0]);
	});
	assert.deepStrictEqual([...at].sort((a, b) => a - b), at, `in arrival order: ${JSON.stringify(lines)}`);
	assert.strictEqual(headers(posted).length, 0, 'no catch-up header');
	assert.ok(!lines.some((line) => line.includes('[missed]')), 'nothing posted as missed');
}

function assertPingFollows(posted, location) {
	const pings = pingsFor(posted, USER);
	assert.strictEqual(pings.length, 1, 'one ping');
	assert.match(plain(text(pings[0])), new RegExp(`Location#${location}\\)`));
	assert.deepStrictEqual(pings[0].allowedMentions, { parse: [], users: [USER] });
	const blockAt = posted.findIndex((p) => text(p).startsWith('```') && plain(text(p)).includes(`Location#${location})`));
	assert.ok(blockAt >= 0 && blockAt < posted.indexOf(pings[0]), 'the ping follows its line');
}

function claimSlotA(ctx) {
	claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
	claims.setPings(ctx.watch.id, 'SlotA', 'all');
}

/** The automatic catch-up a start schedules has run, and found nothing left to post. */
async function catchupRanSince(ctx, since) {
	await waitFor(() => ctx.entry().catchup.lastRunAt > since, 'the catch-up the start schedules', 5000);
}

async function gapThenReattach(ctx, { room }) {
	claimSlotA(ctx);
	const postedBefore = ctx.posted.length;
	const oldCalls = restart(ctx.discord);

	chat(ctx.server, 'GAP-chat');
	join(ctx.server, 'GAP-join SlotA has joined');
	ctx.server.sendItemSend({ receiving: 1, location: 201 });
	if (room) ctx.add(1, [1, 201, 2, 0]);
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, [], 'nothing tried through the destroyed client');
	assert.strictEqual(ctx.posted.length, postedBefore);

	const reattachedAt = Date.now();
	const next = reattach();
	await waitFor(() => pingsFor(next.posted, USER).length > 0, 'the item ping', 5000);
	if (room) await catchupRanSince(ctx, reattachedAt);
	else await sleep(300);

	assertRelayedInOrder(next.posted, ['GAP-chat', 'GAP-join', 'Location#201)']);
	assertPingFollows(next.posted, 201);
	assert.deepStrictEqual(oldCalls, []);
}

test('a room-URL watch holds chat, a join and an item that arrive while detached, and posts them through the new client', async (t) => {
	const ctx = await setup(t);
	await baselined(ctx);
	await gapThenReattach(ctx, { room: true });
});

test('a host:port watch holds chat, a join and an item that arrive while detached, and posts them through the new client', async (t) => {
	const ctx = await hostWatch(t);
	await gapThenReattach(ctx, { room: false });
});

test('a post that fails as the old client is destroyed is sent again through the new one, not counted as refused', async (t) => {
	const ctx = await setup(t);
	await baselined(ctx);
	claimSlotA(ctx);
	let oldCalls = null;
	ctx.discord.control.fail = (payload) => {
		if (!text(payload).includes('IN-FLIGHT-chat')) return false;
		// The restart lands while this block is with Discord, and the block fails with it.
		oldCalls = restart(ctx.discord);
		throw new Error(TOKEN_ERROR);
	};

	chat(ctx.server, 'IN-FLIGHT-chat');
	ctx.server.sendItemSend({ receiving: 1, location: 401 });
	ctx.add(1, [1, 401, 2, 0]);
	await waitFor(() => oldCalls, 'the block to fail under the restart', 5000);
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, [], 'the second try waits for the new client');
	assert.strictEqual(ctx.entry().catchup.lastError, null, 'not recorded as a failed post');

	const reattachedAt = Date.now();
	const next = reattach();
	await waitFor(() => pingsFor(next.posted, USER).length > 0, 'the item ping', 5000);
	await catchupRanSince(ctx, reattachedAt);

	assertRelayedInOrder(next.posted, ['IN-FLIGHT-chat', 'Location#401)']);
	assertPingFollows(next.posted, 401);
	assert.strictEqual(ctx.entry().catchup.lastError, null);
	assert.deepStrictEqual(oldCalls, []);
});

test('a claim ping that fails as the old client is destroyed reaches the new one still mentioning its claimant', async (t) => {
	const ctx = await hostWatch(t);
	claimSlotA(ctx);
	let oldCalls = null;
	ctx.discord.control.fail = (payload) => {
		if (!text(payload).includes(`<@${USER}>`)) return false;
		// The restart lands while the ping is with Discord, its line already posted.
		oldCalls = restart(ctx.discord);
		throw new Error(TOKEN_ERROR);
	};

	ctx.server.sendItemSend({ receiving: 1, location: 451 });
	await waitFor(() => oldCalls, 'the ping to fail under the restart', 5000);
	await sleep(300);
	assert.deepStrictEqual(oldCalls, []);
	assert.strictEqual(relayed(ctx.posted).filter((line) => line.includes('Location#451)')).length, 1, 'the line went out before the restart');

	const next = reattach();
	await waitFor(() => pingsFor(next.posted, USER).length > 0, 'the ping', 5000);
	await sleep(200);
	const pings = pingsFor(next.posted, USER);
	assert.strictEqual(pings.length, 1);
	assert.match(plain(text(pings[0])), /Location#451\)/);
	assert.deepStrictEqual(pings[0].allowedMentions, { parse: [], users: [USER] });
	assert.deepStrictEqual(relayed(next.posted), [], 'its line is not posted again');
});

test('a channel fetch that fails on the old client after the detach is made again through the new one', async (t) => {
	// Down at first, so nothing is cached and the first post after this has to fetch the channel.
	const ctx = await setup(t, { channelDown: true });
	await baselined(ctx);
	let oldCalls = null;
	ctx.discord.client.channels.fetch = async () => {
		// The restart lands while this fetch is with Discord.
		oldCalls = restart(ctx.discord);
		throw new Error(TOKEN_ERROR);
	};

	chat(ctx.server, 'FETCH-chat');
	ctx.server.sendItemSend({ receiving: 1, location: 501 });
	ctx.add(1, [1, 501, 2, 0]);
	await waitFor(() => oldCalls, 'the fetch to fail under the restart', 5000);
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, []);
	assert.strictEqual(ctx.entry().catchup.lastError, null, 'not recorded as an unreachable channel');

	const reattachedAt = Date.now();
	const next = reattach();
	await waitFor(() => relayed(next.posted).some((line) => line.includes('Location#501)')), 'the item', 5000);
	await catchupRanSince(ctx, reattachedAt);

	assertRelayedInOrder(next.posted, ['FETCH-chat', 'Location#501)']);
	assert.deepStrictEqual(oldCalls, []);
});

test('a channel the old client hands back after the detach is never posted to', async (t) => {
	const ctx = await setup(t, { channelDown: true });
	await baselined(ctx);
	let oldCalls = null;
	ctx.discord.client.channels.fetch = async (id) => {
		// The restart lands while this fetch is with Discord, which still answers it.
		oldCalls = restart(ctx.discord);
		return {
			id,
			send: async (payload) => {
				oldCalls.push(`send ${text(payload)}`);
				throw new Error(TOKEN_ERROR);
			}
		};
	};

	chat(ctx.server, 'STALE-chat');
	ctx.server.sendItemSend({ receiving: 1, location: 551 });
	ctx.add(1, [1, 551, 2, 0]);
	await waitFor(() => oldCalls, 'the fetch to answer under the restart', 5000);
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, []);

	const reattachedAt = Date.now();
	const next = reattach();
	await waitFor(() => relayed(next.posted).some((line) => line.includes('Location#551)')), 'the item', 5000);
	await catchupRanSince(ctx, reattachedAt);

	assertRelayedInOrder(next.posted, ['STALE-chat', 'Location#551)']);
	assert.deepStrictEqual(oldCalls, []);
});

async function hintWatch(t, mode) {
	const ctx = await hostWatch(t, { hints: { 1: [hint({ location: 5000 })] } });
	await waitFor(() => hintStore.isSeeded(ctx.seed), 'the hint baseline');
	claims.claim({ watchId: ctx.watch.id, slot: 'SlotA', userId: USER });
	claims.setHintPings(ctx.watch.id, 'SlotA', mode);
	// SlotA is the finder: somebody wants an item out of its world.
	ctx.hintAt = (location) => ctx.server.sendPacket({
		cmd: 'SetReply', key: '_read_hints_0_1', value: [hint({ location: 5000 }), hint({ location })]
	});
	ctx.hintRecorded = (location) => waitFor(() => hintStore.seen(hintStore.hintKey(ctx.seed, 0, 1, location)), 'the hint to be recorded', 5000);
	return ctx;
}

async function assertOneDm(next, location) {
	const dm = await waitFor(() => next.dms[0], 'the hint DM', 5000);
	await sleep(200);
	assert.strictEqual(next.dms.length, 1, 'one DM');
	assert.strictEqual(dm.userId, USER);
	assert.match(dm.payload.content, new RegExp(`waiting on .*Location#${location}`));
	assert.strictEqual(next.posted.filter((p) => text(p).includes('waiting on')).length, 0, 'kept out of the channel');
}

test('a hint DM that comes up while detached is sent through the new client', async (t) => {
	const ctx = await hintWatch(t, 'dm');
	const oldCalls = restart(ctx.discord);

	ctx.hintAt(6001);
	await ctx.hintRecorded(6001);
	await sleep(200);
	assert.deepStrictEqual(oldCalls, []);

	const next = reattach();
	await assertOneDm(next, 6001);
	assert.deepStrictEqual(oldCalls, []);
});

test('a hint DM under way on the old client when it is destroyed is sent again through the new one', async (t) => {
	const ctx = await hintWatch(t, 'dm');
	let oldCalls = null;
	ctx.discord.client.users.fetch = async () => {
		// The restart lands while this lookup is with Discord.
		oldCalls = restart(ctx.discord);
		throw new Error(TOKEN_ERROR);
	};

	ctx.hintAt(6002);
	await waitFor(() => oldCalls, 'the DM to fail under the restart', 5000);
	await sleep(200);
	assert.deepStrictEqual(oldCalls, []);

	const next = reattach();
	await assertOneDm(next, 6002);
	assert.deepStrictEqual(oldCalls, []);
});

test('a hint ping held through the detach and then refused by the new client is tried once, not again as if the restart had failed it', async (t) => {
	const ctx = await hintWatch(t, 'channel');
	restart(ctx.discord);
	ctx.hintAt(6101);
	await ctx.hintRecorded(6101);
	await sleep(200);

	const next = testDiscord();
	const refused = [];
	next.control.fail = (payload) => {
		if (!text(payload).includes('waiting on')) return false;
		refused.push(text(payload));
		return true;
	};
	reattach(next);
	await waitFor(() => refused.length > 0, 'the refusal', 5000);
	// Queued behind the hint ping, so by the time it posts every try at the ping has been made.
	chat(ctx.server, 'AFTER-chat');
	await waitFor(() => relayed(next.posted).some((line) => line.includes('AFTER-chat')), 'the next line', 5000);
	assert.strictEqual(refused.length, 1);
	assert.match(refused[0], /Location#6101/);
});

test('a second detach before the new client is ready, as a failed login retry does, still lets one start post everything', async (t) => {
	const ctx = await hostWatch(t);
	const oldCalls = restart(ctx.discord);

	chat(ctx.server, 'RETRY-chat');
	ctx.server.sendItemSend({ receiving: 1, location: 601 });
	// The first flush is already waiting when the second detach comes.
	await sleep(GAP_MS);
	monitor.detachArchipelagoMonitor();
	chat(ctx.server, 'RETRY-later-chat');
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, []);

	const next = reattach();
	await waitFor(() => relayed(next.posted).some((line) => line.includes('RETRY-later-chat')), 'the later chat', 5000);
	await sleep(300);
	assertRelayedInOrder(next.posted, ['RETRY-chat', 'Location#601)', 'RETRY-later-chat']);
	assert.deepStrictEqual(oldCalls, []);
});

test('one /config change runs applyConfig once however many times the monitor has started', (t) => {
	// applyConfig's first step, so its calls count applyConfig runs.
	const runs = t.mock.method(logic, 'configChanged');
	monitor.startArchipelagoMonitor(ap.fakeDiscord().client);
	monitor.startArchipelagoMonitor(ap.fakeDiscord().client);
	runs.mock.resetCalls();

	configStore.writeOverride('archipelagoBatchSeconds', config.archipelagoBatchSeconds, { path: OVERRIDES });
	assert.strictEqual(runs.mock.callCount(), 1);
});

test('a flush still sending on a state that restartWatch replaced holds its lines for the new client too', async (t) => {
	const ctx = await setup(t);
	await baselined(ctx);
	ctx.discord.control.delayMs = 300;
	const N = 160;
	for (let i = 0; i < N; i++) chat(ctx.server, `FLOOD-${i} ${'x'.repeat(40)}`);
	await waitFor(() => blocks(ctx.posted).length >= 1, 'the first block of the flood');

	// !ap retry (or a /config room change) replaces the state while its flush is still sending.
	monitor.restartWatch(ctx.watch.id);
	restart(ctx.discord);
	await sleep(GAP_MS);
	const next = reattach();

	const both = () => relayed(ctx.posted).concat(relayed(next.posted));
	await waitFor(() => both().some((line) => line.includes(`FLOOD-${N - 1} `)), 'the end of the flood', 20000);
	await sleep(500);
	const counts = Array.from({ length: N }, (_, i) => both().filter((line) => line.includes(`FLOOD-${i} `)).length);
	assert.deepStrictEqual(counts.map((count, i) => [i, count]).filter(([, count]) => count !== 1), [], 'every line posted exactly once');
});

test('a hold past its limit lets lines fail as before it, and the next client relays and holds again', async (t) => {
	const ctx = await hostWatch(t);
	monitor.relayTiming.holdLimitMs = 300;
	const oldCalls = restart(ctx.discord);
	await sleep(500);
	chat(ctx.server, 'AFTER-LIMIT');
	await sleep(GAP_MS);
	// A login retry's stop in the same outage must not start holding again. Given a long limit,
	// a second hold would still be holding when the new client arrives.
	monitor.relayTiming.holdLimitMs = 60000;
	monitor.detachArchipelagoMonitor();
	chat(ctx.server, 'STILL-UNHELD');
	await sleep(GAP_MS);
	assert.deepStrictEqual(oldCalls, [], 'nothing tried through the destroyed client');

	const next = reattach(testDiscord());
	chat(ctx.server, 'LIVE-AGAIN');
	await waitFor(() => relayed(next.posted).some((line) => line.includes('LIVE-AGAIN')), 'a live line on the new client');
	const lines = relayed(next.posted);
	assert.ok(!lines.some((line) => line.includes('AFTER-LIMIT')), 'lines past the limit were not held');
	assert.ok(!lines.some((line) => line.includes('STILL-UNHELD')), 'a second detach did not hold again');

	// Attached again, the next restart holds as usual.
	restart(next);
	chat(ctx.server, 'HELD-AGAIN');
	await sleep(GAP_MS);
	const last = reattach(testDiscord());
	await waitFor(() => relayed(last.posted).some((line) => line.includes('HELD-AGAIN')), 'the held line on the next client');
});
