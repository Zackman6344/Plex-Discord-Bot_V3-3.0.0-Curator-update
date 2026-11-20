// stop-bot.ps1 asking the bot to shut down by itself over the single-instance pipe.
//
// The script is never run here: on this PC it would find the live bot. Its dot-sourced functions
// are called against a holder child on a lock of its own, with the pipe filter narrowed to that
// child's pipe, so the live pipe is never opened.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const singleInstance = require('../helpers/singleInstance.js');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'helpers', 'singleInstance.js');
const PIPE_SCRIPT = path.join(ROOT, 'scripts', 'stop-bot-pipe.ps1');
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };

let tokens = 0;
const uniqueToken = () => `test-stop-pipe-${process.pid}-${++tokens}`;

// The holder runs from a script file, since the script matches the holder's process.argv[1].
const CHILD = path.join(os.tmpdir(), `plexbot-stop-pipe-child-${process.pid}.js`);

test.before(() => {
	fs.writeFileSync(CHILD, [
		'const [helper, token, mode] = process.argv.slice(2);',
		`if (mode === 'quit') process.on('SIGINT', () => { console.log('quit'); process.exit(0); });`,
		`require(helper).claim(token, mode === 'old' ? { platform: 'linux' } : {})`,
		`	.then((c) => { console.log(c ? 'held' : 'refused'); setInterval(() => {}, 1000); });`
	].join('\n'));
});

test.after(() => {
	try { fs.unlinkSync(CHILD); } catch (_) {}
});

function holder(token, mode) {
	const env = { ...process.env, PLEXBOT_LOG_TO_FILE: '0' };
	delete env.NODE_TEST_CONTEXT;
	const child = spawn(process.execPath, [CHILD, HELPER, token, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function requestCleanStop(pid, token) {
	const address = singleInstance.lockAddress(token);
	const leaf = address.slice(address.lastIndexOf('\\') + 1);
	const command = `. ${psQuote(PIPE_SCRIPT)}; ` +
		`$r = Request-CleanStop -ProcessId ${pid} -PipeFilter ${psQuote(leaf)} -Entry ${psQuote(CHILD)}; ` +
		`Write-Output ($r.Result + '|' + $r.Why)`;
	return new Promise((resolve, reject) => {
		execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
			{ timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
				if (err) return reject(new Error(`${err.message}\n${stderr}`));
				const [result, why] = stdout.trim().split('|');
				resolve({ result, why });
			});
	});
}

async function withHolder(mode, fn) {
	const token = uniqueToken();
	const child = await holder(token, mode);
	try {
		await fn(child, token);
	} finally {
		child.kill('SIGKILL');
		await child.exited;
	}
}

test('a holder from before the pipe stop is reported as old', WINDOWS_ONLY, () => withHolder('old', async (child, token) => {
	assert.deepStrictEqual(await requestCleanStop(child.pid, token), { result: 'old', why: '' });
	assert.strictEqual(child.exitCode, null);
}));

test('a holder with no quitter yet refuses as not ready', WINDOWS_ONLY, () => withHolder('plain', async (child, token) => {
	assert.deepStrictEqual(await requestCleanStop(child.pid, token), { result: 'refused', why: 'not ready' });
}));

test('a holder with a quitter is asked and exits cleanly', WINDOWS_ONLY, () => withHolder('quit', async (child, token) => {
	const started = Date.now();
	assert.deepStrictEqual(await requestCleanStop(child.pid, token), { result: 'asked', why: '' });
	assert.strictEqual(await child.exited, 0);
	assert.ok(Date.now() - started < 10000);
	assert.match(child.out, /quit/);
}));

test('a pipe whose holder is another PID is left alone', WINDOWS_ONLY, () => withHolder('quit', async (child, token) => {
	assert.deepStrictEqual(await requestCleanStop(process.pid, token), { result: 'none', why: '' });
	assert.strictEqual(child.exitCode, null);
	assert.doesNotMatch(child.out, /quit/);
}));
