const test = require('node:test');
const assert = require('node:assert');

const { resolveTarget, canProxy, isBonusCorrect } = require('../helpers/hitsterTurn.js');

// Minimal fake VoiceChannel: .members is a Map-like with .has().
function vcWith(...ids) {
    return { members: new Map(ids.map(id => [id, { id }])) };
}

function makeGame(overrides = {}) {
    return Object.assign({
        playerOrder: ['111', '222', 'local:lisa'],
        localPlayers: { 'local:lisa': 'Lisa' },
        voiceChannel: vcWith('111', '222'),
    }, overrides);
}

// ---- resolveTarget -------------------------------------------------------

test('resolveTarget: nothing selected resolves to self', () => {
    const r = resolveTarget(makeGame(), {});
    assert.strictEqual(r.kind, 'self');
    assert.strictEqual(r.id, null);
});

test('resolveTarget: a participant user id resolves to that user', () => {
    const r = resolveTarget(makeGame(), { raw: '222' });
    assert.deepStrictEqual(r, { id: '222', kind: 'user' });
});

test('resolveTarget: a user id not in the game is invalid', () => {
    const r = resolveTarget(makeGame(), { raw: '999' });
    assert.strictEqual(r.kind, 'invalid');
});

test('resolveTarget: a local: participant id resolves to that local player', () => {
    const r = resolveTarget(makeGame(), { raw: 'local:lisa' });
    assert.deepStrictEqual(r, { id: 'local:lisa', kind: 'local' });
});

test('resolveTarget: an unknown local: id is invalid', () => {
    const r = resolveTarget(makeGame(), { raw: 'local:bob' });
    assert.strictEqual(r.kind, 'invalid');
});

// ---- canProxy ------------------------------------------------------------

test('canProxy: acting as yourself is always allowed', () => {
    assert.strictEqual(canProxy(makeGame(), '111', { kind: 'self', id: null }).ok, true);
    assert.strictEqual(canProxy(makeGame(), '111', { kind: 'user', id: '111' }).ok, true);
});

test('canProxy: proxying a real user IN the VC is allowed', () => {
    assert.strictEqual(canProxy(makeGame(), '111', { kind: 'user', id: '222' }).ok, true);
});

test('canProxy: proxying a real user NOT in the VC is denied', () => {
    const game = makeGame({ voiceChannel: vcWith('111') }); // 222 absent
    assert.strictEqual(canProxy(game, '111', { kind: 'user', id: '222' }).ok, false);
});

test('canProxy: proxying a local player requires the ACTOR to be in the VC', () => {
    const inVc = makeGame({ voiceChannel: vcWith('111') });
    assert.strictEqual(canProxy(inVc, '111', { kind: 'local', id: 'local:lisa' }).ok, true);

    const notInVc = makeGame({ voiceChannel: vcWith('222') });
    assert.strictEqual(canProxy(notInVc, '111', { kind: 'local', id: 'local:lisa' }).ok, false);
});

test('canProxy: no voice channel fails closed for proxy actions', () => {
    const game = makeGame({ voiceChannel: null });
    assert.strictEqual(canProxy(game, '111', { kind: 'user', id: '222' }).ok, false);
});

// ---- isBonusCorrect ------------------------------------------------------

test('isBonusCorrect: punctuation-insensitive substring match', () => {
    const target = { artist: 'AC/DC', title: 'Back in Black', album: 'Back in Black' };
    assert.strictEqual(isBonusCorrect(target, 'artist', 'acdc'), true);
    assert.strictEqual(isBonusCorrect(target, 'title', 'black'), true);
    assert.strictEqual(isBonusCorrect(target, 'artist', 'metallica'), false);
});

test('isBonusCorrect: missing field is never correct', () => {
    assert.strictEqual(isBonusCorrect({ title: 'X' }, 'album', 'x'), false);
});
