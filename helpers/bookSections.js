// helpers/bookSections.js
//
// The section each work is listed under in the library: its genre. The field is called genre and
// the grouping sections, because "shelf" already means a listener's own /book shelf.
//
// Per work, the first source that names a section wins:
//   1. podcasts are always "Podcasts";
//   2. the owner's genre for the work (book_overrides.json works[id].genre, found by id or alias);
//   3. the owner's genre for the author (authors[slug].genre);
//   4. the owner's folder: the deepest folder between the work's music root and the folder all its
//      files share that holds works by 3 or more authors, by its own name ("Mythology", "Myth
//      Retellings"). An author's folder ("Brandon Sanderson", "White T.H") or a book's own part
//      folders hold one author and never count;
//   5. the tags of the Calibre record the work matches exactly or by pin, through the allowlist;
//   6. the genres embedded in the files or set in Plex (work.genres), through the allowlist;
//   7. the tags of a likely Calibre match, through the allowlist;
//   8. the majority section of the work's series siblings that got one from 2-7, then the section
//      of the author's other works when all of them that got one agree;
//   9. "More books".
//
// The allowlist matches whole tag segments, case aside: a tag is cut on ";", ",", "/" and " - "
// (never on "&", which belongs to names such as "Fantasy & Magic"), and the first section in list
// order that any segment names wins. A segment that names no section ("Fiction", "General",
// "Audiobook", "Epic", "Literature", age bands, store or uploader tags) counts for nothing, so a
// Calibre record tagged Poetry and Epic is filed under Classics and never under Fantasy.

const bookCatalog = require('./bookCatalog.js');
const bookMetadata = require('./bookMetadata.js');

const MORE = 'More books';
const PODCASTS = 'Podcasts';
const FOLDER_MIN_AUTHORS = 3;

// [section, segments it accepts, segments accepted only from embedded genres]
const ALLOWLIST = Object.freeze([
	['Fantasy', ['fantasy', 'epic fantasy', 'dark fantasy', 'fantasy & magic', 'fantasy fiction', 'dragons & mythical creatures', 'historical & mythological fiction'], []],
	['Science Fiction', ['science fiction', 'hard science fiction', 'sci-fi', 'sci fi', 'scifi', 'space opera', 'dystopian'], []],
	['Mythology', ['mythology', 'greek mythology', 'legends & mythology'], []],
	['Horror', ['horror', 'occult & supernatural'], []],
	['Mystery & Thriller', ['thriller', 'mystery', 'mystery & detective', 'suspense'], []],
	['Classics', ['classics', 'poetry'], ['drama']],
	['Nonfiction', ['nonfiction', 'non-fiction', 'history', 'biography'], []],
].map(([name, segs, embeddedOnly]) => Object.freeze({ name, segs: new Set(segs), embeddedOnly: new Set(embeddedOnly) })));
const SECTIONS = Object.freeze([...ALLOWLIST.map((a) => a.name), PODCASTS, MORE]);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function segmentsOf(tag) {
	return String(tag || '').split(/\s*[;,/]\s*|\s+-\s+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
}

/**
 * The section a list of tags names, or null.
 * @param {string[]} tags
 * @param {{ embedded?: boolean }} [opts] embedded: the tags come from the files or Plex
 */
function mapGenre(tags, { embedded = false } = {}) {
	const segs = new Set();
	for (const t of Array.isArray(tags) ? tags : []) for (const s of segmentsOf(t)) segs.add(s);
	if (!segs.size) return null;
	for (const a of ALLOWLIST) {
		for (const s of segs) {
			if (a.segs.has(s) || (embedded && a.embeddedOnly.has(s))) return a.name;
		}
	}
	return null;
}

function segs(p) {
	return String(p || '').split(/[\\/]+/).filter(Boolean);
}

function commonDir(dirs) {
	const lists = (Array.isArray(dirs) ? dirs : []).filter(nonEmpty).map(segs);
	if (!lists.length) return [];
	const out = [];
	for (let i = 0; i < lists[0].length; i++) {
		const s = lists[0][i];
		if (!lists.every((l) => l.length > i && l[i].toLowerCase() === s.toLowerCase())) break;
		out.push(s);
	}
	return out;
}

const authorKey = (w) => bookCatalog.norm((isObject(w.detected) && w.detected.author) || w.author) || null;

// A catalog built before rules version 5 has no work.root; the deepest music root holding the
// work's first folder stands in.
function rootOf(w, roots) {
	if (nonEmpty(w.root)) return segs(w.root);
	const first = segs(Array.isArray(w.dirs) ? w.dirs[0] : '').map((x) => x.toLowerCase());
	let best = [];
	for (const r of Array.isArray(roots) ? roots : []) {
		const rs = segs(r);
		if (rs.length > best.length && rs.length <= first.length && rs.every((x, i) => x.toLowerCase() === first[i])) best = rs;
	}
	return best;
}

/** Folder sections by work id: the deepest shared folder under the root with 3 or more authors. */
function folderSections(works, roots = []) {
	const candidates = new Map();
	const authorsUnder = new Map();
	for (const w of works) {
		const root = rootOf(w, roots);
		const common = commonDir(w.dirs);
		if (!root.length || common.length <= root.length) continue;
		if (!root.every((s, i) => common[i] && common[i].toLowerCase() === s.toLowerCase())) continue;
		const list = [];
		for (let n = root.length + 1; n <= common.length; n++) {
			const k = common.slice(0, n).join('/').toLowerCase();
			list.push({ k, name: common[n - 1] });
			const a = authorKey(w);
			if (!a) continue;
			if (!authorsUnder.has(k)) authorsUnder.set(k, new Set());
			authorsUnder.get(k).add(a);
		}
		candidates.set(w.id, list);
	}
	const out = new Map();
	for (const [id, list] of candidates) {
		for (let i = list.length - 1; i >= 0; i--) {
			const set = authorsUnder.get(list[i].k);
			if (set && set.size >= FOLDER_MIN_AUTHORS) {
				out.set(id, list[i].name);
				break;
			}
		}
	}
	return out;
}

function seriesKey(w) {
	return nonEmpty(w.series) ? `${bookCatalog.norm(w.series)}|${authorKey(w) || ''}` : null;
}

function majority(names) {
	const counts = new Map();
	for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	if (!ranked.length) return null;
	// A tie names no winner: half a series in Fantasy and half in Science Fiction says nothing.
	if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
	return ranked[0][0];
}

/**
 * Every work's section and where it came from.
 * @param {object[]} works catalog works
 * @param {object} [ctx]
 * @param {object} [ctx.overrides] the parsed book_overrides.json
 * @param {string[]} [ctx.roots] the music roots, for works saved without work.root
 * @param {(work: object) => { verdict: 'exact'|'likely', tags: string[] }|null} [ctx.calibreOf]
 *   the Calibre index's genreOf
 * @returns {Map<string, { section: string, source: 'podcast'|'override'|'author-override'|'folder'|'calibre'|'tags'|'calibre-likely'|'series'|'author'|'none' }>}
 */
function sectionsFor(works, { overrides = {}, roots = [], calibreOf = () => null } = {}) {
	const list = (Array.isArray(works) ? works : []).filter((w) => isObject(w) && typeof w.id === 'string');
	const folders = folderSections(list.filter((w) => w.kind !== 'podcast'), roots);
	const out = new Map();
	const safeCalibre = (w) => { try { return calibreOf(w) || null; } catch (_) { return null; } };
	for (const w of list) {
		if (w.kind === 'podcast') { out.set(w.id, { section: PODCASTS, source: 'podcast' }); continue; }
		const own = bookMetadata.extrasFor(w, overrides).genre;
		if (own) { out.set(w.id, { section: own, source: 'override' }); continue; }
		const a = bookMetadata.authorOverrideFor(w, overrides);
		if (a && nonEmpty(a.genre)) { out.set(w.id, { section: a.genre.trim(), source: 'author-override' }); continue; }
		if (folders.has(w.id)) { out.set(w.id, { section: folders.get(w.id), source: 'folder' }); continue; }
		const cal = safeCalibre(w);
		const exact = cal && cal.verdict === 'exact' ? mapGenre(cal.tags) : null;
		if (exact) { out.set(w.id, { section: exact, source: 'calibre' }); continue; }
		const embedded = mapGenre(w.genres, { embedded: true });
		if (embedded) { out.set(w.id, { section: embedded, source: 'tags' }); continue; }
		const likely = cal && cal.verdict === 'likely' ? mapGenre(cal.tags) : null;
		if (likely) { out.set(w.id, { section: likely, source: 'calibre-likely' }); continue; }
	}

	const direct = new Map(out);
	const bySeries = new Map();
	const byAuthor = new Map();
	for (const w of list) {
		const hit = direct.get(w.id);
		if (!hit || hit.source === 'podcast') continue;
		const s = seriesKey(w);
		if (s) (bySeries.get(s) || bySeries.set(s, []).get(s)).push(hit.section);
		const a = authorKey(w);
		if (a) (byAuthor.get(a) || byAuthor.set(a, []).get(a)).push(hit.section);
	}
	for (const w of list) {
		if (out.has(w.id)) continue;
		const s = seriesKey(w);
		const fromSeries = s && bySeries.has(s) ? majority(bySeries.get(s)) : null;
		if (fromSeries) { out.set(w.id, { section: fromSeries, source: 'series' }); continue; }
		const a = authorKey(w);
		const mine = a && byAuthor.has(a) ? new Set(byAuthor.get(a).map((x) => x.toLowerCase())) : null;
		if (mine && mine.size === 1) { out.set(w.id, { section: byAuthor.get(a)[0], source: 'author' }); continue; }
		out.set(w.id, { section: MORE, source: 'none' });
	}
	return out;
}

/**
 * The works grouped for the library view: the biggest section first, Podcasts and More books
 * last, works in catalog order inside each. Sections spelled differently only in case are one.
 * @param {object[]} works
 * @param {Map<string, { section: string }>} sections from sectionsFor()
 * @returns {Array<{ section: string, works: object[] }>}
 */
function groupBySection(works, sections) {
	const groups = new Map();
	for (const w of Array.isArray(works) ? works : []) {
		const hit = sections && sections.get(w.id);
		const name = hit ? hit.section : MORE;
		const k = name.toLowerCase();
		if (!groups.has(k)) groups.set(k, { section: name, works: [] });
		groups.get(k).works.push(w);
	}
	const last = (g) => (g.section === MORE ? 2 : g.section === PODCASTS ? 1 : 0);
	return [...groups.values()].sort((a, b) => last(a) - last(b) || b.works.length - a.works.length || a.section.localeCompare(b.section));
}

/**
 * A typed section name in the spelling the library already uses ("science fiction" becomes
 * "Science Fiction"), or the name as typed when none matches.
 * @param {string} name
 * @param {Iterable<string>} [known] section names in use, besides the allowlist's
 */
function canonicalSection(name, known = []) {
	const t = String(name || '').trim().replace(/\s+/g, ' ');
	const k = t.toLowerCase();
	for (const s of [...SECTIONS, ...known]) if (String(s).toLowerCase() === k) return s;
	return t;
}

/**
 * sectionsFor over the stored catalog, with the overrides file, the catalog's music roots and the
 * Calibre index (silent while it is off). Memory and one file read; never Calibre or Plex.
 * @param {object} [deps] test seams: catalog (bookCatalogStore's shape), calibreIndex
 */
function sectionsNow(deps = {}) {
	const catalog = deps.catalog || require('./bookCatalogStore.js');
	const index = deps.calibreIndex || require('./calibreIndex.js').instance();
	const read = catalog.readOverrides();
	const meta = catalog.meta() || {};
	return sectionsFor(catalog.works() || [], {
		overrides: read.error ? {} : read.overrides || {},
		roots: Array.isArray(meta.roots) ? meta.roots : [],
		calibreOf: (w) => (index.enabled() ? index.genreOf(w) : null)
	});
}

module.exports = {
	sectionsFor,
	sectionsNow,
	groupBySection,
	mapGenre,
	folderSections,
	canonicalSection,
	SECTIONS,
	MORE,
	PODCASTS,
};
