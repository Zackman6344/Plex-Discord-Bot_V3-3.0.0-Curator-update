// helpers/readAlongModel.js: section classes, chapter keys, the ms <-> word map and pages.
//
// The bug: a read-along page that is not where the narration is, or that never turns up at
// all. A track called "Chatper 12" left unmatched; a bare track number taken for a chapter; a
// next-book preview's "Chapter One" or an unread Ars Arcanum stretching the pace map past the
// epilogue; a chapter split over two tracks leaving an hour of "no text"; "Chapters 12-13"
// hiding chapter 13; "Play from here" landing a word short, on the previous page; a GraphicAudio
// edition whose catalog edition is the narrator's name not labelled dramatized; pages that drop
// or repeat a word. An omnibus whose chapter numbers restart in every book: Book 1's "Chapter 01"
// sent to Book 2's chapter 1, Book 1's heading-plus-chapter-1 section taken for front matter, and
// a recorded book the ebook lacks stretching the pace map over hours of audio.
//
// Harness: the plain pure-function style of test/bookModel.test.js. Works and ebook indexes are
// synthetic: section labels shaped like real tables of contents, track titles shaped like the
// catalog's, and generated filler text ("alpha bravo ..."), never library data or book text.

const test = require('node:test');
const assert = require('node:assert').strict;
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const model = require('../helpers/readAlongModel.js');
const {
	words, labelKey, partKey, bookOfPart, bookAt, keyClass, keysMatch, isNoTextPart, classifySections,
	msToWord, wordToMs, locate, paginate, pageAt, qualityAt, isDramatized,
} = model;

// Every map a test builds is recorded, so the last test can rebuild each one with the first
// release's model and prove the omnibus support left plain works untouched.
const built = [];
function buildMap(...args) {
	built.push(structuredClone(args));
	return model.buildMap(...args);
}

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

const VOCAB = [
	'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett',
	'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
	'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', "don't", 'well-known', 'o\u2019clock',
	'\u201calpha', 'bravo,', 'caf\u00e9', 'na\u00efve', '42', '\u2014',
];

// Filler text with exactly n words: sentences of 5-16 words, paragraphs of 2-6 sentences.
function gen(n, seed = 1) {
	let x = seed >>> 0 || 1;
	const rnd = (k) => {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		return (x >>> 8) % k;
	};
	const paras = [];
	let para = [];
	let sentence = [];
	let count = 0;
	let sLen = 5 + rnd(12);
	let pLen = 2 + rnd(5);
	while (count < n) {
		let w = VOCAB[rnd(VOCAB.length)];
		if (w === '\u2014') {
			if (sentence.length) sentence.push(w);
			continue;
		}
		if (!sentence.length) w = w[0].toUpperCase() + w.slice(1);
		sentence.push(w);
		count++;
		const words = sentence.filter((t) => t !== '\u2014').length;
		if (words >= sLen || count === n) {
			para.push(`${sentence.join(' ')}.`);
			sentence = [];
			sLen = 5 + rnd(12);
			if (para.length >= pLen || count === n) {
				paras.push(para.join(' '));
				para = [];
				pLen = 2 + rnd(5);
			}
		}
	}
	return paras.join('\n');
}

// An index in the cache's shape plus each section's text.
function book(specs, seed = 7) {
	const texts = [];
	let w = 0;
	const sections = specs.map(([label, n], i) => {
		const text = n ? gen(n, seed + i * 31) : '';
		texts.push(text);
		const count = words(text).length;
		const s = { label, href: `text/s${i}.xhtml`, depth: 1, part: 0, words: count, wordStart: w };
		w += count;
		return s;
	});
	return { index: { version: 1, totalWords: w, sections }, texts };
}

function work(parts, extra = {}) {
	return {
		id: 'test-author/test-work',
		kind: 'book',
		title: 'Test Work',
		author: 'Test Author',
		narrator: null,
		edition: null,
		publisher: null,
		...extra,
		parts: parts.map(([title, durationMs], i) => ({ ordinal: i + 1, title, durationMs })),
	};
}

function partStart(w, i) {
	return w.parts.slice(0, i).reduce((n, p) => n + p.durationMs, 0);
}

function sectionOf(index, label) {
	const i = index.sections.findIndex((s) => s.label === label);
	assert.ok(i >= 0, `no section ${label}`);
	return i;
}

const WOK_SECTIONS = [
	['Cover', 0],
	['Title Page', 12],
	['Contents', 60],
	['Prelude to the Archive', 900],
	['Prologue: To Kill', 1500],
	['Part One: Above', 30],
	['1. Stormblessed', 3000],
	['2. Honor Is Dead', 2500],
	['Map of the Isles', 0],
	['3. City of Bells', 2800],
	['I-1: Ishikk', 1200],
	['I-2: Nan Balat', 1100],
	['4. The Shattered', 3000],
	['5. Heretic', 2600],
	['6. Bridge Four', 2900],
	['7. Anything', 2700],
	['Epilogue: Most Worth', 1800],
	['Ars Arcanum', 2000],
	['Acknowledgments', 200],
];

const WOK_PARTS = [
	['01 Opening Credits', 1 * MIN],
	['02 Prelude', 5 * MIN],
	['03 Prologue', 8 * MIN + 20 * S],
	['04 Chatper 1', 16 * MIN + 40 * S],
	['05 Chapter 2', 13 * MIN + 20 * S],
	['06 Chapter 3', 15 * MIN],
	['07 Interlude 1-1', 6 * MIN + 40 * S],
	['08 Interlude 1-2', 5 * MIN + 50 * S],
	['STORMLIGHT0103P01', H],
	['STORMLIGHT0103P02', 20 * MIN],
	['11 Part Two Intro', 30 * S],
	['12 Chapter 7', 15 * MIN],
	['13 Epilogue', 10 * MIN],
	['14 Closing Credits', 1 * MIN],
];

function wokFixture() {
	const { index, texts } = book(WOK_SECTIONS);
	const w = work(WOK_PARTS, { title: 'The Way of Testing' });
	const map = buildMap(w, index);
	assert.ok(map, 'map built');
	return { index, texts, w, map, ws: (label) => index.sections[sectionOf(index, label)].wordStart };
}

// Every reachable page start of every body section survives ms and back: "play from here" and
// the page shown afterwards must be the clicked page.
function assertRoundTrip(map, texts) {
	let checked = 0;
	map.sections.forEach((s, i) => {
		if (s.matter !== 'body' || !(s.words > 0)) return;
		const pages = paginate(texts[i]);
		pages.forEach((p, pi) => {
			const start = s.wordStart + p.startWord;
			const ms = wordToMs(map, start);
			assert.ok(Number.isInteger(ms), `integer ms for word ${start}`);
			const got = msToWord(map, ms).word;
			assert.ok(got >= start, `word ${start} came back as ${got}`);
			const loc = locate(map, got);
			assert.equal(loc.section, i, `word ${start} left its section`);
			assert.equal(pageAt(pages, loc.wordInSection), pi, `word ${start} landed on another page`);
			checked++;
		});
	});
	return checked;
}

test('partKey reads chapter keys from catalog-shaped track titles', () => {
	const table = [
		['18 Chatper 12', 'c12'],
		['04 Chapetr 7', 'c7'],
		['02 Prelude', 'prelude'],
		['03 Prolouge', 'prologue'],
		['Interlude 1-4', 'i1-4'],
		['Interlude I-4', 'i1-4'],
		['Interlude 4', 'i4'],
		['Chapter One', 'c1'],
		['Chapter Twenty-Three', 'c23'],
		['Chapter One Hundred and Five', 'c105'],
		['Chapter XII', 'c12'],
		['The Way of Kings (Grahpic Audio) - Chapter 44', 'c44'],
		['Chapters 12-13', 'c12'],
		['Chapter 12 (cont.)', 'c12'],
		['Ch. 9', 'c9'],
		['Epilogue', 'epilogue'],
		['Endnote', 'endnote'],
		['Ars Arcanum', 'ars-arcanum'],
		['STORMLIGHT0103P01', null],
		['Part 01', null],
		['Hour 3', null],
		['18', null],
		['07 Untitled', null],
		['', null],
		[null, null],
	];
	for (const [title, key] of table) assert.equal(partKey(title), key, `partKey(${JSON.stringify(title)})`);
});

test('partKey ignores a keyword that is only part of the work title', () => {
	assert.equal(partKey('Prelude to Testing - Part 01'), 'prelude');
	assert.equal(partKey('Prelude to Testing - Part 01', { workTitle: 'Prelude to Testing' }), null);
	assert.equal(partKey('Prelude to Testing - Chapter 3', { workTitle: 'Prelude to Testing' }), 'c3');
});

test('labelKey reads chapter keys from table-of-contents labels', () => {
	const table = [
		['12', 'c12'],
		['12. Title', 'c12'],
		['12: Title', 'c12'],
		['12 Title', 'c12'],
		['Chapter 12: x', 'c12'],
		['CHAPTER 12', 'c12'],
		['Chapter Twelve', 'c12'],
		['Chapter XII', 'c12'],
		['XII', 'c12'],
		['One', 'c1'],
		['One: Beginnings', 'c1'],
		['One Last Thing', null],
		['I Am Here', null],
		['I-4', 'i1-4'],
		['1-4', 'i1-4'],
		['I-1: Ishikk', 'i1-1'],
		['Interlude I-4', 'i1-4'],
		['Interlude: Somewhere', 'i'],
		['Prologue: To Kill', 'prologue'],
		['Prelude to the Archive', 'prelude'],
		['Epilogue', 'epilogue'],
		['Ars Arcanum', 'ars-arcanum'],
		['Endnotes', 'endnote'],
		['Postscript', 'postscript'],
		['Afterword', 'afterword'],
		['Part One: Above', null],
		['Map of the Isles', null],
		['Chapter 12 (2)', 'c12'],
		['', null],
	];
	for (const [label, key] of table) assert.equal(labelKey(label), key, `labelKey(${JSON.stringify(label)})`);
});

test('keyClass separates back-matter keys from chapter keys', () => {
	for (const k of ['c1', 'prologue', 'prelude', 'epilogue', 'i1-4', 'i']) assert.equal(keyClass(k), 'chapter', k);
	for (const k of ['ars-arcanum', 'endnote', 'postscript', 'afterword']) assert.equal(keyClass(k), 'back', k);
	assert.equal(keyClass(null), null);
});

test('keysMatch compares interludes by their last number when one side has one number', () => {
	assert.ok(keysMatch('c12', 'c12'));
	assert.ok(!keysMatch('c12', 'c13'));
	assert.ok(keysMatch('i4', 'i1-4'));
	assert.ok(keysMatch('i1-4', 'i4'));
	assert.ok(keysMatch('i1-4', 'i1-4'));
	assert.ok(!keysMatch('i1-4', 'i2-4'));
	assert.ok(!keysMatch('i4', 'i5'));
	assert.ok(!keysMatch('i', 'i4'));
	assert.ok(!keysMatch('c4', 'i4'));
	assert.ok(!keysMatch(null, null));
});

test('isNoTextPart flags intro and credits tracks but never a chapter track', () => {
	assert.ok(isNoTextPart({ title: '01 Opening Credits' }));
	assert.ok(isNoTextPart({ title: 'Outro' }));
	assert.ok(isNoTextPart({ title: '11 Part Two Intro' }));
	assert.ok(isNoTextPart({ title: 'Trailer' }));
	assert.ok(!isNoTextPart({ title: 'Introduction' }));
	assert.ok(!isNoTextPart({ title: 'Chapter 3 - The Opening' }));
	assert.ok(!isNoTextPart({ title: 'Part 01' }));
	assert.ok(!isNoTextPart({}));
});

test('classifySections marks front, body, back and empty sections', () => {
	const { index } = book(WOK_SECTIONS);
	const c = classifySections(index.sections, { performedKeys: new Set(['prelude', 'c1']) });
	const matter = (label) => c.sections[sectionOf(index, label)].matter;
	assert.equal(matter('Cover'), 'empty');
	assert.equal(matter('Title Page'), 'front');
	assert.equal(matter('Contents'), 'front');
	assert.equal(matter('Prelude to the Archive'), 'body');
	assert.equal(matter('Part One: Above'), 'body');
	assert.equal(matter('Map of the Isles'), 'empty');
	assert.equal(matter('Epilogue: Most Worth'), 'body');
	assert.equal(matter('Ars Arcanum'), 'back');
	assert.equal(matter('Acknowledgments'), 'back');
	assert.equal(c.sections[sectionOf(index, 'I-1: Ishikk')].key, 'i1-1');
	const epi = index.sections[sectionOf(index, 'Epilogue: Most Worth')];
	assert.equal(c.bodyStartWord, index.sections[sectionOf(index, 'Prelude to the Archive')].wordStart);
	assert.equal(c.bodyEndWord, epi.wordStart + epi.words);
});

test('classifySections without any chapter label starts the body at the first long unkeyed section', () => {
	const { index } = book([['Cover', 0], ['Copyright', 40], ['Foreword', 20], ['The Story', 5000], ['About the Author', 90]]);
	const c = classifySections(index.sections);
	assert.deepEqual(c.sections.map((s) => s.matter), ['empty', 'front', 'front', 'body', 'back']);
});

test('an unperformed ars arcanum and a trailing preview end the body at the epilogue', () => {
	const specs = [
		['Prologue', 800], ['1', 3000], ['2', 3000], ['Epilogue', 900], ['Ars Arcanum', 1500],
		['An Excerpt from The Next Book', 40], ['Chapter One', 2500], ['About the Author', 120],
	];
	const { index } = book(specs);
	const epi = index.sections[sectionOf(index, 'Epilogue')];
	const hourSplits = work([['Part 01', H], ['Part 02', H], ['Part 03', 40 * MIN]]);
	const map = buildMap(hourSplits, index);
	assert.equal(map.bodyEndWord, epi.wordStart + epi.words);
	assert.equal(map.sections[sectionOf(index, 'Ars Arcanum')].matter, 'back');
	assert.equal(map.sections[sectionOf(index, 'Chapter One')].matter, 'back');
	assert.equal(msToWord(map, hourSplits.parts.reduce((n, p) => n + p.durationMs, 0) - 1).word < map.bodyEndWord, true);
	assert.ok(map.anchors.some((a) => a.kind === 'work-end' && a.word === epi.wordStart + epi.words));

	const performed = work([['Part 01', H], ['Part 02', H], ['Part 03', 40 * MIN], ['Ars Arcanum', 10 * MIN]]);
	const map2 = buildMap(performed, index);
	const ars = index.sections[sectionOf(index, 'Ars Arcanum')];
	assert.equal(map2.sections[sectionOf(index, 'Ars Arcanum')].matter, 'body');
	assert.equal(map2.bodyEndWord, ars.wordStart + ars.words);
	assert.equal(map2.sections[sectionOf(index, 'Chapter One')].matter, 'back');
	const start = map2.anchors.find((a) => a.kind === 'track-start');
	assert.equal(start.ms, partStart(performed, 3));
	assert.equal(start.word, ars.wordStart);
	assert.equal(msToWord(map2, partStart(performed, 3)).level, 'chapter');
});

test('buildMap pins chapter tracks, flattens credits and paces the hour splits', () => {
	const { w, map, ws, index } = wokFixture();
	assert.deepEqual(map.dropped, []);
	assert.equal(map.matchedParts, 9);
	assert.equal(map.totalMs, partStart(w, w.parts.length));

	const ch1 = partStart(w, 3);
	assert.deepEqual(msToWord(map, ch1), { word: ws('1. Stormblessed'), level: 'chapter', segmentIndex: msToWord(map, ch1).segmentIndex });
	assert.equal(msToWord(map, partStart(w, 1)).word, ws('Prelude to the Archive'));
	assert.equal(msToWord(map, partStart(w, 11)).word, ws('7. Anything'));

	assert.equal(msToWord(map, 30 * S).level, 'none');
	assert.equal(msToWord(map, 30 * S).word, ws('Prelude to the Archive'));
	assert.equal(msToWord(map, partStart(w, 10) + 10 * S).level, 'none');
	assert.equal(msToWord(map, map.totalMs - 30 * S).level, 'none');

	const paceFrom = partStart(w, 8);
	const paceTo = partStart(w, 10);
	const mid = (paceFrom + paceTo) / 2;
	const expected = ws('4. The Shattered') + (ws('7. Anything') - ws('4. The Shattered')) / 2;
	assert.equal(msToWord(map, mid).level, 'pace');
	assert.equal(msToWord(map, mid).word, Math.floor(expected));

	// Unkeyed pages between two chapters belong to the span before them.
	const prologueEnd = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 2);
	assert.equal(prologueEnd.word, ws('1. Stormblessed'));
	const i2End = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 7);
	assert.equal(i2End.word, ws('4. The Shattered'));
	const epiEnd = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 12);
	assert.equal(epiEnd.word, map.bodyEndWord);

	const ars = index.sections[sectionOf(index, 'Ars Arcanum')];
	assert.equal(map.bodyEndWord, ars.wordStart);
	assert.ok(map.matchedMsShare > 0.5 && map.matchedMsShare < 0.7, `share ${map.matchedMsShare}`);
	for (let k = 1; k < map.anchors.length; k++) {
		assert.ok(map.anchors[k].ms >= map.anchors[k - 1].ms);
		assert.ok(map.anchors[k].word >= map.anchors[k - 1].word);
	}
});

test('wordToMs of a chapter start lands on its own track, not the intro before it', () => {
	const { w, map, ws } = wokFixture();
	const ch7 = wordToMs(map, ws('7. Anything'));
	assert.ok(ch7 >= partStart(w, 11) && ch7 < partStart(w, 12), `ms ${ch7}`);
	const prelude = wordToMs(map, ws('Prelude to the Archive'));
	assert.ok(prelude >= partStart(w, 1) && prelude < partStart(w, 2), `ms ${prelude}`);
	assert.equal(msToWord(map, ch7).word, ws('7. Anything'));
});

test('an all-hour-split work interpolates from the body start to the body end', () => {
	const { index } = book([['Copyright', 30], ['Prologue', 1000], ['1', 4000], ['2', 5000], ['Acknowledgments', 100]]);
	const w = work([['Part 01', H], ['Part 02', H]]);
	const map = buildMap(w, index);
	assert.equal(map.bodyStartWord, 30);
	assert.equal(map.bodyEndWord, 10030);
	assert.equal(map.segments.length, 1);
	assert.equal(map.segments[0].level, 'pace');
	assert.equal(msToWord(map, 0).word, 30);
	assert.equal(msToWord(map, H).word, 30 + 5000);
	assert.equal(msToWord(map, 2 * H).word, 10029);
	assert.equal(qualityAt(map, H).label, 'estimated from pace');
});

test('consecutive tracks of one chapter merge into one span', () => {
	const { index } = book([['11', 2000], ['12', 3000], ['13', 2500], ['14', 2000]]);
	const w = work([['Chapter 11', 10 * MIN], ['Chapter 12', 9 * MIN], ['Chapter 12 (cont.)', 7 * MIN], ['Chapter 13', 14 * MIN], ['Chapter 14', 11 * MIN]]);
	const map = buildMap(w, index);
	assert.deepEqual(map.dropped, []);
	assert.ok(!map.segments.some((s) => s.level === 'none'));
	const c12 = index.sections[1].wordStart;
	const c13 = index.sections[2].wordStart;
	const start = map.anchors.find((a) => a.kind === 'track-start' && a.word === c12);
	const end = map.anchors.find((a) => a.kind === 'track-end' && a.span === start.span);
	assert.equal(start.ms, partStart(w, 1));
	assert.equal(end.ms, partStart(w, 3));
	assert.equal(end.word, c13);
	const seg = map.segments.find((s) => s.fromMs === start.ms);
	assert.equal(seg.level, 'chapter');
	assert.equal(seg.toMs, partStart(w, 3));
	const atCont = msToWord(map, partStart(w, 2));
	assert.equal(atCont.level, 'chapter');
	assert.equal(atCont.word, Math.floor(c12 + 3000 * 9 / 16));
	assert.equal(map.matchedParts, 5);
});

test('a chapters 12-13 track followed by a chapter 14 track covers chapter 13', () => {
	const { index } = book([['11', 2000], ['12', 3000], ['13', 2500], ['14', 2000], ['15', 2000]]);
	const w = work([['Chapter 11', 10 * MIN], ['Chapters 12-13', 30 * MIN], ['Chapter 14', 11 * MIN], ['Chapter 15', 11 * MIN]]);
	const map = buildMap(w, index);
	const end = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 1);
	assert.equal(end.word, index.sections[3].wordStart);
	const late = msToWord(map, partStart(w, 1) + 25 * MIN);
	assert.equal(locate(map, late.word).section, 2);
	assert.equal(late.level, 'chapter');
	const c13 = wordToMs(map, index.sections[2].wordStart);
	assert.ok(c13 > partStart(w, 1) && c13 < partStart(w, 2));
});

test('a repeated chapter label matches the tracks in order', () => {
	const { index } = book([['39', 2000], ['40', 2000], ['40', 1500], ['41', 2000]]);
	const w = work([['Chapter 39', 10 * MIN], ['Chapter 40', 10 * MIN], ['Part 05', 5 * MIN], ['Chapter 40', 8 * MIN], ['Chapter 41', 10 * MIN]]);
	const map = buildMap(w, index);
	const first = map.anchors.find((a) => a.kind === 'track-start' && a.partIndex === 1);
	const second = map.anchors.find((a) => a.kind === 'track-start' && a.partIndex === 3);
	assert.equal(first.section, 1);
	assert.equal(second.section, 2);
	assert.deepEqual(map.dropped, []);
});

test('out-of-order matches are dropped by the longest chain and reported', () => {
	const { index } = book([['1', 2000], ['2', 2000], ['3', 2000], ['4', 2000], ['5', 2000]]);
	const w = work([['Chapter 1', 10 * MIN], ['Chapter 2', 10 * MIN], ['Chapter 5', 10 * MIN], ['Chapter 3', 10 * MIN], ['Chapter 4', 10 * MIN]]);
	const map = buildMap(w, index);
	assert.ok(map.dropped.some((d) => d.kind === 'track-start' && d.partIndex === 2), JSON.stringify(map.dropped));
	assert.ok(!map.anchors.some((a) => a.partIndex === 2));
	assert.equal(map.matchedParts, 4);
	for (let k = 1; k < map.anchors.length; k++) assert.ok(map.anchors[k].word >= map.anchors[k - 1].word);
	assert.equal(msToWord(map, partStart(w, 3)).word, index.sections[2].wordStart);
});

test('extra anchors pin the word at their ms', () => {
	const { index } = book([['Prologue', 1000], ['1', 4000], ['2', 5000]]);
	const w = work([['Part 01', H], ['Part 02', H]]);
	const mark = { ms: 40 * MIN, word: 7000 };
	const map = buildMap(w, index, { extraAnchors: [mark] });
	assert.ok(map.anchors.some((a) => a.kind === 'mark' && a.ms === mark.ms && a.word === mark.word));
	assert.equal(msToWord(map, mark.ms).word, 7000);
	assert.equal(msToWord(map, 20 * MIN).word, 3500);
	assert.equal(msToWord(map, 40 * MIN + (80 * MIN) / 2).word, 8500);
});

test('words inside a zero-duration jump map forward to where narration resumes', () => {
	const { index, texts } = book([['1', 3000], ['2', 3000], ['3', 3000]]);
	const w = work([['Chapter 1', 16 * MIN], ['Chapter 2', 16 * MIN], ['Chapter 3', 16 * MIN]]);
	const map = buildMap(w, index, { extraAnchors: [{ ms: partStart(w, 1), word: 4000 }] });
	assert.ok(map.jumps.some((j) => j.ms === partStart(w, 1) && j.fromWord === 3000 && j.toWord === 4000), JSON.stringify(map.jumps));
	const ms = wordToMs(map, 3500);
	assert.equal(msToWord(map, ms).word, 4000);
	const pages = paginate(texts[1]);
	const loc = locate(map, msToWord(map, ms).word);
	assert.equal(loc.section, 1);
	assert.equal(pageAt(pages, loc.wordInSection), pageAt(pages, 1000));
});

test('a word skipped just before an intro track resumes on the next text track, not the intro', () => {
	const { index } = book([['1', 3000], ['2', 3000]]);
	const w = work([['Chapter 1', 16 * MIN], ['Part Two Intro', MIN], ['Chapter 2', 16 * MIN]]);
	const map = buildMap(w, index, { extraAnchors: [{ ms: partStart(w, 2), word: 3500 }] });
	assert.ok(map.segments.some((s) => s.level === 'none' && s.fromMs === partStart(w, 1)));
	const ms = wordToMs(map, 3200);
	assert.ok(ms >= partStart(w, 2), `ms ${ms} is inside the intro`);
	assert.equal(msToWord(map, ms).word, 3500);
});

test('msToWord never floors a fractional anchor one word short', () => {
	const map = { bodyEndWord: 100, segments: [{ fromMs: 0, toMs: 5, fromWord: 0.4, toWord: 1.4, level: 'pace' }] };
	assert.equal(msToWord(map, 3).word, 1);
});

test('play from here returns to the same page for every page start on a chapter-named map', () => {
	const { map, texts } = wokFixture();
	const checked = assertRoundTrip(map, texts);
	assert.ok(checked > 100, `only ${checked} pages checked`);
});

test('play from here returns to the same page on hour splits with float-unfriendly lengths', () => {
	const specs = [['Prologue', 1000]];
	for (let i = 1; i <= 20; i++) specs.push([String(i), 2000 + ((i * 977) % 2500)]);
	const { index, texts } = book(specs, 101);
	const w = work([['Part 01', 3600001], ['Part 02', 3599999], ['Part 03', 3600007], ['Part 04', 1234567], ['Part 05', 3600001]]);
	const map = buildMap(w, index);
	const checked = assertRoundTrip(map, texts);
	assert.ok(checked > 200, `only ${checked} pages checked`);
});

test('isDramatized trusts the publisher when the edition is a narrator name', () => {
	assert.ok(isDramatized({ edition: 'Mara Lindqvist', narrator: 'Mara Lindqvist', publisher: 'GraphicAudio' }));
	assert.ok(!isDramatized({ edition: 'Mara Lindqvist', narrator: 'Mara Lindqvist', publisher: null }));
	assert.ok(isDramatized({ edition: 'Grahpic Audio', narrator: null }));
	assert.ok(isDramatized({ narrator: 'A Full-Cast Production' }));
	assert.ok(isDramatized({ edition: 'Dramatised edition' }));
	assert.ok(!isDramatized({}));
	assert.ok(!isDramatized(null));
	const { map } = wokFixture();
	assert.equal(map.dramatized, false);
	const { index } = book([['1', 1000]]);
	assert.equal(buildMap(work([['Part 01', H]], { publisher: 'GraphicAudio', edition: 'Mara Lindqvist' }), index).dramatized, true);
});

test('buildMap returns null when there is no body or no audio', () => {
	const { index } = book([['Cover', 0], ['Copyright', 30], ['Contents', 40]]);
	assert.equal(buildMap(work([['Part 01', H]]), index), null);
	const { index: real } = book([['1', 1000]]);
	assert.equal(buildMap(work([]), real), null);
	assert.equal(buildMap(work([['Opening Credits', MIN]]), real), null);
	assert.equal(buildMap(work([['Part 01', H]]), null), null);
});

test('locate skips sections with no words', () => {
	const { map, ws, index } = wokFixture();
	assert.deepEqual(locate(map, ws('3. City of Bells')), { section: sectionOf(index, '3. City of Bells'), wordInSection: 0 });
	assert.deepEqual(locate(map, 0), { section: sectionOf(index, 'Title Page'), wordInSection: 0 });
	assert.deepEqual(locate(map, ws('3. City of Bells') - 1).section, sectionOf(index, '2. Honor Is Dead'));
	const last = index.sections[index.sections.length - 1];
	assert.deepEqual(locate(map, 10 ** 9), { section: index.sections.length - 1, wordInSection: last.words - 1 });
});

test('paginate covers every word exactly once and is deterministic', () => {
	const text = gen(2345, 3);
	const pages = paginate(text);
	assert.deepEqual(paginate(text), pages);
	assert.equal(pages[0].startChar, 0);
	assert.equal(pages[0].startWord, 0);
	assert.equal(pages[pages.length - 1].endChar, text.length);
	assert.equal(pages[pages.length - 1].endWord, 2345);
	for (let i = 0; i < pages.length; i++) {
		const p = pages[i];
		if (i) {
			assert.equal(p.startWord, pages[i - 1].endWord);
			assert.equal(p.startChar, pages[i - 1].endChar);
		}
		assert.equal(words(text.slice(p.startChar, p.endChar)).length, p.endWord - p.startWord);
		assert.ok(p.endWord - p.startWord <= 225, `page ${i} has ${p.endWord - p.startWord} words`);
	}
	assert.equal(pages.map((p) => text.slice(p.startChar, p.endChar)).join(''), text);
});

test('paginate prefers paragraph ends and honours maxChars', () => {
	const paras = [];
	for (let i = 0; i < 30; i++) paras.push(`\u201c${gen(60, 50 + i)}\u201d`);
	const text = paras.join('\n');
	const pages = paginate(text);
	const ws = words(text);
	for (const p of pages.slice(0, -1)) {
		const gap = text.slice(ws[p.endWord - 1].end, ws[p.endWord].start);
		assert.ok(gap.includes('\n'), `page ending at word ${p.endWord} split a paragraph`);
	}
	// Closing punctuation stays with its page and an opening quote moves with the next one.
	for (const p of pages) {
		const shown = text.slice(p.startChar, p.endChar).trim();
		assert.ok(shown.startsWith('\u201c') && shown.endsWith('.\u201d'), JSON.stringify(shown.slice(0, 8) + shown.slice(-8)));
	}
	const small = paginate(text, { maxChars: 300 });
	for (const p of small) assert.ok(text.slice(p.startChar, p.endChar).trim().length <= 300);
	assert.ok(small.length > pages.length);
});

test('paginate splits a giant paragraph at sentence ends', () => {
	const text = gen(1000, 9).replace(/\n/g, ' ');
	const pages = paginate(text);
	const ws = words(text);
	assert.ok(pages.length >= 4);
	for (const p of pages.slice(0, -1)) {
		const gap = text.slice(ws[p.endWord - 1].end, ws[p.endWord].start);
		assert.match(gap, /\./, `page ending at word ${p.endWord} split a sentence`);
		assert.ok(text.slice(p.startChar, p.endChar).trim().length <= 1400);
	}
});

test('paginate gives an empty section one empty page', () => {
	assert.deepEqual(paginate(''), [{ startChar: 0, endChar: 0, startWord: 0, endWord: 0 }]);
	assert.deepEqual(paginate('  \n '), [{ startChar: 0, endChar: 4, startWord: 0, endWord: 0 }]);
	assert.equal(paginate('alpha bravo.').length, 1);
});

test('pageAt finds the page holding a word and clamps at the edges', () => {
	const pages = [{ startWord: 0, endWord: 180 }, { startWord: 180, endWord: 360 }, { startWord: 360, endWord: 400 }];
	assert.equal(pageAt(pages, 0), 0);
	assert.equal(pageAt(pages, 179), 0);
	assert.equal(pageAt(pages, 180), 1);
	assert.equal(pageAt(pages, 399), 2);
	assert.equal(pageAt(pages, 10 ** 6), 2);
	assert.equal(pageAt(pages, -5), 0);
	assert.equal(pageAt([], 3), 0);
});

test('qualityAt labels chapter tracks, pace stretches and credits', () => {
	const { w, map } = wokFixture();
	assert.deepEqual(qualityAt(map, partStart(w, 4) + MIN), { level: 'chapter', label: 'chapter-level' });
	assert.deepEqual(qualityAt(map, partStart(w, 8) + MIN), { level: 'pace', label: 'estimated from pace' });
	assert.deepEqual(qualityAt(map, 10 * S), { level: 'none', label: 'no text' });
});

test('words matches the cache tokenizer on tricky strings', () => {
	const cases = [
		['don\u2019t stop-gap 42nd caf\u00e9', 4],
		['\u201cHello,\u201d she said\u2014quietly.', 4],
		['  -- \u2014 ... ', 0],
		['na\u00efve \u65e5\u672c\u8a9e text', 3],
		["'quoted' rock'n'roll", 2],
	];
	for (const [text, n] of cases) assert.equal(words(text).length, n, JSON.stringify(text));
	const ws = words('ab cd');
	assert.deepEqual(ws, [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
	assert.ok(model.WORD_RE.global && model.WORD_RE.unicode);
});

// ---- omnibus ----------------------------------------------------------------------------------

test('bookOfPart reads the book number, its title and the rest of omnibus track titles', () => {
	const table = [
		['1-02 Book 1  The Sword of Testing - Chapter 01a', { number: 1, title: 'The Sword of Testing', rest: 'Chapter 01a' }],
		['1-01 Book 1  The Sword of Testing - Intro', { number: 1, title: 'The Sword of Testing', rest: 'Intro' }],
		['Book 2 - The Queen of Fixtures - Chapter 3', { number: 2, title: 'The Queen of Fixtures', rest: 'Chapter 3' }],
		['Book II: The Queen, Chapter 4', { number: 2, title: 'The Queen', rest: 'Chapter 4' }],
		['Book Three - Chapter 3', { number: 3, title: '', rest: 'Chapter 3' }],
		['05 Book 3, Chapter 12: The Opening', { number: 3, title: '', rest: 'Chapter 12: The Opening' }],
		['Book 1 - A Test - Of Dashes - Chapter 3 - Part 2', { number: 1, title: 'A Test - Of Dashes', rest: 'Chapter 3 - Part 2' }],
		['Book 2 Intro', { number: 2, title: '', rest: 'Intro' }],
		['Book 4 The Candle of Tests', { number: 4, title: 'The Candle of Tests', rest: '' }],
		['The Book Thief - Chapter 1', null],
		['Notebook 3 - Chapter 2', null],
		['Book ii - Chapter 1', null],
		['Book 12a - Chapter 1', null],
		['Chapter 7', null],
	];
	for (const [title, want] of table) assert.deepEqual(bookOfPart(title), want, `bookOfPart(${JSON.stringify(title)})`);
	assert.equal(partKey(bookOfPart('5-02 Book 5  The Book of Extras - Chapter 02').rest), 'c2');
});

// Shaped like a real four-book omnibus edition: book 1's heading section also holds chapter 1, the
// other headings are short, a title page and an author's note sit between books 1 and 2, book 3's
// TOC has no '4' (chapter 4 is printed inside '3'), and book 4 opens with an epigraph whose own
// text stands in for its TOC label. The recording titles book 2 differently and adds a fifth book
// the ebook does not have.
const EPIGRAPH = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike';
const OMNIBUS_SECTIONS = [
	['Title Page', 8],
	['The Sword of Testing', 1500],
	['2', 1200], ['3', 1300], ['4', 1100],
	['The Testing Omnibus', 5],
	['T. Author', 300],
	['The Queen of Fixtures', 30],
	['1', 1000], ['2', 1100], ['3', 900],
	['The Ill-Made Test', 14],
	['1', 800], ['2', 900], ['3', 1600], ['5', 700], ['6', 800],
	['The Candle of Tests', 0],
	[EPIGRAPH, 39],
	['1', 1000], ['2', 1200], ['3', 1100],
];
// [book, title, tracks]: each track is [rest, section it starts in (null: no text), starts mid-section].
const OMNIBUS_AUDIO = [
	[1, 'The Sword of Testing', [['Intro', null], ['Chapter 01a', 1], ['Chapter 01b', 1, true], ['Chapter 02', 2], ['Chapter 03', 3], ['Chapter 04', 4]]],
	[2, 'The Witch in the Glade', [['Intro', null], ['Chapter 01', 8], ['Chapter 02', 9], ['Chapter 03', 10]]],
	[3, 'The Ill-Made Test', [
		['Intro', null], ['Chapter 01', 12], ['Chapter 02', 13], ['Chapter 03', 14],
		['Chapter 04a', 14, true], ['Chapter 04b', 14, true], ['Chapter 05', 15], ['Chapter 06', 16],
	]],
	[4, 'The Candle of Tests', [['Intro', null], ['Chapter 01', 19], ['Chapter 02', 20], ['Chapter 03', 21]]],
	[5, 'The Book of Extras', [['Chapter 01', null], ['Chapter 02', null], ['Chapter 03', null]]],
];

function omnibusFixture() {
	const { index } = book(OMNIBUS_SECTIONS);
	const parts = [];
	const expected = [];
	for (const [n, title, tracks] of OMNIBUS_AUDIO) {
		tracks.forEach(([rest, section, inside = false], k) => {
			const ms = rest === 'Intro' ? MIN : (n === 5 ? 20 : 5) * MIN;
			parts.push([`${n}-${String(k + 1).padStart(2, '0')} Book ${n}  ${title} - ${rest}`, ms]);
			expected.push({ section, inside });
		});
	}
	const w = work(parts, { title: 'The Testing Omnibus' });
	return { index, w, expected, map: buildMap(w, index) };
}

test('every omnibus track starts in its own book\'s chapter though chapter numbers restart', () => {
	const { index, w, expected, map } = omnibusFixture();
	assert.deepEqual(map.dropped, []);
	expected.forEach(({ section, inside }, i) => {
		const at = msToWord(map, partStart(w, i));
		const name = w.parts[i].title;
		if (section === null) {
			assert.equal(at.level, 'none', name);
			return;
		}
		assert.equal(at.level, 'chapter', name);
		assert.equal(locate(map, at.word).section, section, name);
		if (!inside) assert.equal(at.word, index.sections[section].wordStart, name);
	});
});

test('an omnibus keeps title pages and epigraphs unanchored and ends each book at its own last word', () => {
	const { index, map } = omnibusFixture();
	assert.equal(map.bodyStartIndex, 1, 'the heading that holds chapter 1 is body, not front matter');
	assert.equal(map.sections[1].matter, 'body');
	for (const s of [5, 6, 7, 11, 17, 18]) assert.ok(!map.anchors.some((a) => a.section === s), `section ${s} is anchored`);
	const endOfBook1 = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 5);
	assert.equal(endOfBook1.word, index.sections[5].wordStart, 'book 1 ends where its chapter 4 ends');
	assert.ok(!map.segments.some((s) => s.level === 'pace'), 'every text track is pinned to its chapter');
});

test('a recorded book the ebook lacks has no text and never stretches the pace map', () => {
	const { index, w, map } = omnibusFixture();
	const from = partStart(w, w.parts.length - 3);
	assert.equal(msToWord(map, from - 1).level, 'chapter');
	for (const ms of [from, from + 30 * MIN, map.totalMs - 1, map.totalMs]) assert.equal(msToWord(map, ms).level, 'none', `ms ${ms}`);
	const lastText = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === w.parts.length - 4);
	assert.equal(lastText.word, index.totalWords);
	assert.deepEqual(map.books.map((b) => [b.number, b.title, b.ebookTitle]), [
		[1, 'The Sword of Testing', 'The Sword of Testing'],
		[2, 'The Witch in the Glade', 'The Queen of Fixtures'],
		[3, 'The Ill-Made Test', 'The Ill-Made Test'],
		[4, 'The Candle of Tests', 'The Candle of Tests'],
		[5, 'The Book of Extras', null],
	]);
	assert.equal(bookAt(map, from + MIN).number, 5);
	assert.equal(bookAt(map, map.totalMs).number, 5);
	assert.equal(bookAt(map, partStart(w, 7)).number, 2);
	assert.equal(map.matchedParts, 18);
	assert.ok(Math.abs(map.matchedMsShare - 90 / 154) < 1e-9, `share ${map.matchedMsShare}`);
});

// Ebook books are [heading, chapter count, heading holds chapter 1]; recorded books are
// [number, title or '', chapter count]. at(k, c) is the section of ebook book k's chapter c.
function shelf(ebookBooks, audioBooks) {
	const specs = [];
	const starts = [];
	for (const [heading, n, holdsOne = false] of ebookBooks) {
		const row = [];
		if (holdsOne) row[1] = specs.length;
		specs.push([heading, holdsOne ? 1000 : 20]);
		for (let c = holdsOne ? 2 : 1; c <= n; c++) {
			row[c] = specs.length;
			specs.push([String(c), 1000]);
		}
		starts.push(row);
	}
	const { index } = book(specs);
	const parts = [];
	for (const [n, title, count] of audioBooks) {
		for (let c = 1; c <= count; c++) parts.push([`Book ${n} - ${title ? `${title} - ` : ''}Chapter ${c}`, 5 * MIN]);
	}
	const w = work(parts);
	return { index, w, map: buildMap(w, index), at: (k, c) => starts[k][c] };
}

// Expected sections are listed per track, null for a track with no text.
function assertStarts(index, w, map, sections) {
	sections.forEach((s, i) => {
		const at = msToWord(map, partStart(w, i));
		const name = w.parts[i].title;
		if (s === null) {
			assert.equal(at.level, 'none', name);
			return;
		}
		assert.equal(at.level, 'chapter', name);
		assert.equal(at.word, index.sections[s].wordStart, name);
	});
}

test('an ebook book the recording skips is passed over when the title confirms it', () => {
	const { index, w, map } = shelf([['Alpha Test', 2], ['Beta Test', 2], ['Gamma Test', 2]], [[1, 'Alpha Test', 2], [2, 'Gamma Test', 2]]);
	assert.equal(msToWord(map, partStart(w, 2)).word, index.sections[7].wordStart);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Alpha Test', 'Gamma Test']);
	const endOfAlpha = map.anchors.find((a) => a.kind === 'track-end' && a.partIndex === 1);
	assert.equal(endOfAlpha.word, index.sections[3].wordStart);
});

test('a recorded book missing from the middle of the ebook has no text and the next book finds its own', () => {
	const { index, w, map } = shelf([['Alpha Test', 2], ['Beta Test', 2]], [[1, 'Alpha Test', 2], [2, 'Extra Bits', 2], [3, 'Beta Test', 2]]);
	assert.equal(msToWord(map, partStart(w, 2)).level, 'none');
	assert.equal(msToWord(map, partStart(w, 4)).word, index.sections[4].wordStart);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Alpha Test', null, 'Beta Test']);
});

test('tracks naming one book, or an ebook whose numbering never restarts, keep the plain matching', () => {
	assert.equal(shelf([['Alpha Test', 2], ['Beta Test', 2]], [[2, 'Beta Test', 2]]).map.books, undefined);
	const { index } = book([['1', 1000], ['2', 1000], ['3', 1000], ['4', 1000]]);
	const w = work([['Book 1 - Chapter 1', 5 * MIN], ['Book 1 - Chapter 2', 5 * MIN], ['Book 2 - Chapter 3', 5 * MIN], ['Book 2 - Chapter 4', 5 * MIN]]);
	assert.equal(buildMap(w, index).books, undefined);
});

// The bug: books were paired by their order on the recording, so a recording that starts at
// book 2 read book 1's text, and an ebook that starts at book 2 lent it to the recording's book 1.
const FOUR_BOOKS = [['Alpha Test', 3, true], ['Beta Test', 2], ['Gamma Test', 2], ['Delta Test', 2]];

test('a recording that starts at book 2 reads the ebook\'s book 2, titled or not', () => {
	for (const audio of [[[2, '', 2], [3, '', 2]], [[2, 'The Witch Variant', 2], [3, 'Gamma Test', 2]]]) {
		const { index, w, map, at } = shelf(FOUR_BOOKS, audio);
		assertStarts(index, w, map, [at(1, 1), at(1, 2), at(2, 1), at(2, 2)]);
		assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Beta Test', 'Gamma Test']);
	}
});

test('a recording missing a middle book still reads each later book by its number', () => {
	const { index, w, map, at } = shelf(FOUR_BOOKS, [[1, '', 3], [3, '', 2], [4, '', 2]]);
	assertStarts(index, w, map, [at(0, 1), at(0, 2), at(0, 3), at(2, 1), at(2, 2), at(3, 1), at(3, 2)]);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Alpha Test', 'Gamma Test', 'Delta Test']);
});

test('an ebook that starts at book 2 leaves the recording\'s book 1 without text', () => {
	const audio = [[1, 'Alpha Test', 2], [2, 'The Witch Variant', 2], [3, 'Gamma Test', 2], [4, 'Delta Test', 2], [5, 'Extra Bits', 2]];
	const { index, w, map, at } = shelf(FOUR_BOOKS.slice(1), audio);
	assertStarts(index, w, map, [null, null, at(0, 1), at(0, 2), at(1, 1), at(1, 2), at(2, 1), at(2, 2), null, null]);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), [null, 'Beta Test', 'Gamma Test', 'Delta Test', null]);
});

// The bug: an epigraph with a short label right after an empty book heading was taken as that
// book's title, and a later recorded book sharing a word with it took that book's text.
test('an empty book heading keeps its title over the short-label epigraph after it', () => {
	const { index } = book([
		['Alpha Test', 20], ['1', 1000], ['2', 1000],
		['Beta Test', 20], ['1', 1000], ['2', 1000],
		['Gamma Test', 0], ['Extras Speak', 39], ['1', 1000], ['2', 1000],
	]);
	const w = work([1, 2, 3, 4].flatMap((n) => [1, 2].map((c) => [
		`Book ${n} - ${['Alpha Test', 'Beta Test', 'Gamma Test', 'The Book of Extras'][n - 1]} - Chapter ${c}`, 5 * MIN,
	])));
	const map = buildMap(w, index);
	assertStarts(index, w, map, [1, 2, 4, 5, 8, 9, null, null]);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Alpha Test', 'Beta Test', 'Gamma Test', null]);
});

// The bug: a book heading that also holds chapter 1 and runs past the cache's section split
// left its second piece looking like the heading, so chapter 1 fell back to pace.
test('a heading that holds chapter 1 and is split in two pieces is still chapter 1', () => {
	const { index } = book([['Alpha Test', 1500], ['Alpha Test (2)', 800], ['2', 1000], ['Beta Test', 20], ['1', 1000], ['2', 1000]]);
	index.sections[0].part = 1;
	index.sections[1].part = 2;
	const w = work([1, 2].flatMap((n) => [1, 2].map((c) => [`Book ${n} - ${n === 1 ? 'Alpha' : 'Beta'} Test - Chapter ${c}`, 5 * MIN])));
	const map = buildMap(w, index);
	assertStarts(index, w, map, [0, 2, 4, 5]);
	assert.deepEqual(map.books.map((b) => b.ebookTitle), ['Alpha Test', 'Beta Test']);
});

// The bug: hour-split tracks that name three books against a novel whose two Parts restart their
// numbering were read as an omnibus, and the third "book" showed as missing from the ebook.
const RESTARTING_PARTS = [['Part One', 20], ['1', 1000], ['2', 1000], ['Part Two', 20], ['1', 1000], ['2', 1000]];

test('tracks that name books but no chapters keep the plain pace map', () => {
	const { index } = book(RESTARTING_PARTS);
	const w = work([1, 2, 3].map((n) => [`Test Work Book ${n} - 0${n}`, 30 * MIN]));
	const map = buildMap(w, index);
	assert.equal(map.books, undefined);
	assert.ok(map.segments.every((s) => s.level === 'pace'), JSON.stringify(map.segments.map((s) => s.level)));
});

// The bug: "Chapter 3 - Book 2 of Ash" was read as book 2 with no chapter, so every track fell
// back to pace.
test('a chapter title that mentions a book after the chapter number stays a chapter', () => {
	const { index } = book(RESTARTING_PARTS);
	const w = work([['Chapter 1 - Book 1 Lost', 5 * MIN], ['Chapter 2 - Book 2 of Ash', 5 * MIN], ['Chapter 1 - Book 1 Lost', 5 * MIN], ['Chapter 2 - Book 2 of Ash', 5 * MIN]]);
	const map = buildMap(w, index);
	assert.equal(map.books, undefined);
	assertStarts(index, w, map, [1, 2, 4, 5]);
});

test('bookOfPart stops a worded book number at its separator and skips a book named after the chapter', () => {
	assert.deepEqual(bookOfPart('Book One - Two Swords - Chapter 1'), { number: 1, title: 'Two Swords', rest: 'Chapter 1' });
	assert.deepEqual(bookOfPart('Book Three - Seven Knights - Chapter 2'), { number: 3, title: 'Seven Knights', rest: 'Chapter 2' });
	assert.deepEqual(bookOfPart('Book Twenty-One: Chapter 2'), { number: 21, title: '', rest: 'Chapter 2' });
	assert.equal(bookOfPart('Chapter 3 - Book 2 of Ash'), null);
	assert.equal(bookOfPart('04 Ch. 3 - Book 2 of Ash'), null);
});

// c03f827 is the read-along's first release. A work without books on both sides must map exactly
// as it did then, so every map built above is rebuilt with that commit's model and compared.
const BASELINE = 'c03f827';

function baselineDir() {
	try {
		const src = execFileSync('git', ['show', `${BASELINE}:helpers/readAlongModel.js`], {
			cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-baseline-'));
		fs.writeFileSync(path.join(dir, 'readAlongModel.js'), src);
		return dir;
	} catch (_) {
		return null;
	}
}

test('every map without books is byte-for-byte what the first release built', (t) => {
	const dir = baselineDir();
	if (!dir) {
		t.skip(`git cannot show ${BASELINE}`);
		return;
	}
	try {
		const old = require(path.join(dir, 'readAlongModel.js'));
		let compared = 0;
		for (const args of built) {
			const now = model.buildMap(...structuredClone(args));
			if (now && now.books) continue;
			const was = old.buildMap(...structuredClone(args));
			const name = (args[0] && Array.isArray(args[0].parts) ? args[0].parts.map((p) => p.title) : []).join(' | ');
			assert.equal(JSON.stringify(now), JSON.stringify(was), name);
			compared++;
		}
		assert.ok(compared >= 20, `compared ${compared}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
