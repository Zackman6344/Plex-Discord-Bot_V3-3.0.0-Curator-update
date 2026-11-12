// helpers/apMediaStore.js: Plex Media's slot bindings, Plex account links, history marks and the
// per-seed slot_data cache.
//
// The bug: a binding store that loses banked checks to a torn write, writes a room password into
// a second file (at any depth of a record), binds a snowflake that lost digits in Number() to
// somebody else, lets a caller's edit of a returned record leak to disk, resets a field a patch
// passed as undefined (banked checks, spent Wild Tickets, a consent), or rewrites the marks file on
// every history poll; and a slot_data cache that writes into the live data folder from a test,
// calls a damaged copy held so the Connect does not ask the server for slot_data, lets a
// server-supplied seed or slot name walk out of its folder (`..`, `C:`, `CON.x`), or keeps a seed's
// files after its last binding is gone.
//
// Harness: every case builds its own stores with createApMediaStore() over files in one
// os.tmpdir() folder; the env vars are set around the call because jsonStore reads them when a
// store is created. fs reads and writes are counted with t.mock.method passing through to the real
// fs, the clock is injected, and logger.warn is muted where a warning is the point. Two cases hand
// these stores to the real apMediaWatch and to an ApMediaClient that never opens a socket.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `plexbot-test-apmedia-store-${process.pid}-`));
const ENV = ['PLEXBOT_APMEDIA_SLOTS_FILE', 'PLEXBOT_APMEDIA_ACCOUNTS_FILE', 'PLEXBOT_APMEDIA_MARKS_FILE', 'PLEXBOT_APMEDIA_CACHE_DIR'];
process.env.PLEXBOT_APMEDIA_SLOTS_FILE = path.join(TMP, 'shared', 'apmedia_slots.json');
process.env.PLEXBOT_APMEDIA_ACCOUNTS_FILE = path.join(TMP, 'shared', 'apmedia_accounts.json');
process.env.PLEXBOT_APMEDIA_MARKS_FILE = path.join(TMP, 'shared', 'apmedia_marks.json');
process.env.PLEXBOT_APMEDIA_CACHE_DIR = path.join(TMP, 'shared', 'cache');

const logger = require('../helpers/logger.js');
const apStore = require('../helpers/apMediaStore.js');

const HOUR = 60 * 60 * 1000;
const ZACK = '100000000000000001';
const OWNER = '100000000000000009';
const SLOT_DATA = { schema: 1, game: 'Plex Media', generated_at: 1731300000, entries: [{ k: 'movie', id: 'rk:1' }] };

test.after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

let cases = 0;

function make({ now, env = {} } = {}) {
	cases += 1;
	const dir = path.join(TMP, `case-${cases}`);
	const paths = {
		PLEXBOT_APMEDIA_SLOTS_FILE: path.join(dir, 'apmedia_slots.json'),
		PLEXBOT_APMEDIA_ACCOUNTS_FILE: path.join(dir, 'apmedia_accounts.json'),
		PLEXBOT_APMEDIA_MARKS_FILE: path.join(dir, 'apmedia_marks.json'),
		PLEXBOT_APMEDIA_CACHE_DIR: path.join(dir, 'cache'),
		...env,
	};
	const saved = Object.fromEntries(ENV.concat('NODE_TEST_CONTEXT').map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(paths)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return { store: apStore.createApMediaStore({ now }), dir, paths };
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

function clock(start = Date.UTC(2026, 10, 11, 12)) {
	const c = { t: start, now: () => c.t };
	return c;
}

function binding(over = {}) {
	return { watchId: 0, slot: 'Zack', userId: ZACK, boundBy: OWNER, ...over };
}

function renames(t, file) {
	const real = fs.renameSync;
	const mock = t.mock.method(fs, 'renameSync', (from, to) => real(from, to));
	return () => mock.mock.calls.filter((call) => path.resolve(String(call.arguments[1])) === path.resolve(file)).length;
}

function quiet(t) {
	const lines = [];
	t.mock.method(logger, 'warn', (...args) => { lines.push(args.join(' ')); });
	t.mock.method(logger, 'error', (...args) => { lines.push(args.join(' ')); });
	return lines;
}

// --- bindings -------------------------------------------------------------------------------------

test('the shared stores use the env paths set before the first require', () => {
	assert.strictEqual(apStore.bindings.file, process.env.PLEXBOT_APMEDIA_SLOTS_FILE);
	assert.strictEqual(apStore.accounts.file, process.env.PLEXBOT_APMEDIA_ACCOUNTS_FILE);
	assert.strictEqual(apStore.marks.file, process.env.PLEXBOT_APMEDIA_MARKS_FILE);
	assert.strictEqual(apStore.cache.dir, process.env.PLEXBOT_APMEDIA_CACHE_DIR);
	assert.strictEqual(apStore.cache.memoryOnly, false);
});

test('a new binding gets every default and is keyed by watch and lower-cased slot', () => {
	const c = clock();
	const { store } = make({ now: c.now });
	const b = store.bindings.put(binding({ slot: ' Zack ', watchId: '2' }));
	assert.deepStrictEqual(b, {
		key: '2::zack', watchId: 2, slot: 'Zack', userId: ZACK, boundAt: c.t, boundBy: OWNER, seedName: null,
		state: 'active', stateDetail: null, pending: [], banked: [], redeemed: [], wildUsed: 0,
		goalSent: false, announce: true, welcomed: false, lastCredit: null, lastTarget: null,
	});
	assert.strictEqual(apStore.bindingKey(2, 'ZACK'), '2::zack');
	assert.deepStrictEqual(store.bindings.find(2, 'zack'), b);
	assert.deepStrictEqual(store.bindings.get('2::zack'), b);
	assert.deepStrictEqual(store.bindings.list(), [b]);
	assert.strictEqual(store.bindings.get('2::nobody'), null);
	assert.strictEqual(store.bindings.find(-1, 'Zack'), null);
});

test('put refuses a binding nothing could use', () => {
	const { store } = make();
	assert.throws(() => store.bindings.put(binding({ userId: undefined })), /Discord user id/);
	assert.throws(() => store.bindings.put(binding({ userId: 'zack' })), /Discord user id/);
	assert.throws(() => store.bindings.put(binding({ slot: '  ' })), /slot name/);
	assert.throws(() => store.bindings.put(binding({ watchId: -1 })), /watch id/);
	assert.throws(() => store.bindings.put(binding({ watchId: null })), /watch id/);
	assert.throws(() => store.bindings.put(binding({ state: 'lost' })), /active, stale, refused, orphaned/);
	assert.throws(() => store.bindings.put(null), TypeError);
	assert.deepStrictEqual(store.bindings.list(), []);
});

test('id lists are deduped numbers and redeemed keys deduped strings, whatever the caller hands in', () => {
	const { store } = make();
	const b = store.bindings.put(binding({
		pending: new Set([1347000005, '1347000006', 1347000005, 'x', -3, null]),
		banked: [1347000007, 1347000007],
		redeemed: ['movie|rk:1', 'movie|rk:1', '', 'album|plex://album/2'],
		wildUsed: '2',
	}));
	assert.deepStrictEqual(b.pending, [1347000005, 1347000006]);
	assert.deepStrictEqual(b.banked, [1347000007]);
	assert.deepStrictEqual(b.redeemed, ['movie|rk:1', 'album|plex://album/2']);
	assert.strictEqual(b.wildUsed, 2);
});

test('a record handed out is a copy: editing it changes nothing until it is written back', () => {
	const { store } = make();
	const b = store.bindings.put(binding());
	b.pending.push(1347000001);
	b.state = 'stale';
	const again = store.bindings.get(b.key);
	again.banked.push(1347000002);
	assert.deepStrictEqual(store.bindings.get(b.key).pending, []);
	assert.deepStrictEqual(store.bindings.get(b.key).banked, []);
	assert.strictEqual(store.bindings.get(b.key).state, 'active');
});

test('patch merges, writes only when something changed, and returns the stored record', (t) => {
	const { store, paths } = make();
	const count = renames(t, paths.PLEXBOT_APMEDIA_SLOTS_FILE);
	const b = store.bindings.put(binding());
	assert.strictEqual(count(), 1);
	const patched = store.bindings.patch(b.key, { pending: [1347000003], lastCredit: { at: 5, title: 'Alien' } });
	assert.deepStrictEqual(patched.pending, [1347000003]);
	assert.deepStrictEqual(patched.lastCredit, { at: 5, title: 'Alien' });
	assert.strictEqual(count(), 2);
	store.bindings.patch(b.key, { pending: [1347000003] });
	store.bindings.put({ ...patched });
	assert.strictEqual(count(), 2);
	assert.strictEqual(store.bindings.patch('9::nobody', { state: 'stale' }), null);
	assert.throws(() => store.bindings.patch(b.key, { state: 'gone' }), TypeError);
	assert.strictEqual(store.bindings.get(b.key).state, 'active');
});

test('a patch leaves alone every field it passes as undefined, and writes nothing for it', (t) => {
	const { store, paths } = make();
	const count = renames(t, paths.PLEXBOT_APMEDIA_SLOTS_FILE);
	const b = store.bindings.put(binding({
		boundAt: 7, seedName: 'S1', state: 'refused', stateDetail: { reason: 'InvalidSlot' }, pending: [1347000006],
		banked: [1347000005], redeemed: ['movie|rk:1'], wildUsed: 2, goalSent: true, announce: false, welcomed: true,
		lastCredit: { at: 5, title: 'Alien' }, lastTarget: { target: { kind: 'room' }, hasPassword: true },
	}));
	assert.ok(store.cache.write('S1', 'Zack', SLOT_DATA));
	assert.strictEqual(count(), 1);
	const blank = Object.fromEntries(Object.keys(b).map((k) => [k, undefined]));
	assert.deepStrictEqual(store.bindings.patch(b.key, blank), b);
	assert.deepStrictEqual(store.bindings.get(b.key), b);
	assert.strictEqual(count(), 1);
	assert.ok(store.cache.has('S1', 'Zack'), 'the seed\'s slot_data stays with its binding');
	const next = store.bindings.patch(b.key, { banked: undefined, pending: [1347000007] });
	assert.deepStrictEqual([next.banked, next.pending, next.wildUsed, next.state], [[1347000005], [1347000007], 2, 'refused']);
	assert.throws(() => store.bindings.patch(b.key, 'banked'), /must be an object/);
	assert.throws(() => store.bindings.patch(b.key, [1347000008]), /must be an object/);
	assert.deepStrictEqual(store.bindings.get(b.key).pending, [1347000007]);
});

test('a patch may fix a slot\'s case but cannot move a binding to another slot or watch', () => {
	const { store } = make();
	const b = store.bindings.put(binding({ slot: 'zack' }));
	assert.strictEqual(store.bindings.patch(b.key, { slot: 'Zack' }).slot, 'Zack');
	assert.throws(() => store.bindings.patch(b.key, { slot: 'Other' }), /another watch or slot/);
	assert.throws(() => store.bindings.patch(b.key, { watchId: 1 }), /another watch or slot/);
	assert.deepStrictEqual(store.bindings.list().map((x) => x.key), ['0::zack']);
});

test('bindings survive a restart, and their file is durable with an hourly backup', () => {
	const c = clock();
	const { store, paths } = make({ now: c.now });
	const b = store.bindings.put(binding({ banked: [1347000009], seedName: '123' }));
	c.t += 2 * HOUR;
	store.bindings.patch(b.key, { pending: [1347000010] });
	assert.ok(fs.existsSync(`${paths.PLEXBOT_APMEDIA_SLOTS_FILE}.bak`), 'the second write after an hour keeps a .bak');
	store.reset();
	const back = store.bindings.get(b.key);
	assert.deepStrictEqual([back.banked, back.pending, back.seedName], [[1347000009], [1347000010], '123']);
	const reopened = make({ now: c.now, env: { PLEXBOT_APMEDIA_SLOTS_FILE: paths.PLEXBOT_APMEDIA_SLOTS_FILE } }).store;
	assert.deepStrictEqual(reopened.bindings.get(b.key), back);
});

test('no password, token or secret reaches the bindings or accounts file, however deep it sits', () => {
	const { store, paths } = make();
	const b = store.bindings.put(binding({
		password: 'hunter2',
		apiToken: 'tok-123',
		lastTarget: {
			target: { kind: 'room', roomUrl: 'https://archipelago.gg/room/abc', password: 'hunter2', room: { port: 38281, password: 'hunter4' } },
			hasPassword: 'yes',
			password: 'hunter2',
		},
		stateDetail: { reason: 'InvalidPassword', errors: ['InvalidPassword'], password: 'hunter2', packet: { cmd: 'ConnectionRefused', password: 'hunter5' } },
		note: 'kept',
		conn: { auth: { user: 'zack', password: 'hunter3' }, tries: [{ at: 1, token: 'tok-456' }, [{ secretKey: 'tok-789' }]] },
	}));
	assert.deepStrictEqual(b.lastTarget, { target: { kind: 'room', roomUrl: 'https://archipelago.gg/room/abc', room: { port: 38281 } }, hasPassword: true });
	assert.deepStrictEqual(b.stateDetail, { reason: 'InvalidPassword', errors: ['InvalidPassword'], packet: { cmd: 'ConnectionRefused' } });
	assert.deepStrictEqual(b.conn, { auth: { user: 'zack' }, tries: [{ at: 1 }, [{}]] });
	assert.strictEqual(b.note, 'kept');
	assert.strictEqual(b.password, undefined);
	const text = fs.readFileSync(paths.PLEXBOT_APMEDIA_SLOTS_FILE, 'utf8');
	assert.ok(!text.includes('hunter') && !text.includes('tok-'), text);

	assert.deepStrictEqual(store.accounts.set(ZACK, { accountId: 7, plex: { user: 'zack', authToken: 'tok-999' } }).plex, { user: 'zack' });
	assert.ok(!fs.readFileSync(paths.PLEXBOT_APMEDIA_ACCOUNTS_FILE, 'utf8').includes('tok-999'));
});

test('a Discord id passed as a number counts only while it is exact: a rounded snowflake names somebody else', () => {
	const { store } = make();
	const rounded = Number(ZACK);
	assert.notStrictEqual(String(rounded), ZACK, 'the snowflake lost digits on its way through Number()');
	assert.throws(() => store.bindings.put(binding({ userId: rounded })), { name: 'TypeError', message: /Discord user id must be a string of digits/ });
	assert.throws(() => store.accounts.set(rounded, { accountId: 2 }), TypeError);
	assert.throws(() => store.accounts.get(rounded), TypeError, 'a lookup would read somebody else\'s link');
	for (const bad of [NaN, Infinity, 1.5]) assert.throws(() => store.bindings.put(binding({ userId: bad })), TypeError, String(bad));
	assert.deepStrictEqual(store.bindings.list(), []);
	assert.deepStrictEqual(store.accounts.list(), []);

	assert.strictEqual(store.bindings.put(binding({ userId: 42 })).userId, '42', 'a number that is still exact is fine');
	assert.strictEqual(store.accounts.set(42, { accountId: 2 }).userId, '42');
	assert.strictEqual(store.accounts.get(42).accountId, 2);
	assert.strictEqual(store.bindings.put(binding({ slot: 'Ann', userId: ` ${ZACK} ` })).userId, ZACK);
});

test('a hand-edited bindings file is repaired on read, and a record nothing could use is dropped', (t) => {
	const lines = quiet(t);
	const { store, paths } = make();
	fs.mkdirSync(path.dirname(paths.PLEXBOT_APMEDIA_SLOTS_FILE), { recursive: true });
	fs.writeFileSync(paths.PLEXBOT_APMEDIA_SLOTS_FILE, JSON.stringify({
		bindings: {
			'0::zack': { watchId: 0, slot: 'Zack', userId: ZACK, boundAt: 1, pending: ['1347000001', 1347000001], state: 'active' },
			'odd key': { watchId: 1, slot: 'Ann', userId: ZACK, boundAt: 2 },
			'0::bad': { watchId: 0, slot: 'Bad', userId: 'nobody' },
			'0::rounded': { watchId: 0, slot: 'Rounded', userId: Number(ZACK) },
		},
	}));
	assert.deepStrictEqual(store.bindings.list().map((b) => [b.key, b.pending]), [['0::zack', [1347000001]], ['1::ann', []]]);
	assert.strictEqual(lines.filter((l) => l.includes('dropped an unusable slot binding')).length, 2, lines.join('\n'));
});

// --- the seed cache follows its bindings ---------------------------------------------------------

test('a seed\'s cached slot_data goes when its last binding does, and stays while another holds it', () => {
	const { store } = make();
	const a = store.bindings.put(binding({ slot: 'Zack', seedName: 'S1' }));
	const b = store.bindings.put(binding({ slot: 'Ann', seedName: 'S1' }));
	assert.ok(store.cache.write('S1', 'Zack', SLOT_DATA));
	assert.ok(store.cache.write('S1', 'Ann', SLOT_DATA));
	const seedDir = path.dirname(store.cache.fileFor('S1', 'Zack'));
	store.bindings.remove(a.key);
	assert.ok(fs.existsSync(seedDir));
	assert.ok(store.cache.has('S1', 'Ann'));
	assert.deepStrictEqual(store.bindings.remove(b.key).slot, 'Ann');
	assert.ok(!fs.existsSync(seedDir));
	assert.strictEqual(store.cache.has('S1', 'Ann'), false);
	assert.strictEqual(store.bindings.remove(b.key), null);
});

test('moving a binding to a new seed drops the old seed\'s cache', () => {
	const { store } = make();
	const b = store.bindings.put(binding({ seedName: 'OLD' }));
	store.cache.write('OLD', 'Zack', SLOT_DATA);
	store.bindings.patch(b.key, { state: 'stale' });
	assert.ok(store.cache.has('OLD', 'Zack'), 'a stale binding keeps its seed until it moves');
	store.bindings.patch(b.key, { seedName: 'NEW', state: 'active' });
	assert.strictEqual(store.cache.has('OLD', 'Zack'), false);
});

// --- accounts -------------------------------------------------------------------------------------

test('an account link starts pending; consent stamps the time; the owner can be granted at once', () => {
	const c = clock();
	const { store } = make({ now: c.now });
	const link = store.accounts.set(ZACK, { accountId: '12345678', name: ' Zack\nM ', linkedBy: OWNER });
	assert.deepStrictEqual(link, { userId: ZACK, accountId: 12345678, name: 'Zack M', linkedAt: c.t, linkedBy: OWNER, consent: 'pending', consentAt: null });
	c.t += 1000;
	const granted = store.accounts.patch(ZACK, { consent: 'granted' });
	assert.deepStrictEqual([granted.consent, granted.consentAt, granted.linkedAt], ['granted', c.t, c.t - 1000]);
	const owner = store.accounts.set(OWNER, { accountId: 1, name: 'Owner', linkedBy: OWNER, consent: 'granted' });
	assert.strictEqual(owner.consentAt, c.t);
	assert.deepStrictEqual(store.accounts.list().map((a) => [a.userId, a.accountId, a.consent]), [[ZACK, 12345678, 'granted'], [OWNER, 1, 'granted']]);
	assert.deepStrictEqual(store.accounts.get(ZACK), granted);
	assert.deepStrictEqual(store.accounts.remove(ZACK), granted);
	assert.strictEqual(store.accounts.get(ZACK), null);
	assert.strictEqual(store.accounts.patch(ZACK, { consent: 'granted' }), null);
});

test('an account patch that passes undefined keeps the consent, the name and the link time', (t) => {
	const c = clock();
	const { store, paths } = make({ now: c.now });
	const count = renames(t, paths.PLEXBOT_APMEDIA_ACCOUNTS_FILE);
	const link = store.accounts.set(ZACK, { accountId: 7, name: 'Zack', linkedBy: OWNER, consent: 'granted' });
	c.t += 1000;
	const blank = { accountId: undefined, name: undefined, linkedAt: undefined, linkedBy: undefined, consent: undefined, consentAt: undefined };
	assert.deepStrictEqual(store.accounts.patch(ZACK, blank), link);
	assert.deepStrictEqual(store.accounts.get(ZACK), link);
	assert.strictEqual(count(), 1);
	assert.throws(() => store.accounts.patch(ZACK, 'granted'), /must be an object/);
});

test('an account link needs a Discord id, a Plex account id and a known consent state', () => {
	const { store } = make();
	assert.throws(() => store.accounts.set('zack', { accountId: 2 }), /Discord user id/);
	assert.throws(() => store.accounts.set(ZACK, { accountId: 0 }), /Plex account id/);
	assert.throws(() => store.accounts.set(ZACK, { accountId: 'x' }), /Plex account id/);
	assert.throws(() => store.accounts.set(ZACK, { accountId: 2, consent: 'yes' }), /pending, granted/);
	assert.strictEqual(store.accounts.get('__proto__'), null);
	assert.deepStrictEqual(store.accounts.list(), []);
});

test('account links survive a restart and are durable', () => {
	const c = clock();
	const { store, paths } = make({ now: c.now });
	store.accounts.set(ZACK, { accountId: 7, name: 'Zack' });
	c.t += 2 * HOUR;
	store.accounts.patch(ZACK, { consent: 'granted' });
	assert.ok(fs.existsSync(`${paths.PLEXBOT_APMEDIA_ACCOUNTS_FILE}.bak`));
	store.reset();
	assert.strictEqual(store.accounts.get(ZACK).consent, 'granted');
});

// --- history marks --------------------------------------------------------------------------------

test('marks round-trip the watcher\'s {newestViewedAt, seen} and skip writes that change nothing', (t) => {
	const { store, paths } = make();
	const count = renames(t, paths.PLEXBOT_APMEDIA_MARKS_FILE);
	assert.strictEqual(store.marks.get(1), null);
	const mark = store.marks.set('1', { newestViewedAt: 1731300000, seen: ['/status/sessions/history/9', 10, '/status/sessions/history/9'] });
	assert.deepStrictEqual(mark, { newestViewedAt: 1731300000, seen: ['/status/sessions/history/9', '10'] });
	assert.deepStrictEqual(store.marks.get(1), mark);
	store.marks.set(1, { newestViewedAt: 1731300000, seen: ['/status/sessions/history/9', '10'] });
	assert.strictEqual(count(), 1);
	store.marks.set(1, { newestViewedAt: 1731300060, seen: ['10'] });
	assert.strictEqual(count(), 2);
	assert.deepStrictEqual(store.marks.list(), [{ accountId: 1, newestViewedAt: 1731300060, seen: ['10'] }]);
	assert.throws(() => store.marks.set(0, { newestViewedAt: 1, seen: [] }), /Plex account id/);
	assert.deepStrictEqual(store.marks.remove(1), { newestViewedAt: 1731300060, seen: ['10'] });
	assert.strictEqual(store.marks.get(1), null);
	store.reset();
	assert.strictEqual(store.marks.get(1), null);
});

test('the marks object drops into apMediaWatch as its marks store', async () => {
	const { createWatcher } = require('../helpers/apMediaWatch.js');
	const { store } = make();
	const rows = [{ historyKey: '/status/sessions/history/5', ratingKey: '2001', viewedAt: 1731300100, accountID: 1, librarySectionID: '3' }];
	const pms = { history: async () => ({ rows, total: rows.length }), sessions: async () => [], accounts: async () => [] };
	const events = [];
	const watcher = createWatcher({
		pms,
		targets: () => [{ accountId: 1, floorS: 1731300000 }],
		onEvent: (e) => { events.push(e); },
		marks: store.marks,
		now: () => 1731300200 * 1000,
		timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
		config: {},
		logger: { warn() {}, info() {}, error() {} },
	});
	await watcher.pollHistory();
	assert.deepStrictEqual(events.map((e) => [e.accountId, e.ratingKey, e.at]), [[1, 2001, 1731300100 * 1000]]);
	assert.deepStrictEqual(store.marks.get(1), { newestViewedAt: 1731300100, seen: ['/status/sessions/history/5'] });
	await watcher.pollHistory();
	assert.strictEqual(events.length, 1);
});

// --- the slot_data cache --------------------------------------------------------------------------

test('slot_data is cached once per seed and slot, through a .tmp and a rename', (t) => {
	const { store, paths } = make();
	const file = store.cache.fileFor('12345', 'Zack');
	assert.strictEqual(path.dirname(path.dirname(file)), paths.PLEXBOT_APMEDIA_CACHE_DIR);
	const count = renames(t, file);
	assert.strictEqual(store.cache.has('12345', 'Zack'), false);
	assert.strictEqual(store.cache.read('12345', 'Zack'), null);
	assert.strictEqual(store.cache.write('12345', 'Zack', SLOT_DATA), true);
	assert.strictEqual(store.cache.write('12345', 'zack', SLOT_DATA), true);
	assert.strictEqual(count(), 1);
	assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
	assert.ok(store.cache.has('12345', 'ZACK'));
	store.reset();
	assert.deepStrictEqual(store.cache.read('12345', 'Zack'), SLOT_DATA);
	assert.strictEqual(store.cache.has('12346', 'Zack'), false);
	assert.strictEqual(store.cache.write('12345', 'Zack', { game: 'ChecksFinder', entries: [] }), false);
	assert.strictEqual(store.cache.write('', 'Zack', SLOT_DATA), false);
	assert.strictEqual(store.cache.read(null, 'Zack'), null);
});

test('a damaged cache file is not held: has() removes it, so the Connect asks the server again', (t) => {
	const lines = quiet(t);
	const { store } = make();
	const file = store.cache.fileFor('777', 'Zack');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '');
	assert.strictEqual(store.cache.has('777', 'Zack'), false);
	assert.ok(!fs.existsSync(file));
	assert.ok(lines.some((l) => l.includes('unusable')), lines.join('\n'));
	assert.strictEqual(store.cache.read('777', 'Zack'), null);
	fs.writeFileSync(file, JSON.stringify({ game: 'ChecksFinder', entries: [] }));
	assert.strictEqual(store.cache.has('777', 'Zack'), false, 'another game\'s slot_data is not this slot\'s');
	assert.ok(!fs.existsSync(file));
	assert.ok(store.cache.write('777', 'Zack', SLOT_DATA));
	assert.ok(fs.existsSync(file));
});

test('has() parses a good copy once, and the read after it comes from memory', (t) => {
	const { store } = make();
	assert.ok(store.cache.write('888', 'Zack', SLOT_DATA));
	store.reset();
	const file = path.resolve(store.cache.fileFor('888', 'Zack'));
	const real = fs.readFileSync;
	const reads = t.mock.method(fs, 'readFileSync', (...args) => real(...args));
	const ofFile = () => reads.mock.calls.filter((call) => path.resolve(String(call.arguments[0])) === file).length;
	assert.strictEqual(store.cache.has('888', 'Zack'), true);
	assert.strictEqual(ofFile(), 1);
	assert.deepStrictEqual(store.cache.read('888', 'zack'), SLOT_DATA);
	assert.strictEqual(store.cache.has('888', 'ZACK'), true);
	assert.strictEqual(ofFile(), 1);
	assert.ok(fs.existsSync(file));
});

test('as ApMediaClient\'s hasSlotData, the cache makes Connect ask for slot_data unless a good copy is held', (t) => {
	quiet(t);
	const { ApMediaClient } = require('../helpers/apMediaClient.js');
	const { store } = make();
	const client = new ApMediaClient({
		target: { kind: 'direct', host: '127.0.0.1', port: 9 },
		slot: 'Zack',
		label: 'store-test',
		hasSlotData: (seed, slot) => store.cache.has(seed, slot),
	});
	client.seedName = '999';
	assert.strictEqual(client.connectPacket().slot_data, true, 'nothing held');
	const file = store.cache.fileFor('999', 'Zack');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '');
	assert.strictEqual(client.connectPacket().slot_data, true, 'a damaged copy is not held');
	assert.ok(store.cache.write('999', 'Zack', SLOT_DATA));
	store.reset();
	assert.strictEqual(client.connectPacket().slot_data, false, 'a good copy on disk is held');
	assert.deepStrictEqual(store.cache.read('999', 'Zack'), SLOT_DATA);
});

test('drop and dropSeed remove one slot or a whole seed', () => {
	const { store } = make();
	store.cache.write('S', 'A', SLOT_DATA);
	store.cache.write('S', 'B', SLOT_DATA);
	store.cache.write('T', 'A', SLOT_DATA);
	assert.strictEqual(store.cache.drop('S', 'A'), true);
	assert.strictEqual(store.cache.has('S', 'A'), false);
	assert.ok(store.cache.has('S', 'B'));
	assert.strictEqual(store.cache.dropSeed('S'), true);
	assert.strictEqual(store.cache.has('S', 'B'), false);
	assert.ok(store.cache.has('T', 'A'));
	assert.strictEqual(store.cache.dropSeed('S'), false);
	assert.strictEqual(store.cache.dropSeed(''), false);
});

test('server-supplied names cannot leave the cache folder or land on a reserved Windows name', () => {
	const { store, paths } = make();
	const root = path.resolve(paths.PLEXBOT_APMEDIA_CACHE_DIR);
	const names = ['..', '../../etc', '..\\..\\Windows', 'C:\\x', 'a:b', 'CON', 'nul.txt', 'COM1', 'Lpt9.json', 'aux.', ' trailing. ', '%2e%2e', 'x'.repeat(500), String.fromCharCode(0x6771, 0x4eac), '.'];
	const segments = new Set();
	for (const seed of names) {
		const file = store.cache.fileFor(seed, seed);
		assert.strictEqual(path.dirname(path.dirname(path.resolve(file))), root, seed);
		for (const part of [path.basename(path.dirname(file)), path.basename(file, '.json')]) {
			assert.match(part, /^[A-Za-z0-9_-]{1,32}-[0-9a-f]{12}$/, `${seed} -> ${part}`);
			assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(part.split('.')[0]), part);
		}
		segments.add(path.basename(path.dirname(file)));
		assert.ok(store.cache.write(seed, seed, SLOT_DATA), seed);
	}
	assert.strictEqual(segments.size, names.length);
	assert.deepStrictEqual(fs.readdirSync(root).sort(), [...segments].sort());
});

test('names that sanitize alike still get their own folders, and the same name always the same one', () => {
	const a = apStore.safeSegment('Seed/1');
	const b = apStore.safeSegment('Seed:1');
	const c = apStore.safeSegment('Seed_1');
	assert.strictEqual(new Set([a, b, c]).size, 3);
	assert.ok(a.startsWith('Seed_1-') && b.startsWith('Seed_1-') && c.startsWith('Seed_1-'));
	assert.strictEqual(apStore.safeSegment('Seed/1'), a);
	assert.strictEqual(apStore.safeSegment(''), null);
	assert.strictEqual(apStore.safeSegment(null), null);
	assert.notStrictEqual(apStore.safeSegment('Zack'), apStore.safeSegment('zack'));
});

test('under the test runner without PLEXBOT_APMEDIA_CACHE_DIR the cache never touches disk', () => {
	const { store } = make({ env: { PLEXBOT_APMEDIA_CACHE_DIR: undefined, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child' } });
	assert.strictEqual(store.cache.memoryOnly, true);
	assert.strictEqual(path.resolve(store.cache.dir), path.resolve(__dirname, '..', 'data', 'archipelago', 'apmedia'));
	const seed = `memory-only-${process.pid}`;
	assert.ok(store.cache.write(seed, 'Zack', SLOT_DATA));
	assert.ok(store.cache.has(seed, 'Zack'));
	assert.strictEqual(store.cache.read(seed, 'zack'), SLOT_DATA);
	assert.ok(!fs.existsSync(path.dirname(store.cache.fileFor(seed, 'Zack'))));
	assert.strictEqual(store.cache.dropSeed(seed), true);
	assert.strictEqual(store.cache.has(seed, 'Zack'), false);
});

test('health reports each part, and a cache write that fails says so', (t) => {
	const lines = quiet(t);
	const { store } = make();
	assert.deepStrictEqual(store.health(), { bindings: true, accounts: true, marks: true, cache: true });
	const file = store.cache.fileFor('BROKEN', 'Zack');
	fs.mkdirSync(`${file}.tmp`, { recursive: true });
	assert.strictEqual(store.cache.write('BROKEN', 'Zack', SLOT_DATA), false);
	assert.strictEqual(store.healthy(), false);
	assert.strictEqual(store.health().cache, false);
	assert.ok(lines.some((l) => l.includes('could not cache slot_data')), lines.join('\n'));
	assert.strictEqual(store.cache.read('BROKEN', 'Zack'), SLOT_DATA, 'the copy in memory still serves this run');
});
