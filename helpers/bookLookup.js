// helpers/bookLookup.js
//
// The optional online lookup for audiobook metadata: Audible's public catalog search, asked once
// per book for the series, the position in it, the narrators and the proper spelling of the title.
//
// Off unless the owner turns on `audiobookOnlineLookup`. The endpoint is the unofficial one the
// Audible mobile app, Audiobookshelf and the Plex Audnexus agent use: no account and no key, but no
// published terms or limits either. So the lookup is polite on purpose: only the cleaned title and
// the author name leave the machine (never a path, a Plex or Discord id, a work id or the
// narrator), one request at a time at least a second apart, a 10 s timeout, Retry-After honoured
// once, and every answer cached for months.
//
// This module only PROPOSES. It never writes a catalog field and never decides which source wins:
// the metadata layer does that, and today it lets online data fill only blanks (plus a title fix
// that changes nothing but case and punctuation). compare() labels each proposed field so that
// layer can apply exactly that rule. Online data must never reach a work id, a folder key, the
// grouping or the part order, so ids, bookmarks, read-along links and sync marks stay put.
//
// Matching is edition first, book second. A local recording's total runtime picks its Audible
// edition almost to the minute when that edition is on the store; a GraphicAudio dramatisation or
// a narration Audible does not sell has no edition there, and then only what every candidate agrees
// on (series and position) is trusted, never a narrator or publisher.

const crypto = require('crypto');
const path = require('path');
const { createStore } = require('./jsonStore.js');
const logger = require('./logger.js');
const catalog = require('./bookCatalog.js');
const { version } = require('../package.json');

const DAY = 24 * 60 * 60 * 1000;
const TTL = Object.freeze({ edition: 180 * DAY, book: 180 * DAY, none: 30 * DAY, error: DAY });
const ERROR_BACKOFF_MS = DAY;

const REGIONS = Object.freeze({
	us: { tld: 'com', language: 'english' },
	ca: { tld: 'ca', language: 'english' },
	uk: { tld: 'co.uk', language: 'english' },
	au: { tld: 'com.au', language: 'english' },
	fr: { tld: 'fr', language: 'french' },
	de: { tld: 'de', language: 'german' },
	jp: { tld: 'co.jp', language: 'japanese' },
	it: { tld: 'it', language: 'italian' },
	in: { tld: 'in', language: 'english' },
	es: { tld: 'es', language: 'spanish' },
});
const DEFAULT_REGION = 'us';

const RESPONSE_GROUPS = 'contributors,product_attrs,product_desc,product_extended_attrs,series';
const USER_AGENT = `Plex-Discord-Bot-BookCatalog/${version}`;
const TIMEOUT_MS = 10000;
const REQUEST_GAP_MS = 1000;
const RETRY_AFTER_CAP_MS = 60 * 1000;
const RETRY_AFTER_DEFAULT_MS = 5000;
const MAX_FAILURES = 3;
// Real answers are under 30 KB; anything far larger is not the catalog answering.
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const MAX_DISTINCT_WORKS = 3;
const FUZZY_MIN_CHARS = 12;
const FUZZY_MIN_RATIO = 0.92;
const MAX_NARRATORS_SHOWN = 3;
const FULL_CAST = 'full cast';

const DELIVERY_TYPES = new Set(['SinglePartBook', 'MultiPartBook']);
const CORP_SUFFIX_RE = /[\s,.]*\b(?:llc|inc|ltd|limited|co|corp|plc|gmbh)\b\.?\s*$/i;
const TRANSLATOR_RE = /-\s*translator\s*$/i;
const GENERIC_NARRATOR_RE = /^(?:various(?: artists| narrators)?|full cast|cast|unknown|multiple narrators|narrators?)$/i;
const ELLIPSIS = String.fromCharCode(0x2026);
const LOCKED_FIELDS = ['title', 'series', 'narrator'];

const lookupStore = createStore({
	envVar: 'PLEXBOT_BOOK_LOOKUP_FILE',
	defaultPath: path.join(__dirname, '..', 'data', 'book_lookup.json'),
	key: 'works',
	shape: 'object',
	label: 'online lookup',
	feature: 'Audiobook',
	// Keyed by work ids built from folder names.
	nullPrototype: true
});

const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const copy = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

// --- normalisation ----------------------------------------------------------------------------

function fold(text) {
	return String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Lower-case words: accents folded, `&` read as "and", apostrophes deleted, other punctuation a space. */
function words(text) {
	return fold(text)
		.replace(/['\p{Pi}\p{Pf}]/gu, '')
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function stripBrackets(text) {
	return String(text || '').replace(/\s*[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Series: Title", "Series 2: Title", "Series - Title", "Series 2 - Title", "Series #2: Title".
const SERIES_PREFIX_RE = /^(.+?)(?:,?\s+(?:book\s+)?#?\d+(?:\.\d+)?)?\s*(?::|\s\p{Pd}\s)\s*(.+)$/iu;

function stripSeriesPrefix(title, seriesNames) {
	const names = (seriesNames || []).filter((s) => !blank(s)).map(words);
	if (!names.length) return title;
	const m = String(title || '').match(SERIES_PREFIX_RE);
	if (!m || !words(m[2])) return title;
	return names.includes(words(m[1])) ? m[2] : title;
}

/**
 * The comparison form of a title: edition markers in brackets dropped, a leading series name
 * dropped when it is one of `seriesNames`, punctuation and a leading "the" dropped.
 */
function normTitle(title, seriesNames = []) {
	return words(stripSeriesPrefix(stripBrackets(title), seriesNames)).replace(/^the /, '');
}

/** Letters only, so "T.H. White" and "T. H. White" agree. A translator credit is no author. */
function normAuthor(name) {
	if (TRANSLATOR_RE.test(String(name || ''))) return '';
	return fold(name).replace(/[^\p{L}]+/gu, '');
}

// Commas are not split: "Tyler, The Creator" is one name.
function localAuthors(author) {
	return String(author || '').split(/\s*(?:&|;|\band\b)\s*/i).map(normAuthor).filter(Boolean);
}

/** Case, accents, spacing and punctuation ignored; nothing else. Decides a case-only title fix. */
function caseKey(text) {
	return fold(text).replace(/['\p{Pi}\p{Pf}]/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(a, b) {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
}

function similarity(a, b) {
	const len = Math.max(a.length, b.length);
	return len ? 1 - levenshtein(a, b) / len : 1;
}

function pubKey(text) {
	return fold(String(text || '').trim().replace(CORP_SUFFIX_RE, '')).replace(/[^\p{L}\p{N}]+/gu, '');
}

// bookCatalog.publisherOf knows every audiobook house the catalog recognises; until a catalog
// without it is gone, GraphicAudio (the one house that turns up as an artist here) is the fallback.
function publisherName(text) {
	if (typeof catalog.publisherOf === 'function') return catalog.publisherOf(text) || null;
	return /^gr(?:aph|ahp)ic\s*audio$/i.test(String(text || '').trim().replace(CORP_SUFFIX_RE, '').trim()) ? 'GraphicAudio' : null;
}

function samePublisher(a, b) {
	if (blank(a) || blank(b)) return false;
	const pa = publisherName(a);
	if (pa && pa === publisherName(b)) return true;
	return !!pubKey(a) && pubKey(a) === pubKey(b);
}

function truncatedList(text) {
	const t = String(text || '').trim();
	return t.endsWith('...') || t.endsWith(ELLIPSIS);
}

function lastName(name) {
	const parts = words(name).split(' ').filter(Boolean);
	return parts.length ? parts[parts.length - 1] : '';
}

/** Surnames in a local narrator field. A cast list cut short with "..." names no single narrator. */
function narratorSurnames(narrator) {
	if (blank(narrator) || truncatedList(narrator)) return [];
	return String(narrator)
		.split(/\s*(?:,|&|;|\band\b)\s*/i)
		.map((s) => s.trim())
		.filter((s) => s && !GENERIC_NARRATOR_RE.test(s))
		.map(lastName)
		.filter(Boolean);
}

// --- reading a product ------------------------------------------------------------------------

const names = (list) => (Array.isArray(list) ? list : [])
	.map((p) => (p && typeof p.name === 'string' ? p.name.trim() : ''))
	.filter(Boolean);

function displayTitle(title) {
	return stripBrackets(title);
}

/**
 * The series a product belongs to: the entry named like its publication_name, else the only entry
 * that has a position. A universe entry ("The Cosmere") carries no position and is skipped.
 * @returns {{ name: string, position: string|null } | null}
 */
function seriesOf(product) {
	const list = (Array.isArray(product && product.series) ? product.series : [])
		.filter((s) => s && typeof s.title === 'string' && s.title.trim());
	const position = (s) => (blank(s.sequence) ? null : String(s.sequence).trim());
	const pub = words(product && product.publication_name);
	const named = pub ? list.find((s) => words(s.title) === pub) : null;
	if (named) return { name: named.title.trim(), position: position(named) };
	const numbered = list.filter((s) => position(s) !== null);
	return numbered.length === 1 ? { name: numbered[0].title.trim(), position: position(numbered[0]) } : null;
}

/** A position like "2" or "0.5" is a number; "1-5" is an omnibus and shows no number. */
function positionInfo(position) {
	if (blank(position)) return { position: null, sequence: null, omnibus: false };
	const p = String(position).trim();
	const sequence = /^\d+(?:\.\d+)?$/.test(p) ? Number(p) : null;
	return { position: p, sequence, omnibus: sequence === null };
}

function narratorText(list) {
	if (!list.length) return null;
	return list.length > MAX_NARRATORS_SHOWN ? FULL_CAST : list.join(', ');
}

function narratorKey(product) {
	return names(product.narrators).map(words).sort().join('|');
}

function bookFields(product) {
	const s = seriesOf(product);
	const pos = positionInfo(s ? s.position : null);
	return {
		title: displayTitle(product.title) || null,
		series: s ? s.name : null,
		position: pos.position,
		sequence: pos.sequence,
		omnibus: pos.omnibus,
	};
}

function editionFields(product) {
	const narrators = names(product.narrators);
	const runtime = Number(product.runtime_length_min);
	const house = String(product.publisher_name || '').trim();
	return Object.assign(bookFields(product), {
		narrators,
		narrator: narratorText(narrators),
		publisher: house ? (publisherName(house) || house.replace(CORP_SUFFIX_RE, '').trim()) : null,
		runtimeMin: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
	});
}

// --- matching ---------------------------------------------------------------------------------

function todayOf(now) {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Why a product cannot be this work, or null when it can.
 * @param {object} product an Audible catalog product
 * @param {object} local { title, author, series }
 * @param {{ language: string, today: string }} ctx
 */
function rejectReason(product, local, ctx) {
	if (!isObject(product)) return 'shape';
	if (String(product.language || '').toLowerCase() !== ctx.language) return 'language';
	if (String(product.format_type || '').toLowerCase() === 'abridged') return 'abridged';
	if (!DELIVERY_TYPES.has(product.content_delivery_type)) return 'delivery';
	if (!blank(product.release_date) && String(product.release_date).slice(0, 10) > ctx.today) return 'unreleased';
	const wanted = localAuthors(local.author);
	const theirs = names(product.authors).map(normAuthor).filter(Boolean);
	if (!wanted.some((a) => theirs.includes(a))) return 'author';

	const rawTitle = String(product.title || '');
	const localRaw = String(local.title || '');
	// "Hyperion & Endymion 4" is a slice of a bigger product, not the book.
	if (/\s&\s/.test(rawTitle) && !/\s&\s/.test(localRaw)) return 'part-split';
	const seriesNames = [local.series, ...((product.series || []).map((s) => s && s.title))];
	const mine = normTitle(localRaw, seriesNames);
	const theirsTitle = normTitle(rawTitle, seriesNames);
	if (/\s\d+$/.test(theirsTitle) && !/\s\d+$/.test(mine)) return 'part-split';
	if (!mine || !theirsTitle) return 'title';
	if (mine === theirsTitle) return null;
	if (mine.length > FUZZY_MIN_CHARS && similarity(mine, theirsTitle) >= FUZZY_MIN_RATIO) return null;
	return 'title';
}

/**
 * Pick the Audible product that is this recording (an edition match), else the book every
 * candidate agrees on (a book match), else nothing.
 * @param {object} local { title, author, series, narrator, publisher, totalMs }
 * @param {object[]} products the `products` of a catalog search
 * @param {{ region?: string, now?: number }} [opts]
 * @returns {{ outcome: 'edition'|'book'|'none', reason: string, asin: string|null, fields: object|null, candidates: number }}
 */
function matchProducts(local, products, opts = {}) {
	const region = REGIONS[opts.region] ? opts.region : DEFAULT_REGION;
	const ctx = { language: REGIONS[region].language, today: todayOf(opts.now === undefined ? Date.now() : opts.now) };
	const none = (reason, candidates = 0) => ({ outcome: 'none', reason, asin: null, fields: null, candidates });
	const list = Array.isArray(products) ? products : [];
	if (!list.length) return none('no-results');

	const candidates = list.filter((p) => rejectReason(p, local, ctx) === null);
	if (!candidates.length) return none('no-candidates');
	const seriesNames = [local.series];
	const distinct = new Set(candidates.map((p) => normTitle(p.title, seriesNames)));
	if (distinct.size > MAX_DISTINCT_WORKS) return none('too-many-works', candidates.length);

	const localMin = Number(local.totalMs) / 60000;
	const surnames = narratorSurnames(local.narrator);
	const passing = [];
	if (Number.isFinite(localMin) && localMin > 0) {
		for (const p of candidates) {
			const runtime = Number(p.runtime_length_min);
			if (!Number.isFinite(runtime) || runtime <= 0) continue;
			const diff = Math.abs(runtime - localMin);
			const narratorHit = surnames.length > 0 && names(p.narrators).some((n) => surnames.includes(lastName(n)));
			const publisherHit = samePublisher(local.publisher, p.publisher_name);
			const tight = Math.max(0.03 * localMin, 10);
			const limit = narratorHit || publisherHit ? Math.max(tight, 0.10 * localMin) : tight;
			if (diff <= limit) {
				const why = diff <= tight ? 'runtime' : (narratorHit ? 'runtime+narrator' : 'runtime+publisher');
				passing.push({ p, runtime, diff, why });
			}
		}
	}
	passing.sort((a, b) => a.diff - b.diff);

	let downgraded = false;
	if (passing.length) {
		const [best, next] = passing;
		const close = next && Math.abs(best.runtime - next.runtime) <= 0.01 * Math.max(best.runtime, next.runtime);
		if (close && narratorKey(best.p) !== narratorKey(next.p)) {
			downgraded = true;
		} else {
			return { outcome: 'edition', reason: best.why, asin: best.p.asin || null, fields: editionFields(best.p), candidates: candidates.length };
		}
	}

	const key = (p) => {
		const s = seriesOf(p);
		return s ? `${normTitle(s.name)}#${s.position || ''}` : '';
	};
	const first = key(candidates[0]);
	if (!candidates.every((p) => key(p) === first)) return none('disagree', candidates.length);
	return {
		outcome: 'book',
		reason: downgraded ? 'close-editions' : 'series-agree',
		asin: null,
		fields: bookFields(candidates[0]),
		candidates: candidates.length,
	};
}

// --- proposals --------------------------------------------------------------------------------

function kindOf(localValue, onlineValue, equivalent) {
	if (blank(onlineValue)) return 'none';
	if (blank(localValue)) return 'fill';
	if (String(localValue) === String(onlineValue)) return 'same';
	return equivalent(localValue, onlineValue) || 'differs';
}

/**
 * Label each field a cache entry proposes against the work's current values, without applying any.
 *   none        the entry has nothing for this field (a book match never has a narrator)
 *   fill        the local value is blank
 *   same        identical
 *   case-fix    the title differs only in case, accents, spacing or punctuation
 *   equivalent  the same thing spelled differently ("The Murderbot Diaries" / "Murderbot Diaries")
 *   differs     a real disagreement ("0.5" from the folder against "2.5" online)
 * The metadata layer applies `fill` and `case-fix` only. `narrator.fullCast` marks Audible's
 * "full cast" (more than three names), which is no single narrator.
 * @param {object} entry a cache entry from get()
 * @param {object} local { title, series, sequence, narrator, publisher }
 */
function compare(entry, local = {}) {
	const f = (entry && entry.fields) || {};
	const field = (kind, value, localValue) => ({ kind, value: value === undefined ? null : value, local: blank(localValue) ? null : localValue });

	const titleKind = kindOf(local.title, f.title, (a, b) => {
		if (caseKey(a) === caseKey(b)) return 'case-fix';
		return normTitle(a) === normTitle(b) ? 'equivalent' : null;
	});
	const seriesKind = kindOf(local.series, f.series, (a, b) => (normTitle(a) === normTitle(b) ? 'equivalent' : null));

	let sequenceKind;
	if (f.sequence === null || f.sequence === undefined) sequenceKind = 'none';
	else if (blank(local.sequence)) {
		// A number only means something next to its own series.
		sequenceKind = blank(local.series) || normTitle(local.series) === normTitle(f.series) ? 'fill' : 'differs';
	} else sequenceKind = Number(local.sequence) === Number(f.sequence) ? 'same' : 'differs';

	const narratorKind = kindOf(local.narrator, f.narrator, (a, b) => {
		if (caseKey(a) === caseKey(b)) return 'equivalent';
		// "Various" or a cut-short cast list against Audible's full cast says the same thing.
		if (b === FULL_CAST && (GENERIC_NARRATOR_RE.test(String(a).trim()) || truncatedList(a))) return 'equivalent';
		// A folder that names the narrator by surname ("Bevine") against "Victor Bevine".
		const mine = narratorSurnames(a);
		const theirs = (f.narrators || []).map(lastName);
		return mine.length && mine.every((s) => theirs.includes(s)) ? 'equivalent' : null;
	});
	const publisherKind = kindOf(local.publisher, f.publisher, (a, b) => (samePublisher(a, b) ? 'equivalent' : null));

	return {
		title: field(titleKind, f.title, local.title),
		series: field(seriesKind, f.series, local.series),
		sequence: Object.assign(field(sequenceKind, f.sequence, local.sequence), { position: f.position || null, omnibus: !!f.omnibus }),
		narrator: Object.assign(field(narratorKind, f.narrator, local.narrator), { fullCast: f.narrator === FULL_CAST }),
		publisher: field(publisherKind, f.publisher, local.publisher),
	};
}

// --- eligibility and requests -----------------------------------------------------------------

/**
 * Whether a work may be looked up at all. Checked before any request, with the reason kept for
 * the rescan reply.
 * @param {object} work a catalog work
 * @param {object|null} [override] its book_overrides.json `works` entry, if any
 */
function eligibility(work, override = null) {
	if (!work || work.kind !== 'book') return { ok: false, reason: 'not-a-book' };
	if (catalog.openDoubts(work, override).length) return { ok: false, reason: 'doubtful' };
	if (blank(work.author)) return { ok: false, reason: 'no-author' };
	if (publisherName(work.author)) return { ok: false, reason: 'publisher-author' };
	if (blank(work.title)) return { ok: false, reason: 'no-title' };
	if (isObject(override) && override.exclude === true) return { ok: false, reason: 'excluded' };
	if (isObject(override) && LOCKED_FIELDS.every((k) => has(override, k))) return { ok: false, reason: 'locked' };
	return { ok: true, reason: null };
}

function regionOf(value) {
	const r = String(value || '').toLowerCase();
	return REGIONS[r] ? r : DEFAULT_REGION;
}

/** Changes when the region, the title's words or the author changes, which forces a fresh lookup. */
function queryKey(work, region = DEFAULT_REGION) {
	const text = `${regionOf(region)}|${normTitle(work && work.title)}|${localAuthors(work && work.author).join(',')}`;
	return crypto.createHash('sha1').update(text).digest('hex');
}

function queryOf(work) {
	const title = stripSeriesPrefix(stripBrackets(work.title), [work.series]).trim();
	// "T.H. White" finds fewer results than the store's own "T. H. White".
	const author = String(work.author || '').trim().replace(/\b([A-Z])\.(?=[A-Z])/g, '$1. ');
	return { title, author };
}

function buildUrl(region, title, author) {
	const { tld } = REGIONS[regionOf(region)];
	return `https://api.audible.${tld}/1.0/catalog/products` +
		`?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}` +
		`&num_results=10&products_sort_by=Relevance&response_groups=${RESPONSE_GROUPS}`;
}

/** Retry-After in ms: seconds or an HTTP date, capped at a minute. */
function retryAfterMs(header, now = Date.now()) {
	const text = String(header || '').trim();
	let ms = RETRY_AFTER_DEFAULT_MS;
	if (/^\d+$/.test(text)) ms = Number(text) * 1000;
	else if (text && Number.isFinite(Date.parse(text))) ms = Math.max(0, Date.parse(text) - now);
	return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Whether a cached entry needs asking again for this query. */
function due(entry, key, now = Date.now()) {
	if (!isObject(entry) || entry.queryKey !== key) return true;
	if (Number.isFinite(entry.failedAt) && now - entry.failedAt < ERROR_BACKOFF_MS) return false;
	const ttl = TTL[entry.outcome];
	if (!ttl || !Number.isFinite(entry.fetchedAt)) return true;
	return now - entry.fetchedAt >= ttl;
}

function idsOf(work) {
	if (!work || typeof work.id !== 'string' || !work.id) return [];
	const aliases = Array.isArray(work.aliases) ? work.aliases.filter((a) => typeof a === 'string' && a) : [];
	return [work.id, ...aliases];
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [deps] every outside effect, so tests inject all of them
 * @param {Function} [deps.fetch]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => object} [deps.getConfig] read on every call, never at require time
 * @param {object} [deps.store] a jsonStore-shaped store
 * @param {object} [deps.log]
 * @param {(work: object) => object|null} [deps.overrideOf] a work's book_overrides.json entry
 */
function createLookup(deps = {}) {
	const {
		fetch: fetchFn = (...args) => globalThis.fetch(...args),
		now = Date.now,
		sleep = defaultSleep,
		getConfig = () => require('../config/config.js'),
		store = lookupStore,
		log = logger,
		overrideOf = () => null,
		timeoutMs = TIMEOUT_MS,
		gapMs = REQUEST_GAP_MS,
	} = deps;

	let running = null;
	let lastRequestAt = -Infinity;

	const settings = () => {
		const cfg = getConfig() || {};
		return { enabled: cfg.audiobookOnlineLookup === true, region: regionOf(cfg.audiobookLookupRegion) };
	};

	function find(work) {
		const all = store.load();
		for (const id of idsOf(work)) {
			if (has(all, id) && isObject(all[id])) return { id, value: all[id] };
		}
		return null;
	}

	/**
	 * The cached answer for a work as it is now, or null when the lookup is off, nothing is cached,
	 * or the entry was made for a different title, author or region. An entry found under an old
	 * id is copied to the current one.
	 */
	function get(work) {
		const { enabled, region } = settings();
		if (!enabled) return null;
		const hit = find(work);
		if (!hit || hit.value.queryKey !== queryKey(work, region)) return null;
		if (hit.id !== work.id) {
			store.load()[work.id] = copy(hit.value);
			store.persist();
		}
		return copy(hit.value);
	}

	/** get() without the setting check or the alias copy, for reports. */
	function peek(work) {
		const hit = find(work);
		return hit ? copy(hit.value) : null;
	}

	async function pace(minMs) {
		const wait = lastRequestAt + minMs - now();
		if (wait > 0) await sleep(wait);
	}

	async function request(url) {
		for (let attempt = 0; attempt < 2; attempt++) {
			let res;
			try {
				res = await fetchFn(url, {
					method: 'GET',
					headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
					redirect: 'error',
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				const name = err && err.name;
				return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
			} finally {
				lastRequestAt = now();
			}
			if (res.status === 429 || res.status === 503) {
				if (attempt > 0) break;
				const headers = res.headers && typeof res.headers.get === 'function' ? res.headers : { get: () => null };
				const wait = retryAfterMs(headers.get('retry-after'), now());
				await pace(Math.max(wait, gapMs));
				continue;
			}
			if (res.status !== 200) return { error: `http-${res.status}` };
			let text;
			try {
				text = await res.text();
			} catch (err) {
				return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
			}
			if (text.length > MAX_BODY_CHARS) return { error: 'too-large' };
			let body;
			try {
				body = JSON.parse(text);
			} catch (_) {
				return { error: 'bad-json' };
			}
			if (!isObject(body) || !Array.isArray(body.products)) return { error: 'bad-shape' };
			return { products: body.products };
		}
		return { error: 'rate-limited' };
	}

	async function lookupOne(work, region) {
		const query = queryOf(work);
		await pace(gapMs);
		const answer = await request(buildUrl(region, query.title, query.author));
		if (answer.error) {
			log.warn(`Online book lookup for "${query.title}" by ${query.author} failed (${answer.error}); keeping local details.`);
			return { outcome: 'error', reason: answer.error, asin: null, fields: null };
		}
		const local = {
			title: work.title, author: work.author, series: work.series, narrator: work.narrator,
			publisher: work.publisher, totalMs: work.totalMs,
		};
		return matchProducts(local, answer.products, { region, now: now() });
	}

	const comparable = (e) => (isObject(e) ? JSON.stringify([e.queryKey, e.outcome, e.asin || null, e.fields || null]) : '');

	async function run(works, opts) {
		const { enabled, region } = settings();
		const counts = { edition: 0, book: 0, none: 0, error: 0, skipped: 0, cached: 0, deferred: 0 };
		const summary = { enabled, region, counts, changed: [], results: {}, stopped: false };
		const list = (Array.isArray(works) ? works : []).filter((w) => w && typeof w.id === 'string' && w.id);
		const force = opts.force === true;
		const overrideFor = typeof opts.overrideOf === 'function' ? opts.overrideOf : overrideOf;

		if (!enabled) {
			for (const w of list) {
				counts.skipped++;
				summary.results[w.id] = { outcome: 'skipped', reason: 'off' };
			}
			return summary;
		}

		const queue = [];
		for (const w of list) {
			const ok = eligibility(w, overrideFor(w));
			if (!ok.ok) {
				counts.skipped++;
				summary.results[w.id] = { outcome: 'skipped', reason: ok.reason };
				continue;
			}
			const key = queryKey(w, region);
			const hit = find(w);
			if (!force && hit && !due(hit.value, key, now())) {
				counts.cached++;
				summary.results[w.id] = { outcome: hit.value.outcome, reason: 'cached' };
				continue;
			}
			queue.push({ w, key, previous: hit ? hit.value : null });
		}

		let failures = 0;
		for (let i = 0; i < queue.length; i++) {
			const { w, key, previous } = queue[i];
			if (failures >= MAX_FAILURES) {
				for (const rest of queue.slice(i)) {
					counts.deferred++;
					summary.results[rest.w.id] = { outcome: 'deferred', reason: 'stopped' };
				}
				summary.stopped = true;
				log.warn(`Online book lookups stopped after ${MAX_FAILURES} failures in a row; ${queue.length - i} left for the next rescan.`);
				break;
			}
			const result = await lookupOne(w, region);
			const at = now();
			const tagAsin = w.asin || (w.detected && w.detected.asin) || null;
			let entry;
			if (result.outcome === 'error') {
				failures++;
				// A good answer for the same query is worth more than a fresh error.
				if (isObject(previous) && previous.queryKey === key && (previous.outcome === 'edition' || previous.outcome === 'book')) {
					entry = Object.assign(copy(previous), { failedAt: at, lastError: result.reason });
				} else {
					entry = { queryKey: key, region, fetchedAt: at, outcome: 'error', reason: result.reason, asin: null, fields: null };
				}
			} else {
				failures = 0;
				entry = { queryKey: key, region, fetchedAt: at, outcome: result.outcome, reason: result.reason, asin: result.asin, fields: result.fields };
			}
			if (tagAsin) entry.tagAsin = String(tagAsin);
			counts[result.outcome]++;
			summary.results[w.id] = { outcome: result.outcome, reason: result.reason };
			const before = find(w);
			if (comparable(before && before.value) !== comparable(entry) || (before && before.id !== w.id)) summary.changed.push(w.id);
			store.load()[w.id] = entry;
			store.persist();
		}
		return summary;
	}

	/**
	 * Look up every eligible work whose entry is missing, stale or made for another query. One
	 * batch at a time: a call while one runs gets that batch's promise. Never rejects.
	 * @param {object[]} works catalog works
	 * @param {{ force?: boolean, overrideOf?: Function }} [opts] force asks again even when the cache
	 *   is fresh; overrideOf gives a work's book_overrides.json entry for this batch, in place of the
	 *   one the lookup was made with
	 */
	function refresh(works, opts = {}) {
		if (running) return running;
		running = run(works, opts)
			.catch((err) => {
				log.warn(`Online book lookups stopped: ${err && err.message}`);
				return { enabled: true, region: null, counts: {}, changed: [], results: {}, stopped: true };
			})
			.finally(() => { running = null; });
		return running;
	}

	return { refresh, get, peek, settings, isRunning: () => !!running };
}

let shared = null;
/** The bot's one lookup, built on first use so nothing reads config or the network at require time. */
function instance() {
	if (!shared) shared = createLookup();
	return shared;
}

module.exports = {
	REGIONS,
	TTL,
	USER_AGENT,
	createLookup,
	instance,
	matchProducts,
	rejectReason,
	compare,
	eligibility,
	queryKey,
	buildUrl,
	retryAfterMs,
	due,
	seriesOf,
	positionInfo,
	narratorSurnames,
	normTitle,
	normAuthor,
	caseKey,
	similarity,
	store: lookupStore,
};
