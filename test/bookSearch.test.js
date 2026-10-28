// helpers/bookSearch.js: a query that names a whole series or author, the typo fallback behind
// "Did you mean ...?", and the short button keys for long work ids.
//
// The bug: "!book start artifical condition" and "!book play Rouge Protocol" answered "Nothing in
// the audiobook library matches" for a one-letter typo; "oath bringer" and "whale fall" missed
// one-word titles over a space; "murderbot 2" found nothing because the series name is longer
// than the word typed, and "Martha Wells - The Murderbot Diaries" did not count as the same series
// as "The Murderbot Diaries". A first prototype of the fallback matched "auto" to a book by
// Autumn Bardot through the author's first name.
//
// Harness: pure functions over a synthetic works list; no store, no files.

const test = require('node:test');
const assert = require('node:assert');

const search = require('../helpers/bookSearch.js');

function work(id, title, author, series = null, sequence = null) {
	return { id, title, author, series, sequence, narrator: null, edition: null, parts: [] };
}

const LIST = [
	work('vela-quinn/all-quiet-signal', 'All Quiet Signal', 'Vela Quinn', 'The Clockbot Diaries', 1),
	work('vela-quinn/artificial-harbor', 'Artificial Harbor', 'Vela Quinn'),
	work('vela-quinn/rogue-lantern', 'Rogue Lantern', 'Vela Quinn'),
	work('vela-quinn/final-orbit', 'Final Orbit', 'Vela Quinn', 'Vela Quinn - The Clockbot Diaries', 7),
	work('tobin-ashe/the-first-tide', 'The First Tide', 'Tobin Ashe', 'The Tide Archive', 1),
	work('tobin-ashe/stormbringer', 'Stormbringer', 'Tobin Ashe', 'The Tide Archive', 3),
	work('tobin-ashe/edgewalker', 'Edgewalker', 'Tobin Ashe', 'The Tide Archive', 0.5),
	work('tobin-ashe/tide-collected-tales', 'Tide - Collected Tales', 'Tobin Ashe', 'The Tide Archive', 7),
	work('autumn-reyes/legends-of-the-marsh', 'Legends of the Marsh', 'Autumn Reyes'),
	work('ilka-varo/the-voyage', 'The Voyage', 'Ilka Varo'),
	work('perrin-hale/voyage-retold-tales', 'Voyage: Retold Tales', 'Perrin Hale, Oda Lind - illustrator'),
	work('perrin-hale/emberfall-a-novel', 'Emberfall - A Novel', 'Perrin Hale'),
	work('noor-vasquez/penelope', 'Pénélope', 'Noor Vásquez')
];

const ids = (works) => works.map((w) => w.id);

test('damerau counts a swapped pair of letters as one edit', () => {
	assert.strictEqual(search.damerau('rouge', 'rogue'), 1);
	assert.strictEqual(search.damerau('artifical', 'artificial'), 1);
	assert.strictEqual(search.damerau('', 'abc'), 3);
	assert.strictEqual(search.damerau('same', 'same'), 0);
});

test('a series is named by its whole name or its first words, without an article or an author prefix', () => {
	const tide = search.namedGroup('tide archive', LIST);
	assert.strictEqual(tide.kind, 'series');
	assert.strictEqual(tide.name, 'The Tide Archive');
	assert.deepStrictEqual(ids(tide.works), ['tobin-ashe/edgewalker', 'tobin-ashe/the-first-tide', 'tobin-ashe/stormbringer', 'tobin-ashe/tide-collected-tales'], 'in series order');
	assert.strictEqual(tide.oneSeries, true);
	assert.strictEqual(tide.number, null);

	const clock = search.namedGroup('clockbot', LIST);
	assert.deepStrictEqual(ids(clock.works), ['vela-quinn/all-quiet-signal', 'vela-quinn/final-orbit'], '"Vela Quinn - The Clockbot Diaries" is the same series');
	assert.strictEqual(clock.name, 'The Clockbot Diaries');
	assert.strictEqual(clock.oneSeries, true);

	assert.strictEqual(search.namedGroup('the tide archive', LIST).kind, 'series');
	assert.strictEqual(search.namedGroup('archive', LIST), null, 'a word from the middle names nothing');
	assert.strictEqual(search.namedGroup('ti', LIST), null, 'too short to name anything');
});

test('a trailing number goes with a series: "<series> 2", "#2", "book two"', () => {
	for (const q of ['clockbot 7', 'clockbot #7', 'Clockbot Diaries book seven', 'the clockbot diaries no 7']) {
		const g = search.namedGroup(q, LIST);
		assert.ok(g, q);
		assert.deepStrictEqual([g.kind, g.number], ['series', 7], q);
	}
	assert.strictEqual(search.namedGroup('quinn 2', LIST), null, 'an author with a number is not a series');
	assert.strictEqual(search.namedGroup('Emberfall - A Novel', LIST), null);
});

test('an author is named by the whole name or the surname, each person of the field on their own', () => {
	const quinn = search.namedGroup('vela quinn', LIST);
	assert.strictEqual(quinn.kind, 'author');
	assert.strictEqual(quinn.name, 'Vela Quinn');
	assert.strictEqual(quinn.works.length, 4);
	assert.strictEqual(quinn.oneSeries, false, 'two of them have no series');
	assert.deepStrictEqual(ids(search.namedGroup('quinn', LIST).works), ids(quinn.works));
	assert.deepStrictEqual(ids(search.namedGroup('hale', LIST).works), ['perrin-hale/voyage-retold-tales', 'perrin-hale/emberfall-a-novel']);
	assert.deepStrictEqual(ids(search.namedGroup('lind', LIST).works), ['perrin-hale/voyage-retold-tales'], 'the illustrator is a person of the field');
	assert.strictEqual(search.namedGroup('illustrator', LIST), null, 'a role is not a name');
	assert.strictEqual(search.namedGroup('ashe', LIST).oneSeries, true, 'every book of the author is in one series');
	assert.strictEqual(search.namedGroup('vasquez', LIST).works[0].id, 'noor-vasquez/penelope', 'accents are folded');
});

test('typos of one or two letters are suggested, a swap counting as one', () => {
	assert.deepStrictEqual(ids(search.suggest('rouge lantern', LIST)), ['vela-quinn/rogue-lantern']);
	assert.deepStrictEqual(ids(search.suggest('artifical harbr', LIST)), ['vela-quinn/artificial-harbor']);
	assert.deepStrictEqual(ids(search.suggest('Artifical Harboor', LIST)), ['vela-quinn/artificial-harbor'], 'a doubled letter');
	assert.deepStrictEqual(ids(search.suggest('penelopy', LIST)), ['noor-vasquez/penelope'], 'against the folded title');
	assert.deepStrictEqual(search.suggest('zzzz qqqq', LIST), []);
});

test('the query with its spaces removed finds a one-word title or series', () => {
	assert.deepStrictEqual(ids(search.suggest('storm bringer', LIST)), ['tobin-ashe/stormbringer']);
	assert.deepStrictEqual(ids(search.suggest('ember fall', LIST)), ['perrin-hale/emberfall-a-novel']);
	assert.deepStrictEqual(ids(search.suggest('edge walker', LIST)), ['tobin-ashe/edgewalker']);
	assert.deepStrictEqual(ids(search.suggest('clock bot', LIST)), ['vela-quinn/all-quiet-signal', 'vela-quinn/final-orbit'], 'a series, in series order');
	assert.deepStrictEqual(ids(search.suggest('tide archve', LIST)).slice(0, 1), ['tobin-ashe/edgewalker']);
});

test('one word never matches an author\'s first name: "auto" is not Autumn Reyes', () => {
	assert.deepStrictEqual(search.suggest('auto', LIST), []);
	assert.deepStrictEqual(search.suggest('autumn', LIST), [], 'not even the whole first name');
	assert.deepStrictEqual(ids(search.suggest('reyse', LIST)), ['autumn-reyes/legends-of-the-marsh'], 'the surname, with a swap');
});

test('a number in a typo is matched as a word: "stormbrnger 3" is one book', () => {
	assert.deepStrictEqual(ids(search.suggest('tide archve 3', LIST)), ['tobin-ashe/stormbringer']);
	assert.deepStrictEqual(ids(search.suggest('tide archve three', LIST)), ['tobin-ashe/stormbringer']);
	assert.deepStrictEqual(search.suggest('tide archve 9', LIST), []);
});

test('three letters or fewer must be exact, and the caller\'s rank breaks ties', () => {
	assert.deepStrictEqual(search.suggest('tdie', LIST).length, 4, 'four letters: one swap from "tide"');
	assert.deepStrictEqual(search.suggest('tdi', LIST), [], 'three letters: no typo budget');
	assert.deepStrictEqual(ids(search.suggest('voyagge', LIST)), ['ilka-varo/the-voyage', 'perrin-hale/voyage-retold-tales'], 'the closer title first');
	const ranked = search.suggest('tdie', LIST, { rank: (w) => (w.id === 'tobin-ashe/stormbringer' ? 0 : 1) });
	assert.deepStrictEqual(ids(ranked), ['tobin-ashe/stormbringer', 'tobin-ashe/edgewalker', 'tobin-ashe/the-first-tide', 'tobin-ashe/tide-collected-tales']);
	assert.strictEqual(search.suggest('tide', LIST, { limit: 2 }).length, 2);
});

test('a short key stands in for a long id and finds the work again', () => {
	const long = work(`some-author/${'a-very-long-folder-name-'.repeat(5)}`, 'Long', 'Some Author');
	const k = search.shortKey(long.id);
	assert.match(k, /^~[0-9a-f]{16}$/);
	assert.ok(`book:play:${k}`.length <= 100);
	assert.strictEqual(search.byShortKey(k, LIST.concat([long])), long);
	assert.strictEqual(search.byShortKey(k, LIST), null, 'gone with the work');
	assert.strictEqual(search.byShortKey(long.id, LIST.concat([long])), null, 'only a short key is looked up');
});

// The bug: byShortKey hashed current ids only, so after a rebuild moved a work's id a Play pick on
// a library list still open, or a "Did you mean" button with a short key, said the book was gone.
test('a short key made from an id a work had before still finds it', () => {
	const moved = Object.assign(work('new-author/new-title', 'New Title', 'New Author'), { aliases: ['old-folder/new-title'] });
	const other = work('old-folder/new-title-2', 'Other', 'Other');
	assert.strictEqual(search.byShortKey(search.shortKey('old-folder/new-title'), LIST.concat([other, moved])), moved);
	const holder = work('old-folder/new-title', 'Holder', 'Holder');
	assert.strictEqual(search.byShortKey(search.shortKey('old-folder/new-title'), [moved, holder]), holder, 'a current id wins over an alias');
});

// The bug: the spacing-typo pass ran a full edit table of the whole query against every title, so
// a pasted 2,000-character message blocked the event loop for about a third of a second.
test('a very long query suggests nothing', () => {
	const junk = 'qzx'.repeat(700);
	assert.deepStrictEqual(search.suggest(junk, LIST), []);
	assert.strictEqual(search.namedGroup(junk, LIST), null);
	assert.deepStrictEqual(ids(search.suggest('storm bringer', LIST)).slice(0, 1), ['tobin-ashe/stormbringer'], 'an ordinary query still works');
});
