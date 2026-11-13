// The files the Archipelago Options Creator (AP 0.6.8) exports for Plex Media, read and filled in by
// the bot. apworld/tests/fixtures/options_creator_default.yaml is an untouched form;
// options_creator_custom.yaml has the mixed preset, 4 movies, two titles, unwatched off, a list name
// with an accent, goal_percent random, the movie timer off by its special name and progression
// balancing at 30; options_creator_long.yaml has list texts long enough for the Creator to wrap them
// over several lines, in each of its quoting styles. launcher_template.yaml is the Launcher's
// Generate Template Options file, which weights every option. apworld/tests/test_creator.py makes
// all four with Archipelago's own code and holds them to it byte for byte, so these tests read
// Archipelago's own output.
//
// What has to hold: readPlayerYaml turns each file into exactly these params, copied settings and
// random keys, from the LF git keeps, the CRLF the Creator saves on Windows, or with a byte order
// mark in front; apworld/tests/fill_creator.js, which fills the files in for the apworld tests,
// writes the header, the setting lines and the list_info that build() writes for the same file, so
// only the titles and the creation time differ; and a filled file attached again reads back to the
// settings it was filled from.
//
// Harness: the real createPms client over the fetch stand-in in test/fixtures/apmediaPlex/fakePms.js,
// serving the invented library in test/fixtures/apmediaPlex/library.js with that file's catalog,
// longForm and bookmarks fakes, a fixed clock and a seeded random, as test/apMediaYaml.test.js uses
// them. No network, no Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPms } = require('../helpers/apMediaPlex.js');
const { createBuilder, readPlayerYaml } = require('../helpers/apMediaYaml.js');
const { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks } = require('./fixtures/apmediaPlex/library.js');
const { createFakePlex } = require('./fixtures/apmediaPlex/fakePms.js');
const { fill, fixtureEntries, ACCOUNT, DISCORD, CREATED_AT } = require('../apworld/tests/fill_creator.js');

const FIXTURES = path.join(__dirname, '..', 'apworld', 'tests', 'fixtures');
const NAMES = Object.freeze(['default', 'custom', 'long']);
const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const BOM = String.fromCharCode(0xfeff);
const LABEL = `Movie night at the caf${String.fromCharCode(0xe9)}`;
const LONG_TITLES = 'movie: Alien (1979); Aliens; Alien 3; show: Lost S1-2; show: The Wire S1; album: Daft Punk - Discovery; '
	+ 'book: The Hobbit; Heat (1995); The Thing; Blade Runner; Halloween (2018); Pride and Prejudice';
const LONG_LABEL = `Zo${String.fromCharCode(0xeb)}'s films and shows for the winter evenings at the lake cabin, ${String.fromCharCode(0x6771, 0x4eac)} edition`;
// The Creator's item and location settings, as an untouched form leaves them, in the file's order.
const ITEM_AND_LOCATION = Object.freeze([
	['local_items', []], ['non_local_items', []], ['start_inventory', new Map()], ['start_hints', []],
	['start_location_hints', []], ['exclude_locations', []], ['priority_locations', []],
]);
const UNTOUCHED_COMMON = Object.freeze([['progression_balancing', 'normal'], ['accessibility', 'items'], ...ITEM_AND_LOCATION]);
const GAME_DEFAULTS = Object.freeze({
	startingUnlocks: 3, goalPercent: 80, tvUnlock: 'episodes', episodesPerUnlock: 3, lockedWatches: 'bank', wildTickets: 2,
	checkpointItems: 'filler_only', strict: false, timeMovies: 15, timeEpisodes: 10, timeAlbums: 0, timeBooks: 30,
});

/** A fixture as git keeps it, with LF: a checkout under core.autocrlf has CRLF. */
function fixture(name) {
	return fs.readFileSync(path.join(FIXTURES, `options_creator_${name}.yaml`), 'utf8').replace(/\r\n/g, '\n');
}

function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function builder() {
	const lib = buildLibrary({});
	const plex = createFakePlex(lib);
	const pms = createPms({ loadConfig: () => ({ hostname: 'localhost', port: '32400', https: false, token: 'FAKE-OWNER-TOKEN-0123456789', homeOwnerToken: '' }), fetchImpl: plex.fetch });
	return createBuilder({ pms, catalogStore: fakeCatalog(), longForm: fakeLongForm(lib), bookmarks: fakeBookmarks(), now: () => NOW_MS, random: seeded(7) });
}

// The lines under "Plex Media:" that are settings: not list_info, the entries or an entry.
function settingLines(yaml) {
	const lines = yaml.split('\n');
	return lines.slice(lines.indexOf('Plex Media:') + 1).filter((l) => l && !/^ {2}(?:list_info|entries):/.test(l) && !l.startsWith('    - '));
}

// name, description, game and requires; the comment lines above them count the titles.
function headerLines(yaml) {
	const lines = yaml.split('\n');
	return lines.slice(lines.findIndex((l) => l.startsWith('name: ')), lines.indexOf('Plex Media:'));
}

function listInfo(yaml) {
	return JSON.parse(yaml.split('\n').find((l) => l.startsWith('  list_info: ')).slice('  list_info: '.length));
}

function entriesOf(yaml) {
	return yaml.split('\n').filter((l) => l.startsWith('    - ')).map((l) => JSON.parse(l.slice('    - '.length)));
}

test('an untouched Creator form reads as 15 unwatched movies, every other setting kept as it is in file order', () => {
	const passthrough = [...UNTOUCHED_COMMON];
	assert.deepStrictEqual(readPlayerYaml(fixture('default')), {
		name: 'Default Fan',
		params: { name: 'Default Fan', preset: 'movies', movies: 15, shows: 0, albums: 0, books: 0, unwatched: true, maxEpisodes: 24, ...GAME_DEFAULTS, passthrough },
		passthrough,
		random: [],
		entriesCount: 0,
	});
});

test('the custom Creator file: the mixed preset with 4 movies, two titles, unwatched off, its list name, the movie timer off, goal_percent left random', () => {
	const passthrough = [['progression_balancing', 30], ['accessibility', 'items'], ['goal_percent', 'random'], ...ITEM_AND_LOCATION];
	const gameOptions = { ...GAME_DEFAULTS, timeMovies: 0 };
	delete gameOptions.goalPercent;
	assert.deepStrictEqual(readPlayerYaml(fixture('custom')), {
		name: 'Custom Fan',
		params: {
			name: 'Custom Fan', preset: 'mixed', movies: 4, shows: 1, albums: 4, books: 1, titles: 'Alien; Aliens', unwatched: false, maxEpisodes: 24,
			label: LABEL, ...gameOptions, passthrough,
		},
		passthrough,
		random: ['goal_percent'],
		entriesCount: 0,
		label: LABEL,
	});
	assert.ok(fixture('custom').includes('  list_label: "Movie night at the caf\\xE9"\n'), 'the Creator escapes the accent');
});

test('list texts the Creator wrapped over several lines, folded, escaped or with a doubled quote, read back whole', () => {
	const passthrough = [...UNTOUCHED_COMMON];
	assert.deepStrictEqual(readPlayerYaml(fixture('long')), {
		name: 'Long Fan',
		params: {
			name: 'Long Fan', preset: 'none', movies: 0, shows: 0, albums: 0, books: 0, titles: LONG_TITLES, playlist: 'Road Trip: 90\'s #1',
			genre: 'Sci-Fi & Fantasy', years: '1990-1999', unwatched: true, maxEpisodes: 24, label: LONG_LABEL, ...GAME_DEFAULTS, passthrough,
		},
		passthrough,
		random: [],
		entriesCount: 0,
		label: LONG_LABEL,
	});
	const lines = fixture('long').split('\n');
	assert.ok(lines.some((l) => l.startsWith('  list_titles: \'')) && lines.some((l) => l.startsWith('    S1; album: ')), 'the titles fold onto the next lines');
	assert.ok(lines.find((l) => l.startsWith('  list_label: "')).endsWith(String.fromCharCode(92)), 'the name goes on after a backslash');
});

test('the CRLF the Creator saves on Windows, and a byte order mark, read the same as the LF git keeps', () => {
	for (const name of NAMES) {
		const lf = fixture(name);
		const crlf = lf.replace(/\n/g, '\r\n');
		const expected = readPlayerYaml(lf);
		assert.deepStrictEqual(readPlayerYaml(crlf), expected, name);
		assert.deepStrictEqual(readPlayerYaml(`${BOM}${crlf}`), expected, name);
		assert.strictEqual(fill(Buffer.from(`${BOM}${crlf}`, 'utf8')).yaml, fill(lf).yaml, `${name}: the filler decodes the bytes as the command does`);
	}
});

test('fill_creator.js writes the header, the setting lines and the list_info that build() writes for the same file; only the titles and the time differ', async () => {
	// The long file names a playlist the fake library does not have, which build() refuses.
	for (const name of ['default', 'custom']) {
		const text = fixture(name);
		const filled = fill(text);
		const built = await builder().build({ ...readPlayerYaml(text).params, accountId: ACCOUNT, discordUserId: DISCORD });
		assert.deepStrictEqual(headerLines(filled.yaml), headerLines(built.yaml), name);
		assert.deepStrictEqual(settingLines(filled.yaml), settingLines(built.yaml), name);
		const { created_at: filledAt, ...filledInfo } = listInfo(filled.yaml);
		const { created_at: builtAt, ...builtInfo } = listInfo(built.yaml);
		assert.deepStrictEqual(filledInfo, builtInfo, name);
		assert.deepStrictEqual([filledAt, builtAt], [CREATED_AT, NOW_MS / 1000], name);
		assert.strictEqual(filled.fileName, built.fileName, name);
		assert.strictEqual(filled.entries.length, 10);
		assert.deepStrictEqual(entriesOf(filled.yaml), fixtureEntries(), `${name}: builder 1's fixture titles stand in for the Plex picks`);
		assert.notDeepStrictEqual(entriesOf(built.yaml), fixtureEntries(), name);
	}
	assert.ok(settingLines(fill(fixture('custom')).yaml).includes('  goal_percent: "random"'));
});

test('the Launcher\'s template reads as the untouched form does: each weighted option has one choice above 0, all Archipelago can roll', () => {
	// As the Launcher saves it on Windows.
	const text = `${BOM}${fs.readFileSync(path.join(FIXTURES, 'launcher_template.yaml'), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')}`;
	assert.throws(() => readPlayerYaml(text), (err) => err.message === 'The name cannot contain {, } or %. That is the name in the file: give the slot another with the name option.',
		'its Player{number} needs a name of its own');
	const read = readPlayerYaml(text, { name: 'Zack' });
	const untouched = readPlayerYaml(fixture('default'), { name: 'Zack' });
	assert.deepStrictEqual({ ...read.params, passthrough: null }, { ...untouched.params, passthrough: null });
	assert.deepStrictEqual(read.random, [], 'no option is left for Archipelago to roll');
	assert.deepStrictEqual(read.passthrough.map(([key]) => key), [...UNTOUCHED_COMMON.map(([key]) => key), 'item_links', 'plando_items']);
	assert.deepStrictEqual(read.passthrough.find(([key]) => key === 'accessibility'), ['accessibility', new Map([['full', 0], ['minimal', 0], ['items', 50]])],
		'a common option\'s weights are copied as they are, for Archipelago');
	const filled = fill(Buffer.from(text.replace('name: Player{number}', 'name: Zack'), 'utf8')).yaml;
	assert.ok(settingLines(filled).includes('  goal_percent: 80') && settingLines(filled).includes('  list_preset: movies'), 'the one choice is written as the value');
});

test('a filled file attached again reads back to the settings it was filled from, its 10 titles counted', () => {
	for (const name of NAMES) {
		const first = readPlayerYaml(fixture(name));
		const again = readPlayerYaml(fill(fixture(name)).yaml);
		assert.strictEqual(again.entriesCount, 10, name);
		assert.deepStrictEqual({ ...again.params, passthrough: null }, { ...first.params, passthrough: null }, name);
		// The game options come first in the bot's layout, so a random one moves up; Maps compare unordered.
		assert.deepStrictEqual(new Map(again.passthrough), new Map(first.passthrough), name);
		assert.deepStrictEqual([again.name, again.label, again.random], [first.name, first.label, first.random], name);
	}
});
