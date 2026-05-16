const test = require('node:test');
const assert = require('node:assert');

// lang/format.js applies a polyfill to String.prototype
require('../lang/format.js');

test('String#format substitutes a single named placeholder', () => {
    assert.strictEqual('hello {name}'.format({ name: 'world' }), 'hello world');
});

test('String#format substitutes multiple placeholders', () => {
    assert.strictEqual(
        '{a} and {b}'.format({ a: 'one', b: 'two' }),
        'one and two'
    );
});

test('String#format leaves unknown placeholders empty', () => {
    assert.strictEqual('hi {missing}'.format({}), 'hi ');
});

test('String#format handles strings with no placeholders', () => {
    assert.strictEqual('plain text'.format({ foo: 'bar' }), 'plain text');
});
