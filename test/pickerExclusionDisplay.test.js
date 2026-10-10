// Books kept out of the commands that only show music, never queue it: the AI recommenders
// commands/curator.js, commands/groupwatch.js and commands/quest.js, the vault mode of
// commands/identify.js, the albums category of commands/releasesurvival.js, and the coverage
// estimate of commands/tags.js.
//
// The bug: each of these reads the whole music section, and the section holds 900-odd
// audiobook chapters. The recommenders handed chapter files to the AI as "songs" to pitch,
// Release Survival dealt book albums as albums to date, and identify's vault mode counted every
// chapter of a long book as a separate suspect, so any description of that book flagged more
// than SAFETY_LIMIT (400) and was refused as too broad. identify's ownership check is a lookup,
// not a pick, and must still find books.
//
// Harness: the catalog store seeded as in test/pickerExclusion.test.js (pid-suffixed
// PLEXBOT_BOOK_CATALOG_FILE before the first require, a deep clone of the synthetic
// test/fixtures/books/catalog.json, exclusion asserted on first). The shared Plex client's query
// is stubbed as test/voiceClaims.test.js does for Hitster. helpers/geminiAPI.js is replaced in
// require.cache before any command loads, so every getModel() returns one scripted model and no
// test can reach Gemini. Discord is a fake channel whose collectors are EventEmitters the test
// drives and whose awaitMessages answers from a script.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-display-catalog-${process.pid}.json`);
const LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-display-' + process.pid);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = LOG_DIR;
process.env.PLEXBOT_TAGS_FILE = pathMod.join(os.tmpdir(), `plexbot-test-display-tags-${process.pid}.json`);
process.env.PLEXBOT_RECENT_PICKS_FILE = pathMod.join(os.tmpdir(), `plexbot-test-display-picks-${process.pid}.json`);

const ai = { prompts: [], replies: [] };
const fakeModel = {
	async generateContent(prompt) {
		ai.prompts.push(prompt);
		assert.ok(ai.replies.length > 0, 'the test scripted a reply for every AI call');
		const reply = ai.replies.shift();
		const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
		return { response: { text: () => text } };
	},
};
const geminiPath = require.resolve('../helpers/geminiAPI.js');
require.cache[geminiPath] = {
	id: geminiPath,
	filename: geminiPath,
	loaded: true,
	exports: { DEFAULT_MODEL: 'test-model', getModel: () => fakeModel, getGenAI: () => null },
};

const config = require('../config/config');
const store = require('../helpers/bookCatalogStore.js');
const longForm = require('../helpers/longForm.js');
const plexTags = require('../helpers/plexTags.js');
const { getPlex } = require('../helpers/plexClient.js');
const curator = require('../commands/curator.js');
const groupwatch = require('../commands/groupwatch.js');
const quest = require('../commands/quest.js');
const identify = require('../commands/identify.js');
const releasesurvival = require('../commands/releasesurvival.js');
const tags = require('../commands/tags.js');
const CATALOG = require('./fixtures/books/catalog.json');
const LIBRARY = require('./fixtures/books/library.json');

const originalSetting = config.audiobooksExcludeFromMusic;
const realRandom = Math.random;
const sharedPlex = getPlex();
const realSharedQuery = sharedPlex.query;

// 20116-20118 (a podcast artist's OST album) are long-form only at artist level, which is
// longForm's rule to test, not this file's; they are asserted neither way here.
const BOOK_TRACKS = LIBRARY.tracks.filter((t) => Number(t.ratingKey) <= 20115);
const MUSIC_TRACKS = LIBRARY.tracks.filter((t) => Number(t.ratingKey) >= 20119);
const SECTIONS = { Directory: [{ type: 'artist', key: '7', title: 'Music' }, { type: 'movie', key: '2', title: 'Movies' }] };

function clone(x) {
	return JSON.parse(JSON.stringify(x));
}

function seed() {
	config.audiobooksExcludeFromMusic = true;
	store.replace(clone(CATALOG));
	assert.strictEqual(longForm.enabled(), true, 'the seeded catalog turns the exclusion on');
	assert.notStrictEqual(longForm.plexExclusion(), '', 'the seeded catalog gives a fragment');
}

function libraryTracks() {
	return clone(LIBRARY.tracks);
}

function asRow(t) {
	return `${t.title} by ${t.grandparentTitle}`;
}

function stubPlex(route) {
	const urls = [];
	sharedPlex.query = async (url) => {
		urls.push(url);
		if (url === '/library/sections') return { MediaContainer: SECTIONS };
		const mc = route(url);
		assert.ok(mc, `the test routes ${url}`);
		return { MediaContainer: mc };
	};
	return urls;
}

// JSON.stringify writes "title":"..." with no space, which the prompts' own example objects
// ("title": "Exact Title") never match, so this reads only the catalog the command sent.
function catalogTitles(prompt) {
	return [...prompt.matchAll(/"title":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
}

function assertMusicOnly(prompt) {
	const titles = catalogTitles(prompt);
	assert.ok(titles.length > 0, 'the prompt carries a catalog');
	for (const t of BOOK_TRACKS) assert.ok(!titles.includes(asRow(t)), `chapter ${t.ratingKey} "${asRow(t)}" reached the AI`);
	for (const t of MUSIC_TRACKS) assert.ok(titles.includes(asRow(t)), `music ${t.ratingKey} "${asRow(t)}" is offered`);
}

function fakeChannel(answers = []) {
	const sent = [];
	const collectors = [];
	const channel = {
		id: 'channel-1',
		sent,
		collectors,
		async send(content) {
			const m = { content, edits: [], deleted: false, channel };
			m.edit = async (x) => { m.edits.push(x); return m; };
			m.delete = async () => { m.deleted = true; };
			sent.push(m);
			return m;
		},
		createMessageCollector(opts) {
			const c = new EventEmitter();
			c.opts = opts;
			c.resetTimer = () => {};
			c.stop = (reason) => { c.stopped = reason || 'user'; };
			collectors.push(c);
			return c;
		},
		async awaitMessages() {
			// A non-Error rejection is how discord.js reports a timeout, which promptUser turns into null.
			if (answers.length === 0) throw new Map();
			const content = answers.shift();
			return { first: () => ({ content }) };
		},
		async sendTyping() {},
	};
	return channel;
}

const AUTHOR = { id: 'user-1', username: 'tester', bot: false };

function texts(channel) {
	return channel.sent.flatMap((m) => [m.content, ...m.edits]).filter((x) => typeof x === 'string');
}

function said(channel, fragment) {
	return texts(channel).some((x) => x.includes(fragment));
}

async function until(pred, what) {
	for (let i = 0; i < 500; i++) {
		if (pred()) return;
		await new Promise((r) => setImmediate(r));
	}
	assert.fail(`timed out waiting for ${what}`);
}

test.afterEach(() => {
	Math.random = realRandom;
	sharedPlex.query = realSharedQuery;
	ai.prompts.length = 0;
	ai.replies.length = 0;
	plexTags._resetCache();
	try { fs.unlinkSync(FILE); } catch (_) {}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	store.reset();
	config.audiobooksExcludeFromMusic = true;
});

test.after(() => {
	config.audiobooksExcludeFromMusic = originalSetting;
	try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

// curator --------------------------------------------------------------------------------------

async function runCurator(keywords) {
	stubPlex((url) => (url === '/library/sections/7/all?type=10' ? { Metadata: libraryTracks() } : null));
	ai.replies.push({ type: 'artist', keywords }, { intent: 'filter', message: 'Here you go.', matches: [{ title: asRow(MUSIC_TRACKS[0]), year: '2001', pitch: 'fits' }] });
	const channel = fakeChannel();
	await curator.command.process({}, {}, { channel, author: AUTHOR });
	const collector = channel.collectors[0];
	collector.emit('collect', { content: 'some calm music', author: AUTHOR });
	await until(() => said(channel, 'Current Matches'), 'the curator recommendations');
	collector.emit('end');
	return channel;
}

test('curator sends the AI music and no audiobook chapters', async () => {
	seed();
	await runCurator([]);
	assert.strictEqual(ai.prompts.length, 2);
	assertMusicOnly(ai.prompts[1]);
});

test('curator keeps books out of its no-match fallback pool too', async () => {
	seed();
	await runCurator(['nothing-matches-this']);
	assertMusicOnly(ai.prompts[1]);
});

test('curator offers books again when the exclusion setting is off', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	assert.strictEqual(longForm.enabled(), false);
	await runCurator([]);
	const titles = catalogTitles(ai.prompts[1]);
	for (const t of BOOK_TRACKS) assert.ok(titles.includes(asRow(t)), `chapter ${t.ratingKey} is offered with the exclusion off`);
});

// groupwatch -----------------------------------------------------------------------------------

test('groupwatch sends the AI music and no audiobook chapters', async () => {
	seed();
	stubPlex((url) => (url === '/library/sections/7/all?type=10' ? { Metadata: libraryTracks() } : null));
	ai.replies.push({ type: 'artist', keywords: [] }, { matches: [{ title: asRow(MUSIC_TRACKS[0]), year: '2001', pitch: 'everyone wins' }] });
	const channel = fakeChannel();
	await groupwatch.command.process({}, {}, { channel, author: AUTHOR });
	channel.collectors[0].emit('collect', { content: 'music', author: AUTHOR });
	await until(() => channel.collectors.length >= 2, 'the group collector');
	const group = channel.collectors[1];
	group.emit('collect', { content: 'something mellow', author: { id: 'user-2', username: 'friend', bot: false }, react: async () => {} });
	group.emit('end');
	await until(() => said(channel, 'Group Watch Compromise Found'), 'the compromise');
	assert.strictEqual(ai.prompts.length, 2);
	assertMusicOnly(ai.prompts[1]);
	for (const c of channel.collectors) c.removeAllListeners();
});

// quest ----------------------------------------------------------------------------------------

test('quest builds a music quest from music only', async () => {
	seed();
	stubPlex((url) => (url === '/library/sections/7/all?type=10' ? { Metadata: libraryTracks() } : null));
	ai.replies.push(
		{ theme: 'calm', keywords: [], targetCount: 1 },
		{ questTitle: 'Calm', introPitch: 'Go.', stages: [{ stageNum: 1, stageName: 'Start', title: asRow(MUSIC_TRACKS[0]), year: '2001', narrative: 'first' }] },
	);
	const channel = fakeChannel(['Music', 'a short calm journey']);
	await quest.command.process({}, {}, { channel, author: AUTHOR });
	assert.ok(said(channel, 'QUEST ACCEPTED'), texts(channel).join('\n'));
	assert.strictEqual(ai.prompts.length, 2);
	assertMusicOnly(ai.prompts[1]);
});

// identify -------------------------------------------------------------------------------------

function hollowLibrary(chapters) {
	const tracks = libraryTracks();
	for (let i = 1; i <= chapters; i++) {
		tracks.push({
			ratingKey: String(30000 + i),
			type: 'track',
			title: `The Hollow King - Chapter ${i}`,
			parentRatingKey: '1040',
			grandparentRatingKey: '9005',
			parentTitle: 'The Hollow King',
			grandparentTitle: 'R.J. Ashdown',
		});
	}
	tracks.push(Object.assign(clone(MUSIC_TRACKS.find((t) => t.ratingKey === '20157')), { ratingKey: '20999', title: 'Hollow Bones' }));
	return tracks;
}

async function runVault(library, keywords) {
	stubPlex((url) => (url === '/library/sections/7/all?type=10' ? { Metadata: library } : null));
	ai.replies.push({ type: 'artist', keywords }, { identified: true, title: 'The Hollow King', year: '2020', pitch: 'A long one.', trivia: 'None.' });
	const channel = fakeChannel(['yes', 'that long hollow book', 'yes']);
	await identify.command.process({}, {}, { channel, author: AUTHOR });
	return channel;
}

test('identify vault mode counts a long book as one suspect, not one per chapter', async () => {
	seed();
	const channel = await runVault(hollowLibrary(450), ['hollow']);
	assert.ok(!said(channel, 'Whoa there'), 'the chapters tripped SAFETY_LIMIT');
	assert.ok(said(channel, 'Case closed'), texts(channel).join('\n'));
	assert.strictEqual(ai.prompts.length, 2);
	const titles = catalogTitles(ai.prompts[1]);
	assert.deepStrictEqual(titles.sort(), ['Hollow Bones by The Quiet Hours', 'The Hollow King by R.J. Ashdown', 'The Tin Valley by Lantern Hollow']);
	assert.match(ai.prompts[1], /An audiobook by R\.J\. Ashdown, read by Tomas Brandt\./);
});

test('identify vault mode lists every catalogued work once, editions apart, and no chapter', async () => {
	seed();
	await runVault(libraryTracks(), []);
	const titles = catalogTitles(ai.prompts[1]);
	for (const t of BOOK_TRACKS) assert.ok(!titles.includes(asRow(t)), `chapter ${t.ratingKey} is a suspect`);
	for (const t of MUSIC_TRACKS) assert.ok(titles.includes(asRow(t)), `music ${t.ratingKey} is a suspect`);
	for (const w of Object.values(CATALOG.works)) {
		const editions = Object.values(CATALOG.works).filter((x) => x.title === w.title && x.author === w.author).length;
		const rows = titles.filter((x) => x === `${w.title} by ${w.author}`).length;
		assert.strictEqual(rows, editions, `${w.id} gives one row per edition`);
	}
	assert.match(ai.prompts[1], /read by Harlow/);
	assert.match(ai.prompts[1], /read by Penrose/);
	assert.match(ai.prompts[1], /A podcast by Lantern Hollow\./);
});

test('identify global mode still finds a book in the vault', async () => {
	seed();
	stubPlex((url) => (url === '/library/sections/7/all?type=10' ? { Metadata: libraryTracks() } : null));
	ai.replies.push({ identified: true, title: 'R.J. Ashdown', year: '2020', type: 'artist', pitch: 'An author.', trivia: 'None.' });
	const channel = fakeChannel(['no', 'that author with the long book']);
	await identify.command.process({}, {}, { channel, author: AUTHOR });
	assert.ok(said(channel, 'Good news!'), texts(channel).join('\n'));
});

// releasesurvival ------------------------------------------------------------------------------

function albumLibrary(musicCount) {
	const albums = clone(LIBRARY.albums).filter((a) => Number(a.ratingKey) <= 1050);
	for (const a of albums) a.year = 2010;
	for (let i = 0; i < musicCount; i++) {
		albums.push({ ratingKey: String(1100 + i), type: 'album', title: `Record ${i}`, parentRatingKey: '9100', parentTitle: 'Synthetic Band', year: 1980 + i });
	}
	return albums;
}

// Steps through the list instead of repeating one index, so getNextItem's "different year" loop ends.
function stepRandom() {
	let k = 0;
	Math.random = () => ((k++) * 0.137) % 1;
}

test('release survival never deals a book album', async () => {
	seed();
	const albums = albumLibrary(12);
	const bookTitles = albums.filter((a) => Number(a.ratingKey) < 1100).map((a) => `${a.title} (by ${a.parentTitle})`);
	stubPlex((url) => (url === '/library/sections/7/all?type=9' ? { Metadata: albums } : null));
	stepRandom();
	const channel = fakeChannel();
	const msg = { channel, author: AUTHOR };
	await releasesurvival.command.process({}, {}, msg, 'start albums');
	try {
		const prompt = channel.sent.map((m) => m.content).find((x) => typeof x === 'string' && x.includes('RELEASE SURVIVAL HAS BEGUN'));
		assert.ok(prompt, texts(channel).join('\n'));
		assert.match(prompt, /Record \d+ \(by Synthetic Band\)/);
		for (const t of bookTitles) assert.ok(!prompt.includes(t), `book album "${t}" was dealt`);
	} finally {
		await releasesurvival.command.process({}, {}, msg, 'stop');
	}
});

test('release survival counts only music albums toward its ten-album minimum', async () => {
	seed();
	stubPlex((url) => (url === '/library/sections/7/all?type=9' ? { Metadata: albumLibrary(9) } : null));
	stepRandom();
	const channel = fakeChannel();
	await releasesurvival.command.process({}, {}, { channel, author: AUTHOR }, 'start albums');
	assert.ok(said(channel, "You don't have enough metadata in your albums library"), texts(channel).join('\n'));
	assert.ok(!said(channel, 'RELEASE SURVIVAL HAS BEGUN'));
});

// tags -----------------------------------------------------------------------------------------

test('tags coverage counts and samples music only', async () => {
	seed();
	const fragment = longForm.plexExclusion();
	const urls = stubPlex((url) => {
		if (/\/library\/sections\/7\/(mood|genre|style)\?type=10$/.test(url)) return { Directory: [] };
		if (url.includes('X-Plex-Container-Size=0')) return { totalSize: url.includes(fragment) ? MUSIC_TRACKS.length : LIBRARY.tracks.length };
		if (url.includes('X-Plex-Container-Size=1')) return { Metadata: [clone(MUSIC_TRACKS[0])] };
		if (url.startsWith('/library/metadata/')) return { Metadata: [Object.assign(clone(MUSIC_TRACKS[0]), { Mood: [{ tag: 'Calm' }] })] };
		return null;
	});
	const sent = [];
	const message = {
		reply: async (x) => { sent.push(x); return {}; },
		channel: { sendTyping: async () => {}, send: async (x) => { sent.push(x); return {}; } },
	};
	await tags.command.process({}, {}, message, 'coverage');
	assert.strictEqual(sent.length, 1);
	const description = sent[0].embeds[0].data.description;
	assert.match(description, new RegExp(`\\*\\*${MUSIC_TRACKS.length}\\*\\* tracks in the music library`));
	const listings = urls.filter((u) => u.includes('X-Plex-Container-Start='));
	assert.ok(listings.length >= 2, 'one count and at least one sample window');
	for (const u of listings) assert.ok(u.includes(fragment), `${u} carries the exclusion`);
});
