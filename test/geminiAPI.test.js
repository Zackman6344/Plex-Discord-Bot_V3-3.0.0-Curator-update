const test = require('node:test');
const assert = require('node:assert');
const { getModel, DEFAULT_MODEL, getGenAI } = require('../helpers/geminiAPI.js');

test('DEFAULT_MODEL is a non-empty string', () => {
    assert.strictEqual(typeof DEFAULT_MODEL, 'string');
    assert.ok(DEFAULT_MODEL.length > 0);
});

test('getModel() returns the same instance on repeated calls (memoization)', () => {
    const a = getModel();
    const b = getModel();
    assert.strictEqual(a, b);
});

test('getModel({ model: "..." }) returns a fresh instance with that model name', () => {
    const a = getModel();
    const b = getModel({ model: 'gemini-1.5-pro' });
    assert.notStrictEqual(a, b);
});

test('getModel({ generationConfig: {...} }) returns a fresh instance', () => {
    const a = getModel();
    const b = getModel({ generationConfig: { responseMimeType: 'application/json' } });
    assert.notStrictEqual(a, b);
});

test('getModel() returns an object with generateContent', () => {
    const m = getModel();
    assert.ok(m, 'model should not be null');
    assert.strictEqual(typeof m.generateContent, 'function');
});

test('getGenAI() returns the same client on repeated calls (memoization)', () => {
    const a = getGenAI();
    const b = getGenAI();
    assert.strictEqual(a, b);
});
