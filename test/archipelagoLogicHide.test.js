// `!ap nexthide` against the real scripts/ap-logic-worker.py.
//
// The fake worker in archipelagoLogic.test.js speaks the protocol as the JS side believes it to be,
// so it cannot catch the two sides disagreeing about a field name. This runs the real Python, with
// a stand-in install that holds just enough of one for the worker to load: a python313.dll for it to
// read the version off, and the two modules bootstrap() imports. With no seed number the rebuild
// fails, which is the worker's own answer-from-multidata mode, so every slot is answered from sphere
// 1 of a multidata written here. The rebuilt-logic path needs Archipelago itself and is driven
// through the worker's Logic class directly, at the end.
//
// The seed: slot 1 (A) holds 101-103 in sphere 1 and 104 in sphere 2. 101's item is A's own, 102's
// is B's (slot 2), 103's is C's (slot 3), and 104's goes to the item-link group 9, whose members
// are B and C. Slot 2 (B) holds 201 (its own item) and 202 (A's).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stores = require('./helpers/apServer.js').useTempStores('logichide');
test.after(() => stores.cleanup());

const logic = require('../helpers/archipelagoLogic.js');
const monitor = require('../helpers/archipelagoMonitor.js');

const UTILS = [
	'import pickle',
	'def local_path(*parts): return ""',
	'def user_path(*parts): return ""',
	'def messagebox(*args, **kwargs): pass',
	'def open_filename(*args, **kwargs): return None',
	'def open_directory(*args, **kwargs): return None',
	'def restricted_loads(data): return pickle.loads(data)',
	''
].join('\n');

const MULTIDATA = [
	'import pickle, sys, types, zlib',
	'NS = types.SimpleNamespace',
	'md = {',
	'    "seed_name": "FAKESEED",',
	'    "spheres": [{1: {101, 102, 103}, 2: {201}}, {1: {104}, 2: {202}}],',
	'    "locations": {',
	'        1: {101: (5001, 1, 1), 102: (5002, 2, 0), 103: (5003, 3, 1), 104: (5004, 9, 0)},',
	'        2: {201: (6001, 2, 1), 202: (6002, 1, 1)},',
	'    },',
	'    "slot_info": {',
	'        1: NS(name="A", game="G1", type=1, group_members=[]),',
	'        2: NS(name="B", game="G2", type=1, group_members=[]),',
	'        3: NS(name="C", game="G2", type=1, group_members=[]),',
	'        9: NS(name="Link", game="G1", type=2, group_members=[2, 3]),',
	'    },',
	'    "datapackage": {"G1": {"location_name_to_id": {"Loc 101": 101, "Loc 102": 102, "Loc 103": 103, "Loc 104": 104}}},',
	'}',
	'with open(sys.argv[1], "wb") as handle:',
	'    handle.write(bytes([3]) + zlib.compress(pickle.dumps(md)))',
	''
].join('\n');

const WORKER = logic._deps.workerScript;
let root = null;
let worker = null;
let unavailable = null;

function py(args) {
	return spawnSync('py', ['-3.13', ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true });
}

test.before(async () => {
	// bootstrap() calls os.add_dll_directory, which only Windows has, as the frozen install does.
	if (process.platform !== 'win32') {
		unavailable = 'the worker only runs on Windows';
		return;
	}
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'plexbot-test-logichide-'));
	const install = path.join(root, 'Archipelago');
	fs.mkdirSync(path.join(install, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(install, 'python313.dll'), '');
	fs.writeFileSync(path.join(install, 'lib', 'Utils.py'), UTILS);
	fs.writeFileSync(path.join(install, 'lib', 'settings.py'), 'skip_autosave = False\nno_gui = False\n');
	const multidata = path.join(root, 'FAKESEED.archipelago');
	const made = py(['-I', '-B', '-c', MULTIDATA, multidata]);
	if (made.error && made.error.code === 'ENOENT') {
		unavailable = 'the py launcher is not installed';
		return;
	}
	if (made.status !== 0) {
		unavailable = `Python 3.13 could not write the multidata: ${made.stderr}`;
		return;
	}
	worker = new logic.LogicWorker({
		command: 'py',
		args: ['-3.13', ...logic._deps.pythonFlags, WORKER, '--ap-dir', install, '--seed-name', 'FAKESEED', '--multidata', multidata],
		label: 'test'
	}).start();
	await worker.whenReady(60000);
});

test.after(async () => {
	try {
		// A worker that already exited has sent its only 'exit', and waiting for another never ends.
		if (worker && worker.state !== 'exited') {
			const gone = new Promise(resolve => worker.child.once('exit', resolve));
			worker.stop();
			await gone;
		}
	} finally {
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

const ids = (result) => result.locations.map(([id]) => id);

test('the stand-in install loads the real worker into its multidata-only mode', (t) => {
	if (unavailable) return t.skip(unavailable);
	assert.strictEqual(worker.state, 'ready');
	assert.match(worker.info.rebuildError, /no seed number/);
});

test('a request without finished is answered as before, with no hidden at all', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a] = await worker.inLogic([{ slot: 1, checked: [] }], {});
	assert.deepStrictEqual(ids(a), [101, 102, 103]);
	assert.strictEqual(a.open, 4);
	assert.ok(!('hidden' in a), 'nobody asked, so nothing may say anything about where items go');
});

test('a location whose item goes to a finished slot is left out of the list and of open, and counted', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a] = await worker.inLogic([{ slot: 1, checked: [] }], {}, { finished: [2] });
	assert.deepStrictEqual(ids(a), [101, 103], 'B is done, so 102 goes; C is not, so 103 stays');
	assert.strictEqual(a.open, 3, '104 is still open: half of its group is playing');
	assert.strictEqual(a.hidden, 1);
	assert.deepStrictEqual(a.locations[0], [101, 1, 'Loc 101'], 'names still come from the data package');
});

test('an item-link group\'s location goes only once every member is done', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a] = await worker.inLogic([{ slot: 1, checked: [] }], {}, { finished: [2, 3] });
	assert.deepStrictEqual(ids(a), [101]);
	assert.strictEqual(a.open, 1);
	assert.strictEqual(a.hidden, 3, '102, 103 and the group\'s 104');
});

test('a checked location is never counted as left out', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a] = await worker.inLogic([{ slot: 1, checked: [102] }], {}, { finished: [2] });
	assert.deepStrictEqual(ids(a), [101, 103]);
	assert.strictEqual(a.open, 3);
	assert.strictEqual(a.hidden, 0);
});

test('an empty finished list still answers with hidden, so the bot can tell it was heard', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a] = await worker.inLogic([{ slot: 1, checked: [] }], {}, { finished: [] });
	assert.deepStrictEqual(ids(a), [101, 102, 103]);
	assert.strictEqual(a.hidden, 0);
});

test('each slot in one request is judged by its own placements', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const [a, b] = await worker.inLogic([{ slot: 1, checked: [] }, { slot: 2, checked: [201] }], {}, { finished: [2, 3] });
	assert.strictEqual(a.hidden, 3);
	assert.deepStrictEqual([b.slot, b.open, b.hidden], [2, 1, 0], '202 holds A\'s item, and A is still playing');
});

test('answerAll asks the real worker about the goaled and released slots, and names what is left', async (t) => {
	if (unavailable) return t.skip(unavailable);
	const client = {
		team: 0,
		goaled: new Set(['0:2', '1:3']),
		released: new Set(),
		fullyChecked: new Set(['0:3']),
		hasFinished: () => false,
		slotGames: new Map([[1, 'G1']]),
		locationNames: new Map([['G1', new Map([[101, 'Loc 101'], [103, 'Loc 103']])]]),
		canonicalSlotName: (name) => (String(name).toLowerCase() === 'a' ? 'A' : null),
		slotIdFor: (name) => (String(name).toLowerCase() === 'a' ? 1 : null)
	};
	const prep = { ok: true, client, worker, logic: { ok: true }, checkedIds: new Map(), receivedItems: new Map() };

	const shown = await monitor.answerAll(prep, ['A']);
	assert.strictEqual(shown.results[0].hidden, undefined, 'off unless asked for');
	assert.strictEqual(shown.results[0].open, 4);

	const out = await monitor.answerAll(prep, ['A'], undefined, { hideFinished: true });
	const a = out.results[0];
	assert.deepStrictEqual(a.locations, ['Loc 101', 'Loc 103'],
		'team 1\'s goaled slot 3 is somebody else, and a fully checked slot may still want its item');
	assert.strictEqual(a.hidden, 1);
	assert.strictEqual(a.open, 3);
});

// The rebuilt-logic path needs a MultiWorld, and so Archipelago, to reach through answer_all. Its
// filter is the same few lines on the far side of can_reach, so it is driven through Logic.answer
// with stand-in locations, and a hidden location must never even be judged.
test('with rebuilt logic, a location for a finished slot is never judged and never listed', (t) => {
	if (unavailable) return t.skip(unavailable);
	const script = [
		'import importlib.util, sys, types, zlib, pickle',
		'spec = importlib.util.spec_from_file_location("ap_logic_worker", sys.argv[1])',
		'mod = importlib.util.module_from_spec(spec)',
		'spec.loader.exec_module(mod)',
		'with open(sys.argv[2], "rb") as handle:',
		'    md = pickle.loads(zlib.decompress(handle.read()[1:]))',
		'judged = []',
		'class Loc:',
		'    def __init__(self, address, reach):',
		'        self.address, self.reach = address, reach',
		'    def can_reach(self, state):',
		'        judged.append(self.address)',
		'        return self.reach',
		'logic = mod.Logic(None, md)',
		'logic.verified = {1: (True, None)}',
		'logic.addressed = {1: [Loc(101, True), Loc(102, True), Loc(103, False), Loc(104, True)]}',
		'state = object()',
		'plain = logic.answer({"slot": 1, "checked": []}, state, "unused")',
		'del judged[:]',
		'hiding = logic.answer({"slot": 1, "checked": []}, state, "unused", {2})',
		'mod.send({"plain": plain, "hiding": hiding, "judged": sorted(judged)})',
		''
	].join('\n');
	const run = py(['-I', '-B', '-c', script, WORKER, path.join(root, 'FAKESEED.archipelago')]);
	assert.strictEqual(run.status, 0, run.stderr);
	const out = JSON.parse(run.stdout.trim().split('\n').pop());
	assert.deepStrictEqual(out.plain.locations.map(([id]) => id), [101, 102, 104]);
	assert.strictEqual(out.plain.verified, true);
	assert.ok(!('hidden' in out.plain));
	assert.deepStrictEqual(out.hiding.locations, [[101, 1, 'Loc 101'], [104, 2, 'Loc 104']]);
	assert.strictEqual(out.hiding.open, 3);
	assert.strictEqual(out.hiding.hidden, 1);
	assert.deepStrictEqual(out.judged, [101, 103, 104], '102 is left out before its rule is asked');
});
