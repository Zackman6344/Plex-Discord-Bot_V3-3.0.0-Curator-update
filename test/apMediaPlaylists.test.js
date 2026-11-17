// Several Plex playlists in one Plex Media list (helpers/apMediaYaml.js): the playlist text is split
// at ";" as titles are, and each piece names a playlist by its ratingKey, its name, the label the
// slash autocomplete shows for it, that label cut short, or the nearest name.
//
// The bug, from the owner's command log of 2026-11-15: three /apmedia yaml builds were refused.
// "Human Music; Lofi A.M.; Boardwalk Bumps;" and the same names split by commas were read as the name
// of one playlist, and "Human Music (audio, 486 items)", the autocomplete's label for a real
// playlist, matched no name. Each refusal listed the first ten playlists in Plex's order, smart and
// video ones, and none of the names the owner had typed. The review of the first fix found its
// autocomplete failing the same way: a choice's name, cut at Discord's 100 characters, came back as
// a piece the builder refused or read as Plex's first playlist of that start, two choices could
// share one name, and past the fourth pick nothing was offered.
//
// What has to hold: pieces are trimmed, empty ones dropped, and a playlist named twice counts once,
// however it is written, before the cap of 10; a label is stripped only when the whole piece is no
// playlist's own name, so a playlist named with a label-like ending or with commas is still found by
// its name; a piece the autocomplete cut short names the one playlist whose label starts that way
// and is never read as the nearest name; a whole text that is the name of a playlist holding ";" is
// that playlist, and other playlists whose names would read that way are written by ratingKey; a
// text without ";" that names no playlist exactly is read as several at its commas only when every
// piece names one exactly, each piece held to 200 characters; a piece that names nothing refuses the
// build before anything is read, naming every such piece and up to 5 of its closest playlists, a
// music one before a video one as close, and never Plex's first ten; every playlist is cut as one
// alone is, a music one into its own unit with a reply line each (5 at most, the rest counted), a
// video one into movies and episodes; the file's list_playlist reads back to the same playlists, and
// a file the bot wrote, attached again, or an Options Creator file reads the same way; every choice
// the autocomplete offers builds, as its name typed on, what its value builds, for ten picks in a
// row, and after a ";" at the end the text as it is comes first; the world's pages and the Creator
// tooltip say how several are written.
//
// Harness: the real createPms client over the fetch stand-in in test/fixtures/apmediaPlex/fakePms.js,
// serving the invented library in test/fixtures/apmediaPlex/library.js with playlists added or
// renamed per test, a fixed clock and a seeded random, as test/apMediaYaml.test.js uses them. The
// owner's library copies the first ten playlists of the refusal in the command log, in its order. The
// autocomplete is the builder's cachedPlaylistChoices, which the command calls with the box's text;
// a pick is followed by typing on after the choice's name, as Discord leaves it in the box. No
// network. The pages are read from apworld/plex_media as they are on disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPms } = require('../helpers/apMediaPlex.js');
const { createBuilder, readPlayerYaml, summaryHead, validateParams, ACCOUNT_FIX, PICK_NOTHING, _internal } = require('../helpers/apMediaYaml.js');
const { planSlot } = require('../helpers/apMediaPlan.js');
const { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks } = require('./fixtures/apmediaPlex/library.js');
const { createFakePlex } = require('./fixtures/apmediaPlex/fakePms.js');
const { creatorYaml } = require('./fixtures/apmedia/creatorYaml.js');

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const HEART = String.fromCharCode(0x2764, 0xfe0f);
const ELLIPSIS = String.fromCharCode(0x2026);
const SEVERAL = 'Several playlists are separated with `;`.';
const CAP = 'The playlist text names 11 playlists, and a list takes at most 10.';
const WORLD = path.join(__dirname, '..', 'apworld', 'plex_media');

function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function playlistRow(rk, title, type, leafCount, smart = false) {
	return { ratingKey: String(rk), key: `/playlists/${rk}/items`, type: 'playlist', title, playlistType: type, smart, leafCount };
}

function song(rk, title) {
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, type: 'track', title, index: 1, parentIndex: 1, duration: 200000,
		grandparentTitle: 'Various Artists', originalTitle: 'Someone', Media: [{ Part: [{ id: rk + 1, key: `/library/parts/${rk + 1}/1700000000/file.flac` }] }],
	};
}

function songs(rk, title, count) {
	return Array.from({ length: count }, (_, i) => song(rk * 1000 + i + 1, `${title} ${i + 1}`));
}

/** Adds a music playlist of `count` songs of 200 s, its songs' ratingKeys counted from rk * 1000. */
function addMusic(lib, rk, title, count) {
	lib.playlists.push(playlistRow(rk, title, 'audio', count));
	lib.playlistItems[rk] = songs(rk, title, count);
}

// The first ten playlists of the owner's refusal, in its order, then Human Music (486 songs) and the
// fixture's Lofi as Lofi A.M. (10 songs); Boardwalk Bumps is the fixture's (32 songs and a book part).
function ownerLibrary(lib) {
	const [bumps, lofi, mcu, photos, all, interludes] = lib.playlists;
	lofi.title = 'Lofi A.M.';
	lib.playlists = [
		playlistRow(5101, `${HEART} Tracks`, 'audio', 40, true), all, playlistRow(5102, 'Classical', 'audio', 20),
		playlistRow(5103, `Fresh ${HEART}`, 'audio', 50, true), playlistRow(5104, 'Recently Added', 'audio', 50, true),
		playlistRow(5105, 'Recently Played', 'audio', 50, true), playlistRow(5106, 'ArrowVerse', 'video', 30),
		playlistRow(5107, 'Arrowverse (Timeline Order)', 'video', 30), bumps, playlistRow(5108, 'DC Animated Universe (Timeline Order)', 'video', 40),
	];
	addMusic(lib, 5109, 'Human Music', 486);
	lib.playlists.push(lofi, mcu, photos, interludes);
}

// The same with something in every one of the ten, so any of them builds: songs in the music ones,
// two movies in each video one.
function ownerFull(lib) {
	ownerLibrary(lib);
	for (const [rk, title, count] of [[5101, 'Tracks', 40], [5102, 'Classical', 20], [5103, 'Fresh', 50], [5104, 'Added', 50], [5105, 'Played', 50]]) {
		lib.playlistItems[rk] = songs(rk, title, count);
	}
	lib.playlistItems[5106] = [lib.movies[0], lib.movies[1]];
	lib.playlistItems[5107] = [lib.movies[2], lib.movies[3]];
	lib.playlistItems[5108] = [lib.movies[4], lib.movies[5]];
}

function setup(mutate = null) {
	const lib = buildLibrary({});
	if (mutate) mutate(lib);
	const plex = createFakePlex(lib);
	const pms = createPms({ loadConfig: () => ({ hostname: 'localhost', port: '32400', https: false, token: 'FAKE-OWNER-TOKEN-0123456789', homeOwnerToken: '' }), fetchImpl: plex.fetch });
	const builder = createBuilder({ pms, catalogStore: fakeCatalog(), longForm: fakeLongForm(lib), bookmarks: fakeBookmarks(), now: () => NOW_MS, random: seeded(7) });
	return { lib, plex, builder };
}

function build(params, mutate = null) {
	return setup(mutate).builder.build({ name: 'Zack', preset: 'none', ...params });
}

function entriesOf(yaml) {
	return yaml.split('\n').filter((l) => l.startsWith('    - ')).map((l) => JSON.parse(l.slice(6)));
}

function listLine(yaml) {
	return yaml.split('\n').find((l) => l.startsWith('  list_playlist:'));
}

function parts(rk, n) {
	return Array.from({ length: n }, (_, i) => `pl:${rk}:${i + 1}`);
}

/** The music playlists a list holds, by ratingKey, in its order. */
function mixes(yaml) {
	return [...new Set(entriesOf(yaml).filter((e) => e.k === 'mix').map((e) => e.pl))];
}

function playlistsRead(plex) {
	return plex.calls.filter((c) => /^\/playlists\/\d+\/items$/.test(c.path)).map((c) => c.path);
}

/** A builder over `mutate`'s library with its playlist cache filled, as the game fills it at start. */
async function warmed(mutate) {
	const { builder } = setup(mutate);
	await builder.playlists('');
	return builder;
}

/** What a playlist text builds on `mutate`'s library: the list_playlist line and the entries, or the refusal. */
async function outcome(text, mutate) {
	try {
		const out = await build({ playlist: text, unwatched: false }, mutate);
		return { list: listLine(out.yaml), ids: entriesOf(out.yaml).map((e) => e.id), near: out.summary.warnings.filter((w) => w.startsWith('Nearest')) };
	} catch (err) {
		return { refused: err.message };
	}
}

test('the owner\'s three refused builds: playlists split by ;, the same split by commas, and the autocomplete\'s label', async () => {
	for (const typed of ['Human Music; Lofi A.M.; Boardwalk Bumps;', 'Human Music, Lofi A.M., Boardwalk Bumps']) {
		const out = await build({ playlist: typed }, ownerLibrary);
		assert.deepStrictEqual(entriesOf(out.yaml).map((e) => e.id), [...parts(5109, 162), ...parts(5002, 4), ...parts(5001, 11)], typed);
		assert.deepStrictEqual(summaryHead(out.summary).slice(1, 4), [
			'`Human Music` opens 3 songs per unlock, in 162 parts.',
			'`Lofi A.M.` opens 3 songs per unlock, in 4 parts.',
			'`Boardwalk Bumps` opens 3 songs per unlock, in 11 parts.',
		], typed);
		assert.match(summaryHead(out.summary)[4], /^Starts with /);
		assert.strictEqual(listLine(out.yaml), '  list_playlist: "Human Music; Lofi A.M.; Boardwalk Bumps"', typed);
		assert.ok(!out.summary.warnings.some((w) => w.startsWith('Nearest')), 'each by its own name');
	}
	const label = await build({ playlist: 'Human Music (audio, 486 items)' }, ownerLibrary);
	assert.deepStrictEqual(entriesOf(label.yaml).map((e) => e.id), parts(5109, 162));
	assert.strictEqual(listLine(label.yaml), '  list_playlist: "Human Music"', 'the name, not the label');
});

test('a piece that names no playlist refuses the build before anything is read, naming each such piece with its closest playlists, never Plex\'s first ten', async () => {
	const { builder, plex } = setup(ownerLibrary);
	await assert.rejects(builder.build({ name: 'Zack', preset: 'none', titles: 'Alien', playlist: 'Human Music; Lofi AM; Boardwalk Bumps' }),
		(err) => err.message === `No playlist called \`Lofi AM\`. Closest by name: \`Lofi A.M.\`. ${SEVERAL}`);
	assert.deepStrictEqual(plex.calls.map((c) => c.path), ['/playlists'], 'no playlist, section or title was read');
	await assert.rejects(build({ playlist: 'Humen Musik; Lofi A.M.; Arowverse; qqqq' }, ownerLibrary), (err) => err.message === 'No playlist called `Humen Musik`, `Arowverse` or `qqqq`. '
		+ 'Closest to `Humen Musik`: `Human Music` and `All Music`. Closest to `Arowverse`: `ArrowVerse` and `Arrowverse (Timeline Order)`. '
		+ `${SEVERAL}`);
	await assert.rejects(build({ playlist: 'qqqq' }, ownerLibrary), (err) => err.message === `No playlist called \`qqqq\`. ${SEVERAL}`, 'no name is close, and none is listed');
	await assert.rejects(build({ playlist: 'Beach Photos' }), (err) => err.message === `No playlist called \`Beach Photos\`. ${SEVERAL}`, 'a photo playlist is no playlist a list takes');
});

test('the closest playlists are five at most, the closest first, and a music playlist before a video one as close', async () => {
	const roads = (lib) => {
		lib.playlists.push(playlistRow(5200, 'Road Trip 0', 'video', 1));
		for (let n = 1; n <= 7; n++) addMusic(lib, 5200 + n, `Road Trip ${n}`, 3);
	};
	await assert.rejects(build({ playlist: 'Road Trp' }, roads), (err) => err.message === 'No playlist called `Road Trp`. '
		+ `Closest by name: \`Road Trip 1\`, \`Road Trip 2\`, \`Road Trip 3\`, \`Road Trip 4\` and \`Road Trip 5\`. ${SEVERAL}`, 'Road Trip 0 is as close, and a video playlist');
	const trap = (lib) => {
		roads(lib);
		lib.playlists.push(playlistRow(5300, 'Road Trap', 'video', 1));
	};
	await assert.rejects(build({ playlist: 'Road Trp' }, trap), (err) => err.message === 'No playlist called `Road Trp`. '
		+ `Closest by name: \`Road Trap\`, \`Road Trip 1\`, \`Road Trip 2\`, \`Road Trip 3\` and \`Road Trip 4\`. ${SEVERAL}`, 'a closer video playlist comes first');
	// Read with its label, "Lfoi" would be too far from Lofi to name it.
	await assert.rejects(build({ playlist: 'Lfoi (audio, 10 items)' }), (err) => err.message === `No playlist called \`Lfoi (audio, 10 items)\`. Closest by name: \`Lofi\`. ${SEVERAL}`);
});

test('ten pieces that name nothing are all named, with the closest playlists of as many as fit, in a refusal that fits a reply', async () => {
	const { MISSING_CHARS, MAX_PLAYLISTS } = _internal;
	assert.deepStrictEqual([MISSING_CHARS, MAX_PLAYLISTS], [1500, 10]);
	const x = 'x'.repeat(48);
	const long = (lib) => { for (let k = 1; k <= 7; k++) addMusic(lib, 5400 + k, `Road Trip ${k} ${x}`, 3); };
	const pieces = Array.from({ length: 10 }, (_, n) => `Road Trp ${n + 1} ${x}`);
	await assert.rejects(build({ playlist: pieces.join('; ') }, long), (err) => {
		assert.ok(err.message.startsWith(`No playlist called ${pieces.slice(0, 9).map((p) => `\`${p}\``).join(', ')} or \`${pieces[9]}\`. Closest to \`${pieces[0]}\`: \`Road Trip 1 ${x}\`, `), err.message);
		assert.strictEqual((err.message.match(/Closest to /g) || []).length, 2, 'two of ten fit');
		assert.ok(err.message.endsWith(` ${SEVERAL}`) && err.message.length <= MISSING_CHARS, `${err.message.length} characters`);
		return true;
	});
	// A line that does not fit is passed over, and a shorter one after it still goes in.
	const more = [...Array.from({ length: 11 }, (_, n) => `Road Trp ${n + 1} ${x}`), 'Lofx'];
	await assert.rejects(build({ playlist: more.join('; ') }, long), (err) => {
		assert.strictEqual((err.message.match(/Closest to `Road Trp/g) || []).length, 1, err.message);
		assert.ok(err.message.endsWith(` Closest to \`Lofx\`: \`Lofi\`. ${SEVERAL}`) && err.message.length <= MISSING_CHARS, err.message);
		return true;
	});
});

test('two music playlists in songs mode are two units with a reply line each, in the order named; off, each part an unlock', async () => {
	const out = await build({ playlist: 'Lofi; Boardwalk Bumps' });
	const entries = entriesOf(out.yaml);
	assert.deepStrictEqual(entries.map((e) => e.id), [...parts(5002, 4), ...parts(5001, 11)]);
	assert.deepStrictEqual(planSlot(entries, { songs_per_unlock: 3 }).units.map((u) => [u.key, u.steps]), [['mix-songs3|5002', 4], ['mix-songs3|5001', 11]]);
	assert.deepStrictEqual(out.summary.playlists, [
		{ title: 'Lofi', parts: 4, songs: 3, tracks: 10 },
		{ title: 'Boardwalk Bumps', parts: 11, songs: 3, tracks: 32 },
	]);
	assert.deepStrictEqual(summaryHead(out.summary).slice(0, 3), [
		'15 entries (15 playlist parts), 42 locations, about 1.8 h.',
		'`Lofi` opens 3 songs per unlock, in 4 parts.',
		'`Boardwalk Bumps` opens 3 songs per unlock, in 11 parts.',
	]);
	const off = await build({ playlist: 'Lofi; Boardwalk Bumps', songsPerUnlock: 'off' });
	assert.deepStrictEqual(planSlot(entriesOf(off.yaml), {}).units.map((u) => u.key), ['mix|pl:5002:1', 'mix|pl:5001:1', 'mix|pl:5001:2', 'mix|pl:5001:3']);
	assert.deepStrictEqual(summaryHead(off.summary).slice(1, 3), ['`Lofi` is in 1 part of 10 songs, with one unlock.', '`Boardwalk Bumps` is in 3 parts of up to 15 songs, one unlock each.']);
});

test('a video and a music playlist together: movies and episodes, then parts, one reply line, and the account asked for before anything is read', async () => {
	const out = await build({ playlist: 'MCU Timeline; Lofi', unwatched: false });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => [e.k, e.rk || e.id]), [
		['movie', 1004], ['episode', 200105], ['movie', 1001], ['episode', 200101], ...parts(5002, 4).map((id) => ['mix', id]),
	]);
	assert.deepStrictEqual(out.summary.playlists.map((cut) => cut.title), ['Lofi']);
	assert.deepStrictEqual(summaryHead(out.summary)[1], '`Lofi` opens 3 songs per unlock, in 4 parts.');
	assert.match(summaryHead(out.summary)[2], /^Starts with /, 'no line for the video playlist');
	const friend = await build({ playlist: 'Lofi; MCU Timeline', accountId: 5 });
	assert.deepStrictEqual(entriesOf(friend.yaml).map((e) => e.rk || e.id), [...parts(5002, 4), 1004, 200105, 200101], 'what account 5 watched is left out');
	const { builder, plex } = setup();
	await assert.rejects(builder.build({ name: 'Zack', preset: 'none', playlist: 'Lofi; MCU Timeline' }), (err) => err.message === ACCOUNT_FIX);
	assert.deepStrictEqual(playlistsRead(plex), [], 'no playlist was read');
});

test('a ratingKey, the name in any case, and the autocomplete\'s label name a playlist, and one named twice counts once', async () => {
	const out = await build({ playlist: 'Lofi; 5002; lofi (audio, 10 items); LOFI (Audio, 10 Items); Lofi (audio); Lofi (audio, 1 item)' });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => e.id), parts(5002, 4));
	assert.deepStrictEqual(summaryHead(out.summary).slice(1, 3).map((line) => line.startsWith('`Lofi`')), [true, false], 'one line');
	assert.strictEqual(listLine(out.yaml), '  list_playlist: "Lofi"');
	assert.deepStrictEqual(_internal.playlistsParam(' Lofi ;Boardwalk Bumps;; Lofi ; lofi ;'), ['Lofi', 'Boardwalk Bumps', 'lofi'], 'trimmed, empties dropped, a text written twice kept once');
	assert.deepStrictEqual(_internal.playlistsParam('Lofi\nA.M.; ;'), ['Lofi A.M.'], 'a line break is a space, as everywhere');
	// A name of digits is a name when no playlist has it as its ratingKey.
	const digits = await build({ playlist: '1999; 5001' }, (lib) => { lib.playlists[1].title = '1999'; });
	assert.deepStrictEqual(entriesOf(digits.yaml).map((e) => e.id), [...parts(5002, 4), ...parts(5001, 11)]);
	// Two playlists of one name: the label tells them apart, and the name alone takes Plex's first.
	const twins = (lib) => {
		lib.playlists.push(playlistRow(5501, 'Mix', 'video', 2));
		lib.playlistItems[5501] = [lib.movies[4], lib.movies[5]];
		addMusic(lib, 5502, 'Mix', 3);
		addMusic(lib, 5505, 'Mix', 5);
	};
	const pair = await build({ playlist: 'Mix (audio, 3 items); Mix (video, 2 items)', unwatched: false }, twins);
	assert.deepStrictEqual(entriesOf(pair.yaml).map((e) => e.rk || e.id), ['pl:5502:1', 1005, 1006]);
	assert.strictEqual(listLine(pair.yaml), '  list_playlist: "5502; 5501"', 'a shared name is written as the ratingKey');
	const first = await build({ playlist: 'Mix', unwatched: false }, twins);
	assert.deepStrictEqual(entriesOf(first.yaml).map((e) => e.rk), [1005, 1006]);
	assert.deepStrictEqual(mixes((await build({ playlist: 'Mix (audio, 5 items)' }, twins)).yaml), [5505], 'the count tells two of one type apart');
	const stale = await build({ playlist: 'Mix (audio, 7 items)', unwatched: false }, twins);
	assert.deepStrictEqual(entriesOf(stale.yaml).map((e) => e.id), ['pl:5502:1'], 'a smart playlist\'s count moves: its type still tells them apart');
	// A name as written is found before one that norm() reads the same.
	const marks = (lib) => {
		addMusic(lib, 6001, 'Mix!', 3);
		addMusic(lib, 6002, 'Mix?', 3);
	};
	assert.deepStrictEqual(entriesOf((await build({ playlist: 'Mix?' }, marks)).yaml).map((e) => e.id), ['pl:6002:1']);
	// A piece that norm() reads as nothing names a playlist only as it is written.
	const hearts = (lib) => addMusic(lib, 6201, `${HEART}${HEART}`, 3);
	const heart = await build({ playlist: `${HEART}${HEART}` }, hearts);
	assert.deepStrictEqual(entriesOf(heart.yaml).map((e) => e.id), ['pl:6201:1']);
	assert.strictEqual(listLine(heart.yaml), `  list_playlist: "${HEART}${HEART}"`);
	await assert.rejects(build({ playlist: '!!!' }, hearts), (err) => err.message === `No playlist called \`!!!\`. ${SEVERAL}`);
	// A label on a name that only comes near: the nearest name, which the reply says it took.
	const near = await build({ playlist: 'lof (audio, 10 items)' });
	assert.deepStrictEqual(entriesOf(near.yaml).map((e) => e.id), parts(5002, 4));
	assert.ok(near.summary.warnings.includes('Nearest matches taken: "lof (audio, 10 items)" as the playlist Lofi.'), near.summary.warnings.join(' | '));
});

test('a piece the autocomplete cut short names the one playlist whose label starts that way, and is never taken for the nearest name', async () => {
	const played = await outcome(`Human Music; Recently P${ELLIPSIS}`, ownerFull);
	assert.deepStrictEqual([played.list, played.near], ['  list_playlist: "Human Music; Recently Played"', []]);
	// As the first fix's autocomplete cut a name: inside the label of the second pick.
	const old = await outcome(`DC Animated Universe (Timeline Order) (video, 40 items); Arrowverse (Timeline Order) (video, 30 ite${ELLIPSIS}; Human Music`, ownerFull);
	assert.deepStrictEqual([old.list, old.near], ['  list_playlist: "DC Animated Universe (Timeline Order); Arrowverse (Timeline Order); Human Music"', []]);
	// Two labels start that way: neither is taken, and the refusal names both, never Plex's first alone.
	assert.deepStrictEqual(await outcome(`Human Music; Rec${ELLIPSIS}; Classical`, ownerFull),
		{ refused: `No playlist called \`Rec${ELLIPSIS}\`. Closest by name: \`Recently Added\` and \`Recently Played\`. ${SEVERAL}` });
	const music = (lib) => {
		ownerFull(lib);
		lib.playlists.push(playlistRow(5110, 'Arrow Songs', 'audio', 3));
	};
	assert.deepStrictEqual(await outcome(`Arr${ELLIPSIS}`, music), { refused: `No playlist called \`Arr${ELLIPSIS}\`. `
		+ `Closest by name: \`Arrow Songs\`, \`ArrowVerse\` and \`Arrowverse (Timeline Order)\`. ${SEVERAL}` }, 'a music one first, then Plex\'s order');
	const roads = (lib) => { for (let n = 1; n <= 7; n++) addMusic(lib, 5200 + n, `Road Trip ${n}`, 3); };
	assert.deepStrictEqual(await outcome(`Road${ELLIPSIS}`, roads), { refused: `No playlist called \`Road${ELLIPSIS}\`. `
		+ `Closest by name: \`Road Trip 1\`, \`Road Trip 2\`, \`Road Trip 3\`, \`Road Trip 4\` and \`Road Trip 5\`. ${SEVERAL}` }, 'five at most');
	assert.deepStrictEqual(await outcome(`Zzz${ELLIPSIS}`, ownerFull), { refused: `No playlist called \`Zzz${ELLIPSIS}\`. ${SEVERAL}` });
	assert.deepStrictEqual(await outcome(ELLIPSIS, ownerFull), { refused: `No playlist called \`${ELLIPSIS}\`. ${SEVERAL}` });
	// A playlist whose own name ends in an ellipsis is found by its name first.
	const etc = (lib) => {
		addMusic(lib, 5901, `And So On${ELLIPSIS}`, 3);
		addMusic(lib, 5902, 'And So On and On', 3);
	};
	assert.deepStrictEqual(mixes((await build({ playlist: `and so on${ELLIPSIS}` }, etc)).yaml), [5901]);
});

test('every choice the autocomplete offers builds, as its name typed on, what its value builds: ten picks in a row, the earlier picks shown by name and sent as ratingKeys', async () => {
	const builder = await warmed(ownerFull);
	const steps = [['Human', 5109], ['Lofi', 5002], ['Board', 5001], ['Recently P', 5105], ['Class', 5102],
		['DC', 5108], ['Arrow', 5107], ['ArrowVerse', 5106], ['Tracks', 5101], ['Fresh', 5103]];
	let box = '';
	for (const [typed, rk] of steps) {
		const text = box ? `${box}; ${typed}` : typed;
		const choices = builder.cachedPlaylistChoices(text);
		const pick = choices.find((c) => c.value.split('; ').pop() === String(rk));
		assert.ok(pick, `${text}: ${JSON.stringify(choices)}`);
		assert.ok(choices.every((c) => c.name.length <= 100 && c.value.length <= 100), JSON.stringify(choices));
		assert.strictEqual(new Set(choices.map((c) => c.name)).size, choices.length, `${text}: no two choices share a name`);
		const [byName, byValue] = [await outcome(pick.name, ownerFull), await outcome(pick.value, ownerFull)];
		assert.ok(byValue.list && !byValue.near.length, JSON.stringify(byValue));
		assert.deepStrictEqual(byName, byValue, pick.name);
		box = pick.name;
	}
	assert.strictEqual(box, `5109; 5002; 5001; 5105; 5102; 5108; Arrowverse (Timeline Order); ArrowVerse; ${HEART} Tracks; Fresh ${HEART}`,
		'the first names turned into ratingKeys, one at a time, only once the latest no longer fit');
	assert.deepStrictEqual(await outcome(`${box}; Interludes`, ownerFull), { refused: CAP });

	// The first fix's two failures, picked and then typed on by hand.
	const dc = builder.cachedPlaylistChoices('DC Ani')[0];
	const arrow = builder.cachedPlaylistChoices(`${dc.name}; Arrow`).find((c) => c.value === '5108; 5107');
	assert.strictEqual(arrow.name, 'DC Animated Universe (Timeline Order); Arrowverse (Timeline Order) (video, 30 items)');
	assert.ok(builder.cachedPlaylistChoices(`${arrow.name}; `).length > 1, 'more to pick after two long names');
	assert.strictEqual((await outcome(`${arrow.name}; Human Music`, ownerFull)).list,
		'  list_playlist: "DC Animated Universe (Timeline Order); Arrowverse (Timeline Order); Human Music"');
	let four = '';
	for (const [typed, rk] of steps.slice(0, 4)) four = builder.cachedPlaylistChoices(four ? `${four}; ${typed}` : typed).find((c) => c.value.endsWith(String(rk))).name;
	assert.strictEqual(four, 'Human Music; Lofi A.M.; Boardwalk Bumps; Recently Played (audio, 50 items)');
	assert.strictEqual((await outcome(`${four}; Classical`, ownerFull)).list, '  list_playlist: "Human Music; Lofi A.M.; Boardwalk Bumps; Recently Played; Classical"');
	assert.deepStrictEqual(builder.cachedPlaylistChoices('Human Music; Lofi A.M.; Boardwalk Bumps; rec').map((c) => c.name), [
		'Human Music; Lofi A.M.; Boardwalk Bumps; Recently Added (audio, 50 items)',
		'Human Music; Lofi A.M.; Boardwalk Bumps; Recently Played (audio, 50 items)',
	]);
});

test('a choice with no room for its name is cut short only where its label alone starts that way, and the cut name builds the same', async () => {
	const z = 'z'.repeat(70);
	const nine = (lib) => {
		for (let n = 1; n <= 9; n++) addMusic(lib, 7400 + n, `Mix ${n}`, 3);
		addMusic(lib, 7450, `A ${z}`, 3);
		addMusic(lib, 7451, `B ${z} one`, 3);
		addMusic(lib, 7452, `B ${z} two`, 3);
		addMusic(lib, 7453, `C ${'z'.repeat(42)} tail`, 3);
	};
	const builder = await warmed(nine);
	const before = Array.from({ length: 9 }, (_, n) => `Mix ${n + 1}`).join('; ');
	const keys = Array.from({ length: 9 }, (_, n) => String(7401 + n)).join('; ');
	const [a] = builder.cachedPlaylistChoices(`${before}; a z`);
	assert.deepStrictEqual(a, { name: `${keys}; A ${'z'.repeat(43)}${ELLIPSIS}`, value: `${keys}; 7450` });
	const [byName, byValue] = [await outcome(a.name, nine), await outcome(a.value, nine)];
	assert.ok(byValue.list && !byValue.near.length);
	assert.deepStrictEqual(byName, byValue);
	assert.deepStrictEqual(builder.cachedPlaylistChoices(`${before}; b z`), [], 'both B labels start the same way that far');
	assert.strictEqual(builder.cachedPlaylistChoices('b z').length, 2, 'with room, each has its own name');
	assert.strictEqual(builder.cachedPlaylistChoices(`${before}; c z`)[0].name, `${keys}; C ${'z'.repeat(42)}${ELLIPSIS}`, 'no space left before the ellipsis');
});

test('a choice shows an earlier pick by its label where its name is another playlist\'s too, and two playlists labelled alike offer one choice', async () => {
	const twins = (lib) => {
		lib.playlists.push(playlistRow(5501, 'Mix', 'video', 2));
		lib.playlistItems[5501] = [lib.movies[4], lib.movies[5]];
		addMusic(lib, 5502, 'Mix', 3);
		addMusic(lib, 5503, 'Dup', 3);
		addMusic(lib, 5504, 'Dup', 3);
	};
	const builder = await warmed(twins);
	const [lofi] = builder.cachedPlaylistChoices('Mix (audio, 3 items); lo');
	assert.deepStrictEqual(lofi, { name: 'Mix (audio, 3 items); Lofi (audio, 10 items)', value: '5502; 5002' });
	assert.deepStrictEqual(await outcome(lofi.name, twins), await outcome(lofi.value, twins));
	assert.deepStrictEqual(builder.cachedPlaylistChoices('dup'), [{ name: 'Dup (audio, 3 items)', value: '5503' }], 'the second would read back as the first');
	assert.strictEqual(builder.cachedPlaylistChoices('5504; lofi')[0].name, '5504; Lofi (audio, 10 items)', 'neither its name nor its label is its own: its ratingKey');
});

test('after a ";" at the end the first choice is the text as it is, and a playlist already named is not offered again', async () => {
	const builder = await warmed(ownerFull);
	const choices = builder.cachedPlaylistChoices('Human Music; Lofi A.M.; Boardwalk Bumps;');
	assert.deepStrictEqual(choices.slice(0, 3), [
		{ name: 'Human Music; Lofi A.M.; Boardwalk Bumps', value: '5109; 5002; 5001' },
		{ name: `Human Music; Lofi A.M.; Boardwalk Bumps; ${HEART} Tracks (audio, 40 items)`, value: '5109; 5002; 5001; 5101' },
		{ name: 'Human Music; Lofi A.M.; Boardwalk Bumps; All Music (audio, 5 items)', value: '5109; 5002; 5001; 5005' },
	]);
	assert.strictEqual(choices.length, 12, 'the text, then the 11 playlists not named yet');
	assert.ok(choices.slice(1).every((c) => !/; (5109|5002|5001)$/.test(c.value)), 'none of the three again');
	assert.deepStrictEqual(await outcome(choices[0].value, ownerFull), await outcome('Human Music; Lofi A.M.; Boardwalk Bumps;', ownerFull));
	assert.deepStrictEqual(builder.cachedPlaylistChoices('lofi a.m.; lo').map((c) => c.value), [], 'Lofi A.M. is named already');
	assert.deepStrictEqual(builder.cachedPlaylistChoices(' ; ').map((c) => c.value).slice(0, 2), ['5101', '5005'], 'a ";" with nothing before it: each playlist alone');
	const thirty = await warmed((lib) => { for (let n = 1; n <= 30; n++) addMusic(lib, 7600 + n, `Mix ${n}`, 3); });
	assert.deepStrictEqual([thirty.cachedPlaylistChoices('').length, thirty.cachedPlaylistChoices('Lofi;').length], [25, 25], 'Discord takes 25');
	// A piece that names no playlist is kept as typed, cleaned as the builder cleans it, in the name and in the value.
	assert.deepStrictEqual(builder.cachedPlaylistChoices('lof\tx;')[0], { name: 'lof x', value: 'lof x' });
	assert.deepStrictEqual(builder.cachedPlaylistChoices(`${'x'.repeat(95)}; Lofi A.M.;`), [], 'no room for the text as it is, nor for more');
	// Ten picks made: the text as it is, its names turned into ratingKeys from the first until it fits.
	const ten = 'Human Music; Lofi A.M.; Boardwalk Bumps; Recently Played; Classical; DC Animated Universe (Timeline Order); '
		+ `Arrowverse (Timeline Order); ArrowVerse; ${HEART} Tracks; Fresh ${HEART};`;
	const [full] = builder.cachedPlaylistChoices(ten);
	assert.deepStrictEqual(full, { name: `5109; 5002; 5001; 5105; 5102; 5108; Arrowverse (Timeline Order); ArrowVerse; ${HEART} Tracks; Fresh ${HEART}`,
		value: '5109; 5002; 5001; 5105; 5102; 5108; 5107; 5106; 5101; 5103' });
	assert.deepStrictEqual(await outcome(full.name, ownerFull), await outcome(full.value, ownerFull));
});

test('a playlist named with a label-like ending or with commas is found by its own name before anything is stripped or split', async () => {
	const named = (lib) => {
		addMusic(lib, 5601, 'Lofi (audio, 10 items)', 3);
		addMusic(lib, 5602, 'Rock, Paper, Scissors', 3);
		addMusic(lib, 5603, 'Rock', 3);
		addMusic(lib, 5604, 'Paper', 3);
	};
	const ids = async (playlist) => entriesOf((await build({ playlist }, named)).yaml).map((e) => e.id);
	assert.deepStrictEqual(await ids('Lofi (audio, 10 items)'), ['pl:5601:1'], 'its own name, not the label of Lofi');
	assert.deepStrictEqual(await ids('Lofi (audio, 10 items) (audio, 3 items)'), ['pl:5601:1'], 'its own label');
	assert.deepStrictEqual(await ids('Lofi (audio, 4 items)'), parts(5002, 4), 'no playlist of that name: the label of Lofi');
	assert.deepStrictEqual(await ids('Rock, Paper, Scissors'), ['pl:5602:1'], 'the whole name, not three pieces');
	assert.deepStrictEqual(await ids('Rock, Paper, Scissors; Rock'), ['pl:5602:1', 'pl:5603:1']);
	assert.deepStrictEqual(await ids('Paper, Rock'), ['pl:5604:1', 'pl:5603:1'], 'no playlist has the whole name: two pieces');
});

test('a whole text that is the name of a playlist holding ";" is that playlist, and others whose names would read that way are written by ratingKey', async () => {
	const rock = (lib) => {
		lib.playlists[5].title = 'Rock; Roll';
		addMusic(lib, 7001, 'Rock', 3);
		addMusic(lib, 7002, 'Roll', 3);
	};
	for (const typed of ['Rock; Roll', 'rock;roll;', ' Rock ; Roll (audio, 18 items) ', 'Rock; Roll (audio, 18 items);']) {
		const out = await build({ playlist: typed }, rock);
		assert.deepStrictEqual(mixes(out.yaml), [5006], typed);
		assert.strictEqual(listLine(out.yaml), '  list_playlist: "5006"', typed);
	}
	// A list written before several were taken, attached again, and an Options Creator file.
	const written = (await build({ playlist: '5006' }, rock)).yaml;
	const older = written.replace('  list_playlist: "5006"', '  list_playlist: "Rock; Roll"');
	assert.notStrictEqual(older, written);
	const creator = creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'\'', list_playlist: '\'Rock; Roll\'' });
	for (const file of [older, creator]) {
		const again = await setup(rock).builder.build({ ...readPlayerYaml(file).params, accountId: 5, discordUserId: '42' });
		assert.deepStrictEqual(mixes(again.yaml), [5006]);
	}
	// Rock and Roll named any way are written so that they read back as the two.
	for (const typed of ['7001; 7002', 'Rock (audio, 3 items); Roll']) {
		const two = await build({ playlist: typed }, rock);
		assert.deepStrictEqual(mixes(two.yaml), [7001, 7002], typed);
		assert.strictEqual(listLine(two.yaml), '  list_playlist: "7001; 7002"', typed);
		const back = await setup(rock).builder.build({ ...readPlayerYaml(two.yaml).params, accountId: 5, discordUserId: '42' });
		assert.deepStrictEqual(mixes(back.yaml), [7001, 7002], typed);
	}
	assert.strictEqual(listLine((await build({ playlist: 'Rock; Lofi' }, rock)).yaml), '  list_playlist: "Rock; Lofi"');
	// A name without ";" of its own never joins the pieces of a text split at one.
	const slash = (lib) => {
		addMusic(lib, 7003, 'Rock / Jazz', 3);
		addMusic(lib, 7001, 'Rock', 3);
		addMusic(lib, 7004, 'Jazz', 3);
	};
	assert.deepStrictEqual(mixes((await build({ playlist: 'Rock; Jazz' }, slash)).yaml), [7001, 7004]);
	// The autocomplete shows the ";" as ",", so the name reads back once typed on.
	const builder = await warmed(rock);
	const pick = builder.cachedPlaylistChoices('rock; r').find((c) => c.value === '7001; 5006');
	assert.strictEqual(pick.name, 'Rock; Rock, Roll (audio, 18 items)');
	assert.deepStrictEqual(await outcome(pick.name, rock), await outcome(pick.value, rock));
	assert.deepStrictEqual(builder.cachedPlaylistChoices('rock, r')[0], { name: 'Rock, Roll (audio, 18 items)', value: '5006' });
});

test('the commas split a text only without ";", when no playlist has the whole name, and when every piece names one exactly', async () => {
	const ids = async (playlist, mutate = null) => entriesOf((await build({ playlist }, mutate)).yaml).map((e) => e.id);
	assert.deepStrictEqual(await ids('Lofi, Boardwalk Bumps'), [...parts(5002, 4), ...parts(5001, 11)]);
	assert.deepStrictEqual(await ids('Lofi (audio, 10 items), Boardwalk Bumps (audio, 33 items), 5006, lofi'), [...parts(5002, 4), ...parts(5001, 11), ...parts(5006, 5)],
		'labels keep their own commas, and ratingKeys count');
	assert.deepStrictEqual(await ids('Lofi (audio, 10 items),'), parts(5002, 4), 'a comma left after a label');
	const smile = (lib) => addMusic(lib, 5704, 'Smile :)', 3);
	assert.deepStrictEqual(await ids('Smile :), Lofi', smile), ['pl:5704:1', ...parts(5002, 4)], 'a ")" with no "(" before it leaves the next comma splitting');
	// Read as one name, these name nothing, and the refusal says how several are written.
	const closest = 'Closest by name: `Boardwalk Bumps` and `Lofi`.';
	await assert.rejects(build({ playlist: 'Lofi, Boardwalk Bump' }), (err) => err.message === `No playlist called \`Lofi, Boardwalk Bump\`. ${closest} ${SEVERAL}`, 'a piece that only comes near');
	await assert.rejects(build({ playlist: 'Lofi, Boardwalk Bumps;' }), (err) => err.message === `No playlist called \`Lofi, Boardwalk Bumps\`. ${closest} ${SEVERAL}`, 'a ";" splits there instead');
	// An exact pair beats the nearest name for the whole.
	const fusion = (lib) => {
		addMusic(lib, 5701, 'Rock', 3);
		addMusic(lib, 5702, 'Jazz', 3);
		addMusic(lib, 5703, 'Rock Jazz Fusion', 3);
	};
	const pair = await build({ playlist: 'Rock, Jazz' }, fusion);
	assert.deepStrictEqual(entriesOf(pair.yaml).map((e) => e.id), ['pl:5701:1', 'pl:5702:1']);
	assert.ok(!pair.summary.warnings.some((w) => w.startsWith('Nearest')));
	const near = await build({ playlist: 'Rock Jazz' }, fusion);
	assert.deepStrictEqual(entriesOf(near.yaml).map((e) => e.id), ['pl:5703:1'], 'without the comma, the nearest name');
	// More than ten by their commas is the cap's refusal, ten are built.
	const eleven = (lib) => { for (let n = 1; n <= 11; n++) addMusic(lib, 5800 + n, `P${n}`, 3); };
	const names = Array.from({ length: 11 }, (_, n) => `P${n + 1}`);
	await assert.rejects(build({ playlist: names.join(', ') }, eleven), (err) => err.message === CAP);
	assert.strictEqual(entriesOf((await build({ playlist: names.slice(0, 10).join(', ') }, eleven)).yaml).length, 10);
});

test('a text split by commas may run past 200 characters, each piece at most 200, and a text without ";" too long says how several are written', async () => {
	const names = Array.from({ length: 10 }, (_, n) => `Long Playlist Name ${String(n + 1).padStart(2, '0')}`);
	const longs = (lib) => names.forEach((name, n) => addMusic(lib, 7501 + n, name, 3));
	const text = names.join(', ');
	assert.strictEqual(text.length, 228);
	const out = await build({ playlist: text }, longs);
	assert.deepStrictEqual(mixes(out.yaml), names.map((_, n) => 7501 + n));
	assert.strictEqual(listLine(out.yaml), `  list_playlist: "${names.join('; ')}"`);
	const file = readPlayerYaml(creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'\'', list_playlist: JSON.stringify(text) }));
	const fromFile = await setup(longs).builder.build({ ...file.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(mixes(fromFile.yaml), names.map((_, n) => 7501 + n), 'from a file too');
	const huge = `${'y'.repeat(201)}, Lofi`;
	assert.throws(() => validateParams({ name: 'Z', playlist: huge }), (err) => err.message === `playlist: \`${'y'.repeat(39)}${ELLIPSIS}\` is too long. ${SEVERAL}`);
	assert.throws(() => validateParams({ name: 'Z', playlist: `${huge};` }), (err) => err.message === `playlist: \`${'y'.repeat(39)}${ELLIPSIS}\` is too long.`, 'split at ";", the piece is one name');
});

test('at most ten playlists in one list, counted once each however they are written, and each piece at most 200 characters', async () => {
	const mixesOf = (lib) => { for (let n = 1; n <= 11; n++) addMusic(lib, 7400 + n, `Mix ${n}`, 3); };
	const ten = Array.from({ length: 10 }, (_, n) => `Mix ${n + 1}`);
	const once = await build({ playlist: [...ten, '7401', 'mix 1 (audio, 3 items)'].join('; ') }, mixesOf);
	assert.deepStrictEqual(mixes(once.yaml), ten.map((_, n) => 7401 + n), 'Mix 1 named three ways is one of ten');
	await assert.rejects(build({ playlist: [...ten, 'Mix 11'].join('; ') }, mixesOf), (err) => err.message === CAP);
	const fileOf = (playlist) => readPlayerYaml(creatorYaml({ list_preset: 'none', list_playlist: JSON.stringify(playlist) }));
	const eleven = fileOf([...ten, 'Mix 11'].join('; '));
	await assert.rejects(setup(mixesOf).builder.build({ ...eleven.params, accountId: 5, discordUserId: '42' }), (err) => err.message === CAP, 'from a file, naming no option');
	const twenty = Array.from({ length: 20 }, (_, n) => `Mix ${n + 1}`);
	assert.strictEqual(validateParams({ name: 'Z', playlist: twenty.join('; ') }).playlists.length, 20, 'twice the cap before Plex is read');
	assert.strictEqual(_internal.MAX_PLAYLIST_PIECES, 20);
	const many = [...twenty, 'Mix 21'].join('; ');
	assert.throws(() => validateParams({ name: 'Z', playlist: many }), (err) => err.message === 'playlist names 21 playlists, and a list takes at most 10.');
	assert.throws(() => fileOf(many), (err) => err.message === 'List: Playlist (`list_playlist`) names 21 playlists, and a list takes at most 10.');
	assert.strictEqual(validateParams({ name: 'Z', playlist: ' Lofi ;; Boardwalk Bumps ;' }).list.list_playlist, 'Lofi; Boardwalk Bumps', 'what a caller without Plex writes');
	const long = 'y'.repeat(201);
	assert.throws(() => validateParams({ name: 'Z', playlist: `Lofi; ${long}` }), (err) => err.message === `playlist: \`${'y'.repeat(39)}${ELLIPSIS}\` is too long.`);
	assert.throws(() => readPlayerYaml(creatorYaml({ list_playlist: JSON.stringify(long) })), (err) => err.message === `List: Playlist (\`list_playlist\`): \`${'y'.repeat(39)}${ELLIPSIS}\` is too long. ${SEVERAL}`);
	assert.strictEqual(validateParams({ name: 'Z', playlist: `${'y'.repeat(200)}; ${'z'.repeat(200)}` }).playlists.length, 2, 'the text may be longer than one name');
	// Only empty pieces name no playlist, as titles of only ";" name no title.
	assert.deepStrictEqual(validateParams({ name: 'Z', playlist: ' ; ;' }).playlists, []);
	assert.throws(() => validateParams({ name: 'Z', preset: 'none', playlist: ';' }), (err) => err.message === PICK_NOTHING);
	assert.strictEqual(validateParams({ name: 'Z', playlist: ';' }).counts.movies, 15, 'the default preset, as with no playlist');
});

test('the file\'s list_playlist reads back to the same playlists, a name that would not as its ratingKey', async () => {
	const out = await build({ playlist: 'lof; boardwalk bumps (audio, 33 items); 5006' });
	assert.strictEqual(listLine(out.yaml), '  list_playlist: "Lofi; Boardwalk Bumps; Interludes"');
	assert.ok(out.summary.warnings.includes('Nearest matches taken: "lof" as the playlist Lofi.'), out.summary.warnings.join(' | '));
	const again = readPlayerYaml(out.yaml);
	assert.strictEqual(again.params.playlist, 'Lofi; Boardwalk Bumps; Interludes');
	const rebuilt = await setup().builder.build({ ...again.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(entriesOf(rebuilt.yaml), entriesOf(out.yaml));
	assert.ok(!rebuilt.summary.warnings.some((w) => w.startsWith('Nearest')), 'read back by their names exactly');

	// A name holding ";", one of digits, one past 200 characters, and one another playlist shares.
	const odd = (lib) => {
		lib.playlists[5].title = 'Side A; Side B';
		lib.playlists[1].title = '1999';
		lib.playlists[4].title = `${'Long '.repeat(41)}Mix`;
		addMusic(lib, 5901, 'Boardwalk Bumps', 3);
	};
	const strange = await build({ playlist: '5006; 1999; Boardwalk Bumps; long mix' }, odd);
	assert.strictEqual(listLine(strange.yaml), '  list_playlist: "5006; 5002; 5001; 5005"');
	const read = readPlayerYaml(strange.yaml);
	const back = await setup(odd).builder.build({ ...read.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(entriesOf(back.yaml), entriesOf(strange.yaml));
	assert.strictEqual(listLine(back.yaml), listLine(strange.yaml));
	const shelf = [{ rk: 1, title: 'Lofi' }, { rk: 2, title: 'LOFI' }, { rk: 3, title: 'Lofi!' }, { rk: 4, title: 'Road, Trip' }, { rk: 5, title: 'Lo-fi' }, { rk: 6, title: HEART }, { rk: 7, title: '!!!' }];
	assert.strictEqual(_internal.playlistsText(shelf, [shelf[0], shelf[2], shelf[3], shelf[4], shelf[5]]), `1; 3; Road, Trip; Lo-fi; ${HEART}`,
		'case, and punctuation norm() drops, make a name shared; a dash is a space to it, so Lo-fi is its own, and a name it reads as nothing is found as written');
});

test('an Options Creator file names several playlists in List: Playlist as the command does: split by ;, by commas, or by their labels', async () => {
	const file = (playlist) => creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'\'', list_playlist: playlist });
	for (const playlist of ['\'Lofi; Boardwalk Bumps\'', '\'Lofi, Boardwalk Bumps\'', '\'Lofi (audio, 10 items); Boardwalk Bumps (audio, 33 items);\'']) {
		const read = readPlayerYaml(file(playlist));
		const out = await setup().builder.build({ ...read.params, accountId: 5, discordUserId: '42' });
		assert.deepStrictEqual(entriesOf(out.yaml).map((e) => e.id), [...parts(5002, 1), ...parts(5001, 3)], playlist);
		assert.deepStrictEqual(summaryHead(out.summary).slice(1, 3), ['`Lofi` is in 1 part of 10 songs, with one unlock.', '`Boardwalk Bumps` is in 3 parts of up to 15 songs, one unlock each.'], playlist);
		assert.strictEqual(listLine(out.yaml), '  list_playlist: "Lofi; Boardwalk Bumps"', playlist);
	}
	// A YAML list is Archipelago's random pick of one, and the refusal says how several are written.
	assert.throws(() => readPlayerYaml(file('[Lofi, Boardwalk Bumps]')),
		(err) => err.message === 'List: Playlist (`list_playlist`) is random: write it as one text, several names split by `;`, the bot needs it to pick titles.');
});

test('the reply gives five music playlists a line each and counts the rest', async () => {
	const fourMore = (lib) => { for (let n = 1; n <= 4; n++) addMusic(lib, 5950 + n, `Mix ${n}`, 3); };
	const out = await build({ playlist: 'Boardwalk Bumps; Lofi; Interludes; Mix 1; Mix 2; Mix 3; Mix 4; MCU Timeline', unwatched: false }, fourMore);
	assert.strictEqual(out.summary.playlists.length, 7, 'the video playlist has no line');
	const head = summaryHead(out.summary);
	assert.deepStrictEqual(head.slice(1, 7), [
		'`Boardwalk Bumps` opens 3 songs per unlock, in 11 parts.',
		'`Lofi` opens 3 songs per unlock, in 4 parts.',
		'`Interludes` opens 3 songs per unlock, in 5 parts.',
		'`Mix 1` is in 1 part of 3 songs, with one unlock.',
		'`Mix 2` is in 1 part of 3 songs, with one unlock.',
		'And 2 more playlists.',
	]);
	assert.match(head[7], /^Starts with /);
	const cut = { title: 'Road', parts: 2, songs: 3, tracks: 6 };
	const base = { entries: 12, counts: { mix: 12 }, locations: 36, hours: 1, hoursToGoal: 1, startOpen: 3, goalCount: 10, warnings: [], misses: [] };
	assert.strictEqual(summaryHead({ ...base, playlists: Array(6).fill(cut) })[6], 'And 1 more playlist.');
	assert.strictEqual(summaryHead({ ...base, playlists: Array(5).fill(cut) }).length, 8, 'five lines and no count');
	assert.strictEqual(_internal.PLAYLIST_LINES, 5);
});

test('the Creator tooltip and the world\'s pages say that several playlists are split by semicolons, ten at most', () => {
	const read = (...file) => fs.readFileSync(path.join(WORLD, ...file), 'utf8').replace(/\s+/g, ' ');
	const options = read('options.py');
	const tooltip = /class ListPlaylist\(FreeText\): """(.*?)"""/.exec(options)[1];
	assert.ok(tooltip.startsWith('The bot reads this when it fills in your titles (/apmedia yaml): Plex playlists by name, at most 10, split by '
		+ 'semicolons, as in Road Trip; Lofi. Each playlist\'s titles go on the list in its own order.'), tooltip);
	assert.ok(!/[a-z]+_[a-z_]+/.test(tooltip), 'a tooltip names settings as the Options Creator shows them');
	const songsPer = /class SongsPerUnlock\(OffRange\): """(.*?)"""/.exec(options)[1];
	assert.ok(songsPer.startsWith('How many songs of each music playlist in List: Playlist one unlock opens, in the playlist\'s order.'), songsPer);
	const game = read('docs', 'en_Plex Media.md');
	assert.ok(game.includes('| `list_playlist` | List: Playlist | empty | Plex playlists by name, split by `;`, at most 10 |'), 'the list settings table');
	const setupPage = read('docs', 'setup_en.md');
	assert.ok(/several playlists split by `;`/.test(setupPage), 'the setup page');
});
