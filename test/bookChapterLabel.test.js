// helpers/bookChapterLabel.js: the words the card puts on the chapter playing.
//
// The bug: bookModel.chapters() makes every part without embedded chapters one chapter, so the
// card counted files. An omnibus showed "Chapter 240 of 319" where its track says Book 4, Chapter
// 7; a book split into hour files showed "Chapter 7 of 19 · 07.Title" as if it had 19 chapters; a
// GraphicAudio code (STORMLIGHT0402P01) was printed as a chapter name. The label must also never
// carry a read-along heading's own words onto the public card, and never move the slot numbers
// `!book chapter <n>` jumps to.
//
// Harness: pure, no Discord. Works are synthetic, with track titles shaped like the catalog's
// (invented titles, never library data); read-along maps come from readAlongModel.buildMap over a
// synthetic table of contents, or are written by hand where a test needs the map to disagree.

const test = require('node:test');
const assert = require('node:assert').strict;

const { chapterLabel, keyLabel } = require('../helpers/bookChapterLabel.js');
const bookModel = require('../helpers/bookModel.js');
const model = require('../helpers/readAlongModel.js');

const PART_MS = 600000;

// Embedded chapters are given by start only; each ends where the next starts, as Plex reports them.
function ended(chapters) {
	return chapters.map((c, k) => Object.assign({ endMs: k + 1 < chapters.length ? chapters[k + 1].startMs : PART_MS }, c));
}

function work(title, titles, extra = {}) {
	const parts = titles.map((t, i) => {
		const over = Object.assign({}, (extra.parts && extra.parts[i]) || {});
		if (over.chapters) over.chapters = ended(over.chapters);
		return Object.assign({ ordinal: i + 1, title: t, durationMs: PART_MS }, over);
	});
	return { id: `test-author/${title.toLowerCase().replace(/\W+/g, '-')}`, kind: extra.kind || 'book', title, series: extra.series || null, parts };
}

function labels(w, opts) {
	const chs = bookModel.chapters(w);
	return chs.map(c => chapterLabel(w, c, chs, opts));
}

function at(w, ms, opts = {}) {
	const chs = bookModel.chapters(w);
	return chapterLabel(w, bookModel.chapterAt(w, ms), chs, Object.assign({ ms }, opts));
}

test('an omnibus track gives the book, the chapter and the book title', () => {
	const w = work('The Iron Crowns', [
		'1-01 Book 1  The Salt Road - Intro',
		'1-02 Book 1  The Salt Road - Chapter 01a',
		'1-03 Book 1  The Salt Road - Chapter 01b',
		'4-09 Book 4  The Lantern Hour - Chapter 07a'
	]);
	const got = labels(w);
	assert.deepEqual(got[3], { label: 'Book 4 · Chapter 7 · The Lantern Hour', short: 'Book 4 · Chapter 7', detail: 'The Lantern Hour' });
	assert.equal(got[1].label, 'Book 1 · Chapter 1 · The Salt Road');
	assert.equal(got[2].short, 'Book 1 · Chapter 1', 'a chapter split over two tracks keeps its number');
	assert.deepEqual(got[0], { label: 'Book 1 · The Salt Road', short: 'Book 1', detail: 'The Salt Road' });
});

test('a track named after a chapter gives just that chapter', () => {
	const w = work('The Glass Tide', ['01 intro', '02 Prelude', '03 Prologue', '09 Chapter 21', 'Chapter 22', '20 Interlude 1-1', '40 Epilogue', '41 outro']);
	assert.deepEqual(labels(w).map(l => l.label), [
		'Part 1 of 8 · 01 intro', 'Prelude', 'Prologue', 'Chapter 21', 'Chapter 22', 'Interlude 1-1', 'Epilogue', 'Part 8 of 8 · 41 outro'
	]);
});

test('a track title that only repeats the work title and the label is dropped', () => {
	const w = work('The Glass Tide', ['Glass Tide 01', 'Glass Tide 02', 'Glass Tide 03: Epilogue']);
	assert.deepEqual(labels(w).map(l => l.label), ['Part 1 of 3', 'Part 2 of 3', 'Epilogue']);
	const numbered = work('The Copper Gate', Array.from({ length: 19 }, (_, i) => `${String(i + 1).padStart(2, '0')}.The Copper Gate`));
	assert.equal(labels(numbered)[6].label, 'Part 7 of 19');
	assert.equal(labels(numbered)[6].detail, null);
});

test('a track title that says more than the label is kept after it', () => {
	const w = work('The Glass Tide', ['00: Prologue', '01: The Miller\'s Tale 03', '02: Glass Tide 05', '03 outro'], { series: 'Tide Cycle' });
	const got = labels(w).map(l => l.label);
	assert.equal(got[1], 'Part 2 of 4 · 01: The Miller\'s Tale 03');
	assert.equal(got[2], 'Part 3 of 4 · 02: Glass Tide 05', 'a number that is not the slot is information');
	const ref = work('Words of Ash', ['The Ash Cycle [02] Words of Ash [01-01]', 'The Ash Cycle [02] Words of Ash [01-02]'], { series: 'The Ash Cycle' });
	assert.deepEqual(labels(ref).map(l => l.short), ['Part 1 of 2', 'Part 2 of 2']);
	assert.ok(labels(ref).every(l => /\[0\d-0\d\]$/.test(l.detail)), 'a two-number reference stays, even when one number is the slot');
});

test('words every track shares do not count as saying something', () => {
	const w = work('The Lost Lanterns', ['LL Show Lost Lanterns ep1 Openings', 'LL Show Lost Lanterns Ep2', 'LL Show Lost Lanterns ep3'], { kind: 'podcast' });
	assert.deepEqual(labels(w).map(l => l.label), ['Episode 1 of 3 · LL Show Lost Lanterns ep1 Openings', 'Episode 2 of 3', 'Episode 3 of 3']);
});

test('a podcast counts episodes, by the number in the title when it has one', () => {
	const w = work('Night Shift Radio', ['Night Shift Radio - Episode 4', 'Night Shift Radio - Episode 5', 'Bonus: Behind the Desk'], { kind: 'podcast' });
	assert.deepEqual(labels(w).map(l => l.label), ['Episode 4 of 3', 'Episode 5 of 3', 'Episode 3 of 3 · Bonus: Behind the Desk']);
});

test('embedded GraphicAudio code chapters give the part and the section, never the code', () => {
	const codes = n => Array.from({ length: n }, (_, k) => ({ title: `GLASSTIDE0402P0${k + 1}`, startMs: k * 100000 }));
	const w = work('The Glass Tide', ['The Tide Cycle [04] The Glass Tide [01-01]', 'GLASSTIDE0402P01', 'The Tide Cycle [04] The Glass Tide [03-01]'], {
		parts: [{}, { chapters: codes(6) }, {}]
	});
	const got = labels(w);
	assert.equal(got.length, 8);
	assert.deepEqual(got[1], { label: 'Part 2 of 3 · Section 1 of 6', short: 'Part 2 of 3 · Section 1 of 6', detail: null });
	assert.equal(got[6].label, 'Part 2 of 3 · Section 6 of 6');
	assert.equal(got[7].short, 'Part 3 of 3', 'the part count is files, not chapter slots');

	const one = work('Red Signal', ['REDSIGNAL01P01'], { parts: [{ chapters: [{ title: 'REDSIGNAL01P01', startMs: 0 }, { title: 'REDSIGNAL01P02', startMs: 200000 }, { title: 'REDSIGNAL01P03', startMs: 400000 }] }] });
	assert.deepEqual(labels(one).map(l => l.label), ['Section 1 of 3', 'Section 2 of 3', 'Section 3 of 3'], 'one file needs no part number');
});

test('a part titled with a code and no embedded chapters gives only its place', () => {
	const w = work('Edge Walker', ['EDGEWALKERP01', 'EDGEWALKERP02']);
	assert.deepEqual(labels(w).map(l => l.label), ['Part 1 of 2', 'Part 2 of 2']);
});

test('embedded chapters with names give the chapter; unnamed ones count inside their part', () => {
	const named = work('The Glass Tide', ['Glass Tide'], { parts: [{ chapters: [{ title: 'Prologue', startMs: 0 }, { title: 'Chapter 1', startMs: 100000 }, { title: 'The Long Night', startMs: 300000 }] }] });
	assert.deepEqual(labels(named).map(l => l.label), ['Prologue', 'Chapter 1', 'Chapter 3 of 3 · The Long Night']);
	const unnamed = work('The Glass Tide', ['07.The Glass Tide', 'Two'], { parts: [{ chapters: [{ startMs: 0 }, { startMs: 200000 }] }, {}] });
	const got = labels(unnamed);
	assert.equal(got[0].label, 'Part 1 of 2 · Chapter 1 of 2', 'bookModel names an untitled chapter after its part; that is no chapter "7"');
	assert.equal(got[1].label, 'Part 1 of 2 · Chapter 2 of 2');
});

test('the slot numbers and the chapter list are left as they were', () => {
	const w = work('The Iron Crowns', ['1-01 Book 1  The Salt Road - Chapter 01a', '4-09 Book 4  The Lantern Hour - Chapter 07a']);
	const chs = bookModel.chapters(w);
	const before = JSON.stringify(chs);
	chs.forEach(c => chapterLabel(w, c, chs));
	assert.equal(JSON.stringify(chs), before);
	assert.deepEqual(chs.map(c => c.number), [1, 2]);
});

test('keyLabel spells out every read-along key and nothing else', () => {
	assert.equal(keyLabel('c12'), 'Chapter 12');
	assert.equal(keyLabel('i3'), 'Interlude 3');
	assert.equal(keyLabel('i2-1'), 'Interlude 2-1');
	assert.equal(keyLabel('i'), 'Interlude');
	assert.equal(keyLabel('ars-arcanum'), 'Ars Arcanum');
	assert.equal(keyLabel('endnote'), 'Endnotes');
	assert.equal(keyLabel(null), null);
	assert.equal(keyLabel('x9'), null);
});

// ---- a read-along map already in memory -----------------------------------------------------------

const TOC = [
	{ label: 'Contents', words: 30 },
	{ label: 'Chapter 1: The Harbour', words: 1000 },
	{ label: 'Chapter 2: Salt and Iron', words: 1000 },
	{ label: 'Chapter 3: The Secret Door', words: 1000 },
	{ label: 'Chapter 4: Ashes', words: 1000 },
	{ label: 'Chapter 5: Low Tide', words: 1000 },
	{ label: 'Chapter 6: Homecoming', words: 1000 }
];

test('a map fills in the chapter where the track title names none, by its key only', () => {
	const w = work('The Copper Gate', ['01.The Copper Gate', '02.The Copper Gate', '03.The Copper Gate']);
	const map = model.buildMap(w, { sections: TOC });
	assert.ok(map, 'the synthetic text lines up');
	const mid = at(w, PART_MS + PART_MS / 4, { map });
	assert.deepEqual(mid, { label: 'Part 2 of 3 · Chapter 3', short: 'Part 2 of 3 · Chapter 3', detail: null });
	assert.ok(!/Secret|Door/.test(JSON.stringify(mid)), 'a heading\'s own words never reach the public card');
	assert.equal(at(w, PART_MS + PART_MS / 4).label, 'Part 2 of 3', 'without a map, the place alone');
});

test('a track that names its chapter wins over a map that only estimates', () => {
	const w = work('The Copper Gate', ['01 Chapter 1', '02 Chapter 2', '03 Chapter 3']);
	const map = {
		totalMs: 3 * PART_MS,
		bodyEndWord: 100,
		sections: [{ label: 'Chapter 9', key: 'c9', wordStart: 0, words: 100, matter: 'body' }],
		segments: [{ fromMs: 0, toMs: 3 * PART_MS, fromWord: 0, toWord: 100, level: 'pace' }],
		anchors: []
	};
	assert.equal(at(w, PART_MS + 1000, { map }).label, 'Chapter 2');
	const plain = work('The Copper Gate', ['01.The Copper Gate', '02.The Copper Gate', '03.The Copper Gate']);
	assert.equal(at(plain, PART_MS + 1000, { map }).label, 'Part 2 of 3 · Chapter 9', 'the same map does fill a nameless track');
});

test('a map adds nothing over a track with no text or for a podcast', () => {
	const w = work('The Copper Gate', ['00 Opening Credits', '01.The Copper Gate', '02.The Copper Gate']);
	const map = model.buildMap(w, { sections: TOC });
	assert.ok(map);
	assert.equal(at(w, 1000, { map }).short, 'Part 1 of 3', 'the credits carry no chapter');
	const pod = Object.assign({}, w, { kind: 'podcast' });
	assert.equal(at(pod, PART_MS + 1000, { map }).short, 'Episode 2 of 3');
});
