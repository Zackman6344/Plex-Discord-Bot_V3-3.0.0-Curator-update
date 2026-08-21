const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const os = require('node:os');
const pathMod = require('node:path');

// Its own store, so parallel test files cannot race on one file and a run can never
// disturb the real one.
process.env.PLEXBOT_TAGS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-inference-' + process.pid + '.json');

const inference = require('../helpers/tagInference.js');
const sidecar = require('../helpers/tagSidecar.js');

const FILE = sidecar._file;
test.afterEach(() => {
    try { fs.unlinkSync(FILE); } catch (_) {}
    sidecar._reset();
});

function stubInteraction(customId, userId, { failUpdate = false, failReply = false, failFollowUp = false } = {}) {
    const seen = { replies: [], updates: [], followUps: [], channelSends: [] };
    return {
        customId,
        user: { id: userId },
        replied: false,
        deferred: false,
        seen,
        async update(p) { if (failUpdate) throw new Error('Unknown Message'); seen.updates.push(p); },
        async reply(p) { if (failReply) throw new Error('Interaction has already been acknowledged'); seen.replies.push(p); },
        async followUp(p) { if (failFollowUp) throw new Error('Invalid Webhook Token'); seen.followUps.push(p); },
        channel: { async send(p) { seen.channelSends.push(p); } }
    };
}

const proposals = (n) => Array.from({ length: n }, (_, i) => ({
    ratingKey: String(1000 + i), title: `Track ${i}`, artist: 'Artist', moods: ['Eerie'], genres: [], styles: []
}));

test('the card stays inside Discord limits however long the review is', () => {
    const many = proposals(60);
    const id = sidecar.stage(many, 'user1');
    const card = inference.buildApprovalMessage(id, many);
    const embed = card.embeds[0].toJSON();

    assert.ok(card.components.length <= 5, 'at most five action rows');
    for (const row of card.components) {
        assert.ok(row.toJSON().components.length <= 5, 'at most five buttons per row');
    }
    assert.match(embed.footer.text, /Track 1 of 60/, 'position in the review is disclosed');

    const total = embed.title.length + embed.description.length + embed.footer.text.length;
    assert.ok(total <= 6000, `embed total under Discord's 6000 ceiling (got ${total})`);
});

test('absurd tag and title lengths are truncated rather than rejected by Discord', () => {
    const monstrous = [{
        ratingKey: '1',
        title: 'T'.repeat(500),
        artist: 'A'.repeat(500),
        moods: Array.from({ length: 40 }, (_, i) => `Mood number ${i} with a very long name`.repeat(2)),
        genres: [], styles: []
    }];
    const card = inference.buildApprovalMessage('abc', monstrous);
    const embed = card.embeds[0].toJSON();

    assert.ok(embed.title.length <= inference.LIMIT.title, 'title clamped');
    assert.ok(embed.description.length <= inference.LIMIT.description, 'description clamped');
});

test('an empty proposal list produces a plain message with no buttons to press', () => {
    const card = inference.buildApprovalMessage('abc', []);
    assert.ok(card.content, 'says something rather than rendering an empty card');
    assert.deepStrictEqual(card.components, [], 'and offers nothing to click');
});

test('buttons belonging to other modules are declined', async () => {
    assert.strictEqual(await inference.handle(stubInteraction('playback:skip', 'u1')), false);
    assert.strictEqual(await inference.handle({}), false);
    assert.strictEqual(await inference.handle(null), false);
});

test('an expired proposal answers the click instead of dying silently', async () => {
    const interaction = stubInteraction('tagprop:approve:nope', 'u1');
    assert.strictEqual(await inference.handle(interaction), true);
    assert.match(interaction.seen.updates[0].content, /expired|already handled/i);
});

test('only the requester can approve', async () => {
    const batch = proposals(1);
    const id = sidecar.stage(batch, 'owner');
    const interaction = stubInteraction(`tagprop:approve:${id}`, 'someone-else');

    await inference.handle(interaction);
    assert.match(interaction.seen.replies[0].content, /only the person who ran the command/i);
    assert.strictEqual(sidecar.stats().active, 0, 'nothing written for a stranger click');
});

test('the response falls through update -> reply -> followUp -> channel', async () => {
    const batch = proposals(1);

    const id1 = sidecar.stage(batch, 'owner');
    const viaReply = stubInteraction(`tagprop:approve:${id1}`, 'owner', { failUpdate: true });
    await inference.handle(viaReply);
    assert.strictEqual(viaReply.seen.replies.length, 1, 'falls back to reply when the card cannot be edited');

    sidecar._reset();
    const id2 = sidecar.stage(batch, 'owner');
    const viaChannel = stubInteraction(`tagprop:approve:${id2}`, 'owner', { failUpdate: true, failReply: true, failFollowUp: true });
    await inference.handle(viaChannel);
    assert.strictEqual(viaChannel.seen.channelSends.length, 1, 'still tells the user what happened');
});

test('a failed write is reported as failed, and the card stays usable', async (t) => {
    const batch = proposals(1);
    const id = sidecar.stage(batch, 'owner');

    t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC'); });
    const interaction = stubInteraction(`tagprop:approve:${id}`, 'owner');
    await inference.handle(interaction);
    t.mock.restoreAll();

    const said = (interaction.seen.replies[0] || interaction.seen.updates[0]).content;
    assert.match(said, /nothing was saved/i, 'never claims success on a failed write');
    assert.match(said, /again/i, 'tells the user it can be retried');
    assert.ok(sidecar.getProposal(id), 'proposal survives for the retry');
});

test('a handler crash still answers the click', async (t) => {
    const batch = proposals(1);
    const id = sidecar.stage(batch, 'owner');
    t.mock.method(sidecar, 'approve', () => { throw new Error('boom'); });

    const interaction = stubInteraction(`tagprop:approve:${id}`, 'owner');
    const claimed = await inference.handle(interaction);
    t.mock.restoreAll();

    assert.strictEqual(claimed, true);
    const said = (interaction.seen.replies[0] || interaction.seen.updates[0] || interaction.seen.channelSends[0]);
    assert.ok(said, 'a thrown handler must not leave the button dead');
});
