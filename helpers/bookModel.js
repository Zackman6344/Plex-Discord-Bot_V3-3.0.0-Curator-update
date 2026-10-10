// helpers/bookModel.js
//
// The arithmetic of a book: where a millisecond of a work falls among its parts, its chapters,
// where a bookmark lands after the library was rebuilt, how the end of a part's stream is read,
// where /book play starts, and the speed, sleep and goto inputs.
//
// Pure on purpose (no discord.js, no app/bot.js, no fs), so the engine's hard decisions are
// tested in milliseconds. Positions are absolute ms from the start of the work unless named
// `partMs`. Part lengths are Plex's `durationMs`, which can overstate the file by a few seconds;
// classifyPartEnd is the one place that absorbs it.
//
// The work's own `totalMs` is never read: everything uses the sum of the part durations, so a
// work whose parts were reordered or re-keyed in memory can never disagree with itself.

// A stream that ends this close to its part's end is the part ending.
const NATURAL_SLACK_MS = 5000;
// A bookmark this close to its part's end resumes at the next part instead of replaying a
// sliver of the old one (and lands a caught-up podcast on its first new episode).
const PART_END_SLACK_MS = 5000;
const SHORT_ATTEMPT_MS = 2000;
const SAME_SPOT_MS = 2000;
const FAILURE_OUTPUT_MS = 10000;
const FAILURE_WINDOW_MS = 120000;
const FAILURE_LIMIT = 3;
const NEAR_END_MS = 120000;
const PREV_CHAPTER_GRACE_MS = 3000;
// Jumps stop a second short of the end, so a forward jump plays something and ends naturally
// instead of building a resource with nothing left to read.
const END_GUARD_MS = 1000;
const GROWN_MS = 60000;
const REWIND_GAP_MS = 5 * 60 * 1000;
const REWIND_LONG_GAP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REWIND_SECONDS = 10;
const MAX_REWIND_SECONDS = 120;

// The /book speed choices. Every value is inside a single ffmpeg atempo's 0.5-100 range.
const SPEEDS = Object.freeze([0.75, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.25, 2.5, 3]);
const SPEED_CYCLE = Object.freeze([1, 1.1, 1.25, 1.5, 1.75, 2]);
const SLEEP_CYCLE = Object.freeze(['off', 15, 30, 60, 'chapter']);

function clamp(n, lo, hi) {
	if (!Number.isFinite(n)) return lo;
	return Math.min(hi, Math.max(lo, n));
}

function durationOf(part) {
	const d = part && part.durationMs;
	return Number.isFinite(d) && d > 0 ? d : 0;
}

function partsOf(work) {
	return work && Array.isArray(work.parts) ? work.parts : [];
}

function baseName(file) {
	if (typeof file !== 'string' || !file) return null;
	return file.split(/[\\/]+/).filter(Boolean).pop() || null;
}

/**
 * Cumulative offsets of a work's parts.
 * @returns {{ parts: { startMs: number, endMs: number, durationMs: number }[], totalMs: number }}
 */
function layout(work) {
	const parts = [];
	let at = 0;
	for (const p of partsOf(work)) {
		const durationMs = durationOf(p);
		parts.push({ startMs: at, endMs: at + durationMs, durationMs });
		at += durationMs;
	}
	return { parts, totalMs: at };
}

function totalMs(work) {
	return layout(work).totalMs;
}

function lastPlayableIndex(parts) {
	for (let i = parts.length - 1; i >= 0; i--) if (parts[i].durationMs > 0) return i;
	return parts.length - 1;
}

function locateIn(lay, absMs) {
	const { parts } = lay;
	if (!parts.length) return { partIndex: 0, partMs: 0 };
	const ms = clamp(absMs, 0, lay.totalMs);
	// Zero-length parts are skipped here because no `ms` is below their end.
	for (let i = 0; i < parts.length; i++) {
		if (ms < parts[i].endMs) return { partIndex: i, partMs: ms - parts[i].startMs };
	}
	const last = lastPlayableIndex(parts);
	return { partIndex: last, partMs: parts[last].durationMs };
}

/**
 * The part an absolute position falls in. A position on a boundary belongs to the later part
 * (at 0); the very end of the work is the last part at its full duration.
 * @returns {{ partIndex: number, partMs: number }}
 */
function locate(work, absMs) {
	return locateIn(layout(work), absMs);
}

function partStartMs(work, i) {
	const lay = layout(work);
	if (i < 0) return 0;
	return lay.parts[i] ? lay.parts[i].startMs : lay.totalMs;
}

function partEndMs(work, i) {
	const lay = layout(work);
	if (i < 0) return 0;
	return lay.parts[i] ? lay.parts[i].endMs : lay.totalMs;
}

/**
 * Where a jump may land: never before the start, and a second short of the end.
 */
function clampTarget(work, absMs) {
	const total = totalMs(work);
	return clamp(absMs, 0, Math.max(0, total - END_GUARD_MS));
}

function partLabel(part, i) {
	return (part && part.title) || `Part ${(part && part.ordinal) || i + 1}`;
}

// Returns part-relative chapters, or null when the part has none worth showing. Plex reports
// mp3 "Marker N" points as chapters with start == end; build-catalog stretches those to the next
// point and flags them `chapterKind: 'markers'`, so both shapes are dropped here.
function embeddedChapters(part, partIndex, durationMs) {
	if (!part || part.chapterKind === 'markers' || !Array.isArray(part.chapters)) return null;
	const real = part.chapters
		.filter(c => c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs && c.startMs < durationMs)
		.sort((a, b) => a.startMs - b.startMs);
	if (real.length < 2) return null;
	const out = [];
	for (const c of real) {
		// The first chapter owns the part's opening seconds, so no position falls into a gap
		// that chapterAt would attribute to the previous part.
		const startMs = out.length ? c.startMs : 0;
		if (out.length && startMs <= out[out.length - 1].startMs) continue;
		out.push({ title: c.title || c.tag || `${partLabel(part, partIndex)} · ${out.length + 1}`, startMs });
	}
	return out.length < 2 ? null : out;
}

/**
 * The work's chapter list: a part's embedded chapters when it has real ones, else the part
 * itself. Every part end is a chapter end, which is what lets the Idle handler alone decide a
 * chapter-sleep at a part boundary.
 * @returns {{ number: number, title: string, startMs: number, endMs: number, partIndex: number, embedded: boolean }[]}
 */
function chapters(work) {
	const lay = layout(work);
	const raw = partsOf(work);
	const out = [];
	raw.forEach((part, i) => {
		const { startMs, endMs, durationMs } = lay.parts[i];
		if (durationMs <= 0) return;
		const inner = embeddedChapters(part, i, durationMs);
		if (!inner) {
			out.push({ title: partLabel(part, i), startMs, endMs, partIndex: i, embedded: false });
			return;
		}
		inner.forEach((c, k) => {
			const next = inner[k + 1];
			out.push({ title: c.title, startMs: startMs + c.startMs, endMs: next ? startMs + next.startMs : endMs, partIndex: i, embedded: true });
		});
	});
	return out.map((c, i) => ({ number: i + 1, ...c }));
}

function chapterIndexAt(chs, ms) {
	let lo = 0;
	let hi = chs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (chs[mid].startMs <= ms) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

function chapterAt(work, absMs) {
	const chs = chapters(work);
	if (!chs.length) return null;
	return chs[chapterIndexAt(chs, clamp(absMs, 0, totalMs(work)))];
}

/**
 * The chapter after the one playing, or null on the last chapter: skipping past the end never
 * finishes a work.
 */
function nextChapter(work, absMs) {
	const chs = chapters(work);
	if (!chs.length) return null;
	const i = chapterIndexAt(chs, clamp(absMs, 0, totalMs(work)));
	return chs[i + 1] || null;
}

/**
 * Media-player "previous": more than 3 s into a chapter goes back to its start, otherwise to
 * the previous chapter (the first chapter's start when there is none).
 */
function prevChapter(work, absMs) {
	const chs = chapters(work);
	if (!chs.length) return null;
	const ms = clamp(absMs, 0, totalMs(work));
	const i = chapterIndexAt(chs, ms);
	if (ms - chs[i].startMs > PREV_CHAPTER_GRACE_MS) return chs[i];
	return chs[i - 1] || chs[i];
}

/**
 * The part hint a bookmark stores next to `absoluteMs`, so a rebuild that reorders or re-keys
 * parts still finds the same file.
 */
function hintFor(work, absMs) {
	const raw = partsOf(work);
	if (!raw.length) return null;
	const { partIndex, partMs } = locate(work, absMs);
	const p = raw[partIndex];
	return {
		ordinal: p.ordinal,
		file: baseName(p.file),
		sizeBytes: p.sizeBytes,
		durationMs: p.durationMs,
		trackRatingKey: p.trackRatingKey,
		partMs
	};
}

const sameKey = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
const sameSize = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null
	&& Number.isFinite(Number(a)) && Number(a) === Number(b);

/**
 * Where a bookmark lands in the work as it is now. First unique match wins:
 * 'track' (trackRatingKey and file basename), 'file-size', 'file', then 'absolute' (absoluteMs
 * mapped onto the current parts, which survives an m4b re-ripped as mp3s). A spot within 5 s of
 * its part's end then moves to the next part at 0.
 * @returns {{ absMs: number, partIndex: number, partMs: number, tier: string, advanced: boolean }}
 */
function resolveBookmark(work, mark) {
	const lay = layout(work);
	const raw = partsOf(work);
	if (!raw.length) return { absMs: 0, partIndex: 0, partMs: 0, tier: 'none', advanced: false };
	const hint = mark && mark.hint;
	let tier = 'absolute';
	let found = -1;
	if (hint && Number.isFinite(hint.partMs)) {
		const file = baseName(hint.file);
		const tiers = [
			['track', p => sameKey(p.trackRatingKey, hint.trackRatingKey) && baseName(p.file) === file],
			['file-size', p => baseName(p.file) === file && sameSize(p.sizeBytes, hint.sizeBytes)],
			['file', p => baseName(p.file) === file]
		];
		// Basenames repeat inside a work (interleaved volumes each restart at 01.mp3), so only a
		// unique hit counts; an ambiguous one falls through to absoluteMs.
		for (const [name, match] of file ? tiers : []) {
			const hits = [];
			raw.forEach((p, i) => { if (match(p)) hits.push(i); });
			if (hits.length === 1) {
				tier = name;
				found = hits[0];
				break;
			}
		}
	}
	let partIndex;
	let partMs;
	if (found >= 0) {
		partIndex = found;
		partMs = clamp(hint.partMs, 0, lay.parts[found].durationMs);
	} else {
		({ partIndex, partMs } = locateIn(lay, Number(mark && mark.absoluteMs)));
	}
	let advanced = false;
	const here = lay.parts[partIndex];
	if (partIndex < lastPlayableIndex(lay.parts) && partMs >= here.durationMs - PART_END_SLACK_MS) {
		({ partIndex, partMs } = locateIn(lay, here.endMs));
		advanced = true;
	}
	return { absMs: lay.parts[partIndex].startMs + partMs, partIndex, partMs, tier, advanced };
}

/**
 * The first part the work did not have when it was finished, or null when the mark cannot tell.
 * A mark keeps only its last part, so the old parts are known only when that part's album alone
 * adds up to the length the work had then.
 */
function startOfAddedParts(work, mark, landed) {
	if (landed.tier === 'absolute' || landed.tier === 'none') return null;
	const raw = partsOf(work);
	const album = raw[landed.partIndex] && raw[landed.partIndex].albumRatingKey;
	if (album === undefined || album === null) return null;
	const isOld = (p) => sameKey(p.albumRatingKey, album);
	const lay = layout(work);
	const oldMs = lay.parts.reduce((sum, p, i) => sum + (isOld(raw[i]) ? p.durationMs : 0), 0);
	if (Math.abs(oldMs - Number(mark.absoluteMs)) > PART_END_SLACK_MS) return null;
	const first = raw.findIndex((p, i) => !isOld(p) && lay.parts[i].durationMs > 0);
	if (first < 0) return null;
	return {
		absMs: lay.parts[first].startMs, partIndex: first, partMs: 0, tier: landed.tier, mode: 'new-material',
		clearFinished: true, rewind: false, newParts: raw.filter((p) => !isOld(p)).length
	};
}

/**
 * Where /book play starts. Modes: 'from-start', 'new' (no bookmark), 'resume', 'new-material'
 * (a finished work that grew: lands on the first new part), 'restart' (finished: from 0).
 * `clearFinished` says the caller should clear `finished` (finishedCount is kept); `rewind`
 * says the resume rewind applies (never at 0 or at the start of new material).
 */
function resumeStart(work, mark, { fromStart = false } = {}) {
	const finished = !!(mark && mark.finished);
	const at0 = (mode) => ({ absMs: 0, partIndex: locate(work, 0).partIndex, partMs: 0, tier: 'none', mode, clearFinished: finished, rewind: false, newParts: 0 });
	const from = (mode, clearFinished) => {
		const r = resolveBookmark(work, mark);
		return {
			absMs: r.absMs, partIndex: r.partIndex, partMs: r.partMs, tier: r.tier, mode, clearFinished,
			rewind: mode === 'resume',
			newParts: mode === 'new-material' ? Math.max(0, partsOf(work).length - r.partIndex) : 0
		};
	};
	if (fromStart) return at0('from-start');
	if (!mark) return at0('new');
	if (!finished) return from('resume', false);
	const total = totalMs(work);
	const abs = Number(mark.absoluteMs);
	if (!Number.isFinite(abs)) return at0('restart');
	// markFinished leaves the hint at its part's end. A finished mark whose hint is mid-part was
	// moved by a goto after finishing, and that is a revisit, not new material.
	const hint = mark.hint;
	const hintAtEnd = !!hint && Number.isFinite(hint.partMs) && Number.isFinite(hint.durationMs)
		&& hint.partMs >= hint.durationMs - PART_END_SLACK_MS;
	if (total > abs + GROWN_MS && (hintAtEnd || !hint)) {
		const grown = from('new-material', true);
		if (grown.absMs < total - END_GUARD_MS) return grown;
		// The new parts sorted ahead of the part the work ended on, and starting there would
		// finish the work again with none of them played.
		return startOfAddedParts(work, mark, grown) || at0('restart');
	}
	if (abs >= total - END_GUARD_MS) return at0('restart');
	// A save that landed a few seconds short of the end after markFinished must not turn a
	// finished book into "resume and hear the last 3 s"; only a place in an earlier part, or
	// mid-way through the last one, is a revisit.
	const lay = layout(work);
	if (hintAtEnd && resolveBookmark(work, mark).partIndex === lastPlayableIndex(lay.parts)) return at0('restart');
	return from('resume', false);
}

/**
 * How far to step back when resuming after a gap, so the listener hears the last sentence
 * again: nothing for 5 min or less, `rewindSeconds` after that, three times it after a day.
 */
function resumeRewindMs(gapMs, rewindSeconds) {
	const raw = typeof rewindSeconds === 'string' && rewindSeconds.trim() !== '' ? Number(rewindSeconds) : rewindSeconds;
	const seconds = Number.isFinite(raw) ? clamp(raw, 0, MAX_REWIND_SECONDS) : DEFAULT_REWIND_SECONDS;
	if (!Number.isFinite(gapMs) || gapMs <= REWIND_GAP_MS) return 0;
	return seconds * 1000 * (gapMs > REWIND_LONG_GAP_MS ? 3 : 1);
}

/**
 * Within two minutes of the end. Only offers the ended card's "Mark finished": no stop
 * finishes a work by itself, because any window would finish books nobody heard to the end.
 */
function nearEnd(work, absMs) {
	const total = totalMs(work);
	if (total <= 0 || !Number.isFinite(absMs)) return false;
	return total - absMs <= NEAR_END_MS;
}

/**
 * Reads why a part's stream stopped and what the engine does next.
 *
 * input: { eos, startAbs, endAbs, partEndAbs, outputMs, lastAttempt: { startAbs, outputMs, eos } | null,
 *   partDurationMs, isLastPart, sleepAtChapterEnd, recentFailures: number[], now }
 *
 * Returns { action, reason, failures }: action is 'next-part' | 'finish-work' | 'sleep-stop' |
 * 'retry' | 'park-failing'. `failures` is the new failure-timestamp list; the caller stores it
 * in place of the old one (the input array is never mutated).
 */
function classifyPartEnd(input) {
	const i = input || {};
	const now = Number.isFinite(i.now) ? i.now : 0;
	const failures = (Array.isArray(i.recentFailures) ? i.recentFailures : [])
		.filter(t => Number.isFinite(t) && now - t < FAILURE_WINDOW_MS);
	const eos = !!i.eos;
	const outputMs = Number.isFinite(i.outputMs) ? i.outputMs : 0;
	// Left NaN when missing, so an incomplete report can never compare as "at the end".
	const endAbs = Number.isFinite(i.endAbs) ? i.endAbs : NaN;
	const partEndAbs = Number.isFinite(i.partEndAbs) ? i.partEndAbs : NaN;
	const startAbs = Number.isFinite(i.startAbs) ? i.startAbs : NaN;

	// Audio is flowing again, so earlier failures say nothing about Plex any more.
	const natural = (reason) => ({
		action: i.isLastPart ? 'finish-work' : i.sleepAtChapterEnd ? 'sleep-stop' : 'next-part',
		reason,
		failures: []
	});

	if (eos && endAbs >= partEndAbs - NATURAL_SLACK_MS) return natural('end-of-stream');

	// The same spot ending twice at once is the file itself ending there. Near the end that is
	// Plex overstating the duration (the part is over); anywhere earlier the file is cut short,
	// and skipping it would silently drop the rest of the part.
	const last = i.lastAttempt;
	const repeatedShortEos = eos && outputMs < SHORT_ATTEMPT_MS
		&& !!last && !!last.eos && Number.isFinite(last.outputMs) && last.outputMs < SHORT_ATTEMPT_MS
		&& Number.isFinite(last.startAbs) && Math.abs(startAbs - last.startAbs) <= SAME_SPOT_MS;
	if (repeatedShortEos) {
		const durationMs = Number.isFinite(i.partDurationMs) && i.partDurationMs > 0 ? i.partDurationMs : 0;
		const slack = Math.max(10000, durationMs * 0.01);
		if (endAbs >= partEndAbs - slack) return natural('overstated-duration');
		return { action: 'park-failing', reason: 'file-ends-early', failures };
	}

	if (outputMs < FAILURE_OUTPUT_MS) failures.push(now);
	if (failures.length >= FAILURE_LIMIT) return { action: 'park-failing', reason: 'plex-failing', failures: [] };
	return { action: 'retry', reason: eos ? 'ended-early' : 'stalled', failures };
}

/**
 * The card's speed button: the next step of SPEED_CYCLE above `x`, wrapping to 1x. A speed
 * set from /book speed that is not on the cycle steps to the next one above it.
 */
function nextSpeed(x) {
	const n = Number(x);
	if (!Number.isFinite(n)) return SPEED_CYCLE[0];
	const next = SPEED_CYCLE.find(s => s > n + 1e-9);
	return next === undefined ? SPEED_CYCLE[0] : next;
}

// A timer's step comes from `minutes` when the session kept it; from `remainingMs` alone a
// half-run 30 min timer would read as 15 and the button would step back to 30.
function sleepStep(current) {
	if (current === null || current === undefined || current === 'off') return 'off';
	if (current === 'chapter') return 'chapter';
	if (typeof current === 'object') {
		if (current.mode === 'chapter') return 'chapter';
		if (current.mode !== 'timer') return 'off';
		const m = Number(current.minutes);
		if (Number.isFinite(m) && m > 0) return m;
		const r = Number(current.remainingMs);
		return Number.isFinite(r) && r > 0 ? Math.ceil(r / 60000) : 'off';
	}
	const n = Number(current);
	return Number.isFinite(n) && n > 0 ? n : 'off';
}

/**
 * The card's sleep button: off, 15, 30, 60 min, end of chapter, off. Takes a SLEEP_CYCLE value,
 * a number of minutes, or a session sleep object ({ mode: 'timer', minutes?, remainingMs } or
 * { mode: 'chapter' }); returns a SLEEP_CYCLE value.
 */
function nextSleep(current) {
	const step = sleepStep(current);
	if (step === 'chapter') return 'off';
	const timers = SLEEP_CYCLE.filter(v => typeof v === 'number');
	if (step === 'off') return timers[0];
	const next = timers.find(m => m > step);
	return next === undefined ? 'chapter' : next;
}

/**
 * The time grammar of !seek's parseToMilliseconds (commands/seek.js): "90" seconds, "1:30"
 * m:ss, "1:23:45" h:mm:ss, "1h30m15s". Stricter where that one guesses: the whole text must
 * match ("1mabc" and "" are refused, not 60 s and NaN), seconds and the minutes of h:mm:ss
 * must be under 60, and "1.5" is 1500 ms rather than parseInt's 1000. A typo in a 37-hour book
 * should be refused, not mapped somewhere plausible.
 * @returns {number|null} milliseconds, or null when it is not a duration
 */
function parseDuration(text) {
	if (typeof text !== 'string' && typeof text !== 'number') return null;
	const s = String(text).trim();
	if (!s) return null;
	let m = s.match(/^(\d+(?:\.\d+)?)$/);
	if (m) return Math.round(Number(m[1]) * 1000);
	m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
	if (m) {
		const [a, b, c] = [m[1], m[2], m[3]].map(x => (x === undefined ? undefined : Number(x)));
		if (c === undefined) return b < 60 ? (a * 60 + b) * 1000 : null;
		return b < 60 && c < 60 ? (a * 3600 + b * 60 + c) * 1000 : null;
	}
	m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i);
	if (m && (m[1] || m[2] || m[3])) {
		return ((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0)) * 1000;
	}
	return null;
}

/**
 * /book goto: a bare time is absolute in the work, a leading + or - makes it relative.
 * @returns {{ mode: 'absolute' | 'relative', ms: number } | null} `ms` is signed when relative
 */
function parseGoto(text) {
	if (typeof text !== 'string' && typeof text !== 'number') return null;
	const s = String(text).trim();
	const sign = s[0] === '+' ? 1 : s[0] === '-' ? -1 : 0;
	const ms = parseDuration(sign ? s.slice(1) : s);
	if (ms === null) return null;
	return sign ? { mode: 'relative', ms: sign * ms } : { mode: 'absolute', ms };
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * "15:12:40", or "12:30" under an hour. `withHours` forces the hour field on or off, so a
 * position and a total on one line can share a shape.
 */
function formatClock(ms, withHours) {
	const s = Math.floor(clamp(ms, 0, Number.MAX_SAFE_INTEGER) / 1000);
	const h = Math.floor(s / 3600);
	const showHours = withHours === undefined ? h > 0 : !!withHours;
	if (showHours) return `${h}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
	return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/**
 * A length in words: "37 h 05 m", "31 min", "45 s".
 */
function formatSpan(ms) {
	const s = Math.floor(clamp(ms, 0, Number.MAX_SAFE_INTEGER) / 1000);
	if (s >= 3600) return `${Math.floor(s / 3600)} h ${pad2(Math.floor(s / 60) % 60)} m`;
	if (s >= 60) return `${Math.floor(s / 60)} min`;
	return `${s} s`;
}

/**
 * Floors, so the bar is only full when the work is.
 */
function progressBar(fraction, cells = 20) {
	const n = Number.isInteger(cells) && cells > 0 ? cells : 20;
	const filled = Math.floor(clamp(fraction, 0, 1) * n);
	return '█'.repeat(filled) + '░'.repeat(n - filled);
}

module.exports = {
	layout,
	totalMs,
	locate,
	partStartMs,
	partEndMs,
	clampTarget,
	chapters,
	chapterAt,
	nextChapter,
	prevChapter,
	hintFor,
	resolveBookmark,
	resumeStart,
	resumeRewindMs,
	nearEnd,
	classifyPartEnd,
	SPEEDS,
	SPEED_CYCLE,
	nextSpeed,
	SLEEP_CYCLE,
	nextSleep,
	parseDuration,
	parseGoto,
	formatClock,
	formatSpan,
	progressBar
};
