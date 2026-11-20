// roomKey: what `!ap watch` compares to find a watch that already follows a room in a channel.

const test = require('node:test');
const assert = require('node:assert');

const harness = require('./helpers/apServer.js');
harness.useTempStores('twice');   // must run before any helper is required

const { parseTarget } = require('../helpers/archipelagoClient.js');
const monitor = require('../helpers/archipelagoMonitor.js');

const key = raw => monitor.roomKey(parseTarget(raw));

test('a room URL keeps its key across case in the host, a scheme and a trailing slash', () => {
    assert.strictEqual(key('https://Archipelago.GG/room/AbCdEfGh12/'), key('archipelago.gg/room/AbCdEfGh12'));
    assert.strictEqual(key('archipelago.gg/room/AbCdEfGh12'), 'room:archipelago.gg/room/AbCdEfGh12');
});

test('the room id keeps its case', () => {
    assert.notStrictEqual(key('archipelago.gg/room/abcdefgh12'), key('archipelago.gg/room/AbCdEfGh12'));
});

test('a host:port compares its host without case and its port exactly', () => {
    assert.strictEqual(key('Localhost:38281'), key('localhost:38281'));
    assert.strictEqual(key('localhost:38281'), 'direct:localhost:38281');
    assert.notStrictEqual(key('localhost:38282'), key('localhost:38281'));
});

test('no target has no key', () => {
    assert.strictEqual(monitor.roomKey(null), null);
    assert.strictEqual(key(''), null);
});
