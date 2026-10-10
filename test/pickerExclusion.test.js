// Books kept out of the music pickers and searches that read the catalog through
// helpers/longForm.js: app/bot.js (findRandomTracksOnPlex, playOneMood, findSong, findAlbum,
// loadAlbum, findArtist, loadPlaylist), Hitster's track pool, helpers/plexTags.js count and
// sample, and commands/list.js and commands/playlist.js/add.js.
//
// The bug: every one of these drew from the whole music section or a /search page, and the
// section holds 900-odd audiobook chapters. !random and !mood dealt chapters, Hitster dealt 597
// dated book parts as "songs", the smart playlist "All Music" queued every book, a search for an
// author listed chapter files to !playsong, and a vibe sample drew offsets from an unfiltered
// count. Search also numbers its hits for !playsong and playlist choice, so a filter that hid
// books from the reply but kept them in bot.tracks would play the wrong track for a number.
//
// Harness: the catalog store seeded as in test/longForm.test.js (pid-suffixed
// PLEXBOT_BOOK_CATALOG_FILE before the first require, a deep clone of the synthetic
// test/fixtures/books/catalog.json, exclusion asserted on first). app/bot.js is required as in
// test/stopClearsQueue.test.js, but nothing here plays: playSong is stubbed on the instance and
// bot.plex.query answers from the synthetic test/fixtures/books/library.json. Hitster runs the
// real command as test/voiceClaims.test.js does, with the shared Plex client's query stubbed and
// the clip's playSong held forever so the first turn stops right after it queues its track.
// Math.random is pinned to 0 where a pick is random, with the book tracks listed first, so a
// missing filter picks a book every time rather than by chance.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-picker-catalog-${process.pid}.json`);
const LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-picker-' + process.pid);
const PLAYLIST_DIR = pathMod.join(os.tmpdir(), `plexbot-test-picker-playlists-${process.pid}`) + pathMod.sep;
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = LOG_DIR;

const config = require('../config/config');
const store = require('../helpers/bookCatalogStore.js');
const longForm = require('../helpers/longForm.js');
const { getPlex } = require('../helpers/plexClient.js');
const Bot = require('../app/bot.js');
const hitster = require('../commands/hitster.js');
const plexTags = require('../helpers/plexTags.js');
const list = require('../commands/list.js');
const playlistAdd = require('../commands/playlist.js/add.js');
const language = require('../lang/en.js');
const CATALOG = require('./fixtures/books/catalog.json');
const LIBRARY = require('./fixtures/books/library.json');

const originalSetting = config.audiobooksExcludeFromMusic;
const realRandom = Math.random;
const sharedPlex = getPlex();
const realSharedQuery = sharedPlex.query;

const BOOK_KEYS = ['20027', '20028', '20087', '20001', '20108', '20115'];
const SONG_KEYS = ['20150', '20151', '20152'];
const GLASS_ROAD = '📚 Also in your books: The Glass Road (Avery Quill), `/book play the glass road`';

function clone(x) {
	return JSON.parse(JSON.stringify(x));
}

function track(ratingKey, extra = {}) {
	const t = LIBRARY.tracks.find((x) => x.ratingKey === ratingKey);
	assert.ok(t, `fixture track ${ratingKey}`);
	return Object.assign(clone(t), extra);
}

function album(ratingKey) {
	const a = LIBRARY.albums.find((x) => x.ratingKey === ratingKey);
	assert.ok(a, `fixture album ${ratingKey}`);
	return clone(a);
}

const partKey = (ratingKey) => track(ratingKey).Media[0].Part[0].key;
const books = () => BOOK_KEYS.map((k) => track(k));
const songs = () => SONG_KEYS.map((k) => track(k));

function seed() {
	config.audiobooksExcludeFromMusic = true;
	store.replace(clone(CATALOG));
	assert.strictEqual(longForm.enabled(), true, 'the seeded catalog turns the exclusion on');
	assert.notStrictEqual(longForm.plexExclusion(), '', 'the seeded catalog gives a fragment');
}

function replies() {
	const sent = [];
	const push = async (x) => { sent.push(typeof x === 'string' ? x : x); return {}; };
	return { sent, message: { reply: push, channel: { send: push } } };
}

function makeBot(route) {
	const bot = new Bot({});
	const urls = [];
	bot.plex = { query: async (url) => { urls.push(url); return { MediaContainer: route(url) }; } };
	bot.played = [];
	bot.playSong = (message) => { bot.played.push(message); };
	bot.urls = urls;
	return bot;
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test.afterEach(() => {
	Math.random = realRandom;
	sharedPlex.query = realSharedQuery;
	try { fs.unlinkSync(FILE); } catch (_) {}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	store.reset();
	config.audiobooksExcludeFromMusic = true;
});

test.after(() => {
	config.audiobooksExcludeFromMusic = originalSetting;
	try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {}
	try { fs.rmSync(PLAYLIST_DIR, { recursive: true, force: true }); } catch (_) {}
});

// app/bot.js ----------------------------------------------------------------------------------

test('!random never picks a book track', async () => {
	seed();
	for (const r of [0, 0.4, 0.999]) {
		Math.random = () => r;
		const bot = makeBot(() => ({ Metadata: [...books(), ...songs()] }));
		bot.cache_library = { 1: { name: 'Music', key: '1' } };
		const { message } = replies();
		await bot.findRandomTracksOnPlex(message);
		assert.strictEqual(bot.songQueue.length, 1);
		assert.ok(SONG_KEYS.map(partKey).includes(bot.songQueue[0].key), `random ${r} picked ${bot.songQueue[0].title}`);
		assert.strictEqual(bot.played.length, 1);
	}
});

test('!random in a library of only books says so and queues nothing', async () => {
	seed();
	const bot = makeBot(() => ({ Metadata: books() }));
	bot.cache_library = { 1: { name: 'Books', key: '1' } };
	const { message, sent } = replies();
	await bot.findRandomTracksOnPlex(message);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.deepStrictEqual(sent, ['That library has no music to pick from.']);
});

test('!mood never picks a book track', async () => {
	seed();
	Math.random = () => 0;
	const bot = makeBot(() => ({ Metadata: [...books(), ...songs()] }));
	bot.cache_library = { 1: { name: 'Music', key: '1', mood: { Calm: { url: '/library/sections/1/all?type=10&mood=7' } } } };
	await bot.playOneMood('Calm', replies().message);
	assert.strictEqual(bot.songQueue.length, 1);
	assert.strictEqual(bot.songQueue[0].key, partKey('20150'));
});

test('a search lists only music, numbered for !playsong, and points at the books', async () => {
	seed();
	const page = [track('20027'), track('20150'), track('20028'), track('20151')];
	const bot = makeBot(() => ({ size: 4, Metadata: page }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('glass', 0, 10, message);

	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), ['20150', '20151'], '!playsong 1 and 2 index the music hits');
	assert.strictEqual(bot.plexOffset, 4, '!nextpage advances past the whole raw page');
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n1 - Theo Bramble - Song 1\n2 - Theo Bramble - Song 2\n/);
	assert.ok(sent[0].includes(GLASS_ROAD + '\n'), sent[0]);
	assert.doesNotMatch(sent[0], /intro/, 'no chapter is listed');
	assert.deepStrictEqual(bot.songQueue, []);
});

test('a search with one song among books queues the song and still points at the books', async () => {
	seed();
	const bot = makeBot(() => ({ size: 3, Metadata: [track('20027'), track('20150'), track('20028')] }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('glass', 0, 10, message);

	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20150')]);
	assert.strictEqual(bot.played.length, 1);
	assert.deepStrictEqual(sent, [GLASS_ROAD]);
});

test('a search whose every hit is a chapter answers with /book, not a song list', async () => {
	seed();
	const bot = makeBot(() => ({ size: 2, Metadata: [track('20027'), track('20028')] }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('glass', 0, 10, message);

	assert.deepStrictEqual(bot.tracks, []);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.deepStrictEqual(sent, ['Those are audiobook chapters, not songs. 📚 The Glass Road (Avery Quill), `/book play the glass road`']);
});

test('with the exclusion off a search behaves as before', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	const page = [track('20027'), track('20150')];
	const bot = makeBot(() => ({ size: 2, Metadata: page }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('glass', 0, 10, message);

	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), ['20027', '20150']);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n1 - GraphicAudio - 01 intro\n2 - Theo Bramble - Song 1\n/);
	assert.doesNotMatch(sent[0], /📚/);
});

// The bug: findSong chose between auto-queue, list and "not songs" by the music left after the
// filter, even on a full raw page. One song among nine chapters started playing unchosen while
// the wanted song sat on page 2, and a page of ten chapters answered "not songs" with no
// !nextpage hint.
function bookHits(n) {
	const hits = LIBRARY.tracks.filter((t) => longForm.isLongFormTrack(t)).slice(0, n).map(clone);
	assert.strictEqual(hits.length, n, `the fixture has ${n} book tracks`);
	return hits;
}

test('a full page with one song among chapters lists the song with the paging hint instead of queueing it', async () => {
	seed();
	const bot = makeBot(() => ({ size: 10, Metadata: [...bookHits(9), track('20150')] }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('prologue', 0, 10, message);

	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(bot.played.length, 0);
	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), ['20150']);
	assert.strictEqual(bot.plexOffset, 10);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n1 - Theo Bramble - Song 1\n📚 Also in your books: /);
	assert.ok(sent[0].endsWith(language.BOT_FIND_SONG_INFO.format({ commandPrefix: bot.config.commandPrefix })), sent[0]);
});

test('a full page of only chapters still offers the next page', async () => {
	seed();
	const bot = makeBot(() => ({ size: 10, Metadata: bookHits(10) }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('prologue', 0, 10, message);

	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(bot.plexOffset, 10);
	assert.strictEqual(sent.length, 1);
	assert.ok(sent[0].startsWith(longForm.ONLY_PREFIX), sent[0]);
	assert.ok(sent[0].endsWith(`\n**${bot.config.commandPrefix}nextpage** if the music you want is not in this page.`), sent[0]);
});

test('with the exclusion off a lone hit at offset 0 is queued as before', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	const bot = makeBot(() => ({ size: 1, Metadata: [track('20027')] }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('intro', 0, 10, message);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20027')]);
	assert.strictEqual(bot.played.length, 1);
	assert.deepStrictEqual(sent, []);
});

test('with the exclusion off a full page is listed as before', async () => {
	seed();
	const page = [...bookHits(9), track('20150')];
	config.audiobooksExcludeFromMusic = false;
	const bot = makeBot(() => ({ size: 10, Metadata: page }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('prologue', 0, 10, message);
	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), page.map((t) => t.ratingKey));
	assert.deepStrictEqual(bot.songQueue, []);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n10 - Theo Bramble - Song 1\n/);
	assert.doesNotMatch(sent[0], /📚/);
});

// The bug: a hit kept out of music only by its podcast's artist (the artist's soundtrack album)
// maps to no work, so the reply fell back to "That is in your audiobooks, not your music" right
// beside the songs it had listed or just queued.
test('a song beside a hit excluded only by its podcast artist gets no audiobook line', async () => {
	seed();
	const ost = track('20116');
	assert.ok(longForm.isLongFormTrack(ost), 'the podcast artist\'s soundtrack is kept out of music');
	assert.deepStrictEqual(longForm.worksFor([ost]), [], 'and belongs to no work');

	const listed = makeBot(() => ({ size: 3, Metadata: [ost, track('20150'), track('20151')] }));
	listed.plexOffset = 0;
	const a = replies();
	await listed.findSong('valley', 0, 10, a.message);
	assert.strictEqual(a.sent.length, 1);
	assert.match(a.sent[0], /\n1 - Theo Bramble - Song 1\n2 - Theo Bramble - Song 2\n/);
	assert.doesNotMatch(a.sent[0], /📚/);

	const queued = makeBot(() => ({ size: 2, Metadata: [ost, track('20150')] }));
	queued.plexOffset = 0;
	const b = replies();
	await queued.findSong('valley', 0, 10, b.message);
	assert.deepStrictEqual(queued.songQueue.map((e) => e.key), [partKey('20150')]);
	assert.deepStrictEqual(b.sent, []);
});

test('a hit excluded only by its podcast artist still answers, saying why, when no song is left', async () => {
	seed();
	const bot = makeBot(() => ({ size: 1, Metadata: [track('20116')] }));
	bot.plexOffset = 0;
	const { message, sent } = replies();
	await bot.findSong('valley', 0, 10, message);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.deepStrictEqual(sent, [longForm.PODCAST_ARTIST_FALLBACK]);
});

test('!album skips a book album for the first music hit and points at the book', async () => {
	seed();
	const loaded = [];
	const bot = makeBot(() => ({ Metadata: [album('1010'), album('1070')] }));
	bot.loadAlbum = (key) => { loaded.push(key); };
	const { message, sent } = replies();
	await bot.findAlbum('glass', message);

	assert.deepStrictEqual(loaded, [album('1070').key]);
	assert.deepStrictEqual(sent, [GLASS_ROAD]);
});

test('!album on a book answers with /book and loads nothing', async () => {
	seed();
	const loaded = [];
	const bot = makeBot(() => ({ Metadata: [album('1010')] }));
	bot.loadAlbum = (key) => { loaded.push(key); };
	const { message, sent } = replies();
	await bot.findAlbum('glass road', message);

	assert.deepStrictEqual(loaded, []);
	assert.deepStrictEqual(sent, ['Those are audiobook chapters, not songs. 📚 The Glass Road (Avery Quill), `/book play the glass road`']);
});

// The bug: an album kept out only because its artist is a catalogued podcast artist belongs to
// no work, yet the reply sent the user to /book library, which does not list it.
test('!album on a podcast artist\'s other album says why it is kept out, not /book library', async () => {
	seed();
	const loaded = [];
	const bot = makeBot(() => ({ Metadata: [album('1051')] }));
	bot.loadAlbum = (key) => { loaded.push(key); };
	const { message, sent } = replies();
	await bot.findAlbum('tin valley', message);

	assert.deepStrictEqual(loaded, []);
	assert.strictEqual(sent.length, 1);
	assert.strictEqual(sent[0], longForm.PODCAST_ARTIST_FALLBACK);
	assert.doesNotMatch(sent[0], /book library/);
});

test('!album on that album with the exclusion off or no catalog loads it with no reply, as before', async () => {
	const setups = [
		() => { seed(); config.audiobooksExcludeFromMusic = false; },
		() => {
			try { fs.unlinkSync(FILE); } catch (_) {}
			store.reset();
			config.audiobooksExcludeFromMusic = true;
			assert.strictEqual(longForm.enabled(), false, 'no catalog');
		},
	];
	for (const setup of setups) {
		setup();
		const loaded = [];
		const bot = makeBot(() => ({ Metadata: [album('1051')] }));
		bot.loadAlbum = (key) => { loaded.push(key); };
		const { message, sent } = replies();
		await bot.findAlbum('tin valley', message);
		assert.deepStrictEqual(loaded, [album('1051').key]);
		assert.deepStrictEqual(sent, []);
	}
});

test('!album with no hit still fails as before', async () => {
	seed();
	const bot = makeBot(() => ({ size: 0 }));
	await assert.rejects(bot.findAlbum('nothing', replies().message), /The album was not found/);
});

test('an album load drops book parts it holds', async () => {
	seed();
	const bot = makeBot(() => ({ Metadata: [track('20150'), track('20027'), track('20151')] }));
	await bot.loadAlbum('/library/metadata/1099/children', replies().message);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20150'), partKey('20151')]);
});

test('!artist skips a book artist, book albums and book tracks, and points at the books', async () => {
	seed();
	const bookAlbum = Object.assign(album('1010'), { parentRatingKey: '9100' });
	const mixedAlbum = { type: 'album', ratingKey: '1099', parentRatingKey: '9100', key: '/library/metadata/1099/children', title: 'Mixed' };
	const bot = makeBot((url) => {
		if (url.startsWith('/search/?type=8')) {
			return { Metadata: [
				{ type: 'artist', ratingKey: '9006', title: 'Lantern Hollow', key: '/library/metadata/9006/children' },
				{ type: 'artist', ratingKey: '9100', title: 'Mixed Artist', key: '/library/metadata/9100/children' },
			] };
		}
		if (url === '/library/metadata/9100/children') return { Metadata: [bookAlbum, mixedAlbum] };
		if (url === '/library/metadata/1099/children') return { Metadata: [track('20150'), track('20087')] };
		throw new Error('unexpected Plex query ' + url);
	});
	const { message, sent } = replies();
	await bot.findArtist('lantern', message);

	assert.ok(!bot.urls.includes('/library/metadata/9006/children'), 'the podcast artist is never opened');
	assert.ok(!bot.urls.includes(bookAlbum.key), 'the book album is never opened');
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20150')]);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /^add lantern's albums to the queue\.\n📚 Also in your books: /);
	for (const title of ['The Tin Valley', 'The Glass Road', 'The Hollow King']) assert.ok(sent[0].includes(title), `${title} in ${sent[0]}`);
});

test('!artist on an author answers with /book and queues nothing', async () => {
	seed();
	const bot = makeBot(() => ({ Metadata: [{ type: 'artist', ratingKey: '9005', title: 'R.J. Ashdown', key: '/library/metadata/9005/children' }] }));
	const { message, sent } = replies();
	await bot.findArtist('ashdown', message);
	assert.deepStrictEqual(bot.songQueue, []);
	assert.deepStrictEqual(sent, ['Those are audiobook chapters, not songs. 📚 The Hollow King (R.J. Ashdown), `/book play the hollow king`']);
});

test('a smart playlist skips book tracks and says how many', async () => {
	seed();
	for (const [how, smartArg, container] of [['flag from the playlist list', true, {}], ['flag on the items', undefined, { smart: '1' }]]) {
		const bot = makeBot(() => Object.assign({ Metadata: [track('20027'), track('20150'), track('20087'), track('20151')] }, container));
		const { message, sent } = replies();
		await bot.loadPlaylist('/playlists/77/items', message, false, smartArg);
		assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20150'), partKey('20151')], how);
		assert.deepStrictEqual(sent, ['📚 Skipped 2 audiobook tracks in this smart playlist.'], how);
	}
});

test('a hand-made playlist keeps its book tracks', async () => {
	seed();
	const bot = makeBot(() => ({ smart: false, Metadata: [track('20027'), track('20150')] }));
	const { message, sent } = replies();
	await bot.loadPlaylist('/playlists/78/items', message, false, false);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20027'), partKey('20150')]);
	assert.deepStrictEqual(sent, []);
});

test('findPlaylist passes the listing\'s smart flag through', async () => {
	seed();
	const bot = makeBot((url) => (url.startsWith('/playlists?')
		? { Metadata: [{ title: 'All Music', key: '/playlists/77/items', smart: true }] }
		: { Metadata: [track('20027'), track('20150')] }));
	const { message } = replies();
	await bot.findPlaylist('all music', message, false);
	await settle();
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20150')]);
});

// Hitster ---------------------------------------------------------------------------------------

test('hitster deals and plays only dated music', async () => {
	seed();
	const pool = [...books(), ...songs()].map((t) => Object.assign(t, { year: 2001 }));
	pool.push(track('20153'));
	sharedPlex.query = async (url) => {
		if (url === '/library/sections') return { MediaContainer: { Directory: [{ type: 'artist', key: '1' }] } };
		if (url === '/library/sections/1/all?type=10') return { MediaContainer: { Metadata: pool } };
		throw new Error('unexpected Plex query ' + url);
	};

	const sent = [];
	const guild = { id: 'g-picker' };
	const voiceChannel = { id: 'vc-picker', name: 'Lounge', guild, members: new Map([['host-p', {}]]) };
	const message = {
		author: { id: 'host-p' },
		guild,
		member: { voice: { channel: voiceChannel }, permissions: { has: () => false } },
		channel: { id: 'tc-picker', async send(x) { sent.push(x); return { edit: async () => {} }; } },
		async reply(x) { sent.push(x); return {}; }
	};
	const bot = { songQueue: [], isPlaying: false, playSong: () => new Promise(() => {}) };

	await hitster.command.process(bot, null, message, 'create');
	Math.random = () => 0;
	await hitster.command.process(bot, null, message, 'start');
	await settle();

	const text = sent.filter((x) => typeof x === 'string').join('\n');
	assert.match(text, /\*Song 1\* by Theo Bramble/, 'the dealt card is the first dated song');
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey('20151')], 'the first clip is the next dated song');
	for (const t of books()) assert.ok(!text.includes(`*${t.title}*`), `${t.title} was dealt`);
});

// helpers/plexTags.js ---------------------------------------------------------------------------

test('the track count and every sample window carry the same exclusion', async () => {
	seed();
	const fragment = longForm.plexExclusion();
	const urls = [];
	sharedPlex.query = async (url) => {
		urls.push(url);
		if (url.includes('X-Plex-Container-Size=0')) return { MediaContainer: { totalSize: 40, size: 0 } };
		const start = Number(/Container-Start=(\d+)/.exec(url)[1]);
		return { MediaContainer: { Metadata: [{ ratingKey: String(30000 + start) }] } };
	};

	assert.strictEqual(await plexTags.countTracks('1'), 40);
	const sample = await plexTags.sampleRandomTracks('1', 5);
	assert.ok(sample.length > 0);
	assert.ok(urls.length >= 3, 'a count and at least one window for each call');
	for (const url of urls) {
		assert.ok(url.startsWith('/library/sections/1/all?type=10&X-Plex-Container-Start='), url);
		assert.ok(url.endsWith('&' + fragment), `${url} carries the fragment`);
		assert.ok(Number(/Container-Start=(\d+)/.exec(url)[1]) < 40, 'offsets stay inside the filtered count');
	}
});

test('with the exclusion off the count URL is unchanged', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	const urls = [];
	sharedPlex.query = async (url) => { urls.push(url); return { MediaContainer: { totalSize: 3 } }; };
	await plexTags.countTracks('1');
	assert.deepStrictEqual(urls, ['/library/sections/1/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=0']);
});

// The bug: a tag listing is capped at 400 rows by Plex and dropped chapters only afterwards, so
// a genre that chapters share could fill the cap and leave vibe with no music for it.
test('a tag listing asks Plex to leave the books out before its cap', async () => {
	seed();
	const urls = [];
	sharedPlex.query = async (url) => { urls.push(url); return { MediaContainer: { Metadata: [] } }; };
	await plexTags.fetchTracksByTag('1', 'genre', '7');
	assert.deepStrictEqual(urls, ['/library/sections/1/all?type=10&genre=7&X-Plex-Container-Start=0&X-Plex-Container-Size=400&' + longForm.plexExclusion()]);
});

test('with the exclusion off the tag listing URL is unchanged', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	const urls = [];
	sharedPlex.query = async (url) => { urls.push(url); return { MediaContainer: { Metadata: [] } }; };
	await plexTags.fetchTracksByTag('1', 'mood', '7');
	assert.deepStrictEqual(urls, ['/library/sections/1/all?type=10&mood=7&X-Plex-Container-Start=0&X-Plex-Container-Size=400']);
});

// commands/list.js ------------------------------------------------------------------------------

function listBot(route) {
	const urls = [];
	const bot = {
		cache_library: { 1: { name: 'Music', key: '1' } },
		language,
		plex: { query: async (url) => { urls.push(url); return { MediaContainer: route(url) }; } },
		trackToMusic: Bot.prototype.trackToMusic,
		urls,
	};
	bot.findTracksOnPlex = Bot.prototype.findTracksOnPlex.bind(bot);
	return bot;
}

test('!list browse asks Plex to leave the books out', async () => {
	seed();
	const bot = listBot(() => ({ Metadata: songs() }));
	const { message, sent } = replies();
	await list.command.process(bot, null, message, 'reset');
	assert.strictEqual(bot.urls.length, 1);
	assert.ok(bot.urls[0].endsWith('&' + longForm.plexExclusion()), bot.urls[0]);
	assert.match(sent[0].embeds[0].fields[0].value, /Song 1/);
});

test('!list search shows only music and points at the books', async () => {
	seed();
	const bot = listBot(() => ({ Metadata: [track('20027'), track('20150')] }));
	const { message, sent } = replies();
	await list.command.process(bot, null, message, 'search glass');
	const embed = sent[0].embeds[0];
	assert.strictEqual(embed.fields[0].value, 'Song 1\n\n');
	assert.ok(embed.description.includes(GLASS_ROAD), embed.description);
});

// commands/playlist.js/add.js -------------------------------------------------------------------

function addBot(metadata) {
	fs.mkdirSync(PLAYLIST_DIR, { recursive: true });
	fs.writeFileSync(PLAYLIST_DIR + 'mix.playlist', JSON.stringify({ musiques: [] }));
	const added = [];
	return {
		added,
		language,
		config: { playlistsDir: PLAYLIST_DIR, commandPrefix: '!' },
		findTracksOnPlex: async () => ({ MediaContainer: { size: metadata.length, Metadata: metadata } }),
		addToPlaylist: (name, t) => { added.push({ name, t }); },
	};
}

test('playlist add lists only music for choice and points at the books', async () => {
	seed();
	const bot = addBot([track('20027'), track('20150'), track('20151')]);
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'song']);
	await settle();
	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), ['20150', '20151'], 'choice 1 and 2 index the music hits');
	assert.strictEqual(bot.plexOffset, 3);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n1 - Theo Bramble - Song 1\n2 - Theo Bramble - Song 2\n/);
	assert.ok(sent[0].includes(GLASS_ROAD), sent[0]);
	assert.deepStrictEqual(bot.added, []);
});

test('playlist add refuses a book track with the redirect', async () => {
	seed();
	const bot = addBot([track('20027')]);
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'glass', 'road']);
	await settle();
	assert.deepStrictEqual(bot.added, []);
	assert.deepStrictEqual(sent, ['Those are audiobook chapters, not songs. 📚 The Glass Road (Avery Quill), `/book play the glass road`']);
});

test('playlist add takes the one song among books', async () => {
	seed();
	const bot = addBot([track('20027'), track('20150')]);
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'song']);
	await settle();
	assert.strictEqual(bot.added.length, 1);
	assert.strictEqual(bot.added[0].t.cle, partKey('20150'));
	assert.deepStrictEqual(sent, [GLASS_ROAD]);
});

// The bug: playlist add wrote the one song left on a full page of chapters straight into the
// playlist file, and a full page of chapters set no paging state, while the wanted song could be
// on page 2.
test('playlist add offers the lone song on a full page for choice instead of writing it', async () => {
	seed();
	const bot = addBot([...bookHits(9), track('20150')]);
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'prologue']);
	await settle();
	assert.deepStrictEqual(bot.added, []);
	assert.deepStrictEqual(bot.tracks.map((t) => t.ratingKey), ['20150']);
	assert.strictEqual(bot.botPlaylist, 'mix');
	assert.strictEqual(bot.plexQuery, 'prologue');
	assert.strictEqual(bot.plexOffset, 10);
	assert.strictEqual(sent.length, 1);
	assert.match(sent[0], /\n1 - Theo Bramble - Song 1\n/);
	assert.ok(sent[0].endsWith(language.PLAYLIST_ADD_INFO.format({ commandPrefix: '!' })), sent[0]);
});

test('playlist add on a full page of chapters keeps the paging state and offers the next page', async () => {
	seed();
	const bot = addBot(bookHits(10));
	bot.tracks = [track('20151')];
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'prologue']);
	await settle();
	assert.deepStrictEqual(bot.added, []);
	assert.deepStrictEqual(bot.tracks, [], 'a choice cannot pick a stale hit from an earlier search');
	assert.strictEqual(bot.botPlaylist, 'mix');
	assert.strictEqual(bot.plexQuery, 'prologue');
	assert.strictEqual(bot.plexOffset, 10);
	assert.strictEqual(sent.length, 1);
	assert.ok(sent[0].startsWith(longForm.ONLY_PREFIX), sent[0]);
	assert.ok(sent[0].endsWith('\n**!playlist page** if the music you want is not in this page.'), sent[0]);
});

test('with the exclusion off playlist add writes a lone hit as before', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	const bot = addBot([track('20027')]);
	const { message, sent } = replies();
	await playlistAdd.command.process(bot, null, message, ['mix', 'intro']);
	await settle();
	assert.strictEqual(bot.added.length, 1);
	assert.strictEqual(bot.added[0].t.cle, partKey('20027'));
	assert.deepStrictEqual(sent, []);
});
