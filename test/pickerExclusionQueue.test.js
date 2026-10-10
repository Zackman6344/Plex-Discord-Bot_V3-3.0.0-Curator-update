// Books kept out of the AI commands that queue or pick music: commands/vibe.js (tag hits, sidecar
// hits, named-artist hits and the discovery wildcards), commands/sonic.js (the section listing the
// anchor comes from, and the sonic hub results that become synthetic !play messages) and
// commands/quotethebard.js (the playlist and library lists the secret song is drawn from).
//
// The bug: each of these reads Plex lists that hold the catalogued audiobook chapters and podcast
// episodes. /vibe queued chapters that carry a mood tag (two T.H. White parts reached the
// recent-picks file), recorded them as picks and proposed sidecar tags for them; /sonic could
// anchor on a chapter or emit "!play <chapter> song" for a sonic neighbour; and Quote the Bard
// could ask the AI to translate the "lyrics" of a chapter file.
//
// Harness: the catalog store seeded as in test/pickerExclusion.test.js (pid-suffixed
// PLEXBOT_BOOK_CATALOG_FILE before the first require, a deep clone of the synthetic
// test/fixtures/books/catalog.json, the exclusion asserted on first), with tracks taken from
// test/fixtures/books/library.json. No network: the shared Gemini model's generateContent and
// the shared Plex client's query are replaced per test, and vibe's helper modules (plexTags,
// tagSidecar, recentPicks, tagInference) are stubbed on their module objects, the way
// test/pickerExclusion.test.js stubs the shared Plex client for Hitster. sonic's 3.5 s pauses
// between synthetic messages run on mock timers. Math.random is pinned so every shuffle keeps
// its input order and the book tracks, listed first, are the ones a missing filter would pick.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const FILE = pathMod.join(os.tmpdir(), `plexbot-test-queue-catalog-${process.pid}.json`);
const LOG_DIR = pathMod.join(os.tmpdir(), `plexbot-test-queue-${process.pid}`);
const PICKS_FILE = pathMod.join(os.tmpdir(), `plexbot-test-queue-picks-${process.pid}.json`);
const TAGS_FILE = pathMod.join(os.tmpdir(), `plexbot-test-queue-tags-${process.pid}.json`);
process.env.PLEXBOT_BOOK_CATALOG_FILE = FILE;
process.env.PLEXBOT_LOG_DIR = LOG_DIR;
process.env.PLEXBOT_RECENT_PICKS_FILE = PICKS_FILE;
process.env.PLEXBOT_TAGS_FILE = TAGS_FILE;

const config = require('../config/config');
const store = require('../helpers/bookCatalogStore.js');
const longForm = require('../helpers/longForm.js');
const { getPlex } = require('../helpers/plexClient.js');
const { getModel } = require('../helpers/geminiAPI.js');
const plexTags = require('../helpers/plexTags.js');
const sidecar = require('../helpers/tagSidecar.js');
const recentPicks = require('../helpers/recentPicks.js');
const tagInference = require('../helpers/tagInference.js');
const vibe = require('../commands/vibe.js');
const sonic = require('../commands/sonic.js');
const quotethebard = require('../commands/quotethebard.js');
const CATALOG = require('./fixtures/books/catalog.json');
const LIBRARY = require('./fixtures/books/library.json');

const originalSetting = config.audiobooksExcludeFromMusic;
const realRandom = Math.random;
const sharedPlex = getPlex();
const realSharedQuery = sharedPlex.query;
const model = getModel();
const realGenerate = model.generateContent;
const stubbed = [
	[plexTags, ['getVocabulary', 'fetchTracksByTags', 'fetchTracksByRatingKeys', 'sampleRandomTracks']],
	[sidecar, ['findByTags', 'getSettings', 'stage']],
	[recentPicks, ['record', 'recency', 'wasRecentlyPicked']],
	[tagInference, ['proposeForTracks', 'buildApprovalMessage']],
];
const realHelpers = stubbed.map(([mod, names]) => names.map((n) => mod[n]));

// Catalogued by track key (Glass Road, Ember Throne, Errant Knight, Tin Valley episode).
const BOOK_KEYS = ['20027', '20028', '20001', '20087', '20108'];
// Long-form only through the podcast artist: no catalog part has this track key.
const PODCAST_EXTRA = '20115';
const SONG_KEYS = ['20150', '20151', '20152'];
const OTHER_SONGS = ['20119', '20157'];

function clone(x) {
	return JSON.parse(JSON.stringify(x));
}

function track(ratingKey) {
	const t = LIBRARY.tracks.find((x) => x.ratingKey === ratingKey);
	assert.ok(t, `fixture track ${ratingKey}`);
	return clone(t);
}

const tracks = (keys) => keys.map(track);
const partKey = (ratingKey) => track(ratingKey).Media[0].Part[0].key;
// In this fixture every track up to 20118 is a book part or by a podcast artist; the rest is music.
const LONG_FORM = LIBRARY.tracks.filter((t) => Number(t.ratingKey) <= 20118);
const LONG_FORM_KEYS = new Set(LONG_FORM.map((t) => t.ratingKey));
const LONG_FORM_PARTS = new Set(LONG_FORM.map((t) => t.Media[0].Part[0].key));
const LONG_FORM_TITLES = new Set(LONG_FORM.map((t) => t.title));

function seed() {
	config.audiobooksExcludeFromMusic = true;
	store.replace(clone(CATALOG));
	assert.strictEqual(longForm.enabled(), true, 'the seeded catalog turns the exclusion on');
	assert.notStrictEqual(longForm.plexExclusion(), '', 'the seeded catalog gives a fragment');
	assert.strictEqual(store.index().trackKeys.has(PODCAST_EXTRA), false, 'the podcast extra has no catalog track key');
	assert.strictEqual(longForm.isLongFormTrack(track(PODCAST_EXTRA)), true, 'the podcast extra is long-form by artist');
}

function reply(json) {
	return { response: { text: () => JSON.stringify(json) } };
}

// Answers each generateContent call in turn and keeps the prompts.
function scriptModel(...answers) {
	const prompts = [];
	model.generateContent = async (prompt) => {
		prompts.push(prompt);
		const next = answers[Math.min(prompts.length - 1, answers.length - 1)];
		return reply(typeof next === 'function' ? next(prompt) : next);
	};
	return prompts;
}

function routePlex(route) {
	const urls = [];
	sharedPlex.query = async (url) => {
		urls.push(url);
		return { MediaContainer: route(url) || {} };
	};
	return urls;
}

let channels = 0;

function fakeChannel() {
	const sent = [];
	const edits = [];
	const collectors = [];
	const channel = {
		id: `channel-${++channels}`,
		sent,
		edits,
		collectors,
		send: async (x) => {
			sent.push(x);
			return { edit: async (y) => { edits.push(y); return {}; }, delete: async () => {} };
		},
		awaitMessages: async () => { throw new Error('no prompt expected'); },
		createMessageCollector: () => {
			const handlers = {};
			const c = {
				on: (ev, fn) => { handlers[ev] = fn; return c; },
				stop: (reason) => { if (handlers.end) handlers.end(new Map(), reason); },
			};
			collectors.push(c);
			return c;
		},
	};
	return channel;
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test.afterEach(() => {
	Math.random = realRandom;
	sharedPlex.query = realSharedQuery;
	model.generateContent = realGenerate;
	stubbed.forEach(([mod, names], i) => names.forEach((n, j) => { mod[n] = realHelpers[i][j]; }));
	try { fs.unlinkSync(FILE); } catch (_) {}
	try { fs.rmSync(`${FILE}.tmp`, { recursive: true, force: true }); } catch (_) {}
	store.reset();
	config.audiobooksExcludeFromMusic = true;
});

test.after(() => {
	config.audiobooksExcludeFromMusic = originalSetting;
	for (const f of [PICKS_FILE, TAGS_FILE, `${PICKS_FILE}.tmp`, `${TAGS_FILE}.tmp`]) {
		try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) {}
	}
	try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

// vibe -----------------------------------------------------------------------------------------

const tagEntry = (t) => ({ track: t, matchedMoods: ['Calm'], matchedGenres: [] });

// Every source empty by default; a test sets the ones it exercises.
function vibeHarness({ tagTracks = [], sidecarHits = [], fullTracks = [], artists = [], artistHits = [], sample = [], discoveryPercent = 0 } = {}) {
	const seen = { record: [], proposed: [], sampleCalls: 0 };
	plexTags.getVocabulary = async () => ({ sectionKey: '1', moods: [{ title: 'Calm' }], genres: [{ title: 'Ambient' }] });
	plexTags.fetchTracksByTags = async () => ({ tracks: tagTracks.map(tagEntry), usedMoods: ['Calm'], usedGenres: [], unknown: [] });
	plexTags.fetchTracksByRatingKeys = async (keys) => fullTracks.filter((t) => keys.map(String).includes(String(t.ratingKey)));
	plexTags.sampleRandomTracks = async () => { seen.sampleCalls++; return clone(sample); };
	sidecar.findByTags = () => sidecarHits.map((rk) => ({ ratingKey: String(rk), entry: {}, matched: { moods: ['Calm'], genres: [], styles: [] } }));
	sidecar.getSettings = () => ({ repeatMemory: 0, discoveryPercent });
	sidecar.stage = () => 'proposal-1';
	recentPicks.record = (keys) => { seen.record.push(...keys.map(String)); };
	recentPicks.recency = () => 0;
	recentPicks.wasRecentlyPicked = () => false;
	tagInference.proposeForTracks = async (keys) => { seen.proposed.push(...keys.map(String)); return { proposals: [], superseded: 0 }; };
	tagInference.buildApprovalMessage = () => 'approval';
	seen.urls = routePlex((url) => (url.startsWith('/search/') ? { Metadata: clone(artistHits) } : {}));
	seen.prompts = scriptModel(
		{ vibe: 'calm evening', artists, genres: [], moods: ['Calm'], trackCount: null, durationMinutes: null },
		{ playlist: Array.from({ length: 200 }, (_, id) => ({ id, reason: 'fits' })) },
	);
	return seen;
}

async function runVibe() {
	Math.random = () => 0.999;
	const channel = fakeChannel();
	const bot = { songQueue: [], isPlaying: false, played: 0 };
	bot.playSong = () => { bot.played++; };
	const msg = { author: { id: 'user-1' }, channel, interaction: { options: { getBoolean: () => false } } };
	await vibe.command.process(bot, null, msg, 'calm evening');
	return { bot, channel };
}

function assertNoBooks(bot, seen) {
	const queued = bot.songQueue.map((e) => e.key);
	assert.deepStrictEqual(queued.filter((k) => LONG_FORM_PARTS.has(k)), [], 'no book part is queued');
	assert.deepStrictEqual(seen.record.filter((k) => LONG_FORM_KEYS.has(k)), [], 'no book key reaches recentPicks.record');
	assert.deepStrictEqual(seen.proposed.filter((k) => LONG_FORM_KEYS.has(k)), [], 'no book key reaches tagInference.proposeForTracks');
}

test('vibe drops book tracks from its mood-tag hits', async () => {
	seed();
	const seen = vibeHarness({ tagTracks: tracks([...BOOK_KEYS, ...SONG_KEYS]) });
	const { bot, channel } = await runVibe();
	assertNoBooks(bot, seen);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key).sort(), SONG_KEYS.map(partKey).sort(), channel.edits.join('\n'));
	assert.deepStrictEqual(seen.record.sort(), [...SONG_KEYS].sort());
	assert.deepStrictEqual(seen.proposed.sort(), [...SONG_KEYS].sort());
	assert.strictEqual(bot.played, 1);
	for (const title of tracks(BOOK_KEYS).map((t) => t.title)) {
		assert.ok(!seen.prompts[1].includes(JSON.stringify(title)), `the curator never sees ${title}`);
	}
});

test('vibe drops a sidecar hit whose fetched track belongs to a podcast artist', async () => {
	seed();
	const seen = vibeHarness({
		tagTracks: tracks([SONG_KEYS[0]]),
		sidecarHits: [PODCAST_EXTRA, SONG_KEYS[1]],
		fullTracks: tracks([PODCAST_EXTRA, SONG_KEYS[1]]),
	});
	const { bot, channel } = await runVibe();
	assertNoBooks(bot, seen);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key).sort(), [SONG_KEYS[0], SONG_KEYS[1]].map(partKey).sort(), channel.edits.join('\n'));
});

test('vibe keeps catalogued sidecar hits from filling the 60-hit cap', async () => {
	seed();
	const bookKeys = LIBRARY.tracks.map((t) => t.ratingKey).filter((k) => store.index().trackKeys.has(k)).slice(0, 60);
	assert.strictEqual(bookKeys.length, 60);
	const lone = OTHER_SONGS[1];
	const seen = vibeHarness({
		sidecarHits: [...bookKeys, lone],
		fullTracks: tracks([...bookKeys, lone]),
	});
	const { bot, channel } = await runVibe();
	assertNoBooks(bot, seen);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key), [partKey(lone)], channel.edits.join('\n'));
});

test('vibe ignores a named artist whose search hits are all books', async () => {
	seed();
	const seen = vibeHarness({
		tagTracks: tracks(SONG_KEYS),
		artists: ['Avery Quill'],
		artistHits: tracks(['20001', '20002', '20005']),
	});
	const { bot, channel } = await runVibe();
	assert.ok(seen.urls.some((u) => u.startsWith('/search/')), 'the artist was looked up');
	assertNoBooks(bot, seen);
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key).sort(), SONG_KEYS.map(partKey).sort(), channel.edits.join('\n'));
	assert.ok(!seen.prompts[1].includes('explicitly requested music by Avery Quill'), 'the curator is not told to favour a book author');
});

test('vibe never spends a discovery wildcard on a book track', async () => {
	seed();
	const seen = vibeHarness({
		tagTracks: tracks(SONG_KEYS),
		sample: tracks(['20027', '20001', PODCAST_EXTRA, ...OTHER_SONGS]),
		discoveryPercent: 100,
	});
	const { bot, channel } = await runVibe();
	assert.strictEqual(seen.sampleCalls, 1);
	assertNoBooks(bot, seen);
	const queued = bot.songQueue.map((e) => e.key);
	assert.strictEqual(queued.length, 3, channel.edits.join('\n'));
	assert.deepStrictEqual(OTHER_SONGS.map(partKey).filter((k) => queued.includes(k)).sort(), OTHER_SONGS.map(partKey).sort(), 'both wildcards are songs');
});

test('vibe whose every hit is a book queues nothing and points at /book', async () => {
	seed();
	const seen = vibeHarness({ tagTracks: tracks(['20027', '20028']) });
	const { bot, channel } = await runVibe();
	assertNoBooks(bot, seen);
	assert.deepStrictEqual(bot.songQueue, []);
	const last = channel.edits[channel.edits.length - 1];
	assert.match(last, /No matches for that vibe/);
	assert.ok(last.endsWith('\n📚 Also in your books: The Glass Road (Avery Quill), `/book play the glass road`'), last);
});

test('vibe queues book tracks again when the exclusion is turned off', async () => {
	seed();
	config.audiobooksExcludeFromMusic = false;
	assert.strictEqual(longForm.enabled(), false);
	vibeHarness({ tagTracks: tracks(['20027', SONG_KEYS[0]]) });
	const { bot } = await runVibe();
	assert.deepStrictEqual(bot.songQueue.map((e) => e.key).sort(), ['20027', SONG_KEYS[0]].map(partKey).sort());
});

// sonic ----------------------------------------------------------------------------------------

const SECTIONS = { Directory: [{ type: 'artist', key: '1', title: 'Music' }] };

function sonicHarness(t, { typeData, anchor, section, hub }) {
	const urls = routePlex((url) => {
		if (url === '/library/sections') return SECTIONS;
		if (url.startsWith('/library/sections/1/all')) return { Metadata: clone(section) };
		if (url.endsWith('/related')) return { Hub: [{ context: 'hub.music.sonic', hubIdentifier: 'sonic', Metadata: clone(hub) }] };
		return {};
	});
	const prompts = scriptModel(typeData, anchor || {});
	const channel = fakeChannel();
	const emitted = [];
	const client = {
		user: { id: 'bot-user' },
		listeners: () => [() => {}],
		emit: (ev, m) => { emitted.push(m.content); },
	};
	const msg = { content: '/sonic', author: { id: 'user-1' }, channel, client };
	t.mock.timers.enable({ apis: ['setTimeout'] });
	return { urls, prompts, channel, emitted, msg };
}

async function runSonic(t, h, query) {
	Math.random = () => 0.999;
	let done = false;
	const run = sonic.command.process({}, null, h.msg, query).then(() => { done = true; });
	for (let i = 0; i < 100 && !done; i++) {
		await settle();
		t.mock.timers.tick(3500);
	}
	await run;
}

const playLine = (t) => `!play ${t.title} ${t.grandparentTitle} song`;

test('sonic shows the AI only songs when it picks a vibe anchor', async (t) => {
	seed();
	const h = sonicHarness(t, {
		typeData: { isSpecificSong: false, vibe: 'calm', keywords: [], trackCount: 2 },
		anchor: { title: 'Song 1', artist: 'Theo Bramble', ratingKey: '20150', reason: 'calm' },
		section: tracks([...BOOK_KEYS, PODCAST_EXTRA, ...SONG_KEYS]),
		hub: tracks([SONG_KEYS[1]]),
	});
	await runSonic(t, h, 'calm');
	const offered = JSON.parse(/(\[[\s\S]*?\])\s*\n\s*Output ONLY/.exec(h.prompts[1])[1]);
	assert.deepStrictEqual(offered.map((x) => x.ratingKey).sort(), [...SONG_KEYS].sort());
	assert.deepStrictEqual(h.emitted, ['!play Song 1 Theo Bramble song', playLine(track(SONG_KEYS[1]))]);
});

test('sonic drops book tracks from the sonic hub before the synthetic !play', async (t) => {
	seed();
	const h = sonicHarness(t, {
		typeData: { isSpecificSong: true, specificQuery: 'song 1', vibe: '', keywords: [], trackCount: 3 },
		section: tracks(SONG_KEYS),
		hub: tracks(['20027', PODCAST_EXTRA, '20001', SONG_KEYS[1], SONG_KEYS[2]]),
	});
	await runSonic(t, h, 'songs like song 1');
	assert.ok(h.urls.includes('/library/metadata/20150/related'));
	assert.deepStrictEqual(h.emitted, [
		'!play Song 1 Theo Bramble song',
		playLine(track(SONG_KEYS[1])),
		playLine(track(SONG_KEYS[2])),
	]);
	for (const title of LONG_FORM_TITLES) assert.ok(!h.channel.sent.some((s) => String(s).includes(`**${title}**`)), `${title} is not announced`);
});

test('sonic never anchors on a chapter and points at /book instead', async (t) => {
	seed();
	const h = sonicHarness(t, {
		typeData: { isSpecificSong: true, specificQuery: 'copper bells', vibe: '', keywords: [], trackCount: 3 },
		section: tracks(['20019', '20020', ...SONG_KEYS]),
		hub: tracks(SONG_KEYS),
	});
	await runSonic(t, h, 'songs like the copper bells');
	assert.deepStrictEqual(h.emitted, []);
	assert.ok(!h.urls.some((u) => u.endsWith('/related')), 'no sonic lookup for a chapter');
	const last = h.channel.edits[h.channel.edits.length - 1];
	assert.match(last, /couldn't find any track matching \*\*"copper bells"\*\* in the vault!\n/);
	assert.ok(last.includes(longForm.ONLY_PREFIX), last);
});

// quotethebard ---------------------------------------------------------------------------------

function bardHarness(t, route) {
	const urls = routePlex(route);
	const prompts = scriptModel({
		title: 'Song 1', artist: 'Theo Bramble', original_lyrics: 'la', lyrics: 'la',
		clue2: 'a', clue3: 'b', clue4: 'c', clue5: 'd',
	});
	const channel = fakeChannel();
	const msg = { author: { id: 'user-1' }, channel };
	t.mock.timers.enable({ apis: ['setTimeout'] });
	return { urls, prompts, channel, msg };
}

async function runBard(h, query) {
	Math.random = () => 0.999;
	await quotethebard.command.process({}, null, h.msg, query);
	// Ends the game so its collector and clue timers do not outlive the test.
	await quotethebard.command.process({}, null, h.msg, 'stop');
}

function bardCatalog(prompt) {
	return JSON.parse(/catalog of songs from the user's Plex server:\s*(\[[\s\S]*?\])\s*\n/.exec(prompt)[1]);
}

test('quotethebard draws the secret song from library songs only', async (t) => {
	seed();
	const h = bardHarness(t, (url) => {
		if (url === '/library/sections') return SECTIONS;
		if (url.startsWith('/library/sections/1/all')) return { Metadata: tracks([...BOOK_KEYS, PODCAST_EXTRA, ...SONG_KEYS]) };
		return {};
	});
	await runBard(h, 'start easy rock');
	assert.strictEqual(h.prompts.length, 1);
	assert.deepStrictEqual(bardCatalog(h.prompts[0]).map((x) => x.title).sort(), tracks(SONG_KEYS).map((x) => x.title).sort());
});

test('quotethebard draws the secret song from playlist songs only', async (t) => {
	seed();
	const h = bardHarness(t, (url) => {
		if (url === '/playlists') return { Metadata: [{ ratingKey: '7001', title: 'Mixed Tape', playlistType: 'audio' }] };
		if (url === '/playlists/7001/items') return { Metadata: tracks([...BOOK_KEYS, PODCAST_EXTRA, ...SONG_KEYS]) };
		return {};
	});
	await runBard(h, 'start easy rock playlist mixed tape');
	assert.strictEqual(h.prompts.length, 1);
	assert.deepStrictEqual(bardCatalog(h.prompts[0]).map((x) => x.title).sort(), tracks(SONG_KEYS).map((x) => x.title).sort());
});

test('quotethebard refuses a playlist of only books without asking the AI', async (t) => {
	seed();
	const h = bardHarness(t, (url) => {
		if (url === '/playlists') return { Metadata: [{ ratingKey: '7002', title: 'Bedtime Books', playlistType: 'audio' }] };
		if (url === '/playlists/7002/items') return { Metadata: tracks(BOOK_KEYS) };
		return {};
	});
	await runBard(h, 'start easy playlist bedtime books');
	assert.strictEqual(h.prompts.length, 0);
	assert.strictEqual(h.channel.edits[h.channel.edits.length - 1], '❌ The playlist "**Bedtime Books**" holds only audiobooks and podcasts, no songs!');
});
