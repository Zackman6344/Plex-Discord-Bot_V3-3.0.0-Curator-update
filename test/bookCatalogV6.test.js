// helpers/bookCatalog.js, rules version 6: Plex's "[Unknown Album]" and book folders named
// "Author (Year) Title (Readers)".
//
// The bug: untagged chapter files in a folder straight under the music root, named like "Ida Marsh
// (1998) The Tin Crown (Various Artists)", that Plex could not match online. Plex filed each as
// "[Unknown Album]" by "Various Artists". The catalog took the placeholder for the title and, with
// "Various Artists" never an author, took the folder under the root, the whole book folder name,
// for the author: id "ida-marsh-1998-the-tin-crown-various-artists/unknown-album".
//
// Harness: invented libraries under N:/Media/Music built inline, as in test/bookCatalogV5.test.js.

const test = require('node:test');
const assert = require('node:assert');

const bookCatalog = require('../helpers/bookCatalog.js');
const { buildCatalog, matchAliases, authorYearTitle, isPlaceholderAlbum } = bookCatalog;

const MIN = 60 * 1000;
const ROOTS = ['N:\\Media\\Music'];
const CHAPTERS = ['01 - The Long Winter', '02 - Salt Roads', '03 - The Quiet Harbour', '04 - Homecoming'];

function album(rk, title, artist) {
	return { ratingKey: String(rk), key: `/library/metadata/${rk}/children`, parentRatingKey: `9${rk}`, type: 'album', title, parentTitle: artist, Genre: [] };
}

function track(rk, alb, file, min, extra = {}) {
	const ms = Math.round(min * MIN);
	const name = file.split('/').pop();
	const container = (name.match(/\.([^.]+)$/) || [])[1] || 'mp3';
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, parentRatingKey: String(alb.ratingKey), grandparentRatingKey: alb.parentRatingKey,
		type: 'track', title: name.replace(/\.[^.]+$/, ''), grandparentTitle: alb.parentTitle, parentTitle: alb.title,
		parentIndex: 1, index: 1, duration: ms, addedAt: 1700000000 + Number(rk),
		Media: [{ id: Number(rk), duration: ms, bitrate: 96, audioChannels: 2, container, Part: [{ id: Number(rk), key: `/library/parts/${rk}/1700000000/${name}`, duration: ms, file, size: 1000000 + Number(rk), container }] }],
		...extra,
	};
}

// Chapter files with no tags, so Plex gives them no track index and, unmatched, its placeholders.
function untagged(rk, folder, { title = '[Unknown Album]', artist = 'Various Artists' } = {}) {
	const a = album(rk, title, artist);
	const tracks = CHAPTERS.map((name, i) => track(rk * 10 + i, a, `N:/Media/Music/${folder}/${name}.opus`, 40, { index: undefined }));
	return { albums: [a], tracks };
}

function build(...libs) {
	return buildCatalog({ roots: ROOTS, albums: libs.flatMap((l) => l.albums), tracks: libs.flatMap((l) => l.tracks) });
}

function shown(w) {
	return { title: w.title, author: w.author, narrator: w.narrator, edition: w.edition, titleFrom: w.detected.sources.title, authorFrom: w.detected.sources.author, doubts: w.doubts };
}

test('a folder named "Author (Year) Title (Readers)" names the book Plex left as "[Unknown Album]"', () => {
	const { works } = build(
		untagged(601, 'Ida Marsh (1998) The Tin Crown (Various Artists)'),
		untagged(602, 'Ida Marsh (1999) The Glass Road (Various Artists)'),
		untagged(603, 'Ida Marsh (2005) The Half-Drowned King (Various Artists)'),
	);
	assert.deepStrictEqual(Object.keys(works).sort(), ['ida-marsh/the-glass-road', 'ida-marsh/the-half-drowned-king', 'ida-marsh/the-tin-crown']);
	assert.deepStrictEqual(shown(works['ida-marsh/the-tin-crown']), {
		title: 'The Tin Crown', author: 'Ida Marsh', narrator: null, edition: null, titleFrom: 'folder', authorFrom: 'folder', doubts: [],
	}, 'a year is no reader and a cast names none');
	assert.strictEqual(works['ida-marsh/the-half-drowned-king'].title, 'The Half-Drowned King');
	assert.deepStrictEqual(works['ida-marsh/the-tin-crown'].parts.map((p) => p.file), CHAPTERS.map((c) => `${c}.opus`));
});

test('an album Plex did match keeps its own title beside its unmatched siblings', () => {
	const { works } = build(
		untagged(611, 'Ida Marsh (1997) The Salt Ocean (Various Artists)', { title: 'The Salt Sea', artist: 'Ida Marsh' }),
		untagged(612, 'Ida Marsh (1998) The Tin Crown (Various Artists)'),
	);
	assert.deepStrictEqual(Object.keys(works).sort(), ['ida-marsh/the-salt-sea', 'ida-marsh/the-tin-crown'], 'the folder never overrides a real album title');
	assert.deepStrictEqual([works['ida-marsh/the-salt-sea'].detected.sources.title, works['ida-marsh/the-salt-sea'].detected.sources.author], ['album', 'plex-artist']);
});

test('a placeholder album in a plain book folder takes the folder name, and the author folder stays the author', () => {
	const { works } = build(untagged(621, 'Ida Marsh/The Tin Crown'));
	assert.deepStrictEqual(Object.keys(works), ['ida-marsh/the-tin-crown']);
	assert.deepStrictEqual([works['ida-marsh/the-tin-crown'].detected.sources.title, works['ida-marsh/the-tin-crown'].detected.sources.author], ['folder', 'folder']);
	const nested = build(untagged(622, 'Ida Marsh/Ida Marsh (2001) The Tin Crown (Jo Vale)')).works;
	assert.deepStrictEqual(Object.keys(nested), ['ida-marsh/the-tin-crown']);
	const sorted = build(untagged(623, 'Marsh, Ida (2001) The Tin Crown (Jo Vale)')).works;
	assert.deepStrictEqual(Object.keys(sorted), ['ida-marsh/the-tin-crown'], 'an author written surname first');
});

test('the id a work had under rules version 5 is carried as an alias', () => {
	const now = build(untagged(631, 'Ida Marsh (1998) The Tin Crown (Various Artists)')).works;
	const v5 = 'ida-marsh-1998-the-tin-crown-various-artists/unknown-album';
	const old = { [v5]: { ...now['ida-marsh/the-tin-crown'], id: v5, title: '[Unknown Album]', author: 'Ida Marsh (1998) The Tin Crown (Various Artists)' } };
	const { works, moved } = matchAliases(old, now);
	assert.deepStrictEqual(moved, { [v5]: 'ida-marsh/the-tin-crown' });
	assert.deepStrictEqual(works['ida-marsh/the-tin-crown'].aliases, [v5], 'a bookmark saved under the old id still opens');
});

test('authorYearTitle reads a person before the year and drops the readers', () => {
	assert.deepStrictEqual(authorYearTitle('J.K. Rowling (1998) Harry Potter and the Chamber of Secrets (Various Artists)'), { author: 'J.K. Rowling', title: 'Harry Potter and the Chamber of Secrets' });
	assert.deepStrictEqual(authorYearTitle('Ida Marsh (2019) Tin Crown'), { author: 'Ida Marsh', title: 'Tin Crown' });
	assert.deepStrictEqual(authorYearTitle('Le Guin, Ursula K. (1968) A Wizard of Earthsea (Jo Vale)'), { author: 'Ursula K. Le Guin', title: 'A Wizard of Earthsea' });
	for (const name of [
		'Tin Crown by Ida Marsh (2019) read by Jo Vale',
		'The Age of Fable Vol 1 by Thomas Bulfinch (1855) read by George Guidall',
		'Mythology (2019) Heroes',
		'Ida Marsh (Various Artists) Tin Crown',
		'Ida Marsh (1998) (Various Artists)',
		'Ida Marsh (2019) read by Jo Vale',
		'Ida Marsh - Tin Crown (2019)',
	]) assert.strictEqual(authorYearTitle(name), null, name);
});

test('only Plex\'s unknown-album placeholder counts as no title', () => {
	for (const t of ['[Unknown Album]', 'Unknown Album', ' [unknown album] ']) assert.strictEqual(isPlaceholderAlbum(t), true, t);
	for (const t of ['Unknown Pleasures', 'The Unknown Album Club', '[Unknown Artist]', '', null]) assert.strictEqual(isPlaceholderAlbum(t), false, String(t));
});
