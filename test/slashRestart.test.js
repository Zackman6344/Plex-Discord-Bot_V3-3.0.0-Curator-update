// app/music.js: a slash command whose deferReply is still in flight when !restart stops the client.
//
// The bug: the dispatcher awaited the defer and then ran the command with the old bot and client,
// after the restart had already ended every game. A /hitster start that straddled a restart opened
// a fresh lobby on the destroyed client, which nothing would end until the next restart.
//
// Harness: the real module wired to a fake client (an EventEmitter) and a fake bot, as in
// test/slashEphemeral.test.js; the interactionCreate listener is called directly and awaited, and
// the restart lands inside the fake interaction's deferReply.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-slash-restart-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_TAGS_FILE = `${BASE}-tags.json`;

const config = require('../config/config.js');
const plexCommands = require('../commands');
const music = require('../app/music.js');
const restartHandoff = require('../helpers/restartHandoff.js');

const client = new EventEmitter();
client.user = { id: '100000000000000099', tag: 'bot#0001' };
const bot = { config, language: {}, songQueue: [] };
music(client, bot);
const dispatch = client.listeners('interactionCreate')[0];

test.after(() => {
	delete plexCommands.zzrestart;
	bot.books.shutdown();
	if (bot.readAlong) bot.readAlong.shutdown();
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
});

function interaction({ restartDuringDefer }) {
	const calls = [];
	return {
		calls,
		commandName: 'zzrestart',
		user: { id: '100000000000000001', username: 'Ana' },
		member: { id: '100000000000000001', voice: {} },
		guild: { id: '200000000000000001' },
		guildId: '200000000000000001',
		channelId: '400000000000000001',
		client: {},
		channel: { id: '400000000000000001', name: 'games', async send(p) { calls.push(['channel.send', p]); } },
		isAutocomplete: () => false,
		isButton: () => false,
		isChatInputCommand: () => true,
		options: { data: [], getSubcommand: () => null, get: () => null, getUser: () => null },
		async deferReply(opts) {
			calls.push(['deferReply', opts]);
			if (restartDuringDefer) restartHandoff.endAll(client);
		},
		async editReply(p) { calls.push(['editReply', p]); return {}; },
		async followUp(p) { calls.push(['followUp', p]); },
		async reply(p) { calls.push(['reply', p]); }
	};
}

test('a command whose defer straddles a restart does not run, and says the bot is restarting', async () => {
	let ran = 0;
	plexCommands.zzrestart = {
		slash: { description: 'test' },
		process: async () => { ran++; }
	};

	const before = interaction({ restartDuringDefer: false });
	await dispatch(before);
	assert.strictEqual(ran, 1, 'runs normally before the restart');

	const straddling = interaction({ restartDuringDefer: true });
	await dispatch(straddling);
	assert.strictEqual(ran, 1, 'not run on the stopped client');
	const reply = straddling.calls.find((c) => c[0] === 'editReply');
	assert.ok(reply, 'the deferred reply is answered');
	assert.match(String(reply[1]), /restarting/);
});
