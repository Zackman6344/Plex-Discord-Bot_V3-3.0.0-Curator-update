const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');

process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-wiring-' + process.pid);

const commandLog = require('../helpers/commandLog.js');
const { adaptInteraction } = require('../helpers/interactionAdapter.js');
const inference = require('../helpers/tagInference.js');
const sidecar = require('../helpers/tagSidecar.js');

const DIR = commandLog._dir;
test.afterEach(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
    sidecar._reset();
});

function fakeInteraction() {
    const sent = { editReply: [], channelSend: [], update: [] };
    return {
        sent,
        channelId: 'c1',
        user: { id: 'u1', username: 'zack' },
        member: {},
        guild: {},
        client: {},
        replied: false,
        deferred: true,
        customId: 'tagprop:next:none:0',
        options: { data: [] },
        async editReply(p) { sent.editReply.push(p); return { id: 'm1' }; },
        async update(p) { sent.update.push(p); },
        async reply(p) { sent.editReply.push(p); },
        async followUp(p) { sent.editReply.push(p); },
        channel: { id: 'c1', name: 'music', async send(p) { sent.channelSend.push(p); return { id: 'm2' }; } }
    };
}

test('the first slash reply is logged even though editReply is an edit', async () => {
    // The regression this guards: a messageCreate listener never sees editReply, so before the
    // adapter reported it the primary reply to every slash command was missing from the log.
    const interaction = fakeInteraction();
    const id = commandLog.startInvocation({ path: 'slash', command: 'vibe', args: 'spooky' });

    const message = adaptInteraction(interaction, 'spooky', {
        onInteractionResponse: (payload) => commandLog.recordOutput({
            id, kind: 'interaction-reply', channelId: 'c1', payload
        })
    });

    await message.channel.send('🎵 Vibe Check Initializing...');
    commandLog.finishInvocation(id, { ok: true, ms: 10, awaited: true });

    const inv = commandLog.readInvocations({}).invocations[0];
    assert.strictEqual(interaction.sent.editReply.length, 1, 'still delivered through editReply');
    assert.strictEqual(inv.outputs.length, 1, 'and it reached the log');
    assert.match(inv.outputs[0].content, /Vibe Check Initializing/);
    assert.strictEqual(inv.outputs[0].kind, 'interaction-reply');
});

test('later channel messages are not double-logged by the adapter', async () => {
    // Those are real messages, so the messageCreate listener records them; reporting here too
    // would count them twice.
    const interaction = fakeInteraction();
    const id = commandLog.startInvocation({ path: 'slash', command: 'vibe' });
    const message = adaptInteraction(interaction, '', {
        onInteractionResponse: (payload) => commandLog.recordOutput({ id, payload })
    });

    await message.channel.send('first');   // editReply — reported
    await message.channel.send('second');  // real channel message — not reported here
    await message.channel.send('third');

    const inv = commandLog.readInvocations({}).invocations[0];
    assert.strictEqual(inv.outputs.length, 1, 'only the interaction response is reported');
    assert.strictEqual(interaction.sent.channelSend.length, 2, 'the rest went to the channel');
});

test('an observer that throws cannot stop the reply reaching the user', async () => {
    const interaction = fakeInteraction();
    const message = adaptInteraction(interaction, '', {
        onInteractionResponse: () => { throw new Error('logging blew up'); }
    });

    await assert.doesNotReject(() => message.reply('still delivered'));
    assert.strictEqual(interaction.sent.editReply.length, 1);
});

test('review-card edits are logged too', async () => {
    const proposal = [{ ratingKey: '1', title: 'T', artist: 'A', moods: ['Eerie'], missing: ['moods'] }];
    const proposalId = sidecar.stage(proposal, 'u1');
    const id = commandLog.startInvocation({ path: 'button', command: 'tagprop:next' });

    const interaction = fakeInteraction();
    interaction.customId = `tagprop:next:${proposalId}:0`;
    interaction.deferred = false;

    await inference.handle(interaction, {
        onInteractionResponse: (payload) => commandLog.recordOutput({
            id, kind: 'interaction-reply', channelId: 'c1', payload
        })
    });

    const inv = commandLog.readInvocations({}).invocations[0];
    assert.ok(interaction.sent.update.length >= 1, 'the card was edited in place');
    assert.ok(inv.outputs.length >= 1, 'and the edit reached the log');
});

test('a command that returns without awaiting its work is not recorded as a plain success', () => {
    const id = commandLog.startInvocation({ path: 'slash', command: 'play' });
    commandLog.finishInvocation(id, { ok: true, ms: 1, awaited: false });

    const inv = commandLog.readInvocations({}).invocations[0];
    assert.strictEqual(inv.ok, true);
    assert.strictEqual(inv.awaited, false, 'the reader shows this as dispatched, not ok');
});

test('outcomes written before the awaited flag existed still read as awaited', () => {
    // Older log files have no `awaited` key; they should not all start reading as "dispatched".
    const id = commandLog.startInvocation({ path: 'slash', command: 'legacy' });
    const file = pathMod.join(DIR, fs.readdirSync(DIR)[0]);
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), type: 'outcome', id, ok: true, ms: 5 }) + '\n');

    assert.strictEqual(commandLog.readInvocations({}).invocations[0].awaited, true);
});
