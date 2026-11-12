// app/music.js: /apmedia through the real dispatcher, and its buttons through the real router.
//
// What has to hold: the dispatcher defers /apmedia privately for every subcommand but apworld, so
// the first reply already lands where nobody else sees it; an apmedia:page: or apmedia:consent:
// click is answered by helpers/apMediaButtons.js after the !ap next pages and before tagInference,
// and a click that is not one of its own goes on to the next handler as before.
//
// Harness: the real module wired to a fake client (an EventEmitter) and a fake bot, as
// test/slashEphemeral.test.js wires them; the interactionCreate listener is called directly and
// awaited, with recording fake interactions. apMediaEnabled stays off, so /apmedia answers that it
// is off without reaching the game; temp files for the stores music.js opens.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { EventEmitter } = require('node:events');

const BASE = pathMod.join(os.tmpdir(), `plexbot-test-apmedia-router-${process.pid}`);
process.env.PLEXBOT_LOG_DIR = `${BASE}-logs`;
process.env.PLEXBOT_BOOK_BOOKMARKS_FILE = `${BASE}-bookmarks.json`;
process.env.PLEXBOT_BOOK_CATALOG_FILE = `${BASE}-catalog.json`;
process.env.PLEXBOT_TAGS_FILE = `${BASE}-tags.json`;

const config = require('../config/config.js');
const music = require('../app/music.js');
const apmedia = require('../commands/apmedia.js');

const EPHEMERAL = 64;
const G = '200000000000000001';
const ANA = '100000000000000001';

const client = new EventEmitter();
client.user = { id: '100000000000000099', tag: 'bot#0001' };
const bot = { config, language: {}, songQueue: [] };
music(client, bot);
const dispatch = client.listeners('interactionCreate')[0];

const saved = config.apMediaEnabled;
test.beforeEach(() => { config.apMediaEnabled = false; });
test.afterEach(() => { config.apMediaEnabled = saved; });
test.after(() => {
	bot.books.shutdown();
	if (bot.readAlong) bot.readAlong.shutdown();
	for (const f of fs.readdirSync(os.tmpdir())) {
		if (f.startsWith(pathMod.basename(BASE))) {
			try { fs.rmSync(pathMod.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (_) {}
		}
	}
});

function chat(sub) {
	const calls = [];
	return {
		calls,
		commandName: 'apmedia',
		user: { id: ANA, username: 'Ana' },
		member: { id: ANA, voice: {} },
		guild: { id: G },
		guildId: G,
		channelId: '400000000000000001',
		client: {},
		channel: { id: '400000000000000001', name: 'media', async send(p) { calls.push(['channel.send', p]); } },
		isAutocomplete: () => false,
		isButton: () => false,
		isChatInputCommand: () => true,
		options: { data: [], getSubcommand: () => sub, get: () => null, getUser: () => null },
		async deferReply(opts) { calls.push(['deferReply', opts]); },
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
		channel: { id: '400000000000000001', name: 'media', async send(p) { calls.push(['channel.send', p]); } },
		message: { flags: { has: () => false } },
		isAutocomplete: () => false,
		isButton: () => true,
		async update(p) { calls.push(['update', p]); },
		async reply(p) { calls.push(['reply', p]); },
		async deferReply(p) { calls.push(['deferReply', p]); },
		async deferUpdate() { calls.push(['deferUpdate']); },
		async editReply(p) { calls.push(['editReply', p]); },
		async followUp(p) { calls.push(['followUp', p]); }
	};
}

test('/apmedia defers privately for every subcommand but apworld', async () => {
	for (const { name } of apmedia._internal.SUBCOMMANDS) {
		const i = chat(name);
		await dispatch(i);
		const defer = i.calls.find((c) => c[0] === 'deferReply');
		assert.ok(defer, name);
		assert.deepStrictEqual(defer[1], name === 'apworld' ? undefined : { flags: EPHEMERAL }, name);
		const answers = i.calls.filter((c) => c[0] !== 'deferReply');
		assert.deepStrictEqual(answers.map((c) => c[0]), ['editReply'], `${name}: one answer, through the defer`);
		assert.match(answers[0][1].content, /Plex Media is turned off/);
		assert.deepStrictEqual(answers[0][1].allowedMentions, { parse: [] });
	}
});

test('apmedia page and consent clicks are answered by their own handler, never left unanswered', async () => {
	const page = button('apmedia:page:gone:1');
	await dispatch(page);
	assert.deepStrictEqual(page.calls.map((c) => c[0]), ['reply']);
	assert.deepStrictEqual(page.calls[0][1], { content: 'This list has expired. Ask for it again to see it as it is now.', flags: EPHEMERAL, allowedMentions: { parse: [] } });
	const consent = button('apmedia:consent:not-a-token');
	await dispatch(consent);
	assert.deepStrictEqual(consent.calls.map((c) => c[0]), ['reply']);
	assert.match(consent.calls[0][1].content, /not one the bot can read/);
	const someoneElse = button(`apmedia:consent:100000000000000002.${(1791500000000).toString(36)}`);
	await dispatch(someoneElse);
	assert.deepStrictEqual(someoneElse.calls.map((c) => [c[0], c[1].flags]), [['reply', EPHEMERAL]]);
});

test('the !ap next pages still answer first, and their ids are not taken for apmedia ones', async () => {
	const next = button('apnext:gone:1');
	await dispatch(next);
	assert.deepStrictEqual(next.calls.map((c) => c[0]), ['reply']);
	assert.match(next.calls[0][1].content, /Ask for it again to see what is in logic now/, 'answered by archipelagoNextButtons');
});
