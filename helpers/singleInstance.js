// helpers/singleInstance.js
//
// Keeps a second copy of the bot from starting while one is already running.
//
// Two processes logged in with the same token each receive every message and every button click.
// Both answer prefix commands, so each builds a queue of its own, while a button click goes to
// whichever copy wins the interaction. On 2026-10-09 a second start left the first copy running
// for five hours: Stop cleared the playing copy's queue, the other copy kept the 48 tracks a
// failed voice join had stranded, and played them at the next !play. Nothing refused that second
// start. The event server's port clash was logged and ignored.
//
// The lock is a named pipe (an abstract socket on Linux), which the OS releases the moment its
// process dies, crash or Stop-Process -Force included. A lock file would outlive a crash and need
// clearing by hand, and a recycled PID written in it could pass for the old holder.
//
// Keyed by the bot token rather than by the install folder: a second install or a worktree logged
// in with the same token doubles every answer just the same. It only sees copies on the same
// operating system. A Docker container or WSL has a pipe and socket namespace of its own, so a
// copy inside one and a copy outside it do not see each other, and neither does another machine.

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger.js');

const PIPE_PREFIX = '\\\\.\\pipe\\';
const ATTEMPTS = 3;
const RETRY_MS = 50;
const GONE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE']);

let held = null;

/** Where the lock for `token` lives. The token is hashed, so it never appears in the name. */
function lockAddress(token, platform = process.platform) {
	const id = crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
	const name = `plex-discord-bot-${id}`;
	if (platform === 'win32') return PIPE_PREFIX + name;
	if (platform === 'linux') return '\0' + name;
	return path.join(os.tmpdir(), `${name}.sock`);
}

function listen(address, info) {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.end(JSON.stringify(info) + '\n');
		});
		server.once('error', reject);
		server.listen(address, () => {
			server.removeListener('error', reject);
			server.on('error', (err) => logger.warn('Single-instance lock error:', err.message || err));
			// The lock must not be what keeps a process alive. A refused copy, or one shutting down,
			// exits once its other work is done.
			server.unref();
			resolve(server);
		});
	});
}

/**
 * What the copy holding `address` says about itself.
 *
 * `holder` is null when it accepts the connection but never answers. That is a copy whose event
 * loop is blocked, such as one whose console window was clicked into selection mode, and it is
 * still logged in. `gone` means the holder is no longer there: it exited in between, closing or
 * resetting the connection before it could answer, or a crash left a socket file behind where the
 * platform uses one. A live holder writes its answer before it closes, and a blocked one never
 * closes at all.
 */
function askHolder(address, timeoutMs) {
	return new Promise((resolve) => {
		let data = '';
		let done = false;
		const socket = net.connect(address);
		const finish = (result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ holder: null }), timeoutMs);
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			data += chunk;
			const end = data.indexOf('\n');
			if (end === -1) return;
			let holder = null;
			try { holder = JSON.parse(data.slice(0, end)); } catch (_) {}
			finish({ holder });
		});
		socket.on('end', () => finish({ gone: true, holder: null }));
		socket.on('error', (err) => finish({ gone: GONE_CODES.has(err.code), holder: null }));
	});
}

/**
 * Take the lock at `address`.
 *
 * @returns {Promise<{server: net.Server|null, holder: object|null}>} `server` when this process
 *   now holds the lock; otherwise null, with whatever the running copy said about itself
 * @throws when the lock cannot be taken for any reason other than another copy holding it
 */
async function acquire(address, { info = holderInfo(), askTimeoutMs = 2000 } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return { server: await listen(address, info), holder: null };
		} catch (err) {
			if (err.code !== 'EADDRINUSE') throw err;
			const reply = await askHolder(address, askTimeoutMs);
			if (!reply.gone || attempt === ATTEMPTS) return { server: null, holder: reply.holder };
			if (!address.startsWith(PIPE_PREFIX) && !address.startsWith('\0')) {
				try { fs.unlinkSync(address); } catch (_) {}
			}
			// A holder killed a moment ago can still own the name for a millisecond or two.
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}
	}
}

function holderInfo() {
	return { pid: process.pid, startedAt: new Date().toISOString(), entry: process.argv[1] || null };
}

/**
 * Claim the bot for this process, or report the copy that already has it.
 *
 * Resolves true when this process may log in, and never rejects. A second claim from the process
 * that holds the lock is satisfied. !restart never claims again: utils.stop() leaves the lock held,
 * so the process keeps it across the restart. A lock that cannot be taken at all is logged and the
 * bot starts anyway: a broken lock is no reason to have no bot.
 */
async function claim(token, { address = lockAddress(token), askTimeoutMs } = {}) {
	if (held) return true;
	let result;
	try {
		result = await acquire(address, { askTimeoutMs });
	} catch (err) {
		logger.warn('Could not take the single-instance lock; starting without it:', err.message || err);
		return true;
	}
	if (result.server) {
		held = result.server;
		return true;
	}

	const h = result.holder;
	const who = h && h.pid
		? `PID ${h.pid}, started ${h.startedAt}${h.entry ? ` from ${h.entry}` : ''}`
		: 'it is not answering, so its event loop may be blocked';
	// stop-bot.ps1 finds a copy only by the full index.js path the shortcuts start it with, so a copy
	// started as `node index.js`, or from another install, is named by its PID instead.
	const how = h && h.pid
		? `close its window, or end PID ${h.pid} (Stop-Process -Id ${h.pid} on Windows)`
		: 'scripts\\stop-bot.ps1 on Windows';
	const message = `Another copy of the bot is already running with this token (${who}). ` +
		'Not starting a second one: both would answer every command and keep separate queues. ' +
		`Stop the running copy first (${how}), then start again.`;
	logger.error(message);
	// The launcher window turns the logger's console mirror off, and this is the one line its
	// reader has to see before the window reports the exit code.
	if (!logger.mirrorsToConsole) console.error(message);
	return false;
}

/** Let go of the lock. Only tests need this; a process that exits releases it anyway. */
function release() {
	if (!held) return;
	try { held.close(); } catch (_) {}
	held = null;
}

module.exports = { claim, acquire, lockAddress, release };
