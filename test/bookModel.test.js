// helpers/bookModel.js: part layout, chapters, bookmark resolution, the part-end classifier,
// where /book play starts, and the speed, sleep and goto inputs.
//
// The bug: every book decision the engine makes is arithmetic over a work's parts, and each
// wrong answer is silent in a live session. A -30 s at a part boundary that does not cross back
// replays the wrong file; a bookmark resolved by ordinal after a rebuild resumes in another
// file; a file cut off an hour early that reads as a natural end skips the rest of the part; a
// finished podcast that restarts at episode 1 instead of its new episode; a stop 11 minutes
// before the end that counts as finished.
//
// Harness: the plain pure-function style of test/seek.test.js. The fixtures are synthetic
// reconstructions of the catalog's shapes (interleaved volumes that share basenames, an m4b
// with embedded chapters, mp3 "Marker" points, a podcast that gains an episode), not library data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../helpers/bookModel.js');
const {
	layout, locate, partStartMs, partEndMs, clampTarget, chapters, chapterAt, nextChapter, prevChapter,
	hintFor, resolveBookmark, resumeStart, resumeRewindMs, nearEnd, classifyPartEnd,
	SPEEDS, SPEED_CYCLE, nextSpeed, SLEEP_CYCLE, nextSleep, parseDuration, parseGoto,
	formatClock, formatSpan, progressBar
} = model;

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

function part(ordinal, durationMs, extra) {
	return Object.assign({
		ordinal,
		albumRatingKey: '900',
		trackRatingKey: String(5000 + ordinal),
		title: `Part ${ordinal}`,
		durationMs,
		partKey: `/library/parts/${7000 + ordinal}/1/file.mp3`,
		file: `0${ordinal} - Part.mp3`,
		sizeBytes: 40000000 + ordinal,
		container: 'mp3'
	}, extra || {});
}

function work(parts, extra) {
	return Object.assign({
		id: 'some-author/a-synthetic-book',
		kind: 'book',
		title: 'A Synthetic Book',
		author: 'Some Author',
		parts,
		totalMs: parts.reduce((s, p) => s + p.durationMs, 0)
	}, extra || {});
}

// 20, 30 and 40 minutes: distinct lengths, so an offset taken from the wrong part shows.
const threeParts = () => work([part(1, 20 * MIN), part(2, 30 * MIN), part(3, 40 * MIN)]);

function chapteredWork() {
	return work([
		part(1, 60 * MIN, {
			file: 'Volume 1.m4b',
			container: 'm4b',
			chapters: [
				{ title: 'Arrival', startMs: 35 * MIN, endMs: 60 * MIN },
				{ title: 'Opening', startMs: 1500, endMs: 10 * MIN },
				{ title: 'Blip', startMs: 20 * MIN, endMs: 20 * MIN },
				{ title: 'The Road', startMs: 10 * MIN, endMs: 35 * MIN }
			]
		}),
		part(2, 10 * MIN, {
			chapterKind: 'markers',
			chapters: [{ tag: 'Marker 1', startMs: 0, endMs: 5 * MIN }, { tag: 'Marker 2', startMs: 5 * MIN, endMs: 10 * MIN }]
		}),
		part(3, 20 * MIN, { file: 'Volume 2.m4b', chapters: [{ title: 'Only one', startMs: 0, endMs: 20 * MIN }] }),
		part(4, 10 * MIN, {
			chapters: [{ tag: 'Marker 1', startMs: 0, endMs: 0 }, { tag: 'Marker 2', startMs: 5 * MIN, endMs: 5 * MIN }]
		})
	]);
}

// ---- layout and locate ------------------------------------------------------------------------

test('layout gives each part its cumulative start and the work its total', () => {
	const lay = layout(threeParts());
	assert.deepStrictEqual(lay.parts.map(p => [p.startMs, p.endMs]), [[0, 20 * MIN], [20 * MIN, 50 * MIN], [50 * MIN, 90 * MIN]]);
	assert.strictEqual(lay.totalMs, 90 * MIN);
	assert.strictEqual(partStartMs(threeParts(), 2), 50 * MIN);
	assert.strictEqual(partEndMs(threeParts(), 1), 50 * MIN);
});

test('layout sums the parts and ignores a stale work totalMs', () => {
	const w = threeParts();
	w.totalMs = 12345;
	assert.strictEqual(layout(w).totalMs, 90 * MIN);
});

test('locate maps inside, on a boundary, at the end and out of range', () => {
	const w = threeParts();
	assert.deepStrictEqual(locate(w, 25 * MIN), { partIndex: 1, partMs: 5 * MIN });
	assert.deepStrictEqual(locate(w, 20 * MIN), { partIndex: 1, partMs: 0 });
	assert.deepStrictEqual(locate(w, 90 * MIN), { partIndex: 2, partMs: 40 * MIN });
	assert.deepStrictEqual(locate(w, -5 * S), { partIndex: 0, partMs: 0 });
	assert.deepStrictEqual(locate(w, 500 * H), { partIndex: 2, partMs: 40 * MIN });
	assert.deepStrictEqual(locate(w, NaN), { partIndex: 0, partMs: 0 });
});

test('back 30 s from 10 s into a part lands 20 s before the end of the previous part', () => {
	const w = threeParts();
	const at = partStartMs(w, 2) + 10 * S;
	assert.deepStrictEqual(locate(w, at - 30 * S), { partIndex: 1, partMs: 30 * MIN - 20 * S });
});

test('a zero-length part is never located', () => {
	const w = work([part(1, 10 * MIN), part(2, 0), part(3, 10 * MIN), part(4, 0)]);
	assert.deepStrictEqual(locate(w, 10 * MIN), { partIndex: 2, partMs: 0 });
	assert.deepStrictEqual(locate(w, 20 * MIN), { partIndex: 2, partMs: 10 * MIN });
});

test('clampTarget keeps jumps inside the work and a second short of its end', () => {
	const w = threeParts();
	assert.strictEqual(clampTarget(w, -10 * S), 0);
	assert.strictEqual(clampTarget(w, 95 * MIN), 90 * MIN - S);
	assert.strictEqual(clampTarget(w, 30 * MIN), 30 * MIN);
	assert.strictEqual(clampTarget(work([]), 5 * S), 0);
});

// ---- chapters ---------------------------------------------------------------------------------

test('chapters split embedded chapters, drop markers and zero-length entries, and fall back to parts', () => {
	const chs = chapters(chapteredWork());
	assert.deepStrictEqual(chs.map(c => [c.number, c.title, c.startMs, c.endMs, c.partIndex, c.embedded]), [
		[1, 'Opening', 0, 10 * MIN, 0, true],
		[2, 'The Road', 10 * MIN, 35 * MIN, 0, true],
		[3, 'Arrival', 35 * MIN, 60 * MIN, 0, true],
		[4, 'Part 2', 60 * MIN, 70 * MIN, 1, false],
		[5, 'Part 3', 70 * MIN, 90 * MIN, 2, false],
		[6, 'Part 4', 90 * MIN, 100 * MIN, 3, false]
	]);
});

test('the last embedded chapter ends where its part ends', () => {
	const w = chapteredWork();
	w.parts[0].chapters = [{ title: 'A', startMs: 0, endMs: 10 * MIN }, { title: 'B', startMs: 10 * MIN, endMs: 50 * MIN }];
	const chs = chapters(w);
	assert.strictEqual(chs[1].endMs, partEndMs(w, 0));
});

test('chapterAt finds the chapter, including the opening seconds before the first embedded start', () => {
	const w = chapteredWork();
	assert.strictEqual(chapterAt(w, 500).number, 1);
	assert.strictEqual(chapterAt(w, 10 * MIN).number, 2);
	assert.strictEqual(chapterAt(w, 65 * MIN).number, 4);
	assert.strictEqual(chapterAt(w, 100 * MIN).number, 6);
	assert.strictEqual(chapterAt(work([]), 0), null);
});

test('nextChapter crosses from a single-chapter part to the next part and is null on the last', () => {
	const w = chapteredWork();
	assert.strictEqual(nextChapter(w, 5 * MIN).number, 2);
	assert.strictEqual(nextChapter(w, 65 * MIN).startMs, 70 * MIN);
	assert.strictEqual(nextChapter(w, 95 * MIN), null);
});

test('prevChapter goes to the chapter start after 3 s and to the previous chapter within them', () => {
	const w = chapteredWork();
	assert.strictEqual(prevChapter(w, 10 * MIN + 3001).number, 2);
	assert.strictEqual(prevChapter(w, 10 * MIN + 3000).number, 1);
	assert.strictEqual(prevChapter(w, 10 * MIN).number, 1);
	assert.strictEqual(prevChapter(w, 2 * S).number, 1);
	assert.strictEqual(prevChapter(w, 70 * MIN + 1000).number, 4);
});

// ---- bookmarks --------------------------------------------------------------------------------

function markAt(w, absMs, extra) {
	return Object.assign({ absoluteMs: absMs, hint: hintFor(w, absMs), finished: false }, extra || {});
}

test('hintFor records the part identity and the offset inside it', () => {
	const w = threeParts();
	assert.deepStrictEqual(hintFor(w, 25 * MIN), {
		ordinal: 2, file: '02 - Part.mp3', sizeBytes: 40000002, durationMs: 30 * MIN, trackRatingKey: '5002', partMs: 5 * MIN
	});
	assert.strictEqual(hintFor(w, 90 * MIN).partMs, 40 * MIN);
	assert.strictEqual(hintFor(work([]), 0), null);
});

test('resolve tier 1: a reorder keeps the place inside the same file', () => {
	const w = threeParts();
	const mark = markAt(w, 25 * MIN);
	const reordered = work([w.parts[1], w.parts[0], w.parts[2]]);
	const r = resolveBookmark(reordered, mark);
	assert.strictEqual(r.tier, 'track');
	assert.deepStrictEqual([r.partIndex, r.partMs, r.absMs], [0, 5 * MIN, 5 * MIN]);
});

test('resolve tier 2: a re-import that changes rating keys matches basename and size', () => {
	const w = threeParts();
	const mark = markAt(w, 55 * MIN);
	const reimported = work(w.parts.map(p => Object.assign({}, p, { trackRatingKey: String(Number(p.trackRatingKey) + 90000) })));
	const r = resolveBookmark(reimported, mark);
	assert.strictEqual(r.tier, 'file-size');
	assert.strictEqual(r.absMs, 55 * MIN);
});

test('resolve tier 3: a re-tagged file matches on a unique basename alone', () => {
	const w = threeParts();
	const mark = markAt(w, 55 * MIN);
	const retagged = work(w.parts.map(p => Object.assign({}, p, { trackRatingKey: 'x' + p.trackRatingKey, sizeBytes: p.sizeBytes + 512 })));
	retagged.parts.unshift(part(9, 15 * MIN, { file: 'Intro.mp3', trackRatingKey: '9999' }));
	const r = resolveBookmark(retagged, mark);
	assert.strictEqual(r.tier, 'file');
	assert.deepStrictEqual([r.partIndex, r.partMs], [3, 5 * MIN]);
});

test('resolve tier 4: an m4b re-ripped as mp3s maps absoluteMs onto the new parts', () => {
	const m4b = work([part(1, 90 * MIN, { file: 'Whole Book.m4b', container: 'm4b', trackRatingKey: '4000' })]);
	const mark = markAt(m4b, 55 * MIN);
	const r = resolveBookmark(threeParts(), mark);
	assert.strictEqual(r.tier, 'absolute');
	assert.deepStrictEqual([r.partIndex, r.partMs, r.absMs], [2, 5 * MIN, 55 * MIN]);
});

test('a basename shared by interleaved volumes is ambiguous and falls through to absoluteMs', () => {
	const volumes = work([
		part(1, 10 * MIN, { file: '01.mp3', sizeBytes: 100 }),
		part(2, 10 * MIN, { file: '01.mp3', sizeBytes: 100 }),
		part(3, 10 * MIN, { file: '02.mp3', sizeBytes: 300 })
	]);
	const mark = { absoluteMs: 14 * MIN, hint: { file: '01.mp3', sizeBytes: 100, trackRatingKey: 'gone', partMs: 2 * MIN } };
	const r = resolveBookmark(volumes, mark);
	assert.strictEqual(r.tier, 'absolute');
	assert.deepStrictEqual([r.partIndex, r.partMs], [1, 4 * MIN]);
});

test('a hint stored with a full path still matches the basename', () => {
	const w = threeParts();
	const mark = markAt(w, 25 * MIN);
	mark.hint.file = 'M:/Music/Some Author/A Synthetic Book/02 - Part.mp3';
	assert.strictEqual(resolveBookmark(w, mark).tier, 'track');
	mark.hint.file = 'M:\\Music\\Some Author\\A Synthetic Book\\02 - Part.mp3';
	assert.strictEqual(resolveBookmark(w, mark).tier, 'track');
});

test('a place within 5 s of its part end starts the next part at 0, except on the last part', () => {
	const w = threeParts();
	const near = resolveBookmark(w, markAt(w, 50 * MIN - 4 * S));
	assert.deepStrictEqual([near.partIndex, near.partMs, near.advanced], [2, 0, true]);
	const notNear = resolveBookmark(w, markAt(w, 50 * MIN - 6 * S));
	assert.deepStrictEqual([notNear.partIndex, notNear.advanced], [1, false]);
	const last = resolveBookmark(w, markAt(w, 90 * MIN - 2 * S));
	assert.deepStrictEqual([last.partIndex, last.partMs, last.advanced], [2, 40 * MIN - 2 * S, false]);
});

test('a mark without a usable hint or position resolves to the start', () => {
	const w = threeParts();
	assert.strictEqual(resolveBookmark(w, { absoluteMs: 25 * MIN }).absMs, 25 * MIN);
	assert.strictEqual(resolveBookmark(w, { absoluteMs: NaN, hint: { file: '02 - Part.mp3' } }).absMs, 0);
	assert.strictEqual(resolveBookmark(w, null).absMs, 0);
	assert.deepStrictEqual(resolveBookmark(work([]), markAt(w, 5 * MIN)), { absMs: 0, partIndex: 0, partMs: 0, tier: 'none', advanced: false });
});

// ---- classifyPartEnd --------------------------------------------------------------------------

const NOW = 10 * H;
function end(extra) {
	return Object.assign({
		eos: true,
		startAbs: 50 * MIN,
		endAbs: 90 * MIN,
		partEndAbs: 90 * MIN,
		outputMs: 40 * MIN,
		lastAttempt: null,
		partDurationMs: 40 * MIN,
		isLastPart: false,
		sleepAtChapterEnd: false,
		recentFailures: [],
		now: NOW
	}, extra || {});
}

test('a stream that ends within 5 s of the part end is natural and advances', () => {
	assert.deepStrictEqual(classifyPartEnd(end({ endAbs: 90 * MIN - 4 * S })), { action: 'next-part', reason: 'end-of-stream', failures: [] });
});

test('a natural end of the last part finishes the work, and that wins over a chapter sleep', () => {
	assert.strictEqual(classifyPartEnd(end({ isLastPart: true, sleepAtChapterEnd: true })).action, 'finish-work');
});

test('a natural end with sleep at end of chapter stops instead of advancing', () => {
	assert.strictEqual(classifyPartEnd(end({ sleepAtChapterEnd: true })).action, 'sleep-stop');
});

test('two short EOS at the same spot near the end is an overstated duration, not a loop', () => {
	const spot = 90 * MIN - 9 * S;
	const v = classifyPartEnd(end({
		startAbs: spot, endAbs: spot + 300, outputMs: 300,
		lastAttempt: { startAbs: spot - 500, outputMs: 0, eos: true },
		recentFailures: [NOW - 2 * S]
	}));
	assert.deepStrictEqual(v, { action: 'next-part', reason: 'overstated-duration', failures: [] });
});

test('the overstated-duration window grows to 1% of a long part', () => {
	const partDurationMs = 2 * H;
	const spot = 90 * MIN - 60 * S;
	const input = {
		startAbs: spot, endAbs: spot, outputMs: 0, partDurationMs,
		lastAttempt: { startAbs: spot, outputMs: 0, eos: true }
	};
	assert.strictEqual(classifyPartEnd(end(input)).action, 'next-part');
	assert.strictEqual(classifyPartEnd(end(Object.assign({}, input, { partDurationMs: 40 * MIN }))).action, 'park-failing');
});

test('two short EOS one hour into a two-hour part parks with file-ends-early, never skips or finishes', () => {
	const spot = 1 * H;
	const v = classifyPartEnd(end({
		startAbs: spot, endAbs: spot + 200, partEndAbs: 2 * H, partDurationMs: 2 * H, outputMs: 200,
		isLastPart: true, sleepAtChapterEnd: true,
		lastAttempt: { startAbs: spot, outputMs: 100, eos: true }
	}));
	assert.strictEqual(v.action, 'park-failing');
	assert.strictEqual(v.reason, 'file-ends-early');
});

test('two short EOS more than 2 s apart are two failures, not a file that ends there', () => {
	const v = classifyPartEnd(end({
		startAbs: 60 * MIN, endAbs: 60 * MIN + 300, outputMs: 300,
		lastAttempt: { startAbs: 60 * MIN - 2500, outputMs: 300, eos: true },
		recentFailures: [NOW - S]
	}));
	assert.deepStrictEqual(v, { action: 'retry', reason: 'ended-early', failures: [NOW - S, NOW] });
});

test('one short EOS far from the end retries and counts a failure', () => {
	const v = classifyPartEnd(end({ startAbs: 60 * MIN, endAbs: 60 * MIN + 500, outputMs: 500 }));
	assert.deepStrictEqual(v, { action: 'retry', reason: 'ended-early', failures: [NOW] });
});

test('an early EOS after real playback retries without counting a failure', () => {
	const v = classifyPartEnd(end({ startAbs: 50 * MIN, endAbs: 70 * MIN, outputMs: 20 * MIN }));
	assert.deepStrictEqual(v, { action: 'retry', reason: 'ended-early', failures: [] });
});

test('a stall with no EOS is early even at the part end', () => {
	const v = classifyPartEnd(end({ eos: false, endAbs: 90 * MIN - S, outputMs: 3 * S }));
	assert.deepStrictEqual(v, { action: 'retry', reason: 'stalled', failures: [NOW] });
});

test('a stream error or probe failure that produced nothing retries and counts a failure', () => {
	const v = classifyPartEnd({ eos: false, startAbs: 60 * MIN, endAbs: 60 * MIN, partEndAbs: 90 * MIN, outputMs: 0, now: NOW });
	assert.deepStrictEqual(v, { action: 'retry', reason: 'stalled', failures: [NOW] });
});

test('the third failure within two minutes parks, older failures age out', () => {
	const failing = end({ eos: false, endAbs: 60 * MIN, outputMs: 0 });
	const parked = classifyPartEnd(Object.assign({}, failing, { recentFailures: [NOW - 100 * S, NOW - 50 * S] }));
	assert.deepStrictEqual(parked, { action: 'park-failing', reason: 'plex-failing', failures: [] });
	const aged = classifyPartEnd(Object.assign({}, failing, { recentFailures: [NOW - 121 * S, NOW - 50 * S] }));
	assert.deepStrictEqual(aged, { action: 'retry', reason: 'stalled', failures: [NOW - 50 * S, NOW] });
});

test('classifyPartEnd never mutates the failure list it is given', () => {
	const recentFailures = [NOW - 10 * S];
	classifyPartEnd(end({ eos: false, endAbs: 60 * MIN, outputMs: 0, recentFailures }));
	assert.deepStrictEqual(recentFailures, [NOW - 10 * S]);
});

test('a report missing the part end is never natural', () => {
	assert.strictEqual(classifyPartEnd({ eos: true, endAbs: 90 * MIN, outputMs: 40 * MIN, now: NOW }).action, 'retry');
	assert.strictEqual(classifyPartEnd(undefined).action, 'retry');
});

// ---- nearEnd and resumeStart ------------------------------------------------------------------

test('nearEnd is true at 119 s from the end and false at 121 s', () => {
	const w = threeParts();
	assert.strictEqual(nearEnd(w, 90 * MIN - 119 * S), true);
	assert.strictEqual(nearEnd(w, 90 * MIN - 120 * S), true);
	assert.strictEqual(nearEnd(w, 90 * MIN - 121 * S), false);
	assert.strictEqual(nearEnd(work([]), 0), false);
});

test('resumeStart from-start and with no bookmark begin at 0', () => {
	const w = threeParts();
	assert.deepStrictEqual(
		[resumeStart(w, markAt(w, 30 * MIN), { fromStart: true }).absMs, resumeStart(w, markAt(w, 30 * MIN), { fromStart: true }).mode],
		[0, 'from-start']
	);
	const none = resumeStart(w, null);
	assert.deepStrictEqual([none.absMs, none.mode, none.rewind, none.clearFinished], [0, 'new', false, false]);
	assert.strictEqual(resumeStart(w, markAt(w, 90 * MIN, { finished: true }), { fromStart: true }).clearFinished, true);
});

test('resumeStart resumes an unfinished book at its resolved bookmark with rewind', () => {
	const w = threeParts();
	const r = resumeStart(w, markAt(w, 33 * MIN));
	assert.deepStrictEqual([r.absMs, r.mode, r.tier, r.rewind, r.clearFinished], [33 * MIN, 'resume', 'track', true, false]);
});

function finishedMark(w) {
	return { absoluteMs: layout(w).totalMs, hint: hintFor(w, layout(w).totalMs), finished: true, finishedCount: 1 };
}

test('resumeStart restarts a finished book from 0', () => {
	const w = threeParts();
	const r = resumeStart(w, finishedMark(w));
	assert.deepStrictEqual([r.absMs, r.mode, r.clearFinished, r.rewind], [0, 'restart', true, false]);
});

test('resumeStart resumes a finished book moved back by goto to five minutes before the end', () => {
	const w = threeParts();
	const mark = Object.assign(markAt(w, 90 * MIN - 5 * MIN), { finished: true, finishedCount: 1 });
	const r = resumeStart(w, mark);
	assert.deepStrictEqual([r.absMs, r.mode, r.clearFinished], [85 * MIN, 'resume', false]);
});

test('resumeStart lands a caught-up podcast on its one new episode', () => {
	const ep = (n, mins) => part(n, mins * MIN, { title: `Episode ${n}`, file: `Episode ${n}.mp3`, trackRatingKey: String(8000 + n) });
	const before = work([ep(1, 50), ep(2, 60), ep(3, 55)], { id: 'some-show/the-campaign', kind: 'podcast' });
	const mark = finishedMark(before);
	const after = work([ep(1, 50), ep(2, 60), ep(3, 55), ep(4, 70)], { id: 'some-show/the-campaign', kind: 'podcast' });
	const r = resumeStart(after, mark);
	assert.deepStrictEqual([r.absMs, r.partIndex, r.partMs, r.mode, r.newParts, r.clearFinished, r.rewind],
		[165 * MIN, 3, 0, 'new-material', 1, true, false]);
});

// The bug: a podcast's next campaign, numbered from ep1 again, sorted in among the old episodes,
// so the old last episode was still last. 'new-material' resolved the finished mark to the very
// end of the work: /book play played nothing and marked the podcast finished again.
const campaignEp = (n, mins, album, name) => part(n, mins * MIN, {
	albumRatingKey: album, title: `${name} ep${n}`, file: `${name} ep${n}.mp3`, trackRatingKey: `${album}${n}`
});

test('resumeStart starts a grown podcast on its first new episode when the new ones sort before its last', () => {
	const old = (n, mins) => campaignEp(n, mins, '900', 'Old');
	const fresh = (n, mins) => campaignEp(n, mins, '901', 'New');
	const before = work([old(1, 50), old(2, 60), old(3, 55)], { id: 'some-show/the-show', kind: 'podcast' });
	const mark = finishedMark(before);
	const after = work([old(1, 50), fresh(1, 40), old(2, 60), fresh(2, 45), old(3, 55)], { id: 'some-show/the-show', kind: 'podcast' });
	const r = resumeStart(after, mark);
	assert.deepStrictEqual([r.absMs, r.partIndex, r.partMs, r.mode, r.newParts, r.clearFinished, r.rewind],
		[50 * MIN, 1, 0, 'new-material', 2, true, false]);
});

test('resumeStart restarts a grown podcast that would start at its end when the mark cannot tell the new parts', () => {
	const before = work([campaignEp(1, 50, '900', 'Old'), campaignEp(2, 60, '900', 'Old'), campaignEp(3, 55, '902', 'Extra')],
		{ id: 'some-show/the-show', kind: 'podcast' });
	const mark = finishedMark(before);
	const after = work([...before.parts.slice(0, 2), campaignEp(1, 40, '901', 'New'), before.parts[2]], { id: 'some-show/the-show', kind: 'podcast' });
	const r = resumeStart(after, mark);
	assert.deepStrictEqual([r.absMs, r.mode, r.clearFinished], [0, 'restart', true]);
});

test('resumeStart restarts a finished book whose last save landed seconds short of the end', () => {
	const w = threeParts();
	const mark = Object.assign(markAt(w, 90 * MIN - 3 * S), { finished: true, finishedCount: 1 });
	assert.strictEqual(resumeStart(w, mark).mode, 'restart');
});

test('resumeStart resumes a finished book moved back into an earlier part', () => {
	const w = threeParts();
	const mark = Object.assign(markAt(w, 30 * MIN), { finished: true, finishedCount: 1 });
	const r = resumeStart(w, mark);
	assert.deepStrictEqual([r.absMs, r.mode, r.clearFinished, r.rewind], [30 * MIN, 'resume', false, true]);
});

test('resumeStart restarts a finished mark whose position is unreadable', () => {
	const w = threeParts();
	assert.strictEqual(resumeStart(w, { finished: true, absoluteMs: undefined }).mode, 'restart');
});

test('resumeRewindMs: none up to 5 min, the setting after, three times it after a day', () => {
	assert.strictEqual(resumeRewindMs(5 * MIN, 10), 0);
	assert.strictEqual(resumeRewindMs(5 * MIN + 1, 10), 10 * S);
	assert.strictEqual(resumeRewindMs(24 * H, 10), 10 * S);
	assert.strictEqual(resumeRewindMs(24 * H + 1, 10), 30 * S);
	assert.strictEqual(resumeRewindMs(NaN, 10), 0);
	assert.strictEqual(resumeRewindMs(H, 0), 0);
	assert.strictEqual(resumeRewindMs(H, undefined), 10 * S);
	assert.strictEqual(resumeRewindMs(H, '20'), 20 * S);
	assert.strictEqual(resumeRewindMs(H, 999), 120 * S);
});

// ---- speed, sleep, goto -----------------------------------------------------------------------

test('the speed cycle steps up through its values and wraps to 1x', () => {
	const seen = [];
	let x = 1;
	for (let k = 0; k < SPEED_CYCLE.length; k++) {
		x = nextSpeed(x);
		seen.push(x);
	}
	assert.deepStrictEqual(seen, [1.1, 1.25, 1.5, 1.75, 2, 1]);
	assert.strictEqual(nextSpeed(1.2), 1.25);
	assert.strictEqual(nextSpeed(0.75), 1);
	assert.strictEqual(nextSpeed(3), 1);
	assert.strictEqual(nextSpeed('1.25'), 1.5);
	assert.strictEqual(nextSpeed('fast'), 1);
});

test('every cycle speed is an allowed speed and the list is frozen', () => {
	for (const s of SPEED_CYCLE) assert.ok(SPEEDS.includes(s), `${s} missing from SPEEDS`);
	assert.ok(Object.isFrozen(SPEEDS) && Object.isFrozen(SPEED_CYCLE) && Object.isFrozen(SLEEP_CYCLE));
});

test('the sleep cycle goes off, 15, 30, 60, chapter, off', () => {
	assert.deepStrictEqual(SLEEP_CYCLE, ['off', 15, 30, 60, 'chapter']);
	const seen = [];
	let v = 'off';
	for (let k = 0; k < 5; k++) {
		v = nextSleep(v);
		seen.push(v);
	}
	assert.deepStrictEqual(seen, [15, 30, 60, 'chapter', 'off']);
	assert.strictEqual(nextSleep(null), 15);
	assert.strictEqual(nextSleep({ mode: 'chapter' }), 'off');
	assert.strictEqual(nextSleep({ mode: 'timer', minutes: 30, remainingMs: 4 * MIN }), 60);
	assert.strictEqual(nextSleep({ mode: 'timer', remainingMs: 20 * MIN }), 30);
	assert.strictEqual(nextSleep(90), 'chapter');
	assert.strictEqual(nextSleep(5), 15);
});

test('parseGoto reads absolute times and signed relative ones', () => {
	assert.deepStrictEqual(parseGoto('1:23:45'), { mode: 'absolute', ms: (1 * 3600 + 23 * 60 + 45) * S });
	assert.deepStrictEqual(parseGoto('+5m'), { mode: 'relative', ms: 5 * MIN });
	assert.deepStrictEqual(parseGoto('-90'), { mode: 'relative', ms: -90 * S });
	assert.deepStrictEqual(parseGoto(' 12:30 '), { mode: 'absolute', ms: 12 * MIN + 30 * S });
	assert.deepStrictEqual(parseGoto('2h5m'), { mode: 'absolute', ms: 2 * H + 5 * MIN });
	assert.deepStrictEqual(parseGoto('- 1m30s'), { mode: 'relative', ms: -90 * S });
	assert.deepStrictEqual(parseGoto('0'), { mode: 'absolute', ms: 0 });
});

test('parseGoto refuses garbage instead of guessing', () => {
	for (const bad of ['', '   ', 'abc', '+', '-', '1mabc', '1:2', '1:75', '1:60:00', '0x10', '1e3', '+-5', '5 m 3', null, undefined, {}]) {
		assert.strictEqual(parseGoto(bad), null, `accepted ${JSON.stringify(bad)}`);
	}
});

test('parseDuration takes the back and forward prefix forms', () => {
	assert.strictEqual(parseDuration('90'), 90 * S);
	assert.strictEqual(parseDuration('1:30'), 90 * S);
	assert.strictEqual(parseDuration('2m'), 2 * MIN);
	assert.strictEqual(parseDuration('1.5'), 1500);
	assert.strictEqual(parseDuration(45), 45 * S);
	assert.strictEqual(parseDuration('-5'), null);
});

// ---- formatting -------------------------------------------------------------------------------

test('formatClock and formatSpan render positions and lengths', () => {
	assert.strictEqual(formatClock((15 * 3600 + 12 * 60 + 40) * S + 999), '15:12:40');
	assert.strictEqual(formatClock(12 * MIN + 30 * S), '12:30');
	assert.strictEqual(formatClock(45 * MIN, true), '0:45:00');
	assert.strictEqual(formatClock(-5), '0:00');
	assert.strictEqual(formatClock(NaN), '0:00');
	assert.strictEqual(formatSpan(37 * H + 5 * MIN + 3 * S), '37 h 05 m');
	assert.strictEqual(formatSpan(31 * MIN + 59 * S), '31 min');
	assert.strictEqual(formatSpan(45 * S), '45 s');
});

test('progressBar fills by floor so only a finished work shows a full bar', () => {
	assert.strictEqual(progressBar(0), '░'.repeat(20));
	assert.strictEqual(progressBar(0.41), '█'.repeat(8) + '░'.repeat(12));
	assert.strictEqual(progressBar(0.999), '█'.repeat(19) + '░');
	assert.strictEqual(progressBar(1), '█'.repeat(20));
	assert.strictEqual(progressBar(2, 10), '█'.repeat(10));
	assert.strictEqual(progressBar(NaN, 5), '░'.repeat(5));
});

// ---- purity -----------------------------------------------------------------------------------

test('the model requires nothing, so it never pulls in discord.js, app/bot.js or fs', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'bookModel.js'), 'utf8');
	assert.doesNotMatch(src, /\brequire\s*\(/);
});
