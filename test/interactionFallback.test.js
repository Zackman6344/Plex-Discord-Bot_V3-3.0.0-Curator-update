// What the bot says when it could not acknowledge a slash command.
//
// The interaction's own token is dead by then, so this is the only route left to the user, and
// without it all Discord shows is "This interaction failed" - which reads like the command broke
// rather than that it never started.

const test = require('node:test');
const assert = require('node:assert');

const fallback = require('../helpers/interactionFallback.js');

function fakeChannel() {
    const sent = [];
    return { sent, send: async (payload) => { sent.push(payload); return {}; } };
}

const expiredError = () => Object.assign(new Error('Unknown interaction'), { code: 10062 });

test('an expired interaction is named as such and points at re-running it', () => {
    const text = fallback.describe('playlist', expiredError());
    assert.match(text, /`\/playlist`/);
    assert.match(text, /expired/i);
    assert.match(text, /again/i);
    assert.match(text, /Nothing ran/);
});

test('any other defer failure reports its own reason', () => {
    const text = fallback.describe('playlist', new Error('Missing Permissions'));
    assert.match(text, /Missing Permissions/);
    assert.match(text, /Nothing ran/);
    assert.ok(!/expired/i.test(text), 'only 10062 is described as expiry');
});

test('isExpired recognises the code and the message, and nothing else', () => {
    assert.strictEqual(fallback.isExpired(expiredError()), true);
    assert.strictEqual(fallback.isExpired(new Error('Unknown interaction')), true);
    assert.strictEqual(fallback.isExpired(new Error('Missing Permissions')), false);
    assert.strictEqual(fallback.isExpired(null), false);
});

test('the explanation is posted to the interaction channel without pinging', async () => {
    const channel = fakeChannel();
    const said = await fallback.explainFailedDefer(null, { channel, channelId: 'c1' }, 'playlist', expiredError());

    assert.strictEqual(channel.sent.length, 1);
    assert.deepStrictEqual(channel.sent[0].allowedMentions, { parse: [] });
    assert.strictEqual(channel.sent[0].content, said);
});

test('an uncached channel is fetched through the client', async () => {
    const channel = fakeChannel();
    const client = { channels: { fetch: async (id) => (id === 'c9' ? channel : null) } };

    const said = await fallback.explainFailedDefer(client, { channel: null, channelId: 'c9' }, 'vibe', expiredError());
    assert.strictEqual(channel.sent.length, 1);
    assert.ok(said);
});

test('it never throws when the fallback itself cannot be posted', async () => {
    const exploding = { channel: { send: async () => { throw new Error('Missing Access'); } }, channelId: 'c1' };
    assert.strictEqual(await fallback.explainFailedDefer(null, exploding, 'playlist', expiredError()), null);

    // No channel at all, and no client to fetch one with.
    assert.strictEqual(await fallback.explainFailedDefer(null, { channel: null, channelId: 'c1' }, 'playlist', null), null);
});

test('the message never echoes the command arguments', () => {
    // Slash options are visible only to whoever ran the command; this reply is public.
    const text = fallback.describe('password', expiredError());
    assert.ok(!text.includes('hunter2'));
    assert.match(text, /`\/password`/);
});
