// The `!ap` argument parser, specifically the optional watch id.
//
// Leaving the id out means "the only watch", which makes the first word after the sub-command
// ambiguous in the prefix form: `!ap claim 0 ZackWord` gives one and `!ap claim ZackWord` does
// not. A leading integer is always read as the id, including one no watch holds, because the
// alternative silently retargets the only watch when the id is stale.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const harness = require('./helpers/apServer.js');
const stores = harness.useTempStores('cmd');   // must run before any helper is required

const config = require('../config/config.js');
const claims = require('../helpers/archipelagoClaims.js');
const monitor = require('../helpers/archipelagoMonitor.js');
const ap = require('../commands/archipelago.js');

const ZACK = '111111111111111111';

const startFakeServer = (slotNames) => harness.startFakeServer({ slots: slotNames, seedName: 'Seed_CMD' });
const { closeServer } = harness;

// Enough of a Discord message for the command to run against. The whole payload is kept, not
// just its text, so the mention-suppression rule can be asserted.
function fakeMessage(author = ZACK) {
    const sent = [];
    return {
        sent,
        author: { id: author },
        guild: null,
        channel: { id: 'chan-1', send: async (payload) => { sent.push(payload); return { edit: async () => {} }; } },
        mentions: { users: { first: () => null } },
        interaction: null,
        deletable: false
    };
}

const said = (msg) => msg.sent.map(p => (typeof p === 'string' ? p : p.content || '')).join('\n');

async function run(...args) {
    const msg = fakeMessage();
    await ap.command.process(msg, ...args);
    return msg;
}

async function runAs(author, ...args) {
    const msg = fakeMessage(author);
    await ap.command.process(msg, ...args);
    return msg;
}

let servers = [];
let watchIds = [];

async function addWatch(slotNames) {
    const server = await startFakeServer(slotNames);
    servers.push(server);
    const { watch } = await monitor.addWatch({
        target: `localhost:${server.port}`,
        slot: slotNames[0],
        channelId: 'chan-1'
    }, 15000);
    watchIds.push(watch.id);
    return watch;
}

// config is a shared singleton, so what a test changes has to be put back or every later test in
// the file inherits it and a mid-run failure leaves the module mutated.
const savedConfig = {};
const CONFIG_KEYS = ['archipelagoEnabled', 'ownerId', 'archipelagoRolesEnabled'];

test.before(() => {
    for (const key of CONFIG_KEYS) savedConfig[key] = config[key];
});

test.beforeEach(() => {
    config.archipelagoEnabled = true;
    config.ownerId = '';                     // claiming is self-service either way
    config.archipelagoRolesEnabled = false;  // no Discord client in this harness
    try { fs.unlinkSync(claims.CLAIM_FILE); } catch (_) {}
    claims.reset();
});

test.afterEach(async () => {
    for (const id of watchIds) monitor.removeWatch(id);
    for (const server of servers) await closeServer(server.wss);
    watchIds = [];
    servers = [];
});

// Every file the env points at, not just the one this suite reads directly: addWatch persists a
// watch file on every test, and PIDs are reused, so a leftover could be loaded by a later run.
test.after(() => {
    for (const key of CONFIG_KEYS) config[key] = savedConfig[key];
    stores.cleanup();
});

test('with one watch, the id can be left out', async () => {
    const watch = await addWatch(['ZackWord', 'ZackREPO']);

    const msg = await run('claim', 'ZackWord');
    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);
});

test('an explicit id still works, and picks the same watch', async () => {
    const watch = await addWatch(['ZackWord', 'ZackREPO']);

    const msg = await run('claim', String(watch.id), 'ZackREPO');
    assert.match(said(msg), /You are now on `ZackREPO`/);
    assert.strictEqual(claims.find(watch.id, 'ZackREPO').userId, ZACK);
});

// A leading integer is always the id, even one no watch holds. Deciding that on whether the id
// exists reads as friendlier and silently retargets the only watch when it does not: `!ap unwatch
// 999` deleted the one live room. Answering "no watch with ID 999" is the recoverable half of
// that trade, and the cost is that a slot literally named "12345" needs the explicit form.
test('an id no watch holds is rejected, not re-read as the next argument', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('claim', '999', 'ZackWord');
    assert.match(said(msg), /No watch with ID 999/);
    assert.strictEqual(claims.forWatch(watch.id).length, 0, 'nothing claimed on the wrong watch');
});

test('a stale id does not destroy the only watch', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('unwatch', '999');
    assert.match(said(msg), /No watch with ID 999/);
    assert.ok(monitor.getWatch(watch.id), 'the live watch must survive a command that named another');
});

test('a stale id is not folded into the password', async () => {
    const watch = await addWatch(['ZackWord']);

    const msg = await run('password', '999', 'hunter2');
    assert.match(said(msg), /No watch with ID 999/);
    assert.strictEqual(monitor.getWatch(watch.id).password, null, 'the live watch keeps its own password');
});

test('a stale id is not re-read as the on/off word', async () => {
    const watch = await addWatch(['ZackWord']);
    const before = monitor.getWatch(watch.id).progressionOnly;

    // "0" would read as falsy and invert this if the id fell through to the toggle position.
    const msg = await run('progression', '0', 'on');
    assert.match(said(msg), /No watch with ID 0/);
    assert.strictEqual(monitor.getWatch(watch.id).progressionOnly, before, 'the live watch is untouched');
});

test('a numeric slot name still works through the explicit id form', async () => {
    const watch = await addWatch(['12345', 'ZackWord']);

    const msg = await run('claim', String(watch.id), '12345');
    assert.match(said(msg), /You are now on `12345`/);
    assert.strictEqual(claims.find(watch.id, '12345').userId, ZACK);
});

test('pings and unclaim take the id optionally too', async () => {
    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');

    const set = await run('pings', 'ZackWord', 'all');
    assert.match(said(set), /pinging for every item/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').pings, 'all');

    const gone = await run('unclaim', 'ZackWord');
    assert.match(said(gone), /released/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord'), null);
});

test('a slot name with spaces survives the optional id', async () => {
    const watch = await addWatch(['Zack Word Two']);

    const msg = await run('claim', 'Zack Word Two');
    assert.match(said(msg), /You are now on `Zack Word Two`/);
    assert.strictEqual(claims.find(watch.id, 'Zack Word Two').userId, ZACK);
});

test('with two watches the id is required again, and says so', async () => {
    await addWatch(['ZackWord']);
    await addWatch(['OtherSlot']);

    const msg = await run('claim', 'ZackWord');
    assert.match(said(msg), /More than one room is being watched/);
    assert.strictEqual(claims.all().length, 0, 'nothing claimed on a guess');
});

test('with no watches at all it says that rather than asking for an ID', async () => {
    const msg = await run('claims');
    assert.match(said(msg), /No rooms are being watched yet/);
});

// --- claiming somebody else's slot ---------------------------------------------------------

const MALLORY = '333333333333333333';

test('a slot already claimed cannot be taken by another user', async (t) => {
    // isOwner() answers true for everybody when no ownerId is configured, so the guard needs a
    // real owner to be a third party here.
    const saved = config.ownerId;
    config.ownerId = '999999999999999999';
    t.after(() => { config.ownerId = saved; });

    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);

    const msg = await runAs(MALLORY, 'claim', 'ZackWord');
    assert.match(said(msg), /already claimed by/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK, 'the original holder keeps it');
});

test('the owner can still reassign a claimed slot', async (t) => {
    const saved = config.ownerId;
    config.ownerId = MALLORY;
    t.after(() => { config.ownerId = saved; });

    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');

    const msg = await runAs(MALLORY, 'claim', 'ZackWord');
    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, MALLORY);
});

test('re-claiming a slot you already hold is still fine', async () => {
    const watch = await addWatch(['ZackWord']);
    await run('claim', 'ZackWord');
    const msg = await run('claim', 'ZackWord');

    assert.match(said(msg), /You are now on `ZackWord`/);
    assert.strictEqual(claims.find(watch.id, 'ZackWord').userId, ZACK);
});

// --- mentions -------------------------------------------------------------------------------

test('no reply can ping anybody, whatever the slot text contains', async () => {
    await addWatch(['ZackWord']);

    // A role mention survives slotArg, which only strips user mentions. Echoed with default
    // parsing it would let any user make the bot ping a role - and the bot's own participant
    // role is created mentionable.
    const msg = await run('unclaim', '<@&123456789012345678>');
    assert.match(said(msg), /Nobody has claimed/);

    for (const payload of msg.sent) {
        assert.strictEqual(typeof payload, 'object', 'every reply is sent as a payload, not a bare string');
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] },
            `a reply went out without mention suppression: ${JSON.stringify(payload).slice(0, 120)}`);
    }
});

test('the claim confirmation names a user without pinging them', async () => {
    await addWatch(['ZackWord']);
    const msg = await run('claim', 'ZackWord');

    assert.ok(msg.sent.length > 0);
    for (const payload of msg.sent) {
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    }
});

// --- slot names in replies -------------------------------------------------------------------

test('a slot name is shown as written, with no escape artefacts', async () => {
    // Underscores are everywhere in Archipelago slot names. Escaping markdown and THEN wrapping
    // in backticks put a literal backslash on screen, because Discord does no escape processing
    // inside an inline code span.
    const watch = await addWatch(['Zack_Word']);

    const msg = await run('claim', 'Zack_Word');
    assert.match(said(msg), /`Zack_Word`/, 'shown as written');
    // Built from the character code so no quoting layer can eat the backslash and leave this
    // silently asserting that the reply contains no underscore.
    const BACKSLASH = String.fromCharCode(92);
    assert.ok(!said(msg).includes(BACKSLASH), `a literal backslash reached the reply: ${said(msg)}`);
    assert.strictEqual(claims.find(watch.id, 'Zack_Word').userId, ZACK);
});

test('a backtick in a slot name cannot break out of the code span', async () => {
    await addWatch(['ZackWord']);

    const msg = await run('unclaim', 'we`ird');
    const text = said(msg);
    // Exactly two backticks: the pair this reply opened and closed.
    assert.strictEqual((text.match(/`/g) || []).length, 2,
        `the span was not closed cleanly: ${text}`);
});

// --- password ---------------------------------------------------------------------------------

test('a numeric password is not mistaken for a request to clear', async () => {
    const watch = await addWatch(['ZackWord']);
    monitor.setPassword(watch.id, 'original');

    // `!ap password 0` reads the 0 as the watch id, leaving nothing after it. Clearing silently
    // would destroy a password whose only other copy is the message just deleted.
    const msg = await run('password', String(watch.id));
    assert.match(said(msg), /would clear the password/);
    assert.strictEqual(monitor.getWatch(watch.id).password, 'original', 'untouched');
});

test('clearing a password still works when asked for in words', async () => {
    const watch = await addWatch(['ZackWord']);
    monitor.setPassword(watch.id, 'original');

    const msg = await run('password', String(watch.id), 'clear');
    assert.match(said(msg), /password cleared/);
    assert.strictEqual(monitor.getWatch(watch.id).password, null);
});

// --- !ap next lists slots by the earliest sphere still within reach ---------------------------
//
// The reply for someone holding many slots used to follow claim order, which says nothing about
// where to go first, and the message limit then cut whichever slots happened to be claimed last.
// Sorted, the first block is the nearest thing to do and the ones cut are the furthest away.
//
// suggestNextAll is stubbed: this is about the order the command renders in, and the sphere
// arithmetic behind each answer is covered in archipelagoSuggest.test.js.

test('!ap next lists claimed slots earliest reachable sphere first', async (t) => {
    const slots = ['ZackWord', 'ZackStuck', 'ZackEarly', 'ZackDone', 'ZackBanner'];
    await addWatch(slots);
    for (const slot of slots) await run('claim', slot);

    const canned = {
        ZackWord:   { ok: true, slot: 'ZackWord', sphere: 3, reach: 3, remaining: 2, beyond: 0, locations: ['Word Loc'] },
        ZackStuck:  { ok: true, slot: 'ZackStuck', sphere: null, reach: 2, remaining: 0, beyond: 5, locations: [] },
        ZackEarly:  { ok: true, slot: 'ZackEarly', sphere: 1, reach: 4, remaining: 9, beyond: 0, locations: ['Early Loc'] },
        ZackDone:   { ok: false, slot: 'ZackDone', reason: 'nothing-left' },
        ZackBanner: { ok: true, slot: 'ZackBanner', sphere: 3, reach: 3, remaining: 1, beyond: 0, locations: ['Banner Loc'] }
    };
    const real = monitor.suggestNextAll;
    let asked = null;
    monitor.suggestNextAll = async (id, wanted) => {
        asked = wanted;
        return { ok: true, results: wanted.map(name => canned[name]) };
    };
    t.after(() => { monitor.suggestNextAll = real; });

    // The status message is edited into the answer, so the edit is what has to be captured.
    const edits = [];
    const msg = fakeMessage();
    msg.channel.send = async (payload) => { msg.sent.push(payload); return { edit: async (text) => { edits.push(text); } }; };
    await ap.command.process(msg, 'next');

    assert.deepStrictEqual(asked, slots, 'every claimed slot was asked about, in claim order');
    const answer = edits.join('\n') || said(msg);
    const at = (name) => answer.indexOf(`**${name}**`);
    for (const name of slots) assert.ok(at(name) >= 0, `${name} is in the reply`);

    // Sphere 1, then the two sphere-3 slots by name, then nothing reachable, then nothing left.
    assert.ok(at('ZackEarly') < at('ZackBanner'), 'sphere 1 before sphere 3');
    assert.ok(at('ZackBanner') < at('ZackWord'), 'a tie in sphere goes by name');
    assert.ok(at('ZackWord') < at('ZackStuck'), 'something to do before nothing reachable yet');
    assert.ok(at('ZackStuck') < at('ZackDone'), 'nothing reachable yet before nothing left');
});

// --- !ap catchup --------------------------------------------------------------------------------
//
// monitor.catchUp is stubbed for every reply path but one: what a catch-up finds and posts is
// covered in archipelagoCatchupRelay.test.js, and this is about the wording the command answers
// with. The status message is edited in place, so the edits are what has to be captured.

// Held once, so a test that asks for two replies restores the real one and not the first stub.
const realCatchUp = monitor.catchUp;

async function catchupReply(t, result, { plan = null, args = ['catchup'] } = {}) {
    const calls = [];
    monitor.catchUp = async (id, options) => {
        calls.push({ id, options });
        if (plan && options && typeof options.onPlan === 'function') options.onPlan(plan);
        return result;
    };
    t.after(() => { monitor.catchUp = realCatchUp; });

    const edits = [];
    const msg = fakeMessage();
    msg.channel.send = async (payload) => {
        msg.sent.push(payload);
        return { edit: async (edit) => { edits.push(edit); return {}; } };
    };
    await ap.command.process(msg, ...args);
    const final = edits.length ? edits[edits.length - 1].content : null;
    return { msg, edits, calls, final };
}

function assertQuiet(reply) {
    for (const payload of [...reply.msg.sent, ...reply.edits]) {
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] },
            `a catch-up reply went out without mention suppression: ${JSON.stringify(payload).slice(0, 120)}`);
    }
}

test('!ap catchup says what it is posting as soon as the plan is known, then what posted', async (t) => {
    const watch = await addWatch(['ZackWord']);
    const reply = await catchupReply(t,
        { ok: true, missed: 3, posted: 3, hidden: 2, channelId: 'chan-1', gapSince: null, seededAt: null },
        { plan: { missed: 3, hidden: 2 } });

    assert.match(said(reply.msg), /Checking the room tracker/);
    assert.strictEqual(reply.calls.length, 1);
    assert.strictEqual(reply.calls[0].id, watch.id, 'the only watch is assumed');
    assert.strictEqual(reply.calls[0].options.manual, true, 'the command posts whatever the setting says');
    assert.strictEqual(reply.edits.length, 2, 'the plan edit and the final edit');
    assert.match(reply.edits[0].content, /Posting 3 missed line\(s\) to <#chan-1>, 2 hidden by this watch's filters\./);
    assert.match(reply.final, /Posted 3 missed line\(s\) to <#chan-1>, 2 hidden by this watch's filters\./);
    assertQuiet(reply);
});

test('!ap catchup names the part that did not post', async (t) => {
    await addWatch(['ZackWord']);
    const reply = await catchupReply(t,
        { ok: true, missed: 5, posted: 3, hidden: 0, channelId: 'chan-1', gapSince: null, seededAt: null },
        { plan: { missed: 5, hidden: 0 } });

    assert.match(reply.edits[0].content, /Posting 5 missed line\(s\) to <#chan-1>\.$/, 'no hidden clause when nothing was hidden');
    assert.match(reply.final, /Posted 3 of 5 missed line\(s\)/);
    assert.match(reply.final, /retries them/);
});

test('!ap catchup with nothing missed says since when', async (t) => {
    await addWatch(['ZackWord']);
    const gapSince = '2026-09-20T12:00:00.000Z';
    const reply = await catchupReply(t,
        { ok: true, missed: 0, posted: 0, hidden: 4, channelId: 'chan-1', gapSince, seededAt: null },
        { plan: { missed: 0, hidden: 4 } });

    assert.strictEqual(reply.edits.length, 1, 'no "Posting 0" edit before the answer');
    assert.strictEqual(reply.final,
        `✅ Nothing missed since <t:${Math.floor(Date.parse(gapSince) / 1000)}:f>; 4 hidden by this watch's filters.`);
    assertQuiet(reply);
});

test('!ap catchup with nothing missed and no gap time leaves the time out', async (t) => {
    await addWatch(['ZackWord']);
    const reply = await catchupReply(t,
        { ok: true, missed: 0, posted: 0, hidden: 0, channelId: 'chan-1', gapSince: null, seededAt: null });
    assert.strictEqual(reply.final, '✅ Nothing missed.');
});

test('!ap catchup inside the settle window says when the next check runs, found or not', async (t) => {
    await addWatch(['ZackWord']);
    const settlingUntil = Date.now() + 90000;
    const note = ` The tracker can run about two minutes behind the room; another check runs at <t:${Math.ceil(settlingUntil / 1000)}:T>.`;

    const nothing = await catchupReply(t,
        { ok: true, missed: 0, posted: 0, hidden: 0, channelId: 'chan-1', gapSince: null, seededAt: null, settlingUntil });
    assert.strictEqual(nothing.final, `✅ Nothing missed.${note}`);

    const posted = await catchupReply(t,
        { ok: true, missed: 2, posted: 2, hidden: 0, channelId: 'chan-1', gapSince: null, seededAt: null, settlingUntil },
        { plan: { missed: 2, hidden: 0 } });
    assert.strictEqual(posted.final, `📜 Posted 2 missed line(s) to <#chan-1>.${note}`);
    assertQuiet(posted);
});

test('!ap catchup on first sight explains the baseline', async (t) => {
    await addWatch(['ZackWord']);
    const reply = await catchupReply(t, { ok: true, baseline: true });
    assert.match(reply.final,
        /First look at this room: recorded where it stands\. Anything missed from now on will be posted\./);
});

test('!ap catchup while the tracker settles says when it can run', async (t) => {
    await addWatch(['ZackWord']);
    const at = Date.now() + 90000;
    const reply = await catchupReply(t, { ok: false, reason: 'settling', at });
    assert.match(reply.final, /connected moments ago/);
    assert.ok(reply.final.includes(`<t:${Math.ceil(at / 1000)}:T>`), reply.final);
});

// Not stubbed: the real monitor refuses a host:port watch before anything is fetched.
test('!ap catchup on a host:port watch says it needs a room URL', async () => {
    await addWatch(['ZackWord']);
    const edits = [];
    const msg = fakeMessage();
    msg.channel.send = async (payload) => {
        msg.sent.push(payload);
        return { edit: async (edit) => { edits.push(edit); return {}; } };
    };
    await ap.command.process(msg, 'catchup');
    assert.strictEqual(edits.length, 1);
    assert.match(edits[0].content, /only a watch made from a room URL has/);
});

test('!ap catchup with a stale id does not fall back to the only watch', async (t) => {
    await addWatch(['ZackWord']);
    const reply = await catchupReply(t, { ok: true, baseline: true }, { args: ['catchup', '999'] });
    assert.match(said(reply.msg), /No watch with ID 999/);
    assert.strictEqual(reply.calls.length, 0);
});

test('!ap catchup is owner-gated', async (t) => {
    const saved = config.ownerId;
    config.ownerId = '999999999999999999';
    t.after(() => { config.ownerId = saved; });

    await addWatch(['ZackWord']);
    const reply = await catchupReply(t, { ok: true, baseline: true });
    assert.match(said(reply.msg), /Only the bot owner/);
    assert.strictEqual(reply.calls.length, 0, 'nothing was run for a non-owner');
});

test('!ap catchup escapes the failure text and explains a restart', async (t) => {
    const watch = await addWatch(['ZackWord']);
    const failed = await catchupReply(t, { ok: false, reason: 'failed', detail: 'HTTP 502 from **tracker**' });
    assert.ok(failed.final.includes('could not finish: HTTP 502 from \\*\\*tracker\\*\\*.'), failed.final);

    const restarted = await catchupReply(t, { ok: false, reason: 'restarted', posted: 20 });
    assert.ok(restarted.final.includes(`Watch #${watch.id} restarted partway through, after 20 line(s) posted`),
        restarted.final);
});

test('!ap list shows the catch-up state and no dropped count', async () => {
    await addWatch(['ZackWord']);
    const msg = await run('list');
    const value = msg.sent[0].embeds[0].data.fields[0].value;
    assert.match(value, /\*\*Catch-up:\*\* not available \(host:port has no tracker\)/);
    assert.match(value, /\*\*Relayed:\*\* 0 line\(s\)$/m);
    assert.ok(!/dropped/.test(value), value);
});

// The list sat at 1,927 characters before catchup joined it, and Discord rejects a send over
// 2,000 outright rather than truncating it.
test('!ap help lists catchup and every message fits Discord\'s limit', async () => {
    const msg = await run('help');
    assert.ok(msg.sent.length >= 1);
    for (const payload of msg.sent) {
        assert.ok(payload.content.length <= 2000, `a help message is ${payload.content.length} characters`);
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
    }
    assert.match(said(msg), /ap catchup \[id\]/);
});
