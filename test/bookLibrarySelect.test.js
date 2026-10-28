// app/music.js: the select-menu branch beside the button branch. Only book:lib:* menus are
// answered there and logged like a button click; every other menu belongs to a per-message
// collector (/config, buildcharacter) and must get no answer from the router, or the collector's
// own answer fails.
//
// Harness: test/slashEphemeral.test.js's, the real module wired to a fake client (an
// EventEmitter) and a fake bot, the interactionCreate listener called directly and awaited.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-book-library-select-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_BOOK_OVERRIDES_FILE = `${BASE}-overrides.json`;
process.env.PLEXBOT_TAGS_FILE = `${BASE}-tags.json`;

const config = require('../config/config.js');
const commandLog = require('../helpers/commandLog.js');
const music = require('../app/music.js');

const EPHEMERAL = 64;
const G = '200000000000000001';
const ANA = '100000000000000001';

const client = new EventEmitter();
client.user = { id: '100000000000000099', tag: 'bot#0001' };
const bot = { config, language: {}, songQueue: [] };
music(client, bot);
const dispatch = client.listeners('interactionCreate')[0];

test.after(() => {
	bot.books.shutdown();
	if (bot.readAlong) bot.readAlong.shutdown();
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
});

function select(customId, values) {
	const calls = [];
	return {
		calls,
		customId,
		values,
		user: { id: ANA, username: 'Ana' },
		member: { id: ANA, voice: {} },
		guild: { id: G },
		guildId: G,
		channelId: '400000000000000001',
		channel: { id: '400000000000000001', name: 'books' },
		message: { flags: { has: () => false } },
		isAutocomplete: () => false,
		isButton: () => false,
		isStringSelectMenu: () => true,
		isChatInputCommand: () => false,
		async update(p) { calls.push(['update', p]); },
		async reply(p) { calls.push(['reply', p]); },
		async deferUpdate() { calls.push(['deferUpdate']); },
		async followUp(p) { calls.push(['followUp', p]); }
	};
}

test('a library menu is answered by the library and logged as a select', async () => {
	const i = select('book:lib:open:deadbeef', ['0']);
	await dispatch(i);
	assert.strictEqual(i.calls.length, 1);
	assert.strictEqual(i.calls[0][0], 'reply');
	assert.match(i.calls[0][1].content, /^This list has expired\. Run `.book library` again\.$/);
	assert.strictEqual(i.calls[0][1].flags, EPHEMERAL);
	const logged = commandLog.readInvocations({ limit: 5 }).invocations.find(v => v.path === 'select');
	assert.ok(logged, 'logged');
	assert.strictEqual(logged.command, 'book:lib:open');
	assert.strictEqual(logged.args, 'book:lib:open:deadbeef 0');
	assert.strictEqual(logged.ok, true);
});

test('any other menu falls through unanswered, for its own collector', async () => {
	for (const id of ['config:pick', 'book:play:x', 'buildcharacter:class']) {
		const i = select(id, ['a']);
		await dispatch(i);
		assert.deepStrictEqual(i.calls, [], id);
	}
});
