// helpers/bookCatalog.js
//
// Turns a Plex music library listing into the long-form catalog: which tracks are parts of an
// audiobook or podcast, which work each belongs to, and in what order they play.
//
// Plex albums are not books on a hand-ripped library. Several books can share one album title, one
// album can hold the second half of one book and the whole of another, a single book can be spread
// over several albums under several artist spellings, and numbered volumes can be poured into one
// flat folder. What does line up is the folder on disk, so works are built from folders first and
// Plex albums second. Membership is never decided by track length: books with short chapter files
// would leak into music, and long music mixes would be taken for books.
//
// Pure (no fs, no Plex, no discord.js), so a rule change is tested against fixtures in
// milliseconds. Embedded tags are read elsewhere (helpers/bookTags.js) and handed in as data.
// RULES_VERSION goes up whenever a change here would build a different catalog from the same
// listing, so a stored catalog built under older rules is rebuilt. Version 3 added the disc-folder
// guard, genre classing, the music split, tag metadata and the duration-weighted alias share.
// Version 4 splits a folder of loose single-file books by each file's own tags, never takes
// "Various Artists" for an author, drops edition markers from titles and hands a split work's id
// to the book that held its first part.

const RULES_VERSION = 4;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const DETECT = Object.freeze({
	minTotalMs: 2 * HOUR,
	medianLongMs: 15 * MIN,
	signalTotalMs: 3 * HOUR,
	monoMinTracks: 20,
	podcastMedianMs: 20 * MIN,
});

// Audiobook houses that turn up in the artist or album-artist field. A publisher is never the
// author: the author then comes from the bracket ("GraphicAudio [Brandon Sanderson]"), the
// "Written by" comment, the copyright line or the author folder.
const PUBLISHERS = [
	['GraphicAudio', /^gr(?:aph|ahp)ic\s*audio$/],
	['Audible Studios', /^audible(?:\s*(?:studios?|originals?|audio))?$/],
	['Brilliance Audio', /^brilliance\s*(?:audio|publishing)$/],
	['Recorded Books', /^recorded\s*books$/],
	['Tantor Media', /^tantor\s*(?:audio|media)$/],
	['Blackstone Audio', /^blackstone\s*(?:audio|publishing)$/],
	['Penguin Random House Audio', /^(?:penguin\s*)?random\s*house\s*audio(?:\s*publishing)?$|^penguin\s*audio$/],
	['HarperAudio', /^harper\s*audio$/],
	['Macmillan Audio', /^macmillan\s*audio$/],
	['Podium Audio', /^podium\s*(?:audio|publishing)$/],
	['Hachette Audio', /^hachette\s*audio$/],
	['Simon & Schuster Audio', /^simon\s*(?:&|and)?\s*schuster\s*audio$/],
	['BBC Audio', /^bbc\s*(?:audio(?:books)?|radio(?:\s*\d)?|worldwide)$/],
	['Naxos AudioBooks', /^naxos\s*audio\s*books$/],
	['Dreamscape Media', /^dreamscape\s*media$/],
	['HighBridge Audio', /^high\s*bridge(?:\s*audio)?$/],
	['Listening Library', /^listening\s*library$/],
	['Bolinda Audio', /^bolinda(?:\s*(?:audio|publishing))?$/],
	['W. F. Howes', /^w\.?\s*f\.?\s*howes$/],
	['Big Finish', /^big\s*finish(?:\s*productions)?$/],
];
const CORP_SUFFIX_RE = /[\s,.]*\b(?:llc|inc|ltd|limited|co|corp|plc|gmbh)\b\.?\s*$/i;
const CORP_WORD_RE = /\b(?:llc|inc|ltd|entertainment|publishing|publishers?|press|media|audio|books|studios?|productions?|company|corp(?:oration)?|group|records|music|rights|reserved|licensed|arrangement)\b/i;
// The publisher test of rules version 2. Ids depend on it (the collision suffix falls back to the
// publisher), so the wider publisherOf() must not reach the id.
const LEGACY_PUBLISHER_RE = /^(graphic\s*audio|grahpic\s*audio)(,?\s*llc)?$/i;

// Placeholders Plex and taggers put in an artist field when a file names nobody in particular.
const VARIOUS_RE = /^(?:various(?:\s+artists?)?|v\.?\s?a\.?|unknown(?:\s+artist)?|\[unknown(?:\s+artist)?\])$/i;

function isVarious(name) {
	return VARIOUS_RE.test(String(name || '').trim());
}

/** The canonical house name when the text names an audiobook publisher, else null. */
function publisherOf(text) {
	const s = String(text || '').trim().replace(CORP_SUFFIX_RE, '').trim().toLowerCase();
	if (!s) return null;
	const hit = PUBLISHERS.find(([, re]) => re.test(s));
	return hit ? hit[0] : null;
}

// Genres say what an album is far more reliably than track lengths do, but only when they are
// present (about one album in ten carries none). An audiobook genre wins over a music one in the
// same tag ("Audiobook - Sci Fi"); "Fantasy", "Comedy" and "Spoken Word" stay neutral.
const BOOK_GENRE_RE = /audio\s*-?\s*books?|\babooks?\b|\bpodcasts?\b|audio\s*drama|radio\s*(?:play|drama|theat(?:er|re))|full[- ]cast|\bnarrat/i;
// A music genre is matched on whole segments ("Pop/Rock", "Hard Rock; Heavy Metal"), ending in a
// music word with only music words or style modifiers before it. A loose word match vetoed books
// filed under "Space Opera", "Fairy Tales, Folk Tales & Myths" or "Haunted House".
const MUSIC_WORDS = String.raw`rock|pop|metal|hip[- ]?hop|trip[- ]?hop|hip|hop|rap|jazz|blues|punk|folk|country|electro\w*|electronic|techno|house|trance|dubstep|edm|drum\s*(?:&|and|n)\s*bass|ambient|classical|soundtrack|score|r&b|rhythm\s*(?:and|&)\s*blues|rock\s*(?:and|&|'?n'?)\s*roll|soul|funk|reggae|reggaeton|ska|disco|indie|grunge|emo|hardcore|post-hardcore|trap|lo-?fi|synth\w*|new\s*wave|post-punk|j-?pop|k-?pop|j-?rock|anisong|denpa|singer-songwriter|gospel|latin|salsa|cumbia|bachata|banda|ranchera|mariachi|corridos?|dance|club|orchestral|opera|chill\w*|beats|instrumental|horrorcore|neo\s*soul|britpop|shoegaze|vaporwave|bluegrass|americana|swing|bossa\s*nova|psychedelic|alternative|acoustic|a\s*cappella|choral|chiptune|video\s*game\s*music|ost`;
const MUSIC_MODIFIERS = String.raw`acid|alt|art|avant[- ]garde|band|baroque|beat|big|black|celtic|chamber|christian|classic|comedy|contemporary|dark|death|deep|doom|experimental|film|french|funky|future|game|garage|german|glam|gothic|hard|heavy|industrial|irish|italo|japanese|jump|korean|melodic|modern|neo|noise|nordic|nu|post|power|progressive|roots|sludge|smooth|soft|southern|stoner|surf|swamp|tech|thrash|traditional|uk|underground|urban|us|vocal|western|world`;
const MUSIC_SEGMENT_RE = new RegExp(String.raw`^(?:(?:${MUSIC_WORDS}|${MUSIC_MODIFIERS})(?:\s*[-&+]\s*|\s+and\s+|\s+))*(?:${MUSIC_WORDS})(?:\s+music)?$`, 'i');

function isMusicGenre(genre) {
	return genre.split(/\s*(?:[/;,|>]|\s-\s)\s*/).some((seg) => MUSIC_SEGMENT_RE.test(seg.trim()));
}

/** @returns {'book'|'music'|null} */
function genreClass(genres) {
	const list = (genres || []).map((g) => String(g || '')).filter(Boolean);
	if (list.some((g) => BOOK_GENRE_RE.test(g))) return 'book';
	if (list.some(isMusicGenre)) return 'music';
	return null;
}

// Folder names that hold a library rather than name a book. A disc or part name ends in a number,
// one letter or a roman numeral, so "Partials", "Volition" and "Discworld" stay titles.
const GENERIC_NAME_RE = /^(?:music|media|audio|audio\s*books?|books?|e-?books?|podcasts?|spoken(?:\s*word)?|library|downloads?|torrents?|music-uploads|untagged.*|new\s*folder|unknown(?:\s*(?:artist|album))?|various(?:\s*artists)?|(?:disc|disk|cd|part|vol(?:ume)?|side)\.?(?:\s*\d+|\s+(?:[a-z]|[ivxlc]+))?)$/i;

function isGenericName(name) {
	const s = String(name || '').trim();
	return !s || /^[A-Za-z]:$/.test(s) || GENERIC_NAME_RE.test(s);
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'upon', 'via', 'vs', 'with']);
const ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:C[MD]|D?C{0,3})(?:X[CL]|L?X{0,3})(?:I[XV]|V?I{0,3})$/;

/**
 * Title case for a name taken from a folder or a tag: small words go lower case except first,
 * last and after a colon or dash; acronyms, roman numerals, mixed-case words (McCoy) and words
 * with digits are left exactly as written. An all-lower-case title gets its words capitalised; an
 * all-capitals one is left alone, since it may be the real title. Only letter case changes, so
 * the slug (and with it the work id) cannot.
 */
function smartTitle(raw) {
	const s = String(raw || '').replace(/\s+/g, ' ').trim();
	if (!/[a-z]/.test(s)) return s;
	const allLower = !/[A-Z]/.test(s);
	const tokens = s.split(' ');
	return tokens.map((tok, i) => {
		const m = tok.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}'’.\-]*?)([^\p{L}\p{N}]*)$/u);
		if (!m || !m[2]) return tok;
		const [, pre, core, post] = m;
		const first = i === 0 || /[:\-–—]$/.test(tokens[i - 1]) || /^[(\[]/.test(pre);
		const last = i === tokens.length - 1;
		if (/\d/.test(core) || ROMAN_RE.test(core) || (core.length > 1 && core === core.toUpperCase())) return tok;
		if (/[a-z][A-Z]/.test(core)) return tok;
		const lower = core.toLowerCase();
		if (SMALL_WORDS.has(lower) && !first && !last) return pre + lower + post;
		if (allLower || core === lower) return pre + core.charAt(0).toUpperCase() + core.slice(1) + post;
		return tok;
	}).join(' ');
}

// "The Childrens Adventure" next to a file named "Children's Adventure": the apostrophe a folder
// name lost is put back when a part's own title or file name spells the word with it beside the
// same neighbouring word, so a chapter called "The King's Road" cannot touch "The Way of Kings".
// norm() drops apostrophes, so the slug is the same either way.
function restoreApostrophes(title, texts) {
	const hay = (texts || []).filter(Boolean).join(' \n ');
	const words = String(title || '').split(' ');
	const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return words.map((word, i) => {
		const m = word.match(/^([A-Za-z]{2,})(s|t|ll|re|ve|d)$/);
		if (!m) return word;
		const core = `${m[1]}(['’])${m[2]}`;
		const next = words[i + 1] ? `\\s+${esc(words[i + 1])}\\b` : null;
		const prev = words[i - 1] ? `\\b${esc(words[i - 1])}\\s+` : null;
		for (const re of [next && new RegExp(`\\b${core}${next}`, 'i'), prev && new RegExp(`${prev}${core}\\b`, 'i')]) {
			const hit = re && hay.match(re);
			if (hit) return `${m[1]}${hit[1]}${m[2]}`;
		}
		return word;
	}).join(' ');
}

/**
 * Series, number and title from an album or folder name.
 *   "The Rust Ledger 1: Cold Iron"                   series 1: title
 *   "The Rust Ledger [02] Grey Tides [01]"           series [NN] title [k]
 *   "The Rust Ledger 4 - Low Sun (2 of 6)"           series N - title (k of n)
 *   "Ashfall, Book 2 - Salt", "Ashfall #2: Salt"     series, book N - title
 *   "The Rust Ledger: Interlude"                     series: title (no number, weak)
 *   "Cold Iron (1 of 5)"                             title (k of n)
 * A weak reading names a series only when something else backs it up, since a history book
 * subtitled "Something: A Brief History" has the same shape.
 * @returns {{ series: string|null, sequence: number|null, title: string, part: number|null, weak: boolean }}
 */
function parseSeriesTitle(raw) {
	let s = String(raw || '').replace(/\s+/g, ' ').trim();
	let part = null;
	let m = s.match(/\s*\(\s*(\d+)\s*of\s*\d+\s*\)\s*$/i);
	if (m) { part = +m[1]; s = s.slice(0, m.index).trim(); }
	m = s.match(/\s*\[(\d+)\]\s*$/);
	if (m && /\[\d+(?:\.\d+)?\]/.test(s.slice(0, m.index))) { part = +m[1]; s = s.slice(0, m.index).trim(); }
	m = s.match(/^(.+?)\s*\[(\d+(?:\.\d+)?)\]\s*[:\-–]?\s*(.+)$/);
	if (m) return { series: m[1].trim(), sequence: +m[2], title: m[3].trim(), part, weak: false };
	m = s.match(/^(.+?),?\s+(?:book\s+|vol(?:ume)?\.?\s*|#)?(\d+(?:\.\d+)?)\s*[:\-–]\s+(.+)$/i);
	if (m && !/^\d{4}$/.test(m[2])) return { series: m[1].trim(), sequence: +m[2], title: m[3].trim(), part, weak: false };
	m = s.match(/^([^:]+?)\s*:\s+(.+)$/);
	if (m && !/^(?:a|the)\s+(?:novel|novella|story|memoir)$/i.test(m[2]) && !/^(?:part|book|volume)\b/i.test(m[2])) {
		return { series: m[1].trim(), sequence: null, title: m[2].trim(), part, weak: true };
	}
	return { series: null, sequence: null, title: s, part, weak: false };
}

function personName(s) {
	const t = String(s || '').trim();
	if (!t || CORP_WORD_RE.test(t) || publisherOf(t)) return null;
	const words = t.split(/\s+/);
	if (words.length < 2 || words.length > 5) return null;
	return words.every((w) => /^(?:[A-Z][\p{L}'’.\-]*|[A-Z]\.|de|van|von|der|la|le|du|da)$/u.test(w)) ? t : null;
}

/** A person's name out of a copyright line, or null for a company or anything unclear. */
function authorFromCopyright(text) {
	let s = String(text || '').split(/\(p\)|℗|\n/i)[0];
	s = s.replace(/copyright|\(c\)|©|all rights reserved.*$/gi, ' ');
	s = s.replace(/\b(?:19|20)\d{2}\b(?:\s*[-,]\s*(?:19|20)\d{2}\b)*/g, ' ');
	s = s.replace(/^[\s,.:;]*(?:by\s+)?/i, '').split(/[.;]|\s{2,}|,\s*(?:published|recorded|licensed)/i)[0];
	s = s.replace(/[\s,]+$/, '').trim();
	return personName(s);
}

/** "Written by X", "By : X" in a comment tag. */
function authorFromComment(text) {
	const m = String(text || '').match(/(?:written\s+by|^\s*by\s*:)\s*([^\n.,;\-–]+?)(?:\s*[.,;\-–]|\s+performed|\s+narrated|\s+read\b|\n|$)/im)
		|| String(text || '').match(/\n\s*By\s*:\s*([^\n]+)/);
	return m ? personName(m[1].trim()) : null;
}

// A list of names, or one cut short ("Mara Lindqvist,..." is the first of a GraphicAudio cast),
// is a cast: showing its first name as the narrator would be wrong.
const CAST_RE = /,|&|\band\b|\.{3}|…|\bcast\b|\bvarious\b|\bensemble\b/i;

function narratorName(text) {
	const s = String(text || '').trim();
	return !s || CAST_RE.test(s) ? null : personName(s);
}

/** "Narrated by: X" / "Read by X", one person only: a full cast is not a narrator. */
function narratorFromComment(text) {
	const m = String(text || '').match(/(?:narrated|read)\s+by\s*:?\s*([^\n.;]+)/i);
	return m ? narratorName(m[1]) : null;
}

const NAME_SIGNAL_RE = /graphic\s*audio|grahpic\s*audio|unabridged|audio\s*book|\babook\b|narrat|\bread by\b|STORMLIGHT\d{4}/i;
const CHAPTER_TITLE_RE = /\b(chapter|chatper|chap\.?|prologue|epilogue|interlude|prelude)\b/i;
const EPISODE_RE = /\b(?:ep|episode)\.?\s*(\d+)/i;
const SAMPLE_RE = /^sample$/i;
const SPOKEN_GENRE_RE = /spoken|abook|audiobook/i;
const SAMPLE_MAX_MS = 5 * MIN;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const natural = (a, b) => collator.compare(String(a), String(b));

function norm(text) {
	return String(text || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function slug(text) {
	return norm(text).replace(/ /g, '-') || 'untitled';
}

function basename(file) {
	const segs = String(file || '').split(/[\\/]+/).filter(Boolean);
	return segs.length ? segs[segs.length - 1] : '';
}

function partIdOf(partKey) {
	const m = String(partKey || '').match(/^\/library\/parts\/(\d+)\//);
	return m ? m[1] : null;
}

function own(map, k) {
	return map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
}

function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v) {
	return typeof v === 'string' && v.trim() !== '';
}

function partOf(t) {
	const m = t && t.Media && t.Media[0];
	return (m && m.Part && m.Part[0]) || {};
}

function containerOf(t) {
	const m = t && t.Media && t.Media[0];
	return String((m && m.container) || '').toLowerCase();
}

function segmentsOf(t) {
	return String(partOf(t).file || '').split(/[\\/]+/).filter(Boolean);
}

// Unlike segmentsOf this keeps the path as Plex wrote it, so a POSIX path keeps its leading "/".
function dirOfTrack(t) {
	const file = String(partOf(t).file || '');
	const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
	if (cut < 0) return '';
	const dir = cut === 0 ? file.slice(0, 1) : file.slice(0, cut);
	// "C:" alone names the drive's current directory, not its root.
	return /^[A-Za-z]:$/.test(dir) ? `${dir}/` : dir;
}

function median(nums) {
	const s = [...nums].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// mp3 ID3 CHAP frames come back from Plex too, but the ones seen were 5-minute "Marker N" points,
// so only mp4 containers and very long files are worth a probe.
function wantsChapters(t) {
	return /mp4|m4a|m4b/.test(containerOf(t)) || (t && t.duration || 0) > 2 * HOUR;
}

/**
 * A Plex `Chapter` array (or an already normalised list) reduced to the chapters worth seeking to.
 * @returns {Array<{title: string|null, startMs: number, endMs: number}> | 'markers' | 'none'}
 */
function normalizeChapters(raw) {
	if (!Array.isArray(raw) || raw.length === 0) return 'none';
	const entries = raw.filter(isObject).map((x) => ({
		title: typeof x.title === 'string' ? x.title : (typeof x.tag === 'string' ? x.tag : null),
		startMs: Number(x.startMs !== undefined ? x.startMs : x.startTimeOffset),
		endMs: Number(x.endMs !== undefined ? x.endMs : x.endTimeOffset),
	}));
	const real = entries.filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs);
	if (real.length >= 2) return real.sort((a, b) => a.startMs - b.startMs);
	if (entries.length && entries.every((c) => c.startMs === c.endMs)) return 'markers';
	return 'none';
}

// "[01]", "(1 of 6)", "part 2", "Disc 3", "The Final Empire 2" all name one piece of a larger whole.
function stripPartMarker(name) {
	let s = String(name || '').trim();
	if (/^(part|disc|disk|cd|vol(ume)?)\s*\d+$/i.test(s)) return '';
	s = s.replace(/\s*\(\s*\d+\s*of\s*\d+\s*\)\s*$/i, '');
	s = s.replace(/\s*\[\s*\d+\s*\]\s*$/, '');
	s = s.replace(/\s*[-,]?\s*(part|disc|disk|cd)\s*\d+\s*$/i, '');
	s = s.replace(/\s+\d{1,2}\s*$/, '');
	return s.trim();
}

/** The artist field, split into the person who wrote it and the house that produced it. */
function splitArtist(artist) {
	const raw = String(artist || '').trim();
	const m = raw.match(/^(.*?)\s*\[(.+)\]\s*$/);
	const base = m ? m[1] : raw;
	const bracket = m ? m[2] : null;
	const house = publisherOf(base);
	if (house) return { author: bracket, publisher: house };
	return { author: base || bracket, publisher: null };
}

function legacyPublisherArtist(artist) {
	const raw = String(artist || '').trim();
	const m = raw.match(/^(.*?)\s*\[(.+)\]\s*$/);
	return LEGACY_PUBLISHER_RE.test(m ? m[1] : raw);
}

/** The folder directly under the library's "Music" root, taken to be the author or artist. */
function rootChild(t) {
	const segs = segmentsOf(t);
	const i = segs.findIndex((s) => /^music$/i.test(s));
	return i >= 0 && i + 2 < segs.length ? segs[i + 1] : null;
}

/** A folder key that is the same for every piece of one book. */
function folderKey(t) {
	const segs = segmentsOf(t);
	const dirs = segs.slice(0, -1);
	if (dirs.length === 0) return `album:${t.parentRatingKey}`;
	const leaf = dirs[dirs.length - 1];
	const parent = dirs[dirs.length - 2] || '';
	const stripped = stripPartMarker(leaf);
	if (!stripped || (parent && norm(parent).includes(norm(stripped)))) return dirs.slice(0, -1).join('/');
	if (stripped !== leaf) return dirs.slice(0, -1).concat(stripped).join('/');
	return dirs.join('/');
}

// Overrides name folders the way the rejected list prints them, but people type slashes and case
// however they like.
function matchKey(key) {
	return String(key || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function dirKeyOf(t) {
	return segmentsOf(t).slice(0, -1).join('/');
}

function albumOf(t) {
	return String(t.parentRatingKey);
}

/** Section folders in folder-key form (slashes, no leading slash), lower-cased. */
function rootSet(roots) {
	return new Set((roots || []).map((r) => String(r || '').split(/[\\/]+/).filter(Boolean).join('/').toLowerCase()));
}

/**
 * @param {object[]} tracks
 * @param {{ roots?: string[] }} [ctx] roots: the music sections' folders
 * @returns {Map<string, object[]>} folder key to tracks
 */
function groupTracks(tracks, ctx = {}) {
	const roots = rootSet(ctx.roots);
	const dirAlbums = new Map();
	for (const t of tracks) {
		const d = dirKeyOf(t);
		if (!dirAlbums.has(d)) dirAlbums.set(d, new Set());
		dirAlbums.get(d).add(albumOf(t));
	}
	// A "Disc 2" or "Title 1" folder folds into its parent only when that parent is a book's
	// folder: it holds no loose files, or its loose files are the same Plex album. A stray "Disc 2"
	// of some rap album under the library root once folded into the root and took a loose book file
	// sitting there along with it.
	const keyOf = (t) => {
		const k = folderKey(t);
		const d = dirKeyOf(t);
		if (k === d || !d.startsWith(k + '/')) return k;
		const loose = dirAlbums.get(k);
		if (loose && loose.size) return loose.has(albumOf(t)) ? k : d;
		return roots.has(k.toLowerCase()) || /^[A-Za-z]:$/.test(k) ? d : k;
	};
	const groups = new Map();
	for (const t of tracks) {
		const k = keyOf(t);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(t);
	}

	// One Plex album spread over sibling folders that nothing else uses is one work (a box set
	// ripped per book). Albums that share a folder with another album are left split, because
	// there the album tag is the thing that is wrong.
	const keysByAlbum = new Map();
	for (const [k, ts] of groups) {
		for (const t of ts) {
			const a = String(t.parentRatingKey);
			if (!keysByAlbum.has(a)) keysByAlbum.set(a, new Set());
			keysByAlbum.get(a).add(k);
		}
	}
	for (const [album, keys] of keysByAlbum) {
		if (keys.size < 2) continue;
		const exclusive = [...keys].every((k) => groups.has(k) && groups.get(k).every((t) => String(t.parentRatingKey) === album));
		if (!exclusive) continue;
		const parents = new Set([...keys].map((k) => k.split('/').slice(0, -1).join('/')));
		if (parents.size !== 1) continue;
		const merged = [...parents][0];
		const all = [];
		for (const k of keys) { all.push(...groups.get(k)); groups.delete(k); }
		groups.set(merged, (groups.get(merged) || []).concat(all));
	}
	return groups;
}

/**
 * The music albums of a group that classified as a book or podcast, when some album in it is
 * not music. Plex filed them apart on purpose; groups that stay music are never split, so the
 * rejected list does not fill with pieces.
 * @returns {string[]} album ratingKeys to split off, possibly empty
 */
function musicAlbumsToSplit(ts, albumClass) {
	const albums = [...new Set(ts.map(albumOf))];
	const music = albums.filter((a) => albumClass(a) === 'music');
	return music.length && music.length < albums.length ? music : [];
}

function groupStats(key, ts, albumsByKey, albumClass = () => null) {
	const durations = ts.map((t) => t.duration || 0);
	const totalMs = durations.reduce((s, d) => s + d, 0);
	const media = ts.map((t) => (t.Media && t.Media[0]) || {});
	const mono = media.filter((m) => m.audioChannels === 1).length / ts.length;
	const bitrate = median(media.map((m) => m.bitrate || 0));
	const albums = [...new Set(ts.map((t) => String(t.parentRatingKey)))].map((k) => albumsByKey.get(k)).filter(Boolean);
	const genres = albums.flatMap((a) => (a.Genre || []).map((g) => g.tag));
	const names = [key, ...albums.map((a) => `${a.parentTitle} ${a.title}`), ...ts.map((t) => t.grandparentTitle)].join(' | ');
	const chapterShare = ts.filter((t) => CHAPTER_TITLE_RE.test(t.title) || CHAPTER_TITLE_RE.test(segmentsOf(t).pop())).length / ts.length;
	const episodeShare = ts.filter((t) => EPISODE_RE.test(t.title) || EPISODE_RE.test(segmentsOf(t).pop())).length / ts.length;
	const bookShare = ts.filter((t) => albumClass(albumOf(t)) === 'book').length / ts.length;
	const musicShare = ts.filter((t) => albumClass(albumOf(t)) === 'music').length / ts.length;
	return {
		bookShare, musicShare,
		n: ts.length, totalMs, medianMs: median(durations), maxMs: durations.reduce((m, d) => Math.max(m, d), 0),
		mono, bitrate, genres,
		nameSignal: NAME_SIGNAL_RE.test(names) || genres.some((g) => SPOKEN_GENRE_RE.test(g)) || chapterShare >= 0.3,
		chapterShare, episodeShare,
	};
}

function musicVetoed(s) {
	return (s.musicShare || 0) >= 0.5 && !s.bookShare;
}

function classify(s) {
	if (s.totalMs < DETECT.minTotalMs) return null;
	// A music genre with no audiobook genre beside it vetoes every length rule: an hour-long mix
	// is still music.
	if (musicVetoed(s)) return null;
	if (s.episodeShare >= 0.5 && s.medianMs >= DETECT.podcastMedianMs) return { kind: 'podcast', rule: 'episodes' };
	if (s.medianMs >= DETECT.medianLongMs) return { kind: 'book', rule: 'median' };
	if (s.bookShare >= 0.5) return { kind: 'book', rule: 'genre' };
	if (s.nameSignal && s.totalMs >= DETECT.signalTotalMs) return { kind: 'book', rule: 'name-signal' };
	if (s.mono >= 0.8 && s.bitrate && s.bitrate <= 96 && s.n >= DETECT.monoMinTracks && s.totalMs >= DETECT.signalTotalMs) return { kind: 'book', rule: 'mono-low-bitrate' };
	return null;
}

function relPath(t, key) {
	const file = segmentsOf(t).join('/');
	return file.startsWith(key + '/') ? file.slice(key.length + 1) : file;
}

function leadingNumber(name) {
	const m = String(name).match(/^\s*(\d+)/);
	return m ? +m[1] : null;
}

// Several files in one folder sharing a leading track number means more than one numbered
// sequence was poured into the same folder.
function hasInterleavedNumbers(ts) {
	const byDir = new Map();
	for (const t of ts) {
		const segs = segmentsOf(t);
		const dir = segs.slice(0, -1).join('/');
		// "1-01", "2-01" are disc-track numbers, not a repeated "1".
		const m = String(segs[segs.length - 1]).match(/^\s*(\d+(?:[-.]\d+)*)/);
		if (!m) continue;
		const key = `${dir}#${m[1]}`;
		byDir.set(key, (byDir.get(key) || 0) + 1);
	}
	return [...byDir.values()].some((c) => c > 1);
}

/**
 * The play order of several numbered volumes dumped in one folder. Each volume restarts its
 * numbering at 01, so chapter numbers decide which volume a file belongs to; files without one
 * (intro, prelude, interlude, outro) go to the volume with a gap at their number. GraphicAudio's
 * own codes (STORMLIGHT0103P04 = book 01, volume 03, part 04) carry the volume outright. Best
 * effort: the work is marked low confidence and a partOrder override is the fix.
 */
function orderInterleaved(ts) {
	const info = ts.map((t) => {
		const file = segmentsOf(t).pop() || '';
		const stem = file.replace(/\.[^.]+$/, '');
		const code = stem.match(/STORMLIGHT(\d{2})(\d{2})P(\d{2})/i) || String(t.title).match(/STORMLIGHT(\d{2})(\d{2})P(\d{2})/i);
		const chap = (t.title + ' ' + stem).match(/\b(?:chapter|chatper)\s*(\d+)/i);
		const num = leadingNumber(stem);
		const cluster = stem.replace(/^\s*\d+\s*/, '').replace(/\s+-\s+.*$/, '').trim().toLowerCase();
		return { t, stem, num, cluster, code: code ? { vol: +code[2], part: +code[3] } : null, chapter: chap ? +chap[1] : null };
	});

	const coded = info.filter((i) => i.code);
	const rest = info.filter((i) => !i.code);
	const clusters = new Map();
	for (const i of rest) {
		if (!clusters.has(i.cluster)) clusters.set(i.cluster, []);
		clusters.get(i.cluster).push(i);
	}

	const volumes = [];
	for (const items of clusters.values()) {
		const chapters = items.filter((i) => i.chapter !== null && i.num !== null).sort((a, b) => a.chapter - b.chapter);
		const vols = [];
		let cur = null;
		for (const c of chapters) {
			if (!cur || c.num <= cur.lastNum) { cur = { items: [], slots: new Map(), lastNum: -1 }; vols.push(cur); }
			cur.items.push(c); cur.slots.set(c.num, c); cur.lastNum = c.num;
		}
		if (vols.length === 0) vols.push({ items: [], slots: new Map(), lastNum: -1 });
		const others = items.filter((i) => !(i.chapter !== null && i.num !== null)).sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
		for (const o of others) {
			const isOutro = /outro/i.test(o.stem);
			const n = o.num ?? 999;
			const candidates = vols.filter((v) => !v.slots.has(n) && !(isOutro && v.items.some((i) => /outro/i.test(i.stem))));
			const score = (v) => {
				const prev = v.slots.get(n - 1), next = v.slots.get(n + 1);
				return (prev && prev.chapter !== null ? 4 : prev ? 2 : 0) + (next && next.chapter !== null ? 3 : next ? 1 : 0);
			};
			const pick = candidates.sort((a, b) => score(b) - score(a))[0] || vols[0];
			pick.items.push(o); pick.slots.set(n, o);
		}
		for (const v of vols) {
			v.items.sort((a, b) => (a.num ?? 999) - (b.num ?? 999) || natural(a.stem, b.stem));
			v.minChapter = Math.min(...v.items.filter((i) => i.chapter !== null).map((i) => i.chapter), Infinity);
			volumes.push(v);
		}
	}
	volumes.sort((a, b) => a.minChapter - b.minChapter);

	const codedVols = new Map();
	for (const c of coded) {
		if (!codedVols.has(c.code.vol)) codedVols.set(c.code.vol, []);
		codedVols.get(c.code.vol).push(c);
	}
	for (const [vol, items] of [...codedVols].sort((a, b) => a[0] - b[0])) {
		items.sort((a, b) => a.code.part - b.code.part);
		volumes.splice(Math.min(vol - 1, volumes.length), 0, { items, coded: vol });
	}
	return volumes.flatMap((v) => v.items.map((i) => i.t));
}

function isSample(t) {
	return SAMPLE_RE.test(String(t.title).trim()) && (t.duration || 0) < SAMPLE_MAX_MS;
}

/**
 * Album play order for a podcast whose episode numbers restart in another album (a new season
 * or campaign in the same folder), or null when none repeat, so a podcast with one album per
 * episode keeps its episode order. Albums go by earliest air date when every album has one,
 * else by when Plex added them, then by rating key, which Plex hands out in the order it adds.
 */
function albumRanks(ts, ep, date) {
	const albumsOfEp = new Map();
	for (const t of ts) {
		const n = ep(t);
		if (!Number.isFinite(n)) continue;
		if (!albumsOfEp.has(n)) albumsOfEp.set(n, new Set());
		albumsOfEp.get(n).add(String(t.parentRatingKey));
	}
	if (![...albumsOfEp.values()].some((s) => s.size > 1)) return null;
	const albums = new Map();
	for (const t of ts) {
		const k = String(t.parentRatingKey);
		const a = albums.get(k) || { key: k, date: '', addedAt: Infinity };
		const d = date(t);
		if (d && (!a.date || d < a.date)) a.date = d;
		if (Number.isFinite(t.addedAt)) a.addedAt = Math.min(a.addedAt, t.addedAt);
		albums.set(k, a);
	}
	const list = [...albums.values()];
	const dated = list.every((a) => a.date);
	list.sort((a, b) => (dated ? natural(a.date, b.date) : 0) || a.addedAt - b.addedAt || natural(a.key, b.key));
	return new Map(list.map((a, i) => [a.key, i]));
}

function orderParts(kind, key, ts) {
	const kept = ts.filter((t) => !isSample(t));
	if (kind === 'podcast') {
		const ep = (t) => { const m = (t.title + ' ' + (segmentsOf(t).pop() || '')).match(EPISODE_RE); return m ? +m[1] : Infinity; };
		const date = (t) => t.originallyAvailableAt || '';
		const byEpisode = (a, b) => ep(a) - ep(b) || natural(date(a), date(b)) || (a.addedAt || 0) - (b.addedAt || 0);
		const rank = albumRanks(kept, ep, date);
		const byAlbum = rank ? (a, b) => rank.get(String(a.parentRatingKey)) - rank.get(String(b.parentRatingKey)) : () => 0;
		return { parts: [...kept].sort((a, b) => byAlbum(a, b) || byEpisode(a, b)), method: 'episode-number' };
	}
	if (hasInterleavedNumbers(kept)) return { parts: orderInterleaved(kept), method: 'interleaved-volumes' };
	return { parts: [...kept].sort((a, b) => natural(relPath(a, key), relPath(b, key))), method: 'path-natural' };
}

// How a recording was made, not who made it: never a title word, a narrator or an edition name.
const EDITION_MARKER = String.raw`(?:dramati[sz]ed(?:\s+adaptation)?|unabridged|abridged|full[- ]cast(?:\s+(?:dramati[sz]ation|production|recording))?|audio\s*drama)`;
const EDITION_TAIL_RE = new RegExp(String.raw`\s*[(\[]\s*${EDITION_MARKER}\s*[)\]]\s*$`, 'i');
const EDITION_ONLY_RE = new RegExp(String.raw`^\s*${EDITION_MARKER}\s*$`, 'i');

function cleanTitle(raw) {
	let s = String(raw || '');
	s = s.replace(/^\s*\d{4}\s*-\s*/, '');                 // "1990 - Title"
	s = s.replace(/\s+\d+\s*mb\s*$/i, '');                  // "... 541mb"
	s = s.replace(/^\s*\d+(\.\d+)?\s*[.\-_]\s*/, '');       // "1.Title", "05 - "
	s = s.replace(EDITION_TAIL_RE, '');                     // "[Unabridged]"
	s = s.replace(/\s*\([^)]*\)\s*$/, '');                  // "(Narrator)": kept as the edition instead
	s = stripPartMarker(s);
	return s.replace(/\s+/g, ' ').trim();
}

// Several numbered files of one book carry one album tag apart from these, so only what is left
// tells two books apart: "Ledger 4 - Low Sun (2 of 6)" and "Ledger [04] Low Sun [03]" are one.
// A store subtitle ("Low Sun: The Ledger, Book 4", "Low Sun: A Novel") and a lone part letter
// ("Low Sun A") go too, since one book's parts spell its tag both with and without them.
const PART_WORD = String.raw`(?:\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)`;
const BOOK_TAIL_RES = [
	/\s*:\s*[^:]+?,\s*(?:book|volume|vol\.?)\s*\d+(?:\.\d+)?\s*$/i,
	/\s*[:,]\s*a\s+novel\s*$/i,
	new RegExp(String.raw`\s*[-,:]?\s*\(?\s*\b(?:part|pt\.?|book|vol(?:ume)?\.?)\s*${PART_WORD}\s+of\s+${PART_WORD}\s*\)?\s*$`, 'i'),
	new RegExp(String.raw`\s*[-,:]?\s*\b(?:part|pt\.?)\s+${PART_WORD}\s*$`, 'i'),
	/\s*[-,]\s*\d+\s+of\s+\d+\s*$/i,
	/\s*[(\[]\s*(?:part\s*)?\d+\s*of\s*\d+\s*[)\]]\s*$/i,
	/\s*\[\s*\d+(?:\s*-\s*\d+)?\s*\]\s*$/,
	/\s*[-,:]?\s*\b(?:part|pt\.?|disc|disk|cd|vol(?:ume)?\.?)\s*\d+\s*$/i,
	/\s+[A-Z]\s*$/,
	/\s+\d{1,2}\s*$/,
	/\s*\([^)]*\)\s*$/,
];

function stripBookTail(raw) {
	let s = String(raw || '').replace(/\s+/g, ' ').trim();
	for (let prev = null; prev !== s;) {
		prev = s;
		s = s.replace(EDITION_TAIL_RE, '').trim();
		for (const re of BOOK_TAIL_RES) s = s.replace(re, '').trim();
	}
	return s;
}

/** The book an album tag or a file name names, reduced to compare equal across its parts. */
function bookIdentity(raw) {
	const s = stripBookTail(raw);
	return norm(stripBookTail(parseSeriesTitle(s).title)) || norm(s);
}

// "Author - #2 Title (Publisher)" or "#2 Title": the shape of a loose single-file book's name.
const NUMBERED_NAME_RE = /^(?:(.+?)\s+-\s+)?#\s*(\d+(?:\.\d+)?)\s*[-:.]?\s+(.+?)\s*$/;

function numberedName(text) {
	const m = String(text || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim().match(NUMBERED_NAME_RE);
	if (!m) return null;
	const name = m[3].replace(/\s*\([^)]*\)\s*$/, '').trim();
	return name ? { author: m[1] ? m[1].trim() : null, number: +m[2], name } : null;
}

function trackNumberOf(value) {
	const m = String(value || '').match(/^\s*(\d{1,3})(?:\s*\/\s*\d+)?\s*$/);
	return m && +m[1] > 0 ? +m[1] : null;
}

// Only a folder of mp4 files can be a set of loose single-file books. Long mp3 files are podcast
// episodes, lectures or a book's parts, which name themselves "#N Title" or tag each file with its
// own album just as books do; and the chapter marks an mp3 carries are timed points, not a book's
// own chapters. Anything else, or more members than a series has, is never read one by one.
const SINGLE_FILE = Object.freeze({ minFiles: 2, maxFiles: 40, minMs: 15 * MIN });

function mayHoldSingleFileBooks(ts) {
	const kept = ts.filter((t) => !isSample(t));
	if (kept.length < SINGLE_FILE.minFiles || kept.length > SINGLE_FILE.maxFiles) return false;
	return kept.every((t) => (t.duration || 0) >= SINGLE_FILE.minMs && /mp4|m4a|m4b/.test(containerOf(t)));
}

/**
 * The book one file belongs to: its own album tag, else a "#N Title" file name or track title.
 * @returns {{ key: string, name: string, source: 'tag'|'folder', number: number|null,
 *   numberSource: string|null, author: string|null } | null}
 */
function bookOfTrack(t, tg = {}) {
	const own = numberedName(segmentsOf(t).pop()) || numberedName(t.title);
	const tagNumber = trackNumberOf(tg.track);
	const number = tagNumber ?? (own ? own.number : null);
	const numberSource = tagNumber !== null ? 'tag' : (own ? 'folder' : null);
	const author = own ? own.author : null;
	if (nonEmpty(tg.album)) {
		const key = bookIdentity(tg.album);
		if (key) return { key, name: tg.album.trim(), source: 'tag', number, numberSource, author };
	}
	if (own) {
		const key = bookIdentity(own.name);
		if (key) return { key, name: own.name, source: 'folder', number, numberSource, author };
	}
	return null;
}

/**
 * A classified folder group cut into one piece per book, when its files name two books or more.
 * Every member must name its book: a file that says nothing could belong to any of them, and a
 * build with tags still pending splits once they land.
 * @returns {Array<{ book: object, ts: object[] }>|null}
 */
function bookPieces(ts, tagsOfTrack) {
	if (!mayHoldSingleFileBooks(ts)) return null;
	// An episode's album tag is its own title, so a podcast in mp4 files looks like a box set.
	if (ts.some((t) => /\bpodcasts?\b/i.test(String((tagsOfTrack(t) || {}).genre || '')))) return null;
	const ordered = [...ts].sort((a, b) => natural(segmentsOf(a).join('/'), segmentsOf(b).join('/')));
	const pieces = new Map();
	const samples = [];
	for (const t of ordered) {
		if (isSample(t)) { samples.push(t); continue; }
		const b = bookOfTrack(t, tagsOfTrack(t));
		if (!b) return null;
		const piece = pieces.get(b.key);
		if (!piece) { pieces.set(b.key, { book: { ...b }, ts: [t] }); continue; }
		piece.ts.push(t);
		if (piece.book.number === null && b.number !== null) Object.assign(piece.book, { number: b.number, numberSource: b.numberSource });
		if (!piece.book.author && b.author) piece.book.author = b.author;
	}
	if (pieces.size < 2) return null;
	const list = [...pieces.values()];
	list[0].ts.push(...samples);
	return list;
}

function parenOf(raw) {
	const m = String(raw || '').match(/\(([^)]+)\)/);
	if (!m) return null;
	const inner = m[1].replace(/\.{2,}|,\s*$/g, '').replace(/,\s*$/, '').trim();
	return /^\d+\s*of\s*\d+$/i.test(inner) ? null : inner || null;
}

// The bracket text parenOf() reads, and whether it was cut short ("Mara Lindqvist,...").
function truncatedParen(raw) {
	const m = String(raw || '').match(/\(([^)]+)\)/);
	return !!m && /(?:\.{2,}|…)\s*$/.test(m[1].trim());
}

function stripFeat(name) {
	return String(name || '').replace(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+.*$/i, '').trim();
}

// The most-weighted reading of several names (album titles, a folder name) that agree on a series.
function consensus(readings) {
	const tally = new Map();
	for (const r of readings) {
		const k = `${norm(r.series)}|${r.sequence ?? ''}|${norm(r.title)}`;
		const e = tally.get(k) || { ...r, weight: 0 };
		e.weight += r.weight;
		tally.set(k, e);
	}
	return [...tally.values()].sort((a, b) => b.weight - a.weight)[0] || null;
}

const AUTHOR_SOURCE = { artist: 'plex-artist', 'tag-artist': 'tag', comment: 'tag', copyright: 'tag', file: 'folder', folder: 'folder' };

/**
 * What a group is called. Besides the display fields it returns idEdition, the collision suffix
 * input exactly as rules version 2 derived it, so tag data can never change an existing id.
 * Doubts are structured and carry names only, never a folder path.
 * @param {object|null} [book] for one book cut out of a folder of single-file books: its name,
 *   number and author as its own files give them (bookOfTrack), which beat every album title
 * @param {(t: object) => object} [tagsOfTrack] a file's own tags, which such a book is read from
 */
function describe(key, ts, albumsByKey, titleCounts, tagsOf = () => ({}), roots = new Set(), book = null, tagsOfTrack = () => ({})) {
	const albumKeys = [...new Set(ts.map(albumOf))];
	const albums = albumKeys.map((k) => albumsByKey.get(k)).filter(Boolean);
	const baseKey = key.replace(/(?:#(?:album|book):[^/#]+)+$/, '');
	// A group carved out by an album include override or a split has no folder of its own to be
	// named after.
	const carved = key.startsWith('album:') || baseKey !== key;
	const weightOf = (a) => ts.filter((t) => albumOf(t) === String(a.ratingKey)).length;
	const mainAlbum = [...albums].sort((a, b) => weightOf(b) - weightOf(a))[0] || null;
	const rawLeaf = book ? book.name : (carved && mainAlbum ? mainAlbum.title : baseKey.split('/').pop());
	// "Music", "Disc 2", a drive or a library root names where files live, not what they are.
	const genericLeaf = !carved && (isGenericName(cleanTitle(rawLeaf)) || roots.has(baseKey.toLowerCase()));
	const leaf = genericLeaf && mainAlbum ? mainAlbum.title : rawLeaf;
	const leafSource = book ? book.source : (carved || (genericLeaf && mainAlbum) ? 'album' : 'folder');
	// The album a loose book sits in can be Plex's guess for several files, so its sample says
	// nothing about this one.
	const tagList = book ? ts.map((t) => tagsOfTrack(t) || {}) : albumKeys.map((k) => tagsOf(k) || {});
	const doubts = [];

	const artists = ts.map((t) => splitArtist(t.grandparentTitle));
	const authorVotes = {};
	for (const a of artists) if (a.author && !isVarious(a.author)) { const n = stripFeat(a.author); authorVotes[n] = (authorVotes[n] || 0) + 1; }
	const ranked = Object.entries(authorVotes).sort((a, b) => b[1] - a[1]);
	if (new Set(ranked.map(([n]) => norm(n))).size > 1) doubts.push({ code: 'mixed-artists', artists: ranked.map(([name, tracks]) => ({ name, tracks })) });
	let author = ranked[0] ? ranked[0][0] : null;
	let authorSource = author ? 'artist' : null;
	if (!author) {
		for (const tg of tagList) {
			const fromTag = [tg.artist, tg.album_artist].map((x) => splitArtist(x).author).find((x) => x && !publisherOf(x) && !isVarious(x));
			const byComment = authorFromComment(tg.comment);
			const byCopyright = authorFromCopyright(tg.copyright);
			const found = fromTag ? ['tag-artist', stripFeat(fromTag)] : byComment ? ['comment', byComment] : byCopyright ? ['copyright', byCopyright] : null;
			if (found) { [authorSource, author] = found; break; }
		}
	}
	if (!author) {
		const fromFile = [book && book.author, ...ts.map((t) => { const n = numberedName(segmentsOf(t).pop()); return n && n.author; })]
			.map((x) => personName(x)).find(Boolean);
		if (fromFile) { author = fromFile; authorSource = 'file'; }
	}
	if (!author && rootChild(ts[0])) { author = rootChild(ts[0]); authorSource = 'folder'; }
	if (!author) doubts.push({ code: 'no-author' });

	const nameText = key + ts.map((t) => segmentsOf(t).pop()).join(' ');
	const gaName = /graphic\s*audio|grahpic/i.test(nameText);
	const artistHouse = artists.map((a) => a.publisher).find(Boolean) || null;
	const tagHouse = tagList.flatMap((tg) => [tg.artist, tg.album_artist, tg.composer, tg.publisher].map((x) => splitArtist(x).publisher)).find(Boolean) || null;
	const gaComment = tagList.some((tg) => /graphicaudio\.net/i.test(tg.comment || ''));
	const publisher = artistHouse || tagHouse || (gaComment || gaName ? 'GraphicAudio' : null);
	const publisherSource = artistHouse ? 'plex-artist' : (tagHouse || gaComment) ? 'tag' : gaName ? 'folder' : null;
	const legacyPublisher = ts.some((t) => legacyPublisherArtist(t.grandparentTitle)) || gaName ? 'GraphicAudio' : null;

	// The folder is the author folder (a flat dump): the album title is the only name there is.
	const folderIsAuthor = norm(leaf) === norm(rootChild(ts[0])) || norm(leaf) === norm(author);
	const singleAlbum = albums.length === 1 ? albums[0] : null;
	const unique = (a) => (titleCounts.get(norm(a.title)) || 0) === 1;
	const albumTitleUsable = singleAlbum && unique(singleAlbum);

	// Series and number: album titles first (only titles no other work shares), the folder second.
	const readings = book ? [] : albums.filter(unique).map((a) => ({ ...parseSeriesTitle(a.title), weight: weightOf(a) }));
	const strongAlbum = consensus(readings.filter((r) => r.series && !r.weak));
	const weakAlbum = consensus(readings.filter((r) => r.series && r.weak));
	const keySegs = baseKey.split('/').slice(-3).filter((s) => !isGenericName(s));
	const keyReadings = keySegs.map((s) => parseSeriesTitle(s)).filter((r) => r.series && !r.weak);
	const keyStrong = keyReadings[keyReadings.length - 1] || null;
	const covered = strongAlbum ? strongAlbum.weight / ts.length : 0;

	let rawTitle;
	let titleSource = 'album';
	if (book) { rawTitle = book.name; titleSource = book.source; }
	else if ((folderIsAuthor || genericLeaf) && singleAlbum) rawTitle = singleAlbum.title;
	else if (albumTitleUsable) rawTitle = singleAlbum.title;
	else if (strongAlbum && covered >= 0.5) rawTitle = strongAlbum.title;
	else { rawTitle = leaf; titleSource = leafSource; }

	let series = null, sequence = null, seriesWeak = false, weakFull = null;
	let seriesSource = null, sequenceSource = null;
	const ownReading = parseSeriesTitle(rawTitle);
	const pick = (ownReading.series && !ownReading.weak ? ownReading : null) || (strongAlbum && covered >= 0.5 ? strongAlbum : null) || keyStrong;
	if (pick) {
		series = pick.series;
		sequence = pick.sequence;
		seriesSource = pick === ownReading ? titleSource : pick === keyStrong ? 'folder' : 'album';
		if (ownReading.series && norm(ownReading.series) === norm(series)) rawTitle = ownReading.title;
	} else if (ownReading.series && ownReading.weak) {
		weakFull = rawTitle;
		series = ownReading.series; seriesWeak = true; rawTitle = ownReading.title;
		seriesSource = titleSource;
	} else if (weakAlbum && weakAlbum.weight / ts.length >= 0.5) {
		series = weakAlbum.series; seriesWeak = true;
		seriesSource = 'album';
	}
	if (series && sequence !== null) sequenceSource = seriesSource;
	if (series && sequence === null) {
		const fromKey = keyReadings.find((r) => norm(r.series) === norm(series));
		if (fromKey) { sequence = fromKey.sequence; seriesWeak = false; sequenceSource = 'folder'; }
	}

	// The rules this replaces, kept as fallbacks: GraphicAudio's STORMLIGHT codes, and "1.Title"
	// folders under an album named after the series.
	if (!series) {
		const stormlight = (rawTitle + ' ' + key).match(/stormlight archive\s*(?:\[(\d+(?:\.\d+)?)\]|(\d+))?/i);
		const code = ts.map((t) => (t.title || '').match(/STORMLIGHT(\d{2})\d{2}P\d{2}/i)).find(Boolean);
		if (stormlight || code) {
			series = 'The Stormlight Archive';
			seriesSource = stormlight ? 'folder' : 'album';
			const fromKey = key.match(/stormlight archive\s*\[(\d+(?:\.\d+)?)\]/i);
			sequence = fromKey ? +fromKey[1] : stormlight && stormlight[2] ? +stormlight[2] : code ? +code[1] : null;
			sequenceSource = sequence === null ? null : (fromKey || (stormlight && stormlight[2]) ? 'folder' : 'album');
			rawTitle = rawTitle.replace(/^.*stormlight archive\s*(\[\d+(?:\.\d+)?\]|\d+)?\s*[:\-]?\s*/i, '');
		}
	}
	const leadNum = String(leaf).match(/^\s*(\d+)\s*\./);
	if (!series && leadNum && albums.length) {
		series = cleanTitle(albums[0].title.replace(/\(.*\)/, '')) || null;
		sequence = +leadNum[1];
		seriesSource = series ? 'album' : null;
		sequenceSource = leafSource;
	}
	// A loose book's number with no series beside it waits for buildCatalog to find the series on
	// a sibling cut from the same folder.
	let numberOnly = false;
	if (book && book.number !== null && sequence === null) {
		sequence = book.number;
		sequenceSource = book.numberSource;
		if (series) seriesWeak = false;
		else numberOnly = true;
	}

	const evidence = ts.flatMap((t) => [t.title, segmentsOf(t).pop()]);
	let title = cleanTitle(rawTitle) || cleanTitle(leaf);
	title = smartTitle(restoreApostrophes(title, evidence));
	if (isGenericName(title)) doubts.push({ code: 'generic-title', title });
	if (genericLeaf && !singleAlbum) {
		// The leaf name only: a drive letter or a full folder path would leak into a public reply.
		doubts.push({ code: 'generic-folder', folder: /^[A-Za-z]:$/.test(rawLeaf) ? null : rawLeaf, albums: albums.length });
	}
	series = series ? smartTitle(cleanTitle(series) || series) : null;
	if (!series) seriesSource = null;

	const parens = [
		...(!genericLeaf ? [{ raw: leaf, source: leafSource }] : []),
		...(book ? [] : albums.map((a) => ({ raw: a.title, source: 'album' }))),
	].map((p) => ({ ...p, value: parenOf(p.raw) })).filter((p) => p.value && !EDITION_ONLY_RE.test(p.value));
	const paren = parens[0] || null;
	const edition = (paren && paren.value) || publisher || null;
	const editionSource = paren ? paren.source : (publisher ? publisherSource : null);
	const idEdition = book
		? (paren && paren.value) || legacyPublisher || null
		: parenOf(rawLeaf) || albums.map((a) => parenOf(a.title)).find(Boolean) || legacyPublisher || null;

	let narrator = null, narratorSource = null;
	if (paren) {
		if (!truncatedParen(paren.raw) && paren.value !== publisher && !publisherOf(paren.value)) {
			narrator = paren.value;
			narratorSource = paren.source;
		}
	} else {
		narrator = tagList.map((tg) => narratorName(tg.narrator) || narratorFromComment(tg.comment)).find(Boolean) || null;
		narratorSource = narrator ? 'tag' : null;
	}

	const titleWithoutWeakSeries = weakFull ? smartTitle(restoreApostrophes(cleanTitle(weakFull), evidence)) : title;
	return {
		title, titleWithoutWeakSeries, author, authorSource, series, sequence, seriesWeak, numberOnly, edition, idEdition, publisher, narrator,
		albums, doubts,
		sources: {
			title: titleSource,
			author: authorSource ? AUTHOR_SOURCE[authorSource] : null,
			narrator: narratorSource,
			edition: editionSource,
			publisher: publisher ? publisherSource : null,
			series: seriesSource,
			sequence: sequence === null ? null : sequenceSource,
		},
	};
}

/** The four override lists and maps, with anything malformed read as absent. */
function cleanOverrides(raw) {
	const o = isObject(raw) ? raw : {};
	const map = (v) => (isObject(v) ? v : {});
	const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
	return {
		authors: map(o.authors),
		works: map(o.works),
		include: list(o.include),
		exclude: list(o.exclude),
		podcastArtists: list(o.podcastArtists),
	};
}

function toList(works) {
	if (Array.isArray(works)) return works.filter(isObject);
	return isObject(works) ? Object.values(works).filter(isObject) : [];
}

function sortKey(w) {
	return `${w.author || ''} ${w.series || ''} ${String(w.sequence ?? 999).padStart(5, '0')} ${w.title || ''}`;
}

function toObject(list) {
	const out = {};
	for (const w of [...list].sort((a, b) => natural(sortKey(a), sortKey(b)) || natural(a.id, b.id))) out[w.id] = w;
	return out;
}

function reorderParts(w, partOrder) {
	const byName = new Map();
	for (const p of w.parts) {
		const k = String(p.file || '').toLowerCase();
		if (!byName.has(k)) byName.set(k, []);
		byName.get(k).push(p);
	}
	const used = new Set();
	const ordered = [];
	const missing = [];
	for (const name of partOrder) {
		const k = basename(name).toLowerCase();
		const pick = (byName.get(k) || []).find((p) => !used.has(p));
		if (!pick) { missing.push(String(name)); continue; }
		used.add(pick);
		ordered.push(pick);
	}
	const rest = w.parts.filter((p) => !used.has(p));
	w.parts = [...ordered, ...rest].map((p, i) => ({ ...p, ordinal: i + 1 }));
	w.orderMethod = 'override';
	if (missing.length) w.notes.push(`partOrder names ${missing.length} file(s) not in this work: ${missing.slice(0, 3).join(', ')}`);
	if (rest.length) w.notes.push(`partOrder leaves ${rest.length} part(s) unlisted; they play after the listed ones`);
	if (!missing.length && !rest.length) w.confidence = 'high';
}

// `!book edit exclude` writes the work's folder beside the flag. No naming rule moves a folder, so
// the exclude holds after the id it was written under stops being the one detection gives.
function excludedFoldersOf(works) {
	return new Set(Object.values(works)
		.filter((e) => isObject(e) && e.exclude === true && nonEmpty(e.folderKey))
		.map((e) => matchKey(e.folderKey)));
}

/**
 * Work-level overrides: author series and order, and per-work title, series, sequence, narrator,
 * edition, partOrder, exclude and pinId. Entries are keyed by the id detection gave the work, so
 * a title or pinId override cannot stop its own entry from matching on the next build.
 * @returns {Object<string, object>} new works keyed by (possibly pinned) id, sorted
 */
function applyOverrides(works, overrides) {
	const ov = cleanOverrides(overrides);
	const list = toList(works).map((w) => ({
		...w,
		aliases: Array.isArray(w.aliases) ? [...w.aliases] : [],
		notes: Array.isArray(w.notes) ? [...w.notes] : [],
		parts: Array.isArray(w.parts) ? w.parts : [],
	}));
	const taken = new Set(list.map((w) => w.id));
	const excludedFolders = excludedFoldersOf(ov.works);
	const out = [];
	for (const w of list) {
		if (w.folderKey && excludedFolders.has(matchKey(w.folderKey))) continue;
		const a = own(ov.authors, slug(w.author));
		if (isObject(a)) {
			if (isObject(a.order)) {
				const hit = Object.keys(a.order).find((k) => slug(k) === slug(w.title));
				if (hit !== undefined && Number.isFinite(Number(a.order[hit]))) {
					if (nonEmpty(a.series)) w.series = a.series.trim();
					w.sequence = Number(a.order[hit]);
				}
			} else if (nonEmpty(a.series) && !w.series) {
				w.series = a.series.trim();
			}
		}

		const o = own(ov.works, w.id);
		if (!isObject(o)) { out.push(w); continue; }
		if (o.exclude === true) continue;
		for (const field of ['title', 'series', 'narrator', 'edition']) {
			if (nonEmpty(o[field])) w[field] = o[field].trim();
			else if (o[field] === null && field !== 'title') w[field] = null;
		}
		if (o.sequence === null) w.sequence = null;
		else if (o.sequence !== undefined && o.sequence !== '' && Number.isFinite(Number(o.sequence))) w.sequence = Number(o.sequence);
		if (Array.isArray(o.partOrder) && o.partOrder.length) {
			reorderParts(w, o.partOrder);
			w.totalMs = w.parts.reduce((s, p) => s + (p.durationMs || 0), 0);
		}
		if (nonEmpty(o.pinId) && o.pinId.trim() !== w.id) {
			const pin = o.pinId.trim();
			if (taken.has(pin)) {
				w.notes.push(`pinId ${pin} ignored: another work already has that id`);
			} else {
				taken.delete(w.id);
				taken.add(pin);
				if (!w.aliases.includes(w.id)) w.aliases.push(w.id);
				w.id = pin;
			}
		}
		out.push(w);
	}
	for (const w of out) w.aliases = w.aliases.filter((x) => x !== w.id);
	return toObject(out);
}

// The larger of the share of parts and the share of listening time: a work that wrongly held one
// long book file and eleven short songs is that book, and a bookmark saved in it follows the book.
function shareOf(parts, keyOf, keys) {
	if (!parts.length) return 0;
	const hit = parts.filter((p) => { const k = keyOf(p); return k !== null && keys.has(k); });
	const byCount = hit.length / parts.length;
	const total = parts.reduce((sum, p) => sum + (Number(p.durationMs) || 0), 0);
	const byTime = total > 0 ? hit.reduce((sum, p) => sum + (Number(p.durationMs) || 0), 0) / total : 0;
	return Math.max(byCount, byTime);
}

const HEIR_KEYS = [
	[(p) => String(p.trackRatingKey), (c) => c.rks],
	[(p) => (p.sizeBytes ? `${String(p.file || '').toLowerCase()}#${p.sizeBytes}` : null), (c) => c.sized],
	[(p) => (p.file ? String(p.file).toLowerCase() : null), (c) => c.names],
];

// One old work a rule change cut into several books: no new work holds half of it, yet together
// they hold most of it. The old work was named after the book of its first part, so that book
// inherits the id and every alias, and a bookmark saved under any of them still opens.
function splitHeir(parts, keyed) {
	const first = [...parts].sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0))[0];
	for (const [keyOf, setOf] of HEIR_KEYS) {
		const holders = keyed.filter((c) => parts.some((p) => { const k = keyOf(p); return k !== null && setOf(c).has(k); }));
		if (holders.length < 2) continue;
		const union = new Set(holders.flatMap((c) => [...setOf(c)]));
		if (shareOf(parts, keyOf, union) < 0.5) continue;
		const k = keyOf(first);
		const heirs = k === null ? [] : holders.filter((c) => setOf(c).has(k));
		return heirs.length === 1 ? heirs[0].w : null;
	}
	return null;
}

/**
 * Carries ids forward across a rebuild. A work whose id changed (a renamed folder, a corrected
 * title) is found again by its tracks, and its old id becomes an alias, so bookmarks saved under
 * it still resolve. Matching tries track ratingKeys, then basename plus size, then basename alone;
 * at least half the old parts, or half the old listening time, must match, and a tie between
 * candidates matches nothing (two narrations of one book share every basename). A work split into
 * several, none holding half of it, goes to the one holding its first part.
 * @returns {{ works: Object<string, object>, moved: Object<string, string> }} new works with
 *   aliases filled, and old id to new id for every work that moved
 */
function matchAliases(oldWorks, newWorks) {
	const olds = toList(oldWorks);
	const news = toList(newWorks).map((w) => ({ ...w, aliases: Array.isArray(w.aliases) ? [...w.aliases] : [] }));
	const newById = new Map(news.map((w) => [w.id, w]));
	const oldIds = new Set(olds.map((w) => w.id));
	const moved = {};

	for (const o of olds) {
		const same = newById.get(o.id);
		if (same) {
			for (const a of o.aliases || []) if (!same.aliases.includes(a)) same.aliases.push(a);
		}
	}

	const keyed = news.map((w) => {
		const parts = Array.isArray(w.parts) ? w.parts : [];
		return {
			w,
			isNew: !oldIds.has(w.id),
			rks: new Set(parts.map((p) => String(p.trackRatingKey))),
			sized: new Set(parts.map((p) => `${String(p.file || '').toLowerCase()}#${p.sizeBytes}`)),
			names: new Set(parts.map((p) => String(p.file || '').toLowerCase())),
		};
	});
	const aliased = new Set(news.flatMap((w) => w.aliases));

	for (const o of olds) {
		if (newById.has(o.id) || aliased.has(o.id)) continue;
		const parts = Array.isArray(o.parts) ? o.parts : [];
		if (!parts.length) continue;
		const tiers = [
			(c) => shareOf(parts, (p) => String(p.trackRatingKey), c.rks),
			(c) => shareOf(parts, (p) => (p.sizeBytes ? `${String(p.file || '').toLowerCase()}#${p.sizeBytes}` : null), c.sized),
			(c) => shareOf(parts, (p) => (p.file ? String(p.file).toLowerCase() : null), c.names),
		];
		let target = null;
		let tied = false;
		for (const score of tiers) {
			const ranked = keyed
				.map((c) => ({ c, s: score(c) }))
				.filter((x) => x.s >= 0.5)
				.sort((a, b) => b.s - a.s || Number(b.c.isNew) - Number(a.c.isNew));
			if (!ranked.length) continue;
			const [best, second] = ranked;
			if (second && second.s === best.s && second.c.isNew === best.c.isNew) { tied = true; break; }
			target = best.c.w;
			break;
		}
		if (!target && !tied) target = splitHeir(parts, keyed);
		if (!target) continue;
		for (const a of [o.id, ...(o.aliases || [])]) {
			if (a !== target.id && !newById.has(a) && !target.aliases.includes(a)) target.aliases.push(a);
		}
		moved[o.id] = target.id;
	}

	const out = {};
	for (const w of news) {
		w.aliases = w.aliases.filter((a) => a !== w.id && !newById.has(a));
		out[w.id] = w;
	}
	return { works: out, moved };
}

const CARRIED_FIELDS = ['exclude', 'partOrder', 'pinId'];

/**
 * Copies an exclude, partOrder or pinId written under an id a work had before (one a rule change
 * or a late tag moved, kept as an alias) onto the id detection gives it now. applyOverrides reads
 * those by the detected id alone, so they would silently stop applying; display fields need no
 * copy, since helpers/bookMetadata.js finds an entry under every alias. The file is never
 * written, so this runs on every build, from the old catalog's ids and aliases.
 * @param {object} overrides the parsed book_overrides.json
 * @param {Object|Array} oldWorks the catalog before this build
 * @param {Object|Array} newWorks a build of the same listing with those overrides
 * @param {Object<string, string>} [moved] matchAliases(oldWorks, newWorks).moved
 * @returns {{ overrides: object, carried: Array<{ from: string, to: string, fields: string[] }> }}
 *   overrides is a new object when anything was carried, otherwise the one given
 */
function carryOverrides(overrides, oldWorks, newWorks, moved = {}) {
	const ov = cleanOverrides(overrides);
	const news = toList(newWorks);
	const newIds = new Set(news.map((w) => w.id));
	const pinned = new Set(Object.values(ov.works).filter((e) => isObject(e) && nonEmpty(e.pinId)).map((e) => e.pinId.trim()));
	const olds = new Map(toList(oldWorks).map((w) => [w.id, w]));
	const oldOf = new Map();
	for (const [from, to] of Object.entries(isObject(moved) ? moved : {})) if (olds.has(from)) oldOf.set(to, olds.get(from));
	const works = { ...ov.works };
	const carried = [];
	for (const w of news) {
		// Already pinned: its entry was found under the id detection gave.
		if (pinned.has(w.id)) continue;
		const old = olds.get(w.id) || oldOf.get(w.id);
		if (!old) continue;
		for (const from of [old.id, ...(Array.isArray(old.aliases) ? old.aliases : [])]) {
			// An id another work holds in this build is that work's entry, never this one's.
			if (from === w.id || newIds.has(from)) continue;
			const e = own(works, from);
			if (!isObject(e)) continue;
			const target = isObject(own(works, w.id)) ? works[w.id] : {};
			const fields = CARRIED_FIELDS.filter((f) => e[f] !== undefined && target[f] === undefined);
			if (!fields.length) continue;
			works[w.id] = { ...target, ...Object.fromEntries(fields.map((f) => [f, e[f]])) };
			carried.push({ from, to: w.id, fields });
		}
	}
	if (!carried.length) return { overrides, carried };
	return { overrides: { ...(isObject(overrides) ? overrides : {}), works }, carried };
}

/**
 * The doubts still worth showing and acting on. A 'split' is told on the rescan's split line
 * instead, and a title or author the owner set by hand means the grouping has been looked at, so
 * `!book rescan` and the online lookup's eligibility agree on which books are doubtful.
 * @param {object} work a catalog work
 * @param {object|null} [override] its book_overrides.json `works` entry, if any
 */
function openDoubts(work, override = null) {
	if (!isObject(work) || !Array.isArray(work.doubts)) return [];
	const doubts = work.doubts.filter((d) => isObject(d) && d.code !== 'split');
	if (!doubts.length) return [];
	if (isObject(override) && (nonEmpty(override.title) || nonEmpty(override.author))) return [];
	// A catalog saved before the metadata layer has no sources, only detection to compare with.
	if (isObject(work.sources)) {
		if (work.sources.title === 'override' || work.sources.author === 'override') return [];
	} else if (isObject(work.detected) && (work.title !== work.detected.title || work.author !== work.detected.author)) {
		return [];
	}
	return doubts;
}

/**
 * The membership lists music pickers filter by. albumKeys holds only albums whose every track is
 * catalogued; artistKeys holds artists whose every album is, the artists of detected podcasts
 * (so a new episode album stays out of music before any rebuild sees it) and podcastArtists.
 * @param {Object|Array} works
 * @param {{ albums?: object[], tracks?: object[] }} library the Plex listing the works came from
 * @param {object} [overrides]
 */
function buildIndex(works, { albums = [], tracks = [] } = {}, overrides = {}) {
	const ov = cleanOverrides(overrides);
	const list = toList(works);
	const trackKeys = new Set();
	const partIds = new Set();
	const add = (p) => {
		if (p.trackRatingKey !== undefined && p.trackRatingKey !== null) trackKeys.add(String(p.trackRatingKey));
		const id = partIdOf(p.partKey);
		if (id) partIds.add(id);
	};
	for (const w of list) {
		for (const p of w.parts || []) add(p);
		for (const p of w.dropped || []) add(p);
	}

	const tracksByKey = new Map();
	const albumTracks = new Map();
	const artistAlbums = new Map();
	const link = (artist, album) => {
		if (artist === undefined || artist === null) return;
		const k = String(artist);
		if (!artistAlbums.has(k)) artistAlbums.set(k, new Set());
		artistAlbums.get(k).add(String(album));
	};
	for (const t of tracks) {
		tracksByKey.set(String(t.ratingKey), t);
		const a = String(t.parentRatingKey);
		if (!albumTracks.has(a)) albumTracks.set(a, new Set());
		albumTracks.get(a).add(String(t.ratingKey));
		link(t.grandparentRatingKey, a);
	}
	for (const a of albums) link(a.parentRatingKey, a.ratingKey);

	const albumKeys = new Set();
	for (const [a, ts] of albumTracks) {
		if (ts.size && [...ts].every((k) => trackKeys.has(k))) albumKeys.add(a);
	}
	const artistKeys = new Set();
	for (const [artist, as] of artistAlbums) {
		if (as.size && [...as].every((a) => albumKeys.has(a))) artistKeys.add(artist);
	}
	for (const w of list) {
		if (w.kind !== 'podcast') continue;
		for (const p of w.parts || []) {
			const t = tracksByKey.get(String(p.trackRatingKey));
			if (t && t.grandparentRatingKey !== undefined && t.grandparentRatingKey !== null) artistKeys.add(String(t.grandparentRatingKey));
		}
	}
	for (const a of ov.podcastArtists) artistKeys.add(a);

	const sorted = (set) => [...set].sort(natural);
	return { trackKeys: sorted(trackKeys), albumKeys: sorted(albumKeys), artistKeys: sorted(artistKeys), partIds: sorted(partIds) };
}

function partFrom(t, ordinal, chapters) {
	const p = partOf(t);
	const out = {
		ordinal,
		albumRatingKey: String(t.parentRatingKey),
		trackRatingKey: String(t.ratingKey),
		title: t.title,
		durationMs: t.duration || 0,
		partKey: p.key || null,
		file: segmentsOf(t).pop() || null,
		sizeBytes: p.size || null,
		container: containerOf(t),
	};
	const ch = own(chapters, String(t.ratingKey));
	const list = Array.isArray(ch) ? normalizeChapters(ch) : ch;
	if (Array.isArray(list)) out.chapters = list.map((c) => ({ title: c.title, startMs: c.startMs, endMs: c.endMs }));
	return { part: out, markers: list === 'markers' };
}

/**
 * @param {object} input
 * @param {object[]} input.albums   Plex type=9 listing
 * @param {object[]} input.tracks   Plex type=10 listing, with Media and Part
 * @param {Object<string, Array|'markers'|'none'>} [input.chapters] by track ratingKey: a Plex
 *   `Chapter` array or a normalizeChapters() result
 * @param {object} [input.overrides] the hand-edited overrides file
 * @param {Object<string, {tags: object}>} [input.tags] embedded tags of one sampled file per
 *   album, keyed by album ratingKey (bookTags.read().byAlbum)
 * @param {Object<string, {tags: object}>} [input.trackTags] embedded tags by track ratingKey
 *   (bookTags.read().byTrack): every file of a group that may hold single-file books
 * @param {string[]} [input.roots] the music sections' folders
 * @returns {{ works: Object<string, object>, rejected: object[], splits: object[], index: object,
 *   notes: string[] }} splits: one { folderKey, album, albumTitle, tracks, reason } per music
 *   album taken out of a book's folder group
 */
function buildCatalog({ albums = [], tracks = [], chapters = {}, overrides = {}, tags = {}, trackTags = {}, roots = [] } = {}) {
	const ov = cleanOverrides(overrides);
	const albumsByKey = new Map(albums.map((a) => [String(a.ratingKey), a]));
	const tagsOf = (k) => { const e = own(tags, String(k)); return (isObject(e) && isObject(e.tags) && e.tags) || {}; };
	const albumSize = new Map();
	for (const t of tracks) albumSize.set(albumOf(t), (albumSize.get(albumOf(t)) || 0) + 1);
	// An album of one file was sampled on that very file.
	const tagsOfTrack = (t) => {
		const e = own(trackTags, String(t.ratingKey));
		if (isObject(e) && isObject(e.tags)) return e.tags;
		return albumSize.get(albumOf(t)) === 1 ? tagsOf(albumOf(t)) : {};
	};
	const classCache = new Map();
	const albumClass = (k) => {
		if (!classCache.has(k)) {
			const a = albumsByKey.get(k);
			classCache.set(k, genreClass([...((a && a.Genre) || []).map((g) => g && g.tag), tagsOf(k).genre]));
		}
		return classCache.get(k);
	};
	const rootKeys = rootSet(roots);
	const splits = [];
	const include = new Set(ov.include.map(matchKey));
	const exclude = new Set(ov.exclude.map(matchKey));
	const notes = [];

	// Album-level includes are carved out before grouping: such an album usually sits in a bucket
	// folder with unrelated music, and including the whole folder would drag that in too.
	const forced = new Map();
	const loose = [];
	for (const t of tracks) {
		const album = String(t.parentRatingKey);
		if (exclude.has(album)) continue;
		if (include.has(album)) {
			const k = `album:${album}`;
			if (!forced.has(k)) forced.set(k, []);
			forced.get(k).push(t);
		} else {
			loose.push(t);
		}
	}
	const groups = groupTracks(loose, { roots });
	for (const [k, ts] of forced) groups.set(k, ts);

	const candidates = [];
	const rejected = [];
	const reject = (key, stats, reason) => rejected.push({
		folderKey: key, tracks: stats.n, hours: +(stats.totalMs / HOUR).toFixed(2),
		medianMin: +(stats.medianMs / MIN).toFixed(1), maxMin: +(stats.maxMs / MIN).toFixed(1), reason,
	});
	const queue = [...groups].map(([key, ts]) => ({ key, ts, first: true }));
	while (queue.length) {
		const { key, ts, first, book = null, parentCls = null } = queue.shift();
		const stats = groupStats(key, ts, albumsByKey, albumClass);
		if (exclude.has(matchKey(key))) { reject(key, stats, 'excluded by override'); continue; }
		const wanted = forced.has(key) || include.has(matchKey(key)) || ts.some((t) => include.has(matchKey(folderKey(t))));
		// A single-file book cut from a classified folder stays a book however short it is.
		const cls = parentCls || classify(stats) || (wanted ? { kind: 'book', rule: 'override' } : null);
		// Only once per group and never on an album the owner included by hand; each piece is
		// classified again on its own.
		const off = cls && first && !forced.has(key) ? musicAlbumsToSplit(ts, albumClass) : [];
		if (off.length) {
			const offSet = new Set(off);
			queue.push({ key, ts: ts.filter((t) => !offSet.has(albumOf(t))), first: false });
			for (const a of off) {
				const piece = ts.filter((t) => albumOf(t) === a);
				const album = albumsByKey.get(a);
				splits.push({ folderKey: key, album: a, albumTitle: album ? album.title : null, tracks: piece.length, reason: 'music-genre' });
				queue.push({ key: `${key}#album:${a}`, ts: piece, first: false });
			}
			continue;
		}
		const pieces = cls && cls.kind === 'book' && !book && !forced.has(key) ? bookPieces(ts, tagsOfTrack) : null;
		if (pieces) {
			for (const p of pieces) queue.push({ key: `${key}#book:${slug(p.book.key)}`, ts: p.ts, first: false, book: { ...p.book, of: pieces.length, baseKey: key }, parentCls: cls });
			continue;
		}
		if (cls) candidates.push({ key, ts, stats, cls, book });
		else if (stats.maxMs >= 15 * MIN || stats.totalMs >= 3 * HOUR) reject(key, stats, stats.totalMs < DETECT.minTotalMs ? 'under 2 h' : (musicVetoed(stats) ? 'music genre' : 'no long-form signal'));
	}

	const titleCounts = new Map();
	for (const c of candidates) {
		for (const k of new Set(c.ts.map((t) => String(t.parentRatingKey)))) {
			const a = albumsByKey.get(k);
			if (a) titleCounts.set(norm(a.title), (titleCounts.get(norm(a.title)) || 0) + 1);
		}
	}

	const tracksByAlbum = new Map();
	for (const t of tracks) {
		const a = String(t.parentRatingKey);
		if (!tracksByAlbum.has(a)) tracksByAlbum.set(a, []);
		tracksByAlbum.get(a).push(t);
	}

	const idEditionOf = new Map();
	const sourcesOf = new Map();
	const bookOf = new Map();
	const works = candidates.map((c) => {
		const d = describe(c.key, c.ts, albumsByKey, titleCounts, tagsOf, rootKeys, c.book, tagsOfTrack);
		const musicAlbums = d.albums.filter((a) => albumClass(String(a.ratingKey)) === 'music');
		if (musicAlbums.length) d.doubts.push({ code: 'music-genre', albums: musicAlbums.map((a) => a.title) });
		const splitOff = splits.filter((sp) => sp.folderKey === c.key);
		// An album with no title stays null: its ratingKey is a Plex id, never shown in a reply.
		if (splitOff.length) d.doubts.push({ code: 'split', albums: splitOff.map((sp) => sp.albumTitle || null) });
		const { parts, method } = orderParts(c.cls.kind, c.key, c.ts);
		const workNotes = [];
		const dupIdx = new Set();
		const seen = new Set();
		for (const t of c.ts) {
			if (t.index === undefined) continue;
			const k = `${t.parentRatingKey}:${t.parentIndex}:${t.index}`;
			if (seen.has(k)) dupIdx.add(k);
			seen.add(k);
		}
		if (dupIdx.size) workNotes.push(`${dupIdx.size} duplicated album/disc/index triples, so the Plex track index cannot order it`);
		if (c.ts.some((t) => t.index === undefined)) workNotes.push('some tracks have no index');
		if (d.albums.length > 1) workNotes.push(`spread over ${d.albums.length} Plex albums`);
		const mine = new Set(c.ts);
		const otherAlbumTracks = d.albums.some((a) => (tracksByAlbum.get(String(a.ratingKey)) || []).some((t) => !mine.has(t)));
		if (otherAlbumTracks) workNotes.push('shares a Plex album with another work');
		if (method === 'interleaved-volumes') workNotes.push('several numbered volumes share one folder; the order is rebuilt from chapter numbers and is worth one check, or a partOrder override');
		if (c.book) workNotes.push(`one of ${c.book.of} books in one folder, told apart by ${c.book.source === 'tag' ? 'their album tags' : 'their file names'}`);
		const kept = new Set(parts);
		const droppedTracks = c.ts.filter((t) => !kept.has(t));
		if (droppedTracks.length) workNotes.push(`${droppedTracks.length} sample clip(s) dropped`);

		let confidence = 'high';
		if (method === 'interleaved-volumes') confidence = 'low';
		else if (method === 'episode-number' || d.albums.length > 1 || dupIdx.size || otherAlbumTracks) confidence = 'medium';
		if (c.cls.rule !== 'median' && c.cls.rule !== 'episodes' && confidence === 'high') confidence = 'medium';

		let markers = false;
		const outParts = parts.map((t, i) => {
			const r = partFrom(t, i + 1, chapters);
			markers = markers || r.markers;
			return r.part;
		});
		if (markers) workNotes.push('some parts carry "Marker N" points rather than chapters; they are ignored');

		const podcastSeries = c.cls.kind === 'podcast' && !d.series;
		const series = podcastSeries ? d.author : d.series;
		const w = {
			id: null,
			kind: c.cls.kind,
			title: d.title,
			author: d.author,
			narrator: d.narrator,
			edition: d.edition,
			// Kept apart from edition, which holds the narrator's name when there is one and so
			// hides a GraphicAudio edition from the read-along's "dramatized" label.
			publisher: d.publisher || null,
			series: series || null,
			sequence: d.sequence ?? null,
			seriesWeak: d.seriesWeak,
			titleWithoutWeakSeries: d.titleWithoutWeakSeries,
			authorSource: d.authorSource,
			doubts: d.doubts,
			confidence,
			aliases: [],
			totalMs: outParts.reduce((s, p) => s + p.durationMs, 0),
			folderKey: c.key,
			// part.file keeps only the basename, and folderKey is a grouping key rather than a real
			// folder, yet sidecar EPUBs sit beside the audio files themselves.
			dirs: [...new Set(parts.map(dirOfTrack))].filter(Boolean).sort(natural),
			detectedBy: c.cls.rule,
			orderMethod: method,
			notes: workNotes,
			parts: outParts,
			dropped: droppedTracks.map((t) => ({
				trackRatingKey: String(t.ratingKey), albumRatingKey: String(t.parentRatingKey), partKey: partOf(t).key || null,
			})),
		};
		idEditionOf.set(w, d.idEdition);
		sourcesOf.set(w, podcastSeries ? { ...d.sources, series: d.author ? d.sources.author : null } : d.sources);
		if (c.book) bookOf.set(w, { baseKey: c.book.baseKey, numberOnly: d.numberOnly });
		return w;
	});

	// Books cut from one folder, by one author, where one names its series and the rest only carry
	// a number ("#2 Title", a track tag): the numbered ones are the same series.
	const siblings = new Map();
	for (const [w, b] of bookOf) {
		const k = `${b.baseKey}\n${norm(w.author)}`;
		if (!siblings.has(k)) siblings.set(k, []);
		siblings.get(k).push(w);
	}
	for (const group of siblings.values()) {
		const named = group.filter((w) => w.series && !w.seriesWeak);
		const names = new Set(named.map((w) => norm(w.series)));
		for (const w of group) {
			if (!bookOf.get(w).numberOnly) continue;
			if (names.size === 1) {
				w.series = named[0].series;
				sourcesOf.set(w, { ...sourcesOf.get(w), series: sourcesOf.get(named[0]).series });
			} else {
				w.sequence = null;
				sourcesOf.set(w, { ...sourcesOf.get(w), sequence: null });
			}
		}
	}

	// "Series: Title" without a number names a series only when another work names it with one,
	// or a number turned up elsewhere: "Something: A Brief History" is a subtitle.
	const strongSeries = new Set(works.filter((w) => w.series && !w.seriesWeak).map((w) => norm(w.series)));
	for (const w of works) {
		if (w.seriesWeak && !strongSeries.has(norm(w.series)) && w.sequence === null) {
			const podcast = w.kind === 'podcast';
			w.series = podcast ? w.author : null;
			w.title = w.titleWithoutWeakSeries;
			const s = sourcesOf.get(w);
			sourcesOf.set(w, { ...s, series: podcast && w.author ? s.author : null });
		}
		delete w.seriesWeak;
		delete w.titleWithoutWeakSeries;
	}

	// What detection and tags found, before any override, for the metadata layers to start from.
	for (const w of works) {
		w.detected = {
			title: w.title, author: w.author, narrator: w.narrator, edition: w.edition, publisher: w.publisher,
			series: w.series, sequence: w.sequence, sources: sourcesOf.get(w),
		};
	}

	// Stable ids: author/title, with the edition appended only where two works would collide. The
	// suffix input is frozen at its version 2 derivation, so a publisher learned from tags never
	// turns a folder suffix into "~graphicaudio".
	const base = (w) => `${slug(w.kind === 'podcast' ? (w.series || w.author) : w.author)}/${slug(w.title)}`;
	const counts = {};
	for (const w of works) counts[base(w)] = (counts[base(w)] || 0) + 1;
	for (const w of works) w.id = counts[base(w)] > 1 ? `${base(w)}~${slug(idEditionOf.get(w) || w.folderKey)}` : base(w);

	const detected = new Set(works.map((w) => w.id));
	const excludedFolders = excludedFoldersOf(ov.works);
	const heldFolders = new Set(works.map((w) => matchKey(w.folderKey)).filter((k) => excludedFolders.has(k)));
	for (const [id, e] of Object.entries(ov.works)) {
		if (detected.has(id)) continue;
		if (isObject(e) && e.exclude === true && nonEmpty(e.folderKey) && heldFolders.has(matchKey(e.folderKey))) continue;
		notes.push(`overrides name a work that was not detected: ${id}`);
	}

	const final = applyOverrides(works, ov);
	return { works: final, rejected, splits, index: buildIndex(final, { albums, tracks }, ov), notes };
}

/**
 * The files whose embedded tags are worth reading: one per Plex album (its first non-sample track
 * by disc and index), only for albums inside a folder group long enough to be a book (2 h in
 * all, or a track of 15 min). Grouped exactly as buildCatalog groups, so a stray disc folder is
 * judged on its own. A group that may hold several single-file books has every other member file
 * listed after the album samples, without an album: Plex can file several books as one album,
 * and only each file's own tags tell them apart.
 * @param {object[]} tracks
 * @param {{ roots?: string[] }} [ctx]
 * @returns {Array<{ album?: string, track: string, file: string, sizeBytes: number|null }>}
 */
function tagSamples(tracks = [], { roots = [] } = {}) {
	const want = new Set();
	const perFileGroups = [];
	for (const ts of groupTracks(tracks, { roots }).values()) {
		const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
		const max = ts.reduce((m, t) => Math.max(m, t.duration || 0), 0);
		if (total < DETECT.minTotalMs && max < DETECT.medianLongMs) continue;
		for (const t of ts) want.add(albumOf(t));
		if (mayHoldSingleFileBooks(ts)) perFileGroups.push(ts.filter((t) => !isSample(t)));
	}
	// Smallest groups first: a handful of loose books is read before a 35-part book whose parts
	// all name the same album, should the first build's tag budget run out.
	const perFile = perFileGroups.sort((a, b) => a.length - b.length).flat();
	const byAlbum = new Map();
	for (const t of tracks) {
		const a = albumOf(t);
		if (!want.has(a)) continue;
		if (!byAlbum.has(a)) byAlbum.set(a, []);
		byAlbum.get(a).push(t);
	}
	const out = [];
	for (const [album, ts] of byAlbum) {
		const sorted = [...ts].sort((x, y) => (x.parentIndex || 0) - (y.parentIndex || 0) || (x.index || 0) - (y.index || 0));
		const t = sorted.find((x) => !isSample(x)) || sorted[0];
		const p = partOf(t);
		if (!p.file) continue;
		out.push({ album, track: String(t.ratingKey), file: String(p.file), sizeBytes: p.size || null });
	}
	const listed = new Set(out.map((s) => s.track));
	for (const t of perFile) {
		const p = partOf(t);
		if (!p.file || listed.has(String(t.ratingKey))) continue;
		listed.add(String(t.ratingKey));
		out.push({ track: String(t.ratingKey), file: String(p.file), sizeBytes: p.size || null });
	}
	return out;
}

module.exports = {
	RULES_VERSION,
	DETECT,
	buildCatalog,
	applyOverrides,
	matchAliases,
	carryOverrides,
	openDoubts,
	buildIndex,
	normalizeChapters,
	wantsChapters,
	cleanOverrides,
	folderKey,
	stripPartMarker,
	splitArtist,
	classify,
	orderInterleaved,
	cleanTitle,
	norm,
	slug,
	basename,
	partIdOf,
	groupTracks,
	tagSamples,
	publisherOf,
	genreClass,
	isGenericName,
	smartTitle,
	restoreApostrophes,
	parseSeriesTitle,
	authorFromCopyright,
	authorFromComment,
	narratorFromComment,
	isVarious,
	bookIdentity,
	numberedName,
};
