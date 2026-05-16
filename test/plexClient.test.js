const test = require('node:test');
const assert = require('node:assert');
const { getPlex } = require('../helpers/plexClient.js');

test('getPlex() returns the same instance on repeated calls (memoization)', () => {
    const a = getPlex();
    const b = getPlex();
    assert.strictEqual(a, b);
});

test('getPlex() returns an object with a .query method', () => {
    const p = getPlex();
    assert.ok(p, 'should not be null');
    assert.strictEqual(typeof p.query, 'function');
});
