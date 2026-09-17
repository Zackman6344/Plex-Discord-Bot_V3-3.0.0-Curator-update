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

// --- the per-server access token -------------------------------------------------------------
//
// The bug this covers: `plex-copy` switched into a managed user successfully and then every
// library call came back 401, which plex-api reports as "you must provide a way to authenticate"
// — reading like the bot had no token rather than like the server refusing one. The switch hands
// back an ACCOUNT token, which plex.tv accepts and the server does not. Plex mints a separate
// per-server access token, on the resource list entry whose clientIdentifier matches the
// server's machineIdentifier, and that is the only one a library call gets past.
//
// Measured on a real server, same user, same moment: account token -> 401, resource accessToken
// -> 200. Confirmed for a PIN-less user, which is what proved the PIN was never involved.

const MACHINE_ID = '92a8cdb927afd71730516730cc53fb5b67de6ea0';

/** Answer /identity and /api/v2/resources, and record what was asked. */
function withFetch(t, { resources, identity = { MediaContainer: { machineIdentifier: MACHINE_ID } }, identityOk = true }) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const href = String(url);
        calls.push({ url: href, token: init && init.headers && init.headers['X-Plex-Token'] });
        if (href.includes('/identity')) {
            return { ok: identityOk, status: identityOk ? 200 : 500, statusText: 'x', json: async () => identity };
        }
        if (href.includes('/resources')) {
            if (resources instanceof Error) throw resources;
            if (resources && resources.status) return { ok: false, status: resources.status, statusText: 'Unauthorized' };
            return { ok: true, status: 200, json: async () => resources };
        }
        throw new Error(`unexpected fetch: ${href}`);
    };
    t.after(() => { globalThis.fetch = real; });
    return calls;
}

test('the token for this server comes off the matching resource entry', async (t) => {
    withFetch(t, {
        resources: [
            { clientIdentifier: 'some-other-server', name: 'Elsewhere', accessToken: 'wrong-token' },
            { clientIdentifier: MACHINE_ID, name: 'The Nerdgasm', accessToken: 'right-token' }
        ]
    });
    assert.strictEqual(await plexHome.accessTokenForServer('account-token'), 'right-token');
});

test('another server sharing the account is not mistaken for this one', async (t) => {
    // Picking the first entry would hand back a token for a server the bot cannot reach.
    withFetch(t, { resources: [{ clientIdentifier: 'not-ours', name: 'Elsewhere', accessToken: 'wrong-token' }] });
    await assert.rejects(() => plexHome.accessTokenForServer('account-token'), /no access to this Plex server/i);
});

test('the resource list is read as the switched user, not as the owner', async (t) => {
    // Asking as the owner returns the owner's own access token, which works and silently gives
    // the wizard the wrong account's library.
    const calls = withFetch(t, { resources: [{ clientIdentifier: MACHINE_ID, accessToken: 'right-token' }] });
    await plexHome.accessTokenForServer('switched-user-token');
    const resourceCall = calls.find(c => c.url.includes('/resources'));
    assert.strictEqual(resourceCall.token, 'switched-user-token');
});

test('the owner entry, which carries no accessToken, falls back to the account token', async (t) => {
    // The owner's account token already is the server token.
    withFetch(t, { resources: [{ clientIdentifier: MACHINE_ID, name: 'The Nerdgasm' }] });
    assert.strictEqual(await plexHome.accessTokenForServer('owner-token'), 'owner-token');
});

test('a machine identifier is read once and reused', async (t) => {
    const calls = withFetch(t, { resources: [{ clientIdentifier: MACHINE_ID, accessToken: 'right-token' }] });
    await plexHome.accessTokenForServer('a');
    await plexHome.accessTokenForServer('b');
    assert.strictEqual(calls.filter(c => c.url.includes('/identity')).length, 1);
});

test('a server that will not identify itself is reported, not guessed at', async (t) => {
    withFetch(t, { resources: [], identityOk: false });
    await assert.rejects(() => plexHome.accessTokenForServer('a'), /identity/i);
});

test('a missing machineIdentifier is reported rather than matched as undefined', async (t) => {
    // Matching undefined against undefined would pick an arbitrary server.
    withFetch(t, { resources: [{ accessToken: 'wrong' }], identity: { MediaContainer: {} } });
    await assert.rejects(() => plexHome.accessTokenForServer('a'), /machineIdentifier/i);
});

test('a refused resource list is reported with its status', async (t) => {
    withFetch(t, { resources: { status: 401 } });
    await assert.rejects(() => plexHome.accessTokenForServer('a'), /401/);
});

test('a non-array resource body does not throw', async (t) => {
    withFetch(t, { resources: { unexpected: 'shape' } });
    await assert.rejects(() => plexHome.accessTokenForServer('a'), /no access to this Plex server/i);
});

// --- not dead-ending on a stale cache ---------------------------------------------------------
//
// The symptom that got this reported: the first run failed, and every run for the next thirty
// minutes hit the cache, skipped the PIN prompt and failed the same way in seconds. The cache
// held whatever the switch produced, proven or not.

test('forgetClient answers false for something that was never cached', () => {
    assert.strictEqual(plexHome.forgetClient('discord-123', 'nobody'), false);
    assert.strictEqual(plexHome.forgetClient('no-such-user', 'nobody'), false);
});

// --- saying what actually went wrong ----------------------------------------------------------

test("plex-api's 401 text is translated into what it means", () => {
    // Verbatim from plex-api/lib/api.js. It describes its own missing authenticator rather than
    // the response, so the wizard passed it on as though the bot were misconfigured.
    const err = new Error('Plex Server denied request, you must provide a way to authenticate! ' +
        'Read more about plex-api authenticators on https://www.npmjs.com/package/plex-api#authenticators');
    const said = plexHome.explainError(err);
    assert.match(said, /refused/i);
    assert.match(said, /401/);
    assert.ok(!/plex-api|npmjs/.test(said), 'the library URL is noise to whoever is reading the DM');
});

test('a 403 is distinguished from a 401', () => {
    const err = new Error('Plex Server denied request due to lack of managed user permissions!');
    assert.match(plexHome.explainError(err), /permission/i);
    assert.match(plexHome.explainError(err), /403/);
});

test('any other error is passed through unchanged', () => {
    assert.strictEqual(plexHome.explainError(new Error('ECONNREFUSED')), 'ECONNREFUSED');
    assert.strictEqual(plexHome.explainError('a bare string'), 'a bare string');
    assert.match(plexHome.explainError(null), /unknown error/);
});
