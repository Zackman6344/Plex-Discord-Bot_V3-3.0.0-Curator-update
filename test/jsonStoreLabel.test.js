// jsonStore's log wording: the `feature` option and its Archipelago default.
//
// The bug: every jsonStore line said "Archipelago" whatever the store held, so a damaged audiobook
// bookmark file would have been reported as an Archipelago one and sent whoever read the log to
// the wrong feature. The default has to stay byte-identical, because the five Archipelago stores
// pass no feature and anyone searching the log for their lines relies on the old text. The
// expected strings below are copied from the wording before the option existed, not derived from
// the module, so a changed default cannot pass itself.
//
// Copies the directory-at-.tmp write breaker and the failing-rename quarantine from
// test/writeFailures.test.js, with logger.error mocked to capture the lines.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-jsonstore-label-${process.pid}.json`);
process.env.PLEXBOT_TEST_JSONSTORE_LABEL_FILE = FILE;

const logger = require('../helpers/logger.js');
const { createStore } = require('../helpers/jsonStore.js');

const DAMAGED = '{"claims": [';

function make(extra = {}) {
	return createStore({
		envVar: 'PLEXBOT_TEST_JSONSTORE_LABEL_FILE',
		defaultPath: pathMod.join(os.tmpdir(), 'never-used.json'),
		key: 'claims',
		shape: 'array',
		label: 'claim',
		...extra
	});
}

function asideFiles() {
	const dir = pathMod.dirname(FILE);
	const base = pathMod.basename(FILE);
	return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`)).map((f) => pathMod.join(dir, f));
}

function parseError(text) {
	try {
		JSON.parse(text);
	} catch (err) {
		return err.message;
	}
	throw new Error('expected a parse error');
}

function captureErrors(t) {
	const lines = [];
	t.mock.method(logger, 'error', (...args) => { lines.push(args); });
	return lines;
}

function failQuarantine(t) {
	const realRename = fs.renameSync;
	t.mock.method(fs, 'renameSync', function (from, to) {
		if (String(to).includes('.corrupt-')) {
			throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
		}
		return realRename.apply(fs, arguments);
	});
}

test.afterEach(() => {
	for (const p of [FILE, ...asideFiles()]) {
		try { fs.unlinkSync(p); } catch (_) {}
	}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
});

test('a quarantine without a feature logs the archipelago wording unchanged', (t) => {
	fs.writeFileSync(FILE, DAMAGED);
	const lines = captureErrors(t);
	make().load();

	const [aside] = asideFiles();
	assert.ok(aside, 'the damaged file was moved aside');
	assert.deepStrictEqual(lines, [[
		`Archipelago claim file unusable (${parseError(DAMAGED)}) — moved to ${aside} and starting fresh. ` +
		`The old contents are intact there if they are worth salvaging.`
	]]);
});

test('a failed write without a feature logs the archipelago wording unchanged', (t) => {
	const store = make();
	store.load();
	fs.mkdirSync(`${FILE}.tmp`, { recursive: true });
	const lines = captureErrors(t);

	assert.strictEqual(store.persist(), false);
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(lines[0][0], 'Could not persist Archipelago claims:');
	assert.strictEqual(typeof lines[0][1], 'string');
});

test('a refused overwrite without a feature logs the archipelago wording unchanged', (t) => {
	fs.writeFileSync(FILE, DAMAGED);
	failQuarantine(t);
	const lines = captureErrors(t);
	const store = make();
	store.load();
	store.persist();

	assert.deepStrictEqual(lines, [
		[`Archipelago claim file unusable (${parseError(DAMAGED)}) and could not be moved aside ` +
			`(EPERM: operation not permitted). Refusing to overwrite ${FILE}; fix it by hand.`],
		[`Not writing Archipelago claims: ${FILE} is damaged and could not be moved aside, so ` +
			`overwriting it would destroy the only copy. Fix it by hand.`]
	]);
	assert.strictEqual(fs.readFileSync(FILE, 'utf8'), DAMAGED);
});

test('a feature names itself in the quarantine line instead of archipelago', (t) => {
	fs.writeFileSync(FILE, DAMAGED);
	const lines = captureErrors(t);
	make({ feature: 'Audiobook', label: 'bookmark' }).load();

	assert.strictEqual(lines.length, 1);
	assert.match(lines[0][0], /^Audiobook bookmark file unusable \(/);
	assert.match(lines[0][0], /starting fresh\./);
	assert.doesNotMatch(lines[0][0], /Archipelago/);
});

test('a feature names itself in the failed-write line instead of archipelago', (t) => {
	const store = make({ feature: 'Audiobook', label: 'bookmark' });
	store.load();
	fs.mkdirSync(`${FILE}.tmp`, { recursive: true });
	const lines = captureErrors(t);

	assert.strictEqual(store.persist(), false);
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(lines[0][0], 'Could not persist Audiobook bookmarks:');
});

test('a feature names itself in both refusal lines instead of archipelago', (t) => {
	fs.writeFileSync(FILE, DAMAGED);
	failQuarantine(t);
	const lines = captureErrors(t);
	const store = make({ feature: 'Audiobook', label: 'bookmark' });
	store.load();
	store.persist();

	assert.strictEqual(lines.length, 2);
	assert.match(lines[0][0], /^Audiobook bookmark file unusable \(.*\) and could not be moved aside/);
	assert.match(lines[1][0], /^Not writing Audiobook bookmarks: /);
	for (const [line] of lines) assert.doesNotMatch(line, /Archipelago/);
});
