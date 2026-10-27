// The collector games after !restart (trivia, badplot, castingcouch, reviewbomb, rumor and
// quotethebard), through helpers/restartHandoff.js.
//
// The bug: a round's collector and clue timers belonged to the client !restart destroys. No guess
// reached the round again, every clue and the final reveal failed with "Expected token to be set",
// and the points were only saved by a reveal that ran minutes later against a dead client.
//
// Harness: the real command modules with Plex, Gemini and the clue cache swapped in require.cache,
// a fake channel whose collector ends on a mocked timer like discord.js's, and leaderboard files
// kept in memory so no test writes the real data/ files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');

const MOVIE = {
	title: 'Restart Probe Film', year: 2001, summary: 'A film made for a test.', type: 'movie',
	key: '/library/metadata/1', ratingKey: '1',
	Role: [{ tag: 'Actor A', role: 'One' }, { tag: 'Actor B', role: 'Two' }, { tag: 'Actor C', role: 'Three' }]
};
const TRACK = { title: 'Restart Probe Song', grandparentTitle: 'Probe Band', type: 'track', ratingKey: '2' };
const CLUES = {
	clue1: 'first', clue2: 'second', clue3: 'third',
	sentence1: 'first', sentence2: 'second', sentence3: 'third'
};
const SONG = {
	title: TRACK.title, artist: 'Probe Band', original_lyrics: 'la la la', lyrics: 'fa la la',
	clue2: 'second', clue3: 'third', clue4: 'fourth', clue5: 'fifth'
};

function stub(rel, exports) {
	const file = require.resolve(path.join(ROOT, rel));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('helpers/plexClient.js', {
	getPlex: () => ({
		async query(p) {
			if (p === '/library/sections') {
				return { MediaContainer: { Directory: [{ type: 'movie', key: '1', title: 'Movies' }, { type: 'artist', key: '2', title: 'Music' }] } };
			}
			if (p.startsWith('/library/sections/1/all')) return { MediaContainer: { Metadata: [MOVIE] } };
			if (p.startsWith('/library/sections/2/all')) return { MediaContainer: { Metadata: [TRACK] } };
			throw new Error(`unexpected Plex query ${p}`);
		}
	})
});
stub('helpers/geminiAPI.js', {
	DEFAULT_MODEL: 'test-model',
	getModel: () => ({ generateContent: async () => ({ response: { text: () => JSON.stringify(SONG) } }) })
});
stub('helpers/clueCache.js', { getOrGenerate: async () => CLUES });

// Leaderboards live at fixed paths under data/; these keep them in memory.
const boards = new Map();
const isBoard = (p) => typeof p === 'string' && /_leaderboard\.json$/.test(p);
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p, ...rest) => (isBoard(p) ? boards.has(p) : realFs.existsSync(p, ...rest));
fs.readFileSync = (p, ...rest) => (isBoard(p) ? boards.get(p) : realFs.readFileSync(p, ...rest));
fs.writeFileSync = (p, data, ...rest) => (isBoard(p) ? void boards.set(p, data) : realFs.writeFileSync(p, data, ...rest));
test.after(() => Object.assign(fs, realFs));

const restartHandoff = require('../helpers/restartHandoff.js');

const GAMES = [
	{ name: 'trivia', args: [], answer: MOVIE.title, time: 180000 },
	{ name: 'badplot', args: [], answer: MOVIE.title, time: 180000 },
	{ name: 'castingcouch', args: [], answer: MOVIE.title, time: 180000 },
	{ name: 'reviewbomb', args: [], answer: MOVIE.title, time: 180000 },
	{ name: 'rumor', args: [], answer: MOVIE.title, time: 180000 },
	{ name: 'quotethebard', args: ['start'], answer: TRACK.title, time: 300000 }
];

class FakeCollector extends EventEmitter {
	constructor({ time }, client) {
		super();
		this.client = client;
		this.ended = false;
		this.reason = null;
		this.timer = setTimeout(() => this.stop('time'), time);
	}
	stop(reason = 'user') {
		if (this.ended) return;
		this.ended = true;
		this.reason = reason;
		clearTimeout(this.timer);
		this.emit('end', new Map(), reason);
	}
}

function fakeChannel(id, client) {
	const channel = {
		id,
		client,
		sent: [],
		collectors: [],
		async send(payload) {
			channel.sent.push(payload);
			return { edit: async () => {}, delete: async () => {} };
		},
		createMessageCollector(options) {
			const collector = new FakeCollector(options, channel.client);
			channel.collectors.push(collector);
			return collector;
		}
	};
	return channel;
}

function clientWith(channel) {
	return { channels: { fetch: async (id) => (id === channel.id ? channel : null) } };
}

async function play(game, channel) {
	const msg = { channel, author: { id: 'host', username: 'host', bot: false } };
	await require(`../commands/${game.name}.js`).command.process(msg, ...game.args);
	assert.strictEqual(channel.collectors.length, 1, `${game.name} started a round`);
	return channel.collectors[0];
}

function guess(content) {
	return { content, author: { id: 'u1', username: 'alice', bot: false }, delete: async () => {} };
}

test.beforeEach(() => boards.clear());

for (const game of GAMES) {
	test(`${game.name}: a round running at !restart ends, keeps its points, and is revealed by the new client`, async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const channel = fakeChannel(`C-${game.name}`);
		const collector = await play(game, channel);
		collector.emit('collect', guess(game.answer));
		const sentBefore = channel.sent.length;

		restartHandoff.endAll();
		t.mock.timers.tick(10 * 60 * 1000);

		assert.strictEqual(channel.sent.length, sentBefore, 'no clue or reveal went through the old client');
		const written = [...boards.values()];
		assert.strictEqual(written.length, 1, 'the leaderboard was saved at the restart');
		assert.strictEqual(JSON.parse(written[0]).u1.score, 1);

		const fresh = fakeChannel(channel.id);
		await restartHandoff.deliver(clientWith(fresh));
		assert.strictEqual(fresh.sent.length, 1);
		assert.match(fresh.sent[0], /THE BOT RESTARTED/);
		assert.ok(fresh.sent[0].includes(game.answer), 'the answer is revealed');
		assert.match(fresh.sent[0], /alice/);

		restartHandoff.endAll();
		await restartHandoff.deliver(clientWith(fresh));
		assert.strictEqual(fresh.sent.length, 1, 'ended once, revealed once');
	});

	test(`${game.name}: a round that runs out is revealed as before and leaves nothing for a restart`, async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const channel = fakeChannel(`C-${game.name}-time`);
		await play(game, channel);

		t.mock.timers.tick(game.time);
		assert.match(channel.sent[channel.sent.length - 1], /TIME'S UP/);
		assert.ok(channel.sent[channel.sent.length - 1].includes(game.answer));

		restartHandoff.endAll();
		const fresh = fakeChannel(channel.id);
		await restartHandoff.deliver(clientWith(fresh));
		assert.deepStrictEqual(fresh.sent, []);
	});
}

// A round still setting up (waiting on Plex, Gemini or the clue cache) when the restart lands
// creates its collector afterwards, on the old client, where nothing would ever end it.
test('a round whose setup finishes after the restart ends at once, and the new client reveals it', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const oldClient = { name: 'old' };
	const channel = fakeChannel('C-late', oldClient);
	const playing = play(GAMES[0], channel);
	restartHandoff.endAll(oldClient);
	const collector = await playing;
	await new Promise((resolve) => setImmediate(resolve));

	assert.strictEqual(collector.reason, restartHandoff.REASON, 'ended as a restart');
	const sentAtEnd = channel.sent.length;
	t.mock.timers.tick(10 * 60 * 1000);
	assert.strictEqual(channel.sent.length, sentAtEnd, 'no clue went through the old client');

	const fresh = fakeChannel(channel.id);
	await restartHandoff.deliver(clientWith(fresh));
	assert.strictEqual(fresh.sent.length, 1);
	assert.match(fresh.sent[0], /THE BOT RESTARTED/);
	assert.ok(fresh.sent[0].includes(MOVIE.title));
});

test('once the new client is ready, a late round is revealed through it straight away', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const oldClient = { name: 'old' };
	const fresh = fakeChannel('C-late-ready');
	const playing = play(GAMES[0], fakeChannel(fresh.id, oldClient));
	restartHandoff.endAll(oldClient);
	await restartHandoff.deliver(clientWith(fresh));
	assert.deepStrictEqual(fresh.sent, [], 'nothing was queued yet');

	await playing;
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(fresh.sent.length, 1, 'posted without waiting for another restart');
	assert.match(fresh.sent[0], /THE BOT RESTARTED/);
});
