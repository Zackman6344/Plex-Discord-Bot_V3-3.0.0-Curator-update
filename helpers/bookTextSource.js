// helpers/bookTextSource.js
//
// Finds the ebook behind an audiobook and hands the read-along its extracted text.
//
// Sources, in order: a link the owner set with `!book link` (a Calibre id or an EPUB path, or
// "off"); the Calibre content server (GET only, matched by title, or by series number and
// author; a work with no pointer yet first tries the exact match of the catalog's Calibre index,
// helpers/calibreIndex.js, when it has an EPUB); then EPUB files sitting in the folders that hold
// the work's audio. Calibre comes before the sidecars because its copy is the one the user curates.
//
// The parse itself never runs here. A 115 MB image-heavy EPUB would stall the voice timer, so it
// goes to helpers/epubTextWorker.js, which parses in a separate Below Normal process and writes
// two files: `<base>.txt` (the text) and `<base>.json` (the section index, written last, so it
// marks a complete pair). This module only reads those back, a section at a time.
//
// The cache is content-addressed. `base` is a hash of the extractor version and the source's
// fingerprint (the Calibre EPUB's own size and mtime, or a file's path, size and mtime), never of
// the work. So a changed ebook parses into NEW files while a handle opened earlier keeps reading
// its own, two narrator editions of one ebook share one parse, and which files a work uses is
// only a pointer in data/book_text/works.json. Old files are deleted by a sweep when the process
// starts, never while a handle might be reading them. A Calibre pointer also keeps the book's
// title, authors and series (`meta`), which the catalog shows above tags and folder names
// (helpers/bookMetadata.js); they never reach a work id.
//
// What is remembered in memory, and for how long, is the subtle part:
//   - A handle, once opened, is returned at once and re-checked in the background every 10
//     minutes, so a slow Calibre never delays a page; a changed ebook is swapped in afterwards
//     and onChange fires.
//   - Stable failures (no ebook, ambiguous, DRM, unreadable, too large, off) are remembered until
//     the catalog is rebuilt or the owner runs `!book link`; transient ones (Calibre closed, a
//     login problem, a timeout) for 30 s. Only background callers honour this memo: anything a
//     person did asks again, because "open Calibre and try again" must work at once.
//   - With Calibre closed the answer is never "no ebook", only "Calibre isn't answering", and a
//     text read earlier is served from the cache (stale) instead.
//   - A failed parse leaves `<base>.fail.json`, so a known-bad 115 MB file is not re-read after
//     every restart; `!book link` clears it.

const crypto = require('crypto');
const path = require('path');
const { createCalibreClient, hasEpub } = require('./calibreClient.js');
const { norm, basename } = require('./bookCatalog.js');
const calibreMatch = require('./calibreMatch.js');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'book_text');
const MAX_EPUB_BYTES = 300 * 1024 * 1024;
const TRANSIENT_TTL_MS = 30 * 1000;
const REVALIDATE_MS = 10 * 60 * 1000;
const FAIL_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TITLE_MATCH = 0.8;
const SIDECAR_MATCH = 0.6;

const STABLE = new Set(['no-ebook', 'ambiguous', 'drm', 'parse-error', 'too-large', 'off']);
const TRANSIENT = new Set(['calibre-unreachable', 'calibre-auth', 'calibre-off', 'bad-url', 'timeout', 'crash']);
// Failures that say something about the ebook itself; a cached copy of a different fingerprint
// is no answer to them.
const VERDICTS = new Set(['drm', 'parse-error', 'too-large', 'off']);

// Downloads and parses in flight, by cache directory and base, shared by every source in this
// process: !restart builds a new source while the old one's download may still be running, and
// the new one must neither sweep its files nor start a second download to the same path.
const IN_FLIGHT = new Map();

const STOP = new Set(['the', 'a', 'an', 'of', 'and']);
const SERIES_FILLER = new Set(['saga', 'series', 'archive', 'cycle', 'book', 'books']);

function sha1(text) {
	return crypto.createHash('sha1').update(text).digest('hex');
}

function extractorVersion() {
	return require('./epubText.js').EXTRACTOR_VERSION;
}

/** The cache files' shared name: 16 hex characters, so always a safe Windows file name. */
function cacheBase(fingerprint, version = extractorVersion()) {
	return sha1(`${version}|${fingerprint}`).slice(0, 16);
}

function versionOf(parse) {
	if (parse && parse.VERSION !== undefined) return parse.VERSION;
	if (parse && parse.parseEpub && parse.parseEpub.VERSION !== undefined) return parse.parseEpub.VERSION;
	return extractorVersion();
}

let sharedCalibre = null;

/** One client per distinct set of Calibre settings, so a /config change takes effect at once. */
function calibreFromConfig(cfg) {
	const url = String((cfg && cfg.calibreUrl) || '').trim();
	if (!url) return null;
	const settings = {
		url,
		libraryId: String(cfg.calibreLibraryId || '').trim(),
		username: String(cfg.calibreUsername || ''),
		password: String(cfg.calibrePassword || '')
	};
	const key = sha1(JSON.stringify(settings));
	if (!sharedCalibre || sharedCalibre.key !== key) sharedCalibre = { key, client: createCalibreClient(settings) };
	return sharedCalibre.client;
}

/** The production wiring. Exported so a test can prove the parse never runs inline. */
function defaults() {
	return {
		parse: require('./epubTextWorker.js'),
		calibre: () => calibreFromConfig(require('../config/config.js')),
		catalog: () => require('./bookCatalogStore.js')
	};
}

// --- matching --------------------------------------------------------------------------------

function words(text) {
	return norm(text).split(' ').filter(Boolean);
}

function significant(text) {
	return new Set(words(text).filter((w) => !STOP.has(w)));
}

function seriesWords(series) {
	return new Set(words(series).filter((w) => !STOP.has(w) && !SERIES_FILLER.has(w)));
}

function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	let both = 0;
	for (const w of a) if (b.has(w)) both++;
	return both / (a.size + b.size - both);
}

function surnameOf(author) {
	const parts = String(author || '').replace(/["\\]/g, '').trim().split(/\s+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : '';
}

// The best of the titles as given, cleaned of brackets, "Book One of ..." and "A Novel", and their
// main titles before a subtitle, with number words as digits: "The Eye of the World: Book One of
// the Wheel of Time" against "The Eye of the World: Book 1 of the Wheel of Time (Now a Major TV
// Series)" scored 0.45 on the raw words. calibreMatch keeps a main title that is only a series
// name ("Ashfall - Collected Tales" cut to "Ashfall") from matching a record titled "Ashfall".
function calibreScore(book, work) {
	const titleScore = Math.max(
		jaccard(significant(work.title), significant(book.title)),
		calibreMatch.titleScore(work.title, work.series, book.title, book.series)
	);
	const surname = norm(surnameOf(work.author));
	const authorMatch = !!surname && (Array.isArray(book.authors) ? book.authors : []).some((a) => words(a).includes(surname));
	const ws = seriesWords(work.series);
	const bs = seriesWords(book.series);
	const seriesMatch = ws.size > 0 && bs.size > 0 && [...ws].some((w) => bs.has(w))
		&& work.sequence !== null && work.sequence !== undefined
		&& Number(book.series_index) === Number(work.sequence);
	const byTitle = titleScore >= TITLE_MATCH;
	const bySeries = seriesMatch && authorMatch;
	return {
		titleScore,
		seriesMatch,
		authorMatch,
		accepted: byTitle || bySeries,
		rank: (byTitle ? 2 * titleScore : 0) + (bySeries ? 1 : 0)
	};
}

function sidecarScore(name, work) {
	const title = significant(work.title);
	const series = new Set(words(work.series));
	const all = words(String(name).replace(/\.epub$/i, '')).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
	const trimmed = all.filter((w) => !series.has(w) && !SERIES_FILLER.has(w));
	// The untrimmed score covers a title made of series or filler words ("The Book of Ash").
	return Math.max(jaccard(new Set(trimmed), title), jaccard(new Set(all), title));
}

// --- ISBNs and paths ---------------------------------------------------------------------------

function isbn13Check(twelve) {
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 ? 3 : 1);
	return String((10 - (sum % 10)) % 10);
}

function isbn10Check(nine) {
	let sum = 0;
	for (let i = 0; i < 9; i++) sum += Number(nine[i]) * (10 - i);
	const c = (11 - (sum % 11)) % 11;
	return c === 10 ? 'X' : String(c);
}

/** @returns {string[]} the ISBN as given and its other length, 13-digit form first; [] if not one */
function isbnForms(raw) {
	const s = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
	if (/^\d{9}[\dX]$/.test(s)) {
		const core = `978${s.slice(0, 9)}`;
		return [`${core}${isbn13Check(core)}`, s];
	}
	if (/^97[89]\d{10}$/.test(s)) {
		return s.startsWith('978') ? [s, `${s.slice(3, 12)}${isbn10Check(s.slice(3, 12))}`] : [s];
	}
	return [];
}

/**
 * Why a path typed into `!book link` may not be read, decided WITHOUT touching the file system:
 * opening \\host\share makes Windows start an SMB session to that host and send the bot account's
 * NTLM hash, so UNC, \\?\ and \\.\ paths and their // spellings are refused before any stat.
 * A mapped drive letter or a local link that points at a share passes: only the string is read.
 * @returns {'empty'|'unc'|'relative'|null}
 */
function localPathProblem(raw, platform = process.platform) {
	const s = String(raw || '').trim();
	if (!s) return 'empty';
	if (s.startsWith('\\\\') || s.startsWith('//') || s.startsWith('\\/') || s.startsWith('/\\')) return 'unc';
	if (platform === 'win32') {
		if (!/^[A-Za-z]:[\\/]/.test(s)) return 'relative';
		if (/^\\\\\?\\UNC\\/i.test(path.win32.toNamespacedPath(s))) return 'unc';
		return null;
	}
	return s.startsWith('/') ? null : 'relative';
}

// --- the source --------------------------------------------------------------------------------

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function samePath(a, b) {
	const n = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
	return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// A pointer recorded under one link must not answer for another: after `!book link` names a
// different book, or `auto` clears a link, the old text is no longer this work's.
function pointerUsable(ptr, link) {
	if (!isObject(ptr) || !isObject(ptr.source) || typeof ptr.base !== 'string') return false;
	if (link && link.type === 'calibre') return ptr.source.type === 'calibre' && Number(ptr.source.id) === Number(link.id);
	if (link && link.type === 'file') return ptr.source.type === 'file' && samePath(ptr.source.path, link.path);
	if (link) return false;
	return ptr.via !== 'link';
}

const META_MAX = 300;

/**
 * The catalog fields of a Calibre book record, kept on the text pointer so the catalog's metadata
 * layer can show the owner's curated title, authors and series without asking Calibre. Calibre's
 * "Unknown" placeholders are no value, and its default series index of 1 counts only beside a
 * series name.
 */
function calibreMetaFrom(book) {
	if (!isObject(book)) return null;
	const text = (v) => (typeof v === 'string' && v.trim() && !/^unknown$/i.test(v.trim()) ? v.trim().slice(0, META_MAX) : null);
	const series = text(book.series);
	const index = Number(book.series_index);
	return {
		title: text(book.title),
		authors: (Array.isArray(book.authors) ? book.authors : []).map(text).filter(Boolean).slice(0, 10),
		series,
		seriesIndex: series && book.series_index !== null && book.series_index !== '' && Number.isFinite(index) ? index : null
	};
}

/** The Calibre meta of a work's text pointer, or null when the pointer is not a usable Calibre one. */
function calibreMetaOf(ptr, link) {
	if (!pointerUsable(ptr, link) || ptr.source.type !== 'calibre' || !isObject(ptr.meta)) return null;
	return JSON.parse(JSON.stringify(ptr.meta));
}

function failCodeOf(code) {
	if (code === 'drm') return 'drm';
	if (code === 'too-large') return 'too-large';
	return 'parse-error';
}

function parseFailCode(code) {
	if (code === 'drm' || code === 'timeout' || code === 'too-large') return code;
	// io-error is a file locked, missing or on a full disk at parse time: it can pass, so it must
	// not be remembered as an unreadable ebook.
	if (code === 'crash' || code === 'shutdown' || code === 'io-error') return 'crash';
	return 'parse-error';
}

/**
 * @param {object} [deps] every omitted dependency comes from the production wiring
 * @param {string} [deps.dir] the book_text directory; PLEXBOT_BOOK_TEXT_DIR otherwise, and
 *   required under the test runner, where the source is disabled without one
 */
function createBookTextSource(deps = {}) {
	const cfg = deps.cfg || require('../config/config.js');
	const parse = deps.parse || require('./epubTextWorker.js');
	const catalog = deps.catalog || (() => require('./bookCatalogStore.js'));
	const calibre = deps.calibre || (() => calibreFromConfig(cfg));
	// The catalog's Calibre index (helpers/calibreIndex.js), off under the test runner by default.
	const indexPick = deps.indexPick || ((work) => require('./calibreIndex.js').instance().readAlongPick(work));
	const store = deps.store || require('./bookTextStore.js');
	const fs = deps.fs || require('fs');
	const fsp = fs.promises;
	const now = deps.now || Date.now;
	const logger = deps.logger || require('./logger.js');
	const VERSION = versionOf(parse);
	const rootDir = deps.dir || process.env.PLEXBOT_BOOK_TEXT_DIR || (process.env.NODE_TEST_CONTEXT ? null : DEFAULT_DIR);
	const cacheDir = rootDir ? path.join(rootDir, 'cache') : null;

	const handles = new Map();
	const memo = new Map();
	const probes = new Map();
	const flights = new Map();
	const generations = new Map();
	const listeners = new Set();
	let sweeping = null;
	let closed = false;

	const prefix = () => (cfg && cfg.commandPrefix) || '!';
	const generation = (id) => generations.get(id) || 0;

	function textFor(code, r = {}) {
		const p = prefix();
		switch (code) {
			case 'off': return 'Read-along is switched off for this book.';
			case 'no-ebook': return `I couldn't find an ebook for this book in Calibre or next to its audio files. The owner can tie one to it with \`${p}book link\`.`;
			case 'ambiguous': return `More than one ebook could be this book, so none was picked. The owner can choose one with \`${p}book link\`.`;
			case 'calibre-unreachable': return 'Calibre isn\'t answering. Open the Calibre app once (its content server only runs while the app is open); after that the text is kept.';
			case 'calibre-auth': return r.reason === 'basic-over-http'
				? 'Calibre asked for a plain-text (Basic) login over http, so the password was not sent. Use Calibre\'s default Digest login, or an https calibreUrl.'
				: `Calibre asked for a login; set calibreUsername and calibrePassword with \`${p}config\` → Integrations.`;
			case 'calibre-off': return `Calibre is turned off (calibreUrl is blank in \`${p}config\` → Integrations).`;
			case 'bad-url': return r.reason === 'login-in-url'
				? `The Calibre URL must not contain a login; put it in calibreUsername and calibrePassword (\`${p}config\` → Integrations).`
				: `The Calibre URL isn't a valid http(s) address; fix calibreUrl with \`${p}config\` → Integrations.`;
			case 'drm': return 'This ebook is DRM-protected, so its text can\'t be read.';
			case 'parse-error': return 'This ebook couldn\'t be read: the file looks damaged or isn\'t an ordinary EPUB.';
			case 'too-large': return `This ebook is too large to read (over ${MAX_EPUB_BYTES / 1048576} MB).`;
			case 'timeout': return 'Reading this ebook took too long. Try again in a minute.';
			case 'crash': return 'Reading this ebook failed unexpectedly. Try again in a minute.';
			case 'podcast': return 'Read-along is for books; podcasts have no ebook.';
			case 'disabled': return `Read-along is turned off (\`${p}config\` → Audiobooks).`;
			default: return 'There is no text for this book.';
		}
	}

	const fail = (code, r) => ({ ok: false, code, text: textFor(code, r) });

	function stamp() {
		try {
			const meta = catalog().meta();
			return meta && meta.builtAt !== undefined ? meta.builtAt : null;
		} catch (_) {
			return null;
		}
	}

	// A session can hold a work object captured before a catalog rebuild added dirs and publisher.
	function fresh(work) {
		if (!work || typeof work.id !== 'string') return work;
		try {
			const c = catalog();
			const hit = c && typeof c.work === 'function' ? c.work(work.id) : null;
			return hit || work;
		} catch (_) {
			return work;
		}
	}

	const enabled = () => cfg.audiobookTextEnabled !== false && !!cacheDir;

	function gate(work) {
		if (!work || typeof work.id !== 'string') return 'no-ebook';
		if (!enabled()) return 'disabled';
		if (work.kind === 'podcast') return 'podcast';
		return null;
	}

	function remember(id, code, r) {
		if (STABLE.has(code)) memo.set(id, { code, text: textFor(code, r), stable: true, stamp: stamp() });
		else if (TRANSIENT.has(code)) memo.set(id, { code, text: textFor(code, r), stable: false, at: now() });
	}

	function recalled(id) {
		const m = memo.get(id);
		if (!m) return null;
		if (m.stable ? m.stamp === stamp() : now() - m.at < TRANSIENT_TTL_MS) return m;
		memo.delete(id);
		return null;
	}

	function recalledProbe(id) {
		const p = probes.get(id);
		if (!p) return null;
		if (p.stable ? p.stamp === stamp() : now() - p.at < TRANSIENT_TTL_MS) return p;
		probes.delete(id);
		return null;
	}

	const statusOfMemo = (m) => (m.stable ? (m.code === 'off' ? 'off' : 'none') : 'unknown');

	function emit(id) {
		for (const fn of listeners) {
			try {
				fn(id);
			} catch (err) {
				logger.warn('Read-along source listener failed:', err && err.message ? err.message : err);
			}
		}
	}

	function safe(fn, fallback = null) {
		try {
			return fn();
		} catch (_) {
			return fallback;
		}
	}

	function status(workIn) {
		const work = fresh(workIn);
		if (!work || typeof work.id !== 'string') return 'unknown';
		if (!enabled()) return 'off';
		if (work.kind === 'podcast') return 'none';
		const link = safe(() => store.links.get(work));
		if (link && link.type === 'off') return 'off';
		if (handles.has(work.id)) return 'ready';
		const m = recalled(work.id);
		if (m) return statusOfMemo(m);
		const p = recalledProbe(work.id);
		if (p) return p.status;
		const ptr = safe(() => store.works.peek(work));
		if (ptr && pointerUsable(ptr, link)) return 'ready';
		return 'unknown';
	}

	function changed(work, before) {
		if (status(work) !== before) emit(work.id);
	}

	// --- files ---

	const fileOf = (base, ext) => path.join(cacheDir, `${base}.${ext}`);

	function textPathOf(base, index) {
		return path.join(cacheDir, path.basename(String((index && index.textFile) || `${base}.txt`)));
	}

	/** @returns {Promise<{ index?: object, fail?: string }>} */
	async function readCache(base, fingerprint) {
		let index = null;
		try {
			index = JSON.parse(await fsp.readFile(fileOf(base, 'json'), 'utf8'));
		} catch (_) {
			index = null;
		}
		if (isObject(index) && index.version === VERSION && isObject(index.source)
			&& index.source.fingerprint === fingerprint && Array.isArray(index.sections)) {
			try {
				const st = await fsp.stat(textPathOf(base, index));
				if (st.size === index.textBytes) return { index };
			} catch (_) { /* the text half is missing: parse again */ }
		}
		try {
			const rec = JSON.parse(await fsp.readFile(fileOf(base, 'fail.json'), 'utf8'));
			if (isObject(rec) && (!rec.fingerprint || rec.fingerprint === fingerprint)) return { fail: failCodeOf(rec.code) };
		} catch (_) { /* no fail record */ }
		return {};
	}

	async function removeFailRecord(base) {
		await fsp.rm(fileOf(base, 'fail.json'), { force: true }).catch(() => {});
	}

	function labelOf(source, via) {
		if (source && source.type === 'calibre') return `Calibre #${source.id}`;
		return via === 'link' ? 'linked EPUB' : 'EPUB next to the audio';
	}

	function makeHandle(workId, base, index, source, via) {
		const textFile = textPathOf(base, index);
		return {
			workId,
			base,
			tag: base.slice(0, 4),
			fingerprint: source.fingerprint,
			index,
			source: JSON.parse(JSON.stringify(source)),
			via,
			label: labelOf(source, via),
			// Content-addressed: the bytes behind this handle are never rewritten, even when a
			// newer copy of the ebook is parsed while it is in use.
			async readSection(i) {
				const s = index.sections[i];
				if (!s || !(s.byteLen > 0)) return '';
				const fh = await fsp.open(textFile, 'r');
				try {
					const buf = Buffer.alloc(s.byteLen);
					const { bytesRead } = await fh.read(buf, 0, s.byteLen, s.byteStart);
					return buf.toString('utf8', 0, bytesRead);
				} finally {
					await fh.close();
				}
			}
		};
	}

	// `meta` is the Calibre book's catalog fields when this call has the record in hand; undefined
	// keeps what the pointer already holds for the same book (a text served from the cache).
	function setPointer(work, base, source, via, meta) {
		const prev = safe(() => store.works.peek(work.id));
		const sameBook = prev && isObject(prev.source) && prev.source.type === 'calibre' && source.type === 'calibre' && Number(prev.source.id) === Number(source.id);
		const nextMeta = source.type !== 'calibre' ? null : (meta !== undefined ? meta : (sameBook && isObject(prev.meta) ? prev.meta : null));
		if (prev && prev.base === base && prev.via === via && prev.fingerprint === source.fingerprint
			&& JSON.stringify(isObject(prev.meta) ? prev.meta : null) === JSON.stringify(nextMeta)) return;
		const entry = { base, fingerprint: source.fingerprint, via, source, at: now() };
		if (isObject(nextMeta)) entry.meta = nextMeta;
		store.works.set(work.id, entry);
	}

	function install(work, base, index, source, via, { stale = false, checkedAt = now(), meta } = {}) {
		const entry = { handle: makeHandle(work.id, base, index, source, via), checkedAt, stale, revalidating: false };
		handles.set(work.id, entry);
		memo.delete(work.id);
		probes.delete(work.id);
		setPointer(work, base, source, via, meta);
		return entry;
	}

	// --- resolving a source ---

	function calibreFailure(err) {
		const code = err && err.code;
		if (code === 'auth') return { code: 'calibre-auth', reason: err.reason, unreachable: true };
		if (code === 'bad-url') return { code: 'bad-url', reason: err.reason, unreachable: true };
		if (code === 'too-large') return { code: 'too-large' };
		if (code === 'no-epub' || code === 'not-found') return { code: 'no-ebook', missing: true };
		if (code === 'io') return { code: 'crash' };
		return { code: 'calibre-unreachable', unreachable: true };
	}

	async function calibreSource(client, id, book, via) {
		if (!book || !hasEpub(book)) return { code: 'no-ebook', missing: true };
		const lib = await client.libraryId();
		const fm = isObject(book.format_metadata) && isObject(book.format_metadata.epub) ? book.format_metadata.epub : null;
		if (fm && Number(fm.size) > MAX_EPUB_BYTES) return { code: 'too-large' };
		// The EPUB's own size and mtime, not last_modified: that moves on every tag, rating or
		// cover edit, which would re-download and re-parse an unchanged book.
		const own = fm && fm.size !== undefined && fm.size !== null && fm.mtime;
		const fingerprint = own
			? `calibre:${lib}:${id}:${fm.size}:${fm.mtime}`
			: `calibre:${lib}:${id}:lm:${book.last_modified || ''}`;
		return {
			source: {
				type: 'calibre', libraryId: lib, id: Number(id),
				// Not part of the fingerprint: only lets the Calibre index tell a reused id apart.
				uuid: typeof book.uuid === 'string' && book.uuid ? book.uuid : null,
				epubSize: own ? fm.size : null, epubMtime: own ? fm.mtime : null, fingerprint
			},
			via,
			title: typeof book.title === 'string' ? book.title : null,
			meta: calibreMetaFrom(book)
		};
	}

	async function fromCalibre(id, via) {
		const client = calibre();
		if (!client) return { code: 'calibre-off', unreachable: true };
		try {
			return await calibreSource(client, id, await client.book(id), via);
		} catch (err) {
			return calibreFailure(err);
		}
	}

	async function fromFile(file, via) {
		let st;
		try {
			st = await fsp.stat(file);
		} catch (_) {
			return { code: 'no-ebook', missing: true };
		}
		if (!st.isFile()) return { code: 'no-ebook', missing: true };
		if (st.size > MAX_EPUB_BYTES) return { code: 'too-large' };
		return {
			source: { type: 'file', path: file, size: st.size, mtimeMs: st.mtimeMs, fingerprint: `file:${file}:${st.size}:${st.mtimeMs}` },
			via
		};
	}

	async function calibreCandidates(client, work) {
		const surname = surnameOf(work.author);
		const title = String(work.title || '').replace(/["\\]/g, '');
		const ids = await client.search(surname ? `authors:"${surname}"` : `title:"${title}"`, { num: 50 });
		const found = await client.books(ids);
		const out = [];
		for (const [id, book] of found) {
			if (book) out.push({ id, book, epub: hasEpub(book), ...calibreScore(book, work) });
		}
		return out;
	}

	async function matchCalibre(client, work) {
		let list;
		try {
			list = await calibreCandidates(client, work);
		} catch (err) {
			return { error: calibreFailure(err) };
		}
		const ok = list.filter((c) => c.epub && c.accepted).sort((a, b) => b.rank - a.rank);
		if (!ok.length) return {};
		if (ok.length > 1 && ok[0].rank === ok[1].rank) return { ambiguous: true };
		return { id: ok[0].id, book: ok[0].book };
	}

	async function sidecarFiles(work) {
		const dirs = Array.isArray(work.dirs) ? work.dirs.filter((d) => typeof d === 'string' && d) : [];
		const seen = new Set();
		const out = [];
		for (const dir of dirs) {
			let names;
			try {
				names = await fsp.readdir(dir);
			} catch (_) {
				continue;
			}
			for (const name of names.filter((n) => /\.epub$/i.test(n)).sort()) {
				const full = path.join(dir, name);
				let st;
				try {
					st = await fsp.stat(full);
				} catch (_) {
					continue;
				}
				if (!st.isFile()) continue;
				// The same EPUB is often copied into every part folder of a book.
				const key = `${name.toLowerCase()}|${st.size}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ path: full, name, size: st.size, score: sidecarScore(name, work) });
			}
		}
		return out;
	}

	async function sidecarMatch(work) {
		const files = (await sidecarFiles(work)).filter((f) => f.score >= SIDECAR_MATCH).sort((a, b) => b.score - a.score);
		if (!files.length) return {};
		if (files.length > 1 && files[0].score === files[1].score) return { ambiguous: true };
		return { file: files[0] };
	}

	function pickFromIndex(work) {
		try {
			return indexPick(work) || null;
		} catch (_) {
			return null;
		}
	}

	async function search(work, { noPointer = false } = {}) {
		let calibreError = null;
		let ambiguous = false;
		const client = calibre();
		// Only for a work with no pointer: taking the index's match could switch the EPUB of an
		// existing pointer, and sync marks belong to the text they were made against.
		const pick = client && noPointer ? pickFromIndex(work) : null;
		if (pick) {
			const r = await fromCalibre(pick.id, 'auto');
			if (r.source) return r;
			if (r.unreachable) calibreError = r;
		}
		if (client && !calibreError) {
			const m = await matchCalibre(client, work);
			if (m.id) {
				let r;
				try {
					r = await calibreSource(client, m.id, m.book, 'auto');
				} catch (err) {
					r = calibreFailure(err);
				}
				if (r.source) return r;
				if (r.unreachable) calibreError = r;
			} else if (m.ambiguous) {
				ambiguous = true;
			} else if (m.error) {
				calibreError = m.error;
			}
		}
		if (cfg.audiobookTextSidecars !== false) {
			const s = await sidecarMatch(work);
			if (s.file) {
				const r = await fromFile(s.file.path, 'sidecar');
				if (r.source) return r;
			} else if (s.ambiguous) {
				ambiguous = true;
			}
		}
		// With Calibre closed the bot cannot know there is no ebook, so it never says so.
		if (calibreError) return calibreError;
		return { code: ambiguous ? 'ambiguous' : 'no-ebook' };
	}

	async function resolve(work) {
		const link = store.links.get(work);
		if (link && link.type === 'off') return { code: 'off' };
		if (link && link.type === 'calibre') return fromCalibre(link.id, 'link');
		if (link && link.type === 'file') return fromFile(link.path, 'link');
		const ptr = store.works.get(work);
		const usable = !!ptr && pointerUsable(ptr, link);
		if (usable) {
			const r = ptr.source.type === 'calibre'
				? await fromCalibre(ptr.source.id, ptr.via)
				: await fromFile(ptr.source.path, ptr.via);
			if (r.source || r.unreachable) return r;
		}
		return search(work, { noPointer: !usable });
	}

	// --- parsing ---

	const flightKey = (base) => `${cacheDir}\0${base}`;

	function materialize(base, source) {
		const key = flightKey(base);
		if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);
		const job = (async () => {
			await fsp.mkdir(cacheDir, { recursive: true });
			let input = source.path;
			let download = null;
			if (source.type === 'calibre') {
				const client = calibre();
				if (!client) return { code: 'calibre-off', unreachable: true };
				download = fileOf(base, 'download.tmp');
				try {
					await client.downloadEpub(source.id, download);
				} catch (err) {
					await fsp.rm(download, { force: true }).catch(() => {});
					return calibreFailure(err);
				}
				input = download;
			}
			try {
				const res = await parse.parseEpub({ input: { path: input }, outDir: cacheDir, base, source });
				if (!res || !res.ok) {
					const code = parseFailCode(res && res.code);
					logger.warn(`Read-along: could not read the ebook for cache ${base}: ${code}${res && res.code && res.code !== code ? ` (${res.code})` : ''}.`);
					return { code };
				}
				const s = res.summary || {};
				logger.info(`Read-along: read the ebook for cache ${base}: ${s.sections ?? '?'} sections, ${s.totalWords ?? '?'} words in ${s.ms ?? '?'} ms.`);
				const cached = await readCache(base, source.fingerprint);
				if (cached.index) return { index: cached.index };
				return { code: cached.fail || 'parse-error' };
			} finally {
				if (download) await fsp.rm(download, { force: true }).catch(() => {});
			}
		})().finally(() => IN_FLIGHT.delete(key));
		IN_FLIGHT.set(key, job);
		return job;
	}

	async function fallback(work, r) {
		if (VERDICTS.has(r.code)) return null;
		const link = store.links.get(work);
		const ptr = store.works.peek(work);
		if (!ptr || !pointerUsable(ptr, link)) return null;
		const cached = await readCache(ptr.base, ptr.fingerprint);
		return cached.index ? { ptr, index: cached.index } : null;
	}

	async function finish(work, r, gen, { retryFailed = false } = {}) {
		const id = work.id;
		let outcome = r;
		if (r.source) {
			const base = cacheBase(r.source.fingerprint, VERSION);
			if (retryFailed) await removeFailRecord(base);
			let cached = await readCache(base, r.source.fingerprint);
			if (!cached.index && !cached.fail) {
				const made = await materialize(base, r.source);
				cached = made.index ? made : {};
				if (!made.index) outcome = made;
			}
			if (cached.index) {
				if (generation(id) !== gen || closed) return { ok: true, handle: makeHandle(id, base, cached.index, r.source, r.via), stale: false };
				const entry = install(work, base, cached.index, r.source, r.via, { meta: r.meta });
				return { ok: true, handle: entry.handle, stale: false };
			}
			if (cached.fail) outcome = { code: cached.fail };
		}
		const old = await fallback(work, outcome);
		if (old) {
			const entry = install(work, old.ptr.base, old.index, old.ptr.source, old.ptr.via, { stale: true });
			return { ok: true, handle: entry.handle, stale: true };
		}
		if (generation(id) === gen) remember(id, outcome.code, outcome);
		return fail(outcome.code, outcome);
	}

	function maybeRevalidate(work, entry) {
		if (closed || entry.revalidating || now() - entry.checkedAt < REVALIDATE_MS) return;
		entry.revalidating = true;
		const gen = generation(work.id);
		revalidate(work, entry, gen)
			.catch((err) => logger.warn(`Read-along: re-checking ${work.id} failed:`, err && err.code ? err.code : (err && err.name) || 'error'))
			.finally(() => { entry.revalidating = false; });
	}

	async function revalidate(work, entry, gen) {
		const current = () => !closed && handles.get(work.id) === entry && generation(work.id) === gen;
		const r = await resolve(work);
		if (!current()) return;
		entry.checkedAt = now();
		if (!r.source) {
			if (r.unreachable || TRANSIENT.has(r.code)) entry.stale = true;
			return;
		}
		entry.stale = false;
		if (r.source.fingerprint === entry.handle.fingerprint) {
			// A title or series edited in Calibre leaves the EPUB alone, so only the pointer's copy
			// of the metadata changes; nothing is downloaded or parsed.
			if (r.meta !== undefined && r.via === entry.handle.via) setPointer(work, entry.handle.base, r.source, r.via, r.meta);
			return;
		}
		const base = cacheBase(r.source.fingerprint, VERSION);
		let cached = await readCache(base, r.source.fingerprint);
		if (!cached.index && !cached.fail) cached = await materialize(base, r.source);
		if (!current() || !cached.index) return;
		install(work, base, cached.index, r.source, r.via, { meta: r.meta });
		emit(work.id);
	}

	function sweepOnce() {
		if (!sweeping) sweeping = sweep().catch((err) => logger.warn('Read-along: cache sweep failed:', err && err.code ? err.code : 'error'));
		return sweeping;
	}

	// Runs before this source queues any parse, and never again in this source, so a handle it
	// opened never loses its file. !restart starts a new source whose sweep can run while the old
	// one's download or parse is still going, so a base with a job in flight is left alone.
	async function sweep() {
		if (!cacheDir) return;
		let names;
		try {
			names = await fsp.readdir(cacheDir);
		} catch (_) {
			return;
		}
		const keep = new Set(Object.values(store.works.all()).map((p) => (isObject(p) ? p.base : null)).filter(Boolean));
		let removed = 0;
		for (const name of names) {
			const m = /^([0-9a-f]{16})\.(.+)$/.exec(name);
			if (!m) continue;
			const [, base, ext] = m;
			if (IN_FLIGHT.has(flightKey(base))) continue;
			const full = path.join(cacheDir, name);
			if (ext === 'fail.json') {
				const st = await fsp.stat(full).catch(() => null);
				if (st && now() - st.mtimeMs > FAIL_RECORD_MAX_AGE_MS) {
					await fsp.rm(full, { force: true }).catch(() => {});
					removed++;
				}
				continue;
			}
			if (keep.has(base)) continue;
			if (ext === 'txt' || ext === 'json' || ext.endsWith('.tmp')) {
				await fsp.rm(full, { force: true }).catch(() => {});
				removed++;
			}
		}
		if (removed) logger.info(`Read-along: removed ${removed} unused cache file(s).`);
	}

	function flight(key, force, run) {
		const existing = flights.get(key);
		if (existing && !force) return existing;
		const job = (existing ? existing.catch(() => {}) : Promise.resolve()).then(run);
		const tracked = job.finally(() => {
			if (flights.get(key) === tracked) flights.delete(key);
		});
		flights.set(key, tracked);
		return tracked;
	}

	// --- public ---

	async function open(workIn, { force = false, explicit = false, retryFailed = false } = {}) {
		const work = fresh(workIn);
		const blocked = gate(work);
		if (blocked) return fail(blocked);
		const before = status(work);
		const result = await flight(`open:${work.id}`, force, () => doOpen(work, { force, explicit, retryFailed }));
		changed(work, before);
		return result;
	}

	async function doOpen(work, { force, explicit, retryFailed }) {
		await sweepOnce();
		const id = work.id;
		const gen = generation(id);
		const link = store.links.get(work);
		if (link && link.type === 'off') return fail('off');
		if (!force) {
			const entry = handles.get(id);
			if (entry) {
				// A person retrying after opening Calibre should not wait out the 10 minutes.
				if (explicit && entry.stale && now() - entry.checkedAt >= TRANSIENT_TTL_MS) entry.checkedAt = -Infinity;
				maybeRevalidate(work, entry);
				return { ok: true, handle: entry.handle, stale: entry.stale };
			}
			if (!explicit) {
				const m = recalled(id);
				if (m) return { ok: false, code: m.code, text: m.text };
			}
			// A text read in an earlier run is served at once and re-checked in the background, so
			// a first page never waits on Calibre, and works with Calibre closed.
			const ptr = store.works.get(work);
			if (ptr && pointerUsable(ptr, link)) {
				const cached = await readCache(ptr.base, ptr.fingerprint);
				if (cached.index && generation(id) === gen) {
					const served = install(work, ptr.base, cached.index, ptr.source, ptr.via, { checkedAt: -Infinity });
					maybeRevalidate(work, served);
					return { ok: true, handle: served.handle, stale: false };
				}
			}
		}
		return finish(work, await resolve(work), gen, { retryFailed });
	}

	async function probe(workIn) {
		const work = fresh(workIn);
		if (!work || typeof work.id !== 'string') return 'unknown';
		if (!enabled()) return 'off';
		if (work.kind === 'podcast') return 'none';
		const before = status(work);
		const result = await flight(`probe:${work.id}`, false, () => doProbe(work));
		changed(work, before);
		return result;
	}

	async function doProbe(work) {
		await sweepOnce();
		const id = work.id;
		const link = store.links.get(work);
		if (link && link.type === 'off') return 'off';
		if (handles.has(id)) return 'ready';
		const m = recalled(id);
		if (m) return statusOfMemo(m);
		const known = recalledProbe(id);
		if (known) return known.status;
		const r = await resolve(work);
		let result;
		if (r.source) {
			const cached = await readCache(cacheBase(r.source.fingerprint, VERSION), r.source.fingerprint);
			if (cached.fail) {
				remember(id, cached.fail);
				return 'none';
			}
			result = cached.index ? 'ready' : 'available';
		} else if (await fallback(work, r)) {
			result = 'ready';
		} else {
			remember(id, r.code, r);
			return STABLE.has(r.code) ? (r.code === 'off' ? 'off' : 'none') : 'unknown';
		}
		probes.set(id, { status: result, stable: true, stamp: stamp() });
		return result;
	}

	function forget(id) {
		memo.delete(id);
		probes.delete(id);
		handles.delete(id);
		generations.set(id, generation(id) + 1);
	}

	async function link(workIn, target, { by = null } = {}) {
		const work = fresh(workIn);
		const blocked = gate(work);
		if (blocked) return fail(blocked);
		await sweepOnce();
		const before = status(work);
		const result = await doLink(work, isObject(target) ? target : {}, by);
		changed(work, before);
		return result;
	}

	function linkRefusal(code, text) {
		return { ok: false, code, text };
	}

	function calibreLinkRefusal(err) {
		const r = calibreFailure(err);
		if (r.code === 'calibre-unreachable') {
			return linkRefusal(r.code, 'Calibre isn\'t answering; open the Calibre app (its content server only runs while the app is open) and try again.');
		}
		return linkRefusal(r.code, textFor(r.code, r));
	}

	async function linkCalibre(work, id, by, isbn) {
		const client = calibre();
		if (!client) return linkRefusal('calibre-off', textFor('calibre-off'));
		let book;
		try {
			book = await client.book(id);
		} catch (err) {
			return calibreLinkRefusal(err);
		}
		if (!book) return linkRefusal('not-found', `Calibre has no book #${id}.`);
		const title = typeof book.title === 'string' && book.title ? book.title : `#${id}`;
		if (!hasEpub(book)) return linkRefusal('no-epub', `Calibre #${id} “${title}” has no EPUB.`);
		const entry = { type: 'calibre', id, by, at: now() };
		if (isbn) entry.isbn = isbn;
		store.links.set(work.id, entry);
		forget(work.id);
		const opened = await open(work, { force: true, explicit: true, retryFailed: true });
		const echo = `Linked ${work.title || work.id} to Calibre #${id} “${title}” (EPUB).`;
		return { ok: true, code: 'linked', text: opened.ok ? echo : `${echo} ${opened.text}`, open: { ok: opened.ok, code: opened.ok ? null : opened.code } };
	}

	async function doLink(work, target, by) {
		const title = work.title || work.id;
		if (target.type === 'calibre') {
			const id = Number(target.id);
			if (!Number.isInteger(id) || id <= 0) return linkRefusal('bad-target', 'A Calibre id is a whole number, like 299.');
			return linkCalibre(work, id, by, null);
		}
		if (target.type === 'isbn') {
			const forms = isbnForms(target.isbn);
			if (!forms.length) return linkRefusal('bad-target', 'That doesn\'t look like an ISBN-10 or ISBN-13.');
			const client = calibre();
			if (!client) return linkRefusal('calibre-off', textFor('calibre-off'));
			let ids;
			try {
				ids = await client.search(forms.map((f) => `identifiers:isbn:${f}`).join(' or '), { num: 10 });
			} catch (err) {
				return calibreLinkRefusal(err);
			}
			if (!ids.length) return linkRefusal('not-found', `No Calibre book has ISBN ${forms[0]}.`);
			if (ids.length > 1) return linkRefusal('ambiguous', `${ids.length} Calibre books have ISBN ${forms[0]}: ${ids.map((i) => `#${i}`).join(', ')}. Link one by its id.`);
			return linkCalibre(work, ids[0], by, forms[0]);
		}
		if (target.type === 'file') {
			const problem = localPathProblem(target.path);
			if (problem === 'unc') return linkRefusal('bad-path', 'Only a file on this PC\'s own drives can be linked.');
			if (problem) return linkRefusal('bad-path', 'Give the full path of the .epub file, starting with its drive letter.');
			const file = path.normalize(String(target.path).trim());
			if (!/\.epub$/i.test(file)) return linkRefusal('bad-path', 'That isn\'t an .epub file.');
			let st;
			try {
				st = await fsp.stat(file);
			} catch (_) {
				return linkRefusal('not-found', `There is no file ${basename(file)} at that path.`);
			}
			if (!st.isFile()) return linkRefusal('bad-path', 'That isn\'t an .epub file.');
			if (st.size > MAX_EPUB_BYTES) return linkRefusal('too-large', textFor('too-large'));
			store.links.set(work.id, { type: 'file', path: file, by, at: now() });
			forget(work.id);
			const opened = await open(work, { force: true, explicit: true, retryFailed: true });
			const echo = `Linked ${title} to the EPUB ${basename(file)}.`;
			return { ok: true, code: 'linked', text: opened.ok ? echo : `${echo} ${opened.text}`, open: { ok: opened.ok, code: opened.ok ? null : opened.code } };
		}
		if (target.type === 'off') {
			store.links.set(work.id, { type: 'off', by, at: now() });
			forget(work.id);
			return { ok: true, code: 'off', text: `Read-along is now off for ${title}.` };
		}
		if (target.type === 'auto') {
			store.links.clear(work);
			forget(work.id);
			const opened = await open(work, { force: true, explicit: true, retryFailed: true });
			const text = opened.ok
				? `Cleared the ebook link for ${title}; it now uses ${opened.handle.label}.`
				: `Cleared the ebook link for ${title}. ${opened.text}`;
			return { ok: true, code: 'auto', text, open: { ok: opened.ok, code: opened.ok ? null : opened.code } };
		}
		return linkRefusal('bad-target', 'Give a Calibre id, an ISBN, an EPUB path, off or auto.');
	}

	async function describe(workIn, { paths = false } = {}) {
		const work = fresh(workIn);
		const show = (p) => (paths ? p : basename(p));
		const summarize = (src) => (src && src.type === 'file'
			? { type: 'file', path: show(src.path), size: src.size ?? null }
			: src ? { type: 'calibre', id: src.id, libraryId: src.libraryId ?? null } : null);
		const out = { workId: work && work.id, title: work && work.title, status: status(work), link: null, cache: null, candidates: { calibre: [], sidecars: [], calibreError: null }, lastError: null };
		if (!work || typeof work.id !== 'string') return out;
		const rec = safe(() => store.links.get(work));
		if (rec) out.link = rec.type === 'file' ? { ...rec, path: show(rec.path) } : { ...rec };
		const ptr = safe(() => store.works.peek(work));
		if (ptr && isObject(ptr.source)) {
			const cached = cacheDir ? await readCache(ptr.base, ptr.fingerprint) : {};
			out.cache = {
				via: ptr.via,
				label: labelOf(ptr.source, ptr.via),
				source: summarize(ptr.source),
				valid: !!cached.index,
				failed: cached.fail || null,
				totalWords: cached.index ? cached.index.totalWords ?? null : null,
				sections: cached.index ? cached.index.sections.length : null,
				builtAt: cached.index ? cached.index.builtAt ?? null : null,
				at: ptr.at ?? null
			};
		}
		const client = calibre();
		if (client) {
			try {
				out.candidates.calibre = (await calibreCandidates(client, work))
					.sort((a, b) => b.rank - a.rank || b.titleScore - a.titleScore)
					.map((c) => ({
						id: c.id, title: c.book.title || null, authors: Array.isArray(c.book.authors) ? c.book.authors : [],
						series: c.book.series || null, seriesIndex: c.book.series_index ?? null,
						epub: c.epub, accepted: c.accepted, titleScore: +c.titleScore.toFixed(2)
					}));
			} catch (err) {
				out.candidates.calibreError = calibreFailure(err).code;
			}
		}
		if (cfg.audiobookTextSidecars !== false) {
			out.candidates.sidecars = (await sidecarFiles(work))
				.sort((a, b) => b.score - a.score)
				.map((f) => ({ file: show(f.path), size: f.size, score: +f.score.toFixed(2), accepted: f.score >= SIDECAR_MATCH }));
		}
		const m = recalled(work.id);
		if (m) out.lastError = { code: m.code, text: m.text };
		return out;
	}

	function onChange(fn) {
		if (typeof fn !== 'function') return () => {};
		listeners.add(fn);
		return () => listeners.delete(fn);
	}

	function shutdown() {
		closed = true;
		listeners.clear();
		memo.clear();
		probes.clear();
		try {
			if (parse && typeof parse.shutdown === 'function') parse.shutdown();
		} catch (_) { /* nothing left to stop */ }
	}

	return { status, probe, open, link, describe, onChange, shutdown };
}

module.exports = {
	createBookTextSource,
	cacheBase,
	defaults,
	isbnForms,
	localPathProblem,
	calibreScore,
	calibreFromConfig,
	sidecarScore,
	pointerUsable,
	calibreMetaFrom,
	calibreMetaOf,
	MAX_EPUB_BYTES,
	TRANSIENT_TTL_MS,
	REVALIDATE_MS
};
