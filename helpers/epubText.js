// helpers/epubText.js
//
// EPUB -> plain text sections for the read-along. Pure: no side effects at require, no logging.
// It runs inside the Below-Normal parse child (epubTextWorker.js), never on the bot's main thread,
// because a 100 MB image-heavy EPUB is several seconds of synchronous inflating and regex work.
//
// Output contract (ARCHITECTURE "Read-along"): sections in reading order, cut at every table of
// contents target, each with its paragraphs and a word count from WORD_RE, which
// readAlongModel.js must tokenise identically (a test cross-checks the two).

const pathMod = require('path');
const zlib = require('zlib');

const EXTRACTOR_VERSION = 1;
const MAX_SECTION_WORDS = 20000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
// Ten times the longest novels' text; anything bigger is not a book the pager could page sanely.
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
// Every document the parse inflates, together (images are never inflated). Markup is a few times
// its text, so past this the book is too large; without it a small zip of many highly
// compressible entries, each under MAX_ENTRY_BYTES, runs the parse child out of memory.
const MAX_INFLATED_BYTES = 4 * MAX_TEXT_BYTES;
// A central directory this large means a corrupt or hostile file, not an ebook.
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_LABEL_CHARS = 300;

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;

const FONT_OBFUSCATION_ALGORITHMS = new Set([
	'http://www.idpf.org/2008/embedding',
	'http://ns.adobe.com/pdf/enc#RC'
]);
const FONT_FILE = /\.(otf|ttf|woff2?)$/i;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;

class EpubError extends Error {
	constructor(code, detail) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = 'EpubError';
		this.code = code;
	}
}

function bufferSource(bytes) {
	return {
		size: bytes.length,
		read(pos, len) {
			if (pos < 0 || len < 0 || pos + len > bytes.length) throw new EpubError('bad-zip', 'read past the end of the file');
			return bytes.subarray(pos, pos + len);
		},
		close() {}
	};
}

// fs is always called as fs.xxxSync(...) and never destructured, so a test can hand in a
// recording fs and see every byte range the reader touches.
function fileSource(filePath, fs) {
	const fd = fs.openSync(filePath, 'r');
	let size;
	try {
		size = fs.fstatSync(fd).size;
	} catch (err) {
		fs.closeSync(fd);
		throw err;
	}
	let closed = false;
	return {
		size,
		read(pos, len) {
			if (pos < 0 || len < 0 || pos + len > size) throw new EpubError('bad-zip', 'read past the end of the file');
			const buf = Buffer.allocUnsafe(len);
			let off = 0;
			while (off < len) {
				const n = fs.readSync(fd, buf, off, len - off, pos + off);
				if (!n) throw new EpubError('bad-zip', 'unexpected end of file');
				off += n;
			}
			return buf;
		},
		close() {
			if (closed) return;
			closed = true;
			fs.closeSync(fd);
		}
	};
}

function findEocd(tail) {
	for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
		if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
		// A stray signature inside the comment would claim a comment running past the end.
		if (i + EOCD_SIZE + tail.readUInt16LE(i + 20) <= tail.length) return i;
	}
	return -1;
}

function openZip(input, { fs = require('fs'), maxEntryBytes = MAX_ENTRY_BYTES, maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
	if (!input || (!input.path && !Buffer.isBuffer(input.bytes))) throw new TypeError('openZip needs { path } or { bytes }');
	const src = input.path ? fileSource(input.path, fs) : bufferSource(input.bytes);
	try {
		return readDirectory(src, maxEntryBytes, maxInflatedBytes);
	} catch (err) {
		src.close();
		throw err;
	}
}

function readDirectory(src, maxEntryBytes, maxInflatedBytes) {
	const size = src.size;
	if (size < EOCD_SIZE) throw new EpubError('not-zip', 'file too small');
	// EPUBs almost never carry a zip comment, so the record is nearly always the last 22 bytes
	// (plus 20 for a zip64 locator). Only otherwise scan the last 64 KB, which on an image-heavy
	// book would mean reading the end of a large image for nothing.
	let tailLen = Math.min(size, EOCD_SIZE + 20);
	let tailStart = size - tailLen;
	let tail = src.read(tailStart, tailLen);
	let eocd = tailLen - EOCD_SIZE;
	if (tail.readUInt32LE(eocd) !== SIG_EOCD || tail.readUInt16LE(eocd + 20) !== 0) {
		tailLen = Math.min(size, EOCD_SIZE + MAX_ZIP_COMMENT);
		tailStart = size - tailLen;
		tail = src.read(tailStart, tailLen);
		eocd = findEocd(tail);
	}
	if (eocd < 0) throw new EpubError('not-zip', 'no end of central directory');
	if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw new EpubError('zip64');
	const disk = tail.readUInt16LE(eocd + 4);
	const cdDisk = tail.readUInt16LE(eocd + 6);
	const countOnDisk = tail.readUInt16LE(eocd + 8);
	const count = tail.readUInt16LE(eocd + 10);
	const cdSize = tail.readUInt32LE(eocd + 12);
	const cdOffset = tail.readUInt32LE(eocd + 16);
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new EpubError('zip64');
	if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) throw new EpubError('bad-zip', 'multi-disk archive');
	if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw new EpubError('bad-zip', 'central directory too large');
	if (cdOffset + cdSize > tailStart + eocd) throw new EpubError('bad-zip', 'central directory runs past its end');
	const cd = src.read(cdOffset, cdSize);

	const entries = new Map();
	const folded = new Map();
	let p = 0;
	for (let n = 0; n < count; n++) {
		if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new EpubError('bad-zip', 'truncated central directory');
		const flags = cd.readUInt16LE(p + 8);
		const method = cd.readUInt16LE(p + 10);
		const csize = cd.readUInt32LE(p + 20);
		const usize = cd.readUInt32LE(p + 24);
		const nameLen = cd.readUInt16LE(p + 28);
		const extraLen = cd.readUInt16LE(p + 30);
		const commentLen = cd.readUInt16LE(p + 32);
		const local = cd.readUInt32LE(p + 42);
		if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new EpubError('zip64');
		if (p + 46 + nameLen > cd.length) throw new EpubError('bad-zip', 'truncated central directory');
		const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;
		if (name.endsWith('/')) continue;
		const entry = { name, flags, method, csize, usize, local };
		entries.set(name, entry);
		const key = name.toLowerCase();
		if (!folded.has(key)) folded.set(key, entry);
	}

	// Hand-made EPUBs sometimes reference "Text/Ch1.xhtml" for a "text/ch1.xhtml" entry; readers
	// forgive it, so the exact name wins and a case-insensitive match is the fallback.
	const lookup = name => entries.get(name) || folded.get(String(name).toLowerCase()) || null;
	let inflated = 0;

	function read(name) {
		const e = lookup(name);
		if (!e) return null;
		if (e.flags & 1) throw new EpubError('drm', 'zip-encrypted entry');
		if (e.method !== 0 && e.method !== 8) throw new EpubError('unsupported-compression', `method ${e.method}`);
		if (e.usize > maxEntryBytes || (e.method === 0 && e.csize > maxEntryBytes)) throw new EpubError('entry-too-large');
		const room = maxInflatedBytes - inflated;
		const tooLarge = () => new EpubError('too-large', 'inflated documents over the limit');
		if (e.usize > room || (e.method === 0 && e.csize > room)) throw tooLarge();
		if (e.local + 30 > size) throw new EpubError('bad-zip', 'local header past the end');
		const lh = src.read(e.local, 30);
		if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new EpubError('bad-zip', 'bad local header');
		const start = e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
		if (start + e.csize > size) throw new EpubError('bad-zip', 'entry data past the end');
		const raw = src.read(start, e.csize);
		let out = raw;
		if (e.method === 8) {
			const cap = Math.max(1, Math.min(maxEntryBytes, room));
			try {
				out = zlib.inflateRawSync(raw, { maxOutputLength: cap });
			} catch (err) {
				// The declared size can lie; maxOutputLength is the real zip-bomb guard.
				if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) throw cap < maxEntryBytes ? tooLarge() : new EpubError('entry-too-large');
				throw new EpubError('bad-zip', 'inflate failed');
			}
		}
		inflated += out.length;
		if (inflated > maxInflatedBytes) throw tooLarge();
		return out;
	}

	return {
		names: [...entries.keys()],
		has: name => !!lookup(name),
		read,
		close: () => src.close()
	};
}

function decodeBytes(buf) {
	if (!buf) return null;
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		const swapped = Buffer.from(buf.subarray(2));
		swapped.swap16();
		return swapped.toString('utf16le');
	}
	const s = buf.toString('utf8');
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const NAMED_ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003',
	thinsp: '\u2009', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018',
	rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', sbquo: '\u201a', bdquo: '\u201e',
	laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a', bull: '\u2022',
	middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', sect: '\u00a7',
	para: '\u00b6', dagger: '\u2020', Dagger: '\u2021', prime: '\u2032', Prime: '\u2033',
	times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc',
	frac34: '\u00be', iexcl: '\u00a1', iquest: '\u00bf', cent: '\u00a2', pound: '\u00a3',
	euro: '\u20ac', yen: '\u00a5', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
	eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', euml: '\u00eb', aacute: '\u00e1',
	agrave: '\u00e0', acirc: '\u00e2', auml: '\u00e4', iacute: '\u00ed', iuml: '\u00ef',
	oacute: '\u00f3', ocirc: '\u00f4', ouml: '\u00f6', uacute: '\u00fa', uuml: '\u00fc',
	ccedil: '\u00e7', ntilde: '\u00f1', szlig: '\u00df', Eacute: '\u00c9', Auml: '\u00c4',
	Ouml: '\u00d6', Uuml: '\u00dc', aelig: '\u00e6', oelig: '\u0153'
};

function codePoint(n) {
	if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
	return String.fromCodePoint(n);
}

// One pass, so "&amp;lt;" becomes "&lt;" and never "<".
function decodeEntities(s) {
	return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
		if (body[0] === '#') return codePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
		return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
	});
}

const DROPPED_ELEMENTS = new Set(['head', 'script', 'style', 'svg', 'rt', 'rp', 'math']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const BLOCK_TAGS = /<\/?(?:p|div|h[1-6]|li|blockquote|tr|section|article|aside|figure|figcaption|header|footer|br|hr|ul|ol|dl|dt|dd|table|pre|main|nav|body|html)\b[^>]*>/gi;
const SPACING_TAGS = /<\/?(?:td|th|img)\b[^>]*>/gi;
// Soft hyphens and zero-width joiners split a word under WORD_RE but are invisible in the book.
const INVISIBLE = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g;
const TAG_NAME = /[A-Za-z0-9_]*/y;
const CLOSE_TAGS = new Map();

// Markup is scanned with indexOf, or a regex only ever sees text up to the last place a match
// could end. A lazy or [^>]* regex otherwise rescans to the end of the document from every
// opener with no close, which a 3 KB EPUB of unclosed "<!--" turns into minutes of CPU.
function upTo(s, close) {
	const i = s.lastIndexOf(close);
	return i < 0 ? 0 : i + close.length;
}

function unwrap(s, open, close, keepInside) {
	let out = '';
	let from = 0;
	for (;;) {
		const i = s.indexOf(open, from);
		if (i < 0) break;
		const j = s.indexOf(close, i + open.length);
		if (j < 0) break;
		out += s.slice(from, i) + (keepInside ? s.slice(i + open.length, j) : ' ');
		from = j + close.length;
	}
	return from ? out + s.slice(from) : s;
}

function closeTag(name) {
	let re = CLOSE_TAGS.get(name);
	if (!re) CLOSE_TAGS.set(name, re = new RegExp(`</${name}\\s*>`, 'gi'));
	return re;
}

// The elements named in `names`, in document order, as <name ...>...</name> with the first
// matching close: what /<(name)\b[^>]*>[\s\S]*?<\/\1\s*>/gi finds, without its rescans.
function* elements(s, names) {
	const closeless = new Set();
	let at = 0;
	let gt = -2;
	for (;;) {
		const i = s.indexOf('<', at);
		if (i < 0) return;
		at = i + 1;
		TAG_NAME.lastIndex = at;
		const name = TAG_NAME.exec(s)[0].toLowerCase();
		if (!names.has(name) || closeless.has(name)) continue;
		if (gt !== -1 && gt < i) gt = s.indexOf('>', i);
		if (gt === -1) return;
		const close = closeTag(name);
		close.lastIndex = gt + 1;
		const m = close.exec(s);
		if (!m) {
			closeless.add(name);
			continue;
		}
		yield { start: i, inner: gt + 1, innerEnd: m.index, end: m.index + m[0].length };
		at = m.index + m[0].length;
	}
}

function dropElements(s) {
	let out = '';
	let from = 0;
	for (const e of elements(s, DROPPED_ELEMENTS)) {
		out += s.slice(from, e.start) + ' ';
		from = e.end;
	}
	return from ? out + s.slice(from) : s;
}

function htmlToParagraphs(html) {
	let s = String(html || '');
	s = unwrap(s, '<!--', '-->', false);
	s = unwrap(s, '<![CDATA[', ']]>', true);
	s = dropElements(s);
	// A line break in the source is only whitespace; paragraphs come from block tags.
	s = s.replace(/\s+/g, ' ');
	const cut = upTo(s, '>');
	const tags = s.slice(0, cut)
		.replace(BLOCK_TAGS, '\n')
		.replace(SPACING_TAGS, ' ')
		// Inline tags join their neighbours: "un<em>believ</em>able" is one word on the page.
		.replace(/<[^>]*>/g, '');
	const flat = decodeEntities(tags + s.slice(cut)).replace(INVISIBLE, '');
	const out = [];
	for (const line of flat.split('\n')) {
		const p = line.replace(/\s+/g, ' ').trim();
		if (p) out.push(p);
	}
	return out;
}

function countWords(text) {
	const m = String(text || '').match(WORD_RE);
	return m ? m.length : 0;
}

function attr(tag, name) {
	const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
	if (!m) return null;
	return decodeEntities(m[1] !== undefined ? m[1] : m[2]);
}

function safeDecodeUri(s) {
	try {
		return decodeURIComponent(s);
	} catch (_) {
		return s;
	}
}

function resolveHref(base, href) {
	if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	const hash = href.indexOf('#');
	const file = hash < 0 ? href : href.slice(0, hash);
	const frag = hash < 0 ? '' : safeDecodeUri(href.slice(hash + 1));
	const joined = file
		? pathMod.posix.normalize(pathMod.posix.join(pathMod.posix.dirname(base), safeDecodeUri(file))).replace(/^\.\//, '')
		: base;
	return frag ? `${joined}#${frag}` : joined;
}

function splitHref(href) {
	const hash = href.indexOf('#');
	return hash < 0 ? [href, ''] : [href.slice(0, hash), href.slice(hash + 1)];
}

function inlineText(html) {
	return htmlToParagraphs(html).join(' ').slice(0, MAX_LABEL_CHARS);
}

function inspectDrm(zip, readText) {
	if (zip.has('META-INF/rights.xml')) return { protected: true, reason: 'rights.xml', fontObfuscationOnly: false };
	if (zip.has('META-INF/sinf.xml')) return { protected: true, reason: 'sinf.xml', fontObfuscationOnly: false };
	if (!zip.has('META-INF/encryption.xml')) return { protected: false, reason: null, fontObfuscationOnly: false };
	const enc = readText('META-INF/encryption.xml') || '';
	const algorithms = [...enc.matchAll(/\bAlgorithm\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
	const uris = [...enc.matchAll(/\bURI\s*=\s*["']([^"']+)["']/g)].map(m => safeDecodeUri(m[1].split(/[?#]/)[0]));
	const fontsOnly = algorithms.every(a => FONT_OBFUSCATION_ALGORITHMS.has(a)) && uris.every(u => FONT_FILE.test(u));
	if (!fontsOnly) return { protected: true, reason: 'encryption.xml lists more than font obfuscation', fontObfuscationOnly: false };
	return { protected: false, reason: null, fontObfuscationOnly: uris.length > 0 };
}

function dcValue(opf, tag) {
	const m = opf.match(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}\\s*>`, 'i'));
	if (!m) return null;
	const v = inlineText(m[1]);
	return v || null;
}

function parseNav(xml, base) {
	const nav = xml.match(/<nav\b[^>]*(?:epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["']|role\s*=\s*["']doc-toc["'])[^>]*>([\s\S]*?)<\/nav\s*>/i);
	if (!nav) return [];
	const out = [];
	let depth = 0;
	const re = /<(\/?)ol\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
	let m;
	while ((m = re.exec(nav[1]))) {
		if (m[2] === undefined && m[3] === undefined) {
			depth += m[1] ? -1 : 1;
			continue;
		}
		const href = resolveHref(base, attr(` ${m[2]}`, 'href'));
		if (!href) continue;
		out.push({ label: inlineText(m[3]), href, depth: Math.max(1, depth) });
	}
	return out;
}

function parseNcx(xml, base) {
	const map = xml.match(/<navMap\b[^>]*>([\s\S]*?)<\/navMap\s*>/i);
	const body = map ? map[1] : xml;
	const out = [];
	const stack = [];
	const re = /<navPoint\b[^>]*?(\/?)>|<\/navPoint\s*>|<navLabel\b[^>]*>([\s\S]*?)<\/navLabel\s*>|<content\b([^>]*)>/gi;
	let m;
	while ((m = re.exec(body))) {
		const tag = m[0];
		if (/^<navPoint/i.test(tag)) {
			const point = { label: '', href: null, depth: stack.length + 1 };
			out.push(point);
			if (!m[1]) stack.push(point);
		} else if (/^<\/navPoint/i.test(tag)) {
			stack.pop();
		} else if (m[2] !== undefined) {
			const top = stack[stack.length - 1];
			if (top && !top.label) top.label = inlineText(m[2]);
		} else {
			const top = stack[stack.length - 1];
			if (top && !top.href) top.href = resolveHref(base, attr(` ${m[3]}`, 'src'));
		}
	}
	return out.filter(p => p.href);
}

function inspectEpub(zip) {
	const readText = name => decodeBytes(zip.read(name));
	const drm = inspectDrm(zip, readText);
	const noOpf = detail => new EpubError(drm.protected ? 'drm' : 'no-opf', drm.protected ? drm.reason : detail);

	const container = readText('META-INF/container.xml');
	if (!container) throw noOpf('no META-INF/container.xml');
	const rootfiles = [...container.matchAll(/<rootfile\b[^>]*>/gi)].map(m => m[0]);
	const rootfile = rootfiles.find(t => /oebps-package/i.test(attr(t, 'media-type') || '')) || rootfiles[0];
	const opfPath = rootfile && attr(rootfile, 'full-path');
	if (!opfPath) throw noOpf('no rootfile');
	const opf = readText(opfPath);
	if (!opf) throw noOpf('rootfile missing');

	const manifest = new Map();
	for (const m of opf.matchAll(/<(?:[\w-]+:)?item\b[^>]*>/gi)) {
		const id = attr(m[0], 'id');
		const href = resolveHref(opfPath, attr(m[0], 'href'));
		if (!id || !href) continue;
		manifest.set(id, { id, href, type: (attr(m[0], 'media-type') || '').toLowerCase(), props: attr(m[0], 'properties') || '' });
	}
	const spineTag = (opf.match(/<(?:[\w-]+:)?spine\b[^>]*>/i) || [''])[0];
	const spine = [];
	for (const m of opf.matchAll(/<(?:[\w-]+:)?itemref\b[^>]*>/gi)) {
		const item = manifest.get(attr(m[0], 'idref'));
		if (!item) continue;
		spine.push({ href: item.href, type: item.type, linear: (attr(m[0], 'linear') || '').toLowerCase() !== 'no' });
	}

	let toc = [];
	let tocSource = 'spine';
	const navItem = [...manifest.values()].find(i => /(^|\s)nav(\s|$)/.test(i.props));
	if (navItem) {
		toc = parseNav(readText(navItem.href) || '', navItem.href);
		if (toc.length) tocSource = 'nav';
	}
	if (!toc.length) {
		const ncxId = attr(spineTag, 'toc');
		const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find(i => i.type === 'application/x-dtbncx+xml');
		if (ncx) {
			toc = parseNcx(readText(ncx.href) || '', ncx.href);
			if (toc.length) tocSource = 'ncx';
		}
	}

	return {
		opfPath,
		meta: {
			title: dcValue(opf, 'title'),
			creator: dcValue(opf, 'creator'),
			identifier: dcValue(opf, 'identifier'),
			language: dcValue(opf, 'language')
		},
		spine,
		toc,
		tocSource,
		drm
	};
}

function isHtmlItem(item) {
	if (item.type) return item.type === 'application/xhtml+xml' || item.type === 'text/html';
	return /\.x?html?$/i.test(item.href);
}

function bodyRange(html) {
	const open = /<body\b[^>]*>/i.exec(html.slice(0, upTo(html, '>')));
	const start = open ? open.index + open[0].length : 0;
	const close = html.lastIndexOf('</body');
	const end = close >= start ? close : html.length;
	return [start, end];
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cutAt(html, frag, start, end) {
	if (!frag) return start;
	const re = new RegExp(`\\s(?:id|name)\\s*=\\s*["']${escapeRegExp(frag)}["']`, 'i');
	const hit = re.exec(html);
	// A missing anchor is nearly always a TOC typo in a one-chapter-per-file book, so the file's
	// start is a better guess than leaving the chapter with no text at all.
	if (!hit || hit.index >= end) return start;
	return Math.max(start, html.lastIndexOf('<', hit.index));
}

function spineSections(zip, info, readText, take) {
	const out = [];
	for (const item of info.spine) {
		if (!item.linear || !isHtmlItem(item)) continue;
		const html = readText(item.href);
		if (html == null) continue;
		const [start, end] = bodyRange(html);
		const body = html.slice(start, end);
		const heading = elements(body, HEADINGS).next().value;
		const label = heading ? inlineText(body.slice(heading.inner, heading.innerEnd)) : '';
		out.push({ label, href: item.href, depth: 1, paragraphs: take(htmlToParagraphs(body)) });
	}
	return out;
}

// push(...arr) throws past roughly 100k arguments, and one huge XHTML file can exceed that.
function pushAll(target, items) {
	for (const item of items) target.push(item);
}

function tocSections(zip, info, readText, take) {
	const entries = info.toc.map((t, i) => ({ i, label: String(t.label || '').slice(0, MAX_LABEL_CHARS), href: t.href, depth: t.depth || 1, paragraphs: [], key: null }));
	const marks = new Map();
	for (const e of entries) {
		const [file, frag] = splitHref(e.href);
		if (!marks.has(file)) marks.set(file, []);
		marks.get(file).push({ e, frag });
	}
	const front = { i: -1, label: '', href: null, depth: 0, paragraphs: [], key: [-1, -1, -1] };
	let cur = front;
	let spineIndex = 0;
	for (const item of info.spine) {
		spineIndex++;
		if (!item.linear || !isHtmlItem(item)) continue;
		const html = readText(item.href);
		if (html == null) continue;
		const [start, end] = bodyRange(html);
		if (!front.href) front.href = item.href;
		const cuts = [];
		for (const { e, frag } of marks.get(item.href) || []) {
			if (e.key) continue;
			const at = cutAt(html, frag, start, end);
			e.key = [spineIndex, at, e.i];
			cuts.push({ at, e });
		}
		cuts.sort((a, b) => a.at - b.at || a.e.i - b.e.i);
		let pos = start;
		for (const c of cuts) {
			if (c.at > pos) pushAll(cur.paragraphs, take(htmlToParagraphs(html.slice(pos, c.at))));
			cur = c.e;
			pos = Math.max(pos, c.at);
		}
		pushAll(cur.paragraphs, take(htmlToParagraphs(html.slice(pos, end))));
	}
	// Entries the spine never reached (a target outside the spine, or linear="no") keep their
	// place after the TOC entry before them, so the section list still reads in TOC order.
	let prev = [-1, -1, -1];
	for (const e of entries) {
		if (e.key) prev = e.key;
		else e.key = [prev[0], prev[1], e.i];
	}
	const ordered = entries.slice().sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
	const out = front.paragraphs.length ? [front, ...ordered] : ordered;
	return out.map(s => ({ label: s.label, href: s.href, depth: s.depth, paragraphs: s.paragraphs }));
}

function splitParagraph(p, max) {
	const pieces = [];
	let words = 0;
	let from = 0;
	WORD_RE.lastIndex = 0;
	let m;
	while ((m = WORD_RE.exec(p))) {
		if (words === max) {
			pieces.push(p.slice(from, m.index).trim());
			from = m.index;
			words = 0;
		}
		words++;
	}
	pieces.push(p.slice(from).trim());
	return pieces.filter(Boolean);
}

function splitLarge(section, max) {
	const words = countWords(section.paragraphs.join('\n'));
	if (words <= max) return [{ ...section, part: 0, words }];
	const paragraphs = [];
	for (const p of section.paragraphs) {
		if (countWords(p) > max) pushAll(paragraphs, splitParagraph(p, max));
		else paragraphs.push(p);
	}
	const target = Math.ceil(words / Math.ceil(words / max));
	const pieces = [];
	let cur = [];
	let curWords = 0;
	for (const p of paragraphs) {
		const w = countWords(p);
		if (cur.length && (curWords + w > max || curWords >= target)) {
			pieces.push({ paragraphs: cur, words: curWords });
			cur = [];
			curWords = 0;
		}
		cur.push(p);
		curWords += w;
	}
	if (cur.length) pieces.push({ paragraphs: cur, words: curWords });
	return pieces.map((piece, n) => ({
		label: n === 0 ? section.label : `${section.label} (${n + 1})`,
		href: section.href,
		depth: section.depth,
		part: n + 1,
		paragraphs: piece.paragraphs,
		words: piece.words
	}));
}

// Counted as each document is read, not in buildCache: by then every section is in memory, and
// a book far over the limit has already run the parse child out of it.
function textBudget(max) {
	let bytes = 0;
	return (paragraphs) => {
		for (const p of paragraphs) bytes += Buffer.byteLength(p, 'utf8') + 1;
		if (bytes > max) throw new EpubError('too-large', 'extracted text over the limit');
		return paragraphs;
	};
}

function extractSections(zip, info, { maxSectionWords = MAX_SECTION_WORDS, maxTextBytes = MAX_TEXT_BYTES } = {}) {
	const readText = name => decodeBytes(zip.read(name));
	const take = textBudget(maxTextBytes);
	const raw = info.toc && info.toc.length ? tocSections(zip, info, readText, take) : spineSections(zip, info, readText, take);
	const out = [];
	for (const s of raw) out.push(...splitLarge(s, maxSectionWords));
	return out;
}

function buildCache(sections, info, { source = null, now = Date.now, maxTextBytes = MAX_TEXT_BYTES } = {}) {
	const chunks = [];
	const index = [];
	let bytes = 0;
	let wordStart = 0;
	for (const s of sections) {
		const body = s.paragraphs.join('\n');
		const byteLen = Buffer.byteLength(body, 'utf8');
		index.push({
			label: s.label,
			href: s.href,
			depth: s.depth,
			part: s.part || 0,
			words: s.words,
			wordStart,
			byteStart: bytes,
			byteLen,
			paragraphs: s.paragraphs.length
		});
		chunks.push(body, '\n');
		bytes += byteLen + 1;
		wordStart += s.words;
		if (bytes > maxTextBytes) throw new EpubError('too-large', 'extracted text over the limit');
	}
	return {
		index: {
			version: EXTRACTOR_VERSION,
			builtAt: typeof now === 'function' ? now() : now,
			source,
			meta: {
				title: info.meta.title,
				creator: info.meta.creator,
				identifier: info.meta.identifier,
				language: info.meta.language,
				tocSource: info.tocSource,
				drm: { fontObfuscationOnly: !!(info.drm && info.drm.fontObfuscationOnly) }
			},
			textBytes: bytes,
			totalWords: wordStart,
			sections: index
		},
		text: chunks.join('')
	};
}

function parseEpubToCache(input, { source = null, now = Date.now, fs = require('fs'), maxEntryBytes, maxInflatedBytes, maxSectionWords, maxTextBytes } = {}) {
	const zip = openZip(input, { fs, maxEntryBytes, maxInflatedBytes });
	try {
		const info = inspectEpub(zip);
		if (info.drm.protected) throw new EpubError('drm', info.drm.reason);
		const sections = extractSections(zip, info, { maxSectionWords, maxTextBytes });
		const built = buildCache(sections, info, { source, now, maxTextBytes });
		if (!built.index.totalWords) throw new EpubError('empty', 'no words in the reading order');
		return built;
	} finally {
		zip.close();
	}
}

module.exports = {
	EXTRACTOR_VERSION,
	MAX_SECTION_WORDS,
	MAX_ENTRY_BYTES,
	MAX_TEXT_BYTES,
	MAX_INFLATED_BYTES,
	WORD_RE,
	EpubError,
	openZip,
	inspectEpub,
	htmlToParagraphs,
	countWords,
	extractSections,
	buildCache,
	parseEpubToCache
};
