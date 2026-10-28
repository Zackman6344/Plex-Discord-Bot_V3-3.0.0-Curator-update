// helpers/bookMetadata.js: which source each displayed field of a work comes from.
//
// The bug: each of these shows a listener the wrong thing or undoes the owner's work. An owner's
// title or series edit replaced by a folder name on the next rescan, or by an online answer. An
// edit lost because the work was renamed and the entry sits under its old id. "Series: none"
// filled in again from below. An online lookup turning a folder's #0.5 into 2.5, renaming "The X
// Diaries" to "X Diaries", or naming one member of a cast as the narrator. A Calibre series number
// of 1 (Calibre's default) shown for a book with no series. A Calibre record titled in lower case,
// or after its series, replacing a good title. An online "Words Of The Tide" replacing a local
// "Words of the Tide" as a case fix. And any metadata source reaching a work's id, which would
// orphan its bookmarks and read-along links.
//
// Harness: plain synthetic works and layers (invented authors and titles); the online entries
// have the bookLookup cache-entry shape and one is made by the real matchProducts from a synthetic
// Audible-shaped product. The lookup cache env var points at a pid-suffixed temp file before the
// first require, though nothing here writes it.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

process.env.PLEXBOT_BOOK_LOOKUP_FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-metadata-lookup-${process.pid}.json`);

const meta = require('../helpers/bookMetadata.js');
const lookup = require('../helpers/bookLookup.js');
const bookCatalog = require('../helpers/bookCatalog.js');

const MIN = 60 * 1000;

function work(over = {}, detected = {}) {
	const d = Object.assign({
		title: 'The Ember Throne', author: 'Avery Quill', narrator: 'Morgan Vale', edition: 'Morgan Vale', publisher: null,
		series: 'Ashfall', sequence: 1,
		sources: { title: 'folder', author: 'plex-artist', narrator: 'folder', edition: 'folder', publisher: null, series: 'album', sequence: 'folder' },
	}, detected);
	return Object.assign({
		id: 'avery-quill/the-ember-throne', kind: 'book', aliases: [], confidence: 'high', detectedBy: 'median',
		folderKey: 'M:/Library/Music/Avery Quill/Ashfall 1 - The Ember Throne', totalMs: 600 * MIN,
		parts: [{ ordinal: 1, trackRatingKey: '9001', file: 'Ember 01.mp3', durationMs: 600 * MIN }],
		doubts: [],
		title: d.title, author: d.author, narrator: d.narrator, edition: d.edition, publisher: d.publisher,
		series: d.series, sequence: d.sequence, detected: d,
	}, over);
}

function entry(fields, outcome = 'edition') {
	return { queryKey: 'k', region: 'us', fetchedAt: 0, outcome, reason: 'runtime', asin: 'B0TEST0001', fields };
}

const pick = (w) => ({ title: w.title, author: w.author, narrator: w.narrator, edition: w.edition, publisher: w.publisher, series: w.series, sequence: w.sequence });

test('detected values come through with their sources folded to tag, plex and folder', () => {
	const w = work({}, { publisher: 'Lantern Audio', sources: { title: 'album', author: 'tag', narrator: 'folder', edition: 'folder', publisher: 'plex-artist', series: 'folder', sequence: 'folder' } });
	const r = meta.resolve(w);
	assert.deepStrictEqual(pick(r), pick(w));
	assert.deepStrictEqual(r.sources, { title: 'plex', author: 'tag', narrator: 'folder', edition: 'folder', publisher: 'plex', series: 'folder', sequence: 'folder' });
});

test('each field takes the highest source that has it: override, detection, then calibre and online blanks', () => {
	const w = work({}, { narrator: null, edition: null, publisher: null, series: null, sequence: null });
	const layers = {
		override: { narrator: 'Rhea Stone' },
		calibre: { title: 'The Ember Throne: A Novel', authors: ['A. Quill'], series: 'Ashfall Saga', seriesIndex: 1 },
		online: entry({ title: 'Ember Throne', series: 'Ashfall', position: '3', sequence: 3, narrators: ['Kit Moss'], narrator: 'Kit Moss', publisher: 'Lantern Audio' }),
	};
	const r = meta.resolve(w, layers);
	assert.deepStrictEqual(pick(r), {
		title: 'The Ember Throne', author: 'Avery Quill', narrator: 'Rhea Stone', edition: null, publisher: 'Lantern Audio',
		series: 'Ashfall Saga', sequence: 1,
	});
	assert.deepStrictEqual(r.sources, { title: 'folder', author: 'plex', narrator: 'override', edition: null, publisher: 'online', series: 'calibre', sequence: 'calibre' });
});

test('calibre fills only blanks: a lower-case or series-named record never replaces a title, author, series or number', () => {
	const lowerCase = meta.resolve(work(), { calibre: { title: 'The ember throne', authors: ['A. Quill'], series: 'Ashfall Saga', seriesIndex: 4 } });
	assert.deepStrictEqual(pick(lowerCase), pick(work()), 'every detected value stays');
	assert.deepStrictEqual([lowerCase.sources.title, lowerCase.sources.author, lowerCase.sources.series, lowerCase.sources.sequence], ['folder', 'plex', 'plex', 'folder']);
	const seriesNamed = meta.resolve(work(), { calibre: { title: 'Ashfall', authors: ['Avery Quill'], series: 'Ashfall', seriesIndex: 1 } });
	assert.deepStrictEqual([seriesNamed.title, seriesNamed.sources.title], ['The Ember Throne', 'folder'], 'a record titled after its series is no title for the book');

	const number = meta.resolve(work({}, { sequence: null }), { calibre: { series: 'ashfall', seriesIndex: 2 } });
	assert.deepStrictEqual([number.series, number.sequence, number.sources.series, number.sources.sequence], ['Ashfall', 2, 'plex', 'calibre'], 'a blank number beside the same series is filled');
	const otherSeries = meta.resolve(work({}, { sequence: null }), { calibre: { series: 'Ember Cycle', seriesIndex: 2 } });
	assert.deepStrictEqual([otherSeries.series, otherSeries.sequence], ['Ashfall', null], 'a number for another series is not taken');
	const numberKept = meta.resolve(work({}, { series: null, sequence: 3 }), { calibre: { series: 'Ashfall', seriesIndex: 1 } });
	assert.deepStrictEqual([numberKept.series, numberKept.sequence, numberKept.sources.series, numberKept.sources.sequence], ['Ashfall', 3, 'calibre', 'folder'], 'the series fills, the folder\'s number stays');
	const noIndex = meta.resolve(work(), { calibre: { series: 'Ashfall', seriesIndex: null } });
	assert.strictEqual(noIndex.sequence, 1, 'a record without a number blanks nothing');

	const blankTitle = meta.resolve(work({}, { title: null, author: null }), { calibre: { title: 'The ember throne', authors: ['Avery Quill'] } });
	assert.deepStrictEqual([blankTitle.title, blankTitle.author, blankTitle.sources.title, blankTitle.sources.author], ['The ember throne', 'Avery Quill', 'calibre', 'calibre'], 'what nothing else gave is filled as Calibre has it');
	assert.strictEqual(meta.resolve(work(), { override: { series: null, sequence: null }, calibre: { series: 'Ashfall', seriesIndex: 1 } }).series, null, 'series none stays none');
	assert.strictEqual(meta.resolve(work({}, { series: null, sequence: null }), { authorOverride: { series: 'The Quill Books' }, calibre: { series: 'Ashfall', seriesIndex: 1 } }).series, 'The Quill Books', 'the owner\'s author default beats a Calibre fill');
});

test('a case fix from calibre or online needs the same title, properly cased', () => {
	const caseFixed = meta.resolve(work({}, { title: 'Words Of The Tide' }), { calibre: { title: 'Words of the Tide' } });
	assert.deepStrictEqual([caseFixed.title, caseFixed.sources.title, caseFixed.id], ['Words of the Tide', 'calibre', 'avery-quill/the-ember-throne']);

	const good = work({}, { title: 'Words of the Tide', sources: { title: 'album', author: 'plex-artist', narrator: 'folder', edition: 'folder', publisher: null, series: 'album', sequence: 'folder' } });
	for (const worse of ['Words Of The Tide', 'words of the tide', 'Words of the tide', 'WORDS OF THE TIDE']) {
		const online = meta.resolve(good, { online: entry({ title: worse }, 'book') });
		assert.deepStrictEqual([online.title, online.sources.title], ['Words of the Tide', 'plex'], `online ${worse}`);
		const calibre = meta.resolve(good, { calibre: { title: worse } });
		assert.deepStrictEqual([calibre.title, calibre.sources.title], ['Words of the Tide', 'plex'], `calibre ${worse}`);
	}
	assert.strictEqual(meta.resolve(work({}, { title: 'Words Of The Tide' }), { calibre: { title: 'The Words of the Tide' } }).title, 'Words Of The Tide', 'other words are no case fix');
	assert.strictEqual(meta.resolve(work({}, { title: 'Words Of The Tide' }), { override: { title: 'Words Of The Tide' }, calibre: { title: 'Words of the Tide' } }).title, 'Words Of The Tide', 'an owner\'s spelling stays');
});

test('an override is never replaced by calibre, detection or online', () => {
	const o = { title: 'The Ember Throne (Revised)', author: 'A. Quill', narrator: 'Rhea Stone', edition: 'Rhea Stone', publisher: 'Tidewater', series: 'Ashfall Cycle', sequence: 4 };
	const layers = {
		override: o,
		calibre: { title: 'Ember Throne', authors: ['Avery Quill'], series: 'Ashfall', seriesIndex: 9 },
		online: entry({ title: 'The Ember Throne (revised)', series: 'Ashfall', sequence: 1, narrators: ['Kit Moss'], narrator: 'Kit Moss', publisher: 'Lantern Audio' }),
	};
	const r = meta.resolve(work(), layers);
	assert.deepStrictEqual(pick(r), o);
	for (const f of meta.FIELDS) assert.strictEqual(r.sources[f], 'override', f);
});

test('an explicit null in an override means none, and no lower source fills it', () => {
	const w = work({}, { narrator: null, sources: { title: 'folder', author: 'plex-artist', narrator: null, edition: 'folder', publisher: null, series: 'album', sequence: 'folder' } });
	const layers = {
		override: { series: null, sequence: null, narrator: null, edition: null, title: null, author: null },
		calibre: { title: null, authors: [], series: 'Ashfall', seriesIndex: 2 },
		online: entry({ title: 'The Ember Throne', series: 'Ashfall', position: '1', sequence: 1, narrators: ['Kit Moss'], narrator: 'Kit Moss', publisher: null }),
	};
	const r = meta.resolve(w, layers);
	assert.strictEqual(r.series, null);
	assert.strictEqual(r.sequence, null);
	assert.strictEqual(r.narrator, null);
	assert.strictEqual(r.edition, null);
	assert.deepStrictEqual([r.sources.series, r.sources.sequence, r.sources.narrator, r.sources.edition], ['override', 'override', 'override', 'override']);
	assert.strictEqual(r.title, 'The Ember Throne', 'a book always keeps a title');
	assert.strictEqual(r.author, 'Avery Quill', 'and an author');
});

test('clearing an override field falls back one layer', () => {
	const calibre = { title: 'The Ember Throne', authors: ['Avery Quill'], series: 'Ashfall Saga', seriesIndex: 1 };
	const unnumbered = work({}, { series: null, sequence: null });
	const edited = meta.resolve(unnumbered, { override: { series: 'Ember Cycle', sequence: 2 }, calibre });
	assert.deepStrictEqual([edited.series, edited.sequence, edited.sources.series], ['Ember Cycle', 2, 'override']);
	const cleared = meta.resolve(unnumbered, { override: {}, calibre });
	assert.deepStrictEqual([cleared.series, cleared.sequence, cleared.sources.series], ['Ashfall Saga', 1, 'calibre']);
	const noCalibre = meta.resolve(work(), { override: {} });
	assert.deepStrictEqual([noCalibre.series, noCalibre.sequence, noCalibre.sources.series], ['Ashfall', 1, 'plex']);
});

test('a series edit without a number keeps the number detection found, as the build always did', () => {
	const r = meta.resolve(work(), { override: { series: 'Ashfall Cycle' } });
	assert.deepStrictEqual([r.series, r.sequence, r.sources.sequence], ['Ashfall Cycle', 1, 'folder']);
	const applied = bookCatalog.applyOverrides([work()], { works: { [work().id]: { series: 'Ashfall Cycle' } } })[work().id];
	assert.deepStrictEqual([applied.series, applied.sequence], [r.series, r.sequence], 'the same answer as applyOverrides');
});

test('an author-level series and order names every book of that author and changes no id', () => {
	const overrides = { authors: { 'corin-vale': { series: 'The Tide Cantos', order: { 'The Long Tide': 1, 'the low tide!': 2 } } } };
	const books = [
		work({ id: 'corin-vale/the-long-tide' }, { title: 'The Long Tide', author: 'Corin Vale', series: null, sequence: null }),
		work({ id: 'corin-vale/the-low-tide~harlow' }, { title: 'The Low Tide', author: 'Corin Vale', series: null, sequence: null }),
		work({ id: 'corin-vale/a-short-tale' }, { title: 'A Short Tale', author: 'Corin Vale', series: null, sequence: null }),
	];
	const out = books.map((w) => meta.resolveWith(w, { overrides }));
	assert.deepStrictEqual(out.map((w) => [w.id, w.series, w.sequence]), [
		['corin-vale/the-long-tide', 'The Tide Cantos', 1],
		['corin-vale/the-low-tide~harlow', 'The Tide Cantos', 2],
		['corin-vale/a-short-tale', null, null],
	], 'a title the order does not list is left alone, as applyOverrides does');
	assert.deepStrictEqual([out[0].sources.series, out[0].sources.sequence], ['override', 'override']);
	assert.strictEqual(out[0].detected.series, null, 'detected stays what detection found');

	const display = meta.resolveWith(work({ id: 'corin-vale/the-long-tide', author: 'C. Vale' }, { title: 'The Long Tide', author: 'Corin Vale', series: null, sequence: null }), { overrides: { authors: { 'Corin Vale': { series: 'The Tide Cantos', order: { 'The Long Tide': 1 } } }, works: { 'corin-vale/the-long-tide': { author: 'C. Vale' } } } });
	assert.deepStrictEqual([display.author, display.series, display.sequence], ['C. Vale', 'The Tide Cantos', 1], 'keyed by the detected author; a hand-written unslugged key still counts');
});

// The bug: an author series written against the author and titles detection gave before the
// version 5 cleanup (a credit list for an author, a store tail on a title) stopped applying
// silently once the work's detected author and title changed.
test('an author-series written against a v4 author and title follows the work through its aliases', () => {
	const oldAuthor = 'corin-vale-jo-reed-169-2012-by-harbour-books';
	const overrides = { authors: { [oldAuthor]: { series: 'Owner Tides', order: { 'The Long Tide: Book One of the Tides': 9 } } } };
	const moved = work({ id: 'corin-vale/the-long-tide', aliases: [`${oldAuthor}/the-long-tide-book-one-of-the-tides`] },
		{ title: 'The Long Tide', author: 'Corin Vale', series: null, sequence: null });
	const out = meta.resolveWith(moved, { overrides });
	assert.deepStrictEqual([out.series, out.sequence, out.sources.series], ['Owner Tides', 9, 'override']);
	const now = { authors: { ...overrides.authors, 'corin-vale': { series: 'Newer' } } };
	assert.strictEqual(meta.authorOverrideFor(moved, now).series, 'Newer', 'an entry under the current author comes first');
	const notes = bookCatalog.authorOverrideNotes({ authors: { ...overrides.authors, 'nobody-here': { series: 'X' }, 'corin-vale': { order: { 'Gone Title': 1 } } } }, [moved]);
	assert.deepStrictEqual(notes, ['overrides name an author no work has: nobody-here', 'overrides for corin-vale order 1 title(s) no work of theirs has: Gone Title']);
});

test('an author-level series without an order only fills books with no series', () => {
	const overrides = { authors: { 'avery-quill': { series: 'The Quill Books' } } };
	const none = meta.resolveWith(work({}, { series: null, sequence: null }), { overrides });
	assert.deepStrictEqual([none.series, none.sources.series], ['The Quill Books', 'override']);
	const some = meta.resolveWith(work(), { overrides });
	assert.deepStrictEqual([some.series, some.sources.series], ['Ashfall', 'plex']);
	const online = meta.resolveWith(work({}, { series: null, sequence: null }), { overrides, onlineOf: () => entry({ series: 'Ashfall', sequence: 1, position: '1' }, 'book') });
	assert.strictEqual(online.series, 'The Quill Books', 'the owner\'s default beats an online fill');
	assert.strictEqual(online.sequence, null, 'a number for another series is not taken');
});

test('an override is found through an alias, and the current id\'s entry wins field by field', () => {
	const w = work({ id: 'avery-quill/the-ember-throne', aliases: ['untitled/ember', 'old/ember'] });
	const overrides = { works: {
		'old/ember': { title: 'Old Title', narrator: 'Old Narrator', series: 'Old Series' },
		'untitled/ember': { narrator: 'Rhea Stone', exclude: false },
		'avery-quill/the-ember-throne': { title: 'The Ember Throne, Revised' },
	} };
	assert.deepStrictEqual(meta.overrideFor(w, overrides), { title: 'The Ember Throne, Revised', narrator: 'Rhea Stone', exclude: false, series: 'Old Series' });
	const r = meta.resolveWith(w, { overrides });
	assert.deepStrictEqual([r.title, r.narrator, r.series], ['The Ember Throne, Revised', 'Rhea Stone', 'Old Series']);
	assert.strictEqual(meta.overrideFor(w, { works: { constructor: { title: 'x' } } }), null);
	assert.strictEqual(meta.overrideFor(work({ id: '__proto__' }), JSON.parse('{"works":{"__proto__":{"title":"x"}}}')).title, 'x');
});

test('online data fills only blanks: a different number or a respelled series stays as given', () => {
	const w = work({}, { title: 'Dawnbreaker', narrator: null, edition: null, publisher: null, series: 'The Rust Ledger', sequence: 0.5,
		sources: { title: 'folder', author: 'plex-artist', narrator: null, edition: null, publisher: null, series: 'folder', sequence: 'folder' } });
	const online = entry({ title: 'Dawnbreaker', series: 'Rust Ledger', position: '2.5', sequence: 2.5, narrators: ['Kit Moss'], narrator: 'Kit Moss', publisher: 'Lantern Audio' });
	const r = meta.resolve(w, { online });
	assert.deepStrictEqual([r.series, r.sequence, r.sources.sequence], ['The Rust Ledger', 0.5, 'folder']);
	assert.deepStrictEqual([r.narrator, r.sources.narrator], ['Kit Moss', 'online']);
	assert.deepStrictEqual([r.publisher, r.sources.publisher], ['Lantern Audio', 'online']);

	const blankSeries = meta.resolve(work({}, { series: null, sequence: null }), { online: entry({ series: 'Ashfall', position: '1', sequence: 1 }, 'book') });
	assert.deepStrictEqual([blankSeries.series, blankSeries.sequence, blankSeries.sources.series, blankSeries.sources.sequence], ['Ashfall', 1, 'online', 'online']);
	const numberOnly = meta.resolve(work({}, { sequence: null }), { online: entry({ series: 'Ashfall', position: '3', sequence: 3 }, 'book') });
	assert.deepStrictEqual([numberOnly.sequence, numberOnly.sources.sequence], [3, 'online'], 'a number beside the same series fills a blank');
	const omnibus = meta.resolve(work({}, { sequence: null }), { online: entry({ series: 'Ashfall', position: '1-3', sequence: null, omnibus: true }, 'book') });
	assert.strictEqual(omnibus.sequence, null);
});

test('online fixes a title\'s case and punctuation only when tags, plex or the folder gave it', () => {
	const online = entry({ title: 'Words of the Tide', series: 'Ashfall', sequence: 1 }, 'book');
	const folder = meta.resolve(work({}, { title: 'Words Of The Tide' }), { online });
	assert.deepStrictEqual([folder.title, folder.sources.title], ['Words of the Tide', 'online']);
	assert.strictEqual(folder.id, 'avery-quill/the-ember-throne');
	const apostrophe = meta.resolve(work({}, { title: 'The Tinkers Road' }), { online: entry({ title: 'The Tinker\'s Road' }, 'book') });
	assert.strictEqual(apostrophe.title, 'The Tinker\'s Road');

	assert.strictEqual(meta.resolve(work({}, { title: 'Words Of The Tide' }), { online, override: { title: 'Words Of The Tide' } }).title, 'Words Of The Tide', 'an owner\'s spelling stays');
	assert.strictEqual(meta.resolve(work({}, { title: null }), { online, calibre: { title: 'Words Of The Tide' } }).title, 'Words Of The Tide', 'so does a title Calibre filled');
	const reworded = meta.resolve(work({}, { title: 'Tide Words' }), { online: entry({ title: 'The Tide Words' }, 'book') });
	assert.deepStrictEqual([reworded.title, reworded.sources.title], ['Tide Words', 'folder'], 'a title that differs in words is not a case fix');
});

test('online never names a single narrator for a cast', () => {
	const noNarrator = { narrator: null, edition: 'GraphicAudio', publisher: 'GraphicAudio', sources: { title: 'folder', author: 'tag', narrator: null, edition: 'plex-artist', publisher: 'plex-artist', series: 'album', sequence: 'folder' } };
	const fullCast = meta.resolve(work({}, noNarrator), { online: entry({ narrators: ['A B', 'C D', 'E F', 'G H'], narrator: 'full cast', publisher: 'GraphicAudio' }) });
	assert.strictEqual(fullCast.narrator, null);
	const trio = meta.resolve(work({}, noNarrator), { online: entry({ narrators: ['Kit Moss', 'Lee Park'], narrator: 'Kit Moss, Lee Park' }) });
	assert.strictEqual(trio.narrator, 'Kit Moss, Lee Park', 'a named list from the edition match is the narration');

	const cutShortCast = { narrator: null, edition: 'Mara Lindqvist', publisher: null, sources: { title: 'folder', author: 'plex-artist', narrator: null, edition: 'album', publisher: null, series: 'album', sequence: 'folder' } };
	const r = meta.resolve(work({}, cutShortCast), { online: entry({ narrators: ['Mara Lindqvist'], narrator: 'Mara Lindqvist' }) });
	assert.deepStrictEqual([r.narrator, r.edition], [null, 'Mara Lindqvist'], 'the edition was a cut-short cast list');
});

test('an online number needs a series beside it', () => {
	const r = meta.resolve(work({}, { series: null, sequence: null }), { override: { series: null }, online: entry({ series: 'Ashfall', position: '2', sequence: 2 }, 'book') });
	assert.deepStrictEqual([r.series, r.sequence], [null, null]);
	const locked = meta.resolve(work({}, { sequence: null }), { override: { sequence: null }, online: entry({ series: 'Ashfall', position: '2', sequence: 2 }, 'book') });
	assert.strictEqual(locked.sequence, null);
});

test('a real matchProducts answer resolves through the same rules', () => {
	const product = {
		asin: 'B0TEST0002', title: 'Words of the Tide (Dramatized Adaptation)', authors: [{ name: 'Avery Quill' }],
		narrators: ['A B', 'C D', 'E F', 'G H', 'I J'].map((name) => ({ name })), publisher_name: 'Graphic Audio, LLC',
		runtime_length_min: 300, release_date: '2020-01-01', language: 'english', format_type: 'unabridged',
		content_delivery_type: 'SinglePartBook', publication_name: 'Ashfall Diaries', series: [{ title: 'Ashfall Diaries', sequence: '1' }],
	};
	const w = work({}, { title: 'Words Of The Tide', narrator: null, edition: 'GraphicAudio', publisher: 'GraphicAudio', series: 'The Ashfall Diaries', sequence: null,
		sources: { title: 'tag', author: 'tag', narrator: null, edition: 'tag', publisher: 'tag', series: 'tag', sequence: null } });
	w.totalMs = 300 * MIN;
	const local = { title: w.title, author: w.author, series: w.series, narrator: w.narrator, publisher: w.publisher, totalMs: w.totalMs };
	const r = lookup.matchProducts(local, [product], { region: 'us', now: Date.parse('2026-10-16T00:00:00Z') });
	assert.strictEqual(r.outcome, 'edition');
	const out = meta.resolve(w, { online: { queryKey: 'k', fetchedAt: 0, outcome: r.outcome, reason: r.reason, asin: r.asin, fields: r.fields } });
	assert.strictEqual(out.series, 'The Ashfall Diaries', 'the tags\' spelling stays');
	assert.deepStrictEqual([out.sequence, out.sources.sequence], [1, 'online'], 'the blank number beside an equivalent series is filled');
	assert.strictEqual(out.narrator, null, 'a full cast is no narrator');
	assert.deepStrictEqual([out.title, out.sources.title], ['Words of the Tide', 'online'], 'the case is fixed and the edition marker is not shown');
});

test('ids, aliases, folder keys, parts, kind and confidence are never touched, and the input is not changed', () => {
	const w = work({ aliases: ['old/ember'] });
	const before = JSON.stringify(w);
	const r = meta.resolve(w, {
		override: { title: 'Another Title', author: 'Someone Else' },
		calibre: { title: 'Calibre Title', authors: ['C Author'], series: 'C Series', seriesIndex: 4 },
		online: entry({ title: 'Another title', series: 'S', sequence: 1 }),
	});
	assert.strictEqual(JSON.stringify(w), before);
	for (const k of ['id', 'aliases', 'folderKey', 'parts', 'kind', 'confidence', 'detectedBy', 'totalMs', 'detected', 'doubts']) assert.deepStrictEqual(r[k], w[k], k);
	assert.strictEqual(r.parts, w.parts, 'parts are shared, not copied');
	assert.notStrictEqual(r, w);
});

test('a work stored before detection was recorded starts from its own fields', () => {
	const w = work();
	delete w.detected;
	const r = meta.resolve(w, { override: { narrator: 'Rhea Stone' } });
	assert.deepStrictEqual(pick(r), Object.assign(pick(w), { narrator: 'Rhea Stone' }));
	assert.deepStrictEqual(r.sources, { title: null, author: null, narrator: 'override', edition: null, publisher: null, series: null, sequence: null });
});

test('layersFor asks the lookup with the work as it stands without the online layer, and survives a failing source', () => {
	const seen = [];
	const w = work({ aliases: ['old/ember'] });
	const layers = meta.layersFor(w, {
		overrides: { works: { 'old/ember': { title: 'Edited Title' } } },
		calibreOf: (x) => { seen.push(['calibre', x.id]); return { title: 'Calibre Title', authors: ['Avery Quill'] }; },
		onlineOf: (x) => { seen.push(['online', x.title, x.aliases.join()]); return entry({ narrator: 'Kit Moss', narrators: ['Kit Moss'] }); },
	});
	assert.deepStrictEqual(seen, [['calibre', w.id], ['online', 'Edited Title', 'old/ember']]);
	assert.strictEqual(layers.online.fields.narrator, 'Kit Moss');

	const failing = meta.layersFor(w, { calibreOf: () => { throw new Error('store'); }, onlineOf: () => { throw new Error('store'); } });
	assert.deepStrictEqual([failing.calibre, failing.online, failing.override, failing.authorOverride], [null, null, null, null]);
});

test('calibreFields joins several authors and drops a series number with no series', () => {
	assert.deepStrictEqual(meta.calibreFields({ title: ' Tide ', authors: ['Avery Quill', 'Corin Vale'], series: null, seriesIndex: 1 }), { title: 'Tide', author: 'Avery Quill & Corin Vale' });
	assert.deepStrictEqual(meta.calibreFields({ title: null, authors: [], series: 'Ashfall', seriesIndex: 2.5 }), { series: 'Ashfall', sequence: 2.5 });
	assert.deepStrictEqual(meta.calibreFields({ series: 'Ashfall', seriesIndex: null }), { series: 'Ashfall', sequence: null });
	assert.deepStrictEqual(meta.calibreFields(null), {});
});

test('differs notices a changed field or source and nothing else', () => {
	const w = meta.resolve(work());
	assert.strictEqual(meta.differs(w, meta.resolve(work())), false);
	assert.strictEqual(meta.differs(w, Object.assign({}, w, { notes: ['x'] })), false);
	assert.strictEqual(meta.differs(w, Object.assign({}, w, { title: 'Other' })), true);
	assert.strictEqual(meta.differs(w, Object.assign({}, w, { sources: Object.assign({}, w.sources, { title: 'online' }) })), true);
});
