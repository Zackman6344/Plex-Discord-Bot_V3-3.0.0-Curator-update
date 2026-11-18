// The slots each watch heard released, per seed. The server keeps no record of a release, so this
// store is the only copy there is, which is why it is durable: a damaged file comes back from its
// hourly backup rather than empty.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const stores = require('./helpers/apServer.js').useTempStores('releases');
const releases = require('../helpers/archipelagoReleases.js');

const FILE = releases.RELEASES_FILE;

function fresh() {
	const dir = path.dirname(FILE);
	const aside = fs.readdirSync(dir).filter(name => name.startsWith(`${path.basename(FILE)}.corrupt-`));
	for (const f of [FILE, `${FILE}.bak`, `${FILE}.tmp`, ...aside.map(name => path.join(dir, name))]) {
		fs.rmSync(f, { recursive: true, force: true });
	}
	releases.reset();
}

test.beforeEach(fresh);
test.after(() => {
	fresh();
	stores.cleanup();
});

const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).released;

test('the store is the one the test harness points at, never the bot\'s own', () => {
	assert.strictEqual(FILE, stores.paths.releases);
});

test('a release is kept per watch and seed, in order, and written only when it is new', () => {
	assert.deepStrictEqual([...releases.heard(0, 'S1')], []);
	assert.ok(!fs.existsSync(FILE), 'asking writes nothing');

	assert.strictEqual(releases.note(0, 'S1', [7, '3', 'x', null, 0, '', 2.5, -1]), true);
	assert.deepStrictEqual(onDisk(), { '0::S1': [3, 7] });

	fs.rmSync(FILE);
	assert.strictEqual(releases.note(0, 'S1', [3]), true);
	assert.ok(!fs.existsSync(FILE), 'nothing new, so nothing written');
	assert.deepStrictEqual([...releases.heard(0, 'S1')], [3, 7]);
	assert.deepStrictEqual([...releases.heard(1, 'S1')], [], 'another watch');
	assert.deepStrictEqual([...releases.heard(0, 'S2')], [], 'another seed');
});

test('a restart reads them back off disk', () => {
	releases.note(2, 'S1', [4]);
	releases.reset();
	assert.deepStrictEqual([...releases.heard(2, 'S1')], [4]);
});

test('a damaged file comes back from its hourly backup rather than empty', () => {
	releases.note(0, 'S1', [1]);
	// A boot: the first write after it backs up the file that boot found.
	releases.reset();
	releases.note(0, 'S1', [2]);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${FILE}.bak`, 'utf8')).released, { '0::S1': [1] });

	fs.writeFileSync(FILE, '');
	releases.reset();
	assert.deepStrictEqual([...releases.heard(0, 'S1')], [1], 'what the backup held');
});

test('a release that cannot be written is refused, and memory stays as the file is', () => {
	releases.note(0, 'S1', [1]);
	fs.mkdirSync(`${FILE}.tmp`);
	assert.strictEqual(releases.note(0, 'S1', [2]), false);
	assert.deepStrictEqual([...releases.heard(0, 'S1')], [1]);
	assert.strictEqual(releases.note(0, 'S9', [5]), false);
	assert.deepStrictEqual([...releases.heard(0, 'S9')], [], 'a first list that failed leaves nothing behind');
});

test('forgetting a watch drops every seed it had, and no other watch\'s', () => {
	releases.note(0, 'S1', [1]);
	releases.note(0, 'S2', [2]);
	releases.note(1, 'S1', [3]);
	releases.note(10, 'S1', [4]);
	assert.strictEqual(releases.forgetWatch(0), 2);
	assert.strictEqual(releases.forgetWatch(1), 1);
	assert.deepStrictEqual(onDisk(), { '10::S1': [4] }, 'watch 10 is not watch 1');
	assert.strictEqual(releases.forgetWatch(0), 0);
});

test('a hand-edited list that is not a list reads as no releases', () => {
	fs.writeFileSync(FILE, JSON.stringify({ released: { '0::S1': 'all of them', '0::S2': [2, 'two', null, 0] } }));
	releases.reset();
	assert.deepStrictEqual([...releases.heard(0, 'S1')], []);
	assert.deepStrictEqual([...releases.heard(0, 'S2')], [2]);
});
