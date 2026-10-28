// helpers/bookCatalog.js, rules version 5: what parenthesis text, artist fields, folder names and
// per-file tags may say about a work, and which short or shared folders are works.
//
// The bug: parenthesis text became the narrator and the edition whatever it said, so a year
// ("(1942)"), a cast ("(Various)"), a translator ("(Jo Vale transl.)") and a word of the title
// showed as the reader on every card, and the reader the tags named was never looked at. Authors
// came out as credit lists ("Ida Marsh/Jo Vale/©2019 by ..."), as the shelf folder holding forty
// authors' books, or as an album artist Plex made up; titles kept store tails ("- A Novel",
// ", Book 1") and credits; a series spelled "Author - Series" on one book split the series and
// wiped its siblings' numbers. A 70-minute play on four long scenes was dropped as "under 2 h", and
// an LP of eight 10-minute scenes was dropped without even being listed. Three plays in one mp3
// folder were one work, interleaved volumes put two intros in the wrong volume, and a rule change
// that gave two works one id dropped one of them.
//
// Harness: invented libraries under N:/Media/Music built inline, in the style of the version 3 and
// 4 cases in test/bookCatalog.test.js; the shared fixture is left to that file.

const test = require('node:test');
const assert = require('node:assert');

const bookCatalog = require('../helpers/bookCatalog.js');
const { buildCatalog, matchAliases, cleanAuthor, cleanTitle } = bookCatalog;

const MIN = 60 * 1000;
const ROOTS = ['N:\\Media\\Music'];

function album(rk, title, artist, genres = []) {
	return { ratingKey: String(rk), key: `/library/metadata/${rk}/children`, parentRatingKey: `9${rk}`, type: 'album', title, parentTitle: artist, Genre: genres.map((tag) => ({ tag })) };
}

function track(rk, alb, file, min, extra = {}) {
	const ms = Math.round(min * MIN);
	const name = file.split('/').pop();
	const container = (name.match(/\.([^.]+)$/) || [])[1] || 'mp3';
	return {
		ratingKey: String(rk), key: `/library/metadata/${rk}`, parentRatingKey: String(alb.ratingKey), grandparentRatingKey: alb.parentRatingKey,
		type: 'track', title: name.replace(/\.[^.]+$/, ''), grandparentTitle: alb.parentTitle, parentTitle: alb.title,
		parentIndex: 1, index: 1, duration: ms, addedAt: 1700000000 + Number(rk),
		Media: [{ id: Number(rk), duration: ms, bitrate: 128, audioChannels: 2, container: container === 'm4b' ? 'mp4' : container, Part: [{ id: Number(rk), key: `/library/parts/${rk}/1700000000/${name}`, duration: ms, file, size: 1000000 + Number(rk), container }] }],
		...extra,
	};
}

// One album of three 40-minute files in its own folder.
function folderBook(rk, albumTitle, folder, { artist = 'Ida Marsh', genres = ['Audiobook'], tags = null, n = 3, min = 40, extra = {} } = {}) {
	const a = album(rk, albumTitle, artist, genres);
	const tracks = Array.from({ length: n }, (_, i) => track(rk * 10 + i, a, `N:/Media/Music/${folder}/0${i + 1}.mp3`, min, { index: i + 1, ...extra }));
	return { albums: [a], tracks, tags: tags ? { [rk]: { tags } } : {} };
}

function merge(...libs) {
	return {
		roots: ROOTS,
		albums: libs.flatMap((l) => l.albums),
		tracks: libs.flatMap((l) => l.tracks),
		tags: Object.assign({}, ...libs.map((l) => l.tags || {})),
		trackTags: Object.assign({}, ...libs.map((l) => l.trackTags || {})),
	};
}

function only(lib) {
	const works = Object.values(buildCatalog(merge(lib)).works);
	assert.strictEqual(works.length, 1);
	return works[0];
}

test('parenthesis text is a narrator only when it names a person', () => {
	const year = only(folderBook(501, 'Tin Crown', 'Ida Marsh/Tin Crown (1942)', { tags: { composer: 'Jo Vale' } }));
	assert.deepStrictEqual([year.narrator, year.edition, year.detected.sources.narrator], ['Jo Vale', null, 'tag'], 'a year is no narrator and no edition; the composer reads it');
	const cast = only(folderBook(502, 'Tin Crown', 'Ida Marsh/Tin Crown (Various)'));
	assert.deepStrictEqual([cast.narrator, cast.edition], [null, 'Various'], 'a cast tells the edition apart and names no reader');
	const transl = only(folderBook(503, 'Tin Crown', 'Ida Marsh/Tin Crown (Rhea Stone transl.)', { tags: { artist: 'Ida Marsh/Jo Vale/©2019 by Harbour Books' } }));
	assert.deepStrictEqual([transl.narrator, transl.edition], ['Jo Vale', 'Rhea Stone transl.'], 'the translator is the edition; the second name beside the author reads it');
	const word = only(folderBook(504, 'The Saga: Tin Crown', 'Ida Marsh/Tin Crown (Saga)'));
	assert.deepStrictEqual([word.narrator, word.edition], [null, null], 'a word of the title is neither');
	const abr = only(folderBook(505, 'Tin Crown', 'Ida Marsh/Tin Crown (Abr Jo Vale) Vinyl LP'));
	assert.deepStrictEqual([abr.narrator, abr.edition], ['Jo Vale', 'Jo Vale']);
	const lp = only(folderBook(506, 'Tin Crown', 'Ida Marsh/Tin Crown (1976 LP)'));
	assert.strictEqual(lp.edition, null, 'a year and a format leave no edition');
	const readBy = only(folderBook(507, 'Tin Crown', 'Ida Marsh/Tin Crown (1855) read by Jo Vale'));
	assert.deepStrictEqual([readBy.narrator, readBy.detected.sources.narrator], ['Jo Vale', 'folder']);
	const surname = only(folderBook(508, 'Tin Crown', 'Ida Marsh/Tin Crown (Penrose)'));
	assert.strictEqual(surname.narrator, 'Penrose', 'a lone surname still tells one narration from another');
	const comma = only(folderBook(509, 'Tin Crown', 'Ida Marsh/Tin Crown', { tags: { artist: 'Ida Marsh, Jo Vale', album_artist: 'Ida Marsh' } }));
	assert.strictEqual(comma.narrator, 'Jo Vale');
	const notAuthor = only(folderBook(510, 'Tin Crown', 'Ida Marsh/Tin Crown', { tags: { composer: 'Graphic Audio LLC.' } }));
	assert.strictEqual(notAuthor.narrator, null, 'a house is no narrator');
});

test('a narrator fix never moves an id: the collision suffix still reads the parenthesis', () => {
	const out = buildCatalog(merge(
		folderBook(511, 'Tin Crown', 'Ida Marsh/Tin Crown (1942)'),
		folderBook(512, 'Tin Crown', 'Ida Marsh/Tin Crown (Various)'),
	));
	assert.deepStrictEqual(Object.keys(out.works).sort(), ['ida-marsh/tin-crown~1942', 'ida-marsh/tin-crown~various']);
});

test('cleanAuthor keeps the person who wrote it out of a credit list', () => {
	const cases = [
		['Ida Marsh/Jo Vale/&#169;2019 by Harbour Books', 'Ida Marsh'],
		['BBC/Ida Marsh/Jo Vale/Rhea Stone', 'Ida Marsh'],
		['Ida Marsh, Jo Vale - illustrator', 'Ida Marsh'],
		['Ida Marsh, Jo Vale - translator', 'Ida Marsh'],
		['Ida Marsh; Jo Vale', 'Ida Marsh'],
		['Tin Crown II; The Saga Retold by Ida Marsh', 'Ida Marsh'],
		['Ida Marsh, Jo Vale', 'Ida Marsh'],
		['MARSH', 'Marsh'],
		['Ida Marsh', 'Ida Marsh'],
		['Ida Marsh & Jo Vale', 'Ida Marsh & Jo Vale'],
		['BBC Radio 4', null],
		['', null],
	];
	for (const [raw, want] of cases) assert.strictEqual(cleanAuthor(raw), want, raw);
});

test('the track artist stands in for Various Artists, and an album artist nothing backs gives way to the tags', () => {
	const various = folderBook(521, 'The Long Sea', 'Shelf One/The Long Sea LP', { artist: 'Various Artists', extra: { originalTitle: 'Ida Marsh; Jo Vale' } });
	const w = only(various);
	assert.deepStrictEqual([w.id, w.author, w.narrator], ['ida-marsh/the-long-sea', 'Ida Marsh', 'Jo Vale']);

	const junk = folderBook(522, 'The Birch', 'Shelf One/Ida Marsh', { artist: 'Kid Ferro', tags: { artist: 'Ida Marsh', album: 'The Birch' } });
	assert.strictEqual(only(junk).author, 'Ida Marsh', 'the folder and the files say Ida Marsh');
	const backed = folderBook(523, 'The Birch', 'Kid Ferro/The Birch', { artist: 'Kid Ferro', tags: { artist: 'Ida Marsh' } });
	assert.strictEqual(only(backed).author, 'Kid Ferro', 'an album artist the folder names stays');
});

test('a shelf folder of many authors is never an author; a credit in the folder name or the house is', () => {
	const shelf = (rk, name, artist) => folderBook(rk, name, `Myths/${name}`, { artist });
	const lib = merge(
		shelf(531, 'Tin Crown', 'Ida Marsh'),
		shelf(532, 'Grey Tides', 'Wren Halloway'),
		shelf(533, 'Low Sun', 'Rhea Stone'),
		folderBook(534, 'The Golden Wake by Jo Vale', 'Myths/The Golden Wake by Jo Vale', { artist: '' }),
		folderBook(535, 'Old Voices', 'Myths/Old Voices Radio Dramatised', { artist: 'BBC Radio 4' }),
		folderBook(536, 'Quiet Hours', 'Myths/Quiet Hours', { artist: '' }),
	);
	const out = buildCatalog(lib);
	const by = (title) => Object.values(out.works).find((w) => w.title === title);
	assert.deepStrictEqual([by('The Golden Wake').id, by('The Golden Wake').author], ['jo-vale/the-golden-wake', 'Jo Vale']);
	assert.deepStrictEqual([by('Old Voices').id, by('Old Voices').doubts], ['bbc-radio-4/old-voices', [{ code: 'no-author' }]], 'the station stands in, and the doubt stays');
	assert.deepStrictEqual([by('Quiet Hours').id, by('Quiet Hours').doubts], ['untitled/quiet-hours', [{ code: 'no-author' }]], 'never "Myths"');

	const lone = buildCatalog(merge(folderBook(537, 'Quiet Hours', 'Ida Marsh/Quiet Hours', { artist: '' })));
	assert.deepStrictEqual(Object.keys(lone.works), ['ida-marsh/quiet-hours'], 'a folder of one author still names it');
});

test('titles lose store tails and credits, and keep the volume number', () => {
	for (const [raw, want] of [
		['Tin Crown - A Novel', 'Tin Crown'],
		['Galene: A Short Story', 'Galene'],
		['Tin Crown: Penguin Classics', 'Tin Crown'],
		['The Iliad (Jo Vale Transl) Read by Rhea Stone', 'The Iliad'],
		['The Age of Tin Vol 1 (1855) Read by Jo Vale', 'The Age of Tin Vol 1'],
		['BBC The Glass Plays', 'The Glass Plays'],
		['Tin Crown; Harbour Vinyl LP (1966)', 'Tin Crown'],
		['The Final Ember 2', 'The Final Ember'],
	]) assert.strictEqual(cleanTitle(raw), want, raw);

	const out = buildCatalog(merge(
		folderBook(541, 'The Age of Tin Vol 1 (1855) read by Jo Vale', 'Ida Marsh/The Age of Tin Vol 1 by Ida Marsh (1855) read by Jo Vale'),
		folderBook(542, 'The Age of Tin Vol 2 (1855) read by Jo Vale', 'Ida Marsh/The Age of Tin Vol 2 by Ida Marsh (1855) read by Jo Vale'),
		folderBook(543, 'The Kettle by Ida Marsh (Rhea Stone transl.) Read by Jo Vale', 'Ida Marsh/The Kettle'),
	));
	assert.deepStrictEqual(Object.values(out.works).map((w) => [w.id, w.title, w.narrator]).sort(), [
		['ida-marsh/the-age-of-tin-vol-1', 'The Age of Tin Vol 1', 'Jo Vale'],
		['ida-marsh/the-age-of-tin-vol-2', 'The Age of Tin Vol 2', 'Jo Vale'],
		['ida-marsh/the-kettle', 'The Kettle', 'Jo Vale'],
	]);
});

test('a store tail names the series and number, and an author prefix leaves the series', () => {
	const read = (raw) => { const r = bookCatalog.storeSeriesReading(raw); return r && [r.title, r.series, r.sequence]; };
	assert.deepStrictEqual(read('Low Sun: The Rust Ledger, Book 4'), ['Low Sun', 'The Rust Ledger', 4]);
	assert.deepStrictEqual(read('Grey Tides: Book Two of the Rust Ledger (Unabridged)'), ['Grey Tides', 'the Rust Ledger', 2]);
	assert.deepStrictEqual(read('Salt Road - Rust Ledger Series, Book 3'), ['Salt Road', 'Rust Ledger', 3]);
	assert.strictEqual(read('Something: A Brief History'), null);

	const tides = only(folderBook(551, 'Grey Tides: Book Two of the Rust Ledger', 'Wren Halloway/Grey Tides', { artist: 'Wren Halloway' }));
	assert.deepStrictEqual([tides.id, tides.title, tides.series, tides.sequence], ['wren-halloway/grey-tides', 'Grey Tides', 'The Rust Ledger', 2]);
	const prefixed = only(folderBook(552, 'Wren Halloway - The Rust Ledger 7: Iron Sea', 'Wren Halloway/Iron Sea', { artist: 'Wren Halloway' }));
	assert.deepStrictEqual([prefixed.series, prefixed.sequence, prefixed.title], ['The Rust Ledger', 7, 'Iron Sea']);
});

test('a numbered series folder joins the series a sibling by the same author names', () => {
	const out = buildCatalog(merge(
		folderBook(561, 'Cold Iron', 'Shelf/The Rust Ledger 01 - Cold Iron by Wren Halloway', { artist: 'Wren Halloway' }),
		folderBook(562, 'Low Sun', 'Shelf/The Rust Ledger 03 Low Sun by Wren Halloway', { artist: 'Wren Halloway' }),
		folderBook(563, 'Tide Book', 'Shelf/Room 2 Tide Book', { artist: 'Ida Marsh' }),
	));
	const by = (title) => Object.values(out.works).find((w) => w.title === title);
	assert.deepStrictEqual([by('Low Sun').series, by('Low Sun').sequence, by('Low Sun').detected.sources.series], ['The Rust Ledger', 3, 'folder']);
	assert.deepStrictEqual([by('Tide Book').series, by('Tide Book').sequence], [null, null], 'a number with no sibling series is left alone');
});

// Loose single-file books in one folder, as Plex lumps them: #1 names the series one way, #7 with
// the author in front, and #2 and #3 only carry a track number.
test('siblings spelling one series with and without the author are one series, and the numbered ones join it', () => {
	const first = album(5701, 'The Rust Ledger 1: Cold Iron', 'Wren Halloway', ['Audiobook']);
	const lumped = album(5702, 'The Rust Ledger 1: Cold Iron', 'Various Artists', ['Audiobook']);
	const books = [[1, 'Cold Iron', 'The Rust Ledger 1: Cold Iron'], [2, 'Grey Tides', 'Grey Tides'], [3, 'Low Sun', 'Low Sun'], [7, 'Iron Sea', 'Wren Halloway - The Rust Ledger 07 - Iron Sea']];
	const tracks = [];
	const trackTags = {};
	for (const [n, title, albumTag] of books) {
		const t = track(57010 + n, n === 1 ? first : lumped, `N:/Media/Music/Wren Halloway - #${n} ${title}.m4b`, 150, { index: n, originalTitle: 'Wren Halloway' });
		tracks.push(t);
		trackTags[t.ratingKey] = { tags: { album: albumTag, artist: 'Wren Halloway', track: String(n) } };
	}
	const out = buildCatalog({ roots: ROOTS, albums: [first, lumped], tracks, trackTags });
	assert.deepStrictEqual(Object.values(out.works).map((w) => [w.title, w.series, w.sequence]).sort((a, b) => a[2] - b[2]), [
		['Cold Iron', 'The Rust Ledger', 1],
		['Grey Tides', 'The Rust Ledger', 2],
		['Low Sun', 'The Rust Ledger', 3],
		['Iron Sea', 'The Rust Ledger', 7],
	]);
});

test('a short play on long tracks is a work, and the music veto still holds', () => {
	const play = only(folderBook(581, 'The Lamps', 'Ida Marsh/The Lamps LP', { genres: [], n: 4, min: 17 }));
	assert.deepStrictEqual([play.detectedBy, play.confidence], ['median-short', 'medium']);
	const mix = buildCatalog(merge(folderBook(582, 'Night Drive', 'Kid Ferro/Night Drive', { artist: 'Kid Ferro', genres: ['Electronic'], n: 2, min: 30 })));
	assert.deepStrictEqual(Object.keys(mix.works), []);
	const scrap = buildCatalog(merge(folderBook(583, 'Short Bits', 'Ida Marsh/Short Bits', { genres: [], n: 2, min: 18 })));
	assert.deepStrictEqual(Object.keys(scrap.works), [], 'under 40 min in all is too short');
	assert.deepStrictEqual(bookCatalog.classify({ totalMs: 39 * MIN, medianMs: 20 * MIN, musicShare: 0, bookShare: 0 }), null);
});

test('an LP of mid-length scenes beside three works in its folder is one more, and is listed when it is not', () => {
	const plays = (rk, title) => folderBook(rk, title, `Plays/${title}`, { artist: 'Ida Marsh' });
	const lp = (rk, folder, genres = []) => folderBook(rk, 'The Kettle', folder, { artist: 'Ida Marsh', genres, n: 8, min: 10.5 });
	const shelf = [plays(591, 'Tin Crown'), plays(592, 'Grey Tides'), plays(593, 'Low Sun')];
	const taken = buildCatalog(merge(...shelf, lp(594, 'Plays/The Kettle LP')));
	const kettle = Object.values(taken.works).find((w) => w.title === 'The Kettle');
	assert.deepStrictEqual([kettle && kettle.detectedBy, taken.rejected.length], ['sibling-books', 0]);

	const music = buildCatalog(merge(...shelf, lp(595, 'Plays/The Kettle LP', ['Rock'])));
	assert.ok(!Object.values(music.works).some((w) => w.title === 'The Kettle'), 'a music genre keeps it music');
	const alone = buildCatalog(merge(plays(596, 'Tin Crown'), lp(597, 'Plays/The Kettle LP')));
	assert.ok(!Object.values(alone.works).some((w) => w.title === 'The Kettle'), 'one work beside it is no shelf');
	assert.deepStrictEqual(alone.rejected.map((r) => [r.folderKey, r.reason, r.medianMin, r.maxMin]), [['N:/Media/Music/Plays/The Kettle LP', 'under 2 h', 10.5, 10.5]], 'a 10-minute median is listed though no track reaches 15 minutes');
	const songs = buildCatalog(merge(...shelf, folderBook(598, 'Pop Hits', 'Plays/Pop Hits', { genres: [], n: 20, min: 3.5 })));
	assert.ok(!Object.values(songs.works).some((w) => w.title === 'Pop Hits'), 'three-minute tracks are songs');
	const atRoot = buildCatalog(merge(
		folderBook(599, 'Tin Crown', 'Tin Crown'), folderBook(600, 'Grey Tides', 'Grey Tides'), folderBook(601, 'Low Sun', 'Low Sun'), lp(602, 'The Kettle LP'),
	));
	assert.ok(!Object.values(atRoot.works).some((w) => w.title === 'The Kettle'), 'a section root backs nothing');
});

test('two works given one id both survive, each under its own folder name', () => {
	const out = buildCatalog(merge(
		folderBook(611, 'Tin Crown (Jo Vale)', 'Ida Marsh/Tin Crown (Jo Vale)'),
		folderBook(612, 'Tin Crown (Jo Vale)', 'Ida Marsh/Old Rips/Tin Crown (Jo Vale)'),
	));
	assert.deepStrictEqual(Object.keys(out.works).sort(), ['ida-marsh/tin-crown~old-rips-tin-crown-jo-vale', 'ida-marsh/tin-crown~tin-crown-jo-vale']);
	assert.strictEqual(out.works['ida-marsh/tin-crown~old-rips-tin-crown-jo-vale'].folderKey, 'N:/Media/Music/Ida Marsh/Old Rips/Tin Crown (Jo Vale)');
	assert.ok(Object.values(out.works).every((w) => w.parts.length === 3));
	assert.deepStrictEqual(out.notes, ['2 works came out as ida-marsh/tin-crown~jo-vale, so they are ida-marsh/tin-crown~tin-crown-jo-vale, ida-marsh/tin-crown~old-rips-tin-crown-jo-vale']);
});

// The bug: the first holder by folder sort kept a duplicated id and the rest were numbered on, so
// a third copy that sorted first took the first copy's id, the first took the second's, and
// matchAliases saw the same ids and moved nothing: bookmarks and overrides followed the id to
// another recording.
test('a third copy of a duplicate leaves the first two their ids', () => {
	const A = folderBook(611, 'Tin Crown (Jo Vale)', 'Ida Marsh/Tin Crown (Jo Vale)');
	const B = folderBook(612, 'Tin Crown (Jo Vale)', 'Ida Marsh/Zz Rips/Tin Crown (Jo Vale)');
	const N = folderBook(613, 'Tin Crown (Jo Vale)', 'Ida Marsh/Old Rips/Tin Crown (Jo Vale)');
	const one = buildCatalog(merge(A, B)).works;
	const two = matchAliases(one, buildCatalog(merge(A, B, N)).works);
	const rksOf = (w) => w.parts.map((p) => p.trackRatingKey).join(',');
	for (const [id, w] of Object.entries(one)) {
		const now = two.works[two.moved[id] || id];
		assert.ok(now, id);
		assert.strictEqual(rksOf(now), rksOf(w), `${id} still names the same recording`);
	}
	assert.deepStrictEqual(two.moved, {});
	assert.ok(Object.keys(two.works).includes('ida-marsh/tin-crown~old-rips-tin-crown-jo-vale'));
});

// The bug: an id held before and after a build was taken as the same work without a look at its
// parts, so an id that passed to another recording took the old work's aliases with it.
test('an id that passed to another recording sends the old work to its real heir', () => {
	const oldA = { id: 'ida-marsh/tin-crown~a', aliases: ['ida-marsh/old-a'], parts: [{ trackRatingKey: '1', file: 'a1.mp3', durationMs: 1 }, { trackRatingKey: '2', file: 'a2.mp3', durationMs: 1 }] };
	const newB = { id: 'ida-marsh/tin-crown~a', aliases: [], parts: [{ trackRatingKey: '9', file: 'b1.mp3', durationMs: 1 }] };
	const newA = { id: 'ida-marsh/tin-crown~c', aliases: [], parts: oldA.parts };
	const m = matchAliases([oldA], [newB, newA]);
	assert.deepStrictEqual(m.moved, { 'ida-marsh/tin-crown~a': 'ida-marsh/tin-crown~c' });
	assert.deepStrictEqual(m.works['ida-marsh/tin-crown~a'].aliases, [], 'the newcomer gets none of the old aliases');
	assert.deepStrictEqual(m.works['ida-marsh/tin-crown~c'].aliases, ['ida-marsh/old-a']);
	const carried = bookCatalog.carryOverrides({ works: { 'ida-marsh/tin-crown~a': { partOrder: ['a2.mp3', 'a1.mp3'], title: 'Kept' } } }, [oldA], [newB, newA], m.moved);
	assert.deepStrictEqual(carried.overrides.works['ida-marsh/tin-crown~c'], { partOrder: ['a2.mp3', 'a1.mp3'] });
	assert.deepStrictEqual(carried.overrides.works['ida-marsh/tin-crown~a'], { title: 'Kept' }, 'the order leaves the recording that took the id');
});

// The bug: an exclude written for a whole folder matched only that exact folder key, so when a
// rule change cut the folder into one work per book ("…#book:<slug>") every piece came back.
test('a split folder keeps a whole-folder exclude, and a piece exclude hides that piece only', () => {
	const lib = threePlays();
	const folder = 'N:/Media/Music/Plays/Ida Marsh';
	const whole = buildCatalog({ ...lib, overrides: { works: { 'kid-ferro/the-birch': { exclude: true, folderKey: folder } } } });
	assert.deepStrictEqual(Object.keys(whole.works), [], 'every piece of the excluded folder stays out');
	assert.deepStrictEqual(whole.notes, [], 'a held folder is no stale override');
	const piece = buildCatalog({ ...lib, overrides: { works: { 'ida-marsh/the-moss': { exclude: true, folderKey: `${folder}#book:the-moss` } } } });
	assert.deepStrictEqual(Object.keys(piece.works).sort(), ['ida-marsh/the-birch', 'ida-marsh/the-lamps']);
	const loose = [
		{ id: 'jo-vale/tin-crown', folderKey: 'N:/Media/Music#book:tin-crown', parts: [] },
		{ id: 'jo-vale/grey-tides', folderKey: 'N:/Media/Music#book:grey-tides', parts: [] },
		{ id: 'jo-vale/low-sun', folderKey: 'N:/Media/Music/Jo Vale/Low Sun', parts: [] },
	];
	const kept = bookCatalog.applyOverrides(loose, { works: { x: { exclude: true, folderKey: 'n:\\media\\music#book:tin-crown' } } });
	assert.deepStrictEqual(Object.keys(kept).sort(), ['jo-vale/grey-tides', 'jo-vale/low-sun'], 'a loose book at the root hides no other');
});

// The bug: the median-short rule took any group of 40 min to 2 h on long tracks without a music
// genre, so a single hour-long mix with no genre, or one tagged "DJ Mix", left music as a book.
test('an hour-long single file with nothing saying what it is, or a mix genre, stays music', () => {
	const bare = buildCatalog(merge(folderBook(631, 'Essential Mix', 'Some DJ/Essential Mix', { genres: [], n: 1, min: 62 })));
	assert.deepStrictEqual(Object.keys(bare.works), []);
	const dj = buildCatalog(merge(folderBook(632, 'Essential Mix', 'Some DJ/Essential Mix', { genres: ['DJ Mix'], n: 1, min: 62 })));
	assert.deepStrictEqual(Object.keys(dj.works), []);
	const play = buildCatalog(merge(folderBook(633, 'Galeta', 'Mythic/Galeta', { genres: ['Mythology'], n: 1, min: 62 })));
	assert.strictEqual(Object.values(play.works).length, 1, 'one file with a genre that is not music is still a short work');
	const lp = buildCatalog(merge(folderBook(634, 'Tin Crown LP', 'Ida Marsh/Tin Crown LP', { genres: [], n: 4, min: 18 })));
	assert.strictEqual(Object.values(lp.works).length, 1, 'four long scenes with no genre are still a play');
});

// The bug: a single author written surname first with a two-word surname ("Le Guin, Ursula K.")
// passed as two people, and only "Le Guin" was kept.
test('an author written surname first is one person', () => {
	assert.strictEqual(cleanAuthor('Le Guin, Ursula K.'), 'Ursula K. Le Guin');
	assert.strictEqual(cleanAuthor('Van Vogt, A. E.'), 'A. E. Van Vogt');
	assert.strictEqual(cleanAuthor('Marsh, J.R.R.'), 'J.R.R. Marsh');
	assert.strictEqual(cleanAuthor('Ida Marsh, Jo Vale'), 'Ida Marsh', 'two people still keep the first');
	assert.strictEqual(cleanAuthor('Homer, Rhea Stone'), 'Homer, Rhea Stone', 'two given words with no initial may be a second person');
});

// Five volumes poured into one folder: each restarts at 01, and the intros carry no chapter
// number, so only each file's own "(k of n)" album tag places them.
function glassRoad() {
	const a = album(6201, 'The Glass Road', 'Ida Marsh', ['Audiobook']);
	const vols = [
		['01 intro', '02 Prelude', '03 Chapter 1', '04 Chapter 2', '05 outro'],
		['01 Chapter 3', '02 Chapter 4', '03 outro'],
		['01 intro', '02 Chapter 5', '03 Chapter 6', '04 outro'],
	];
	const tracks = [];
	const trackTags = {};
	vols.forEach((names, v) => names.forEach((name, i) => {
		const t = track(62010 + v * 10 + i, a, `N:/Media/Music/Ida Marsh/The Glass Road/${name}.mp3`, 13, { index: i + 1 });
		tracks.push(t);
		trackTags[t.ratingKey] = { tags: { album: `The Glass Road (${v + 1} of 3)`, ...(i === 0 && v === 0 ? {} : { track: String(i + 1) }) } };
	}));
	return { roots: ROOTS, albums: [a], tracks, trackTags };
}

test('interleaved volumes follow their album tags, and the files are read one by one for it', () => {
	const lib = glassRoad();
	const w = Object.values(buildCatalog(lib).works)[0];
	assert.deepStrictEqual([w.orderMethod, w.confidence], ['tagged-volumes', 'medium']);
	assert.deepStrictEqual(w.parts.map((p) => p.title), [
		'01 intro', '02 Prelude', '03 Chapter 1', '04 Chapter 2', '05 outro',
		'01 Chapter 3', '02 Chapter 4', '03 outro',
		'01 intro', '02 Chapter 5', '03 Chapter 6', '04 outro',
	]);
	const missing = { ...lib.trackTags };
	delete missing[lib.tracks[3].ratingKey];
	assert.strictEqual(Object.values(buildCatalog({ ...lib, trackTags: missing }).works)[0].orderMethod, 'interleaved-volumes', 'one silent file keeps the chapter order');

	const samples = bookCatalog.tagSamples(lib.tracks, { roots: ROOTS, albums: lib.albums });
	assert.strictEqual(samples.length, lib.tracks.length, 'one album sample and every other file');
	const rock = { ...lib.albums[0], Genre: [{ tag: 'Rock' }] };
	assert.strictEqual(bookCatalog.tagSamples(lib.tracks, { roots: ROOTS, albums: [rock] }).length, 1, 'a bucket of songs sharing track numbers is not read');
});

// Three plays in one mp3 folder, filed by Plex as one album under a made-up artist. Each file's
// own album tag names its play, and its file name repeats it.
function threePlays() {
	const a = album(6301, 'The Birch', 'Kid Ferro', ['Literature']);
	const files = [['The Birch by Ida Marsh 1990 Radio.mp3', 'The Birch', 120], ['The Lamps by Ida Marsh 1.mp3', 'The Lamps', 45], ['The Lamps by Ida Marsh 2.mp3', 'The Lamps', 30],
		['The Lamps by Ida Marsh 3.mp3', 'The Lamps', 25], ['The Moss by Ida Marsh 1.mp3', 'The Moss', 54], ['The Moss by Ida Marsh 2.mp3', 'The Moss', 48]];
	const tracks = files.map(([f, , min], i) => track(63010 + i, a, `N:/Media/Music/Plays/Ida Marsh/${f}`, min, { index: i + 1 }));
	const trackTags = Object.fromEntries(files.map(([, play], i) => [tracks[i].ratingKey, { tags: { album: play, artist: 'Ida Marsh', track: String(i + 1) } }]));
	return { roots: ROOTS, albums: [a], tracks, trackTags };
}

test('an mp3 folder of plays splits by album tag, and the old id goes to the play holding its first part', () => {
	const lib = threePlays();
	const out = buildCatalog(lib);
	assert.deepStrictEqual(Object.values(out.works).map((w) => [w.id, w.parts.length]).sort(), [['ida-marsh/the-birch', 1], ['ida-marsh/the-lamps', 3], ['ida-marsh/the-moss', 2]]);

	const unsplit = buildCatalog({ ...lib, trackTags: {} }).works;
	assert.deepStrictEqual(Object.keys(unsplit), ['kid-ferro/the-birch'], 'without tags it is one work under the Plex artist');
	assert.deepStrictEqual(matchAliases(unsplit, out.works).moved, { 'kid-ferro/the-birch': 'ida-marsh/the-birch' }, 'the three-file play holds half the files, yet the first part names the heir');

	const unnamed = { ...lib, tracks: lib.tracks.map((t, i) => ({ ...t, Media: [{ ...t.Media[0], Part: [{ ...t.Media[0].Part[0], file: `N:/Media/Music/Plays/Ida Marsh/Track ${i + 1}.mp3` }] }] })) };
	assert.strictEqual(Object.keys(buildCatalog(unnamed).works).length, 1, 'an album tag the file name does not repeat splits no mp3 folder');
});

test('one tagger typo in an album tag splits no book', () => {
	const a = album(6401, 'The Glass Plays', 'Ida Marsh', ['Audiobook']);
	const tracks = [1, 2, 3].map((i) => track(64010 + i, a, `N:/Media/Music/Ida Marsh/The Glass Plays/Glass ${i}.m4b`, 80, { index: i }));
	const tags = ['The Glass Plays', 'The Glass Playes', 'The Glass Plays'];
	const out = buildCatalog({ roots: ROOTS, albums: [a], tracks, trackTags: Object.fromEntries(tracks.map((t, i) => [t.ratingKey, { tags: { album: tags[i] } }])) });
	assert.deepStrictEqual(Object.values(out.works).map((w) => w.parts.length), [3]);
});

test('works carry their genres and the section folder they sit under, apart from the id', () => {
	const lib = folderBook(651, 'Tin Crown', 'Ida Marsh/Tin Crown', { genres: ['Audiobook', 'Mythology'], tags: { genre: 'audiobook' } });
	const w = only(lib);
	assert.deepStrictEqual([w.genres, w.root, w.dirs], [['Audiobook', 'Mythology'], 'N:\\Media\\Music', ['N:/Media/Music/Ida Marsh/Tin Crown']]);
	const elsewhere = Object.values(buildCatalog({ ...merge(lib), roots: ['Q:\\Other'] }).works)[0];
	assert.deepStrictEqual([elsewhere.root, elsewhere.id], [null, w.id]);
});

test('cheap doubts name a credit left in a title or author and a shelf taken for an author', () => {
	const credit = only(folderBook(661, 'The Greek Tales by Rhea Stone', 'Ida Marsh/The Greek Tales by Rhea Stone'));
	assert.deepStrictEqual(credit.doubts, [{ code: 'title-credit', title: 'The Greek Tales by Rhea Stone' }]);
	const role = only(folderBook(662, 'Tin Crown', 'Jo Vale translator/Tin Crown', { artist: '' }));
	assert.deepStrictEqual(role.doubts, [{ code: 'author-credit', author: 'Jo Vale translator' }]);
	const shelf = (rk, name, artist) => folderBook(rk, name, `Myths/${name}`, { artist });
	const out = buildCatalog(merge(shelf(663, 'Tin Crown', 'Ida Marsh'), shelf(664, 'Grey Tides', 'Wren Halloway'), shelf(665, 'Low Sun', 'Myths')));
	assert.deepStrictEqual(Object.values(out.works).find((w) => w.title === 'Low Sun').doubts, [{ code: 'author-shelf', author: 'Myths' }]);
	for (const w of Object.values(out.works)) assert.ok(!/[\\/]/.test(JSON.stringify(w.doubts)), 'doubts name no folder path');
});

test('html entities in cached tags and Plex names are decoded', () => {
	assert.strictEqual(bookCatalog.decodeEntities('&#169;2019 Harbour &amp; Sons &#x2014; &bogus;'), '©2019 Harbour & Sons \u2014 &bogus;');
	const w = only(folderBook(671, 'Tin Crown', 'Ida Marsh/Tin Crown', { artist: '', tags: { artist: 'Ida Marsh/Jo Vale/&#169;2019 by Harbour Books' } }));
	assert.deepStrictEqual([w.author, w.narrator], ['Ida Marsh', 'Jo Vale']);
});
