// helpers/archipelagoClient.js
//
// One read-only connection to an Archipelago multiworld server, speaking the AP network
// protocol over a WebSocket.
//
// Why a socket instead of scraping the room's log page: archipelago.gg gates
// /log/<room> behind the room owner's browser session (the Flask route checks
// room.owner == session["_id"] and 403s otherwise), so scraping needs a cookie that
// expires and only ever works for rooms you own. The protocol's own observer mode has
// none of those problems, arrives in real time, works the same against a self-hosted
// server, and hands over structured packets instead of pre-rendered text.
//
// The connection is deliberately inert: `items_handling: 0` and a Tracker tag tell the
// server this client never receives items and never checks locations, so attaching to a
// slot cannot disturb the person actually playing it (AP allows many clients per slot —
// that is how the standard text client rides along).
//
// Two things this does that are visible to other players: the room sees a client join on
// whatever slot is being watched, and holding the socket open stops a hosted room from
// idling to sleep.
//
// Events emitted:
//   'line'    { type, group, text, flags, packet }  — one rendered log line
//   'status'  { state, detail }                     — connecting/connected/disconnected/error
//   'statuses'{ goaled }                            — goal statuses read back from the server
//   'fatal'   { reason }                            — connect refused; no point retrying

const EventEmitter = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const logger = require('./logger.js');
const dataCache = require('./archipelagoData.js');

// Claimed protocol version. Servers refuse clients *older* than their minimum and have no
// upper bound, so tracking a recent release is the safe direction to be wrong in.
const CLIENT_VERSION = { class: 'Version', major: 0, minor: 6, build: 1 };
const DEFAULT_PORT = 38281;
const PING_INTERVAL_MS = 30000;
const RECONNECT_DELAYS_MS = [5000, 10000, 20000, 40000, 80000, 160000, 300000];
const USER_AGENT = 'PlexDiscordBot-ArchipelagoMonitor/1.0';

// NetworkItem.flags — used for the progression-only filter and for colouring.
const ITEM_FLAG_PROGRESSION = 0b001;
const ITEM_FLAG_USEFUL = 0b010;
const ITEM_FLAG_TRAP = 0b100;

// ClientStatus.CLIENT_GOAL. A slot reporting this has finished; items still arriving for it are
// noise, which is what the skip-goaled filter exists to drop.
const CLIENT_STATUS_GOAL = 30;

// Discord renders a subset of ANSI inside a ```ansi block. The mapping follows Archipelago's
// own clients so the colours mean the same thing here as in the game's text client.
const ANSI = {
    reset: '\u001b[0m',
    progression: '\u001b[0;35m', // magenta
    useful: '\u001b[0;34m',      // blue
    trap: '\u001b[0;31m',        // red
    filler: '\u001b[0;36m'       // cyan
};

// Discord renders ANSI code blocks on desktop and web, and not in the mobile apps, where the
// same message arrives as plain uncoloured text. These markers carry the class independently of
// any of that, so a phone reader sees what a desktop reader sees. Filler is deliberately left
// unmarked: most sends are filler, and marking them all would be noise rather than signal.
const MARKERS = {
    progression: '🟪',
    useful: '🟦',
    trap: '🟥',
    filler: ''
};

// Colour is only legible inside a ```ansi fence. Anything rendered outside one — a ping, an
// embed field — has to have the escapes taken back out or they show as literal garbage.
function stripAnsi(text) {
    return String(text === null || text === undefined ? '' : text).replace(/\u001b\[[0-9;]*m/g, '');
}

/** Which of the four item classes a NetworkItem.flags value describes. */
function classifyItem(flags) {
    const value = Number(flags) || 0;
    if (value & ITEM_FLAG_TRAP) return 'trap';
    if (value & ITEM_FLAG_PROGRESSION) return 'progression';
    if (value & ITEM_FLAG_USEFUL) return 'useful';
    return 'filler';
}

// PrintJSON types collapsed into the handful of switches a Discord channel actually
// wants to toggle. Anything the protocol adds later lands in 'misc' rather than vanishing.
const CATEGORY_GROUPS = {
    items:  ['ItemSend', 'ItemCheat'],
    hints:  ['Hint'],
    chat:   ['Chat', 'ServerChat'],
    joins:  ['Join', 'Part', 'TagsChanged'],
    goals:  ['Goal', 'Release', 'Collect'],
    deaths: ['DeathLink'],
    misc:   ['Countdown', 'Tutorial', 'CommandResult', 'AdminCommandResult', 'Text']
};

const TYPE_TO_GROUP = {};
for (const [group, types] of Object.entries(CATEGORY_GROUPS)) {
    for (const type of types) TYPE_TO_GROUP[type] = group;
}

function groupOf(type) {
    return TYPE_TO_GROUP[type] || 'misc';
}

/**
 * Turn user input into a connection target.
 * Accepts a room URL (port resolved later, since it changes every time the room restarts),
 * a host:port pair, or a bare host (assumes the default AP port).
 * @returns {{kind: 'room', roomUrl: string} | {kind: 'direct', host: string, port: number} | null}
 */
function parseTarget(input) {
    const text = String(input || '').trim().replace(/^<|>$/g, '');
    if (!text) return null;

    const room = text.match(/^(?:https?:\/\/)?([A-Za-z0-9.\-]+\.[A-Za-z]{2,}|localhost)(?::\d{1,5})?\/room\/([A-Za-z0-9_-]{8,64})\/?$/i);
    if (room) {
        return { kind: 'room', roomUrl: `https://${room[1]}/room/${room[2]}` };
    }

    const bare = text.replace(/^[A-Za-z]+:\/\//, '').replace(/\/+$/, '');
    const hostPort = bare.match(/^([A-Za-z0-9.\-_]+):(\d{1,5})$/);
    if (hostPort) {
        const port = Number(hostPort[2]);
        if (port < 1 || port > 65535) return null;
        return { kind: 'direct', host: hostPort[1], port };
    }
    if (/^[A-Za-z0-9.\-_]+$/.test(bare) && /[A-Za-z]/.test(bare)) {
        return { kind: 'direct', host: bare, port: DEFAULT_PORT };
    }
    return null;
}

// The room page renders the address as: '/connect archipelago.gg:38281'
function extractConnectAddress(html) {
    const match = String(html || '').match(/\/connect\s+([A-Za-z0-9.\-_]+):(\d{2,5})/);
    if (!match) return null;
    return { host: match[1], port: Number(match[2]) };
}

/**
 * Fetch a room page to learn the port its server is currently listening on.
 * Hosted rooms are assigned a new port each time they spin up, so this has to run on
 * every connection attempt rather than once at setup. Requesting the page is also what
 * wakes a room the web host has paused for inactivity — the same thing a player does by
 * refreshing it.
 */
async function resolveRoomAddress(roomUrl) {
    const res = await fetch(roomUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`room page returned HTTP ${res.status}`);

    const html = await res.text();
    const address = extractConnectAddress(html);
    if (address) return address;

    if (/error hosting this Room/i.test(html)) {
        throw new Error('the web host reported an error starting this room');
    }
    throw new Error('no connect address on the room page — the room may have expired');
}

// Each part carries its own flags, so an item is marked by what that item is rather than by
// whatever the packet's headline item happened to be.
function paint(text, part, options) {
    if (typeof part.flags !== 'number') return text;
    const kind = classifyItem(part.flags);
    const marked = options.markers && MARKERS[kind] ? `${MARKERS[kind]} ${text}` : text;
    return options.ansi ? `${ANSI[kind]}${marked}${ANSI.reset}` : marked;
}

function renderPart(part, tables, options) {
    const raw = (part && part.text !== undefined && part.text !== null) ? String(part.text) : '';
    if (!part || !part.type) return raw;

    switch (part.type) {
        case 'player_id': {
            const slot = Number(raw);
            const name = tables.playerName && tables.playerName(slot);
            return name || `Player#${raw}`;
        }
        case 'item_id': {
            const game = tables.gameForSlot && tables.gameForSlot(Number(part.player));
            const name = tables.itemName && tables.itemName(game, Number(raw));
            return paint(name || `Item#${raw}`, part, options);
        }
        case 'item_name':
            return paint(raw, part, options);
        case 'location_id': {
            const game = tables.gameForSlot && tables.gameForSlot(Number(part.player));
            const name = tables.locationName && tables.locationName(game, Number(raw));
            return name || `Location#${raw}`;
        }
        default:
            return raw;
    }
}

/**
 * Render a PrintJSON packet into a single log line.
 * The server already composes the sentence — the parts list is a pre-split message where
 * ids stand in for names — so rendering is a concatenation plus id lookups.
 * @param {Object} packet
 * @param {Object} tables lookup callbacks: playerName(slot), gameForSlot(slot), itemName(game,id), locationName(game,id)
 */
function renderPrintJSON(packet, tables = {}, options = {}) {
    const parts = Array.isArray(packet && packet.data) ? packet.data : [];
    const type = (packet && packet.type) || 'Text';
    const flags = packet && packet.item && typeof packet.item.flags === 'number' ? packet.item.flags : 0;
    const render = { ansi: !!options.ansi, markers: !!options.markers };
    return {
        type,
        group: groupOf(type),
        flags,
        itemClass: classifyItem(flags),
        text: parts.map(part => renderPart(part, tables, render)).join('').trim()
    };
}

class ArchipelagoClient extends EventEmitter {
    /**
     * @param {Object} options
     * @param {Object} options.target   parseTarget() result
     * @param {string} options.slot     an existing slot name in the multiworld to observe from
     * @param {string} [options.password]
     * @param {boolean} [options.deathlink] request DeathLink broadcasts (adds the tag the server routes them by)
     * @param {string} [options.label]  name used in log lines
     */
    constructor(options = {}) {
        super();
        this.target = options.target;
        this.slot = options.slot;
        this.password = options.password || null;
        this.deathlink = !!options.deathlink;
        this.label = options.label || options.slot || 'archipelago';
        this.uuid = crypto.randomUUID();

        this.socket = null;
        this.stopped = false;
        this.connected = false;
        this.address = null;
        // RoomInfo.seed_name. Stable for the life of a multiworld and unique across them, which
        // makes it the only durable way to say "this person's game in this room" once the watch
        // that saw it is gone.
        this.seedName = null;
        this.attempt = 0;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.awaitingPong = false;
        // Remembered so a self-hosted plain-ws server isn't made to fail a TLS handshake
        // on every single reconnect.
        this.preferredScheme = 'wss';
        // Packet handling touches the disk (data package cache), so packets are chained
        // rather than fired off in parallel — order matters for the name tables.
        this.queue = Promise.resolve();

        this.players = new Map();
        // Display names, which is players-with-aliases-applied. Kept apart from `players`
        // because an alias can be changed mid-game and slot claims are keyed on the name the
        // seed was rolled with — matching claims against a display name would silently unclaim
        // anyone who set one.
        this.slotNames = new Map();
        this.slotGames = new Map();
        this.itemNames = new Map();
        this.locationNames = new Map();
        this.pendingChecksums = {};

        // Slots that are done with, as "team:slot". Goals are rebuilt from the server on every
        // connect, because a watch outlives its socket and a hosted room restarts often.
        this.goaled = new Set();
        // Releases are only ever announced, never stored anywhere readable, so this set is
        // built from what the socket hears and deliberately survives a reconnect. A release
        // seen before the bot first connected is invisible; a goal is not.
        this.released = new Set();
        // Slots whose locations are all checked. Not knowable over the socket at all, so the
        // monitor fills this from the room's tracker page. See helpers/archipelagoTracker.js.
        this.fullyChecked = new Set();
        this.team = 0;
        // Flipped per watch by the monitor; read at render time so a colour toggle costs no
        // reconnect.
        this.colorize = !!options.colorize;
        // Same idea as colorize: read at render time, so the toggle costs no reconnect.
        this.markers = options.markers !== false;
    }

    /**
     * The unchanging slot name for a slot number, or undefined before the room has been read.
     * Defaults to the team this connection is on, which is the only one anything here acts for.
     */
    slotNameFor(slotId, team = this.team) {
        return this.slotNames.get(`${team}:${Number(slotId)}`);
    }

    /**
     * The room's own spelling of a slot name on this team, matched case-insensitively.
     * Lets someone claim `zackword` and have the claim stored as `ZackWord`, so the ping and the
     * room agree on the name.
     * @returns {string|null} null if the team has no such slot, or the room is not read yet
     */
    canonicalSlotName(input, team = this.team) {
        const wanted = String(input || '').trim().toLowerCase();
        if (!wanted) return null;
        const prefix = `${team}:`;
        for (const [key, name] of this.slotNames) {
            if (key.startsWith(prefix) && name.toLowerCase() === wanted) return name;
        }
        return null;
    }

    hasGoaled(slot, team = this.team) {
        return this.goaled.has(`${team}:${slot}`);
    }

    hasReleased(slot, team = this.team) {
        return this.released.has(`${team}:${slot}`);
    }

    hasFullyChecked(slot, team = this.team) {
        return this.fullyChecked.has(`${team}:${slot}`);
    }

    /**
     * Is this join/part/tags broadcast about this very connection?
     * The room announces every client that attaches to a slot, so each reconnect produces
     * "<slot> tracking <game> has joined ... ['Tracker']" — the bot narrating itself. The real
     * player shares the slot but not the tags, so the tag list is what separates them.
     */
    isSelfPresence(packet) {
        if (!packet || !['Join', 'Part', 'TagsChanged'].includes(packet.type)) return false;
        if (packet.slot !== this.slotId) return false;
        if (!Array.isArray(packet.tags)) return false;
        return this.tags.every(tag => packet.tags.includes(tag)) && packet.tags.includes('Tracker');
    }

    /**
     * Is the server talking to this connection rather than reporting room activity?
     *
     * Two kinds, both of which were reaching the channel:
     *  - the join/part/tags broadcast for this very client
     *  - `Tutorial`, which the server sends to a client the instant it connects ("Now that you
     *    are connected, you can use !help ..."). It goes to that one client, so relaying it
     *    republished the bot's own welcome text on every reconnect. A hosted room cycles every
     *    couple of hours, which is exactly how often it turned up.
     */
    isSelfDirected(packet) {
        if (!packet) return false;
        if (packet.type === 'Tutorial') return true;
        return this.isSelfPresence(packet);
    }

    /** Done with, however it happened: nothing sent to this slot from here on matters. */
    hasFinished(slot, team = this.team) {
        return this.hasGoaled(slot, team) || this.hasReleased(slot, team) || this.hasFullyChecked(slot, team);
    }

    get finishedCount() {
        return new Set([...this.goaled, ...this.released, ...this.fullyChecked]).size;
    }

    get tags() {
        return this.deathlink ? ['Tracker', 'DeathLink'] : ['Tracker'];
    }

    lookupTables() {
        return {
            playerName: (slot) => this.players.get(`${this.team}:${slot}`),
            gameForSlot: (slot) => this.slotGames.get(slot),
            itemName: (game, id) => {
                const table = this.itemNames.get(game);
                return table && table.get(id);
            },
            locationName: (game, id) => {
                const table = this.locationNames.get(game);
                return table && table.get(id);
            }
        };
    }

    start() {
        this.stopped = false;
        this.attempt = 0;
        this._open();
    }

    stop() {
        this.stopped = true;
        this._clearTimers();
        if (this.socket) {
            try { this.socket.close(); } catch (_) {}
            try { this.socket.removeAllListeners(); } catch (_) {}
            // A socket closed while its handshake is still in flight emits one more 'error', and
            // an EventEmitter with no 'error' listener rethrows it as an uncaught exception.
            // Stopping a watch mid-connect is routine: `!ap retry`, a password change, and the
            // /config wizard all rebuild the client, sometimes before the previous one is up.
            try { this.socket.on('error', () => {}); } catch (_) {}
            this.socket = null;
        }
        this.connected = false;
    }

    _clearTimers() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.reconnectTimer = null;
        this.pingTimer = null;
    }

    _scheduleReconnect(detail) {
        if (this.stopped) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
        this.attempt++;
        logger.debug(`[AP:${this.label}] reconnecting in ${delay / 1000}s — ${detail || 'connection lost'}`);
        this.reconnectTimer = setTimeout(() => this._open(), delay);
    }

    /**
     * Is a failure right now just the room waking up?
     *
     * Requesting a paused room's page is what starts it, and the port is not listening for a
     * few seconds afterwards, so the first attempt of a fresh sequence against a room URL fails
     * as a matter of course. archipelago.gg cycles a room every couple of hours, which made that
     * a recurring warning for something entirely routine. The second attempt onwards is a real
     * problem and still warns.
     *
     * Only room URLs get this: a host:port has no wake-up step, so a failure there means what it
     * says the first time.
     */
    isWakingRoom() {
        return this.attempt === 0 && !!this.target && this.target.kind === 'room';
    }

    async _resolveAddress() {
        if (this.target && this.target.kind === 'room') return resolveRoomAddress(this.target.roomUrl);
        if (this.target && this.target.kind === 'direct') return { host: this.target.host, port: this.target.port };
        throw new Error('no server address configured');
    }

    async _open() {
        if (this.stopped) return;

        let address;
        try {
            address = await this._resolveAddress();
        } catch (err) {
            this.emit('status', { state: 'error', detail: err.message, expected: this.isWakingRoom() });
            this._scheduleReconnect(err.message);
            return;
        }

        this.address = `${address.host}:${address.port}`;
        this.emit('status', { state: 'connecting', detail: this.address });
        this._connectSocket(this.preferredScheme, address);
    }

    // archipelago.gg terminates TLS on the game port; most self-hosted servers don't. The
    // official clients solve this the same way — try one scheme, fall back to the other
    // before treating the attempt as failed.
    _connectSocket(scheme, address) {
        if (this.stopped) return;

        const url = `${scheme}://${address.host}:${address.port}`;
        let socket;
        try {
            socket = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 128 * 1024 * 1024 });
        } catch (err) {
            this._handleOpenFailure(scheme, address, err.message);
            return;
        }

        this.socket = socket;
        let opened = false;

        socket.on('open', () => {
            opened = true;
            this.preferredScheme = scheme;
            this.awaitingPong = false;
            this.pingTimer = setInterval(() => {
                if (this.awaitingPong) {
                    logger.debug(`[AP:${this.label}] no pong — dropping a stale socket`);
                    try { socket.terminate(); } catch (_) {}
                    return;
                }
                this.awaitingPong = true;
                try { socket.ping(); } catch (_) {}
            }, PING_INTERVAL_MS);
        });

        socket.on('pong', () => { this.awaitingPong = false; });

        socket.on('message', (raw) => {
            let packets;
            try {
                packets = JSON.parse(raw.toString());
            } catch (err) {
                logger.warn(`[AP:${this.label}] unparseable packet:`, err.message);
                return;
            }
            if (!Array.isArray(packets)) packets = [packets];
            for (const packet of packets) {
                this.queue = this.queue.then(() => this._handlePacket(packet)).catch(err => {
                    logger.error(`[AP:${this.label}] packet handler threw:`, err.message || err);
                });
            }
        });

        socket.on('error', (err) => {
            if (!opened) return; // the close handler runs the scheme fallback
            logger.debug(`[AP:${this.label}] socket error:`, err.message);
        });

        socket.on('close', (code, reason) => {
            this._clearTimers();
            if (this.socket === socket) this.socket = null;

            if (!opened) {
                this._handleOpenFailure(scheme, address, `${scheme} handshake failed`);
                return;
            }

            const wasConnected = this.connected;
            this.connected = false;
            if (this.stopped) return;

            const detail = reason && reason.length ? reason.toString() : `closed (${code})`;
            if (wasConnected) this.emit('status', { state: 'disconnected', detail });
            this._scheduleReconnect(detail);
        });
    }

    _handleOpenFailure(scheme, address, detail) {
        if (this.stopped) return;
        if (scheme === 'wss') {
            this.preferredScheme = 'ws';
            this._connectSocket('ws', address);
            return;
        }
        // Both schemes are out; if wss was skipped this pass, put it back in rotation so a
        // server that later gains TLS isn't stuck on plaintext forever.
        this.preferredScheme = 'wss';
        this.emit('status', {
            state: 'error',
            detail: `cannot reach ${address.host}:${address.port}`,
            expected: this.isWakingRoom()
        });
        this._scheduleReconnect(detail);
    }

    _send(packet) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        try {
            this.socket.send(JSON.stringify([packet]));
        } catch (err) {
            logger.warn(`[AP:${this.label}] send failed:`, err.message);
        }
    }

    async _handlePacket(packet) {
        if (!packet || !packet.cmd) return;

        switch (packet.cmd) {
            case 'RoomInfo':
                await this._handleRoomInfo(packet);
                break;
            case 'DataPackage':
                await this._handleDataPackage(packet);
                break;
            case 'Connected':
                this._handleConnected(packet);
                break;
            case 'ConnectionRefused':
                this._handleRefused(packet);
                break;
            case 'PrintJSON': {
                if (typeof packet.slot === 'number') {
                    const id = `${packet.team || 0}:${packet.slot}`;
                    if (packet.type === 'Goal') this.goaled.add(id);
                    // Releasing hands out everything the slot was still holding, so it is as
                    // done as a goal even when the player never finished.
                    if (packet.type === 'Release') this.released.add(id);
                }
                const line = renderPrintJSON(packet, this.lookupTables(), { ansi: this.colorize, markers: this.markers });
                if (line.text) {
                    const receiving = typeof packet.receiving === 'number' ? packet.receiving : null;
                    this.emit('line', {
                        ...line,
                        receiving,
                        recipientFinished: receiving !== null && this.hasFinished(receiving),
                        self: this.isSelfDirected(packet),
                        packet
                    });
                }
                break;
            }
            case 'Retrieved':
                this._absorbStatuses(packet.keys || {});
                break;
            case 'SetReply':
                if (packet.key) this._absorbStatuses({ [packet.key]: packet.value });
                break;
            case 'RoomUpdate':
                this._absorbPlayers(packet);
                break;
            case 'Bounced':
                this._handleBounced(packet);
                break;
            default:
                break;
        }
    }

    async _handleRoomInfo(packet) {
        this.pendingChecksums = packet.datapackage_checksums || {};
        // Assigned unconditionally. Keeping the previous value when a server sends none let a
        // re-pointed watch carry the old multiworld's goal key into a different room.
        this.seedName = packet.seed_name ? String(packet.seed_name) : null;

        const missing = [];
        for (const game of packet.games || []) {
            const checksum = this.pendingChecksums[game];
            const cached = await dataCache.load(game, checksum);
            if (cached) {
                this.itemNames.set(game, cached.items);
                this.locationNames.set(game, cached.locations);
            } else {
                missing.push(game);
            }
        }

        if (missing.length > 0) {
            logger.debug(`[AP:${this.label}] fetching data packages for ${missing.length} game(s)`);
            this._send({ cmd: 'GetDataPackage', games: missing });
        }

        this._send({
            cmd: 'Connect',
            game: '',
            name: this.slot,
            password: this.password,
            uuid: this.uuid,
            version: CLIENT_VERSION,
            items_handling: 0,
            tags: this.tags,
            slot_data: false
        });
    }

    async _handleDataPackage(packet) {
        const games = (packet.data && packet.data.games) || {};
        for (const [game, gameData] of Object.entries(games)) {
            this.itemNames.set(game, dataCache.invert(gameData.item_name_to_id));
            this.locationNames.set(game, dataCache.invert(gameData.location_name_to_id));
            await dataCache.save(game, gameData.checksum || this.pendingChecksums[game], gameData);
        }
    }

    /** Slot numbers on one team, in the order the room reported them. */
    slotsOnTeam(team = this.team) {
        const prefix = `${team}:`;
        const slots = [];
        for (const key of this.slotNames.keys()) {
            if (key.startsWith(prefix)) slots.push(Number(key.slice(prefix.length)));
        }
        return slots;
    }

    _absorbPlayers(packet) {
        for (const player of packet.players || []) {
            // Keyed by team like slotNames below, and for the same reason: slot numbers repeat
            // across teams, so a flat key let team 1's entry overwrite team 0's and every relayed
            // line naming that slot rendered the wrong player.
            this.players.set(`${player.team || 0}:${player.slot}`, player.alias || player.name);
            // player.name is the slot name the seed was rolled with and never changes; the alias
            // above is display-only and does.
            //
            // Keyed by team as well as slot, matching how goaled/released/fullyChecked are keyed.
            // Slot numbers repeat across teams, so a flat key let team 1's name overwrite team 0's
            // and a goal from either was credited to whoever claimed the surviving name.
            if (player.name) this.slotNames.set(`${player.team || 0}:${player.slot}`, player.name);
        }
        for (const [slot, info] of Object.entries(packet.slot_info || {})) {
            this.slotGames.set(Number(slot), info.game);
        }
    }

    // Goal status lives in the server's data storage under a read-only key per slot. Reading it
    // at connect is what makes the skip-goaled filter work for players who finished before the
    // bot joined, or before its last reconnect; SetNotify keeps it current afterwards.
    //
    // The key is requested under both spellings seen in the protocol docs. An unknown key is
    // answered with null rather than an error, so asking for both costs nothing and means a
    // wrong guess degrades to "nobody has goaled" instead of a silently dead filter.
    _statusKeys() {
        const keys = [];
        // This connection's own team only. Iterating every key would have asked for another
        // team's slot numbers under this team's prefix once the maps became team-keyed.
        for (const slot of this.slotsOnTeam()) {
            keys.push(`_read_client_status_${this.team}_${slot}`);
            keys.push(`client_status_${this.team}_${slot}`);
        }
        return keys;
    }

    _absorbStatuses(entries) {
        let sawStatus = false;
        for (const [key, value] of Object.entries(entries)) {
            const match = /client_status_(\d+)_(\d+)$/.exec(key);
            if (!match) continue;
            // A key the server does not have comes back null. Both spellings are requested, so
            // every slot answers once with a status and once with null; treating that null as
            // "not goaled" deleted the status that had just been read one key earlier.
            if (value === null || value === undefined) continue;
            const id = `${Number(match[1])}:${Number(match[2])}`;
            sawStatus = true;
            if (Number(value) === CLIENT_STATUS_GOAL) this.goaled.add(id);
            else this.goaled.delete(id);
        }
        // The goal set is only populated once this response lands, which is well after
        // 'connected'. Anything counting goals has to wait for this rather than for the socket.
        if (sawStatus) this.emit('statuses', { goaled: this.goaled });
    }

    _handleConnected(packet) {
        // Team first, so everything below is keyed and filtered against the right one.
        if (typeof packet.team === 'number') this.team = packet.team;
        // Connected is the room describing itself from scratch, and a reconnect may be to a
        // different multiworld entirely after a /config re-point. _absorbPlayers only ever sets,
        // so without this the old room's slot names would linger and canonicalSlotName would
        // "verify" claims against slots that no longer exist.
        this.players.clear();
        this.slotNames.clear();
        this.slotGames.clear();
        this._absorbPlayers(packet);
        // Numeric slot, as opposed to this.slot which is the name given in config. Needed to
        // recognise the room's join broadcast for this very connection.
        if (typeof packet.slot === 'number') this.slotId = packet.slot;
        this.connected = true;
        this.attempt = 0;

        this.goaled.clear();
        const keys = this._statusKeys();
        if (keys.length > 0) {
            this._send({ cmd: 'Get', keys });
            this._send({ cmd: 'SetNotify', keys });
        }

        this.emit('status', { state: 'connected', detail: this.address, slots: this.slotsOnTeam().length });
    }

    _handleRefused(packet) {
        const errors = Array.isArray(packet.errors) ? packet.errors : [];
        const reason = errors.length ? errors.join(', ') : 'connection refused';
        this.stopped = true;
        this._clearTimers();
        if (this.socket) {
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
        }
        this.emit('fatal', { reason, errors });
    }

    // DeathLink rides on Bounce packets rather than PrintJSON, so it needs its own
    // rendering to reach the feed as a log line.
    _handleBounced(packet) {
        const tags = packet.tags || [];
        const data = packet.data || {};
        if (!tags.includes('DeathLink')) return;

        const source = data.source || 'someone';
        const cause = data.cause ? String(data.cause) : `${source} died`;
        this.emit('line', { type: 'DeathLink', group: 'deaths', flags: 0, text: `💀 ${cause}`, packet });
    }
}

module.exports = {
    ArchipelagoClient,
    classifyItem,
    stripAnsi,
    ANSI,
    MARKERS,
    CLIENT_STATUS_GOAL,
    parseTarget,
    extractConnectAddress,
    resolveRoomAddress,
    renderPrintJSON,
    groupOf,
    CATEGORY_GROUPS,
    CLIENT_VERSION,
    DEFAULT_PORT,
    ITEM_FLAG_PROGRESSION,
    ITEM_FLAG_USEFUL,
    ITEM_FLAG_TRAP
};
