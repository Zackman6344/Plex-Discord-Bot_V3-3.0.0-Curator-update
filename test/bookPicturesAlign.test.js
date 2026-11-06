// helpers/bookPicturesAlign.js: printed pages of a scanned PDF to the read-along's word numbers.
//
// The bugs it guards against: ebook words numbered differently from the pager (char offsets
// instead of byte offsets, another tokenizer), so every picture drifts off its page; a two-column
// scan read row by row across both columns, as pdftotext lists it, which put 9 of #384's 17
// chapter openers on the wrong word; a chapter opener whose drop cap hides its first words
// starting a few words late; a front-matter page that matches the ebook's back matter dragging
// the whole book to its end; pages beside a run of missing printed pages, or on a 2-up scan, left
// out so their pictures show thousands of words late; a full-page picture given no word, or the
// word of the page before it, or no fallback for when its word is never narrated; front-matter
// pictures shown in the body; and a PDF of another book accepted as a match.
//
// Harness: synthetic books from test/fixtures/bookPictures/synth.js. The ebook is cached by the
// read-along's own epubText.buildCache, or parsed from an EPUB built by test/helpers/epubFixture.js;
// its printed pages are typeset in two columns and turned into pdftotext -bbox-layout XHTML
// (CRLF, entities), with OCR noise where a test asks for it.

const test = require('node:test');
const assert = require('node:assert');

const align = require('../helpers/bookPicturesAlign.js');
const { parseBboxLayout } = require('../helpers/bookPicturesScan.js');
const model = require('../helpers/readAlongModel.js');
const epubText = require('../helpers/epubText.js');
const efx = require('./helpers/epubFixture.js');
const fx = require('./fixtures/bookPictures/synth.js');

const { normalise, tokenKey, ebookKeys, readingOrder, alignPages, pictureWords, DEFAULTS } = align;

function pageKeysOf(xhtml) {
	return parseBboxLayout(xhtml).map((p) => Uint32Array.from(readingOrder(p), (t) => tokenKey(t)));
}

function alignBook(ebook, print = {}) {
	const book = fx.printBook(ebook, print);
	const keys = pageKeysOf(fx.xhtmlOf(book.map((p) => p.ocr), { crlf: true }));
	const ek = ebookKeys(ebook.text, ebook.index.sections);
	return { book, keys, ek, r: alignPages(keys, ek) };
}

const startOf = (ebook, label) => ebook.index.sections.find((s) => s.label === label).wordStart;

test('normalise drops case, accents, apostrophes and punctuation; tokenKey hashes what is left', () => {
	assert.strictEqual(normalise('Didn\u2019t'), 'didnt');
	assert.strictEqual(normalise('didn\'t'), 'didnt');
	assert.strictEqual(normalise('Caf\u00e9'), 'cafe');
	assert.strictEqual(normalise('nai\u0308ve'), 'naive');
	assert.strictEqual(normalise('longest-ever'), 'longestever');
	assert.strictEqual(normalise('\u65e5\u672c\u8a9e'), '\u65e5\u672c\u8a9e');
	assert.strictEqual(normalise('\u2014...'), '');
	assert.strictEqual(tokenKey('Didn\u2019t'), tokenKey('didnt'));
	assert.strictEqual(tokenKey('stair-case'), tokenKey('staircase'));
	assert.notStrictEqual(tokenKey('cat'), tokenKey('act'));
	assert.strictEqual(tokenKey('...'), null);
	assert.strictEqual(tokenKey(''), null);
	for (const w of ['a', 'the', 'Dursleys\u2019', '42', '\u00e9t\u00e9']) {
		const k = tokenKey(w);
		assert.ok(Number.isInteger(k) && k > 0 && k <= 0xffffffff, w);
	}
});

test('ebookKeys numbers words exactly as the pager does, by bytes of <base>.txt', () => {
	// The first section's multi-byte words put every later section's byteStart past its char offset.
	const chapters = [
		{ label: 'One', paragraphs: ['Caf\u00e9 na\u00efve \u65e5\u672c\u8a9e don\u2019t rock\'n\'roll well-known 1,000 e-mail \u2014 x \ud83d\udcd6 emoji', 'a \u201cquoted\u201d line'] },
		{ label: 'Two', paragraphs: ['alpha bravo charlie \u00e9t\u00e9 delta', 'echo foxtrot'] },
		{ label: 'Empty', paragraphs: [] },
		{ label: 'Three', paragraphs: ['golf hotel india'] }
	];
	const { index, text } = epubText.parseEpubToCache({ bytes: efx.buildEpub(efx.chapterBook({ chapters })) });
	const buf = Buffer.from(text, 'utf8');
	const ek = ebookKeys(text, index.sections);
	assert.strictEqual(ek.totalWords, index.totalWords);
	assert.strictEqual(ek.keys.length, index.totalWords);
	assert.deepStrictEqual(ek.sectionStarts, index.sections.filter((s) => s.words > 0).map((s) => s.wordStart));
	let checked = 0;
	for (const s of index.sections) {
		// What handle.readSection gives the pager, and how paginate counts it.
		const body = buf.toString('utf8', s.byteStart, s.byteStart + s.byteLen);
		const ws = model.words(body);
		assert.strictEqual(ws.length, s.words, s.label);
		ws.forEach((w, i) => {
			assert.strictEqual(ek.keys[s.wordStart + i], tokenKey(body.slice(w.start, w.end)) || 0, `${s.label} word ${i}`);
			checked++;
		});
	}
	assert.strictEqual(checked, index.totalWords);
	assert.ok(index.sections[1].byteStart !== text.indexOf(buf.toString('utf8', index.sections[1].byteStart, index.sections[1].byteStart + index.sections[1].byteLen)));
	assert.deepStrictEqual(ebookKeys(buf, index.sections), ek);
});

test('ebookKeys numbers an index without wordStart by running totals, as the read-along model does', () => {
	const { index, text } = fx.makeEbook({ seed: 3, chapters: 2, chapterWords: 200 });
	const bare = index.sections.map(({ wordStart, ...s }) => s);
	assert.deepStrictEqual(ebookKeys(text, bare), ebookKeys(text, index.sections));
	const none = ebookKeys('', []);
	assert.strictEqual(none.totalWords, 0);
	assert.strictEqual(none.keys.length, 0);
});

test('readingOrder reads the left column before the right one and drops heads and folios', () => {
	const L = (t, y) => fx.lineOf(t.split(' '), 56, y);
	const R = (t, y) => fx.lineOf(t.split(' '), 296, y);
	const page = {
		width: fx.PAGE_W,
		height: fx.PAGE_H,
		lines: [
			fx.lineOf(['RUNNING', 'HEAD'], 226, 24.3, 9.5),
			L('one two three', 80), R('seven eight nine', 80),
			L('four five', 93.2), R('ten eleven', 93.2),
			L('six', 106.4), R('twelve', 106.4),
			fx.lineOf(['112'], 275, 655.8, 12.4)
		]
	};
	const xhtml = fx.xhtmlOf([page], { crlf: true });
	assert.ok(xhtml.includes('\r\n'));
	const [parsed] = parseBboxLayout(xhtml);
	assert.deepStrictEqual(parsed.lines.map((l) => l.words[0].text), ['RUNNING', 'one', 'seven', 'four', 'ten', 'six', 'twelve', '112']);
	assert.deepStrictEqual(readingOrder(parsed), ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']);
});

test('readingOrder reads a full-width line between the bands it cuts, and keeps a drop cap row together', () => {
	const page = {
		width: fx.PAGE_W,
		height: fx.PAGE_H,
		lines: [
			fx.lineOf(['top', 'left'], 56, 80), fx.lineOf(['top', 'right'], 296, 80),
			{ ...fx.lineOf(['A', 'WIDE', 'CAPTION'], 150, 120, 14), xMax: 412 },
			// A drop cap's remainder and the rest of its line: two boxes 0.6 pt apart on one row.
			fx.lineOf(['arry'], 78, 160.6), fx.lineOf(['woke', 'early'], 100, 160),
			fx.lineOf(['bottom', 'right'], 296, 160)
		]
	};
	const [parsed] = parseBboxLayout(fx.xhtmlOf([page]));
	assert.deepStrictEqual(readingOrder(parsed), ['top', 'left', 'top', 'right', 'A', 'WIDE', 'CAPTION', 'arry', 'woke', 'early', 'bottom', 'right']);
});

test('readingOrder joins a word broken by a line-end hyphen, and only before a lowercase start', () => {
	const page = {
		width: fx.PAGE_W,
		height: fx.PAGE_H,
		lines: [
			fx.lineOf(['the', 'stair-'], 56, 80),
			fx.lineOf(['case', 'creaked', 'won\u00ad'], 56, 93.2),
			fx.lineOf(['der', 'Smith-'], 56, 106.4),
			fx.lineOf(['Jones', 'left-'], 56, 119.6),
			// The column's last line runs on into the right column's first.
			fx.lineOf(['handed', 'end'], 296, 80)
		]
	};
	const [parsed] = parseBboxLayout(fx.xhtmlOf([page]));
	assert.deepStrictEqual(readingOrder(parsed), ['the', 'staircase', 'creaked', 'wonder', 'Smith-', 'Jones', 'lefthanded', 'end']);
});

test('readingOrder reads the text pdftotext escaped, and an empty or sizeless page as no words', () => {
	const xhtml = [
		'<doc>',
		'<page width="562.2" height="690.2">',
		'<line xMin="56" yMin="80" xMax="250" yMax="91">',
		'<word xMin="56" yMin="80" xMax="90" yMax="91">won&apos;t</word>',
		'<word xMin="92" yMin="80" xMax="120" yMax="91">&quot;Fish&quot;</word>',
		'<word xMin="122" yMin="80" xMax="130" yMax="91">&amp;</word>',
		'<word xMin="132" yMin="80" xMax="170" yMax="91">Dursleys&#8217;</word>',
		'<word xMin="172" yMin="80" xMax="200" yMax="91">caf&#xE9;</word>',
		'</line>',
		'</page>',
		'<page width="562.2" height="690.2">',
		'</page>',
		'</doc>'
	].join('\r\n');
	const pages = parseBboxLayout(xhtml);
	assert.deepStrictEqual(readingOrder(pages[0]), ['won\'t', 'Fish', 'Dursleys\u2019', 'caf\u00e9']);
	assert.deepStrictEqual(readingOrder(pages[1]), []);
	assert.deepStrictEqual(readingOrder({ width: 0, height: 0, lines: pages[0].lines }), []);
	assert.deepStrictEqual(readingOrder(null), []);
});

test('alignPages starts every page of a clean scan on its first word and every opener on its chapter', () => {
	const ebook = fx.makeEbook({ seed: 1 });
	const { book, keys, ek, r } = alignBook(ebook);
	assert.strictEqual(r.starts.length, book.length);
	assert.strictEqual(r.ends.length, book.length);
	for (const p of book) {
		const got = r.starts[p.n - 1];
		if (p.truth === null) assert.strictEqual(got, null, `page ${p.n} (${p.label}) should not align`);
		else assert.strictEqual(got, p.truth, `page ${p.n} (${p.label})`);
	}
	const openers = book.filter((p) => p.opener);
	assert.strictEqual(openers.length, 5);
	for (const p of openers) assert.strictEqual(r.starts[p.n - 1], startOf(ebook, p.label), p.label);
	// Each aligned page ends on the word before the next one starts.
	const aligned = book.filter((p) => r.starts[p.n - 1] !== null);
	for (let i = 1; i < aligned.length; i++) {
		assert.strictEqual(r.ends[aligned[i - 1].n - 1] + 1, r.starts[aligned[i].n - 1], `boundary before page ${aligned[i].n}`);
	}
	assert.strictEqual(r.ends[book.length - 2], ek.totalWords - 1);
	const textPages = keys.filter((k) => k.length >= DEFAULTS.textPageTokens).length;
	assert.deepStrictEqual(r.quality, { textPages, aligned: textPages - 1, share: (textPages - 1) / textPages });
	assert.ok(r.quality.share >= DEFAULTS.minShare);
});

test('alignPages refuses the front-matter page that matches the ebook\'s back matter', () => {
	const ebook = fx.makeEbook({ seed: 1 });
	const { book, r } = alignBook(ebook);
	const copyright = book.find((p) => p.label === 'copyright');
	const back = book.find((p) => p.label === 'About the Author');
	assert.ok(copyright.n < 5 && back.n > book.length - 3);
	assert.strictEqual(r.starts[copyright.n - 1], null);
	assert.strictEqual(r.starts[back.n - 1], startOf(ebook, 'About the Author'));
});

test('alignPages keeps openers exact and pages within a few words under heavy OCR noise', () => {
	const ebook = fx.makeEbook({ seed: 1 });
	for (const noise of [{ junk: 0.1, merge: 0.02, hyphen: 0.3, seed: 5 }, { junk: 0.3, merge: 0.03, hyphen: 0.3, seed: 6 }]) {
		const { book, r } = alignBook(ebook, noise);
		const body = book.filter((p) => p.kind === 'text' && /^Chapter /.test(p.label));
		let exact = 0;
		for (const p of body) {
			const got = r.starts[p.n - 1];
			if (p.opener) assert.strictEqual(got, p.truth, `${JSON.stringify(noise)} opener of ${p.label}`);
			assert.ok(got !== null && Math.abs(got - p.truth) <= 3, `${JSON.stringify(noise)} page ${p.n}: ${got} for ${p.truth}`);
			if (got === p.truth) exact++;
		}
		assert.ok(exact >= 0.9 * body.length, `${JSON.stringify(noise)}: ${exact} of ${body.length} exact`);
		assert.strictEqual(r.starts[book.find((p) => p.label === 'copyright').n - 1], null);
	}
});

test('alignPages takes page keys as plain arrays too, as decoded from pages.json', () => {
	const ebook = fx.makeEbook({ seed: 1, chapters: 2 });
	const { keys, ek, r } = alignBook(ebook);
	const plain = alignPages(keys.map((k) => Array.from(k)), { ...ek, keys: Array.from(ek.keys) });
	assert.deepStrictEqual(plain, r);
});

test('alignPages reports a PDF of another book as under minShare', () => {
	const ebook = fx.makeEbook({ seed: 1, chapters: 3 });
	const other = fx.makeEbook({ seed: 2, chapters: 3 });
	const book = fx.printBook(other, { junk: 0.05 });
	const keys = pageKeysOf(fx.xhtmlOf(book.map((p) => p.ocr)));
	const r = alignPages(keys, ebookKeys(ebook.text, ebook.index.sections));
	assert.ok(r.quality.textPages > 10);
	assert.ok(r.quality.share < DEFAULTS.minShare, `share ${r.quality.share}`);
	const empty = alignPages([], ebookKeys(ebook.text, ebook.index.sections));
	assert.deepStrictEqual(empty, { starts: [], ends: [], quality: { textPages: 0, aligned: 0, share: 0 } });
	const noText = alignPages([new Uint32Array(0), new Uint32Array(0)], ebookKeys(ebook.text, ebook.index.sections));
	assert.deepStrictEqual(noText.quality, { textPages: 0, aligned: 0, share: 0 });
});

// Where the offset jumps further than the DP's 650 words a page plus 200, it left out strong pages
// beside the jump, and their pictures took the start of the next placed page, past the gap. On
// #384 with scan pages 180-185 gone, page 178's picture came 4,251 words late.
test('alignPages keeps the pages beside a run of missing printed pages, and their pictures\' words', () => {
	const ebook = fx.makeEbook({ seed: 1, chapters: 4, chapterWords: 5000 });
	const { book, keys, ek, r: clean } = alignBook(ebook);
	const placed = (r, pictures) => pictureWords(pictures, r, { totalWords: ek.totalWords }).map((w) => [w.id, w.word, w.how]);
	for (const [from, count] of [[12, 3], [26, 6]]) {
		const gone = book.filter((p) => p.n >= from && p.n < from + count);
		assert.ok(gone.every((p) => p.kind === 'text' && /^Chapter /.test(p.label) && !p.opener), `gap ${from}+${count}`);
		const kept = book.filter((p) => p.n < from || p.n >= from + count);
		const r = alignPages(kept.map((p) => keys[p.n - 1]), ek);
		kept.forEach((p, i) => assert.strictEqual(r.starts[i], clean.starts[p.n - 1], `gap ${from}+${count}: page ${p.n}`));
		// A picture on each page from 8 before the gap to 8 after, numbered as each scan has it.
		const near = kept.filter((p) => p.n >= from - 8 && p.n < from + count + 8);
		const pictures = (numberOf) => near.map((p) => ({ id: `p${p.n}`, pages: [numberOf(p)], kind: p.kind === 'art' ? 'full' : 'part' }));
		const got = placed(r, pictures((p) => kept.indexOf(p) + 1));
		assert.deepStrictEqual(got, placed(clean, pictures((p) => p.n)), `gap ${from}+${count}`);
		assert.ok(got.length >= 14 && got.every((w, i) => !i || w[1] >= got[i - 1][1]), `gap ${from}+${count}: in reading order`);
	}
});

test('alignPages places the pages of a 2-up scan, which carry more words than the DP\'s step', () => {
	// Two printed pages of 30 lines a column to each scan page: about 900 OCR words on a sheet of
	// text alone. A plate on one half makes a sheet light, so the DP chains most of the book and
	// leaves out the sheets beside the heavy ones.
	const ebook = fx.makeEbook({ seed: 1, chapters: 4, chapterWords: 5000 });
	const { book, keys, ek, r: clean } = alignBook(ebook, { lines: 30, plateEvery: 2 });
	const sheets = [];
	for (let i = 0; i < book.length; i += 2) sheets.push(book.slice(i, i + 2));
	const r = alignPages(sheets.map((s) => Uint32Array.from(s.flatMap((p) => [...keys[p.n - 1]]))), ek);
	let heavy = 0;
	sheets.forEach((s, m) => {
		if (!s.some((p) => p.kind === 'text' && /^Chapter /.test(p.label))) return;
		const first = s.map((p) => clean.starts[p.n - 1]).find((w) => Number.isInteger(w));
		assert.strictEqual(r.starts[m], first, `sheet ${m + 1} (pages ${s.map((p) => p.n).join('+')})`);
		if (s.reduce((t, p) => t + keys[p.n - 1].length, 0) > DEFAULTS.step + DEFAULTS.slack) heavy++;
	});
	assert.ok(heavy >= 8, `${heavy} sheets over the step`);
	// Each plate shows with the text on its own sheet, never a later sheet's.
	const plates = sheets.flatMap((s, m) => s.filter((p) => p.label === 'plate').map((p) => ({ id: `p${p.n}`, pages: [m + 1], kind: 'part' })));
	assert.ok(plates.length >= 15);
	assert.deepStrictEqual(pictureWords(plates, r, { totalWords: ek.totalWords }).map((w) => [w.id, w.how]), plates.map((p) => [p.id, 'page-start']));
});

test('pictureWords places pictures by their page, the next text page or the previous page\'s end', () => {
	const ebook = fx.makeEbook({ seed: 1 });
	const { book, ek, r } = alignBook(ebook);
	const pageOf = (label) => book.find((p) => p.label === label).n;
	const c2 = book.filter((p) => p.label === 'Chapter 2');
	const spread = [pageOf('spread-left'), pageOf('spread-right')];
	const pictures = [
		{ id: 'p001', pages: [pageOf('cover')], kind: 'full' },
		{ id: `p00${pageOf('frontispiece')}`, pages: [pageOf('frontispiece')], kind: 'full' },
		{ id: 'mid', pages: [pageOf('mid-chapter')], kind: 'full' },
		{ id: 'part', pages: [c2[1].n], kind: 'part' },
		{ id: 'spread', pages: spread, kind: 'spread' },
		{ id: 'end', pages: [pageOf('endpaper')], kind: 'full' }
	];
	const got = pictureWords(pictures, r, { totalWords: ek.totalWords });
	const afterMid = book[pageOf('mid-chapter')];
	// A picture off its own page falls back to the last word of the page before it, which on this
	// clean scan is the word before the next page's start.
	assert.deepStrictEqual(got, [
		{ id: `p00${pageOf('frontispiece')}`, word: startOf(ebook, 'Chapter 1'), how: 'next-text', fallback: startOf(ebook, 'Chapter 1') - 1 },
		{ id: 'mid', word: afterMid.truth, how: 'next-text', fallback: afterMid.truth - 1 },
		{ id: 'part', word: c2[1].truth, how: 'page-start' },
		{ id: 'spread', word: startOf(ebook, 'Chapter 3'), how: 'next-text', fallback: startOf(ebook, 'Chapter 3') - 1 },
		// The last text page ends on the book's last word; the picture after it shows on that word.
		{ id: 'end', word: ek.totalWords - 1, how: 'prev-end', fallback: ek.totalWords - 1 }
	]);
});

test('pictureWords drops front matter, prefers a picture page\'s own text, and skips unaligned text pages', () => {
	const aligned = {
		starts: [null, null, 100, null, 300, null, null, 700, null, null],
		ends: [null, null, 299, null, 499, null, null, 899, null, null]
	};
	const got = pictureWords([
		{ id: 'front', pages: [2], kind: 'full' },
		{ id: 'own', pages: [3], kind: 'part' },
		{ id: 'unaligned-text', pages: [4], kind: 'part' },
		{ id: 'spread-own-right', pages: [5, 4], kind: 'spread' },
		{ id: 'skip-two', pages: [6], kind: 'full' },
		{ id: 'tail', pages: [9, 10], kind: 'spread' },
		{ id: 'bad', pages: [], kind: 'full' }
	], aligned, { totalWords: 5000 });
	assert.deepStrictEqual(got, [
		{ id: 'own', word: 100, how: 'page-start' },
		{ id: 'unaligned-text', word: 300, how: 'next-text', fallback: 299 },
		{ id: 'spread-own-right', word: 300, how: 'page-start' },
		{ id: 'skip-two', word: 700, how: 'next-text', fallback: 499 },
		{ id: 'tail', word: 900, how: 'prev-end', fallback: 899 }
	]);
	assert.deepStrictEqual(pictureWords([{ id: 'x', pages: [1], kind: 'full' }], { starts: [null, null], ends: [null, null] }, { totalWords: 10 }), []);
	assert.deepStrictEqual(pictureWords([{ id: 'x', pages: [2], kind: 'full' }], { starts: [5, null], ends: [9, null] }, { totalWords: 10 }), [{ id: 'x', word: 9, how: 'prev-end', fallback: 9 }]);
	assert.deepStrictEqual(pictureWords([{ id: 'x', pages: [2], kind: 'full' }], { starts: [5, null], ends: [9, null] }), [{ id: 'x', word: 10, how: 'prev-end', fallback: 9 }]);
});

// #384's last story picture (p259) takes the first back-matter page's start, which the narration
// never reaches once the read-along ends a book at its last chapter's last word. The fallback is
// that last word itself: the word after it is exactly the first one not narrated.
test('pictureWords gives a picture off its own page the last word of the aligned page before it, and only that one', () => {
	const aligned = { starts: [10, null, 200, null, 600, null, null], ends: [199, null, 599, null, 799, null, null] };
	const got = pictureWords([
		{ id: 'own', pages: [3], kind: 'part' },
		{ id: 'nearest', pages: [4], kind: 'full' },
		{ id: 'first', pages: [2], kind: 'full' },
		{ id: 'end', pages: [6, 7], kind: 'spread' }
	], aligned, { totalWords: 1000 });
	assert.deepStrictEqual(got, [
		{ id: 'own', word: 200, how: 'page-start' },
		{ id: 'nearest', word: 600, how: 'next-text', fallback: 599 },
		{ id: 'first', word: 200, how: 'next-text', fallback: 199 },
		{ id: 'end', word: 800, how: 'prev-end', fallback: 799 }
	]);
	// Clamped to the text's last word, as the word is.
	assert.deepStrictEqual(pictureWords([{ id: 'x', pages: [4], kind: 'full' }], aligned, { totalWords: 500 }), [{ id: 'x', word: 499, how: 'next-text', fallback: 499 }]);
	// No aligned page with an end before it: no fallback rather than a made-up one.
	assert.deepStrictEqual(pictureWords([{ id: 'x', pages: [2], kind: 'full' }], { starts: [5, null, 20], ends: [null, null, 30] }), [{ id: 'x', word: 20, how: 'next-text' }]);
});

test('DEFAULTS are the constants the design validated on #384', () => {
	assert.ok(Object.isFrozen(DEFAULTS));
	assert.deepStrictEqual(
		{ n: DEFAULTS.n, k: DEFAULTS.k, radius: DEFAULTS.radius, maxCandidates: DEFAULTS.maxCandidates, minVotes: DEFAULTS.minVotes, step: DEFAULTS.step, slack: DEFAULTS.slack, back: DEFAULTS.back, snap: DEFAULTS.snap, minShare: DEFAULTS.minShare },
		{ n: 3, k: 1, radius: 25, maxCandidates: 5, minVotes: 3, step: 650, slack: 200, back: 20, snap: 40, minShare: 0.6 }
	);
	// The fill pass's bar: it admits no page on #384's clean scan against either text.
	assert.strictEqual(DEFAULTS.fillMinVotes, 20);
});
