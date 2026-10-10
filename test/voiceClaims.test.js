// helpers/voiceClaims.js, and Hitster's side of it in commands/hitster.js.
//
// The bug: a Hitster game and an audiobook both drive the one voice connection a guild allows.
// Without a shared answer to "who holds this guild's voice", a Hitster start during a book had
// every clip refused by the music gate turn after turn, and a book started during a game took the
// connection from under the clips. A claim kept as a flag would also outlive a game or a book that
// ended some unusual way, locking the other out until a restart.
//
// The registry part follows test/channelClaims.test.js. The Hitster part runs the real command's
// process() against a message-shaped object, with the shared Plex client's query held forever so
// a started game stays in 'playing' without contacting any server.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const pathMod = require('node:path');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-voiceclaims-' + process.pid);

const voiceClaims = require('../helpers/voiceClaims.js');

test('holder is null when nothing claims the guild', () => {
	voiceClaims.register('nobody', () => null);
	assert.strictEqual(voiceClaims.holder('g-empty'), null);
});

test('a claim follows the owner\'s live state', () => {
	const live = new Map([['g-live', 'Ana']]);
	voiceClaims.register('live-owner', (guildId) => live.get(guildId) || null);

	assert.deepStrictEqual(voiceClaims.holder('g-live'), { owner: 'live-owner', label: 'Ana' });
	assert.strictEqual(voiceClaims.holder('g-other'), null);

	live.delete('g-live');
	assert.strictEqual(voiceClaims.holder('g-live'), null);
});

test('ignore skips the caller\'s own claim and still finds another owner\'s', () => {
	voiceClaims.register('mine', (guildId) => (guildId === 'g-both' ? 'me' : null));
	voiceClaims.register('theirs', (guildId) => (guildId === 'g-both' ? 'them' : null));

	assert.deepStrictEqual(voiceClaims.holder('g-both', { ignore: ['mine'] }), { owner: 'theirs', label: 'them' });
	assert.strictEqual(voiceClaims.holder('g-both', { ignore: ['mine', 'theirs'] }), null);
});

test('a throwing predicate counts as free and does not hide a later claim', () => {
	voiceClaims.register('broken', () => { throw new Error('boom'); });
	voiceClaims.register('after-broken', (guildId) => (guildId === 'g-throw' ? 'held' : null));

	assert.deepStrictEqual(voiceClaims.holder('g-throw'), { owner: 'after-broken', label: 'held' });
	assert.strictEqual(voiceClaims.holder('g-throw-free'), null);
});

test('registering an owner again replaces its predicate', () => {
	// What !restart does: a new book director registers over the old one.
	voiceClaims.register('restarted', () => 'old session');
	voiceClaims.register('restarted', () => null);
	assert.strictEqual(voiceClaims.holder('g-restart'), null);
});

test('a missing guild id is never held', () => {
	voiceClaims.register('greedy', () => 'everything');
	assert.strictEqual(voiceClaims.holder(null), null);
	assert.strictEqual(voiceClaims.holder(undefined), null);
	voiceClaims.register('greedy', () => null);
});

// Hitster -------------------------------------------------------------------------------------

const { getPlex } = require('../helpers/plexClient.js');
getPlex().query = () => new Promise(() => {});
const hitster = require('../commands/hitster.js');

const book = new Map();
voiceClaims.register('audiobook', (guildId) => book.get(guildId) || null);

function hitsterMessage(guildId, channelId, userId = 'host-1') {
	const sent = [];
	const guild = { id: guildId };
	const voiceChannel = { id: 'vc-' + guildId, name: 'Lounge', guild, members: new Map([[userId, {}]]) };
	return {
		sent,
		message: {
			author: { id: userId },
			guild,
			member: { voice: { channel: voiceChannel }, permissions: { has: () => false } },
			channel: { id: channelId, async send(x) { sent.push(x); return {}; } },
			async reply(x) { sent.push(x); return {}; }
		}
	};
}

const text = (sent) => sent.map(x => (typeof x === 'string' ? x : x.content)).join('\n');

test('hitster create is refused while a book plays in the guild', async () => {
	book.set('g-h1', 'Ana');
	try {
		const { message, sent } = hitsterMessage('g-h1', 'tc-h1');
		await hitster.command.process({}, null, message, 'create');

		assert.match(text(sent), /📚 Ana is listening to a book in this server\. Hitster can start after `\/book stop`\./);
		assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] }, 'a display name cannot ping anyone');
		assert.doesNotMatch(text(sent), /HITSTER LOBBY/, 'no lobby is opened');
	} finally {
		book.delete('g-h1');
	}
});

test('hitster start is refused when a book began after the lobby opened', async () => {
	const { message, sent } = hitsterMessage('g-h2', 'tc-h2');
	await hitster.command.process({}, null, message, 'create');
	assert.match(text(sent), /HITSTER LOBBY/);

	book.set('g-h2', 'Ana');
	try {
		sent.length = 0;
		// Not awaited: a start that wrongly goes ahead waits on the held Plex query forever.
		hitster.command.process({}, null, message, 'start');
		await new Promise(r => setImmediate(r));
		assert.match(text(sent), /Ana is listening to a book/);
		assert.doesNotMatch(text(sent), /Starting!/);
		assert.strictEqual(voiceClaims.holder('g-h2', { ignore: ['audiobook'] }), null, 'the game is still a lobby, so it claims nothing');
	} finally {
		book.delete('g-h2');
	}
});

test('a started hitster game claims its guild\'s voice and a lobby does not', async () => {
	const { message, sent } = hitsterMessage('g-h3', 'tc-h3');
	await hitster.command.process({}, null, message, 'create');
	assert.strictEqual(voiceClaims.holder('g-h3', { ignore: ['audiobook'] }), null);

	// The held Plex query keeps the game in 'playing' with no turn dealt.
	hitster.command.process({}, null, message, 'start');
	assert.match(text(sent), /Starting!/);

	assert.deepStrictEqual(voiceClaims.holder('g-h3', { ignore: ['audiobook'] }), { owner: 'hitster', label: 'a Hitster game' });
	assert.strictEqual(voiceClaims.holder('g-h3', { ignore: ['hitster', 'audiobook'] }), null);
	assert.strictEqual(voiceClaims.holder('g-elsewhere', { ignore: ['audiobook'] }), null, 'only the game\'s own guild');
});
