// helpers/calibreMatch.js: which Calibre record holds each audiobook work's book.
//
// The bug: Calibre metadata reached only books someone had opened the read-along for, and the
// read-along's matcher searched by the last word of the author string ("illustrator",
// "translator", a publisher's name) and missed subtitled titles. A naive replacement falls into the
// traps of the owner's own library: a record titled after its series against a work whose title
// starts with the series name, two translations of one text claiming one record, and a surname
// found inside another author's first name.
//
// Synthetic records and works only; each case mirrors one of those traps.

const test = require('node:test');
const assert = require('node:assert');
const calibreMatch = require('../helpers/calibreMatch.js');

function work(over = {}) {
	return { id: `avery-quill/${Math.random().toString(36).slice(2)}`, kind: 'book', title: 'The Lantern Road', author: 'Avery Quill', series: null, sequence: null, aliases: [], ...over };
}

function rec(over = {}) {
	return { uuid: `uuid-${Math.random().toString(36).slice(2)}`, title: 'The Lantern Road', authors: ['Avery Quill'], series: null, index: null, tags: [], isbn: null, formats: ['epub'], ...over };
}

const match = (w, books, opts = {}) => calibreMatch.matchWork(w, books, { libraryId: 'Test_Library', ...opts });

test('a cleaned title and the author surname give an exact match that carries the uuid and library', () => {
	const books = { 7: rec({ title: 'The lantern road: A Novel', authors: ['A. Quill'] }) };
	const m = match(work(), books);
	assert.strictEqual(m.verdict, 'exact');
	assert.strictEqual(m.id, 7);
	assert.strictEqual(m.uuid, books[7].uuid);
	assert.strictEqual(m.libraryId, 'Test_Library');
});

test('a marketing subtitle with "Book 1 of the ..." and a bracketed tail still matches the plain title', () => {
	const books = { 7: rec({ title: 'The Lantern Road: Book 1 of the Tidewater Cycle (Now a Major TV Series)' }) };
	assert.strictEqual(match(work({ title: 'The Lantern Road: Book One of the Tidewater Cycle' }), books).id, 7);
	assert.strictEqual(match(work(), books).id, 7);
});

// The bug: "Mistborn - Collected Tales" cut to its main title is "Mistborn", the title of the
// record that holds book one.
test('a work whose title starts with its series name never matches the record titled after the series', () => {
	const books = { 299: rec({ title: 'Ashfall', series: 'The Ashfall Saga', index: 1 }) };
	const tales = work({ title: 'Ashfall - Collected Tales', series: 'Ashfall', sequence: 7 });
	assert.strictEqual(match(tales, books).verdict, 'none');
	const first = work({ title: 'The Ember Throne', series: 'Ashfall', sequence: 1 });
	const m = match(first, books);
	assert.strictEqual(m.verdict, 'exact');
	assert.strictEqual(m.method, 'series, number and author');
	assert.strictEqual(m.id, 299);
});

test('a record titled after the series with no series of its own needs the number to agree', () => {
	const books = { 5: rec({ title: 'Ashfall', series: null, index: 1 }) };
	assert.strictEqual(match(work({ title: 'The Salt Crown', series: 'Ashfall', sequence: 2 }), books).verdict, 'none');
});

test('"Series: Title" matches the title on its own, both ways round', () => {
	const books = { 9: rec({ title: 'Ashfall: The Ember Throne', series: 'Ashfall', index: null }) };
	assert.strictEqual(match(work({ title: 'The Ember Throne', series: 'Ashfall', sequence: 1 }), books).id, 9);
	const plain = { 10: rec({ title: 'The Ember Throne' }) };
	assert.strictEqual(match(work({ title: 'Ashfall: The Ember Throne', series: 'Ashfall', sequence: 1 }), plain).id, 10);
});

test('two subtitles under one main title are two books', () => {
	const books = { 3: rec({ title: 'Heroes: Mortals and Monsters' }) };
	assert.strictEqual(match(work({ title: 'Heroes: The Myths Retold' }), books).verdict, 'none');
});

// The bug: a substring search for "Quill" found Quillon Harrow's books.
test('the surname must be the last word of one of the record\'s authors', () => {
	const books = { 4: rec({ authors: ['Quill Harrow'] }) };
	assert.strictEqual(match(work(), books).verdict, 'none');
	assert.deepStrictEqual(calibreMatch.authorSurnames('Ilse Moreau, Corin Vale - translator'), ['moreau', 'vale']);
	assert.deepStrictEqual(calibreMatch.authorSurnames('BBC/Corin Vale/Various'), ['vale']);
	assert.deepStrictEqual(calibreMatch.authorSurnames('Mara Lindqvist &#169;2012 by Tideworks Publishers'), ['lindqvist']);
});

test('two records that fit equally are ambiguous, listed and never picked', () => {
	const books = { 80: rec(), 81: rec() };
	const m = match(work(), books);
	assert.strictEqual(m.verdict, 'ambiguous');
	assert.strictEqual(m.id, null);
	assert.deepStrictEqual(m.candidates, [80, 81]);
});

test('several narrations of one title share one record', () => {
	const books = { 12: rec({ title: 'The Far Shore', authors: ['Ilse Moreau'] }) };
	const a = work({ id: 'ilse-moreau/the-far-shore~harlow', title: 'The Far Shore', author: 'Ilse Moreau', edition: 'Harlow' });
	const b = work({ id: 'ilse-moreau/the-far-shore~penrose', title: 'The Far Shore', author: 'Ilse Moreau', edition: 'Penrose' });
	const all = calibreMatch.matchAll([a, b], books, { libraryId: 'L' });
	assert.strictEqual(all[a.id].id, 12);
	assert.strictEqual(all[b.id].id, 12);
});

// The bug: the Fitzgerald and Lattimore Iliads both claimed the one record that named neither.
test('two translations each find the record naming their translator, and share none that names neither', () => {
	const fenn = work({ id: 'old-poet/the-long-song~mara-fenn-transl', title: 'The Long Song', author: 'Old Poet', edition: 'Mara Fenn transl' });
	const gray = work({ id: 'old-poet/the-long-song~tobias-gray-transl', title: 'The Long Song', author: 'Old Poet', edition: 'Tobias Gray transl.' });
	const own = {
		20: rec({ title: 'The Long Song', authors: ['Old Poet', 'Mara Fenn'] }),
		21: rec({ title: 'The Long Song of Old Poet', authors: ['Old Poet', 'Tobias Gray'] })
	};
	const both = calibreMatch.matchAll([fenn, gray], own);
	assert.strictEqual(both[fenn.id].id, 20);
	assert.strictEqual(both[gray.id].id, 21);

	const shared = { 30: rec({ title: 'The Long Song', authors: ['Old Poet'] }) };
	const neither = calibreMatch.matchAll([fenn, gray], shared);
	assert.strictEqual(neither[fenn.id].verdict, 'ambiguous');
	assert.strictEqual(neither[gray.id].verdict, 'ambiguous');
	assert.deepStrictEqual(neither[fenn.id].candidates, [30]);

	const one = { 40: rec({ title: 'The Long Song', authors: ['Old Poet', 'Mara Fenn'] }) };
	const named = calibreMatch.matchAll([fenn, gray], one);
	assert.strictEqual(named[fenn.id].id, 40);
	assert.strictEqual(named[gray.id].id, null);
	assert.strictEqual(named[gray.id].method, 'another translation');
});

test('one volume against the whole set, and a 0.6 title overlap, are only likely', () => {
	const volume = { 50: rec({ title: 'The Age of Lanterns' }) };
	const m = match(work({ title: 'The Age of Lanterns Vol 2' }), volume);
	assert.strictEqual(m.verdict, 'likely');
	assert.strictEqual(m.id, 50);
	const overlap = { 51: rec({ title: 'The Lantern Road Home' }) };
	assert.strictEqual(match(work(), overlap).verdict, 'likely');
});

test('a pin wins, a pin to none forbids, and a pin that no longer resolves is flagged, never replaced', () => {
	const books = { 7: rec(), 8: rec({ title: 'Something Else' }) };
	const w = work();
	assert.deepStrictEqual([match(w, books, { pin: { id: 8 } }).id, match(w, books, { pin: { id: 8 } }).method], [8, 'pin']);
	const none = match(w, books, { pin: { id: null } });
	assert.deepStrictEqual([none.id, none.verdict, none.method], [null, 'none', 'pin']);
	assert.strictEqual(match(w, books, { pin: { id: 9 } }).problem, 'missing');
	const moved = match(w, books, { pin: { id: 8, uuid: 'uuid-of-a-book-since-deleted' } });
	assert.deepStrictEqual([moved.verdict, moved.problem], ['none', 'uuid-changed']);
	assert.strictEqual(match(w, books, { pin: { id: 8, library: 'Other_Library' } }).problem, 'other-library');
	assert.strictEqual(match(w, books, { pin: { id: 8, uuid: books[8].uuid, library: 'Test_Library' } }).verdict, 'exact');
});

test('an ebook link, then the read-along\'s own book, come before any automatic match', () => {
	const books = { 7: rec(), 8: rec({ title: 'Something Else' }), 9: rec({ title: 'A Third' }) };
	assert.strictEqual(match(work(), books, { linkId: 8, pointerId: 9 }).method, 'link');
	assert.strictEqual(match(work(), books, { pointerId: 9 }).method, 'read-along');
	assert.strictEqual(match(work(), books, { linkId: 99 }).id, 7);
});

test('an ISBN on the work finds its record in either length', () => {
	const books = { 7: rec({ title: 'Different Title', isbn: '9780765350381' }), 8: rec() };
	const m = match(work({ isbn: '0765350386' }), books);
	assert.deepStrictEqual([m.id, m.method], [7, 'isbn']);
});

test('podcasts are left out of a catalog match', () => {
	const pod = work({ id: 'lantern-hollow/the-tin-valley', kind: 'podcast', title: 'The Lantern Road', author: 'Avery Quill' });
	assert.deepStrictEqual(Object.keys(calibreMatch.matchAll([pod], { 7: rec() })), []);
});

test('number words count as digits and accents are ignored', () => {
	assert.strictEqual(calibreMatch.titleVariants('Book One').clean, calibreMatch.titleVariants('Book 1').clean);
	const books = { 7: rec({ title: 'Ēmber Thrône', authors: ['Avery Quíll'] }) };
	assert.strictEqual(match(work({ title: 'Ember Throne' }), books).id, 7);
});

test('the read-along title score drops a main title that is only the series name', () => {
	assert.ok(calibreMatch.titleScore('The Lantern Road: Book One of the Tidewater Cycle', null, 'The Lantern Road: Book 1 of the Tidewater Cycle (Now a Major TV Series)', 'Tidewater Cycle') >= 0.8);
	assert.ok(calibreMatch.titleScore('Ashfall - Collected Tales', 'Ashfall', 'Ashfall', 'The Ashfall Saga') < 0.8);
});

// The bug: Calibre stores authors surname first ("Weir, Andy"), and the last word of that is the
// given name, so a work by the same person never matched its record, even with the title equal.
test("a calibre author written surname first is read as the person", () => {
	const w = work({ title: "The Red Planet", author: "Jo Vale" });
	const m = match(w, { 351: rec({ title: "The Red Planet", authors: ["Vale, Jo"] }) });
	assert.deepStrictEqual([m.id, m.verdict, m.method], [351, "exact", "title and author"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Vale, Jo"]), ["vale"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Marsh, J.R.R."]), ["marsh"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Marsh, Ida K."]), ["marsh"]);
	assert.strictEqual(match(work({ title: "Tin Crown", author: "J. R. R. Marsh" }), { 2: rec({ title: "Tin Crown", authors: ["Marsh, J.R.R."] }) }).id, 2);
});

test("a particle surname and a jr. suffix written surname first keep the last name", () => {
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Le Vale, Ida K."]), ["vale"]);
	assert.deepStrictEqual(calibreMatch.authorSurnames("Ida K. Le Vale"), ["vale"]);
	assert.strictEqual(match(work({ title: "The Salt Road", author: "Ida K. Le Vale" }), { 5: rec({ title: "The Salt Road", authors: ["Le Vale, Ida K."] }) }).id, 5);
	for (const a of ["Marsh, Corin Abel, Jr.", "Marsh, Jr., Corin Abel", "Corin Abel Marsh, Jr.", "Corin Abel Marsh Jr."]) {
		assert.deepStrictEqual(calibreMatch.recordSurnames([a]), ["marsh"], a);
	}
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Ida Marsh, LCSW"]), ["marsh"]);
	assert.strictEqual(match(work({ title: "Tide", author: "Corin Abel Marsh Jr." }), { 6: rec({ title: "Tide", authors: ["Marsh, Corin Abel, Jr."] }) }).id, 6);
});

test("several authors on one record, only one of them surname first, all count", () => {
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Ida Marsh", "Vale, Jo"]), ["marsh", "vale"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Vale, Jo; Marsh, Ida"]), ["vale", "marsh"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Ida Marsh, Corin Vale"]), ["marsh", "vale"]);
	const books = { 9: rec({ title: "The Red Planet", authors: ["Ida Marsh", "Vale, Jo"] }) };
	assert.strictEqual(match(work({ title: "The Red Planet", author: "Jo Vale" }), books).id, 9);
	assert.strictEqual(match(work({ title: "The Red Planet", author: "Ida Marsh" }), books).id, 9);
});

test("surname first never turns a given name or a credit list into a surname", () => {
	const books = { 4: rec({ title: "The Red Planet", authors: ["Vale, Jo"] }) };
	assert.strictEqual(match(work({ title: "The Red Planet", author: "Jo Valentine" }), books).verdict, "none");
	assert.strictEqual(match(work({ title: "The Red Planet", author: "Vale Jo" }), books).verdict, "none");
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Homer, Corin Vale"]), ["homer", "vale"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Homer, C. Vale - translator"]), ["homer", "vale"]);
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Unknown", "Various"]), []);
});

test("calibre authors are shown given name first", () => {
	assert.strictEqual(calibreMatch.displayAuthors(["Vale, Jo"]), "Jo Vale");
	assert.strictEqual(calibreMatch.displayAuthors(["Le Vale, Ida K.", "Corin Marsh"]), "Ida K. Le Vale & Corin Marsh");
	assert.strictEqual(calibreMatch.displayAuthors(["Marsh, Corin Abel, Jr."]), "Corin Abel Marsh Jr.");
	assert.strictEqual(calibreMatch.displayAuthors(["Vale, Jo; Marsh, J.R.R."]), "Jo Vale & J.R.R. Marsh");
	assert.strictEqual(calibreMatch.displayAuthors(["Homer, Corin Vale", "Ida Marsh, LCSW"]), "Homer, Corin Vale & Ida Marsh, LCSW");
	assert.strictEqual(calibreMatch.displayAuthors([]), "");
});

// Pins a known gap (see the header of helpers/calibreMatch.js) so that changing it is deliberate.
test("a one-word author then an initialed second name with no role reads as one person", () => {
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Homer, J. Vale"]), ["homer"]);
	assert.strictEqual(calibreMatch.displayAuthors(["Homer, J. Vale"]), "J. Vale Homer");
	assert.deepStrictEqual(calibreMatch.recordSurnames(["Homer, J. Vale - translator"]), ["homer", "vale"]);
});
