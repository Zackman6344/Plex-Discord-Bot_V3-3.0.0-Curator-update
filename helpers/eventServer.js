// helpers/eventServer.js
// A tiny inbound HTTP listener so on-machine tools can push events to the bot. Kometa's
// native webhooks hit POST /kometa; Playnite's "after starting a game" script hits
// POST /playnite/start. Both get relayed to the broadcast channel via helpers/broadcast.js.
//
// Deliberately built on Node's core `http` (no Express) and bound to 127.0.0.1 only, so it
// is never reachable from another machine. The optional config.eventServerToken is a second
// layer checked from the `?token=` query string (or an X-Auth-Token header).
const http = require('http');
const config = require('../config/config.js');
const logger = require('./logger.js');
const broadcast = require('./broadcast.js');

// Kometa's `changes` payload carries the collection poster and background base64-inlined
// (webhooks.py get_image_encoded) whenever the artwork isn't a URL, so a local 250 KB poster
// arrives as ~340 KB of JSON. The old 64 KB ceiling silently 413'd exactly those events.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
let isListening = false;

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handle(req, res, client) {
    const respond = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };

    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;

    if (config.eventServerToken) {
        const token = parsed.searchParams.get('token') || req.headers['x-auth-token'];
        if (token !== config.eventServerToken) return respond(401, { error: 'unauthorized' });
    }

    if (req.method === 'GET' && pathname === '/health') {
        return respond(200, { ok: true });
    }

    if (req.method === 'POST' && (pathname === '/kometa' || pathname === '/playnite/start')) {
        let data;
        try {
            const raw = (await readBody(req)).trim();
            data = raw ? JSON.parse(raw) : {};
        } catch (err) {
            if (err.statusCode === 413) return respond(413, { error: 'payload too large' });
            return respond(400, { error: 'invalid JSON body' });
        }

        if (pathname === '/kometa') {
            // broadcastKometaRun applies the right per-event toggle itself (broadcastKometa for
            // run summaries, broadcastKometaChanges for live per-collection updates).
            broadcast.broadcastKometaRun(client, data).catch(() => {});
            return respond(200, { ok: true });
        }
        // /playnite/start
        if (config.broadcastGameLaunch) broadcast.broadcastGameLaunch(client, data).catch(() => {});
        return respond(200, { ok: true });
    }

    return respond(404, { error: 'not found' });
}

function startEventServer(client) {
    if (!config.eventServerEnabled) {
        logger.info('Event server disabled (config.eventServerEnabled=false)');
        return null;
    }

    const port = config.eventServerPort || 8799;
    const server = http.createServer((req, res) => {
        handle(req, res, client).catch((err) => {
            logger.error('Event server handler error:', err.message || err);
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal error' }));
            } catch (_) { /* response already sent */ }
        });
    });

    // Listen failures (e.g. port already taken) should degrade this feature, not crash the bot.
    server.on('error', (err) => {
        isListening = false;
        if (err.code === 'EADDRINUSE') {
            logger.error(`Event server port ${port} is already in use — inbound broadcasts disabled.`);
        } else {
            logger.error('Event server error:', err.message || err);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        isListening = true;
        logger.info(`Event server listening on http://127.0.0.1:${port} (Kometa + Playnite pushes)`);
    });

    return server;
}

// Snapshot for the health check / !diag report.
function getStatus() {
    return {
        enabled: !!config.eventServerEnabled,
        listening: isListening,
        port: config.eventServerPort || 8799,
    };
}

module.exports = { startEventServer, getStatus };
