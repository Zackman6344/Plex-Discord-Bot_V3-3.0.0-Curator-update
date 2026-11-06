// helpers/bookPictures.js
//
// Pictures for the read-along from a scanned PDF. When the Calibre record a book's text comes from
// also holds a PDF of the printed edition, the PDF's illustrations show on the listener's DM page
// and the 📖 page as the narration reaches the start of the printed page they are on. This is the
// bot's side of it: it checks the record, hands the analysis to helpers/bookPicturesWorker.js (a
// Below Normal child running Calibre's poppler tools and ffmpeg), installs what the child wrote and
// serves the picture list. It never parses a PDF or renders a page itself: reading one book's word
// boxes takes a second and lining them up with the text a few hundred ms, against the voice's 20 ms
// timer.
//
// On disk, under data/book_text/pictures/:
//   <key>/            one analysis of one PDF: index.json (the picture list, written last, so it
//                     marks a complete folder), pages.json (each printed page's word keys, read only
//                     by the child when it lines the pictures up with another text), the JPGs, and
//                     per text an align-<base>.json (each picture's word) or align-<base>.fail.json
//   <key>.fail.json   the PDF gives no pictures (encrypted, damaged, ...), or the strikes of an
//                     analysis that hung or crashed: on disk, so a PDF that hangs the tools is not
//                     read three times after every restart
//   <key>.work/       an analysis in flight: the downloaded book.pdf and the child's out/. Deleted
//                     when the job ends, whatever the result, and by the start-up sweep after a kill.
//                     The PDF is never kept: the pictures and pages.json are all a later text needs.
//   <key>.old/        the folder a new analysis of the same PDF replaces (pictures:redo while another
//                     work shows it), for the moment between two renames; after a crash in that
//                     moment the sweep puts it back, or removes it once <key>/ is there
// `key` hashes PICTURES_VERSION with the PDF's own size and mtime from Calibre's format_metadata.
// Never last_modified, which moves on every tag, rating or cover edit, and never the PDF's path: the
// record carries the library's local path, and nothing here copies it into a pointer, a log line or
// a reply. The text's `base` names only the align file, so a re-parsed or replaced EPUB is lined up
// again in seconds, with no download and no rendering. Which key and base a work uses, and the
// owner's per-book switch, are a pointer in pictures.json (helpers/bookTextStore.js).
//
// forText() runs on every page render, so it is a Map lookup and nothing more: no disk, no Calibre,
// no work started. ensure(), which the read-along calls each time it opens a text, does the rest in
// the background and emits onChange(workId) when the set a work serves changes. Full analyses run
// one at a time for the whole process and download their PDF only when their turn comes, so a
// queued book holds no PDF on disk; lining a kept analysis up with a new text skips that line, and
// the worker runs it ahead of any full analysis waiting there.
//
// Log lines carry codes, counts, 16-hex keys and bases, and ms: never a title, a path or page text.

const crypto = require('crypto');
const path = require('path');

const PICTURES_VERSION = 1;
const ALIGN_VERSION = 1;
const MAX_PAGE_PICTURES = 10;
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIR_BYTES = 1024 * 1024 * 1024;

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'book_text');
const SETTING = 'audiobookTextPictures';
// The text source's own re-check interval (helpers/bookTextSource.js REVALIDATE_MS).
const REVALIDATE_MS = 10 * 60 * 1000;
const CALIBRE_RETRY_MS = 2 * 60 * 1000;
// As long as pdfTools.instance() remembers where the tools are.
const TOOLS_RETRY_MS = 60 * 1000;
const STRIKE_RETRY_MS = 30 * 60 * 1000;
const MAX_STRIKES = 3;
const FAIL_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// The size cap never takes an analysis a page served this recently.
const RECENT_USE_MS = 60 * 60 * 1000;
// How often a served set refreshes its pointer's usedAt, so a book read for hours stays recent.
const TOUCH_MS = 30 * 60 * 1000;
// pictures:redo waits this long for a cancelled job to let go of its folder.
const CANCEL_WAIT_MS = 20 * 1000;
// Rendering measured 0.84 s a page on an idle PC and 1.38 s on a busy one: 1000 pages take about 14
// to 23 minutes. The worker's total cap stretches with the page count (5 minutes and 3 s a page, 55
// minutes for 1000), so a busy PC does not push a big book into timeout strikes.
const LIMITS = Object.freeze({ maxPages: 1000, maxPictures: 200, maxPictureBytes: MAX_PICTURE_BYTES, renderHeight: 1200 });
// The child stamps its files with these, so the files it writes are the ones this module loads.
const VERSIONS = Object.freeze({ pictures: PICTURES_VERSION, align: ALIGN_VERSION });

const HEX16 = /^[0-9a-f]{16}$/;
const PICTURE_FILE = /^p\d{3,4}(-\d{3,4})?\.jpg$/;
const PICTURE_ID = /^p\d{3,4}(-\d{3,4})?$/;
const ALIGN_FILE = /^align-([0-9a-f]{16})(?:\.fail)?\.json$/;
const KINDS = new Set(['full', 'part', 'spread']);
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Failures that say something about the PDF itself: kept on disk until the PDF changes (a new
// key), the owner runs pictures:redo, or after 30 days, when the sweep removes the record.
const STABLE = new Set(['pdf-encrypted', 'pdf-damaged', 'no-text-layer', 'too-large', 'gave-up']);
// Failures that pass on their own, kept in memory only and retried after these waits. 'io-error'
// comes before any PDF was read (saving the download, or a text an align job could not read), so a
// retry is cheap. 'pdf-missing' is a record that lists a PDF whose file is gone from the library:
// it stays gone until someone puts it back, so it is looked at again only as often as the record is.
const MEMORY_WAIT_MS = {
	'calibre-unreachable': CALIBRE_RETRY_MS,
	'calibre-auth': CALIBRE_RETRY_MS,
	'calibre-off': CALIBRE_RETRY_MS,
	'io-error': CALIBRE_RETRY_MS,
	'pdf-missing': REVALIDATE_MS,
	'tools-missing': TOOLS_RETRY_MS
};
// Failures that come after the PDF was downloaded and read, so a retry costs minutes of CPU: struck
// on disk, retried after 30 minutes, given up after the third. 'disk-error' is the child's io-error
// (it downloads nothing) or the parent failing to put a finished analysis in place.
const STRIKES = new Set(['timeout', 'crash', 'disk-error']);
const NO_RESULT = new Set(['cancelled', 'shutdown']);

// Jobs in flight for the whole process, by pictures folder and key (a full analysis) or key and
// text base (an alignment): !restart builds a new instance while the old one's download or child
// may still be running, and the new one must neither start a second job for that key nor sweep its
// folders.
const IN_FLIGHT = new Map();
// Full analyses waiting for their turn, one at a time for the whole process.
const FULL_QUEUE = [];
let fullRunning = null;

function pumpFull() {
	if (fullRunning || !FULL_QUEUE.length) return;
	const job = FULL_QUEUE.shift();
	fullRunning = job;
	Promise.resolve().then(() => job.begin()).finally(() => {
		if (fullRunning === job) fullRunning = null;
		pumpFull();
	});
}

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function codeOf(err) {
	return (err && (err.code || err.name)) || 'error';
}

function sha1(text) {
	return crypto.createHash('sha1').update(text).digest('hex');
}

/** The pictures folder name: 16 hex characters, the recipe of the text cache's `base`. */
function picturesKey(fingerprint, version = PICTURES_VERSION) {
	return sha1(`${version}|${fingerprint}`).slice(0, 16);
}

/**
 * The PDF of a Calibre /ajax/book record, or null when it has none. Copies the PDF's own size and
 * mtime, never its `path` (the library's local path); falls back to last_modified only when the
 * record carries no size and mtime for it, as the text's fingerprint does.
 * @param {object} book the record as calibreClient.book returns it
 * @param {string} libraryId the library the record was read from
 * @param {number} [id] the record id; the record's own application_id otherwise
 * @returns {{ libraryId: string, id: number, uuid: string|null, size: number|null, mtime: string|null, fingerprint: string } | null}
 */
function pdfOf(book, libraryId, id = isObject(book) ? (book.application_id ?? book.id) : null) {
	if (!isObject(book) || typeof libraryId !== 'string' || !libraryId) return null;
	const n = Number(id);
	if (!Number.isInteger(n) || n <= 0) return null;
	const formats = (Array.isArray(book.formats) ? book.formats : []).map((f) => String(f).toLowerCase());
	if (!formats.includes('pdf')) return null;
	const all = isObject(book.format_metadata) ? book.format_metadata : null;
	const fm = all && isObject(all.pdf) ? all.pdf : null;
	const own = !!fm && fm.size !== undefined && fm.size !== null && Number.isFinite(Number(fm.size)) && typeof fm.mtime === 'string' && !!fm.mtime;
	const size = own ? Number(fm.size) : null;
	const mtime = own ? fm.mtime : null;
	return {
		libraryId,
		id: n,
		uuid: typeof book.uuid === 'string' && book.uuid ? book.uuid : null,
		size,
		mtime,
		fingerprint: own ? `calibre:${libraryId}:${n}:pdf:${size}:${mtime}` : `calibre:${libraryId}:${n}:pdf:lm:${book.last_modified || ''}`
	};
}

/**
 * The pictures whose word lies in [fromWord, toWord), in reading order: at most `max`, and no more
 * than `maxBytes` together, so a page of big scans stays under Discord's upload limit. `count` is
 * every picture in the range, for the page's "10 of 12 pictures".
 * @param {object[]} pictures a PictureSet's pictures, sorted by word
 */
function between(pictures, fromWord, toWord, max = MAX_PAGE_PICTURES, maxBytes = MAX_MESSAGE_BYTES) {
	const list = Array.isArray(pictures) ? pictures : [];
	const from = Number(fromWord);
	const to = Number(toWord);
	if (!list.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { shown: [], count: 0 };
	const lower = (w) => {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (list[mid].word < w) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	const start = lower(from);
	const end = lower(to);
	const cap = Number.isInteger(max) && max >= 0 ? max : MAX_PAGE_PICTURES;
	const shown = [];
	let bytes = 0;
	for (let i = start; i < end && shown.length < cap; i++) {
		const size = Number(list[i].bytes) || 0;
		if (bytes + size > maxBytes) break;
		bytes += size;
		shown.push(list[i]);
	}
	return { shown, count: end - start };
}

function titleArg(title) {
	const t = String(title || '').replace(/["`\\]/g, '').trim();
	return t ? `"${t}"` : '<book>';
}

const FAIL_REASON = {
	'pdf-encrypted': 'it is encrypted',
	'pdf-damaged': 'it is damaged',
	'no-text-layer': 'it has no text layer to place them by',
	'align-failed': 'its pages don\'t match this ebook',
	'too-large': 'it is too large',
	'gave-up': 'reading it failed 3 times',
	'disk-error': 'the bot couldn\'t read or write its picture files'
};

const WAIT_REASON = {
	'calibre-unreachable': 'Calibre isn\'t answering',
	'calibre-auth': 'Calibre asked for a login',
	'calibre-off': 'Calibre is turned off',
	'io-error': 'a file could not be written',
	'pdf-missing': 'Calibre lists a PDF but has no file for it',
	'tools-missing': 'Calibre\'s PDF tools weren\'t found on this PC',
	'disk-error': 'the bot couldn\'t read or write its picture files',
	timeout: 'it took too long',
	crash: 'it stopped unexpectedly'
};

function inMinutes(st) {
	const ms = Number.isFinite(st.retryIn) ? st.retryIn : (Number.isFinite(st.retryAt) ? st.retryAt - Date.now() : NaN);
	if (!Number.isFinite(ms) || ms <= 0) return 'shortly';
	const m = Math.ceil(ms / 60000);
	return `in ${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * The 🖼 line of `!book text` for a status() report, or null when there is nothing to say: a file
 * source, no PDF, a podcast, the first check still running or Calibre not answering it ('unknown':
 * most records have no PDF, so nothing a listener misses has failed), or the setting off for a book
 * that has no pictures.
 */
function statusLine(st, { prefix = '!' } = {}) {
	if (!isObject(st) || typeof st.state !== 'string') return null;
	const record = Number.isInteger(st.pdfId) ? `Calibre #${st.pdfId}` : 'Calibre';
	const count = Number.isInteger(st.count) ? st.count : 0;
	switch (st.state) {
		case 'ready':
			if (count <= 0) return `🖼 ${record}'s PDF has no pictures the bot could find.`;
			return count === 1
				? `🖼 1 picture from ${record}'s PDF shows on your page as the narration reaches it.`
				: `🖼 ${count} pictures from ${record}'s PDF show on your page as the narration reaches them.`;
		case 'queued':
			return `🖼 ${record} has a PDF; it is read for pictures after the book being read now.`;
		case 'downloading':
		case 'running': {
			const p = isObject(st.progress) ? st.progress : null;
			const at = p && (p.stage === 'find' || p.stage === 'render') && Number.isInteger(p.total) && p.total > 0 && Number.isInteger(p.done)
				? `: page ${Math.max(0, Math.min(p.done, p.total))} of ${p.total}` : '';
			return `🖼 Reading ${record}'s PDF for pictures${at} (a few minutes, once).`;
		}
		case 'aligning':
			return `🖼 Lining ${record}'s pictures up with this text.`;
		case 'failed':
			return `🖼 ${record}'s PDF gives no pictures: ${FAIL_REASON[st.code] || 'it could not be read'}.`;
		case 'waiting':
			return `🖼 Reading the PDF for pictures failed (${WAIT_REASON[st.code] || 'an error'}); it tries again ${inMinutes(st)}.`;
		case 'tools-missing':
			return '🖼 Calibre\'s PDF tools weren\'t found on this PC, so no pictures. Install Calibre here.';
		case 'book-off':
			return `🖼 Pictures are off for this book (\`${prefix}book link ${titleArg(st.title)} pictures:on\`).`;
		case 'off':
			return count > 0 ? `🖼 This book has pictures from a PDF; the owner can show them with audiobookTextPictures (\`${prefix}config\` → Audiobooks).` : null;
		default:
			return null;
	}
}

function usableHandle(h) {
	return isObject(h) && typeof h.base === 'string' && HEX16.test(h.base)
		&& isObject(h.source) && h.source.type === 'calibre' && Number.isInteger(Number(h.source.id)) && Number(h.source.id) > 0
		&& typeof h.textPath === 'string' && !!h.textPath && typeof h.indexPath === 'string' && !!h.indexPath;
}

const recordOf = (h) => `${h.source.libraryId || ''}|${Number(h.source.id)}|${h.source.uuid || ''}`;
const signatureOf = (h) => `${recordOf(h)}|${h.base}`;
// The key a pointer says pictures:redo still has to read again (see redoPointer).
const redoOf = (ptr) => (isObject(ptr) && typeof ptr.redo === 'string' && HEX16.test(ptr.redo) ? ptr.redo : null);

function indexOk(index, fingerprint) {
	if (!isObject(index) || index.version !== PICTURES_VERSION || !Array.isArray(index.pictures)) return false;
	return !(fingerprint && isObject(index.pdf) && typeof index.pdf.fingerprint === 'string' && index.pdf.fingerprint !== fingerprint);
}

function alignOk(a, key, base) {
	return isObject(a) && a.version === ALIGN_VERSION && a.base === base && (a.key === undefined || a.key === key)
		&& Number.isInteger(a.textWords) && a.textWords > 0 && Array.isArray(a.pictures);
}

function pictureOk(p) {
	return isObject(p) && typeof p.id === 'string' && PICTURE_ID.test(p.id) && typeof p.file === 'string' && PICTURE_FILE.test(p.file)
		&& Array.isArray(p.pages) && p.pages.length > 0 && p.pages.every((n) => Number.isInteger(n) && n > 0);
}

// The number printed on the page, which is what someone holding the book reads: the PDF's 22nd page
// is page 10 of #384. Without a folio offset, or for a page before the numbering starts, the PDF's
// own number would mislead, so none is given.
function altOf(pages, folioOffset) {
	const plain = 'Picture from the printed book';
	if (!Number.isInteger(folioOffset)) return plain;
	const printed = pages.map((n) => n - folioOffset);
	if (!printed.every((n) => n >= 1)) return plain;
	if (printed.length === 1) return `${plain}, page ${printed[0]}`;
	if (printed.length === 2) return `${plain}, pages ${printed[0]} and ${printed[1]}`;
	return `${plain}, pages ${printed[0]} to ${printed[printed.length - 1]}`;
}

function calibreCode(err) {
	const code = err && err.code;
	if (code === 'auth') return 'calibre-auth';
	if (code === 'bad-url') return 'calibre-off';
	if (code === 'io') return 'io-error';
	return 'calibre-unreachable';
}

// Calibre answers 404 for a format its record lists when the file itself is gone from the library
// folder: the record check finds the PDF again, so 'no-pdf' here would loop on every page.
function downloadCode(err) {
	const code = err && err.code;
	if (code === 'no-format' || code === 'not-found') return 'pdf-missing';
	if (code === 'too-large') return 'too-large';
	return calibreCode(err);
}

function calibreText(code, p) {
	switch (code) {
		case 'calibre-auth': return `Calibre asked for a login; set calibreUsername and calibrePassword with \`${p}config\` → Integrations.`;
		case 'calibre-off': return `Calibre is turned off (calibreUrl is blank in \`${p}config\` → Integrations).`;
		case 'io-error': return 'A file could not be read; try again in a moment.';
		default: return 'Calibre isn\'t answering; open the Calibre app (its content server only runs while the app is open) and try again.';
	}
}

function idsOf(work) {
	if (!work || typeof work.id !== 'string') return [];
	const aliases = Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [];
	return [work.id, ...aliases];
}

function progressOf(job, p) {
	if (!isObject(p)) return;
	const stage = typeof p.stage === 'string' ? p.stage.slice(0, 16) : null;
	const done = Number(p.done);
	const total = Number(p.total);
	job.progress = { stage, done: Number.isFinite(done) ? done : null, total: Number.isFinite(total) ? total : null };
	job.phase = job.kind === 'align' || stage === 'align' ? 'aligning' : 'running';
}

// A whole analysis may still have lost a few pages or pictures (the scan fails the job only past a
// threshold): the install line says how many, so a partial read is visible.
function partOf(summary) {
	const count = (k) => (isObject(summary) && Number.isInteger(summary[k]) && summary[k] > 0 ? summary[k] : 0);
	const skipped = count('skipped');
	const encodeFailed = count('encodeFailed');
	return skipped || encodeFailed ? `; pages skipped: ${skipped}, pictures not encoded: ${encodeFailed}` : '';
}

/**
 * @param {object} [deps] every omitted one is the production wiring
 * @param {object|Function} [deps.cfg] the live config object or a getter, read at call time; when
 *   given, /config changes are not followed live (a test passes its own)
 * @param {string} [deps.dir] the book_text directory (pictures go in `<dir>/pictures`);
 *   PLEXBOT_BOOK_TEXT_DIR otherwise; under the test runner the module is inert without one
 * @param {() => object|null} [deps.calibre] the Calibre client, or null when calibreUrl is blank
 * @param {object} [deps.store] bookTextStore's shape: pictures.{get,peek,set,clear,all}, works.all
 * @param {object} [deps.worker] bookPicturesWorker's shape: run, cancel, shutdown, busy
 * @param {(cfg: object) => object|Promise<object>} [deps.locateTools] where the PDF tools are, as
 *   pdfTools.locate answers; pdfTools.instance().warm otherwise
 * @param {(work: object) => Promise<object>} [deps.openText] source.open(work, { explicit: true });
 *   without it pictures:redo starts the new analysis on the text's next open
 * @param {() => object} [deps.catalog] bookCatalogStore, for the current work and its aliases
 * @param {object|null} [deps.configStore] whose onChange to follow; configStore.js when deps.cfg is
 *   omitted, nothing when it is given
 * @param {number} [deps.maxDirBytes] the size cap, MAX_DIR_BYTES; a test seam
 * @param {object} [deps.fs] @param {() => number} [deps.now] @param {object} [deps.logger]
 */
function createBookPictures(deps = {}) {
	const cfgOf = () => {
		const c = typeof deps.cfg === 'function' ? deps.cfg() : deps.cfg;
		return c || require('../config/config.js');
	};
	const rootDir = deps.dir || process.env.PLEXBOT_BOOK_TEXT_DIR || (process.env.NODE_TEST_CONTEXT ? null : DEFAULT_DIR);
	// Absolute, so every served picture path is: the page card attaches only local absolute paths,
	// and the worker takes no other.
	const picsDir = rootDir ? path.join(path.resolve(rootDir), 'pictures') : null;
	const fs = deps.fs || require('fs');
	const fsp = fs.promises;
	const now = deps.now || Date.now;
	const logger = deps.logger || require('./logger.js');
	const store = deps.store || require('./bookTextStore.js');
	const calibre = deps.calibre || (() => require('./bookTextSource.js').calibreFromConfig(cfgOf()));
	const catalog = deps.catalog || (() => require('./bookCatalogStore.js'));
	// warm() asks the tools for their version off the bot's thread: locate's first answer in a
	// process spawns them synchronously (130-270 ms), and an analysis starts while a book plays.
	const locateTools = deps.locateTools || ((c) => require('./pdfTools.js').instance().warm(c));
	const openText = typeof deps.openText === 'function' ? deps.openText : null;
	const maxDirBytes = Number.isFinite(deps.maxDirBytes) && deps.maxDirBytes >= 0 ? deps.maxDirBytes : MAX_DIR_BYTES;
	const { pickFormat } = require('./ebookConvert.js');
	let workerRef = deps.worker || null;
	const workerOf = () => {
		if (!workerRef) workerRef = require('./bookPicturesWorker.js');
		return workerRef;
	};

	const self = {};
	const memo = new Map();
	const listeners = new Set();
	const pending = new Set();
	const missingWarned = new Set();
	let sweeping = null;
	let closed = false;
	let unsubscribeConfig = () => {};

	const enabled = () => {
		try {
			return cfgOf()[SETTING] === true;
		} catch (_) {
			return false;
		}
	};
	const prefix = () => {
		try {
			return cfgOf().commandPrefix || '!';
		} catch (_) {
			return '!';
		}
	};
	const flightKey = (key) => `${picsDir}\0${key}`;
	const alignKey = (key, base) => `${picsDir}\0${key}\0${base}`;
	const keyDirOf = (key) => path.join(picsDir, key);
	const failFileOf = (key) => path.join(picsDir, `${key}.fail.json`);
	const asideOf = (key) => path.join(picsDir, `${key}.old`);

	function safe(fn, fallback = null) {
		try {
			return fn();
		} catch (_) {
			return fallback;
		}
	}

	// A session can hold a work captured before a catalog rebuild renamed it.
	function fresh(work) {
		if (!work || typeof work.id !== 'string') return work || null;
		try {
			const c = catalog();
			const hit = c && typeof c.work === 'function' ? c.work(work.id) : null;
			return hit || work;
		} catch (_) {
			return work;
		}
	}

	function track(p) {
		pending.add(p);
		const done = () => pending.delete(p);
		p.then(done, done);
		return p;
	}

	function emit(id) {
		for (const fn of [...listeners]) {
			try {
				fn(id);
			} catch (err) {
				logger.warn('Read-along pictures: a listener failed:', codeOf(err));
			}
		}
	}

	function busyKey(key) {
		if (IN_FLIGHT.has(flightKey(key))) return true;
		const p = `${flightKey(key)}\0`;
		for (const k of IN_FLIGHT.keys()) if (k.startsWith(p)) return true;
		return false;
	}

	async function readJson(file) {
		try {
			return JSON.parse(await fsp.readFile(file, 'utf8'));
		} catch (_) {
			return null;
		}
	}

	async function rm(target) {
		await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
	}

	function toolsOf(located) {
		const out = {};
		for (const [k, v] of Object.entries(located)) if (k !== 'ok' && k !== 'code' && k !== 'reason') out[k] = v;
		return out;
	}

	const textOf = (h) => ({ base: h.base, textPath: path.resolve(h.textPath), indexPath: path.resolve(h.indexPath) });

	// --- pointers ---

	function slimPdf(pdf) {
		if (!isObject(pdf)) return null;
		return { libraryId: pdf.libraryId ?? null, id: pdf.id, uuid: pdf.uuid ?? null, size: pdf.size ?? null, mtime: pdf.mtime ?? null, fingerprint: pdf.fingerprint };
	}

	function writePointer(work, { key, base, pdf, count, redo = null }) {
		const prev = safe(() => store.pictures.peek(work));
		const t = now();
		const slim = slimPdf(pdf);
		const same = !!prev && prev.key === key && prev.base === base && prev.count === count
			&& JSON.stringify(isObject(prev.pdf) ? prev.pdf : null) === JSON.stringify(slim);
		if (same && redoOf(prev) === redo && Number.isFinite(prev.usedAt) && t - prev.usedAt < TOUCH_MS) return;
		const off = !!prev && prev.off === true;
		const next = {
			key, base, pdf: slim, count,
			at: same && Number.isFinite(prev.at) ? prev.at : t,
			usedAt: t,
			off, offBy: off ? prev.offBy ?? null : null, offAt: off ? prev.offAt ?? null : null
		};
		if (redo) next.redo = redo;
		safe(() => store.pictures.set(work.id, next));
	}

	// pictures:redo reading again an analysis another work shows: like any redo the pointer names no
	// analysis meanwhile, but it keeps the key to read, so a restart in the minutes that takes reads
	// it all the same.
	function redoPointer(work, prev, key) {
		const off = !!prev && prev.off === true;
		safe(() => store.pictures.set(work.id, {
			key: null, base: null, pdf: null, count: 0, at: now(), usedAt: prev ? prev.usedAt ?? null : null,
			off, offBy: off ? prev.offBy ?? null : null, offAt: off ? prev.offAt ?? null : null, redo: key
		}));
	}

	// The forced re-read is over: done, failed for good, or made moot by a new PDF.
	function endRedo(e) {
		e.forceFull = null;
		const prev = safe(() => store.pictures.peek(e.work));
		if (!isObject(prev) || prev.redo === undefined) return;
		const next = Object.assign({}, prev);
		delete next.redo;
		if (typeof next.key !== 'string' && next.off !== true) safe(() => store.pictures.clear(e.work));
		else safe(() => store.pictures.set(e.work.id, next));
	}

	// The owner's off switch outlives the analysis it was set on.
	function dropPointer(workOrId, prev = safe(() => store.pictures.peek(workOrId))) {
		if (!prev) return;
		const id = typeof workOrId === 'string' ? workOrId : workOrId.id;
		if (prev.off === true) {
			if (prev.key === null && prev.base === null && prev.redo === undefined) return;
			safe(() => store.pictures.set(id, { key: null, base: null, pdf: null, count: 0, at: now(), usedAt: prev.usedAt ?? null, off: true, offBy: prev.offBy ?? null, offAt: prev.offAt ?? null }));
		} else {
			safe(() => store.pictures.clear(workOrId));
		}
	}

	function touch(e) {
		e.touchedAt = now();
		const work = e.work;
		track(Promise.resolve().then(() => {
			const prev = safe(() => store.pictures.peek(work));
			if (!prev || typeof prev.key !== 'string') return;
			safe(() => store.pictures.set(work.id, Object.assign({}, prev, { usedAt: now() })));
		}));
	}

	function sameRecord(pdf, h) {
		if (!isObject(pdf) || Number(pdf.id) !== Number(h.source.id) || pdf.libraryId !== h.source.libraryId) return false;
		return !(pdf.uuid && h.source.uuid && pdf.uuid !== h.source.uuid);
	}

	function fits(ptr, h) {
		if (!isObject(ptr) || typeof ptr.key !== 'string' || !HEX16.test(ptr.key) || ptr.base !== h.base) return false;
		return sameRecord(ptr.pdf, h);
	}

	// Whether this run or an earlier one saw a PDF on the record this text comes from.
	function pdfKnown(e, ptr, h) {
		return sameRecord(e.pdf, h) || sameRecord(e.checked && e.checked.pdf, h) || sameRecord(isObject(ptr) ? ptr.pdf : null, h);
	}

	// --- files ---

	async function readFail(key, fingerprint) {
		const rec = await readJson(failFileOf(key));
		if (!isObject(rec) || typeof rec.code !== 'string') return null;
		if (rec.fingerprint && fingerprint && rec.fingerprint !== fingerprint) return null;
		return {
			code: rec.code,
			stable: rec.stable === true || STABLE.has(rec.code),
			strikes: Number.isInteger(rec.strikes) && rec.strikes > 0 ? rec.strikes : 1,
			retryAfter: Number.isFinite(rec.retryAfter) ? rec.retryAfter : null
		};
	}

	async function writeFail(key, rec) {
		const file = failFileOf(key);
		try {
			await fsp.mkdir(picsDir, { recursive: true });
			await fsp.writeFile(`${file}.tmp`, JSON.stringify(Object.assign({ version: PICTURES_VERSION }, rec, { at: now() })));
			await fsp.rename(`${file}.tmp`, file);
		} catch (_) {
			await rm(`${file}.tmp`);
		}
	}

	/**
	 * The set a key serves for one text, by the load rules: anything malformed is skipped, not
	 * fatal. `index` without `set` means the analysis is there and this text is not lined up yet.
	 */
	async function loadSet(key, base, { workId, pdf }) {
		if (!HEX16.test(String(key || '')) || !HEX16.test(String(base || ''))) return {};
		const dir = keyDirOf(key);
		const index = await readJson(path.join(dir, 'index.json'));
		if (!indexOk(index, pdf && pdf.fingerprint)) return {};
		const align = await readJson(path.join(dir, `align-${base}.json`));
		if (!alignOk(align, key, base)) {
			const fail = await readJson(path.join(dir, `align-${base}.fail.json`));
			// A failure from another alignment version or another text says nothing about this one:
			// the text is lined up again, and the answer replaces the record. Bumping ALIGN_VERSION
			// is how a better alignment retries the texts the old one failed.
			return isObject(fail) && fail.version === ALIGN_VERSION && fail.base === base ? { index, failed: fail } : { index };
		}
		const wordOk = (w) => Number.isInteger(w) && w >= 0 && w < align.textWords;
		const byId = new Map();
		for (const p of index.pictures) if (pictureOk(p) && !byId.has(p.id)) byId.set(p.id, p);
		const used = new Set();
		const pictures = [];
		for (const a of align.pictures) {
			if (!isObject(a) || typeof a.id !== 'string' || used.has(a.id)) continue;
			const p = byId.get(a.id);
			if (!p || !wordOk(a.word)) continue;
			const file = path.join(dir, p.file);
			let st = null;
			try {
				st = await fsp.stat(file);
			} catch (_) {
				st = null;
			}
			if (!st || !st.isFile() || st.size <= 0 || st.size > MAX_PICTURE_BYTES) continue;
			used.add(a.id);
			const picture = {
				id: p.id,
				word: a.word,
				path: file,
				name: p.file,
				pages: Object.freeze(p.pages.slice()),
				kind: KINDS.has(p.kind) ? p.kind : 'part',
				width: Number.isFinite(p.width) ? p.width : null,
				height: Number.isFinite(p.height) ? p.height : null,
				bytes: st.size,
				alt: altOf(p.pages, index.folioOffset)
			};
			// Where the pager shows a picture placed past the last narrated word (the book's last
			// illustration, placed at the back matter's first page): a bad one is dropped, never the picture.
			if (wordOk(a.fallback)) picture.fallback = a.fallback;
			pictures.push(Object.freeze(picture));
		}
		pictures.sort((x, y) => x.word - y.word || x.pages[0] - y.pages[0]);
		const set = Object.freeze({ key, base, workId, pdfId: pdf && Number.isInteger(Number(pdf.id)) ? Number(pdf.id) : null, count: pictures.length, pictures: Object.freeze(pictures) });
		return { index, align, set };
	}

	// --- the record ---

	/** @returns {Promise<{ pdf: object } | { pdf: null, code: string } | { error: string }>} */
	async function checkRecord(h) {
		const client = safe(() => calibre());
		if (!client) return { error: 'calibre-off' };
		const id = Number(h.source.id);
		let lib;
		try {
			lib = await client.libraryId();
		} catch (err) {
			return { error: calibreCode(err) };
		}
		// Another library's #384 is another book.
		if (typeof lib !== 'string' || !lib || lib !== h.source.libraryId) return { pdf: null, code: 'record-changed' };
		let book;
		try {
			book = await client.book(id);
		} catch (err) {
			return { error: calibreCode(err) };
		}
		if (!isObject(book)) return { pdf: null, code: 'no-pdf' };
		// Calibre reuses the id of a deleted record.
		const uuid = typeof book.uuid === 'string' && book.uuid ? book.uuid : null;
		if (uuid && h.source.uuid && uuid !== h.source.uuid) return { pdf: null, code: 'record-changed' };
		const pdf = pdfOf(book, lib, id);
		if (!pdf) return { pdf: null, code: 'no-pdf' };
		// The text this handle serves is a cached copy of a format the record no longer has.
		if (!pickFormat(book.formats)) return { pdf: null, code: 'pdf-only' };
		return { pdf };
	}

	// --- the per-work memo ---

	function entryOf(work) {
		let e = memo.get(work.id);
		if (e) return e;
		const ptr = safe(() => store.pictures.peek(work));
		e = {
			id: work.id, work, handle: null, seen: null, gen: 0,
			off: !!ptr && ptr.off === true,
			checked: null, pdf: null, set: null,
			state: 'checking', code: null, retryAt: null,
			job: null, task: null, again: false, hold: false, touchedAt: -Infinity,
			// The key pictures:redo reads again although another work shows its analysis. Read from
			// the pointer once, when this run first meets the work, so a redo the last run left
			// unfinished is done here.
			forceFull: redoOf(ptr), stale: false
		};
		memo.set(work.id, e);
		return e;
	}

	function servedFor(e, h) {
		return e.set && !e.off && isObject(h) && e.set.base === h.base ? e.set : null;
	}

	function due(e) {
		if (e.retryAt !== null) return now() >= e.retryAt;
		return !e.checked || now() - e.checked.at >= REVALIDATE_MS;
	}

	// A reload of the same key and text after its folder was replaced can hold pictures the old set
	// lacked, so any new set is news; the pager redraws a page only when its own pictures differ.
	function install(e, set, pdf) {
		const before = e.set;
		e.set = set;
		e.stale = false;
		e.pdf = pdf || e.pdf;
		// The kept analysis a forced re-read replaces serves meanwhile, but is not what was asked for.
		const redoing = e.forceFull === set.key;
		e.state = redoing ? 'checking' : 'ready';
		e.code = null;
		e.retryAt = null;
		writePointer(e.work, { key: set.key, base: set.base, pdf: e.pdf, count: set.count, redo: redoing ? set.key : null });
		e.touchedAt = now();
		if (before !== set) emit(e.id);
	}

	// The record's current PDF gives no pictures for this text. `keep` is an analysis that is there
	// and only failed to line up: its pointer stays, so the sweep keeps pages.json for the next text.
	function failed(e, code, keep = null) {
		const had = !!e.set;
		e.set = null;
		e.state = 'failed';
		e.code = code;
		e.retryAt = null;
		if (keep) writePointer(e.work, { key: keep.key, base: keep.handle.base, pdf: keep.pdf, count: 0, redo: e.forceFull === keep.key ? keep.key : null });
		else dropPointer(e.work);
		if (had) emit(e.id);
	}

	// A set already served keeps serving while a transient failure waits.
	function wait(e, code, ms) {
		e.state = code === 'tools-missing' ? 'tools-missing' : 'waiting';
		e.code = code;
		e.retryAt = now() + Math.max(0, ms);
	}

	// The record check failed before anything said this text's record has a PDF. Most records have
	// none, so no line claims a failed read; it is checked again after the same wait.
	function unknown(e, code, ms) {
		e.state = 'unknown';
		e.code = code;
		e.retryAt = now() + Math.max(0, ms);
	}

	function nothing(e, code) {
		const had = !!e.set;
		e.set = null;
		e.pdf = null;
		e.state = 'no-pdf';
		e.code = code || 'no-pdf';
		e.retryAt = null;
		dropPointer(e.work);
		if (had) emit(e.id);
	}

	function afterJob(e, res) {
		const r = isObject(res) ? res : { ok: false, code: 'crash' };
		const code = typeof r.code === 'string' ? r.code : (r.ok ? 'bad-result' : 'crash');
		if (NO_RESULT.has(code)) {
			e.state = 'checking';
			e.retryAt = now();
			return;
		}
		if (MEMORY_WAIT_MS[code] !== undefined) {
			wait(e, code, MEMORY_WAIT_MS[code]);
			return;
		}
		if (r.ok || code === 'bad-result' || code === 'align-failed') {
			// Kept in memory only, so a child that reports success without its files is not run
			// again on every page, and is after a restart.
			e.state = 'failed';
			e.code = code === 'align-failed' ? code : 'bad-result';
			e.retryAt = null;
			return;
		}
		// Reached when the strike record could not be written, as on a full disk: the wait is the
		// strike's all the same, so the PDF is not read again in minutes.
		wait(e, STRIKES.has(code) ? code : 'crash', STRIKE_RETRY_MS);
	}

	function start(e) {
		const gen = e.gen;
		const task = (async () => {
			do {
				e.again = false;
				await step(e, gen);
			} while (e.again && !closed && e.gen === gen);
		})().catch((err) => {
			logger.warn('Read-along pictures: a check failed:', codeOf(err));
		}).finally(() => {
			if (e.task === task) e.task = null;
		});
		e.task = task;
		track(task);
	}

	async function step(e, gen) {
		await sweepOnce();
		const handle = e.handle;
		const sig = e.seen;
		const live = () => !closed && e.gen === gen && e.seen === sig;
		if (!live() || !enabled() || !usableHandle(handle)) return;
		const work = e.work;
		const ptr = safe(() => store.pictures.get(work));
		e.off = !!ptr && ptr.off === true;
		if (e.off) return;
		// An analysis from an earlier run is served before Calibre is asked, so a first page never
		// waits on it and the pictures stay with Calibre closed; so is a folder another work's
		// pictures:redo replaced under this one.
		if ((e.stale || !servedFor(e, handle)) && fits(ptr, handle)) {
			const got = await loadSet(ptr.key, handle.base, { workId: e.id, pdf: ptr.pdf });
			if (!live()) return;
			if (got.set) install(e, got.set, ptr.pdf);
			// Held like any known failure, so a Calibre that is closed below does not replace it.
			else if (got.failed && !e.set) Object.assign(e, { state: 'failed', code: 'align-failed', retryAt: null });
		}
		const fresh10 = e.checked && e.checked.sig === sig && now() - e.checked.at < REVALIDATE_MS;
		let pdf = fresh10 ? e.checked.pdf : undefined;
		if (pdf === undefined) {
			const r = await checkRecord(handle);
			if (!live()) return;
			if (r.error) {
				const ms = MEMORY_WAIT_MS[r.error] || CALIBRE_RETRY_MS;
				// A failure already known for this text stands: a Calibre that does not answer says
				// nothing new about it, and only moves its next check.
				if (e.state === 'failed') e.retryAt = now() + ms;
				else if (pdfKnown(e, ptr, handle)) wait(e, r.error, ms);
				else unknown(e, r.error, ms);
				return;
			}
			e.checked = { sig, at: now(), pdf: r.pdf, code: r.code || null };
			pdf = r.pdf;
		}
		if (!pdf) {
			nothing(e, e.checked.code);
			return;
		}
		e.pdf = pdf;
		const key = picturesKey(pdf.fingerprint);
		// The record holds another PDF since pictures:redo: reading that one is the re-read.
		if (e.forceFull && e.forceFull !== key) endRedo(e);
		if (e.set && !e.stale && e.set.key === key && e.set.base === handle.base && e.forceFull !== key) {
			e.state = 'ready';
			e.code = null;
			e.retryAt = null;
			if (now() - e.touchedAt >= TOUCH_MS) touch(e);
			return;
		}
		await settle(e, { work, handle, pdf, key, gen }, live, null);
	}

	/**
	 * What the files say for this key and text, and the job they call for. `after` is the job that
	 * just ran: no second job of its kind is started, so a child that leaves nothing usable cannot
	 * loop. A full analysis this work joined may have been lined up with another narration's text,
	 * so an align job can still follow it.
	 */
	async function settle(e, ctx, live, after) {
		const { key, handle, pdf } = ctx;
		if (!after && e.forceFull === key) {
			await reread(e, ctx, live);
			return;
		}
		const got = await loadSet(key, handle.base, { workId: e.id, pdf });
		if (!live()) return;
		if (got.set) {
			install(e, got.set, pdf);
			return;
		}
		if (got.failed) {
			failed(e, 'align-failed', ctx);
			return;
		}
		if (got.index) {
			if (after && after.kind === 'align') {
				afterJob(e, after.res);
				return;
			}
			const res = await alignJob(e, ctx);
			if (!live()) return;
			await settle(e, ctx, live, { kind: 'align', res });
			return;
		}
		const rec = await readFail(key, pdf.fingerprint);
		if (!live()) return;
		if (rec && rec.stable) {
			failed(e, rec.code);
			return;
		}
		if (rec && rec.retryAfter !== null && rec.retryAfter > now()) {
			wait(e, rec.code, rec.retryAfter - now());
			return;
		}
		if (after) {
			afterJob(e, after.res);
			return;
		}
		const res = await fullJob(e, ctx);
		if (!live()) return;
		await settle(e, ctx, live, { kind: 'full', res });
	}

	/**
	 * pictures:redo on an analysis another work still shows: the PDF is read again all the same, and
	 * the new folder replaces the kept one only when it is whole (swapIn); the kept one serves
	 * meanwhile. A re-read that fails for a reason that passes (a wait in memory, a cancel or a
	 * shutdown, a strike) is tried again after that failure's own wait, a strike's taken from its
	 * record so that it holds across a restart. A stable failure or the third strike ends the redo.
	 */
	async function reread(e, ctx, live) {
		const { key, pdf } = ctx;
		const rec = await readFail(key, pdf.fingerprint);
		if (!live()) return;
		const held = !!rec && !rec.stable && rec.retryAfter !== null && rec.retryAfter > now();
		let res = null;
		// A stable record says this PDF was read and failed for good since the redo was asked.
		if (rec && rec.stable) endRedo(e);
		else res = held ? { ok: false, code: rec.code } : await fullJob(e, ctx);
		const code = res && !res.ok ? (typeof res.code === 'string' ? res.code : 'crash') : null;
		const again = !!code && (NO_RESULT.has(code) || MEMORY_WAIT_MS[code] !== undefined || STRIKES.has(code));
		// Before the text is checked again: a re-read that ended is not run again for a text that
		// changed meanwhile. A redo asked since (a new gen) decides for itself.
		if (res && !again && !closed && e.gen === ctx.gen) endRedo(e);
		if (!live()) return;
		await settle(e, ctx, live, res ? { kind: 'full', res } : null);
		if (!live() || !again || e.forceFull !== key) return;
		if (NO_RESULT.has(code)) {
			e.state = 'checking';
			e.code = null;
			e.retryAt = now();
			return;
		}
		wait(e, code, held ? rec.retryAfter - now() : STRIKES.has(code) ? STRIKE_RETRY_MS : MEMORY_WAIT_MS[code]);
		// Even for missing tools: the kept pictures still show, so not the line that says there are none.
		e.state = 'waiting';
	}

	// --- jobs ---

	function fullJob(e, ctx) {
		const fk = flightKey(ctx.key);
		let job = IN_FLIGHT.get(fk);
		if (!job) {
			job = { kind: 'full', dir: picsDir, key: ctx.key, owner: self, phase: 'queued', progress: null, cancelled: false, settled: false };
			job.promise = new Promise((resolve) => {
				job.settle = (res) => {
					if (job.settled) return;
					job.settled = true;
					if (IN_FLIGHT.get(fk) === job) IN_FLIGHT.delete(fk);
					resolve(res);
				};
			});
			job.begin = () => runFull(job, ctx).catch(() => ({ ok: false, code: 'crash' })).then((res) => job.settle(res));
			IN_FLIGHT.set(fk, job);
			FULL_QUEUE.push(job);
			pumpFull();
		}
		e.job = job;
		return job.promise.finally(() => {
			if (e.job === job) e.job = null;
		});
	}

	async function runFull(job, ctx) {
		const { key, pdf, handle } = ctx;
		const stopped = () => (job.cancelled ? 'cancelled' : closed ? 'shutdown' : !enabled() ? 'cancelled' : null);
		if (stopped()) return { ok: false, code: stopped() };
		let tools = null;
		try {
			tools = await locateTools(cfgOf());
		} catch (_) {
			tools = null;
		}
		if (stopped()) return { ok: false, code: stopped() };
		if (!isObject(tools) || tools.ok !== true) {
			const reason = isObject(tools) && typeof tools.reason === 'string' && /^[a-z-]{1,32}$/.test(tools.reason) ? tools.reason : 'not-found';
			logger.warn(`Read-along pictures: Calibre's PDF tools were not found (${reason}).`);
			return { ok: false, code: 'tools-missing' };
		}
		const client = safe(() => calibre());
		if (!client) return { ok: false, code: 'calibre-off' };
		const workDir = path.join(picsDir, `${key}.work`);
		const started = now();
		let ran = false;
		try {
			await fsp.rm(workDir, { recursive: true, force: true });
			await fsp.mkdir(workDir, { recursive: true });
			const pdfPath = path.join(workDir, 'book.pdf');
			job.phase = 'downloading';
			try {
				await client.downloadFormat(pdf.id, 'pdf', pdfPath);
			} catch (err) {
				const code = downloadCode(err);
				// Asked again every 10 minutes while the file is gone: one line says it.
				if (code !== 'pdf-missing' || !missingWarned.has(key)) logger.warn(`Read-along pictures: could not download the PDF for ${key}: ${code}.`);
				if (code === 'pdf-missing') missingWarned.add(key);
				return await recordFull(ctx, { ok: false, code });
			}
			if (stopped()) return { ok: false, code: stopped() };
			const w = workerOf();
			job.phase = safe(() => w.busy(), false) ? 'queued' : 'running';
			let res = await w.run({
				kind: 'full', key, fingerprint: pdf.fingerprint, workDir, keyDir: keyDirOf(key), pdfPath, text: textOf(handle),
				tools: toolsOf(tools), limits: Object.assign({}, LIMITS), versions: Object.assign({}, VERSIONS)
			}, { onProgress: (p) => progressOf(job, p) });
			ran = true;
			if (!isObject(res)) res = { ok: false, code: 'crash' };
			if (job.cancelled) return { ok: false, code: 'cancelled' };
			const out = path.join(workDir, 'out');
			const index = await readJson(path.join(out, 'index.json'));
			// index.json is written last: when it is whole, the analysis is, whatever the answer said.
			if (indexOk(index, pdf.fingerprint)) {
				let replaced;
				try {
					replaced = await swapIn(key, out);
				} catch (err) {
					logger.warn(`Read-along pictures: could not put the analysis ${key} in place:`, codeOf(err));
					return await recordFull(ctx, { ok: false, code: 'disk-error' });
				}
				await rm(failFileOf(key));
				if (replaced) outdated(key);
				const pages = isObject(index.pdf) && Number.isInteger(index.pdf.pages) ? index.pdf.pages : '?';
				const spreads = index.pictures.filter((p) => isObject(p) && p.kind === 'spread').length;
				const ms = isObject(res.summary) && Number.isFinite(res.summary.ms) ? res.summary.ms : now() - started;
				logger.info(`Read-along pictures: read the PDF for pictures ${key}: ${pages} pages, ${index.pictures.length} pictures (${spreads} spreads) in ${ms} ms${partOf(index.summary)}.`);
				// While this key is still in flight, so the cap cannot take the analysis just made.
				await capSize();
				return { ok: true, summary: isObject(res.summary) ? res.summary : null };
			}
			if (res.ok) res = { ok: false, code: 'crash' };
			// The child downloads nothing, so its disk errors come after the PDF was fetched and read.
			else if (res.code === 'io-error') res = { ok: false, code: 'disk-error' };
			return await recordFull(ctx, res);
		} catch (err) {
			logger.warn(`Read-along pictures: the analysis ${key} failed on disk:`, codeOf(err));
			// Until the child has read the PDF, trying again in 2 minutes costs little; after that, a
			// disk that keeps failing would cost a download and minutes of CPU each time.
			return ran ? await recordFull(ctx, { ok: false, code: 'disk-error' }) : { ok: false, code: 'io-error' };
		} finally {
			// After the child has closed: Windows will not delete a folder a process holds a file in.
			await rm(workDir);
		}
	}

	// A virus scanner opening the new JPGs can hold the folder for a moment.
	async function renameDir(from, to) {
		for (let i = 0; ; i++) {
			try {
				await fsp.rename(from, to);
				return;
			} catch (err) {
				if (i >= 4 || !RENAME_RETRY.has(err && err.code)) throw err;
				await new Promise((r) => {
					const h = setTimeout(r, 200);
					if (h && typeof h.unref === 'function') h.unref();
				});
			}
		}
	}

	/**
	 * Puts a finished analysis in as <key>/. Another work's pages may be showing the folder it
	 * replaces (pictures:redo on a shared key), so that one is moved aside rather than deleted
	 * first, and moved back when the new one cannot go in: the key never loses its folder for more
	 * than the moment between two renames. A crash in that moment leaves <key>.old for the sweep.
	 * @returns {Promise<boolean>} whether an older folder was replaced
	 */
	async function swapIn(key, from) {
		const to = keyDirOf(key);
		const aside = asideOf(key);
		await rm(aside);
		let replaced = false;
		try {
			await renameDir(to, aside);
			replaced = true;
		} catch (err) {
			if (!err || err.code !== 'ENOENT') throw err;
		}
		try {
			await renameDir(from, to);
		} catch (err) {
			if (replaced) {
				await renameDir(aside, to).catch((back) => {
					logger.warn(`Read-along pictures: could not move the analysis ${key} back:`, codeOf(back));
				});
			}
			throw err;
		}
		if (replaced) await rm(aside);
		return replaced;
	}

	// The works showing a folder just replaced load the new one on their next look, keeping their
	// pictures until then; one whose text the new folder is not lined up with yet is lined up again.
	function outdated(key) {
		for (const x of memo.values()) {
			if (!x.set || x.set.key !== key) continue;
			x.stale = true;
			x.retryAt = now();
		}
	}

	async function recordFull(ctx, res) {
		const { key, pdf } = ctx;
		const code = typeof res.code === 'string' ? res.code : 'crash';
		if (NO_RESULT.has(code) || MEMORY_WAIT_MS[code] !== undefined) return { ok: false, code };
		if (STABLE.has(code)) {
			await writeFail(key, { fingerprint: pdf.fingerprint, code, stable: true, strikes: 1, retryAfter: null });
			logger.warn(`Read-along pictures: the PDF ${key} gives no pictures: ${code}.`);
			return { ok: false, code };
		}
		const strike = STRIKES.has(code) ? code : 'crash';
		const prev = await readFail(key, pdf.fingerprint);
		const strikes = (prev && !prev.stable ? prev.strikes : 0) + 1;
		if (strikes >= MAX_STRIKES) {
			await writeFail(key, { fingerprint: pdf.fingerprint, code: 'gave-up', stable: true, strikes, retryAfter: null });
			logger.warn(`Read-along pictures: reading the PDF ${key} failed ${strikes} times (${strike}); it is not tried again.`);
			return { ok: false, code: 'gave-up' };
		}
		await writeFail(key, { fingerprint: pdf.fingerprint, code: strike, stable: false, strikes, retryAfter: now() + STRIKE_RETRY_MS });
		logger.warn(`Read-along pictures: reading the PDF ${key} failed (${strike}), strike ${strikes} of ${MAX_STRIKES}; it tries again in 30 minutes.`);
		return { ok: false, code: strike };
	}

	function alignJob(e, ctx) {
		const { key, handle } = ctx;
		const ak = alignKey(key, handle.base);
		let job = IN_FLIGHT.get(ak);
		if (!job) {
			job = { kind: 'align', dir: picsDir, key, base: handle.base, owner: self, phase: 'aligning', progress: null };
			const started = now();
			// Lining up reads pages.json and the text only: no tool runs, so none is looked for.
			job.promise = Promise.resolve()
				.then(() => workerOf().run({
					kind: 'align', key, workDir: keyDirOf(key), keyDir: keyDirOf(key), text: textOf(handle),
					tools: null, limits: Object.assign({}, LIMITS), versions: Object.assign({}, VERSIONS)
				}, { onProgress: (p) => progressOf(job, p) }))
				.then((res) => (isObject(res) ? res : { ok: false, code: 'crash' }), () => ({ ok: false, code: 'crash' }))
				.then((res) => {
					if (IN_FLIGHT.get(ak) === job) IN_FLIGHT.delete(ak);
					if (res.ok) {
						const ms = isObject(res.summary) && Number.isFinite(res.summary.ms) ? res.summary.ms : now() - started;
						logger.info(`Read-along pictures: lined up ${key} with text ${handle.base} in ${ms} ms.`);
					} else if (res.code === 'align-failed') {
						logger.warn(`Read-along pictures: the PDF ${key} does not line up with text ${handle.base}.`);
					} else if (!NO_RESULT.has(res.code)) {
						logger.warn(`Read-along pictures: lining up ${key} with text ${handle.base} failed: ${typeof res.code === 'string' ? res.code.slice(0, 32) : 'crash'}.`);
					}
					return res;
				});
			IN_FLIGHT.set(ak, job);
		}
		e.job = job;
		return job.promise.finally(() => {
			if (e.job === job) e.job = null;
		});
	}

	function cancelKey(key) {
		for (let i = FULL_QUEUE.length - 1; i >= 0; i--) {
			const job = FULL_QUEUE[i];
			if (job.dir === picsDir && job.key === key) {
				FULL_QUEUE.splice(i, 1);
				job.settle({ ok: false, code: 'cancelled' });
			}
		}
		const running = IN_FLIGHT.get(flightKey(key));
		if (running) running.cancelled = true;
		if (workerRef || busyKey(key)) {
			try {
				workerOf().cancel(key);
			} catch (_) { /* nothing running for it */ }
		}
	}

	function flightsOf(key) {
		const out = [];
		const p = flightKey(key);
		for (const [k, job] of IN_FLIGHT) if (k === p || k.startsWith(`${p}\0`)) out.push(job.promise);
		return out;
	}

	function within(list, ms) {
		const ps = list.filter(Boolean).map((p) => Promise.resolve(p).catch(() => {}));
		if (!ps.length) return Promise.resolve();
		let timer = null;
		const late = new Promise((r) => {
			timer = setTimeout(r, ms);
			if (timer && typeof timer.unref === 'function') timer.unref();
		});
		return Promise.race([Promise.all(ps), late]).finally(() => clearTimeout(timer));
	}

	// --- the sweep and the size cap ---

	function sweepOnce() {
		if (!sweeping) sweeping = sweep().catch((err) => logger.warn('Read-along pictures: the sweep failed:', codeOf(err)));
		return sweeping;
	}

	async function failTime(file) {
		const rec = await readJson(file);
		if (isObject(rec) && Number.isFinite(rec.at)) return rec.at;
		try {
			return (await fsp.stat(file)).mtimeMs;
		} catch (_) {
			return now();
		}
	}

	// Runs once per instance, before its first load or job, and skips every key with a job in
	// flight anywhere in the process.
	async function sweep() {
		if (!picsDir) return;
		let names;
		try {
			names = await fsp.readdir(picsDir, { withFileTypes: true });
		} catch (_) {
			return;
		}
		const pointers = Object.values(safe(() => store.pictures.all(), {}) || {}).filter(isObject);
		const keys = new Set(pointers.map((p) => p.key).filter((k) => typeof k === 'string'));
		const bases = new Set(pointers.map((p) => p.base).filter((b) => typeof b === 'string'));
		for (const p of Object.values(safe(() => store.works.all(), {}) || {})) if (isObject(p) && typeof p.base === 'string') bases.add(p.base);
		const t = now();
		const present = new Set(names.map((d) => d.name));
		let removed = 0;
		let restored = 0;
		for (const d of names) {
			const full = path.join(picsDir, d.name);
			let m = /^([0-9a-f]{16})\.work$/.exec(d.name);
			if (m) {
				if (!busyKey(m[1])) {
					await rm(full);
					removed++;
				}
				continue;
			}
			m = /^([0-9a-f]{16})\.old$/.exec(d.name);
			if (m) {
				if (busyKey(m[1])) continue;
				// swapIn cut short between its two renames: the analysis it moved aside is the only one
				// a work's pointer names, so it goes back rather than being read from the PDF again.
				if (d.isDirectory() && keys.has(m[1]) && !present.has(m[1])) {
					if (await fsp.rename(full, keyDirOf(m[1])).then(() => true, () => false)) restored++;
				} else {
					await rm(full);
					removed++;
				}
				continue;
			}
			m = /^([0-9a-f]{16})\.fail\.json(\.tmp)?$/.exec(d.name);
			if (m) {
				// A failed key never gets a pointer, so its record is kept for 30 days by its age alone.
				if (!busyKey(m[1]) && (m[2] || t - await failTime(full) > FAIL_RECORD_MAX_AGE_MS)) {
					await rm(full);
					removed++;
				}
				continue;
			}
			if (!d.isDirectory() || !HEX16.test(d.name) || busyKey(d.name)) continue;
			if (!keys.has(d.name)) {
				await rm(full);
				removed++;
				continue;
			}
			let inner = [];
			try {
				inner = await fsp.readdir(full);
			} catch (_) {
				inner = [];
			}
			for (const f of inner) {
				const a = ALIGN_FILE.exec(f);
				if ((a && !bases.has(a[1])) || f.endsWith('.tmp')) {
					await rm(path.join(full, f));
					removed++;
				}
			}
		}
		if (removed) logger.info(`Read-along pictures: removed ${removed} unused file(s) or folder(s).`);
		if (restored) logger.info(`Read-along pictures: put back ${restored} analysis folder(s) a crash left aside.`);
		await capSize();
	}

	async function dirSize(dir) {
		let total = 0;
		let list = [];
		try {
			list = await fsp.readdir(dir, { withFileTypes: true });
		} catch (_) {
			return 0;
		}
		for (const d of list) {
			const full = path.join(dir, d.name);
			if (d.isDirectory()) total += await dirSize(full);
			else total += await fsp.stat(full).then((st) => st.size, () => 0);
		}
		return total;
	}

	/** Whole analyses go, least recently used first, until the folder is under the cap again. */
	async function capSize() {
		if (!picsDir) return 0;
		let names;
		try {
			names = await fsp.readdir(picsDir, { withFileTypes: true });
		} catch (_) {
			return 0;
		}
		const pointers = Object.entries(safe(() => store.pictures.all(), {}) || {}).filter(([, p]) => isObject(p));
		const usedAt = new Map();
		for (const [, p] of pointers) {
			if (typeof p.key !== 'string') continue;
			const at = Number.isFinite(p.usedAt) ? p.usedAt : -Infinity;
			usedAt.set(p.key, Math.max(usedAt.has(p.key) ? usedAt.get(p.key) : -Infinity, at));
		}
		const folders = [];
		let total = 0;
		for (const d of names) {
			if (!d.isDirectory() || !HEX16.test(d.name)) continue;
			const size = await dirSize(path.join(picsDir, d.name));
			total += size;
			folders.push({ key: d.name, size, usedAt: usedAt.has(d.name) ? usedAt.get(d.name) : -Infinity });
		}
		if (total <= maxDirBytes) return 0;
		const t = now();
		// A set in memory counts only while pages use it: memo entries live as long as the bot, and
		// every analysis opened since the start would otherwise be out of the cap's reach.
		const served = new Set();
		for (const e of memo.values()) if (e.set && t - e.touchedAt < RECENT_USE_MS) served.add(e.set.key);
		const victims = folders
			.filter((f) => !busyKey(f.key) && !served.has(f.key) && t - f.usedAt >= RECENT_USE_MS)
			.sort((a, b) => a.usedAt - b.usedAt);
		let removed = 0;
		let freed = 0;
		for (const f of victims) {
			if (total <= maxDirBytes) break;
			await rm(path.join(picsDir, f.key));
			total -= f.size;
			freed += f.size;
			removed++;
			for (const [id, p] of pointers) if (p.key === f.key) dropPointer(id, p);
			// Its files are gone: the next page drawn checks the record again instead of serving them.
			// No emit: the pager answers one by opening the text, and a paused book's DM page stays
			// open, so the PDF would be read straight back for nobody. That page keeps the copies
			// Discord already holds until it is drawn again.
			for (const e of memo.values()) {
				if (!e.set || e.set.key !== f.key) continue;
				Object.assign(e, { set: null, checked: null, state: 'checking', code: null, retryAt: t, stale: false });
			}
		}
		if (removed) {
			const mb = (n) => Math.round(n / 1048576);
			logger.info(`Read-along pictures: the pictures folder was over ${mb(maxDirBytes)} MB; removed the ${removed} least recently used analyses (${mb(freed)} MB).`);
		}
		return removed;
	}

	// --- public ---

	/** The set of pictures for this text, or null. Synchronous: never reads the disk, never starts work. */
	function forText(work, handle) {
		if (closed || !picsDir || !enabled() || !usableHandle(handle)) return null;
		const id = typeof handle.workId === 'string' && handle.workId ? handle.workId : null;
		const e = (id && memo.get(id)) || (work && typeof work.id === 'string' ? memo.get(work.id) : null);
		return e ? servedFor(e, handle) : null;
	}

	/** Loads, checks or queues in the background; a memo hit is a Map lookup. */
	function ensure(workIn, handle) {
		if (closed || !picsDir || !enabled() || !usableHandle(handle)) return;
		const work = fresh(workIn);
		if (!work || typeof work.id !== 'string' || !work.id || work.kind === 'podcast') return;
		const e = entryOf(work);
		e.work = work;
		e.handle = handle;
		const sig = signatureOf(handle);
		const changed = e.seen !== sig;
		if (changed) {
			e.seen = sig;
			e.retryAt = null;
			if (!servedFor(e, handle)) {
				e.state = 'checking';
				e.code = null;
			}
		}
		if (e.off) return;
		// `hold`: pictures:redo is clearing this work's files, and starts the next step itself.
		if (e.task || e.hold) {
			if (changed) e.again = true;
			return;
		}
		if (changed || due(e)) {
			start(e);
			return;
		}
		if (e.set && now() - e.touchedAt >= TOUCH_MS) touch(e);
	}

	/** The PictureStatus behind the 🖼 line of `!book text` (statusLine). */
	function status(workIn, handle) {
		const work = fresh(workIn);
		const out = { state: 'off', pdfId: null, count: 0, progress: null, code: null, retryAt: null, retryIn: null, title: work && typeof work.title === 'string' ? work.title : null };
		if (!picsDir || !work || typeof work.id !== 'string') return out;
		if (work.kind === 'podcast' || !usableHandle(handle)) {
			out.state = 'not-calibre';
			return out;
		}
		out.pdfId = Number(handle.source.id);
		const ptr = safe(() => store.pictures.peek(work));
		const e = memo.get(work.id);
		if (!enabled()) {
			out.count = ptr && typeof ptr.key === 'string' && Number.isInteger(ptr.count) ? ptr.count : 0;
			return out;
		}
		if (e ? e.off : !!ptr && ptr.off === true) {
			out.state = 'book-off';
			return out;
		}
		if (!e || e.seen !== signatureOf(handle)) {
			out.state = 'checking';
			return out;
		}
		const served = servedFor(e, handle);
		// A kept analysis that pictures:redo is reading again serves meanwhile: the state is the
		// re-read's until the new one is in.
		if (served && e.forceFull !== served.key) {
			out.state = 'ready';
			out.count = served.count;
			return out;
		}
		if (e.job) {
			out.state = e.job.phase;
			out.progress = e.job.progress ? Object.assign({}, e.job.progress) : null;
			return out;
		}
		out.state = e.state;
		out.code = e.code;
		out.retryAt = e.retryAt;
		out.retryIn = e.retryAt !== null ? Math.max(0, e.retryAt - now()) : null;
		return out;
	}

	/**
	 * The pictures report for `!book link <book>`. Never a path: the PDF by record id, size and
	 * mtime. A book not opened in this run is looked up through its text pointer and Calibre.
	 * @returns {Promise<{ enabled: boolean, state: string, off: boolean, offBy: string|null,
	 *   offAt: number|null, pdfId: number|null, pdf: { id, size, mtime }|null, key: string|null,
	 *   base: string|null, count: number|null, found: number|null, pages: number|null,
	 *   quality: { textPages, aligned, share }|null, share: number|null,
	 *   progress: object|null, code: string|null, retryAt: number|null }>}
	 */
	async function describe(workIn) {
		const work = fresh(workIn);
		const out = {
			enabled: enabled(), state: 'off', off: false, offBy: null, offAt: null, pdfId: null, pdf: null, key: null, base: null,
			count: null, found: null, pages: null, quality: null, share: null, progress: null, code: null, retryAt: null
		};
		if (!picsDir || !work || typeof work.id !== 'string') return out;
		const reply = (pdf) => (isObject(pdf) ? { id: Number(pdf.id), size: pdf.size ?? null, mtime: pdf.mtime ?? null } : null);
		const ptr = safe(() => store.pictures.peek(work));
		if (ptr) {
			out.off = ptr.off === true;
			out.offBy = ptr.offBy ?? null;
			out.offAt = ptr.offAt ?? null;
			if (typeof ptr.key === 'string') {
				out.key = ptr.key;
				out.base = typeof ptr.base === 'string' ? ptr.base : null;
				out.count = Number.isInteger(ptr.count) ? ptr.count : null;
			}
			out.pdf = reply(ptr.pdf);
		}
		const e = memo.get(work.id);
		// A re-read pictures:redo still owes, from this run or the pointer of an earlier one: the
		// analysis it replaces is no answer to it.
		const owed = (e && e.forceFull) || redoOf(ptr);
		let pdf = null;
		let base = out.base;
		if (!out.enabled) out.state = 'off';
		else if (out.off) out.state = 'book-off';
		else if (e && usableHandle(e.handle)) {
			const st = status(work, e.handle);
			Object.assign(out, { state: st.state, code: st.code, retryAt: st.retryAt, progress: st.progress });
			if (st.state === 'ready') out.count = st.count;
			base = e.handle.base;
			pdf = e.set && e.pdf ? e.pdf : (e.checked && e.checked.pdf) || null;
		} else {
			const tp = safe(() => store.works.peek(work));
			const source = isObject(tp) && isObject(tp.source) ? tp.source : null;
			if (!source) out.state = 'unknown';
			else if (source.type !== 'calibre') out.state = 'not-calibre';
			else {
				base = typeof tp.base === 'string' ? tp.base : null;
				const r = await checkRecord({ base, source });
				if (r.error) {
					out.state = 'unknown';
					out.code = r.error;
				} else if (!r.pdf) {
					out.state = 'no-pdf';
					out.code = r.code;
				} else {
					pdf = r.pdf;
					out.state = 'available';
				}
			}
		}
		if (pdf) {
			out.pdf = reply(pdf);
			out.key = picturesKey(pdf.fingerprint);
		}
		out.pdfId = out.pdf ? out.pdf.id : null;
		if (out.key && base && HEX16.test(base)) {
			out.base = base;
			const got = await loadSet(out.key, base, { workId: work.id, pdf });
			if (got.index) {
				out.found = got.index.pictures.length;
				out.pages = isObject(got.index.pdf) && Number.isInteger(got.index.pdf.pages) ? got.index.pdf.pages : null;
			}
			if (got.set) {
				if ((out.state === 'available' || out.state === 'unknown') && out.key !== owed) out.state = 'ready';
				if (out.state === 'ready') out.count = got.set.count;
				const q = isObject(got.align.quality) ? got.align.quality : null;
				out.quality = q ? { textPages: q.textPages ?? null, aligned: q.aligned ?? null, share: Number.isFinite(q.share) ? q.share : null } : null;
			} else if (got.failed) {
				// A Calibre that is not answering is why the record went unchecked, not why there are
				// no pictures: the kept alignment failure is.
				if (out.state === 'available' || out.state === 'unknown') Object.assign(out, { state: 'failed', code: 'align-failed' });
				else out.code = out.code || 'align-failed';
				out.quality = { textPages: null, aligned: null, share: Number.isFinite(got.failed.share) ? got.failed.share : null };
			} else if (!got.index && pdf && (out.state === 'available' || out.state === 'unknown')) {
				const rec = await readFail(out.key, pdf.fingerprint);
				if (rec && rec.stable) Object.assign(out, { state: 'failed', code: rec.code });
				else if (rec && rec.retryAfter !== null && rec.retryAfter > now()) Object.assign(out, { state: 'waiting', code: rec.code, retryAt: rec.retryAfter });
			}
		}
		out.share = out.quality ? out.quality.share : null;
		return out;
	}

	function setOff(work, off, by, p) {
		const prev = safe(() => store.pictures.peek(work));
		let saved = true;
		if (off) {
			const entry = Object.assign({ key: null, base: null, pdf: null, count: 0, at: now(), usedAt: null }, prev || {}, {
				off: true, offBy: by === null || by === undefined ? null : String(by), offAt: now()
			});
			saved = safe(() => store.pictures.set(work.id, entry), false) !== false;
		} else if (prev && (typeof prev.key === 'string' || redoOf(prev))) {
			saved = safe(() => store.pictures.set(work.id, Object.assign({}, prev, { off: false, offBy: null, offAt: null })), false) !== false;
		} else if (prev) {
			saved = safe(() => store.pictures.clear(work), false) !== false;
		}
		const e = memo.get(work.id);
		if (e) {
			e.off = off;
			if (!off && !e.set) e.retryAt = now();
		}
		emit(work.id);
		const title = String(work.title || work.id).replace(/([\\*_`~|])/g, '\\$1');
		const unsaved = saved ? '' : ' (it could not be saved, so it lasts until the bot restarts)';
		if (off) return { ok: true, code: 'off', text: `🖼 Pictures are now off for ${title}${unsaved}.` };
		const later = enabled() ? '' : ` They show once audiobookTextPictures is on (\`${p}config\` → Audiobooks).`;
		return { ok: true, code: 'on', text: `🖼 Pictures are on again for ${title}${unsaved}.${later}` };
	}

	/**
	 * Deletes a key's failure record and, unless another work's pointer names the key, its folder.
	 * A shared folder stays whole for that work's pages, alignments included, until a new analysis
	 * replaces it (swapIn); should the re-read fail, it serves on as before.
	 * @returns {Promise<boolean>} whether the folder was kept because another work shows it
	 */
	async function clearKey(key, work) {
		const mine = new Set(idsOf(work));
		const shared = Object.entries(safe(() => store.pictures.all(), {}) || {}).some(([id, ptr]) => !mine.has(id) && isObject(ptr) && ptr.key === key);
		await rm(failFileOf(key));
		if (!shared) await rm(keyDirOf(key));
		return shared;
	}

	async function redo(work, p) {
		const look = `\`${p}book link ${titleArg(work.title)}\``;
		if (!enabled()) return { ok: false, code: 'disabled', text: `🖼 Pictures are turned off for every book (audiobookTextPictures in \`${p}config\` → Audiobooks).` };
		if (work.kind === 'podcast') return { ok: false, code: 'podcast', text: '🖼 Podcasts have no pictures.' };
		const ptr = safe(() => store.pictures.peek(work));
		const prior = memo.get(work.id);
		// An off switch that could not be saved holds in memory until the bot restarts.
		if ((ptr && ptr.off === true) || (prior && prior.off === true)) return { ok: false, code: 'book-off', text: `🖼 Pictures are off for this book; \`${p}book link ${titleArg(work.title)} pictures:on\` turns them back on first.` };
		const e = entryOf(work);
		e.work = work;
		let handle = usableHandle(e.handle) ? e.handle : null;
		if (openText) {
			let opened = null;
			try {
				opened = await openText(work);
			} catch (_) {
				opened = null;
			}
			if (!opened || !opened.ok || !opened.handle) {
				const why = opened && typeof opened.text === 'string' && opened.text ? ` ${opened.text}` : '';
				return { ok: false, code: (opened && opened.code) || 'no-text', text: `🖼 This book has no text to line pictures up with.${why}` };
			}
			handle = opened.handle;
			if (!usableHandle(handle)) return { ok: false, code: 'not-calibre', text: '🖼 This book\'s text isn\'t from a Calibre record, so there is no PDF to read pictures from.' };
		}
		let pdf = null;
		if (handle) {
			const r = await checkRecord(handle);
			if (r.error) return { ok: false, code: r.error, text: `🖼 ${calibreText(r.error, p)}` };
			const id = Number(handle.source.id);
			if (!r.pdf) {
				e.handle = handle;
				e.seen = signatureOf(handle);
				e.checked = { sig: e.seen, at: now(), pdf: null, code: r.code };
				nothing(e, r.code);
				return {
					ok: false,
					code: r.code,
					text: r.code === 'record-changed'
						? `🖼 Calibre #${id} no longer holds the book this text came from, so it has no pictures.`
						: `🖼 Calibre #${id} has no PDF to read pictures from (or nothing else to line its pages up with).`
				};
			}
			pdf = r.pdf;
		}
		const keys = new Set();
		if (pdf) keys.add(picturesKey(pdf.fingerprint));
		if (ptr && typeof ptr.key === 'string' && HEX16.test(ptr.key)) keys.add(ptr.key);
		if (redoOf(ptr)) keys.add(redoOf(ptr));
		// The analysis the next look serves: the record's PDF now, else the one the pointer names.
		const target = pdf ? picturesKey(pdf.fingerprint) : [...keys][0] || null;
		e.hold = true;
		e.gen++;
		for (const k of keys) cancelKey(k);
		await within([e.task, ...[...keys].flatMap(flightsOf)], CANCEL_WAIT_MS);
		if (closed) {
			e.hold = false;
			return { ok: false, code: 'shutdown', text: '🖼 The bot is restarting; try again in a moment.' };
		}
		const kept = new Set();
		for (const k of keys) if (await clearKey(k, work)) kept.add(k);
		// A kept shared folder would be served as it is: forceFull reads its PDF again regardless.
		const forced = target && kept.has(target) ? target : null;
		// pictures:off can arrive while the job lets go; the owner's switch outlives a redo.
		const latest = safe(() => store.pictures.peek(work));
		const off = e.off === true || (!!latest && latest.off === true);
		if (forced) redoPointer(work, latest, forced);
		else dropPointer(work, latest);
		const had = !!e.set;
		Object.assign(e, { set: null, pdf, job: null, state: 'checking', code: null, retryAt: null, again: false, off, hold: false, forceFull: forced, stale: false });
		if (had) emit(work.id);
		const id = pdf ? pdf.id : (ptr && isObject(ptr.pdf) ? ptr.pdf.id : null);
		const record = Number.isInteger(id) ? `Calibre #${id}` : 'Calibre';
		if (off) {
			return { ok: false, code: 'book-off', text: `🖼 Cleared the pictures, but they were switched off for this book meanwhile; \`${p}book link ${titleArg(work.title)} pictures:on\` reads ${record}'s PDF again.` };
		}
		if (!handle) {
			e.checked = null;
			e.seen = null;
			return { ok: true, code: 'redo', text: `🖼 Cleared the pictures; ${record}'s PDF is read again the next time the book's text opens. ${look} shows how far it is.` };
		}
		e.handle = handle;
		e.seen = signatureOf(handle);
		e.checked = { sig: e.seen, at: now(), pdf, code: null };
		start(e);
		return { ok: true, code: 'redo', text: `🖼 Reading ${record}'s PDF for pictures again; it takes a few minutes. ${look} shows how far it is.` };
	}

	/**
	 * The owner's controls from `!book link <book> pictures:redo|off|on`.
	 * @returns {Promise<{ ok: boolean, code: string, text: string }>}
	 */
	async function command(workIn, action, { by = null } = {}) {
		const work = fresh(workIn);
		const p = prefix();
		if (!work || typeof work.id !== 'string' || !work.id) return { ok: false, code: 'no-book', text: '🖼 Which book?' };
		if (!picsDir) return { ok: false, code: 'unavailable', text: '🖼 Read-along pictures have no folder to work in here.' };
		const act = String(action || '').trim().toLowerCase();
		if (act === 'off' || act === 'on') return setOff(work, act === 'off', by, p);
		if (act === 'redo') return redo(work, p);
		return { ok: false, code: 'bad-action', text: '🖼 Use `pictures:redo`, `pictures:off` or `pictures:on`.' };
	}

	function onChange(fn) {
		if (typeof fn !== 'function') return () => {};
		listeners.add(fn);
		return () => listeners.delete(fn);
	}

	// Off cancels this instance's jobs and clears every open picture page at once; on brings the
	// kept sets back on each page's next look, with no new analysis.
	function onConfig(key) {
		if (closed || key !== SETTING) return;
		if (!enabled()) {
			const keys = new Set();
			for (const job of FULL_QUEUE) if (job.owner === self) keys.add(job.key);
			for (const job of IN_FLIGHT.values()) if (job.owner === self) keys.add(job.key);
			for (const k of keys) cancelKey(k);
		}
		emit('*');
	}

	function shutdown() {
		if (closed) return;
		closed = true;
		listeners.clear();
		try {
			unsubscribeConfig();
		} catch (_) { /* already gone */ }
		for (let i = FULL_QUEUE.length - 1; i >= 0; i--) {
			const job = FULL_QUEUE[i];
			if (job.owner === self) {
				FULL_QUEUE.splice(i, 1);
				job.settle({ ok: false, code: 'shutdown' });
			}
		}
		if (workerRef) {
			try {
				workerRef.shutdown();
			} catch (_) { /* nothing running */ }
		}
	}

	/** Test seam: resolves once every background check, load and job of this instance has settled. */
	async function idle() {
		while (pending.size) await Promise.allSettled([...pending]);
	}

	if (picsDir) {
		const source = deps.configStore !== undefined ? deps.configStore : (deps.cfg === undefined ? 'production' : null);
		try {
			const mod = source === 'production' ? require('./configStore.js') : source;
			if (mod && typeof mod.onChange === 'function') {
				const off = mod.onChange(onConfig);
				if (typeof off === 'function') unsubscribeConfig = off;
			}
		} catch (_) { /* no live config: the setting is still read at call time */ }
	}

	return { forText, ensure, status, describe, command, onChange, shutdown, _idle: idle };
}

module.exports = {
	createBookPictures,
	between,
	pdfOf,
	picturesKey,
	statusLine,
	PICTURES_VERSION,
	ALIGN_VERSION,
	MAX_PAGE_PICTURES,
	MAX_PICTURE_BYTES,
	MAX_MESSAGE_BYTES,
	MAX_DIR_BYTES,
	REVALIDATE_MS,
	STRIKE_RETRY_MS,
	CALIBRE_RETRY_MS,
	TOOLS_RETRY_MS,
	FAIL_RECORD_MAX_AGE_MS
};
