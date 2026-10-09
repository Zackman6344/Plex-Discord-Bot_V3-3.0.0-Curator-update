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
