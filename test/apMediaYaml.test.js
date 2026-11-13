// helpers/apMediaYaml.js: the Plex Media player YAML builder (spec 5.11): parameter checks, the
// unwatched rule, the three sources (hand-picked titles, a playlist or collection, random picks),
// music curation and album twins, books, the summary and caps, and the exact YAML layout.
//
// A YAML that AP's loader refuses stops the whole multiworld from generating, and a friend's list
// filtered by the owner's history hands them the wrong titles, so the layout is compared line for
// line, odd characters are run through it, and every history read is checked for the account it
// used. Two players' YAML file names must never collide in the owner's Players folder.
//
// A player's own YAML (readPlayerYaml): files shaped like the Archipelago Options Creator's export
// and like the bot's own, read the way PyYAML reads them and each value the way Archipelago's option
// classes read it; every refusal, a list the bot built before it saved its list settings among them;
// the empty documents Archipelago skips; what the command's options replace; the list settings and
// the copied settings written back; the limits that keep a crafted file from holding the main
// thread or blowing a reply up (repeated keys and aliases found in one pass, 64 K of settings, 32 KB
// of copied settings); a timer left random planned at its lowest roll; contracts.LIST_OPTIONS and
// PRESETS against apworld/plex_media/constants.py, and the choices' numbers against
// apworld/plex_media/options.py.
//
// Harness: the real createPms client over the fetch stand-in in
// test/fixtures/apmediaPlex/fakePms.js, serving the invented library in
// test/fixtures/apmediaPlex/library.js, with that file's catalog, longForm and bookmarks fakes, a
// fixed clock and a seeded random. No network. The mirror test loads constants.py alone in an
// isolated Python 3.13 (py -3.13 -I), never Archipelago, and skips when the py launcher is missing;
// the missing-package test runs the reader in a child Node that cannot resolve yaml.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createPms } = require('../helpers/apMediaPlex.js');
const { createBuilder, renderYaml, readPlayerYaml, summaryLines, validateParams, listDoc, ACCOUNT_FIX, PICK_NOTHING, FILE_MAX_BYTES, _internal } = require('../helpers/apMediaYaml.js');
const { planSlot } = require('../helpers/apMediaPlan.js');
const contracts = require('../helpers/apMediaContracts.js');
const { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks } = require('./fixtures/apmediaPlex/library.js');
const { createFakePlex } = require('./fixtures/apmediaPlex/fakePms.js');
const { creatorYaml } = require('./fixtures/apmedia/creatorYaml.js');

const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const TOKEN = 'FAKE-OWNER-TOKEN-0123456789';

function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function setup({ seed = 7, library = {}, mutate = null } = {}) {
	const lib = buildLibrary(library);
	if (mutate) mutate(lib);
	const plex = createFakePlex(lib);
	const pms = createPms({ loadConfig: () => ({ hostname: 'localhost', port: '32400', https: false, token: TOKEN, homeOwnerToken: '' }), fetchImpl: plex.fetch });
	const builder = createBuilder({
		pms,
		catalogStore: fakeCatalog(),
		longForm: fakeLongForm(lib),
		bookmarks: fakeBookmarks(),
		now: () => NOW_MS,
		random: seeded(seed),
	});
	return { lib, plex, builder };
}

// The checks apworld/plex_media/entries.py makes of each entry; a file failing one stops the seed.
function assertParses(e) {
	const int = (v) => Number.isInteger(v) && v >= 0;
	const intOrNull = (v) => v === null || int(v);
	const text = (v) => typeof v === 'string' && contracts.sanitizeText(v) !== '';
	const ident = (v) => typeof v === 'string' && v.trim() !== '';
	const where = JSON.stringify(e).slice(0, 80);
	assert.ok(contracts.KINDS.includes(e.k) && ident(e.id), where);
	assert.ok(e.g === undefined || ident(e.g), where);
	const tracks = (size, max) => {
		assert.ok(Array.isArray(e.tr) && e.tr.length >= 1 && e.tr.length <= max, where);
		for (const t of e.tr) {
			assert.ok(t.length >= size && int(t[0]) && intOrNull(t[1]) && text(t[2]) && int(t[3]) && intOrNull(t[4]), where);
			if (size === 6) assert.ok(text(t[5]), where);
		}
		assert.ok(e.tr.some((t) => t[3] >= contracts.LIMITS.minTrackMs), `${where}: no track of 30 s or more`);
	};
	if (e.k === 'movie') assert.ok(int(e.rk) && text(e.t) && intOrNull(e.y) && int(e.d), where);
	if (e.k === 'episode') assert.ok(int(e.rk) && text(e.t) && text(e.sh) && ident(e.sid) && int(e.srk) && int(e.sn) && int(e.en) && int(e.d), where);
	if (e.k === 'album') {
		assert.ok(int(e.rk) && text(e.ar) && text(e.t) && intOrNull(e.y) && int(e.d), where);
		tracks(5, Infinity);
		for (const [album, pairs] of e.alt || []) {
			assert.ok(intOrNull(album) && pairs.length === e.tr.length && pairs.every((x) => intOrNull(x[0]) && intOrNull(x[1])), where);
		}
	}
	if (e.k === 'mix') {
		assert.ok(int(e.pl) && Number.isInteger(e.part) && e.part >= 1 && e.id === `pl:${e.pl}:${e.part}` && text(e.t) && int(e.d), where);
		tracks(6, contracts.LIMITS.mixTracks);
	}
	if (e.k === 'book') {
		assert.ok(ident(e.w) && e.id === `book:${e.w}` && text(e.t) && text(e.au) && int(e.d), where);
		assert.ok(Array.isArray(e.pa) && e.pa.length >= 1 && e.pa.every((x) => intOrNull(x[0]) && intOrNull(x[1]) && int(x[2])), where);
	}
}

function entriesOf(yaml) {
	const entries = yaml.split('\n').filter((l) => l.startsWith('    - ')).map((l) => JSON.parse(l.slice(6)));
	entries.forEach(assertParses);
	assert.strictEqual(new Set(entries.map(contracts.entryKey)).size, entries.length, 'no entry twice');
	return entries;
}

function historyCalls(plex) {
	return plex.calls.filter((c) => c.path === '/status/sessions/history/all');
}

test('renderYaml writes the exact spec layout', () => {
	const created = NOW_MS / 1000;
	const yaml = renderYaml({
		name: 'Zack',
		label: "Zack's list",
		createdAt: created,
		listInfo: { account: 1, discord: '1234' },
		entries: [{ k: 'movie', id: 'plex://movie/abc', rk: 123, g: 'plex://movie/abc', t: 'The Matrix', y: 1999, d: 8160000 }],
	});
	assert.strictEqual(yaml, [
		"# Zack's list: Plex Media list built 2026-11-11 for Zack",
		'# 1 entry (1 movie), 9 locations, about 2.3 h; starts with 1 open; goal: finish 1 of 1',
		'name: "Zack"',
		'description: "Zack\'s list"',
		'game: Plex Media',
		'requires:',
		'  version: 0.6.8',
		'  game:',
		'    Plex Media: 0.2.0',
		'Plex Media:',
		'  starting_unlocks: 3',
		'  goal_percent: 80',
		'  tv_unlock: episodes',
		'  episodes_per_unlock: 3',
		'  locked_watches: bank',
		'  checkpoint_items: filler_only',
		'  timesanity_strict: false',
		'  timesanity_movies: 15',
		'  timesanity_episodes: 10',
		'  timesanity_albums: 0',
		'  timesanity_books: 30',
		'  wild_tickets: 2',
		'  list_preset: movies',
		'  list_movies: preset',
		'  list_shows: preset',
		'  list_albums: preset',
		'  list_books: preset',
		'  list_titles: ""',
		'  list_playlist: ""',
		'  list_collection: ""',
		'  list_genre: ""',
		'  list_years: ""',
		'  list_unwatched: true',
		'  list_max_episodes: 24',
		'  list_label: ""',
		`  list_info: {"builder":1,"created_at":${created},"label":"Zack's list","slot":"Zack","account":1,"discord":"1234"}`,
		'  entries:',
		'    - {"k":"movie","id":"plex://movie/abc","rk":123,"g":"plex://movie/abc","t":"The Matrix","y":1999,"d":8160000}',
		'',
	].join('\n'));
});

test('renderYaml cleans every string and writes nothing the AP YAML loader refuses', () => {
	const c = String.fromCharCode;
	const odd = `Quote "here": #1${c(0x85)}NEL${c(0x2028)}LS${c(0x2029)}PS\ttab${c(0xd800)}lone${c(0x7f)}del${c(0x9f)}c1${c(0xfffe)}${c(0xffff)}  end `;
	const yaml = renderYaml({
		name: `Zo${c(0xeb)} ${c(0xd83d, 0xde00)}`,
		label: `Label${c(0x2028)}two`,
		createdAt: 1794398400,
		options: { timesanity_movies: 0 },
		entries: [{ k: 'movie', id: 'rk:5', rk: 5, t: odd, y: null, d: 60000 }],
	});
	assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff\u2028\u2029]/u.test(yaml.replace(/[\ud83d][\ude00]/g, '')), 'no raw control, C1, surrogate, U+FFFE/FFFF or line separator');
	assert.ok(!/\\ud[89a-f]/i.test(yaml), 'no surrogate escapes either');
	const [entry] = entriesOf(yaml);
	assert.strictEqual(entry.t, 'Quote "here": #1 NEL LS PS tablonedelc1 end');
	assert.match(yaml, /\nname: "Zo\u00eb \ud83d\ude00"\n/u);
	assert.match(yaml, /\ndescription: "Label two"\n/);
	assert.match(yaml, /"t":"Quote \\"here\\": #1 NEL/);
});

test('renderYaml refuses a name AP would rewrite and orders each entry by kind', () => {
	assert.throws(() => renderYaml({ name: 'Archipelago', entries: [] }), /reserved/);
	assert.throws(() => renderYaml({ name: 'A%player%', entries: [] }), /\{, \} or %/);
	const yaml = renderYaml({
		name: 'Kim',
		createdAt: 1794398400,
		entries: [{ d: 1, t: 'Pilot', en: 1, sn: 1, srk: 7, sid: 'plex://show/x', sh: 'Show', rk: 70, id: 'plex://episode/y', k: 'episode', extra: 'kept' }],
	});
	assert.strictEqual(yaml.split('\n').find((l) => l.startsWith('    - ')),
		'    - {"k":"episode","id":"plex://episode/y","rk":70,"sh":"Show","sid":"plex://show/x","srk":7,"sn":1,"en":1,"t":"Pilot","d":1,"extra":"kept"}');
	assert.match(yaml, /^# Kim's list: /);
	assert.match(renderYaml({ name: 'Kim', createdAt: 1794398400, entries: [] }), /\n {2}entries: \[\]\n$/);
});

test('params: names, counts, presets, years, timers and unknown keys are checked in code', () => {
	const ok = (over) => validateParams({ name: 'Zack', ...over });
	assert.throws(() => ok({ name: '' }), /1 to 16/);
	assert.throws(() => ok({ name: 'ABCDEFGHIJKLMNOPQ' }), /at most 16/);
	assert.throws(() => ok({ name: ' Zack' }), /start or end/);
	assert.throws(() => ok({ name: 'Za{ck}' }), /\{, \} or %/);
	assert.throws(() => ok({ name: 'archipelago' }), /reserved/);
	assert.throws(() => ok({ movies: 201 }), /movies must be a whole number from 0 to 200/);
	assert.throws(() => ok({ shows: -1 }), /shows must be/);
	assert.throws(() => ok({ books: 'many' }), /books must be/);
	assert.throws(() => ok({ albums: 2.5 }), /albums must be/);
	assert.throws(() => ok({ maxEpisodes: 0 }), /maxEpisodes must be a whole number from 1 to 500/);
	assert.throws(() => ok({ preset: 'anime' }), /preset must be one of/);
	assert.throws(() => ok({ years: '19-20' }), /years must look like/);
	assert.throws(() => ok({ years: '2000-1990' }), /earliest first/);
	assert.throws(() => ok({ timeMovies: 241 }), /timeMovies must be a whole number from 0 to 240/);
	assert.throws(() => ok({ goalPercent: 0 }), /goalPercent/);
	assert.throws(() => ok({ tvUnlock: 'weekly' }), /tvUnlock must be one of: episodes, season/);
	assert.throws(() => ok({ unwatched: 'maybe' }), /unwatched must be true or false/);
	assert.throws(() => ok({ accountId: 'abc' }), /accountId/);
	assert.throws(() => ok({ titles: Array.from({ length: 51 }, (_, i) => `t${i}`).join(';') }), /at most 50/);
	assert.throws(() => ok({ titles: 'movie:  ' }), /names no title/);
	assert.throws(() => ok({ fooBar: 1 }), /Unknown option fooBar/);

	const p = ok({ timeBooks: 'off', tvUnlock: 'Season', unwatched: 'no', movies: '4', accountId: '5', strict: 'true', fooBar: undefined });
	assert.strictEqual(p.options.timesanity_books, 0);
	assert.strictEqual(p.options.tv_unlock, 'season');
	assert.strictEqual(p.options.timesanity_strict, true);
	assert.strictEqual(p.unwatched, false);
	assert.strictEqual(p.accountId, 5);
	assert.deepStrictEqual(p.counts, { movies: 4, shows: 0, albums: 0, books: 0 });
	assert.strictEqual(p.label, "Zack's list");
	assert.strictEqual(p.maxEpisodes, contracts.COUNT_RANGES.maxEpisodes.default);
});

test('discordUserId must be a Discord id, and list_info never carries a character the YAML loader refuses', () => {
	const c = String.fromCharCode;
	assert.throws(() => validateParams({ name: 'Z', discordUserId: `12${c(0x9f)}34` }), /discordUserId must be a Discord user id/);
	assert.throws(() => validateParams({ name: 'Z', discordUserId: '<@1234>' }), /discordUserId/);
	assert.throws(() => validateParams({ name: 'Z', discordUserId: 2 ** 60 }), /discordUserId/, 'a snowflake as a number has lost digits');
	assert.strictEqual(validateParams({ name: 'Z', discordUserId: ' 123456789012345678 ' }).discordUserId, '123456789012345678');
	assert.strictEqual(validateParams({ name: 'Z', discordUserId: 42 }).discordUserId, '42');

	const yaml = renderYaml({ name: 'Z', createdAt: 1794398400, listInfo: { account: 'x', discord: `42${c(0x9f)}${c(0xfffe)}${c(0x2028)}` }, entries: [] });
	const line = yaml.split('\n').find((l) => l.startsWith('  list_info: '));
	assert.deepStrictEqual(JSON.parse(line.slice('  list_info: '.length)), { builder: 1, created_at: 1794398400, label: "Z's list", slot: 'Z', account: null, discord: '42' });
	const refused = [...yaml].filter((ch) => {
		const n = ch.codePointAt(0);
		return (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || n === 0xfffe || n === 0xffff;
	});
	assert.deepStrictEqual(refused, []);
	assert.match(renderYaml({ name: 'Z', createdAt: 1794398400, listInfo: { discord: c(0x2028) }, entries: [] }), /"discord":null\}/);
});

test('presets: nothing asked means 15 movies; a preset fills the counts not given; titles alone add no random picks', () => {
	assert.deepStrictEqual(validateParams({ name: 'Z' }).counts, { movies: 15, shows: 0, albums: 0, books: 0 });
	assert.deepStrictEqual(validateParams({ name: 'Z', preset: 'mixed', movies: 10 }).counts, { movies: 10, shows: 1, albums: 4, books: 1 });
	assert.deepStrictEqual(validateParams({ name: 'Z', titles: 'Alien' }).counts, { movies: 0, shows: 0, albums: 0, books: 0 });
	assert.deepStrictEqual(validateParams({ name: 'Z', albums: 3 }).counts, { movies: 0, shows: 0, albums: 3, books: 0 });
});

test('unwatched video picks without a Plex account fail with the fix, before Plex is read', async () => {
	const { builder, plex } = setup();
	await assert.rejects(builder.build({ name: 'Friend' }), (err) => err.message === ACCOUNT_FIX);
	await assert.rejects(builder.build({ name: 'Friend', shows: 1 }), /\/apmedia account @you <plex name>/);
	await assert.rejects(builder.build({ name: 'Friend', collection: 'Alien Collection' }), /unwatched=false/);
	assert.strictEqual(plex.calls.length, 0);
	await assert.rejects(builder.build({ name: 'Friend', playlist: 'MCU Timeline' }), /\/apmedia account/);
	assert.strictEqual(historyCalls(plex).length, 0);
});

test('unwatched=false builds without any history read; music and books need no account', async () => {
	const { builder, plex } = setup();
	const movies = await builder.build({ name: 'Friend', movies: 3, unwatched: false });
	assert.strictEqual(entriesOf(movies.yaml).length, 3);
	const music = await builder.build({ name: 'Friend', albums: 1, books: 1, discordUserId: '42' });
	assert.strictEqual(entriesOf(music.yaml).length, 2);
	assert.strictEqual(historyCalls(plex).length, 0);
});

test('the default list is 15 unwatched movies from that account only; the owner history is never read for a friend', async () => {
	const { builder, plex } = setup();
	const out = await builder.build({ name: 'Friend', accountId: 5 });
	const entries = entriesOf(out.yaml);
	assert.strictEqual(entries.length, 15);
	assert.ok(entries.every((e) => e.k === 'movie'));
	const rks = entries.map((e) => e.rk);
	assert.ok(!rks.includes(1001), 'Alien is in account 5 history');
	assert.ok(!rks.includes(1020), 'a movie with no duration is not a random pick');
	const calls = historyCalls(plex);
	assert.ok(calls.length > 0);
	assert.ok(calls.every((c) => c.query.accountID === '5'));
	assert.ok(plex.calls.every((c) => c.token === TOKEN && !c.url.includes(TOKEN)), 'the token travels only as a header');

	const all = await setup().builder.build({ name: 'Friend', accountId: 5, movies: 200 });
	const allRks = entriesOf(all.yaml).map((e) => e.rk).sort((a, b) => a - b);
	assert.ok(allRks.includes(1002), 'Aliens is only in the owner history, so the friend still gets it');
	assert.strictEqual(allRks.length, 18);
	assert.ok(all.summary.warnings.includes('Only 18 of 200 movies fit the filters.'));
	const local = entriesOf(all.yaml).find((e) => e.rk === 1019);
	assert.deepStrictEqual(local, { k: 'movie', id: 'rk:1019', rk: 1019, g: 'local://1019', t: 'Home Video', y: 2015, d: 2700000 });
});

test('a random show starts at the first unwatched regular episode, skips later watched ones and leaves specials out', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Friend', accountId: 5, shows: 1, years: '2008', maxEpisodes: 5 });
	const entries = entriesOf(out.yaml);
	assert.deepStrictEqual(entries.map((e) => `S${e.sn}E${e.en}`), ['S1E3', 'S1E5', 'S1E6', 'S1E7', 'S2E1']);
	assert.deepStrictEqual(entries[0], {
		k: 'episode', id: 'plex://episode/2001-1-3', rk: 200105, g: 'plex://episode/2001-1-3', sh: 'Breaking Bad',
		sid: 'plex://show/s2001', srk: 2001, sn: 1, en: 3, t: 'Episode Title 1x3', d: 48 * 60000,
	});
	await assert.rejects(setup().builder.build({ name: 'Friend', accountId: 5, shows: 1, years: '2010' }), /Nothing on the list/);
});

test('albums: matched, 3 to 40 tracks with 3 of 30 s or more, no placeholders or books; twins become alt', async () => {
	const { builder, plex, lib } = setup();
	const out = await builder.build({ name: 'Ears', albums: 10 });
	const albums = entriesOf(out.yaml);
	assert.deepStrictEqual(albums.map((a) => a.id).sort(), ['mbid://kob', 'plex://album/abbey', 'plex://album/disc', 'plex://album/ram']);
	assert.ok(out.summary.warnings.includes('Only 4 of 10 albums fit the filters.'));

	const disc = albums.find((a) => a.id === 'plex://album/disc');
	assert.strictEqual(disc.rk, 3001, 'equal copies: the lower ratingKey is kept');
	assert.deepStrictEqual(disc.tr[0], [300101, 1, 'Discovery Song 1', 320000, 700101]);
	assert.strictEqual(disc.d, (320 + 212 + 301 + 230) * 1000);
	assert.deepStrictEqual(disc.alt, [[3002, [[300201, 700201], [300202, 700202], [300203, 700203], [300204, 700204]]]]);

	const ram = albums.find((a) => a.id === 'plex://album/ram');
	assert.strictEqual(ram.rk, 3010, 'the copy with more tracks wins');
	assert.strictEqual(ram.tr.length, 6);
	assert.strictEqual(ram.alt, undefined, 'a copy with a different track count is no twin');

	const listing = plex.calls.find((c) => c.path === '/library/sections/1/all');
	assert.strictEqual(listing.query['album.id!'], '3007', 'the album listing carries the book exclusion');
	const fetched = plex.calls.filter((c) => /\/children$/.test(c.path)).map((c) => c.path.split('/')[3]);
	for (const never of ['3005', '3006', '3007', '3014', '3015', '3016']) assert.ok(!fetched.includes(never), `album ${never} is never opened`);

	const albumRow = (rk) => lib.albums.find((a) => a.ratingKey === rk);
	for (const rk of ['3005', '3014', '3015', '3016']) assert.ok(_internal.isPlaceholderAlbum(albumRow(rk)), `album ${rk} is a placeholder`);
	assert.ok(!_internal.isPlaceholderAlbum(albumRow('3001')));
});

test('album genre filters by tag; a movie genre filters on the server by its key', async () => {
	const { builder, plex } = setup();
	const music = await builder.build({ name: 'Ears', albums: 5, genre: 'electronic' });
	assert.deepStrictEqual(entriesOf(music.yaml).map((a) => a.id).sort(), ['plex://album/disc', 'plex://album/ram']);

	const horror = await builder.build({ name: 'Friend', accountId: 5, movies: 5, genre: 'Horror' });
	assert.deepStrictEqual(entriesOf(horror.yaml).map((e) => e.rk).sort(), [1002, 1003, 1012]);
	assert.ok(plex.calls.some((c) => c.path === '/library/sections/3/all' && c.query.genre === '10'));

	const western = setup().builder.build({ name: 'Friend', accountId: 5, movies: 5, genre: 'Western' });
	await assert.rejects(western, /Nothing on the list/);
});

test('books: catalog works of kind book, finished ones left out through their alias, podcasts only by hand', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Reader', books: 3, discordUserId: '42' });
	const books = entriesOf(out.yaml);
	assert.deepStrictEqual(books.map((b) => b.w).sort(), ['b/second', 'c/third']);
	assert.ok(out.summary.warnings.includes('Only 2 of 3 books fit the filters.'));
	const third = books.find((b) => b.w === 'c/third');
	assert.deepStrictEqual(third, { k: 'book', id: 'book:c/third', w: 'c/third', t: 'Third Book', au: 'Unknown author', d: 1800000, pa: [[70021, 80021, 1800000]] });

	const again = await setup().builder.build({ name: 'Reader', books: 5, discordUserId: '42', unwatched: false });
	const glass = entriesOf(again.yaml).find((b) => b.w === 'avery-quill/the-glass-road');
	assert.deepStrictEqual(glass.pa, [[70001, 80001, 3600000], [70002, 80002, 5400000]], 'parts in play order');
	assert.strictEqual(glass.d, 9000000);
	assert.ok(!entriesOf(again.yaml).some((b) => b.w === 'pod/cast'));
	const years = await setup().builder.build({ name: 'Reader', books: 2, years: '1990-1999', discordUserId: '42', unwatched: false });
	assert.ok(years.summary.warnings.includes('The years filter does not apply to books.'), years.summary.warnings.join(' | '));
});

test('hand-picked titles: prefixes, years, season ranges, albums by artist, books, misses with suggestions', async () => {
	const { builder } = setup();
	const out = await builder.build({
		name: 'Picker',
		accountId: 5,
		discordUserId: '42',
		titles: 'Alien; movie: Aliens (1986); show: Breaking Bad S2; album: Daft Punk - Discovery; book: Glass Road; The Podcast; Alein; zzzz qqqq',
	});
	const entries = entriesOf(out.yaml);
	assert.deepStrictEqual(entries.slice(0, 2).map((e) => e.rk), [1001, 1002], 'hand-picks are not filtered by unwatched');
	const eps = entries.filter((e) => e.k === 'episode');
	assert.strictEqual(eps.length, 13);
	assert.ok(eps.every((e) => e.sn === 2));
	const disc = entries.find((e) => e.k === 'album');
	assert.strictEqual(disc.id, 'plex://album/disc');
	assert.ok(disc.alt);
	assert.deepStrictEqual(entries.filter((e) => e.k === 'book').map((e) => e.w), ['avery-quill/the-glass-road', 'pod/cast']);
	assert.deepStrictEqual(out.summary.misses, [
		{ query: 'Alein', didYouMean: ['Alien (1979)', 'Alien 3 (1992)'] },
		{ query: 'zzzz qqqq', didYouMean: [] },
	]);
	assert.strictEqual(entries.length, 2 + 13 + 1 + 2);
});

// The bug: once the listings were read, every hand-pick ran on promises alone, so 50 misses scored
// against the whole library held the event loop (timers, voice frames) for seconds in one stretch.
test('each hand-pick gives the event loop a turn before it is matched', async () => {
	const lib = buildLibrary({});
	const plex = createFakePlex(lib);
	const catalog = fakeCatalog();
	let turns = 0;
	let ticking = true;
	const tickOn = () => {
		turns += 1;
		if (ticking) setImmediate(tickOn);
	};
	const seen = [];
	const findWorks = catalog.findWorks;
	catalog.findWorks = (text) => {
		seen.push(turns);
		return findWorks(text);
	};
	const builder = createBuilder({
		pms: createPms({ loadConfig: () => ({ hostname: 'localhost', port: '32400', https: false, token: TOKEN, homeOwnerToken: '' }), fetchImpl: plex.fetch }),
		catalogStore: catalog,
		longForm: fakeLongForm(lib),
		bookmarks: fakeBookmarks(),
		now: () => NOW_MS,
		random: seeded(7),
	});
	const misses = Array.from({ length: 6 }, (_, i) => `zzqq nothing ${i}`);
	setImmediate(tickOn);
	try {
		const out = await builder.build({ name: 'Turns', unwatched: false, titles: ['Alien', ...misses].join('; ') });
		assert.strictEqual(out.summary.misses.length, 6);
	} finally {
		ticking = false;
	}
	assert.strictEqual(seen.length, 6, 'one catalog lookup per miss');
	for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `a turn between miss ${i} and miss ${i + 1}: ${seen.join(', ')}`);
});

test('counts are totals: hand-picked titles count toward them, and the account is needed only for the random rest', async () => {
	const three = await setup().builder.build({ name: 'Picker', accountId: 5, titles: 'Alien; Aliens', movies: 3 });
	const rks = entriesOf(three.yaml).map((e) => e.rk);
	assert.strictEqual(rks.length, 3);
	assert.deepStrictEqual(rks.slice(0, 2), [1001, 1002]);

	const covered = setup();
	const two = await covered.builder.build({ name: 'Picker', titles: 'Alien; Aliens', movies: 2 });
	assert.strictEqual(entriesOf(two.yaml).length, 2);
	assert.strictEqual(historyCalls(covered.plex).length, 0);

	await assert.rejects(setup().builder.build({ name: 'Picker', titles: 'Alien', movies: 2 }), (err) => err.message === ACCOUNT_FIX);

	const books = entriesOf((await setup().builder.build({ name: 'Reader', titles: 'book: The Podcast', books: 2, discordUserId: '42' })).yaml);
	assert.strictEqual(books.length, 2);
	assert.strictEqual(books[0].w, 'pod/cast');
	assert.ok(['b/second', 'c/third'].includes(books[1].w), 'one random book makes two, and not the finished one');
});

test('a hand-picked show without seasons is a run from the first unwatched episode; specials come only by asking', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Picker', accountId: 5, titles: 'show: Breaking Bad; show: Breaking Bad S0', maxEpisodes: 3 });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => `S${e.sn}E${e.en}`), ['S1E3', 'S1E5', 'S1E6', 'S0E1', 'S0E2']);

	const local = await setup().builder.build({ name: 'Picker', titles: 'show: Local Show', unwatched: false });
	const first = entriesOf(local.yaml)[0];
	assert.strictEqual(first.id, 'rk:200201', 'an unmatched episode keys by ratingKey');
	assert.strictEqual(first.sid, 'rk:2002');
	assert.deepStrictEqual(local.summary.warnings, ['Almost everything starts open: fewer than 2 unlocks are left for the multiworld to find.']);

	const noAccount = await setup().builder.build({ name: 'Picker', titles: 'show: Breaking Bad', maxEpisodes: 2 });
	assert.deepStrictEqual(entriesOf(noAccount.yaml).map((e) => `S${e.sn}E${e.en}`), ['S1E1', 'S1E2']);
	assert.ok(noAccount.summary.warnings.includes('Breaking Bad starts at its first episode: the bot knows nothing you have watched.'));

	// Watched to the end, a show named without seasons was found and is left out, and the reply says how to keep it.
	const done = 'Watched Show: every episode has been watched, so it was left out. To keep it, name its seasons (show: Watched Show S1) or turn unwatched off.';
	const watched = await setup().builder.build({ name: 'Picker', accountId: 5, titles: 'show: Watched Show; Alien' });
	assert.deepStrictEqual([entriesOf(watched.yaml).map((e) => e.t), watched.summary.misses, watched.summary.warnings.includes(done)], [['Alien'], [], true]);
	await assert.rejects(setup().builder.build({ name: 'Picker', accountId: 5, titles: 'show: Watched Show' }),
		(err) => err.message === 'Nothing on the list: nothing in the library fits these settings.' && err.warnings.includes(done));
	const seasons = await setup().builder.build({ name: 'Picker', accountId: 5, titles: 'show: Watched Show S1' });
	assert.strictEqual(entriesOf(seasons.yaml).length, 3, 'named with its seasons it stays whole');
});

test('an audio playlist becomes mixes of at most 15 tracks, book parts left out', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Ears', playlist: 'boardwalk bumps' });
	const mixes = entriesOf(out.yaml);
	assert.deepStrictEqual(mixes.map((m) => [m.id, m.part, m.t, m.tr.length]), [
		['pl:5001:1', 1, 'Boardwalk Bumps Part 1', 15],
		['pl:5001:2', 2, 'Boardwalk Bumps Part 2', 15],
		['pl:5001:3', 3, 'Boardwalk Bumps Part 3', 2],
	]);
	assert.deepStrictEqual(mixes[0].tr[0], [51001, 1, 'Bump 1', 150000, 451001, 'Artist 0']);
	assert.deepStrictEqual(mixes[2].tr[1], [51032, 32, 'Bump 32', 181000, 451032, 'Artist 1']);
	assert.ok(mixes.flatMap((m) => m.tr).every((t) => t[0] !== 59999));
	assert.ok(out.summary.warnings.includes('1 audiobook part in Boardwalk Bumps were left out.'));
	assert.strictEqual(mixes[0].d, mixes[0].tr.reduce((n, t) => n + t[3], 0));

	const lofi = await setup().builder.build({ name: 'Ears', playlist: '5002' });
	assert.deepStrictEqual(entriesOf(lofi.yaml).map((m) => [m.id, m.t]), [['pl:5002:1', 'Lofi']]);
	await assert.rejects(setup().builder.build({ name: 'Ears', playlist: 'Beach Photos' }), /No playlist called `Beach Photos`\. Playlists: /);
});

test('a playlist part of only short tracks, or a hand-picked album of them, is left out rather than breaking the seed', async () => {
	const out = await setup().builder.build({ name: 'Ears', playlist: 'Interludes' });
	assert.deepStrictEqual(entriesOf(out.yaml).map((m) => [m.id, m.t, m.tr.length]), [['pl:5006:1', 'Interludes', 15]]);
	assert.ok(out.summary.warnings.includes('3 short tracks of Interludes were left out: a part needs one track of 30 s or more.'));

	const picked = await setup().builder.build({ name: 'Ears', titles: 'album: Skits; album: Kind of Blue' });
	assert.deepStrictEqual(entriesOf(picked.yaml).map((e) => e.id), ['mbid://kob']);
	assert.deepStrictEqual(picked.summary.misses, [{ query: 'album: Skits', didYouMean: [] }]);
	assert.ok(picked.summary.warnings.includes('Comedian - Skits has nothing that fits.'));
});

test('a library-sized smart playlist is read only as far as the list can use', async () => {
	const audio = setup({ library: { bigAudioPlaylist: 5000 } });
	const built = await audio.builder.build({ name: 'Ears', playlist: 'Everything Ever' });
	const mixes = entriesOf(built.yaml);
	assert.strictEqual(mixes.length, 40);
	assert.ok(mixes.every((m) => m.tr.length === 15));
	assert.deepStrictEqual(mixes[39].tr[14].slice(0, 3), [600600, 600, 'Song 600']);
	const audioReads = audio.plex.calls.filter((c) => c.path === '/playlists/5007/items');
	assert.deepStrictEqual(audioReads.map((c) => c.query['X-Plex-Container-Start']), ['0', '300', '600', '900'], '1200 of 5000 tracks');
	assert.ok(built.summary.warnings.includes('Everything Ever has 5000 tracks; only the first 600 were used.'));

	const video = setup({ library: { bigVideoPlaylist: 2700 } });
	const out = await video.builder.build({ name: 'Films', playlist: 'Every Movie', unwatched: false });
	assert.strictEqual(entriesOf(out.yaml).length, 200);
	assert.strictEqual(video.plex.calls.filter((c) => c.path === '/playlists/5008/items').length, 7, '2000 of 2700 items, not 9 pages');
	assert.ok(out.summary.warnings.includes('The playlist Every Movie is long: only its first 200 movies and 50 shows were used.'));
	assert.ok(out.summary.warnings.includes('The playlist Every Movie has 2700 items; only the first 2000 were read.'));
});

test('a video playlist keeps its order, drops watched items and keeps its specials', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Friend', accountId: 5, playlist: 'MCU Timeline' });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => [e.k, e.rk]), [['movie', 1004], ['episode', 200105], ['episode', 200101]]);
	const ep = entriesOf(out.yaml)[1];
	assert.strictEqual(ep.sid, 'plex://show/s2001');
	assert.strictEqual(ep.sh, 'Breaking Bad');

	const all = await setup().builder.build({ name: 'Friend', playlist: 'MCU Timeline', unwatched: false });
	assert.deepStrictEqual(entriesOf(all.yaml).map((e) => e.rk), [1004, 200105, 1001, 200101]);
});

test('a playlist or collection episode with no show ratingKey is left out with a warning, not written as "srk":null', async () => {
	const showless = (lib) => {
		const ep = { ...lib.leaves[2003][5] };
		delete ep.grandparentRatingKey;
		return ep;
	};
	const playlist = setup({ mutate: (lib) => { lib.playlistItems[5003] = [...lib.playlistItems[5003], showless(lib)]; } });
	const out = await playlist.builder.build({ name: 'Friend', playlist: 'MCU Timeline', unwatched: false });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => e.rk), [1004, 200105, 1001, 200101]);
	assert.ok(out.summary.warnings.includes('The playlist MCU Timeline: 1 episode was left out because Plex did not say which show it is from.'), out.summary.warnings.join('\n'));

	const collection = setup({
		mutate: (lib) => {
			const zero = { ...lib.leaves[2003][6], grandparentRatingKey: '0' };
			lib.collectionItems[6002] = [...lib.collectionItems[6002], showless(lib), zero];
		},
	});
	const shows = await collection.builder.build({ name: 'Friend', collection: 'Space Shows', maxEpisodes: 2, unwatched: false });
	assert.deepStrictEqual(entriesOf(shows.yaml).map((e) => [e.srk, e.en]), [[2003, 1], [2003, 2]]);
	assert.ok(shows.summary.warnings.includes('The collection Space Shows: 2 episodes were left out because Plex did not say which show they are from.'), shows.summary.warnings.join('\n'));
});

test('a playlist whose title is empty once cleaned is called "Playlist <rk>", since a mix needs a title', async () => {
	const c = String.fromCharCode;
	const { builder } = setup({ mutate: (lib) => { lib.playlists[1].title = `${c(0x2028)} ${c(0x85)}\t`; } });
	const out = await builder.build({ name: 'Ears', playlist: '5002' });
	assert.deepStrictEqual(entriesOf(out.yaml).map((m) => [m.id, m.t]), [['pl:5002:1', 'Playlist 5002']]);
	assert.deepStrictEqual((await builder.playlists('playlist')).map((x) => [x.rk, x.title]), [[5002, 'Playlist 5002']]);
});

test('collections: movies in order minus watched ones; shows become episode runs', async () => {
	const { builder } = setup();
	const movies = await builder.build({ name: 'Friend', accountId: 5, collection: 'alien collection' });
	assert.deepStrictEqual(entriesOf(movies.yaml).map((e) => e.rk), [1002, 1003]);
	const shows = await setup().builder.build({ name: 'Friend', accountId: 5, collection: 'Space Shows', maxEpisodes: 4 });
	assert.deepStrictEqual(entriesOf(shows.yaml).map((e) => [e.sh, e.en]), [['Cosmos', 1], ['Cosmos', 2], ['Cosmos', 3], ['Cosmos', 4]]);
	await assert.rejects(setup().builder.build({ name: 'Friend', accountId: 5, collection: 'Nope Nothing' }), /No movie or TV collection called `Nope Nothing`\. Some collections: /);
});

test('random picks of different kinds interleave, so a mixed list opens with one of each', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Mixed', accountId: 5, discordUserId: '42', movies: 2, albums: 2, books: 1 });
	assert.deepStrictEqual(entriesOf(out.yaml).map((e) => e.k), ['movie', 'album', 'book', 'movie', 'album']);
	assert.strictEqual(out.summary.startOpen, 3);
});

test('the summary matches the plan of the written entries', async () => {
	const { builder } = setup();
	const out = await builder.build({ name: 'Zack', preset: 'mixed', accountId: 5, discordUserId: '42', goalPercent: 50, timeEpisodes: 5 });
	const entries = entriesOf(out.yaml);
	const plan = planSlot(entries, { goal_percent: 50, timesanity_episodes: 5 });
	const s = out.summary;
	assert.deepStrictEqual(s.counts, plan.counts);
	assert.strictEqual(s.entries, entries.length);
	assert.strictEqual(s.locations, plan.locations);
	assert.strictEqual(s.copies, plan.C);
	assert.strictEqual(s.startCopies, plan.S);
	assert.strictEqual(s.wildTickets, plan.W);
	assert.strictEqual(s.startOpen, plan.startOpen);
	assert.strictEqual(s.goalCount, plan.goal_count);
	assert.strictEqual(s.hours, Math.round(plan.hours * 10) / 10);
	assert.match(out.yaml, /\n {2}goal_percent: 50\n/);
	assert.match(out.yaml, /\n {2}timesanity_episodes: 5\n/);
	assert.match(out.yaml, new RegExp(`^# Zack's list: Plex Media list built 2026-11-11 for Zack\\n# ${entries.length} entries \\(`));
	assert.strictEqual(out.fileName, 'Zack.yaml');
	const lines = summaryLines(s, 'Zack');
	assert.ok(lines.some((l) => l.includes('`/apmedia link Zack`')));
	assert.ok(lines.some((l) => /visible to the whole room/.test(l)));
});

test('a list over the caps is refused with its counts; big lists get warnings', async () => {
	const huge = setup({ library: { hugeShowEpisodes: 2100 } });
	await assert.rejects(huge.builder.build({ name: 'Binge', titles: 'show: Huge Show S1' }), /too big for one slot: 2100 entries \(at most 2000\)/);

	// 26 checkpoints a minute apart before 90% of each 30-minute episode, plus its watch.
	const timed = setup({ library: { hugeShowEpisodes: 1900 } });
	await assert.rejects(timed.builder.build({ name: 'Binge', titles: 'show: Huge Show S1', timeEpisodes: 1, episodesPerUnlock: 12 }),
		/too big for one slot: 1900 entries \(at most 2000\), 159 unlock copies \(at most 2000\), 51300 locations \(at most 10000\)\. Lower the counts or the episodes per show, raise the episodes per unlock, or turn the timers down\.$/,
		'the settings in words every path knows, not the builder\'s param names');

	const big = setup({ library: { hugeShowEpisodes: 700 } });
	const out = await big.builder.build({ name: 'Binge', titles: 'show: Huge Show S1', episodesPerUnlock: 1, timeEpisodes: 5 });
	assert.strictEqual(out.summary.copies, 700);
	assert.deepStrictEqual(out.summary.warnings, [
		'700 unlock copies: above 600, generating the seed gets slow.',
		'4200 locations: above 1500, that is a very long list.',
		'About 280 h to the goal (more than 50 h).',
	]);
	assert.strictEqual(out.summary.startCopies, 14, 'ceil(700 / 50)');
});

test('a list that is nearly all open says so; season mode with one-season shows says so', async () => {
	const { builder } = setup();
	const one = await builder.build({ name: 'Solo', titles: 'Alien', accountId: 5 });
	assert.ok(one.summary.warnings.some((w) => /fewer than 2 unlocks/.test(w)));
	const season = await setup().builder.build({ name: 'Seasons', titles: 'show: Cosmos S1', tvUnlock: 'season' });
	assert.ok(season.summary.warnings.some((w) => /Season mode: 1 show is one season/.test(w)));
});

test('the same seed builds the same file', async () => {
	const a = await setup({ seed: 99 }).builder.build({ name: 'Zack', preset: 'mixed', accountId: 5, discordUserId: '42' });
	const b = await setup({ seed: 99 }).builder.build({ name: 'Zack', preset: 'mixed', accountId: 5, discordUserId: '42' });
	assert.strictEqual(a.yaml, b.yaml);
	const c = await setup({ seed: 100 }).builder.build({ name: 'Zack', preset: 'mixed', accountId: 5, discordUserId: '42' });
	assert.notStrictEqual(a.yaml, c.yaml);
});

test('nothing found is an error that names the misses', async () => {
	await assert.rejects(setup().builder.build({ name: 'Zack', titles: 'qqqq; wwww' }), /^Error: Nothing on the list: no title matched what was asked for\. Not found: `qqqq`, `wwww`\.$/);
});

test('a list the filters leave empty says so, with the warnings that name the filter', async () => {
	await assert.rejects(setup().builder.build({ name: 'Zack', preset: 'none', movies: 3, shows: 1, genre: 'Polka', unwatched: false }), (err) => {
		assert.strictEqual(err.message, 'Nothing on the list: nothing in the library fits these settings.');
		assert.ok(err.warnings.includes('Movies has no Polka genre.'), err.warnings.join(' | '));
		assert.ok(err.warnings.some((w) => /^Only 0 of 3 movies fit the filters\.$/.test(w)), err.warnings.join(' | '));
		return true;
	});
});

test('a name that matched only the nearest title is said back; a name of random takes only a title of that name', async () => {
	const out = await setup().builder.build({ name: 'Zack', titles: 'Alie; Aliens', playlist: 'lof', unwatched: false });
	assert.ok(out.summary.warnings.includes('Nearest matches taken: "Alie" as Alien (1979); "lof" as the playlist Lofi.'), out.summary.warnings.join(' | '));
	// Ten are named, so 50 near matches cannot fill the reply.
	const many = await setup().builder.build({ name: 'Zack', titles: 'Alie; Matr; Incep; Arriv; Padd; Hot F; Zodi; Grav; Paddingt; Incepti; Arriva; Zodia', unwatched: false });
	const nearest = many.summary.warnings.find((w) => w.startsWith('Nearest matches taken: '));
	assert.match(nearest, /^Nearest matches taken: (?:"[^"]+" as [^;]+; ){10}and 2 more\.$/, nearest);
	// Random Access Memories and a playlist called Random Hits start with the word, and are not taken for it.
	const random = setup({ mutate: (lib) => { lib.playlists[1].title = 'Random Hits'; } }).builder;
	await assert.rejects(random.build({ name: 'Zack', titles: 'random', unwatched: false }), /^Error: Nothing on the list: no title matched what was asked for\. Not found: `random`\.$/);
	await assert.rejects(random.build({ name: 'Zack', preset: 'none', playlist: 'Random', unwatched: false }), /^Error: No playlist called `Random`\. Playlists: .*Random Hits/);
	const near = await random.build({ name: 'Zack', preset: 'none', playlist: 'random h', unwatched: false });
	assert.ok(near.summary.warnings.includes('Nearest matches taken: "random h" as the playlist Random Hits.'), 'more than the word is a name like any other');
	const exact = await random.build({ name: 'Zack', preset: 'none', playlist: 'random hits', unwatched: false });
	assert.ok(exact.summary.counts.mix >= 1 && !exact.summary.warnings.some((w) => w.startsWith('Nearest')), 'a name equal to the title is no near match');
	const lowlights = setup({ mutate: (lib) => { lib.playlists[1].title = 'Random Lowlights'; } }).builder;
	await assert.rejects(lowlights.build({ name: 'Zack', preset: 'none', playlist: 'random-low', unwatched: false }), /^Error: No playlist called `random-low`\./, 'random- is the word too');
	const lows = await lowlights.build({ name: 'Zack', preset: 'none', playlist: 'rand low', unwatched: false });
	assert.ok(lows.summary.warnings.includes('Nearest matches taken: "rand low" as the playlist Random Lowlights.'), 'which other words would match');

	// Long titles are named only as far as about 900 characters go, so the misses still fit the reply.
	const { LOOSE_CHARS } = _internal;
	const long = setup({ mutate: (lib) => { for (const m of lib.movies) m.title = `${m.title} ${'y'.repeat(150)}`; } }).builder;
	const longOut = await long.build({ name: 'Zack', titles: 'Inception; Arrival; Paddington; Zodiac; Gravity; Moon; Jaws; Heat', unwatched: false });
	const longLine = longOut.summary.warnings.find((w) => w.startsWith('Nearest matches taken: '));
	const named = (longLine.match(/" as /g) || []).length;
	assert.ok(named >= 1 && named < 8 && longLine.length < LOOSE_CHARS + 200, longLine);
	assert.ok(longLine.endsWith(`; and ${8 - named} more.`), longLine);
});

test('an empty list\'s refusal names ten titles that were not found and counts the rest', async () => {
	const { MISSES_SHOWN } = _internal;
	assert.strictEqual(MISSES_SHOWN, 10);
	const titles = Array.from({ length: 50 }, (_, i) => `qqqq${i}`);
	await assert.rejects(setup().builder.build({ name: 'Zack', titles: titles.join('; '), unwatched: false }), (err) => {
		assert.strictEqual(err.message, `Nothing on the list: no title matched what was asked for. Not found: ${titles.slice(0, 10).map((t) => `\`${t}\``).join(', ')} and 40 more.`);
		return true;
	});
	await assert.rejects(setup().builder.build({ name: 'Zack', titles: titles.slice(0, 10).join('; '), unwatched: false }), /Not found: `qqqq0`, .*`qqqq9`\.$/, 'ten are named whole');
	await assert.rejects(setup().builder.build({ name: 'Zack', titles: titles.slice(0, 11).join('; '), unwatched: false }), /Not found: `qqqq0`, .*`qqqq9` and 1 more\.$/, 'the eleventh is counted');
});

test('playlists lists audio and video playlists by prefix, then contains, from a short-lived cache', async () => {
	const { builder, plex } = setup();
	assert.deepStrictEqual(builder.cachedPlaylists('b'), [], 'nothing cached yet');
	const hits = await builder.playlists('b');
	assert.deepStrictEqual(hits.map((x) => x.title), ['Boardwalk Bumps']);
	assert.deepStrictEqual((await builder.playlists('')).map((x) => x.title), ['Boardwalk Bumps', 'Lofi', 'MCU Timeline', 'All Music', 'Interludes']);
	assert.deepStrictEqual((await builder.playlists('music')).map((x) => [x.title, x.smart, x.type]), [['All Music', true, 'audio']]);
	assert.deepStrictEqual(builder.cachedPlaylists('mcu').map((x) => [x.rk, x.type, x.items]), [[5003, 'video', 4]]);
	assert.strictEqual(plex.calls.filter((c) => c.path === '/playlists').length, 1);
});

test('file names keep letters of any script; a name that had to change gets a hash of its spelling', () => {
	const katakana = String.fromCharCode(0x30bc, 0x30eb, 0x30c0);
	assert.strictEqual(_internal.safeFileName('Zack'), 'Zack.yaml');
	assert.strictEqual(_internal.safeFileName(katakana), `${katakana}.yaml`);
	assert.match(_internal.safeFileName('Zack M.'), /^Zack_M-[0-9a-f]{8}\.yaml$/);
	assert.match(_internal.safeFileName(String.fromCharCode(0xd83d, 0xde00)), /^plex-media-[0-9a-f]{8}\.yaml$/);
	assert.match(_internal.safeFileName('CON'), /^CON-[0-9a-f]{8}\.yaml$/);
	assert.match(_internal.safeFileName('nul.txt'), /^nul_txt-[0-9a-f]{8}\.yaml$/);
});

test('two different slot names never share a YAML file in the Players folder, and none is a Windows device', () => {
	const c = String.fromCharCode;
	const file = _internal.safeFileName;
	const names = [
		'Zack', 'zack', 'Zack M', 'Zack_M', 'Zack?M', 'Zack M.', '_Zack', 'Zack_', 'Zo', 'Zo!', 'Zo?',
		`Zo${c(0xeb)}`, `Zo${c(0xe9)}`, `Zoe${c(0x308)}`, `ZO${c(0xcb)}`,
		c(0x30bc, 0x30eb, 0x30c0), c(0x30bc, 0x30eb), c(0x6771, 0x4eac), c(0x5317, 0x4eac),
		c(0xd83d, 0xde00), c(0xd83d, 0xde01), c(0x2764, 0xfe0f), c(0x2b50, 0xfe0f), '!!!', '???',
		'CON', 'con', 'Nul', 'nul.txt', 'aux.', 'COM1', 'lpt9', `COM${c(0xb9)}`, 'PRN.x.y', 'con.Zack',
		'Zo-1a2b3c4d', 'Zo-1A2B3C4D',
	];
	// A friend could type another name's file name back as their own slot name.
	names.push(file('Zo!').slice(0, -'.yaml'.length));
	const files = names.map(file);
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			assert.notStrictEqual(files[i], files[j], `${JSON.stringify(names[i])} and ${JSON.stringify(names[j])}`);
			// Windows ignores case in file names; AP refuses two slot names that differ only in case.
			if (names[i].toLowerCase() !== names[j].toLowerCase()) {
				assert.notStrictEqual(files[i].toLowerCase(), files[j].toLowerCase(), `${JSON.stringify(names[i])} and ${JSON.stringify(names[j])} ignoring case`);
			}
		}
	}
	for (const f of files) {
		assert.match(f, /^[\p{L}\p{N}-][\p{L}\p{N}._-]*\.yaml$/u, f);
		assert.ok(!/^(?:con|prn|aux|nul|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3])$/i.test(f.split('.')[0]), f);
	}
	assert.deepStrictEqual(names.map(file), files, 'the same name always gives the same file');
});

test('title matching: exact beats prefix beats words; articles and accents do not matter', () => {
	const { matchScore, parseTitle } = _internal;
	assert.strictEqual(matchScore('alien', 'Alien'), 100);
	assert.strictEqual(matchScore('matrix', 'The Matrix'), 95);
	assert.strictEqual(matchScore('alien', 'Alien 3'), 80);
	assert.strictEqual(matchScore('random memories', 'Random Access Memories'), 60);
	assert.strictEqual(matchScore('amelie', `Am${String.fromCharCode(0xe9)}lie`), 100);
	assert.strictEqual(matchScore('alein', 'Alien'), 0);
	assert.deepStrictEqual(parseTitle('show: Breaking Bad S1-2'), { query: 'show: Breaking Bad S1-2', text: 'Breaking Bad', kind: 'show', seasons: [1, 2], year: null });
	assert.deepStrictEqual(parseTitle('Alien (1979)'), { query: 'Alien (1979)', text: 'Alien', kind: null, seasons: null, year: 1979 });
	assert.deepStrictEqual(parseTitle('BOOK: Dune (1965)'), { query: 'BOOK: Dune (1965)', text: 'Dune (1965)', kind: 'book', seasons: null, year: null });
});

// ---- a player's own YAML ------------------------------------------------------------------------

// The lines under "Plex Media:" that are settings: not list_info, the entries or an entry.
function settingLines(yaml) {
	const lines = yaml.split('\n');
	return lines.slice(lines.indexOf('Plex Media:') + 1).filter((l) => l && !/^ {2}(?:list_info|entries):/.test(l) && !l.startsWith('    - '));
}

const CREATOR_PARAMS = Object.freeze({
	name: 'Zack', preset: 'mixed', movies: 6, shows: 2, albums: 4, books: 1, titles: 'Alien; Aliens', unwatched: true, maxEpisodes: 24,
	startingUnlocks: 3, tvUnlock: 'episodes', episodesPerUnlock: 3, lockedWatches: 'bank', checkpointItems: 'filler_only', strict: false,
	timeMovies: 15, timeEpisodes: 10, timeAlbums: 0, timeBooks: 30, wildTickets: 2,
});
const CREATOR_KEPT = Object.freeze([
	['progression_balancing', 50], ['accessibility', 'full'], ['goal_percent', 'random'], ['local_items', []], ['non_local_items', []],
	['start_inventory', new Map()], ['start_hints', []], ['start_location_hints', []], ['exclude_locations', []], ['priority_locations', []],
]);

test('an Options Creator YAML: the list settings become params, a random game option and every other setting are kept in file order', async () => {
	const read = readPlayerYaml(creatorYaml());
	assert.deepStrictEqual(read, {
		name: 'Zack',
		params: { ...CREATOR_PARAMS, passthrough: CREATOR_KEPT.map((pair) => [...pair]) },
		passthrough: CREATOR_KEPT.map((pair) => [...pair]),
		random: ['goal_percent'],
		entriesCount: 0,
	});

	const out = await setup().builder.build({ ...read.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(settingLines(out.yaml), [
		'  starting_unlocks: 3',
		'  goal_percent: "random"',
		'  tv_unlock: episodes',
		'  episodes_per_unlock: 3',
		'  locked_watches: bank',
		'  checkpoint_items: filler_only',
		'  timesanity_strict: false',
		'  timesanity_movies: 15',
		'  timesanity_episodes: 10',
		'  timesanity_albums: 0',
		'  timesanity_books: 30',
		'  wild_tickets: 2',
		'  list_preset: mixed',
		'  list_movies: preset',
		'  list_shows: 2',
		'  list_albums: preset',
		'  list_books: preset',
		'  list_titles: "Alien; Aliens"',
		'  list_playlist: ""',
		'  list_collection: ""',
		'  list_genre: ""',
		'  list_years: ""',
		'  list_unwatched: true',
		'  list_max_episodes: 24',
		'  list_label: ""',
		'  progression_balancing: 50',
		'  accessibility: "full"',
		'  local_items: []',
		'  non_local_items: []',
		'  start_inventory: {}',
		'  start_hints: []',
		'  start_location_hints: []',
		'  exclude_locations: []',
		'  priority_locations: []',
	]);
	const entries = entriesOf(out.yaml);
	assert.deepStrictEqual(entries.slice(0, 2).map((e) => e.rk), [1001, 1002], 'the titles the file named come first');
	assert.strictEqual(out.summary.goalCount, planSlot(entries, {}).goal_count, 'a random goal_percent is planned at its default');
	assert.strictEqual(out.yaml.split('\n')[2], '# goal_percent stays random until Archipelago rolls it: the line above plans it at 80', 'and the file says so');
	const two = renderYaml({ name: 'Z', createdAt: 1794398400, entries: [], passthrough: [['goal_percent', 'random'], ['tv_unlock', 'random']] });
	assert.strictEqual(two.split('\n')[2], '# goal_percent and tv_unlock stay random until Archipelago rolls them: the line above plans them at 80 and episodes');
});

test('a count at preset or -1 follows list_preset, none makes it 0 and a number stays; a file without list settings asks for 15 movies', () => {
	const counts = (over) => {
		const p = readPlayerYaml(creatorYaml({ list_titles: '\'\'', ...over })).params;
		return [p.preset, p.movies, p.shows, p.albums, p.books];
	};
	assert.deepStrictEqual(counts({ list_preset: 'tv', list_movies: '-1', list_shows: 'preset' }), ['tv', 0, 3, 0, 0]);
	assert.deepStrictEqual(counts({ list_preset: 'none', list_shows: '5' }), ['none', 0, 5, 0, 0]);
	assert.deepStrictEqual(counts({ list_preset: 'MUSIC', list_shows: 'PRESET', list_books: '\'2\'' }), ['music', 0, 0, 10, 2], 'Archipelago lowercases a name and reads a quoted number');
	assert.deepStrictEqual(counts({ list_preset: undefined, list_shows: undefined }), ['movies', 15, 0, 0, 0], 'a missing setting is its default');

	const bare = readPlayerYaml(['name: Kim', 'game: Plex Media', 'Plex Media:', '  goal_percent: 70', ''].join('\n'));
	assert.deepStrictEqual(bare.params, { name: 'Kim', preset: 'movies', movies: 15, shows: 0, albums: 0, books: 0, unwatched: true, maxEpisodes: 24, goalPercent: 70, passthrough: [] });
	assert.deepStrictEqual(readPlayerYaml('name: Kim\ngame: Plex Media\nPlex Media:\n').params.movies, 15, 'an empty Plex Media: is all defaults');
});

test('readPlayerYaml refuses what it cannot use, saying which setting and how to fix it', () => {
	const refuses = (text, expected, what = String(expected)) => assert.throws(() => readPlayerYaml(text), (err) => {
		if (typeof expected === 'string') assert.strictEqual(err.message, expected, what);
		else assert.match(err.message, expected, what);
		return true;
	}, what);
	const ellipsis = String.fromCharCode(0x2026);
	const aliases = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x${i}`, '*h']));

	refuses('', 'The file is empty: attach the YAML the Options Creator saved.');
	refuses('# a comment and nothing else\n', /^The file is empty/);
	refuses(`${creatorYaml()}---\nname: Ben\ngame: Plex Media\nPlex Media: {}\n`, 'The file holds 2 YAML documents (split by ---), and the bot takes one player per file.');
	refuses('- a\n- b\n', 'The file is not a player YAML: it needs name, game and Plex Media at the top.');
	refuses('x'.repeat(FILE_MAX_BYTES + 1), 'The file is over 8 MB, the most the bot reads.');
	refuses(creatorYaml().replace('  wild_tickets: 2', '  wild_tickets: 2\n  wild_tickets: 3'), 'The file could not be read at line 26: a key is given twice.');
	refuses(creatorYaml().replace('  wild_tickets: 2', '\twild_tickets: 2'), /^The file could not be read at line 25: /);
	// Archipelago's loader refuses a key beside its "+" twin in any mapping. It compares Python's str()
	// of each key with the text keys before it, so 1 after "+1" clashes and "+1" after 1 does not.
	refuses(creatorYaml({ '+local_items': '[Wild Ticket]' }), 'The file could not be read at line 39: it gives both `local_items` and `+local_items`, which Archipelago refuses together.');
	refuses(creatorYaml({ start_inventory: '{"+Wild Ticket": 1, Wild Ticket: 1}' }), 'The file could not be read at line 34: it gives both `+Wild Ticket` and `Wild Ticket`, which Archipelago refuses together.');
	refuses(creatorYaml({ blob: '{"+1": a, 1: b}' }), 'The file could not be read at line 39: it gives both `+1` and `1`, which Archipelago refuses together.');
	refuses(creatorYaml({ blob: '{"+True": a, yes: b}' }), 'The file could not be read at line 39: it gives both `+True` and `yes`, which Archipelago refuses together.');
	for (const blob of ['{1: a, "+1": b}', '{"+1": a, 1.0: b}']) {
		assert.strictEqual(readPlayerYaml(creatorYaml({ blob })).passthrough.length, 11, `Archipelago reads ${blob}`);
	}
	// Generate.roll_settings stops the whole seed on a + or - setting outside triggers.
	const triggersOnly = (key) => `\`${key}\` starts with ${key[0]}, which Archipelago takes only inside triggers, and here it stops the whole seed: `
		+ 'write the setting without it, or take it out of the file.';
	refuses(creatorYaml({ local_items: undefined, '+local_items': '[Wild Ticket]' }), triggersOnly('+local_items'));
	refuses(creatorYaml({ '-local_items': '[Wild Ticket]' }), triggersOnly('-local_items'));
	refuses(creatorYaml({ '+entries': '[]' }), triggersOnly('+entries'), 'the + form of a setting the bot writes');
	refuses(creatorYaml({ goal_percent: undefined, '+goal_percent': '50' }), triggersOnly('+goal_percent'));
	refuses(creatorYaml({ '-account': '1' }), triggersOnly('-account'), 'the + and - come first');
	assert.ok(readPlayerYaml(creatorYaml({ triggers: '[{option_category: Plex Media, option_name: wild_tickets, option_result: 3, options: {Plex Media: {+local_items: [Popcorn]}}}]' }))
		.passthrough.some(([key]) => key === 'triggers'), 'inside triggers a + key is Archipelago\'s to merge');
	refuses(creatorYaml({ accessibility: '!!python/name:os.system full' }), /^The file could not be read at line \d+: it uses a !tag the bot does not read\.$/);
	refuses(creatorYaml({ start_hints: '&h [Popcorn]', ...aliases }), 'The file repeats values through aliases (*name) more than 20 times: write them out instead.');
	assert.strictEqual(readPlayerYaml(creatorYaml({ start_hints: '&h [Popcorn]', ...Object.fromEntries(Object.entries(aliases).slice(1)) })).name, 'Zack', '20 aliases are fine');
	// The package caps the uses of each anchor only, and resolves each alias by walking every anchor
	// before it, so the bot counts aliases over the whole file.
	const distinct = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [[`a${i}`, `&x${i} ${i}`], [`b${i}`, `*x${i}`]]).flat());
	refuses(creatorYaml(distinct(21)), 'The file repeats values through aliases (*name) more than 20 times: write them out instead.', '21 anchors, each used once');
	assert.strictEqual(readPlayerYaml(creatorYaml(distinct(20))).passthrough.length, 10 + 40, '20 anchors used once each are fine');
	// 13 aliases in all, but x1 holds two uses of x0 and is used 11 times: 22 copies of x0.
	const nested = { a: '&x0 1', b: '&x1 [*x0, *x0]', ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`c${i}`, '*x1'])) };
	refuses(creatorYaml(nested), 'The file repeats values through aliases (*name) more than 20 times: write them out instead.', 'a repeat inside a repeat');
	refuses(creatorYaml({ blob: '*nope' }), 'The file could not be read at line 39: the alias `*nope` has no anchor `&nope` above it.');
	refuses(creatorYaml({ a: '*x', b: '&x 1' }), 'The file could not be read at line 39: the alias `*x` has no anchor `&x` above it.', 'an anchor after its alias');
	refuses(creatorYaml({ a: '*`<@&1>`' }), /^The file could not be read at line 39: the alias `\*'<@&1>'` has no anchor `&'<@&1>'` above it\.$/, 'an alias name is shown as code');
	refuses(creatorYaml({ '""': '4' }), 'The Plex Media settings have a setting with no name: take that line out.');

	refuses(creatorYaml({}, { top: ['A Link to the Past: {}'] }), 'The file has `A Link to the Past` at the top, and the bot takes one player per file: name, description, game, requires and Plex Media only.');
	refuses(creatorYaml({}, { top: ['triggers: []'] }), /^The file has `triggers` at the top/);
	refuses(creatorYaml().replace('game: Plex Media', 'game:\n  Plex Media: 1\n  Clique: 1'), 'The file picks its game at random: set game: Plex Media.');
	refuses(creatorYaml().replace('game: Plex Media', 'game: Clique'), 'The file\'s game is `Clique`, and the bot fills in Plex Media lists only.');
	// Another game's file, from the Options Creator or a template, has that game's settings at the top too.
	const finder = ['name: Finder', 'description: YAML generated by Archipelago 0.6.8.', 'game: ChecksFinder', 'ChecksFinder:', '  progression_balancing: 50', ''].join('\n');
	refuses(finder, 'The file\'s game is `ChecksFinder`, and the bot fills in Plex Media lists only.', 'another game with its own settings');
	refuses(creatorYaml({}, { top: ['Clique: {}'] }).replace('game: Plex Media', 'game:\n  Plex Media: 1\n  Clique: 1'), 'The file picks its game at random: set game: Plex Media.', 'a weighted game with both games\' settings');
	refuses(creatorYaml().replace('game: Plex Media', 'game: "*x* `y` <@&1>"'), 'The file\'s game is `*x* \'y\' <@&1>`, and the bot fills in Plex Media lists only.');
	refuses(creatorYaml().replace('game: Plex Media\n', ''), 'The file names no game: set game: Plex Media.');
	refuses('name: Zack\ngame: Plex Media\n', 'The file has no Plex Media settings: save it again from the Options Creator.');
	refuses('name: Zack\ngame: Plex Media\nPlex Media: 5\n', 'The file\'s Plex Media: needs its settings under it, one per line, as the Options Creator writes them.');
	refuses('name: Zack\ngame: Plex Media\nPlex Media:\n  50: 1\n', 'The Plex Media settings have `50` where a setting name goes.');

	refuses(creatorYaml().replace('name: Zack\n', ''), 'The file has no name: give the slot one with the name option.');
	refuses(creatorYaml({}, { name: '\'\'' }), 'The file has no name: give the slot one with the name option.');
	refuses(creatorYaml({}, { name: '' }), 'The file has no name: give the slot one with the name option.');
	refuses(creatorYaml({}, { name: '123' }), 'The name in the file is not text: give the slot one with the name option.');
	refuses(creatorYaml({}, { name: '\'Za{ck}\'' }), 'The name cannot contain {, } or %. That is the name in the file: give the slot another with the name option.');
	refuses(creatorYaml({}, { name: 'ABCDEFGHIJKLMNOPQ' }), /^The name can be at most 16 characters.*That is the name in the file/);

	refuses(creatorYaml({ list_movies: 'random' }), 'List: Movies (`list_movies`) is random: set a number, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_shows: 'random-range-1-5' }), 'List: Shows (`list_shows`) is random: set a number, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_max_episodes: 'random-high' }), 'List: Episodes per Show (`list_max_episodes`) is random: set a number, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_preset: 'random' }), 'List: Preset (`list_preset`) is random: choose one, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_preset: '{movies: 1, tv: 1}' }), 'List: Preset (`list_preset`) is random: choose one, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_unwatched: 'random' }), 'List: Unwatched Only (`list_unwatched`) is random: set true or false, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_titles: '[Alien, Heat]' }), 'List: Titles (`list_titles`) is random: write it as one text, the bot needs it to pick titles.');
	// Archipelago never rolls a plain text setting, so random there is a name, as it is on the command.
	assert.strictEqual(readPlayerYaml(creatorYaml({ list_playlist: 'Random' })).params.playlist, 'Random');
	assert.strictEqual(validateParams({ name: 'Z', playlist: 'Random' }).playlist, 'Random');
	assert.strictEqual(readPlayerYaml(creatorYaml({ list_collection: '\'random-access memories\'' })).params.collection, 'random-access memories');
	refuses(creatorYaml({ list_playlist: '{Rock: 1, Jazz: 1}' }), 'List: Playlist (`list_playlist`) is random: write it as one text, the bot needs it to pick titles.');
	refuses(creatorYaml({ list_movies: '201' }), 'List: Movies (`list_movies`) must be a whole number from 0 to 200 or preset.');
	refuses(creatorYaml({ list_movies: '2.5' }), 'List: Movies (`list_movies`) must be a whole number from 0 to 200 or preset.');
	refuses(creatorYaml({ list_max_episodes: '0' }), 'List: Episodes per Show (`list_max_episodes`) must be a whole number from 1 to 500.');
	refuses(creatorYaml({ list_preset: 'anime' }), 'List: Preset (`list_preset`) must be one of: movies, tv, music, books, mixed, none.');
	refuses(creatorYaml({ list_unwatched: 'maybe' }), 'List: Unwatched Only (`list_unwatched`) must be true or false.');
	refuses(creatorYaml({ list_years: 'nineties' }), 'List: Years (`list_years`) must look like 1990 or 1990-1999.');
	refuses(creatorYaml({ list_titles: 'yes' }), 'List: Titles (`list_titles`) must be text: put it in quotes.');
	refuses(creatorYaml({ list_titles: `'${Array.from({ length: 51 }, (_, i) => `t${i}`).join(';')}'` }), 'List: Titles (`list_titles`) can name at most 50 titles.');
	refuses(creatorYaml({ list_genre: `'${'g'.repeat(61)}'` }), 'List: Genre (`list_genre`) can be at most 60 characters.');

	refuses(creatorYaml({ goal_percent: '150' }), 'Goal Percent (`goal_percent`) must be a whole number from 1 to 100.');
	// Archipelago reads a few more random-range spellings than the bot, such as random-range-x-1-5.
	refuses(creatorYaml({ goal_percent: 'random-often' }), 'Goal Percent (`goal_percent`) is `random-often`, which the bot does not read: random, random-low, random-middle, random-high or random-range-<min>-<max> picks at random.');
	refuses(creatorYaml({ goal_percent: 'random-range-x-1-5' }), /^Goal Percent \(`goal_percent`\) is `random-range-x-1-5`, which the bot does not read: /);
	refuses(creatorYaml({ tv_unlock: 'weekly' }), 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');
	refuses(creatorYaml({ tv_unlock: 'random-low' }), 'TV Unlock (`tv_unlock`) is `random-low`, which Archipelago does not read: random picks at random.');
	// An unquoted off is false in YAML 1.1. The world's timers read false as 0 whatever their default,
	// and true as their default only where that is not 0; a quoted "no" is text, which they refuse.
	for (const word of ['off', 'Off', 'no', 'false', '"false"']) {
		assert.strictEqual(readPlayerYaml(creatorYaml({ timesanity_albums: word })).params.timeAlbums, 0, `timesanity_albums: ${word}`);
	}
	for (const word of ['true', 'on', '"no"']) {
		refuses(creatorYaml({ timesanity_albums: word }), 'Timesanity: Albums (`timesanity_albums`) must be a whole number from 0 to 240 or off.', `timesanity_albums: ${word}`);
	}
	refuses(creatorYaml({ timesanity_strict: 'sometimes' }), 'Timesanity Strict (`timesanity_strict`) must be true or false.');

	refuses(creatorYaml({ account: '5' }), '`account` is filled in by the bot from the linked Plex account: take it out of the file.');
	refuses(creatorYaml({ accountId: '5' }), '`accountId` is filled in by the bot from the linked Plex account: take it out of the file.');
	refuses(creatorYaml({ discord: '1' }), '`discord` is filled in by the bot with the Discord id of the person the list is for: take it out of the file.');
	refuses(creatorYaml({ Discord_User_Id: '1' }), '`Discord_User_Id` is filled in by the bot with the Discord id of the person the list is for: take it out of the file.');
	refuses(creatorYaml({ plando_items: '2026-11-12' }), '`plando_items` holds a value the bot cannot copy (a date, a set or binary data): write it as text, numbers, lists or mappings.');
	refuses(creatorYaml({ progression_balancing: '9007199254740993' }), '`progression_balancing` holds a number too large for the bot to copy exactly: write a smaller one.');
	refuses(creatorYaml({ [`k${'k'.repeat(99)}`]: '2026-11-12' }), new RegExp(`^\`${'k'.repeat(59)}${ellipsis}\` holds a value`), 'a long key is cut short in the message');

	refuses(creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'\'' }), PICK_NOTHING);
	refuses(creatorYaml({ list_movies: '0', list_shows: '0', list_albums: '0', list_books: '0', list_titles: '\'\'' }), PICK_NOTHING);
	assert.strictEqual(PICK_NOTHING, 'Your list settings pick nothing: choose a preset, set a count, or name titles, a playlist or a collection.');
});

test('scalars read the way PyYAML reads them, so a copied value means to Archipelago what it meant in the file', () => {
	const read = readPlayerYaml(creatorYaml({
		timesanity_movies: 'off',
		timesanity_books: 'true',
		wild_tickets: '0x2',
		episodes_per_unlock: '1_2',
		starting_unlocks: '010',
		goal_percent: '1:10',
		list_years: '1999',
		list_max_episodes: '\'12\'',
		tv_unlock: '{episodes: 1, season: 2}',
		checkpoint_items: '[filler_only, anything]',
		notes: '[n, y, 1e5, 1.5e+3, .5, 0b11, ~, On, 07, 09, 2026-1-5]',
	}, { name: 'n' }));
	assert.strictEqual(read.name, 'n', 'n is text to PyYAML, not false');
	const p = read.params;
	assert.deepStrictEqual([p.timeMovies, p.timeBooks, p.wildTickets, p.episodesPerUnlock, p.startingUnlocks, p.goalPercent, p.years, p.maxEpisodes],
		[0, 30, 2, 12, 8, 70, '1999', 12]);
	const notes = read.passthrough.find(([key]) => key === 'notes')[1];
	assert.deepStrictEqual(notes, ['n', 'y', '1e5', new _internal.PyFloat(1500), 0.5, 3, null, true, 7, '09', '2026-1-5']);
	assert.strictEqual(_internal.flowValue(notes, '`notes`'), '["n", "y", "1e5", 1500.0, 0.5, 3, null, true, 7, "09", "2026-1-5"]', '1.5e+3 stays a float');
	assert.deepStrictEqual(read.random, ['tv_unlock', 'checkpoint_items'], 'weights, and a list Archipelago picks from, stay the game\'s to roll');
	assert.deepStrictEqual([p.tvUnlock, p.checkpointItems], [undefined, undefined]);
	assert.strictEqual(readPlayerYaml(`${String.fromCharCode(0xfeff)}${creatorYaml()}`).name, 'Zack', 'a byte order mark in front is no part of the file');
});

test('a lone CR ends a line, as it does for Archipelago; a raw NEL, U+2028, U+2029 or control character is refused by its line', () => {
	const c = String.fromCharCode;
	const lf = readPlayerYaml(creatorYaml());
	assert.deepStrictEqual(readPlayerYaml(creatorYaml().replace(/\n/g, '\r')), lf, 'CR only, as an old Mac file has');
	assert.deepStrictEqual(readPlayerYaml(creatorYaml().replace(/\n/g, '\r\r\n')), lf, 'CR CR LF, as a doubled conversion leaves');
	const hints = readPlayerYaml(`${creatorYaml({ start_hints: undefined })}  # my hints\r  start_hints: [Wild Ticket]\n`).passthrough;
	assert.deepStrictEqual(hints.find(([key]) => key === 'start_hints'), ['start_hints', ['Wild Ticket']], 'after a CR in a comment comes a setting');
	const hex = (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
	for (const code of [0x85, 0x2028, 0x2029]) {
		const broken = `The file could not be read at line 39: it holds an invisible line break (${hex(code)}), which Archipelago would split the line at: delete it.`;
		assert.throws(() => readPlayerYaml(`${creatorYaml()}  notes: "a${c(code)}b"\n`), (err) => err.message === broken, hex(code));
		assert.throws(() => readPlayerYaml(`${creatorYaml()}  # a note${c(code)}  extra: 1\n`), (err) => err.message === broken, `${hex(code)} in a comment`);
	}
	for (const code of [0x07, 0x1b, 0x7f, 0x9f, 0xfffe, 0xffff]) {
		const refused = `The file could not be read at line 39: it holds an invisible control character (${hex(code)}), which Archipelago refuses: delete it.`;
		assert.throws(() => readPlayerYaml(`${creatorYaml()}  notes: "a${c(code)}b"\n`), (err) => err.message === refused, hex(code));
	}
	const escaped = readPlayerYaml(`${creatorYaml()}  notes: "a${c(92)}u0085b${c(92)}Lc"\n`).passthrough;
	assert.deepStrictEqual(escaped.find(([key]) => key === 'notes'), ['notes', `a${c(0x85)}b${c(0x2028)}c`], 'written as an escape, each is the character');
});

test('keys repeat and meet their "+" twins as Archipelago\'s loader has them: true is 1, an alias key is the key it names, null is None, 1.0 stays a float', () => {
	const { parsePlayerFile, flowValue, yamlKey } = _internal;
	const refuses = (text, message, what) => assert.throws(() => readPlayerYaml(text), (err) => {
		assert.strictEqual(err.message, message, what);
		return true;
	}, what);
	const twice = (line) => `The file could not be read at line ${line}: a key is given twice.`;
	const twins = (line, a, b) => `The file could not be read at line ${line}: it gives both \`${a}\` and \`${b}\`, which Archipelago refuses together.`;
	const head = 'name: Zack\ngame: Plex Media\nPlex Media:\n';
	const parses = (blob) => assert.ok(parsePlayerFile(`${head}  blob: ${blob}\n`) instanceof Map, blob);

	// A Python dict holds True and 1, False, 0 and 0.0, and every null as one key. PyYAML makes every
	// .nan one shared float, which a dict finds by itself, and two equal dates are one key too.
	refuses(creatorYaml({ timesanity_albums: '{off: 1, 0: 1, 30: 2}' }), twice(30), 'a weighted timer with off and 0');
	// Those keys are told apart for one file at a time: a key kept in the global symbol registry would
	// stay in the bot's memory for as long as it runs, one for every big number or date anyone sends.
	const registry = Symbol.for;
	let registered = 0;
	Symbol.for = (key) => {
		if (/^(?:int |date |nan$)/.test(String(key))) registered += 1;
		return registry(key);
	};
	try {
		refuses(creatorYaml({ blob: '{12345678901234567890: a, 1.0e+30: b, 2001-01-01: c, .nan: d, .NaN: e}' }), twice(39), 'one .nan repeats the other');
		refuses(creatorYaml({ blob: '{1152921504606846976: a, 1152921504606846976.0: b}' }), twice(39), 'a big float repeats the int it equals');
		refuses(creatorYaml({ blob: '{2001-01-01: a, 2001-01-01: b}' }), twice(39), 'two equal dates');
	} finally {
		Symbol.for = registry;
	}
	assert.strictEqual(registered, 0);
	for (const blob of ['{1: a, yes: b}', '{true: a, 1.0: b}', '{false: a, 0.0: b}', '{~: a, null: b}', '{.nan: 1, .NaN: 2}', '{2001-01-31: a, 2001-01-31: b}']) {
		refuses(creatorYaml({ blob }), twice(39), blob);
	}
	for (const blob of ['{off: 1, "0": 1}', '{true: 1, false: 1}', '{.nan: 1, .inf: 2}', '{1: a, "+1": b}', '{"+1": a, 1.0: b}', '{~: a, "+None": b}', '{1.0: a, "+1.0": b}',
		'{2001-01-31: a, 2001-01-30: b}', '{2001-01-31: a, "2001-01-31": b}']) parses(blob);
	// Python compares ints past 2**53 by their exact digits, and a float of the same whole value equals the int.
	parses('{12345678901234567890: a, 12345678901234567891: b}');
	assert.throws(() => parsePlayerFile(`${head}  blob: {12345678901234567890: a, 12345678901234567890: b}\n`), (err) => err.message === twice(4));
	assert.throws(() => parsePlayerFile(`${head}  blob: {9007199254740992: a, 9007199254740992.0: b}\n`), (err) => err.message === twice(4), 'a float past 2**53 equals its int');
	parses('{9007199254740993: a, 9007199254740992.0: b}');
	assert.throws(() => parsePlayerFile(`${head}  blob: {"+12345678901234567890": a, 12345678901234567890: b}\n`), (err) => err.message === twins(4, '+12345678901234567890', '12345678901234567890'));
	// Python's str() of a null key is None, and of a float key 1.0, 1e+16 or inf.
	for (const [blob, a, b] of [['{"+None": a, ~: b}', '+None', '~'], ['{"+1.0": a, 1.0: b}', '+1.0', '1.0'], ['{"+1.5": a, 1.5: b}', '+1.5', '1.5'],
		['{"+-0.0": a, -0.0: b}', '+-0.0', '-0.0'], ['{"+1e+16": a, 1.0e+16: b}', '+1e+16', '1.0e+16'], ['{"+inf": a, .inf: b}', '+inf', '.inf'],
		['{"+90.0": a, 1:30.0: b}', '+90.0', '1:30.0'], ['{"+1e-05": a, 0.00001: b}', '+1e-05', '0.00001']]) {
		refuses(creatorYaml({ blob }), twins(39, a, b), blob);
	}
	// An alias used as a key is the key it names.
	refuses(creatorYaml({ anch: '&p "+dkey"', extra: '{dkey: 1, *p : 2}' }), twins(40, 'dkey', '+dkey'));
	refuses(creatorYaml({ anch: '&d local_items', '*d ': '[Wild Ticket]' }), twice(40), 'an alias key repeating a setting');
	refuses(creatorYaml({ blob: '{&k dkey: 1, *k : 2}' }), twice(39));
	refuses(creatorYaml({ a1: '&k fresh', a2: '&k local_items', '*k ': '[x]' }), 'The file could not be read at line 40: it names the anchor `&k` a second time, '
		+ 'which Archipelago refuses: rename one.', 'Archipelago\'s loader refuses an anchor named twice');
	assert.ok(readPlayerYaml(creatorYaml({ anch: '&u fresh_key', '*u ': '1' })).passthrough.some(([key, value]) => key === 'fresh_key' && value === 1));

	// Archipelago's loader builds no << merge, no bare = and no bare ! tag, and !!omap and !!pairs are lists of pairs to it.
	const at39 = (what) => `The file could not be read at line 39: ${what}.`;
	refuses(creatorYaml({ blob: '{<<: {a: 1}, b: 2}' }), at39('it uses a << merge, which Archipelago cannot read: write the keys out instead'));
	refuses(creatorYaml({ blob: '=' }), at39('it has a bare =, which Archipelago cannot read: put it in quotes'));
	refuses(creatorYaml({ blob: '[a, <<]' }), at39('it uses a << merge, which Archipelago cannot read: write the keys out instead'));
	assert.deepStrictEqual(readPlayerYaml(creatorYaml({ blob: '"="', blob2: '\'<<\'' })).passthrough.slice(-2), [['blob', '='], ['blob2', '<<']], 'quoted, both are text');
	for (const blob of ['! 1', '! "1"', '{! yes: a}']) refuses(creatorYaml({ blob }), at39('it tags a value with a bare !, which the bot does not read: take the ! out'), blob);
	for (const blob of ['!!omap [{a: 1}, {b: 2}]', '!!pairs [{a: 1}, {a: 2}]']) {
		refuses(creatorYaml({ blob }), at39('it uses !!omap or !!pairs, which the bot does not copy: write a mapping or a list instead'), blob);
	}
	refuses(creatorYaml({ blob: '!!float 16' }), at39('it uses a !tag the bot does not read'));

	// A float key stays a float, so Python's str() of it after its "+" twin stays 1.0.
	const { PyFloat } = _internal;
	assert.strictEqual(flowValue(new Map([['+1', 'a'], [new PyFloat(1), 'b']]), '`x`'), '{"+1": "a", 1.0: "b"}');
	assert.strictEqual(flowValue(new Map([[1, 'b'], ['+1', 'a']]), '`x`'), '{1: "b", "+1": "a"}');
	const read = readPlayerYaml(creatorYaml({ blob: '{"+1": a, 1.0: b}' }));
	const written = renderYaml({ name: 'Zack', createdAt: 1794398400, entries: [], passthrough: read.passthrough });
	assert.ok(written.includes('\n  blob: {"+1": "a", 1.0: "b"}\n'), written);
	assert.deepStrictEqual(readPlayerYaml(written).passthrough.find(([key]) => key === 'blob'), ['blob', new Map([['+1', 'a'], [new PyFloat(1), 'b']])], 'the bot reads its own file back');

	// Archipelago reads a key without a "?" of at most 1,024 characters, and escapes make a key longer.
	assert.strictEqual(flowValue(new Map([['k'.repeat(998), 1]]), '`x`'), `{"${'k'.repeat(998)}": 1}`, 'a key of 1000 characters, quotes included');
	const longKey = /^Error: `x` has a key of more than 1000 characters as the bot writes it \(an emoji counts as two\), which Archipelago cannot read back: shorten it\.$/;
	assert.throws(() => flowValue(new Map([['k'.repeat(999), 1]]), '`x`'), longKey);
	assert.throws(() => flowValue(new Map([[String.fromCharCode(92).repeat(500), 1]]), '`x`'), longKey, 'a backslash is written as two');
	assert.throws(() => flowValue(new Map([[String.fromCodePoint(0x1f600).repeat(500), 1]]), '`x`'), longKey, 'the package counts an emoji as two');
	assert.throws(() => yamlKey('k'.repeat(1001)), /^Error: The setting name `k+.` is more than 1000 characters as the bot writes it \(an emoji counts as two\)/);
	refuses(`${creatorYaml()}  "${'k'.repeat(1023)}": 1\n`, 'The file could not be read at line 39: a key runs past 1,024 characters (an emoji counts as two), more than the bot reads.');

	// A key that is not text is shown as the file spells it.
	refuses(creatorYaml({ '2001-01-01': 'x' }), 'The Plex Media settings have `2001-01-01` where a setting name goes.');
	refuses(creatorYaml({ '.inf': 'x' }), 'The Plex Media settings have `.inf` where a setting name goes.');
	refuses(`${creatorYaml()}  ? [a, b]\n  : 1\n`, 'The file could not be read at line 39: it uses a list or a mapping as a key, which Archipelago cannot read.');
	refuses(creatorYaml({ list_titles: '{[Alien]: 0, Heat: 1}' }), 'The file could not be read at line 12: it uses a list or a mapping as a key, which Archipelago cannot read.', 'a choice that is never rolled');
	refuses(creatorYaml({}, { top: ['requires:', '  ? {a: 1}', '  : 1'] }), 'The file could not be read at line 5: it uses a list or a mapping as a key, which Archipelago cannot read.', 'in a part the bot rewrites');
	refuses(creatorYaml({ anchor: '&k [a]', blob: '{*k : 1}' }), 'The file could not be read at line 40: it uses a list or a mapping as a key, which Archipelago cannot read.', 'an alias of a list');
	refuses(creatorYaml({}, { top: ['2001-01-01: x'] }), 'The file has `2001-01-01` at the top, and the bot takes one player per file: name, description, game, requires and Plex Media only.');
	refuses(creatorYaml().replace('game: Plex Media', 'game: 2001-01-01'), 'The file\'s game is `2001-01-01`, and the bot fills in Plex Media lists only.');
	refuses(creatorYaml({ blob: '{2001-01-01: a}' }), '`blob` uses a date as a key, which the bot does not copy: put it in quotes.');
});

test('a weighted option or a list is read as Archipelago rolls it: one choice above 0 is that choice, and each choice it can roll is one it reads', () => {
	const read = (over) => readPlayerYaml(creatorYaml(over));
	const refuses = (over, message) => assert.throws(() => read(over), (err) => {
		assert.strictEqual(err.message, message, JSON.stringify(over));
		return true;
	});
	// A Launcher template weights every option this way: one choice above 0, which is all Archipelago can roll.
	const one = read({
		goal_percent: '{80: 0, 60: 50, random: 0}', tv_unlock: '{episodes: 0, season: 50}', timesanity_albums: '{random: 0, off: 50}', timesanity_strict: '["true"]',
		list_preset: '{movies: 0, tv: 50}', list_shows: '{random: 0, preset: 50}', list_titles: '{"": 50}', list_unwatched: '{"false": 50, "true": 0}',
	});
	assert.deepStrictEqual([one.params.goalPercent, one.params.tvUnlock, one.params.timeAlbums, one.params.strict, one.params.preset, one.params.shows, one.params.titles, one.params.unwatched],
		[60, 'season', 0, true, 'tv', 3, undefined, false]);
	assert.deepStrictEqual(one.random, []);
	assert.ok(!one.passthrough.some(([key]) => key === 'goal_percent'), 'it is written as its value');
	assert.strictEqual(read({ goal_percent: '{60: "3", 70: 0.5}' }).params.goalPercent, 60, 'a weight goes through Python\'s int(): "3" is 3 and 0.5 is 0');
	assert.strictEqual(read({ goal_percent: '{60: 1.0, 70: 0.0, 80: " 2 ", 90: "+0"}' }).random[0], 'goal_percent', 'int() reads 1.0, " 2 " and "+0"');
	assert.strictEqual(read({ goal_percent: '{60: yes, 70: no}' }).params.goalPercent, 60, 'a weight of yes is True, which int() makes 1');
	refuses({ goal_percent: '{}' }, 'Goal Percent (`goal_percent`) is empty, which Archipelago refuses: give it a value or take the line out.');
	assert.strictEqual(read({ goal_percent: '{random-high: 1, 50: 0}' }).random[0], 'goal_percent', 'its one choice may be random itself');
	assert.deepStrictEqual(read({ goal_percent: '{60: 1, 70: 1}', tv_unlock: '[episodes, season]' }).random, ['goal_percent', 'tv_unlock']);

	// Each choice Archipelago can roll has to be one it reads, or one roll stops the whole seed.
	const goal = 'Goal Percent (`goal_percent`)';
	refuses({ goal_percent: '{80: 0, random: 0}' }, `${goal} has every choice weighted 0, which Archipelago refuses: give one a weight above 0.`);
	refuses({ goal_percent: '{150: 50, 50: 1}' }, `${goal} can roll \`150\`: it must be a whole number from 1 to 100.`);
	refuses({ goal_percent: '[50, 150]' }, `${goal} can roll \`150\`: it must be a whole number from 1 to 100.`);
	refuses({ goal_percent: '{random-range-0-200: 50, 50: 1}' }, `${goal} can roll \`random-range-0-200\`, which Archipelago refuses: a random range has to stay within 1 to 100.`);
	refuses({ goal_percent: '{random-often: 50, 50: 1}' }, `${goal} can roll \`random-often\`, which the bot does not read: random, random-low, random-middle, random-high or random-range-<min>-<max> picks at random.`);
	refuses({ goal_percent: '{50.0: 1, 80: 1}' }, `${goal} can roll \`50.0\`: it must be a whole number from 1 to 100, written without a decimal point.`);
	refuses({ goal_percent: '{.nan: 1, 80: 1}' }, `${goal} can roll \`.nan\`: it must be a whole number from 1 to 100.`);
	assert.strictEqual(read({ goal_percent: '{50.0: 0, 80: 1}' }).params.goalPercent, 80, 'a float Archipelago never rolls');
	refuses({ tv_unlock: '{seasons: 50, episodes: 1}' }, 'TV Unlock (`tv_unlock`) can roll `seasons`: it must be one of: episodes, season.');
	refuses({ starting_unlocks: '{0: 50}' }, 'Starting Unlocks (`starting_unlocks`) can roll `0`: it must be a whole number from 1 to 50.');
	refuses({ goal_percent: '[]' }, `${goal} is an empty list, which Archipelago cannot pick from: give it a value.`);
	refuses({ goal_percent: '{80: lots, 60: 1}' }, `${goal} gives \`80\` a weight that is not a whole number, which Archipelago cannot roll.`);
	refuses({ goal_percent: '{80: -1, 60: 2}' }, `${goal} gives \`80\` a weight below 0, which the bot does not read: use 0 to leave a choice out.`);
	refuses({ goal_percent: '{80: 1, ~: 1}' }, `${goal} can roll an empty value, which Archipelago refuses: give each choice a value.`);
	refuses({ goal_percent: '{~: 1, 80: 0}' }, `${goal} can roll an empty value, which Archipelago refuses: give each choice a value.`);
	refuses({ goal_percent: '{80: "\\ufeff1", 60: 2}' }, `${goal} gives \`80\` a weight that is not a whole number, which Archipelago cannot roll.`);
	// int() reads digits of any script, U+0085 around them and _ between them, but not U+001C to U+001F,
	// which str.strip() takes as spaces.
	for (const weight of ['"\\uff11"', '"\\N1"', '"1\\N"', '"1_0"']) assert.strictEqual(read({ goal_percent: `{50: ${weight}, 80: 0}` }).params.goalPercent, 50, weight);
	refuses({ goal_percent: '{50: "\\x1c1", 80: 1}' }, `${goal} gives \`50\` a weight that is not a whole number, which Archipelago cannot roll.`);
	// A choice that is wrong only by a space around it is shown with its quotes.
	refuses({ tv_unlock: '{" episodes": 1, season: 1}' }, 'TV Unlock (`tv_unlock`) can roll `" episodes"`: it must be one of: episodes, season.');
	refuses({ tv_unlock: '" season"' }, 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');

	// A list setting has to come out as one value, and the reply names every one that does not.
	refuses({ list_movies: '{3: 1, 4: 1}', list_shows: '[1, 2]', list_unwatched: 'random' },
		'List: Movies (`list_movies`), List: Shows (`list_shows`) and List: Unwatched Only (`list_unwatched`) are random: the bot needs a value in each to pick titles.');
	refuses({ list_titles: '[[Alien]]' }, 'List: Titles (`list_titles`) must be text, not a list or a mapping.');
	refuses({ list_preset: '{tv: 0}' }, 'List: Preset (`list_preset`) has every choice weighted 0, which Archipelago refuses: give one a weight above 0.');
});

test('values Archipelago reads in more than one spelling: empty as it reads it; default, high and low; toggle words and numbers; a choice by its number', () => {
	const read = (over) => readPlayerYaml(creatorYaml(over));
	const refuses = (over, message) => assert.throws(() => read(over), (err) => {
		assert.strictEqual(err.message, message, JSON.stringify(over));
		return true;
	});

	// Archipelago makes None of an empty value, which no option of the world reads but the preset (as
	// none) and a text (as "None", which the bot reads as no text).
	for (const empty of ['', '~', '{}', '{~: 1}']) {
		refuses({ goal_percent: empty }, empty === '{~: 1}' ? 'Goal Percent (`goal_percent`) can roll an empty value, which Archipelago refuses: give each choice a value.'
			: 'Goal Percent (`goal_percent`) is empty, which Archipelago refuses: give it a value or take the line out.');
	}
	refuses({ timesanity_strict: '' }, 'Timesanity Strict (`timesanity_strict`) is empty, which Archipelago refuses: give it a value or take the line out.');
	refuses({ tv_unlock: '~' }, 'TV Unlock (`tv_unlock`) is empty, which Archipelago refuses: give it a value or take the line out.');
	refuses({ list_movies: '~' }, 'List: Movies (`list_movies`) is empty, which Archipelago refuses: set a number.');
	refuses({ list_max_episodes: '{}' }, 'List: Episodes per Show (`list_max_episodes`) is empty, which Archipelago refuses: set a number.');
	refuses({ list_unwatched: '' }, 'List: Unwatched Only (`list_unwatched`) is empty, which Archipelago refuses: set true or false.');
	const empty = read({ list_preset: '~', list_genre: '', list_titles: '{~: 1}' });
	assert.deepStrictEqual([empty.params.preset, empty.params.genre, empty.params.titles, empty.params.shows], ['none', undefined, undefined, 2]);

	// A decimal point makes a float, which a range and a choice refuse, and a toggle reads through int().
	refuses({ goal_percent: '50.0' }, 'Goal Percent (`goal_percent`) must be a whole number from 1 to 100, written without a decimal point.');
	refuses({ list_movies: '5.0' }, 'List: Movies (`list_movies`) must be a whole number from 0 to 200, written without a decimal point.');
	refuses({ tv_unlock: '1.0' }, 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');
	assert.deepStrictEqual(['1.0', '0.0', '2.5', '-0.5'].map((w) => read({ timesanity_strict: w }).params.strict), [true, false, true, false]);
	// Python's int() reads spaces around a number but not U+FEFF, and a toggle's words only as written.
	assert.strictEqual(read({ goal_percent: '" 50 "' }).params.goalPercent, 50);
	refuses({ goal_percent: '"\\ufeff50"' }, 'Goal Percent (`goal_percent`) must be a whole number from 1 to 100.');
	refuses({ goal_percent: '"-5"' }, 'Goal Percent (`goal_percent`) must be a whole number from 1 to 100.');
	// The mathematical sans-serif digits are the third run of ten in a block of fifty.
	assert.deepStrictEqual(['"\\uff15\\uff10"', '"\\u0665\\u0660"', '"\\U0001D7E7\\U0001D7E2"', '"\\N50"', '"50\\N"', '"5_0"'].map((v) => read({ goal_percent: v }).params.goalPercent),
		[50, 50, 50, 50, 50, 50], 'as int() reads them: digits of any script, the spaces it takes, _ between digits');
	refuses({ goal_percent: '"\\x1c50"' }, 'Goal Percent (`goal_percent`) must be a whole number from 1 to 100.');
	refuses({ list_years: '1999.0' }, 'List: Years (`list_years`) must look like 1990 or 1990-1999.');
	// A text setting written as a number reads as Python's str() writes that number.
	assert.deepStrictEqual([read({ list_titles: '0.00001' }).params.titles, read({ list_label: '1.5e-7' }).params.label], ['1e-05', '1.5e-07']);
	refuses({ list_titles: '12345678901234567890' }, 'List: Titles (`list_titles`) holds a number too large for the bot to read exactly: put it in quotes.');
	refuses({ timesanity_strict: '" no "' }, 'Timesanity Strict (`timesanity_strict`) must be true or false.');
	assert.strictEqual(read({ timesanity_strict: '"No"' }).params.strict, false);

	assert.deepStrictEqual(['high', 'low', 'default', 'High'].map((w) => read({ goal_percent: w }).params.goalPercent), [100, 1, 80, 100]);
	assert.deepStrictEqual(['high', 'low', 'default', 'true', 'false', 'preset', '-1'].map((w) => read({ list_movies: w }).params.movies), [200, 0, 6, 6, 0, 6, 6],
		'a count reads default and true as preset, the mixed preset\'s 6');
	assert.deepStrictEqual(['high', 'low', 'default'].map((w) => read({ list_max_episodes: w }).params.maxEpisodes), [500, 1, 24]);
	refuses({ list_max_episodes: 'true' }, 'List: Episodes per Show (`list_max_episodes`) must be a whole number from 1 to 500.');
	refuses({ list_max_episodes: 'no' }, 'List: Episodes per Show (`list_max_episodes`) must be a whole number from 1 to 500.');
	assert.deepStrictEqual(['true', 'false', '\'off\'', 'Default'].map((w) => read({ timesanity_movies: w }).params.timeMovies), [15, 0, 0, 15]);

	assert.deepStrictEqual(['1', '0', '2', '-1', '0.5', 'enabled', 'Disabled', 'none', '\'null\'', '\'1\'', '\'0\'', 'yes', 'off'].map((w) => read({ timesanity_strict: w }).params.strict),
		[true, false, true, true, false, true, false, false, false, true, false, true, false], 'a number is on unless it is 0; Archipelago\'s words in any case');
	assert.deepStrictEqual(['disabled', '0', 'enabled'].map((w) => read({ list_unwatched: w }).params.unwatched), [false, false, true]);
	refuses({ timesanity_strict: '.inf' }, 'Timesanity Strict (`timesanity_strict`) must be true or false.');
	refuses({ timesanity_strict: 'maybe' }, 'Timesanity Strict (`timesanity_strict`) must be true or false.');
	assert.deepStrictEqual(read({ timesanity_strict: 'random' }).random, ['goal_percent', 'timesanity_strict']);
	refuses({ timesanity_strict: 'Random' }, 'Timesanity Strict (`timesanity_strict`) is `Random`, which Archipelago does not read: random picks at random.');
	refuses({ list_unwatched: 'RANDOM' }, 'List: Unwatched Only (`list_unwatched`) is random: set true or false, the bot needs it to pick titles.');
	assert.deepStrictEqual(read({ goal_percent: 'RANDOM-low', tv_unlock: 'Random' }).random, ['goal_percent', 'tv_unlock'], 'a Range and a Choice lowercase their text first');

	assert.deepStrictEqual(['0', '1', '0x1'].map((w) => read({ tv_unlock: w }).params.tvUnlock), ['episodes', 'season', 'season']);
	assert.deepStrictEqual([read({ list_preset: '4' }).params.preset, read({ list_preset: '5', list_shows: 'preset' }).params.preset], ['mixed', 'none']);
	refuses({ tv_unlock: '2' }, 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');
	refuses({ tv_unlock: '\'1\'' }, 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');
	refuses({ tv_unlock: 'true' }, 'TV Unlock (`tv_unlock`) must be one of: episodes, season.');
	refuses({ list_preset: '-1' }, 'List: Preset (`list_preset`) must be one of: movies, tv, music, books, mixed, none.');

	assert.deepStrictEqual(read({ goal_percent: 'random-range-100-1', wild_tickets: 'Random-Range-Low-0-20', timesanity_books: 'random-range-high-1440-0' }).random,
		['goal_percent', 'wild_tickets', 'timesanity_books'], 'a random range inside the option\'s own, either way round');
	refuses({ goal_percent: 'random-range-0-100' }, 'Goal Percent (`goal_percent`) is `random-range-0-100`, which Archipelago refuses: a random range has to stay within 1 to 100.');
	refuses({ wild_tickets: 'random-range-low-21-5' }, 'Wild Tickets (`wild_tickets`) is `random-range-low-21-5`, which Archipelago refuses: a random range has to stay within 0 to 20.');
});

test('the game and the name read as Archipelago\'s get_choice rolls them: a mapping or a list that can roll one value is that value', () => {
	const plain = readPlayerYaml(creatorYaml());
	const refuses = (text, message, what) => assert.throws(() => readPlayerYaml(text), (err) => {
		assert.strictEqual(err.message, message, what);
		return true;
	}, what);
	for (const game of ['game: {Plex Media: 50}', 'game: {Plex Media: 50, ChecksFinder: 0}', 'game:\n  Plex Media: 1', 'game: [Plex Media]', 'game: [Plex Media, Plex Media]', 'game: {Plex Media: "50"}']) {
		assert.deepStrictEqual(readPlayerYaml(creatorYaml().replace('game: Plex Media', game)), plain, game);
	}
	const withGame = (game) => creatorYaml().replace('game: Plex Media', game);
	refuses(withGame('game: {Plex Media: 0, ChecksFinder: 1}'), 'The file\'s game is `ChecksFinder`, and the bot fills in Plex Media lists only.');
	refuses(withGame('game: {}'), 'The file names no game: set game: Plex Media.');
	refuses(withGame('game: {Plex Media: 0}'), 'The file\'s game has every choice weighted 0, which Archipelago refuses: give one a weight above 0.');
	refuses(withGame('game: []'), 'The file\'s game is an empty list, which Archipelago cannot pick from: give it a value.');
	refuses(withGame('game: [Plex Media, ChecksFinder]'), 'The file picks its game at random: set game: Plex Media.');

	assert.strictEqual(readPlayerYaml(creatorYaml({}, { name: '{Zack: 1, Ana: 0}' })).name, 'Zack');
	assert.strictEqual(readPlayerYaml(creatorYaml({}, { name: '[Zack, Zack]' })).name, 'Zack');
	refuses(creatorYaml({}, { name: '{Zack: 1, Ana: 1}' }), 'The file picks its name at random: give the slot one with the name option.');
	assert.strictEqual(readPlayerYaml(creatorYaml({}, { name: '{Zack: 1, Ana: 1}' }), { name: 'Kim' }).name, 'Kim', 'a typed name is all that counts');
	refuses(creatorYaml({}, { name: '{Zack: -1, Ana: 2}' }), 'The name in the file gives `Zack` a weight below 0, which the bot does not read: use 0 to leave a choice out.');
});

test('a setting a trigger in the file checks keeps the file\'s own spelling, which Archipelago compares with option_result', () => {
	const trigger = (name, result) => `[{option_category: Plex Media, option_name: ${name}, option_result: ${result}, options: {Plex Media: {wild_tickets: 5}}}]`;
	const read = readPlayerYaml(creatorYaml({ timesanity_albums: '\'off\'', tv_unlock: 'Season', triggers: trigger('timesanity_albums', '\'off\'') }));
	assert.deepStrictEqual(read.params.asWritten, [['timesanity_albums', 'off']]);
	assert.deepStrictEqual([read.params.timeAlbums, read.params.tvUnlock, read.random], [0, 'season', ['goal_percent']], 'the plan still reads it as Archipelago does, and it is not random');
	const finished = (params) => renderYaml(listDoc(validateParams(params), { createdAt: 1794398400, entries: [] })).split('\n');
	const lines = finished(read.params);
	assert.ok(lines.includes('  timesanity_albums: "off"') && lines.includes('  tv_unlock: season'), 'only the setting the trigger checks keeps its spelling');
	assert.ok(lines.includes(`  triggers: [{"option_category": "Plex Media", "option_name": "timesanity_albums", "option_result": "off", "options": {"Plex Media": {"wild_tickets": 5}}}]`));

	const both = readPlayerYaml(creatorYaml({
		list_preset: 'Mixed', goal_percent: '\'50\'', triggers: `[{option_category: Plex Media, option_name: {list_preset: 1, goal_percent: 1}, option_result: x}, ${trigger('tv_unlock', 'season').slice(1, -1)}]`,
	})).params;
	const p = validateParams(both);
	const written = finished(both);
	assert.ok(written.includes('  list_preset: "Mixed"') && written.includes('  goal_percent: "50"') && written.includes('  tv_unlock: "episodes"'), 'every name a trigger can roll');
	assert.deepStrictEqual([p.counts.shows, p.options.goal_percent], [2, 50]);
	for (const other of ['[{option_name: goal_percent, option_result: 50}]', '[{option_category: requires, option_name: version, option_result: x}]', '[]', '{}', '\'\'']) {
		assert.strictEqual(readPlayerYaml(creatorYaml({ goal_percent: '\'50\'', triggers: other })).params.asWritten, undefined, other);
	}
	const random = readPlayerYaml(creatorYaml({ triggers: trigger('goal_percent', '50') }));
	assert.deepStrictEqual([random.random, random.params.asWritten], [['goal_percent'], undefined], 'a random setting is copied as it is anyway');
	assert.strictEqual(readPlayerYaml(creatorYaml({ goal_percent: '\'50\'', triggers: trigger('goal_percent', '50') }), { goalPercent: 60 }).params.asWritten, undefined, 'a typed option replaces it');
	// Typed as the file has it, the file's spelling stays for the trigger.
	const albums = (typed) => readPlayerYaml(creatorYaml({ timesanity_albums: '\'off\'', triggers: trigger('timesanity_albums', '\'off\'') }), { timeAlbums: typed }).params;
	assert.deepStrictEqual([albums('off').asWritten, albums('0').asWritten, albums('5').asWritten], [[['timesanity_albums', 'off']], [['timesanity_albums', 'off']], undefined]);
	assert.ok(finished(albums('off')).includes('  timesanity_albums: "off"') && finished(albums('5')).includes('  timesanity_albums: 5'));
	const unwatched = (typed) => readPlayerYaml(creatorYaml({ list_unwatched: '\'no\'', triggers: trigger('list_unwatched', '\'no\'') }), { unwatched: typed }).params.asWritten;
	assert.deepStrictEqual([unwatched('false'), unwatched('true')], [[['list_unwatched', 'no']], undefined], 'a list setting the same way');
	// random.choices never lands on a weight below 0, so a trigger can only roll the name weighted above 0.
	for (const name of ['{goal_percent: -1, tv_unlock: 2}', '{tv_unlock: 2, goal_percent: -1}', '{tv_unlock: "\\N1"}', '{tv_unlock: "\uFF11"}']) {
		assert.deepStrictEqual(readPlayerYaml(creatorYaml({ tv_unlock: 'Season', triggers: trigger(name, 'Season') })).params.asWritten, [['tv_unlock', 'Season']], name);
	}
	for (const name of ['{goal_percent: -1, tv_unlock: 2}', '{goal_percent: 0, tv_unlock: 2}']) {
		assert.deepStrictEqual(readPlayerYaml(creatorYaml({ goal_percent: undefined, tv_unlock: 'Season', triggers: trigger(name, 'Season') })).params.asWritten,
			[['tv_unlock', 'Season']], `${name} without goal_percent`);
	}

	assert.throws(() => readPlayerYaml(creatorYaml({ goal_percent: undefined, triggers: trigger('goal_percent', '50') })),
		(err) => err.message === 'A trigger in your file checks Goal Percent (`goal_percent`), which the file does not set: set it in the file.');
	assert.throws(() => validateParams({ name: 'Z', asWritten: [['notes', 1]] }), /^TypeError: asWritten must be a list of \[key, value\] pairs/);
	assert.throws(() => renderYaml({ name: 'Z', entries: [], passthrough: [['goal_percent', 'random']], asWritten: [['goal_percent', '50']] }), /both copied as it is and written as the file wrote it/);
});

test('a trigger Archipelago refuses on every roll, or one that sets what the bot picks titles with, is refused by its number', () => {
	const refuses = (triggers, message) => assert.throws(() => readPlayerYaml(creatorYaml({ triggers })), (err) => err.message === message, triggers);
	const set = (options) => `[{option_category: Plex Media, option_name: tv_unlock, option_result: episodes, options: {Plex Media: ${options}}}]`;
	const NOT_A_LIST = 'The file\'s triggers: needs a list of triggers under it, each starting with "- ", which Archipelago refuses otherwise.';
	for (const triggers of ['5', '~', 'abc', '{a: 1}', 'true']) refuses(triggers, NOT_A_LIST);
	refuses('[5]', 'Trigger 1 in your file is not a mapping of option_category, option_name, option_result and options, which Archipelago refuses.');
	refuses(`[${set('{wild_tickets: 5}').slice(1, -1)}, abc]`, 'Trigger 2 in your file is not a mapping of option_category, option_name, option_result and options, which Archipelago refuses.');
	for (const [category, shown] of [['ChecksFinder', '`ChecksFinder`'], ['plex media', '`plex media`'], ['"Plex Media "', '`"Plex Media "`'], ['5', '`5`']]) {
		refuses(`[{option_category: ${category}, option_name: goal_percent, option_result: 50}]`,
			`Trigger 1 in your file has the option_category ${shown}, which Archipelago cannot find in the file: use Plex Media.`);
	}
	for (const [category, shown] of [['{Plex Media: 1}', 'a mapping'], ['[Plex Media]', 'a list']]) {
		refuses(`[{option_category: ${category}, option_name: goal_percent, option_result: 50}]`,
			`Trigger 1 in your file has ${shown} as its option_category, which Archipelago cannot find in the file: use Plex Media.`);
	}
	refuses('[{option_name: {goal_percent: 0}, option_result: 50}]', 'Trigger 1 in your file has an option_name that cannot roll, which Archipelago refuses: give its choices whole-number weights, one of them above 0.');
	refuses('[{option_name: {goal_percent: -2, tv_unlock: 1}, option_result: 50}]', 'Trigger 1 in your file has an option_name that cannot roll, which Archipelago refuses: give its choices whole-number weights, one of them above 0.');
	refuses('[{option_name: {goal_percent: a}, option_result: 50}]', 'Trigger 1 in your file has an option_name that cannot roll, which Archipelago refuses: give its choices whole-number weights, one of them above 0.');
	refuses('[{option_name: [], option_result: 50}]', 'Trigger 1 in your file has an empty list as its option_name, which Archipelago cannot pick from.');
	refuses('[{option_name: description, option_result: x, options: {Plex Media: {wild_tickets: 9}}}]', 'Trigger 1 in your file checks `description` at the top of the file, which the bot writes itself: check a Plex Media setting instead.');
	refuses('[{option_category: ~, option_name: [requires], option_result: ~}]', 'Trigger 1 in your file checks `requires` at the top of the file, which the bot writes itself: check a Plex Media setting instead.');
	refuses(set('{list_preset: tv}'), 'Trigger 1 in your file sets List: Preset (`list_preset`), which the bot does not follow: set it in the file itself.');
	refuses(set('{"+list_titles": Heat}'), 'Trigger 1 in your file sets List: Titles (`list_titles`), which the bot does not follow: set it in the file itself.');
	refuses(set('{list_unwatched: false}'), 'Trigger 1 in your file sets List: Unwatched Only (`list_unwatched`), which the bot does not follow: set it in the file itself.');
	refuses(set('{entries: []}'), 'Trigger 1 in your file sets `entries`, which the bot writes: take it out of the trigger.');
	refuses(set('{goal_percent: 500}'), 'Trigger 1 in your file: Goal Percent (`goal_percent`) must be a whole number from 1 to 100.');
	refuses(set('{tv_unlock: {season: 0}}'), 'Trigger 1 in your file: TV Unlock (`tv_unlock`) has every choice weighted 0, which Archipelago refuses: give one a weight above 0.');
	// What Archipelago reads only when a trigger fires is left to it, and the rest is fine.
	for (const triggers of [set('{wild_tickets: 5, goal_percent: random, "+local_items": [Popcorn], "-tv_unlock": x}'), '[{option_name: [goal_percent], option_result: 50, percentage: abc}]',
		'[{option_category: Plex Media, option_name: {}, option_result: x}]', '[{option_category: 0, option_name: name, option_result: Zack, options: {"": {description: x, list_preset: tv}}}]']) {
		assert.ok(readPlayerYaml(creatorYaml({ triggers })).passthrough.some(([key]) => key === 'triggers'), triggers);
	}
	assert.throws(() => readPlayerYaml(creatorYaml({}, { top: ['triggers: []'] })), (err) => err.message === 'The file has `triggers` at the top: the bot reads triggers under Plex Media: only, so move them there.');
	assert.throws(() => readPlayerYaml(creatorYaml({}, { top: ['linked_options: []'] })), (err) => err.message === 'The file has `linked_options` at the top, which the bot does not copy: take them out.');
});

test('the plando a file requires stays in the finished file, so Archipelago still stops where the host has it off', () => {
	const requires = (plando) => creatorYaml({ plando_items: '[{items: {Wild Ticket: 1}, locations: [Check 1]}]' }, { top: ['requires:', '  version: 0.6.8', `  plando: ${plando}`] });
	const read = readPlayerYaml(requires('items, bosses'));
	assert.strictEqual(read.params.plando, 'items, bosses');
	const lines = renderYaml(listDoc(validateParams(read.params), { createdAt: 1794398400, entries: [] })).split('\n');
	assert.deepStrictEqual(lines.slice(lines.indexOf('requires:'), lines.indexOf('Plex Media:')),['requires:', '  version: 0.6.8', '  plando: "items, bosses"', '  game:', '    Plex Media: 0.2.0']);
	assert.strictEqual(readPlayerYaml(creatorYaml()).params.plando, undefined);
	assert.strictEqual(readPlayerYaml(requires('\'\'')).params.plando, '', 'an empty text asks for nothing, as in Archipelago');
	const refuses = (text, message) => assert.throws(() => readPlayerYaml(text), (err) => err.message === message, message);
	refuses(requires('[items]'), 'The file\'s requires: plando must be text naming items, connections, texts or bosses, split by commas.');
	refuses(requires('~'), 'The file\'s requires: plando must be text naming items, connections, texts or bosses, split by commas.');
	refuses(requires('items, banana'), 'The file\'s requires: plando names `banana`, which Archipelago does not know: it takes items, connections, texts or bosses, split by commas.');
	refuses(creatorYaml({}, { top: ['requires: 0.6.8'] }), 'The file\'s requires: needs its settings under it, one per line, as a template from the Launcher writes them.');
	assert.strictEqual(readPlayerYaml(creatorYaml({}, { top: ['requires:'] })).name, 'Zack', 'an empty requires is nothing to Archipelago');
	for (const falsy of ['0', '\'\'', '[]', 'false', '0.0', '{}']) {
		assert.strictEqual(readPlayerYaml(creatorYaml({}, { top: [`requires: ${falsy}`] })).params.plando, undefined, `Archipelago skips requires: ${falsy}`);
	}
	assert.throws(() => validateParams({ name: 'Z', plando: 5 }), /^Error: plando must be text naming items/);

	// PlandoOptions has none as well, and from_option_string strips each part with Python's str.strip().
	for (const plando of ['none', 'None', '\'None, items\'', '"items\\x1c"', '"items\\N"']) {
		assert.strictEqual(typeof readPlayerYaml(requires(plando)).params.plando, 'string', plando);
	}
	const none = renderYaml(listDoc(validateParams(readPlayerYaml(requires('none')).params), { createdAt: 1794398400, entries: [] })).split('\n');
	assert.ok(none.includes('  plando: "none"'), none.join('\n'));
	refuses(requires('"\\ufeffitems"'), 'The file\'s requires: plando names `"\\ufeffitems"`, which Archipelago does not know: it takes items, connections, texts or bosses, split by commas.');
});

test('a list the bot wrote belongs to its person while it keeps the slot it was built under, whatever its name line says', () => {
	const ANA = '100000000000000001';
	const movie = { k: 'movie', id: 'rk:1', rk: 1, t: 'Film 1', y: 2000, d: 6000000 };
	const anas = renderYaml({ name: 'Ana', createdAt: 1794398400, listInfo: { account: 5, discord: ANA }, entries: [movie] });
	assert.match(anas, /"slot":"Ana"/);
	const renamed = anas.replace('name: "Ana"', 'name: "Ben"');
	assert.deepStrictEqual([readPlayerYaml(anas).listFor, readPlayerYaml(anas, { name: 'Ben' }).listFor], [ANA, undefined]);
	assert.deepStrictEqual([readPlayerYaml(renamed).listFor, readPlayerYaml(renamed, { name: 'Ben' }).listFor, readPlayerYaml(renamed, { name: 'Ana' }).listFor], [undefined, undefined, ANA],
		'renamed in the file, it is a new slot, and back under Ana\'s name it is hers again');
	// A list from before list_info named the slot names it in its first line.
	const older = anas.replace('"slot":"Ana",', '');
	assert.deepStrictEqual([readPlayerYaml(older).listFor, readPlayerYaml(older, { name: 'Ana' }).listFor, readPlayerYaml(older, { name: 'Ben' }).listFor], [ANA, ANA, undefined]);
	const olderRenamed = older.replace('name: "Ana"', 'name: "Ben"');
	assert.deepStrictEqual([readPlayerYaml(olderRenamed).listFor, readPlayerYaml(olderRenamed, { name: 'Ben' }).listFor, readPlayerYaml(olderRenamed, { name: 'Ana' }).listFor],
		[undefined, undefined, ANA], 'renamed in its name line, it is a new slot');
	assert.deepStrictEqual([readPlayerYaml(`\uFEFF${olderRenamed}`).listFor, readPlayerYaml(olderRenamed.replace(/\n/g, '\r\n')).listFor], [undefined, undefined], 'with a BOM or CRLF too');
	assert.strictEqual(readPlayerYaml(olderRenamed.slice(olderRenamed.indexOf('\n') + 1)).listFor, ANA, 'without its first line the name line is all there is');
	// The 0.1.0 layout, without list settings: the old default label stays with the old slot.
	const old010 = olderRenamed.replace(/^ {2}list_(?!info).*\n/gm, '');
	assert.match(old010, /"label":"Ana's list"/);
	const read010 = readPlayerYaml(old010, { movies: '5' });
	assert.deepStrictEqual([read010.listFor, read010.label], [undefined, undefined]);
	const own010 = readPlayerYaml(old010.replace('"label":"Ana\'s list"', '"label":"Album club"'), { movies: '5' });
	assert.strictEqual(own010.label, 'Album club', 'a label of its own comes along');
	assert.strictEqual(readPlayerYaml(anas.replace(`"discord":"${ANA}"`, '"discord":"12345"')).listFor, undefined, 'a discord that is no Discord id names nobody');
});

test('Archipelago\'s loader refuses an anchor named twice, a list or a mapping as a key and a key left empty without "?", which the package reads anyway', () => {
	const refuses = (text, message) => assert.throws(() => readPlayerYaml(text), (err) => err.message === message, message);
	const at39 = (what) => `The file could not be read at line 39: ${what}.`;
	refuses(creatorYaml({ a: '&x 1', b: '&x 2' }), 'The file could not be read at line 40: it names the anchor `&x` a second time, which Archipelago refuses: rename one.');
	refuses(creatorYaml({ blob: '{: b}' }), at39('it has a : with no key before it, which Archipelago cannot read: give it a key'));
	refuses(`${creatorYaml()}  blob:\n    : b\n`, 'The file could not be read at line 40: it has a : with no key before it, which Archipelago cannot read: give it a key.');
	const explicit = readPlayerYaml(`${creatorYaml()}  blob:\n    ?\n    : b\n`).passthrough.find(([key]) => key === 'blob')[1];
	assert.deepStrictEqual(explicit, new Map([[null, 'b']]), 'with a "?" an empty key is null to Archipelago too');
	for (const text of [`${creatorYaml()}  blob:\n    ?   \n    : b\n`, creatorYaml({ blob: '{?   : b}' }), `${creatorYaml()}  blob:\n    ?${' '.repeat(45)}\n    : b\n`, creatorYaml({ blob: `{?${'\t'.repeat(45)}: b}` })]) {
		assert.deepStrictEqual(readPlayerYaml(text).passthrough.find(([key]) => key === 'blob')[1], new Map([[null, 'b']]), 'blanks after the "?" too, however many');
	}
	assert.strictEqual(readPlayerYaml(creatorYaml({ blob: '{"": b}' })).passthrough.find(([key]) => key === 'blob')[1].get(''), 'b', 'a quoted empty key is text');
	// Tagged as text, << and = are text to Archipelago; the package merges at a key << anyway.
	assert.deepStrictEqual(readPlayerYaml(creatorYaml({ blob: '!!str <<', blob2: '!!str =' })).passthrough.slice(-2), [['blob', '<<'], ['blob2', '=']]);
	refuses(creatorYaml({ blob: '{!!str <<: x}' }), at39('it tags a << key, which the bot does not read: write "<<" in quotes instead'));
	refuses(creatorYaml({ blob: '{!!merge <<: {a: 1}}' }), at39('it uses a << merge, which Archipelago cannot read: write the keys out instead'));
	refuses(creatorYaml({ blob: '! <<' }), at39('it uses a << merge, which Archipelago cannot read: write the keys out instead'));
	// In octal and in minutes and seconds, an int key is the number Python's str() writes.
	refuses(creatorYaml({ blob: '{"+8": a, 010: b}' }), at39('it gives both `+8` and `010`, which Archipelago refuses together'));
	refuses(creatorYaml({ blob: '{"+90": a, 1:30: b}' }), at39('it gives both `+90` and `1:30`, which Archipelago refuses together'));
	refuses(creatorYaml({ blob: '{"+2001-01-31": a, 2001-01-31: b}' }), at39('it gives both `+2001-01-31` and `2001-01-31`, which Archipelago refuses together'));
});

test('a quote or a bracket left open is named at the line it opens, and an indented quote\'s next line is said to be the cause too', () => {
	const refuses = (text, message) => assert.throws(() => readPlayerYaml(text), (err) => err.message === message, message);
	const open = 'a quoted text or a bracket is not closed, or a line of it is not indented';
	refuses(creatorYaml({ list_titles: '"Alien; Aliens' }), `The file could not be read at line 12: ${open}.`);
	refuses(creatorYaml({ list_titles: '\'Alien; Aliens' }), `The file could not be read at line 12: ${open}.`);
	refuses(creatorYaml({ list_titles: '"Alien;\nAliens"' }), `The file could not be read at line 12: ${open}.`);
	refuses(`${creatorYaml()}  blob: {\n    "Sword": 1,\n    "Bow: 1\n  }\n`, `The file could not be read at line 41: ${open}.`);
	// A bracket left open inside the file's mappings is noticed at the next line not indented past its key.
	refuses(creatorYaml({ local_items: '[Sword, Bow' }), `The file could not be read at line 32: ${open}.`);
	refuses(creatorYaml({ start_inventory: '{Sword: 1' }), `The file could not be read at line 34: ${open}.`);
	refuses(creatorYaml({ exclude_locations: '[\n      "Cave",\n      "Tower"' }), `The file could not be read at line 37: ${open}.`);
	refuses(creatorYaml({ start_hints: '[[a, b], [c' }), `The file could not be read at line 35: ${open}.`);
	refuses(creatorYaml({ start_hints: '[\n      [a, b],\n      [c' }), `The file could not be read at line 35: ${open}.`, 'the outermost bracket left open');
});

test('a file of millions of lines is refused or read about as fast as the fullest list the bot writes', () => {
	const movie = (rk) => ({ k: 'movie', id: `rk:${rk}`, rk, t: `Film ${rk}`, y: 2000, d: 6000000 });
	// 2,000 entries, the most a list holds, grown toward 8 MB with albums of 100 long tracks.
	const album = (n) => ({ k: 'album', id: `plex://album/${n}`, rk: 300000 + n, ar: `Artist ${n}`, t: `Album ${n}`, y: 2000, d: 100 * 200000,
		tr: Array.from({ length: 100 }, (_, i) => [3000000 + n * 100 + i, i + 1, `Track ${i + 1} ${'x'.repeat(148)}`, 200000, 4000000 + n * 100 + i, `Artist ${n} ${'y'.repeat(20)}`]) });
	const real = renderYaml({ name: 'Zack', createdAt: 1794398400, entries: [...Array.from({ length: 370 }, (_, i) => album(i + 1)), ...Array.from({ length: 1630 }, (_, i) => movie(i + 1))] });
	assert.ok(Buffer.byteLength(real) <= FILE_MAX_BYTES && real.length > 0.95 * FILE_MAX_BYTES, String(real.length));
	const time = (text) => {
		const start = process.hrtime.bigint();
		let out;
		try {
			out = readPlayerYaml(text);
		} catch (err) {
			out = err;
		}
		return [Number(process.hrtime.bigint() - start) / 1e6, out];
	};
	time(real);
	const [realA, read] = time(real);
	const realMs = Math.min(realA, time(real)[0]);
	assert.strictEqual(read.entriesCount, 2000);
	const TOO_BIG = 'The file\'s settings take more than 64 KB, the most the bot reads: attach the YAML the Options Creator saved, or a list the bot wrote.';
	const player = 'name: Zack\ngame: Plex Media\nPlex Media:\n  list_preset: movies\n  entries:\n';
	const fill = (line) => `${player}${line.repeat(Math.floor((FILE_MAX_BYTES - player.length) / line.length))}`;
	for (const [what, text, check] of [
		['line feeds', '\n'.repeat(FILE_MAX_BYTES), (out) => out.message === TOO_BIG],
		['lone CRs', '\r'.repeat(FILE_MAX_BYTES), (out) => out.message === TOO_BIG],
		['an entries line, then lone CRs', `${player}${'\r'.repeat(FILE_MAX_BYTES - player.length)}`, (out) => out.entriesCount === 0],
		['lone CRs, then a control character', `${'\r'.repeat(FILE_MAX_BYTES - 1)}\u0001`, (out) => /^The file could not be read at line 8388608: it holds an invisible control character/.test(out.message)],
		// More entries than a list holds, and more lines than its entries take, are not counted to the end.
		['entry lines, LF', fill('    - \n'), (out) => out.message === TOO_BIG],
		['entry lines, CR', fill('    - \r'), (out) => out.message === TOO_BIG],
		['lines indented past the entries', fill('      x\n'), (out) => out.message === TOO_BIG],
		['comment lines', fill('  #\n'), (out) => out.message === TOO_BIG],
	]) {
		const [ms, out] = time(text);
		assert.ok(check(out), `${what}: ${out && out.message}`);
		assert.ok(Math.min(ms, time(text)[0]) < realMs * 3 + 50, `${what}: ${Math.round(ms)} ms, the list the bot wrote ${Math.round(realMs)} ms`);
	}
	const crOnly = creatorYaml({ notes: '"a\u0001b"' }).replace(/\n/g, '\r');
	assert.throws(() => readPlayerYaml(crOnly), (err) => /^The file could not be read at line 39: /.test(err.message), 'a lone CR counts as a line');
});

test('a list the bot built before it saved its list settings is refused until the command says what to pick, and keeps its label', () => {
	const OLD = 'This list comes from an older version of the bot, which did not save what to pick: give a preset, a count, or titles, a playlist or a collection with the command.';
	const movie = (rk) => ({ k: 'movie', id: `rk:${rk}`, rk, t: `Film ${rk}`, y: 2000, d: 6000000 });
	// The layout of a 0.1.0 list: the game options, list_info and the entries, and no list settings.
	const old = (label) => renderYaml({ name: 'Zack', label, createdAt: 1794398400, options: { goal_percent: 60 }, entries: [movie(1), movie(2), movie(3)] })
		.replace(/^ {2}list_(?!info).*\n/gm, '').replace(`${contracts.GAME}: ${contracts.WORLD_VERSION}`, `${contracts.GAME}: 0.1.0`);
	const text = old('Album club');
	assert.ok(!/^ {2}list_(?!info)/m.test(text) && /^ {2}list_info: .*"label":"Album club"/m.test(text) && /^ {4}- /m.test(text), text);
	const noInfo = text.replace(/^ {2}list_info: .*\n/m, '');
	const files = [
		[text, 'list_info and the entries'],
		[noInfo, 'the entries in the bot\'s layout'],
		[noInfo.replace(/\n {2}entries:\n(?: {4}- .*\n)+/, '\n  entries: [{"k": "movie"}, {"k": "movie"}]\n'), 'the entries written another way'],
		[text.replace(/\n {2}entries:\n(?: {4}- .*\n)+/, '\n'), 'list_info alone'],
	];
	for (const [file, what] of files) {
		assert.throws(() => readPlayerYaml(file), (err) => err.message === OLD, what);
		assert.throws(() => readPlayerYaml(file, { name: 'Kim', genre: 'Jazz', unwatched: false, goalPercent: 70 }), (err) => err.message === OLD, `${what}: filters and game options pick nothing`);
	}

	const music = readPlayerYaml(text, { preset: 'music' });
	assert.deepStrictEqual(music.params, {
		name: 'Zack', preset: 'music', unwatched: true, maxEpisodes: 24, label: 'Album club', startingUnlocks: 3, goalPercent: 60, tvUnlock: 'episodes',
		episodesPerUnlock: 3, lockedWatches: 'bank', checkpointItems: 'filler_only', strict: false, timeMovies: 15, timeEpisodes: 10, timeAlbums: 0, timeBooks: 30,
		wildTickets: 2, passthrough: [],
	});
	assert.deepStrictEqual([music.name, music.label, music.entriesCount, music.random], ['Zack', 'Album club', 3, []]);
	const p = validateParams(music.params);
	assert.deepStrictEqual(p.counts, { movies: 0, shows: 0, albums: 10, books: 0 });
	assert.deepStrictEqual([p.label, p.list.list_preset, p.list.list_albums, p.list.list_label], ['Album club', 'music', 'preset', 'Album club'], 'the new file saves what it picked');
	assert.deepStrictEqual(validateParams(readPlayerYaml(text, { titles: 'Heat' }).params).counts, { movies: 0, shows: 0, albums: 0, books: 0 }, 'titles typed alone pick only those, as without a file');
	assert.deepStrictEqual(validateParams(readPlayerYaml(files[3][0], { albums: '2' }).params).counts, { movies: 0, shows: 0, albums: 2, books: 0 });
	assert.throws(() => validateParams(readPlayerYaml(text, { movies: 0 }).params), (err) => err.message === PICK_NOTHING);
	assert.throws(() => validateParams(readPlayerYaml(text, { preset: 'anime' }).params), /^Error: preset must be one of: movies, tv, music, books, mixed, none\.$/);

	const renamed = readPlayerYaml(old(undefined), { preset: 'tv', name: 'Kim' });
	assert.strictEqual(renamed.label, undefined, 'a label that was only "<name>\'s list" follows the slot\'s name');
	assert.strictEqual(validateParams(renamed.params).label, 'Kim\'s list');
	assert.strictEqual(readPlayerYaml(text, { preset: 'tv', label: 'Mine' }).label, 'Mine', 'a typed label wins');
	assert.strictEqual(readPlayerYaml(old('x'.repeat(101)), { preset: 'tv' }).label, undefined, 'a label longer than list_label takes stays behind, and the list is still read');
});

test('an empty YAML document, as a stray --- leaves, holds no player, and Archipelago skips it too', () => {
	const player = creatorYaml();
	for (const text of [`${player}---\n`, `${player}...\n---\n`, `${player}--- ~\n`, `${player}---\n# the end\n`, `${player}---\n---\n`, `---\n---\n${player}`, `--- null\n...\n---\n${player}`]) {
		assert.strictEqual(readPlayerYaml(text).name, 'Zack', JSON.stringify(text.replace(player, '<player>')));
	}
	for (const text of ['---\n', '--- ~\n---\n']) {
		assert.throws(() => readPlayerYaml(text), /^Error: The file is empty: attach the YAML the Options Creator saved\.$/, text);
	}
	assert.throws(() => readPlayerYaml(`${player}--- ""\n`), /^Error: The file holds 2 YAML documents/, 'an empty text is a document to Archipelago, which then fails');
});

test('a title error shows the title in a code span, so Markdown, links and mentions from a file stay text', () => {
	const ellipsis = String.fromCharCode(0x2026);
	const link = `[free nitro](https://e.co/a) **bold** <@123> ${'a'.repeat(200)}`;
	const tooLong = (name) => `${name}: \`${link.slice(0, 39)}${ellipsis}\` is too long.`;
	assert.throws(() => readPlayerYaml(creatorYaml({ list_titles: `'${link}'` })), (err) => err.message === tooLong('List: Titles (`list_titles`)'));
	assert.throws(() => validateParams({ name: 'Z', titles: `Heat; ${link}` }), (err) => err.message === tooLong('titles'));
	assert.throws(() => readPlayerYaml(creatorYaml({ list_titles: '\'Heat; movie: (1999)\'' })), (err) => err.message === 'List: Titles (`list_titles`): `movie: (1999)` names no title.');
	assert.throws(() => validateParams({ name: 'Z', titles: 'book: ' }), (err) => err.message === 'titles: `book:` names no title.');
});

test('without its yaml package the bot says what is missing, and names no install command', () => {
	const script = [
		'const Module = require("module");',
		'const resolve = Module._resolveFilename;',
		'Module._resolveFilename = function (request, ...rest) {',
		'	if (request === "yaml") throw Object.assign(new Error("Cannot find module yaml"), { code: "MODULE_NOT_FOUND" });',
		'	return resolve.call(this, request, ...rest);',
		'};',
		'const { readPlayerYaml } = require(process.argv[1]);',
		'try { readPlayerYaml("name: Zack\\n"); } catch (err) { process.stdout.write(err.message); }',
	].join('\n');
	const run = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', 'helpers', 'apMediaYaml.js')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
	assert.strictEqual(run.status, 0, run.stderr);
	const version = require('../package.json').dependencies.yaml;
	assert.match(version, /^\d+\.\d+\.\d+$/, 'an exact version');
	assert.strictEqual(run.stdout, `The bot cannot read YAML files yet: the owner has to install its yaml package (${version}).`);
});

test('the Options Creator files these tests make have the keys, in the order, of one Archipelago wrote', () => {
	const YAML = require('yaml');
	const real = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'apworld', 'tests', 'fixtures', 'options_creator_default.yaml'), 'utf8'));
	const made = YAML.parse(creatorYaml());
	assert.deepStrictEqual(Object.keys(made), Object.keys(real));
	assert.deepStrictEqual(Object.keys(made[contracts.GAME]), Object.keys(real[contracts.GAME]));
	assert.strictEqual(made.description, real.description);
});

test('options typed with the command replace the file\'s; the name and pick-something checks look at the result', () => {
	const empty = creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'\'' }, { name: '\'Za{ck}\'' });
	assert.throws(() => readPlayerYaml(empty), /cannot contain/);
	const read = readPlayerYaml(empty, { name: 'Kim', titles: 'Heat', goalPercent: '70', preset: undefined, label: '' });
	assert.strictEqual(read.name, 'Kim');
	assert.deepStrictEqual([read.params.name, read.params.titles, read.params.goalPercent, read.params.preset], ['Kim', 'Heat', '70', 'none']);
	assert.deepStrictEqual(read.random, [], 'the typed goal_percent replaces the random one');
	assert.ok(!read.passthrough.some(([key]) => key === 'goal_percent'));
	assert.ok(!read.params.passthrough.some(([key]) => key === 'goal_percent'));
	assert.strictEqual(read.label, undefined);

	const tv = readPlayerYaml(creatorYaml({ list_movies: '4', list_shows: 'preset' }), { preset: 'TV' });
	assert.deepStrictEqual([tv.params.preset, tv.params.movies, tv.params.shows, tv.params.albums, tv.params.books], ['tv', 4, 3, 0, 0], 'a count left at preset follows the typed preset; a number stays');
	const typed = readPlayerYaml(creatorYaml(), { movies: '9', unwatched: false, label: 'Mine', strict: 'true' });
	assert.deepStrictEqual([typed.params.movies, typed.params.unwatched, typed.params.label, typed.params.strict, typed.label], ['9', false, 'Mine', 'true', 'Mine']);
	assert.throws(() => readPlayerYaml(creatorYaml(), { preset: 'anime' }), /^Error: preset must be one of: movies, tv, music, books, mixed, none\.$/);
	assert.throws(() => readPlayerYaml(creatorYaml({ list_titles: '\'\'' }), { movies: 0, shows: '0', albums: 0, books: 0 }), (err) => err.message === PICK_NOTHING);
	assert.strictEqual(readPlayerYaml(creatorYaml({ list_titles: '\'\'' }), { movies: 'many' }).params.movies, 'many', 'a typed count the builder will refuse is not taken for 0');

	// A typed option replaces the file's value before that value is read, so the file's cannot stop it.
	const fixed = readPlayerYaml(creatorYaml({ list_playlist: '{Rock: 1, Jazz: 1}', list_movies: 'random', goal_percent: '150', tv_unlock: 'weekly' }),
		{ playlist: 'Rock', movies: '3', goalPercent: '70', tvUnlock: 'season' });
	assert.deepStrictEqual([fixed.params.playlist, fixed.params.movies, fixed.params.goalPercent, fixed.params.tvUnlock], ['Rock', '3', '70', 'season']);
	assert.deepStrictEqual(fixed.random, []);
	assert.throws(() => readPlayerYaml(creatorYaml({ list_playlist: '{Rock: 1, Jazz: 1}' }), { collection: 'Pixar' }), /^Error: List: Playlist \(`list_playlist`\) is random: write it as one text/, 'only the option typed is replaced');
});

test('validateParams takes preset none, refuses a list that picks nothing, and records the list settings it used', () => {
	assert.throws(() => validateParams({ name: 'Z', preset: 'none' }), (err) => err.message === PICK_NOTHING);
	assert.throws(() => validateParams({ name: 'Z', movies: 0 }), (err) => err.message === PICK_NOTHING);
	assert.deepStrictEqual(validateParams({ name: 'Z', preset: 'None', titles: 'Alien' }).counts, { movies: 0, shows: 0, albums: 0, books: 0 });
	const list = (params) => validateParams({ name: 'Z', ...params }).list;
	const DEFAULTS = {
		list_preset: 'movies', list_movies: 'preset', list_shows: 'preset', list_albums: 'preset', list_books: 'preset',
		list_titles: '', list_playlist: '', list_collection: '', list_genre: '', list_years: '', list_unwatched: true, list_max_episodes: 24, list_label: '',
	};
	assert.deepStrictEqual(list({}), DEFAULTS);
	assert.deepStrictEqual(list({
		preset: 'mixed', movies: 6, shows: 2, titles: ' Alien ;movie: Aliens (1986); ', years: '1990 - 1999', genre: 'Horror', label: 'Fright night',
		unwatched: 'no', maxEpisodes: '5', playlist: '501', collection: 'Pixar',
	}), {
		...DEFAULTS, list_preset: 'mixed', list_shows: 2, list_titles: 'Alien; movie: Aliens (1986)', list_playlist: '501', list_collection: 'Pixar',
		list_genre: 'Horror', list_years: '1990-1999', list_unwatched: false, list_max_episodes: 5, list_label: 'Fright night',
	});
	assert.deepStrictEqual(list({ movies: 10, years: '2001' }), { ...DEFAULTS, list_preset: 'none', list_movies: 10, list_years: '2001' });
	assert.deepStrictEqual(list({ preset: 'tv', movies: 0 }), { ...DEFAULTS, list_preset: 'tv' }, 'a count equal to the preset\'s is written as preset');
});

test('renderYaml writes the list settings it is given, then the copied settings as lines PyYAML reads back the same', () => {
	const c = String.fromCharCode;
	const u = (hex) => `${c(92)}u${hex}`;
	const kept = [
		['goal_percent', new Map([[50, 1], ['random-high', 2]])],
		['progression_balancing', 50],
		['accessibility', 'full'],
		['start_inventory', new Map([['Wild Ticket', 2]])],
		['local_items', ['Popcorn']],
		['on', true],
		['my key', `line${c(0x2028)}sep${c(0x85)}nel${c(0x9f)}`],
		['odd', `x${c(0x7f)}y${c(0xfffe)}${c(0xffff)}z`],
		['plain', 0.25],
		['nested', { a: [1, { b: null }] }],
	];
	const yaml = renderYaml({
		name: 'Zack',
		createdAt: 1794398400,
		entries: [],
		options: { goal_percent: 50 },
		list: { list_preset: 'none', list_movies: 3, list_shows: -1, list_titles: `Quote "it"; Tab${c(9)}bed`, list_label: 'Mine', list_unwatched: false },
		passthrough: kept,
	});
	assert.deepStrictEqual(settingLines(yaml), [
		'  starting_unlocks: 3',
		'  goal_percent: {50: 1, "random-high": 2}',
		'  tv_unlock: episodes',
		'  episodes_per_unlock: 3',
		'  locked_watches: bank',
		'  checkpoint_items: filler_only',
		'  timesanity_strict: false',
		'  timesanity_movies: 15',
		'  timesanity_episodes: 10',
		'  timesanity_albums: 0',
		'  timesanity_books: 30',
		'  wild_tickets: 2',
		'  list_preset: none',
		'  list_movies: 3',
		'  list_shows: preset',
		'  list_albums: preset',
		'  list_books: preset',
		'  list_titles: "Quote \\"it\\"; Tab bed"',
		'  list_playlist: ""',
		'  list_collection: ""',
		'  list_genre: ""',
		'  list_years: ""',
		'  list_unwatched: false',
		'  list_max_episodes: 24',
		'  list_label: "Mine"',
		'  progression_balancing: 50',
		'  accessibility: "full"',
		'  start_inventory: {"Wild Ticket": 2}',
		'  local_items: ["Popcorn"]',
		'  "on": true',
		`  "my key": "line${u('2028')}sep${u('0085')}nel${u('009f')}"`,
		`  odd: "x${u('007f')}y${u('fffe')}${u('ffff')}z"`,
		'  plain: 0.25',
		'  nested: {"a": [1, {"b": null}]}',
	]);
	// Archipelago's loader refuses a raw DEL, C1 control, U+FFFE or U+FFFF, and one refused file stops the whole multiworld.
	const raw = new RegExp(`[${c(0x7f)}-${c(0x9f)}${c(0x2028)}${c(0x2029)}${c(0xfffe)}${c(0xffff)}]`);
	assert.ok(!raw.test(yaml), 'no raw DEL, C1 control, line separator, U+FFFE or U+FFFF');
	const back = readPlayerYaml(yaml);
	assert.deepStrictEqual(back.passthrough, kept.map(([key, value]) => [key, key === 'nested' ? new Map([['a', [1, new Map([['b', null]])]]]) : value]),
		'every copied value reads back as it was, number keys included');
	assert.deepStrictEqual([back.params.preset, back.params.movies, back.params.shows, back.params.titles, back.params.label, back.params.unwatched],
		['none', 3, 0, 'Quote "it"; Tab bed', 'Mine', false]);

	const bad = (doc, pattern, what) => assert.throws(() => renderYaml({ name: 'Z', entries: [], ...doc }), pattern, what);
	for (const key of ['entries', 'list_info', 'list_movies', 'list_label']) {
		bad({ passthrough: [[key, []]] }, new RegExp(`^Error: \`${key}\` is written by the bot, so a copied setting cannot replace it\\.$`), key);
	}
	bad({ passthrough: [['a', 1], ['a', 2]] }, /`a` is given twice/);
	bad({ passthrough: [['+local_items', []]] }, /^Error: `\+local_items` starts with \+, which Archipelago takes only inside triggers/);
	bad({ passthrough: [['a', `x${c(0xd800)}`]] }, /`a` holds a broken character Archipelago cannot read/);
	bad({ passthrough: { a: 1 } }, /passthrough must be a list of \[key, value\] pairs/);
	bad({ list: { list_movies: 201 } }, TypeError);
	bad({ list: { list_preset: 'anime' } }, TypeError);
	bad({ list: { list_unwatched: 'yes' } }, TypeError);
	assert.throws(() => validateParams({ name: 'Z', passthrough: [['entries', []]] }), /`entries` is written by the bot/);
	assert.deepStrictEqual(validateParams({ name: 'Z', goalPercent: 70, passthrough: [['goal_percent', 'random'], ['x', 1]] }).passthrough, [['x', 1]],
		'a game option given as a param replaces a random copy of it');
});

test('a copied value that would not read back the same is refused, naming the setting; keys are quoted when YAML would misread them', () => {
	const { flowValue, yamlKey, PyFloat } = _internal;
	// A whole number past 2**53 is an int the package could not hold exactly; a float is written as
	// PyYAML reads one, with its decimal point.
	for (const n of [1e21, 2 ** 60, -(2 ** 54)]) {
		assert.throws(() => flowValue(n, '`x`'), /^Error: `x` holds a number too large for the bot to copy exactly: write a smaller one\.$/, String(n));
	}
	assert.deepStrictEqual([Infinity, -Infinity, NaN, 1e-7, 0.5].map((n) => flowValue(n, '`x`')), ['.inf', '-.inf', '.nan', '1.0e-07', '0.5']);
	assert.deepStrictEqual([50, -0, 1e16, 2 ** 60, 1.5e300].map((n) => flowValue(new PyFloat(n), '`x`')), ['50.0', '-0.0', '1.0e+16', '1.152921504606847e+18', '1.5e+300']);
	const floats = readPlayerYaml(creatorYaml({ blob: '[1.5e+300, 2.0, -0.0, 1e+3, .5e-7]' })).passthrough.find(([key]) => key === 'blob')[1];
	assert.strictEqual(flowValue(floats, '`x`'), '[1.5e+300, 2.0, -0.0, "1e+3", 5.0e-08]', 'each float as Python writes it, with a point; 1e+3 is text to PyYAML');
	assert.throws(() => flowValue(new Set([1]), '`x`'), /`x` holds a value the bot cannot copy \(a date, a set or binary data\)/);
	assert.throws(() => flowValue(new Uint8Array([1]), '`x`'), /cannot copy \(a date, a set or binary data\)/);
	assert.throws(() => flowValue(new Map([[[1], 2]]), '`x`'), /`x` uses a list or a mapping as a key, which Archipelago cannot read/);
	let deep = 1;
	for (let i = 0; i < 40; i++) deep = [deep];
	assert.throws(() => flowValue(deep, '`x`'), /`x` is nested more than 32 levels deep/);
	assert.strictEqual(flowValue(-0, '`x`'), '0');
	assert.strictEqual(flowValue(new Map([[true, 1], [null, 2], [1.5, 3]]), '`x`'), '{true: 1, null: 2, 1.5: 3}');
	assert.strictEqual(yamlKey('progression_balancing'), 'progression_balancing');
	for (const key of ['on', 'Off', 'yes', 'n', 'Y', 'NULL', 'True', '1abc', 'a b', 'a:b', '#x', '']) assert.strictEqual(yamlKey(key), JSON.stringify(key), key);
});

test('a YAML the bot wrote reads back to the settings it was built with, and its titles are counted and picked again', async () => {
	const first = await setup().builder.build({
		name: 'Zack', preset: 'mixed', shows: 2, titles: 'Alien; Aliens', label: 'Fright night', accountId: 5, discordUserId: '42', goalPercent: 60, timeAlbums: 'off',
	});
	const read = readPlayerYaml(first.yaml);
	assert.strictEqual(read.entriesCount, entriesOf(first.yaml).length);
	assert.strictEqual(read.label, 'Fright night');
	assert.deepStrictEqual(read.passthrough, []);
	assert.deepStrictEqual(read.random, []);
	const again = await setup().builder.build({ ...read.params, accountId: 5, discordUserId: '42' });
	assert.deepStrictEqual(settingLines(again.yaml), settingLines(first.yaml));
	assert.ok(settingLines(first.yaml).includes('  list_label: "Fright night"'));
	assert.ok(settingLines(first.yaml).includes('  list_movies: preset'));
});

test('the entries at the end of a file the bot wrote are counted, not parsed; any other layout is parsed whole', () => {
	const movie = (rk) => ({ k: 'movie', id: `rk:${rk}`, rk, t: `Film ${rk}`, y: 2000, d: 6000000 });
	const text = renderYaml({ name: 'Zack', createdAt: 1794398400, entries: Array.from({ length: 300 }, (_, i) => movie(i + 1)) });
	assert.strictEqual(readPlayerYaml(text).entriesCount, 300);
	const lines = text.split('\n');
	const garbled = lines.map((line, i) => (i === lines.length - 2 ? '    - {"k": "movie", "t": ' : line)).join('\r\n');
	assert.strictEqual(readPlayerYaml(garbled).entriesCount, 300, 'a broken entry line is dropped unread, CRLF and all');
	// The broken last entry makes the whole file unreadable, so each of these reads only if the block is cut.
	const broken = garbled.replace(/\r\n/g, '\n');
	const params = readPlayerYaml(text).params;
	const blockStyle = text.replace(/\n {2}entries:\n[\s\S]*$/, `\n  entries:\n${Array.from({ length: 300 }, (_, i) => `  - k: movie\n    id: rk:${i + 1}\n    t: Film ${i + 1}\n`).join('')}`)
		.replace(/t: Film 300\n$/, 't: "Film 300\n');
	for (const [layout, file] of [
		['no final line end', broken.replace(/\n$/, '')],
		['CR only', broken.replace(/\n/g, '\r')],
		['a space after entries:', broken.replace('\n  entries:\n', '\n  entries: \n')],
		['a comment after entries:', broken.replace('\n  entries:\n', '\n  entries:  # the titles\n')],
		['entries indented as a YAML tool writes them', broken.replace(/\n {4}- /g, '\n  - ')],
		['a comment among the entries', broken.replace('\n    - {"k":"movie","id":"rk:150"', '\n  # half way\n    - {"k":"movie","id":"rk:150"')],
		['a comment after the entries', `${broken}# edited by Ana\n`],
		['a setting after the entries', `${broken}\n  item_links: []\n`],
		['entries written out over lines', blockStyle],
	]) {
		const read = readPlayerYaml(file);
		assert.strictEqual(read.entriesCount, 300, layout);
		assert.deepStrictEqual(read.params, { ...params, passthrough: read.params.passthrough }, layout);
	}
	assert.deepStrictEqual(readPlayerYaml(`${broken}  item_links: []\n`).passthrough, [['item_links', []]], 'a setting after the entries is read');
	// After the cut, a problem is still named at its line in the file.
	refusesAt(`${broken}  goal_percent: 5\n`, lines.length, 'a key is given twice');
	refusesAt(`${broken}  item_links: [\n`, lines.length, 'a quoted text or a bracket is not closed, or a line of it is not indented');
	refusesAt(broken.replace(/\n/g, '\r').concat('  item_links: !!omap []\r'), lines.length, 'it uses !!omap or !!pairs, which the bot does not copy: write a mapping or a list instead');

	const entriesFirst = text.replace('  list_info: ', '  entries_note: 1\n  list_info: ').replace(/\n {2}entries:\n((?: {4}- .*\n)+)/, '\n');
	const moved = entriesFirst.replace('  starting_unlocks: 3\n', `  starting_unlocks: 3\n  entries:\n${lines.filter((l) => l.startsWith('    - ')).slice(0, 2).join('\n')}\n`);
	const read = readPlayerYaml(moved);
	assert.strictEqual(read.entriesCount, 2, 'entries before other settings: the whole file is parsed');
	assert.ok(read.passthrough.some(([key]) => key === 'entries_note'));
	assert.throws(() => readPlayerYaml(`${text}  - stray\n`), (err) => err.message.startsWith(`The file could not be read at line ${lines.length}: `),
		'an item at another indent ends the block, and a broken file still says so at its line');
});

function refusesAt(text, line, what) {
	assert.throws(() => readPlayerYaml(text), (err) => err.message === `The file could not be read at line ${line}: ${what}.`, `line ${line}: ${what}`);
}

test('the file\'s entries and list_info are dropped: the new file has the bot\'s list_info, fresh titles, and each key once', async () => {
	const text = creatorYaml({
		list_info: '{builder: 1, created_at: 1, label: Old, account: 1, discord: "999"}',
		entries: '[{k: movie, id: "rk:1001", rk: 1001, t: Old, d: 1}, {k: movie, id: "rk:1", rk: 1, t: Gone, d: 1}]',
	});
	const read = readPlayerYaml(text);
	assert.strictEqual(read.entriesCount, 2);
	assert.ok(read.passthrough.every(([key]) => key !== 'entries' && key !== 'list_info'));
	assert.throws(() => validateParams({ ...read.params, passthrough: [...read.passthrough, ['list_info', {}]] }), /`list_info` is written by the bot/);
	const out = await setup().builder.build({ ...read.params, accountId: 5, discordUserId: '42' });
	const info = JSON.parse(out.yaml.split('\n').find((l) => l.startsWith('  list_info: ')).slice('  list_info: '.length));
	assert.deepStrictEqual([info.account, info.discord, info.label], [5, '42', 'Zack\'s list']);
	assert.ok(!entriesOf(out.yaml).some((e) => e.id === 'rk:1'), 'no title of the old list is copied');
	for (const key of ['entries', 'list_info', 'list_movies', 'goal_percent']) {
		assert.strictEqual(out.yaml.split('\n').filter((l) => l.startsWith(`  ${key}:`)).length, 1, key);
	}
});

// The reader runs on the main thread, which voice playback and the gateway heartbeat share, for
// anyone who may run /apmedia yaml.
test('one mapping of many keys reads in time that grows with its length, and a repeated key still names its line', () => {
	const { parsePlayerFile } = _internal;
	const n = 15000;
	const head = 'name: Zack\ngame: Plex Media\nPlex Media:\n';
	// The same keys in one mapping, and each in a mapping of its own. The package's own repeat check
	// compares each key with every key before it in its mapping, which made the first about 13 times
	// slower than the second at this size (3.2 s against 0.25 s); without it they take about as long.
	const flat = `${head}${Array.from({ length: n }, (_, i) => `  k${i}:`).join('\n')}\n`;
	const split = `${head}  k:\n${Array.from({ length: n }, (_, i) => `    - k${i}:`).join('\n')}\n`;
	const time = (text) => {
		const start = process.hrtime.bigint();
		parsePlayerFile(text);
		return Number(process.hrtime.bigint() - start) / 1e6;
	};
	parsePlayerFile(`${head}  a: 1\n`);
	const splitMs = Math.min(time(split), time(split));
	const flatMs = Math.min(time(flat), time(flat));
	assert.ok(flatMs < splitMs * 4 + 50, `${n} keys in one mapping took ${Math.round(flatMs)} ms, in ${n} mappings ${Math.round(splitMs)} ms`);
	assert.throws(() => parsePlayerFile(`${flat}  k${n - 1}: 2\n`), (err) => err.message === `The file could not be read at line ${n + 4}: a key is given twice.`);
	assert.throws(() => parsePlayerFile(`${head}  a:\n    b: 1\n    b: 2\n  c: 1\n  c: 2\n`), (err) => err.message === 'The file could not be read at line 6: a key is given twice.',
		'the first repeat in the file is the one named');
	const read = parsePlayerFile(`${head}  1: a\n  "1": b\n  "<<": c\n`).get('Plex Media');
	assert.deepStrictEqual([...read.keys()], [1, '1', '<<'], 'a number and its text are two keys, as in Archipelago\'s loader, and a quoted << is text');
	assert.throws(() => parsePlayerFile(`${head}  base: &b {x: 1}\n  m:\n    <<: *b\n`), (err) => err.message === 'The file could not be read at line 6: it uses a << merge, which Archipelago cannot read: write the keys out instead.');
});

test('the settings copied as they are take 32 KB at most, counted as they are written, so aliases cannot blow a reply up', () => {
	const { COPY_MAX_BYTES } = _internal;
	assert.strictEqual(COPY_MAX_BYTES, 32 * 1024);
	const over = (key) => `The settings the bot copies as they are can take 32 KB in all, and \`${key}\` goes past that: shorten it or take it out of the file.`;
	const file = (lines) => `name: Zack\ngame: Plex Media\nPlex Media:\n  list_preset: movies\n${lines.join('\n')}\n`;
	// "  blob: " and the quotes and line break around the text are 11 bytes.
	const blob = (n) => file([`  blob: "${'a'.repeat(n)}"`]);
	assert.strictEqual(readPlayerYaml(blob(COPY_MAX_BYTES - 11)).passthrough[0][1].length, COPY_MAX_BYTES - 11, 'exactly 32 KB is copied');
	assert.throws(() => readPlayerYaml(blob(COPY_MAX_BYTES - 10)), (err) => err.message === over('blob'));
	const accents = file([`  blob: "${String.fromCharCode(0xe9).repeat(COPY_MAX_BYTES / 2)}"`]);
	assert.throws(() => readPlayerYaml(accents), (err) => err.message === over('blob'), 'bytes are counted, not characters');

	// One anchored value used 20 times: a 2 KB file, 42 KB once written out.
	const aliased = file([`  a: &x "${'a'.repeat(2000)}"`, ...Array.from({ length: 20 }, (_, i) => `  b${i}: *x`)]);
	assert.ok(aliased.length < 2500);
	assert.throws(() => readPlayerYaml(aliased), (err) => /^The settings the bot copies as they are can take 32 KB in all, and `b1\d` goes past that/.test(err.message), 'stopped at the alias that crosses it');
	const list = file([`  a: &x [${Array.from({ length: 2000 }, () => '1').join(', ')}]`, ...Array.from({ length: 20 }, (_, i) => `  b${i}: *x`)]);
	assert.throws(() => readPlayerYaml(list), /goes past that/, 'a list is counted item by item');
	const big = file([`  a: &x "${'a'.repeat(50000)}"`, ...Array.from({ length: 20 }, (_, i) => `  b${i}: *x`)]);
	assert.throws(() => readPlayerYaml(big), (err) => err.message === over('a'));

	assert.throws(() => validateParams({ name: 'Z', passthrough: [['blob', 'a'.repeat(COPY_MAX_BYTES)]] }), (err) => err.message === over('blob'), 'build() checks it too');
	assert.throws(() => renderYaml({ name: 'Z', entries: [], passthrough: [['x', 1], ['blob', 'a'.repeat(COPY_MAX_BYTES)]] }), (err) => err.message === over('blob'));
});

test('a file is parsed only up to 64 K of settings, the bot\'s entries block left out, and the fullest list the bot writes still reads back', () => {
	const { SETTINGS_MAX, COPY_MAX_BYTES } = _internal;
	assert.strictEqual(SETTINGS_MAX, 64 * 1024);
	const TOO_BIG = 'The file\'s settings take more than 64 KB, the most the bot reads: attach the YAML the Options Creator saved, or a list the bot wrote.';
	const player = 'name: Zack\ngame: Plex Media\nPlex Media:\n  list_preset: movies\n';
	// 250,000 empty documents took 3.4 s to parse, and Archipelago skips every one of them.
	const docs = `${'---\n'.repeat(250000)}${player}`;
	assert.ok(Buffer.byteLength(docs) <= FILE_MAX_BYTES);
	assert.throws(() => readPlayerYaml(docs), (err) => err.message === TOO_BIG);
	const pad = (n) => `${player}  pad: "${'a'.repeat(n)}"\n`;
	const fits = pad(SETTINGS_MAX - pad(0).length);
	assert.strictEqual(fits.length, SETTINGS_MAX);
	assert.throws(() => readPlayerYaml(fits), /goes past that/, '64 K of settings are parsed, and then the copy room says no');
	assert.throws(() => readPlayerYaml(`${fits} `), (err) => err.message === TOO_BIG);

	const movie = (rk) => ({ k: 'movie', id: `rk:${rk}`, rk, t: `Film ${rk}`, y: 2000, d: 6000000 });
	const long = renderYaml({ name: 'Zack', createdAt: 1794398400, entries: Array.from({ length: 2000 }, (_, i) => movie(i + 1)) });
	assert.ok(long.length > 2 * SETTINGS_MAX);
	assert.strictEqual(readPlayerYaml(long).entriesCount, 2000, 'the entries block of a list the bot wrote is never parsed');
	const longer = renderYaml({ name: 'Zack', createdAt: 1794398400, entries: Array.from({ length: 2001 }, (_, i) => movie(i + 1)) });
	assert.throws(() => readPlayerYaml(longer), (err) => err.message === TOO_BIG, 'more entries than a list holds are not counted, and the file is read whole');

	// 50 titles of 200 characters outside the BMP, two each in UTF-16, the longest label, playlist,
	// collection and genre, and copied settings that fill their room.
	const wide = String.fromCodePoint(0x1f600);
	const titles = Array.from({ length: 50 }, (_, i) => `movie: ${wide.repeat(199)}${i % 10} (1999)`).join('; ');
	const fullest = renderYaml({
		name: 'ABCDEFGHIJKLMNOP',
		label: wide.repeat(100),
		createdAt: 1794398400,
		list: { list_preset: 'none', list_titles: titles, list_playlist: wide.repeat(200), list_collection: wide.repeat(200), list_genre: wide.repeat(60), list_label: wide.repeat(100) },
		passthrough: [['notes', 'a'.repeat(COPY_MAX_BYTES - 12)]],
		listInfo: { account: 123456789, discord: '123456789012345678901' },
		entries: [movie(1)],
	});
	const read = readPlayerYaml(fullest);
	assert.deepStrictEqual([read.params.titles, read.params.label, read.passthrough[0][1].length], [titles, wide.repeat(100), COPY_MAX_BYTES - 12]);
	const settings = fullest.slice(0, fullest.indexOf('  entries:'));
	assert.ok(settings.length > 0.8 * SETTINGS_MAX && Buffer.byteLength(settings) > SETTINGS_MAX, `${settings.length} UTF-16 units, ${Buffer.byteLength(settings)} bytes`);
});

test('a timer the file leaves random is planned at its lowest roll too, so a long list never fails Archipelago on a low roll', async () => {
	// Each 30-minute episode is 27 locations at 1 minute and 14 at 2; 400 of them make 10,800 and 5,600.
	const params = (timer) => readPlayerYaml(creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'show: Huge Show S1\'', goal_percent: '80', timesanity_episodes: timer })).params;
	const build = (timer) => setup({ library: { hugeShowEpisodes: 400 } }).builder.build({ ...params(timer), accountId: 5, discordUserId: '42' });
	const refused = 'Timesanity: Episodes (`timesanity_episodes`) is random in your file, and a roll of 1 would make 10800 locations (at most 10000): set a number, or use random-range-2-240.';
	for (const timer of ['random', 'random-low', 'random-range-0-5', '{15: 9, 1: 1}', '[10, 1]', '{random-high: 1}', '{15: 9, "0_1": 1}', '[10, "\\uff11"]']) {
		await assert.rejects(build(timer), (err) => err.message === refused, timer);
	}
	// A trigger writes its value over the file's before Archipelago plans the slot, whether or not it is
	// sure to fire, and whatever it compares.
	const triggered = (set, head = 'option_category: Plex Media, option_name: tv_unlock, option_result: episodes') => setup({ library: { hugeShowEpisodes: 400 } }).builder.build({
		...readPlayerYaml(creatorYaml({ list_preset: 'none', list_shows: 'preset', list_titles: '\'show: Huge Show S1\'', goal_percent: '80',
			triggers: `[{${head}, options: {Plex Media: {${set}}}}]` })).params,
		accountId: 5,
		discordUserId: '42',
	});
	const byTrigger = 'A trigger in your file sets Timesanity: Episodes (`timesanity_episodes`), and at 1 the list makes 10800 locations (at most 10000): have the trigger set it to 2 or more.';
	for (const [set, head] of [['timesanity_episodes: 1'], ['timesanity_episodes: random'], ['timesanity_episodes: {15: 9, 1: 1}'], ['timesanity_episodes: 1', 'option_category: Plex Media, option_name: tv_unlock, option_result: season, percentage: 50'],
		['timesanity_episodes: 1', 'option_name: name, option_result: Zack']]) {
		await assert.rejects(triggered(set, head), (err) => err.message === byTrigger, `${head || ''} ${set}`);
	}
	for (const set of ['timesanity_episodes: 2', 'timesanity_episodes: 0', 'wild_tickets: 5', '"-timesanity_episodes": [1]']) {
		assert.strictEqual((await triggered(set)).summary.locations, 1200, set);
	}
	// Two triggers on one timer: the lower value counts, whichever comes first.
	await assert.rejects(triggered('timesanity_episodes: 1}}}, {option_name: name, option_result: x, options: {Plex Media: {timesanity_episodes: 10'), (err) => err.message === byTrigger);
	for (const timer of ['random-range-2-240', '{15: 9, 2: 1}', '[10, 2, off]', '{off: 1, low: 1}']) {
		const out = await build(timer);
		assert.strictEqual(out.summary.locations, 1200, `${timer}: planned at the default, 10`);
	}
	assert.match((await build('random-range-2-240')).yaml, /\n {2}timesanity_episodes: "random-range-2-240"\n/);
	// One choice weighted above 0 is the only one Archipelago can roll: the option is that value.
	const single = await build('{15: 9, 1: 0}');
	assert.deepStrictEqual([params('{15: 9, 1: 0}').timeEpisodes, single.summary.locations], [15, 800]);
	assert.match(single.yaml, /\n {2}timesanity_episodes: 15\n/);

	// 300 episodes and 40 mixes of 50 minutes: each timer at its lowest alone fits, both together do not.
	const both = setup({ library: { hugeShowEpisodes: 300, bigAudioPlaylist: 5000 } }).builder.build({
		name: 'Zack', titles: 'show: Huge Show S1', playlist: 'Everything Ever', passthrough: [['timesanity_episodes', 'random'], ['timesanity_albums', 'random']],
	});
	await assert.rejects(both, (err) => err.message === 'Timesanity: Episodes (`timesanity_episodes`) and Timesanity: Albums (`timesanity_albums`) are random in your file, and if they all roll their lowest '
		+ 'the list makes 10460 locations (at most 10000): set a number for one of them.');
	const episodesTrigger = [new Map([['option_category', 'Plex Media'], ['option_name', 'tv_unlock'], ['option_result', 'episodes'],
		['options', new Map([['Plex Media', new Map([['timesanity_episodes', 'random']])]])]])];
	const mixed = setup({ library: { hugeShowEpisodes: 300, bigAudioPlaylist: 5000 } }).builder.build({
		name: 'Zack', titles: 'show: Huge Show S1', playlist: 'Everything Ever', passthrough: [['timesanity_albums', 'random'], ['triggers', episodesTrigger]],
	});
	const together = 'Timesanity: Albums (`timesanity_albums`) and Timesanity: Episodes (`timesanity_episodes`) are random in your file or set by a trigger in it, '
		+ 'and if they all take their lowest the list makes 10460 locations (at most 10000): raise one of them.';
	await assert.rejects(mixed, (err) => err.message === together);
	// A timer random in the file and set higher by a trigger is tried at the lower of the two.
	const higher = [new Map([['option_category', 'Plex Media'], ['option_name', 'tv_unlock'], ['option_result', 'episodes'],
		['options', new Map([['Plex Media', new Map([['timesanity_episodes', 200]])]])]])];
	const lowerOfTwo = setup({ library: { hugeShowEpisodes: 300, bigAudioPlaylist: 5000 } }).builder.build({
		name: 'Zack', titles: 'show: Huge Show S1', playlist: 'Everything Ever', passthrough: [['timesanity_albums', 'random'], ['timesanity_episodes', 'random'], ['triggers', higher]],
	});
	await assert.rejects(lowerOfTwo, (err) => err.message === together);

	// BUGTESTING Phase 17's step: a show of half-hour episodes, which run about 22 minutes in Plex,
	// named without seasons stops at List: Episodes per Show; named with its seasons it does not.
	const shortEpisodes = (n) => setup({ library: { hugeShowEpisodes: n }, mutate: (lib) => { for (const e of lib.leaves[2099]) e.duration = 22 * 60000; } }).builder;
	const named = (titles) => ({ ...readPlayerYaml(creatorYaml({ list_preset: 'movies', list_shows: 'preset', list_titles: titles, goal_percent: '80', timesanity_episodes: 'random' })).params,
		accountId: 5, discordUserId: '42' });
	assert.strictEqual((await shortEpisodes(520).build(named('\'show: Huge Show\''))).summary.counts.episode, 24);
	await assert.rejects(shortEpisodes(520).build(named('\'show: Huge Show S1\'')), (err) => err.message === 'Timesanity: Episodes (`timesanity_episodes`) is random in your file, '
		+ 'and a roll of 1 would make 10515 locations (at most 10000): set a number, or use random-range-2-240.');
	assert.strictEqual((await shortEpisodes(490).build(named('\'show: Huge Show S1\''))).summary.counts.episode, 490);

	const { lowestRoll } = _internal;
	const books = contracts.OPTIONS.timesanity_books;
	assert.deepStrictEqual([
		lowestRoll(books, 'random'), lowestRoll(books, 'RANDOM-Range-High-40-30'), lowestRoll(books, 'random-range-0-0'), lowestRoll(books, new Map([['default', 1], [true, 1]])),
		lowestRoll(books, new Map([['high', 2], ['low', 5]])), lowestRoll(books, ['1500', 'nonsense', 2000, -1]), lowestRoll(books, new Map([[5, '0'], [45, '3']])),
		lowestRoll(books, new Map([[5, 0.5], [45, 1]])),
	], [1, 30, null, 30, 1440, null, 45, 45], 'a weight goes through Python\'s int(), so 0.5 never rolls');
});

test('contracts.LIST_OPTIONS and PRESETS mirror apworld/plex_media/constants.py, and every list setting has a builder param', (t) => {
	assert.deepStrictEqual(Object.keys(_internal.LIST_PARAMS), Object.keys(contracts.LIST_OPTIONS));
	const script = [
		'import importlib.util, json, sys',
		'spec = importlib.util.spec_from_file_location("plex_media_constants", sys.argv[1])',
		'mod = importlib.util.module_from_spec(spec)',
		'spec.loader.exec_module(mod)',
		'sys.stdout.write(json.dumps({"LIST_OPTIONS": mod.LIST_OPTIONS, "PRESETS": mod.PRESETS}))',
	].join('\n');
	const constants = path.join(__dirname, '..', 'apworld', 'plex_media', 'constants.py');
	// -B: no __pycache__ left in apworld/plex_media for the apworld build or a commit to pick up.
	const run = spawnSync('py', ['-3.13', '-I', '-B', '-c', script, constants], { encoding: 'utf8', timeout: 60000, windowsHide: true });
	if (run.error && run.error.code === 'ENOENT') {
		t.skip('the py launcher is not installed');
		return;
	}
	assert.strictEqual(run.status, 0, run.stderr);
	const py = JSON.parse(run.stdout);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(contracts.LIST_OPTIONS)), py.LIST_OPTIONS);
	assert.deepStrictEqual(Object.keys(contracts.LIST_OPTIONS), Object.keys(py.LIST_OPTIONS), 'in the order the YAML writes them');
	assert.deepStrictEqual(JSON.parse(JSON.stringify(contracts.PRESETS)), py.PRESETS);
});

test('contracts.SETTING_NAMES are the display names apworld/plex_media/options.py gives the Options Creator, for every option and list setting', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'apworld', 'plex_media', 'options.py'), 'utf8').replace(/\r\n/g, '\n');
	const shown = {};
	for (const block of source.split(/^(?=class )/m)) {
		const head = /^class (\w+)\(/.exec(block);
		const name = /^\tdisplay_name = "([^"]+)"$/m.exec(block);
		if (head && name) shown[head[1]] = name[1];
	}
	const classOf = Object.fromEntries([...source.split('class PlexMediaOptions(')[1].matchAll(/^\t(\w+): (\w+)$/gm)].map((m) => [m[1], m[2]]));
	const keys = [...Object.keys(contracts.OPTIONS), ...Object.keys(contracts.LIST_OPTIONS)];
	assert.deepStrictEqual(contracts.SETTING_NAMES, Object.fromEntries(keys.map((key) => [key, shown[classOf[key]]])));
});

test('a choice\'s number is its place in the table, as apworld/plex_media/options.py numbers it, so a file may give either', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'apworld', 'plex_media', 'options.py'), 'utf8').replace(/\r\n/g, '\n');
	const numbers = {};
	for (const block of source.split(/^(?=class )/m)) {
		const head = /^class (\w+)\(/.exec(block);
		if (head) numbers[head[1]] = Object.fromEntries([...block.matchAll(/^\toption_(\w+) = (\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
	}
	const classOf = Object.fromEntries([...source.split('class PlexMediaOptions(')[1].matchAll(/^\t(\w+): (\w+)$/gm)].map((m) => [m[1], m[2]]));
	const param = { tv_unlock: 'tvUnlock', locked_watches: 'lockedWatches', checkpoint_items: 'checkpointItems', list_preset: 'preset' };
	const choices = Object.entries({ ...contracts.OPTIONS, ...contracts.LIST_OPTIONS }).filter(([, spec]) => spec.type === 'choice');
	assert.deepStrictEqual(choices.map(([key]) => key), Object.keys(param));
	for (const [key, spec] of choices) {
		assert.deepStrictEqual(numbers[classOf[key]], Object.fromEntries(spec.values.map((value, i) => [value, i])), key);
		assert.deepStrictEqual(spec.values.map((value, i) => readPlayerYaml(creatorYaml({ [key]: String(i), list_titles: '\'Heat\'' })).params[param[key]]), spec.values, key);
	}
});
