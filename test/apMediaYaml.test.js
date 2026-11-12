// helpers/apMediaYaml.js: the Plex Media player YAML builder (spec 5.11): parameter checks, the
// unwatched rule, the three sources (hand-picked titles, a playlist or collection, random picks),
// music curation and album twins, books, the summary and caps, and the exact YAML layout.
//
// A YAML that AP's loader refuses stops the whole multiworld from generating, and a friend's list
// filtered by the owner's history hands them the wrong titles, so the layout is compared line for
// line, odd characters are run through it, and every history read is checked for the account it
// used. Two players' YAML file names must never collide in the owner's Players folder.
//
// Harness: the real createPms client over the fetch stand-in in
// test/fixtures/apmediaPlex/fakePms.js, serving the invented library in
// test/fixtures/apmediaPlex/library.js, with that file's catalog, longForm and bookmarks fakes, a
// fixed clock and a seeded random. No network.

const test = require('node:test');
const assert = require('node:assert');
const { createPms } = require('../helpers/apMediaPlex.js');
const { createBuilder, renderYaml, summaryLines, validateParams, ACCOUNT_FIX, _internal } = require('../helpers/apMediaYaml.js');
const { planSlot } = require('../helpers/apMediaPlan.js');
const contracts = require('../helpers/apMediaContracts.js');
const { buildLibrary, fakeLongForm, fakeCatalog, fakeBookmarks } = require('./fixtures/apmediaPlex/library.js');
const { createFakePlex } = require('./fixtures/apmediaPlex/fakePms.js');

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
		'    Plex Media: 0.1.0',
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
		`  list_info: {"builder":1,"created_at":${created},"label":"Zack's list","account":1,"discord":"1234"}`,
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
	assert.deepStrictEqual(JSON.parse(line.slice('  list_info: '.length)), { builder: 1, created_at: 1794398400, label: "Z's list", account: null, discord: '42' });
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
	assert.ok(noAccount.summary.warnings.includes('Breaking Bad starts at its first episode: without a linked Plex account nothing is known as watched.'));
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
	await assert.rejects(setup().builder.build({ name: 'Ears', playlist: 'Beach Photos' }), /No playlist called "Beach Photos"/);
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
	await assert.rejects(setup().builder.build({ name: 'Friend', accountId: 5, collection: 'Nope Nothing' }), /No movie or TV collection called "Nope Nothing"/);
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
		/too big for one slot: 1900 entries \(at most 2000\), 159 unlock copies \(at most 2000\), 51300 locations \(at most 10000\)/);

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
	await assert.rejects(setup().builder.build({ name: 'Zack', titles: 'qqqq; wwww' }), /Nothing on the list.*Not found: qqqq; wwww/);
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
