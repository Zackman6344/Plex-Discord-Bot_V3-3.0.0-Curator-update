// test/apworldBuild.test.js
// helpers/apworldBuild.js: the plex_media.apworld zip the owner installs into Archipelago.
//
// A broken zip, or a manifest version that is not exactly x.y.z, stops every Archipelago process on
// the PC (Launcher, Generate, the room server, the !ap next worker), so these pin what the builder
// refuses and what it writes: stored entries whose CRCs match, the UTF-8 name flag, fixed
// 1980-01-01 timestamps (two builds are byte-identical), the plex_media/ layout without
// __pycache__, .pyc files or tests, LF line endings, and a write that lands through a rename.
// apworld/tests/test_generate.py loads the same built file through Archipelago's own loader and
// checks it with Python's zipfile.
//
// Harness: node:test. The zip is parsed here by an independent reader; sources for the refusal cases
// are written to a pid-suffixed folder under os.tmpdir() and removed afterwards.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const build = require('../helpers/apworldBuild.js');
const contracts = require('../helpers/apMediaContracts.js');
const { zip } = require('./helpers/epubFixture.js');

const TMP = path.join(os.tmpdir(), `plexbot-test-apworld-${process.pid}`);
let made = 0;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const GOOD_MANIFEST = {
	game: 'Plex Media',
	world_version: '0.1.0',
	minimum_ap_version: '0.6.8',
	compatible_version: 7,
	version: 7,
	authors: ['Plex Discord Bot'],
};

function source(files) {
	const dir = path.join(TMP, `src-${++made}`, 'plex_media');
	for (const [rel, data] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, data);
	}
	return dir;
}

function withManifest(manifest, extra = {}) {
	return source({
		'__init__.py': 'GAME = "Plex Media"\n',
		'archipelago.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
		...extra,
	});
}

/** Every entry of a zip, read from its own end record and central directory. */
function readZip(buf) {
	const end = buf.length - 22;
	assert.strictEqual(buf.readUInt32LE(end), 0x06054b50, 'end record at the very end (no comment)');
	const count = buf.readUInt16LE(end + 10);
	assert.strictEqual(buf.readUInt16LE(end + 8), count);
	const size = buf.readUInt32LE(end + 12);
	let at = buf.readUInt32LE(end + 16);
	assert.strictEqual(at + size, end, 'central directory ends where the end record starts');
	const entries = [];
	for (let i = 0; i < count; i++) {
		assert.strictEqual(buf.readUInt32LE(at), 0x02014b50);
		const nameLen = buf.readUInt16LE(at + 28);
		const entry = {
			flags: buf.readUInt16LE(at + 8),
			method: buf.readUInt16LE(at + 10),
			time: buf.readUInt16LE(at + 12),
			date: buf.readUInt16LE(at + 14),
			crc: buf.readUInt32LE(at + 16),
			csize: buf.readUInt32LE(at + 20),
			usize: buf.readUInt32LE(at + 24),
			extra: buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32),
			offset: buf.readUInt32LE(at + 42),
			name: buf.toString('utf8', at + 46, at + 46 + nameLen),
		};
		const local = entry.offset;
		assert.strictEqual(buf.readUInt32LE(local), 0x04034b50, `${entry.name}: local header`);
		assert.strictEqual(buf.readUInt16LE(local + 6), entry.flags);
		assert.strictEqual(buf.readUInt16LE(local + 8), entry.method);
		assert.strictEqual(buf.readUInt32LE(local + 14), entry.crc);
		assert.strictEqual(buf.readUInt16LE(local + 28), 0, `${entry.name}: no local extra field`);
		const start = local + 30 + buf.readUInt16LE(local + 26);
		entry.data = buf.subarray(start, start + entry.csize);
		entries.push(entry);
		at += 46 + nameLen + entry.extra;
	}
	return entries;
}

test('builds the real world as plex_media/ with its manifest, and nothing Python leaves behind', () => {
	const built = build.buildApworld();
	assert.ok(built.files.every((name) => name.startsWith('plex_media/')), built.files.join(', '));
	for (const name of ['__init__.py', 'archipelago.json', 'constants.py', 'entries.py', 'plan.py', 'registry.py',
		'naming.py', 'rules.py', 'options.py', 'datapackage.py', 'slotdata.py']) {
		assert.ok(built.files.includes(`plex_media/${name}`), `${name} is packed`);
	}
	assert.ok(built.files.some((name) => name.startsWith('plex_media/docs/')), 'the docs are packed');
	assert.ok(!built.files.some((name) => /__pycache__|\.pyc$|\/tests\//.test(name)));
	assert.strictEqual(built.bytes, built.buffer.length);
	assert.strictEqual(built.worldVersion, contracts.WORLD_VERSION);
	const manifest = JSON.parse(readZip(built.buffer).find((e) => e.name === 'plex_media/archipelago.json').data);
	assert.strictEqual(manifest.game, contracts.GAME);
	assert.strictEqual(manifest.minimum_ap_version, contracts.MIN_AP_VERSION);
	assert.strictEqual(manifest.compatible_version, 7);
});

test('every entry is stored, flagged UTF-8, stamped 1980-01-01 and carries the CRC of its bytes', () => {
	const entries = readZip(build.buildApworld().buffer);
	assert.ok(entries.length >= 12);
	for (const entry of entries) {
		assert.strictEqual(entry.method, 0, entry.name);
		assert.strictEqual(entry.flags, 0x0800, entry.name);
		assert.strictEqual(entry.time, 0, entry.name);
		assert.strictEqual(entry.date, (1 << 5) | 1, entry.name);
		assert.strictEqual(entry.extra, 0, entry.name);
		assert.strictEqual(entry.csize, entry.usize, entry.name);
		assert.strictEqual(entry.crc, build._internal.crc32Fallback(entry.data), entry.name);
		if (/\.(py|json|md)$/.test(entry.name)) assert.ok(!entry.data.includes('\r\n'), `${entry.name} is LF`);
	}
	assert.deepStrictEqual(entries.map((e) => e.name), [...entries.map((e) => e.name)].sort());
});

test('two builds of the same sources are byte-identical', () => {
	assert.ok(build.buildApworld().buffer.equals(build.buildApworld().buffer));
	const crlf = withManifest(GOOD_MANIFEST, { 'plan.py': 'a = 1\r\nb = 2\r\n' });
	const lf = withManifest(GOOD_MANIFEST, { 'plan.py': 'a = 1\nb = 2\n' });
	assert.ok(build.buildApworld({ srcDir: crlf }).buffer.equals(build.buildApworld({ srcDir: lf }).buffer));
});

test('refuses a manifest that would stop Archipelago loading worlds, and writes nothing', () => {
	const cases = [
		[{ ...GOOD_MANIFEST, world_version: '1.2' }, /world_version must be exactly x\.y\.z/],
		[{ ...GOOD_MANIFEST, world_version: '1.2.3.4' }, /world_version must be exactly x\.y\.z/],
		[{ ...GOOD_MANIFEST, world_version: 'v1.2.3' }, /world_version/],
		[{ ...GOOD_MANIFEST, world_version: '1.2.3\n' }, /world_version/],
		[{ ...GOOD_MANIFEST, world_version: 123 }, /world_version/],
		[{ ...GOOD_MANIFEST, world_version: undefined }, /world_version/],
		[{ ...GOOD_MANIFEST, minimum_ap_version: '0.6' }, /minimum_ap_version must be exactly x\.y\.z/],
		[{ ...GOOD_MANIFEST, maximum_ap_version: 'x.y.z' }, /maximum_ap_version must be exactly x\.y\.z/],
		[{ ...GOOD_MANIFEST, game: 'Plex' }, /game must be "Plex Media"/],
		[{ ...GOOD_MANIFEST, compatible_version: 8 }, /compatible_version must be 7/],
		[{ ...GOOD_MANIFEST, compatible_version: '7' }, /compatible_version must be 7/],
		['{"game": "Plex Media",', /not valid JSON/],
		['[]', /must hold a JSON object/],
	];
	for (const [manifest, error] of cases) {
		const srcDir = withManifest(manifest);
		const out = path.join(TMP, `refused-${made}`, 'plex_media.apworld');
		assert.throws(() => build.writeApworld(out, { srcDir }), error, JSON.stringify(manifest));
		assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.tmp`), 'nothing written');
	}
	assert.throws(() => build.buildApworld({ srcDir: source({ '__init__.py': '' }) }), /archipelago\.json is missing/);
	assert.throws(() => build.buildApworld({ srcDir: source({ 'archipelago.json': JSON.stringify(GOOD_MANIFEST) }) }),
		/__init__\.py is missing/);
	assert.throws(() => build.buildApworld({ srcDir: withManifest(GOOD_MANIFEST), worldVersion: '0.2' }), /world_version/);
});

test('a worldVersion given to the build replaces the manifest\'s', () => {
	const built = build.buildApworld({ srcDir: withManifest(GOOD_MANIFEST), worldVersion: '0.2.0' });
	assert.strictEqual(built.worldVersion, '0.2.0');
	const manifest = JSON.parse(readZip(built.buffer).find((e) => e.name.endsWith('archipelago.json')).data);
	assert.deepStrictEqual(manifest, { ...GOOD_MANIFEST, world_version: '0.2.0' });
});

test('skips __pycache__, .pyc files, tests folders and dotfiles; keeps nested data', () => {
	const srcDir = withManifest(GOOD_MANIFEST, {
		'plan.py': 'x = 1\n',
		'__pycache__/plan.cpython-313.pyc': 'compiled',
		'stray.pyc': 'compiled',
		'tests/test_plan.py': 'test',
		'docs/tests/note.md': 'nested tests folder',
		'.DS_Store': 'finder',
		'docs/setup_en.md': '# Setup\n',
		'data/names.json': '{}',
	});
	const { files } = build.buildApworld({ srcDir });
	assert.deepStrictEqual(files, [
		'plex_media/__init__.py',
		'plex_media/archipelago.json',
		'plex_media/data/names.json',
		'plex_media/docs/setup_en.md',
		'plex_media/plan.py',
	]);
});

test('writeApworld writes <out>.tmp and renames it into place', (t) => {
	const out = path.join(TMP, 'dist-ok', 'plex_media.apworld');
	const renames = [];
	const rename = fs.renameSync;
	t.mock.method(fs, 'renameSync', (from, to) => {
		renames.push([from, to, fs.existsSync(from), fs.existsSync(to)]);
		return rename(from, to);
	});
	const built = build.writeApworld(out);
	assert.deepStrictEqual(renames, [[`${path.resolve(out)}.tmp`, path.resolve(out), true, false]]);
	assert.strictEqual(built.file, path.resolve(out));
	assert.ok(fs.readFileSync(out).equals(built.buffer));
	assert.ok(!fs.existsSync(`${out}.tmp`));
});

test('a failed rename leaves neither the target nor the temporary file', (t) => {
	const out = path.join(TMP, 'dist-fail', 'plex_media.apworld');
	t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }); });
	assert.throws(() => build.writeApworld(out), /EBUSY/);
	assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.tmp`));
});

test('the CRC-32 fallback matches the check value and zlib', () => {
	assert.strictEqual(build._internal.crc32Fallback(Buffer.from('123456789')), 0xcbf43926);
	assert.strictEqual(build._internal.crc32Fallback(Buffer.alloc(0)), 0);
	if (typeof zlib.crc32 === 'function') {
		const sample = Buffer.from('Plex Media \u00e9\u2026');
		assert.strictEqual(build.crc32(sample), build._internal.crc32Fallback(sample));
	}
});

test('readApworldManifest reads the built file and a deflated one, and refuses a non-zip', () => {
	const out = path.join(TMP, 'dist-read', 'plex_media.apworld');
	build.writeApworld(out);
	assert.strictEqual(build.readApworldManifest(out).world_version, contracts.WORLD_VERSION);
	const deflated = path.join(TMP, 'deflated.apworld');
	fs.writeFileSync(deflated, zip([
		{ name: 'plex_media/__init__.py', data: 'x = 1\n', method: 8 },
		{ name: 'plex_media/archipelago.json', data: JSON.stringify({ ...GOOD_MANIFEST, world_version: '9.8.7' }), method: 8 },
	]));
	assert.strictEqual(build.readApworldManifest(deflated).world_version, '9.8.7');
	const none = path.join(TMP, 'none.apworld');
	fs.writeFileSync(none, zip([{ name: 'plex_media/__init__.py', data: '', method: 0 }]));
	assert.strictEqual(build.readApworldManifest(none), null);
	const junk = path.join(TMP, 'junk.apworld');
	fs.writeFileSync(junk, 'not a zip at all');
	assert.throws(() => build.readApworldManifest(junk), /is not a zip/);
});
