// A second copy of the bot refusing to start while one is running.
//
// On 2026-10-09 two copies were logged in with the same token for five hours. Each answered every
// prefix command with a queue of its own, and a Stop button click reached only one of them, so the
// other's stale queue played at the next !play. The holders here are real child processes: the
// lock is only worth anything if another process sees it, and is gone once its holder dies.

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const singleInstance = require('../helpers/singleInstance.js');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'helpers', 'singleInstance.js');

let tokens = 0;
const uniqueToken = () => `test-token-${process.pid}-${++tokens}`;

function childEnv(extra = {}) {
	const env = { ...process.env, PLEXBOT_LOG_TO_FILE: '0', ...extra };
	// The test runner's marker would otherwise reach a grandchild that runs no tests.
	delete env.NODE_TEST_CONTEXT;
	return env;
}

/** A separate process holding the lock for `token`, resolved once it has it. */
function holdInChild(token) {
	const script = `require(${JSON.stringify(HELPER)}).claim(${JSON.stringify(token)})` +
		`.then((c) => { console.log(c ? 'held' : 'refused'); setInterval(() => {}, 1000); });`;
	const child = spawn(process.execPath, ['-e', script], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
	return new Promise((resolve, reject) => {
		let out = '';
		child.stdout.on('data', (d) => {
			out += d;
			if (out.includes('held')) resolve(child);
			if (out.includes('refused')) {
				child.kill('SIGKILL');
				reject(new Error('the child could not take the lock'));
			}
		});
		child.on('exit', (code) => reject(new Error(`the holder exited early (${code})`)));
	});
}

function killed(child) {
	return new Promise((resolve) => {
		child.once('exit', resolve);
		child.kill('SIGKILL');
	});
}

test.afterEach(() => singleInstance.release());

test('the lock name is per token and never contains it', () => {
	const a = singleInstance.lockAddress('secret-token-a', 'win32');
	assert.match(a, /^\\\\\.\\pipe\\plex-discord-bot-[0-9a-f]{16}$/);
	assert.strictEqual(singleInstance.lockAddress('secret-token-a', 'win32'), a, 'the same token always meets the same lock');
	assert.notStrictEqual(singleInstance.lockAddress('secret-token-b', 'win32'), a, 'a different bot is not blocked');
	assert.doesNotMatch(a, /secret/);
	assert.match(singleInstance.lockAddress('secret-token-a', 'linux'), /^\0plex-discord-bot-[0-9a-f]{16}$/,
		'abstract on Linux, so a crash leaves no socket file behind');
	assert.strictEqual(path.dirname(singleInstance.lockAddress('secret-token-a', 'darwin')), os.tmpdir());
});

test('a second copy is refused and told which process holds the bot', async () => {
	const token = uniqueToken();
	const holder = await holdInChild(token);
	try {
		const result = await singleInstance.acquire(singleInstance.lockAddress(token));
		assert.strictEqual(result.server, null);
		assert.strictEqual(result.holder.pid, holder.pid);
		assert.strictEqual(await singleInstance.claim(token), false);
	} finally {
		await killed(holder);
	}
});

test('the lock is free again once its holder is killed outright', async () => {
	const token = uniqueToken();
	const holder = await holdInChild(token);
	// Killed whatever the assertion says, or a regression leaves it running and the run never ends.
	try {
		assert.strictEqual(await singleInstance.claim(token), false, 'held while the holder lives');
	} finally {
		await killed(holder);
	}
	assert.strictEqual(await singleInstance.claim(token), true, 'a forced kill leaves no stale lock to clear');
});

test('a second claim from the process that holds the lock is satisfied', async () => {
	const token = uniqueToken();
	assert.strictEqual(await singleInstance.claim(token), true);
	assert.strictEqual(await singleInstance.claim(token), true);
});

test('the lock outlives utils.stop, so an in-process !restart stays locked', async () => {
	const token = uniqueToken();
	assert.strictEqual(await singleInstance.claim(token), true);

	require('../app/utils.js').stop({ songQueue: [{}], stop() {}, destroy() {} }, { destroy() {} });

	const result = await singleInstance.acquire(singleInstance.lockAddress(token), { askTimeoutMs: 500 });
	assert.strictEqual(result.server, null, 'another copy is still refused after the restart stop');
	assert.strictEqual(result.holder.pid, process.pid);
});

test('a copy that holds the lock but never answers still blocks a second one', async () => {
	const token = uniqueToken();
	const address = singleInstance.lockAddress(token);
	const silent = net.createServer(() => {});
	await new Promise((resolve) => silent.listen(address, resolve));
	try {
		const result = await singleInstance.acquire(address, { askTimeoutMs: 200 });
		assert.strictEqual(result.server, null);
		assert.strictEqual(result.holder, null);
		assert.strictEqual(await singleInstance.claim(token, { askTimeoutMs: 200 }), false);
	} finally {
		await new Promise((resolve) => silent.close(resolve));
	}
});

/**
 * Run index.js as a copy logged in with `token`, and wait for it to exit.
 *
 * The token goes into the cached config/keys.js before index.js reads it. The file's own token is
 * the live bot's in the main checkout, and the same empty example in every worktree, so a test
 * claiming that one would fail while the bot runs and collide with a run in another worktree.
 */
async function runIndex(token, extraEnv) {
	const keys = path.join(ROOT, 'config', 'keys.js');
	const index = path.join(ROOT, 'index.js');
	const script = `require(${JSON.stringify(keys)}).botToken = ${JSON.stringify(token)};` +
		`require(${JSON.stringify(index)});`;
	const child = spawn(process.execPath, ['-e', script], {
		cwd: ROOT,
		env: childEnv({ PLEXBOT_LOG_DIR: path.join(os.tmpdir(), `plexbot-test-single-${process.pid}`), ...extraEnv }),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stderr = '';
	child.stderr.on('data', (d) => { stderr += d; });
	const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
	const code = await new Promise((resolve) => child.on('exit', resolve));
	clearTimeout(timer);
	return { code, stderr, said: stderr.split('Another copy').length - 1 };
}

test('index.js exits before logging in when the bot is already running', async () => {
	const token = uniqueToken();
	assert.strictEqual(await singleInstance.claim(token), true);

	// The launcher window turns the console mirror off, so the refusal has to reach stderr itself.
	const windowed = await runIndex(token, { PLEXBOT_LOG_TO_CONSOLE: '0' });
	assert.strictEqual(windowed.code, 1, 'a refused copy exits with an error, which the launcher window reports');
	assert.match(windowed.stderr, /Another copy of the bot is already running/);
	assert.match(windowed.stderr, new RegExp(`PID ${process.pid}\\b`));
	assert.strictEqual(windowed.said, 1, 'reaches stderr once with the console mirror off');

	const plain = await runIndex(token, { PLEXBOT_LOG_TO_CONSOLE: '1' });
	assert.strictEqual(plain.code, 1);
	assert.strictEqual(plain.said, 1, 'said once, not once per sink, with the console mirror on');
});

const WINDOWS_ONLY = { skip: process.platform !== 'win32' };
const noop = () => {};

/**
 * Connect to the lock at `address`, read the holder's line and, given `line`, send it and read the
 * answer. The socket is handed back open, so a test decides when the asker hangs up.
 */
function ask(address, line = null) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(address);
		const lines = [];
		let data = '';
		socket.setEncoding('utf8');
		socket.on('error', reject);
		socket.on('data', (chunk) => {
			data += chunk;
			let end;
			while ((end = data.indexOf('\n')) !== -1) {
				lines.push(JSON.parse(data.slice(0, end)));
				data = data.slice(end + 1);
				if (lines.length === 1 && line !== null) socket.write(line + '\n');
			}
			if (lines.length === (line === null ? 1 : 2)) resolve({ info: lines[0], answer: lines[1], socket });
		});
	});
}

function hangUp(socket) {
	return new Promise((resolve) => {
		socket.once('close', () => setTimeout(resolve, 50));
		socket.end();
	});
}

function withSigint(fn) {
	return async () => {
		process.on('SIGINT', noop);
		try { await fn(); } finally { process.removeListener('SIGINT', noop); }
	};
}

test('the holder offers the stop on Windows, and a second copy still gets its line', WINDOWS_ONLY, async () => {
	const token = uniqueToken();
	assert.strictEqual(await singleInstance.claim(token, { onStop: noop }), true);
	const address = singleInstance.lockAddress(token);
	const { info, socket } = await ask(address);
	try {
		assert.deepStrictEqual(info.accepts, ['stop']);
		assert.strictEqual(info.pid, process.pid);
		const result = await singleInstance.acquire(address, { askTimeoutMs: 1000 });
		assert.strictEqual(result.server, null);
		assert.strictEqual(result.holder.pid, process.pid, 'askHolder reads the line though the holder keeps the socket open');
	} finally {
		socket.destroy();
	}
});

test('a stop line is answered, and the stop runs once, after the asker hangs up', WINDOWS_ONLY, withSigint(async () => {
	const token = uniqueToken();
	let stops = 0;
	assert.strictEqual(await singleInstance.claim(token, { onStop: () => { stops++; } }), true);
	const address = singleInstance.lockAddress(token);
	const first = await ask(address, '\uFEFFstop ');
	assert.deepStrictEqual(first.answer, { stopping: true });
	assert.strictEqual(stops, 0, 'not before the asker has hung up');
	await hangUp(first.socket);
	assert.strictEqual(stops, 1);
	const second = await ask(address, 'stop');
	assert.deepStrictEqual(second.answer, { stopping: true });
	await hangUp(second.socket);
	assert.strictEqual(stops, 1, 'a second ask does not stop twice');
}));

test('another line changes nothing, and the lock still answers a second copy', WINDOWS_ONLY, withSigint(async () => {
	const token = uniqueToken();
	let stops = 0;
	assert.strictEqual(await singleInstance.claim(token, { onStop: () => { stops++; } }), true);
	const address = singleInstance.lockAddress(token);
	const { answer, socket } = await ask(address, 'quit');
	assert.deepStrictEqual(answer, { stopping: false, why: 'unknown request' });
	await hangUp(socket);
	assert.strictEqual(stops, 0);
	const result = await singleInstance.acquire(address, { askTimeoutMs: 1000 });
	assert.strictEqual(result.holder.pid, process.pid);
}));

test('a stop is refused as not ready while nothing listens for SIGINT', WINDOWS_ONLY, async () => {
	assert.strictEqual(process.listenerCount('SIGINT'), 0, 'a node --test child has no quitter');
	const token = uniqueToken();
	let stops = 0;
	assert.strictEqual(await singleInstance.claim(token, { onStop: () => { stops++; } }), true);
	const { answer, socket } = await ask(singleInstance.lockAddress(token), 'stop');
	assert.deepStrictEqual(answer, { stopping: false, why: 'not ready' });
	await hangUp(socket);
	assert.strictEqual(stops, 0);
});

test('off Windows the holder offers no stop and refuses one', withSigint(async () => {
	const token = uniqueToken();
	let stops = 0;
	assert.strictEqual(await singleInstance.claim(token, { onStop: () => { stops++; }, platform: 'linux' }), true);
	const address = singleInstance.lockAddress(token);
	const { info, answer, socket } = await ask(address, 'stop');
	assert.strictEqual(info.accepts, undefined);
	assert.deepStrictEqual(answer, { stopping: false, why: 'not on Windows' });
	await hangUp(socket);
	assert.strictEqual(stops, 0);
}));

test('a silent asker is cut off within 2 s', async () => {
	const token = uniqueToken();
	assert.strictEqual(await singleInstance.claim(token, { onStop: noop }), true);
	const { socket } = await ask(singleInstance.lockAddress(token));
	const started = Date.now();
	await new Promise((resolve) => socket.once('close', resolve));
	assert.ok(Date.now() - started < 2500, `closed after ${Date.now() - started} ms`);
});

/** A child holding the lock for `token`, with a SIGINT listener that prints quit when asked. */
function stopChild(token, { sigint = true, keepAliveMs = null } = {}) {
	const script = (sigint ? `process.on('SIGINT', () => { console.log('quit'); process.exit(0); });` : '') +
		`require(${JSON.stringify(HELPER)}).claim(${JSON.stringify(token)})` +
		`.then((c) => { console.log(c ? 'held' : 'refused'); ` +
		(keepAliveMs === null ? `setInterval(() => {}, 1000); });` : `setTimeout(() => {}, ${keepAliveMs}); });`);
	const child = spawn(process.execPath, ['-e', script], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
	child.out = '';
	child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
	return new Promise((resolve, reject) => {
		child.stdout.on('data', (d) => {
			child.out += d;
			if (child.out.includes('held')) resolve(child);
			if (child.out.includes('refused')) reject(new Error('the child could not take the lock'));
		});
		child.exited.then((code) => reject(new Error(`the holder exited early (${code})`)));
	});
}

test('a holder with only the lock and a silent asker exits by itself', async () => {
	const token = uniqueToken();
	const child = await stopChild(token, { sigint: false, keepAliveMs: 200 });
	const { socket } = await ask(singleInstance.lockAddress(token));
	const started = Date.now();
	const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
	const code = await child.exited;
	clearTimeout(timer);
	socket.destroy();
	assert.strictEqual(code, 0);
	assert.ok(Date.now() - started < 1500, `exited after ${Date.now() - started} ms, so the asker held it`);
});

test('a holder with a SIGINT listener quits when asked', WINDOWS_ONLY, async () => {
	const token = uniqueToken();
	const child = await stopChild(token);
	const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
	try {
		const { answer, socket } = await ask(singleInstance.lockAddress(token), 'stop');
		assert.deepStrictEqual(answer, { stopping: true });
		await hangUp(socket);
		assert.strictEqual(await child.exited, 0);
		assert.match(child.out, /quit/);
	} finally {
		clearTimeout(timer);
		child.kill('SIGKILL');
	}
});

test('a holder with no SIGINT listener answers not ready and keeps running', WINDOWS_ONLY, async () => {
	const token = uniqueToken();
	const child = await stopChild(token, { sigint: false });
	try {
		const { answer, socket } = await ask(singleInstance.lockAddress(token), 'stop');
		assert.deepStrictEqual(answer, { stopping: false, why: 'not ready' });
		await hangUp(socket);
		assert.strictEqual(child.exitCode, null);
	} finally {
		await killed(child);
	}
});
