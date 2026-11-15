// World 0.4.0's songs per unlock on the bot's side (helpers/apMediaYaml.js): the builder cuts a music
// playlist into parts of songs_per_unlock songs, 3 for a list built from the command alone, and the
// reader takes a file's own number, the Options Creator's quoted 'off', the Launcher template's
// unquoted off, and off for a file written before the setting existed.
//
// What has to hold: the parts are cut when the file is written, and plan.py refuses a part longer
// than songs_per_unlock, so the parts must be cut at it exactly, and a songs_per_unlock that
// Archipelago would roll later (random, weighted, or set by a trigger) is refused instead of kept,
// in words that hold with or without a playlist; a part of only short tracks still leaves the list
// at any size; the reply says how the playlist opens, counting only the parts kept, and a list too
// big for a slot at a small number is told it can raise it; a file attached again keeps its number.
// world 0.3.0 YAMLs, which have none, stay off. The world's own pages, which players read, say what
// a hand edit of the number does to a finished list, how the copies and a Wild Ticket open parts,
// and that the albums timer counts inside each part; they and the Locked Watches tooltip say that the
// bot skips a song of a locked playlist part in its voice channel, that a Plexamp play of it counts as
// any locked title's play does, and that an album never locks a song.
//
// Harness: the real createPms client over the fetch stand-in in test/fixtures/apmediaPlex/fakePms.js,
// serving the invented library in test/fixtures/apmediaPlex/library.js, with a fixed clock and a
// seeded random, as test/apMediaYaml.test.js uses them. Boardwalk Bumps there holds 32 songs and an
// audiobook part, Lofi 10 songs, Interludes 15 songs of 200 s and 3 of 15 s. No network. The pages
// are read from apworld/plex_media as they are on disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createPms } = require('../helpers/apMediaPlex.js');
const { createBuilder, renderYaml, readPlayerYaml, summaryHead, summaryLines, validateParams } = require('../helpers/apMediaYaml.js');
const { planSlot } = require('../helpers/apMediaPlan.js');
const { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks } = require('./fixtures/apmediaPlex/library.js');
const { createFakePlex } = require('./fixtures/apmediaPlex/fakePms.js');
const { creatorYaml } = require('./fixtures/apmedia/creatorYaml.js');

const NOW_MS = Date.UTC(2026, 10, 14, 12, 0, 0);
const RANDOM = 'Songs per Unlock (`songs_per_unlock`) is random: set a number or off, the bot cuts a music playlist at it when it writes the list.';
const WORLD = path.join(__dirname, '..', 'apworld', 'plex_media');
const ONE_PLAYLIST = { list_preset: 'none', list_shows: 'preset', list_titles: '\'\'', list_playlist: '\'Boardwalk Bumps\'' };

function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function builderOf({ library = {}, mutate = null } = {}) {
	const lib = buildLibrary(library);
	if (mutate) mutate(lib);
	const plex = createFakePlex(lib);
	const pms = createPms({ loadConfig: () => ({ hostname: 'localhost', port: '32400', https: false, token: 'FAKE-OWNER-TOKEN-0123456789', homeOwnerToken: '' }), fetchImpl: plex.fetch });
	return createBuilder({ pms, catalogStore: fakeCatalog(), longForm: fakeLongForm(lib), bookmarks: fakeBookmarks(), now: () => NOW_MS, random: seeded(7) });
}

function entriesOf(yaml) {
	return yaml.split('\n').filter((l) => l.startsWith('    - ')).map((l) => JSON.parse(l.slice(6)));
}

function songsLine(yaml) {
	return yaml.split('\n').find((l) => l.startsWith('  songs_per_unlock:'));
}

test('a list built from the command opens its playlist 3 songs per unlock, part by part in the playlist\'s order', async () => {
	const out = await builderOf().build({ name: 'Ears', playlist: 'boardwalk bumps' });
	const parts = entriesOf(out.yaml);
	assert.deepStrictEqual(parts.map((m) => [m.id, m.part, m.t, m.tr.length]), Array.from({ length: 11 }, (_, i) => [
		`pl:5001:${i + 1}`, i + 1, `Boardwalk Bumps Part ${i + 1}`, i < 10 ? 3 : 2,
	]));
	assert.deepStrictEqual(parts.flatMap((m) => m.tr.map((t) => t[1])), Array.from({ length: 32 }, (_, i) => i + 1), 'every song once, in order');
	assert.strictEqual(songsLine(out.yaml), '  songs_per_unlock: 3');
	const plan = planSlot(parts, { songs_per_unlock: 3 });
	assert.deepStrictEqual(plan.units, [{ key: 'mix-songs3|5001', steps: 11, start: 3, prefix: Array.from({ length: 12 }, (_, c) => c) }]);
	assert.deepStrictEqual(plan.entries.map((e) => e.step), Array.from({ length: 11 }, (_, i) => i + 1));
	assert.deepStrictEqual([out.summary.copies, out.summary.startOpen, out.summary.goalCount], [11, 3, 8], 'each part is a title toward the goal');
	assert.deepStrictEqual(out.summary.playlist, { title: 'Boardwalk Bumps', parts: 11, songs: 3, tracks: 32 });
	assert.strictEqual(summaryHead(out.summary)[1], '`Boardwalk Bumps` opens 3 songs per unlock, in 11 parts.');
	assert.ok(out.summary.warnings.includes('1 audiobook part in Boardwalk Bumps was left out.'));
});

test('1 or 15 songs per unlock, a number or off typed with the command, and nothing outside 0 to 15', async () => {
	const one = await builderOf().build({ name: 'Ears', playlist: 'boardwalk bumps', songsPerUnlock: 1 });
	assert.deepStrictEqual(entriesOf(one.yaml).map((m) => m.tr.length), Array(32).fill(1));
	assert.strictEqual(summaryHead(one.summary)[1], '`Boardwalk Bumps` opens 1 song per unlock, in 32 parts.');
	const fifteen = await builderOf().build({ name: 'Ears', playlist: 'boardwalk bumps', songsPerUnlock: '15' });
	assert.deepStrictEqual(entriesOf(fifteen.yaml).map((m) => m.tr.length), [15, 15, 2]);
	assert.deepStrictEqual(planSlot(entriesOf(fifteen.yaml), { songs_per_unlock: 15 }).units.map((u) => [u.key, u.steps]), [['mix-songs15|5001', 3]]);
	const off = await builderOf().build({ name: 'Ears', playlist: 'boardwalk bumps', songsPerUnlock: ' OFF ' });
	assert.deepStrictEqual([songsLine(off.yaml), entriesOf(off.yaml).map((m) => m.tr.length)], ['  songs_per_unlock: 0', [15, 15, 2]]);
	assert.strictEqual(summaryHead(off.summary)[1], '`Boardwalk Bumps` is in 3 parts of up to 15 songs, one unlock each.');
	assert.deepStrictEqual(planSlot(entriesOf(off.yaml), {}).units.map((u) => [u.key, u.steps]), [['mix|pl:5001:1', 1], ['mix|pl:5001:2', 1], ['mix|pl:5001:3', 1]]);

	assert.strictEqual(validateParams({ name: 'Z' }).options.songs_per_unlock, 3, 'a list from the command alone');
	assert.strictEqual(validateParams({ name: 'Z', songsPerUnlock: 0 }).options.songs_per_unlock, 0);
	for (const bad of [16, -1, '2.5', 'random', 'on']) {
		assert.throws(() => validateParams({ name: 'Z', songsPerUnlock: bad }), (err) => err.message === 'songsPerUnlock must be a whole number from 0 to 15 or off.', String(bad));
	}
	assert.throws(() => validateParams({ name: 'Z', timeMovies: 'never' }), (err) => err.message === 'timeMovies must be a whole number from 0 to 240 or off.', 'every timer takes off too');
	assert.throws(() => validateParams({ name: 'Z', episodesPerUnlock: 'off' }), (err) => err.message === 'episodesPerUnlock must be a whole number from 1 to 12.', 'a range with no off');
});

test('at a small size a part of only short tracks still leaves the list, and the parts after it are numbered on', async () => {
	const three = await builderOf().build({ name: 'Ears', playlist: 'Interludes' });
	assert.deepStrictEqual(entriesOf(three.yaml).map((m) => [m.part, m.tr.length]), [[1, 3], [2, 3], [3, 3], [4, 3], [5, 3]]);
	assert.ok(three.summary.warnings.includes('3 short tracks of Interludes were left out: a part needs one track of 30 s or more.'));
	// Cut into 6 parts, of which the last, 3 short tracks, left: the reply counts the 5 on the list.
	assert.deepStrictEqual(three.summary.playlist, { title: 'Interludes', parts: 5, songs: 3, tracks: 15 });
	assert.strictEqual(summaryHead(three.summary)[1], '`Interludes` opens 3 songs per unlock, in 5 parts.');

	// Song 2 cut to 15 s: inside a part of 3 it stays, a part of 1 song it leaves.
	const shortSecond = (lib) => { lib.playlistItems[5006][1].duration = 15000; };
	const kept = entriesOf((await builderOf({ mutate: shortSecond }).build({ name: 'Ears', playlist: 'Interludes' })).yaml);
	assert.deepStrictEqual(kept[0].tr.map((t) => [t[1], t[3]]), [[1, 200000], [2, 15000], [3, 200000]]);
	assert.strictEqual(planSlot(kept, { songs_per_unlock: 3 }).entries[0].main, 2, 'a short song has no location of its own');
	const single = await builderOf({ mutate: shortSecond }).build({ name: 'Ears', playlist: 'Interludes', songsPerUnlock: 1 });
	const parts = entriesOf(single.yaml);
	assert.deepStrictEqual(parts.slice(0, 3).map((m) => [m.id, m.tr[0][1]]), [['pl:5006:1', 1], ['pl:5006:2', 3], ['pl:5006:3', 4]]);
	assert.strictEqual(parts.length, 14);
	assert.ok(single.summary.warnings.includes('4 short tracks of Interludes were left out: a part needs one track of 30 s or more.'));
});

test('a 600-song playlist at 1 song per unlock is 600 parts, and 600 copies is not yet above the slow-generation warning', async () => {
	const big = await builderOf({ library: { bigAudioPlaylist: 700 } }).build({ name: 'Ears', playlist: 'Everything Ever', songsPerUnlock: 1 });
	assert.strictEqual(entriesOf(big.yaml).length, 600);
	assert.strictEqual(big.summary.copies, 600);
	assert.deepStrictEqual(big.summary.warnings, ['Everything Ever has 700 tracks; only the first 600 were used.']);
	const three = await builderOf({ library: { bigAudioPlaylist: 700 } }).build({ name: 'Ears', playlist: 'Everything Ever' });
	assert.strictEqual(entriesOf(three.yaml).length, 200);
});

test('a list too big for a slot at a small songs_per_unlock is told it can raise it, and not at 15 or off', async () => {
	const ask = { name: 'Big', preset: 'none', titles: 'show: Huge Show S1', playlist: 'Everything Ever', episodesPerUnlock: 12, timeEpisodes: 0 };
	const library = (episodes) => ({ library: { hugeShowEpisodes: episodes, bigAudioPlaylist: 700 } });
	await assert.rejects(builderOf(library(1500)).build({ ...ask, songsPerUnlock: 1 }),
		/^Error: That list is too big for one slot: 2100 entries \(at most 2000\), 725 unlock copies \(at most 2000\), 2100 locations \(at most 10000\)\. Lower the counts or the episodes per show, raise the episodes or songs per unlock, or turn the timers down\.$/);
	const fits = await builderOf(library(1500)).build({ ...ask, songsPerUnlock: 3 });
	assert.deepStrictEqual([fits.summary.entries, fits.summary.copies], [1700, 325], 'the same list at 3 songs per unlock fits');
	for (const songsPerUnlock of [15, 0]) {
		await assert.rejects(builderOf(library(1990)).build({ ...ask, songsPerUnlock }),
			/: 2030 entries \(at most 2000\), .* raise the episodes per unlock, or turn the timers down\.$/, `parts of 15 at ${songsPerUnlock}`);
	}
});

test('the reply reads right for a playlist of one part and for one short song left out', async () => {
	const twoSongs = (lib) => {
		lib.playlistItems[5002] = lib.playlistItems[5002].slice(0, 2);
		lib.playlists[1].leafCount = 2;
	};
	const small = await builderOf({ mutate: twoSongs }).build({ name: 'Ears', preset: 'none', playlist: 'Lofi' });
	assert.deepStrictEqual(small.summary.playlist, { title: 'Lofi', parts: 1, songs: 3, tracks: 2 });
	assert.strictEqual(summaryHead(small.summary)[1], '`Lofi` is in 1 part of 2 songs, with one unlock.', 'not 3 songs per unlock of a 2-song playlist');
	const whole = await builderOf().build({ name: 'Ears', preset: 'none', playlist: 'Lofi', songsPerUnlock: 'off' });
	assert.strictEqual(summaryHead(whole.summary)[1], '`Lofi` is in 1 part of 10 songs, with one unlock.');

	const shortFifth = (lib) => { lib.playlistItems[5002][4].duration = 15000; };
	const ones = await builderOf({ mutate: shortFifth }).build({ name: 'Ears', preset: 'none', playlist: 'Lofi', songsPerUnlock: 1 });
	assert.deepStrictEqual(ones.summary.warnings, ['1 short track of Lofi was left out: a part needs one track of 30 s or more.']);
	assert.strictEqual(summaryHead(ones.summary)[1], '`Lofi` opens 1 song per unlock, in 9 parts.');

	const secondBook = (lib) => {
		lib.playlistItems[5001].push({ ...lib.playlistItems[5001][10], ratingKey: '59998', key: '/library/metadata/59998' });
		lib.bookTracks.add('59998');
	};
	const books = await builderOf({ mutate: secondBook }).build({ name: 'Ears', preset: 'none', playlist: 'Boardwalk Bumps' });
	assert.ok(books.summary.warnings.includes('2 audiobook parts in Boardwalk Bumps were left out.'), JSON.stringify(books.summary.warnings));
});

test('a file\'s own songs_per_unlock: a number, the Creator\'s \'off\', the template\'s unquoted off, and off when the file has none', () => {
	const read = (value, typed = {}) => readPlayerYaml(creatorYaml({ songs_per_unlock: value }), typed).params.songsPerUnlock;
	assert.strictEqual(read('\'off\''), 0, 'what the Options Creator exports untouched');
	assert.strictEqual(read('5'), 5);
	for (const value of ['off', 'Off', 'no', 'false', '\'OFF\'', '{off: 50, random: 0, random-low: 0, random-high: 0}', '{1: 0, 3: 50}']) {
		assert.strictEqual(read(value), value === '{1: 0, 3: 50}' ? 3 : 0, value);
	}
	assert.strictEqual(read(undefined), 0, 'a file written for world 0.3.0 or earlier keeps whole parts');
	assert.strictEqual(read(undefined, { songsPerUnlock: '2' }), '2', 'a typed value goes on to the builder');
	assert.throws(() => read('true'), (err) => err.message === 'Songs per Unlock (`songs_per_unlock`) must be a whole number from 0 to 15 or off.',
		'true is the default, which Archipelago refuses for a range whose default is 0');
	assert.throws(() => read('16'), /^Error: Songs per Unlock \(`songs_per_unlock`\) must be a whole number from 0 to 15 or off\.$/);
});

test('a file\'s songs_per_unlock left random, weighted or set by a trigger is refused; a trigger may still check it', async () => {
	for (const value of ['random', 'random-low', 'random-range-1-5', '{1: 1, 3: 1}', '[1, 3]']) {
		assert.throws(() => readPlayerYaml(creatorYaml({ songs_per_unlock: value })), (err) => err.message === RANDOM, value);
	}
	assert.strictEqual(readPlayerYaml(creatorYaml({ songs_per_unlock: 'random' }), { songsPerUnlock: '2' }).params.songsPerUnlock, '2', 'a typed value replaces the random one');
	assert.throws(() => readPlayerYaml(creatorYaml({ ...ONE_PLAYLIST, songs_per_unlock: 'random' })), (err) => err.message === RANDOM, 'the same words with a playlist');
	assert.throws(() => readPlayerYaml(creatorYaml({ songs_per_unlock: 'random', list_movies: 'random' })),
		(err) => err.message === 'List: Movies (`list_movies`) and Songs per Unlock (`songs_per_unlock`) are random: the bot needs a value in each to build the list.');
	assert.throws(() => readPlayerYaml(creatorYaml({ list_shows: 'random', list_movies: 'random' })),
		(err) => err.message === 'List: Movies (`list_movies`) and List: Shows (`list_shows`) are random: the bot needs a value in each to pick titles.');

	const trigger = (set) => creatorYaml({ triggers: `[{option_category: Plex Media, option_name: tv_unlock, option_result: episodes, options: {Plex Media: {${set}}}}]` });
	for (const set of ['songs_per_unlock: 1', '"+songs_per_unlock": 1', 'songs_per_unlock: off']) {
		assert.throws(() => readPlayerYaml(trigger(set)), (err) => err.message === 'Trigger 1 in your file sets Songs per Unlock (`songs_per_unlock`), which the bot does not follow: set it in the file itself.', set);
	}
	const checked = creatorYaml({ triggers: '[{option_category: Plex Media, option_name: songs_per_unlock, option_result: \'off\', options: {Plex Media: {wild_tickets: 5}}}]' });
	const params = readPlayerYaml(checked).params;
	assert.strictEqual(params.songsPerUnlock, 0);
	const out = await builderOf().build({ ...params, accountId: 5, discordUserId: '42' });
	assert.strictEqual(songsLine(out.yaml), '  songs_per_unlock: "off"', 'the spelling the trigger compares');
});

test('a songs_per_unlock copied as it is is refused by validateParams and renderYaml', () => {
	for (const typed of [{}, { songsPerUnlock: 3 }]) {
		assert.throws(() => validateParams({ name: 'Z', ...typed, passthrough: [['songs_per_unlock', 'random']] }), (err) => err.message === RANDOM, JSON.stringify(typed));
	}
	assert.throws(() => renderYaml({ name: 'Z', createdAt: 1794398400, entries: [], passthrough: [['songs_per_unlock', { 1: 1, 3: 1 }]] }), (err) => err.message === RANDOM);
});

test('renderYaml refuses parts longer than songs_per_unlock with plan.py\'s words, as generation would', () => {
	const tracks = Array.from({ length: 15 }, (_, i) => [7000 + i, i + 1, `Song ${i + 1}`, 180000, 8000 + i, 'Band']);
	const part = { k: 'mix', id: 'pl:77:1', pl: 77, part: 1, t: 'Road Trip Part 1', d: 15 * 180000, tr: tracks };
	assert.throws(() => renderYaml({ name: 'Z', createdAt: 1794398400, options: { songs_per_unlock: 3 }, entries: [part] }),
		(err) => err.message === 'entry 1 (Road Trip Part 1) holds 15 tracks, more than songs_per_unlock 3 (the YAML attached to /apmedia yaml again, '
			+ 'which cuts the playlist at 3, or songs_per_unlock 0 would help)');
	assert.ok(renderYaml({ name: 'Z', createdAt: 1794398400, options: { songs_per_unlock: 15 }, entries: [part] }).includes('\n  songs_per_unlock: 15\n'));
});

test('a list attached again keeps its songs_per_unlock and cuts the playlist the same way', async () => {
	const first = await builderOf().build({ name: 'Ears', playlist: 'boardwalk bumps', songsPerUnlock: 1 });
	const again = readPlayerYaml(first.yaml);
	assert.strictEqual(again.params.songsPerUnlock, 1);
	const second = await builderOf().build({ ...again.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(entriesOf(second.yaml), entriesOf(first.yaml));
});

test('the reply\'s head names the playlist as code, after the size line, in both modes', () => {
	const base = { entries: 21, counts: { movie: 1, mix: 20 }, locations: 61, hours: 3.4, hoursToGoal: 2.7, startOpen: 3, goalCount: 16, warnings: ['W'], misses: [] };
	const head = summaryHead({ ...base, playlist: { title: 'Road `Trip` **now**', parts: 20, songs: 3 } });
	assert.deepStrictEqual(head.slice(0, 3), ['21 entries (1 movie, 20 playlist parts), 61 locations, about 3.4 h.', '`Road \'Trip\' **now**` opens 3 songs per unlock, in 20 parts.',
		'Starts with 3 open; goal: finish 16 of 21 (about 2.7 h).']);
	assert.strictEqual(head.length, 4);
	assert.strictEqual(summaryHead({ ...base, playlist: { title: 'Road', parts: 4, songs: 0, tracks: 60 } })[1], '`Road` is in 4 parts of up to 15 songs, one unlock each.');
	assert.strictEqual(summaryHead({ ...base, playlist: { title: 'Lofi', parts: 1, songs: 0, tracks: 1 } })[1], '`Lofi` is in 1 part of 1 song, with one unlock.');
	assert.strictEqual(summaryHead({ ...base, playlist: null }).length, 3, 'no playlist, no line');
	assert.deepStrictEqual(summaryLines({ ...base, playlist: null }, 'Zack').slice(0, 4), [...summaryHead({ ...base, playlist: null }), 'Warning: W']);
});

test('the world\'s pages say what a hand edit of songs_per_unlock does, how the copies and a Wild Ticket open parts, and that the albums timer counts per part', () => {
	// Read as one line each, so a rewrap of the page does not matter.
	const read = (...file) => fs.readFileSync(path.join(WORLD, ...file), 'utf8').replace(/\s+/g, ' ');
	const setup = read('docs', 'setup_en.md');
	const game = read('docs', 'en_Plex Media.md');
	const options = read('options.py');
	// Generation reads songs_per_unlock from the finished file (plan.py), so a hand edit counts at once.
	assert.ok(!/to a list setting or to `songs_per_unlock` takes effect only/.test(setup), 'the setup page invites edits to the game options');
	assert.ok(setup.includes('Change `songs_per_unlock` only that way, which cuts the playlist again: edited by hand, a lower number stops the whole seed '
		+ 'from generating, `off` gives each part an unlock of its own, opened in any order, and a higher number only renames the unlock.'), 'setup_en.md');
	assert.ok(game.includes('Edited by hand in a finished list, a lower number leaves parts longer than `songs_per_unlock`, which stops generation, naming '
		+ 'the player; `off` gives each part an unlock of its own, opened in any order, and a higher number only renames the unlock.'), 'en_Plex Media.md');
	// A copy opens the part its count reaches (credit.isUnlocked), whatever a ticket opened before it.
	assert.ok(game.includes('Unlocks one part of a playlist, up to that many songs: the first copy part 1, the second part 2, in the playlist\'s order;'),
		'the Items table, where a playlist\'s last part can be shorter');
	assert.ok(game.includes('A Wild Ticket opens the one part you name and leaves the copies counting from part 1, so a ticket spent on the next locked '
		+ 'part saves only the wait for the next copy.'));
	assert.ok(!/Unlocks the next part of a playlist/.test(game));
	const albums = /class TimesanityAlbums\(OffRange\): """(.*?)"""/.exec(options)[1];
	// plan.py checkpoint_count: before 90% of a 10-minute part, 5 fits once and 10 never.
	assert.strictEqual(albums, 'Minutes between checkpoints inside each album and each part of a playlist (off: none), so a 10-minute part of 3 songs '
		+ 'gets 1 checkpoint at 5 and none at 10. Every track of 30 s or more already has a check of its own.');
	assert.ok(!/[a-z]+_[a-z_]+/.test(albums), 'a tooltip names settings as the Options Creator shows them');
	const songs = /class SongsPerUnlock\(OffRange\): """(.*?)"""/.exec(options)[1];
	assert.ok(songs.startsWith('How many songs of the music playlist in List: Playlist one unlock opens, in the playlist\'s order.'), songs);
});

// The bug: no page a player reads said that the bot skips the songs of a locked playlist part in its
// voice channel, and the game page promised that a title played before its unlock banks its checks.
// Then the pages said that album tracks always play and that a Plexamp play banks: lockedFor skips
// an album's song that sits in a locked part, and under ignore a locked play counts for nothing.
test('the world\'s pages and the Locked Watches tooltip say that the bot skips a locked playlist song in voice, that a Plexamp play counts as any locked title\'s, and that an album never locks a song', () => {
	const read = (...file) => fs.readFileSync(path.join(WORLD, ...file), 'utf8').replace(/\s+/g, ' ');
	const setup = read('docs', 'setup_en.md');
	const game = read('docs', 'en_Plex Media.md');
	const options = read('options.py');
	assert.ok(game.includes('a trap then only says so. Through the bot, in its voice channel, a song of a playlist part still locked for someone '
		+ 'listening is skipped, as Locations says.'), 'after the traps that need you in the voice channel');
	assert.ok(game.includes('With `ignore`, the watch counts for nothing. Through the bot, in its voice channel, a song of a playlist part still locked '
		+ 'for someone listening is skipped before it plays, unless someone there has it open on their own list, so it banks nothing. Played in '
		+ 'Plexamp or another Plex app, it counts as above. An album never locks a song: a song in no locked part plays and counts as any title '
		+ 'does.'), 'under Locations, after the banking rule');
	assert.ok(game.includes('saves only the wait for the next copy. Through the bot, in its voice channel, the songs of a part still locked for '
		+ 'someone listening are skipped, as Locations says.'), 'in the Songs per Unlock paragraph');
	assert.ok(setup.includes('Only playback after the seed was generated counts. Through the bot, in its voice channel, a song of a playlist part '
		+ 'still locked for someone listening is skipped before it plays, unless someone there has it open, so it banks nothing; played in Plexamp '
		+ 'or another Plex app it counts as any locked title does: banked under `locked_watches: bank`, the default. An album never locks a song.'),
		'the Play step');
	const locked = /class LockedWatches\(Choice\): """(.*?)"""/.exec(options)[1];
	assert.strictEqual(locked, 'What happens to a title you finish before it is unlocked. bank: its checks wait and are sent when the unlock arrives. '
		+ 'ignore: nothing is sent, so watch it again later. In the bot\'s Discord voice channel, a song of a playlist part still locked for someone '
		+ 'listening is skipped unless someone there has it open, so it earns nothing; played in Plexamp or another Plex app it is banked or ignored '
		+ 'as above, and an album never locks a song.');
	assert.ok(!/[a-z]+_[a-z_]+/.test(locked), 'a tooltip names settings as the Options Creator shows them');
	for (const [name, text] of [['en_Plex Media.md', game], ['setup_en.md', setup], ['options.py', options]]) {
		assert.ok(!/always play/i.test(text), `${name} says a song always plays`);
	}
});
