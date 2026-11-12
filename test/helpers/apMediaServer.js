// test/helpers/apMediaServer.js
// A stand-in Archipelago server that speaks the game-client half of the protocol, for
// helpers/apMediaClient.js and for the observer watch that shares a room with it.
//
// test/helpers/apServer.js is the observer's stand-in and answers only Connect and Get. It stays as
// it is, because the existing AP tests lean on exactly that. This one follows MultiServer 0.6.8
// (process_client_cmd, on_client_joined/left, register_location_checks, send_new_items) wherever a
// game client could tell the difference:
//  - Connect is checked the way the server checks it: the slot name exactly, the game unless a
//    Tracker, TextOnly or HintGame client sends none, the password, and the items_handling flag
//    rule, and refused with the server's own error names.
//  - Connected carries slot_data unless the client asked for none, and the first ReceivedItems
//    (index 0, start inventory first) shares its frame. A slot that holds nothing gets none at all.
//  - Later items go out from each socket's own send index. Sync answers with the whole list.
//  - LocationChecks and the goal from a tracker-tagged client get InvalidPacket. From a game client
//    only the slot's own unchecked locations register, answered with RoomUpdate carrying the new
//    ones, after any ReceivedItems they caused.
//  - Join and Part reach every authenticated client that did not ask for NoText, worded as the
//    server words them. Part has no tags field: in 0.6.8 the tag list is only in its text.
//
// RoomInfo carries no data package checksums and a GetDataPackage is answered with no games, so an
// observer connected here never writes to the data package cache. Get is never answered.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const { WebSocketServer, WebSocket } = require('ws');

// MultiServer._non_game_messages, in its dict order: the first tag found picks the verb.
const NON_GAME = [['HintGame', 'hinting'], ['Tracker', 'tracking'], ['TextOnly', 'viewing']];
const CLIENT_GOAL = 30;
const TUTORIAL = 'Now that you are connected, you can use !help to list commands to run via the server. ' +
	'If your client supports it, you may have additional local commands you can list with /help.';

function pyStr(value) {
	const text = String(value).replace(/\\/g, '\\\\');
	if (text.includes("'") && !text.includes('"')) return `"${text}"`;
	return `'${text.replace(/'/g, "\\'")}'`;
}

// How Python prints a list of tag strings inside an f-string: ['AP', 'PlexMediaBot', 'NoText']
function pyList(values) {
	return `[${values.map(pyStr).join(', ')}]`;
}

function versionText(version) {
	const v = version || {};
	return [v.major, v.minor, v.build].map(part => (part === undefined ? 0 : part)).join('.');
}

function presenceVerb(tags, joining) {
	for (const [tag, verb] of NON_GAME) {
		if (tags.includes(tag)) return joining ? verb : `stopped ${verb}`;
	}
	return joining ? 'playing' : 'left';
}

function isNonGame(tags) {
	return tags.some(tag => NON_GAME.some(([name]) => name === tag));
}

// MultiServer's Client.items_handling setter: bits 1 and 2 need bit 0.
function validItemsHandling(value) {
	return Number.isInteger(value) && !(!(value & 1) && (value & 0b110));
}

function networkItem(item, location, player, flags = 0) {
	return { item: Number(item), location: Number(location), player: Number(player), flags: Number(flags) || 0, class: 'NetworkItem' };
}

/**
 * @param {object} [options]
 * @param {Array<{name: string, game: string, alias?: string}>} [options.slots]  numbered from 1
 * @param {string} [options.seedName]
 * @param {string|null} [options.password]  the room password; a Connect without it is refused
 * @param {object} [options.slotData]        slot number -> slot_data
 * @param {object} [options.locations]       slot number -> every location id in that slot's world
 * @param {object} [options.checked]         slot number -> location ids checked before anyone connects
 * @param {object} [options.startInventory]  slot number -> [{item, flags}] precollected
 * @param {object} [options.received]        slot number -> [{item, location, player, flags}] already received
 * @param {object} [options.placements]      location id -> {item, player, flags}: what checking it sends
 * @returns {Promise<object>} see the object built at the bottom
 */
function startApMediaServer(options = {}) {
	const {
		slots = [{ name: 'ZackPlex', game: 'Plex Media' }, { name: 'Watcher', game: 'ChecksFinder' }],
		seedName = 'Seed_PLEX',
		password = null,
		slotData = {},
		locations = {},
		checked = {},
		startInventory = {},
		received = {},
		placements = {},
	} = options;

	const team = 0;
	let roomPassword = password;
	const slotNumbers = slots.map((_, i) => i + 1);
	const names = new Map(slots.map((slot, i) => [slot.name, i + 1]));
	const gameOf = (slot) => slots[slot - 1].game;
	const aliasOf = (slot) => {
		const { name, alias } = slots[slot - 1];
		return alias && alias !== name ? `${alias} (${name})` : name;
	};
	const locationsOf = (slot) => new Set((locations[slot] || []).map(Number));
	const checkedBy = new Map(slotNumbers.map(slot => [slot, new Set((checked[slot] || []).map(Number))]));
	const startBy = new Map(slotNumbers.map(slot => [slot,
		(startInventory[slot] || []).map(entry => networkItem(entry.item, -2, 0, entry.flags))]));
	const receivedBy = new Map(slotNumbers.map(slot => [slot,
		(received[slot] || []).map(entry => networkItem(entry.item, entry.location, entry.player, entry.flags))]));
	const statuses = new Map();
	const clients = new Set();
	const log = { received: [], frames: [] };
	let opened = 0;

	const wss = new WebSocketServer({ port: 0 });

	function send(client, packets) {
		if (client.socket.readyState !== WebSocket.OPEN) return;
		log.frames.push({ to: client.id, packets });
		client.socket.send(JSON.stringify(packets));
	}

	function broadcastText(text, extra) {
		const packet = { cmd: 'PrintJSON', data: [{ text }], ...extra };
		for (const client of clients) {
			if (client.auth && !client.noText) send(client, [packet]);
		}
	}

	function itemsFor(client) {
		const start = client.remoteStart ? startBy.get(client.slot) : [];
		// The server keeps two lists per slot: with remote_items off, the slot's own world's items
		// are the local game's business and never sent.
		const items = receivedBy.get(client.slot).filter(item => client.remoteItems || item.player !== client.slot);
		return [...start, ...items];
	}

	function sendNewItems() {
		for (const client of clients) {
			if (!client.auth || client.noItems) continue;
			const full = itemsFor(client);
			if (full.length > client.sendIndex) {
				send(client, [{ cmd: 'ReceivedItems', index: client.sendIndex, items: full.slice(client.sendIndex) }]);
				client.sendIndex = full.length;
			}
		}
	}

	function register(slot, ids) {
		const own = locationsOf(slot);
		const done = checkedBy.get(slot);
		const fresh = [...new Set(ids.map(Number))].filter(id => own.has(id) && !done.has(id)).sort((a, b) => a - b);
		if (fresh.length === 0) return [];
		const prints = [];
		for (const location of fresh) {
			const placed = placements[location];
			if (!placed) continue;
			const item = networkItem(placed.item, location, slot, placed.flags);
			receivedBy.get(Number(placed.player)).push(item);
			prints.push({
				cmd: 'PrintJSON', type: 'ItemSend', receiving: Number(placed.player), item,
				data: [{ text: `${aliasOf(slot)} sent item ${placed.item} to ${aliasOf(Number(placed.player))}` }],
			});
		}
		if (prints.length > 0) {
			for (const client of clients) {
				if (client.auth && !client.noText) send(client, prints);
			}
		}
		for (const id of fresh) done.add(id);
		sendNewItems();
		for (const client of clients) {
			if (client.auth && client.slot === slot) send(client, [{ cmd: 'RoomUpdate', hint_points: 0, checked_locations: fresh }]);
		}
		return fresh;
	}

	function sendFrame(packets, { slot } = {}) {
		for (const client of clients) {
			if (slot === undefined || (client.auth && client.slot === slot)) send(client, packets);
		}
	}

	function updateStatus(slot, status) {
		if (statuses.get(slot) === CLIENT_GOAL) return;
		statuses.set(slot, status);
		if (status === CLIENT_GOAL) {
			broadcastText(`${aliasOf(slot)} (Team #${team + 1}) has completed their goal.`, { type: 'Goal', team, slot });
		}
	}

	function handleConnect(client, args) {
		if (!('password' in args) || !(typeof args.password === 'string' || args.password === null) || !('game' in args)) {
			send(client, [{ cmd: 'InvalidPacket', type: 'arguments', text: 'Connect', original_cmd: 'Connect' }]);
			return;
		}
		const tags = Array.isArray(args.tags) ? args.tags : [];
		const errors = new Set();
		if (roomPassword && args.password !== roomPassword) errors.add('InvalidPassword');
		const slot = names.get(args.name);
		if (slot === undefined) {
			errors.add('InvalidSlot');
		} else {
			const ignoreGame = !args.game && isNonGame(tags);
			if (!ignoreGame && args.game !== gameOf(slot)) errors.add('InvalidGame');
			if (!validItemsHandling(args.items_handling)) errors.add('InvalidItemsHandling');
		}
		if (errors.size > 0) {
			send(client, [{ cmd: 'ConnectionRefused', errors: [...errors] }]);
			return;
		}

		const rejoin = client.auth;
		const handling = args.items_handling;
		Object.assign(client, {
			auth: true, team, slot, tags, version: args.version,
			noLocations: isNonGame(tags),
			noText: tags.includes('NoText'),
			noItems: !(handling & 1),
			remoteItems: !!(handling & 2),
			remoteStart: !!(handling & 4),
			sendIndex: 0,
		});
		const done = checkedBy.get(slot);
		const connected = {
			cmd: 'Connected', team, slot,
			players: slotNumbers.map(n => ({ team, slot: n, alias: aliasOf(n), name: slots[n - 1].name, class: 'NetworkPlayer' })),
			missing_locations: [...locationsOf(slot)].filter(id => !done.has(id)),
			checked_locations: [...done],
			slot_info: Object.fromEntries(slotNumbers.map(n => [n, { name: slots[n - 1].name, game: gameOf(n), type: 1, group_members: [], class: 'NetworkSlot' }])),
			hint_points: 0,
		};
		// args.get("slot_data", True): asking for none is the only way not to get it.
		if (args.slot_data === undefined || args.slot_data) connected.slot_data = slotData[slot] ?? {};
		const reply = [connected];
		const full = itemsFor(client);
		if (full.length > 0 && !client.noItems) {
			reply.push({ cmd: 'ReceivedItems', index: 0, items: full });
			client.sendIndex = full.length;
		}
		send(client, reply);
		if (rejoin) return;
		broadcastText(
			`${aliasOf(slot)} (Team #${team + 1}) ${presenceVerb(tags, true)} ${gameOf(slot)} has joined. ` +
			`Client(${versionText(args.version)}), ${pyList(tags)}.`,
			{ type: 'Join', team, slot, tags });
		if (!client.noText) send(client, [{ cmd: 'PrintJSON', type: 'Tutorial', data: [{ text: TUTORIAL }] }]);
	}

	function handle(client, packet) {
		if (!packet || typeof packet.cmd !== 'string') return;
		if (packet.cmd === 'Connect') return handleConnect(client, packet);
		if (packet.cmd === 'GetDataPackage') return send(client, [{ cmd: 'DataPackage', data: { games: {} } }]);
		if (!client.auth) return;
		switch (packet.cmd) {
			case 'Sync': {
				const full = itemsFor(client);
				if (full.length > 0 && !client.noItems) {
					client.sendIndex = full.length;
					send(client, [{ cmd: 'ReceivedItems', index: 0, items: full }]);
				}
				return;
			}
			case 'LocationChecks':
				if (client.noLocations) {
					send(client, [{ cmd: 'InvalidPacket', type: 'cmd', text: "Trackers can't register new Location Checks", original_cmd: 'LocationChecks' }]);
					return;
				}
				register(client.slot, Array.isArray(packet.locations) ? packet.locations : []);
				return;
			case 'StatusUpdate':
				if (client.noLocations && packet.status === CLIENT_GOAL) {
					send(client, [{ cmd: 'InvalidPacket', type: 'cmd', text: "Trackers can't register Goal Complete", original_cmd: 'StatusUpdate' }]);
					return;
				}
				updateStatus(client.slot, packet.status);
				return;
			default:
				return;
		}
	}

	wss.on('connection', (socket) => {
		const client = { id: ++opened, socket, auth: false, slot: null, tags: [], sendIndex: 0 };
		clients.add(client);
		send(client, [{
			cmd: 'RoomInfo',
			version: { major: 0, minor: 6, build: 8, class: 'Version' },
			generator_version: { major: 0, minor: 6, build: 8, class: 'Version' },
			tags: ['AP'],
			password: !!roomPassword,
			games: [...new Set(slots.map(slot => slot.game))],
			datapackage_checksums: {},
			seed_name: seedName,
		}]);
		socket.on('message', (raw) => {
			let packets;
			try {
				packets = JSON.parse(raw.toString());
			} catch (_) {
				return;
			}
			for (const packet of Array.isArray(packets) ? packets : [packets]) {
				log.received.push(packet);
				handle(client, packet);
			}
		});
		socket.on('close', () => {
			clients.delete(client);
			if (!client.auth) return;
			broadcastText(
				`${aliasOf(client.slot)} (Team #${team + 1}) has ${presenceVerb(client.tags, false)} the game. ` +
				`Client(${versionText(client.version)}), ${pyList(client.tags)}.`,
				{ type: 'Part', team, slot: client.slot });
		});
	});

	return new Promise((resolve) => wss.on('listening', () => {
		const port = wss.address().port;
		resolve({
			wss,
			port,
			target: { kind: 'direct', host: '127.0.0.1', port },
			/** Every packet any client sent, in order. */
			received: log.received,
			/** Every frame the server sent: {to: socket number, packets}. */
			frames: log.frames,
			/** slot number -> the last client status reported (30 = goal) */
			statuses,
			get connectionsOpened() { return opened; },
			clientsOn: (slot) => [...clients].filter(client => client.auth && client.slot === slot),
			checkedOf: (slot) => new Set(checkedBy.get(slot)),
			/** Items as if another world sent them; each connected client gets them from its own index. */
			pushItems(slot, items) {
				for (const entry of items) receivedBy.get(slot).push(networkItem(entry.item, entry.location, entry.player, entry.flags));
				sendNewItems();
			},
			/** Items the server believes it sent to the slot's clients, as if their frame was lost. */
			loseItems(slot, items) {
				for (const entry of items) receivedBy.get(slot).push(networkItem(entry.item, entry.location, entry.player, entry.flags));
				for (const client of clients) {
					if (client.auth && client.slot === slot && !client.noItems) client.sendIndex = itemsFor(client).length;
				}
			},
			/** Checks registered by another client of the slot, as a person's own game client would. */
			checkFromElsewhere: (slot, ids) => register(slot, ids),
			/** One frame to every authenticated client of `slot`, or to every socket without one. */
			sendFrame,
			sendPacket: (packet, where = {}) => sendFrame([packet], where),
			setPassword(value) { roomPassword = value || null; },
			close() {
				return new Promise((done) => {
					for (const socket of wss.clients) socket.terminate();
					wss.close(() => done());
				});
			},
		});
	}));
}

/**
 * A bare protocol client standing in for a person's own game client: it sends one Connect when
 * RoomInfo arrives and resolves once the server has answered it.
 * @returns {Promise<{socket: WebSocket, packets: object[], close: () => Promise<void>}>}
 */
function connectRaw(port, connect) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		const packets = [];
		let settled = false;
		const close = () => new Promise((done) => {
			if (socket.readyState === WebSocket.CLOSED) return done();
			socket.once('close', () => done());
			socket.close();
		});
		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err) reject(err);
			else resolve({ socket, packets, close });
		};
		const timer = setTimeout(() => finish(new Error('the server never answered Connect')), 5000);
		socket.on('message', (raw) => {
			for (const packet of JSON.parse(raw.toString())) {
				packets.push(packet);
				if (packet.cmd === 'RoomInfo') {
					socket.send(JSON.stringify([{
						cmd: 'Connect', password: null, uuid: `raw-${Date.now()}`,
						version: { class: 'Version', major: 0, minor: 6, build: 1 },
						items_handling: 7, tags: ['AP'], slot_data: false, ...connect,
					}]));
				}
				if (packet.cmd === 'Connected' || packet.cmd === 'ConnectionRefused') finish();
			}
		});
		socket.on('error', finish);
	});
}

module.exports = { startApMediaServer, connectRaw, pyList };
