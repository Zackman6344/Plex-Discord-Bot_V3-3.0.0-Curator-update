// apworld/tests/e2e_bot.test.js
// The bot's side of scenario (g): the whole Plex Media feature played against a real Archipelago
// 0.6.8 MultiServer, from linking a slot to the room recording its goal.
//
// What has to hold: the watch reads the room and the slot links in the room's own spelling; the
// room takes the bot's client as a game client of that slot; a Plex history row of the open title
// puts exactly that title's watch location and every checkpoint into the room; the locked title's
// checks wait in the bank and nothing of it reaches the room; its unlock, sent through the
// multiworld, releases them into the room; the room records the slot's goal; and the relay posts
// other clients' join and leave lines, every send that skip-goaled lets through (one per location
// the slot checked, and the unlock's) and the goal, but never the bot client's own join and leave.
//
// Harness: apworld/tests/test_e2e.py runs this file with node --test (npm run test:apworld, scenario
// G) once it has generated the seed with the frozen Archipelago and hosts it with MultiServer on a
// loopback port; the JSON file PLEXMEDIA_E2E_PLAN names carries the room, the slots and the ids the
// seed placed, and without it the test is skipped. The test runner keeps every store in memory.
// Real: createGame, ApMediaClient, a memory apMediaStore, apMediaWatch and archipelagoMonitor watching
// the ChecksFinder slot of the configured room. Fake: the PMS (history rows the test adds), Discord
// (posts recorded by channel) and the game's timers (batches go out on flushAll, polls when the test
// calls them). The ChecksFinder player is a raw websocket client. The room's own record is read from
// test_e2e.py's GET /state on loopback. Data packages are cached in memory: archipelagoData writes
// to data/archipelago/datapackage with no test-runner gate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const WebSocket = require('ws');

const config = require('../../config/config.js');
const monitor = require('../../helpers/archipelagoMonitor.js');
const dataCache = require('../../helpers/archipelagoData.js');
const { ArchipelagoClient, CLIENT_VERSION, stripAnsi } = require('../../helpers/archipelagoClient.js');
const { ApMediaClient } = require('../../helpers/apMediaClient.js');
const { createGame, entryLabel } = require('../../helpers/apMediaGame.js');
const { createApMediaStore } = require('../../helpers/apMediaStore.js');
const { BOT_GAME_TAG, CLIENT_GOAL, CLIENT_TAGS, GAME } = require('../../helpers/apMediaContracts.js');
const { waitFor } = require('../../test/helpers/apServer.js');

const PLAN_FILE = process.env.PLEXMEDIA_E2E_PLAN || '';
const RELAY_CHANNEL = '200000000000000101';
const GAME_CHANNEL = '200000000000000102';
const ICON = {
	done: String.fromCodePoint(0x2705),
	locked: String.fromCodePoint(0x1F512),
	unlocked: String.fromCodePoint(0x1F513),
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sortIds = (ids) => [...ids].map(Number).sort((a, b) => a - b);

// Never fire: the game's announcement batches go out on flushAll, and its Plex polls when the test
// calls them, so nothing runs on a clock the room does not share.
function heldTimers() {
	let next = 0;
	return {
		setTimeout: () => ({ id: ++next, unref() {} }),
		setInterval: () => ({ id: ++next, unref() {} }),
		clearTimeout() {},
		clearInterval() {},
	};
}

function fakeDiscord() {
	const posts = [];
	const channel = (id) => ({
		id,
		send: async (payload) => {
			posts.push({ channelId: String(id), content: String(payload.content ?? ''), allowedMentions: payload.allowedMentions });
			return {};
		},
	});
	return {
		posts,
		client: {
			channels: { fetch: async (id) => channel(id) },
			users: { fetch: async (id) => channel(`dm:${id}`) },
		},
	};
}

function fakePms() {
	const pms = {
		rows: [],
		async history({ accountId, since, start = 0, size = 300 }) {
			const all = pms.rows.filter((r) => Number(r.accountID) === Number(accountId) && Number(r.viewedAt) >= Number(since));
			return { rows: all.slice(start, start + size), total: all.length };
		},
		async metadata() { return null; },
		async sessions() { return []; },
		async accounts() { return [{ id: 1, name: 'Owner' }]; },
	};
	return pms;
}

async function rawClient(port, connect) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const packets = [];
	ws.on('message', (raw) => {
		for (const packet of JSON.parse(raw.toString())) {
			packets.push(packet);
			if (packet.cmd === 'RoomInfo') ws.send(JSON.stringify([connect]));
		}
	});
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	ws.on('error', (err) => packets.push({ cmd: 'error', message: err.message }));
	const answer = await waitFor(() => packets.find((p) => p.cmd === 'Connected' || p.cmd === 'ConnectionRefused'), `${connect.name} to connect`);
	assert.strictEqual(answer.cmd, 'Connected', `the room refused ${connect.name}: ${JSON.stringify(answer.errors)}`);
	return {
		packets,
		send: (packet) => ws.send(JSON.stringify([packet])),
		close: () => new Promise((resolve) => {
			if (ws.readyState === WebSocket.CLOSED) return resolve();
			ws.once('close', () => resolve());
			ws.close();
		}),
	};
}

async function roomState(plan) {
	const response = await fetch(`http://127.0.0.1:${plan.statePort}/state`);
	assert.strictEqual(response.status, 200, 'the room\'s state endpoint answers');
	return response.json();
}

async function waitRoom(plan, predicate, what, timeoutMs = 15000) {
	const started = Date.now();
	for (;;) {
		const state = await roomState(plan);
		if (predicate(state)) return state;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; the room holds ${JSON.stringify(state)}`);
		await delay(50);
	}
}

test('the bot plays a Plex Media slot against a real MultiServer, from a Plex history row to the goal', {
	skip: PLAN_FILE ? false : 'needs PLEXMEDIA_E2E_PLAN, which apworld/tests/test_e2e.py sets (npm run test:apworld)',
	timeout: 90000,
}, async () => {
	const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
	const plex = plan.plex.slot;
	const finderSlot = plan.finder.slot;
	const slot = plan.plex.name;
	const openLabel = entryLabel(plan.open.entry);
	const lockedLabel = entryLabel(plan.locked.entry);
	const viaPlex = plan.deliver.kind === 'plex';
	const undo = [];
	try {
		const { load, save } = dataCache;
		dataCache.load = async () => null;
		dataCache.save = async () => {};
		undo.push(() => {
			dataCache.load = load;
			dataCache.save = save;
		});

		// What the watch's observer turned into relay lines, each with its own verdict: a line marked
		// self is never relayed.
		const lines = [];
		const ownEmit = Object.prototype.hasOwnProperty.call(ArchipelagoClient.prototype, 'emit');
		const emit = ArchipelagoClient.prototype.emit;
		ArchipelagoClient.prototype.emit = function recordLine(event, ...args) {
			if (event === 'line' && this.constructor === ArchipelagoClient) lines.push(args[0]);
			return emit.call(this, event, ...args);
		};
		undo.push(() => {
			if (ownEmit) ArchipelagoClient.prototype.emit = emit;
			else delete ArchipelagoClient.prototype.emit;
		});

		// Every packet the bot's game client put on the wire.
		const wire = [];
		const sendNow = ApMediaClient.prototype._sendNow;
		ApMediaClient.prototype._sendNow = function recordPacket(packet) {
			const ok = sendNow.call(this, packet);
			if (ok) wire.push(packet);
			return ok;
		};
		undo.push(() => {
			ApMediaClient.prototype._sendNow = sendNow;
		});
		const sentIds = () => wire.filter((p) => p.cmd === 'LocationChecks').flatMap((p) => p.locations);

		const savedConfig = { ...config };
		undo.push(() => {
			for (const key of Object.keys(config)) if (!(key in savedConfig)) delete config[key];
			Object.assign(config, savedConfig);
		});
		Object.assign(config, {
			ownerId: plan.owner,
			commandPrefix: '!',
			archipelagoEnabled: true,
			archipelagoRoomUrl: '',
			archipelagoHost: '127.0.0.1',
			archipelagoPort: plan.port,
			archipelagoSlot: plan.finder.name,
			archipelagoPassword: '',
			archipelagoChannelId: RELAY_CHANNEL,
			archipelagoBatchSeconds: 0.2,
			apMediaEnabled: true,
			apMediaChannelId: GAME_CHANNEL,
			apMediaAnnounce: 'completions',
		});
		const savedTiming = { ...monitor.relayTiming };
		monitor.relayTiming.minFlushMs = 50;
		undo.push(() => Object.assign(monitor.relayTiming, savedTiming));

		// The watch on the ChecksFinder slot, then the game, then the owner's link.
		const discord = fakeDiscord();
		monitor.startArchipelagoMonitor(discord.client);
		undo.push(() => {
			config.archipelagoEnabled = false;
			monitor.applyConfig();
		});
		const described = await waitFor(() => {
			const d = monitor.describeSlot(0, slot);
			return d && d.known && d.game ? d : null;
		}, 'the watch to read the room', 20000);
		assert.deepStrictEqual(described, { known: true, canonical: slot, slotId: plex, game: GAME });

		const store = createApMediaStore();
		const pms = fakePms();
		const events = [];
		const game = createGame({
			store,
			monitor,
			config,
			pms,
			configStore: { onChange: () => () => {} },
			timers: heldTimers(),
			watcherTimers: heldTimers(),
			commandLog: { recordEvent: (kind, detail) => events.push({ kind, ...detail }) },
			builder: { playlists: async () => [] },
			bookmarks: { forUser: () => [] },
			catalogStore: { work: () => null },
		});
		undo.push(() => game.stop());
		assert.deepStrictEqual(game.start({ discord: discord.client }), { running: true, reason: null });

		let read = 0;
		async function gameLines() {
			await game._internal.idle();
			await game._internal.flushAll();
			const posted = discord.posts.filter((p) => p.channelId === GAME_CHANNEL);
			const fresh = posted.slice(read);
			read = posted.length;
			for (const p of fresh) assert.deepStrictEqual(p.allowedMentions, { parse: [] }, 'a credit line pings nobody');
			return fresh.flatMap((p) => p.content.split('\n'));
		}
		let historyKey = 9000;
		async function watchedOnPlex(entry) {
			historyKey += 1;
			pms.rows.push({
				historyKey: `/status/sessions/history/${historyKey}`,
				ratingKey: String(entry.rk),
				viewedAt: Math.max(Math.floor(Date.now() / 1000), plan.generatedAt + 1),
				accountID: 1,
				librarySectionID: entry.k === 'movie' ? '3' : '4',
				type: entry.k,
			});
			await game._internal.watcher().pollHistory();
			await game._internal.idle();
		}

		// Typed in lower case: the binding keeps the room's spelling, which is all the server takes.
		const linked = await game.link({ watchId: 0, slot: slot.toLowerCase(), userId: plan.owner, by: plan.owner });
		assert.ok(linked.ok, linked.message);
		assert.strictEqual(linked.binding.slot, slot);
		assert.deepStrictEqual(linked.warnings, []);
		const key = linked.binding.key;
		const row = () => game.status(key).bindings[0];
		await waitFor(() => row().connection === 'connected' && row().inventoryKnown, 'the slot to connect and report its items', 20000);
		await game._internal.idle();
		let r = row();
		assert.strictEqual(r.seedName, plan.seedName);
		assert.deepStrictEqual([r.total, r.goalCount, r.ready, r.locked, r.done], [plan.plex.entries, plan.plex.goalCount, 1, plan.plex.entries - 1, 0]);
		let state = await roomState(plan);
		assert.deepStrictEqual(state.clients[plex], [{ tags: [...CLIENT_TAGS], noLocations: false, noText: true }],
			'the room takes the bot as a game client of the slot, one that may send checks');
		assert.deepStrictEqual(state.checked[plex], []);
		const welcome = (await gameLines()).join('\n');
		assert.ok(welcome.includes(`\`${slot}\` is in the game with 1 of ${plan.plex.entries} titles open: ${openLabel} (`), welcome);
		assert.ok(welcome.includes(`Goal: finish ${plan.plex.goalCount}.`), welcome);

		// The open title, watched on Plex: its watch location and every checkpoint, nothing else.
		await watchedOnPlex(plan.open.entry);
		state = await waitRoom(plan, (s) => s.checked[plex].length >= plan.open.ids.length, 'the open title\'s checks');
		assert.deepStrictEqual(sortIds(state.checked[plex]), sortIds(plan.open.ids), 'exactly its watch location and its checkpoints');
		assert.notStrictEqual(state.status[plex], CLIENT_GOAL, `one title is not the ${plan.plex.goalCount} the goal needs`);
		await waitFor(() => row().pending === 0, 'the room to confirm the checks');
		assert.strictEqual(row().done, 1);
		assert.deepStrictEqual(game.list(key, 'done').groups.flatMap((g) => g.rows.map((x) => x.title)), [openLabel]);
		assert.deepStrictEqual(await gameLines(), [`${ICON.done} \`${slot}\` watched **${openLabel}**, ${plan.open.ids.length} checks sent`]);

		// The locked title, watched on Plex: banked, and nothing of it reaches the room.
		await watchedOnPlex(plan.locked.entry);
		r = row();
		assert.strictEqual(r.banked, plan.locked.ids.length, 'its checks wait in the bank');
		assert.strictEqual(r.pending, 0);
		assert.deepStrictEqual(await gameLines(), [`${ICON.locked} \`${slot}\` watched **${lockedLabel}**, ${plan.locked.ids.length} checks waiting for its unlock`]);
		await delay(300);
		state = await roomState(plan);
		assert.deepStrictEqual(sortIds(state.checked[plex]), sortIds(plan.open.ids), 'the room holds nothing of the locked title');
		assert.deepStrictEqual(sentIds().filter((id) => plan.locked.ids.includes(id)), [], 'and the bot sent none of its ids');

		// Its unlock comes through the multiworld: from the ChecksFinder player's location, or from a
		// title the bot can watch now. The ChecksFinder player connects either way, so the relay has a
		// join and a leave of someone other than the bot to post.
		const finder = await rawClient(plan.port, {
			cmd: 'Connect',
			password: '',
			game: 'ChecksFinder',
			name: plan.finder.name,
			uuid: 'plex-media-e2e-checksfinder',
			version: CLIENT_VERSION,
			items_handling: 0,
			tags: [],
			slot_data: false,
		});
		undo.push(() => finder.close());
		let earned;
		if (viaPlex) {
			await watchedOnPlex(plan.deliver.entry);
			earned = [...plan.open.ids, ...plan.deliver.ids, ...plan.locked.ids];
		} else {
			finder.send({ cmd: 'LocationChecks', locations: [plan.deliver.location] });
			earned = [...plan.open.ids, ...plan.locked.ids];
		}
		state = await waitRoom(plan, (s) => s.checked[plex].length >= earned.length, 'the released checks');
		assert.deepStrictEqual(sortIds(state.checked[plex]), sortIds(earned), 'the banked checks reached the room, and nothing else');
		assert.deepStrictEqual(state.checked[finderSlot], viaPlex ? [] : [plan.deliver.location]);
		await waitFor(() => row().banked === 0 && row().pending === 0, 'the bank to empty');
		const released = `${ICON.unlocked} \`${slot}\` **${lockedLabel}** unlocked, ${plan.locked.ids.length} checks sent`;
		const viaLine = viaPlex ? [`${ICON.done} \`${slot}\` watched **${entryLabel(plan.deliver.entry)}**, ${plan.deliver.ids.length} checks sent`] : [];
		assert.deepStrictEqual(await gameLines(), [...viaLine, released]);

		// Two titles done of the two the goal needs: the room records the goal.
		state = await waitRoom(plan, (s) => s.status[plex] === CLIENT_GOAL, 'the room to record the goal');
		r = row();
		assert.ok(r.goalReached && r.goalSent, 'the binding knows its goal went');
		assert.strictEqual(r.done, viaPlex ? 3 : 2);
		assert.deepStrictEqual(wire.filter((p) => p.cmd === 'StatusUpdate'), [{ cmd: 'StatusUpdate', status: CLIENT_GOAL }]);
		assert.ok(events.some((e) => e.kind === 'apmedia-goal' && e.slot === slot));
		assert.strictEqual(game.health().status, 'ok', game.health().detail);

		// The relay: the bot client's join and leave are seen and kept out; everyone else's lines go.
		await waitFor(() => lines.some((l) => l.type === 'Goal' && l.packet.slot === plex), 'the goal line at the watch');
		game.stop();
		const presence = (slotId) => lines.filter((l) => (l.type === 'Join' || l.type === 'Part') && l.packet.slot === slotId);
		await waitFor(() => presence(plex).some((l) => l.type === 'Part'), 'the bot client\'s leave line at the watch');
		await finder.close();
		// The ChecksFinder slot is also the one the watch observes from: its own join is there too.
		const player = () => presence(finderSlot).filter((l) => !/\['Tracker'\]\.$/.test(stripAnsi(l.text)));
		await waitFor(() => player().some((l) => l.type === 'Part'), 'the ChecksFinder client\'s leave line at the watch');
		const relayText = () => discord.posts.filter((p) => p.channelId === RELAY_CHANNEL).map((p) => stripAnsi(p.content)).join('\n');
		// The relay posts in order, so once this last line is out every line before it has been decided.
		const relay = await waitFor(() => {
			const text = relayText();
			return text.includes(`${plan.finder.name} (Team #1) has left the game`) ? text : null;
		}, 'the relay to post the ChecksFinder client\'s leave line', 5000);
		const bot = presence(plex);
		assert.deepStrictEqual(bot.map((l) => [l.type, l.self]), [['Join', true], ['Part', true]],
			'the watch saw the bot client come and go once, and took both lines for the bot\'s own');
		for (const l of bot) assert.ok(!relay.includes(stripAnsi(l.text)), `not relayed: ${stripAnsi(l.text)}`);
		assert.ok(!relay.includes(BOT_GAME_TAG), relay);
		assert.deepStrictEqual(player().map((l) => [l.type, l.self]), [['Join', false], ['Part', false]]);
		for (const l of player()) assert.ok(relay.includes(stripAnsi(l.text)), `relayed: ${stripAnsi(l.text)}`);
		assert.ok(relay.includes(`${slot} (Team #1) has completed their goal`), relay);
		// The bot client's sends are the slot's, not its presence: the room prints one per location.
		// Each is relayed unless skip-goaled (on by default) keeps it out as an item for a slot whose
		// goal line came first; the bank a Plex-world unlock releases goes out after the goal.
		const skipGoaled = config.archipelagoSkipGoaled !== false;
		const goalAt = lines.findIndex((l) => l.type === 'Goal' && l.packet.slot === plex);
		const relayable = (l) => !(skipGoaled && l.receiving === plex && lines.indexOf(l) > goalAt);
		const slotSends = lines.filter((l) => l.type === 'ItemSend' && l.packet.item && l.packet.item.player === plex);
		assert.deepStrictEqual(sortIds(slotSends.map((l) => l.packet.item.location)), sortIds(earned),
			'one send line per location the slot checked');
		for (const l of slotSends) {
			const text = stripAnsi(l.text);
			assert.strictEqual(l.self, false, `not taken for the bot's own: ${text}`);
			assert.strictEqual(relay.includes(text), relayable(l), `${relayable(l) ? 'relayed' : 'kept out by skip-goaled'}: ${text}`);
		}
		const holder = viaPlex ? plex : finderSlot;
		const send = lines.find((l) => l.type === 'ItemSend' && l.packet.item && l.packet.item.player === holder
			&& l.packet.item.location === plan.deliver.location);
		assert.ok(send && !send.self, 'the watch saw the unlock sent from the location that held it');
		const sendText = stripAnsi(send.text);
		assert.ok(sendText.includes(plan.locked.unit) && sendText.includes(plan.deliver.locationName), sendText);
		assert.ok(relayable(send) && relay.includes(sendText), `relayed: ${sendText}`);

		// The watch stops too, and the room sees every client go.
		config.archipelagoEnabled = false;
		monitor.applyConfig();
		state = await waitRoom(plan, (s) => s.endpoints === 0, 'every client to leave the room');
		assert.deepStrictEqual(Object.values(state.clients).flat(), []);
		fs.writeFileSync(plan.resultFile, JSON.stringify({
			ok: true,
			deliver: plan.deliver.kind,
			sent: sortIds(sentIds()),
			relayed: discord.posts.filter((p) => p.channelId === RELAY_CHANNEL).length,
		}));
	} finally {
		for (const step of undo.reverse()) {
			try {
				await step();
			} catch (err) {
				console.error('teardown step failed:', err);
			}
		}
	}
});
