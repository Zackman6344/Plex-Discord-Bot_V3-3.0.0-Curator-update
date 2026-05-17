const test = require('node:test');
const assert = require('node:assert');

const plexHome = require('../helpers/plexHome.js');

// Most plexHome paths hit plex.tv over the network. These tests cover the bits we can
// exercise without a real Plex Home: the cache layer + the missing-config error path.
// Live PIN switching is verified manually against a real server.

test.beforeEach(() => plexHome._resetCaches());

test('exports the expected public surface', () => {
    assert.strictEqual(typeof plexHome.listHomeUsers, 'function');
    assert.strictEqual(typeof plexHome.findUserByName, 'function');
    assert.strictEqual(typeof plexHome.switchAs, 'function');
    assert.strictEqual(typeof plexHome.getCachedClient, 'function');
});

test('getCachedClient returns null for unknown user', () => {
    assert.strictEqual(plexHome.getCachedClient('discord-123', 'someone'), null);
});

test('listHomeUsers throws a clear error when homeOwnerToken is empty', async () => {
    // Default plex.example.js + the worktree's plex.js both leave homeOwnerToken empty.
    await assert.rejects(
        () => plexHome.listHomeUsers(),
        /homeOwnerToken is not set/i
    );
});

test('switchAs surfaces the same missing-token error path', async () => {
    await assert.rejects(
        () => plexHome.switchAs('whoever', '1234', 'discord-123'),
        /homeOwnerToken is not set/i
    );
});

test('_resetCaches clears in-memory caches', async () => {
    // We can't easily seed a cached client without doing a switch, but we can verify
    // that the function exists and doesn't throw on an empty cache.
    plexHome._resetCaches();
    assert.strictEqual(plexHome.getCachedClient('any-user', 'any-account'), null);
});
