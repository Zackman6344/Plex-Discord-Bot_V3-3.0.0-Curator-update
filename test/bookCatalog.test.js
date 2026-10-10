// helpers/bookCatalog.js: grouping a Plex music listing into audiobook and podcast works, their
// play order, the overrides file, id aliases across rebuilds, and the membership index.
//
// The bug: Plex albums are not books on a hand-ripped library, so every shortcut fails somewhere.
// Grouping by album merges seven books that share one album title and splits one book over two
// albums; path order plays interleaved volumes out of sequence; a duration rule lets short chapter
// files into music and takes long music mixes for books; two narrations of one book collapse into
// one work with one bookmark; a renamed folder orphans every bookmark saved under the old id.
//
// Harness: the plain pure-function style of test/bookModel.test.js. test/fixtures/books/ holds a
// SYNTHETIC library (invented names under M:/Music/) that reproduces each of those structures,
// built by a generator kept outside the repo; catalog.json is its built form, which the music
// exclusion tests seed the store with.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bookCatalog = require('../helpers/bookCatalog.js');
const { buildCatalog, applyOverrides, matchAliases, buildIndex, normalizeChapters } = bookCatalog;

const FIXTURES = path.join(__dirname, 'fixtures', 'books');
const LIBRARY = require(path.join(FIXTURES, 'library.json'));
const CATALOG = require(path.join(FIXTURES, 'catalog.json'));
const OVERRIDES = require(path.join(FIXTURES, 'overrides.json'));

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
		assert.strictEqual(w.edition, 'Mara Lindqvist');
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
	assert.strictEqual(BASE.works['ilse-moreau/the-glass-sea'].narrator, 'Various');
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
	const drama = WITH.works['studio-kiseki/drama-cd-vol'];
	assert.ok(drama, 'the drama album is a work');
	assert.strictEqual(drama.detectedBy, 'override');
	assert.strictEqual(drama.title, 'Drama CD Vol', 'a trailing number reads as a part marker; a title override fixes it');
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
