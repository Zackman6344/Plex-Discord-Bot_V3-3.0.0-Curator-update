// The read-along end to end: a generated EPUB next to the audio, through the real parse child,
// the real text source on temp dirs, the real model and renderer, to the DM page; and the two
// promises that only hold together: book text never reaches the command log or the bot log, and
// a big first parse never stalls the voice timer.
//
// The bug: a DM page whose text is not the slice the index points at (byte offsets off by a
// multi-byte character, or the two tokenizers counting words differently, so every page drifts);
// a page of the book written to data/logs by the bot's own messageCreate recorder; a leak test
// that passes only because the command log was switched off under the test runner; a 115 MB
// image-heavy EPUB parsed on the bot's thread, stuttering the audio for seconds.
//
// Harness: every store, cache and log path is pointed at pid-suffixed temp paths on the first
// lines, before any require, because helpers/commandLog.js decides at require time whether it
// writes at all. The pager is built with no injected source, so it runs the production wiring
// (bookTextSource.defaults(): the real epubTextWorker child). Calibre is switched off in config
// so nothing is contacted; the ebook is found as a sidecar EPUB in the work's folder. The
// director and the Discord client are the fakes from test/helpers/readAlongFakes.js; the DM send
// is recorded through commandLog.payloadOfMessage on a real discord.js Message built from API
// data with a client that never logs in. All text is generated (NATO words and made-up words).

const os = require('node:os');
const pathMod = require('node:path');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-readalong-int-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_TEXT_DIR = `${BASE}-text`;
process.env.PLEXBOT_BOOK_TEXT_LINKS_FILE = `${BASE}-links.json`;
process.env.PLEXBOT_BOOK_TEXT_READERS_FILE = `${BASE}-readers.json`;
process.env.PLEXBOT_BOOK_TEXT_WORKS_FILE = `${BASE}-works.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const config = require('../config/config.js');
const logger = require('../helpers/logger.js');
const commandLog = require('../helpers/commandLog.js');
const catalog = require('../helpers/bookCatalogStore.js');
const epubText = require('../helpers/epubText.js');
const epubTextWorker = require('../helpers/epubTextWorker.js');
const bookTextSource = require('../helpers/bookTextSource.js');
const model = require('../helpers/readAlongModel.js');
const { createReadAlong } = require('../helpers/readAlong.js');
const book = require('../commands/book.js');
const fixture = require('./helpers/epubFixture.js');
const T = require('./helpers/readAlongFakes.js');

const AUDIO = `${BASE}-audio`;
const BIG_AUDIO = `${BASE}-audio-big`;
const USER = '100000000000000001';
// Made-up words, so a hit in a log can only have come from the book.
const MARKER = 'Zorvath quindle marrowpike sang the brass orrery awake';

const saved = { calibreUrl: config.calibreUrl, audiobookTextEnabled: config.audiobookTextEnabled, audiobookTextSidecars: config.audiobookTextSidecars, audiobooksEnabled: config.audiobooksEnabled };

const logged = [];
const realLogger = {};
for (const level of ['debug', 'info', 'warn', 'error']) {
	realLogger[level] = logger[level];
	logger[level] = (...args) => {
		logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	};
}

const parses = [];
const realParse = epubTextWorker.parseEpub;
epubTextWorker.parseEpub = async (job) => {
	const res = await realParse(job);
	parses.push(res);
	return res;
};
epubTextWorker.parseEpub.VERSION = realParse.VERSION;

function cleanup() {
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
}

const live = [];
test.before(() => {
	cleanup();
	config.calibreUrl = '';
	config.audiobookTextEnabled = true;
	config.audiobookTextSidecars = true;
	config.audiobooksEnabled = true;
});
test.after(() => {
	for (const ra of live) ra.shutdown();
	epubTextWorker.shutdown();
	epubTextWorker.parseEpub = realParse;
	Object.assign(logger, realLogger);
	Object.assign(config, saved);
	cleanup();
});

function chapters(count, paragraphsEach, wordsEach, { marker = false } = {}) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const paragraphs = fixture.paragraphs(paragraphsEach, wordsEach, i * 1000);
		if (marker && i === 0) paragraphs[1] = `${MARKER}, ${paragraphs[1]}`;
		out.push({ label: `Chapter ${i + 1}`, paragraphs });
	}
	return out;
}

function workFor(id, title, dir, list) {
	return {
		id, kind: 'book', title, author: 'Test Author', narrator: null, edition: null, publisher: null,
		series: null, sequence: null, aliases: [], dirs: [dir],
		parts: list.map((c, i) => ({
			ordinal: i + 1, title: c.label, trackRatingKey: `${id}-${i}`, file: `${i + 1}.mp3`,
			durationMs: Math.round((c.paragraphs.join(' ').split(' ').length + 2) * T.MS_PER_WORD)
		}))
	};
}

function prefixMessage(query) {
	const calls = [];
	const user = { id: USER, username: 'Ana' };
	return {
		calls,
		author: user,
		member: { id: USER, user },
		guild: { id: '200000000000000001' },
		content: `!book ${query}`,
		channel: { id: '400000000000000001', name: 'books', async send(p) { calls.push(p); return {}; } },
		async reply(p) { calls.push(p); return {}; }
	};
}

async function until(cond, what, ms = 60000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 10));
	}
}

function pageOf(msg) {
	return [msg.first, ...msg.edits].reverse().find(p => T.pageWordOf(p) !== null) || null;
}

function plain(text) {
	return String(text).replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
}

const SMALL = chapters(3, 6, 60, { marker: true });
const SMALL_WORK = workFor('test-author/the-quokka-ledger', 'The Quokka Ledger', AUDIO, SMALL);
const BIG = chapters(40, 75, 100);
const BIG_WORK = workFor('test-author/the-heavy-atlas', 'The Heavy Atlas', BIG_AUDIO, BIG);

function seedCatalog() {
	catalog.replace({ meta: { builtAt: 1 }, works: { [SMALL_WORK.id]: SMALL_WORK, [BIG_WORK.id]: BIG_WORK } });
}

function setup(work) {
	const clock = T.manualClock();
	const books = T.fakeBooks(clock);
	const client = T.fakeClient();
	const ra = createReadAlong({ client, books });
	live.push(ra);
	books.add({ work, userId: USER, audible: false });
	return { clock, books, client, ra, bot: { books, readAlong: ra } };
}

test('a generated EPUB next to the audio reaches the DM page as exactly the slice the index points at', async () => {
	fs.mkdirSync(AUDIO, { recursive: true });
	fixture.writeEpub(pathMod.join(AUDIO, 'The Quokka Ledger.epub'), fixture.chapterBook({ title: 'The Quokka Ledger', chapters: SMALL }));
	seedCatalog();
	const h = setup(SMALL_WORK);

	const m = prefixMessage('text on');
	await book.command.process(h.bot, null, m, 'text on');
	assert.match(m.calls[0].content, /Sent to your DMs|Preparing the text in your DMs/);
	const msg = h.client.sent[0];
	await until(() => pageOf(msg), 'the first page');

	const page = pageOf(msg);
	const sectionText = ['Chapter 1', ...SMALL[0].paragraphs].join('\n');
	const pages = model.paginate(sectionText, { targetWords: 180, maxChars: 1400 });
	const want = sectionText.slice(pages[0].startChar, pages[0].endChar);
	assert.strictEqual(plain(page.embeds[0].description), plain(want));
	assert.ok(page.embeds[0].description.includes('Zorvath'), 'the marker paragraph is on the first page');
	assert.strictEqual(parses.length, 1);
	assert.strictEqual(parses[0].ok, true);
	assert.notStrictEqual(parses[0].summary.pid, process.pid, 'the parse ran in another process');

	// ---- the command log: the DM send as the bot's own messageCreate recorder sees it ----
	const { Client, Message } = require('discord.js');
	const discord = new Client({ intents: [] });
	const asSent = (payload, id) => new Message(discord, {
		id, channel_id: '500000000000000001', type: 0, timestamp: new Date().toISOString(),
		author: { id: '100000000000000099', username: 'bot', discriminator: '0' },
		content: payload.content || '', embeds: payload.embeds || [], components: payload.components || [],
		attachments: [], mentions: [], mention_roles: [], pinned: false, tts: false
	});
	const dmPage = asSent(page, '600000000000000001');
	assert.strictEqual(dmPage.components[0].components[0].constructor.name, 'ButtonComponent', 'real discord.js components');
	commandLog.recordOutput({ kind: 'message', channelId: dmPage.channelId, payload: commandLog.payloadOfMessage(dmPage) });
	const ordinary = asSent({ content: 'Ordinary reply: the lighthouse keeper waved', embeds: [{ title: 'Plain card' }], components: [] }, '600000000000000002');
	commandLog.recordOutput({ kind: 'message', channelId: ordinary.channelId, payload: commandLog.payloadOfMessage(ordinary) });
	discord.destroy();

	const file = pathMod.join(commandLog._dir, `commands-${new Date().toISOString().slice(0, 10)}.jsonl`);
	assert.ok(fs.existsSync(file), 'the command log is live under this test');
	const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
	const outputs = events.filter(e => e.type === 'output');
	assert.ok(outputs.some(e => e.embeds.length && e.embeds[0].title === '[book text not logged]'), 'positive control: the page was recorded, as a placeholder');
	assert.ok(outputs.some(e => e.content === 'Ordinary reply: the lighthouse keeper waved'), 'negative control: an ordinary message is kept verbatim');
	const raw = fs.readFileSync(file, 'utf8');
	for (const needle of ['Zorvath', 'marrowpike', SMALL[0].paragraphs[0].slice(0, 40)]) {
		assert.ok(!raw.includes(needle), `the command log holds "${needle}"`);
	}
	assert.ok(logged.some(l => /Read-along: read the ebook for cache [0-9a-f]{16}/.test(l)), 'positive control: the logger spy saw the parse');
	assert.ok(!logged.some(l => /Zorvath|marrowpike|alpha bravo charlie/.test(l)), 'no book text in the bot log');
});

test('parsing a large book never stalls the event loop', async (t) => {
	assert.strictEqual(bookTextSource.defaults().parse, require('../helpers/epubTextWorker.js'), 'the production parse is the child-process worker');
	assert.notStrictEqual(bookTextSource.defaults().parse, epubText);
	fs.mkdirSync(BIG_AUDIO, { recursive: true });
	const book50 = Object.assign(fixture.chapterBook({ title: 'The Heavy Atlas', chapters: BIG }), {
		manifestExtra: [{ id: 'plate', href: 'images/plate.png', mediaType: 'image/png' }],
		extra: [{ name: 'OEBPS/images/plate.png', data: Buffer.alloc(50 * 1024 * 1024, 0x5a), method: 0 }]
	});
	const epubPath = pathMod.join(BIG_AUDIO, 'The Heavy Atlas.epub');
	const { size } = fixture.writeEpub(epubPath, book50);
	assert.ok(size > 50 * 1024 * 1024 && size < 60 * 1024 * 1024, `${size}`);
	seedCatalog();

	// Under `npm test` fifteen other test files share the CPU, and a saturated scheduler alone
	// can hold a timer or the synchronous fork for 50-200 ms (measured: fork took 15 ms idle and
	// up to 215 ms with 24 busy processes). A parse on this thread stalls on EVERY attempt, a
	// contention spike only on some, so the best of three first parses is what is bounded.
	const stalls = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		let work = BIG_WORK;
		if (attempt > 0) {
			// A copy beside a work of its own: touching the first file would only change its
			// fingerprint, and the source would serve the old cache at once and re-parse in the
			// background, outside what this attempt measures.
			const dir = `${BIG_AUDIO}-${attempt}`;
			fs.mkdirSync(dir, { recursive: true });
			fs.copyFileSync(epubPath, pathMod.join(dir, pathMod.basename(epubPath)));
			work = { ...BIG_WORK, id: `${BIG_WORK.id}-${attempt}`, dirs: [dir] };
			catalog.replace({ meta: { builtAt: 1 }, works: { [SMALL_WORK.id]: SMALL_WORK, [BIG_WORK.id]: BIG_WORK, [work.id]: work } });
		}
		const h = setup(work);
		const before = parses.length;

		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		const m = prefixMessage('text on');
		await book.command.process(h.bot, null, m, 'text on');
		const msg = h.client.sent[0];
		await until(() => pageOf(msg), 'the first page of the big book', 120000);
		histogram.disable();

		assert.strictEqual(parses.length - before, 1, 'every attempt is a first parse');
		assert.strictEqual(parses[parses.length - 1].ok, true);
		assert.ok(parses[parses.length - 1].summary.totalWords > 290000, 'about 2 MB of XHTML went through');
		assert.notStrictEqual(parses[parses.length - 1].summary.pid, process.pid);
		stalls.push(histogram.max / 1e6);
		t.diagnostic(`attempt ${attempt + 1}: longest event-loop stall ${(histogram.max / 1e6).toFixed(1)} ms over ${histogram.count} samples`);
		if (histogram.max < 50e6) break;
	}
	assert.ok(Math.min(...stalls) < 50, `the longest event-loop stall was ${stalls.map(s => s.toFixed(1)).join(', ')} ms`);
});

test('the parser and the pager count words the same way', () => {
	const cp = (...codes) => String.fromCodePoint(...codes);
	const samples = [
		`don${cp(0x2019)}t stop-gap 42nd caf${cp(0xe9)}`,
		`${cp(0x201c)}Quoted${cp(0x201d)} ${cp(0x2014)}dash${cp(0x2014)} words`,
		`cafe${cp(0x301)} na${cp(0x308)}ive`,
		`${cp(0x6771, 0x4eac)} ${cp(0x3068)} ${cp(0x5927, 0x962a)}`,
		'\'tis rock\'n\'roll, isn\'t it?',
		'1,000 3.14 U.S.A. e-mail -- ---',
		`zero${cp(0x200d)}width join${cp(0x200b)}space`,
		`emoji ${cp(0x1f4d6)} between ${cp(0x1f469, 0x200d, 0x1f467)} words`,
		'tabs\tand\nnewlines\r\nand   spaces',
		'snake_case under_score',
		'',
		'...!?'
	];
	for (const s of samples) assert.strictEqual(epubText.countWords(s), model.words(s).length, JSON.stringify(s));
	assert.strictEqual(String(epubText.WORD_RE), String(model.WORD_RE));
});
