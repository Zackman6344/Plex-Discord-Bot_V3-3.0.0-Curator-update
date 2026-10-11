// test/helpers/epubFixture.js
//
// Builds small synthetic EPUBs (and broken zips) for the read-along tests. Every word comes from
// the NATO alphabet, so no copyrighted text ever lands in the public repo.
//
// buildEpub(book) / writeEpub(file, book) take a book description:
//   { title, creator, identifier, language, opfDir = 'OEBPS',
//     files: [{ href, body, title?, linear = true, mediaType?, inSpine = true }],   spine order
//     toc: [{ label, href, children? }] | null,  hrefs relative to opfDir, '#frag' allowed
//     tocFormat: 'nav' | 'ncx' | 'both' | 'none',
//     extra: [{ name, data, method? }],          raw zip entries (images, META-INF files)
//     manifestExtra: [{ id, href, mediaType, properties? }],
//     textMethod: 8 | 0 }
// writeEpub/writeZip stream the parts to disk and return the layout of every entry
// ({ name, localOffset, dataStart, dataEnd }), which is how a test knows where a 50 MB image's
// bytes are without reading the file back.
//
// zip(entries, opts) / writeZip(file, entries, opts) build any zip. An entry may carry rawData
// (written as-is, for unsupported methods), usize (a lying declared size), flags. opts: zip64
// (add a zip64 locator), eocd (override count/cdSize/cdOffset), truncateCentral (cut that many
// bytes off the end of the central directory).
//
// Not named *.test.js, so `node --test test/*.test.js` does not try to run it.

const fs = require('node:fs');
const zlib = require('node:zlib');

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india',
	'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra',
	'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

function words(n, start = 0) {
	const out = new Array(n);
	for (let i = 0; i < n; i++) out[i] = WORDS[(start + i) % WORDS.length];
	return out.join(' ');
}

function paragraphs(count, wordsEach, start = 0) {
	const out = [];
	for (let i = 0; i < count; i++) out.push(words(wordsEach, start + i * wordsEach));
	return out;
}

function pBody(heading, paras) {
	return (heading ? `<h1>${heading}</h1>\n` : '') + paras.map(p => `<p>${p}</p>`).join('\n');
}

let CRC_TABLE = null;
function crc32(buf) {
	if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function toBuffer(data) {
	return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

function zipParts(entries, opts = {}) {
	const parts = [];
	const central = [];
	const layout = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const plain = e.rawData ? null : toBuffer(e.data == null ? '' : e.data);
		const method = e.method == null ? 8 : e.method;
		const stored = e.rawData ? e.rawData : method === 8 ? zlib.deflateRawSync(plain) : plain;
		const crc = e.crc != null ? e.crc : plain ? crc32(plain) : 0;
		const usize = e.usize != null ? e.usize : plain ? plain.length : stored.length;
		const flags = (e.flags || 0) | 0x800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(usize, 22);
		local.writeUInt16LE(name.length, 26);
		parts.push(local, name, stored);
		const dataStart = offset + 30 + name.length;
		layout.push({ name: e.name, localOffset: offset, dataStart, dataEnd: dataStart + stored.length });
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(flags, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt32LE(crc, 16);
		cd.writeUInt32LE(stored.length, 20);
		cd.writeUInt32LE(usize, 24);
		cd.writeUInt16LE(name.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, name);
		offset = dataStart + stored.length;
	}
	let cdBuf = Buffer.concat(central);
	const cdOffset = offset;
	const cdSize = cdBuf.length;
	if (opts.truncateCentral) cdBuf = cdBuf.subarray(0, Math.max(0, cdBuf.length - opts.truncateCentral));
	parts.push(cdBuf);
	offset += cdBuf.length;
	if (opts.zip64) {
		const locator = Buffer.alloc(20);
		locator.writeUInt32LE(0x07064b50, 0);
		parts.push(locator);
		offset += 20;
	}
	const eocd = Buffer.alloc(22);
	const o = opts.eocd || {};
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(o.count != null ? o.count : entries.length, 8);
	eocd.writeUInt16LE(o.count != null ? o.count : entries.length, 10);
	eocd.writeUInt32LE(o.cdSize != null ? o.cdSize : cdSize, 12);
	eocd.writeUInt32LE(o.cdOffset != null ? o.cdOffset : cdOffset, 16);
	parts.push(eocd);
	offset += 22;
	return { parts, layout, size: offset };
}

function zip(entries, opts) {
	return Buffer.concat(zipParts(entries, opts).parts);
}

function writeZip(file, entries, opts) {
	const { parts, layout, size } = zipParts(entries, opts);
	const fd = fs.openSync(file, 'w');
	try {
		for (const part of parts) fs.writeSync(fd, part);
	} finally {
		fs.closeSync(fd);
	}
	return { layout, size };
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xhtml(title, body) {
	return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
		'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
		`<head><title>${esc(title || '')}</title><style>p { margin: 0 }</style></head>\n` +
		`<body>\n${body}\n</body>\n</html>\n`;
}

function navDoc(toc) {
	const list = items => '<ol>' + items.map(t =>
		`<li><a href="${esc(t.href)}">${esc(t.label)}</a>${t.children && t.children.length ? list(t.children) : ''}</li>`).join('') + '</ol>';
	return xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1>${list(toc)}</nav>`);
}

function ncxDoc(toc, identifier, title) {
	let order = 0;
	const points = items => items.map(t => {
		order++;
		return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${esc(t.label)}</text></navLabel>` +
			`<content src="${esc(t.href)}"/>${t.children && t.children.length ? points(t.children) : ''}</navPoint>`;
	}).join('\n');
	return '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
		`<head><meta name="dtb:uid" content="${esc(identifier)}"/></head>\n<docTitle><text>${esc(title)}</text></docTitle>\n` +
		`<navMap>\n${points(toc)}\n</navMap>\n</ncx>\n`;
}

function epubEntries(book = {}) {
	const title = book.title || 'Synthetic Test Book';
	const creator = book.creator || 'Test Author';
	const identifier = book.identifier || 'urn:uuid:00000000-0000-4000-8000-000000000001';
	const language = book.language || 'en';
	const dir = book.opfDir == null ? 'OEBPS' : book.opfDir;
	const prefix = dir ? `${dir}/` : '';
	const files = book.files || [];
	const toc = book.toc || null;
	const tocFormat = book.tocFormat || (toc ? 'ncx' : 'none');
	const textMethod = book.textMethod == null ? 8 : book.textMethod;

	const manifest = [];
	const spine = [];
	const entries = [{ name: 'mimetype', data: 'application/epub+zip', method: 0 }];
	if (book.container !== false) {
		entries.push({
			name: 'META-INF/container.xml',
			method: textMethod,
			data: '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
				`<rootfiles><rootfile full-path="${prefix}content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n`
		});
	}
	files.forEach((f, i) => {
		const id = `f${i + 1}`;
		manifest.push(`<item id="${id}" href="${esc(f.href)}" media-type="${esc(f.mediaType || 'application/xhtml+xml')}"/>`);
		if (f.inSpine !== false) spine.push(`<itemref idref="${id}"${f.linear === false ? ' linear="no"' : ''}/>`);
		entries.push({ name: prefix + f.href, method: textMethod, data: f.raw != null ? f.raw : xhtml(f.title || '', f.body || '') });
	});
	if (toc && (tocFormat === 'nav' || tocFormat === 'both')) {
		manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
		entries.push({ name: `${prefix}nav.xhtml`, method: textMethod, data: navDoc(toc) });
	}
	if (toc && (tocFormat === 'ncx' || tocFormat === 'both')) {
		manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
		entries.push({ name: `${prefix}toc.ncx`, method: textMethod, data: ncxDoc(toc, identifier, title) });
	}
	for (const m of book.manifestExtra || []) {
		manifest.push(`<item id="${esc(m.id)}" href="${esc(m.href)}" media-type="${esc(m.mediaType)}"${m.properties ? ` properties="${esc(m.properties)}"` : ''}/>`);
	}
	const hasNcx = toc && (tocFormat === 'ncx' || tocFormat === 'both');
	const opf = '<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
		'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
		`<dc:identifier id="bookid">${esc(identifier)}</dc:identifier>\n<dc:title>${esc(title)}</dc:title>\n` +
		`<dc:creator>${esc(creator)}</dc:creator>\n<dc:language>${esc(language)}</dc:language>\n</metadata>\n` +
		`<manifest>\n${manifest.join('\n')}\n</manifest>\n` +
		`<spine${hasNcx ? ' toc="ncx"' : ''}>\n${spine.join('\n')}\n</spine>\n</package>\n`;
	if (book.opf !== false) entries.push({ name: `${prefix}content.opf`, method: textMethod, data: opf });
	for (const e of book.extra || []) entries.push({ method: 8, ...e });
	return entries;
}

function buildEpub(book) {
	return zip(epubEntries(book));
}

function writeEpub(file, book) {
	return writeZip(file, epubEntries(book));
}

// One file per chapter, TOC entry per chapter: the common shape of a commercial EPUB.
function chapterBook({ chapters, tocFormat = 'ncx', ...rest }) {
	return {
		...rest,
		tocFormat,
		files: chapters.map((c, i) => ({ href: `text/c${i + 1}.xhtml`, title: c.label, body: c.body != null ? c.body : pBody(c.label, c.paragraphs || []) })),
		toc: chapters.map((c, i) => ({ label: c.label, href: `text/c${i + 1}.xhtml` }))
	};
}

function encryptionXml(items) {
	return '<?xml version="1.0"?>\n<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
		'xmlns:enc="http://www.w3.org/2001/04/xmlenc#">\n' +
		items.map(({ uri, algorithm }) => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${esc(algorithm)}"/>` +
			`<enc:CipherData><enc:CipherReference URI="${esc(uri)}"/></enc:CipherData></enc:EncryptedData>`).join('\n') +
		'\n</encryption>\n';
}

module.exports = {
	WORDS,
	words,
	paragraphs,
	pBody,
	crc32,
	zip,
	zipParts,
	writeZip,
	xhtml,
	epubEntries,
	buildEpub,
	writeEpub,
	chapterBook,
	encryptionXml
};
