const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const pathMod = require('node:path');

// Its own directory, so a test run never mixes with the real log.
process.env.PLEXBOT_LOG_DIR = pathMod.join(os.tmpdir(), 'plexbot-test-logs-' + process.pid);

const commandLog = require('../helpers/commandLog.js');

const DIR = commandLog._dir;
test.afterEach(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
    commandLog._reset();
});

test('an invocation, its outcome and its outputs fold back into one record', () => {
    const id = commandLog.startInvocation({
        path: 'slash', command: 'vibe', args: 'spooky forest',
        user: 'zack', userId: 'u1', channel: 'music', channelId: 'c1'
    });
    commandLog.recordOutput({ id, channelId: 'c1', payload: 'Queuing up 5 tracks...' });
    commandLog.finishInvocation(id, { ok: true, ms: 1234 });

    const { invocations } = commandLog.readInvocations({});
    assert.strictEqual(invocations.length, 1);

    const inv = invocations[0];
    assert.strictEqual(inv.command, 'vibe');
    assert.strictEqual(inv.path, 'slash');
    assert.strictEqual(inv.args, 'spooky forest');
    assert.strictEqual(inv.ok, true);
    assert.strictEqual(inv.ms, 1234);
    assert.strictEqual(inv.outputs.length, 1);
    assert.match(inv.outputs[0].content, /Queuing up 5 tracks/);
});

test('a failure keeps the error where it can be read back later', () => {
    const id = commandLog.startInvocation({ command: 'game', path: 'slash' });
    commandLog.finishInvocation(id, { ok: false, ms: 12, error: new Error('Playnite offline') });

    const inv = commandLog.readInvocations({ errorsOnly: true }).invocations[0];
    assert.strictEqual(inv.ok, false);
    assert.match(inv.error, /Playnite offline/);
});

test('secrets never reach the log file', () => {
    const keys = (() => { try { return require('../config/keys.js'); } catch (_) { return {}; } })();
    const token = keys.botToken;

    const id = commandLog.startInvocation({ command: 'oops', args: `here is my token ${token || 'x'}` });
    commandLog.recordOutput({ id, payload: `leaked: ${token || 'x'}` });

    const written = fs.readFileSync(pathMod.join(DIR, fs.readdirSync(DIR)[0]), 'utf8');
    if (token && token.length >= 8) {
        assert.ok(!written.includes(token), 'the bot token must never be written to the log');
        assert.match(written, /\[redacted\]/);
    }
});

test('long content is truncated rather than dumped whole', () => {
    const id = commandLog.startInvocation({ command: 'x', args: 'a'.repeat(5000) });
    commandLog.recordOutput({ id, payload: 'b'.repeat(5000) });

    const inv = commandLog.readInvocations({}).invocations[0];
    assert.ok(inv.args.length < 400, `args truncated (${inv.args.length})`);
    assert.ok(inv.outputs[0].content.length < 500, 'content truncated');
});

test('embeds are summarised, not stored whole', () => {
    const summary = commandLog.summarise({
        content: 'hi',
        embeds: [{ toJSON: () => ({ title: 'Vibe Locked', description: 'spooky forest', fields: [1, 2, 3] }) }],
        components: [{}, {}]
    });

    assert.strictEqual(summary.content, 'hi');
    assert.deepStrictEqual(summary.embeds[0], { title: 'Vibe Locked', description: 'spooky forest', fields: 3 });
    assert.strictEqual(summary.components, 2);
});

test('output with no invocation is kept as unattached rather than dropped', () => {
    commandLog.recordOutput({ channelId: 'c9', payload: 'Kometa run finished' });

    const { invocations, unattached } = commandLog.readInvocations({});
    assert.strictEqual(invocations.length, 0);
    assert.strictEqual(unattached.length, 1);
    assert.match(unattached[0].content, /Kometa run finished/);
});

test('a torn final line costs one event, not the file', () => {
    const id = commandLog.startInvocation({ command: 'first' });
    commandLog.finishInvocation(id, { ok: true });

    const file = pathMod.join(DIR, fs.readdirSync(DIR)[0]);
    fs.appendFileSync(file, '{"t":"2026-01-01","type":"invo');  // killed mid-append

    const { invocations } = commandLog.readInvocations({});
    assert.strictEqual(invocations.length, 1, 'the intact events still read back');
});

test('filters narrow to a command, a user, or a time window', () => {
    const a = commandLog.startInvocation({ command: 'vibe', userId: 'u1' });
    commandLog.finishInvocation(a, { ok: true });
    const b = commandLog.startInvocation({ command: 'play', userId: 'u2' });
    commandLog.finishInvocation(b, { ok: true });

    assert.strictEqual(commandLog.readInvocations({ command: 'vibe' }).invocations.length, 1);
    assert.strictEqual(commandLog.readInvocations({ userId: 'u2' }).invocations[0].command, 'play');
    assert.strictEqual(commandLog.readInvocations({ sinceMs: 60000 }).invocations.length, 2);
    assert.strictEqual(commandLog.readInvocations({ sinceMs: -1 }).invocations.length, 0);
});

test('reading an empty or missing log directory is not an error', () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    assert.deepStrictEqual(commandLog.readEvents(), []);
    assert.deepStrictEqual(commandLog.readInvocations({}).invocations, []);
    assert.strictEqual(commandLog.stats().invocations, 0);
});

test('logging can be switched off entirely', () => {
    // The kill switch is read at require time, so check the flag rather than re-importing.
    assert.strictEqual(process.env.PLEXBOT_COMMAND_LOG === '0', false, 'on by default in tests');
});

// ---- the read-along's private pages ----------------------------------------------------------
// A DM page holds a page of a copyrighted book, sent to one person. The log keeps that it was
// sent, never what it said; the bookpage: button row is how a payload is recognised.

const PAGE_TEXT = 'quebec romeo sierra tango uniform victor whiskey';

function rawPage() {
    return {
        content: 'The text was updated; this is where the narration is.',
        embeds: [{ title: 'The Fake Book · Chapter 1', description: PAGE_TEXT, footer: { text: 'page 1 of 5' } }],
        components: [{ type: 1, components: [{ type: 2, style: 2, custom_id: 'bookpage:next:d:a1b2c3:9f0c:0', label: 'Page' }] }]
    };
}

test('a raw-JSON payload with a bookpage: row is recorded without its text', () => {
    const summary = commandLog.summarise(rawPage());
    assert.deepStrictEqual(summary, {
        content: '[book text not logged]',
        embeds: [{ title: '[book text not logged]', description: null, fields: 0 }],
        components: 1
    });
});

test('discord.js classes (a sent Message\'s rows and embeds, and builders) are recognised too', () => {
    const { ActionRow, Embed, ActionRowBuilder, ButtonBuilder, EmbedBuilder } = require('discord.js');
    const fromMessage = commandLog.payloadOfMessage({
        content: '',
        embeds: [new Embed({ title: 'Chapter 1', description: PAGE_TEXT })],
        components: [new ActionRow({ type: 1, components: [{ type: 2, style: 2, custom_id: 'bookpage:now:d:a1b2c3:9f0c:5k', label: 'Now' }] })]
    });
    const built = {
        embeds: [new EmbedBuilder().setTitle('Chapter 1').setDescription(PAGE_TEXT)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('bookpage:prev:e:a1b2c3:9f0c:0').setLabel('Page').setStyle(2))]
    };
    for (const payload of [fromMessage, built]) {
        assert.ok(commandLog.carriesPrivateText(payload));
        assert.ok(!JSON.stringify(commandLog.summarise(payload)).includes('quebec'));
    }
});

test('an ordinary payload, the book card included, is still kept as it was', () => {
    const cardPayload = {
        content: '',
        embeds: [{ title: '📚 The Fake Book', description: 'Chapter 2 of 9' }],
        components: [{ type: 1, components: [{ type: 2, style: 2, custom_id: 'bookread:a1b2c3', label: 'Text' }, { type: 2, style: 4, custom_id: 'book:stop:a1b2c3', label: 'Stop' }] }]
    };
    assert.strictEqual(commandLog.carriesPrivateText(cardPayload), false);
    assert.deepStrictEqual(commandLog.summarise(cardPayload).embeds[0], { title: '📚 The Fake Book', description: 'Chapter 2 of 9', fields: 0 });
    assert.strictEqual(commandLog.carriesPrivateText(null), false);
    assert.strictEqual(commandLog.carriesPrivateText('bookpage:'), false);
});

test('a page reaches the day-file as a placeholder, and the page text never does', () => {
    const id = commandLog.startInvocation({ command: 'book', path: 'button', args: 'bookpage:next:d:a1b2c3:9f0c:0' });
    commandLog.recordOutput({ id, kind: 'interaction-reply', payload: rawPage() });
    commandLog.recordOutput({ id, payload: 'an ordinary reply' });
    const written = fs.readFileSync(pathMod.join(DIR, fs.readdirSync(DIR)[0]), 'utf8');
    assert.match(written, /\[book text not logged\]/);
    assert.match(written, /an ordinary reply/);
    assert.ok(!written.includes('quebec'));
    assert.ok(!written.includes('narration is'));
});

test('payloadOfMessage keeps exactly the fields the output recorder always took', () => {
    const message = { content: 'c', embeds: ['e'], components: ['r'], author: { id: 'bot' }, channelId: 'x' };
    assert.deepStrictEqual(commandLog.payloadOfMessage(message), { content: message.content, embeds: message.embeds, components: message.components });
});

test('the Calibre password is redacted like the other secrets', () => {
    const config = require('../config/config.js');
    const saved = config.calibrePassword;
    config.calibrePassword = 'calibre-test-pass-4821';
    try {
        commandLog._reset();
        const id = commandLog.startInvocation({ command: 'config', args: 'calibrePassword calibre-test-pass-4821' });
        commandLog.recordOutput({ id, payload: 'set to calibre-test-pass-4821' });
        const written = fs.readFileSync(pathMod.join(DIR, fs.readdirSync(DIR)[0]), 'utf8');
        assert.ok(!written.includes('calibre-test-pass-4821'));
        assert.match(written, /\[redacted\]/);
    } finally {
        config.calibrePassword = saved;
        commandLog._reset();
    }
});
