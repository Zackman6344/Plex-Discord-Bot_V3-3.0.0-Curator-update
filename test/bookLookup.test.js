// helpers/bookLookup.js: the optional Audible catalog lookup.
//
// The bug: the catalog has no series for the Hyperion Cantos, shows folder capitals ("Words Of
// Radiance", "The Once And Future King") and cannot tell one narration from another. Asked
// carelessly, an online catalog makes it worse: a Spanish or German edition, an abridged or
// pre-order product, a part-split ("Hyperion & Endymion 4") or another narration's runtime taken
// for this recording; an omnibus range ("1-5") read as book 1; an "(Dramatized Adaptation)" suffix
// kept in the title; a narrator copied from a book match; a lookup sent while the setting is off,
// with more than the title and author in it, faster than once a second, or retried forever.
//
// Harness: the Audible answers are trimmed copies of real catalog responses (factual fields only)
// in test/fixtures/books/audible/; everything else is synthetic. fetch, the clock and sleep are
// injected, the cache is the real jsonStore pointed at a pid-suffixed temp file before the first
// require, and nothing touches the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const CACHE_FILE = pathMod.join(os.tmpdir(), `plexbot-test-book-lookup-${process.pid}.json`);
process.env.PLEXBOT_BOOK_LOOKUP_FILE = CACHE_FILE;

const lookup = require('../helpers/bookLookup.js');

const FIXTURES = pathMod.join(__dirname, 'fixtures', 'books', 'audible');
const fixture = (name) => JSON.parse(fs.readFileSync(pathMod.join(FIXTURES, `${name}.json`), 'utf8'));
const products = (name) => fixture(name).products;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse('2026-10-16T12:00:00Z');

test.afterEach(() => {
	fs.rmSync(CACHE_FILE, { force: true });
	fs.rmSync(`${CACHE_FILE}.tmp`, { force: true });
	lookup.store.reset();
});

function product(over = {}) {
	return Object.assign({
		asin: 'B0TEST0001',
		title: 'The Ember Throne',
		authors: [{ name: 'Avery Quill' }],
		narrators: [{ name: 'Morgan Vale' }],
		publisher_name: 'Lantern Audio',
		runtime_length_min: 600,
		release_date: '2020-01-01',
		language: 'english',
		format_type: 'unabridged',
		content_delivery_type: 'MultiPartBook',
		publication_name: 'Tidewater Cycle',
		series: [{ title: 'Tidewater Cycle', sequence: '1' }],
	}, over);
}

function local(over = {}) {
	return Object.assign({ title: 'The Ember Throne', author: 'Avery Quill', series: null, narrator: null, publisher: null, totalMs: 600 * MIN }, over);
}

const match = (l, list, opts = {}) => lookup.matchProducts(l, list, Object.assign({ now: NOW }, opts));

function work(over = {}) {
	return Object.assign({
		id: 'avery-quill/the-ember-throne', aliases: [], kind: 'book', title: 'The Ember Throne', author: 'Avery Quill',
		narrator: null, publisher: null, series: null, sequence: null, totalMs: 600 * MIN, doubts: [],
		folderKey: 'M:/Library/Music/Avery Quill/The Ember Throne', parts: [{ trackRatingKey: '9001' }],
	}, over);
}

function harness(opts = {}) {
	const clock = { t: NOW };
	const sleeps = [];
	const calls = [];
	const config = Object.assign({ audiobookOnlineLookup: true, audiobookLookupRegion: 'us' }, opts.config);
	const replies = opts.replies || [];
	const respond = opts.respond || (() => {
		const next = replies.length ? replies.shift() : { body: { products: [], total_results: 0 } };
		if (next instanceof Error) throw next;
		return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status || 200, headers: next.headers || {} });
	});
	const warnings = [];
	const instance = lookup.createLookup({
		fetch: async (url, init) => {
			calls.push({ url, init, at: clock.t });
			return respond(url, init);
		},
		now: () => clock.t,
		sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
		getConfig: () => config,
		log: { warn: (m) => warnings.push(m) },
		overrideOf: opts.overrideOf,
	});
	return { instance, clock, sleeps, calls, config, warnings };
}

// --- normalisation ----------------------------------------------------------------------------

test('titles compare without case, punctuation, brackets, a leading "the" or the series prefix', () => {
	assert.strictEqual(lookup.normTitle('Words Of Radiance'), lookup.normTitle('Words of Radiance'));
	assert.strictEqual(lookup.normTitle('All Systems Red (Dramatized Adaptation)'), 'all systems red');
	assert.strictEqual(lookup.normTitle('The Childrens Adventure'), lookup.normTitle('The Children\'s Adventure'));
	assert.strictEqual(lookup.normTitle('Swords & Sorcery'), 'swords and sorcery');
	assert.strictEqual(lookup.normTitle('Tidewater Cycle 2: The Glass Sea', ['Tidewater Cycle']), 'glass sea');
	assert.strictEqual(lookup.normTitle('Tidewater Cycle - The Glass Sea', ['Tidewater Cycle']), 'glass sea');
	assert.strictEqual(lookup.normTitle('Sapiens: A Brief History', ['Tidewater Cycle']), 'sapiens a brief history');
	assert.strictEqual(lookup.normTitle('Cr\u00e8me Br\u00fbl\u00e9e'), 'creme brulee');
});

test('authors compare by letters only and a translator credit is no author', () => {
	assert.strictEqual(lookup.normAuthor('T.H. White'), lookup.normAuthor('T. H. White'));
	assert.strictEqual(lookup.normAuthor('Carlos Gardini - translator'), '');
	const r = lookup.rejectReason(product({ authors: [{ name: 'Someone Else - translator' }, { name: 'A. Quill' }] }), local({ author: 'A.Quill' }), { language: 'english', today: '2026-10-16' });
	assert.strictEqual(r, null);
});

test('a cast list cut short with an ellipsis names no single narrator', () => {
	assert.deepStrictEqual(lookup.narratorSurnames('Terence Aselford,...'), []);
	assert.deepStrictEqual(lookup.narratorSurnames('Terence Aselford, Nora Pike\u2026'), []);
	assert.deepStrictEqual(lookup.narratorSurnames('Various'), []);
	assert.deepStrictEqual(lookup.narratorSurnames('Morgan Vale and Ida Brook'), ['vale', 'brook']);
});

// --- the research outcomes, on real catalog answers ---------------------------------------------

test('hyperion matches its audible studios edition as series hyperion #1', () => {
	const r = match(local({ title: 'Hyperion', author: 'Dan Simmons', narrator: 'Various', totalMs: 1245 * MIN }), products('hyperion'));
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.asin, 'B002V5BLIW');
	assert.strictEqual(r.fields.series, 'Hyperion');
	assert.strictEqual(r.fields.sequence, 1);
	assert.strictEqual(r.fields.narrator, 'full cast');
	assert.strictEqual(r.candidates, 1, 'the Spanish, German and other-title products are filtered out');
});

test('the bevine fall of hyperion matches its edition as #2', () => {
	const r = match(local({ title: 'The Fall of Hyperion', author: 'Dan Simmons', narrator: 'Bevine', totalMs: 1305 * MIN }), products('fall-of-hyperion'));
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.asin, 'B002V5D34W');
	assert.strictEqual(r.fields.sequence, 2);
	assert.strictEqual(r.fields.narrator, 'Victor Bevine');
});

test('the foushee fall of hyperion is a book match #2 that keeps the local narrator', () => {
	const l = local({ title: 'The Fall of Hyperion', author: 'Dan Simmons', narrator: 'Foushee', totalMs: 1159 * MIN });
	const r = match(l, products('fall-of-hyperion'));
	assert.strictEqual(r.outcome, 'book');
	assert.strictEqual(r.asin, null);
	assert.deepStrictEqual(r.fields, { title: 'The Fall of Hyperion', series: 'Hyperion', position: '2', sequence: 2, omnibus: false });
	const c = lookup.compare(r, l);
	assert.strictEqual(c.narrator.kind, 'none');
	assert.strictEqual(c.publisher.kind, 'none');
});

test('the graphicaudio all systems red matches its edition without the dramatized adaptation suffix', () => {
	const l = local({ title: 'All Systems Red', author: 'Martha Wells', series: 'The Murderbot Diaries', publisher: 'GraphicAudio', totalMs: 153 * MIN });
	const r = match(l, products('all-systems-red'));
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.asin, 'B0CHG25ZT7');
	assert.strictEqual(r.fields.title, 'All Systems Red');
	assert.strictEqual(r.fields.series, 'Murderbot Diaries');
	assert.strictEqual(r.fields.sequence, 1);
	assert.strictEqual(r.fields.publisher, 'GraphicAudio');
	assert.strictEqual(r.fields.narrator, 'full cast');
	assert.strictEqual(r.fields.narrators.length, 11);
	const c = lookup.compare(r, l);
	assert.strictEqual(c.series.kind, 'equivalent', 'the tags\' "The Murderbot Diaries" is not replaced');
	assert.strictEqual(c.publisher.kind, 'same');
	assert.strictEqual(c.narrator.fullCast, true);
});

test('the once and future king omnibus has its series and no number', () => {
	const l = local({ title: 'The Once And Future King', author: 'T.H. White', narrator: 'Neville Jason', totalMs: 1984 * MIN });
	const r = match(l, products('once-and-future-king'));
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.asin, 'B00546D584');
	assert.strictEqual(r.fields.publisher, 'Naxos AudioBooks');
	assert.strictEqual(r.fields.narrator, 'Neville Jason');
	assert.strictEqual(r.fields.series, 'Once and Future King');
	assert.strictEqual(r.fields.position, '1-5');
	assert.strictEqual(r.fields.sequence, null);
	assert.strictEqual(r.fields.omnibus, true);
	const c = lookup.compare(r, l);
	assert.strictEqual(c.title.kind, 'case-fix');
	assert.strictEqual(c.title.value, 'The Once and Future King');
	assert.strictEqual(c.sequence.kind, 'none');
	assert.strictEqual(c.narrator.kind, 'same');
});

test('the graphicaudio words of radiance is a book match #2 with the title case fixed', () => {
	const l = local({ title: 'Words Of Radiance', author: 'Brandon Sanderson', series: 'The Stormlight Archive', sequence: 2, publisher: 'GraphicAudio', totalMs: 2257 * MIN });
	const r = match(l, products('words-of-radiance'));
	assert.strictEqual(r.outcome, 'book');
	assert.strictEqual(r.fields.series, 'The Stormlight Archive', 'the publication_name entry wins over the Cosmere universe entry');
	assert.strictEqual(r.fields.sequence, 2);
	const c = lookup.compare(r, l);
	assert.strictEqual(c.title.kind, 'case-fix');
	assert.strictEqual(c.title.value, 'Words of Radiance');
	assert.strictEqual(c.sequence.kind, 'same');
	assert.strictEqual(c.narrator.kind, 'none');
});

test('edgedancer\'s local #0.5 is reported as a disagreement, never a fill', () => {
	const l = local({ title: 'Edgedancer', author: 'Brandon Sanderson', series: 'The Stormlight Archive', sequence: 0.5, publisher: 'GraphicAudio', totalMs: 217 * MIN });
	const r = match(l, products('stormlight-keywords'));
	assert.strictEqual(r.outcome, 'book');
	assert.strictEqual(r.fields.sequence, 2.5);
	const c = lookup.compare(r, l);
	assert.strictEqual(c.sequence.kind, 'differs');
	assert.strictEqual(c.sequence.local, 0.5);
});

test('music by tyler is never queried and an empty answer is no match', () => {
	const tyler = work({ id: 'tyler-the-creator/music', title: 'Music', author: 'Tyler, The Creator', doubts: [{ code: 'generic-title', title: 'Music' }] });
	assert.deepStrictEqual(lookup.eligibility(tyler), { ok: false, reason: 'doubtful' });
	const r = match(local({ title: 'Music', author: 'Tyler, The Creator', totalMs: 192 * MIN }), products('no-results'));
	assert.strictEqual(r.outcome, 'none');
	assert.strictEqual(r.reason, 'no-results');
});

// --- candidate filters ------------------------------------------------------------------------

test('each candidate filter rejects what it should', () => {
	const ctx = { language: 'english', today: '2026-10-16' };
	const l = local();
	assert.strictEqual(lookup.rejectReason(product(), l, ctx), null);
	assert.strictEqual(lookup.rejectReason(product({ language: 'spanish' }), l, ctx), 'language');
	assert.strictEqual(lookup.rejectReason(product({ format_type: 'abridged' }), l, ctx), 'abridged');
	assert.strictEqual(lookup.rejectReason(product({ content_delivery_type: 'PodcastParent' }), l, ctx), 'delivery');
	assert.strictEqual(lookup.rejectReason(product({ content_delivery_type: undefined }), l, ctx), 'delivery');
	assert.strictEqual(lookup.rejectReason(product({ release_date: '2027-01-01' }), l, ctx), 'unreleased');
	assert.strictEqual(lookup.rejectReason(product({ authors: [{ name: 'Someone Else' }] }), l, ctx), 'author');
	assert.strictEqual(lookup.rejectReason(product({ title: 'The Ember Throne & The Glass Sea' }), l, ctx), 'part-split');
	assert.strictEqual(lookup.rejectReason(product({ title: 'The Ember Throne 4' }), l, ctx), 'part-split');
	assert.strictEqual(lookup.rejectReason(product({ title: 'The Ember Thorn' }), l, ctx), 'title', 'a title of 12 characters or fewer must match exactly');
});

test('a title longer than 12 characters may differ by a letter or two', () => {
	const ctx = { language: 'english', today: '2026-10-16' };
	const l = local({ title: 'The Lighthouse Keepers' });
	assert.strictEqual(lookup.rejectReason(product({ title: 'The Lighthouse Keeper' }), l, ctx), null);
	assert.strictEqual(lookup.rejectReason(product({ title: 'The Lighthouse Thieves' }), l, ctx), 'title');
});

test('a part number or ampersand the local title has too is allowed', () => {
	const ctx = { language: 'english', today: '2026-10-16' };
	assert.strictEqual(lookup.rejectReason(product({ title: 'Catch 22' }), local({ title: 'Catch 22' }), ctx), null);
	assert.strictEqual(lookup.rejectReason(product({ title: 'Salt & Iron' }), local({ title: 'Salt & Iron' }), ctx), null);
});

test('the region decides the language a match must be in', () => {
	const r = match(local(), [product()], { region: 'de' });
	assert.strictEqual(r.outcome, 'none');
	assert.strictEqual(r.reason, 'no-candidates');
	assert.strictEqual(match(local(), [product({ language: 'german' })], { region: 'de' }).outcome, 'edition');
});

// --- edition and book ---------------------------------------------------------------------------

test('an edition matches on runtime within 3 percent or 10 minutes', () => {
	assert.strictEqual(match(local({ totalMs: 617 * MIN }), [product()]).outcome, 'edition');
	assert.strictEqual(match(local({ totalMs: 100 * MIN }), [product({ runtime_length_min: 109 })]).outcome, 'edition');
	assert.strictEqual(match(local({ totalMs: 640 * MIN }), [product()]).outcome, 'book');
});

test('a local narrator surname widens the runtime window to 10 percent', () => {
	const off = local({ totalMs: 650 * MIN });
	assert.strictEqual(match(off, [product()]).outcome, 'book');
	const r = match(Object.assign({}, off, { narrator: 'Vale' }), [product()]);
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.reason, 'runtime+narrator');
	assert.strictEqual(match(local({ totalMs: 700 * MIN, narrator: 'Vale' }), [product()]).outcome, 'book');
});

test('the local publisher widens the runtime window too', () => {
	const r = match(local({ totalMs: 650 * MIN, publisher: 'Lantern Audio, LLC.' }), [product()]);
	assert.strictEqual(r.outcome, 'edition');
	assert.strictEqual(r.reason, 'runtime+publisher');
});

test('the closest runtime wins among several editions', () => {
	const list = [product({ asin: 'B0TEST0001', runtime_length_min: 590 }), product({ asin: 'B0TEST0002', runtime_length_min: 603, narrators: [{ name: 'Ida Brook' }] })];
	assert.strictEqual(match(local(), list).asin, 'B0TEST0002');
});

test('two editions within 1 percent with different narrators fall back to a book match', () => {
	const list = [product({ asin: 'B0TEST0001', runtime_length_min: 600 }), product({ asin: 'B0TEST0002', runtime_length_min: 604, narrators: [{ name: 'Ida Brook' }] })];
	const r = match(local(), list);
	assert.strictEqual(r.outcome, 'book');
	assert.strictEqual(r.reason, 'close-editions');
	assert.strictEqual(r.fields.narrator, undefined);
	const same = [product({ asin: 'B0TEST0001', runtime_length_min: 600 }), product({ asin: 'B0TEST0002', runtime_length_min: 604 })];
	assert.strictEqual(match(local(), same).outcome, 'edition');
});

test('a book match needs every candidate to agree on series and position', () => {
	const off = local({ totalMs: 900 * MIN });
	const agree = [product({ asin: 'B0TEST0001' }), product({ asin: 'B0TEST0002', runtime_length_min: 300 })];
	assert.strictEqual(match(off, agree).outcome, 'book');
	const disagree = [product({ asin: 'B0TEST0001' }), product({ asin: 'B0TEST0002', series: [{ title: 'Tidewater Cycle', sequence: '2' }] })];
	const r = match(off, disagree);
	assert.strictEqual(r.outcome, 'none');
	assert.strictEqual(r.reason, 'disagree');
});

test('more than three distinct works passing is no match', () => {
	const l = local({ title: 'The Lighthouse Keepers', totalMs: 9000 * MIN });
	const list = ['The Lighthouse Keepers', 'The Lighthouse Keeper', 'The Lighthouse Keepers I', 'The Lighthouse Keepers.', 'The Lighthous Keepers', 'The Lighthouse Keeperz']
		.map((title, i) => product({ asin: `B0TEST000${i}`, title }));
	const r = match(l, list);
	assert.strictEqual(r.outcome, 'none');
	assert.strictEqual(r.reason, 'too-many-works');
});

test('the series is the publication_name entry, else the only numbered one', () => {
	assert.deepStrictEqual(lookup.seriesOf(product({ series: [{ title: 'Greater Tides' }, { title: 'Tidewater Cycle', sequence: '3' }] })), { name: 'Tidewater Cycle', position: '3' });
	assert.deepStrictEqual(lookup.seriesOf(product({ publication_name: 'Elsewhere', series: [{ title: 'Greater Tides' }, { title: 'Tidewater Cycle', sequence: '3' }] })), { name: 'Tidewater Cycle', position: '3' });
	assert.strictEqual(lookup.seriesOf(product({ publication_name: 'Elsewhere', series: [{ title: 'A', sequence: '1' }, { title: 'B', sequence: '2' }] })), null);
	assert.strictEqual(lookup.seriesOf(product({ publication_name: undefined, series: [{ title: 'Greater Tides' }] })), null);
});

test('a range or word position is an omnibus with no number', () => {
	assert.deepStrictEqual(lookup.positionInfo('1-5'), { position: '1-5', sequence: null, omnibus: true });
	assert.deepStrictEqual(lookup.positionInfo('2.5'), { position: '2.5', sequence: 2.5, omnibus: false });
	assert.deepStrictEqual(lookup.positionInfo(''), { position: null, sequence: null, omnibus: false });
});

test('more than three narrators show as full cast and three or fewer by name', () => {
	const three = match(local(), [product({ narrators: [{ name: 'A One' }, { name: 'B Two' }, { name: 'C Three' }] })]);
	assert.strictEqual(three.fields.narrator, 'A One, B Two, C Three');
	const four = match(local(), [product({ narrators: [{ name: 'A One' }, { name: 'B Two' }, { name: 'C Three' }, { name: 'D Four' }] })]);
	assert.strictEqual(four.fields.narrator, 'full cast');
});

// --- proposals ----------------------------------------------------------------------------------

test('compare fills only blanks and fixes a title only when case or punctuation differ', () => {
	const entry = { outcome: 'edition', fields: { title: 'The Ember Throne', series: 'Tidewater Cycle', position: '1', sequence: 1, omnibus: false, narrators: ['Morgan Vale'], narrator: 'Morgan Vale', publisher: 'Lantern Audio' } };
	const blank = lookup.compare(entry, { title: 'The Ember Throne' });
	assert.deepStrictEqual([blank.title.kind, blank.series.kind, blank.sequence.kind, blank.narrator.kind, blank.publisher.kind], ['same', 'fill', 'fill', 'fill', 'fill']);
	assert.strictEqual(lookup.compare(entry, { title: 'the ember-throne' }).title.kind, 'case-fix');
	assert.strictEqual(lookup.compare(entry, { title: 'Ember Throne' }).title.kind, 'equivalent', 'dropping "The" is not a case fix');
	assert.strictEqual(lookup.compare(entry, { title: 'The Glass Sea' }).title.kind, 'differs');
	assert.strictEqual(lookup.compare(entry, { series: 'tidewater cycle' }).series.kind, 'equivalent', 'a series is never case-fixed');
	assert.strictEqual(lookup.compare(entry, { series: 'Greater Tides' }).sequence.kind, 'differs', 'a number is not filled next to another series');
	assert.strictEqual(lookup.compare(entry, { narrator: 'Vale' }).narrator.kind, 'equivalent');
	assert.strictEqual(lookup.compare(entry, { narrator: 'Ida Brook' }).narrator.kind, 'differs');
});

test('the dan simmons author override series is reported as a disagreement, not replaced', () => {
	const entry = { outcome: 'edition', fields: { title: 'Hyperion', series: 'Hyperion', position: '1', sequence: 1, omnibus: false } };
	const c = lookup.compare(entry, { title: 'Hyperion', series: 'Hyperion Cantos', sequence: 1 });
	assert.strictEqual(c.series.kind, 'differs');
	assert.strictEqual(c.sequence.kind, 'same');
});

// --- eligibility --------------------------------------------------------------------------------

test('podcasts, doubtful works, publisher authors, excluded and locked works are skipped', () => {
	assert.deepStrictEqual(lookup.eligibility(work()), { ok: true, reason: null });
	assert.strictEqual(lookup.eligibility(work({ kind: 'podcast' })).reason, 'not-a-book');
	assert.strictEqual(lookup.eligibility(work({ doubts: [{ code: 'no-author' }] })).reason, 'doubtful');
	assert.strictEqual(lookup.eligibility(work({ author: null })).reason, 'no-author');
	assert.strictEqual(lookup.eligibility(work({ author: 'GraphicAudio' })).reason, 'publisher-author');
	assert.strictEqual(lookup.eligibility(work({ author: 'Graphic Audio LLC.' })).reason, 'publisher-author');
	assert.strictEqual(lookup.eligibility(work(), { exclude: true }).reason, 'excluded');
	assert.strictEqual(lookup.eligibility(work(), { title: 'X', series: null, narrator: 'Y' }).reason, 'locked');
	assert.strictEqual(lookup.eligibility(work(), { title: 'X', narrator: 'Y' }).ok, true, 'one field left open still looks up');
});

// --- requests and the queue ---------------------------------------------------------------------

test('the request carries only the title and author, with an identifying user agent', async () => {
	const h = harness({ replies: [{ body: fixture('once-and-future-king') }] });
	const w = work({ id: 't-h-white/the-once-and-future-king', title: 'The Once And Future King', author: 'T.H. White', narrator: 'Neville Jason', totalMs: 1984 * MIN });
	await h.instance.refresh([w]);
	assert.strictEqual(h.calls.length, 1);
	const url = new URL(h.calls[0].url);
	assert.strictEqual(url.origin, 'https://api.audible.com');
	assert.strictEqual(url.pathname, '/1.0/catalog/products');
	assert.deepStrictEqual([...url.searchParams.keys()].sort(), ['author', 'num_results', 'products_sort_by', 'response_groups', 'title']);
	assert.strictEqual(url.searchParams.get('title'), 'The Once And Future King');
	assert.strictEqual(url.searchParams.get('author'), 'T. H. White');
	assert.ok(!h.calls[0].url.includes('Neville') && !h.calls[0].url.includes('t-h-white') && !h.calls[0].url.includes('M:'));
	const init = h.calls[0].init;
	assert.strictEqual(init.method, 'GET');
	assert.strictEqual(init.redirect, 'error');
	assert.match(init.headers['User-Agent'], /^Plex-Discord-Bot-BookCatalog\/\d+\.\d+\.\d+$/);
	assert.ok(init.signal instanceof AbortSignal);
});

test('the store region picks the audible domain', () => {
	assert.ok(lookup.buildUrl('uk', 'A', 'B').startsWith('https://api.audible.co.uk/1.0/catalog/products?title=A&author=B&'));
	assert.ok(lookup.buildUrl('jp', 'A', 'B').startsWith('https://api.audible.co.jp/'));
	assert.ok(lookup.buildUrl('nowhere', 'A', 'B').startsWith('https://api.audible.com/'));
});

test('the setting off makes no request and hides the cache', async () => {
	const h = harness({ config: { audiobookOnlineLookup: false } });
	const summary = await h.instance.refresh([work(), work({ id: 'b/x', title: 'X' })]);
	assert.strictEqual(h.calls.length, 0);
	assert.strictEqual(summary.counts.skipped, 2);
	assert.strictEqual(summary.results['b/x'].reason, 'off');
	lookup.store.load()['avery-quill/the-ember-throne'] = { queryKey: lookup.queryKey(work(), 'us'), outcome: 'edition', fetchedAt: NOW, fields: { title: 'The Ember Throne' } };
	assert.strictEqual(h.instance.get(work()), null);
	h.config.audiobookOnlineLookup = true;
	assert.strictEqual(h.instance.get(work()).outcome, 'edition');
});

test('skipped works make no request', async () => {
	const h = harness({ overrideOf: (w) => (w.id === 'c/locked' ? { title: 'T', series: null, narrator: null } : null) });
	const summary = await h.instance.refresh([
		work({ id: 'a/pod', kind: 'podcast' }),
		work({ id: 'b/doubt', doubts: [{ code: 'mixed-artists', artists: [] }] }),
		work({ id: 'c/locked' }),
		work({ id: 'd/pub', author: 'GraphicAudio' }),
	]);
	assert.strictEqual(h.calls.length, 0);
	assert.strictEqual(summary.counts.skipped, 4);
	assert.deepStrictEqual(Object.values(summary.results).map((r) => r.reason), ['not-a-book', 'doubtful', 'locked', 'publisher-author']);
});

// The bug (review): the library's batch passes each work's override with the call, but refresh()
// read only the one given when the lookup was made, which the bot's instance never had, so a
// locked or excluded work was looked up anyway.
test('refresh reads overrideOf from the call too, as the library batch passes it', async () => {
	const h = harness();
	const overrideOf = (w) => ({ 'c/locked': { title: 'T', series: null, narrator: null }, 'e/out': { exclude: true } }[w.id] || null);
	const summary = await h.instance.refresh([work({ id: 'c/locked' }), work({ id: 'e/out' })], { overrideOf });
	assert.strictEqual(h.calls.length, 0);
	assert.deepStrictEqual(Object.values(summary.results).map((r) => r.reason), ['locked', 'excluded']);
});

// The bug (review): any doubt blocked the lookup, even a split the rescan never shows and a doubt
// the owner answered with a title or author edit, so those books were never looked up.
test('a split doubt or one the owner answered with an edit does not block the lookup', () => {
	assert.strictEqual(lookup.eligibility(work({ doubts: [{ code: 'split', albums: ['x'] }] })).ok, true);
	const generic = [{ code: 'generic-title', title: 'Audio' }];
	assert.strictEqual(lookup.eligibility(work({ doubts: generic, sources: { title: 'override', author: 'plex' } })).ok, true);
	assert.strictEqual(lookup.eligibility(work({ doubts: generic }), { author: 'Avery Quill' }).ok, true);
	assert.strictEqual(lookup.eligibility(work({ doubts: generic, sources: { title: 'folder', author: 'plex' } })).reason, 'doubtful');
});

test('an empty answer is cached as no match for 30 days', async () => {
	const h = harness({ replies: [{ body: fixture('no-results') }] });
	const summary = await h.instance.refresh([work()]);
	assert.strictEqual(summary.counts.none, 1);
	const entry = h.instance.peek(work());
	assert.strictEqual(entry.outcome, 'none');
	assert.strictEqual(entry.reason, 'no-results');
	assert.strictEqual(lookup.due(entry, entry.queryKey, NOW + 29 * DAY), false);
	assert.strictEqual(lookup.due(entry, entry.queryKey, NOW + 31 * DAY), true);
});

test('a match is cached with only the picked factual fields', async () => {
	const body = { products: [Object.assign(product(), { publisher_summary: '<p>Marketing copy.</p>', merchandising_summary: 'More copy.' })] };
	const h = harness({ replies: [{ body }] });
	const w = work();
	await h.instance.refresh([w]);
	const entry = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).works[w.id];
	assert.deepStrictEqual(Object.keys(entry).sort(), ['asin', 'fetchedAt', 'fields', 'outcome', 'queryKey', 'reason', 'region']);
	assert.deepStrictEqual(Object.keys(entry.fields).sort(), ['narrator', 'narrators', 'omnibus', 'position', 'publisher', 'runtimeMin', 'sequence', 'series', 'title']);
	assert.ok(!JSON.stringify(entry).includes('Marketing'));
	assert.ok(!JSON.stringify(entry).includes(w.folderKey));
});

test('a 429 waits for retry-after and retries once', async () => {
	const h = harness({ replies: [{ status: 429, headers: { 'Retry-After': '7' }, body: '' }, { body: { products: [product()] } }] });
	const summary = await h.instance.refresh([work()]);
	assert.strictEqual(h.calls.length, 2);
	assert.ok(h.calls[1].at - h.calls[0].at >= 7000, 'the retry waited for Retry-After');
	assert.strictEqual(summary.counts.edition, 1);
});

test('a second 429 or 503 gives up for the day', async () => {
	const h = harness({ replies: [{ status: 503, headers: { 'Retry-After': '600' }, body: '' }, { status: 429, body: '' }] });
	const summary = await h.instance.refresh([work()]);
	assert.strictEqual(h.calls.length, 2);
	assert.ok(h.calls[1].at - h.calls[0].at <= 60000, 'Retry-After is capped at a minute');
	assert.strictEqual(summary.counts.error, 1);
	const entry = h.instance.peek(work());
	assert.strictEqual(entry.outcome, 'error');
	assert.strictEqual(entry.reason, 'rate-limited');
	assert.strictEqual(lookup.due(entry, entry.queryKey, NOW + DAY - MIN), false);
	assert.strictEqual(lookup.due(entry, entry.queryKey, NOW + DAY + 2 * MIN), true);
});

test('retry-after reads seconds or a date and is capped at a minute', () => {
	assert.strictEqual(lookup.retryAfterMs('3', NOW), 3000);
	assert.strictEqual(lookup.retryAfterMs('9999', NOW), 60000);
	assert.strictEqual(lookup.retryAfterMs(new Date(NOW + 20000).toUTCString(), NOW), 20000);
	assert.strictEqual(lookup.retryAfterMs(null, NOW), 5000);
});

test('a timeout is an error that keeps the last good answer', async () => {
	const w = work();
	const key = lookup.queryKey(w, 'us');
	const good = { queryKey: key, region: 'us', fetchedAt: NOW - 200 * DAY, outcome: 'book', reason: 'series-agree', asin: null, fields: { title: 'The Ember Throne', series: 'Tidewater Cycle', position: '1', sequence: 1, omnibus: false } };
	lookup.store.load()[w.id] = good;
	const timeout = new Error('timed out');
	timeout.name = 'TimeoutError';
	const h = harness({ replies: [timeout] });
	const summary = await h.instance.refresh([w]);
	assert.strictEqual(summary.results[w.id].reason, 'timeout');
	assert.deepStrictEqual(summary.changed, [], 'the answer itself did not change');
	const entry = h.instance.peek(w);
	assert.strictEqual(entry.outcome, 'book');
	assert.strictEqual(entry.lastError, 'timeout');
	assert.strictEqual(lookup.due(entry, key, h.clock.t + 1000), false, 'not asked again until a day has passed');
	assert.match(h.warnings[0], /"The Ember Throne" by Avery Quill failed \(timeout\)/);
});

test('three failures in a row stop the batch', async () => {
	const h = harness({ respond: () => { throw new TypeError('fetch failed'); } });
	const works = [1, 2, 3, 4, 5].map((n) => work({ id: `w/${n}`, title: `Book ${'abcde'[n - 1]}` }));
	const summary = await h.instance.refresh(works);
	assert.strictEqual(h.calls.length, 3);
	assert.strictEqual(summary.counts.error, 3);
	assert.strictEqual(summary.counts.deferred, 2);
	assert.strictEqual(summary.stopped, true);
	assert.strictEqual(h.instance.peek(works[4]), null, 'a deferred work is not cached as failed');
});

test('requests go one at a time at least a second apart', async () => {
	let inFlight = 0;
	let most = 0;
	const h = harness({
		respond: async () => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((r) => setImmediate(r));
			inFlight--;
			return new Response(JSON.stringify({ products: [] }), { status: 200 });
		}
	});
	const works = [1, 2, 3].map((n) => work({ id: `w/${n}`, title: `Book ${'abc'[n - 1]}` }));
	await h.instance.refresh(works);
	assert.strictEqual(h.calls.length, 3);
	assert.strictEqual(most, 1);
	for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1000);
});

test('a second refresh while one runs gets the same batch', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	const h = harness({ respond: async () => { await gate; return new Response('{"products":[]}', { status: 200 }); } });
	const first = h.instance.refresh([work()]);
	const second = h.instance.refresh([work({ id: 'other/x', title: 'Other' })]);
	assert.strictEqual(first, second);
	assert.strictEqual(h.instance.isRunning(), true);
	release();
	await first;
	assert.strictEqual(h.calls.length, 1);
	assert.strictEqual(h.instance.isRunning(), false);
});

test('a fresh entry is not asked again and a changed query is', async () => {
	const h = harness({ replies: [{ body: { products: [product()] } }, { body: { products: [] } }] });
	await h.instance.refresh([work()]);
	h.clock.t += 179 * DAY;
	const again = await h.instance.refresh([work({ title: 'the ember throne' })]);
	assert.strictEqual(again.counts.cached, 1, 'a case-only title change keeps the same query');
	assert.strictEqual(h.calls.length, 1);
	await h.instance.refresh([work({ title: 'The Glass Sea' })]);
	assert.strictEqual(h.calls.length, 2);
});

test('the ttls are 180 days for a match, 30 for none and 1 for an error', () => {
	const key = 'k';
	const at = (outcome) => ({ queryKey: key, outcome, fetchedAt: NOW });
	assert.strictEqual(lookup.due(at('edition'), key, NOW + 179 * DAY), false);
	assert.strictEqual(lookup.due(at('edition'), key, NOW + 181 * DAY), true);
	assert.strictEqual(lookup.due(at('book'), key, NOW + 181 * DAY), true);
	assert.strictEqual(lookup.due(at('none'), key, NOW + 29 * DAY), false);
	assert.strictEqual(lookup.due(at('error'), key, NOW + 2 * DAY), true);
	assert.strictEqual(lookup.due(at('edition'), 'other', NOW), true);
	assert.strictEqual(lookup.due(null, key, NOW), true);
});

test('force asks again even when the cache is fresh', async () => {
	const h = harness({ replies: [{ body: { products: [product()] } }, { body: { products: [product()] } }] });
	await h.instance.refresh([work()]);
	const summary = await h.instance.refresh([work()], { force: true });
	assert.strictEqual(h.calls.length, 2);
	assert.deepStrictEqual(summary.changed, [], 'the same answer again changes nothing');
});

test('a renamed work finds its entry through the alias and copies it to the new id', async () => {
	const h = harness();
	const old = work({ id: 'untitled/the-ember-throne' });
	lookup.store.load()[old.id] = { queryKey: lookup.queryKey(old, 'us'), region: 'us', outcome: 'edition', fetchedAt: NOW, fields: { title: 'The Ember Throne' } };
	const renamed = work({ id: 'avery-quill/the-ember-throne', aliases: ['untitled/the-ember-throne'] });
	assert.strictEqual(h.instance.peek(renamed).outcome, 'edition');
	assert.strictEqual(lookup.store.load()[renamed.id], undefined, 'peek does not write');
	assert.strictEqual(h.instance.get(renamed).outcome, 'edition');
	assert.strictEqual(lookup.store.load()[renamed.id].outcome, 'edition');
	const summary = await h.instance.refresh([renamed]);
	assert.strictEqual(summary.counts.cached, 1);
	assert.strictEqual(h.calls.length, 0);
});

test('the lookup never changes the works it is given', async () => {
	const h = harness({ replies: [{ body: { products: [product({ title: 'The Ember Throne (Unabridged)' })] } }] });
	const works = [work({ title: 'The Ember Throne', aliases: ['old/id'] })];
	const before = JSON.parse(JSON.stringify(works));
	const summary = await h.instance.refresh(works);
	assert.deepStrictEqual(works, before);
	assert.strictEqual(summary.counts.edition, 1);
	const c = lookup.compare(h.instance.get(works[0]), works[0]);
	assert.deepStrictEqual(works, before);
	assert.strictEqual(c.title.kind, 'same');
});

test('a bad answer is an error, not a crash', async () => {
	const h = harness({ replies: [{ body: 'not json' }, { status: 404, body: '' }, { body: { nothing: true } }] });
	const works = [1, 2, 3].map((n) => work({ id: `w/${n}`, title: `Book ${'abc'[n - 1]}` }));
	const summary = await h.instance.refresh(works);
	assert.deepStrictEqual(Object.values(summary.results).map((r) => r.reason), ['bad-json', 'http-404', 'bad-shape']);
});

test('nothing is read from config or the network at require time', () => {
	const src = fs.readFileSync(pathMod.join(__dirname, '..', 'helpers', 'bookLookup.js'), 'utf8');
	assert.ok(!/^const .*require\(['"]\.\.\/config\/config\.js['"]\)/m.test(src));
	assert.strictEqual(typeof lookup.instance, 'function');
});
