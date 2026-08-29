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

// NetworkItem.flags — used for the progression-only filter.
const ITEM_FLAG_PROGRESSION = 0b001;
const ITEM_FLAG_USEFUL = 0b010;
const ITEM_FLAG_TRAP = 0b100;

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

function renderPart(part, tables) {
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
            return name || `Item#${raw}`;
        }
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
function renderPrintJSON(packet, tables = {}) {
    const parts = Array.isArray(packet && packet.data) ? packet.data : [];
    const type = (packet && packet.type) || 'Text';
    const flags = packet && packet.item && typeof packet.item.flags === 'number' ? packet.item.flags : 0;
    return {
        type,
        group: groupOf(type),
        flags,
        text: parts.map(part => renderPart(part, tables)).join('').trim()
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
        this.slotGames = new Map();
        this.itemNames = new Map();
        this.locationNames = new Map();
        this.pendingChecksums = {};
    }

    get tags() {
        return this.deathlink ? ['Tracker', 'DeathLink'] : ['Tracker'];
    }

    lookupTables() {
        return {
            playerName: (slot) => this.players.get(slot),
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
            this.emit('status', { state: 'error', detail: err.message });
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
        this.emit('status', { state: 'error', detail: `cannot reach ${address.host}:${address.port}` });
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
                const line = renderPrintJSON(packet, this.lookupTables());
                if (line.text) this.emit('line', { ...line, packet });
                break;
            }
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

    _absorbPlayers(packet) {
        for (const player of packet.players || []) {
            this.players.set(player.slot, player.alias || player.name);
        }
        for (const [slot, info] of Object.entries(packet.slot_info || {})) {
            this.slotGames.set(Number(slot), info.game);
        }
    }

    _handleConnected(packet) {
        this._absorbPlayers(packet);
        this.connected = true;
        this.attempt = 0;
        this.emit('status', { state: 'connected', detail: this.address, slots: this.players.size });
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
