// helpers/processPriority.js: raising the bot above Normal priority at boot.
//
// The bug: at Normal priority a game, VR stream or Plex transcode on the same PC delayed the 20 ms
// voice send timer by up to 359 ms (34 ms at ABOVE_NORMAL), which listeners hear as stutter. The
// raise has to survive a host that refuses it (EACCES on Linux and in Docker) with one warning and
// a bot that still starts, and the 'normal' setting has to put a running bot back.
//
// os is injected as a fake that records setPriority calls and can refuse them, so nothing here
// changes the test runner's own priority. Constants are the ones Node defines.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-priority-' + process.pid);

const priority = require('../helpers/processPriority.js');

function fakeOs({ refuse = null } = {}) {
	let current = os.constants.priority.PRIORITY_NORMAL;
	const calls = [];
	return {
		calls,
		constants: { priority: os.constants.priority },
		setPriority(pid, value) {
			calls.push([pid, value]);
			if (refuse) {
				const err = new Error(`A system error occurred: uv_os_setpriority returned ${refuse}`);
				err.code = refuse;
				throw err;
			}
			current = value;
		},
		getPriority() { return current; }
	};
}

function fakeLogger() {
	const lines = { info: [], warn: [] };
	return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
}

test.beforeEach(() => priority._reset());

test('the default raises this process to above normal and logs it', () => {
	const fos = fakeOs();
	const logger = fakeLogger();

	const r = priority.apply(undefined, { os: fos, logger });

	assert.deepStrictEqual(fos.calls, [[0, os.constants.priority.PRIORITY_ABOVE_NORMAL]]);
	assert.deepStrictEqual(r, { setting: 'above_normal', ok: true, effective: 'above_normal', error: null });
	assert.deepStrictEqual(logger.lines.info, ['Process priority: above_normal']);
	assert.deepStrictEqual(logger.lines.warn, []);
});

test('a refused raise warns once, never throws, and reports the priority actually in effect', () => {
	const fos = fakeOs({ refuse: 'EACCES' });
	const logger = fakeLogger();

	const first = priority.apply('above_normal', { os: fos, logger });
	const second = priority.apply('above_normal', { os: fos, logger });

	assert.strictEqual(first.ok, false);
	assert.strictEqual(first.error, 'EACCES');
	assert.strictEqual(first.effective, 'normal');
	assert.strictEqual(second.ok, false);
	assert.strictEqual(logger.lines.warn.length, 1);
	assert.match(logger.lines.warn[0], /above_normal \(EACCES\)/);
	assert.deepStrictEqual(logger.lines.info, ['Process priority: normal', 'Process priority: normal']);
});

test('the normal setting sets normal, and an unknown value falls back to above normal', () => {
	const fos = fakeOs();
	const logger = fakeLogger();

	assert.strictEqual(priority.apply('normal', { os: fos, logger }).effective, 'normal');
	assert.strictEqual(priority.apply('realtime', { os: fos, logger }).setting, 'above_normal');
	assert.deepStrictEqual(fos.calls.map((c) => c[1]), [os.constants.priority.PRIORITY_NORMAL, os.constants.priority.PRIORITY_ABOVE_NORMAL]);
});

test('bindToConfig applies at boot and again on a /config change, subscribing once', () => {
	const fos = fakeOs();
	const logger = fakeLogger();
	const listeners = [];
	const store = { onChange(fn) { listeners.push(fn); } };

	priority.bindToConfig({ processPriority: 'above_normal' }, { store, os: fos, logger });
	priority.bindToConfig({ processPriority: 'above_normal' }, { store, os: fos, logger });
	assert.strictEqual(listeners.length, 1, 'a !restart does not stack listeners');

	listeners[0]('voiceHealthEnabled', true);
	listeners[0]('processPriority', 'normal');

	assert.deepStrictEqual(fos.calls.map((c) => c[1]), [
		os.constants.priority.PRIORITY_ABOVE_NORMAL,
		os.constants.priority.PRIORITY_ABOVE_NORMAL,
		os.constants.priority.PRIORITY_NORMAL
	]);
	assert.strictEqual(logger.lines.info[logger.lines.info.length - 1], 'Process priority: normal');
});
