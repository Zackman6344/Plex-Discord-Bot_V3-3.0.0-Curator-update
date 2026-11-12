// app/utils.js and helpers/healthCheck.js: where the Plex Media game sits in the bot's lifecycle
// (SPEC 5.12).
//
// stop(), which !restart, a login retry and shutdown all run, must stop the game exactly once and
// still stop everything after it when the game's stop throws; and the health report (the boot log
// and !plextest) must carry an apMedia line from the game's own health(), or an error line when that
// throws.
//
// Harness: app/utils.js and helpers/healthCheck.js loaded with every module they require swapped in
// require.cache, as test/loginRetry.test.js does: a recording stand-in for helpers/apMediaGame.js,
// and stand-ins for Plex, Tautulli, Playnite, the event server, the Archipelago monitor and the
// config files, so nothing reaches the network or reads config/keys.js.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const calls = [];
const HEALTHY = { status: 'ok', detail: '1 slot, 1 connected, Plex history read 4m ago' };
const game = {};

function stub(rel, exports) {
	const file = require.resolve(path.join(ROOT, rel));
	require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stub('helpers/apMediaGame.js', game);
stub('helpers/calibreIndex.js', { instance: () => ({ stop: () => calls.push('calibre.stop') }) });
stub('helpers/eventServer.js', { stopEventServer: () => calls.push('eventServer.stop'), getStatus: () => ({ enabled: false }) });
stub('helpers/healthMonitor.js', { stopHealthMonitor: () => calls.push('healthMonitor.stop') });
stub('helpers/kometaTheater.js', { stopKometaTheater: () => calls.push('kometa.stop') });
stub('helpers/archipelagoMonitor.js', { detachArchipelagoMonitor: () => calls.push('archipelago.detach'), getStatus: () => ({ enabled: false }) });
stub('helpers/restartHandoff.js', { endAll: () => calls.push('handoff.endAll') });
stub('helpers/plexClient.js', { getPlex: () => { throw new Error('no Plex in this test'); } });
stub('helpers/tautulliAPI.js', {});
stub('helpers/playniteAPI.js', {});
stub('config/config.js', { commandPrefix: '!', language: 'en', serverName: 'Test', playlistsDir: 'playlists', tautulliEnabled: false, playniteEnabled: false });
stub('config/plex.js', { hostname: '' });
stub('config/keys.js', { geminiApiKey: '' });

const utils = require('../app/utils.js');
const healthCheck = require('../helpers/healthCheck.js');

function fakePair() {
	const bot = {
		songQueue: [{}],
		books: { shutdown: () => calls.push('books.shutdown') },
		stop: () => calls.push('bot.stop'),
		destroy: () => calls.push('bot.destroy'),
	};
	const client = { destroy: () => calls.push('client.destroy') };
	return { bot, client };
}

test.beforeEach(() => {
	calls.length = 0;
	game.stop = () => calls.push('apMedia.stop');
	game.health = () => ({ ...HEALTHY });
});

test('stop() stops the game once, after the audiobooks have closed their sessions', () => {
	const { bot, client } = fakePair();
	utils.stop(bot, client);
	assert.strictEqual(calls.filter((c) => c === 'apMedia.stop').length, 1);
	// apMediaBooks hands on a book's last listening when the game detaches it, so the engine must
	// have ended its sessions by then.
	assert.ok(calls.indexOf('books.shutdown') < calls.indexOf('apMedia.stop'), calls.join(', '));
	assert.ok(calls.includes('client.destroy'));
});

test('a game stop that throws leaves the rest of stop() to run', () => {
	game.stop = () => {
		calls.push('apMedia.stop');
		throw new Error('boom');
	};
	const { bot, client } = fakePair();
	assert.doesNotThrow(() => utils.stop(bot, client));
	const after = calls.slice(calls.indexOf('apMedia.stop') + 1);
	assert.deepStrictEqual(after.filter((c) => c === 'handoff.endAll' || c === 'client.destroy'), ['handoff.endAll', 'client.destroy']);
});

test('the health report carries the game\'s own health as apMedia', async () => {
	const report = await healthCheck.runHealthCheck();
	assert.deepStrictEqual(report.apMedia, HEALTHY);
	assert.match(healthCheck.formatHealthCheck(report), /^ {2}\S ApMedia: 1 slot, 1 connected, Plex history read 4m ago$/m);
});

test('a game health() that throws is reported as an error line, never thrown', async () => {
	game.health = () => {
		throw new Error('boom');
	};
	assert.deepStrictEqual(healthCheck.checkApMedia(), { status: 'error', detail: 'Plex Media health check failed: boom' });
	const report = await healthCheck.runHealthCheck();
	assert.strictEqual(report.apMedia.status, 'error');
	assert.strictEqual(report.config.status, 'ok', 'the other checks still report');
});
