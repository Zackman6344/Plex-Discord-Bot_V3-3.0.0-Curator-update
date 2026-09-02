// test/helpers/apServer.js
//
// The stand-in Archipelago server the suite drives the real client against, plus the fake Discord
// client and temp-file plumbing that went with it.
//
// Four test files carried their own copy and they had already drifted: one sent no `seed_name`,
// another sent its own, the fake Discord channels differed in whether they pushed `{id, content}`
// or the raw payload, and only some cleaned up the files they wrote. A protocol change on the bot
// side meant finding and fixing four near-identical fakes.
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const os = require('node:os');
const fs = require('node:fs');
const pathMod = require('node:path');
const { WebSocketServer } = require('ws');

/**
 * Point every Archipelago store at its own temp file for this process.
 * Call before requiring any helper, since each reads its path at module load.
 * @returns {{paths: Object, cleanup: () => void}}
 */
function useTempStores(prefix) {
    const file = (name) => pathMod.join(os.tmpdir(), `plexbot-test-${prefix}-${name}-${process.pid}.json`);
    const paths = {
        claims: file('claims'),
        watches: file('watches'),
        goals: file('goals'),
        roles: file('roles')
    };
    process.env.PLEXBOT_AP_CLAIMS_FILE = paths.claims;
    process.env.PLEXBOT_AP_WATCHES_FILE = paths.watches;
    process.env.PLEXBOT_AP_GOALS_FILE = paths.goals;
    process.env.PLEXBOT_AP_ROLES_FILE = paths.roles;

    return {
        paths,
        cleanup() {
            for (const p of Object.values(paths)) {
                try { fs.unlinkSync(p); } catch (_) {}
            }
        }
    };
}

/**
 * A server that completes the RoomInfo -> Connect -> Connected handshake.
 * @param {Object} [options]
 * @param {string[]} [options.slots]     slot names, numbered from 1 in order
 * @param {string}   [options.seedName]  RoomInfo.seed_name; the goal tally keys on it
 * @param {number}   [options.watchSlot] which slot the connecting client is told it is
 * @param {boolean}  [options.refuse]    answer Connect with ConnectionRefused instead
 * @returns {Promise<{wss, port, sendPacket, sendItem, received}>}
 */
function startFakeServer(options = {}) {
    const {
        slots = ['SlotA', 'SlotB'],
        seedName = 'Seed_TEST',
        watchSlot = 1,
        refuse = false
    } = options;

    const wss = new WebSocketServer({ port: 0 });   // 0 = let the OS pick, so a busy port cannot flake
    const received = [];
    let live = null;

    wss.on('connection', (socket) => {
        live = socket;
        const send = (packets) => socket.send(JSON.stringify(packets));
        send([{ cmd: 'RoomInfo', games: [], datapackage_checksums: {}, password: false, seed_name: seedName }]);

        socket.on('message', (raw) => {
            for (const packet of JSON.parse(raw.toString())) {
                received.push(packet);
                if (packet.cmd !== 'Connect') continue;
                if (refuse) {
                    send([{ cmd: 'ConnectionRefused', errors: ['InvalidSlot'] }]);
                    continue;
                }
                send([{
                    cmd: 'Connected',
                    team: 0,
                    slot: watchSlot,
                    players: slots.map((name, i) => ({ team: 0, slot: i + 1, name, alias: name })),
                    slot_info: {},
                    missing_locations: [],
                    checked_locations: []
                }]);
            }
        });
    });

    return new Promise((resolve) => wss.on('listening', () => resolve({
        wss,
        port: wss.address().port,
        received,
        sendPacket: (packet) => live.send(JSON.stringify([packet])),
        // No data package is loaded, so an item_name part renders its own text: this keeps a test
        // about the path under test rather than about name resolution.
        sendItem: (receiving, flags, name = 'Progressive Sword') => live.send(JSON.stringify([{
            cmd: 'PrintJSON', type: 'ItemSend', receiving,
            item: { item: 1, location: 2, player: watchSlot, flags },
            data: [
                { text: 'Watcher sent ' },
                { type: 'item_name', text: name, flags },
                { text: ' onward' }
            ]
        }]))
    })));
}

function closeServer(wss) {
    return new Promise((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(resolve);
    });
}

/**
 * A Discord client stub that records whole payloads, so mention suppression can be asserted and
 * not just the text.
 */
function fakeDiscord() {
    const posted = [];
    return {
        posted,
        client: {
            channels: {
                fetch: async (id) => ({
                    id,
                    send: async (payload) => { posted.push(payload); return {}; }
                })
            }
        }
    };
}

/** Poll until `predicate` returns something truthy, or fail saying what was being waited for. */
function waitFor(predicate, what, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const hit = predicate();
            if (hit) return resolve(hit);
            if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
            setTimeout(tick, 50);
        };
        tick();
    });
}

module.exports = { useTempStores, startFakeServer, closeServer, fakeDiscord, waitFor };
