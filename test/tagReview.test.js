const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const os = require('node:os');
const pathMod = require('node:path');

// Its own store, so parallel test files cannot race on one file and a run can never
// disturb the real one.
process.env.PLEXBOT_TAGS_FILE = pathMod.join(os.tmpdir(), 'plexbot-test-review-' + process.pid + '.json');

const sidecar = require('../helpers/tagSidecar.js');
const inference = require('../helpers/tagInference.js');

const FILE = sidecar._file;
test.afterEach(() => {
    try { fs.unlinkSync(FILE); } catch (_) {}
    try { fs.unlinkSync(FILE + '.tmp'); } catch (_) {}
    sidecar._reset();
});

const batch = (n) => Array.from({ length: n }, (_, i) => ({
    ratingKey: String(700 + i),
    title: `Track ${i}`,
    artist: 'Artist',
    moods: ['Eerie'],
    genres: [],
    styles: [],
    missing: ['moods', 'genres', 'styles']
}));

function stubInteraction(customId, userId) {
    const seen = { updates: [], replies: [], followUps: [], channelSends: [] };
    return {
        customId,
        user: { id: userId },
        replied: false,
        deferred: false,
        seen,
        async update(p) { seen.updates.push(p); },
        async reply(p) { seen.replies.push(p); },
        async followUp(p) { seen.followUps.push(p); },
        channel: { async send(p) { seen.channelSends.push(p); } }
    };
}

const lastCard = (interaction) => interaction.seen.updates[interaction.seen.updates.length - 1];

test('approving one track writes only that track', async () => {
    const id = sidecar.stage(batch(3), 'owner');
    await inference.handle(stubInteraction(`tagprop:approve:${id}:1`, 'owner'));

    assert.strictEqual(sidecar.stats().active, 1, 'exactly one track written');
    assert.ok(sidecar.get('701'), 'the one that was approved');
    assert.strictEqual(sidecar.get('700'), null, 'its neighbours are untouched');
    assert.strictEqual(sidecar.get('702'), null);
});

test('rejecting one track writes nothing and leaves the rest reviewable', async () => {
    const id = sidecar.stage(batch(3), 'owner');
    await inference.handle(stubInteraction(`tagprop:reject:${id}:0`, 'owner'));

    assert.strictEqual(sidecar.stats().active, 0, 'a rejection never writes');
    const counts = sidecar.proposalSummary(id);
    assert.strictEqual(counts.rejected, 1);
    assert.strictEqual(counts.pending, 2, 'the other two are still up for review');
});

test('a decision moves the card to the next undecided track', async () => {
    const id = sidecar.stage(batch(3), 'owner');
    const interaction = stubInteraction(`tagprop:approve:${id}:0`, 'owner');
    await inference.handle(interaction);

    const footer = lastCard(interaction).embeds[0].toJSON().footer.text;
    assert.match(footer, /Track 2 of 3/, 'advances past the track just decided');
    assert.match(footer, /1 saved, 0 rejected, 2 to go/);
});

test('each decision survives independently — an interrupted review keeps what was approved', async () => {
    const id = sidecar.stage(batch(4), 'owner');
    await inference.handle(stubInteraction(`tagprop:approve:${id}:0`, 'owner'));
    await inference.handle(stubInteraction(`tagprop:reject:${id}:1`, 'owner'));

    sidecar._reset(); // the bot restarts mid-review

    assert.strictEqual(sidecar.stats().active, 1, 'approved track persisted');
    const counts = sidecar.proposalSummary(id);
    assert.deepStrictEqual(
        { approved: counts.approved, rejected: counts.rejected, pending: counts.pending },
        { approved: 1, rejected: 1, pending: 2 },
        'per-track decisions survive a restart'
    );
});

test('approve-remaining only touches what is still undecided', async () => {
    const id = sidecar.stage(batch(4), 'owner');
    await inference.handle(stubInteraction(`tagprop:reject:${id}:2`, 'owner'));
    await inference.handle(stubInteraction(`tagprop:approveall:${id}:0`, 'owner'));

    assert.strictEqual(sidecar.stats().active, 3, 'the rejected track stays out');
    assert.strictEqual(sidecar.get('702'), null);
});

test('navigation changes the shown track without deciding anything', async () => {
    const id = sidecar.stage(batch(3), 'owner');
    const interaction = stubInteraction(`tagprop:next:${id}:0`, 'owner');
    await inference.handle(interaction);

    assert.match(lastCard(interaction).embeds[0].toJSON().footer.text, /Track 2 of 3/);
    assert.strictEqual(sidecar.proposalSummary(id).pending, 3, 'browsing decides nothing');
});

test('feedback is remembered per track and fed into later inference', () => {
    sidecar.recordFeedback('900', 'this is a sea shanty, not synthwave', 'owner', 'rejected');

    const stored = sidecar.getFeedback('900');
    assert.strictEqual(stored.text, 'this is a sea shanty, not synthwave');
    assert.strictEqual(stored.outcome, 'rejected');

    sidecar._reset();
    assert.ok(sidecar.getFeedback('900'), 'feedback outlives the proposal that produced it');
});

test('regeneration replaces the suggestion in place, keeping the note', () => {
    const id = sidecar.stage(batch(1), 'owner');
    const result = sidecar.updateProposalEntry(id, 0, { moods: ['Gloomy'], feedback: 'much darker than that' });

    assert.strictEqual(result.ok, true);
    const entry = sidecar.getProposal(id).entries[0];
    assert.deepStrictEqual(entry.moods, ['Gloomy']);
    assert.strictEqual(entry.feedback, 'much darker than that');
    assert.strictEqual(entry.status, 'pending', 'a revised suggestion still needs approving');
});

test('a regenerated track can then be approved with its revised tags', async () => {
    const id = sidecar.stage(batch(1), 'owner');
    sidecar.updateProposalEntry(id, 0, { moods: ['Gloomy'], feedback: 'darker' });
    await inference.handle(stubInteraction(`tagprop:approve:${id}:0`, 'owner'));

    const saved = sidecar.get('700');
    assert.deepStrictEqual(saved.moods, ['Gloomy'], 'the revision is what gets stored');
    assert.strictEqual(saved.note, 'darker', 'the reason is kept alongside it');
});

test('finishing closes the review and reports what happened', async () => {
    const id = sidecar.stage(batch(3), 'owner');
    await inference.handle(stubInteraction(`tagprop:approve:${id}:0`, 'owner'));

    const interaction = stubInteraction(`tagprop:done:${id}:0`, 'owner');
    await inference.handle(interaction);

    assert.match(lastCard(interaction).content, /1.*saved/);
    assert.strictEqual(sidecar.getProposal(id), null, 'the review is closed');
});

test('a failed write reports failure and leaves the track undecided', async (t) => {
    const id = sidecar.stage(batch(2), 'owner');
    t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC'); });

    const interaction = stubInteraction(`tagprop:approve:${id}:0`, 'owner');
    await inference.handle(interaction);
    t.mock.restoreAll();

    assert.match(interaction.seen.replies[0].content, /not saved/i);
    assert.strictEqual(sidecar.proposalSummary(id).approved, 0, 'the decision did not stick');
    assert.strictEqual(sidecar.proposalSummary(id).pending, 2, 'so it can be retried');
});

test('old single-button cards from before this change still work', async () => {
    const id = sidecar.stage(batch(2), 'owner');
    const interaction = stubInteraction(`tagprop:approve:${id}`, 'owner'); // no index — legacy shape

    await inference.handle(interaction);
    assert.strictEqual(sidecar.stats().active, 2, 'legacy approve still saves the batch');
});

test('only the requester can decide', async () => {
    const id = sidecar.stage(batch(2), 'owner');
    const interaction = stubInteraction(`tagprop:approve:${id}:0`, 'someone-else');

    await inference.handle(interaction);
    assert.match(interaction.seen.replies[0].content, /only the person who ran the command/i);
    assert.strictEqual(sidecar.stats().active, 0);
});

test('a failed approve-remaining does not undo decisions already made', async (t) => {
    // Regression: the rollback used to revert every entry marked approved, including ones
    // approved by earlier successful clicks whose tags were already in the store.
    const id = sidecar.stage(batch(3), 'owner');
    await inference.handle(stubInteraction(`tagprop:approve:${id}:0`, 'owner'));
    assert.strictEqual(sidecar.proposalSummary(id).approved, 1, 'track 0 approved and stored');

    t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC'); });
    await inference.handle(stubInteraction(`tagprop:approveall:${id}:0`, 'owner'));
    t.mock.restoreAll();

    const counts = sidecar.proposalSummary(id);
    assert.strictEqual(counts.approved, 1, 'the earlier decision survives the failed batch');
    assert.strictEqual(counts.pending, 2, 'only the two that failed are still undecided');
    assert.ok(sidecar.get('700'), 'and its tags are still stored');
});
