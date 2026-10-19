// commands/book.js/admin.js rescanText: the reply to `!book rescan` and `/book rescan`.
//
// The bug: a stray disc folder of a rap album merged with a loose book file and was catalogued as
// a book called "Music", and the rescan reply said nothing about it. Rules version 3 keeps such a
// doubtful group catalogued and records why it is doubtful, splits music albums off book folders,
// and can fill blanks from an online lookup; the reply has to say all three without printing a
// folder path, a drive letter or a Plex id, because `!book rescan` answers in the open channel.
// The rejected list printed a drive path such as "P:/Music" for a group at the top of a music
// section.
//
// Harness: rescanText driven with a fake catalog (work, works, load) and hand-made reports in the
// shapes bookLibrary.rebuild and bookLookup.refresh return; one test feeds it a real buildCatalog
// result built from a small invented library under N:/Media/Music; one runs the whole rescan
// subcommand against the real catalog store on a pid-suffixed temp file with a stubbed rebuild.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-rescan-text-${process.pid}`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;

const config = require('../config/config.js');
const admin = require('../commands/book.js/admin.js');
const bookCatalog = require('../helpers/bookCatalog.js');
const bookLibrary = require('../helpers/bookLibrary.js');
const store = require('../helpers/bookCatalogStore.js');

const { rescanText, shownKey, chunks } = admin;
const HOUR = 3600000;
const MIN = 60000;
const ROOTS = ['N:\\Media\\Music', 'O:/Books'];
const P = config.commandPrefix || '!';
// A drive with a slash, or a bare 'E:' standing alone (never the colon after a word).
const DRIVE = /(^|[^A-Za-z])[A-Za-z]:([\\/]|\s|$)/;

const saved = { ownerId: config.ownerId, rebuild: bookLibrary.rebuild };

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
	store.reset();
}

test.after(() => {
	config.ownerId = saved.ownerId;
	bookLibrary.rebuild = saved.rebuild;
	cleanup();
});

function work(id, title, extra = {}) {
	return {
		id, title, kind: 'book', author: id.split('/')[0], narrator: null, edition: null, publisher: null,
		series: null, sequence: null, confidence: 'high', folderKey: `N:/Media/Music/${title}`, parts: [{}], doubts: [],
		...extra,
	};
}

function fakeCatalog({ works = [], rejected = [], roots = null } = {}) {
	const byId = new Map(works.map(w => [w.id, w]));
	return {
		work: (id) => byId.get(id) || null,
		works: () => works,
		load: () => ({ meta: roots ? { roots } : {}, works: Object.fromEntries(byId), rejected }),
	};
}

function report(extra = {}) {
	return {
		ok: true, works: 1, books: 1, podcasts: 0, parts: 1, totalMs: 3 * HOUR,
		added: [], removed: [], moved: {}, rejected: 0, splits: [], doubtful: [], notes: [], persisted: true,
		...extra,
	};
}

function text(lines) {
	return lines.join('\n');
}

// What a public reply must never carry: a drive path, a backslash (Windows paths, and also the
// markdown escapes the invented titles below never need), a section folder or a ratingKey.
function assertPrivate(out) {
	assert.doesNotMatch(out, DRIVE, 'no drive letter');
	assert.ok(!out.includes('\\'), 'no backslash');
	assert.doesNotMatch(out, /Media\/Music|O:|#album|3302|90210/, 'no section folder or Plex id');
}

test('each doubt code gets its own reason, with the work and the fix', () => {
	const works = [
		work('music/music', 'Music', { doubts: [
			{ code: 'generic-folder', folder: 'Music', albums: 2 },
			{ code: 'music-genre', albums: ['Night Shift + Instrumentals'] },
		] }),
		work('ida-marsh/book-one', 'Book One', { doubts: [
			{ code: 'mixed-artists', artists: [{ name: 'Ida Marsh', tracks: 11 }, { name: 'Tom Reed', tracks: 1 }] },
		] }),
		work('untitled/cold-iron', 'Cold Iron', { doubts: [{ code: 'no-author' }] }),
		work('kay-dunn/audiobooks', 'Audiobooks', { doubts: [{ code: 'generic-title', title: 'Audiobooks' }] }),
		work('kay-dunn/top', 'Top', { doubts: [{ code: 'generic-folder', folder: null, albums: 1 }] }),
		work('lena-park/clean', 'Clean'),
	];
	const lines = rescanText(report(), fakeCatalog({ works }));
	const at = lines.indexOf('⚠️ Doubtful groups, catalogued anyway (5):');
	assert.ok(at > 0, text(lines));
	assert.deepStrictEqual(lines.slice(at + 1, at + 6), [
		`• **Music** (\`music/music\`): folder name "Music" is generic and spans 2 albums; music genre on Night Shift + Instrumentals. Fix: \`${P}book edit music/music exclude\`, or a title or author edit.`,
		`• **Book One** (\`ida-marsh/book-one\`): tracks by Ida Marsh (11) and Tom Reed (1). Fix: \`${P}book edit ida-marsh/book-one exclude\`, or a title or author edit.`,
		`• **Cold Iron** (\`untitled/cold-iron\`): no author found. Fix: \`${P}book edit untitled/cold-iron exclude\`, or a title or author edit.`,
		`• **Audiobooks** (\`kay-dunn/audiobooks\`): the title "Audiobooks" looks like a folder name. Fix: \`${P}book edit kay-dunn/audiobooks exclude\`, or a title or author edit.`,
		`• **Top** (\`kay-dunn/top\`): its folder is the top of a drive. Fix: \`${P}book edit kay-dunn/top exclude\`, or a title or author edit.`,
	]);
	assert.ok(!text(lines).includes('lena-park/clean'), 'a work with no doubts is not listed');
	assertPrivate(text(lines));
});

test('the doubt list stops at five and names the rest by id', () => {
	const works = [];
	for (let i = 1; i <= 8; i++) works.push(work(`a/w${i}`, `W${i}`, { doubts: [{ code: 'no-author' }] }));
	const lines = rescanText(report(), fakeCatalog({ works }));
	assert.ok(lines.includes('⚠️ Doubtful groups, catalogued anyway (8):'));
	assert.strictEqual(lines.filter(l => l.startsWith('• **')).length, 5);
	assert.ok(lines.includes('• and 3 more: `a/w6`, `a/w7`, `a/w8`'), text(lines));
});

test('a doubt the owner has answered with a title or author edit is not warned about again', () => {
	const works = [
		work('a/by-source', 'By Source', { doubts: [{ code: 'no-author' }], sources: { title: 'override', author: null } }),
		work('a/by-detected', 'Fixed Title', { doubts: [{ code: 'no-author' }], detected: { title: 'Music', author: 'a' } }),
		work('a/calibre', 'From Calibre', { doubts: [{ code: 'no-author' }], sources: { title: 'calibre', author: null }, detected: { title: 'Music', author: 'a' } }),
		work('a/untouched', 'Untouched', { doubts: [{ code: 'no-author' }], detected: { title: 'Untouched', author: 'a' } }),
	];
	const out = text(rescanText(report(), fakeCatalog({ works })));
	assert.match(out, /catalogued anyway \(2\)/);
	assert.match(out, /`a\/calibre`/, 'only an owner edit counts, not a Calibre title');
	assert.match(out, /`a\/untouched`/);
	assert.doesNotMatch(out, /a\/by-source|a\/by-detected/);
});

// The bug (review): a mixed-artists doubt with a blank vote printed "tracks by  (3)", and edit.js
// fell back to raw doubt codes because the wording was not exported.
test('doubtReason is shared, and a blank artist name is never printed', () => {
	assert.strictEqual(typeof admin.doubtReason, 'function');
	const d = { code: 'mixed-artists', artists: [{ name: '', tracks: 3 }, { name: 'Ida Marsh', tracks: 9 }, { name: '  ', tracks: 1 }, null] };
	assert.strictEqual(admin.doubtReason(d), 'tracks by Ida Marsh (9)');
	assert.strictEqual(admin.doubtReason({ code: 'mixed-artists', artists: [{ name: '', tracks: 2 }] }), 'tracks by several artists');
	assert.strictEqual(admin.doubtReason({ code: 'split', albums: ['x'] }), null);
});

test('a split is told on its own line with the book it came from, and its piece leaves the long-group list', () => {
	const book = work('wren-halloway/grey-tides', 'Grey Tides', { folderKey: 'N:/Media/Music/Mixed Bag', doubts: [{ code: 'split', albums: ['Night Shift'] }] });
	const r = report({ splits: [
		{ folderKey: 'N:/Media/Music/Mixed Bag', album: '3302', albumTitle: 'Night Shift', tracks: 5, reason: 'music-genre' },
		{ folderKey: 'N:/Media/Music/Gone', album: '90210', albumTitle: null, tracks: 1, reason: 'music-genre' },
	] });
	const rejected = [
		{ folderKey: 'N:/Media/Music/Mixed Bag#album:3302', tracks: 5, hours: 3.5, reason: 'music genre' },
		{ folderKey: 'N:\\Media\\Music\\Kid Ferro\\Night Shift', tracks: 12, hours: 2.5, reason: 'music genre' },
	];
	const lines = rescanText(r, fakeCatalog({ works: [book], rejected, roots: ROOTS }));
	assert.ok(lines.includes('✂️ Music split off a book folder (2): Night Shift (5 tracks) from **Grey Tides**, an untitled album (1 track). Plex tags it as music, so it stays in the music library.'), text(lines));
	assert.ok(!lines.some(l => l.startsWith('⚠️ Doubtful')), 'the split doubt is the split line, not a doubtful group');
	const long = lines.find(l => l.startsWith('🗂'));
	assert.match(long, /: Kid Ferro\/Night Shift \(2\.5 h\)$/);
	assertPrivate(text(lines));
});

test('the online line counts the batch and lists only what it filled in', () => {
	const works = [
		work('rena-voss/quiet-engine', 'Quiet Engine', { series: 'The Quiet Logs', sequence: 1, publisher: 'GraphicAudio',
			sources: { title: 'tag', series: 'tag', sequence: 'tag', narrator: null, publisher: 'tag' } }),
		work('oren-hale/far-orbit', 'Far Orbit', { series: 'Orbit Cycle', sequence: 1, narrator: 'Ana Reyes',
			sources: { title: 'folder', series: 'online', sequence: 'online', narrator: 'online', publisher: null } }),
		work('j-c-marlow/the-lantern-king', 'The Lantern King', { publisher: 'Brightwell Audio',
			sources: { title: 'online', series: null, sequence: null, narrator: 'folder', publisher: 'online' } }),
		work('oren-hale/deep-orbit', 'Deep Orbit', { series: 'Orbit Cycle', sequence: 3,
			sources: { title: 'folder', series: 'online', sequence: 'online' } }),
	];
	const online = {
		enabled: true, region: 'us', stopped: false,
		counts: { edition: 2, book: 1, none: 1, error: 0, skipped: 3, cached: 4, deferred: 0 },
		changed: ['rena-voss/quiet-engine', 'oren-hale/far-orbit', 'j-c-marlow/the-lantern-king'],
		results: {},
	};
	const lines = rescanText(report({ online }), fakeCatalog({ works }));
	const onl = lines.filter(l => l.startsWith('🌐'));
	assert.deepStrictEqual(onl, [
		'🌐 Online lookup: 2 edition matches, 1 book match, 1 not found, 4 already looked up, 3 skipped.',
		'🌐 Filled in online (2): **Far Orbit**: series Orbit Cycle #1, narrator Ana Reyes; **The Lantern King**: title case, publisher Brightwell Audio',
	]);
	assert.doesNotMatch(text(lines), /replaced|instead of|kept/, 'fill-blanks-only: nothing was replaced, so nothing says so');
	assert.doesNotMatch(text(lines), /Deep Orbit/, 'a fill from an earlier batch is not news');
});

test('the online line is absent when the lookup is off, and says when it stopped or is still running', () => {
	const works = [work('a/b', 'B')];
	const off = { enabled: false, counts: { skipped: 1 }, changed: [], results: {}, stopped: false };
	assert.ok(!rescanText(report({ online: off }), fakeCatalog({ works })).some(l => l.startsWith('🌐')));
	assert.ok(!rescanText(report(), fakeCatalog({ works })).some(l => l.startsWith('🌐')));
	const stopped = { enabled: true, counts: { error: 3, deferred: 7 }, changed: [], results: {}, stopped: true };
	assert.deepStrictEqual(rescanText(report({ online: stopped }), fakeCatalog({ works })).filter(l => l.startsWith('🌐')),
		['🌐 Online lookup: 3 failed. Stopped after failures in a row; 7 books left for the next rescan.']);
	const idle = { enabled: true, counts: {}, changed: [], results: {}, stopped: false };
	assert.deepStrictEqual(rescanText(report({ online: idle }), fakeCatalog({ works })).filter(l => l.startsWith('🌐')),
		['🌐 Online lookup: nothing to look up.']);
	assert.deepStrictEqual(rescanText(report({ online: { pending: true } }), fakeCatalog({ works })).filter(l => l.startsWith('🌐')),
		['🌐 Online lookups are still running; what they fill in shows after they finish.']);
});

test('shownKey strips the music section folder, and never shows a drive, a host or a Plex id', () => {
	assert.strictEqual(shownKey('N:/Media/Music/Kid Ferro/Night Shift', ROOTS), 'Kid Ferro/Night Shift');
	assert.strictEqual(shownKey('n:\\media\\music\\Kid Ferro', ROOTS), 'Kid Ferro', 'case and slashes as Plex wrote them');
	assert.strictEqual(shownKey('O:/Books/Ida Marsh/Book One', ROOTS), 'Ida Marsh/Book One', 'a section not named Music');
	assert.strictEqual(shownKey('O:/Books', ROOTS), 'Books', 'the section folder itself');
	assert.strictEqual(shownKey('P:/', ['P:\\']), 'the top of a music folder');
	assert.strictEqual(shownKey('N:/Media/Music/Mixed Bag#album:3302', ROOTS), 'Mixed Bag');
	assert.strictEqual(shownKey('album:3302', ROOTS), 'an album included by hand');
	assert.strictEqual(shownKey('N:/Media/Musicals/Cats', ROOTS), 'Musicals/Cats', 'a root matches whole folders only');
	// Without meta.roots (a catalog built before version 3), the old rule, minus the drive.
	assert.strictEqual(shownKey('M:/Music/Sam Drift/[Unknown Album]'), 'Sam Drift/[Unknown Album]');
	assert.strictEqual(shownKey('P:/Music'), 'Music');
	assert.strictEqual(shownKey('P:/'), 'the top of a drive');
	assert.strictEqual(shownKey('\\\\nas-box\\share\\Audio'), 'share/Audio');
	assert.strictEqual(shownKey('/srv/media/Music/Ida Marsh'), 'Ida Marsh');
});

test('a group at the top of a music section is shown by the section folder\'s name, not its drive path', () => {
	const rejected = [
		{ folderKey: 'P:/Music', tracks: 17, hours: 17, reason: 'music genre' },
		{ folderKey: 'N:\\Media\\Music', tracks: 61, hours: 61, reason: 'music genre' },
	];
	const withRoots = rescanText(report(), fakeCatalog({ rejected, roots: ['P:/Music', 'N:\\Media\\Music'] })).find(l => l.startsWith('🗂'));
	assert.match(withRoots, /: Music \(61\.0 h\), Music \(17\.0 h\)$/);
	const without = rescanText(report(), fakeCatalog({ rejected })).find(l => l.startsWith('🗂'));
	assert.match(without, /: Media\/Music \(61\.0 h\), Music \(17\.0 h\)$/);
	assertPrivate(withRoots);
	assert.doesNotMatch(without, DRIVE);
});

test('a real version 3 build of a doubtful group and a split gives private lines', () => {
	const album = (rk, title, artist, genres = []) => ({ ratingKey: String(rk), parentRatingKey: `9${rk}`, type: 'album', title, parentTitle: artist, Genre: genres.map(tag => ({ tag })) });
	const track = (rk, alb, file, min, index = 1) => {
		const ms = Math.round(min * MIN);
		const name = file.split('/').pop();
		return {
			ratingKey: String(rk), parentRatingKey: alb.ratingKey, grandparentRatingKey: alb.parentRatingKey, type: 'track',
			title: name.replace(/\.[^.]+$/, ''), grandparentTitle: alb.parentTitle, parentTitle: alb.title, parentIndex: 1, index, duration: ms,
			Media: [{ id: Number(rk), duration: ms, bitrate: 128, container: 'mp3', Part: [{ id: Number(rk), key: `/library/parts/${rk}/1/${name}`, duration: ms, file, size: 1000 + Number(rk) }] }],
		};
	};
	const one = album(3901, 'Book One', 'Ida Marsh');
	const two = album(3902, 'Book Two', 'Tom Reed');
	const grey = album(3301, 'Grey Tides', 'Wren Halloway', ['Audiobook']);
	const rap = album(3302, 'Night Shift', 'Kid Ferro', ['Rap']);
	const tracks = [track(39011, one, 'N:/Media/Music/Book One.m4b', 150), track(39021, two, 'N:/Media/Music/Book Two.m4b', 150)];
	for (let i = 1; i <= 6; i++) tracks.push(track(33010 + i, grey, `N:/Media/Music/Mixed Bag/Grey Tides 0${i}.mp3`, 40, i));
	for (let i = 1; i <= 5; i++) tracks.push(track(33020 + i, rap, `N:/Media/Music/Mixed Bag/Night Shift 0${i}.mp3`, 4, i));
	const built = bookCatalog.buildCatalog({ albums: [one, two, grey, rap], tracks, roots: ['N:\\Media\\Music'] });
	const works = Object.values(built.works);
	assert.strictEqual(works.length, 2);
	const r = report({ works: 2, books: 2, splits: built.splits, doubtful: works.filter(w => w.doubts.length).map(w => ({ id: w.id, doubts: w.doubts.length })) });
	const lines = rescanText(r, fakeCatalog({ works, rejected: built.rejected, roots: ['N:\\Media\\Music'] }));
	const doubtful = works.find(w => w.doubts.some(d => d.code === 'mixed-artists'));
	assert.ok(lines.includes('⚠️ Doubtful groups, catalogued anyway (1):'), text(lines));
	assert.ok(lines.some(l => l.startsWith(`• **${doubtful.title}** (\`${doubtful.id}\`): tracks by Ida Marsh (1) and Tom Reed (1); folder name "Music" is generic and spans 2 albums.`)), text(lines));
	assert.ok(lines.includes('✂️ Music split off a book folder (1): Night Shift (5 tracks) from **Grey Tides**. Plex tags it as music, so it stays in the music library.'), text(lines));
	assertPrivate(text(lines));
});

test('titles and album names from tags cannot break the markdown', () => {
	const works = [work('a/b', 'Star*Fall_Two', { doubts: [{ code: 'music-genre', albums: ['Lo`Fi|Beats'] }] })];
	const out = text(rescanText(report(), fakeCatalog({ works })));
	assert.ok(out.includes('**Star\\*Fall\\_Two**'), out);
	assert.ok(out.includes('music genre on Lo\\`Fi\\|Beats'), out);
});

test('a long reply is cut into messages under 1,900 characters, line by line', () => {
	const works = [];
	for (let i = 1; i <= 40; i++) {
		works.push(work(`author-${i}/book-${i}`, `A Rather Long Invented Title Number ${i} `.repeat(3).trim(), {
			confidence: 'low',
			doubts: [{ code: 'mixed-artists', artists: [{ name: 'Ida Marsh', tracks: 9 }, { name: 'Tom Reed', tracks: 2 }, { name: 'Kay Dunn', tracks: 1 }, { name: 'Lena Park', tracks: 1 }] }, { code: 'no-author' }],
		}));
	}
	const splits = works.map((w, i) => ({ folderKey: w.folderKey, album: String(5000 + i), albumTitle: `Split Album ${i}`, tracks: 3, reason: 'music-genre' }));
	const lines = rescanText(report({ splits, notes: Array(12).fill('a note') }), fakeCatalog({ works }));
	const messages = chunks(lines);
	assert.ok(messages.length >= 2);
	for (const m of messages) assert.ok(m.length <= 1900, `${m.length}`);
	assert.deepStrictEqual(messages.join('\n').split('\n'), lines, 'no line is cut or lost');
	assert.ok(lines.some(l => l.includes('tracks by Ida Marsh (9), Tom Reed (2), Kay Dunn (1) and 1 more; no author found.')), text(lines));
});

test('the rescan subcommand posts every new line through the real catalog store', async () => {
	cleanup();
	config.ownerId = '';
	const works = {
		'untitled/cold-iron': work('untitled/cold-iron', 'Cold Iron', { doubts: [{ code: 'no-author' }] }),
		'wren-halloway/grey-tides': work('wren-halloway/grey-tides', 'Grey Tides', { folderKey: 'N:/Media/Music/Mixed Bag' }),
	};
	store.replace({
		meta: { builtAt: 1, rulesVersion: 3, roots: ['N:\\Media\\Music'] },
		works,
		rejected: [{ folderKey: 'N:/Media/Music/Kid Ferro', tracks: 30, hours: 4, reason: 'music genre' }],
		index: {},
	});
	bookLibrary.rebuild = async () => report({
		works: 2, books: 2,
		splits: [{ folderKey: 'N:/Media/Music/Mixed Bag', album: '3302', albumTitle: 'Night Shift', tracks: 5, reason: 'music-genre' }],
		doubtful: [{ id: 'untitled/cold-iron', doubts: 1 }],
	});
	const said = [];
	await admin.run({ sub: 'rescan', userId: '100000000000000001', say: async (m) => { said.push(m); } });
	assert.match(said[0], /about 20 s, up to a minute the first time after an update/);
	const posted = said.slice(1).join('\n');
	assert.match(posted, /Doubtful groups, catalogued anyway \(1\):\n• \*\*Cold Iron\*\* \(`untitled\/cold-iron`\): no author found\./);
	assert.match(posted, /Night Shift \(5 tracks\) from \*\*Grey Tides\*\*/);
	assert.match(posted, /Long groups not taken as books.*: Kid Ferro \(4\.0 h\)/);
	assertPrivate(posted);
});
