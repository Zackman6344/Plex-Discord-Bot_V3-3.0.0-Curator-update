// helpers/bookSections.js: the library section (genre) of each work and where it came from.
//
// The bug: a section design that read the first folder under the music root gave junk sections
// (an author's own folder with the name reversed, a book's part folders), let them block Calibre,
// filed epic poetry under Fantasy because "Epic" mapped to Fantasy, broke on split BISAC tags
// ("Science Fiction; Fantasy & Horror"), and let one sibling's stray "Science Fiction & Fantasy"
// split a series between sections.
//
// Synthetic works on a synthetic M:/Music root; no stores, no Calibre.

const test = require('node:test');
const assert = require('node:assert');
const bookSections = require('../helpers/bookSections.js');

const ROOT = 'M:/Music';

function work(id, over = {}) {
	return { id, kind: 'book', title: id, author: 'Avery Quill', series: null, sequence: null, genres: [], root: ROOT, dirs: [`${ROOT}/${id}`], aliases: [], ...over };
}

const map = (works, ctx) => bookSections.sectionsFor(works, ctx);

test('the allowlist matches whole segments in list order and ignores generic tags', () => {
	const m = bookSections.mapGenre;
	assert.strictEqual(m(['Fiction', 'General', 'Audiobook']), null);
	assert.strictEqual(m(['Epic', 'Poetry']), 'Classics', 'epic poetry is never Fantasy');
	assert.strictEqual(m(['Science Fiction & Fantasy']), null, 'a combined store category names neither');
	assert.strictEqual(m(['Science Fiction; Fantasy & Horror']), 'Science Fiction');
	assert.strictEqual(m(['Fantasy ; American']), 'Fantasy');
	assert.strictEqual(m(['Audiobook - Sci Fi - Avery Quill']), 'Science Fiction');
	assert.strictEqual(m(['Sci-Fi, Adventure']), 'Science Fiction');
	assert.strictEqual(m(['Fiction/Historical Fiction/Literature']), null);
	assert.strictEqual(m(['Fairy Tales; Folk Tales; Legends & Mythology']), 'Mythology');
	assert.strictEqual(m(['Historical & Mythological Fiction']), 'Fantasy');
	assert.strictEqual(m(['Science Fiction', 'Fantasy & Magic', 'Juvenile Fiction']), 'Fantasy', 'the first section in list order wins');
	assert.strictEqual(m(['Mystery; Thriller & Suspense']), 'Mystery & Thriller');
	assert.strictEqual(m(['Drama']), null);
	assert.strictEqual(m(['Drama'], { embedded: true }), 'Classics', 'Drama counts only from the files');
});

test('a folder holding works by 3 or more authors is a section, by its own name', () => {
	const shelf = (id, author) => work(id, { author, dirs: [`${ROOT}/Myths/Retellings/${id} by ${author}`] });
	const works = [
		shelf('ithaca', 'Corin Vale'), shelf('circe', 'Ilse Moreau'), shelf('elektra', 'R.J. Ashdown'),
		work('theogony', { author: 'Old Poet', dirs: [`${ROOT}/Myths/Old Poet/Theogony`] }),
		work('works-and-days', { author: 'Old Poet', dirs: [`${ROOT}/Myths/Old Poet/Works and Days`] }),
		work('loose', { author: 'Avery Quill', dirs: [ROOT] }),
	];
	const s = map(works);
	assert.deepStrictEqual(s.get('ithaca'), { section: 'Retellings', source: 'folder' });
	assert.deepStrictEqual(s.get('theogony'), { section: 'Myths', source: 'folder' }, 'an author folder is skipped for the shelf above it');
	assert.deepStrictEqual(s.get('loose'), { section: 'More books', source: 'none' }, 'the music root itself is never a section');
});

// The bug: "White T.H" (an author folder with the name reversed) and a book's own part folders
// became sections.
test('an author folder, a reversed author folder and a book\'s part folders never count', () => {
	const parts = (n) => `${ROOT}/Ashdown R.J/Ashdown R.J. - The Hollow King (2011)/0${n}.Part ${n}`;
	const works = [
		work('hollow-king', { author: 'R.J. Ashdown', dirs: [parts(1), parts(2), parts(3)] }),
		work('edge', { author: 'Avery Quill', dirs: [`${ROOT}/Avery Quill/The Tide Archive [0.5] Edge/The Tide Archive - Edge`] }),
		work('ember', { author: 'Avery Quill', dirs: [`${ROOT}/Avery Quill/1.The Ember Throne/The Ember Throne 1`, `${ROOT}/Avery Quill/1.The Ember Throne/The Ember Throne 2`] }),
	];
	for (const w of works) assert.strictEqual(map(works).get(w.id).source, 'none');
});

test('precedence: own edit, author edit, folder, exact Calibre tags, file genres, likely Calibre tags', () => {
	const inFolder = (id, author) => work(id, { author, dirs: [`${ROOT}/Myths/${id}`] });
	const folder = [inFolder('f1', 'Corin Vale'), inFolder('f2', 'Ilse Moreau'), inFolder('f3', 'Mara Fenn')];
	const calibre = { exact: { verdict: 'exact', tags: ['Fantasy'] }, likely: { verdict: 'likely', tags: ['Horror'] } };
	const works = [
		...folder,
		work('own', { genres: ['Thriller'] }),
		work('by-author', { author: 'Tobias Gray', genres: ['Thriller'] }),
		work('cal', { genres: ['Thriller'] }),
		work('tags', { genres: ['Thriller'] }),
		work('likely', { genres: ['Audiobook'] }),
	];
	const overrides = {
		works: { own: { genre: 'Bedtime' }, f1: { genre: 'Bedtime' } },
		authors: { 'tobias-gray': { genre: 'Bedtime', series: 'X' } }
	};
	const calibreOf = (w) => (w.id === 'cal' || w.id === 'f2' ? calibre.exact : w.id === 'likely' ? calibre.likely : null);
	const s = map(works, { overrides, calibreOf });
	assert.deepStrictEqual(s.get('own'), { section: 'Bedtime', source: 'override' });
	assert.deepStrictEqual(s.get('f1'), { section: 'Bedtime', source: 'override' });
	assert.deepStrictEqual(s.get('by-author'), { section: 'Bedtime', source: 'author-override' });
	assert.deepStrictEqual(s.get('f2'), { section: 'Myths', source: 'folder' }, 'the owner\'s folder outranks Calibre');
	assert.deepStrictEqual(s.get('cal'), { section: 'Fantasy', source: 'calibre' });
	assert.deepStrictEqual(s.get('tags'), { section: 'Mystery & Thriller', source: 'tags' });
	assert.deepStrictEqual(s.get('likely'), { section: 'Horror', source: 'calibre-likely' });
});

test('a per-work genre written under an old id still applies after the id moved', () => {
	const moved = work('avery-quill/the-lantern-road', { aliases: ['avery-quill/the-lantern-road-a-novel'] });
	const s = map([moved], { overrides: { works: { 'avery-quill/the-lantern-road-a-novel': { genre: 'Fantasy' } } } });
	assert.deepStrictEqual(s.get(moved.id), { section: 'Fantasy', source: 'override' });
});

test('series siblings lend their majority, then an author whose sections all agree lends that', () => {
	const ser = (id, n, genres = []) => work(id, { series: 'Ashfall', sequence: n, genres });
	const works = [
		ser('a1', 1, ['Sci-Fi, Adventure']), ser('a2', 2), ser('a3', 3, ['Audiobook']),
		work('standalone'),
		work('other-author', { author: 'Corin Vale' }),
	];
	const s = map(works);
	assert.deepStrictEqual(s.get('a2'), { section: 'Science Fiction', source: 'series' });
	assert.deepStrictEqual(s.get('standalone'), { section: 'Science Fiction', source: 'author' });
	assert.deepStrictEqual(s.get('other-author'), { section: 'More books', source: 'none' });
});

test('a tie among series siblings lends nothing, and an author with two sections lends nothing', () => {
	const works = [
		work('b1', { series: 'Tide', sequence: 1, genres: ['Fantasy'] }),
		work('b2', { series: 'Tide', sequence: 2, genres: ['Horror'] }),
		work('b3', { series: 'Tide', sequence: 3 }),
		work('b4'),
	];
	const s = map(works);
	assert.strictEqual(s.get('b3').source, 'none');
	assert.strictEqual(s.get('b4').source, 'none');
});

test('podcasts are always Podcasts, and a podcast never makes a folder a section', () => {
	const works = [
		work('pod', { kind: 'podcast', author: 'Lantern Hollow', genres: ['Fantasy'], dirs: [`${ROOT}/Shows/Lantern Hollow`] }),
		work('p2', { kind: 'podcast', author: 'Tin Valley', dirs: [`${ROOT}/Shows/Tin Valley`] }),
		work('book', { author: 'Corin Vale', dirs: [`${ROOT}/Shows/Book`] }),
	];
	const s = map(works, { overrides: { works: { pod: { genre: 'Fantasy' } } } });
	assert.deepStrictEqual(s.get('pod'), { section: 'Podcasts', source: 'podcast' });
	assert.strictEqual(s.get('book').source, 'none');
});

test('a work saved without work.root finds its root among the catalog\'s music roots', () => {
	const old = (id, author) => ({ ...work(id, { author, dirs: [`${ROOT}/Myths/${id}`] }), root: null });
	const works = [old('x1', 'Corin Vale'), old('x2', 'Ilse Moreau'), old('x3', 'Mara Fenn')];
	assert.strictEqual(map(works).get('x1').source, 'none');
	assert.deepStrictEqual(map(works, { roots: ['M:\\Music'] }).get('x1'), { section: 'Myths', source: 'folder' });
});

test('grouping puts the biggest section first, Podcasts and More books last, and merges case', () => {
	const works = [work('a'), work('b'), work('c'), work('d'), work('e'), work('f')];
	const sections = new Map([
		['a', { section: 'More books' }], ['b', { section: 'Podcasts' }], ['c', { section: 'Fantasy' }],
		['d', { section: 'fantasy' }], ['e', { section: 'Horror' }], ['f', { section: 'Fantasy' }],
	]);
	const groups = bookSections.groupBySection(works, sections);
	assert.deepStrictEqual(groups.map((g) => [g.section, g.works.map((w) => w.id).join('')]), [['Fantasy', 'cdf'], ['Horror', 'e'], ['Podcasts', 'b'], ['More books', 'a']]);
});

test('a typed section takes the spelling the library already uses', () => {
	assert.strictEqual(bookSections.canonicalSection('science fiction'), 'Science Fiction');
	assert.strictEqual(bookSections.canonicalSection('myth retellings', ['Myth Retellings']), 'Myth Retellings');
	assert.strictEqual(bookSections.canonicalSection('  Cosy   Crime '), 'Cosy Crime');
});
