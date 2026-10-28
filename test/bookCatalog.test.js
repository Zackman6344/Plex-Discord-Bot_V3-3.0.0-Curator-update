// helpers/bookCatalog.js: grouping a Plex music listing into audiobook and podcast works, their
// play order, the overrides file, id aliases across rebuilds, and the membership index.
//
// The bug: Plex albums are not books on a hand-ripped library, so every shortcut fails somewhere.
// Grouping by album merges seven books that share one album title and splits one book over two
// albums; path order plays interleaved volumes out of sequence; a duration rule lets short chapter
// files into music and takes long music mixes for books; two narrations of one book collapse into
// one work with one bookmark; a renamed folder orphans every bookmark saved under the old id.
//
// The bug (rules version 3): a stray "Disc 2" folder of a rap album folded into the library root,
// where a loose GraphicAudio book file sat, and the two became one work called "Music" by the
// rapper. The publisher in the artist field, a truncated cast list read as the narrator, folder
// capitalisation and a lost apostrophe all showed through, and the old id held a live bookmark
// that a count-only alias match would have orphaned.
//
// Harness: the plain pure-function style of test/bookModel.test.js. test/fixtures/books/ holds a
// SYNTHETIC library (invented names under M:/Music/) that reproduces each of those structures,
// built by a generator kept outside the repo; catalog.json is its built form, which the music
// exclusion tests seed the store with, and tags.json holds invented embedded tags by album. The
// version 3 and 4 cases build small invented libraries under N:/Media/Music inline, so the shared
// fixture that other test files read stays as it was.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bookCatalog = require('../helpers/bookCatalog.js');
const { buildCatalog, applyOverrides, matchAliases, buildIndex, normalizeChapters } = bookCatalog;

const FIXTURES = path.join(__dirname, 'fixtures', 'books');
const LIBRARY = require(path.join(FIXTURES, 'library.json'));
const CATALOG = require(path.join(FIXTURES, 'catalog.json'));
const OVERRIDES = require(path.join(FIXTURES, 'overrides.json'));
const TAGS = require(path.join(FIXTURES, 'tags.json'));

function library() {
	return JSON.parse(JSON.stringify(LIBRARY));
}

const BASE = buildCatalog(library());

function titles(work) {
	return work.parts.map((p) => p.title);
}

function trackKeysOf(lib, predicate) {
	return lib.tracks.filter(predicate).map((t) => String(t.ratingKey));
}

test('seven books sharing one album title are seven works, numbered from their folders', () => {
	const ashfall = Object.values(BASE.works).filter((w) => w.series === 'Ashfall');
	assert.deepStrictEqual(ashfall.map((w) => [w.id, w.sequence]), [
		['avery-quill/the-ember-throne', 1],
		['avery-quill/the-salt-crown', 2],
		['avery-quill/the-last-lantern', 3],
		['avery-quill/the-iron-wake', 4],
		['avery-quill/shadows-of-glass', 5],
		['avery-quill/the-copper-bells', 6],
		['avery-quill/ashfall-collected-tales', 7],
	]);
	for (const w of ashfall) {
		assert.strictEqual(w.author, 'Avery Quill');
		assert.strictEqual(w.edition, w.publisher, 'a cast cut short is no edition name');
		assert.strictEqual(w.kind, 'book');
	}
	assert.deepStrictEqual(titles(BASE.works['avery-quill/the-ember-throne']), [
		'Ashfall: The Ember Throne Part 1 Part 1', 'Ashfall: The Ember Throne Part 1 Part 2', '03.The Ember Throne', '04.The Ember Throne',
	]);
});

test('a book split over two albums is one work, and the work sharing its second album stays apart', () => {
	const bells = BASE.works['avery-quill/the-copper-bells'];
	assert.deepStrictEqual(bells.parts.map((p) => [p.albumRatingKey, p.file]), [
		['1006', '01.The Copper Bells.mp3'],
		['1006', '02.The Copper Bells.mp3'],
		['1007', '03.The Copper Bells.mp3'],
		['1007', '04.The Copper Bells.mp3'],
	]);
	assert.strictEqual(bells.author, 'Avery Quill', 'the GraphicAudio artist spelling is a publisher, not the author');
	assert.strictEqual(bells.confidence, 'medium');
	assert.ok(bells.notes.some((n) => /spread over 2 Plex albums/.test(n)));

	const tales = BASE.works['avery-quill/ashfall-collected-tales'];
	assert.deepStrictEqual(tales.parts.map((p) => p.albumRatingKey), ['1007', '1007', '1007', '1007']);
	assert.ok(tales.notes.some((n) => /shares a Plex album/.test(n)));
});

test('interleaved volumes in one folder play in chapter order, not path order', () => {
	const road = BASE.works['avery-quill/the-glass-road'];
	assert.deepStrictEqual(titles(road), [
		'01 intro', '02 Prelude', '03 Prologue', '04 Chapter 1', '05 Chapter 2', '06 Interlude 1-1', '07 Chapter 3',
		'01 Chapter 10', '02 Chapter 11', '03 Chapter 12',
		'01 Chapter 20', '02 Chapter 21', '03 Epilogue', '04 Endnote', '05 outro',
	]);
	assert.deepStrictEqual(road.parts.map((p) => p.ordinal), road.parts.map((p, i) => i + 1));
	assert.strictEqual(road.orderMethod, 'interleaved-volumes');
	assert.strictEqual(road.confidence, 'low');
	assert.strictEqual(road.title, 'The Glass Road', 'a flat author folder takes its name from the album');
	assert.strictEqual(road.edition, 'GraphicAudio');

	const pathOrder = [...road.parts].sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true })).map((p) => p.title);
	assert.notDeepStrictEqual(pathOrder, titles(road), 'the fixture really is out of order by path');
});

test('a coded volume is spliced in at its volume number', () => {
	const t = (title, file) => ({ title, Media: [{ Part: [{ file: `M:/Music/X/${file}` }] }] });
	const order = bookCatalog.orderInterleaved([
		t('01 Chapter 1', '01 Road - Chapter 1.mp3'),
		t('02 Chapter 2', '02 Road - Chapter 2.mp3'),
		t('01 Chapter 9', '01 Road - Chapter 9.mp3'),
		t('STORMLIGHT0102P02', 'STORMLIGHT0102P02.mp3'),
		t('STORMLIGHT0102P01', 'STORMLIGHT0102P01.mp3'),
	]);
	assert.deepStrictEqual(order.map((x) => x.title), [
		'01 Chapter 1', '02 Chapter 2', 'STORMLIGHT0102P01', 'STORMLIGHT0102P02', '01 Chapter 9',
	]);
});

test('narrator editions get the narrator in the id only where two would collide', () => {
	const ids = Object.keys(BASE.works).filter((id) => id.startsWith('ilse-moreau/'));
	assert.deepStrictEqual(ids.sort(), [
		'ilse-moreau/the-far-shore~harlow',
		'ilse-moreau/the-far-shore~penrose',
		'ilse-moreau/the-glass-sea',
		'ilse-moreau/the-night-gate~harlow',
		'ilse-moreau/the-night-gate~penrose',
	]);
	assert.strictEqual(BASE.works['ilse-moreau/the-far-shore~penrose'].narrator, 'Penrose');
	assert.strictEqual(BASE.works['ilse-moreau/the-far-shore~penrose'].title, 'The Far Shore');
	assert.strictEqual(BASE.works['ilse-moreau/the-glass-sea'].narrator, null, '"(Various)" names a cast');
	assert.strictEqual(BASE.works['ilse-moreau/the-glass-sea'].edition, 'Various', 'and still tells the edition apart');
	assert.strictEqual(BASE.works['avery-quill/the-glass-road'].narrator, null, 'a publisher is an edition, not a narrator');
});

test('two same-named long files from different narrations stay in separate works', () => {
	const a = BASE.works['ilse-moreau/the-night-gate~penrose'].parts[1];
	const b = BASE.works['ilse-moreau/the-night-gate~harlow'].parts[1];
	assert.strictEqual(a.file, 'Night Gate 21.mp3');
	assert.strictEqual(b.file, 'Night Gate 21.mp3');
	assert.notStrictEqual(a.trackRatingKey, b.trackRatingKey);
	assert.notStrictEqual(a.sizeBytes, b.sizeBytes);
	assert.notStrictEqual(a.durationMs, b.durationMs);
	assert.strictEqual(BASE.works['ilse-moreau/the-night-gate~penrose'].parts.length, 2);
	assert.strictEqual(BASE.works['ilse-moreau/the-night-gate~harlow'].parts.length, 2);
});

test('a podcast plays in episode-number order whatever its files are called', () => {
	const pod = BASE.works['lantern-hollow/the-tin-valley'];
	assert.strictEqual(pod.kind, 'podcast');
	assert.strictEqual(pod.series, 'Lantern Hollow');
	assert.strictEqual(pod.orderMethod, 'episode-number');
	assert.deepStrictEqual(titles(pod), [
		'LH Tin Valley ep1 Overture', 'LH Tin Valley Ep2', 'LH Tin Valley ep3', 'LH Tin Valley ep4',
		'LH Tin Valley ep5', 'LH Tin Valley ep6', 'LH Tin Valley ep7', 'LH Tin Valley Ep8',
	]);
	assert.ok(!titles(pod).includes('Tin Valley Theme'), 'the extras folder is not an episode');
});

// The bug: podcast parts sorted by episode number alone, so a second campaign added to the same
// folder, numbered from ep1 again, was interleaved with the first (ep1, new ep1, Ep2, new ep2,
// ...) and the old last episode stayed last.
const TIN_VALLEY = ['20108', '20110', '20107', '20112', '20111', '20114', '20113', '20109'];

function podcastWork(lib) {
	const works = Object.values(buildCatalog(lib).works).filter((w) => w.parts.some((p) => p.trackRatingKey === '20108'));
	assert.strictEqual(works.length, 1);
	return works[0];
}

function addEpisodes(lib, album, name, numbers, extra = {}) {
	const proto = lib.tracks.find((t) => t.ratingKey === '20107');
	lib.albums.push({ ...lib.albums.find((a) => a.ratingKey === '1050'), ratingKey: album, key: `/library/metadata/${album}/children`, title: name });
	for (const n of numbers) {
		const key = `${album}${n}`;
		const file = `LH ${name} ep${n}.mp3`;
		const t = JSON.parse(JSON.stringify(proto));
		Object.assign(t, { ratingKey: key, key: `/library/metadata/${key}`, parentRatingKey: album, parentTitle: name, title: `LH ${name} ep${n}`, addedAt: 1700100000 + n }, extra);
		Object.assign(t.Media[0].Part[0], { id: Number(key), key: `/library/parts/${key}/1700000000/${file}`, file: `M:/Music/Lantern Hollow/${file}`, size: 70000000 + n });
		lib.tracks.push(t);
	}
}

test('a podcast season that restarts its numbering plays after the season before it', () => {
	const lib = library();
	addEpisodes(lib, '1059', 'Brass Coast', [1, 2, 3]);
	assert.deepStrictEqual(podcastWork(lib).parts.map((p) => p.trackRatingKey), [...TIN_VALLEY, '10591', '10592', '10593']);
});

test('a season with earlier air dates plays first when every season has dates', () => {
	const lib = library();
	for (const t of lib.tracks) if (t.parentRatingKey === '1050') t.originallyAvailableAt = '2023-05-01';
	addEpisodes(lib, '1059', 'Brass Coast', [1, 2], { originallyAvailableAt: '2021-02-01' });
	assert.deepStrictEqual(podcastWork(lib).parts.map((p) => p.trackRatingKey), ['10591', '10592', ...TIN_VALLEY]);
});

test('a podcast with one album per episode keeps episode order whatever order the albums came in', () => {
	const lib = library();
	// Later episodes added first, so ranking these albums would reverse them.
	TIN_VALLEY.forEach((key, i) => {
		const t = lib.tracks.find((x) => x.ratingKey === key);
		t.parentRatingKey = `11${i}`;
		t.addedAt = 1700000900 - i;
		lib.albums.push({ ...lib.albums.find((a) => a.ratingKey === '1050'), ratingKey: `11${i}`, key: `/library/metadata/11${i}/children`, title: `Episode ${i + 1}` });
	});
	assert.deepStrictEqual(podcastWork(lib).parts.map((p) => p.trackRatingKey), TIN_VALLEY);
});

test('a box set over sibling folders of short chapter files is one detected work', () => {
	const king = BASE.works['r-j-ashdown/the-hollow-king'];
	assert.strictEqual(king.parts.length, 35);
	assert.strictEqual(king.detectedBy, 'name-signal', 'the median track is 6.5 min, so only the chapter titles find it');
	assert.strictEqual(king.edition, 'Tomas Brandt');
	assert.strictEqual(king.title, 'The Hollow King');
	assert.strictEqual(king.parts[0].title, '1-01 Book 1  The Stone Garden - Intro');
	assert.strictEqual(king.parts[7].title, '2-01 Book 2  The Weeping Queen - Intro');
	assert.strictEqual(king.parts[34].title, '5-07 Book 5  The Book of Ash - Chapter 06a');
	assert.ok(king.parts.every((p) => p.durationMs <= 6.5 * 60000), 'every part is shorter than any duration rule would catch');
});

test('a lofi bucket with an hour-long mix, a comedy special and a drama bucket stay music', () => {
	assert.deepStrictEqual(BASE.rejected.map((r) => [r.folderKey, r.reason]), [
		['M:/Music/Sam Drift/[Unknown Album]', 'no long-form signal'],
		['M:/Music/Theo Bramble/well', 'under 2 h'],
		['M:/Music/music-uploads', 'no long-form signal'],
	]);
	const lib = library();
	const keys = new Set(BASE.index.trackKeys);
	for (const k of trackKeysOf(lib, (t) => ['1060', '1070', '1080', '1090', '1091', '1051'].includes(String(t.parentRatingKey)))) {
		assert.ok(!keys.has(k), `music track ${k} is not catalogued`);
	}
	const mix = lib.tracks.find((t) => t.title === 'Night Drive Mix');
	assert.ok(mix.duration > 60 * 60000);
	assert.ok(!keys.has(String(mix.ratingKey)));
});

test('a sample clip is left out of play but still kept out of music', () => {
	const wake = BASE.works['avery-quill/the-iron-wake'];
	assert.deepStrictEqual(titles(wake), ['1.The Iron Wake', '2.The Iron Wake', '3.The Iron Wake']);
	assert.strictEqual(wake.dropped.length, 1);
	const sample = library().tracks.find((t) => t.title === 'Sample');
	assert.strictEqual(wake.dropped[0].trackRatingKey, String(sample.ratingKey));
	assert.ok(BASE.index.trackKeys.includes(String(sample.ratingKey)));
	assert.ok(BASE.index.partIds.includes(String(sample.Media[0].Part[0].id)));
	assert.ok(BASE.index.albumKeys.includes('1004'));
});

test('embedded chapters survive and marker points are dropped', () => {
	const tide = BASE.works['corin-vale/the-long-tide'];
	assert.strictEqual(tide.parts.length, 5);
	assert.strictEqual(tide.parts[0].chapters, undefined, 'marker points are not chapters');
	assert.deepStrictEqual(tide.parts[4].chapters, [
		{ title: 'Tidefall Part 1', startMs: 0, endMs: 6000000 },
		{ title: 'Tidefall Part 2', startMs: 6000000, endMs: 12500000 },
		{ title: 'Tidefall Part 3', startMs: 12500000, endMs: 18000000 },
	]);
	assert.ok(tide.parts.every((p) => p.chapterKind === undefined));
	assert.strictEqual(tide.author, 'Corin Vale', 'the author comes from the bracket after the publisher');
});

test('normalizeChapters keeps two or more real chapters and names markers', () => {
	assert.strictEqual(normalizeChapters(undefined), 'none');
	assert.strictEqual(normalizeChapters([]), 'none');
	assert.strictEqual(normalizeChapters([{ tag: 'Marker 1', startTimeOffset: 0, endTimeOffset: 0 }, { tag: 'Marker 2', startTimeOffset: 300000, endTimeOffset: 300000 }]), 'markers');
	assert.strictEqual(normalizeChapters([{ tag: 'Only', startTimeOffset: 0, endTimeOffset: 1000 }]), 'none');
	assert.deepStrictEqual(normalizeChapters([
		{ tag: 'B', startTimeOffset: 5000, endTimeOffset: 9000 },
		{ tag: 'A', startTimeOffset: 0, endTimeOffset: 5000 },
		{ tag: 'bad', startTimeOffset: 9000, endTimeOffset: 9000 },
	]), [{ title: 'A', startMs: 0, endMs: 5000 }, { title: 'B', startMs: 5000, endMs: 9000 }]);
	const normalised = [{ title: 'x', startMs: 0, endMs: 10 }, { title: 'y', startMs: 10, endMs: 20 }];
	assert.deepStrictEqual(normalizeChapters(normalised), normalised, 'an already normalised list passes through');
});

test('chapter probes are wanted only for mp4 containers and parts over two hours', () => {
	const t = (container, min) => ({ duration: min * 60000, Media: [{ container }] });
	assert.strictEqual(bookCatalog.wantsChapters(t('mp4', 60)), true);
	assert.strictEqual(bookCatalog.wantsChapters(t('m4b', 60)), true);
	assert.strictEqual(bookCatalog.wantsChapters(t('mp3', 121)), true);
	assert.strictEqual(bookCatalog.wantsChapters(t('mp3', 119)), false);
	assert.strictEqual(bookCatalog.wantsChapters(t('flac', 60)), false);
});

test('the index holds an album only when every track is catalogued, and a podcast artist always', () => {
	assert.deepStrictEqual(BASE.index.albumKeys, [
		'1001', '1002', '1003', '1004', '1005', '1006', '1007', '1010', '1020', '1021', '1022',
		'1030', '1031', '1032', '1033', '1034', '1040',
	]);
	assert.ok(!BASE.index.albumKeys.includes('1050'), 'the podcast album also holds a theme track in another folder');
	assert.deepStrictEqual(BASE.index.artistKeys, ['9001', '9002', '9003', '9004', '9005', '9006']);
	const parts = Object.values(BASE.works).reduce((s, w) => s + w.parts.length + w.dropped.length, 0);
	assert.strictEqual(BASE.index.trackKeys.length, parts);
	assert.strictEqual(BASE.index.partIds.length, parts);
});

test('the committed catalog fixture matches a fresh build', () => {
	assert.deepStrictEqual(BASE.works, CATALOG.works, 'regenerate test/fixtures/books/catalog.json after a rule change');
	assert.deepStrictEqual(BASE.rejected, CATALOG.rejected);
	assert.deepStrictEqual(BASE.index, CATALOG.index);
	assert.strictEqual(CATALOG.meta.rulesVersion, bookCatalog.RULES_VERSION);
	assert.deepStrictEqual(BASE.notes, []);
});

const WITH = buildCatalog({ ...library(), overrides: OVERRIDES });

test('author overrides set a series and its order by title', () => {
	assert.deepStrictEqual(
		['ilse-moreau/the-far-shore~penrose', 'ilse-moreau/the-far-shore~harlow', 'ilse-moreau/the-night-gate~penrose', 'ilse-moreau/the-night-gate~harlow']
			.map((id) => [WITH.works[id].series, WITH.works[id].sequence]),
		[['Tidewater Cycle', 2], ['Tidewater Cycle', 2], ['Tidewater Cycle', 3], ['Tidewater Cycle', 3]],
	);
});

test('an author override with no order fills a missing series only', () => {
	const out = applyOverrides(BASE.works, { authors: { 'avery-quill': { series: 'Quill Tales' } } });
	assert.strictEqual(out['avery-quill/the-glass-road'].series, 'Quill Tales');
	assert.strictEqual(out['avery-quill/the-ember-throne'].series, 'Ashfall');
	assert.strictEqual(BASE.works['avery-quill/the-glass-road'].series, null, 'the input is not mutated');
});

test('a folder exclude keeps that folder out of the catalog and says so', () => {
	assert.strictEqual(WITH.works['ilse-moreau/the-glass-sea'], undefined);
	const row = WITH.rejected.find((r) => r.folderKey === 'M:/Music/Ilse Moreau/1989 - The Glass Sea (Various) 500mb');
	assert.strictEqual(row.reason, 'excluded by override');
	assert.ok(!WITH.index.albumKeys.includes('1030'));
});

test('partOrder reorders the parts, renumbers them and raises the confidence', () => {
	const road = WITH.works['avery-quill/the-glass-road'];
	assert.deepStrictEqual(titles(road).slice(-3), ['03 Epilogue', '05 outro', '04 Endnote']);
	assert.deepStrictEqual(road.parts.map((p) => p.ordinal), road.parts.map((p, i) => i + 1));
	assert.strictEqual(road.orderMethod, 'override');
	assert.strictEqual(road.confidence, 'high');
	assert.strictEqual(road.series, 'Glassworks');
	assert.strictEqual(road.sequence, 1);
	assert.strictEqual(road.totalMs, BASE.works['avery-quill/the-glass-road'].totalMs);
});

test('a partOrder with unknown and unlisted files keeps the unlisted parts after the listed ones', () => {
	const out = applyOverrides(BASE.works, {
		works: { 'avery-quill/the-salt-crown': { partOrder: ['04.The Salt Crown.mp3', 'nope.mp3', 'M:/Music/x/02.THE SALT CROWN.mp3'] } },
	});
	const crown = out['avery-quill/the-salt-crown'];
	assert.deepStrictEqual(crown.parts.map((p) => p.file), ['04.The Salt Crown.mp3', '02.The Salt Crown.mp3', '01.The Salt Crown.mp3', '03.The Salt Crown.mp3']);
	assert.deepStrictEqual(crown.parts.map((p) => p.ordinal), [1, 2, 3, 4]);
	assert.strictEqual(crown.confidence, 'high', 'confidence is only raised by a complete list');
	assert.ok(crown.notes.some((n) => /not in this work: nope\.mp3/.test(n)));
	assert.ok(crown.notes.some((n) => /leaves 2 part\(s\) unlisted/.test(n)));
});

test('a work exclude removes the work and hands its tracks back to music', () => {
	assert.strictEqual(WITH.works['avery-quill/shadows-of-glass'], undefined);
	const shadow = BASE.works['avery-quill/shadows-of-glass'].parts.map((p) => p.trackRatingKey);
	for (const k of shadow) assert.ok(!WITH.index.trackKeys.includes(k));
	assert.ok(!WITH.index.albumKeys.includes('1005'));
	assert.ok(!WITH.index.artistKeys.includes('9001'), 'the author still has a music album now');
});

test('a sequence override replaces the detected one', () => {
	assert.strictEqual(WITH.works['corin-vale/the-long-tide'].sequence, 2.5);
});

test('pinId gives a stable id and keeps the detected one as an alias', () => {
	assert.strictEqual(WITH.works['r-j-ashdown/the-hollow-king'], undefined);
	const king = WITH.works['rj-ashdown/hollow-king'];
	assert.strictEqual(king.id, 'rj-ashdown/hollow-king');
	assert.deepStrictEqual(king.aliases, ['r-j-ashdown/the-hollow-king']);
	assert.strictEqual(king.title, 'The Hollow King (Complete)');
});

test('a pinId already used by another work is ignored with a note', () => {
	const out = applyOverrides(BASE.works, { works: { 'avery-quill/the-salt-crown': { pinId: 'avery-quill/the-ember-throne' } } });
	assert.ok(out['avery-quill/the-salt-crown']);
	assert.strictEqual(out['avery-quill/the-ember-throne'].title, 'The Ember Throne');
	assert.ok(out['avery-quill/the-salt-crown'].notes.some((n) => /pinId avery-quill\/the-ember-throne ignored/.test(n)));
});

test('an album include carves that album out of a bucket folder', () => {
	const drama = WITH.works['studio-kiseki/drama-cd-vol-1'];
	assert.ok(drama, 'the drama album is a work');
	assert.strictEqual(drama.detectedBy, 'median-short', 'carved out, its two long tracks (55 min) read as a short drama');
	assert.ok(!Object.values(BASE.works).some((w) => w.parts.some((p) => p.albumRatingKey === '1090')), 'left in the bucket it is music');
	assert.strictEqual(drama.title, 'Drama CD Vol 1', 'a volume number tells volumes apart, so it stays');
	assert.deepStrictEqual(titles(drama), ['Drama Track 1', 'Drama Track 2']);
	assert.ok(WITH.index.albumKeys.includes('1090'));
	assert.ok(!WITH.index.albumKeys.includes('1091'), 'the rest of the bucket stays music');
	assert.ok(!WITH.rejected.some((r) => r.folderKey === 'M:/Music/music-uploads'), 'what is left of the bucket is not long');
});

test('podcastArtists adds an artist the detector did not find', () => {
	assert.ok(WITH.index.artistKeys.includes('9011'));
	assert.ok(!BASE.index.artistKeys.includes('9011'));
});

test('a folder include matches whatever slashes and case it was typed with', () => {
	const out = buildCatalog({ ...library(), overrides: { include: ['m:\\music\\THEO BRAMBLE\\well\\'] } });
	const special = Object.values(out.works).find((w) => w.folderKey === 'M:/Music/Theo Bramble/well');
	assert.ok(special, 'the special became a work');
	assert.strictEqual(special.detectedBy, 'override');
	assert.ok(!out.rejected.some((r) => r.folderKey === 'M:/Music/Theo Bramble/well'));
});

test('an album exclude keeps every track of that album out', () => {
	const out = buildCatalog({ ...library(), overrides: { exclude: ['1050'] } });
	assert.strictEqual(out.works['lantern-hollow/the-tin-valley'], undefined);
	assert.ok(!out.index.artistKeys.includes('9006'));
});

test('overrides for a work that was not detected are reported, and malformed overrides read as none', () => {
	const out = buildCatalog({ ...library(), overrides: { works: { 'nobody/nothing': { sequence: 1 } } } });
	assert.deepStrictEqual(out.notes, ['overrides name a work that was not detected: nobody/nothing']);
	for (const bad of ['text', [1, 2], null, { works: [], include: 'x', authors: 3 }]) {
		const r = buildCatalog({ ...library(), overrides: bad });
		assert.deepStrictEqual(Object.keys(r.works), Object.keys(BASE.works));
	}
});

test('an author named like an Object prototype member is not an override', () => {
	const works = { 'a/b': { id: 'a/b', author: 'Constructor', title: 'B', series: null, sequence: null, parts: [] } };
	const out = applyOverrides(works, { authors: {} });
	assert.strictEqual(out['a/b'].series, null);
});

test('a work whose title changed keeps its old id as an alias, found by ratingKey', () => {
	const lib = library();
	for (const t of lib.tracks) {
		const p = t.Media[0].Part[0];
		p.file = p.file.replace('/1.The Ember Throne/The Ember Throne ', '/1.Ember Throne/Ember Throne ');
	}
	const next = buildCatalog(lib);
	assert.ok(next.works['avery-quill/ember-throne']);
	const { works, moved } = matchAliases(BASE.works, next.works);
	assert.deepStrictEqual(moved, { 'avery-quill/the-ember-throne': 'avery-quill/ember-throne' });
	assert.deepStrictEqual(works['avery-quill/ember-throne'].aliases, ['avery-quill/the-ember-throne']);
});

test('a re-imported work with new ratingKeys is found by basename and size', () => {
	const lib = library();
	const album = lib.albums.find((a) => a.ratingKey === '1040');
	album.title = 'The Hollow King: Complete';
	for (const t of lib.tracks) if (t.parentRatingKey === '1040') t.ratingKey = `9${t.ratingKey}`;
	const next = buildCatalog(lib);
	const { works, moved } = matchAliases(BASE.works, next.works);
	assert.deepStrictEqual(moved, { 'r-j-ashdown/the-hollow-king': 'r-j-ashdown/the-hollow-king-complete' });
	assert.deepStrictEqual(works['r-j-ashdown/the-hollow-king-complete'].aliases, ['r-j-ashdown/the-hollow-king']);
});

test('a renamed narration is matched to itself, not to its twin with the same basenames', () => {
	const lib = library();
	for (const t of lib.tracks) {
		const p = t.Media[0].Part[0];
		if (p.file.includes('(Penrose) 540mb')) {
			p.file = p.file.replace('(Penrose) 540mb', '(D. Penrose) 540mb');
			t.ratingKey = `8${t.ratingKey}`;
		}
	}
	const next = buildCatalog(lib);
	const { moved } = matchAliases(BASE.works, next.works);
	assert.deepStrictEqual(moved, { 'ilse-moreau/the-far-shore~penrose': 'ilse-moreau/the-far-shore~d-penrose' });
});

test('a tie between two equally likely new works matches nothing', () => {
	const part = (file) => ({ trackRatingKey: file, file, sizeBytes: null });
	const old = { 'a/old': { id: 'a/old', parts: [part('01.mp3'), part('02.mp3')] } };
	const next = {
		'a/one': { id: 'a/one', parts: [{ ...part('01.mp3'), trackRatingKey: 'x1' }, { ...part('02.mp3'), trackRatingKey: 'x2' }] },
		'a/two': { id: 'a/two', parts: [{ ...part('01.mp3'), trackRatingKey: 'y1' }, { ...part('02.mp3'), trackRatingKey: 'y2' }] },
	};
	const { works, moved } = matchAliases(old, next);
	assert.deepStrictEqual(moved, {});
	assert.deepStrictEqual(works['a/one'].aliases, []);
	assert.deepStrictEqual(works['a/two'].aliases, []);
});

test('aliases carry over between rebuilds and never name a live work', () => {
	const old = {
		'a/x': { id: 'a/x', aliases: ['a/older', 'a/y'], parts: [{ trackRatingKey: '1', file: '1.mp3' }] },
		'a/y': { id: 'a/y', aliases: [], parts: [{ trackRatingKey: '2', file: '2.mp3' }] },
	};
	const next = {
		'a/x': { id: 'a/x', aliases: [], parts: [{ trackRatingKey: '1', file: '1.mp3' }] },
		'a/y': { id: 'a/y', aliases: [], parts: [{ trackRatingKey: '2', file: '2.mp3' }] },
	};
	const { works, moved } = matchAliases(old, next);
	assert.deepStrictEqual(works['a/x'].aliases, ['a/older']);
	assert.deepStrictEqual(moved, {});
});

test('buildIndex reads part ids from part keys and ignores a key it cannot parse', () => {
	const works = { 'a/b': { id: 'a/b', kind: 'book', parts: [
		{ trackRatingKey: '1', partKey: '/library/parts/77/1700000000/a.mp3' },
		{ trackRatingKey: '2', partKey: null },
	] } };
	const index = buildIndex(works, { tracks: [
		{ ratingKey: '1', parentRatingKey: '10', grandparentRatingKey: '100' },
		{ ratingKey: '2', parentRatingKey: '10', grandparentRatingKey: '100' },
	] });
	assert.deepStrictEqual(index, { trackKeys: ['1', '2'], albumKeys: ['10'], artistKeys: ['100'], partIds: ['77'] });
});

test('folderKey reads backslash paths the same as slash paths', () => {
	const t = (file) => ({ parentRatingKey: '1', Media: [{ Part: [{ file }] }] });
	assert.strictEqual(
		bookCatalog.folderKey(t('M:\\Music\\Avery Quill\\1.The Ember Throne\\The Ember Throne 2\\03.mp3')),
		bookCatalog.folderKey(t('M:/Music/Avery Quill/1.The Ember Throne/The Ember Throne 2/03.mp3')),
	);
	assert.strictEqual(bookCatalog.folderKey(t('M:/Music/Avery Quill/1.The Ember Throne/The Ember Throne 2/03.mp3')), 'M:/Music/Avery Quill/1.The Ember Throne');
});

// The read-along looks for sidecar EPUBs beside the audio files, which neither part.file (a
// basename) nor folderKey (a grouping key, here the book folder ABOVE the part folders) names.
test('a work records the real folders its part files sit in', () => {
	assert.deepStrictEqual(BASE.works['avery-quill/the-ember-throne'].dirs, [
		'M:/Music/Avery Quill/1.The Ember Throne/The Ember Throne 1',
		'M:/Music/Avery Quill/1.The Ember Throne/The Ember Throne 2',
	]);
	assert.strictEqual(BASE.works['avery-quill/the-ember-throne'].folderKey, 'M:/Music/Avery Quill/1.The Ember Throne');
	assert.deepStrictEqual(BASE.works['corin-vale/the-long-tide'].dirs, [
		'M:/Music/Corin Vale/The Long Tide [01]', 'M:/Music/Corin Vale/The Long Tide [02]', 'M:/Music/Corin Vale/The Long Tide [03]',
	]);
	for (const w of Object.values(BASE.works)) {
		assert.ok(w.dirs.length > 0, w.id);
		for (const d of w.dirs) assert.ok(!/\.(mp3|m4a|m4b|flac)$/i.test(d), `${w.id}: ${d}`);
	}
});

test('folders keep the path as Plex wrote it: a POSIX path keeps its leading slash, a Windows one its backslashes', () => {
	const lib = library();
	for (const t of lib.tracks) {
		const part = t.Media[0].Part[0];
		part.file = part.file.startsWith('M:/Music/Corin Vale/')
			? part.file.replace('M:/Music/', 'M:\\Music\\').replace(/\//g, '\\')
			: part.file.replace(/^M:\/Music\//, '/srv/media/Music/');
	}
	const built = buildCatalog(lib).works;
	assert.deepStrictEqual(built['avery-quill/the-iron-wake'].dirs, ['/srv/media/Music/Avery Quill/4.The Iron Wake']);
	assert.deepStrictEqual(built['corin-vale/the-long-tide'].dirs, [
		'M:\\Music\\Corin Vale\\The Long Tide [01]', 'M:\\Music\\Corin Vale\\The Long Tide [02]', 'M:\\Music\\Corin Vale\\The Long Tide [03]',
	]);
	const root = buildCatalog({ ...library(), tracks: library().tracks.map((t) => {
		t.Media[0].Part[0].file = `/${t.Media[0].Part[0].file.split('/').pop()}`;
		return t;
	}) }).works;
	assert.ok(Object.keys(root).length > 0);
	for (const w of Object.values(root)) assert.deepStrictEqual(w.dirs, ['/'], w.id);
});

test('the publisher is kept apart from the edition, so a narrated GraphicAudio edition stays recognisable', () => {
	const bells = BASE.works['avery-quill/the-copper-bells'];
	assert.deepStrictEqual([bells.edition, bells.narrator, bells.publisher], ['GraphicAudio', null, 'GraphicAudio'], 'the album names a cut-off cast, so no single narrator and no edition name');
	assert.strictEqual(BASE.works['corin-vale/the-long-tide'].publisher, 'GraphicAudio');
	assert.strictEqual(BASE.works['avery-quill/the-ember-throne'].publisher, null);
	assert.strictEqual(BASE.works['r-j-ashdown/the-hollow-king'].publisher, null);
});

// ---- rules version 3 ----

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
		Media: [{ id: Number(rk), duration: ms, bitrate: 128, audioChannels: 2, container, Part: [{ id: Number(rk), key: `/library/parts/${rk}/1700000000/${name}`, duration: ms, file, size: 1000000 + Number(rk), container }] }],
		...extra,
	};
}

// The headline bug, invented: a loose GraphicAudio book file in the library root, and eleven
// tracks of a rap album in a stray "Disc 2" folder beside it.
function strayDisc() {
	const book = album(3002, 'The Rust Ledger 1: Cold Iron', 'Graphic Audio LLC.');
	const rap = album(3001, 'Night Shift + Instrumentals', 'Kid Ferro');
	const tracks = [track(30020, book, 'N:/Media/Music/Cold_Iron_GraphicAudio.m4b', 150)];
	for (let i = 1; i <= 11; i++) tracks.push(track(30100 + i, rap, `N:/Media/Music/Disc 2/${String(i).padStart(2, '0')} Night Shift.mp3`, 3, { parentIndex: 2, index: i }));
	return { albums: [book, rap], tracks };
}

function keysOf(groups) {
	return [...groups.keys()].sort();
}

function noPaths(value) {
	return !/[A-Za-z]:[\\/]|\\/.test(JSON.stringify(value));
}

test('a stray disc folder under the library root stays apart from a loose book file there, even with no tags', () => {
	const out = buildCatalog({ ...strayDisc(), roots: ROOTS });
	assert.deepStrictEqual(Object.keys(out.works), ['graphic-audio/cold-iron'], 'with no author found, the house the artist field names stands in');
	const w = out.works['graphic-audio/cold-iron'];
	assert.deepStrictEqual(w.parts.map((p) => p.trackRatingKey), ['30020']);
	assert.strictEqual(w.title, 'Cold Iron', 'a library root is never a title');
	assert.deepStrictEqual([w.series, w.sequence, w.publisher], ['The Rust Ledger', 1, 'GraphicAudio']);
	assert.deepStrictEqual(w.doubts, [{ code: 'no-author' }]);
	for (let i = 1; i <= 11; i++) assert.ok(!out.index.trackKeys.includes(String(30100 + i)));
});

test('embedded tags give a publisher-filed book its author from the copyright line', () => {
	const out = buildCatalog({ ...strayDisc(), roots: ROOTS, tags: TAGS });
	const w = out.works['wren-halloway/cold-iron'];
	assert.ok(w, Object.keys(out.works).join());
	assert.strictEqual(w.author, 'Wren Halloway');
	assert.strictEqual(w.authorSource, 'copyright');
	assert.strictEqual(w.detectedBy, 'median');
	assert.strictEqual(w.confidence, 'high');
	assert.deepStrictEqual(w.doubts, []);
	assert.deepStrictEqual(w.detected.sources, { title: 'album', author: 'tag', narrator: null, edition: 'plex-artist', publisher: 'plex-artist', series: 'album', sequence: 'album' });
});

test('a disc folder folds into a book folder but never into a library root or another album\'s folder', () => {
	const a = album(3101, 'Loose Ends', 'Kid Ferro');
	const b = album(3102, 'Second Wind', 'Kid Ferro');
	const strays = [track(31011, a, 'N:/Media/Music/Disc 1/01 Loose.mp3', 3), track(31021, b, 'N:/Media/Music/Disc 2/01 Wind.mp3', 3)];
	assert.deepStrictEqual(keysOf(bookCatalog.groupTracks(strays)), ['N:/Media/Music'], 'without the roots the two strays would merge');
	assert.deepStrictEqual(keysOf(bookCatalog.groupTracks(strays, { roots: ROOTS })), ['N:/Media/Music/Disc 1', 'N:/Media/Music/Disc 2']);

	const tides = album(3103, 'Grey Tides', 'Wren Halloway');
	const sun = album(3104, 'Low Sun', 'Wren Halloway');
	const other = album(3105, 'Odd Lot', 'Ida Marsh');
	const book = [
		track(31031, tides, 'N:/Media/Music/Wren Halloway/Grey Tides/Disc 1/01.mp3', 40),
		track(31032, tides, 'N:/Media/Music/Wren Halloway/Grey Tides/Disc 2/01.mp3', 40),
		track(31041, sun, 'N:/Media/Music/Wren Halloway/Low Sun/01.mp3', 40),
		track(31042, sun, 'N:/Media/Music/Wren Halloway/Low Sun/Disc 2/01.mp3', 40),
		track(31051, other, 'N:/Media/Music/Wren Halloway/Low Sun/Disc 3/01.mp3', 40),
	];
	assert.deepStrictEqual(keysOf(bookCatalog.groupTracks(book, { roots: ROOTS })), [
		'N:/Media/Music/Wren Halloway/Grey Tides',
		'N:/Media/Music/Wren Halloway/Low Sun',
		'N:/Media/Music/Wren Halloway/Low Sun/Disc 3',
	]);
});

test('a music genre vetoes every length rule, so a 3 h mix album stays music', () => {
	const mix = (genres) => {
		const a = album(3201, 'Deep Focus', 'Sam Drift', genres);
		return { albums: [a], tracks: [1, 2, 3].map((i) => track(32010 + i, a, `N:/Media/Music/Sam Drift/Deep Focus/0${i} Focus.mp3`, 60, { index: i })) };
	};
	assert.ok(buildCatalog({ ...mix([]), roots: ROOTS }).works['sam-drift/deep-focus'], 'without a genre the hour-long tracks read as a book');
	const out = buildCatalog({ ...mix(['Electronic']), roots: ROOTS });
	assert.deepStrictEqual(Object.keys(out.works), []);
	assert.deepStrictEqual(out.rejected.map((r) => [r.folderKey, r.reason]), [['N:/Media/Music/Sam Drift/Deep Focus', 'music genre']]);
});

test('genres class an album as book, music or neither, and a book genre wins inside one tag', () => {
	assert.strictEqual(bookCatalog.genreClass(['Audiobook - Sci Fi - Wren Halloway']), 'book');
	assert.strictEqual(bookCatalog.genreClass(['Rock', 'Audio Book']), 'book');
	assert.strictEqual(bookCatalog.genreClass(['Podcast']), 'book');
	assert.strictEqual(bookCatalog.genreClass(['Hip-Hop/Rap']), 'music');
	assert.strictEqual(bookCatalog.genreClass(['Fantasy']), null);
	assert.strictEqual(bookCatalog.genreClass(['Comedy', 'Spoken Word']), null);
	assert.strictEqual(bookCatalog.genreClass([]), null);
});

test('tags in the fixture move detection only where a genre says so, and never membership', () => {
	const out = buildCatalog({ ...library(), tags: TAGS });
	assert.strictEqual(out.works['r-j-ashdown/the-hollow-king'].detectedBy, 'genre', 'an audiobook genre over half the tracks is the genre rule');
	assert.strictEqual(out.works['r-j-ashdown/the-hollow-king'].confidence, 'medium');
	assert.deepStrictEqual(out.rejected.map((r) => [r.folderKey, r.reason]), [
		['M:/Music/Sam Drift/[Unknown Album]', 'music genre'],
		['M:/Music/Theo Bramble/well', 'under 2 h'],
		['M:/Music/music-uploads', 'no long-form signal'],
	]);
	const road = out.works['avery-quill/the-glass-road'];
	assert.deepStrictEqual([road.author, road.authorSource], ['Avery Quill', 'copyright'], 'the copyright line names the author the folder only implied');
	assert.deepStrictEqual(Object.keys(out.works), Object.keys(BASE.works), 'tags never change an id here');
	assert.deepStrictEqual(out.index, BASE.index);
});

test('a music album is split off a book folder and recorded, and the book says so', () => {
	const book = album(3301, 'Grey Tides', 'Wren Halloway', ['Audiobook']);
	const rap = album(3302, 'Night Shift', 'Kid Ferro', ['Rap']);
	const tracks = [];
	for (let i = 1; i <= 6; i++) tracks.push(track(33010 + i, book, `N:/Media/Music/Mixed Bag/Grey Tides 0${i}.mp3`, 40, { index: i }));
	for (let i = 1; i <= 5; i++) tracks.push(track(33020 + i, rap, `N:/Media/Music/Mixed Bag/Night Shift 0${i}.mp3`, 4, { index: i }));
	const out = buildCatalog({ albums: [book, rap], tracks, roots: ROOTS });
	assert.deepStrictEqual(out.splits, [{ folderKey: 'N:/Media/Music/Mixed Bag', album: '3302', albumTitle: 'Night Shift', tracks: 5, reason: 'music-genre' }]);
	const w = out.works['wren-halloway/grey-tides'];
	assert.strictEqual(w.parts.length, 6);
	assert.deepStrictEqual(w.doubts, [{ code: 'split', albums: ['Night Shift'] }]);
	for (let i = 1; i <= 5; i++) assert.ok(!out.index.trackKeys.includes(String(33020 + i)));
});

test('a group that stays music is never split, even when one of its albums has no genre', () => {
	const rap = album(3401, 'Night Shift', 'Kid Ferro', ['Rap']);
	const bare = album(3402, 'Loose Ends', 'Kid Ferro');
	const tracks = [
		...[1, 2, 3].map((i) => track(34010 + i, rap, `N:/Media/Music/Kid Ferro/Night Shift 0${i}.mp3`, 60, { index: i })),
		...[1, 2, 3].map((i) => track(34020 + i, bare, `N:/Media/Music/Kid Ferro/Loose Ends 0${i}.mp3`, 60, { index: i })),
	];
	const out = buildCatalog({ albums: [rap, bare], tracks, roots: ROOTS });
	assert.deepStrictEqual(out.splits, []);
	assert.deepStrictEqual(Object.keys(out.works), []);
	assert.deepStrictEqual(out.rejected.map((r) => r.reason), ['music genre']);
});

test('parseSeriesTitle reads the five series shapes and leaves a subtitle alone', () => {
	const read = (s) => { const r = bookCatalog.parseSeriesTitle(s); return [r.series, r.sequence, r.title, r.part, r.weak]; };
	assert.deepStrictEqual(read('The Rust Ledger 1: Cold Iron'), ['The Rust Ledger', 1, 'Cold Iron', null, false]);
	assert.deepStrictEqual(read('The Rust Ledger [02] Grey Tides [01]'), ['The Rust Ledger', 2, 'Grey Tides', 1, false]);
	assert.deepStrictEqual(read('The Rust Ledger 4 - Low Sun (2 of 6)'), ['The Rust Ledger', 4, 'Low Sun', 2, false]);
	assert.deepStrictEqual(read('Ashfall, Book 2 - The Salt Crown'), ['Ashfall', 2, 'The Salt Crown', null, false]);
	assert.deepStrictEqual(read('Ashfall #3: The Last Lantern'), ['Ashfall', 3, 'The Last Lantern', null, false]);
	assert.deepStrictEqual(read('Cold Iron (1 of 5)'), [null, null, 'Cold Iron', 1, false]);
	assert.deepStrictEqual(read('Salt and Stone: A Brief History'), ['Salt and Stone', null, 'A Brief History', null, true]);
});

test('a numberless "Series: Title" names a series only when something backs it', () => {
	const ledger = album(3501, 'The Rust Ledger 1: Cold Iron', 'Wren Halloway');
	const interlude = album(3502, 'The Rust Ledger: Interlude', 'Wren Halloway');
	const history = album(3503, 'Salt and Stone: A Brief History', 'Ida Marsh');
	const two = (rk, alb, dir) => [1, 2].map((i) => track(rk + i, alb, `N:/Media/Music/${dir}/0${i}.mp3`, 70, { index: i }));
	const out = buildCatalog({
		albums: [ledger, interlude, history],
		tracks: [...two(35010, ledger, 'Wren Halloway/Cold Iron'), ...two(35020, interlude, 'Wren Halloway/The Rust Ledger [0.5] Interlude'), ...two(35030, history, 'Ida Marsh/Salt and Stone')],
		roots: ROOTS,
	});
	const pick = (id) => { const w = out.works[id]; return w && [w.title, w.series, w.sequence]; };
	assert.deepStrictEqual(pick('wren-halloway/cold-iron'), ['Cold Iron', 'The Rust Ledger', 1]);
	assert.deepStrictEqual(pick('wren-halloway/interlude'), ['Interlude', 'The Rust Ledger', 0.5]);
	assert.deepStrictEqual(pick('ida-marsh/salt-and-stone-a-brief-history'), ['Salt and Stone: A Brief History', null, null]);
});

test('a person is read out of a copyright line and a company is not', () => {
	assert.strictEqual(bookCatalog.authorFromCopyright('(c) 2018 Wren Halloway'), 'Wren Halloway');
	assert.strictEqual(bookCatalog.authorFromCopyright('Copyright 2016-2018 by Ida Marsh. All rights reserved.'), 'Ida Marsh');
	assert.strictEqual(bookCatalog.authorFromCopyright('Copyright 2017 Rustworks Entertainment, LLC'), null);
	assert.strictEqual(bookCatalog.authorFromCopyright('(P) 2018 GraphicAudio'), null);
	assert.strictEqual(bookCatalog.authorFromCopyright(''), null);
	assert.strictEqual(bookCatalog.authorFromComment('An epic tale.\nWritten by Ida Marsh. Performed by a cast.'), 'Ida Marsh');
});

test('publisherOf knows a house under any suffix, and a publisher is never the author', () => {
	assert.strictEqual(bookCatalog.publisherOf('Graphic Audio LLC.'), 'GraphicAudio');
	assert.strictEqual(bookCatalog.publisherOf('Grahpic Audio, LLC'), 'GraphicAudio');
	assert.strictEqual(bookCatalog.publisherOf('GraphicAudio'), 'GraphicAudio');
	assert.strictEqual(bookCatalog.publisherOf('Brilliance Audio'), 'Brilliance Audio');
	assert.strictEqual(bookCatalog.publisherOf('Wren Halloway'), null);
	assert.deepStrictEqual(bookCatalog.splitArtist('Graphic Audio LLC. [Wren Halloway]'), { author: 'Wren Halloway', publisher: 'GraphicAudio' });
	assert.deepStrictEqual(bookCatalog.splitArtist('Graphic Audio LLC.'), { author: null, publisher: 'GraphicAudio' });
});

test('smartTitle fixes folder capitalisation and leaves acronyms, numerals and mixed case alone', () => {
	const cases = [
		['Songs Of The Deep', 'Songs of the Deep'],
		['the iron wake', 'The Iron Wake'],
		['NASA And The Moon', 'NASA and the Moon'],
		['Book II Of The Saga', 'Book II of the Saga'],
		['The McCoy Files', 'The McCoy Files'],
		['Ledger: Of Ice And Fire', 'Ledger: Of Ice and Fire'],
		['WHAT IS LEFT', 'WHAT IS LEFT'],
		['Room 101 Of Fear', 'Room 101 of Fear'],
		['What Dreams Are Made Of', 'What Dreams Are Made Of'],
	];
	for (const [raw, want] of cases) assert.strictEqual(bookCatalog.smartTitle(raw), want, raw);
});

test('an apostrophe comes back only when a part spells the word with it beside the same neighbour', () => {
	assert.strictEqual(bookCatalog.restoreApostrophes('The Childrens Road', ['01 Childrens', "Children's Road - Part 1.mp3"]), "The Children's Road");
	assert.strictEqual(bookCatalog.restoreApostrophes('The Way of Kings', ["The King's Road", 'Kings Road']), 'The Way of Kings');
	assert.strictEqual(bookCatalog.restoreApostrophes('The Wardens Oath', ['Chapter 1']), 'The Wardens Oath');
});

test('title fixes never change a slug, so they never change an id', () => {
	const evidence = ["Children's Road - Part 1", "Warden's Oath"];
	for (const raw of ['The Childrens Road', 'Songs Of The Deep', 'the iron wake', 'NASA And The Moon', 'The Wardens Oath', 'Ledger: Of Ice And Fire', 'WHAT IS LEFT']) {
		assert.strictEqual(bookCatalog.slug(bookCatalog.smartTitle(bookCatalog.restoreApostrophes(raw, evidence))), bookCatalog.slug(raw), raw);
	}
});

test('a publisher learned from tags never changes a collision suffix', () => {
	const a = album(3601, 'Cold Iron', 'Wren Halloway');
	const b = album(3602, 'Cold Iron', 'Wren Halloway');
	const two = (rk, alb, dir) => [1, 2].map((i) => track(rk + i, alb, `N:/Media/Music/${dir}/0${i}.mp3`, 70, { index: i }));
	const lib = () => ({ albums: [a, b], tracks: [...two(36010, a, 'Wren Halloway/Cold Iron'), ...two(36020, b, 'Archive/Wren Halloway/Cold Iron')], roots: ROOTS });
	const plain = buildCatalog(lib());
	const tagged = buildCatalog({ ...lib(), tags: { 3602: { tags: { album_artist: 'GraphicAudio' } } } });
	const ids = [
		'wren-halloway/cold-iron~n-media-music-archive-wren-halloway-cold-iron',
		'wren-halloway/cold-iron~n-media-music-wren-halloway-cold-iron',
	];
	assert.deepStrictEqual(Object.keys(plain.works).sort(), ids);
	assert.deepStrictEqual(Object.keys(tagged.works).sort(), ids);
	const archived = tagged.works[ids[0]];
	assert.deepStrictEqual([archived.publisher, archived.edition, archived.narrator], ['GraphicAudio', 'GraphicAudio', null], 'the display edition may use the tag publisher');
});

test('a cast list cut short is no single narrator nor an edition, and the ids stay as they were', () => {
	for (const w of Object.values(BASE.works).filter((x) => x.series === 'Ashfall')) {
		assert.strictEqual(w.narrator, null, w.id);
		assert.notStrictEqual(w.edition, 'Mara Lindqvist', w.id);
	}
	assert.deepStrictEqual(Object.keys(BASE.works).sort(), Object.keys(CATALOG.works).sort());
	const ellipsis = String.fromCharCode(0x2026);
	const a = album(3701, `Grey Tides (Ida Marsh,${ellipsis})`, 'Wren Halloway');
	const out = buildCatalog({ albums: [a], tracks: [1, 2].map((i) => track(37010 + i, a, `N:/Media/Music/Wren Halloway/Grey Tides/0${i}.mp3`, 70, { index: i })), roots: ROOTS });
	assert.strictEqual(out.works['wren-halloway/grey-tides'].narrator, null);
});

test('a narrator tag is used only for one person and only when no folder or album names one', () => {
	const a = album(3801, 'Low Sun', 'Wren Halloway');
	const lib = () => ({ albums: [a], tracks: [1, 2].map((i) => track(38010 + i, a, `N:/Media/Music/Wren Halloway/Low Sun/0${i}.mp3`, 70, { index: i })), roots: ROOTS });
	const narratorWith = (tags) => {
		const w = buildCatalog({ ...lib(), tags: { 3801: { tags } } }).works['wren-halloway/low-sun'];
		return [w.narrator, w.detected.sources.narrator];
	};
	assert.deepStrictEqual(narratorWith({ narrator: 'Ida Marsh' }), ['Ida Marsh', 'tag']);
	assert.deepStrictEqual(narratorWith({ comment: 'Narrated by: Ida Marsh' }), ['Ida Marsh', 'tag']);
	assert.deepStrictEqual(narratorWith({ narrator: 'Full Cast' }), [null, null]);
	assert.deepStrictEqual(narratorWith({ narrator: 'Ida Marsh, Tom Reed' }), [null, null]);
	assert.deepStrictEqual(narratorWith({ comment: 'Read by Ida Marsh and Tom Reed' }), [null, null]);
});

// Checked on a real library (rules version 4): three single-file books came out narrated by a
// name with its surname twice. Their credits comment spells the name that way in both places it
// appears, so the parser is right to keep it; it neither doubles a word nor drops a repeated one.
test('a credits comment gives its narrator exactly as written, repeated words and all', () => {
	const credits = 'Written by Wren Halloway - Performed by Narrated by Kit Moss Moss. Featuring Kit Moss Moss as the Warden and Ida Mar';
	assert.strictEqual(bookCatalog.narratorFromComment(credits), 'Kit Moss Moss');
	assert.strictEqual(bookCatalog.authorFromComment(credits), 'Wren Halloway');
	assert.strictEqual(bookCatalog.narratorFromComment('Written by Wren Halloway - Performed by Narrated by Kit Moss. Featuring Kit Moss as the Warden'), 'Kit Moss');
	assert.strictEqual(bookCatalog.narratorFromComment('See the publisher for cast and production credits.'), null);
});

test('doubts are structured, name no folder path, and never hold a work back', () => {
	const one = album(3901, 'Book One', 'Ida Marsh');
	const two = album(3902, 'Book Two', 'Tom Reed');
	const out = buildCatalog({
		albums: [one, two],
		tracks: [track(39011, one, 'N:/Media/Music/Book One.m4b', 150), track(39021, two, 'N:/Media/Music/Book Two.m4b', 150)],
		roots: ROOTS,
	});
	const works = Object.values(out.works);
	assert.strictEqual(works.length, 1, 'catalogued anyway');
	assert.notStrictEqual(works[0].title, 'Music');
	assert.deepStrictEqual(works[0].doubts, [
		{ code: 'mixed-artists', artists: [{ name: 'Ida Marsh', tracks: 1 }, { name: 'Tom Reed', tracks: 1 }] },
		{ code: 'generic-folder', folder: 'Music', albums: 2 },
	]);
	assert.ok(noPaths(works[0].doubts));
	for (const w of Object.values(BASE.works)) assert.ok(noPaths(w.doubts), w.id);
});

test('detected keeps what detection found, under an override and an author-level series', () => {
	const out = buildCatalog({
		...strayDisc(),
		roots: ROOTS,
		tags: TAGS,
		overrides: {
			works: { 'wren-halloway/cold-iron': { title: 'Cold Iron (Full Cast)' } },
			authors: { 'wren-halloway': { series: 'Ledger Cycle', order: { 'Cold Iron': 1 } } },
		},
	});
	const w = out.works['wren-halloway/cold-iron'];
	assert.ok(w, 'neither override changes the id');
	assert.deepStrictEqual([w.title, w.series, w.sequence], ['Cold Iron (Full Cast)', 'Ledger Cycle', 1]);
	assert.deepStrictEqual(w.detected, {
		title: 'Cold Iron', author: 'Wren Halloway', narrator: null, edition: 'GraphicAudio', publisher: 'GraphicAudio',
		series: 'The Rust Ledger', sequence: 1,
		sources: { title: 'album', author: 'tag', narrator: null, edition: 'plex-artist', publisher: 'plex-artist', series: 'album', sequence: 'album' },
	});
});

test('a work that held one long book file and eleven songs hands its id to the book', () => {
	const lib = strayDisc();
	const durationOf = new Map(lib.tracks.map((t) => [t.ratingKey, t.duration]));
	const oldParts = lib.tracks.map((t, i) => ({ ordinal: i + 1, trackRatingKey: t.ratingKey, file: t.Media[0].Part[0].file.split('/').pop(), sizeBytes: t.Media[0].Part[0].size, durationMs: durationOf.get(t.ratingKey) }));
	const old = { 'kid-ferro/music': { id: 'kid-ferro/music', aliases: [], parts: oldParts } };
	const next = buildCatalog({ ...lib, roots: ROOTS, tags: TAGS }).works;
	const { works, moved } = matchAliases(old, next);
	assert.deepStrictEqual(moved, { 'kid-ferro/music': 'wren-halloway/cold-iron' });
	assert.deepStrictEqual(works['wren-halloway/cold-iron'].aliases, ['kid-ferro/music']);

	const countOnly = { 'kid-ferro/music': { ...old['kid-ferro/music'], parts: oldParts.map(({ durationMs, ...p }) => p) } };
	assert.deepStrictEqual(matchAliases(countOnly, next).moved, {}, 'one part in twelve is not enough by count alone');
});

test('tag samples are one file per album, only from groups long enough to be a book', () => {
	const lib = strayDisc();
	const sample = album(3003, 'Grey Tides', 'Wren Halloway');
	lib.albums.push(sample);
	lib.tracks.push(
		track(30031, sample, 'N:/Media/Music/Wren Halloway/Grey Tides/Sample.mp3', 2, { title: 'Sample', index: 1 }),
		track(30032, sample, 'N:/Media/Music/Wren Halloway/Grey Tides/02.m4b', 70, { index: 2 }),
		track(30033, sample, 'N:/Media/Music/Wren Halloway/Grey Tides/03.m4b', 70, { index: 3 }),
	);
	assert.deepStrictEqual(bookCatalog.tagSamples(lib.tracks, { roots: ROOTS }), [
		{ album: '3002', track: '30020', file: 'N:/Media/Music/Cold_Iron_GraphicAudio.m4b', sizeBytes: 1030020 },
		{ album: '3003', track: '30032', file: 'N:/Media/Music/Wren Halloway/Grey Tides/02.m4b', sizeBytes: 1030032 },
		{ track: '30033', file: 'N:/Media/Music/Wren Halloway/Grey Tides/03.m4b', sizeBytes: 1030033 },
	], 'two long m4b files could be two books, so the one the album sample missed is read for itself');
	const mp3s = lib.tracks.map((t) => (t.ratingKey === '30032' || t.ratingKey === '30033' ? track(t.ratingKey, sample, t.Media[0].Part[0].file.replace('.m4b', '.mp3'), 70, { index: t.index }) : t));
	assert.deepStrictEqual(bookCatalog.tagSamples(mp3s, { roots: ROOTS }).map((s) => s.track), ['30020', '30032', '30033'], 'long mp3 files are read one by one too: a collection of plays tags each file with its play');
	assert.deepStrictEqual(bookCatalog.tagSamples([]), []);
});

test('the rules version is 5', () => {
	assert.strictEqual(bookCatalog.RULES_VERSION, 5);
});

// The bug (review): the music genre pattern matched words inside book genres ("Space Opera",
// "Folk Tales", "Haunted House"), and the veto dropped those books; "Partials" and "Volition"
// read as "Part ..." and "Vol ..." folder names; and an exclude, partOrder or pinId keyed by the
// id an older rule gave a work stopped applying once a rule change moved the id.

function crown(genres, artist = 'Avery Quill') {
	const a = album(3601, 'The Salt Crown', artist, genres);
	const tracks = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => track(36010 + i, a, `N:/Media/Music/Avery Quill/The Salt Crown/0${i}.mp3`, 40, { index: i }));
	return { albums: [a], tracks, roots: ROOTS };
}

test('a book genre that only shares a word with a music genre never vetoes the book', () => {
	for (const g of ['Space Opera', 'Science Fiction & Fantasy/Science Fiction/Space Opera', 'Fairy Tales, Folk Tales & Myths', 'Alternative & Complementary Medicine', 'Classical Studies', 'Latin American', 'Country Life', 'Haunted House', 'Mind, Body & Soul']) {
		assert.strictEqual(bookCatalog.genreClass([g]), null, g);
		assert.deepStrictEqual(Object.keys(buildCatalog(crown([g])).works), ['avery-quill/the-salt-crown'], g);
	}
	for (const g of ['Rap', 'Electronic', 'Hip-Hop', 'Pop/Rock', 'Alternative Rock', 'Death Metal', 'Psychedelic Folk', 'Electro House', 'Dance-Pop', 'Rhythm And Blues', 'Pop Punk; Pop Rock', 'Electronic/Trance/Dance/Jazz', 'Rock Music']) {
		assert.strictEqual(bookCatalog.genreClass([g]), 'music', g);
	}
	assert.deepStrictEqual(buildCatalog(crown(['Rock'])).rejected.map((r) => r.reason), ['music genre']);
});

test('a one-word title that starts like Part, Vol, Disc or Side is not a folder name', () => {
	for (const name of ['Partials', 'Partisans', 'Volition', 'Volcano', 'Discworld', 'Sidekick', 'Cdx']) assert.strictEqual(bookCatalog.isGenericName(name), false, name);
	for (const name of ['Disc 2', 'CD1', 'Part B', 'Vol IV', 'Volume 3', 'Side A', 'Disk', 'Part']) assert.strictEqual(bookCatalog.isGenericName(name), true, name);
});

function moveCrown(entry) {
	const lib = crown([], 'Avery Quill with Rhea Stone');
	const OLD = 'avery-quill-with-rhea-stone/the-salt-crown';
	const first = buildCatalog(lib).works;
	const detected = first['avery-quill/the-salt-crown'];
	const old = { [OLD]: { ...detected, id: OLD, aliases: [] } };
	const overrides = { works: { [OLD]: entry } };
	const { moved } = matchAliases(old, first);
	const carried = bookCatalog.carryOverrides(overrides, old, first, moved);
	return { lib, OLD, old, overrides, carried, folderKey: detected.folderKey };
}

test('an exclude, partOrder or pinId under the id a work had before follows it to its new id', () => {
	const order = ['08.mp3', '07.mp3', '06.mp3', '05.mp3', '04.mp3', '03.mp3', '02.mp3', '01.mp3'];
	const pin = moveCrown({ partOrder: order, pinId: 'my-pinned-id', title: 'Kept By Alias' });
	assert.deepStrictEqual(pin.carried.carried, [{ from: pin.OLD, to: 'avery-quill/the-salt-crown', fields: ['partOrder', 'pinId'] }]);
	assert.deepStrictEqual(pin.overrides.works, { [pin.OLD]: { partOrder: order, pinId: 'my-pinned-id', title: 'Kept By Alias' } }, "the caller's overrides are not changed");
	const next = buildCatalog({ ...pin.lib, overrides: pin.carried.overrides }).works;
	assert.deepStrictEqual(Object.keys(next), ['my-pinned-id']);
	assert.deepStrictEqual(next['my-pinned-id'].parts.map((p) => p.file).slice(0, 2), ['08.mp3', '07.mp3']);
	assert.ok(!('title' in pin.carried.overrides.works['avery-quill/the-salt-crown']), 'display fields reach the work through its aliases instead');

	// The rebuild after that: the catalog holds the work under its pinned id, the old id an alias.
	const kept = matchAliases(pin.old, next).works;
	const again = buildCatalog(pin.lib).works;
	const round2 = bookCatalog.carryOverrides(pin.overrides, kept, again, matchAliases(kept, again).moved);
	assert.deepStrictEqual(Object.keys(buildCatalog({ ...pin.lib, overrides: round2.overrides }).works), ['my-pinned-id']);

	const gone = moveCrown({ exclude: true });
	assert.deepStrictEqual(Object.keys(buildCatalog({ ...gone.lib, overrides: gone.carried.overrides }).works), []);
	assert.deepStrictEqual(bookCatalog.carryOverrides({ works: { x: { exclude: true } } }, {}, {}, {}).carried, []);
});

test("an exclude that names the work's folder holds whatever id the work is given", () => {
	const lib = crown([], 'Avery Quill with Rhea Stone');
	const fk = buildCatalog(lib).works['avery-quill/the-salt-crown'].folderKey;
	const out = buildCatalog({ ...lib, overrides: { works: { 'untitled/the-salt-crown': { exclude: true, folderKey: fk.replace(/\//g, '\\').toUpperCase() } } } });
	assert.deepStrictEqual(Object.keys(out.works), []);
	assert.ok(!out.index.trackKeys.includes('36011'), 'its tracks go back to music');
	assert.deepStrictEqual(out.notes, [], 'an exclude that held is not reported as undetected');
});

test('openDoubts leaves out a split and any doubt the owner answered with a title or author edit', () => {
	const w = { doubts: [{ code: 'split', albums: ['x'] }, { code: 'generic-title', title: 'Audio' }], sources: { title: 'folder', author: 'plex' } };
	assert.deepStrictEqual(bookCatalog.openDoubts(w), [{ code: 'generic-title', title: 'Audio' }]);
	assert.deepStrictEqual(bookCatalog.openDoubts({ doubts: [{ code: 'split' }] }), []);
	assert.deepStrictEqual(bookCatalog.openDoubts({ ...w, sources: { title: 'override', author: 'plex' } }), []);
	assert.deepStrictEqual(bookCatalog.openDoubts(w, { author: 'Avery Quill' }), []);
	assert.deepStrictEqual(bookCatalog.openDoubts({ doubts: w.doubts, title: 'B', detected: { title: 'A' } }), [], 'a catalog without sources compares against detection');
	assert.deepStrictEqual(bookCatalog.openDoubts(null), []);
});

// ---- rules version 4 ----

// The bug (rules version 4): books #2 to #5 of a series were dropped as loose single-file books
// beside #1 in the library root. Plex filed the four as one album under "Various Artists" with
// #1's album title, and tags were read from one file per album, so all five became one work named
// after #1, by "Various Artists", with a live bookmark under its id.

const LEDGER = [[2, 'Grey Tides', 160], [3, 'Low Sun', 165], [4, 'Salt Road', 170], [5, 'Iron Sea', 490]];

function looseBooks() {
	const first = album(4001, 'The Rust Ledger 1: Cold Iron', 'Graphic Audio LLC.', ['Audiobook']);
	const lumped = album(4002, 'The Rust Ledger 1: Cold Iron', 'Various Artists', ['Audiobook']);
	const tracks = [track(40010, first, 'N:/Media/Music/Cold_Iron_GraphicAudio.m4b', 150, { index: undefined })];
	const tags = { 4001: { tags: { artist: 'Graphic Audio LLC.', album: 'The Rust Ledger 1: Cold Iron', genre: 'Audiobook', copyright: 'Copyright (c) 2017, Wren Halloway. All rights reserved.' } } };
	const trackTags = {};
	for (const [n, title, min] of LEDGER) {
		const name = n === 5 ? `${title} (Dramatized Adaptation)` : title;
		tracks.push(track(40020 + n, lumped, `N:/Media/Music/Wren Halloway - #${n} ${title} (Graphic Audio LLC.).m4b`, min, { title: name, index: n, chapterSource: 'media' }));
		trackTags[40020 + n] = { tags: { title: name, album: name, artist: 'Wren Halloway', composer: 'Graphic Audio LLC.', genre: 'Audiobook', track: String(n) } };
	}
	return { albums: [first, lumped], tracks, roots: ROOTS, tags, trackTags };
}

const LEDGER_WORKS = [
	['wren-halloway/cold-iron', 'Cold Iron', 1, '40010'],
	['wren-halloway/grey-tides', 'Grey Tides', 2, '40022'],
	['wren-halloway/iron-sea', 'Iron Sea', 5, '40025'],
	['wren-halloway/low-sun', 'Low Sun', 3, '40023'],
	['wren-halloway/salt-road', 'Salt Road', 4, '40024'],
];

function rowsOf(works) {
	return Object.values(works).map((w) => [w.id, w.title, w.sequence, w.parts.map((p) => p.trackRatingKey).join()]).sort((a, b) => a[0].localeCompare(b[0]));
}

test('loose single-file books in one folder are one work each, named by their own tags', () => {
	const out = buildCatalog(looseBooks());
	assert.deepStrictEqual(rowsOf(out.works), LEDGER_WORKS);
	for (const w of Object.values(out.works)) {
		assert.deepStrictEqual([w.author, w.series, w.publisher, w.edition, w.narrator, w.kind, w.doubts], ['Wren Halloway', 'The Rust Ledger', 'GraphicAudio', 'GraphicAudio', null, 'book', []], w.id);
		assert.ok(w.notes.includes('one of 5 books in one folder, told apart by their album tags'), w.id);
		assert.ok(noPaths(w.doubts) && noPaths(w.notes));
	}
	const tides = out.works['wren-halloway/grey-tides'];
	assert.deepStrictEqual([tides.detected.sources.title, tides.detected.sources.author, tides.detected.sources.sequence], ['tag', 'tag', 'tag']);
	assert.strictEqual(tides.detected.sources.series, out.works['wren-halloway/cold-iron'].detected.sources.series, 'the series comes from the sibling that names it');
	assert.deepStrictEqual(out.index.trackKeys, ['40010', '40022', '40023', '40024', '40025']);
	assert.deepStrictEqual(out.splits, [], 'a book split is not a music split');
});

test('without a file\'s own tags its "#N Title" file name tells the books apart, and one silent file holds the split back', () => {
	const lib = looseBooks();
	const byName = buildCatalog({ ...lib, trackTags: {} });
	assert.deepStrictEqual(rowsOf(byName.works), LEDGER_WORKS);
	const tides = byName.works['wren-halloway/grey-tides'];
	assert.deepStrictEqual([tides.author, tides.series, tides.publisher, tides.detected.sources.title, tides.detected.sources.author], ['Wren Halloway', 'The Rust Ledger', 'GraphicAudio', 'folder', 'folder']);
	assert.ok(tides.notes.includes('one of 5 books in one folder, told apart by their file names'));

	const silent = buildCatalog({ ...lib, tags: {}, trackTags: {} });
	assert.deepStrictEqual(Object.values(silent.works).map((w) => w.parts.length), [5], 'the #1 file names no book, so nothing is split until its tags arrive');
});

test('a number with no series on any sibling is dropped rather than shown alone', () => {
	const lib = looseBooks();
	const out = buildCatalog({ ...lib, tracks: lib.tracks.slice(1), tags: {} });
	assert.deepStrictEqual(rowsOf(out.works).map(([id, , seq]) => [id, seq]), [['wren-halloway/grey-tides', null], ['wren-halloway/iron-sea', null], ['wren-halloway/low-sun', null], ['wren-halloway/salt-road', null]]);
	assert.ok(Object.values(out.works).every((w) => w.series === null && w.detected.sources.sequence === null));
});

test('Various Artists and its kin are never an author, and the tags or the file name give one', () => {
	for (const name of ['Various Artists', 'Various', 'various artist', 'VA', 'V.A.', 'Unknown Artist', '[Unknown Artist]']) assert.ok(bookCatalog.isVarious(name), name);
	for (const name of ['Vance Arlo', 'Variety Hour', 'Wren Halloway']) assert.ok(!bookCatalog.isVarious(name), name);
	const a = album(4101, 'Tin Crown', 'Various Artists', ['Audiobook']);
	const tracks = [1, 2, 3].map((i) => track(41010 + i, a, `N:/Media/Music/Ida Marsh/Tin Crown/0${i}.mp3`, 50, { index: i }));
	const tagged = buildCatalog({ albums: [a], tracks, roots: ROOTS, tags: { 4101: { tags: { artist: 'Various Artists', copyright: 'Copyright 2019 by Ida Marsh' } } } });
	assert.deepStrictEqual(Object.values(tagged.works).map((w) => [w.id, w.author, w.authorSource]), [['ida-marsh/tin-crown', 'Ida Marsh', 'copyright']]);
	assert.deepStrictEqual(Object.values(tagged.works)[0].doubts, [], 'no mixed-artists doubt from a placeholder');
	const bare = buildCatalog({ albums: [a], tracks, roots: ROOTS });
	assert.deepStrictEqual(Object.values(bare.works).map((w) => [w.author, w.authorSource]), [['Ida Marsh', 'folder']], 'even the author folder beats a placeholder');
});

test('edition markers leave titles, and are never a narrator or an edition name', () => {
	assert.strictEqual(bookCatalog.cleanTitle('Iron Sea (Dramatized Adaptation)'), 'Iron Sea');
	assert.strictEqual(bookCatalog.cleanTitle('Iron Sea [Unabridged]'), 'Iron Sea');
	assert.strictEqual(bookCatalog.cleanTitle('Iron Sea (Full Cast)'), 'Iron Sea');
	const a = album(4201, 'Tin Crown (Unabridged)', 'Ida Marsh', ['Audiobook']);
	const tracks = [1, 2, 3].map((i) => track(42010 + i, a, `N:/Media/Music/Ida Marsh/Tin Crown (Unabridged)/0${i}.mp3`, 50, { index: i }));
	const w = buildCatalog({ albums: [a], tracks, roots: ROOTS }).works['ida-marsh/tin-crown'];
	assert.ok(w, 'the id is the one the trailing bracket never reached');
	assert.deepStrictEqual([w.title, w.narrator, w.edition], ['Tin Crown', null, null]);
});

test('bookIdentity sees past part, edition and series markers, and numberedName reads a loose book file', () => {
	const same = [
		'The Rust Ledger 4 - Low Sun (2 of 6)', 'The Rust Ledger 4: Low Sun (3 of 6)', 'The Rust Ledger [04] Low Sun [01]',
		'The Rust Ledger [04] Low Sun [01-02]', 'Low Sun Part 1', 'Low Sun - Disc 2', 'Low Sun CD 1', 'Low Sun 01',
		'Low Sun (Dramatized Adaptation)', 'Low Sun (Unabridged)', 'Low Sun (Abridged)', 'Low Sun (Full Cast)', 'Low Sun (Part 2 of 3)', 'Low Sun [2 of 6]',
		'The Rust Ledger: Low Sun', 'LOW SUN', 'Low, Sun!',
	];
	for (const s of same) assert.strictEqual(bookCatalog.bookIdentity(s), 'low sun', s);
	assert.notStrictEqual(bookCatalog.bookIdentity('The Rust Ledger 1: Cold Iron'), bookCatalog.bookIdentity('Grey Tides'));
	assert.deepStrictEqual(bookCatalog.numberedName('Wren Halloway - #2 Grey Tides (Graphic Audio LLC.).m4b'), { author: 'Wren Halloway', number: 2, name: 'Grey Tides' });
	assert.deepStrictEqual(bookCatalog.numberedName('#3 Low Sun.mp3'), { author: null, number: 3, name: 'Low Sun' });
	assert.strictEqual(bookCatalog.numberedName('03 Low Sun.mp3'), null);
	assert.strictEqual(bookCatalog.numberedName('Low Sun.mp3'), null);
});

test('the old id of a split work and every alias go to the book that held its first part', () => {
	const lib = looseBooks();
	const [merged] = Object.values(buildCatalog({ ...lib, tags: {}, trackTags: {} }).works);
	const old = { ...merged, id: 'various-artists/cold-iron', aliases: ['wren-halloway/cold-iron', 'kid-ferro/music'] };
	const next = buildCatalog(lib).works;
	const { works, moved } = matchAliases({ [old.id]: old }, next);
	assert.deepStrictEqual(moved, { 'various-artists/cold-iron': 'wren-halloway/cold-iron' });
	assert.deepStrictEqual(works['wren-halloway/cold-iron'].aliases, ['various-artists/cold-iron', 'kid-ferro/music']);
	assert.ok(['grey-tides', 'low-sun', 'salt-road', 'iron-sea'].every((t) => works[`wren-halloway/${t}`].aliases.length === 0));

	const lowFirst = [merged.parts[2], merged.parts[0], merged.parts[1], ...merged.parts.slice(3)].map((p, i) => ({ ...p, ordinal: i + 1 }));
	assert.deepStrictEqual(matchAliases({ [old.id]: { ...old, parts: lowFirst } }, next).moved, { 'various-artists/cold-iron': 'wren-halloway/low-sun' });

	const ghosts = [1, 2, 3, 4, 5, 6].map((i) => ({ ordinal: 2 + i, trackRatingKey: `999${i}`, file: `gone ${i}.mp3`, sizeBytes: i, durationMs: 600 * MIN }));
	const mostlyGone = { ...old, parts: [merged.parts[0], merged.parts[1], ...ghosts] };
	assert.deepStrictEqual(matchAliases({ [old.id]: mostlyGone }, next).moved, {}, 'two books holding a sliver of a vanished work are no split of it');
});

// Shapes from the real library that must stay one work each: their files are long enough to be
// read one by one, or their parts carry several album tags, yet each is one book.

function oneBookEach(lib, expected, message) {
	const out = buildCatalog({ roots: ROOTS, ...lib });
	assert.deepStrictEqual(Object.values(out.works).map((w) => w.parts.length + w.dropped.length).sort((a, b) => a - b), expected, message);
	return out;
}

function taggedParts(alb, folder, n, min, albumTag, extra = {}) {
	return Array.from({ length: n }, (_, i) => track(alb.ratingKey * 100 + i, alb, `${folder}/${String(i + 1).padStart(2, '0')}.mp3`, min, { index: i + 1, ...extra }))
		.map((t) => ({ t, tags: { tags: { album: albumTag, title: t.title, track: String(t.index) } } }));
}

function libOf(albums, groups) {
	const all = groups.flat();
	return { albums, tracks: all.map((x) => x.t), trackTags: Object.fromEntries(all.map((x) => [x.t.ratingKey, x.tags])) };
}

test('podcast episodes, one album and no tags, stay one podcast', () => {
	const a = album(43, 'Far Signals', 'Far Signals');
	const tracks = Array.from({ length: 8 }, (_, i) => track(4300 + i, a, `N:/Media/Music/Far Signals/FS ep${i + 1} Arrival Part ${i + 1}.mp3`, 95, { index: i + 1 }));
	const out = oneBookEach({ albums: [a], tracks }, [8]);
	assert.strictEqual(Object.values(out.works)[0].kind, 'podcast');
	assert.strictEqual(bookCatalog.tagSamples(tracks, { roots: ROOTS }).filter((s) => s.album === undefined).length, 0, 'long mp3 episodes are never read file by file');
	const titled = Object.fromEntries(tracks.map((t, i) => [t.ratingKey, { tags: { album: ['Arrival', 'The Long Dark', 'Static', 'Relay', 'Drift', 'Echoes', 'Signal Fire', 'Homeward'][i] } }]));
	assert.strictEqual(Object.values(oneBookEach({ albums: [a], tracks, trackTags: titled }, [8]).works)[0].kind, 'podcast', 'episodes tagged with their own titles are still one podcast');
});

test('part albums that differ only by part markers stay one book', () => {
	const dir = 'N:/Media/Music/Wren Halloway/The Rust Ledger [04] Low Sun';
	const p1 = album(44, 'The Rust Ledger [04] Low Sun [01]', 'Graphic Audio [Wren Halloway]');
	const p2 = album(45, 'The Rust Ledger 4 - Low Sun (2 of 6)', 'Graphic Audio [Wren Halloway]');
	const p3 = album(46, 'The Rust Ledger 4: Low Sun (3 of 6)', 'Graphic Audio [Wren Halloway]');
	const m4b = { t: track(4400, p1, `${dir}/Part 1/The Rust Ledger [04] Low Sun [01].m4b`, 140, { chapterSource: 'media' }), tags: { tags: { album: p1.title } } };
	oneBookEach(libOf([p1, p2, p3], [[m4b], taggedParts(p2, `${dir}/Part 2`, 3, 60, p2.title), taggedParts(p3, `${dir}/Part 3`, 3, 60, p3.title)]), [7], 'Low Sun');

	const tides = [1, 2, 3].map((k) => album(46 + k, `The Rust Ledger [02] Grey Tides [0${k}]`, 'Graphic Audio [Wren Halloway]'));
	const tdir = 'N:/Media/Music/Wren Halloway/The Rust Ledger [02] Grey Tides';
	oneBookEach(libOf(tides, tides.map((a, k) => taggedParts(a, `${tdir} [0${k + 1}]`, 3, 60, a.title))), [9], 'Grey Tides');

	const oath = [album(50, 'The Rust Ledger [03] Oath [01]', 'Graphic Audio [Wren Halloway]'), album(51, 'The Rust Ledger 3: Oath (3 of 6)', 'Graphic Audio [Wren Halloway]')];
	const odir = 'N:/Media/Music/Wren Halloway/The Rust Ledger [03] Oath';
	const m4a = { t: track(5000, oath[0], `${odir} [01]/The Rust Ledger [03] Oath [01].m4a`, 300, { chapterSource: 'media' }), tags: { tags: { album: 'The Rust Ledger [03] Oath [01]' } } };
	oneBookEach(libOf(oath, [[m4a], taggedParts(oath[1], `${odir} [03]`, 4, 65, oath[1].title)]), [5], 'Oath: one chaptered file plus mp3 parts in a sibling folder');
});

test('chapter files, an omnibus and hour splits are never read one by one or split', () => {
	const road = album(52, 'The Long Road (5 of 5)', 'Graphic Audio [Wren Halloway]');
	const chapters = Array.from({ length: 83 }, (_, i) => ({ t: track(52000 + i, road, `N:/Media/Music/Wren Halloway/The Long Road/${String(i + 2).padStart(2, '0')} The Long Road - Chapter ${i + 1}.mp3`, i % 2 ? 40 : 20, { index: i + 1 }), tags: { tags: { album: `Chapter ${i + 1}` } } }));
	oneBookEach(libOf([road], [chapters]), [83], '83 chapter tracks');
	assert.strictEqual(bookCatalog.tagSamples(chapters.map((x) => x.t), { roots: ROOTS }).length, 1, 'one album sample, no file read for itself');

	const king = album(53, 'The Hollow Crown Cycle', 'Ida Marsh');
	const omnibus = Array.from({ length: 319 }, (_, i) => ({ t: track(53000 + i, king, `N:/Media/Music/Ida Marsh/The Hollow Crown Cycle/${Math.floor(i / 64) + 1}-${String((i % 64) + 1).padStart(2, '0')} Book ${Math.floor(i / 64) + 1}_ Part - Chapter ${i}.mp3`, 6, { index: i + 1 }), tags: { tags: { album: `Book ${Math.floor(i / 64) + 1}` } } }));
	oneBookEach(libOf([king], [omnibus]), [319], 'a 319-track omnibus');

	const short = album(57, 'The Glass Road', 'Ida Marsh');
	const shortChapters = Array.from({ length: 12 }, (_, i) => ({ t: track(57000 + i, short, `N:/Media/Music/Ida Marsh/The Glass Road/Chapter ${i + 1}.mp3`, 20, { index: i + 1 }), tags: { tags: { album: `Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'][i]}` } } }));
	oneBookEach(libOf([short], [shortChapters]), [12], 'twelve 20-minute chapter files, each tagged with its chapter');

	const box = album(58, 'The Hollow Crown Box', 'Ida Marsh');
	const boxParts = Array.from({ length: 41 }, (_, i) => ({ t: track(58000 + i, box, `N:/Media/Music/Ida Marsh/The Hollow Crown Box/Part ${i + 1}.mp3`, 45, { index: i + 1 }), tags: { tags: { album: `Section ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'x' : ''}` } } }));
	oneBookEach(libOf([box], [boxParts]), [41], 'more long files than a series has books');
	assert.strictEqual(bookCatalog.tagSamples(boxParts.map((x) => x.t), { roots: ROOTS }).length, 1);

	const star = album(54, 'Starfall', 'Ida Marsh');
	const hours = Array.from({ length: 6 }, (_, i) => ({ t: track(54000 + i, star, `N:/Media/Music/Ida Marsh/Starfall/Starfall ${String(i).padStart(2, '0')}.mp3`, 60, { index: i + 1 }), tags: { tags: { album: 'Starfall', title: `Starfall ${String(i).padStart(2, '0')}` } } }));
	oneBookEach(libOf([star], [hours]), [6], 'hour splits named after their book');
	oneBookEach({ albums: [star], tracks: hours.map((x) => x.t) }, [6], 'hour splits without tags');
});

test('books sharing one album title stay apart by folder, and neither is split', () => {
	const a = album(55, 'Ashfall (Mara Lindqvist,...)', 'Avery Quill');
	const b = album(56, 'Ashfall (Mara Lindqvist,...)', 'Avery Quill');
	const out = oneBookEach(libOf([a, b], [
		taggedParts(a, 'N:/Media/Music/Avery Quill/1.The Ember Throne', 5, 60, a.title),
		taggedParts(b, 'N:/Media/Music/Avery Quill/2.The Salt Crown', 4, 60, b.title),
	]), [4, 5]);
	assert.deepStrictEqual(Object.values(out.works).map((w) => w.folderKey).sort(), ['N:/Media/Music/Avery Quill/1.The Ember Throne', 'N:/Media/Music/Avery Quill/2.The Salt Crown']);
});

// The bug (review of rules version 4): a podcast is typed one only when its file names say "ep N"
// or "Episode N". Other long mp3 episodes were cut into one work per episode when their names
// read "#N Title" or each carried its own album tag, and so was a course tagged lecture by lecture.

const NIGHT_OWL = ['The Long Dark', 'Static', 'Relay', 'Drift', 'Echoes', 'Signal Fire'];

function nightOwl(a, ext, prefix = () => '') {
	return NIGHT_OWL.map((t, i) => track(a.ratingKey * 100 + i, a, `N:/Media/Music/Night Owl Radio/${prefix(i)}${t}.${ext}`, 55, { index: i + 1 }));
}

function perEpisodeTags(ts, extra = {}) {
	return Object.fromEntries(ts.map((t, i) => [t.ratingKey, { tags: { album: NIGHT_OWL[i], title: NIGHT_OWL[i], ...extra } }]));
}

test('long mp3 files are never books of their own, however they are named or tagged', () => {
	const a = album(60, 'Night Owl Radio', 'Night Owl Radio', ['Podcast']);
	oneBookEach({ albums: [a], tracks: nightOwl(a, 'mp3', (i) => `Night Owl Radio - #${i + 1} `) }, [6], '"Show - #N Title" names');
	oneBookEach({ albums: [a], tracks: nightOwl(a, 'mp3', (i) => `#${i + 1} `) }, [6], '"#N Title" names');
	const bare = nightOwl(a, 'mp3');
	oneBookEach({ albums: [a], tracks: bare, trackTags: perEpisodeTags(bare, { artist: 'Night Owl Radio', genre: 'Podcast' }) }, [6], 'one album tag per episode, genre Podcast');
	const plain = album(60, 'Night Owl Radio', 'Night Owl Radio');
	oneBookEach({ albums: [plain], tracks: bare, trackTags: perEpisodeTags(bare) }, [6], 'one album tag per episode, no genre');
	const chaptered = bare.map((t) => ({ ...t, chapterSource: 'media' }));
	oneBookEach({ albums: [plain], tracks: chaptered, trackTags: perEpisodeTags(chaptered) }, [6], 'mp3 chapter marks make no file a book of its own');
	assert.strictEqual(bookCatalog.tagSamples(chaptered, { roots: ROOTS }).filter((s) => s.album === undefined).length, 5, 'they are read one by one, and still never split');

	const lec = album(61, 'Understanding Tides', 'Ida Marsh', ['Audiobook']);
	const lectures = Array.from({ length: 12 }, (_, i) => track(6100 + i, lec, `N:/Media/Music/Ida Marsh/Understanding Tides/Lecture ${i + 1}.mp3`, 31, { index: i + 1 }));
	const topics = Object.fromEntries(lectures.map((t, i) => [t.ratingKey, { tags: { album: `Lecture ${i + 1}: Topic ${String.fromCharCode(65 + i)}`, genre: 'Audiobook' } }]));
	oneBookEach({ albums: [lec], tracks: lectures, trackTags: topics }, [12], 'a lecture course tagged lecture by lecture');
});

test('episodes tagged genre Podcast are never split, even in mp4 files', () => {
	const a = album(62, 'Night Owl Radio', 'Night Owl Radio');
	const ts = nightOwl(a, 'm4a');
	oneBookEach({ albums: [a], tracks: ts, trackTags: perEpisodeTags(ts, { genre: 'Podcast' }) }, [6]);
	assert.strictEqual(Object.keys(buildCatalog({ roots: ROOTS, albums: [a], tracks: ts, trackTags: perEpisodeTags(ts, { genre: 'Audiobook' }) }).works).length, 6, 'the same files as books are split');
});

// The bug (review of rules version 4): part words the part-marker list did not know split one
// book in long m4b parts into one work per part, titled "Grey Tides, Part 1 Of" and the like.
test('bookIdentity sees past spelled, roman and "N of M" part words', () => {
	const same = [
		'Grey Tides, Part One', 'Grey Tides, Part Four', 'Grey Tides, Part 1 of 3', 'Grey Tides - Book 2 of 3', 'Grey Tides (Book 3 of 3)',
		'Grey Tides - Part I', 'Grey Tides - Part II', 'Grey Tides Pt. IV', 'Grey Tides, 1 of 3', 'Grey Tides - 2 of 3', 'Grey Tides Vol. 2', 'Grey Tides (Disc 2)',
	];
	for (const s of same) assert.strictEqual(bookCatalog.bookIdentity(s), 'grey tides', s);
	for (const s of ['Fahrenheit 451', 'Catch-22', '1984', 'The Rust Ledger 1: Cold Iron']) assert.notStrictEqual(bookCatalog.bookIdentity(s), '', s);
	assert.notStrictEqual(bookCatalog.bookIdentity('Fahrenheit 451'), bookCatalog.bookIdentity('Catch-22'));
});

test('one book in long m4b parts named by part words stays one work', () => {
	const a = album(63, 'Grey Tides', 'Wren Halloway', ['Audiobook']);
	const shapes = [
		['Part One', 'Part Two', 'Part Three', 'Part Four'].map((p) => `Grey Tides, ${p}`),
		[1, 2, 3].map((n) => `Grey Tides, Part ${n} of 3`),
		[1, 2, 3].map((n) => `Grey Tides - Book ${n} of 3`),
		['Part I', 'Part II'].map((p) => `Grey Tides - ${p}`),
	];
	for (const names of shapes) {
		const ts = names.map((_, i) => track(6300 + i, a, `N:/Media/Music/Wren Halloway/Grey Tides/GT${i + 1}.m4b`, 120, { index: i + 1 }));
		const out = oneBookEach({ albums: [a], tracks: ts, trackTags: Object.fromEntries(ts.map((t, i) => [t.ratingKey, { tags: { album: names[i] } }])) }, [names.length], names[0]);
		assert.deepStrictEqual(Object.values(out.works).map((w) => w.title), ['Grey Tides'], names[0]);
	}
});

// Lower severity, same review: one book whose parts spell its album tag two ways was split.
test('one book whose parts spell its album tag two ways stays one work', () => {
	const pairs = [
		['Iron Sea: A Novel', 'Iron Sea'],
		['The Rust Ledger, Book 5: Iron Sea', 'Iron Sea: The Rust Ledger, Book 5'],
		['Iron Sea A', 'Iron Sea B'],
	];
	for (const [x, y] of pairs) assert.strictEqual(bookCatalog.bookIdentity(x), bookCatalog.bookIdentity(y), `${x} / ${y}`);
	assert.notStrictEqual(bookCatalog.bookIdentity('Iron Sea: The Rust Ledger, Book 5'), bookCatalog.bookIdentity('Low Sun: The Rust Ledger, Book 4'));
	const a = album(64, 'Iron Sea', 'Wren Halloway', ['Audiobook']);
	for (const pair of pairs) {
		const ts = pair.map((_, i) => track(6400 + i, a, `N:/Media/Music/Wren Halloway/Iron Sea/Iron Sea ${i + 1}.m4b`, 150, { index: i + 1 }));
		oneBookEach({ albums: [a], tracks: ts, trackTags: Object.fromEntries(ts.map((t, i) => [t.ratingKey, { tags: { album: pair[i] } }])) }, [2], pair.join(' / '));
	}
});

test('an m4b box set splits into its books, each with its own series number, and titles ending in numbers stay whole', () => {
	const box = album(65, 'The Rust Ledger Box Set', 'Wren Halloway', ['Audiobook']);
	const books = ['Cold Iron', 'Grey Tides', 'Low Sun'];
	const ts = [];
	const tags = {};
	books.forEach((b, bi) => [1, 2].forEach((p) => {
		const t = track(6500 + bi * 2 + p, box, `N:/Media/Music/Wren Halloway/The Rust Ledger Box Set/${bi + 1}-${p} ${b}.m4b`, 200, { index: bi * 2 + p });
		ts.push(t);
		tags[t.ratingKey] = { tags: { album: `The Rust Ledger ${bi + 1}: ${b} (${p} of 2)`, artist: 'Wren Halloway', track: String(bi * 2 + p) } };
	}));
	const out = buildCatalog({ roots: ROOTS, albums: [box], tracks: ts, trackTags: tags });
	assert.deepStrictEqual(Object.values(out.works).map((w) => [w.id, w.series, w.sequence, w.parts.length]).sort((x, y) => x[0].localeCompare(y[0])), [
		['wren-halloway/cold-iron', 'The Rust Ledger', 1, 2],
		['wren-halloway/grey-tides', 'The Rust Ledger', 2, 2],
		['wren-halloway/low-sun', 'The Rust Ledger', 3, 2],
	]);

	const classics = album(66, 'Classics', 'Various Artists', ['Audiobook']);
	const named = [['Fahrenheit 451', 'Ray Barton'], ['Catch-22', 'Jo Heller'], ['1984', 'Ed Orwin'], ['2001: A Space Odyssey', 'Art Clarkson']];
	const cts = named.map(([b], i) => track(6600 + i, classics, `N:/Media/Music/Classics/${b.replace(':', '')}.m4b`, 400, { index: i + 1 }));
	const four = buildCatalog({ roots: ROOTS, albums: [classics], tracks: cts, trackTags: Object.fromEntries(cts.map((t, i) => [t.ratingKey, { tags: { album: named[i][0], artist: named[i][1] } }])) });
	assert.deepStrictEqual(Object.values(four.works).map((w) => [w.title, w.author]).sort((x, y) => x[0].localeCompare(y[0])), [
		['1984', 'Ed Orwin'], ['2001: A Space Odyssey', 'Art Clarkson'], ['Catch-22', 'Jo Heller'], ['Fahrenheit 451', 'Ray Barton'],
	]);
});
