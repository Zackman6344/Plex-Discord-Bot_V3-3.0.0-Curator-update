// helpers/epubText.js: EPUB -> text sections for the read-along.
//
// The bug: without a real parser the read-along would show the wrong chapter's words or none.
// The ways that happens: an EPUB3 nav and an EPUB2 NCX disagreeing; two chapters sharing one
// XHTML file and cut only at file boundaries; the title-page text before the first TOC entry
// silently dropped or glued onto chapter one; a map page with no words removed, shifting every
// later chapter; linear="no" footnotes read into the story; nested Part/Chapter entries
// flattened out of order; entities left as "&mdash;" or soft hyphens splitting words; a
// DRM-locked book parsed into garbage while a font-obfuscated one (Oathbringer) is refused; a
// corrupt or zip64 file crashing the parse; a 115 MB image-heavy EPUB loaded whole into memory
// to read 3 MB of text; and byte offsets that drift on accented or CJK text so a page shows the
// middle of a word.
//
// Harness: every EPUB is built in memory or in a pid-suffixed temp dir by
// test/helpers/epubFixture.js from NATO-alphabet words. The large-image test hands openZip a
// recording fs and checks, with a positive control, which byte ranges it read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const epub = require('../helpers/epubText.js');
const fx = require('./helpers/epubFixture.js');

const TMP = pathMod.join(os.tmpdir(), `plexbot-test-epubtext-${process.pid}`);

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function sectionsOf(book, opts) {
	const zip = epub.openZip({ bytes: fx.buildEpub(book) });
	try {
		const info = epub.inspectEpub(zip);
		return { info, sections: epub.extractSections(zip, info, opts) };
	} finally {
		zip.close();
	}
}

function codeOf(fn) {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof epub.EpubError, `expected an EpubError, got ${err && err.stack}`);
		return err.code;
	}
	return null;
}

const threeChapters = () => [
	{ label: 'Prologue', paragraphs: fx.paragraphs(3, 12, 0) },
	{ label: 'Chapter 1', paragraphs: fx.paragraphs(4, 9, 3) },
	{ label: 'Chapter 2', paragraphs: fx.paragraphs(2, 15, 7) }
];

test('nav and ncx tables of contents give the same sections', () => {
	const nav = sectionsOf(fx.chapterBook({ chapters: threeChapters(), tocFormat: 'nav' }));
	const ncx = sectionsOf(fx.chapterBook({ chapters: threeChapters(), tocFormat: 'ncx' }));
	assert.strictEqual(nav.info.tocSource, 'nav');
	assert.strictEqual(ncx.info.tocSource, 'ncx');
	assert.deepStrictEqual(nav.sections, ncx.sections);
	assert.deepStrictEqual(nav.sections.map(s => [s.label, s.words]), [
		['Prologue', 1 + 36],
		['Chapter 1', 2 + 36],
		['Chapter 2', 2 + 30]
	]);
});

test('an epub with both prefers the nav document', () => {
	const both = sectionsOf(fx.chapterBook({ chapters: threeChapters(), tocFormat: 'both' }));
	assert.strictEqual(both.info.tocSource, 'nav');
	assert.strictEqual(both.sections.length, 3);
});

test('a fragment target cuts one file into two sections', () => {
	const body = '<h2 id="c1">Chapter 1</h2>\n<p>' + fx.words(20) + '</p>\n' +
		'<div><h2 id="c2">Chapter 2</h2></div>\n<p>' + fx.words(30, 5) + '</p>';
	const { sections } = sectionsOf({
		tocFormat: 'nav',
		files: [{ href: 'text/all.xhtml', body }],
		toc: [{ label: 'Chapter 1', href: 'text/all.xhtml#c1' }, { label: 'Chapter 2', href: 'text/all.xhtml#c2' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.words, s.paragraphs[0]]), [
		['Chapter 1', 22, 'Chapter 1'],
		['Chapter 2', 32, 'Chapter 2']
	]);
	assert.strictEqual(sections[1].paragraphs[1], fx.words(30, 5));
});

test('text before the first toc entry becomes an unlabelled front section', () => {
	const { sections } = sectionsOf({
		tocFormat: 'ncx',
		files: [
			{ href: 'text/title.xhtml', body: '<p>golf hotel india</p>' },
			{ href: 'text/c1.xhtml', body: '<p>romeo sierra</p><h2 id="c1">Chapter 1</h2><p>' + fx.words(10) + '</p>' }
		],
		toc: [{ label: 'Chapter 1', href: 'text/c1.xhtml#c1' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.depth, s.paragraphs]), [
		['', 0, ['golf hotel india', 'romeo sierra']],
		['Chapter 1', 1, ['Chapter 1', fx.words(10)]]
	]);
});

test('a book whose first toc entry is its first page has no front section', () => {
	const { sections } = sectionsOf(fx.chapterBook({ chapters: threeChapters() }));
	assert.notStrictEqual(sections[0].label, '');
});

test('a section with no words keeps its place in toc order', () => {
	const { sections } = sectionsOf({
		tocFormat: 'nav',
		files: [
			{ href: 'text/c1.xhtml', body: '<h1>One</h1><p>' + fx.words(10) + '</p>' },
			{ href: 'text/map.xhtml', body: '<div><img src="../images/map.png" alt=""/></div>' },
			{ href: 'text/c2.xhtml', body: '<h1>Two</h1><p>' + fx.words(10) + '</p>' }
		],
		toc: [{ label: 'One', href: 'text/c1.xhtml' }, { label: 'Map', href: 'text/map.xhtml' }, { label: 'Two', href: 'text/c2.xhtml' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.words]), [['One', 11], ['Map', 0], ['Two', 11]]);
});

test('a linear="no" spine item is skipped', () => {
	const { sections } = sectionsOf({
		tocFormat: 'ncx',
		files: [
			{ href: 'text/c1.xhtml', body: '<p>' + fx.words(8) + '</p>' },
			{ href: 'text/notes.xhtml', body: '<p>kilo kilo kilo</p>', linear: false },
			{ href: 'text/c2.xhtml', body: '<p>' + fx.words(8) + '</p>' }
		],
		toc: [{ label: 'One', href: 'text/c1.xhtml' }, { label: 'Two', href: 'text/c2.xhtml' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.words]), [['One', 8], ['Two', 8]]);
	assert.ok(!sections.some(s => s.paragraphs.includes('kilo kilo kilo')));
});

test('a book with no toc gets one section per spine item labelled by its heading', () => {
	const { info, sections } = sectionsOf({
		tocFormat: 'none',
		files: [
			{ href: 'a.xhtml', body: '<h2>Alpha <em>Heading</em></h2><p>' + fx.words(5) + '</p>' },
			{ href: 'b.xhtml', body: '<p>' + fx.words(4) + '</p>' },
			{ href: 'c.xhtml', body: '<h4>Not a title</h4><h3>Charlie</h3><p>' + fx.words(3) + '</p>' }
		]
	});
	assert.strictEqual(info.tocSource, 'spine');
	assert.deepStrictEqual(sections.map(s => [s.label, s.depth, s.part]), [['Alpha Heading', 1, 0], ['', 1, 0], ['Charlie', 1, 0]]);
});

test('nested toc entries keep document order and depth', () => {
	const book = format => ({
		tocFormat: format,
		files: [
			{ href: 'p1.xhtml', body: '<h1>Part One</h1>' },
			{ href: 'c1.xhtml', body: '<p>' + fx.words(6) + '</p>' },
			{ href: 'c2.xhtml', body: '<p>' + fx.words(7) + '</p>' },
			{ href: 'p2.xhtml', body: '<h1>Part Two</h1>' },
			{ href: 'c3.xhtml', body: '<p>' + fx.words(8) + '</p>' }
		],
		toc: [
			{ label: 'Part One', href: 'p1.xhtml', children: [{ label: 'Chapter 1', href: 'c1.xhtml' }, { label: 'Chapter 2', href: 'c2.xhtml' }] },
			{ label: 'Part Two', href: 'p2.xhtml', children: [{ label: 'Chapter 3', href: 'c3.xhtml' }] }
		]
	});
	const expected = [['Part One', 1, 2], ['Chapter 1', 2, 6], ['Chapter 2', 2, 7], ['Part Two', 1, 2], ['Chapter 3', 2, 8]];
	for (const format of ['nav', 'ncx']) {
		const { sections } = sectionsOf(book(format));
		assert.deepStrictEqual(sections.map(s => [s.label, s.depth, s.words]), expected, format);
	}
});

test('a toc listed out of reading order still yields sections in reading order', () => {
	const { sections } = sectionsOf({
		tocFormat: 'ncx',
		files: [
			{ href: 'c1.xhtml', body: '<p>' + fx.words(3) + '</p>' },
			{ href: 'c2.xhtml', body: '<p>' + fx.words(4) + '</p>' }
		],
		toc: [{ label: 'Second', href: 'c2.xhtml' }, { label: 'First', href: 'c1.xhtml' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.words]), [['First', 3], ['Second', 4]]);
});

test('a missing fragment anchor cuts at the start of its file', () => {
	const { sections } = sectionsOf({
		tocFormat: 'nav',
		files: [
			{ href: 'c1.xhtml', body: '<p>' + fx.words(3) + '</p>' },
			{ href: 'c2.xhtml', body: '<p>' + fx.words(4) + '</p>' }
		],
		toc: [{ label: 'One', href: 'c1.xhtml' }, { label: 'Two', href: 'c2.xhtml#no-such-id' }]
	});
	assert.deepStrictEqual(sections.map(s => [s.label, s.words]), [['One', 3], ['Two', 4]]);
});

test('htmlToParagraphs decodes entities, drops non-text elements and collapses whitespace', () => {
	const html = '<p>Caf&eacute;   &amp;lt; &#x41;&#66; &mdash; won&shy;der</p>' +
		'<script>var x = "kilo";</script><style>p { color: red }</style>' +
		'<p>un<em>believ</em>able&nbsp;&nbsp;\r\n  text</p><svg><text>lima</text></svg>' +
		'<ruby>\u6f22<rt>kan</rt></ruby><br/>next&unknown; &#0; <!-- mike -->';
	assert.deepStrictEqual(epub.htmlToParagraphs(html), [
		'Caf\u00e9 &lt; AB \u2014 wonder',
		'unbelievable text',
		'\u6f22',
		'next&unknown; \ufffd'
	]);
	assert.deepStrictEqual(epub.htmlToParagraphs('<p>won\u00adder ze\u200dro\ufeff</p>'), ['wonder zero']);
	assert.strictEqual(epub.countWords(epub.htmlToParagraphs('<p>won\u00adder</p>')[0]), 1);
});

test('countWords treats hyphens and apostrophes inside a word as part of it', () => {
	assert.strictEqual(epub.countWords('well-known don\u2019t \'tis 42 \u2014 x'), 5);
	assert.strictEqual(epub.countWords(''), 0);
	assert.strictEqual(epub.countWords('\u65e5\u672c\u8a9e caf\u00e9'), 2);
});

test('rights.xml, sinf.xml and non-font encryption are refused as drm', () => {
	const base = threeChapters();
	const cases = [
		[{ name: 'META-INF/rights.xml', data: '<rights/>' }],
		[{ name: 'META-INF/sinf.xml', data: '<sinf/>' }],
		[{ name: 'META-INF/encryption.xml', data: fx.encryptionXml([{ uri: 'OEBPS/text/c1.xhtml', algorithm: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc' }]) }],
		[{ name: 'META-INF/encryption.xml', data: fx.encryptionXml([{ uri: 'OEBPS/fonts/a.otf', algorithm: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc' }]) }],
		[{ name: 'META-INF/encryption.xml', data: fx.encryptionXml([{ uri: 'OEBPS/text/c1.xhtml', algorithm: 'http://www.idpf.org/2008/embedding' }]) }]
	];
	for (const extra of cases) {
		const bytes = fx.buildEpub(fx.chapterBook({ chapters: base, extra }));
		assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes })), 'drm', extra[0].name);
	}
});

test('a drm-locked book with no readable package is reported as drm, not no-opf', () => {
	const bytes = fx.buildEpub({ ...fx.chapterBook({ chapters: threeChapters() }), opf: false, extra: [{ name: 'META-INF/rights.xml', data: '<rights/>' }] });
	assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes })), 'drm');
});

test('font obfuscation alone is accepted', () => {
	const extra = [
		{ name: 'META-INF/encryption.xml', data: fx.encryptionXml([
			{ uri: 'OEBPS/fonts/a.otf', algorithm: 'http://www.idpf.org/2008/embedding' },
			{ uri: 'OEBPS/fonts/b%20c.TTF', algorithm: 'http://ns.adobe.com/pdf/enc#RC' }
		]) },
		{ name: 'OEBPS/fonts/a.otf', data: Buffer.alloc(64, 1), method: 0 }
	];
	const { index } = epub.parseEpubToCache({ bytes: fx.buildEpub(fx.chapterBook({ chapters: threeChapters(), extra })) });
	assert.strictEqual(index.meta.drm.fontObfuscationOnly, true);
	assert.strictEqual(index.sections.length, 3);
});

test('a file that is not a zip is refused as not-zip', () => {
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: Buffer.from('this is plain text, not an archive at all') })), 'not-zip');
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: Buffer.alloc(5) })), 'not-zip');
});

test('a truncated or miscounted central directory is bad-zip', () => {
	const entries = fx.epubEntries(fx.chapterBook({ chapters: threeChapters() }));
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: fx.zip(entries, { truncateCentral: 10 }) })), 'bad-zip');
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: fx.zip(entries, { eocd: { count: entries.length + 3 } }) })), 'bad-zip');
});

test('an unsupported compression method is refused', () => {
	const bytes = fx.zip([
		{ name: 'mimetype', data: 'application/epub+zip', method: 0 },
		{ name: 'odd.bin', method: 12, rawData: Buffer.from('BZh91AY&SY') }
	]);
	const zip = epub.openZip({ bytes });
	assert.strictEqual(codeOf(() => zip.read('odd.bin')), 'unsupported-compression');
	assert.strictEqual(zip.read('mimetype').toString(), 'application/epub+zip');
});

test('a zip64 archive is refused', () => {
	const entries = fx.epubEntries(fx.chapterBook({ chapters: threeChapters() }));
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: fx.zip(entries, { zip64: true }) })), 'zip64');
	assert.strictEqual(codeOf(() => epub.openZip({ bytes: fx.zip(entries, { eocd: { cdOffset: 0xffffffff } }) })), 'zip64');
});

test('an entry over the size limit is refused, even when its declared size lies', () => {
	const bytes = fx.zip([
		{ name: 'stored.bin', data: Buffer.alloc(2000, 7), method: 0 },
		{ name: 'bomb.bin', data: Buffer.alloc(100000), method: 8, usize: 10 },
		{ name: 'small.bin', data: Buffer.alloc(500, 3), method: 8 }
	]);
	const zip = epub.openZip({ bytes }, { maxEntryBytes: 1000 });
	assert.strictEqual(codeOf(() => zip.read('stored.bin')), 'entry-too-large');
	assert.strictEqual(codeOf(() => zip.read('bomb.bin')), 'entry-too-large');
	assert.strictEqual(zip.read('small.bin').length, 500);
});

test('a book with no words or no package document is refused', () => {
	const imageOnly = fx.buildEpub({ tocFormat: 'none', files: [{ href: 'cover.xhtml', body: '<img src="c.jpg"/>' }] });
	assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes: imageOnly })), 'empty');
	const noContainer = fx.buildEpub({ ...fx.chapterBook({ chapters: threeChapters() }), container: false });
	assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes: noContainer })), 'no-opf');
});

test('the file reader never touches the bytes of a 50 MB stored image', () => {
	fs.mkdirSync(TMP, { recursive: true });
	const file = pathMod.join(TMP, 'big.epub');
	const book = fx.chapterBook({ chapters: threeChapters(), tocFormat: 'ncx' });
	book.manifestExtra = [{ id: 'img', href: 'images/plate.png', mediaType: 'image/png' }];
	book.extra = [{ name: 'OEBPS/images/plate.png', data: Buffer.alloc(50 * 1024 * 1024, 0x5a), method: 0 }];
	const { layout } = fx.writeEpub(file, book);

	const ranges = [];
	const recording = {
		...fs,
		readSync(fd, buffer, offset, length, position) {
			ranges.push([position, position + length]);
			return fs.readSync(fd, buffer, offset, length, position);
		}
	};
	const { index } = epub.parseEpubToCache({ path: file }, { fs: recording });
	assert.strictEqual(index.sections.length, 3);

	const covered = (from, to) => ranges.some(([a, b]) => a <= from && b >= to);
	const needed = ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/text/c1.xhtml', 'OEBPS/text/c2.xhtml', 'OEBPS/text/c3.xhtml'];
	for (const name of needed) {
		const e = layout.find(l => l.name === name);
		assert.ok(covered(e.dataStart, e.dataEnd), `positive control: ${name} was read`);
	}
	const img = layout.find(l => l.name === 'OEBPS/images/plate.png');
	const touching = ranges.filter(([a, b]) => a < img.dataEnd && b > img.dataStart);
	assert.deepStrictEqual(touching, []);
	const total = ranges.reduce((n, [a, b]) => n + (b - a), 0);
	assert.ok(total < 64 * 1024, `read ${total} bytes`);
});

test('the file reader closes its descriptor even when the parse fails', () => {
	fs.mkdirSync(TMP, { recursive: true });
	const file = pathMod.join(TMP, 'locked.epub');
	fx.writeEpub(file, { ...fx.chapterBook({ chapters: threeChapters() }), extra: [{ name: 'META-INF/rights.xml', data: '<r/>' }] });
	let opened = 0;
	let closed = 0;
	const counting = {
		...fs,
		openSync: (...a) => { opened++; return fs.openSync(...a); },
		closeSync: fd => { closed++; return fs.closeSync(fd); }
	};
	assert.throws(() => epub.parseEpubToCache({ path: file }, { fs: counting }), err => err.code === 'drm');
	assert.strictEqual(opened, 1);
	assert.strictEqual(closed, 1);
});

test('a section over MAX_SECTION_WORDS splits at paragraph boundaries', () => {
	assert.strictEqual(epub.MAX_SECTION_WORDS, 20000);
	const { sections } = sectionsOf(fx.chapterBook({
		chapters: [
			{ label: 'Short', paragraphs: fx.paragraphs(2, 10) },
			{ label: 'Long', body: fx.paragraphs(450, 100).map(p => `<p>${p}</p>`).join('') },
			{ label: 'After', paragraphs: fx.paragraphs(1, 10) }
		]
	}));
	assert.deepStrictEqual(sections.map(s => [s.label, s.part, s.words]), [
		['Short', 0, 21],
		['Long', 1, 15000],
		['Long (2)', 2, 15000],
		['Long (3)', 3, 15000],
		['After', 0, 11]
	]);
	for (const s of sections) assert.strictEqual(s.paragraphs.every(p => p.split(' ').length === 100 || s.part === 0), true);
});

test('a single paragraph over MAX_SECTION_WORDS still splits, between words', () => {
	const { sections } = sectionsOf(fx.chapterBook({
		chapters: [{ label: 'Wall', body: `<p>${fx.words(25000)}</p>` }]
	}));
	assert.ok(sections.length >= 2);
	assert.ok(sections.every(s => s.words <= epub.MAX_SECTION_WORDS));
	assert.strictEqual(sections.reduce((n, s) => n + s.words, 0), 25000);
	assert.strictEqual(sections.map(s => s.paragraphs.join(' ')).join(' '), fx.words(25000));
});

test('byte offsets round-trip multi-byte text', () => {
	const chapters = [
		{ label: 'Caf\u00e9', paragraphs: ['na\u00efve caf\u00e9 \u2014 r\u00e9sum\u00e9', '\u65e5\u672c\u8a9e \u30c6\u30ad\u30b9\u30c8'] },
		{ label: 'Emoji \ud83d\ude00', paragraphs: ['alpha \ud83d\ude00 bravo', 'charlie'] },
		{ label: 'Plain', paragraphs: fx.paragraphs(3, 5) }
	];
	const { index, text } = epub.parseEpubToCache({ bytes: fx.buildEpub(fx.chapterBook({ chapters })) }, { source: { type: 'file', fingerprint: 'f' }, now: () => 123 });
	const bytes = Buffer.from(text, 'utf8');
	assert.strictEqual(index.textBytes, bytes.length);
	let wordStart = 0;
	index.sections.forEach((s, i) => {
		const slice = bytes.subarray(s.byteStart, s.byteStart + s.byteLen).toString('utf8');
		assert.strictEqual(slice, [chapters[i].label, ...chapters[i].paragraphs].join('\n'));
		assert.strictEqual(bytes[s.byteStart + s.byteLen], 0x0a);
		assert.strictEqual(epub.countWords(slice), s.words);
		assert.strictEqual(s.wordStart, wordStart);
		assert.strictEqual(s.paragraphs, chapters[i].paragraphs.length + 1);
		wordStart += s.words;
	});
	assert.strictEqual(index.totalWords, wordStart);
	assert.strictEqual(index.version, epub.EXTRACTOR_VERSION);
	assert.strictEqual(index.builtAt, 123);
	assert.deepStrictEqual(index.source, { type: 'file', fingerprint: 'f' });
	assert.strictEqual(index.meta.title, 'Synthetic Test Book');
	assert.strictEqual(index.meta.tocSource, 'ncx');
});

// The bug: a 5 MB EPUB of 30 highly compressible 36 MB chapters passed the per-entry limit, and
// the text limit was only checked once every section was in memory, so the parse child died of
// out-of-memory (a "crash", retried on every open) instead of being refused as too large.
test('the text limit is checked while sections are read, and the inflated total has its own limit', () => {
	const book = fx.chapterBook({ chapters: [1, 2, 3, 4].map(n => ({ label: `Chapter ${n}`, paragraphs: fx.paragraphs(40, 50, n * 2000) })) });
	const zip = epub.openZip({ bytes: fx.buildEpub(book) });
	try {
		const info = epub.inspectEpub(zip);
		assert.strictEqual(epub.extractSections(zip, info).length, 4, 'the book reads under the default limits');
		assert.strictEqual(codeOf(() => epub.extractSections(zip, info, { maxTextBytes: 20000 })), 'too-large');
	} finally {
		zip.close();
	}
	const bytes = fx.zip([
		{ name: 'a.txt', data: Buffer.alloc(6000, 97), method: 8 },
		{ name: 'b.txt', data: Buffer.alloc(6000, 98), method: 8 },
		{ name: 'c.txt', data: Buffer.alloc(6000, 99), method: 0 }
	]);
	const capped = epub.openZip({ bytes }, { maxInflatedBytes: 10000 });
	assert.strictEqual(capped.read('a.txt').length, 6000);
	assert.strictEqual(codeOf(() => capped.read('b.txt')), 'too-large');
	assert.strictEqual(codeOf(() => capped.read('c.txt')), 'too-large');
	assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes: fx.buildEpub(book) }, { maxTextBytes: 20000 })), 'too-large');
	assert.strictEqual(codeOf(() => epub.parseEpubToCache({ bytes: fx.buildEpub(book) }, { maxInflatedBytes: 20000 })), 'too-large');
});

// The bug: lazy regexes rescanned to the end of the document from every opener with no close,
// so a 3 KB EPUB of unclosed "<!--" or "<style>" kept the parse child at full CPU until its
// 120 s timeout, and a timeout is retried on every open.
test('unclosed comments, CDATA, dropped elements, headings and tags parse in linear time', () => {
	const n = 200000;
	const hostile = {
		comment: '<!--x',
		cdata: '<![CDATA[x',
		style: '<style>',
		'style, no ">"': '<style ',
		'block tag, no ">"': '<p ',
		'tag, no ">"': '<x',
		heading: '<h1>',
		body: '<body '
	};
	for (const [name, opener] of Object.entries(hostile)) {
		const html = '<html><body><p>alpha bravo</p>' + opener.repeat(n);
		const started = Date.now();
		epub.htmlToParagraphs(html);
		const bytes = fx.buildEpub({ tocFormat: 'none', files: [{ href: 'a.xhtml', raw: html }] });
		try { epub.parseEpubToCache({ bytes }); } catch (_) { /* only the time matters */ }
		const ms = Date.now() - started;
		assert.ok(ms < 3000, `${name} x${n} took ${ms} ms`);
	}
});

test('the linear scans give the same paragraphs as before on ordinary and unclosed markup', () => {
	const cases = [
		['<p>a<!-- x -->b</p><p>c<!-- y</p>', ['a b', 'c<!-- y']],
		['<p><![CDATA[kilo]]> lima</p><p>mike <![CDATA[oscar</p>', ['kilo lima', 'mike <![CDATA[oscar']],
		['<p>one</p><STYLE type="x">p{}</Style ><p>two</p><style>unclosed<p>three</p>', ['one', 'two', 'unclosed', 'three']],
		['<p>alpha</p><style>a<script>b</style>c</script><p>d</p>', ['alpha', 'c', 'd']],
		['<p>x</p><stylex>kept</stylex><svg:svg>y</svg:svg>', ['x', 'kepty']],
		['<p>tail <b>bold</b> and < not a tag', ['tail bold and < not a tag']]
	];
	for (const [html, want] of cases) assert.deepStrictEqual(epub.htmlToParagraphs(html), want, html);
	const heading = sectionsOf({ tocFormat: 'none', files: [{ href: 'a.xhtml', raw: '<html><body><h2>open<h1>Real <i>One</i></h1><p>text</p></body></html>' }] });
	assert.strictEqual(heading.sections[0].label, 'Real One');
});
