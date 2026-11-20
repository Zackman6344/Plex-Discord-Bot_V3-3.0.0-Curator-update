const test = require('node:test');
const assert = require('node:assert');
const logger = require('../helpers/logger.js');
const monitor = require('../helpers/archipelagoMonitor.js');

const client = { slotGames: new Map([[3, 'Plex Media'], [4, 'Clique']]) };

function captureWarn(fn) {
	const lines = [];
	const original = logger.warn;
	logger.warn = (...args) => lines.push(args.join(' '));
	try {
		fn();
	} finally {
		logger.warn = original;
	}
	return lines;
}

test('setGameDescriber refuses a game that is not a string and a describer with no function', () => {
	for (const game of [undefined, null, 5, {}]) {
		assert.throws(() => monitor.setGameDescriber(game, { next: () => null }), TypeError);
	}
	for (const describer of [undefined, null, {}, { next: 1 }, { hint: 'x' }]) {
		assert.throws(() => monitor.setGameDescriber('Plex Media', describer), TypeError);
	}
});

test('describe asks the slot\'s game for the kind it has, with the query as given', () => {
	const seen = [];
	const notes = new Map([[7, 'a note']]);
	const off = monitor.setGameDescriber('Plex Media', { next: query => { seen.push(query); return notes; } });
	try {
		const query = { watchId: 'w', seedName: 's', team: 0, slot: 'Zack', slotId: 3, ids: [7] };
		assert.strictEqual(monitor.describe(client, '3', 'next', query), notes);
		assert.deepStrictEqual(seen, [query]);
		const quiet = captureWarn(() => assert.strictEqual(monitor.describe(client, 3, 'hint', query), null));
		assert.deepStrictEqual(quiet, []);
		assert.strictEqual(monitor.describe(client, 4, 'next', query), null);
		assert.strictEqual(monitor.describe(client, 9, 'next', query), null);
		assert.strictEqual(monitor.describe({}, 3, 'next', query), null);
		assert.strictEqual(monitor.describe(null, 3, 'next', query), null);
		assert.strictEqual(seen.length, 1);
	} finally {
		off();
	}
	assert.strictEqual(monitor.describe(client, 3, 'next', {}), null);
});

test('a describer that throws logs one warn line and gives null', () => {
	const off = monitor.setGameDescriber('Plex Media', { next: () => { throw new Error('boom'); } });
	try {
		let answer;
		const lines = captureWarn(() => { answer = monitor.describe(client, 3, 'next', { ids: [] }); });
		assert.strictEqual(answer, null);
		assert.deepStrictEqual(lines, ['[AP] the Plex Media describer threw: boom']);
	} finally {
		off();
	}
});

test('the returned function removes only its own describer', () => {
	const offFirst = monitor.setGameDescriber('Plex Media', { next: () => 'first' });
	const offSecond = monitor.setGameDescriber('Plex Media', { next: () => 'second', hint: () => 'hinted' });
	try {
		offFirst();
		assert.strictEqual(monitor.describe(client, 3, 'next', {}), 'second');
		assert.strictEqual(monitor.describe(client, 3, 'hint', {}), 'hinted');
	} finally {
		offSecond();
	}
	assert.strictEqual(monitor.describe(client, 3, 'next', {}), null);
	offSecond();
	assert.strictEqual(monitor.describe(client, 3, 'next', {}), null);
});

const NAMES = new Map([[11, 'Loc 11'], [12, 'Loc 12'], [13, 'Loc 13']]);

function nextClient() {
	return {
		team: 0,
		seedName: 'S1',
		slotGames: new Map([[3, 'Plex Media'], [4, 'Clique']]),
		locationNames: new Map([['Plex Media', NAMES], ['Clique', NAMES]]),
		canonicalSlotName: name => ({ zack: 'Zack', cliq: 'Cliq' })[String(name).toLowerCase()] || null,
		slotIdFor: name => ({ Zack: 3, Cliq: 4 })[name]
	};
}

const WORKER_ANSWER = { verified: true, open: 3, locations: [[13, 2], [11, 1], [12, 1]] };

test('answerFromLogic asks describe once about every listed id and keeps the notes it has', () => {
	const calls = [];
	const long = 'x'.repeat(60);
	const found = new Map([[11, 'gap 10:00\u201318:47, heard to 43:37'], [12, ''], [13, long], [99, 'not listed']]);
	const resolved = { ok: true, slot: 'Zack', slotId: 3 };
	const out = monitor.answerFromLogic(nextClient(), resolved, WORKER_ANSWER, {
		describe: (r, ids) => { calls.push([r, ids]); return found; }
	});
	assert.deepStrictEqual(calls, [[resolved, [11, 12, 13]]]);
	assert.deepStrictEqual(out.notes, { 'Loc 11': 'gap 10:00\u201318:47, heard to 43:37', 'Loc 13': 'x'.repeat(48) });
	assert.deepStrictEqual(out.locations, ['Loc 11', 'Loc 12']);
});

test('answerFromLogic adds no notes key without a describe or a note', () => {
	const resolved = { ok: true, slot: 'Zack', slotId: 3 };
	const bare = monitor.answerFromLogic(nextClient(), resolved, WORKER_ANSWER);
	for (const answer of [null, new Map(), new Map([[11, '  ']]), { 11: 'not a Map' }, 'tag']) {
		const out = monitor.answerFromLogic(nextClient(), resolved, WORKER_ANSWER, { describe: () => answer });
		assert.strictEqual('notes' in out, false);
		assert.deepStrictEqual(out, bare);
	}
});

test('answerAll asks the slot\'s game describer with the watch, seed and slot', async () => {
	const seen = [];
	const off = monitor.setGameDescriber('Plex Media', { next: q => { seen.push(q); return new Map([[11, 'tag']]); } });
	try {
		const worker = { inLogic: async asked => asked.map(() => WORKER_ANSWER) };
		const prep = { ok: true, client: nextClient(), worker, state: { watch: { id: 7 } }, logic: { ok: true }, checkedIds: new Map(), receivedItems: new Map() };
		const out = await monitor.answerAll(prep, ['zack', 'cliq']);
		assert.deepStrictEqual(seen, [{ watchId: 7, seedName: 'S1', team: 0, slot: 'Zack', slotId: 3, ids: [11, 12, 13] }]);
		assert.deepStrictEqual(out.results[0].notes, { 'Loc 11': 'tag' });
		assert.strictEqual('notes' in out.results[1], false);

		seen.length = 0;
		const handMade = await monitor.answerAll({ ...prep, state: undefined }, ['Zack']);
		assert.strictEqual(seen[0].watchId, null);
		assert.deepStrictEqual(handMade.results[0].notes, { 'Loc 11': 'tag' });
	} finally {
		off();
	}
});

test('the sphere 1 fallback asks no describer and has no notes', async () => {
	let asked = 0;
	const off = monitor.setGameDescriber('Plex Media', { next: () => { asked += 1; return new Map([[11, 'tag']]); } });
	try {
		const prep = {
			ok: true,
			client: nextClient(),
			spheres: { source: 'multidata', slots: { 3: { 1: [11, 12], 2: [13] } } },
			logic: { ok: false },
			checkedIds: new Map(),
			receivedItems: new Map()
		};
		const out = await monitor.answerAll(prep, ['Zack']);
		assert.strictEqual(out.results[0].ok, true);
		assert.deepStrictEqual(out.results[0].locations, ['Loc 11', 'Loc 12']);
		assert.strictEqual('notes' in out.results[0], false);
		assert.strictEqual(asked, 0);
	} finally {
		off();
	}
});
