// helpers/bookChapterLabel.js
//
// The words the card puts on the chapter playing. helpers/bookModel.js chapters() makes every part
// without embedded chapters one chapter, so its numbers count files: "Chapter 240 of 319" on an
// omnibus whose track says Book 4, Chapter 7. This module reads the track (or embedded chapter)
// title with the read-along's own parsers and says what it names, falling back to the file's place.
//
// The slot numbers stay what `!book chapter <n>` jumps to; only the words shown change.
//
// Pure and cheap: it runs on every card render, on the bot's main thread. It never opens a text:
// a read-along map is used only when the caller already holds one.

const model = require('./readAlongModel.js');

const NAMES = {
	prologue: 'Prologue',
	prelude: 'Prelude',
	epilogue: 'Epilogue',
	endnote: 'Endnotes',
	postscript: 'Postscript',
	afterword: 'Afterword',
	'ars-arcanum': 'Ars Arcanum'
};

// GraphicAudio's chapter and track names: STORMLIGHT0402P01, MURDERBOTDIARIES01P02, STORMLIGHTEDGEP01.
const CODE_RE = /^[A-Z]{3,}\d*P\d{2,}$/;
const EPISODE_RE = /\b(?:ep|episode)\.?\s*(\d+)/i;
const LEADING_NUMBER_RE = /^[\s\d:._\-]+/;
const NOISE = new Set(['part', 'pt', 'chapter', 'chap', 'ch', 'track', 'disc', 'cd', 'ep', 'episode', 'section', 'book', 'the', 'of', 'a', 'an', 'and']);
const SEP = ' · ';

const commonCache = new WeakMap();

/** A read-along key ('c21', 'i3-1', 'prologue') as words, or null. */
function keyLabel(key) {
	if (!key) return null;
	let m = /^c(\d+)$/.exec(key);
	if (m) return `Chapter ${m[1]}`;
	m = /^i(\d+)(?:-(\d+))?$/.exec(key);
	if (m) return m[2] ? `Interlude ${m[1]}-${m[2]}` : `Interlude ${m[1]}`;
	if (key === 'i') return 'Interlude';
	return NAMES[key] || null;
}

function tokens(text) {
	return String(text ?? '').toLowerCase().replace(/['’]/g, '').match(/\p{L}+|\p{N}+/gu) || [];
}

function isNumber(tok) {
	return /^\p{N}+$/u.test(tok);
}

// Words every track title of the work shares ("WBN WWW Childrens Adventure ep3") say nothing
// about one track. Cached per parts array: the catalog replaces the array when a work changes.
function commonWords(work) {
	const parts = Array.isArray(work && work.parts) ? work.parts : [];
	if (commonCache.has(parts)) return commonCache.get(parts);
	let common = new Set();
	if (parts.length >= 2) {
		parts.forEach((p, i) => {
			const own = new Set(tokens(String((p && p.title) || '').replace(LEADING_NUMBER_RE, '')).filter(t => !isNumber(t)));
			common = i === 0 ? own : new Set([...common].filter(t => own.has(t)));
		});
	}
	commonCache.set(parts, common);
	return common;
}

/**
 * Whether a raw title says something the label does not. "07.The Final Empire" on Part 7 of The
 * Final Empire, "Endymion 01" on Part 1, "Fall of Hyperion 46: Epilogue" under "Epilogue" add
 * nothing; "outro", "[01-02]" and "The Soldier's Tale 03" do. At most one number may be left, and
 * only the slot's own: two numbers ("[01-01]") are a reference the label does not carry.
 */
function addsToLabel(raw, short, work, slot) {
	const text = String(raw ?? '').trim();
	if (!text) return false;
	const known = new Set([...NOISE, ...tokens(work && work.title), ...tokens(work && work.series), ...tokens(short), ...commonWords(work)]);
	const left = tokens(text.replace(LEADING_NUMBER_RE, '')).filter(t => !(known.has(t) && !isNumber(t)));
	if (left.some(t => !isNumber(t))) return true;
	// "of 19" is a count: a track titled 19 on part 7 is not saying "part 7".
	const own = tokens(String(short).replace(/\bof \d+/g, '')).filter(isNumber).map(Number);
	const rest = left.map(Number);
	for (const n of own) {
		const i = rest.indexOf(n);
		if (i >= 0) rest.splice(i, 1);
	}
	if (rest.length !== 1) return rest.length > 1;
	// A leftover slot number repeats the label only when the label did not already show it:
	// "Glass Tide 03: Epilogue" on part 3, but not "[01-01]" on Part 1.
	return rest[0] !== slot || own.includes(slot);
}

function result(short, detail) {
	const d = detail ? String(detail).trim() : '';
	return { label: d ? `${short}${SEP}${d}` : short, short, detail: d || null };
}

// The ebook section playing, as a chapter key's words. Only the key: the card is public and the
// read-along's text is private, so a heading's own words never reach it.
function mapSection(map, ms) {
	if (!map || !Number.isFinite(ms) || !Array.isArray(map.sections)) return null;
	const at = model.msToWord(map, ms);
	if (!at || at.level === 'none' || model.inNoText(map, ms)) return null;
	const loc = model.locate(map, at.word);
	const sec = loc ? map.sections[loc.section] : null;
	return sec && sec.matter === 'body' ? keyLabel(sec.key) : null;
}

/**
 * The card's words for one chapter slot.
 *
 * - an embedded chapter with a recognisable name: "Chapter 21", "Prologue", "Interlude 3";
 * - an embedded chapter with a GraphicAudio code title: "Part 13 of 31 · Section 1 of 6";
 * - a podcast: "Episode 3 of 8";
 * - a track naming a book: "Book 4 · Chapter 7 · The Candle in the Wind";
 * - a track naming a chapter: "Chapter 21";
 * - otherwise "Part 7 of 19", with the track title after it when it adds anything.
 *
 * When the caller holds a read-along map for this work and the title names no chapter, the map's
 * section at `ms` fills it in ("Part 7 of 19 · Chapter 12"). A title that names one wins: it is
 * exact, where the map between two named tracks is an estimate from pace.
 *
 * @param {object} work catalog work
 * @param {{ number: number, title: string, partIndex: number, embedded: boolean }} ch the slot
 * @param {object[]} chs bookModel.chapters(work)
 * @param {{ map?: object, ms?: number }} [opts]
 * @returns {{ label: string, short: string, detail: string|null }} `short` is the label without
 *   the free-text title, for the one-line forms; `label` is short plus detail
 */
function chapterLabel(work, ch, chs, { map = null, ms = NaN } = {}) {
	const parts = Array.isArray(work && work.parts) ? work.parts : [];
	const part = parts[ch.partIndex] || {};
	const partTitle = String(part.title || '');
	const podcast = work && work.kind === 'podcast';
	const opts = { workTitle: (work && work.title) || '' };
	const slot = ch.partIndex + 1;
	const episode = () => {
		const m = EPISODE_RE.exec(partTitle);
		return m ? Number(m[1]) : slot;
	};
	const place = podcast ? `Episode ${episode()} of ${parts.length}` : `Part ${slot} of ${parts.length}`;
	const fromMap = () => (podcast ? null : mapSection(map, ms));
	const withMap = (short) => {
		const sec = fromMap();
		return sec ? `${short}${SEP}${sec}` : short;
	};

	if (ch.embedded) {
		const inPart = (chs || []).filter(c => c.partIndex === ch.partIndex);
		const k = inPart.findIndex(c => c.number === ch.number) + 1;
		const title = String(ch.title || '');
		const generated = title === `${partTitle || `Part ${part.ordinal || slot}`} · ${k}`;
		const named = generated ? null : keyLabel(model.labelKey(title));
		if (named) return result(named, addsToLabel(title, named, work, k) ? title : null);
		const prefix = parts.length > 1 || podcast ? `${place}${SEP}` : '';
		const short = withMap(`${prefix}${CODE_RE.test(title) ? 'Section' : 'Chapter'} ${k} of ${inPart.length}`);
		const detail = generated || CODE_RE.test(title) || !addsToLabel(title, short, work, k) ? null : title;
		return result(short, detail);
	}

	if (podcast) return result(place, addsToLabel(partTitle, place, work, episode()) ? partTitle : null);

	const book = model.bookOfPart(partTitle, opts);
	const named = keyLabel(model.partKey(book ? book.rest : partTitle, opts));
	if (book) {
		let short = `Book ${book.number}`;
		if (named) short += `${SEP}${named}`;
		else short = withMap(short);
		return result(short, book.title || null);
	}
	if (named) return result(named, addsToLabel(partTitle, named, work, slot) ? partTitle : null);
	const short = withMap(place);
	return result(short, CODE_RE.test(partTitle) || !addsToLabel(partTitle, short, work, slot) ? null : partTitle);
}

module.exports = { chapterLabel, keyLabel };
