const test = require('node:test');
const assert = require('node:assert');
const logger = require('../helpers/logger.js');

test('logger exposes debug/info/warn/error functions', () => {
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info,  'function');
    assert.strictEqual(typeof logger.warn,  'function');
    assert.strictEqual(typeof logger.error, 'function');
});

test('logger.info emits a line with timestamp and INFO label', () => {
    const captured = [];
    const original = console.log;
    console.log = (...args) => captured.push(args.join(' '));
    try {
        logger.info('hello');
    } finally {
        console.log = original;
    }
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'should contain an ISO timestamp');
    assert.match(captured[0], /INFO/, 'should contain INFO label');
    assert.match(captured[0], /hello/, 'should contain the message');
});

test('logger.error routes to console.error', () => {
    const captured = [];
    const original = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    try {
        logger.error('boom');
    } finally {
        console.error = original;
    }
    assert.strictEqual(captured.length, 1);
    assert.match(captured[0], /ERROR/);
    assert.match(captured[0], /boom/);
});
