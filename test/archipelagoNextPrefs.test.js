// Each person's own `!ap next` settings, which today is whether to leave out the checks whose items
// go to slots that have goaled or released.
//
// Off is the one answer that must never come from a misread file: on is the only state in which the
// bot reads what a location holds, and nobody may land in it without asking.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const stores = require('./helpers/apServer.js').useTempStores('nextprefs');
const prefs = require('../helpers/archipelagoNextPrefs.js');

const ZACK = '111111111111111111';
const DAVE = '222222222222222222';

function fresh() {
	for (const file of [prefs.NEXT_FILE, `${prefs.NEXT_FILE}.tmp`]) fs.rmSync(file, { recursive: true, force: true });
	prefs.reset();
}

test.beforeEach(fresh);
test.after(() => {
	fresh();
	stores.cleanup();
});

const onDisk = () => JSON.parse(fs.readFileSync(prefs.NEXT_FILE, 'utf8')).users;

test('the store is the one the test harness points at, never the bot\'s own', () => {
	assert.strictEqual(prefs.NEXT_FILE, stores.paths.next);
});

test('nobody leaves anything out until they say so', () => {
	assert.strictEqual(prefs.hidesFinished(ZACK), false);
	assert.strictEqual(prefs.hidesFinished(null), false);
	assert.strictEqual(prefs.hidesFinished(''), false);
	assert.ok(!fs.existsSync(prefs.NEXT_FILE), 'asking writes nothing');
});

test('a setting is one person\'s, and survives a restart', () => {
	assert.strictEqual(prefs.setHideFinished(ZACK, true), true);
	assert.strictEqual(prefs.hidesFinished(ZACK), true);
	assert.strictEqual(prefs.hidesFinished(DAVE), false);
	assert.deepStrictEqual(onDisk(), { [ZACK]: { hideFinished: true } });

	prefs.reset();
	assert.strictEqual(prefs.hidesFinished(ZACK), true, 'read back off disk');

	assert.strictEqual(prefs.setHideFinished(ZACK, false), false);
	assert.strictEqual(prefs.hidesFinished(ZACK), false);
	assert.deepStrictEqual(onDisk(), { [ZACK]: { hideFinished: false } });
});

test('a user id given as a number is the same person as its string', () => {
	prefs.setHideFinished(Number(ZACK.slice(0, 15)), true);
	assert.strictEqual(prefs.hidesFinished(ZACK.slice(0, 15)), true);
});

test('only a stored true turns it on, whatever a hand-edited file holds', () => {
	fs.writeFileSync(prefs.NEXT_FILE, JSON.stringify({ users: {
		1: { hideFinished: 'yes' },
		2: true,
		3: { hideFinished: 1 },
		4: null,
		5: { hideFinished: true }
	} }));
	prefs.reset();
	assert.deepStrictEqual([1, 2, 3, 4, 5].map(id => prefs.hidesFinished(String(id))), [false, false, false, false, true]);
});

test('a setting that cannot be saved is refused, and the old one stays', () => {
	prefs.setHideFinished(ZACK, true);
	fs.mkdirSync(`${prefs.NEXT_FILE}.tmp`);
	assert.throws(() => prefs.setHideFinished(ZACK, false), /could not save that setting.*Nothing changed/);
	assert.strictEqual(prefs.hidesFinished(ZACK), true);
	assert.throws(() => prefs.setHideFinished(DAVE, true), /could not save/);
	assert.strictEqual(prefs.hidesFinished(DAVE), false, 'a first setting that failed leaves nothing behind');
});

test('a setting with nobody to keep it for is refused', () => {
	assert.throws(() => prefs.setHideFinished(null, true), /who that setting is for/);
	assert.ok(!fs.existsSync(prefs.NEXT_FILE));
});

test('a user id of __proto__ is kept as a key, never as the prototype', () => {
	prefs.setHideFinished('__proto__', true);
	assert.strictEqual(prefs.hidesFinished('__proto__'), true);
	assert.strictEqual(prefs.hidesFinished(ZACK), false);
	assert.strictEqual({}.hideFinished, undefined);
});
