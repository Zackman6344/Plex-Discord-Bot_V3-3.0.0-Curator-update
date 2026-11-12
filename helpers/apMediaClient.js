// helpers/apMediaClient.js
// The Plex Media game client: one connection per bound slot that receives the slot's items and
// sends its location checks and its goal.
//
// It is the observer client (helpers/archipelagoClient.js) with the connection core unchanged (the
// room URL re-resolved on every attempt, wss to ws fallback, backoff, ping watchdog, a refusal is
// fatal) and the hooks that make it a game client. The server refuses checks and the goal from
// Tracker, TextOnly and HintGame clients, so its tags carry none of those. 'NoText' keeps the
// room's chat and item feed off this socket, since the watch on the same room relays it already,
// and 'PlexMediaBot' lets that watch recognise this client's join and leave lines as the bot's own.
// It never loads a data package: it never shows a name.
//
// Packets are handled one at a time on the base's queue, and everything here runs synchronously
// inside it. Listeners get plain events and must not hold the queue either: helpers/apMediaGame.js
// does its Plex and Discord work outside.
//
// The inventory: the server puts the first ReceivedItems (index 0, the whole list) in the same
// frame as Connected, and sends none at all to a slot that holds nothing (MultiServer.py
// process_client_cmd, Connect). So the list is reset on Connected and is known once that frame has
// been handled, and exactly one 'items' event follows every 'connected', an empty one for an empty
// slot. A listener never has to guess whether more is on the way.
//
// Events:
//   'connected' {seedName, team, slot, slotId, slotData, checked: Set, missing: Set}
//   'items'     {items, added}   NetworkItem objects; start inventory has location -2
//   'checked'   {ids}            locations the server now reports checked
//   'invalid'   {packet}         the server rejected something this client sent
//   'orphaned'  {reason}         resolveWatch() found no watch; the client has stopped
//   'fatal' {reason, errors} and 'status' {state, detail} come from ArchipelagoClient.

const WebSocket = require('ws');
const logger = require('./logger.js');
const { ArchipelagoClient, CLIENT_VERSION } = require('./archipelagoClient.js');
const { GAME, CLIENT_TAGS, ITEMS_HANDLING, CLIENT_GOAL } = require('./apMediaContracts.js');

// Ids reach sendChecks from stores and slot_data, where one can turn up as a string, and the server
// matches ints only: a "1347000005" in LocationChecks is dropped without a word.
function uniqueIds(values) {
	const out = new Set();
	for (const value of values || []) {
		const id = Number(value);
		if (Number.isSafeInteger(id) && id > 0) out.add(id);
	}
	return [...out];
}

function sameItem(a, b) {
	return !!a && !!b && a.item === b.item && a.location === b.location && a.player === b.player && a.flags === b.flags;
}

function startsWith(list, prefix) {
	if (prefix.length > list.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!sameItem(list[i], prefix[i])) return false;
	}
	return true;
}

class ApMediaClient extends ArchipelagoClient {
	/**
	 * @param {object} options
	 * @param {string} options.slot  the slot name as the room spells it: the server matches it exactly
	 * @param {string} [options.label]  name used in log lines
	 * @param {() => ({target: object, password: (string|null)}|null)} [options.resolveWatch]  read
	 *   before every connection attempt, `target` being a parseTarget() result; null stops the client
	 *   and emits 'orphaned'
	 * @param {(seedName: string, slot: string) => boolean} [options.hasSlotData]  true when this seed's
	 *   slot_data for the slot is already held, so Connect does not ask for it again
	 * @param {object} [options.target]  a fixed room, for a client without resolveWatch
	 * @param {string} [options.password]
	 */
	constructor(options = {}) {
		super({
			target: options.target,
			slot: options.slot,
			password: options.password,
			label: options.label || `apmedia:${options.slot}`,
		});
		this._resolveWatch = typeof options.resolveWatch === 'function' ? options.resolveWatch : null;
		this._hasSlotData = typeof options.hasSlotData === 'function' ? options.hasSlotData : () => false;
		this.slotData = null;
		this.items = [];
		this.inventoryKnown = false;
		this.checkedLocations = new Set();
		this.missingLocations = new Set();
		// Numbers each Connected, so the end-of-frame settle of a connection that has since dropped
		// does nothing to the next one.
		this.connection = 0;
	}

	get tags() {
		return [...CLIENT_TAGS];
	}

	/** Connected with the socket open: the only state in which a check or the goal goes anywhere. */
	get isReady() {
		return !!(this.connected && this.socket && this.socket.readyState === WebSocket.OPEN);
	}

	wantsDataPackages() {
		return false;
	}

	subscribeRoomState() {}

	refreshTarget() {
		if (!this._resolveWatch) return;
		const next = this._resolveWatch();
		if (!next || !next.target) {
			this.stop();
			this.emit('orphaned', { reason: 'orphaned' });
			return;
		}
		this.target = next.target;
		this.password = next.password || null;
	}

	connectPacket() {
		return {
			cmd: 'Connect',
			game: GAME,
			name: this.slot,
			password: this.password,
			uuid: this.uuid,
			version: CLIENT_VERSION,
			items_handling: ITEMS_HANDLING,
			tags: this.tags,
			slot_data: !this._slotDataHeld(),
		};
	}

	// Without a seed name there is nothing to key a held copy on, so the server's is the only one.
	_slotDataHeld() {
		if (!this.seedName) return false;
		try {
			return !!this._hasSlotData(this.seedName, this.slot);
		} catch (err) {
			logger.warn(`[AP:${this.label}] could not tell whether slot_data is held: ${err.message || err}`);
			return false;
		}
	}

	async _handlePacket(packet) {
		if (!packet || !packet.cmd || this.stopped) return;
		switch (packet.cmd) {
			case 'Connected':
				// The base first: until it has run, `connected` is still false and team, slotId and
				// the slot maps describe the previous connection, so a check sent from a 'connected'
				// listener would go nowhere. Its 'status' listeners may have stopped or restarted
				// this client meanwhile, and then this connection is over before it began.
				await super._handlePacket(packet);
				if (this.stopped || !this.connected) return;
				this._afterConnected(packet);
				return;
			case 'ReceivedItems':
				this._absorbItems(packet);
				return;
			case 'RoomUpdate':
				this._absorbChecked(packet);
				return super._handlePacket(packet);
			case 'InvalidPacket':
				this._handleInvalid(packet);
				return;
			default:
				return super._handlePacket(packet);
		}
	}

	_afterConnected(packet) {
		this.slotData = packet.slot_data && typeof packet.slot_data === 'object' ? packet.slot_data : null;
		this.checkedLocations = new Set(uniqueIds(packet.checked_locations));
		this.missingLocations = new Set(uniqueIds(packet.missing_locations));
		this.items = [];
		this.inventoryKnown = false;
		const connection = ++this.connection;
		this.emit('connected', {
			seedName: this.seedName,
			team: this.team,
			slot: this.slot,
			slotId: this.slotId,
			slotData: this.slotData,
			checked: new Set(this.checkedLocations),
			missing: new Set(this.missingLocations),
		});
		// The socket queues a frame's packets all at once, before the first of them runs, so this
		// lands after the ReceivedItems that shared Connected's frame, if there was one.
		this.queue = this.queue
			.then(() => this._settleInventory(connection))
			.catch(err => logger.error(`[AP:${this.label}] inventory settle threw:`, err.message || err));
	}

	_settleInventory(connection) {
		if (this.stopped || connection !== this.connection || this.inventoryKnown) return;
		this.inventoryKnown = true;
		this.emit('items', { items: this.items, added: [] });
	}

	// The stock client's rule (CommonClient.py, ReceivedItems): index 0 is the whole list again, an
	// index equal to what is held appends, and anything else means something was missed, which Sync
	// repairs: the server answers it with the whole list at index 0.
	_absorbItems(packet) {
		const index = Number(packet.index);
		const incoming = Array.isArray(packet.items) ? packet.items : [];
		let added;
		if (index === 0) {
			const previous = this.items;
			this.items = incoming.slice();
			added = startsWith(this.items, previous) ? this.items.slice(previous.length) : this.items.slice();
		} else if (index === this.items.length) {
			added = incoming.slice();
			this.items = this.items.concat(added);
		} else {
			logger.debug(`[AP:${this.label}] items from index ${packet.index} with ${this.items.length} held; asking for a Sync`);
			this._send({ cmd: 'Sync' });
			return;
		}
		this.inventoryKnown = true;
		this.emit('items', { items: this.items, added });
	}

	_absorbChecked(packet) {
		if (!Array.isArray(packet.checked_locations)) return;
		const ids = uniqueIds(packet.checked_locations);
		if (ids.length === 0) return;
		for (const id of ids) {
			this.checkedLocations.add(id);
			this.missingLocations.delete(id);
		}
		this.emit('checked', { ids });
	}

	// The base drops InvalidPacket without a word, which would hide the one failure a game client
	// must see: a check or a goal the server did not take.
	_handleInvalid(packet) {
		const text = this._redact(packet.text);
		logger.warn(`[AP:${this.label}] the server rejected ${packet.original_cmd || 'a packet'} ` +
			`(${packet.type || 'unknown'}): ${text.slice(0, 300)}`);
		this.emit('invalid', { packet: { ...packet, text } });
	}

	// The server quotes a malformed packet back in its text, and a Connect carries the room password.
	_redact(text) {
		const value = String(text ?? '');
		return this.password ? value.split(this.password).join('***') : value;
	}

	/**
	 * Send location checks. Safe to repeat: the server ignores a location already checked.
	 * @param {Iterable<number|string>} ids
	 * @returns {boolean} false when not connected, and nothing went out
	 */
	sendChecks(ids) {
		if (!this.isReady) return false;
		const locations = uniqueIds(ids);
		if (locations.length === 0) return true;
		return this._sendNow({ cmd: 'LocationChecks', locations });
	}

	/**
	 * Report the slot's goal. Safe to repeat: the server keeps a goal once reached.
	 * @returns {boolean} false when not connected, and nothing went out
	 */
	sendGoal() {
		return this._sendNow({ cmd: 'StatusUpdate', status: CLIENT_GOAL });
	}

	// The base _send drops a packet silently when the socket is down; a caller holding pending checks
	// needs to know whether this one went.
	_sendNow(packet) {
		if (!this.isReady) return false;
		try {
			this.socket.send(JSON.stringify([packet]));
			return true;
		} catch (err) {
			logger.warn(`[AP:${this.label}] send failed:`, err.message || err);
			return false;
		}
	}

	// EventEmitter lets a listener's throw out of emit() into the code that emitted: the packet
	// queue, the socket's handlers, the backoff timer. The base emits 'status' just before this
	// class's Connected handling and just before it dials or schedules a reconnect, so one faulty
	// listener could cost a connection its 'connected' and 'items' events, or strand the client
	// with no socket and no retry. 'error' keeps EventEmitter's own rule.
	emit(event, ...args) {
		if (event === 'error') return super.emit(event, ...args);
		try {
			return super.emit(event, ...args);
		} catch (err) {
			logger.error(`[AP:${this.label}] a '${String(event)}' listener threw:`, err.message || err);
			return true;
		}
	}
}

module.exports = { ApMediaClient };
