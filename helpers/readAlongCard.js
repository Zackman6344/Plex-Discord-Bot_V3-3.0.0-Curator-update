// helpers/readAlongCard.js
//
// The read-along's messages: a page of the book (a DM to the listener, or an ephemeral reply to
// the card's 📖), the "no text here" page, and the stubs a page turns into. Pure: plain JSON, no
// discord.js.
//
// The rule the command log depends on: every payload that carries book text carries a row of
// bookpage:* buttons, and nothing else does. helpers/commandLog.js redacts by that row, so a
// payload with text and no row would be written to disk.

const NAMESPACE = 'bookpage';
const ACTS = new Set(['prev', 'next', 'now', 'play', 'off', 'dm', 'mark']);
const SURFACES = new Set(['d', 'e']);
const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const LIMITS = { title: 256, description: 4096, footer: 2048, content: 2000 };
const NO_PINGS = { parse: [] };

const MODE_TEXT = {
	following: 'following the narration',
	browsing: 'browsing: 📍 Now follows again',
	paused: '⏸ paused',
	snapshot: 'only you can see this; 📍 Now shows the latest'
};

const NOTE_TEXT = {
	'text-updated': 'The text was updated; this is where the narration is.'
};

function clip(text, max) {
	const s = String(text);
	if (s.length <= max) return s;
	let out = s.slice(0, max - 1);
	// A cut right after an escape backslash would escape the ellipsis instead.
	if (/(^|[^\\])(\\\\)*\\$/.test(out)) out = out.slice(0, -1);
	return out + '…';
}

// Titles and labels come from file tags and the ebook's own table of contents.
function esc(text) {
	return String(text === null || text === undefined ? '' : text).replace(/([\\*_`~|])/g, '\\$1');
}

// Book text also needs the line-start markdown (quotes, headings, lists) and masked links
// escaped, or a line starting "# " or "> " would render as a heading or a quote.
function escText(text) {
	return esc(text)
		.replace(/[[\]]/g, '\\$&')
		.replace(/^(\s*)([>#-])/gm, '$1\\$2')
		.replace(/^(\s*\d+)\./gm, '$1\\.');
}

function pageText(text) {
	return String(text || '').replace(/\r/g, '').trim().replace(/\s*\n\s*/g, '\n\n');
}

/**
 * customId of a page button: bookpage:<act>:<surface>:<sid>:<tag>:<word, base 36>[:n]. The
 * trailing :n marks the no-text page, whose word is where the text picks up, not a page start.
 */
function pageId({ act, surface, sid, tag, word, none = false }) {
	const w = Math.max(0, Math.floor(Number(word) || 0)).toString(36);
	return `${NAMESPACE}:${act}:${surface}:${sid}:${tag}:${w}${none ? ':n' : ''}`;
}

/** @returns {{ act, surface, sid, tag, word, none? } | null} */
function parsePageId(customId) {
	const m = /^bookpage:([a-z]+):([de]):([0-9a-f]{6}):([0-9a-f]{4}):([0-9a-z]{1,12})(:n)?$/.exec(String(customId || ''));
	if (!m || !ACTS.has(m[1]) || !SURFACES.has(m[2])) return null;
	const word = parseInt(m[5], 36);
	if (!Number.isSafeInteger(word) || word < 0) return null;
	const id = { act: m[1], surface: m[2], sid: m[3], tag: m[4], word };
	if (m[6]) id.none = true;
	return id;
}

function button(customId, label, emoji, style, disabled) {
	const b = { type: 2, style, custom_id: customId, label };
	if (emoji) b.emoji = { name: emoji };
	if (disabled) b.disabled = true;
	return b;
}

function pageRow({ surface, sid, tag, word, none = false, isListener, prevOk = true, nextOk = true }) {
	const id = act => pageId({ act, surface, sid, tag, word, none });
	const list = [
		button(id('prev'), 'Page', '◀️', STYLE.secondary, !prevOk),
		button(id('next'), 'Page', '▶️', STYLE.secondary, !nextOk),
		button(id('now'), 'Now', '📍', STYLE.primary, false)
	];
	// Someone else in the voice channel reads along but never moves the listener's book.
	if (isListener) list.push(button(id('play'), 'Play from here', '↪️', STYLE.secondary, false));
	if (surface === 'd') list.push(button(id('off'), 'Off', '✖️', STYLE.danger, false));
	else if (isListener) list.push(button(id('dm'), 'Follow in DMs', '📩', STYLE.secondary, false));
	return { type: 1, components: list };
}

// The listener's DM page only: 📌 pins the moment the narrator reaches this page's first word,
// which an ephemeral page (a snapshot, perhaps someone else's) has no business setting. A row of
// its own, since the first row already holds Discord's five.
function markRow({ sid, tag, word }) {
	return { type: 1, components: [button(pageId({ act: 'mark', surface: 'd', sid, tag, word }), 'Narrator is here', '📌', STYLE.secondary, false)] };
}

function footerOf({ quality, dramatized, page, pageCount, mode, extra }) {
	const bits = ['≈ Approximate'];
	if (dramatized) bits.push('dramatized edition');
	if (quality && quality.label) bits.push(quality.label);
	if (Number.isFinite(page) && Number.isFinite(pageCount)) bits.push(`page ${page + 1} of ${pageCount}`);
	if (extra) bits.push(extra);
	if (MODE_TEXT[mode]) bits.push(MODE_TEXT[mode]);
	return clip(bits.join(' · '), LIMITS.footer);
}

function titleOf(bookTitle, sectionLabel, sectionNo, sectionCount) {
	const label = String(sectionLabel || '').trim()
		|| (sectionNo > 0 ? `Section ${sectionNo}${sectionCount > 0 ? ` of ${sectionCount}` : ''}` : '');
	return clip(`📖 ${esc(bookTitle || 'Book')}${label ? ` · ${esc(label)}` : ''}`, LIMITS.title);
}

function noteLine(note) {
	return NOTE_TEXT[note] || '';
}

/**
 * One page of the book with its button row.
 * @param {object} o surface 'd' (DM) or 'e' (ephemeral); word is the page's first global word
 */
function pagePayload(o) {
	const embed = {
		color: 0x8e6e53,
		title: titleOf(o.bookTitle, o.sectionLabel, o.sectionNo, o.sectionCount),
		description: clip(escText(pageText(o.text)) || '…', LIMITS.description),
		footer: { text: footerOf(o) }
	};
	return {
		content: noteLine(o.note),
		embeds: [embed],
		components: o.surface === 'd' && o.isListener ? [pageRow(o), markRow(o)] : [pageRow(o)],
		allowedMentions: NO_PINGS
	};
}

/** Where the narration has no text (an intro or outro track, or past the end). */
function noTextPayload(o) {
	// The label is the ebook's own TOC text, so it gets the masked-link escaping book text gets.
	const where = o.resumesAt ? `The text picks up at ${escText(o.resumesAt)}.` : 'The narrated text has ended.';
	// An omnibus recording can hold a book its ebook edition leaves out; its title comes from file tags.
	const what = o.notInEbook
		? `${escText(o.notInEbook)} is not in the ebook, so there is no text for it.`
		: 'No text for this part of the audio (an intro, credits or music).';
	const embed = {
		color: 0x99aab5,
		title: titleOf(o.bookTitle, '', 0, 0),
		description: `🎧 ${what} ${where}`,
		footer: { text: footerOf({ quality: { label: 'no text' }, dramatized: o.dramatized, mode: o.mode }) }
	};
	return {
		content: noteLine(o.note),
		embeds: [embed],
		components: [pageRow(Object.assign({ prevOk: true, nextOk: true }, o, { none: true }))],
		allowedMentions: NO_PINGS
	};
}

function stub(content) {
	return { content: clip(content, LIMITS.content), embeds: [], components: [], allowedMentions: NO_PINGS };
}

function preparingPayload({ bookTitle } = {}) {
	return stub(`⏳ Preparing the text of ${esc(bookTitle || 'this book')} (first time only)…`);
}

function endedStub({ bookTitle } = {}) {
	return stub(bookTitle ? `📕 ${esc(bookTitle)}: the book stopped, so this page did too.` : '📕 This book is no longer playing.');
}

function offStub({ prefix = '!' } = {}) {
	return stub(`📕 Read-along is off. \`${prefix}book text on\` turns it back on.`);
}

function movedStub() {
	return stub('📖 This page moved ↓');
}

/** A reason the page cannot be shown (no ebook, Calibre closed); never any book text. */
function noticePayload(text) {
	return stub(text || 'There is no text for this book.');
}

module.exports = {
	NAMESPACE,
	pagePayload,
	noTextPayload,
	preparingPayload,
	endedStub,
	offStub,
	movedStub,
	noticePayload,
	pageId,
	parsePageId,
	escText
};
