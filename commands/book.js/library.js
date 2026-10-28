// /book shelf, library, stats and leaderboard: read-only views of the catalog and the bookmark
// store. Nothing here touches Plex or voice.

const bookModel = require('../../helpers/bookModel.js');
const { chapterLabel } = require('../../helpers/bookChapterLabel.js');
const { renderBoard } = require('../../helpers/leaderboard.js');
const { esc } = require('../../helpers/bookCard.js');
const bookCatalog = require('../../helpers/bookCatalog.js');
const bookSearch = require('../../helpers/bookSearch.js');
const bookSections = require('../../helpers/bookSections.js');
const libraryButtons = require('../../helpers/bookLibraryButtons.js');

const CHUNK = 1900;
const EMBED_MAX = 4096;
const CUSTOM_ID_MAX = 100;
const SHOWN_FINISHED = 10;
const COLOR = 0x2ecc71;

const EMPTY_SHELF = 'Your shelf is empty. `/book library` lists the books; `/book play <title>` starts one.';
const READING = '📚 The audiobook library is being read (about 20 s). Try again in a moment.';

function stores() {
	return {
		bookmarks: require('../../helpers/bookmarks.js'),
		catalog: require('../../helpers/bookCatalogStore.js')
	};
}

function hours(ms) {
	return `${((ms || 0) / 3600000).toFixed(1)} h`;
}

function sec(ms) {
	return Math.round(ms / 1000);
}

function clip(text, max) {
	const s = String(text);
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function edition(work) {
	return work && work.edition ? ` (${esc(work.edition)})` : '';
}

// The short form: the shelf line has room for where you are, not for the track's own title.
function chapterShort(work, ch) {
	const chs = bookModel.chapters(work);
	try {
		return chapterLabel(work, ch, chs).short;
	} catch (_) {
		return `Ch ${ch.number} of ${chs.length}`;
	}
}

function listeningLine(mark, work, status) {
	const title = `**${esc(work ? work.title : mark.title)}**${edition(work)}`;
	if (status === 'missing') return `⚠️ ${title} · not in the library any more; your place is kept`;
	if (status === 'new-episodes') return `🆕 ${title} · new episodes since you caught up`;
	const total = bookModel.totalMs(work);
	const abs = Math.max(0, Math.min(mark.absoluteMs || 0, total));
	const speed = bookModel.SPEEDS.includes(mark.speed) ? mark.speed : 1;
	const bits = [`${total > 0 ? Math.floor((abs / total) * 100) : 0}%`];
	const ch = bookModel.chapterAt(work, abs);
	if (ch) bits.push(chapterShort(work, ch));
	bits.push(`${bookModel.formatSpan((total - abs) / speed)} left${speed !== 1 ? ` at ${speed}x` : ''}`);
	if (Number.isFinite(mark.lastListenedAt)) bits.push(`<t:${sec(mark.lastListenedAt)}:R>`);
	return `▶ ${title} · ${bits.join(' · ')}`;
}

function finishedLine(mark, work, status) {
	const title = `${esc(work ? work.title : mark.title)}${edition(work)}`;
	if (status === 'caught-up') return `✅ ${title} · caught up`;
	const when = Number.isFinite(mark.finishedAt) ? ` <t:${sec(mark.finishedAt)}:d>` : '';
	const times = mark.finishedCount > 1 ? ` (×${mark.finishedCount})` : '';
	return `✅ ${title} · finished${when}${times}`;
}

function fit(lines, budget) {
	const out = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget) {
			out.push(`…and ${lines.length - out.length} more.`);
			break;
		}
		out.push(line);
		used += line.length + 1;
	}
	return out;
}

/**
 * The shelf as a reply payload: in progress (last listened first) with up to 5 Resume buttons,
 * then finished works collapsed. Shared by /book shelf and the ended card's "My shelf".
 * @returns {{ content, embeds, components }}
 */
function buildShelf(userId, given = {}) {
	const { bookmarks, catalog } = Object.assign(stores(), given);
	const marks = bookmarks.forUser(String(userId));
	if (!marks.length) return { content: EMPTY_SHELF, embeds: [], components: [] };
	const listening = [];
	const done = [];
	for (const mark of marks) {
		const work = catalog.work(mark.workId);
		const status = bookmarks.statusOf(mark, work);
		if (status === 'finished' || status === 'caught-up') done.push({ mark, work, status });
		else listening.push({ mark, work, status });
	}
	const recency = m => (Number.isFinite(m.lastListenedAt) ? m.lastListenedAt : m.updatedAt || 0);
	listening.sort((a, b) => recency(b.mark) - recency(a.mark));

	const parts = [];
	if (listening.length) parts.push('**Listening**', ...fit(listening.map(x => listeningLine(x.mark, x.work, x.status)), 2600));
	if (done.length) {
		const shown = done.slice(0, SHOWN_FINISHED).map(x => finishedLine(x.mark, x.work, x.status));
		if (done.length > SHOWN_FINISHED) shown.push(`…and ${done.length - SHOWN_FINISHED} more.`);
		if (parts.length) parts.push('');
		parts.push('**Finished**', ...fit(shown, 1200));
	}
	const resumeId = id => (`book:resume:${id}`.length <= CUSTOM_ID_MAX ? `book:resume:${id}` : `book:resume:${bookSearch.shortKey(id)}`);
	const buttons = listening
		.filter(x => x.work)
		.slice(0, 5)
		.map(x => ({ type: 2, style: 2, custom_id: resumeId(x.work.id), emoji: { name: '▶️' }, label: clip(x.work.title, 80) }));
	return {
		content: '',
		embeds: [{ color: COLOR, title: '📚 Your shelf', description: clip(parts.join('\n'), EMBED_MAX) }],
		components: buttons.length ? [{ type: 1, components: buttons }] : []
	};
}

function seqOf(work) {
	// Number(null) is 0, which listed a series with no number as "#null" and first in its group.
	if (work.sequence === null || work.sequence === undefined || work.sequence === '') return Infinity;
	const n = Number(work.sequence);
	return Number.isFinite(n) ? n : Infinity;
}

// ---- /book library ---------------------------------------------------------------------------
//
// No filter: a landing with one line per section and an "Open a section" menu. A section, or any
// filter, is a list cut into pages of 25 works at most (a select holds 25) and 1,900 characters,
// with a "▶ Play one of these…" menu for the page and ◀ n/N ▶ buttons. Each page shows the asker's
// marks (✅, %), as the old list did; slash replies are private, and a prefix reply shows the
// marks of the person who typed it, whoever turns the pages.

const PAGE_WORKS = 25;
const LINE_MAX = 200;
const TITLE_MAX = 90;
const OPTION_MAX = 100;
const SELECT_MAX = 25;
const SHORT_MS = 5 * 3600000;
const LONG_MS = 20 * 3600000;
const FIELDS = { author: 'author', series: 'series', section: 'section', genre: 'section' };
const STATUS_LABELS = { unread: 'unread by you', listening: 'in progress for you', finished: 'finished by you' };
const LENGTH_LABELS = { short: 'under 5 h', long: '20 h or longer' };
const KEYWORDS = new Set([...Object.keys(STATUS_LABELS), ...Object.keys(LENGTH_LABELS), 'podcast', 'podcasts']);

function libraryDeps(given) {
	return Object.assign(stores(), { sections: null, play: null }, given);
}

function sortKey(text) {
	return bookSearch.bare(bookSearch.key(text));
}

function byTitle(a, b) {
	return sortKey(a.title).localeCompare(sortKey(b.title)) || String(a.id).localeCompare(String(b.id));
}

// An author reading their own book ("Mythos (Stephen Fry) · Stephen Fry") says nothing twice.
function voiceOf(work) {
	const voice = work.edition || work.narrator || null;
	return voice && bookCatalog.norm(voice) !== bookCatalog.norm(work.author) ? voice : null;
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function spanOf(works) {
	return bookModel.formatSpan(works.reduce((s, w) => s + bookModel.totalMs(w), 0));
}

function sectionsOf(works, deps) {
	try {
		return deps.sections ? deps.sections(works) : bookSections.sectionsNow({ catalog: deps.catalog });
	} catch (err) {
		require('../../helpers/logger.js').warn('Library sections failed; listing every book together:', (err && err.message) || err);
		return bookSections.sectionsFor(works);
	}
}

function sectionName(sections, work) {
	const hit = sections.get(work.id);
	return hit ? hit.section : bookSections.MORE;
}

// groupBySection ends with Podcasts then More books; the landing ends with Podcasts, the one
// section that holds a different kind of thing.
function orderedSections(works, sections) {
	const groups = bookSections.groupBySection(works, sections);
	return [...groups.filter(g => g.section !== bookSections.PODCASTS), ...groups.filter(g => g.section === bookSections.PODCASTS)];
}

function markLine(mark, len) {
	if (mark && mark.finished) return ['✅'];
	if (mark && len > 0) return [`${Math.floor((mark.absoluteMs / len) * 100)}%`];
	return [];
}

function workLine(w, mark) {
	const len = bookModel.totalMs(w);
	const seq = w.series && Number.isFinite(seqOf(w)) ? `#${w.sequence} ` : '';
	const voice = voiceOf(w);
	const bits = [];
	if (!w.series && w.author) bits.push(esc(w.author));
	if (w.kind === 'podcast') bits.push('🎙 podcast');
	bits.push(bookModel.formatSpan(len), ...markLine(mark, len));
	return clip(`• ${seq}${esc(clip(w.title, TITLE_MAX))}${voice ? ` (${esc(voice)})` : ''} · ${bits.join(' · ')}`, LINE_MAX);
}

/**
 * The works in display order, one entry per line: sections in the landing's order, then inside a
 * section the books outside any series by title, then each series under its heading, the series
 * sorted by the name the heading shows ("The Stormlight Archive" under S).
 */
function entriesFor(works, sections, markOf) {
	const out = [];
	for (const g of orderedSections(works, sections)) {
		const series = new Map();
		for (const w of g.works) {
			if (!w.series) continue;
			const k = `${bookCatalog.norm(w.series)}|${bookCatalog.norm(w.author)}`;
			// A podcast's series is usually its own name, which is also its author.
			const by = w.author && bookCatalog.norm(w.author) !== bookCatalog.norm(w.series) ? ` · ${esc(w.author)}` : '';
			if (!series.has(k)) series.set(k, { key: k, heading: `*${esc(w.series)}*${by}`, sort: bookSearch.seriesName(w) || sortKey(w.series), works: [] });
			series.get(k).works.push(w);
		}
		const base = { section: g.section, count: g.works.length };
		for (const w of g.works.filter(x => !x.series).sort(byTitle)) out.push(Object.assign({ group: null, work: w, line: workLine(w, markOf(w)) }, base));
		const groups = [...series.values()].sort((a, b) => a.sort.localeCompare(b.sort) || a.key.localeCompare(b.key));
		for (const s of groups) {
			for (const w of s.works.sort((a, b) => seqOf(a) - seqOf(b) || byTitle(a, b))) {
				out.push(Object.assign({ group: s.key, heading: s.heading, work: w, line: workLine(w, markOf(w)) }, base));
			}
		}
	}
	return out;
}

/**
 * Pages of at most PAGE_WORKS works and CHUNK characters. A heading always travels with its first
 * book, and a page that opens inside a section or series repeats its heading with "(cont.)".
 * @returns {Array<{ text: string, works: object[] }>}
 */
function paginate(header, entries, sectionHeadings) {
	const pages = [];
	let page = null;
	const open = () => {
		page = { lines: [header], works: [], size: header.length, section: null, group: null };
		pages.push(page);
	};
	const blockFor = (e, prev) => {
		const lines = [];
		const cont = same => (same ? ' (cont.)' : '');
		const newSection = page.section !== e.section;
		if (sectionHeadings && newSection) lines.push('', `**${esc(e.section)}** (${e.count})${cont(prev && prev.section === e.section)}`);
		if (e.group && (newSection || page.group !== e.group)) {
			if (!lines.length) lines.push('');
			lines.push(`${e.heading}${cont(prev && prev.group === e.group)}`);
		}
		if (!lines.length && !page.works.length) lines.push('');
		lines.push(e.line);
		return lines;
	};
	const sizeOf = lines => lines.reduce((s, l) => s + l.length + 1, 0);
	open();
	for (const e of entries) {
		let lines = blockFor(e, null);
		if (page.works.length && (page.works.length >= PAGE_WORKS || page.size + sizeOf(lines) > CHUNK)) {
			const prev = { section: page.section, group: page.group };
			open();
			lines = blockFor(e, prev);
		}
		page.lines.push(...lines);
		page.size += sizeOf(lines);
		page.section = e.section;
		page.group = e.group;
		page.works.push(e.work);
	}
	return pages.map(p => ({ text: p.lines.join('\n'), works: p.works }));
}

function matchSections(text, names, loose) {
	const k = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
	if (!k) return [];
	const exact = names.filter(n => n.toLowerCase() === k);
	if (exact.length || !loose) return exact;
	const starts = names.filter(n => n.toLowerCase().startsWith(k));
	return starts.length ? starts : names.filter(n => ` ${n.toLowerCase()} `.includes(` ${k} `));
}

function blankFilter(raw) {
	return { raw, section: null, sectionLoose: false, author: null, series: null, status: [], length: [], podcasts: false, words: '', edgeOf: null };
}

/**
 * What `/book library <text>` asks for. Text that is exactly a section name is that section, even
 * when it is also a keyword. Otherwise: author:x, series:x and section:x (or genre:x; a value runs
 * to the next keyword, or quote it), the keywords unread, listening, finished, short, long and
 * podcasts, and the remaining words, which are a section when they name one exactly (or start or
 * end with one) and a title, author or series search when not. Every part narrows the list.
 * @param {string} text
 * @param {string[]} names the section names in use
 * @returns {null|{ raw, section, sectionLoose, author, series, status: string[], length: string[], podcasts: boolean, words: string, edgeOf: string|null }}
 *   edgeOf: the words as typed when the section came off one end of them
 */
function parseFilter(text, names = []) {
	const raw = String(text || '').trim().replace(/\s+/g, ' ');
	if (!raw) return null;
	const f = blankFilter(raw);
	const whole = matchSections(raw, names, false);
	if (whole.length) {
		f.section = whole[0];
		return f;
	}
	const free = [];
	const values = {};
	let field = null;
	for (const tok of raw.match(/[a-z]+:"[^"]*"?|"[^"]*"?|\S+/gi) || []) {
		const m = /^([a-z]+):(.*)$/i.exec(tok);
		if (m && FIELDS[m[1].toLowerCase()]) {
			const quoted = m[2].startsWith('"');
			field = FIELDS[m[1].toLowerCase()];
			values[field] = [m[2].replace(/"/g, '')].filter(Boolean);
			if (quoted) field = null;
			continue;
		}
		const word = tok.toLowerCase();
		if (KEYWORDS.has(word)) {
			field = null;
			if (STATUS_LABELS[word]) f.status.push(word);
			else if (LENGTH_LABELS[word]) f.length.push(word);
			else f.podcasts = true;
			continue;
		}
		const plain = tok.replace(/"/g, '');
		if (!plain) continue;
		if (field) values[field].push(plain);
		else free.push(plain);
	}
	if (values.author && values.author.length) f.author = values.author.join(' ');
	if (values.series && values.series.length) f.series = values.series.join(' ');
	if (values.section && values.section.length) {
		f.section = values.section.join(' ');
		f.sectionLoose = true;
	}
	const words = free.join(' ');
	const named = !f.section && words ? matchSections(words, names, false) : [];
	if (named.length) {
		f.section = named[0];
		return f;
	}
	const edge = f.section ? null : sectionAtEdge(words, names);
	if (edge) {
		f.section = edge.section;
		f.words = edge.rest;
		f.edgeOf = words;
	} else {
		f.words = words;
	}
	return f;
}

// "fantasy sanderson" or "sanderson fantasy": a section name at either end of the words, the
// longest first so "science fiction" wins over a section called "Science".
function sectionAtEdge(words, names) {
	const low = words.toLowerCase();
	for (const name of [...names].sort((a, b) => b.length - a.length)) {
		const n = name.toLowerCase();
		if (low.startsWith(`${n} `)) return { section: name, rest: words.slice(n.length + 1).trim() };
		if (low.endsWith(` ${n}`)) return { section: name, rest: words.slice(0, words.length - n.length - 1).trim() };
	}
	return null;
}

function sectionOnly(f) {
	return !!(f && f.section && !f.sectionLoose && !f.author && !f.series && !f.status.length && !f.length.length && !f.podcasts && !f.words);
}

/** The works a parsed filter keeps, in catalog order; null keeps them all. */
function applyFilter(works, f, { sections, markOf, catalog }) {
	if (!f) return works;
	let list = works;
	if (f.words) {
		const hits = new Set((catalog.findWorks(f.words) || []).map(w => w.id));
		list = list.filter(w => hits.has(w.id));
	}
	if (f.section) {
		const names = [...new Set(works.map(w => sectionName(sections, w)))];
		const keep = new Set(matchSections(f.section, names, f.sectionLoose).map(n => n.toLowerCase()));
		list = list.filter(w => keep.has(sectionName(sections, w).toLowerCase()));
	}
	if (f.author) {
		const q = bookSearch.key(f.author);
		list = list.filter(w => q && ` ${bookSearch.key(w.author)} `.includes(` ${q} `));
	}
	if (f.series) {
		const q = bookSearch.bare(bookSearch.key(f.series));
		list = list.filter(w => q && w.series && (` ${bookSearch.seriesName(w)} `.includes(` ${q} `) || ` ${bookSearch.key(w.series)} `.includes(` ${q} `)));
	}
	for (const s of f.status) {
		list = list.filter((w) => {
			const mark = markOf(w);
			if (s === 'unread') return !mark;
			if (s === 'finished') return !!(mark && mark.finished);
			return !!(mark && !mark.finished);
		});
	}
	for (const l of f.length) {
		list = list.filter(w => (l === 'short' ? bookModel.totalMs(w) < SHORT_MS : bookModel.totalMs(w) >= LONG_MS));
	}
	if (f.podcasts) list = list.filter(w => w.kind === 'podcast');
	return list;
}

function headerFor(f, list) {
	const count = `${plural(list.length, 'work')}, ${spanOf(list)}`;
	if (sectionOnly(f)) return `📚 **${esc(f.section)}** · ${count}`;
	const labels = [];
	if (f) {
		if (f.section) labels.push(f.sectionLoose ? `section "${esc(f.section)}"` : esc(f.section));
		if (f.author) labels.push(`author "${esc(f.author)}"`);
		if (f.series) labels.push(`series "${esc(f.series)}"`);
		for (const s of f.status) labels.push(STATUS_LABELS[s]);
		for (const l of f.length) labels.push(LENGTH_LABELS[l]);
		if (f.podcasts) labels.push('podcasts');
	}
	const matching = f && f.words ? ` matching "${esc(f.words)}"` : '';
	return `📚 **Audiobook library**${matching}${labels.map(l => ` · ${l}`).join('')} · ${count}`;
}

function hintLine(cmd, example, lead) {
	return `_${lead}: \`${cmd} ${example}\`, \`author:<name>\`, \`series:<name>\`, \`unread\`, \`listening\`, \`finished\`, \`short\` (under 5 h), \`long\` (20 h or more), \`podcasts\`._`;
}

function playOption(w, description) {
	const voice = voiceOf(w);
	const seq = w.series && Number.isFinite(seqOf(w)) ? `#${w.sequence} ` : '';
	return { label: clip(`${seq}${w.title}${voice ? ` (${voice})` : ''}`, OPTION_MAX), value: bookSearch.shortKey(w.id), description: clip(description, OPTION_MAX) };
}

function playSelect(token, placeholder, options) {
	return { type: 1, components: [{ type: 3, custom_id: `book:lib:play:${token}`, placeholder, options: options.slice(0, SELECT_MAX) }] };
}

function inProgress(userId, deps) {
	const recency = m => (Number.isFinite(m.lastListenedAt) ? m.lastListenedAt : m.updatedAt || 0);
	return deps.bookmarks.forUser(String(userId))
		.filter(m => !m.finished)
		.sort((a, b) => recency(b) - recency(a))
		.map(mark => ({ mark, work: deps.catalog.work(mark.workId) }))
		.filter(x => x.work);
}

function renderLanding(view, token, works, sections, deps) {
	const groups = orderedSections(works, sections);
	view.sections = groups.map(g => g.section);
	const lines = [`📚 **Audiobook library** · ${plural(works.length, 'work')}, ${spanOf(works)}`, ''];
	const rows = groups.map(g => `**${esc(g.section)}** · ${plural(g.works.length, 'work')}, ${spanOf(g.works)}`);
	const listening = inProgress(view.userId, deps);
	const tail = [''];
	if (listening.length) tail.push(`▶ ${plural(listening.length, 'book')} of yours ${listening.length === 1 ? 'is' : 'are'} in progress; pick one below to play it.`);
	tail.push(hintLine(view.cmd, groups[0].section.toLowerCase(), 'Open a section below, or narrow it down'));
	const budget = CHUNK - sizeOfLines(lines) - sizeOfLines(tail);
	lines.push(...fit(rows, budget), ...tail);
	const components = [{ type: 1, components: [{
		type: 3,
		custom_id: `book:lib:open:${token}`,
		placeholder: 'Open a section',
		options: groups.slice(0, SELECT_MAX).map((g, i) => ({ label: clip(g.section, OPTION_MAX), value: String(i), description: clip(`${plural(g.works.length, 'work')} · ${spanOf(g.works)}`, OPTION_MAX) }))
	}] }];
	if (listening.length) {
		const options = listening.slice(0, SELECT_MAX).map(({ mark, work }) => {
			const total = bookModel.totalMs(work);
			const abs = Math.max(0, Math.min(mark.absoluteMs || 0, total));
			const pct = total > 0 ? Math.floor((abs / total) * 100) : 0;
			return playOption(work, `${pct}% · ${bookModel.formatSpan(total - abs)} left${work.author ? ` · ${work.author}` : ''}`);
		});
		components.push(playSelect(token, '▶ Play a book in progress…', options));
	}
	return { content: lines.join('\n'), components };
}

function sizeOfLines(lines) {
	return lines.reduce((s, l) => s + l.length + 1, 0);
}

function renderList(view, token, works, sections, deps, markOf) {
	const f = view.query.filter || null;
	const list = applyFilter(works, f, { sections, markOf, catalog: deps.catalog });
	const header = headerFor(f, list);
	const showHome = new Set(works.map(w => sectionName(sections, w).toLowerCase())).size > 1;
	const home = { type: 2, style: 2, custom_id: `book:lib:home:${token}`, emoji: { name: '📚' }, label: 'All sections' };
	if (!list.length) {
		return { content: `${header}\n\nNothing here any more.`, components: showHome ? [{ type: 1, components: [home] }] : [] };
	}
	const entries = entriesFor(list, sections, markOf);
	const pages = paginate(header, entries, new Set(entries.map(e => e.section)).size > 1);
	const at = Math.min(Math.max(0, Number(view.page) || 0), pages.length - 1);
	view.page = at;
	const page = pages[at];
	const components = [playSelect(token, '▶ Play one of these…', page.works.map((w) => {
		const len = bookModel.totalMs(w);
		const bits = [w.author, bookModel.formatSpan(len), ...markLine(markOf(w), len)].filter(Boolean);
		return playOption(w, bits.join(' · '));
	}))];
	const buttons = [];
	if (pages.length > 1) {
		buttons.push(
			{ type: 2, style: 2, custom_id: `book:lib:page:${token}:${at - 1}`, emoji: { name: '◀️' }, disabled: at === 0 },
			{ type: 2, style: 2, custom_id: `book:lib:noop:${token}`, label: `${at + 1} / ${pages.length}`, disabled: true },
			{ type: 2, style: 2, custom_id: `book:lib:page:${token}:${at + 1}`, emoji: { name: '▶️' }, disabled: at === pages.length - 1 }
		);
	}
	if (showHome) buttons.push(home);
	if (buttons.length) components.push({ type: 1, components: buttons });
	view.pages = pages.length;
	return { content: page.text, components };
}

/**
 * A remembered library view as a message payload, rendered from the catalog as it is now.
 * @param {{ userId, cmd, query: { type: 'landing' } | { type: 'list', filter }, page }} view
 *   changed in place: a list clamps its page and records its page count (pages), a landing
 *   records its section names (sections)
 * @param {string} token from bookLibraryButtons.remember
 * @param {object} [given] test seams: bookmarks, catalog, sections(works) -> Map
 * @returns {{ content: string, components: object[] }}
 */
function renderView(view, token, given = {}) {
	const deps = libraryDeps(given);
	const works = deps.catalog.works() || [];
	if (!works.length) return { content: READING, components: [] };
	const sections = sectionsOf(works, deps);
	const markOf = w => deps.bookmarks.get(String(view.userId), w);
	if (view.query.type === 'landing') {
		if (new Set(works.map(w => sectionName(sections, w).toLowerCase())).size > 1) return renderLanding(view, token, works, sections, deps);
		view.query = { type: 'list', filter: null };
	}
	return renderList(view, token, works, sections, deps, markOf);
}

function noMatch(f, works, names, cmd, deps) {
	const missing = `Nothing in the audiobook library matches "${esc(f.raw)}".`;
	if (f.words && !(deps.catalog.findWorks(f.words) || []).length) {
		let near = [];
		try { near = bookSearch.suggest(f.words, works); } catch (_) {}
		if (near.length) {
			const choices = near.map(w => ({ id: w.id, title: w.title, narrator: w.narrator || null, edition: w.edition || null, percent: null }));
			const which = near.length === 1 ? `**${esc(near[0].title)}**?` : `one of these?\n${near.map(w => `• ${esc(w.title)}${voiceOf(w) ? ` (${esc(voiceOf(w))})` : ''}`).join('\n')}`;
			const row = (deps.play || require('./play.js')).choiceRow(choices);
			return { content: `${missing} Did you mean ${which}`, components: row };
		}
	}
	const list = names.map(n => `**${esc(n)}**`).join(', ');
	return { content: clip(`${missing}\nSections: ${list}.\n${hintLine(cmd, names[0] ? names[0].toLowerCase() : 'fantasy', 'Try a section or a filter')}`, CHUNK), components: [] };
}

/**
 * `/book library [filter]` as one reply payload: the landing, a list with its menus, or a "Nothing
 * matches" answer with suggestions. Remembers the view for its buttons.
 * @param {string} userId the asker; their marks are the ones shown
 * @param {string} text the filter, empty for the landing
 * @param {{ cmd?: string }} [opts] how the asker types the command, for the hints
 * @param {object} [given] test seams, as renderView
 */
function libraryReply(userId, text, { cmd = '/book library' } = {}, given = {}) {
	const deps = libraryDeps(given);
	const works = deps.catalog.works() || [];
	if (!works.length) return { content: READING, components: [] };
	const sections = sectionsOf(works, deps);
	const names = orderedSections(works, sections).map(g => g.section);
	let f = parseFilter(text, names);
	if (f) {
		const markOf = w => deps.bookmarks.get(String(userId), w);
		const keeps = g => applyFilter(works, g, { sections, markOf, catalog: deps.catalog }).length > 0;
		// A title that starts with a section's name ("Mythology" by Edith Hamilton) is still a title.
		if (!keeps(f) && f.edgeOf) f = Object.assign({}, f, { section: null, words: f.edgeOf, edgeOf: null });
		if (!keeps(f)) return noMatch(f, works, names, cmd, deps);
	}
	const view = { userId: String(userId), cmd, query: f ? { type: 'list', filter: f } : { type: 'landing' }, page: 0 };
	const token = libraryButtons.remember(view);
	return renderView(view, token, Object.assign({}, given, { sections: () => sections }));
}

/** The filter "Open a section" applies: that section alone, as typing its name would. */
function sectionFilter(name) {
	return Object.assign(blankFilter(name), { section: name });
}

function statsEmbed(target, st) {
	const who = `<@${target.id}>`;
	const lines = [
		who,
		`🎧 **${hours(st.listenedMs)}** listened · **${hours(st.coveredMs)}** of book time covered`,
		`✅ ${st.worksFinished} finished (${st.totalFinishes} finish${st.totalFinishes === 1 ? '' : 'es'}) · ▶ ${st.inProgress} in progress`
	];
	if (st.byKind && st.byKind.podcast && st.byKind.podcast.works > 0) {
		lines.push(`📖 Books ${hours(st.byKind.book.listenedMs)} · 🎙 Podcasts ${hours(st.byKind.podcast.listenedMs)}`);
	}
	if (st.newEpisodes > 0) lines.push(`🆕 ${st.newEpisodes} podcast${st.newEpisodes === 1 ? ' has' : 's have'} new episodes`);
	if (st.top && st.top.length) {
		lines.push('', '**Most listened**');
		lines.push(...renderBoard(st.top, r => `${esc(r.title)} · ${hours(r.listenedMs)}`));
	}
	return { color: COLOR, title: '📚 Listening stats', description: clip(lines.join('\n'), EMBED_MAX) };
}

function statsTarget(ctx) {
	let user = null;
	try {
		if (ctx.interaction && ctx.interaction.options) user = ctx.interaction.options.getUser('user');
	} catch (_) {}
	if (!user && !ctx.interaction && ctx.message.mentions && ctx.message.mentions.users) {
		user = ctx.message.mentions.users.first() || null;
	}
	return user || { id: ctx.userId };
}

async function run(ctx) {
	const { bookmarks, catalog } = stores();
	switch (ctx.sub) {
		case 'shelf':
			return ctx.say(buildShelf(ctx.userId));
		case 'library': {
			if (!(catalog.works() || []).length) {
				require('./play.js').ensureLibrary(ctx.bot);
				return ctx.say(READING);
			}
			const p = (ctx.bot && ctx.bot.config && ctx.bot.config.commandPrefix) || require('../../config/config.js').commandPrefix || '!';
			return ctx.say(libraryReply(ctx.userId, ctx.rest, { cmd: ctx.interaction ? '/book library' : `${p}book library` }));
		}
		case 'stats': {
			const target = statsTarget(ctx);
			const st = bookmarks.statsFor(String(target.id), catalog);
			if (!st.works) return ctx.say(`<@${target.id}> has no audiobook bookmarks yet.`);
			return ctx.say({ embeds: [statsEmbed(target, st)] });
		}
		case 'leaderboard': {
			if (!ctx.guildId) return ctx.say('Run the leaderboard in a server.');
			// A bookmark opened and never listened to would rank at 0.0 h.
			const rows = bookmarks.leaderboardRows(ctx.guildId).filter(r => r.listenedMs > 0 || r.worksFinished > 0);
			if (!rows.length) return ctx.say('Nobody has listened to an audiobook here yet.');
			const lines = renderBoard(rows, r => `<@${r.userId}> · ${hours(r.listenedMs)} listened · ${r.worksFinished} finished`, { limit: 10 });
			return ctx.say({ embeds: [{ color: COLOR, title: '📚 Audiobook leaderboard', description: lines.join('\n') }] });
		}
		default:
			return null;
	}
}

module.exports = {
	names: ['shelf', 'library', 'stats', 'leaderboard'],
	run,
	buildShelf,
	libraryReply,
	renderView,
	parseFilter,
	applyFilter,
	sectionFilter,
	paginate,
	statsEmbed,
	PAGE_WORKS
};
