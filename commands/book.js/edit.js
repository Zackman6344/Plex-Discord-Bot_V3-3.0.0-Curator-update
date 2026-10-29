// /book edit: the owner's fixes to what a book shows, written to book_overrides.json.
//
// Values go through bookCatalogStore.editOverrides and show at once through refreshMetadata();
// helpers/bookMetadata.js ranks them above every detected, Calibre or online value. They never
// feed a work's id, so bookmarks, read-along links and sync marks stay where they are. exclude
// and include change what counts as a book, so only those two rebuild the catalog.
//
// genre, author-genre and calibre are not display fields: genre names the library section
// (helpers/bookSections.js) and calibre pins the Calibre record (helpers/calibreIndex.js), stored
// as works[id].genre, authors[slug].genre and works[id].calibreId with the record's uuid and
// library. bookMetadata.extrasFor reads them by id and alias, so they follow an id move.
//
// `!book edit` can answer in an open channel: replies name works by title and id only, never a
// folder or the overrides file's path (editOverrides' errors are already path-free).

const config = require('../../config/config.js');
const logger = require('../../helpers/logger.js');

const VALUE_MAX = 300;
const NAME_MAX = 80;
const LIST_MAX = 5;
const LOOKUP_WAIT_MS = 60 * 1000;
const GENRE_MAX = 40;
const FIELDS = ['title', 'author', 'narrator', 'publisher', 'series', 'author-series', 'genre', 'author-genre', 'calibre', 'clear', 'exclude', 'include', 'lookup'];
const CLEARABLE = ['title', 'author', 'narrator', 'publisher', 'series', 'author-series', 'genre', 'author-genre', 'calibre', 'all'];
const METADATA_KEYS = ['title', 'author', 'narrator', 'edition', 'publisher', 'series', 'sequence'];
const CALIBRE_KEYS = ['calibreId', 'calibreUuid', 'calibreLibrary'];
// Two narrations of one title share its name, series and section, but not a narrator, a
// publisher, the decision to drop one of them, or a Calibre record: two translations of one title
// are two books.
const ONE_RECORDING = new Set(['author', 'narrator', 'publisher', 'exclude', 'include', 'calibre']);
const SECTION_SOURCES = {
	override: 'your edit', 'author-override': 'your author-wide edit', folder: 'your folder', calibre: 'Calibre tags',
	tags: 'file tags', 'calibre-likely': 'Calibre tags of a likely match', series: 'its series', author: 'its author',
	podcast: 'a podcast', none: 'no source'
};
const SOURCE_NAMES = { override: 'your edit', calibre: 'Calibre', online: 'online', tag: 'file tags', plex: 'Plex', folder: 'folder name' };
const POSITION_RE = /^#?(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?$/;
const CLEAR = Symbol('clear');

const catalogStore = () => require('../../helpers/bookCatalogStore.js');
const bookCatalog = () => require('../../helpers/bookCatalog.js');
const bookMetadata = () => require('../../helpers/bookMetadata.js');
const bookSections = () => require('../../helpers/bookSections.js');
const calibreIndex = () => require('../../helpers/calibreIndex.js').instance();
const calibreMatch = () => require('../../helpers/calibreMatch.js');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const norm = (text) => bookCatalog().norm(text);
const prefix = () => config.commandPrefix || '!';

function esc(text) {
	const s = String(text === null || text === undefined ? '' : text);
	const clipped = s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
	return clipped.replace(/([\\*_`~|])/g, '\\$1');
}

function idsOf(work) {
	return [work.id, ...(Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [])];
}

// The rescan's wording, which names albums, artists and folder names but never a path.
function doubtReason(d) {
	return require('./admin.js').doubtReason(d);
}

function usage(p = prefix()) {
	return [
		`✏️ \`${p}book edit\` (owner): fix what a book shows. Your edit wins over tags, Plex, folders, Calibre and the online lookup, and never changes the book's id.`,
		`\`${p}book edit <book>\`: each detail and where it came from.`,
		`\`${p}book edit <book> title|author|narrator|publisher <value>\` (\`narrator none\` for none).`,
		`\`${p}book edit <book> series <name> [number]\` or \`series none\`. Quote a name that ends in a number: \`series "Area 51"\`.`,
		`\`${p}book edit <book> author-series <name> [number]\`: one series for all of the author's books, numbered book by book.`,
		`\`${p}book edit <book> genre <section>\` / \`author-genre <section>\`: the library section for this title, or for all of the author's books.`,
		`\`${p}book edit <book> calibre <id>\` / \`calibre none\`: tie the book to a Calibre record by its id, or stop any match.`,
		`\`${p}book edit <book> clear <${CLEARABLE.join('|')}>\`: back to the detected value.`,
		`\`${p}book edit <book> exclude\` / \`include\`: take a book out of the catalog or bring it back (rebuilds the catalog).`,
		`\`${p}book edit <book> lookup\`: look it up online again, when the online lookup is on.`,
		'Title and series edits apply to every recording of the same title.',
	].join('\n');
}

// ---- parsing ---------------------------------------------------------------------------------

function tokenize(text) {
	const out = [];
	const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
	let m;
	while ((m = re.exec(String(text || '')))) {
		if (m[3] !== undefined) out.push({ text: m[3], quoted: false });
		else out.push({ text: (m[1] !== undefined ? m[1] : m[2]).trim(), quoted: true });
	}
	return out;
}

const joined = (toks) => toks.map((t) => t.text).join(' ').trim();

function positionOf(tok) {
	if (!tok || tok.quoted) return null;
	const m = POSITION_RE.exec(tok.text);
	if (!m) return null;
	// resolve() ignores a sequence that is not one number, so a range is kept as "no number".
	return m[2] ? { text: `${m[1]}-${m[2]}`, sequence: null } : { text: m[1], sequence: Number(m[1]) };
}

/** @returns {{ ok: true, req: object } | { ok: false, error: string }} */
function parseArgs(field, toks) {
	const p = prefix();
	const ok = (req) => ({ ok: true, req });
	const bad = (error) => ({ ok: false, error });
	const text = joined(toks);
	const none = toks.length === 1 && !toks[0].quoted && /^none$/i.test(toks[0].text);
	switch (field) {
		case 'title':
		case 'author':
		case 'narrator':
		case 'publisher':
			if (none && (field === 'narrator' || field === 'publisher')) return ok({ action: 'set', field, value: null });
			if (!text) return bad(`\`${field}\` needs a value: \`${p}book edit <book> ${field} <value>\`.`);
			if (text.length > VALUE_MAX) return bad(`That ${field} is longer than ${VALUE_MAX} characters.`);
			return ok({ action: 'set', field, value: text });
		case 'series':
		case 'author-series': {
			if (none) return ok({ action: field, none: true });
			let position = null;
			let nameToks = toks;
			if (toks.length > 1) {
				position = positionOf(toks[toks.length - 1]);
				if (position) nameToks = toks.slice(0, -1);
			}
			const name = joined(nameToks);
			if (!name) return bad(`\`${field}\` needs a name: \`${p}book edit <book> ${field} <name> [number]\`, or \`${field} none\`.`);
			if (name.length > VALUE_MAX) return bad(`That series name is longer than ${VALUE_MAX} characters.`);
			if (field === 'author-series' && position && position.sequence === null) return bad('`author-series` numbers one book at a time, so it needs a single number such as 2 or 0.5.');
			return ok({ action: field, name, position });
		}
		case 'genre':
		case 'author-genre':
			if (none) return bad(`A section needs a name. \`${p}book edit <book> clear ${field}\` goes back to the section the book gets on its own.`);
			if (!text) return bad(`\`${field}\` needs a section: \`${p}book edit <book> ${field} <section>\`, such as Fantasy.`);
			if (text.length > GENRE_MAX) return bad(`A section name is at most ${GENRE_MAX} characters.`);
			return ok({ action: field, value: text.replace(/\s+/g, ' ') });
		case 'calibre': {
			if (none) return ok({ action: 'calibre', id: null });
			const m = toks.length === 1 ? /^#?(\d{1,9})$/.exec(toks[0].text) : null;
			if (!m || Number(m[1]) < 1) return bad(`\`calibre\` takes a Calibre book id (the number in Calibre's Id column) or none: \`${p}book edit <book> calibre 42\`.`);
			return ok({ action: 'calibre', id: Number(m[1]) });
		}
		case 'clear': {
			const f = text.toLowerCase();
			if (toks.length !== 1 || !CLEARABLE.includes(f)) return bad(`\`clear\` takes one of: ${CLEARABLE.join(', ')}.`);
			return ok({ action: 'clear', field: f });
		}
		case 'exclude':
		case 'include':
		case 'lookup':
			if (toks.length) return bad(`\`${field}\` takes no value: \`${p}book edit <book> ${field}\`.`);
			return ok({ action: field });
		default:
			return bad(`Unknown detail "${field}". \`${p}book edit\` lists what can be changed.`);
	}
}

function fieldOf(tok) {
	if (!tok || tok.quoted) return null;
	const f = tok.text.toLowerCase();
	return FIELDS.includes(f) ? f : null;
}

/**
 * Work text, the field and its arguments from the prefix form. Unquoted, the work is the text
 * before the earliest field word whose arguments parse and whose leading text names a work: one
 * whose title it is exactly (or an id) first, then any match, so "The Narrator Wars narrator X"
 * edits that book rather than a book matching "The".
 * @param {string} rest
 * @param {(text: string, field: string|null, strong: boolean) => boolean} names
 * @returns {{ help?: true, error?: string, workText?: string, req?: object }}
 */
function parsePrefix(rest, names) {
	const toks = tokenize(rest);
	if (!toks.length || (toks.length === 1 && !toks[0].quoted && /^(\?|help)$/i.test(toks[0].text))) return { help: true };
	if (toks[0].quoted) {
		if (toks.length === 1) return { workText: toks[0].text, req: { action: 'show' } };
		const f = fieldOf(toks[1]);
		if (!f) return { error: `Unknown detail "${esc(toks[1].text)}". \`${prefix()}book edit\` lists what can be changed.` };
		const r = parseArgs(f, toks.slice(2));
		return r.ok ? { workText: toks[0].text, req: r.req } : { error: r.error };
	}
	const candidates = [];
	for (let i = 1; i < toks.length; i++) {
		const f = fieldOf(toks[i]);
		if (f) candidates.push({ f, before: joined(toks.slice(0, i)), args: parseArgs(f, toks.slice(i + 1)) });
	}
	const whole = joined(toks);
	const pick = (strong) => candidates.find((c) => c.args.ok && names(c.before, c.f, strong));
	const strong = pick(true);
	if (strong) return { workText: strong.before, req: strong.args.req };
	if (names(whole, null, true)) return { workText: whole, req: { action: 'show' } };
	const weak = pick(false);
	if (weak) return { workText: weak.before, req: weak.args.req };
	if (names(whole, null, false)) return { workText: whole, req: { action: 'show' } };
	const bad = candidates.find((c) => !c.args.ok && names(c.before, c.f, false));
	if (bad) return { error: bad.args.error };
	return { workText: whole, req: { action: 'show' } };
}

// The slash options are separate, so a value is taken whole: `/book edit series value:Area 51`
// is a series named "Area 51", never "Area" number 51.
function parseSlash(interaction) {
	const get = (name) => {
		try {
			const o = interaction.options.get(name);
			return o && o.value !== undefined && o.value !== null ? String(o.value).trim() : '';
		} catch (_) {
			return '';
		}
	};
	const workText = get('title');
	const field = get('field').toLowerCase();
	const value = get('value');
	const position = get('position');
	if (!workText) return { help: true };
	if (!field) return { workText, req: { action: 'show' } };
	if (!FIELDS.includes(field)) return { error: `Unknown detail "${esc(field)}".` };
	const toks = [];
	if (value) toks.push({ text: value, quoted: !(field === 'clear' || field === 'calibre' || /^none$/i.test(value)) });
	if (position && (field === 'series' || field === 'author-series')) toks.push({ text: position, quoted: false });
	if (position && field.endsWith('series') && !value) return { error: `\`${field}\` needs a name in \`value\`, with the number in \`position\`.` };
	const r = parseArgs(field, toks);
	return r.ok ? { workText, req: r.req } : { error: r.error };
}

// ---- finding the work ------------------------------------------------------------------------

function groupKey(w) {
	return `${norm(w.title)}|${norm(w.author)}`;
}

function suffixOf(w) {
	if (w.edition) return ` (${esc(w.edition)})`;
	if (w.narrator) return ` (read by ${esc(w.narrator)})`;
	return '';
}

function idList(works) {
	const lines = works.slice(0, LIST_MAX).map((w) => `• \`${w.id}\` ${esc(w.title)}${suffixOf(w)}`);
	if (works.length > LIST_MAX) lines.push(`• and ${works.length - LIST_MAX} more`);
	return lines.join('\n');
}

/**
 * The work an edit is about, and every recording of the same title and author (title and series
 * edits reach them all).
 * @returns {{ work?: object, group?: object[], exact?: boolean, error?: string }}
 */
function findTarget(text) {
	const store = catalogStore();
	const all = store.works() || [];
	const groupOf = (w) => all.filter((x) => groupKey(x) === groupKey(w));
	const exact = store.work(text);
	if (exact) return { work: exact, group: groupOf(exact), exact: true };
	const hits = store.findWorks(text) || [];
	if (!hits.length) return { error: `Nothing in the audiobook library matches "${esc(text)}".` };
	const same = hits.filter((w) => norm(w.title) === norm(text));
	const pool = same.length ? same : hits;
	if (new Set(pool.map(groupKey)).size === 1) return { work: pool[0], group: groupOf(pool[0]), exact: false };
	return { error: `Which one? Use the id:\n${idList(pool)}` };
}

// An excluded work is not in the catalog any more; book_overrides.json still names it by id.
function excludedIds() {
	let works = {};
	try {
		const read = catalogStore().readOverrides();
		works = isObject(read.overrides) && isObject(read.overrides.works) ? read.overrides.works : {};
	} catch (_) {}
	return Object.keys(works).filter((k) => isObject(works[k]) && works[k].exclude === true);
}

function findExcluded(text) {
	const ids = excludedIds();
	if (ids.includes(text)) return text;
	const s = bookCatalog().slug(text);
	const hits = ids.filter((id) => id.endsWith(`/${s}`) || id.includes(`/${s}~`));
	return hits.length === 1 ? hits[0] : null;
}

function namesWork(text, field, strong) {
	if (!text) return false;
	const store = catalogStore();
	if (store.work(text)) return true;
	if ((field === 'include' || field === 'exclude') && findExcluded(text)) return true;
	const hits = store.findWorks(text) || [];
	return strong ? hits.some((w) => norm(w.title) === norm(text)) : hits.length > 0;
}

// ---- writing ---------------------------------------------------------------------------------

// bookCatalog.applyOverrides reads an entry by the id detection gave, so a pinned work's entry
// stays under the id its pinId sits on.
function entryKey(works, work) {
	return idsOf(work).find((id) => isObject(works[id]) && works[id].pinId === work.id) || work.id;
}

function worksOf(raw) {
	if (raw.works !== undefined && !isObject(raw.works)) throw new Error('"works" is not an object');
	if (!isObject(raw.works)) raw.works = {};
	return raw.works;
}

/**
 * Sets (or with CLEAR, removes) fields of one work's entry. The same fields go from the entries
 * under its other ids, because bookMetadata merges every entry of a work and an older one would
 * otherwise show through a cleared field.
 */
function writeFields(raw, work, patch) {
	const works = worksOf(raw);
	const key = entryKey(works, work);
	for (const id of idsOf(work)) {
		if (id === key || !isObject(works[id])) continue;
		for (const f of Object.keys(patch)) delete works[id][f];
		if (!Object.keys(works[id]).length) delete works[id];
	}
	const entry = isObject(works[key]) ? works[key] : {};
	for (const [f, v] of Object.entries(patch)) {
		if (v === CLEAR) delete entry[f];
		else entry[f] = v;
	}
	if (Object.keys(entry).length) works[key] = entry;
	else delete works[key];
}

function detectedOf(work) {
	const d = isObject(work.detected) ? work.detected : {};
	return { author: d.author || work.author, title: d.title || work.title };
}

/**
 * authors[slug(detected author)] = { series, order: { <detected title>: n } }, the entry the
 * build's applyOverrides reads. Its order is merged across calls, so one command per book builds
 * the whole series. A hand-written key that slugs the same is folded into the slug key, which is
 * the only one the build honours.
 */
function writeAuthorSeries(raw, work, req) {
	const bc = bookCatalog();
	const { author, title } = detectedOf(work);
	const key = bc.slug(author);
	if (raw.authors !== undefined && !isObject(raw.authors)) throw new Error('"authors" is not an object');
	const authors = isObject(raw.authors) ? raw.authors : {};
	let existing = isObject(authors[key]) ? authors[key] : null;
	for (const k of Object.keys(authors)) {
		if (k === key || bc.slug(k) !== key) continue;
		if (!existing && isObject(authors[k])) existing = authors[k];
		delete authors[k];
	}
	if (req.none) delete authors[key];
	else {
		const entry = Object.assign({}, existing || {}, { series: req.name });
		if (req.position) {
			const order = isObject(entry.order) ? Object.assign({}, entry.order) : {};
			for (const k of Object.keys(order)) if (bc.slug(k) === bc.slug(title)) delete order[k];
			order[title] = req.position.sequence;
			entry.order = order;
		}
		authors[key] = entry;
	}
	if (Object.keys(authors).length) raw.authors = authors;
	else delete raw.authors;
}

function sourceName(w, f) {
	const s = w && isObject(w.sources) ? w.sources[f] : null;
	return SOURCE_NAMES[s] || null;
}

function seriesText(w) {
	if (!w.series) return 'no series';
	const n = w.sequence;
	return `${esc(w.series)}${n !== null && n !== undefined && n !== '' ? ` #${n}` : ''}`;
}

function valueText(w, f) {
	if (f === 'series') return seriesText(w);
	return w[f] ? esc(w[f]) : `no ${f}`;
}

/**
 * Writes, then lays the metadata over the catalog again so the reply shows the result.
 * @returns {{ ok: boolean, changed?: boolean, text?: string, refreshNote?: string }}
 */
function save(mutator) {
	const store = catalogStore();
	// editOverrides spots an unchanged file only when one exists, so a clear with nothing to clear
	// would otherwise create one holding an empty "works". A "works" the owner left empty stays.
	const r = store.editOverrides((raw) => {
		const before = JSON.stringify(raw);
		const keepEmpty = isObject(raw.works) && !Object.keys(raw.works).length;
		if (mutator(raw) === false) return false;
		if (!keepEmpty && isObject(raw.works) && !Object.keys(raw.works).length) delete raw.works;
		return JSON.stringify(raw) === before ? false : undefined;
	});
	if (!r.ok) return { ok: false, text: `⚠️ book_overrides.json: ${r.error}, so nothing was changed.` };
	const fresh = store.refreshMetadata();
	const refreshNote = fresh.ok ? '' : `\n⚠️ Saved, but the catalog could not be refreshed (${fresh.error}); it shows after the next rescan.`;
	return { ok: true, changed: r.changed, refreshNote };
}

function current(work) {
	return catalogStore().work(work.id) || work;
}

function who(t) {
	if (t.group.length < 2 || !t.groupWide) return `**${esc(t.work.title)}**`;
	return `**${esc(t.work.title)}** (all ${t.group.length} recordings: ${t.group.map((w) => `\`${w.id}\``).join(', ')})`;
}

const WINS = '(your edit wins over every other source)';

function setReply(t, req, saved) {
	const w = current(t.work);
	if (req.action === 'set') {
		const what = req.value === null ? `no ${req.field} from now on` : `${req.field} set to ${valueText(w, req.field)}`;
		return `✏️ ${who(t)}: ${what} ${WINS}.${saved.refreshNote}`;
	}
	if (req.none) return `✏️ ${who(t)}: no series from now on ${WINS}.${saved.refreshNote}`;
	const range = req.position && req.position.sequence === null ? ` The range ${req.position.text} is kept as no number.` : '';
	const from = !req.position && w.sequence !== null && w.sequence !== undefined && sourceName(w, 'sequence') !== 'your edit'
		? ` Its number comes from ${sourceName(w, 'sequence') || 'detection'}.` : '';
	return `✏️ ${who(t)}: series set to ${seriesText(w)} ${WINS}.${range}${from}${saved.refreshNote}`;
}

async function editFields(ctx, t, req) {
	const targets = t.groupWide ? t.group : [t.work];
	let patch;
	if (req.action === 'set') patch = { [req.field]: req.value };
	else if (req.none) patch = { series: null, sequence: null };
	else patch = { series: req.name, sequence: req.position ? req.position.sequence : CLEAR };
	const saved = save((raw) => { for (const w of targets) writeFields(raw, w, patch); });
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: ${targets.map((w) => w.id).join(', ')} ${Object.keys(patch).join('+')} set by the owner.`);
	return ctx.say(setReply(t, req, saved));
}

async function clearField(ctx, t, req) {
	const targets = t.groupWide ? t.group : [t.work];
	if (req.field === 'author-series') return authorSeries(ctx, t, { none: true });
	if (req.field === 'author-genre') return authorGenre(ctx, t, { none: true });
	const keys = req.field === 'all' ? METADATA_KEYS : req.field === 'series' ? ['series', 'sequence'] : req.field === 'calibre' ? CALIBRE_KEYS : [req.field];
	const patch = Object.fromEntries(keys.map((k) => [k, CLEAR]));
	const saved = save((raw) => { for (const w of targets) writeFields(raw, w, patch); });
	if (!saved.ok) return ctx.say(saved.text);
	if (!saved.changed) return ctx.say(`There was no ${req.field === 'all' ? '' : `${req.field} `}edit on ${who(t)} to clear.`);
	logger.info(`!book edit: ${targets.map((w) => w.id).join(', ')} ${req.field} cleared by the owner.`);
	const w = current(t.work);
	if (req.field === 'all') return ctx.say(`✏️ ${who(t)}: your edits to its details are cleared. An exclude, a part order, a pinned id, a section or a Calibre pin stays.${saved.refreshNote}`);
	if (req.field === 'genre') {
		const now = sectionText(w);
		return ctx.say(`✏️ ${who(t)}: your section edit is cleared${now ? `; it is listed under ${now}` : ''}.`);
	}
	if (req.field === 'calibre') {
		try { calibreIndex().rematch(); } catch (_) {}
		const line = calibreLine(w);
		return ctx.say(`✏️ ${who(t)}: your Calibre pin is cleared${line ? `; ${line.replace(/^Calibre: /, 'Calibre now: ')}` : ''}.${saved.refreshNote}`);
	}
	const src = sourceName(w, req.field);
	return ctx.say(`✏️ ${who(t)}: your ${req.field} edit is cleared; it shows ${valueText(w, req.field)}${src ? ` (${src})` : ''}.${saved.refreshNote}`);
}

async function authorSeries(ctx, t, req) {
	const bc = bookCatalog();
	const { author } = detectedOf(t.work);
	const key = bc.slug(author);
	const saved = save((raw) => writeAuthorSeries(raw, t.work, req));
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: author-series for ${key} ${req.none ? 'removed' : 'set'} by the owner.`);
	if (req.none) {
		if (!saved.changed) return ctx.say(`There was no author-wide series for ${esc(author)} to clear.${saved.refreshNote}`);
		return ctx.say(`✏️ ${esc(author)}: the author-wide series is cleared; each book shows its own series again.${saved.refreshNote}`);
	}
	const mine = (catalogStore().works() || []).filter((w) => bc.slug(detectedOf(w).author) === key);
	const inSeries = mine.filter((w) => norm(w.series) === norm(req.name));
	const byTitle = new Map();
	for (const w of inSeries) {
		const k = norm(w.title);
		if (!byTitle.has(k)) byTitle.set(k, { w, n: 0 });
		byTitle.get(k).n++;
	}
	const rows = [...byTitle.values()]
		.sort((a, b) => (Number(a.w.sequence) || Infinity) - (Number(b.w.sequence) || Infinity))
		.map(({ w, n }) => `${esc(w.title)}${w.sequence !== null && w.sequence !== undefined ? ` #${w.sequence}` : ''}${n > 1 ? ` (${n} recordings)` : ''}`);
	const own = mine.filter((w) => sourceName(w, 'series') === 'your edit' && norm(w.series) !== norm(req.name));
	const note = own.length ? `\nThese have a series edit of their own, which wins: ${own.slice(0, LIST_MAX).map((w) => `\`${w.id}\``).join(', ')}. \`clear series\` on one drops it.` : '';
	return ctx.say(`✏️ ${esc(req.name)}, for every ${esc(author)} book${rows.length ? `: ${rows.join(', ')}` : ''} ${WINS}.${note}${saved.refreshNote}`);
}

// ---- sections and Calibre --------------------------------------------------------------------

function sectionsNow() {
	try {
		return bookSections().sectionsNow();
	} catch (err) {
		logger.warn('!book edit: the library sections could not be worked out:', (err && err.message) || err);
		return new Map();
	}
}

function sectionName(typed) {
	const known = [...sectionsNow().values()].map((s) => s.section);
	return bookSections().canonicalSection(typed, known);
}

function sectionText(work) {
	const hit = sectionsNow().get(work.id);
	if (!hit) return null;
	return `${esc(hit.section)} · ${SECTION_SOURCES[hit.source] || hit.source}`;
}

async function editGenre(ctx, t, req) {
	if (t.work.kind === 'podcast') return ctx.say(`**${esc(t.work.title)}** is a podcast, and podcasts are always listed under Podcasts.`);
	const targets = t.groupWide ? t.group : [t.work];
	const name = sectionName(req.value);
	const saved = save((raw) => { for (const w of targets) writeFields(raw, w, { genre: name }); });
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: ${targets.map((w) => w.id).join(', ')} genre set by the owner.`);
	return ctx.say(`✏️ ${who(t)}: listed under **${esc(name)}** in the library ${WINS}.${saved.refreshNote}`);
}

/** authors[slug(detected author)].genre, beside any author-wide series the same entry holds. */
function writeAuthorGenre(raw, work, name) {
	const bc = bookCatalog();
	const key = bc.slug(detectedOf(work).author);
	if (raw.authors !== undefined && !isObject(raw.authors)) throw new Error('"authors" is not an object');
	const authors = isObject(raw.authors) ? raw.authors : {};
	let entry = isObject(authors[key]) ? authors[key] : null;
	for (const k of Object.keys(authors)) {
		if (k === key || bc.slug(k) !== key) continue;
		if (!entry && isObject(authors[k])) entry = authors[k];
		delete authors[k];
	}
	entry = Object.assign({}, entry || {});
	if (name === null) delete entry.genre;
	else entry.genre = name;
	if (Object.keys(entry).length) authors[key] = entry;
	else delete authors[key];
	if (Object.keys(authors).length) raw.authors = authors;
	else delete raw.authors;
}

async function authorGenre(ctx, t, req) {
	const { author } = detectedOf(t.work);
	const name = req.none ? null : sectionName(req.value);
	const saved = save((raw) => writeAuthorGenre(raw, t.work, name));
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: author-genre for ${bookCatalog().slug(author)} ${name === null ? 'removed' : 'set'} by the owner.`);
	if (name === null) {
		if (!saved.changed) return ctx.say(`There was no author-wide section for ${esc(author)} to clear.`);
		return ctx.say(`✏️ ${esc(author)}: the author-wide section is cleared; each book gets its own again.`);
	}
	const key = bookCatalog().slug(author);
	const sections = sectionsNow();
	const own = (catalogStore().works() || []).filter((w) => bookCatalog().slug(detectedOf(w).author) === key && (sections.get(w.id) || {}).source === 'override');
	const note = own.length ? `\nThese have a section edit of their own, which wins: ${own.slice(0, LIST_MAX).map((w) => `\`${w.id}\``).join(', ')}. \`clear genre\` on one drops it.` : '';
	return ctx.say(`✏️ Every ${esc(author)} book is listed under **${esc(name)}** ${WINS}.${note}`);
}

function calibreOffNote() {
	const index = calibreIndex();
	if (index.enabled()) return '';
	const p = prefix();
	return index.configured()
		? `\nThe Calibre index is off, so this applies once it is on: \`${p}config\`, under Audiobooks (\`audiobookCalibreSort\`).`
		: `\nCalibre is not set up, so this applies once \`calibreUrl\` is set (\`${p}config\`, Integrations) and \`audiobookCalibreSort\` is on.`;
}

function recordText(id, rec) {
	if (!rec) return `Calibre book #${id}`;
	const formats = Array.isArray(rec.formats) && rec.formats.length ? rec.formats.map((f) => f.toUpperCase()).join(', ') : 'no file';
	const by = calibreMatch().displayAuthors(rec.authors);
	return `Calibre #${id} “${esc(rec.title || 'untitled')}”${by ? ` by ${esc(by)}` : ''} (${formats})`;
}

async function pinCalibre(ctx, t, req) {
	const index = calibreIndex();
	const rec = req.id === null ? null : index.recordOf(req.id);
	const lib = index.status().libraryId;
	const patch = req.id === null
		? { calibreId: null, calibreUuid: CLEAR, calibreLibrary: CLEAR }
		: { calibreId: req.id, calibreUuid: rec && rec.uuid ? rec.uuid : CLEAR, calibreLibrary: lib || CLEAR };
	const saved = save((raw) => writeFields(raw, t.work, patch));
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: ${t.work.id} Calibre ${req.id === null ? 'none' : `#${req.id}`} set by the owner.`);
	try { index.rematch(); } catch (err) { logger.warn('!book edit: Calibre matching failed:', (err && err.message) || err); }
	const off = calibreOffNote();
	if (req.id === null) return ctx.say(`✏️ **${esc(t.work.title)}**: no Calibre book from now on, so nothing from Calibre fills its details or picks its section.${off}${saved.refreshNote}`);
	let missing = '';
	if (!rec && !off) {
		missing = `\nThe saved copy of the Calibre library has no book #${req.id}. It is read again now; \`${prefix()}book calibre\` shows whether the pin holds.`;
		index.refresh({ force: true }).catch(() => {});
	}
	return ctx.say(`✏️ **${esc(t.work.title)}**: ${recordText(req.id, rec)} from now on ${WINS}. It fills only details nothing else gave, and its tags can pick the section.${missing}${off}${saved.refreshNote}`);
}

function calibreLine(work) {
	const index = calibreIndex();
	if (!index.enabled()) return null;
	const m = index.matchFor(work);
	if (!m) return 'Calibre: not matched yet';
	if (m.method === 'pin' && m.id === null) return 'Calibre: none, by your edit';
	if (m.problem) return `Calibre: your pin to #${m.id} no longer holds (${m.problem === 'missing' ? 'the book is gone' : m.problem === 'uuid-changed' ? 'that id is another book now' : 'it is in another library'})`;
	if (m.verdict === 'ambiguous') return `Calibre: ambiguous between ${(m.candidates || []).map((id) => `#${id}`).join(', ')}`;
	if (m.id === null) return 'Calibre: no match';
	const how = m.method === 'pin' ? 'your pin' : m.method === 'link' ? 'your ebook link' : m.method === 'read-along' ? 'the read-along\'s ebook' : `${m.verdict}, ${m.method}`;
	return `Calibre: ${recordText(m.id, index.recordOf(m.id))} · ${how}`;
}

// ---- exclude, include, lookup ----------------------------------------------------------------

function savedPlaces(ctx, work) {
	if (!ctx.guildId) return 0;
	try {
		const bookmarks = require('../../helpers/bookmarks.js');
		const ids = new Set(idsOf(work));
		return bookmarks.leaderboardRows(ctx.guildId).filter((row) => bookmarks.forUser(row.userId).some((m) => ids.has(m.workId))).length;
	} catch (_) {
		return 0;
	}
}

// A build already running read the overrides before this edit, so exactly one more follows it.
async function rebuildAfterEdit() {
	const library = require('../../helpers/bookLibrary.js');
	try {
		return await library.rebuild({ force: true, after: 'current' });
	} catch (err) {
		logger.error('!book edit: the catalog rebuild threw:', (err && err.message) || err);
		return { ok: false };
	}
}

function notFinished(report) {
	const why = report && report.skipped === 'refreshing' ? 'Plex is scanning the library' : 'see the bot log';
	return `⚠️ The rebuild did not finish (${why}). The change is saved and applies at the next rescan.`;
}

async function exclude(ctx, t) {
	const p = prefix();
	// The folder goes beside the flag: a rule change or a late tag can move the work's id, never
	// its folder (bookCatalog.applyOverrides honours either).
	const patch = typeof t.work.folderKey === 'string' && t.work.folderKey ? { exclude: true, folderKey: t.work.folderKey } : { exclude: true };
	const saved = save((raw) => writeFields(raw, t.work, patch));
	if (!saved.ok) return ctx.say(saved.text);
	logger.info(`!book edit: ${t.work.id} excluded by the owner.`);
	const places = savedPlaces(ctx, t.work);
	const placeNote = places ? ` ${places === 1 ? '1 listener here has a place' : `${places} listeners here have a place`} saved in it; it is kept and comes back with \`${p}book edit ${t.work.id} include\`.` : '';
	await ctx.say(`🚫 Taking **${esc(t.work.title)}** out of the catalog; its tracks go back to the music library. Rebuilding the catalog, about 20 s.${placeNote}`);
	const report = await rebuildAfterEdit();
	if (!report || !report.ok) return ctx.say(notFinished(report));
	if (catalogStore().work(t.work.id)) return ctx.say(`⚠️ Rebuilt, but **${esc(t.work.title)}** is still in the catalog. Check its entry in book_overrides.json.`);
	return ctx.say(`✅ **${esc(t.work.title)}** is out of the catalog. \`${p}book edit ${t.work.id} include\` brings it back.`);
}

async function include(ctx, id) {
	const saved = save((raw) => {
		const works = worksOf(raw);
		const e = works[id];
		if (!isObject(e) || e.exclude !== true) return false;
		delete e.exclude;
		delete e.folderKey;
		if (!Object.keys(e).length) delete works[id];
		return undefined;
	});
	if (!saved.ok) return ctx.say(saved.text);
	if (!saved.changed) return ctx.say(`\`${id}\` is not excluded.`);
	logger.info(`!book edit: ${id} included by the owner.`);
	await ctx.say(`📚 Bringing \`${id}\` back into the catalog. Rebuilding the catalog, about 20 s.`);
	const report = await rebuildAfterEdit();
	if (!report || !report.ok) return ctx.say(notFinished(report));
	const back = catalogStore().work(id);
	if (!back) return ctx.say(`⚠️ Rebuilt, but \`${id}\` did not come back. Plex may no longer have it, or its id changed (\`${prefix()}book library\` lists what is there).`);
	return ctx.say(`✅ **${esc(back.title)}** is back in the catalog.`);
}

const SKIP_REASONS = {
	'not-a-book': 'podcasts are not looked up',
	doubtful: 'its grouping has doubts (the rescan lists them); a title or author edit, or an exclude, settles them',
	'no-author': 'it has no author to search by',
	'publisher-author': 'its author is a publisher\'s name',
	'no-title': 'it has no title to search by',
	excluded: 'it is excluded',
	locked: 'your edits already set every detail it could fill',
	off: 'the online lookup is off',
};

function onlineFilled(w) {
	const out = [];
	for (const f of ['title', 'series', 'sequence', 'narrator', 'publisher']) {
		if (sourceName(w, f) !== 'online') continue;
		if (f === 'title') out.push(`title case (${esc(w.title)})`);
		else if (f === 'series' || (f === 'sequence' && sourceName(w, 'series') !== 'online')) out.push(`series ${seriesText(w)}`);
		else if (f !== 'sequence') out.push(`${f} ${esc(w[f])}`);
	}
	return out;
}

/**
 * Waits until no lookup batch runs, at most `ms`. Every catalog build starts one, so refusing
 * while one ran would refuse most lookups asked for after an edit. refresh() hands back the
 * running batch, and the loop covers a batch the library starts the moment that one ends.
 * @returns {Promise<boolean>} false when one was still running at the limit
 */
async function waitForBatch(lookups, ms) {
	const deadline = Date.now() + ms;
	while (typeof lookups.isRunning === 'function' && lookups.isRunning()) {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		let timer = null;
		const limit = new Promise((resolve) => { timer = setTimeout(resolve, left); });
		try {
			await Promise.race([Promise.resolve(lookups.refresh([])).catch(() => null), limit]);
		} finally {
			clearTimeout(timer);
		}
	}
	return true;
}

async function lookup(ctx, t) {
	const p = prefix();
	if (config.audiobookOnlineLookup !== true) {
		return ctx.say(`🌐 The online lookup is off. The owner can turn it on with \`${p}config\`, under Audiobooks (\`audiobookOnlineLookup\`). It sends only a book's title and author.`);
	}
	const lookups = require('../../helpers/bookLookup.js').instance();
	const targets = t.exact ? [t.work] : t.group;
	const busy = typeof lookups.isRunning === 'function' && lookups.isRunning();
	await ctx.say(`🌐 Looking up **${esc(t.work.title)}** online${targets.length > 1 ? ` (${targets.length} recordings)` : ''}${busy ? ', after the batch of lookups running now' : ''}…`);
	if (!await waitForBatch(lookups, LOOKUP_WAIT_MS)) return ctx.say('🌐 A batch of online lookups is still running after a minute. Try again when it finishes.');
	let overrides = {};
	try {
		const read = catalogStore().readOverrides();
		overrides = read.error ? {} : read.overrides || {};
	} catch (_) {}
	const overrideOf = (w) => bookMetadata().overrideFor(w, overrides);
	const summary = await lookups.refresh(targets, { force: true, overrideOf });
	const fresh = catalogStore().refreshMetadata();
	const results = (summary && summary.results) || {};
	const lines = targets.map((w0) => {
		const w = current(w0);
		const r = results[w0.id] || {};
		const name = targets.length > 1 ? `\`${w0.id}\`` : `**${esc(w.title)}**`;
		if (r.outcome === 'edition' || r.outcome === 'book') {
			const filled = onlineFilled(w);
			const match = r.outcome === 'edition' ? 'this recording' : 'the book';
			return filled.length ? `${name}: found ${match}; filled in ${filled.join(', ')}.` : `${name}: found ${match}; nothing was blank, and online details only fill blanks.`;
		}
		if (r.outcome === 'none') return `${name}: not found online.`;
		if (r.outcome === 'skipped') return `${name}: skipped, ${SKIP_REASONS[r.reason] || 'it is not eligible'}.`;
		if (r.outcome === 'error') return `${name}: the lookup failed (${esc(r.reason || 'error')}); the local details stay.`;
		if (r.outcome === 'deferred') return `${name}: not looked up, after failures in a row. Try again later.`;
		return `${name}: no answer.`;
	});
	if (!fresh.ok) lines.push(`⚠️ The catalog could not be refreshed (${fresh.error}); what was found shows after the next rescan.`);
	return ctx.say(`🌐 ${lines.join('\n')}`);
}

// ---- show ------------------------------------------------------------------------------------

function showText(work, group) {
	const p = prefix();
	const store = catalogStore();
	let w = work;
	if (!isObject(w.sources)) {
		// A catalog saved before the metadata layer has no sources yet.
		try { w = bookMetadata().resolveWith(work, store.metadataContext()); } catch (_) {}
	}
	let ov = null;
	try {
		const read = store.readOverrides();
		ov = read.error ? null : bookMetadata().overrideFor(w, read.overrides);
	} catch (_) {}
	const lines = [`✏️ **${esc(w.title)}** (\`${w.id}\`)${w.kind === 'podcast' ? ', a podcast' : ''}`];
	for (const f of ['title', 'author', 'narrator', 'edition', 'publisher', 'series']) {
		const label = f[0].toUpperCase() + f.slice(1);
		let src = sourceName(w, f);
		if (f === 'series' && src === 'your edit' && !(ov && has(ov, 'series'))) src = 'your author-wide edit';
		let seqSrc = f === 'series' && w.series ? sourceName(w, 'sequence') : null;
		if (seqSrc === 'your edit' && !(ov && has(ov, 'sequence'))) seqSrc = 'your author-wide edit';
		const both = seqSrc && seqSrc !== src ? `${src || 'unknown'}, number from ${seqSrc}` : src;
		const empty = f === 'series' ? !w.series : !w[f];
		lines.push(`${label}: ${empty ? '-' : valueText(w, f)}${both && !empty ? ` · ${both}` : ''}${empty && src === 'your edit' ? ' · none, by your edit' : ''}`);
	}
	const section = sectionText(w);
	if (section) lines.push(`Section: ${section}`);
	const calibre = calibreLine(w);
	if (calibre) lines.push(calibre);
	const reasons = (Array.isArray(w.doubts) ? w.doubts : []).map(doubtReason).filter(Boolean);
	if (reasons.length) lines.push(`⚠️ Doubts: ${reasons.join('; ')}.`);
	const others = group.filter((x) => x.id !== w.id);
	if (others.length) lines.push(`Other recordings of this title (title, series and section edits reach them too): ${others.slice(0, LIST_MAX).map((x) => `\`${x.id}\`${suffixOf(x)}`).join(', ')}`);
	lines.push(`Change: \`${p}book edit ${w.id} title|author|narrator|publisher <value>\`, \`series <name> [number]\`, \`author-series <name> [number]\`, \`genre <section>\`, \`calibre <id|none>\`, \`clear <detail|all>\`, \`exclude\`, \`lookup\`. \`${p}book edit\` explains each.`);
	return lines.join('\n');
}

// ---- dispatch --------------------------------------------------------------------------------

async function run(ctx) {
	const p = prefix();
	const owner = String(config.ownerId || '').trim();
	if (!owner) return ctx.say(`⛔ Set ownerId first (\`${p}config\` → Access); editing the book catalog is owner-only.`);
	if (String(ctx.userId) !== owner) return ctx.say('⛔ Only the bot owner can edit book details.');
	const interaction = ctx.interaction;
	const parsed = interaction && interaction.options && typeof interaction.options.get === 'function'
		? parseSlash(interaction)
		: parsePrefix(ctx.rest, namesWork);
	if (parsed.help) return ctx.say(usage(p));
	if (parsed.error) return ctx.say(parsed.error);
	const { workText, req } = parsed;

	if (req.action === 'include' || req.action === 'exclude') {
		const store = catalogStore();
		if (!store.work(workText)) {
			const id = findExcluded(workText);
			if (id) return req.action === 'include' ? include(ctx, id) : ctx.say(`\`${id}\` is already out of the catalog.`);
		}
	}
	const t = findTarget(workText);
	if (t.error) return ctx.say(t.error);
	if (req.action === 'include') return ctx.say(`**${esc(t.work.title)}** is already in the catalog.`);

	const single = ONE_RECORDING.has(req.action) || ONE_RECORDING.has(req.field) || (req.action === 'clear' && req.field === 'all');
	if (single && t.group.length > 1 && !t.exact) {
		return ctx.say(`That changes one recording, and **${esc(t.work.title)}** has ${t.group.length}. Use the id:\n${idList(t.group)}`);
	}
	t.groupWide = !single;

	switch (req.action) {
		case 'show': return ctx.say(showText(t.work, t.group));
		case 'set':
		case 'series': return editFields(ctx, t, req);
		case 'author-series': return authorSeries(ctx, t, req);
		case 'genre': return editGenre(ctx, t, req);
		case 'author-genre': return authorGenre(ctx, t, req);
		case 'calibre': return pinCalibre(ctx, t, req);
		case 'clear': return clearField(ctx, t, req);
		case 'exclude': return exclude(ctx, t);
		case 'lookup': return lookup(ctx, t);
		default: return ctx.say(usage(p));
	}
}

module.exports = { names: ['edit'], run, usage, parsePrefix, parseSlash, parseArgs, tokenize, writeFields, writeAuthorSeries, writeAuthorGenre, waitForBatch, CLEAR };
