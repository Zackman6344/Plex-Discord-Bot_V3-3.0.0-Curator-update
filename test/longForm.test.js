// helpers/longForm.js: whether a Plex track, album, artist or queue entry belongs to the book
// catalog, the Plex-side exclusion fragment, partition, and the /book redirect line.
//
// The bug: with no answer to "is this a book", every music picker treated 900-odd audiobook
// chapters as songs: !random, Hitster and smart playlists dealt chapters, and a search for an
// author listed chapter files as hits. A duration rule instead would drop hour-long music mixes
// and still keep 6-minute chapters. An exclusion that stayed on after audiobooksExcludeFromMusic
// was turned off, or that built a fragment from an empty catalog, would hide music or send Plex
// a malformed filter.
//
// Harness: the store pattern of test/bookCatalogStore.test.js (pid-suffixed
// PLEXBOT_BOOK_CATALOG_FILE set before the first require, afterEach unlink and reset), seeded with
// a deep clone of the synthetic test/fixtures/books/catalog.json. Every seeded test asserts the
// exclusion is enabled first, so a missing seed fails instead of comparing '' with ''.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-longform-catalog-${process.pid}.json`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
const LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-longform-' + process.pid);
process.env.PLEXBOT_LOG_DIR = LOG_DIR;

const config = require('../config/config');
const store = require('../helpers/bookCatalogStore.js');
const longForm = require('../helpers/longForm.js');
const CATALOG = require('./fixtures/books/catalog.json');
const LIBRARY = require('./fixtures/books/library.json');

const originalSetting = config.audiobooksExcludeFromMusic;
config.audiobooksExcludeFromMusic = true;

const ALBUMS = '1001,1002,1003,1004,1005,1006,1007,1010,1020,1021,1022,1030,1031,1032,1033,1034,1040';
const ARTISTS = '9001,9002,9003,9004,9005,9006';
const FRAGMENT = `album.id!=${ALBUMS}&artist.id!=${ARTISTS}`;

function clone(x) {
	return JSON.parse(JSON.stringify(x));
}

function seed(catalog = CATALOG) {
	store.replace(clone(catalog));
	assert.strictEqual(longForm.enabled(), true, 'the seeded catalog turns the exclusion on');
	assert.notStrictEqual(longForm.plexExclusion(), '', 'the seeded catalog gives a fragment');
}

function track(ratingKey) {
	const t = LIBRARY.tracks.find((x) => x.ratingKey === ratingKey);
	assert.ok(t, `fixture track ${ratingKey}`);
	return clone(t);
}

function album(ratingKey) {
	const a = LIBRARY.albums.find((x) => x.ratingKey === ratingKey);
	assert.ok(a, `fixture album ${ratingKey}`);
	return clone(a);
}

const artist = (ratingKey, title) => ({ type: 'artist', ratingKey, title, key: `/library/metadata/${ratingKey}/children` });

test.afterEach(() => {
	try { fs.unlinkSync(FILE); } catch (_) {}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	store.reset();
	config.audiobooksExcludeFromMusic = true;
});

test.after(() => {
	config.audiobooksExcludeFromMusic = originalSetting;
	try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

test('with no catalog nothing is excluded and the fragment is empty', () => {
	store.reset();
	assert.strictEqual(longForm.enabled(), false);
	assert.strictEqual(longForm.plexExclusion(), '');
	assert.strictEqual(longForm.withExclusion('/library/sections/1/all?type=10'), '/library/sections/1/all?type=10');
	assert.strictEqual(longForm.isLongFormTrack(track('20027')), false);
	assert.strictEqual(longForm.isLongFormAlbum(album('1010')), false);
	const all = [track('20027'), track('20150')];
	assert.deepStrictEqual(longForm.partition(all), { music: all, books: [] });
	assert.deepStrictEqual(longForm.worksFor(all), []);
});

test('the fragment excludes catalogued albums and artists', () => {
	seed();
	assert.strictEqual(longForm.plexExclusion(), FRAGMENT);
	assert.strictEqual(longForm.withExclusion('/library/sections/1/all?type=10'), `/library/sections/1/all?type=10&${FRAGMENT}`);
	assert.strictEqual(longForm.withExclusion('/library/sections/1/all'), `/library/sections/1/all?${FRAGMENT}`);
});

test('the fragment builder keeps only numeric keys', () => {
	const ix = { albumKeys: new Set(['1001', '10&x=1']), artistKeys: new Set(['9001', '', 'abc']), trackKeys: new Set(), partIds: new Set() };
	assert.strictEqual(longForm.exclusionFragment(ix), 'album.id!=1001&artist.id!=9001');
	assert.strictEqual(longForm.exclusionFragment({ albumKeys: new Set(), artistKeys: new Set() }), '');
	assert.strictEqual(longForm.exclusionFragment(null), '');
});

test('a catalogued track is long-form however short, and an hour-long mix is music', () => {
	seed();
	assert.strictEqual(longForm.isLongFormTrack(track('20027')), true, 'a book part');
	const chapter = track('20087');
	assert.ok(chapter.duration < 7 * 60 * 1000, 'the fixture chapter is short');
	assert.strictEqual(longForm.isLongFormTrack(chapter), true, 'a 6-minute chapter');
	const mix = track('20149');
	assert.ok(mix.duration > 60 * 60 * 1000, 'the fixture mix is over an hour');
	assert.strictEqual(longForm.isLongFormTrack(mix), false, 'the 61-minute mix');
	assert.strictEqual(longForm.isLongFormTrack(track('20150')), false, 'a song');
});

test('a podcast artist is excluded at artist level, as the Plex fragment does', () => {
	seed();
	const theme = track('20115');
	assert.ok(!store.index().trackKeys.has('20115'), 'the extras track is not itself catalogued');
	assert.strictEqual(longForm.isLongFormTrack(theme), true);
	assert.strictEqual(longForm.isLongFormTrack(track('20116')), true, 'every album by the artist');
	assert.strictEqual(longForm.isLongFormAlbum(album('1050')), true, 'an album that is not fully catalogued');
	assert.strictEqual(longForm.isLongFormArtist(artist('9006', 'Lantern Hollow')), true);
});

test('albums and artists outside the catalog are music', () => {
	seed();
	assert.strictEqual(longForm.isLongFormAlbum(album('1010')), true);
	assert.strictEqual(longForm.isLongFormAlbum(album('1060')), false);
	assert.strictEqual(longForm.isLongFormAlbum(album('1070')), false);
	assert.strictEqual(longForm.isLongFormArtist(artist('9001', 'Avery Quill')), true);
	assert.strictEqual(longForm.isLongFormArtist(artist('9007', 'Sam Drift')), false);
});

test('a track known only by its part key is still caught', () => {
	seed();
	const t = track('20027');
	delete t.ratingKey;
	delete t.parentRatingKey;
	delete t.grandparentRatingKey;
	assert.strictEqual(longForm.isLongFormTrack(t), true);
});

test('queue entries are matched by the part id in their key', () => {
	seed();
	assert.strictEqual(longForm.isLongFormEntry({ key: '/library/parts/50027/1700000000/file.mp3', title: 'x' }), true);
	assert.strictEqual(longForm.isLongFormEntry({ key: '/library/parts/50149/1700000000/Night Drive Mix.mp3' }), false);
	assert.strictEqual(longForm.isLongFormEntry({ key: 'https://www.youtube.com/watch?v=abc' }), false);
	assert.strictEqual(longForm.isLongFormEntry(null), false);
});

test('isLongForm tells the shapes apart', () => {
	seed();
	assert.strictEqual(longForm.isLongForm(track('20027')), true);
	assert.strictEqual(longForm.isLongForm(album('1010')), true);
	assert.strictEqual(longForm.isLongForm(artist('9004', 'Ilse Moreau')), true);
	assert.strictEqual(longForm.isLongForm({ key: '/library/parts/50027/1/a.mp3' }), true);
	assert.strictEqual(longForm.isLongForm({ ...track('20027'), type: undefined }), true, 'a track without a type, by its Media');
	assert.strictEqual(longForm.isLongForm(track('20150')), false);
	assert.strictEqual(longForm.isLongForm({ type: 'playlist', ratingKey: '1010' }), false);
	assert.strictEqual(longForm.isLongForm(undefined), false);
});

test('turning the setting off lets everything back into music', () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	assert.strictEqual(longForm.enabled(), false);
	assert.strictEqual(longForm.plexExclusion(), '');
	assert.strictEqual(longForm.isLongFormTrack(track('20027')), false);
	assert.strictEqual(longForm.isLongFormEntry({ key: '/library/parts/50027/1/a.mp3' }), false);
	const all = [track('20027'), track('20150')];
	assert.deepStrictEqual(longForm.partition(all).books, []);

	config.audiobooksExcludeFromMusic = true;
	assert.strictEqual(longForm.isLongFormTrack(track('20027')), true, 'read live, so turning it back on works at once');
});

test('partition keeps each side in the order given', () => {
	seed();
	const page = ['20150', '20027', '20149', '20087', '20151'].map(track);
	const { music, books } = longForm.partition(page);
	assert.deepStrictEqual(music.map((t) => t.ratingKey), ['20150', '20149', '20151']);
	assert.deepStrictEqual(books.map((t) => t.ratingKey), ['20027', '20087']);
	assert.deepStrictEqual(longForm.partition(undefined), { music: [], books: [] });
});

test('worksFor names each work once, first seen first', () => {
	seed();
	const works = longForm.worksFor(['20087', '20027', '20028', '20150', '20108'].map(track));
	assert.deepStrictEqual(works.map((w) => w.id), ['r-j-ashdown/the-hollow-king', 'avery-quill/the-glass-road', 'lantern-hollow/the-tin-valley']);
	assert.deepStrictEqual(longForm.worksFor([album('1031')]).map((w) => w.id), ['ilse-moreau/the-far-shore~penrose']);
	assert.deepStrictEqual(longForm.worksFor([artist('9005', 'R.J. Ashdown')]).map((w) => w.id), ['r-j-ashdown/the-hollow-king']);
	assert.deepStrictEqual(longForm.worksFor([{ key: '/library/parts/50042/1/x.mp3' }]).map((w) => w.id), ['corin-vale/the-long-tide']);
});

test('the redirect line names the work and the command to play it', () => {
	seed();
	const line = longForm.redirectLine(longForm.worksFor([track('20027')]));
	assert.strictEqual(line, '📚 Also in your books: The Glass Road (Avery Quill), `/book play the glass road`');
	assert.strictEqual(longForm.redirectLine([]), '');
	assert.strictEqual(longForm.redirectLine(undefined), '');
});

test('two editions of one title give one redirect entry', () => {
	seed();
	const works = longForm.worksFor([album('1031'), album('1032')]);
	assert.strictEqual(works.length, 2, 'two editions');
	const line = longForm.redirectLine(works, longForm.ONLY_PREFIX);
	assert.strictEqual(line, 'Those are audiobook chapters, not songs. 📚 The Far Shore (Ilse Moreau), `/book play the far shore`');
});

test('a long redirect shows three works and counts the rest', () => {
	seed();
	const works = longForm.worksFor([artist('9001', 'Avery Quill')]);
	assert.ok(works.length > 3);
	const line = longForm.redirectLine(works);
	assert.strictEqual((line.match(/`\/book play /g) || []).length, 3);
	assert.match(line, new RegExp(`; and ${works.length - 3} more$`));
});

test('markdown in a title cannot break the line', () => {
	const line = longForm.redirectLine([{ id: 'a/b', title: 'Star*s `x`', author: 'A_B' }]);
	assert.strictEqual(line, '📚 Also in your books: Star\\*s \\`x\\` (A\\_B), `/book play star*s x`');
});

test('onlyBooksLine falls back to a pointer when no work is known', () => {
	seed();
	assert.match(longForm.onlyBooksLine([track('20027')]), /^Those are audiobook chapters, not songs\. 📚 The Glass Road/);
	assert.strictEqual(longForm.onlyBooksLine([artist('9999', 'Nobody Known')]), longForm.ONLY_FALLBACK);
});

// The bug: a podcast artist's soundtrack album is kept out by the artist key alone and belongs to
// no work, yet the fallback sent the user to /book library, which does not list it.
test('onlyBooksLine explains an album or track kept out only by its podcast artist', () => {
	seed();
	const line = longForm.onlyBooksLine([album('1051')]);
	assert.strictEqual(line, longForm.PODCAST_ARTIST_FALLBACK);
	assert.doesNotMatch(line, /book library/);
	assert.match(line, /`audiobooksExcludeFromMusic` off/);
	assert.match(line, /book_overrides\.json/);
	assert.strictEqual(longForm.onlyBooksLine([track('20116')]), longForm.PODCAST_ARTIST_FALLBACK);
	assert.strictEqual(longForm.fallbackLine([track('20116')]), longForm.PODCAST_ARTIST_FALLBACK);
	assert.strictEqual(longForm.fallbackLine([album('1051'), artist('9999', 'Nobody Known')]), longForm.ONLY_FALLBACK, 'only when every item is artist-only');

	config.audiobooksExcludeFromMusic = false;
	assert.strictEqual(longForm.onlyBooksLine([album('1051')]), longForm.ONLY_FALLBACK, 'unchanged with the exclusion off');
	try { fs.unlinkSync(FILE); } catch (_) {}
	store.reset();
	config.audiobooksExcludeFromMusic = true;
	assert.strictEqual(longForm.enabled(), false, 'no catalog');
	assert.strictEqual(longForm.onlyBooksLine([album('1051')]), longForm.ONLY_FALLBACK, 'unchanged with no catalog');
});

test('a rebuild swaps the index and the work lookups together', () => {
	seed();
	assert.strictEqual(longForm.isLongFormAlbum(album('1010')), true);
	assert.strictEqual(longForm.worksFor([track('20027')]).length, 1);

	const smaller = clone(CATALOG);
	delete smaller.works['avery-quill/the-glass-road'];
	smaller.index.albumKeys = smaller.index.albumKeys.filter((k) => k !== '1010');
	smaller.index.trackKeys = smaller.index.trackKeys.filter((k) => Number(k) < 20027 || Number(k) > 20041);
	smaller.index.partIds = smaller.index.partIds.filter((k) => Number(k) < 50027 || Number(k) > 50041);
	smaller.index.artistKeys = smaller.index.artistKeys.filter((k) => k !== '9002');
	seed(smaller);

	assert.strictEqual(longForm.isLongFormAlbum(album('1010')), false);
	assert.strictEqual(longForm.isLongFormTrack(track('20027')), false);
	assert.deepStrictEqual(longForm.worksFor([track('20027')]), []);
	assert.doesNotMatch(longForm.plexExclusion(), /\b1010\b/);
});

test('an unreadable catalog reads as no catalog instead of breaking music', () => {
	seed();
	const realIndex = store.index;
	store.index = () => { throw new Error('boom'); };
	try {
		assert.strictEqual(longForm.enabled(), false);
		assert.strictEqual(longForm.isLongFormTrack(track('20027')), false);
		assert.strictEqual(longForm.plexExclusion(), '');
	} finally {
		store.index = realIndex;
	}
});
