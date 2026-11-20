// `!ap nexthide` against a real room watch: a real client on the stand-in server, the room page and
// tracker stubbed as in the catch-up tests, and the logic worker faked at acquire().
//
// Two hand-offs decide whether the setting does anything, and no test of answerAll alone can see
// either: the command's hideFinished has to reach the worker through suggestNextAll, and a release
// has to outlive a restart of the bot. A seed generated here collects a slot's items when it goals,
// so most of what the setting leaves out goes to slots released without a goal, and the server keeps
// no record of a release for the bot to read back. archipelagoReleases.js keeps the ones it heard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const ap = require('./helpers/apServer.js');
const stores = ap.useTempStores('nexthideroom');
const { catchup, tracker, monitor, setup, baselined, waitFor } = require('./helpers/catchupRelay.js');
const logic = require('../helpers/archipelagoLogic.js');
const releases = require('../helpers/archipelagoReleases.js');

test.after(() => stores.cleanup());

/** A worker that answers every slot with one open location and keeps the options each request came with. */
function fakeWorker(t) {
	const sent = [];
	const worker = {
		inLogic: async (queries, received, opts) => {
			sent.push(opts);
			return queries.map(q => ({
				slot: q.slot, verified: true, locations: [[5000, 1, 'Loc 5000']], open: 1,
				...(opts && Array.isArray(opts.finished) ? { hidden: opts.finished.length } : {})
			}));
		}
	};
	t.mock.method(logic, 'acquire', async () => ({ ok: true, worker }));
	t.mock.method(tracker, 'readProgress', async () => ({ checkedIds: new Map(), receivedItems: new Map() }));
	return sent;
}

const release = (slot) => ({
	cmd: 'PrintJSON', type: 'Release', team: 0, slot,
	data: [{ text: `Player ${slot} (Team #1) has released all remaining items from their world.` }]
});

const heardFor = (ctx) => [...releases.heard(ctx.watch.id, ctx.seed)];
const onDisk = () => JSON.parse(fs.readFileSync(stores.paths.releases, 'utf8')).released;

async function releaseHeard(ctx, slot) {
	ctx.server.sendPacket(release(slot));
	await waitFor(() => heardFor(ctx).includes(slot), `slot ${slot}'s release`);
}

/** A restart as a fresh boot sees it: nothing in memory, and the client knows of no release until it is put back. */
async function freshBoot(ctx) {
	releases.reset();
	const state = monitor.restartWatch(ctx.watch.id);
	state.client.released.clear();
	await waitFor(() => ctx.entry().status === 'connected' && state.client.roomStateReadAt, 'the reconnect');
	return state;
}

test('suggestNextAll hands hideFinished to the worker as the room\'s goaled slots, and only when asked', async (t) => {
	const ctx = await setup(t, { statuses: { 1: 30 } });
	await baselined(ctx);
	await waitFor(() => ctx.entry().finished === 1, 'SlotA\'s goal');
	const sent = fakeWorker(t);

	const plain = await monitor.suggestNextAll(ctx.watch.id, ['Watcher']);
	const hiding = await monitor.suggestNextAll(ctx.watch.id, ['Watcher'], { hideFinished: true });
	assert.strictEqual(plain.ok, true, JSON.stringify(plain));
	assert.deepStrictEqual(sent, [{}, { finished: [1] }]);
	assert.strictEqual(plain.results[0].hidden, undefined);
	assert.strictEqual(hiding.results[0].hidden, 1);
});

test('a release the bot hears is on disk at once, even with release lines filtered out of the channel', async (t) => {
	// Nothing posts here, and a forced stop kills the process, which skips every exit hook.
	const ctx = await setup(t);
	await baselined(ctx);
	monitor.setFilter(ctx.watch.id, 'goals', false);
	await releaseHeard(ctx, 1);
	assert.deepStrictEqual(onDisk()[`${ctx.watch.id}::${ctx.seed}`], [1]);
});

test('after a restart, a release heard before it is put back, for resolveSlot and for nexthide', async (t) => {
	const ctx = await setup(t);
	await baselined(ctx);
	await releaseHeard(ctx, 1);

	const state = await freshBoot(ctx);
	assert.deepStrictEqual([...state.client.released], ['0:1']);
	assert.strictEqual(monitor.resolveSlot(state.client, 'SlotA').how, 'released');

	const sent = fakeWorker(t);
	await monitor.suggestNextAll(ctx.watch.id, ['Watcher'], { hideFinished: true });
	assert.deepStrictEqual(sent, [{ finished: [1] }]);
});

test('a goal is never kept as a release, and comes back from the server instead', async (t) => {
	// A goal is in data storage for every connect to read. Kept as a release, it would also say
	// `released` to resolveSlot about a slot that goaled.
	const ctx = await setup(t, { statuses: { 2: 30 } });
	await baselined(ctx);
	await waitFor(() => ctx.entry().finished === 1, 'Watcher\'s goal');
	await releaseHeard(ctx, 1);
	assert.deepStrictEqual(onDisk()[`${ctx.watch.id}::${ctx.seed}`], [1]);

	const state = await freshBoot(ctx);
	assert.deepStrictEqual([...state.client.released], ['0:1']);
	assert.ok(state.client.hasGoaled(2));
});

test('losing the catch-up file loses no release', async (t) => {
	// The catch-up record is rewritten after every post and may be lost to a crash; it holds none.
	const ctx = await setup(t);
	await baselined(ctx);
	await releaseHeard(ctx, 1);
	fs.rmSync(stores.paths.catchup, { force: true });
	catchup.reset();

	const state = await freshBoot(ctx);
	assert.deepStrictEqual([...state.client.released], ['0:1']);
});

test('a server that comes back on another seed takes no release of the old one with it', async (t) => {
	// Releases outlive a reconnect, and keeping them would make a stale one the new seed's.
	const ctx = await setup(t);
	await baselined(ctx);
	await releaseHeard(ctx, 1);

	const state = monitor.restartWatch(ctx.watch.id);
	await waitFor(() => ctx.entry().status === 'connected' && state.client.roomStateReadAt, 'the reconnect');
	assert.ok(state.client.released.has('0:1'), 'kept across a reconnect to the same seed');

	await state.client._handleRoomInfo({ cmd: 'RoomInfo', seed_name: 'Seed_Next_Async', games: [], datapackage_checksums: {} });
	assert.deepStrictEqual([...state.client.released], []);
	assert.strictEqual(state.client.seedName, 'Seed_Next_Async');
});

test('a release kept for another seed on the same watch is not put back', async (t) => {
	const ctx = await setup(t);
	await baselined(ctx);
	assert.strictEqual(releases.note(ctx.watch.id, 'Some_Other_Seed', [1]), true);
	const state = await freshBoot(ctx);
	assert.deepStrictEqual([...state.client.released], []);
});

test('a watch that goes takes its releases with it', async (t) => {
	// Its id can name another room later, which must not inherit them.
	const ctx = await setup(t);
	await baselined(ctx);
	await releaseHeard(ctx, 1);
	monitor.removeWatch(ctx.watch.id);
	assert.deepStrictEqual(heardFor(ctx), []);
	assert.ok(!(`${ctx.watch.id}::${ctx.seed}` in onDisk()));
});
