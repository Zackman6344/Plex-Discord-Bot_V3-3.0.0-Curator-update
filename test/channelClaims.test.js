const test = require('node:test');
const assert = require('node:assert');

const channelClaims = require('../helpers/channelClaims.js');

test('isClaimed is false when no predicate matches', () => {
    assert.strictEqual(channelClaims.isClaimed('unclaimed-channel'), false);
});

test('a registered predicate claims matching channels and follows live state', () => {
    const live = new Set(['chan-A']);
    channelClaims.register((id) => live.has(id));

    assert.strictEqual(channelClaims.isClaimed('chan-A'), true);
    assert.strictEqual(channelClaims.isClaimed('chan-B'), false);

    // Derived from live state — releasing is just mutating the source.
    live.delete('chan-A');
    assert.strictEqual(channelClaims.isClaimed('chan-A'), false);
});

test('a throwing predicate is treated as no-claim, not a crash', () => {
    channelClaims.register(() => { throw new Error('boom'); });
    assert.strictEqual(channelClaims.isClaimed('any-channel'), false);
});
