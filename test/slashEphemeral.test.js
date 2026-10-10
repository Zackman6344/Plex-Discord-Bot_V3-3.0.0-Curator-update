// app/music.js: the slash dispatcher's `ephemeral` (a value or a function of the interaction),
// and the button router's order now that book:* buttons have a handler.
//
// The bug: /book's ephemeral is a function, and `!!cmd.slash.ephemeral` reads any function as
// true, so the leaderboard would be private; the failed-defer fallback reading it the same way
// would post an ephemeral command's explanation publicly (or skip the public one); a throwing
// function would take the dispatch down; a book:* click falling through to tagInference unanswered.
//
// Harness: the real module wired to a fake client (an EventEmitter) and a fake bot, as
// app/utils.js wires them; the interactionCreate listener is called directly and awaited.
// Interactions are recording fakes in the shape of test/commandLogWiring.test.js's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-slash-ephemeral-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_TAGS_FILE = `${BASE}-tags.json`;

const config = require('../config/config.js');
const plexCommands = require('../commands');
const music = require('../app/music.js');

const EPHEMERAL = 64;
const G = '200000000000000001';
const ANA = '100000000000000001';

const client = new EventEmitter();
client.user = { id: '100000000000000099', tag: 'bot#0001' };
const bot = { config, language: {}, songQueue: [] };
music(client, bot);
const dispatch = client.listeners('interactionCreate')[0];

const savedEnabled = config.audiobooksEnabled;
test.afterEach(() => {
	config.audiobooksEnabled = savedEnabled;
	delete plexCommands.zzephemeralthrows;
});
test.after(() => {
	bot.books.shutdown();
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
});

function chat(name, sub, { deferFails = false } = {}) {
	const calls = [];
	return {
		calls,
		commandName: name,
		user: { id: ANA, username: 'Ana' },
		member: { id: ANA, voice: {} },
		guild: { id: G },
		guildId: G,
		channelId: '400000000000000001',
		client: {},
		channel: { id: '400000000000000001', name: 'books', async send(p) { calls.push(['channel.send', p]); } },
		isAutocomplete: () => false,
		isButton: () => false,
		isChatInputCommand: () => true,
		options: { data: [], getSubcommand: () => sub, get: () => null, getUser: () => null },
		async deferReply(opts) {
			calls.push(['deferReply', opts]);
			if (deferFails) throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
		},
		async editReply(p) { calls.push(['editReply', p]); return {}; },
		async followUp(p) { calls.push(['followUp', p]); },
		async reply(p) { calls.push(['reply', p]); }
	};
}

function button(customId) {
	const calls = [];
	return {
		calls,
		customId,
		user: { id: ANA, username: 'Ana' },
		member: { id: ANA, voice: {} },
		guild: { id: G },
		guildId: G,
		channelId: '400000000000000001',
		channel: { id: '400000000000000001', name: 'books', async send(p) { calls.push(['channel.send', p]); } },
		message: { flags: { has: () => false } },
		isAutocomplete: () => false,
		isButton: () => true,
		async update(p) { calls.push(['update', p]); },
		async reply(p) { calls.push(['reply', p]); },
		async deferReply(p) { calls.push(['deferReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); }
	};
}

function deferOpts(i) {
	const hit = i.calls.find(c => c[0] === 'deferReply');
	assert.ok(hit, 'deferred');
	return hit[1];
}

test('/book defers privately except for the leaderboard', async () => {
	const shelf = chat('book', 'shelf');
	await dispatch(shelf);
	assert.deepStrictEqual(deferOpts(shelf), { flags: EPHEMERAL });
	const board = chat('book', 'leaderboard');
	await dispatch(board);
	assert.strictEqual(deferOpts(board), undefined, 'public');
});

test('/book still answers through the deferred reply', async () => {
	config.audiobooksEnabled = false;
	const i = chat('book', 'play');
	await dispatch(i);
	const replies = i.calls.filter(c => c[0] !== 'deferReply');
	assert.deepStrictEqual(replies.map(c => c[0]), ['editReply']);
	assert.match(replies[0][1].content, /Audiobooks are turned off/);
});

test('a failed defer explains itself publicly only for a public command', async () => {
	const priv = chat('book', 'shelf', { deferFails: true });
	await dispatch(priv);
	assert.ok(!priv.calls.some(c => c[0] === 'channel.send'), 'a private command gets no channel message');
	const pub = chat('book', 'leaderboard', { deferFails: true });
	await dispatch(pub);
	assert.strictEqual(pub.calls.filter(c => c[0] === 'channel.send').length, 1, 'the public one is explained in the channel');
});

test('/config keeps its plain ephemeral: true', async () => {
	const i = chat('config', null, { deferFails: true });
	await dispatch(i);
	assert.deepStrictEqual(deferOpts(i), { flags: EPHEMERAL });
	assert.ok(!i.calls.some(c => c[0] === 'channel.send'));
});

test('an ephemeral function that throws counts as public and the command still runs', async () => {
	let ran = 0;
	plexCommands.zzephemeralthrows = {
		slash: { description: 'test', ephemeral: () => { throw new Error('boom'); } },
		process: async (b, c, message) => { ran++; await message.reply('ok'); }
	};
	const i = chat('zzephemeralthrows', null);
	await dispatch(i);
	assert.strictEqual(deferOpts(i), undefined);
	assert.strictEqual(ran, 1);
});

test('book buttons are routed to the book handler, after the music card\'s', async () => {
	const stale = button('book:toggle:abcdef');
	await dispatch(stale);
	assert.deepStrictEqual(stale.calls.map(c => c[0]), ['update', 'followUp'], 'claimed by bookButtons: an unknown session is a stale card');
	assert.deepStrictEqual(stale.calls[0][1], { components: [] });
	const music = button('playback:nonsense');
	await dispatch(music);
	assert.deepStrictEqual(music.calls.map(c => c[0]), ['reply'], 'the music card handler still answers its own ids first');
	assert.match(music.calls[0][1].content, /Unknown playback action/);
});

test('the director is attached at module init', () => {
	assert.ok(bot.books && typeof bot.books.blocksMusic === 'function');
	assert.ok(client.listeners('voiceStateUpdate').length >= 1);
});

test('utils.stop shuts the books down before the music, and survives a throwing shutdown', () => {
	// The saves are synchronous and process.exit follows straight after; the queue is music's.
	const { stop } = require('../app/utils.js');
	for (const throws of [false, true]) {
		const order = [];
		const fake = {
			songQueue: ['a'],
			books: { shutdown() { order.push(['books', fake.songQueue.length]); if (throws) throw new Error('boom'); } },
			stop() { order.push(['stop']); },
			destroy() { order.push(['destroy']); }
		};
		stop(fake, { destroy() { order.push(['client']); } });
		assert.deepStrictEqual(order, [['books', 1], ['stop'], ['destroy'], ['client']]);
		assert.deepStrictEqual(fake.songQueue, []);
	}
});
